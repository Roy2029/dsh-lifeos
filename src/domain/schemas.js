/**
 * LifeOS — 表规格与记录校验（A 线：领域层）
 *
 * 冻结依据：`design/08-V1-Schema冻结清单.md`（28 业务表 + journal；M6 schema v2 增 1 张 `group` 表 → 29 业务表；unit 归属见 §2.1/§4.5）。
 * M0 只强制：必填字段存在、枚举白名单、ID 前缀、时间/日期格式、基础类型。
 * 完整业务规则（状态机/跨字段不变量）在 M1+ 实现；这里不实现（契约见 design/08 §7）。
 *
 * 零依赖：仅使用同目录 ids.js / time.js。
 */

import { isId } from './ids.js'
import { isIsoTimestamp, isLocalDate } from './time.js'

export const UNIT = Object.freeze({
  CORE: 'lifeos',
  RAW: 'lifeos_raw',
  LOG: 'lifeos_log',
})

export const UNIT_NAMES = Object.freeze([UNIT.CORE, UNIT.RAW, UNIT.LOG])

export const JOURNAL_TABLE = 'journal'

const ORIGIN_TYPES = Object.freeze([
  'user_stated',
  'record_extraction',
  'statistical',
  'agent_inference',
  'external',
  'system',
  'import',
])

const CONFIRMATION_STATUSES = Object.freeze([
  'not_required',
  'pending',
  'confirmed',
  'rejected',
  'expired',
  'retracted',
])

const C_GROUP_ENUMS = Object.freeze({
  origin_type: ORIGIN_TYPES,
  confirmation_status: CONFIRMATION_STATUSES,
})

const C_GROUP_TIMESTAMPS = Object.freeze(['created_at', 'updated_at', 'deleted_at'])

