/**
 * A：M4a 习惯应用服务。
 *
 * 契约：M4-PLAN §3.1（频率/打卡口径）+ §3.2（habitView / statsItem / 方法签名）。
 * 原则：
 *  - 写走 store.transaction（journal-first）：habit / habit_checkin + state_change + operation_log 一次原子提交；
 *  - 打卡按 (habit_id, local_date) 幂等合并；过去日期必须 retro=true 且限定近 7 天；暂停/归档拒绝新打卡；
 *  - 不写 unknown：无记录就是没有行，unknown 由领域层按计划日推导；
 *  - 读路径全部从 store.entries 快照计算（≤1 万条可接受；500 条打卡的 stats/month 有性能测试兜底）。
 *
 * 零第三方依赖；不 import `@deepseek-ai/*` 或 zod。
 */

import { LifeosError } from './errors.js'
import { newId as defaultNewId } from '../domain/ids.js'
import { addDays, isLocalDate, localDate } from '../domain/time.js'
import {
  CHECKIN_STATUSES,
  FREQUENCY_KINDS,
  WEEKDAYS,
  buildMonthMatrix,
  computeCoverage,
  computePeriodAchievement,
  computeStreak,
  describeFrequency,
  habitPeriodOf,
  indexCheckinsByDate,
  isLiveCheckin,
  isPlanDay,
  periodKey,
  planDaysBetween,
  validateFrequencyRule,
} from '../domain/habit.js'

const CORE = 'lifeos'
const LOG = 'lifeos_log'
const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
const RETRO_WINDOW_DAYS = 7
const HABIT_STATUSES = ['active', 'paused', 'archived']
const CHECKIN_MODES = ['manual', 'event_auto', 'either']
const HABIT_DETAIL_CHECKIN_DAYS = 60
const DEFAULT_STATS_WINDOW_DAYS = 14

const HABIT_FIELD_MAP = Object.freeze({
  name: 'name',
  description: 'description',
  status: 'status',
  frequency_rule: 'frequency_rule',
  frequencyRule: 'frequency_rule',
  period_rule: 'period_rule',
  periodRule: 'period_rule',
  target_json: 'target_json',
  targetJson: 'target_json',
  checkin_mode: 'checkin_mode',
  checkinMode: 'checkin_mode',
  start_date: 'start_date',
  startDate: 'start_date',
  end_date: 'end_date',
  endDate: 'end_date',
  time_hint: 'time_hint',
  timeHint: 'time_hint',
  sort_order: 'sort_order',
  sortOrder: 'sort_order',
  event_match_json: 'event_match_json',
  eventMatchJson: 'event_match_json',
  icon: 'icon',
  group_id: 'group_id',
  groupId: 'group_id',
})

const HABIT_FIELDS = Object.freeze(Object.values(HABIT_FIELD_MAP))

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toMs(now) {
  if (now instanceof Date) return now.getTime()
  if (typeof now === 'number' && Number.isFinite(now)) return now
  return Date.now()
}

function iso(ms) {
  return new Date(ms).toISOString()
}

function validationError(message, errors) {
  return new LifeosError('validation_failed', message, { errors: Array.isArray(errors) ? errors : [message] })
}

function expectedRevValue(value) {
  if (isPlainObject(value)) return value.expectedRev
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return value
}

function pickFields(input, fieldMap) {
  const out = {}
  if (!isPlainObject(input)) return out
  for (const [key, canonical] of Object.entries(fieldMap)) {
    if (input[key] === undefined) continue
    out[canonical] = input[key]
  }
  return out
}

/**
 * @param {{
 *   store: object,
 *   newId?: (prefix:string)=>string,
 *   now?: ()=>number|Date,
 *   timeZone?: string,
 *   weekStart?: 'monday'|'sunday',
 *   todayLocal?: ()=>string,
 *   emitChanged?: (kind:string, ids:string[], extra?:object)=>void,
 *   actorType?: string,
 * }} deps
 */
