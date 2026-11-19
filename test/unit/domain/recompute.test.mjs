import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildEvidenceRefs,
  detectEntityType,
  diffRecordFields,
  isCorrectableEntity,
  recomputeAfterCorrection,
} from '../../../src/domain/recompute.js'
import { extractCandidates } from '../../../src/domain/extraction.js'

const TZ = 'Asia/Shanghai'
const NOW = '2026-11-13T02:00:00.000Z'

function metricRecord(overrides = {}) {
  return {
    id: 'mtr_test',
    metric_code: 'steps',
    value_num: 9000,
    unit: 'count',
    measured_at: NOW,
    measured_tz: TZ,
    validity: 'valid',
    rev: 1,
    ...overrides,
  }
}

function checkinRecord(overrides = {}) {
  return {
    id: 'hci_test',
    habit_id: 'hab_test',
    local_date: '2026-11-13',
    status: 'done',
    checkin_kind: 'from_event',
    rev: 1,
    ...overrides,
  }
}

test('detectEntityType / isCorrectableEntity', () => {
  assert.equal(detectEntityType(metricRecord()), 'metric')
  assert.equal(detectEntityType(checkinRecord()), 'habit_checkin')
  assert.equal(detectEntityType({ event_type: 'exercise', occurred_start_at: NOW }), 'event')
  assert.equal(detectEntityType({ title: 'x', status: 'todo' }), 'task')
  assert.equal(detectEntityType(null), null)
  assert.equal(isCorrectableEntity({ foo: 1 }), false)
  assert.equal(isCorrectableEntity(metricRecord()), true)
})

test('diffRecordFields：忽略审计字段，输出变更字段', () => {
  const before = metricRecord()
  const after = { ...before, value_num: 8000, updated_at: NOW, rev: 2 }
  assert.deepEqual(diffRecordFields(before, after), ['value_num'])
  assert.deepEqual(diffRecordFields(before, { ...before }), [])
})

test('场景 1：修改已确认 metric → metric_stat 重算计划（M2-G4）', () => {
  const before = metricRecord()
  const after = { ...before, value_num: 8000, rev: 2 }
  const result = recomputeAfterCorrection({ before, after, timeZone: TZ })
  assert.equal(result.entityType, 'metric')
  assert.equal(result.revoked, false)
  assert.deepEqual(result.changedFields, ['value_num'])
  const stat = result.affected.find((item) => item.type === 'metric_stat')
  assert.ok(stat)
  assert.equal(stat.key.metric_code, 'steps')
  assert.equal(stat.key.local_date, '2026-11-13')
  assert.equal(stat.reason, 'metric_corrected')
  assert.ok(result.plan.some((step) => step.step === 'recompute_metric_daily_total'))
  assert.ok(result.plan.some((step) => step.step === 'recompute_metric_range_stats'))
  assert.ok(result.plan.every((step) => step.mode === 'immediate'))
})

test('场景 1b：撤销 metric（after=null）→ metric_stat + 证据失效计划', () => {
  const before = metricRecord()
  const result = recomputeAfterCorrection({ before, after: null, timeZone: TZ })
  assert.equal(result.revoked, true)
  const stat = result.affected.find((item) => item.type === 'metric_stat')
  assert.equal(stat.reason, 'metric_revoked')
  assert.ok(result.plan.some((step) => step.step === 'mark_evidence_stale'))
  assert.ok(result.plan.every((step) => step.reason === 'revoked'))
})

test('场景 2：habit_checkin 改判 → habit_streak + 周期达成率重算', () => {
  const before = checkinRecord()
  const after = { ...before, status: 'not_done', rev: 2 }
  const result = recomputeAfterCorrection({ before, after, timeZone: TZ })
  assert.equal(result.entityType, 'habit_checkin')
  assert.equal(result.revoked, false)
  const streak = result.affected.find((item) => item.type === 'habit_streak')
  assert.ok(streak)
  assert.equal(streak.key.habit_id, 'hab_test')
  assert.equal(streak.key.local_date, '2026-11-13')
  const steps = result.plan.map((step) => step.step)
  assert.ok(steps.includes('recompute_habit_streak'))
  assert.ok(steps.includes('recompute_habit_period_rate'))
  assert.ok(result.plan.every((step) => step.write === 'derived_stat'))
})

test('场景 3：event 纠错 → event_index + 关联习惯重算', () => {
  const before = {
    id: 'evt_test',
    event_type: 'exercise',
    occurred_start_at: NOW,
    habit_id: 'hab_test',
    validity: 'valid',
    rev: 1,
  }
  const after = { ...before, occurred_start_at: '2026-11-13T03:00:00.000Z', rev: 2 }
  const result = recomputeAfterCorrection({ before, after, timeZone: TZ })
  assert.equal(result.entityType, 'event')
  assert.ok(result.affected.some((item) => item.type === 'event_index'))
  assert.ok(result.affected.some((item) => item.type === 'habit_streak'))
  const steps = result.plan.map((step) => step.step)
  assert.ok(steps.includes('recompute_event_index'))
  assert.ok(steps.includes('recompute_habit_streak'))
})

test('场景 4：task 纠错无派生统计；无变化返回空计划', () => {
  const task = { id: 'tsk_test', title: '写报告', status: 'todo', due_date: '2026-11-14', rev: 1 }
  const result = recomputeAfterCorrection({ before: task, after: { ...task, title: '写周报', rev: 2 } })
  assert.equal(result.entityType, 'task')
  assert.deepEqual(result.changedFields, ['title'])
  assert.deepEqual(result.affected, [])
  assert.deepEqual(result.plan, [])
  assert.deepEqual(recomputeAfterCorrection({ before: task, after: { ...task } }).changedFields, [])
})

test('输入防御：before 缺失抛 TypeError', () => {
  assert.throws(() => recomputeAfterCorrection({}), TypeError)
  assert.throws(() => recomputeAfterCorrection({ before: null }), TypeError)
})

test('buildEvidenceRefs（recompute.js 再导出）与抽取候选兼容', () => {
  const text = '今天步数9000。'
  const [candidate] = extractCandidates(text, { localDate: '2026-11-13', rawRecordId: 'rr_1' })
  const refs = buildEvidenceRefs(candidate)
  assert.equal(refs[0].type, 'raw_record')
  assert.equal(refs[0].id, 'rr_1')
  assert.equal(text.slice(...refs[0].locator.span), refs[0].excerpt)
})