/** @type {Array<object>} 29 张业务表（顺序与 design/08 §2.1 一致；M6 增 `group`） */
const BUSINESS_DEFS = [
  {
    name: 'raw_record',
    unit: UNIT.RAW,
    prefix: 'rr',
    required: ['raw_text', 'user_local_date', 'tz'],
    enums: {
      kind: ['journal', 'note', 'chat', 'import'],
      content_format: ['plain', 'markdown'],
      channel: ['composer', 'chat', 'paste', 'import'],
      processing_status: ['pending', 'processing', 'processed', 'partial', 'failed', 'skipped'],
    },
    defaults: { kind: 'note', content_format: 'plain', channel: 'composer', processing_status: 'pending' },
    timestamps: ['processed_at', 'client_created_at'],
    localDates: ['user_local_date'],
    types: { raw_text: 'string', tz: 'string', raw_text_sha256: 'string' },
  },
  {
    name: 'inbox_item',
    unit: UNIT.CORE,
    prefix: 'inb',
    required: ['title', 'status'],
    enums: {
      status: ['captured', 'triaged', 'needs_review', 'promoted', 'dismissed', 'archived'],
      suggested_kind: ['task', 'project', 'wish', 'goal', 'habit', 'event', 'memory', 'none'],
      priority: ['none', 'low', 'medium', 'high'],
    },
    defaults: { status: 'captured', suggested_kind: 'none', priority: 'none', sort_order: 0 },
    timestamps: ['triaged_at', 'dismissed_at'],
    localDates: ['due_date'],
    types: { title: 'string' },
  },
  {
    name: 'extraction_run',
    unit: UNIT.CORE,
    prefix: 'xrun',
    required: ['run_kind', 'local_date', 'trigger', 'status', 'idempotency_key'],
    enums: {
      run_kind: ['inbox_nightly', 'inbox_manual', 'correction_reprocess', 'backfill'],
      trigger: ['scheduled', 'manual', 'threshold', 'retry'],
      status: ['running', 'succeeded', 'partial', 'failed', 'degraded', 'skipped'],
    },
    defaults: { status: 'running', auto_written: 0, needs_confirm: 0, dropped: 0, failed_count: 0 },
    timestamps: ['started_at', 'finished_at'],
    localDates: ['local_date'],
    arrays: ['raw_record_ids'],
    objects: ['report_json'],
    types: { batch_id: 'string', idempotency_key: 'string' },
  },
  {
    name: 'task',
    unit: UNIT.CORE,
    prefix: 'tsk',
    required: ['title', 'status'],
    enums: {
      status: ['todo', 'doing', 'done', 'cancelled'],
      priority: ['none', 'low', 'medium', 'high'],
      time_kind: ['none', 'date', 'datetime', 'span', 'all_day'],
      work_kind: ['action', 'time_block'],
    },
    defaults: { status: 'todo', priority: 'none', time_kind: 'none', work_kind: 'action', sort_order: 0, pinned: false, repeat_rule: null },
    timestamps: [
      'scheduled_start_at',
      'scheduled_end_at',
      'due_at',
      'completed_at',
      'cancelled_at',
      'archived_at',
    ],
    localDates: ['scheduled_date', 'due_date'],
    types: {
      title: 'string',
      notes: 'string',
      estimate_minutes: 'number',
      sort_order: 'number',
      project_id: 'string',
      goal_id: 'string',
      list_id: 'string',
      group_id: 'string',
      parent_task_id: 'string',
      scheduled_tz: 'string',
      due_tz: 'string',
      cancelled_reason: 'string',
    },
    booleans: ['is_all_day', 'pinned'],
    // M8 schema v3：重复规则（可空对象；形状语义校验在 domain/task.js::normalizeRepeatRule）。
    objects: ['repeat_rule'],
  },
  {
    name: 'checklist_item',
    unit: UNIT.CORE,
    prefix: 'chk',
    required: ['task_id', 'title'],
    timestamps: ['done_at'],
    types: { title: 'string' },
    booleans: ['done'],
  },
  {
    name: 'project',
    unit: UNIT.CORE,
    prefix: 'prj',
    required: ['name', 'status'],
    enums: {
      status: ['active', 'paused', 'completed', 'cancelled', 'archived'],
      progress_mode: ['auto_by_tasks', 'manual'],
    },
    defaults: { status: 'active', progress_mode: 'auto_by_tasks', sort_order: 0 },
    timestamps: ['completed_at', 'paused_at', 'archived_at'],
    localDates: ['start_date', 'target_date'],
    types: { name: 'string', description: 'string', color: 'string', progress_pct: 'number', sort_order: 'number' },
  },
  {
    name: 'goal',
    unit: UNIT.CORE,
    prefix: 'gol',
    required: ['title', 'status'],
    enums: {
      status: ['active', 'paused', 'achieved', 'abandoned'],
      horizon: ['short', 'mid', 'long'],
      progress_mode: ['manual', 'auto_by_projects', 'auto_by_tasks'],
    },
    defaults: { status: 'active', horizon: 'mid', progress_mode: 'manual' },
    timestamps: ['achieved_at', 'archived_at'],
    localDates: ['start_date', 'target_date'],
    types: {
      title: 'string',
      description: 'string',
      success_criteria: 'string',
      abandoned_reason: 'string',
      progress_pct: 'number',
    },
  },
  {
    name: 'wish',
    unit: UNIT.CORE,
    prefix: 'wsh',
    required: ['title', 'status'],
    enums: { status: ['captured', 'considering', 'committed', 'deferred', 'discarded'] },
    defaults: { status: 'captured', sort_order: 0 },
    timestamps: ['converted_at', 'archived_at'],
    localDates: ['review_at'],
    types: { title: 'string', description: 'string', converted_to_goal_id: 'string' },
  },
  {
    name: 'habit',
    unit: UNIT.CORE,
    prefix: 'hab',
    required: ['name', 'status', 'frequency_rule', 'start_date'],
    enums: { status: ['active', 'paused', 'archived'], checkin_mode: ['manual', 'event_auto', 'either'] },
    defaults: { status: 'active', checkin_mode: 'either', sort_order: 0 },
    timestamps: ['paused_at', 'resumed_at', 'archived_at'],
    localDates: ['start_date', 'end_date'],
    objects: ['frequency_rule', 'period_rule', 'target_json', 'event_match_json'],
    // M18 schema v4：icon 为用户选择的图标（null = 按名称推导）；group_id 指向 habit_group（null = 未分组）。
    types: { name: 'string', time_hint: 'string', icon: 'string', group_id: 'string' },
  },
  {
    name: 'habit_checkin',
    unit: UNIT.CORE,
    prefix: 'hci',
    required: ['habit_id', 'local_date', 'status'],
    enums: {
      status: ['done', 'partial', 'skipped', 'not_done'],
      checkin_kind: ['manual', 'from_event', 'retro'],
    },
    defaults: { status: 'done', checkin_kind: 'manual' },
    timestamps: ['backfilled_at'],
    localDates: ['local_date'],
    objects: ['value_json'],
  },
  {
    name: 'event',
    unit: UNIT.CORE,
    prefix: 'evt',
    required: ['event_type', 'title', 'occurred_start_at', 'occurred_tz', 'time_precision'],
    enums: {
      event_type: [
        'exercise',
        'sleep',
        'meal',
        'work',
        'study',
        'meeting',
        'social',
        'mood',
        'health',
        'finance',
        'other',
      ],
      time_precision: ['exact', 'minute', 'hour', 'day', 'period', 'unknown'],
      validity: ['valid', 'corrected', 'retracted', 'superseded'],
    },
    defaults: { event_type: 'other', time_precision: 'minute', validity: 'valid', is_all_day: false },
    timestamps: ['occurred_start_at', 'occurred_end_at', 'retracted_at'],
    objects: ['payload_json'],
    types: { title: 'string', duration_minutes: 'number' },
    booleans: ['is_all_day'],
  },
  {
    name: 'metric',
    unit: UNIT.CORE,
    prefix: 'mtr',
    required: ['metric_code', 'value_num', 'unit', 'measured_at', 'measured_tz'],
    enums: { validity: ['valid', 'corrected', 'retracted', 'superseded'] },
    defaults: { validity: 'valid' },
    timestamps: ['measured_at', 'period_start', 'period_end'],
    types: { metric_code: 'string', value_num: 'number', unit: 'string' },
  },
  {
    name: 'state',
    unit: UNIT.CORE,
    prefix: 'st',
    required: ['subject_type', 'field', 'value_type', 'value_json', 'observed_at', 'status'],
    enums: {
      subject_type: ['user', 'task', 'project', 'habit', 'goal', 'environment'],
      value_type: ['number', 'string', 'boolean', 'json'],
      status: ['active', 'expired', 'retracted'],
    },
    defaults: { subject_type: 'user', status: 'active' },
    timestamps: ['observed_at', 'valid_from', 'valid_until'],
    types: { field: 'string' },
  },
  {
    name: 'state_change',
    unit: UNIT.LOG,
    prefix: 'stc',
    required: ['entity_type', 'entity_id', 'field', 'changed_at', 'actor_type', 'origin_type'],
    enums: {
      actor_type: ['user', 'agent', 'system', 'scheduler', 'import'],
      origin_type: ORIGIN_TYPES,
    },
    defaults: { reversible: true },
    timestamps: ['changed_at'],
    booleans: ['reversible'],
    types: { entity_type: 'string', entity_id: 'string', field: 'string' },
  },
  {
    name: 'tag',
    unit: UNIT.CORE,
    prefix: 'tag',
    required: ['name'],
    defaults: { usage_count: 0 },
    types: { name: 'string', color: 'string', emoji: 'string', description: 'string' },
  },
  {
    name: 'entity_tag',
    unit: UNIT.CORE,
    prefix: 'etag',
    required: ['tag_id', 'entity_type', 'entity_id'],
    enums: {
      entity_type: ['task', 'project', 'goal', 'wish', 'habit', 'event', 'memory', 'inbox_item'],
    },
  },
  {
    name: 'entity_link',
    unit: UNIT.CORE,
    prefix: 'lnk',
    required: ['from_type', 'from_id', 'to_type', 'to_id', 'link_type'],
    enums: {
      link_type: ['supports', 'evidence', 'converted_to', 'derived_from', 'related', 'contradicts', 'mentions'],
    },
    types: { from_type: 'string', from_id: 'string', to_type: 'string', to_id: 'string', weight: 'number' },
  },
  {
    name: 'evidence_link',
    unit: UNIT.CORE,
    prefix: 'evl',
    required: ['from_type', 'from_id', 'to_type', 'to_id', 'relation'],
    enums: {
      // M2 扩展（Lead 2026-11-13 拍板）：派生对象 ↔ 原始记录/事实的证据链双向可写。
      // from = 被证据支撑的主体（推断/记忆/建议/状态/操作日志/派生对象/原始记录）；
      // to   = 证据来源（原始记录/事件/指标/打卡/任务/愿望/状态变更）。
      from_type: [
        'agent_inference',
        'personal_memory',
        'assistant_suggestion',
        'state',
        'operation_log',
        'task',
        'event',
        'metric',
        'habit_checkin',
        'wish',
        'raw_record',
      ],
      to_type: ['raw_record', 'event', 'metric', 'habit_checkin', 'task', 'wish', 'state_change'],
      relation: ['supports', 'contradicts', 'derived_from', 'evidence_of'],
    },
    defaults: { relation: 'supports' },
    timestamps: ['stale_at'],
    objects: ['locator_json'],
    types: { excerpt: 'string', weight: 'number', created_by: 'string' },
  },
  {
    name: 'list',
    unit: UNIT.CORE,
    prefix: 'lst',
    required: ['name', 'kind'],
    enums: { kind: ['inbox', 'normal'] },
    defaults: { kind: 'normal', sort_order: 0, is_default: false },
    timestamps: ['archived_at'],
    types: { name: 'string', color: 'string', icon: 'string', sort_order: 'number' },
    booleans: ['is_default'],
  },
  {
    // M6 schema v2：清单内分组（用户自定义分组；sort_order 手工排序，collapsed 折叠状态）
    name: 'group',
    unit: UNIT.CORE,
    prefix: 'grp',
    required: ['list_id', 'name'],
    defaults: { sort_order: 0, collapsed: false },
    timestamps: ['archived_at'],
    types: { list_id: 'string', name: 'string', color: 'string', sort_order: 'number' },
    booleans: ['collapsed'],
  },
  {
    // M18 schema v4：习惯一级分组（独立表，不复用任务 list/group；sort_order 手工排序，collapsed 折叠状态）。
    name: 'habit_group',
    unit: UNIT.CORE,
    prefix: 'hgrp',
    required: ['name'],
    defaults: { sort_order: 0, collapsed: false },
    timestamps: ['archived_at'],
    types: { name: 'string', sort_order: 'number' },
    booleans: ['collapsed'],
  },
  {
    name: 'reminder',
    unit: UNIT.CORE,
    prefix: 'rmd',
    required: ['target_type', 'rule_json', 'channel', 'enabled'],
    enums: {
      target_type: ['task', 'habit', 'inbox_item', 'project', 'date'],
      channel: ['in_chat', 'system_notify', 'badge'],
    },
    defaults: { channel: 'in_chat', enabled: true, fire_count: 0, dnd_override: false },
    timestamps: ['next_fire_at', 'last_fired_at', 'valid_from', 'valid_until'],
    objects: ['rule_json'],
    booleans: ['enabled', 'dnd_override'],
    types: { fire_count: 'number' },
  },
  {
    name: 'attachment',
    unit: UNIT.CORE,
    prefix: 'att',
    required: ['owner_type', 'owner_id', 'file_name', 'mime_type', 'size_bytes', 'storage_ref', 'sha256'],
    types: {
      owner_type: 'string',
      owner_id: 'string',
      file_name: 'string',
      mime_type: 'string',
      size_bytes: 'number',
      storage_ref: 'string',
      sha256: 'string',
    },
  },
  {
    name: 'personal_memory',
    unit: UNIT.CORE,
    prefix: 'mem',
    required: ['category', 'content', 'status'],
    enums: {
      category: [
        'stable_preference',
        'phase_goal',
        'temporary_state',
        'fact',
        'boundary',
        'skill',
        'relationship',
      ],
      status: ['active', 'expired', 'archived', 'retracted'],
      sensitivity: ['normal', 'sensitive'],
    },
    defaults: { category: 'fact', status: 'active', sensitivity: 'normal' },
    timestamps: ['valid_from', 'valid_until'],
    objects: ['structured_json'],
    types: { content: 'string' },
  },
  {
    name: 'agent_inference',
    unit: UNIT.CORE,
    prefix: 'inf',
    required: ['inference_type', 'subject_type', 'claim', 'confidence', 'status'],
    enums: {
      inference_type: [
        'task_classification',
        'completion_detection',
        'habit_detection',
        'event_extraction',
        'behavior_pattern',
        'energy_pattern',
        'plan_adjustment',
        'memory_suggestion',
      ],
      subject_type: ['user', 'raw_record', 'inbox_item', 'task', 'event', 'habit', 'project', 'memory'],
      status: ['active', 'confirmed', 'rejected', 'expired', 'retracted', 'superseded'],
    },
    defaults: { inference_type: 'behavior_pattern', status: 'active' },
    timestamps: ['first_observed_at', 'last_observed_at', 'expires_at'],
    objects: ['claim_json', 'confidence_factors', 'proposed_action_json'],
    types: { claim: 'string', confidence: 'number', sample_size: 'number' },
  },
  {
    name: 'assistant_suggestion',
    unit: UNIT.CORE,
    prefix: 'sug',
    required: ['suggestion_type', 'trigger_source', 'topic_key', 'status', 'expected_signal', 'proposed_at'],
    enums: {
      suggestion_type: ['coach', 'plan', 'nudge', 'review'],
      trigger_source: ['chat', 'schedule', 'organize', 'user_command'],
      status: [
        'proposed',
        'accepted',
        'rejected',
        'in_progress',
        'executed',
        'not_executed',
        'reviewed',
        'expired',
        'superseded',
      ],
      outcome: ['achieved', 'partial', 'not_achieved', 'unknown'],
    },
    defaults: {
      status: 'proposed',
      options: [],
      problem_tags: [],
      theory_tags: [],
      context_snapshot: {},
      evidence_refs: [],
    },
    timestamps: [
      'proposed_at',
      'accepted_at',
      'follow_up_at',
      'reviewed_at',
      'cooldown_until',
    ],
    arrays: ['options', 'problem_tags', 'theory_tags', 'evidence_refs'],
    objects: ['context_snapshot', 'expected_signal'],
    types: { topic_key: 'string', chosen_index: 'number', user_rating: 'number' },
  },
  {
    name: 'notification_outbox',
    unit: UNIT.CORE,
    prefix: 'notif',
    required: ['kind', 'title', 'body', 'priority', 'dedupe_key', 'status', 'channel', 'expires_at'],
    enums: {
      kind: ['morning_brief', 'deadline_reminder', 'organize_report', 'habit_ask', 'coach_nudge', 'system'],
      priority: ['P0', 'P1', 'P2', 'P3', 'P4'],
      status: ['pending', 'delivered', 'dismissed', 'expired'],
      channel: ['in_app', 'desktop_notify', 'badge'],
    },
    defaults: { status: 'pending', channel: 'in_app', priority: 'P2', action_json: [], attempt_count: 0 },
    timestamps: ['delivered_at', 'read_at', 'replied_at', 'dismissed_at', 'expired_at', 'expires_at'],
    arrays: ['action_json'],
    types: { title: 'string', body: 'string', dedupe_key: 'string', attempt_count: 'number' },
  },
  {
    name: 'permission',
    unit: UNIT.CORE,
    prefix: 'prm',
    required: ['action_pattern', 'permission_level', 'status'],
    enums: {
      permission_level: ['L0', 'L1', 'L2', 'L3', 'forbidden'],
      scope_type: ['global', 'entity_type', 'entity'],
      status: ['active', 'paused', 'revoked', 'expired'],
      grant_kind: ['once', 'standing'],
    },
    defaults: { status: 'active', grant_kind: 'standing', scope_type: 'global' },
    timestamps: ['valid_from', 'valid_until', 'granted_at', 'revoked_at'],
    objects: ['scope_json', 'conditions_json'],
    types: { action_pattern: 'string', remaining_uses: 'number' },
  },
  {
    name: 'operation_log',
    unit: UNIT.LOG,
    prefix: 'opl',
    required: ['actor_type', 'action', 'decision', 'status', 'occurred_at'],
    enums: {
      actor_type: ['user', 'agent', 'system', 'scheduler', 'import'],
      decision: ['allowed', 'needs_confirm', 'denied'],
      status: ['applied', 'proposed', 'undone', 'failed', 'dry_run'],
    },
    defaults: { status: 'applied', reversible: true },
    timestamps: ['occurred_at'],
    booleans: ['reversible'],
    arrays: ['target_ids_json', 'state_change_ids', 'evidence_refs'],
    objects: ['before_json', 'after_json', 'diff_json', 'undo_patch_json'],
    types: {
      action: 'string',
      permission_level: 'string',
      idempotency_key: 'string',
      duration_ms: 'number',
    },
  },
  {
    name: 'app_setting',
    unit: UNIT.CORE,
    prefix: null,
    keyMode: 'key',
    required: ['value_json'],
    timestamps: ['updated_at'],
  },
]

