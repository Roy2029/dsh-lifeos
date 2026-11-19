/**
 * B：M2 Inbox 整理服务（M2-PLAN §2/§3.1）。
 *
 * 职责：
 *  - runTriage：规则抽取（A 的 `extractCandidates`，缺失时保守 fallback）→ 写 extraction_run + 候选（run 内）；
 *    runKey 幂等；raw.processing_status 推进；候选不落业务表。
 *  - listTriagePending：待整理 raw 分组（raw + inbox + 候选 + runId）。
 *  - applyTriage：**一个 journal 事务**写目标对象 + evidence_link + raw/inbox 状态 + state_change + oplog；
 *    失败补偿回滚；同 run 重复 apply 幂等。
 *  - reprocessRaw / correctDerived / triageStatus / automation get/set。
 *
 * 写作用域：src/application/**（B 所有）。不 import 第三方包。
 */

import { LifeosError } from './errors.js';
import { extractCandidates, recomputeAfterCorrection } from './triage-rules.js';
import { addDays } from '../domain/time.js';

const CORE = 'lifeos';
const RAW = 'lifeos_raw';
const LOG = 'lifeos_log';

const RAW_PENDING = ['pending', 'processing', 'partial'];
const EVENT_TYPES = new Set([
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
]);
const TIME_PRECISIONS = new Set(['exact', 'minute', 'hour', 'day', 'period', 'unknown']);
const CORRECT_TABLES = Object.freeze({
  task: 'task',
  event: 'event',
  metric: 'metric',
  habit_checkin: 'habit_checkin',
  wish: 'wish',
});
const METRIC_UNIT_OK = new Set(['步', '分钟', '小时', '组', 'kg', 'g', 'ml', '次', '毫克', 'mg', '杯', '个']);

/** inbox_item.suggested_kind 是展示快照，枚举不含 metric/habit_checkin。 */
const SUGGESTED_KIND_MAP = Object.freeze({
  task: 'task',
  event: 'event',
  wish: 'wish',
  metric: 'none',
  habit_checkin: 'habit',
  ignore: 'none',
});