export function createHabitOps(deps = {}) {
  const { store } = deps
  if (!store || typeof store.get !== 'function' || typeof store.transaction !== 'function') {
    throw new LifeosError('validation_failed', 'createHabitOps 需要 LifeosStore')
  }
  const newId = typeof deps.newId === 'function' ? deps.newId : (prefix) => defaultNewId(prefix)
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const timeZone = typeof deps.timeZone === 'string' && deps.timeZone.length > 0 ? deps.timeZone : DEFAULT_TIME_ZONE
  const fixedWeekStart = deps.weekStart === 'sunday' ? 'sunday' : deps.weekStart === 'monday' ? 'monday' : null
  const emitChanged = typeof deps.emitChanged === 'function' ? deps.emitChanged : null
  const actorType = typeof deps.actorType === 'string' && deps.actorType.length > 0 ? deps.actorType : 'user'
  const todayLocalOverride = typeof deps.todayLocal === 'function' ? deps.todayLocal : null

  function currentIso() {
    return iso(toMs(now()))
  }

  function todayLocal() {
    if (todayLocalOverride) {
      const value = todayLocalOverride()
      if (isLocalDate(value)) return value
    }
    return localDate(timeZone, new Date(toMs(now())))
  }

  function weekStartMode() {
    if (fixedWeekStart) return fixedWeekStart
    try {
      const record = store.get(CORE, 'app_setting', 'week_start')
      const raw = record ? record.value_json : null
      const value = typeof raw === 'string' ? raw : isPlainObject(raw) ? raw.value : null
      if (value === 'sunday') return 'sunday'
    } catch {
      /* 读不到就用默认 monday */
    }
    return 'monday'
  }

  function assertWritable() {
    if (store.degraded === true) throw new LifeosError('store_unavailable', '存储不可用（只读降级）')
  }

  function emit(kind, ids, extra) {
    if (!emitChanged) return
    try {
      emitChanged(kind, ids, extra)
    } catch {
      /* 事件失败不影响写入结果 */
    }
  }

  /* ── 读工具 ─────────────────────────────────────────────── */

  function entries(table) {
    try {
      return store.entries(CORE, table)
    } catch {
      return []
    }
  }

  function allHabits() {
    return entries('habit')
      .map(([, record]) => record)
      .filter((record) => isPlainObject(record) && !record.deleted_at)
  }

  function allCheckins() {
    return entries('habit_checkin')
      .map(([, record]) => record)
      .filter(isLiveCheckin)
  }

  function getHabitRecord(id) {
    if (typeof id !== 'string' || id.length === 0) return null
    try {
      const record = store.get(CORE, 'habit', id)
      return record && !record.deleted_at ? record : null
    } catch {
      return null
    }
  }

  function groupCheckinsByHabit(checkins) {
    const map = new Map()
    for (const record of checkins) {
      if (!map.has(record.habit_id)) map.set(record.habit_id, [])
      map.get(record.habit_id).push(record)
    }
    return map
  }

  function sortHabits(habits) {
    return habits
      .slice()
      .sort(
        (a, b) =>
          (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
          String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) ||
          String(a.name ?? '').localeCompare(String(b.name ?? '')),
      )
  }

  function periodTypeOf(habit) {
    const base = habitPeriodOf(habit)
    const rule = isPlainObject(habit.period_rule) ? habit.period_rule : null
    if (base) {
      return { period: base, weekStart: rule && rule.week_start === 'sunday' ? 'sunday' : weekStartMode() }
    }
    if (rule && (rule.period === 'week' || rule.period === 'month')) {
      return { period: rule.period, weekStart: rule.week_start === 'sunday' ? 'sunday' : weekStartMode() }
    }
    return { period: 'week', weekStart: weekStartMode() }
  }

  function periodTargetOf(habit) {
    const rule = isPlainObject(habit.period_rule) ? habit.period_rule : null
    const fromRule = rule && Number.isInteger(rule.target_count) && rule.target_count > 0 ? rule.target_count : null
    if (fromRule) return fromRule
    const freq = isPlainObject(habit.frequency_rule) ? habit.frequency_rule : null
    if (freq && freq.kind === 'weekly_count' && Number.isInteger(freq.count) && freq.count > 0) return freq.count
    return null
  }

  function todayStatusOf(habit, today, checkins) {
    const record = checkins.find((item) => item.local_date === today)
    if (record) return record.status
    if (habit.status === 'archived') return 'unknown'
    if (habit.status === 'paused') return 'paused'
    if (isPlanDay(habit, today)) return 'pending'
    return 'unknown'
  }

  function targetTextOf(habit) {
    const target = periodTargetOf(habit)
    const { period } = periodTypeOf(habit)
    if (target) return period === 'month' ? `本月 ${target} 次` : `本周 ${target} 次`
    const freq = isPlainObject(habit.frequency_rule) ? habit.frequency_rule : null
    if (freq && freq.kind === 'weekly_days' && Array.isArray(freq.days) && freq.days.length > 0) {
      return `每周 ${freq.days.length} 天`
    }
    return null
  }

  function habitView(habit, options = {}) {
    const today = options.today ?? todayLocal()
    const checkins = options.checkins ?? []
    const record = checkins.find((item) => item.local_date === today) ?? null
    return {
      id: habit.id,
      name: habit.name,
      description: habit.description ?? null,
      status: habit.status ?? 'active',
      frequency_rule: habit.frequency_rule ?? null,
      period_rule: habit.period_rule ?? null,
      target_json: habit.target_json ?? null,
      checkin_mode: habit.checkin_mode ?? 'manual',
      start_date: habit.start_date ?? null,
      end_date: habit.end_date ?? null,
      paused_at: habit.paused_at ?? null,
      resumed_at: habit.resumed_at ?? null,
      archived_at: habit.archived_at ?? null,
      time_hint: habit.time_hint ?? null,
      sort_order: habit.sort_order ?? 0,
      icon: habit.icon ?? null,
      group_id: habit.group_id ?? null,
      rev: habit.rev ?? 1,
      created_at: habit.created_at ?? null,
      updated_at: habit.updated_at ?? null,
      frequency_text: describeFrequency(habit.frequency_rule, habit.period_rule),
      today_status: todayStatusOf(habit, today, checkins),
      today_checkin_id: record ? record.id : null,
    }
  }

  function checkinView(record) {
    return {
      id: record.id,
      habit_id: record.habit_id,
      local_date: record.local_date,
      status: record.status,
      checkin_kind: record.checkin_kind ?? 'manual',
      value_json: record.value_json ?? null,
      note: record.note ?? null,
      backfilled_at: record.backfilled_at ?? null,
      created_at: record.created_at,
      updated_at: record.updated_at,
      rev: record.rev,
    }
  }

  /* ── 写入辅助 ─────────────────────────────────────────────── */

  function stateChangeRecords(entityType, entityId, diffs, nowIso, revAfter) {
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
      rev_after: revAfter,
      reversible: true,
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      schema_version: 1,
      meta_json: null,
    }))
  }

  function oplogRecord({ action, targetType, targetId, targetIds, before, after, stateChangeIds, nowIso, meta }) {
    return {
      id: newId('opl'),
      actor_type: actorType,
      actor_ref: null,
      action,
      target_type: targetType,
      target_id: targetId,
      target_ids_json: Array.isArray(targetIds) ? targetIds : [targetId],
      permission_id: null,
      permission_level: 'L2',
      decision: 'allowed',
      status: 'applied',
      before_json: before ?? null,
      after_json: after ?? null,
      diff_json: null,
      state_change_ids: stateChangeIds ?? [],
      evidence_refs: [],
      undo_of_id: null,
      reversible: true,
      undo_patch_json: null,
      reason: null,
      idempotency_key: null,
      occurred_at: nowIso,
      duration_ms: null,
      error: null,
      meta_json: meta ?? { source: 'm4a' },
    }
  }

  function diffOf(before, after, fields) {
    const diffs = []
    for (const field of fields) {
      const oldValue = before[field] === undefined ? null : before[field]
      const newValue = after[field] === undefined ? null : after[field]
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue
      diffs.push({ field, oldValue, newValue })
    }
    return diffs
  }

  function requireExpectedRev(value) {
    const rev = expectedRevValue(value)
    if (!Number.isInteger(rev) || rev < 1) {
      throw validationError('写操作必须提供正整数 expectedRev（If-Match）', ['expectedRev 缺失或非法'])
    }
    return rev
  }

  function optionalExpectedRev(value) {
    const rev = expectedRevValue(value)
    if (rev === undefined || rev === null) return null
    if (!Number.isInteger(rev) || rev < 1) throw validationError('expectedRev 必须是正整数', ['expectedRev 非法'])
    return rev
  }

  function assertHabitRev(habit, expectedRev, view) {
    if (habit.rev !== expectedRev) {
      throw new LifeosError('conflict', '习惯已被修改，请刷新后重试', {
        current: view,
        expectedRev,
        currentRev: habit.rev,
      })
    }
  }

  function normalizeHabitInput(input, { existing = null } = {}) {
    const values = pickFields(input, HABIT_FIELD_MAP)
    const errors = []
    const merged = existing
      ? {
          name: existing.name,
          frequency_rule: existing.frequency_rule,
          period_rule: existing.period_rule ?? null,
          start_date: existing.start_date,
          end_date: existing.end_date ?? null,
          status: existing.status,
          checkin_mode: existing.checkin_mode ?? 'manual',
        }
      : {
          name: null,
          frequency_rule: null,
          period_rule: null,
          start_date: null,
          end_date: null,
          status: 'active',
          checkin_mode: 'manual',
        }
    for (const key of Object.keys(merged)) {
      if (values[key] !== undefined) merged[key] = values[key]
    }
    if (typeof merged.name !== 'string' || merged.name.trim().length === 0) {
      errors.push('name 必填')
    } else {
      merged.name = merged.name.trim()
    }
    if (values.description !== undefined && values.description !== null && typeof values.description !== 'string') {
      errors.push('description: 必须是字符串')
    }
    if (merged.status !== undefined && !HABIT_STATUSES.includes(merged.status)) {
      errors.push(`status: 必须是 ${HABIT_STATUSES.join('/')}`)
    }
    if (values.checkin_mode !== undefined && !CHECKIN_MODES.includes(values.checkin_mode)) {
      errors.push(`checkin_mode: 必须是 ${CHECKIN_MODES.join('/')}`)
    }
    if (!isLocalDate(merged.start_date)) errors.push('start_date: 必须是 YYYY-MM-DD 自然日')
    if (merged.end_date !== undefined && merged.end_date !== null && !isLocalDate(merged.end_date)) {
      errors.push('end_date: 必须是 YYYY-MM-DD 自然日')
    }
    if (isLocalDate(merged.start_date) && isLocalDate(merged.end_date) && merged.end_date < merged.start_date) {
      errors.push('end_date: 不能早于 start_date')
    }
    const ruleCheck = validateFrequencyRule(merged.frequency_rule, { periodRule: merged.period_rule })
    if (!ruleCheck.ok) errors.push(...ruleCheck.errors)
    if (values.target_json !== undefined && values.target_json !== null && !isPlainObject(values.target_json)) {
      errors.push('target_json: 必须是对象')
    }
    if (
      values.event_match_json !== undefined &&
      values.event_match_json !== null &&
      !isPlainObject(values.event_match_json)
    ) {
      errors.push('event_match_json: 必须是对象')
    }
    if (values.sort_order !== undefined && values.sort_order !== null) {
      if (!Number.isInteger(values.sort_order) || values.sort_order < 0) errors.push('sort_order: 必须是 >=0 的整数')
    }
    if (values.icon !== undefined && values.icon !== null && values.icon !== '') {
      if (typeof values.icon !== 'string' || values.icon.trim().length === 0) errors.push('icon: 必须是字符串')
      else if (values.icon.trim().length > 8) errors.push('icon: 超过上限 8 字符')
    }
    if (values.group_id !== undefined && values.group_id !== null && values.group_id !== '') {
      if (typeof values.group_id !== 'string' || !/^hgrp_/.test(values.group_id)) {
        errors.push('group_id: 必须是 hgrp_ 开头的分组 ID')
      } else if (!getHabitGroupRecord(values.group_id)) {
        errors.push('group_id: 分组不存在')
      }
    }
    if (errors.length > 0) throw validationError('习惯字段不合法', errors)
    return { values, merged }
  }

  /* ── 习惯分组（M18，schema v4）──────────────────────────── */

  function allHabitGroups() {
    return entries('habit_group')
      .map(([, record]) => record)
      .filter((record) => isPlainObject(record) && !record.deleted_at)
  }

  function getHabitGroupRecord(id) {
    if (typeof id !== 'string' || id.length === 0) return null
    try {
      const record = store.get(CORE, 'habit_group', id)
      return record && !record.deleted_at ? record : null
    } catch {
      return null
    }
  }

  function sortHabitGroups(groups) {
    return groups
      .slice()
      .sort(
        (a, b) =>
          (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
          String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) ||
          String(a.name ?? '').localeCompare(String(b.name ?? '')),
      )
  }

  function habitGroupView(group) {
    return {
      id: group.id,
      name: group.name,
      sort_order: group.sort_order ?? 0,
      collapsed: group.collapsed === true,
      rev: group.rev ?? 1,
      created_at: group.created_at ?? null,
      updated_at: group.updated_at ?? null,
    }
  }

  function requireGroupRev(group, expectedRev, view) {
    if (group.rev !== expectedRev) {
      throw new LifeosError('conflict', '习惯分组已被修改，请刷新后重试', {
        current: view,
        expectedRev,
        currentRev: group.rev,
      })
    }
  }

  function normalizeGroupName(name) {
    if (typeof name !== 'string' || name.trim().length === 0) return null
    const trimmed = name.trim()
    return trimmed.length > 40 ? null : trimmed
  }

  function listHabitGroups() {
    return { items: sortHabitGroups(allHabitGroups()).map(habitGroupView) }
  }

  function createHabitGroup(input = {}) {
    assertWritable()
    const source = isPlainObject(input) ? input : {}
    const name = normalizeGroupName(source.name)
    const errors = []
    if (!name) errors.push('name 必填且不超过 40 字')
    if (source.sort_order !== undefined && source.sort_order !== null) {
      if (!Number.isInteger(source.sort_order) || source.sort_order < 0) errors.push('sort_order: 必须是 >=0 的整数')
    }
    if (source.collapsed !== undefined && source.collapsed !== null && typeof source.collapsed !== 'boolean') {
      errors.push('collapsed: 必须是布尔值')
    }
    if (errors.length > 0) throw validationError('习惯分组字段不合法', errors)
    const nowIso = currentIso()
    const existing = allHabitGroups()
    const nextOrder =
      Number.isInteger(source.sort_order) && source.sort_order >= 0
        ? source.sort_order
        : existing.reduce((max, group) => Math.max(max, Number(group.sort_order ?? 0)), -1) + 1
    const record = {
      id: newId('hgrp'),
      name,
      sort_order: nextOrder,
      collapsed: source.collapsed === true,
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      schema_version: 1,
      deleted_at: null,
      archived_at: null,
      origin_type: 'user_stated',
      origin_ref: null,
      origin_key: null,
      confirmation_status: 'not_required',
      evidence_refs: [],
      meta_json: null,
    }
    const oplog = oplogRecord({
      action: 'habit_group.create',
      targetType: 'habit_group',
      targetId: record.id,
      targetIds: [record.id],
      after: habitGroupView(record),
      nowIso,
    })
    return store
      .transaction([
        { unit: CORE, table: 'habit_group', key: record.id, value: record },
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emit('habit_group', [record.id], { action: 'create' })
        return { group: habitGroupView(record), revision: record.rev }
      })
  }

  function updateHabitGroup(id, patch = {}, revInput) {
    assertWritable()
    const expectedRev = requireExpectedRev(revInput)
    const current = getHabitGroupRecord(id)
    if (!current) throw new LifeosError('not_found', `习惯分组不存在：${id}`, { id })
    const currentView = habitGroupView(current)
    requireGroupRev(current, expectedRev, currentView)
    const source = isPlainObject(patch) ? patch : {}
    const errors = []
    const next = { ...current, updated_at: currentIso(), rev: current.rev + 1 }
    if (source.name !== undefined) {
      const name = normalizeGroupName(source.name)
      if (!name) errors.push('name 必填且不超过 40 字')
      else next.name = name
    }
    if (source.sort_order !== undefined) {
      if (!Number.isInteger(source.sort_order) || source.sort_order < 0) errors.push('sort_order: 必须是 >=0 的整数')
      else next.sort_order = source.sort_order
    }
    if (source.collapsed !== undefined) {
      if (typeof source.collapsed !== 'boolean') errors.push('collapsed: 必须是布尔值')
      else next.collapsed = source.collapsed
    }
    if (errors.length > 0) throw validationError('习惯分组字段不合法', errors)
    const changedFields = ['name', 'sort_order', 'collapsed'].filter(
      (field) => JSON.stringify(current[field] ?? null) !== JSON.stringify(next[field] ?? null),
    )
    if (changedFields.length === 0) {
      return Promise.resolve({ group: currentView, revision: current.rev, diff: [] })
    }
    const diffs = diffOf(current, next, changedFields)
    const changes = stateChangeRecords('habit_group', id, diffs, next.updated_at, next.rev)
    const oplog = oplogRecord({
      action: 'habit_group.update',
      targetType: 'habit_group',
      targetId: id,
      targetIds: [id],
      before: currentView,
      after: habitGroupView(next),
      stateChangeIds: changes.map((record) => record.id),
      nowIso: next.updated_at,
    })
    return store
      .transaction([
        { unit: CORE, table: 'habit_group', key: id, value: next },
        ...changes.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emit('habit_group', [id], { action: 'update' })
        return {
          group: habitGroupView(next),
          revision: next.rev,
          diff: diffs.map((diff) => ({ field: diff.field, oldValue: diff.oldValue, newValue: diff.newValue })),
        }
      })
  }

  /** 删除分组：软删分组 + 组内习惯一律回「未分组」（group_id=null），一次事务。 */
  function deleteHabitGroup(id, revInput) {
    assertWritable()
    const expectedRev = requireExpectedRev(revInput)
    const current = getHabitGroupRecord(id)
    if (!current) throw new LifeosError('not_found', `习惯分组不存在：${id}`, { id })
    const currentView = habitGroupView(current)
    requireGroupRev(current, expectedRev, currentView)
    const nowIso = currentIso()
    const members = allHabits().filter((habit) => habit.group_id === id)
    const nextGroup = { ...current, deleted_at: nowIso, updated_at: nowIso, rev: current.rev + 1 }
    const ops = [{ unit: CORE, table: 'habit_group', key: id, value: nextGroup }]
    const stateChangeOps = []
    const memberIds = []
    for (const habit of members) {
      const next = { ...habit, group_id: null, updated_at: nowIso, rev: habit.rev + 1 }
      ops.push({ unit: CORE, table: 'habit', key: habit.id, value: next })
      memberIds.push(habit.id)
      const changes = stateChangeRecords('habit', habit.id, [{ field: 'group_id', oldValue: id, newValue: null }], nowIso, next.rev)
      for (const record of changes) stateChangeOps.push({ unit: LOG, table: 'state_change', key: record.id, value: record })
    }
    const oplog = oplogRecord({
      action: 'habit_group.delete',
      targetType: 'habit_group',
      targetId: id,
      targetIds: [id, ...memberIds],
      before: currentView,
      after: { id, deleted_at: nowIso, moved_to_ungrouped: memberIds },
      nowIso,
    })
    return store
      .transaction([...ops, ...stateChangeOps, { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog }])
      .then(() => {
        emit('habit_group', [id], { action: 'delete' })
        if (memberIds.length > 0) emit('habit', memberIds, { action: 'update' })
        return { deleted: true, id, movedToUngrouped: memberIds, revision: nextGroup.rev }
      })
  }

  /** 拖拽排序：ids 为目标顺序，逐个写 sort_order=index；缺 id 报 not_found。 */
  function reorderHabitGroups(input = {}) {
    assertWritable()
    const ids = isPlainObject(input) && Array.isArray(input.ids) ? input.ids : null
    if (!ids || ids.length === 0) throw validationError('习惯分组排序不合法', ['ids 必须是非空数组'])
    if (new Set(ids).size !== ids.length) throw validationError('习惯分组排序不合法', ['ids 不能重复'])
    const current = allHabitGroups()
    const byId = new Map(current.map((group) => [group.id, group]))
    const missing = ids.filter((id) => !byId.has(id))
    if (missing.length > 0) throw new LifeosError('not_found', `习惯分组不存在：${missing[0]}`, { id: missing[0] })
    const nowIso = currentIso()
    const ops = []
    const changed = []
    ids.forEach((id, index) => {
      const group = byId.get(id)
      if (Number(group.sort_order ?? 0) === index) return
      const next = { ...group, sort_order: index, updated_at: nowIso, rev: group.rev + 1 }
      ops.push({ unit: CORE, table: 'habit_group', key: id, value: next })
      changed.push(id)
    })
    if (ops.length === 0) {
      return Promise.resolve({ items: sortHabitGroups(current).map(habitGroupView), revision: null })
    }
    const oplog = oplogRecord({
      action: 'habit_group.reorder',
      targetType: 'habit_group',
      targetId: null,
      targetIds: ids,
      after: { ids },
      nowIso,
    })
    return store.transaction([...ops, { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog }]).then(() => {
      emit('habit_group', changed, { action: 'reorder' })
      return { items: sortHabitGroups(allHabitGroups()).map(habitGroupView), revision: null }
    })
  }

  /* ── 习惯 CRUD ─────────────────────────────────────────── */

  function listHabits(input = {}) {
    const query = isPlainObject(input) ? input : {}
    const includeArchived = query.includeArchived === true
    const status = typeof query.status === 'string' && query.status !== 'all' ? query.status : null
    let habits = allHabits()
    if (status) habits = habits.filter((habit) => (habit.status ?? 'active') === status)
    if (!includeArchived) habits = habits.filter((habit) => (habit.status ?? 'active') !== 'archived')
    const checkinsByHabit = groupCheckinsByHabit(allCheckins())
    const today = todayLocal()
    return {
      items: sortHabits(habits).map((habit) =>
        habitView(habit, { today, checkins: checkinsByHabit.get(habit.id) ?? [] }),
      ),
      today,
    }
  }

  function getHabit(id) {
    const habit = getHabitRecord(id)
    if (!habit) throw new LifeosError('not_found', `习惯不存在：${id}`, { id })
    const today = todayLocal()
    const from = addDays(today, -(HABIT_DETAIL_CHECKIN_DAYS - 1))
    const checkins = allCheckins()
      .filter((record) => record.habit_id === id && record.local_date >= from && record.local_date <= today)
      .sort((a, b) => String(a.local_date).localeCompare(String(b.local_date)))
    return {
      habit: habitView(habit, { today, checkins }),
      checkins: checkins.map(checkinView),
    }
  }

  function makeHabitRecord(merged, values, nowIso) {
    const record = {
      id: newId('hab'),
      name: merged.name,
      description: values.description ?? null,
      status: merged.status ?? 'active',
      frequency_rule: merged.frequency_rule,
      period_rule: merged.period_rule ?? null,
      target_json: values.target_json ?? null,
      checkin_mode: values.checkin_mode ?? 'manual',
      start_date: merged.start_date,
      end_date: merged.end_date ?? null,
      time_hint: values.time_hint ?? null,
      event_match_json: values.event_match_json ?? null,
      sort_order: values.sort_order ?? 0,
      icon: typeof values.icon === 'string' && values.icon.trim().length > 0 ? values.icon.trim() : null,
      group_id: typeof values.group_id === 'string' && values.group_id.length > 0 ? values.group_id : null,
      paused_at: null,
      resumed_at: null,
      archived_at: null,
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      schema_version: 1,
      deleted_at: null,
      origin_type: 'user_stated',
      origin_ref: null,
      origin_key: null,
      confirmation_status: 'not_required',
      evidence_refs: [],
      meta_json: null,
    }
    if (record.status === 'paused') record.paused_at = nowIso
    if (record.status === 'archived') record.archived_at = nowIso
    return record
  }

  function createHabit(input = {}) {
    assertWritable()
    const nowIso = currentIso()
    const today = todayLocal()
    const source = { ...(isPlainObject(input) ? input : {}) }
    if (source.start_date === undefined) source.start_date = today
    const { values, merged } = normalizeHabitInput(source)
    const record = makeHabitRecord(merged, values, nowIso)
    const view = habitView(record, { today, checkins: [] })
    const oplog = oplogRecord({
      action: 'habit.create',
      targetType: 'habit',
      targetId: record.id,
      targetIds: [record.id],
      after: view,
      nowIso,
    })
    return store
      .transaction([
        { unit: CORE, table: 'habit', key: record.id, value: record },
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emit('habit', [record.id], { action: 'create' })
        return { habit: view, revision: record.rev }
      })
  }

  function updateHabit(id, patch = {}, revInput) {
    assertWritable()
    const expectedRev = requireExpectedRev(revInput)
    const current = getHabitRecord(id)
    if (!current) throw new LifeosError('not_found', `习惯不存在：${id}`, { id })
    const today = todayLocal()
    const currentCheckins = allCheckins().filter((record) => record.habit_id === id)
    const currentView = habitView(current, { today, checkins: currentCheckins })
    assertHabitRev(current, expectedRev, currentView)
    const { values, merged } = normalizeHabitInput(patch, { existing: current })
    const nowIso = currentIso()
    const next = { ...current, updated_at: nowIso, rev: current.rev + 1 }
    for (const field of HABIT_FIELDS) {
      if (values[field] !== undefined) next[field] = values[field]
    }
    next.name = merged.name
    next.frequency_rule = merged.frequency_rule
    next.period_rule = merged.period_rule ?? null
    next.start_date = merged.start_date
    next.end_date = merged.end_date ?? null
    if (merged.status !== undefined) next.status = merged.status
    if (values.checkin_mode !== undefined) next.checkin_mode = values.checkin_mode
    if (values.target_json !== undefined) next.target_json = values.target_json
    if (values.event_match_json !== undefined) next.event_match_json = values.event_match_json
    if (values.time_hint !== undefined) next.time_hint = values.time_hint
    if (values.sort_order !== undefined) next.sort_order = values.sort_order
    if (values.icon !== undefined) {
      const icon = values.icon === null ? null : String(values.icon).trim()
      next.icon = icon ? icon : null
    }
    if (values.group_id !== undefined) {
      next.group_id = values.group_id === null || values.group_id === '' ? null : values.group_id
    }
    if (next.status === 'archived' && current.status !== 'archived') next.archived_at = nowIso
    if (next.status === 'paused' && current.status !== 'paused') next.paused_at = nowIso
    if (next.status === 'active' && current.status === 'paused') next.resumed_at = nowIso
    if (current.status === 'archived' && next.status !== 'archived') {
      throw new LifeosError('invalid_state', '已归档习惯不可恢复为 active/paused', {
        id,
        currentStatus: current.status,
      })
    }
    const changedFields = HABIT_FIELDS.filter((field) => JSON.stringify(current[field] ?? null) !== JSON.stringify(next[field] ?? null))
    const diffs = diffOf(current, next, changedFields)
    const view = habitView(next, { today, checkins: currentCheckins })
    const changes = stateChangeRecords('habit', id, diffs, nowIso, next.rev)
    const oplog = oplogRecord({
      action: 'habit.update',
      targetType: 'habit',
      targetId: id,
      targetIds: [id],
      before: currentView,
      after: view,
      stateChangeIds: changes.map((record) => record.id),
      nowIso,
    })
    return store
      .transaction([
        { unit: CORE, table: 'habit', key: id, value: next },
        ...changes.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emit('habit', [id], { action: 'update' })
        return {
          habit: view,
          revision: next.rev,
          diff: diffs.map((diff) => ({ field: diff.field, oldValue: diff.oldValue, newValue: diff.newValue })),
        }
      })
  }

  function archiveHabit(id, revInput) {
    assertWritable()
    const expectedRev = requireExpectedRev(revInput)
    const current = getHabitRecord(id)
    if (!current) throw new LifeosError('not_found', `习惯不存在：${id}`, { id })
    const today = todayLocal()
    const checkins = allCheckins().filter((record) => record.habit_id === id)
    const currentView = habitView(current, { today, checkins })
    assertHabitRev(current, expectedRev, currentView)
    if (current.status === 'archived') {
      throw new LifeosError('invalid_state', '习惯已归档', { id })
    }
    const nowIso = currentIso()
    const next = { ...current, status: 'archived', archived_at: nowIso, updated_at: nowIso, rev: current.rev + 1 }
    const view = habitView(next, { today, checkins })
    const changes = stateChangeRecords(
      'habit',
      id,
      [{ field: 'status', oldValue: current.status, newValue: 'archived' }],
      nowIso,
      next.rev,
    )
    const oplog = oplogRecord({
      action: 'habit.archive',
      targetType: 'habit',
      targetId: id,
      targetIds: [id],
      before: currentView,
      after: view,
      stateChangeIds: changes.map((record) => record.id),
      nowIso,
    })
    return store
      .transaction([
        { unit: CORE, table: 'habit', key: id, value: next },
        ...changes.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emit('habit', [id], { action: 'archive' })
        return { habit: view, revision: next.rev }
      })
  }

  /* ── 打卡 ─────────────────────────────────────────────── */

  function findCheckin(habitId, dateLocal) {
    const matches = allCheckins().filter(
      (record) => record.habit_id === habitId && record.local_date === dateLocal,
    )
    return matches.length > 0 ? matches[0] : null
  }

  /** 含软删记录（撤销后同日再打卡要恢复同一行，保持 (habit_id, local_date) 唯一）。 */
  function findAnyCheckin(habitId, dateLocal) {
    const matches = entries('habit_checkin')
      .map(([, record]) => record)
      .filter(
        (record) =>
          isPlainObject(record) && record.habit_id === habitId && record.local_date === dateLocal,
      )
      .sort((a, b) => (b.rev ?? 0) - (a.rev ?? 0))
    return matches.length > 0 ? matches[0] : null
  }

  function normalizeCheckinStatus(status) {
    if (status === undefined || status === null) return 'done'
    if (typeof status !== 'string' || !CHECKIN_STATUSES.includes(status)) {
      throw validationError(`打卡状态不合法（${CHECKIN_STATUSES.join('/')}）`, [`status: ${String(status)}`])
    }
    return status
  }

  function assertCheckinDate(habit, dateLocal, retro, today) {
    if (!isLocalDate(dateLocal)) throw validationError('localDate 必须是 YYYY-MM-DD 自然日', ['localDate 非法'])
    if (dateLocal > today) throw validationError('不能给未来日期打卡', [`localDate: ${dateLocal} 晚于今天 ${today}`])
    if (isLocalDate(habit.start_date) && dateLocal < habit.start_date) {
      throw validationError('不能早于习惯开始日期打卡', [`localDate: ${dateLocal} < start_date ${habit.start_date}`])
    }
    if (isLocalDate(habit.end_date) && dateLocal > habit.end_date) {
      throw validationError('不能晚于习惯结束日期打卡', [`localDate: ${dateLocal} > end_date ${habit.end_date}`])
    }
    if (dateLocal < today) {
      if (retro !== true) {
        throw validationError('过去日期补记需要 retro=true', ['retro: 过去日期必须显式补记'])
      }
      const earliest = addDays(today, -RETRO_WINDOW_DAYS)
      if (dateLocal < earliest) {
        throw validationError(`补记窗口为近 ${RETRO_WINDOW_DAYS} 天`, [`localDate: ${dateLocal} < ${earliest}`])
      }
    }
  }

  function checkin(input = {}) {
    assertWritable()
    const payload = isPlainObject(input) ? input : {}
    const habitId = payload.habitId ?? payload.habit_id
    const habit = getHabitRecord(habitId)
    if (!habit) throw new LifeosError('not_found', `习惯不存在：${String(habitId)}`, { habitId })
    if (habit.status !== 'active') {
      throw new LifeosError('invalid_state', `习惯状态为 ${habit.status}，不能打卡`, { id: habit.id, status: habit.status })
    }
    const today = todayLocal()
    const dateLocal = payload.localDate ?? payload.local_date ?? today
    const retroFlag = payload.retro === true
    assertCheckinDate(habit, dateLocal, retroFlag, today)
    const retro = retroFlag && dateLocal < today
    const status = normalizeCheckinStatus(payload.status)
    const noteValue =
      payload.note === undefined || payload.note === null
        ? undefined
        : typeof payload.note === 'string'
          ? payload.note.trim() || null
          : String(payload.note)
    const valueJson = payload.value === undefined ? undefined : { value: payload.value }
    const existing = findAnyCheckin(habit.id, dateLocal)
    const nowIso = currentIso()

    if (existing && !existing.deleted_at) {
      const kindNext = retro ? 'retro' : existing.checkin_kind ?? 'manual'
      const noChange =
        existing.status === status &&
        (noteValue === undefined || noteValue === (existing.note ?? null)) &&
        (valueJson === undefined || JSON.stringify(valueJson) === JSON.stringify(existing.value_json ?? null)) &&
        kindNext === (existing.checkin_kind ?? 'manual')
      if (noChange) {
        return Promise.resolve({ checkin: checkinView(existing), revision: existing.rev, merged: false })
      }
      const next = {
        ...existing,
        status,
        checkin_kind: kindNext,
        value_json: valueJson === undefined ? existing.value_json ?? null : valueJson,
        note: noteValue === undefined ? existing.note ?? null : noteValue,
        backfilled_at: retro ? existing.backfilled_at ?? nowIso : existing.backfilled_at ?? null,
        updated_at: nowIso,
        rev: existing.rev + 1,
      }
      const diffs = diffOf(existing, next, ['status', 'checkin_kind', 'value_json', 'note'])
      const changes = stateChangeRecords('habit_checkin', next.id, diffs, nowIso, next.rev)
      const oplog = oplogRecord({
        action: 'habit.checkin',
        targetType: 'habit_checkin',
        targetId: next.id,
        targetIds: [next.id],
        before: checkinView(existing),
        after: checkinView(next),
        stateChangeIds: changes.map((record) => record.id),
        nowIso,
        meta: { source: 'm4a', habitId: habit.id, localDate: dateLocal, merged: true, retro },
      })
      return store
        .transaction([
          { unit: CORE, table: 'habit_checkin', key: next.id, value: next },
          ...changes.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
          { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
        ])
        .then(() => {
          emit('habit_checkin', [next.id], { habitId: habit.id, localDate: dateLocal, merged: true })
          emit('habit', [habit.id], { action: 'checkin', localDate: dateLocal })
          return { checkin: checkinView(next), revision: next.rev, merged: true }
        })
    }

    // 软删记录（撤销后同日再打卡）：恢复同一行，避免重复 (habit_id, local_date)。
    const base = existing && existing.deleted_at ? existing : null
    const record = {
      id: base ? base.id : newId('hci'),
      habit_id: habit.id,
      local_date: dateLocal,
      status,
      checkin_kind: retro ? 'retro' : 'manual',
      value_json: valueJson === undefined ? base?.value_json ?? null : valueJson,
      note: noteValue === undefined ? base?.note ?? null : noteValue,
      backfilled_at: retro ? nowIso : base?.backfilled_at ?? null,
      created_at: base ? base.created_at : nowIso,
      updated_at: nowIso,
      rev: base ? base.rev + 1 : 1,
      schema_version: 1,
      deleted_at: null,
      origin_type: 'user_stated',
      origin_ref: null,
      confirmation_status: 'not_required',
      evidence_refs: [],
      meta_json: { source: 'm4a', retro },
    }
    const viewAfter = checkinView(record)
    const diffs = [{ field: 'status', oldValue: base ? base.status : null, newValue: status }]
    const changes = stateChangeRecords('habit_checkin', record.id, diffs, nowIso, record.rev)
    const oplog = oplogRecord({
      action: 'habit.checkin',
      targetType: 'habit_checkin',
      targetId: record.id,
      targetIds: [record.id],
      before: base ? checkinView(base) : null,
      after: viewAfter,
      stateChangeIds: changes.map((item) => item.id),
      nowIso,
      meta: { source: 'm4a', habitId: habit.id, localDate: dateLocal, restored: Boolean(base), retro },
    })
    return store
      .transaction([
        { unit: CORE, table: 'habit_checkin', key: record.id, value: record },
        ...changes.map((item) => ({ unit: LOG, table: 'state_change', key: item.id, value: item })),
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emit('habit_checkin', [record.id], { habitId: habit.id, localDate: dateLocal, merged: false })
        emit('habit', [habit.id], { action: 'checkin', localDate: dateLocal })
        return { checkin: viewAfter, revision: record.rev, merged: false }
      })
  }

  function uncheck(input = {}) {
    assertWritable()
    const payload = isPlainObject(input) ? input : {}
    const habitId = payload.habitId ?? payload.habit_id
    const habit = getHabitRecord(habitId)
    if (!habit) throw new LifeosError('not_found', `习惯不存在：${String(habitId)}`, { habitId })
    const dateLocal = payload.localDate ?? payload.local_date
    if (!isLocalDate(dateLocal)) throw validationError('localDate 必须是 YYYY-MM-DD 自然日', ['localDate 非法'])
    const optionalRev = optionalExpectedRev(payload.expectedRev ?? payload.rev)
    const existing = findCheckin(habit.id, dateLocal)
    if (!existing) throw new LifeosError('not_found', `该日期没有打卡记录：${dateLocal}`, { habitId, localDate: dateLocal })
    if (optionalRev !== null && existing.rev !== optionalRev) {
      throw new LifeosError('conflict', '打卡记录已被修改，请刷新后重试', {
        current: checkinView(existing),
        expectedRev: optionalRev,
        currentRev: existing.rev,
      })
    }
    const nowIso = currentIso()
    const next = { ...existing, deleted_at: nowIso, updated_at: nowIso, rev: existing.rev + 1 }
    const changes = stateChangeRecords(
      'habit_checkin',
      next.id,
      [{ field: 'deleted_at', oldValue: null, newValue: nowIso }],
      nowIso,
      next.rev,
    )
    const oplog = oplogRecord({
      action: 'habit.uncheck',
      targetType: 'habit_checkin',
      targetId: next.id,
      targetIds: [next.id],
      before: checkinView(existing),
      after: checkinView(next),
      stateChangeIds: changes.map((item) => item.id),
      nowIso,
      meta: { source: 'm4a', habitId: habit.id, localDate: dateLocal },
    })
    return store
      .transaction([
        { unit: CORE, table: 'habit_checkin', key: next.id, value: next },
        ...changes.map((item) => ({ unit: LOG, table: 'state_change', key: item.id, value: item })),
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emit('habit_checkin', [next.id], { habitId: habit.id, localDate: dateLocal, deleted: true })
        emit('habit', [habit.id], { action: 'uncheck', localDate: dateLocal })
        return { ok: true, revision: next.rev }
      })
  }

  function listCheckins(input = {}) {
    const query = isPlainObject(input) ? input : {}
    const habitId = query.habitId ?? query.habit_id
    const habit = getHabitRecord(habitId)
    if (!habit) throw new LifeosError('not_found', `习惯不存在：${String(habitId)}`, { habitId })
    const today = todayLocal()
    const from = isLocalDate(query.from) ? query.from : isLocalDate(habit.start_date) ? habit.start_date : today
    const to = isLocalDate(query.to) ? query.to : today
    if (from > to) throw validationError('from 不能晚于 to', ['from > to'])
    const items = allCheckins()
      .filter(
        (record) =>
          record.habit_id === habit.id && record.local_date >= from && record.local_date <= to,
      )
      .sort((a, b) => String(a.local_date).localeCompare(String(b.local_date)))
      .map(checkinView)
    return { items }
  }

  /* ── 统计 / 月矩阵 / 今日 ───────────────────────────────── */

  function resolveStatsRange(input, today) {
    const from = isLocalDate(input.from) ? input.from : addDays(today, -(DEFAULT_STATS_WINDOW_DAYS - 1))
    const to = isLocalDate(input.to) ? input.to : today
    if (from > to) throw validationError('from 不能晚于 to', ['from > to'])
    return { from, to }
  }

  function statsItemOf(habit, today, from, to, checkins, streakMode, weekStart) {
    const { period } = periodTypeOf(habit)
    const periodKeyValue = periodKey({ period, week_start: weekStart }, today)
    const achievement = computePeriodAchievement({
      habit,
      checkins,
      periodKey: periodKeyValue,
      weekStart,
    })
    const coverage = computeCoverage({
      habit,
      checkins,
      from,
      to,
      asOf: today,
      weekStart,
      timeZone,
    })
    const streak = computeStreak({
      habit,
      checkins,
      asOf: today,
      mode: streakMode,
      weekStart,
      timeZone,
    })
    const todayRecord = checkins.find((record) => record.local_date === today) ?? null
    return {
      habitId: habit.id,
      name: habit.name,
      frequency_text: describeFrequency(habit.frequency_rule, habit.period_rule),
      streak,
      coverage: {
        recorded: coverage.recorded,
        expected: coverage.expected,
        ratio: coverage.ratio,
        unknownDays: coverage.unknownDays,
        windowDays: coverage.windowDays,
      },
      period: {
        key: periodKeyValue,
        period,
        target: achievement.target,
        achieved: achievement.achieved,
        met: achievement.met,
      },
      today: { status: todayStatusOf(habit, today, checkins), checkin_id: todayRecord ? todayRecord.id : null },
    }
  }

  function getStats(input = {}) {
    const query = isPlainObject(input) ? input : {}
    const today = todayLocal()
    const range = resolveStatsRange(query, today)
    const streakMode = query.streakMode === 'strict' || query.mode === 'strict' ? 'strict' : 'grace'
    const weekStart = weekStartMode()
    const habits = allHabits()
    const checkinsByHabit = groupCheckinsByHabit(allCheckins())
    const wanted = Array.isArray(query.habitIds) && query.habitIds.length > 0 ? new Set(query.habitIds) : null
    const selected = sortHabits(habits).filter((habit) => {
      if (wanted) return wanted.has(habit.id)
      return (habit.status ?? 'active') !== 'archived'
    })
    return {
      range: { from: range.from, to: range.to },
      today,
      habits: selected.map((habit) => {
        const checkins = checkinsByHabit.get(habit.id) ?? []
        return statsItemOf(habit, today, range.from, range.to, checkins, streakMode, weekStart)
      }),
    }
  }

  function getMonth(input = {}) {
    const query = isPlainObject(input) ? input : {}
    const today = todayLocal()
    const month = typeof query.month === 'string' && query.month.length > 0 ? query.month : today.slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(month) || Number(month.slice(5, 7)) < 1 || Number(month.slice(5, 7)) > 12) {
      throw validationError('month 必须是 YYYY-MM', ['month 非法'])
    }
    const includeArchived = query.includeArchived === true
    const habits = allHabits().filter((habit) =>
      includeArchived ? true : (habit.status ?? 'active') !== 'archived',
    )
    return buildMonthMatrix({
      habits: sortHabits(habits),
      checkins: allCheckins(),
      month,
      todayLocal: today,
      weekStart: weekStartMode(),
      timeZone,
    })
  }

  function todayHabits() {
    const today = todayLocal()
    const weekStart = weekStartMode()
    const habits = sortHabits(allHabits()).filter((habit) => (habit.status ?? 'active') !== 'archived')
    const checkinsByHabit = groupCheckinsByHabit(allCheckins())
    return habits.map((habit) => {
      const checkins = checkinsByHabit.get(habit.id) ?? []
      return {
        habitId: habit.id,
        name: habit.name,
        frequency_text: describeFrequency(habit.frequency_rule, habit.period_rule),
        target_text: targetTextOf(habit),
        time_hint: habit.time_hint ?? null,
        status: habit.status ?? 'active',
        today_status: todayStatusOf(habit, today, checkins),
        today_checkin_id: (checkins.find((record) => record.local_date === today) ?? null)?.id ?? null,
        streak: computeStreak({ habit, checkins, asOf: today, mode: 'grace', weekStart, timeZone }),
      }
    })
  }

  return {
    listHabits,
    getHabit,
    createHabit,
    updateHabit,
    archiveHabit,
    checkin,
    uncheck,
    listCheckins,
    getStats,
    getMonth,
    todayHabits,
    listHabitGroups,
    createHabitGroup,
    updateHabitGroup,
    deleteHabitGroup,
    reorderHabitGroups,
  }
}

export { HABIT_STATUSES, CHECKIN_STATUSES, CHECKIN_MODES, FREQUENCY_KINDS, WEEKDAYS, RETRO_WINDOW_DAYS }