/** journal（基础设施表，log unit；字段按 M0-PLAN §3.5 冻结形态） */
const JOURNAL_DEF = {
  name: JOURNAL_TABLE,
  unit: UNIT.LOG,
  prefix: 'jrn',
  required: ['status', 'ops', 'createdAt'],
  enums: { status: ['pending', 'committed', 'failed'] },
  defaults: { status: 'pending', source: 'service' },
  timestamps: ['createdAt', 'updated_at'],
  arrays: ['ops'],
  types: { source: 'string', error: 'string' },
}

const DEFS = [...BUSINESS_DEFS, JOURNAL_DEF]

/** @type {Record<string, object>} 表名 → 规格 */
export const TABLE_SPECS = Object.freeze(
  Object.fromEntries(
    DEFS.map((def) => {
      const spec = {
        name: def.name,
        unit: def.unit,
        prefix: def.prefix ?? null,
        keyMode: def.keyMode ?? 'ulid',
        required: Object.freeze([...(def.required ?? [])]),
        enums: Object.freeze(
          Object.fromEntries(
            Object.entries({
              ...(def.keyMode === 'key' || def.name === JOURNAL_TABLE ? {} : C_GROUP_ENUMS),
              ...(def.enums ?? {}),
            }).map(([field, values]) => [field, Object.freeze([...values])]),
          ),
        ),
        defaults: Object.freeze({ ...(def.defaults ?? {}) }),
        timestamps: Object.freeze([
          ...new Set([
            ...(def.name === JOURNAL_TABLE ? [] : C_GROUP_TIMESTAMPS),
            ...(def.timestamps ?? []),
          ]),
        ]),
        localDates: Object.freeze([...(def.localDates ?? [])]),
        types: Object.freeze({ ...(def.types ?? {}), ...(def.name === JOURNAL_TABLE ? {} : { id: 'string' }) }),
        arrays: Object.freeze([...(def.arrays ?? [])]),
        objects: Object.freeze([...(def.objects ?? [])]),
        booleans: Object.freeze([...(def.booleans ?? [])]),
      }
      spec.validate = (record) => validateWithSpec(spec, record)
      return [def.name, Object.freeze(spec)]
    }),
  ),
)