function localDateOfIso(isoValue, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(isoValue));
    const pick = (type) => parts.find((part) => part.type === type)?.value;
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
  } catch {
    return String(isoValue || '').slice(0, 10);
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {object} deps
 * @param {object} deps.store LifeosStore
 * @param {(prefix?:string)=>string} deps.newId
 * @param {()=>number} deps.now
 * @param {string} deps.timeZone
 * @param {(kind:string, ids:string[], extra?:object)=>void} [deps.emitChanged]
 * @param {object} [deps.scheduler] createScheduler()
 * @param {object} [deps.diagnostics]
 */
export function createTriageOps(deps) {
  const { store, newId, now, timeZone } = deps;
  const emitChanged = typeof deps.emitChanged === 'function' ? deps.emitChanged : () => {};
  const scheduler = deps.scheduler || null;
  const diagnostics = deps.diagnostics || null;

  function isoNow() {
    return iso(now());
  }

  function todayLocal() {
    return localDateOfIso(isoNow(), timeZone) || isoNow().slice(0, 10);
  }

  function entries(unit, table) {
    try {
      return store.entries(unit, table);
    } catch {
      return [];
    }
  }

  function get(unit, table, key) {
    try {
      const record = store.get(unit, table, key);
      return record ?? null;
    } catch {
      return null;
    }
  }

  function assertWritable() {
    if (store.degraded === true) throw new LifeosError('store_unavailable', '存储不可用（只读降级）');
  }

  function rawRecords() {
    return entries(RAW, 'raw_record')
      .map(([, record]) => record)
      .filter((record) => record && !record.deleted_at);
  }

  function inboxItems() {
    return entries(CORE, 'inbox_item').map(([, record]) => record).filter(Boolean);
  }

  function runs() {
    return entries(CORE, 'extraction_run').map(([, record]) => record).filter(Boolean);
  }

  function latestRunForRaw(rawRecordId) {
    const list = runs()
      .filter((run) => Array.isArray(run.raw_record_ids) && run.raw_record_ids.includes(rawRecordId))
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    return list[0] || null;
  }

  function findRunByRunKey(runKey) {
    return runs().find((run) => run.idempotency_key === runKey) || null;
  }

  function rawLite(record) {
    return {
      id: record.id,
      text: record.raw_text,
      channel: record.channel,
      userLocalDate: record.user_local_date,
      processingStatus: record.processing_status,
      createdAt: record.created_at,
      tz: record.tz,
    };
  }

  function inboxLite(record) {
    if (!record) return null;
    return {
      id: record.id,
      title: record.title,
      status: record.status,
      suggestedKind: record.suggested_kind ?? 'none',
      priority: record.priority ?? 'none',
      rawRecordId: record.raw_record_id ?? null,
      createdAt: record.created_at,
    };
  }

  function runView(record) {
    if (!record) return null;
    const report = isPlainObject(record.report_json) ? record.report_json : {};
    return {
      id: record.id,
      runKey: record.idempotency_key,
      runKind: record.run_kind,
      localDate: record.local_date,
      status: record.status,
      trigger: record.trigger,
      counts: {
        raw: record.scanned_count ?? 0,
        candidates: record.candidates ?? 0,
        autoWritten: record.auto_written ?? 0,
        needsConfirm: record.needs_confirm ?? 0,
        dropped: record.dropped ?? 0,
        failed: record.failed_count ?? 0,
      },
      candidates: Array.isArray(report.candidates) ? report.candidates : [],
      appliedAt: report.appliedAt || null,
      appliedCandidateIds: Array.isArray(report.appliedCandidateIds) ? report.appliedCandidateIds : [],
      duplicateCandidateIds: Array.isArray(report.duplicateCandidateIds) ? report.duplicateCandidateIds : [],
      duplicates: Array.isArray(report.duplicates) ? report.duplicates : [],
      ignoredCandidateIds: Array.isArray(report.ignoredCandidateIds) ? report.ignoredCandidateIds : [],
      applyComplete: report.applyComplete === true,
      applyResult: report.applyResult || null,
      startedAt: record.started_at,
      finishedAt: record.finished_at,
      createdAt: record.created_at,
      error: record.error ?? null,
    };
  }

  function normalizeCandidate(rawRecordId, candidate, index) {
    const kind = CORRECT_TABLES[candidate?.kind] || candidate?.kind;
    const source = isPlainObject(candidate?.source) ? candidate.source : {};
    const fields = isPlainObject(candidate?.fields) ? candidate.fields : {};
    return {
      candidateId: typeof candidate?.candidateId === 'string' ? candidate.candidateId : `${newId('cand')}`,
      rawRecordId,
      kind,
      confidence: typeof candidate?.confidence === 'number' ? Math.max(0, Math.min(1, candidate.confidence)) : 0.5,
      source: {
        quote: textOf(source.quote),
        start: Number.isInteger(source.start) ? source.start : null,
        end: Number.isInteger(source.end) ? source.end : null,
      },
      fields,
      reasons: Array.isArray(candidate?.reasons) ? candidate.reasons.map(String) : [],
      risks: Array.isArray(candidate?.risks) ? candidate.risks.map(String) : [],
      requiresConfirm: candidate?.requiresConfirm !== false || index === -1,
    };
  }

  function dedupeCandidates(list) {
    const seen = new Set();
    const out = [];
    for (const candidate of list) {
      const key = [
        candidate.kind,
        candidate.fields.title || candidate.fields.metric_code || candidate.fields.event_type || candidate.fields.habit_id || '',
        candidate.fields.local_date || candidate.fields.occurred_date || candidate.fields.due_date || '',
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
    }
    return out;
  }

  function oplogRecord({ action, targetType, targetId, before, after, stateChangeIds, nowIso, idempotencyKey, status = 'applied', error }) {
    const record = {
      id: newId('opl'),
      actor_type: 'user',
      actor_ref: null,
      action,
      target_type: targetType,
      target_id: targetId,
      target_ids_json: targetId ? [targetId] : [],
      permission_id: null,
      permission_level: 'L2',
      decision: 'allowed',
      status,
      before_json: before ?? null,
      after_json: after ?? null,
      diff_json: null,
      state_change_ids: Array.isArray(stateChangeIds) ? stateChangeIds : null,
      evidence_refs: [],
      undo_of_id: null,
      reversible: true,
      undo_patch_json: null,
      reason: null,
      idempotency_key: typeof idempotencyKey === 'string' && idempotencyKey.length > 0 ? idempotencyKey : null,
      occurred_at: nowIso,
      duration_ms: null,
      error: error === undefined ? null : String(error).slice(0, 500),
      meta_json: { source: 'm2' },
    };
    return record;
  }

  function stateChangeRecords(entityType, entityId, diffs, nowIso, actorType = 'user') {
    return diffs.map((diff) => ({
      id: newId('stc'),
      entity_type: entityType,
      entity_id: entityId,
      field: diff.field,
      old_value: diff.oldValue === undefined ? null : diff.oldValue,
      new_value: diff.newValue === undefined ? null : diff.newValue,
      changed_at: nowIso,
      actor_type: actorType,
      actor_ref: null,
      origin_type: 'user_stated',
      reason: null,
      permission_id: null,
      operation_log_id: null,
      rev_after: diff.revAfter ?? null,
      reversible: true,
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      schema_version: 1,
      meta_json: null,
    }));
  }

  function evidenceLinkRecord({ operationLogId, rawRecordId, targetType, targetId, candidate, nowIso }) {
    return {
      id: newId('evl'),
      from_type: 'operation_log',
      from_id: operationLogId,
      to_type: 'raw_record',
      to_id: rawRecordId,
      relation: 'derived_from',
      locator_json: {
        target_type: targetType,
        target_id: targetId,
        candidate_id: candidate.candidateId,
        span: candidate.source?.start !== null && candidate.source?.end !== null
          ? [candidate.source.start, candidate.source.end]
          : null,
        excerpt: candidate.source?.quote || null,
      },
      excerpt: candidate.source?.quote || null,
      weight: candidate.confidence,
      stale_at: null,
      created_by: 'system',
      created_at: nowIso,
      schema_version: 1,
    };
  }

  function originRef(candidate) {
    const span = candidate.source?.start !== null && candidate.source?.end !== null
      ? [candidate.source.start, candidate.source.end]
      : undefined;
    return span ? { raw_record_id: candidate.rawRecordId, span } : { raw_record_id: candidate.rawRecordId };
  }

  function evidenceRefs(candidate) {
    return [
      {
        type: 'raw_record',
        id: candidate.rawRecordId,
        locator: candidate.source?.start !== null && candidate.source?.end !== null
          ? { span: [candidate.source.start, candidate.source.end] }
          : {},
        excerpt: candidate.source?.quote || undefined,
      },
    ];
  }

  function baseOrigin(candidate, nowIso) {
    return {
      origin_type: 'record_extraction',
      origin_ref: originRef(candidate),
      origin_key: `record_extraction:${candidate.rawRecordId}:${candidate.candidateId}`,
      confidence: candidate.confidence,
      confirmation_status: 'confirmed',
      evidence_refs: evidenceRefs(candidate),
      meta_json: { candidate_id: candidate.candidateId, rule_version: 'm2' },
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      deleted_at: null,
      schema_version: 1,
    };
  }

  function buildTarget(candidate, nowIso, patch = null) {
    const fields = { ...candidate.fields, ...(isPlainObject(patch) ? patch : {}) };
    const origin = baseOrigin(candidate, nowIso);
    if (candidate.kind === 'task') {
      const title = textOf(fields.title).trim() || textOf(candidate.source?.quote).trim().slice(0, 500);
      if (!title) throw new LifeosError('validation_failed', '任务候选缺少 title');
      const dueDate = typeof fields.due_date === 'string' ? fields.due_date : null;
      const scheduledDate = typeof fields.scheduled_date === 'string' ? fields.scheduled_date : null;
      return {
        unit: CORE,
        table: 'task',
        value: {
          id: newId('tsk'),
          title: title.slice(0, 500),
          notes: fields.notes ?? null,
          work_kind: 'action',
          time_kind: scheduledDate ? 'all_day' : 'none',
          scheduled_date: scheduledDate,
          scheduled_start_at: null,
          scheduled_end_at: null,
          scheduled_tz: scheduledDate ? timeZone : null,
          is_all_day: Boolean(scheduledDate),
          due_date: dueDate,
          due_at: null,
          due_tz: dueDate ? timeZone : null,
          status: 'todo',
          priority: ['none', 'low', 'medium', 'high'].includes(fields.priority) ? fields.priority : 'none',
          project_id: null,
          goal_id: null,
          parent_task_id: null,
          list_id: null,
          estimate_minutes: null,
          completed_at: null,
          completed_origin: null,
          cancelled_at: null,
          cancelled_reason: null,
          archived_at: null,
          recurrence_rule: null,
          recurrence_tz: null,
          sort_order: 0,
          ...origin,
        },
        entityType: 'task',
      };
    }
    if (candidate.kind === 'event') {
      const day = textOf(fields.local_date) || textOf(fields.occurred_date) || candidate.fields.local_date;
      const occurredStartAt = typeof fields.occurred_start_at === 'string'
        ? fields.occurred_start_at
        : day
          ? `${day}T00:00:00.000Z`
          : `${todayLocal()}T00:00:00.000Z`;
      const rawType = textOf(fields.event_type);
      const eventType = EVENT_TYPES.has(rawType) ? rawType : 'other';
      const rawPrecision = textOf(fields.time_precision);
      const precision = TIME_PRECISIONS.has(rawPrecision) ? rawPrecision : 'day';
      return {
        unit: CORE,
        table: 'event',
        value: {
          id: newId('evt'),
          event_type: eventType,
          title: textOf(fields.title).trim() || textOf(fields.event_type) || '活动',
          notes: fields.notes ?? null,
          occurred_start_at: occurredStartAt,
          occurred_end_at: null,
          occurred_tz: textOf(fields.occurred_tz) || timeZone,
          time_precision: precision,
          validity: 'valid',
          task_id: null,
          habit_id: null,
          raw_record_id: candidate.rawRecordId,
          payload_json: null,
          ...origin,
        },
        entityType: 'event',
      };
    }
    if (candidate.kind === 'metric') {
      const code = textOf(fields.metric_code);
      const value = Number(fields.value_num);
      if (!code) throw new LifeosError('validation_failed', '指标候选缺少 metric_code');
      if (!Number.isFinite(value)) throw new LifeosError('validation_failed', '指标候选 value_num 非法');
      const unit = textOf(fields.unit) || '个';
      return {
        unit: CORE,
        table: 'metric',
        value: {
          id: newId('mtr'),
          metric_code: code,
          value_num: value,
          unit: METRIC_UNIT_OK.has(unit) ? unit : unit.slice(0, 16),
          measured_at: typeof fields.measured_at === 'string' ? fields.measured_at : nowIso,
          measured_tz: textOf(fields.measured_tz) || timeZone,
          validity: 'valid',
          event_id: null,
          raw_record_id: candidate.rawRecordId,
          source_label: null,
          ...origin,
        },
        entityType: 'metric',
      };
    }
    if (candidate.kind === 'wish') {
      const title = textOf(fields.title).trim();
      if (!title) throw new LifeosError('validation_failed', '愿望候选缺少 title');
      return {
        unit: CORE,
        table: 'wish',
        value: {
          id: newId('wsh'),
          title: title.slice(0, 500),
          notes: fields.notes ?? null,
          status: ['captured', 'considering', 'committed', 'deferred', 'discarded'].includes(fields.status)
            ? fields.status
            : 'captured',
          review_at: null,
          converted_to_goal_id: null,
          ...origin,
        },
        entityType: 'wish',
      };
    }
    if (candidate.kind === 'habit_checkin') {
      const habitId = textOf(fields.habit_id);
      if (!habitId) throw new LifeosError('validation_failed', '习惯打卡候选缺少 habit_id（M2 不自动建习惯）');
      const habit = get(CORE, 'habit', habitId);
      if (!habit) throw new LifeosError('validation_failed', `习惯不存在：${habitId}`);
      const localDate = textOf(fields.local_date) || todayLocal();
      if (localDate > todayLocal()) throw new LifeosError('validation_failed', '不能为未来日期打卡');
      const existing = entries(CORE, 'habit_checkin').find(
        ([, record]) => record && record.habit_id === habitId && record.local_date === localDate && !record.deleted_at,
      );
      if (existing) throw new LifeosError('conflict', '该习惯当日已打卡', { current: existing[1] });
      return {
        unit: CORE,
        table: 'habit_checkin',
        value: {
          id: newId('hci'),
          habit_id: habitId,
          local_date: localDate,
          status: ['done', 'partial', 'skipped', 'not_done'].includes(fields.status) ? fields.status : 'done',
          value_json: null,
          note: fields.note ?? null,
          event_id: null,
          origin_type: 'record_extraction',
          origin_ref: originRef(candidate),
          origin_key: `record_extraction:${candidate.rawRecordId}:${candidate.candidateId}`,
          confidence: candidate.confidence,
          confirmation_status: 'confirmed',
          evidence_refs: evidenceRefs(candidate),
          meta_json: { candidate_id: candidate.candidateId },
          created_at: nowIso,
          updated_at: nowIso,
          rev: 1,
          deleted_at: null,
          schema_version: 1,
        },
        entityType: 'habit_checkin',
      };
    }
    return null;
  }

  /* ───────── runTriage ───────── */

  /**
   * 默认 runKey（M2-B2）：
   * - 显式 runKey（nightly `inbox_nightly:<date>` / D 指定）→ 幂等复用；
   * - 带 requestId → `inbox:<date>:<mode>:req:<requestId>`（同请求幂等）；
   * - 否则每次唯一：`inbox:<date>:<mode>:<seq>`（同日再次手动整理会开新 run）。
   */
  function defaultRunKey(input, mode, localDate) {
    if (typeof input.runKey === 'string' && input.runKey.length > 0) return input.runKey;
    const normalizedMode = mode === 'both' ? 'agent' : mode;
    if (typeof input.requestId === 'string' && input.requestId.length > 0) {
      return `inbox:${localDate}:${normalizedMode}:req:${input.requestId}`;
    }
    const prefix = `inbox:${localDate}:${normalizedMode}:`;
    const used = runs()
      .map((run) => run.idempotency_key)
      .filter((key) => typeof key === 'string' && key.startsWith(prefix));
    return `${prefix}${used.length + 1}`;
  }

  async function runTriage(input = {}) {
    assertWritable();
    const mode = input.mode || 'rules';
    const localDate = todayLocal();
    const runKey = defaultRunKey(input, mode, localDate);
    const existing = findRunByRunKey(runKey);
    if (existing) {
      return {
        runId: existing.id,
        run: runView(existing),
        candidates: runView(existing).candidates,
        counts: runView(existing).counts,
        alreadyDone: true,
        needsAgent: false,
      };
    }

    // D 的 lifeos_triage.begin：mode='agent' 时只建 run + 返回待抽取批次，不自动生成候选
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
    if (mode === 'agent') {
      return await beginAgentRun(input, runKey, limit);
    }
    let candidatesRaw;
    if (Array.isArray(input.rawRecordIds) && input.rawRecordIds.length > 0) {
      const wanted = new Set(input.rawRecordIds.map(String));
      candidatesRaw = rawRecords().filter((record) => wanted.has(record.id));
    } else {
      candidatesRaw = rawRecords()
        .filter((record) => RAW_PENDING.includes(record.processing_status) || record.processing_status === undefined)
        .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
    }
    const selected = candidatesRaw.slice(0, limit);
    const nowIso = isoNow();
    const runId = newId('xrun');
    const collected = [];
    const rawOps = [];
    const inboxOps = [];
    const stateChanges = [];
    let failedCount = 0;
    for (const raw of selected) {
      try {
        const produced = extractCandidates(raw.raw_text, { localDate, timeZone, nowIso });
        const normalized = dedupeCandidates(
          (Array.isArray(produced) ? produced : []).map((candidate, index) => normalizeCandidate(raw.id, candidate, index)),
        );
        for (const candidate of normalized) collected.push(candidate);
        const processed = normalized.length > 0;
        const nextStatus = processed ? 'partial' : 'skipped';
        if (raw.processing_status !== nextStatus) {
          rawOps.push({
            unit: RAW,
            table: 'raw_record',
            key: raw.id,
            value: {
              ...raw,
              processing_status: nextStatus,
              processed_at: nowIso,
              processed_by: runId,
              updated_at: nowIso,
              rev: (raw.rev ?? 1) + 1,
            },
          });
          stateChanges.push(
            ...stateChangeRecords('raw_record', raw.id, [
              { field: 'processing_status', oldValue: raw.processing_status ?? null, newValue: nextStatus, revAfter: (raw.rev ?? 1) + 1 },
            ], nowIso),
          );
        }
        const inbox = inboxItems().find((item) => item.raw_record_id === raw.id && !item.deleted_at);
        if (inbox && normalized.length > 0) {
          const top = normalized.slice().sort((a, b) => b.confidence - a.confidence)[0];
          const suggestedKind = SUGGESTED_KIND_MAP[top.kind] || 'none';
          inboxOps.push({
            unit: CORE,
            table: 'inbox_item',
            key: inbox.id,
            value: {
              ...inbox,
              suggested_kind: suggestedKind,
              suggestion_confidence: top.confidence,
              updated_at: nowIso,
              rev: (inbox.rev ?? 1) + 1,
            },
          });
        }
      } catch (error) {
        failedCount += 1;
        diagnostics?.recordError?.('triage_extract_failed', `规则抽取失败：${error?.message || error}`, {
          rawRecordId: raw.id,
        });
      }
    }

    const needsConfirm = collected.filter((candidate) => candidate.requiresConfirm).length;
    const status = collected.length > 0 ? 'succeeded' : 'skipped';
    const run = {
      id: runId,
      run_kind: String(runKey).startsWith('inbox_nightly') ? 'inbox_nightly' : 'inbox_manual',
      local_date: localDate,
      trigger: String(runKey).startsWith('inbox_nightly') ? 'scheduled' : 'manual',
      status,
      batch_id: newId('bat'),
      raw_record_ids: selected.map((record) => record.id),
      scanned_count: selected.length,
      candidates: collected.length,
      auto_written: 0,
      needs_confirm: needsConfirm,
      dropped: 0,
      failed_count: failedCount,
      report_json: {
        summary: {
          scanned: selected.length,
          candidates: collected.length,
          needsConfirm,
          failed: failedCount,
        },
        candidates: collected,
        degraded: false,
        cost: { model: null, token_in: 0, token_out: 0 },
        prompt_version: 'm2-rules',
      },
      model: null,
      prompt_version: 'm2-rules',
      token_in: 0,
      token_out: 0,
      duration_ms: 0,
      idempotency_key: runKey,
      retry_of_id: null,
      error: null,
      started_at: nowIso,
      finished_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      schema_version: 1,
      origin_type: 'system',
      origin_ref: null,
      origin_key: null,
      confidence: null,
      confirmation_status: 'not_required',
      evidence_refs: [],
      meta_json: { source: 'm2', mode },
    };
    const oplog = oplogRecord({
      action: 'triage.run',
      targetType: 'extraction_run',
      targetId: runId,
      before: null,
      after: { candidates: collected.length, raw: selected.length, mode },
      nowIso,
      idempotencyKey: input.requestId ? `triage.run:${runKey}:${input.requestId}` : null,
    });
    await store.transaction([
      { unit: CORE, table: 'extraction_run', key: runId, value: run },
      ...rawOps,
      ...inboxOps,
      ...stateChanges.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
      { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
    ]);
    emitChanged('triage', [runId], { action: 'run', candidates: collected.length });
    return {
      runId,
      run: runView(run),
      candidates: collected,
      counts: runView(run).counts,
      alreadyDone: false,
      needsAgent: mode === 'both',
    };
  }

  /* ───────── Agent 深抽取：begin / saveCandidates / abort（D 的 lifeos_triage 调用） ───────── */

  function selectRawForRun(input, limit) {
    if (Array.isArray(input.rawRecordIds) && input.rawRecordIds.length > 0) {
      const wanted = new Set(input.rawRecordIds.map(String));
      return rawRecords().filter((record) => wanted.has(record.id));
    }
    return rawRecords()
      .filter((record) => RAW_PENDING.includes(record.processing_status) || record.processing_status === undefined)
      .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
      .slice(0, limit);
  }

  function batchesOf(rawList) {
    return rawList.map((raw) => {
      const inbox = inboxItems().find((item) => item.raw_record_id === raw.id && !item.deleted_at);
      return { rawRecord: rawLite(raw), inboxItem: inboxLite(inbox) };
    });
  }

  async function beginAgentRun(input, runKey, limit) {
    const existing = findRunByRunKey(runKey);
    if (existing) {
      const view = runView(existing);
      const rawList = (existing.raw_record_ids || [])
        .map((id) => get(RAW, 'raw_record', id))
        .filter(Boolean);
      return {
        runId: existing.id,
        run: view,
        batches: batchesOf(rawList),
        candidates: view.candidates,
        counts: view.counts,
        needsAgent: view.candidates.length === 0,
        alreadyDone: view.candidates.length > 0,
      };
    }
    const localDate = todayLocal();
    const selected = selectRawForRun(input, limit);
    const nowIso = isoNow();
    const runId = newId('xrun');
    const run = {
      id: runId,
      run_kind: String(runKey).startsWith('inbox_nightly') ? 'inbox_nightly' : 'inbox_manual',
      local_date: localDate,
      trigger: String(runKey).startsWith('inbox_nightly') ? 'scheduled' : 'manual',
      status: 'running',
      batch_id: newId('bat'),
      raw_record_ids: selected.map((record) => record.id),
      scanned_count: selected.length,
      candidates: 0,
      auto_written: 0,
      needs_confirm: 0,
      dropped: 0,
      failed_count: 0,
      report_json: {
        summary: { scanned: selected.length, candidates: 0, needsConfirm: 0, failed: 0 },
        candidates: [],
        awaitingAgent: true,
        prompt_version: 'm2-agent',
        cost: { model: null, token_in: 0, token_out: 0 },
      },
      model: null,
      prompt_version: 'm2-agent',
      token_in: 0,
      token_out: 0,
      duration_ms: 0,
      idempotency_key: runKey,
      retry_of_id: null,
      error: null,
      started_at: nowIso,
      finished_at: null,
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      schema_version: 1,
      origin_type: 'system',
      origin_ref: null,
      origin_key: null,
      confidence: null,
      confirmation_status: 'not_required',
      evidence_refs: [],
      meta_json: { source: 'm2', mode: 'agent' },
    };
    const stateChanges = [];
    const rawOps = [];
    for (const raw of selected) {
      if (raw.processing_status === 'processing') continue;
      rawOps.push({
        unit: RAW,
        table: 'raw_record',
        key: raw.id,
        value: { ...raw, processing_status: 'processing', updated_at: nowIso, rev: (raw.rev ?? 1) + 1 },
      });
      stateChanges.push(
        ...stateChangeRecords('raw_record', raw.id, [
          { field: 'processing_status', oldValue: raw.processing_status ?? null, newValue: 'processing', revAfter: (raw.rev ?? 1) + 1 },
        ], nowIso, 'agent'),
      );
    }
    const oplog = oplogRecord({
      action: 'triage.begin',
      targetType: 'extraction_run',
      targetId: runId,
      before: null,
      after: { raw: selected.length, mode: 'agent' },
      stateChangeIds: stateChanges.map((record) => record.id),
      nowIso,
      idempotencyKey: input.requestId ? `triage.begin:${runKey}:${input.requestId}` : null,
    });
    await store.transaction([
      { unit: CORE, table: 'extraction_run', key: runId, value: run },
      ...rawOps,
      ...stateChanges.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
      { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
    ]);
    emitChanged('triage', [runId], { action: 'begin', raw: selected.length });
    return {
      runId,
      run: runView(run),
      batches: batchesOf(selected),
      candidates: [],
      counts: runView(run).counts,
      needsAgent: true,
      alreadyDone: false,
    };
  }

  /**
   * D 的 lifeos_triage.commit：只写 extraction_run 候选草稿（不落业务表）。
   * @param {{runId:string, candidates:object[]}} input
   */
  async function saveTriageCandidates(input = {}) {
    assertWritable();
    const run = loadRun(input.runId);
    if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
      throw new LifeosError('validation_failed', 'candidates 必须是非空数组', { errors: ['candidates 必须是非空数组'] });
    }
    const runV = runView(run);
    const knownRawIds = new Set(runV.candidates.length > 0 ? [] : (run.raw_record_ids || []));
    if (run.raw_record_ids && run.raw_record_ids.length > 0) for (const id of run.raw_record_ids) knownRawIds.add(id);
    const merged = [...runV.candidates];
    const existingKeys = new Set(merged.map((candidate) => `${candidate.rawRecordId}|${candidate.candidateId}`));
    for (const [index, candidate] of input.candidates.entries()) {
      const rawRecordId = typeof candidate?.rawRecordId === 'string' ? candidate.rawRecordId : '';
      if (!rawRecordId || !get(RAW, 'raw_record', rawRecordId)) {
        throw new LifeosError('validation_failed', `candidates[${index}].rawRecordId 不存在：${rawRecordId}`, {
          errors: [`rawRecordId 不存在：${rawRecordId}`],
        });
      }
      if (!knownRawIds.has(rawRecordId)) knownRawIds.add(rawRecordId);
      const normalized = normalizeCandidate(rawRecordId, candidate, index);
      const key = `${normalized.rawRecordId}|${normalized.candidateId}`;
      if (existingKeys.has(key)) continue;
      const dedupeKey = `${normalized.rawRecordId}|${normalized.kind}|${normalized.fields.title || normalized.fields.metric_code || normalized.fields.event_type || ''}`;
      if (merged.some((item) => `${item.rawRecordId}|${item.kind}|${item.fields.title || item.fields.metric_code || item.fields.event_type || ''}` === dedupeKey)) continue;
      existingKeys.add(key);
      merged.push(normalized);
    }
    const nowIso = isoNow();
    const limit = typeof input.limit === 'number' ? input.limit : 200;
    const sized = merged.slice(0, Math.min(Math.max(limit, 1), 200));
    const needsConfirm = sized.filter((candidate) => candidate.requiresConfirm).length;
    const nextRun = {
      ...run,
      status: 'succeeded',
      candidates: sized.length,
      needs_confirm: needsConfirm,
      updated_at: nowIso,
      finished_at: nowIso,
      rev: (run.rev ?? 1) + 1,
      report_json: {
        ...(isPlainObject(run.report_json) ? run.report_json : {}),
        summary: { scanned: run.scanned_count ?? 0, candidates: sized.length, needsConfirm, failed: run.failed_count ?? 0 },
        candidates: sized,
        awaitingAgent: false,
        prompt_version: 'm2-agent',
      },
    };
    const rawIds = [...new Set(sized.map((candidate) => candidate.rawRecordId))];
    const rawOps = [];
    const stateChanges = [];
    for (const rawId of rawIds) {
      const raw = get(RAW, 'raw_record', rawId);
      if (!raw || raw.processing_status === 'partial') continue;
      rawOps.push({
        unit: RAW,
        table: 'raw_record',
        key: rawId,
        value: {
          ...raw,
          processing_status: 'partial',
          processed_at: nowIso,
          processed_by: run.id,
          updated_at: nowIso,
          rev: (raw.rev ?? 1) + 1,
        },
      });
      stateChanges.push(
        ...stateChangeRecords('raw_record', rawId, [
          { field: 'processing_status', oldValue: raw.processing_status ?? null, newValue: 'partial', revAfter: (raw.rev ?? 1) + 1 },
        ], nowIso, 'agent'),
      );
    }
    const oplog = oplogRecord({
      action: 'triage.commit',
      targetType: 'extraction_run',
      targetId: run.id,
      before: { candidates: runV.candidates.length },
      after: { candidates: sized.length },
      stateChangeIds: stateChanges.map((record) => record.id),
      nowIso,
      idempotencyKey: input.requestId ? `triage.commit:${run.id}:${input.requestId}` : null,
    });
    await store.transaction([
      { unit: CORE, table: 'extraction_run', key: run.id, value: nextRun },
      ...rawOps,
      ...stateChanges.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
      { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
    ]);
    emitChanged('triage', [run.id], { action: 'commit', candidates: sized.length });
    return {
      saved: sized.length - runV.candidates.length,
      total: sized.length,
      needsConfirm,
      alreadyDone: sized.length - runV.candidates.length === 0,
      run: runView(nextRun),
    };
  }

  /** 显式 beginTriage 别名（Lead/D 契约命名） */
  async function beginTriage(input = {}) {
    return runTriage({ ...input, mode: 'agent' });
  }

  /** D 的 lifeos_triage.abort */
  async function abortTriage(input = {}) {
    assertWritable();
    const run = loadRun(input.runId);
    const nowIso = isoNow();
    const reason = typeof input.reason === 'string' && input.reason.length > 0 ? input.reason.slice(0, 200) : 'aborted';
    const nextRun = {
      ...run,
      status: 'skipped',
      error: reason,
      updated_at: nowIso,
      finished_at: nowIso,
      rev: (run.rev ?? 1) + 1,
      report_json: {
        ...(isPlainObject(run.report_json) ? run.report_json : {}),
        abortReason: reason,
        abortedAt: nowIso,
      },
    };
    const oplog = oplogRecord({
      action: 'triage.abort',
      targetType: 'extraction_run',
      targetId: run.id,
      before: { status: run.status },
      after: { status: 'skipped', reason },
      nowIso,
    });
    await store.transaction([
      { unit: CORE, table: 'extraction_run', key: run.id, value: nextRun },
      { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
    ]);
    return { runId: run.id, run: runView(nextRun), aborted: true };
  }

  /* ───────── listTriagePending / status ───────── */

  function listTriagePending() {
    const pendingRaws = rawRecords()
      .filter((record) => RAW_PENDING.includes(record.processing_status) || record.processing_status === undefined)
      .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
    const groups = [];
    let pendingCandidates = 0;
    for (const raw of pendingRaws) {
      const latest = latestRunForRaw(raw.id);
      const runV = latest ? runView(latest) : null;
      const { appliedIds, ignoredIds, duplicateIds } = handledIdsOf(latest?.report_json || {});
      const candidates = (runV ? runV.candidates : [])
        .filter((candidate) => candidate.rawRecordId === raw.id)
        .map((candidate) => ({
          ...candidate,
          handled: appliedIds.has(candidate.candidateId)
            ? 'accepted'
            : ignoredIds.has(candidate.candidateId)
              ? 'ignored'
              : duplicateIds.has(candidate.candidateId)
                ? 'duplicate'
                : null,
        }));
      const undecided = candidates.filter((candidate) => candidate.handled === null);
      pendingCandidates += undecided.length;
      const inbox = inboxItems().find((item) => item.raw_record_id === raw.id && !item.deleted_at);
      groups.push({
        rawRecord: rawLite(raw),
        inboxItem: inboxLite(inbox),
        candidates,
        runId: latest ? latest.id : null,
        requiresConfirm: undecided.some((candidate) => candidate.requiresConfirm),
        progress: {
          total: candidates.length,
          handled: candidates.length - undecided.length,
          remaining: undecided.length,
          applyComplete: runV ? runV.applyComplete === true : false,
        },
      });
    }
    return { groups, counts: { pendingRaw: groups.length, pendingCandidates } };
  }

  function getTriageRun(runId) {
    return runView(loadRun(runId));
  }

  async function triageStatus() {
    const pending = listTriagePending();
    const lastRun = runs()
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || String(b.id).localeCompare(String(a.id)))
      .map(runView)[0] || null;
    const automation = scheduler && typeof scheduler.getAutomation === 'function'
      ? await scheduler.getAutomation()
      : await fallbackAutomation();
    // M2-G7：每次操作后重算计数并写入诊断（修复 M1 陈旧计数）
    try {
      diagnostics?.setStage?.(store.degraded ? 'degraded' : 'ready', {
        counts: { inboxPending: pending.counts.pendingRaw, pendingCandidates: pending.counts.pendingCandidates },
        units: store.status ? store.status().units : {},
        ok: store.degraded !== true,
      });
    } catch {
      /* ignore */
    }
    return {
      pendingRaw: pending.counts.pendingRaw,
      pendingCandidates: pending.counts.pendingCandidates,
      lastRun,
      automation,
    };
  }

  /* ───────── applyTriage ───────── */

  function loadRun(runId) {
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new LifeosError('validation_failed', 'runId 必填', { errors: ['runId 必填'] });
    }
    const run = get(CORE, 'extraction_run', runId);
    if (!run) throw new LifeosError('not_found', `整理批次不存在：${runId}`, { runId });
    return run;
  }

  function handledIdsOf(report) {
    const appliedIds = new Set(Array.isArray(report?.appliedCandidateIds) ? report.appliedCandidateIds : []);
    const ignoredIds = new Set(Array.isArray(report?.ignoredCandidateIds) ? report.ignoredCandidateIds : []);
    const duplicateIds = new Set(Array.isArray(report?.duplicateCandidateIds) ? report.duplicateCandidateIds : []);
    return { appliedIds, ignoredIds, duplicateIds };
  }

  function remainingCandidates(candidates, appliedIds, ignoredIds, duplicateIds) {
    return candidates.filter(
      (candidate) =>
        !appliedIds.has(candidate.candidateId) &&
        !ignoredIds.has(candidate.candidateId) &&
        !(duplicateIds && duplicateIds.has(candidate.candidateId)),
    );
  }

  /* ───────── M2.6 跨 run 去重：同 raw + 同类 + 关键字段 ───────── */

  const DEDUPE_LOCAL_DATE = (isoValue) => localDateOfIso(isoValue, timeZone);

  function dedupeKeyOf(candidate) {
    const fields = candidate.fields || {};
    const raw = candidate.rawRecordId;
    if (candidate.kind === 'task') {
      return `${raw}|task|${String(fields.title || candidate.source?.quote || '').trim()}`;
    }
    if (candidate.kind === 'event') {
      const day = textOf(fields.local_date) || textOf(fields.occurred_date)
        || (typeof fields.occurred_start_at === 'string' ? DEDUPE_LOCAL_DATE(fields.occurred_start_at) : '');
      return `${raw}|event|${textOf(fields.event_type) || 'other'}|${day}`;
    }
    if (candidate.kind === 'metric') {
      const day = textOf(fields.local_date)
        || (typeof fields.measured_at === 'string' ? DEDUPE_LOCAL_DATE(fields.measured_at) : '');
      return `${raw}|metric|${textOf(fields.metric_code)}|${day}|${Number(fields.value_num)}|${textOf(fields.unit)}`;
    }
    if (candidate.kind === 'habit_checkin') {
      const day = textOf(fields.local_date);
      const habitKey = textOf(fields.habit_key || fields.habit_id);
      return `${raw}|habit_checkin|${habitKey}|${day}`;
    }
    if (candidate.kind === 'wish') {
      return `${raw}|wish|${String(fields.title || candidate.source?.quote || '').trim()}`;
    }
    return `${raw}|${candidate.kind}|${candidate.candidateId}`;
  }

  function isRevokedRecord(table, record) {
    if (!record) return true;
    if (record.deleted_at) return true;
    if (table === 'event' || table === 'metric') return record.validity === 'retracted';
    if (table === 'task') return record.status === 'cancelled';
    if (table === 'wish') return record.status === 'discarded';
    return false;
  }

  /**
   * 全库查找同 raw + 关键字段的派生对象（M2.6-R4）。
   * 返回未撤销的既有对象 `{id,type}`；已撤销/软删则视为不存在（允许重建）。
   */
  function findExistingDerived(candidate) {
    const table = CORRECT_TABLES[candidate.kind];
    if (!table) return null;
    const key = dedupeKeyOf(candidate);
    for (const [, record] of entries(CORE, table)) {
      if (!record || record.deleted_at) continue;
      const originRaw = record.origin_ref && typeof record.origin_ref === 'object' ? record.origin_ref.raw_record_id : null;
      const recordRaw = originRaw || record.raw_record_id || null;
      if (recordRaw !== candidate.rawRecordId) continue;
      if (isRevokedRecord(table, record)) continue;
      if (dedupeKeyOf(recordToCandidate(candidate.kind, candidate.rawRecordId, record)) === key) {
        return { id: record.id, type: candidate.kind };
      }
    }
    return null;
  }

  /** 把既有记录还原成候选形状（仅用于 dedupeKeyOf 比较）。 */
  function recordToCandidate(kind, rawRecordId, record) {
    if (kind === 'task') return { kind, rawRecordId, fields: { title: record.title } };
    if (kind === 'event') {
      return {
        kind,
        rawRecordId,
        fields: {
          event_type: record.event_type,
          local_date: record.occurred_start_at ? DEDUPE_LOCAL_DATE(record.occurred_start_at) : '',
        },
      };
    }
    if (kind === 'metric') {
      return {
        kind,
        rawRecordId,
        fields: {
          metric_code: record.metric_code,
          local_date: record.measured_at ? DEDUPE_LOCAL_DATE(record.measured_at) : '',
          value_num: record.value_num,
          unit: record.unit,
        },
      };
    }
    if (kind === 'habit_checkin') {
      return { kind, rawRecordId, fields: { habit_id: record.habit_id, local_date: record.local_date } };
    }
    if (kind === 'wish') return { kind, rawRecordId, fields: { title: record.title } };
    return { kind, rawRecordId, fields: {} };
  }

  /**
   * 应用整理候选（**同一 run 可多次调用**，M2-B2）。
   * - 已完成候选记入 run.report_json.appliedCandidateIds/ignoredCandidateIds；
   * - 本次只处理新 decisions；已处理的在 handledEarlier 返回，不重复创建；
   * - 全部候选处理完才标 applyComplete=true 并把 raw 置 processed。
   */
  async function applyTriage(input = {}) {
    assertWritable();
    const run = loadRun(input.runId);
    const runV = runView(run);
    const report = isPlainObject(run.report_json) ? run.report_json : {};
    const { appliedIds: priorAppliedIds, ignoredIds: priorIgnoredIds, duplicateIds: priorDuplicateIds } = handledIdsOf(report);
    const priorCreated = Array.isArray(report.applyResult?.created) ? report.applyResult.created : [];
    const priorDecisions = Array.isArray(report.decisions) ? report.decisions : [];
    const priorDuplicates = Array.isArray(report.duplicates) ? report.duplicates : [];

    const decisions = Array.isArray(input.decisions) ? input.decisions : [];
    if (decisions.length === 0) {
      throw new LifeosError('validation_failed', 'decisions 不能为空', { errors: ['至少一条 decision'] });
    }
    const candidates = runV.candidates;
    const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
    const decisionMap = new Map();
    const errors = [];
    for (const decision of decisions) {
      const candidate = byId.get(decision?.candidateId);
      if (!candidate) {
        errors.push(`未知 candidateId：${decision?.candidateId}`);
        continue;
      }
      const action = decision.action;
      if (!['accept', 'edit', 'ignore'].includes(action)) {
        errors.push(`候选 ${candidate.candidateId} 的 action 非法：${action}`);
        continue;
      }
      if (decision.patch !== undefined && !isPlainObject(decision.patch)) {
        errors.push(`候选 ${candidate.candidateId} 的 patch 必须是对象`);
        continue;
      }
      decisionMap.set(candidate.candidateId, { action, patch: decision.patch || null });
    }
    if (errors.length > 0) throw new LifeosError('validation_failed', 'decisions 不合法', { errors });

    // 已处理候选：幂等返回，不重复写
    const handledEarlier = [];
    const newDecisions = new Map();
    for (const [candidateId, decision] of decisionMap) {
      if (priorAppliedIds.has(candidateId) || priorIgnoredIds.has(candidateId)) {
        handledEarlier.push({ candidateId, action: decision.action });
        continue;
      }
      if (priorDuplicateIds.has(candidateId)) {
        handledEarlier.push({ candidateId, action: 'duplicate' });
        continue;
      }
      newDecisions.set(candidateId, decision);
    }
    const alreadyComplete = remainingCandidates(candidates, priorAppliedIds, priorIgnoredIds, priorDuplicateIds).length === 0;
    if (newDecisions.size === 0) {
      return {
        alreadyApplied: true,
        applied: 0,
        ignored: 0,
        created: [],
        duplicates: priorDuplicateIds.size > 0 ? [] : [],
        duplicateCount: priorDuplicateIds.size,
        handledEarlier,
        run: runV,
        applyComplete: alreadyComplete,
      };
    }

    const nowIso = isoNow();
    const ops = [];
    const compensation = [];
    const created = [];
    const stateChanges = [];
    const evidenceLinks = [];
    const touchedRawIds = new Set();
    const appliedIds = new Set(priorAppliedIds);
    const ignoredIds = new Set(priorIgnoredIds);
    const duplicateIds = new Set(priorDuplicateIds);
    const duplicates = [];
    const createdThisCall = new Map(); // dedupeKey -> 目标 id（同一次 apply 内多个同内容候选）
    let applied = 0;
    let ignored = 0;
    let duplicated = 0;

    for (const candidate of candidates) {
      const decision = newDecisions.get(candidate.candidateId);
      if (!decision) continue;
      touchedRawIds.add(candidate.rawRecordId);
      if (decision.action === 'ignore' || candidate.kind === 'ignore') {
        ignored += 1;
        ignoredIds.add(candidate.candidateId);
        continue;
      }
      const derivedKey = dedupeKeyOf(decision.patch ? { ...candidate, fields: { ...candidate.fields, ...decision.patch } } : candidate);
      const inCallCreated = createdThisCall.get(derivedKey);
      const existingDerived = inCallCreated ? { id: inCallCreated, type: candidate.kind } : findExistingDerived(candidate);
      if (existingDerived) {
        duplicated += 1;
        duplicateIds.add(candidate.candidateId);
        duplicates.push({ candidateId: candidate.candidateId, existingId: existingDerived.id, type: existingDerived.type });
        continue;
      }
      const duplicate = entries(CORE, CORRECT_TABLES[candidate.kind] || candidate.kind).find(
        ([, record]) => record && record.origin_key === `record_extraction:${candidate.rawRecordId}:${candidate.candidateId}` && !record.deleted_at,
      );
      if (duplicate) {
        created.push({ type: candidate.kind, id: duplicate[1].id, candidateId: candidate.candidateId, deduped: true });
        appliedIds.add(candidate.candidateId);
        applied += 1;
        createdThisCall.set(derivedKey, duplicate[1].id);
        continue;
      }
      let target;
      try {
        target = buildTarget(candidate, nowIso, decision.patch);
      } catch (error) {
        errors.push(`候选 ${candidate.candidateId} 无法落库：${error.message}`);
        continue;
      }
      if (!target) {
        errors.push(`候选 ${candidate.candidateId} 类型不支持：${candidate.kind}`);
        continue;
      }
      ops.push({ unit: target.unit, table: target.table, key: target.value.id, value: target.value });
      compensation.push({ unit: target.unit, table: target.table, key: target.value.id, value: null });
      created.push({ type: candidate.kind, id: target.value.id, candidateId: candidate.candidateId });
      applied += 1;
      appliedIds.add(candidate.candidateId);
      createdThisCall.set(derivedKey, target.value.id);
      stateChanges.push(
        ...stateChangeRecords(target.entityType, target.value.id, [
          { field: '__created__', oldValue: null, newValue: { kind: candidate.kind }, revAfter: 1 },
        ], nowIso, 'agent'),
      );
      evidenceLinks.push(evidenceLinkRecord({
        operationLogId: null,
        rawRecordId: candidate.rawRecordId,
        targetType: target.entityType,
        targetId: target.value.id,
        candidate,
        nowIso,
      }));
    }
    if (errors.length > 0) throw new LifeosError('validation_failed', '候选落库失败', { errors });

    const oplog = oplogRecord({
      action: 'triage.apply',
      targetType: 'extraction_run',
      targetId: run.id,
      before: { applied: priorAppliedIds.size, ignored: priorIgnoredIds.size, candidates: candidates.length },
      after: {
        applied: appliedIds.size,
        ignored: ignoredIds.size,
        duplicates: duplicated,
        remaining: remainingCandidates(candidates, appliedIds, ignoredIds, duplicateIds).length,
        created: created.map((item) => `${item.type}:${item.id}`),
      },
      stateChangeIds: stateChanges.map((record) => record.id),
      nowIso,
      idempotencyKey: input.requestId ? `triage.apply:${run.id}:${input.requestId}` : null,
    });
    for (const link of evidenceLinks) {
      link.from_id = oplog.id;
      ops.push({ unit: CORE, table: 'evidence_link', key: link.id, value: link });
      compensation.push({ unit: CORE, table: 'evidence_link', key: link.id, value: null });
    }

    for (const rawId of touchedRawIds) {
      const raw = get(RAW, 'raw_record', rawId);
      if (!raw) continue;
      const remaining = remainingCandidates(candidates, appliedIds, ignoredIds, duplicateIds).filter(
        (candidate) => candidate.rawRecordId === rawId,
      ).length;
      const nextStatus = remaining > 0 ? 'partial' : 'processed';
      const nextRaw = {
        ...raw,
        processing_status: nextStatus,
        processed_at: nowIso,
        processed_by: run.id,
        updated_at: nowIso,
        rev: (raw.rev ?? 1) + 1,
      };
      ops.push({ unit: RAW, table: 'raw_record', key: rawId, value: nextRaw });
      compensation.push({ unit: RAW, table: 'raw_record', key: rawId, value: raw });
      stateChanges.push(
        ...stateChangeRecords('raw_record', rawId, [
          { field: 'processing_status', oldValue: raw.processing_status ?? null, newValue: nextStatus, revAfter: nextRaw.rev },
        ], nowIso),
      );
      const inbox = inboxItems().find((item) => item.raw_record_id === rawId && !item.deleted_at);
      if (inbox) {
        const acceptedAny = candidates.some(
          (candidate) => candidate.rawRecordId === rawId && appliedIds.has(candidate.candidateId),
        );
        const nextInboxStatus = acceptedAny ? 'triaged' : remaining > 0 ? inbox.status : 'dismissed';
        const nextInbox = {
          ...inbox,
          status: nextInboxStatus,
          triaged_at: nextInboxStatus === 'triaged' ? (inbox.triaged_at || nowIso) : null,
          dismissed_at: nextInboxStatus === 'dismissed' ? (inbox.dismissed_at || nowIso) : null,
          dismissed_reason: nextInboxStatus === 'dismissed' ? 'all_candidates_ignored' : null,
          updated_at: nowIso,
          rev: (inbox.rev ?? 1) + 1,
        };
        ops.push({ unit: CORE, table: 'inbox_item', key: inbox.id, value: nextInbox });
        compensation.push({ unit: CORE, table: 'inbox_item', key: inbox.id, value: inbox });
      }
    }

    const remainingAll = remainingCandidates(candidates, appliedIds, ignoredIds, duplicateIds);
    const applyComplete = remainingAll.length === 0;
    const mergedCreated = [...priorCreated, ...created.filter((item) => !item.deduped)];
    const mergedDuplicates = [...priorDuplicates, ...duplicates];
    const nextRun = {
      ...run,
      status: applyComplete ? (appliedIds.size > 0 ? 'succeeded' : 'partial') : 'succeeded',
      auto_written: appliedIds.size,
      failed_count: ignoredIds.size,
      updated_at: nowIso,
      finished_at: applyComplete ? nowIso : run.finished_at ?? null,
      rev: (run.rev ?? 1) + 1,
      report_json: {
        ...report,
        decisions: [
          ...priorDecisions,
          ...[...newDecisions.entries()].map(([candidateId, decision]) => ({ candidateId, action: decision.action })),
        ],
        appliedCandidateIds: [...appliedIds],
        ignoredCandidateIds: [...ignoredIds],
        duplicateCandidateIds: [...duplicateIds],
        duplicates: mergedDuplicates,
        appliedAt: nowIso,
        applyComplete,
        remainingCandidateIds: remainingAll.map((candidate) => candidate.candidateId),
        applyResult: {
          applied: appliedIds.size,
          ignored: ignoredIds.size,
          duplicates: duplicateIds.size,
          created: mergedCreated,
        },
      },
    };
    ops.push({ unit: CORE, table: 'extraction_run', key: run.id, value: nextRun });
    compensation.push({ unit: CORE, table: 'extraction_run', key: run.id, value: run });
    ops.push(...stateChanges.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })));
    ops.push({ unit: LOG, table: 'operation_log', key: oplog.id, value: oplog });
    compensation.push({ unit: LOG, table: 'operation_log', key: oplog.id, value: null });

    try {
      await store.transaction(ops);
    } catch (error) {
      let compensated = false;
      try {
        await store.transaction(compensation);
        compensated = true;
      } catch (compensateError) {
        diagnostics?.recordError?.('triage_compensate_failed', `整理回滚失败：${compensateError?.message || compensateError}`, {
          runId: run.id,
        });
      }
      try {
        const failureLog = oplogRecord({
          action: 'triage.apply.failed',
          targetType: 'extraction_run',
          targetId: run.id,
          before: null,
          after: { compensated },
          nowIso: isoNow(),
          status: 'failed',
          error: String(error?.message || error),
        });
        await store.transaction([{ unit: LOG, table: 'operation_log', key: failureLog.id, value: failureLog }]);
      } catch {
        /* 审计失败不掩盖原错误 */
      }
      throw new LifeosError('internal', '整理应用失败，已回滚', {
        stage: 'apply',
        compensated,
        cause: String(error?.message || error),
      });
    }

    emitChanged('triage', [run.id], { action: 'apply', applied, ignored, applyComplete });
    for (const item of created) emitChanged(item.type, [item.id], { action: 'create' });
    if (scheduler && typeof scheduler.noteRun === 'function' && nextRun.trigger === 'scheduled') {
      await scheduler.noteRun(nextRun.local_date).catch(() => {});
    }
    return {
      applied,
      ignored,
      duplicates,
      duplicateCount: duplicates.length,
      created,
      handledEarlier,
      run: runView(nextRun),
      alreadyApplied: false,
      applyComplete,
    };
  }

  /* ───────── reprocess / correct ───────── */

  async function reprocessRaw(rawRecordId) {
    assertWritable();
    const raw = get(RAW, 'raw_record', rawRecordId);
    if (!raw) throw new LifeosError('not_found', `原始记录不存在：${rawRecordId}`, { rawRecordId });
    const nowIso = isoNow();
    const ops = [];
    const stateChanges = [];
    // 软撤销该 raw 的旧证据链（保留审计）
    for (const [, link] of entries(CORE, 'evidence_link')) {
      if (!link || link.to_type !== 'raw_record' || link.to_id !== rawRecordId) continue;
      if (link.stale_at) continue;
      ops.push({ unit: CORE, table: 'evidence_link', key: link.id, value: { ...link, stale_at: nowIso } });
    }
    const nextRaw = {
      ...raw,
      processing_status: 'pending',
      processed_at: null,
      processed_by: null,
      updated_at: nowIso,
      rev: (raw.rev ?? 1) + 1,
    };
    ops.push({ unit: RAW, table: 'raw_record', key: rawRecordId, value: nextRaw });
    stateChanges.push(
      ...stateChangeRecords('raw_record', rawRecordId, [
        { field: 'processing_status', oldValue: raw.processing_status ?? null, newValue: 'pending', revAfter: nextRaw.rev },
      ], nowIso),
    );
    const oplog = oplogRecord({
      action: 'triage.reprocess',
      targetType: 'raw_record',
      targetId: rawRecordId,
      before: { processing_status: raw.processing_status ?? null },
      after: { processing_status: 'pending' },
      stateChanges: null,
      nowIso,
      idempotencyKey: null,
    });
    ops.push(...stateChanges.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })));
    ops.push({ unit: LOG, table: 'operation_log', key: oplog.id, value: oplog });
    await store.transaction(ops);
    const priorReprocess = runs().filter((run) => String(run.idempotency_key || '').includes(`reprocess:${rawRecordId}`)).length;
    const runKey = `inbox:${todayLocal()}:reprocess:${rawRecordId}:${priorReprocess + 1}`;
    const result = await runTriage({ mode: 'rules', rawRecordIds: [rawRecordId], runKey });
    emitChanged('triage', [result.run.id], { action: 'reprocess', rawRecordId });
    return { runId: result.run.id, run: result.run, candidates: result.candidates };
  }

  const CORRECT_PATCH_KEYS = Object.freeze({
    task: ['title', 'notes', 'priority', 'scheduled_date', 'due_date'],
    event: ['title', 'notes', 'validity'],
    metric: ['value_num', 'unit', 'validity'],
    habit_checkin: ['status', 'value_json', 'note'],
    wish: ['title', 'notes', 'status'],
  });

  async function correctDerived(input = {}) {
    assertWritable();
    const type = input.type;
    const table = CORRECT_TABLES[type];
    if (!table) throw new LifeosError('validation_failed', `不支持的纠错类型：${type}`, { errors: [`type 非法：${type}`] });
    const id = input.id;
    if (typeof id !== 'string' || id.length === 0) throw new LifeosError('validation_failed', 'id 必填');
    const action = input.action || 'update';
    if (!['update', 'revoke'].includes(action)) {
      throw new LifeosError('validation_failed', `action 非法：${action}`, { errors: ['action 必须是 update|revoke'] });
    }
    const current = get(CORE, table, id);
    if (!current || current.deleted_at) throw new LifeosError('not_found', `对象不存在：${type}/${id}`, { type, id });
    const nowIso = isoNow();
    let next;
    const diffs = [];
    if (action === 'update') {
      const patch = isPlainObject(input.patch) ? input.patch : {};
      const allowed = CORRECT_PATCH_KEYS[type] || [];
      const unknown = Object.keys(patch).filter((key) => !allowed.includes(key));
      if (unknown.length > 0) {
        throw new LifeosError('validation_failed', `不允许修改的字段：${unknown.join(', ')}`, { errors: unknown, allowed });
      }
      next = { ...current, updated_at: nowIso, rev: (current.rev ?? 1) + 1 };
      for (const key of allowed) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
        if ((current[key] ?? null) !== (patch[key] ?? null)) {
          diffs.push({ field: key, oldValue: current[key] ?? null, newValue: patch[key] ?? null, revAfter: next.rev });
          next[key] = patch[key];
        }
      }
      if (diffs.length === 0) {
        return { affected: [], object: current, noop: true };
      }
    } else {
      next = { ...current, updated_at: nowIso, rev: (current.rev ?? 1) + 1 };
      if (type === 'event' || type === 'metric') {
        diffs.push({ field: 'validity', oldValue: current.validity ?? 'valid', newValue: 'retracted', revAfter: next.rev });
        next.validity = 'retracted';
      } else if (type === 'habit_checkin') {
        diffs.push({ field: 'deleted_at', oldValue: null, newValue: nowIso, revAfter: next.rev });
        next.deleted_at = nowIso;
      } else if (type === 'task') {
        diffs.push({ field: 'status', oldValue: current.status, newValue: 'cancelled', revAfter: next.rev });
        next.status = 'cancelled';
        next.cancelled_at = nowIso;
        next.cancelled_reason = input.reason || '纠正撤销';
      } else {
        diffs.push({ field: 'status', oldValue: current.status ?? null, newValue: 'discarded', revAfter: next.rev });
        next.status = 'discarded';
      }
    }
    const stateChanges = stateChangeRecords(type, id, diffs, nowIso);
    const recompute = recomputeAfterCorrection({ before: current, after: next, type, action });
    const affected = Array.isArray(recompute?.affected) ? recompute.affected : [];
    const oplog = oplogRecord({
      action: `triage.correct.${action}`,
      targetType: type,
      targetId: id,
      before: Object.fromEntries(diffs.map((diff) => [diff.field, diff.oldValue])),
      after: Object.fromEntries(diffs.map((diff) => [diff.field, diff.newValue])),
      stateChangeIds: stateChanges.map((record) => record.id),
      nowIso,
      idempotencyKey: input.requestId ? `triage.correct:${type}:${id}:${input.requestId}` : null,
    });
    const ops = [
      { unit: CORE, table, key: id, value: next },
      ...stateChanges.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
      { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
    ];
    // 来源/证据链：撤销/修改后把指向该对象的 evidence_link 标 stale
    for (const [, link] of entries(CORE, 'evidence_link')) {
      if (!link || link.stale_at) continue;
      const locator = link.locator_json || {};
      if (locator.target_type === type && locator.target_id === id) {
        ops.push({ unit: CORE, table: 'evidence_link', key: link.id, value: { ...link, stale_at: nowIso } });
      }
    }
    await store.transaction(ops);
    emitChanged(type, [id], { action: `correct.${action}`, affected });
    return { affected, object: next, recompute, diffs };
  }

  /* ───────── automation fallback（无 scheduler 时） ───────── */

  const AUTOMATION_KEY = 'automation.inbox_nightly';

  async function fallbackAutomation() {
    const record = get(CORE, 'app_setting', AUTOMATION_KEY);
    const value = record && isPlainObject(record.value_json) ? record.value_json : {};
    return {
      enabled: value.enabled !== false,
      time: typeof value.time === 'string' ? value.time : '21:30',
      timeZone,
      scheduleId: value.scheduleId ?? null,
      schedule: null,
      healthy: false,
    };
  }

  async function getAutomation() {
    if (scheduler && typeof scheduler.getAutomation === 'function') return scheduler.getAutomation();
    return fallbackAutomation();
  }

  async function setAutomation(patch = {}) {
    if (scheduler && typeof scheduler.setAutomation === 'function') return scheduler.setAutomation(patch);
    assertWritable();
    const current = await fallbackAutomation();
    const next = {
      ...current,
      enabled: patch.enabled === undefined ? current.enabled : Boolean(patch.enabled),
      time: typeof patch.time === 'string' ? patch.time : current.time,
    };
    const record = { key: AUTOMATION_KEY, id: AUTOMATION_KEY, value_json: next, updated_at: isoNow() };
    await store.transaction([{ unit: CORE, table: 'app_setting', key: AUTOMATION_KEY, value: record }]);
    return next;
  }

  return {
    runTriage,
    beginTriage,
    saveTriageCandidates,
    abortTriage,
    getTriageRun,
    listTriagePending,
    applyTriage,
    reprocessRaw,
    correctDerived,
    triageStatus,
    getAutomation,
    setAutomation,
    // 测试/调试
    _internals: { runView, rawLite, normalizeCandidate, dedupeCandidates, todayLocal },
  };
}

export { CORRECT_TABLES, RAW_PENDING };
