/**
 * LifeOS — 纠错后的派生重算（A 线：领域层，纯函数）
 *
 * 契约：`M2-PLAN.md` §2.4 / `design/04` §9.4（纠错重算闭包）。
 * M2 先支持两类派生影响立即重算：`metric_stat`（指标日统计）与 `habit_streak`（习惯连续/周期）；
 * event 纠错额外产出 `event_index`（时间线索引）与关联习惯的重算计划。
 *
 * 本文件不写库：返回 affected（受影响派生）+ plan（B 的落库/重算步骤）。
 * 零第三方依赖：仅使用同目录 time.js / extraction.js。
 */

import { isIsoTimestamp, localDateOfIso } from './time.js'
import { buildEvidenceRefs } from './extraction.js'

export { buildEvidenceRefs }

/** 修正类型：metric / habit_checkin / event / task。 */
export function detectEntityType(record) {
  if (!record || typeof record !== 'object') return null
  if (record.metric_code) return 'metric'
  if (record.habit_id && record.local_date) return 'habit_checkin'
  if (record.event_type || record.occurred_start_at) return 'event'
  if (record.title && record.status) return 'task'
  return null
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 顶层字段差异（忽略 updated_at/rev 等审计字段）。 */
export function diffRecordFields(before, after) {
  const base = isPlainObject(before) ? before : {}
  const next = isPlainObject(after) ? after : {}
  const ignored = new Set(['updated_at', 'rev', 'schema_version', 'meta_json'])
  const fields = new Set([...Object.keys(base), ...Object.keys(next)])
  const changed = []
  for (const field of fields) {
    if (ignored.has(field)) continue
    const a = base[field] === undefined ? null : base[field]
    const b = next[field] === undefined ? null : next[field]
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(field)
  }
  return changed.sort()
}

function localDayOf(record, timeZone) {
  if (typeof record?.local_date === 'string') return record.local_date
  const iso = record?.measured_at ?? record?.occurred_start_at ?? record?.completed_at ?? null
  if (typeof iso === 'string' && isIsoTimestamp(iso)) return localDateOfIso(timeZone, iso)
  return null
}

function isRevoked(after, before) {
  if (after === null || after === undefined) return true
  if (!isPlainObject(after)) return true
  if (after.revoked === true || after.deleted_at) return true
  if (after.validity === 'retracted' || after.validity === 'superseded') return true
  if (after.status === 'not_done' && before?.status !== 'not_done') return false // 打卡改判不是撤销
  return false
}

/**
 * 纠错后重算闭包。
 * @param {{before: object, after?: object|null, timeZone?: string, now?: string}} input
 *   - before：纠错前的派生对象；after：纠错后的对象（null/undefined 表示撤销）；timeZone 默认 Asia/Shanghai
 * @returns {{entityType:string|null, revoked:boolean, changedFields:string[], affected:Array<object>, plan:Array<object>}}
 */
export function recomputeAfterCorrection({ before, after = null, timeZone = 'Asia/Shanghai' } = {}) {
  if (!before || typeof before !== 'object') {
    throw new TypeError('recomputeAfterCorrection requires { before } 对象')
  }
  const entityType = detectEntityType(before)
  const changedFields = diffRecordFields(before, after)
  const revoked = isRevoked(after, before)
  const affected = []
  const plan = []

  const push = (item) => {
    if (!affected.some((existing) => JSON.stringify(existing) === JSON.stringify(item))) affected.push(item)
  }
  const planStep = (step, target, extra = {}) => {
    plan.push({ step, target, ...extra, mode: 'immediate', reason: revoked ? 'revoked' : 'corrected' })
  }

  if (entityType === 'metric') {
    const day = localDayOf(before, timeZone)
    const key = { metric_code: before.metric_code, local_date: day, scope: day ? 'day' : 'all' }
    push({ type: 'metric_stat', key, reason: revoked ? 'metric_revoked' : 'metric_corrected' })
    if (before.event_id) push({ type: 'event_index', key: { event_id: before.event_id }, reason: 'metric_linked_event' })
    planStep('recompute_metric_daily_total', key, { write: 'derived_stat' })
    planStep('recompute_metric_range_stats', { metric_code: before.metric_code }, { write: 'derived_stat' })
    if (before.event_id) planStep('recompute_event_index', { event_id: before.event_id }, { write: 'in-memory-index' })
    if (revoked) planStep('mark_evidence_stale', { type: 'metric', id: before.id }, { write: 'evidence_link.stale_at' })
    return { entityType, revoked, changedFields, affected, plan }
  }

  if (entityType === 'habit_checkin') {
    const habitId = before.habit_id
    const localDate = before.local_date ?? null
    const key = { habit_id: habitId, local_date: localDate }
    push({ type: 'habit_streak', key, reason: revoked ? 'checkin_revoked' : 'checkin_corrected' })
    planStep('recompute_habit_streak', { habit_id: habitId }, { write: 'derived_stat' })
    planStep('recompute_habit_period_rate', { habit_id: habitId, period: 'current' }, { write: 'derived_stat' })
    if (typeof before.event_id === 'string') {
      push({ type: 'event_index', key: { event_id: before.event_id }, reason: 'checkin_linked_event' })
      planStep('recompute_event_index', { event_id: before.event_id }, { write: 'in-memory-index' })
    }
    if (revoked) planStep('mark_evidence_stale', { type: 'habit_checkin', id: before.id }, { write: 'evidence_link.stale_at' })
    return { entityType, revoked, changedFields, affected, plan }
  }

  if (entityType === 'event') {
    const day = localDayOf(before, timeZone)
    const key = { event_type: before.event_type, local_date: day }
    push({ type: 'event_index', key, reason: revoked ? 'event_revoked' : 'event_corrected' })
    planStep('recompute_event_index', key, { write: 'in-memory-index' })
    if (typeof before.habit_id === 'string') {
      push({ type: 'habit_streak', key: { habit_id: before.habit_id, local_date: day }, reason: 'habit_linked_event' })
      planStep('recompute_habit_streak', { habit_id: before.habit_id }, { write: 'derived_stat' })
    }
    if (typeof before.task_id === 'string') {
      planStep('recompute_task_completion_hint', { task_id: before.task_id }, { write: 'agent_inference' })
    }
    if (revoked) planStep('mark_evidence_stale', { type: 'event', id: before.id }, { write: 'evidence_link.stale_at' })
    return { entityType, revoked, changedFields, affected, plan }
  }

  if (entityType === 'task') {
    // 任务纠错本身不产生派生统计；保留 changedFields 供 B 落 state_change
    return { entityType, revoked, changedFields, affected, plan }
  }

  return { entityType, revoked, changedFields, affected, plan }
}

/** 便捷判断：对象是否属于 M2 可纠错的派生类型。 */
export function isCorrectableEntity(record) {
  return ['metric', 'habit_checkin', 'event', 'task'].includes(detectEntityType(record))
}