/** 30 张业务表名（不含 journal）；用于建表/统计/测试。 */
export const BUSINESS_TABLES = Object.freeze(BUSINESS_DEFS.map((d) => d.name))

/** unit → 表名数组（含 journal；表名一次定全）。 */
export const UNIT_TABLES = Object.freeze(
  Object.fromEntries(
    UNIT_NAMES.map((unit) => [unit, Object.freeze(DEFS.filter((d) => d.unit === unit).map((d) => d.name))]),
  ),
)

/** 表 → unit。 */
export function unitOf(table) {
  const spec = TABLE_SPECS[table]
  return spec ? spec.unit : null
}

/** unit → 表名数组（副本）。 */
export function tablesForUnit(unit) {
  const list = UNIT_TABLES[unit]
  return list ? [...list] : []
}

/** 表是否在冻结清单内。 */
export function isKnownTable(table) {
  return typeof table === 'string' && Object.prototype.hasOwnProperty.call(TABLE_SPECS, table)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkId(spec, record, errors) {
  if (spec.keyMode === 'key') {
    const key = record.key ?? record.id
    if (typeof key !== 'string' || key.length === 0) {
      errors.push('id: app_setting 需要非空 key 或 id')
    }
    return
  }
  const id = record.id
  if (typeof id !== 'string' || id.length === 0) {
    errors.push('id: required')
    return
  }
  if (spec.prefix && !isId(id, spec.prefix)) {
    errors.push(`id: 必须是 ${spec.prefix}_ + 26 位 Crockford Base32`)
  }
}

function checkJournalOps(record, errors) {
  if (!Array.isArray(record.ops)) return // 已由 arrays 检查报错
  if (record.ops.length === 0) errors.push('ops: 事务至少包含 1 个 op')
  record.ops.forEach((op, index) => {
    const where = `ops[${index}]`
    if (!isPlainObject(op)) {
      errors.push(`${where}: 必须是对象`)
      return
    }
    if (!UNIT_NAMES.includes(op.unit)) errors.push(`${where}.unit: 非法 unit ${String(op.unit)}`)
    if (typeof op.table !== 'string' || !isKnownTable(op.table)) {
      errors.push(`${where}.table: 未知表 ${String(op.table)}`)
      return
    }
    if (op.table === JOURNAL_TABLE) errors.push(`${where}.table: 不允许在事务内写 journal`)
    const spec = TABLE_SPECS[op.table]
    if (op.unit !== spec.unit) {
      errors.push(`${where}.unit: ${op.table} 属于 ${spec.unit}，收到 ${String(op.unit)}`)
    }
    if (typeof op.key !== 'string' || op.key.length === 0) errors.push(`${where}.key: 必须是字符串`)
    if (!(op.value === null || isPlainObject(op.value))) {
      errors.push(`${where}.value: 必须是对象或 null（null=删除）`)
    }
  })
}

function validateWithSpec(spec, record) {
  const errors = []
  if (!isPlainObject(record)) {
    return { ok: false, errors: ['record: 必须是普通对象'] }
  }

  checkId(spec, record, errors)

  for (const field of spec.required) {
    const value = record[field]
    if (value === undefined || value === null) {
      errors.push(`${field}: required`)
      continue
    }
    if (typeof value === 'string' && value.length === 0) errors.push(`${field}: 不能为空字符串`)
  }

  for (const [field, allowed] of Object.entries(spec.enums)) {
    const value = record[field]
    if (value === undefined || value === null) continue
    if (!allowed.includes(value)) {
      errors.push(`${field}: 非法枚举值 ${JSON.stringify(value)}（允许：${allowed.join('|')}）`)
    }
  }

  for (const [field, type] of Object.entries(spec.types)) {
    const value = record[field]
    if (value === undefined || value === null) continue
    if (type === 'string' && typeof value !== 'string') errors.push(`${field}: 必须是字符串`)
    if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      errors.push(`${field}: 必须是有限数字`)
    }
  }

  for (const field of spec.booleans) {
    const value = record[field]
    if (value === undefined || value === null) continue
    if (typeof value !== 'boolean') errors.push(`${field}: 必须是布尔值`)
  }

  for (const field of spec.arrays) {
    const value = record[field]
    if (value === undefined || value === null) continue
    if (!Array.isArray(value)) errors.push(`${field}: 必须是数组`)
  }

  for (const field of spec.objects) {
    const value = record[field]
    if (value === undefined || value === null) continue
    if (!isPlainObject(value)) errors.push(`${field}: 必须是对象`)
  }

  for (const field of spec.timestamps) {
    const value = record[field]
    if (value === undefined || value === null) continue
    if (!isIsoTimestamp(value)) errors.push(`${field}: 必须是 UTC ISO 时刻（毫秒 + Z）`)
  }

  for (const field of spec.localDates) {
    const value = record[field]
    if (value === undefined || value === null) continue
    if (!isLocalDate(value)) errors.push(`${field}: 必须是 YYYY-MM-DD 自然日`)
  }

  // 通用取值范围
  if (typeof record.confidence === 'number') {
    if (!(record.confidence >= 0 && record.confidence <= 1)) errors.push('confidence: 必须在 0..1')
  } else if (record.confidence !== undefined && record.confidence !== null) {
    errors.push('confidence: 必须是数字')
  }
  if (record.rev !== undefined && record.rev !== null && (!Number.isInteger(record.rev) || record.rev < 1)) {
    errors.push('rev: 必须是 >=1 的整数')
  }
  if (
    record.schema_version !== undefined &&
    record.schema_version !== null &&
    (!Number.isInteger(record.schema_version) || record.schema_version < 1)
  ) {
    errors.push('schema_version: 必须是 >=1 的整数')
  }

  if (spec.name === JOURNAL_TABLE && Array.isArray(record.ops)) {
    if (record.ops.length === 0) errors.push('ops: 事务至少包含 1 个 op')
    else checkJournalOps(record, errors)
  }

  return { ok: errors.length === 0, errors }
}

/**
 * 校验一条记录。
 * @param {string} table
 * @param {object} record
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateRecord(table, record) {
  const spec = TABLE_SPECS[table]
  if (!spec) return { ok: false, errors: [`table: 未知表 ${String(table)}`] }
  return spec.validate(record)
}

function cloneJson(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

/**
 * 写入前的规范化：补齐 schema 默认值、注入通用列（id/created_at/updated_at/rev/schema_version）。
 * 不修改入参；返回新对象。业务层可选使用；`LifeosStore` 在写路径上自动调用。
 * @param {string} table
 * @param {object} record
 * @param {{key?: string, now?: string}} [context]
 */
export function normalizeRecord(table, record, context = {}) {
  const spec = TABLE_SPECS[table]
  if (!spec) throw new TypeError(`unknown table: ${String(table)}`)
  if (!isPlainObject(record)) throw new TypeError(`record for ${table} must be object`)
  const out = cloneJson(record)
  for (const [field, value] of Object.entries(spec.defaults)) {
    if (out[field] === undefined) out[field] = cloneJson(value)
  }
  if (spec.keyMode === 'key') {
    if (context.key !== undefined && out.key === undefined) out.key = context.key
    if (context.key !== undefined && out.id === undefined) out.id = context.key
    if (out.updated_at === undefined) out.updated_at = context.now ?? new Date().toISOString()
    return out
  }
  if (context.key !== undefined && out.id === undefined) out.id = context.key
  if (spec.name !== JOURNAL_TABLE) {
    const now = context.now ?? new Date().toISOString()
    if (out.created_at === undefined) out.created_at = now
    if (out.updated_at === undefined) out.updated_at = out.created_at
    if (out.rev === undefined) out.rev = 1
    if (out.schema_version === undefined) out.schema_version = 1
  }
  return out
}

export const withDefaults = normalizeRecord

export const ENUMS = Object.freeze({
  origin_type: ORIGIN_TYPES,
  confirmation_status: CONFIRMATION_STATUSES,
})
