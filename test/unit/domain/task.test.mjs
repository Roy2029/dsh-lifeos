import test from 'node:test'
import assert from 'node:assert/strict'

import {
  REPEAT_KINDS,
  TASK_ACTIONS,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  allowedActions,
  canTransition,
  normalizeRepeatRule,
  normalizeTaskInput,
  normalizeTaskUpdate,
  timeKindOf,
  transitionTask,
  validateStatusChange,
} from '../../../src/domain/task.js'
import { newId } from '../../../src/domain/ids.js'

const NOW = '2026-11-13T02:00:00.000Z'
const TODAY = '2026-11-13'

function makeTask(status = 'todo', extra = {}) {
  return { id: newId('tsk'), title: '写周报', status, created_at: NOW, updated_at: NOW, rev: 1, ...extra }
}

// ---------------------------------------------------------------------------
// 状态机：4 条合法 + 4 条非法（M1-PLAN §1.2 / M1-G1）
// ---------------------------------------------------------------------------

test('合法转换：todo --start--> doing', () => {
  const task = makeTask('todo')
  const result = transitionTask(task, 'start', { now: NOW })
  assert.equal(result.ok, true)
  assert.equal(result.task.status, 'doing')
  assert.deepEqual(result.changedFields, ['status'])
  assert.equal(task.status, 'todo', '不得修改入参')
})

test('合法转换：todo --complete--> done（写 completed_at）', () => {
  const result = transitionTask(makeTask('todo'), 'complete', { now: NOW })
  assert.equal(result.ok, true)
  assert.equal(result.task.status, 'done')
  assert.equal(result.task.completed_at, NOW)
  assert.ok(result.changedFields.includes('completed_at'))
})

test('合法转换：doing --complete--> done', () => {
  const result = transitionTask(makeTask('doing'), 'complete', { now: NOW })
  assert.equal(result.ok, true)
  assert.equal(result.task.status, 'done')
})

test('合法转换：todo/doing --cancel--> cancelled（写 cancelled_at）', () => {
  const a = transitionTask(makeTask('todo'), 'cancel', { now: NOW })
  assert.equal(a.ok, true)
  assert.equal(a.task.status, 'cancelled')
  assert.equal(a.task.cancelled_at, NOW)
  const b = transitionTask(makeTask('doing'), 'cancel', { now: NOW })
  assert.equal(b.ok, true)
})

test('合法转换：done/cancelled --reopen--> todo（清两个时间戳）', () => {
  const done = transitionTask(makeTask('done', { completed_at: NOW }), 'reopen', { now: NOW })
  assert.equal(done.ok, true)
  assert.equal(done.task.status, 'todo')
  assert.equal(done.task.completed_at, null)
  const cancelled = transitionTask(makeTask('cancelled', { cancelled_at: NOW }), 'reopen', { now: NOW })
  assert.equal(cancelled.task.cancelled_at, null)
})

test('非法转换：done --start--> doing 拒绝，并返回 allowed', () => {
  const result = transitionTask(makeTask('done'), 'start', { now: NOW })
  assert.equal(result.ok, false)
  assert.deepEqual(result.allowed, ['reopen'])
  assert.ok(result.errors[0].includes('非法转换'))
})

test('非法转换：cancelled --complete--> done 拒绝', () => {
  const result = transitionTask(makeTask('cancelled'), 'complete')
  assert.equal(result.ok, false)
  assert.deepEqual(result.allowed, ['reopen'])
})

test('非法转换：todo --reopen--> todo 拒绝（无此动作）', () => {
  const result = transitionTask(makeTask('todo'), 'reopen')
  assert.equal(result.ok, false)
  assert.deepEqual(result.allowed, ['start', 'complete', 'cancel'])
})

test('非法转换：doing --start--> doing 拒绝；未知状态/未知动作拒绝', () => {
  assert.equal(transitionTask(makeTask('doing'), 'start').ok, false)
  assert.equal(transitionTask(makeTask('weird'), 'complete').ok, false)
  assert.equal(transitionTask(makeTask('todo'), 'explode').ok, false)
})

test('转换表封闭性：4 状态 × 4 动作只有 7 条合法边', () => {
  let legal = 0
  for (const status of TASK_STATUSES) {
    for (const action of TASK_ACTIONS) {
      assert.equal(canTransition(status, action), Boolean(TASK_TRANSITIONS[status]?.[action]))
      if (canTransition(status, action)) legal += 1
    }
  }
  assert.equal(legal, 7)
  assert.equal(allowedActions('todo').length, 3)
  assert.deepEqual(allowedActions('done'), ['reopen'])
})

test('validateStatusChange：直接改 status 的等价动作映射', () => {
  assert.deepEqual(validateStatusChange('todo', 'done'), { ok: true, action: 'complete', nextStatus: 'done' })
  assert.deepEqual(validateStatusChange('todo', 'doing'), { ok: true, action: 'start', nextStatus: 'doing' })
  assert.deepEqual(validateStatusChange('done', 'todo'), { ok: true, action: 'reopen', nextStatus: 'todo' })
  assert.deepEqual(validateStatusChange('todo', 'todo'), { ok: true, action: null, nextStatus: 'todo' })
  const bad = validateStatusChange('done', 'doing')
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.allowed, ['reopen'])
  assert.equal(validateStatusChange('todo', 'nope').ok, false)
})

// ---------------------------------------------------------------------------
// normalizeTaskInput：时间三形态 + 截止 + 优先级
// ---------------------------------------------------------------------------

test('normalizeTaskInput：无时间（只标题/优先级默认 none）', () => {
  const result = normalizeTaskInput({ title: '  写周报  ' })
  assert.equal(result.ok, true)
  assert.equal(result.value.title, '写周报')
  assert.equal(result.value.priority, 'none')
  assert.equal(result.value.time_kind, 'none')
  assert.equal(result.value.is_all_day, false)
  assert.equal(result.value.scheduled_date, null)
  assert.equal(result.value.scheduled_start_at, null)
  assert.equal(result.value.due_date, null)
  assert.equal(result.value.due_at, null)
})

test('normalizeTaskInput：日期型（scheduled_date + is_all_day 强制 true）', () => {
  const result = normalizeTaskInput({ title: '交房租', scheduledDate: TODAY })
  assert.equal(result.ok, true)
  assert.equal(result.value.scheduled_date, TODAY)
  assert.equal(result.value.is_all_day, true)
  assert.equal(result.value.time_kind, 'all_day')
  assert.equal(normalizeTaskInput({ title: 'x', scheduled_date: TODAY, isAllDay: true }).ok, true)
  // 日期型显式 is_all_day=false 非法
  assert.equal(normalizeTaskInput({ title: 'x', scheduled_date: TODAY, is_all_day: false }).ok, false)
})

test('normalizeTaskInput：时间段型（start < end，camelCase 兼容）', () => {
  const result = normalizeTaskInput({
    title: '评审会',
    scheduledStartAt: '2026-11-13T02:00:00.000Z',
    scheduledEndAt: '2026-11-13T03:00:00.000Z',
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.time_kind, 'span')
  assert.equal(result.value.is_all_day, false)
  // 起止倒挂 / 只给一端 / 与日期互斥
  assert.equal(
    normalizeTaskInput({
      title: 'x',
      scheduled_start_at: '2026-11-13T03:00:00.000Z',
      scheduled_end_at: '2026-11-13T02:00:00.000Z',
    }).ok,
    false,
  )
  assert.equal(normalizeTaskInput({ title: 'x', scheduled_start_at: '2026-11-13T02:00:00.000Z' }).ok, false)
  assert.equal(
    normalizeTaskInput({ title: 'x', scheduled_date: TODAY, scheduled_start_at: '2026-11-13T02:00:00.000Z' }).ok,
    false,
  )
})

test('normalizeTaskInput：仅截止（due_date / due_at 互斥，允许过去日期=逾期种子）', () => {
  const byDate = normalizeTaskInput({ title: '交报告', dueDate: '2026-11-12' })
  assert.equal(byDate.ok, true)
  assert.equal(byDate.value.due_date, '2026-11-12')
  assert.equal(byDate.value.time_kind, 'none')
  const byAt = normalizeTaskInput({ title: '交报告', dueAt: '2026-11-14T10:00:00.000Z' })
  assert.equal(byAt.ok, true)
  assert.equal(byAt.value.due_at, '2026-11-14T10:00:00.000Z')
  assert.equal(normalizeTaskInput({ title: 'x', due_date: TODAY, due_at: '2026-11-14T10:00:00.000Z' }).ok, false)
})

test('normalizeTaskInput：标题/优先级/格式校验', () => {
  assert.equal(normalizeTaskInput({ title: '' }).ok, false)
  assert.equal(normalizeTaskInput({ title: 'x'.repeat(501) }).ok, false)
  assert.equal(normalizeTaskInput({ title: 'x', priority: 'urgent' }).ok, false)
  assert.equal(normalizeTaskInput({ title: 'x', priority: 'high' }).value.priority, 'high')
  assert.equal(normalizeTaskInput({ title: 'x', scheduled_date: '2026-02-30' }).ok, false)
  assert.equal(normalizeTaskInput({ title: 'x', due_at: '2026-11-14T10:00:00Z' }).ok, false)
  assert.equal(normalizeTaskInput(null).ok, false)
})

test('normalizeTaskUpdate：合并 current，null 清除，changedFields 准确', () => {
  const current = makeTask('todo', { scheduled_date: TODAY, is_all_day: true, time_kind: 'all_day' })
  const cleared = normalizeTaskUpdate({ scheduledDate: null }, current)
  assert.equal(cleared.ok, true)
  assert.equal(cleared.value.scheduled_date, null)
  assert.equal(cleared.value.time_kind, 'none')
  assert.ok(cleared.changedFields.includes('scheduled_date'))
  assert.ok(cleared.changedFields.includes('time_kind'))
  const renamed = normalizeTaskUpdate({ title: '新标题' }, current)
  assert.equal(renamed.value.title, '新标题')
  assert.equal(renamed.value.scheduled_date, TODAY, '未提供字段沿用 current')
  assert.equal(renamed.changedFields.includes('scheduled_date'), false)
})

test('timeKindOf：三种形态派生', () => {
  assert.equal(timeKindOf({}), 'none')
  assert.equal(timeKindOf({ scheduled_date: TODAY }), 'all_day')
  assert.equal(
    timeKindOf({ scheduled_start_at: '2026-11-13T02:00:00.000Z', scheduled_end_at: '2026-11-13T03:00:00.000Z' }),
    'span',
  )
  assert.equal(timeKindOf({ due_date: TODAY }), 'none')
})

// ---------------------------------------------------------------------------
// M8：repeatRule（重复规则，存储字段 repeat_rule）
// ---------------------------------------------------------------------------

test('normalizeRepeatRule：null/daily/weekly/monthly 归一', () => {
  assert.deepEqual(REPEAT_KINDS, ['daily', 'weekly', 'monthly'])
  assert.deepEqual(normalizeRepeatRule(null), { ok: true, value: null })
  assert.deepEqual(normalizeRepeatRule(undefined), { ok: true, value: null })
  assert.deepEqual(normalizeRepeatRule({ kind: 'daily' }), { ok: true, value: { kind: 'daily' } })
  // 每周：1=周一，去重 + 升序。
  assert.deepEqual(normalizeRepeatRule({ kind: 'weekly', days: [7, 1, 7, 3] }), {
    ok: true,
    value: { kind: 'weekly', days: [1, 3, 7] },
  })
  assert.deepEqual(normalizeRepeatRule({ kind: 'monthly', day: 31 }), { ok: true, value: { kind: 'monthly', day: 31 } })
  // daily 的多余字段被忽略（契约二选一中选择「忽略」）。
  assert.deepEqual(normalizeRepeatRule({ kind: 'daily', days: [1] }).value, { kind: 'daily' })
})

test('normalizeRepeatRule：非法输入返回可读错误', () => {
  const cases = [
    ['weekly'],
    [[]],
    [{ kind: 'yearly' }],
    [{ kind: 'weekly' }],
    [{ kind: 'weekly', days: [] }],
    [{ kind: 'weekly', days: [0] }],
    [{ kind: 'weekly', days: [8] }],
    [{ kind: 'weekly', days: [2.5] }],
    [{ kind: 'monthly' }],
    [{ kind: 'monthly', day: 0 }],
    [{ kind: 'monthly', day: 32 }],
  ]
  for (const [value] of cases) {
    const result = normalizeRepeatRule(value)
    assert.equal(result.ok, false, JSON.stringify(value))
    assert.ok(result.errors[0].includes('repeatRule'), result.errors[0])
  }
})

test('normalizeTaskInput：repeatRule → repeat_rule，null 清除、未提供沿用 current', () => {
  const created = normalizeTaskInput({ title: '重复任务', repeatRule: { kind: 'weekly', days: [5, 2, 2] } })
  assert.equal(created.ok, true)
  assert.deepEqual(created.value.repeat_rule, { kind: 'weekly', days: [2, 5] })

  const current = makeTask('todo', { repeat_rule: { kind: 'daily' } })
  const kept = normalizeTaskUpdate({ title: '改名' }, current)
  assert.equal(kept.ok, true)
  assert.deepEqual(kept.value.repeat_rule, { kind: 'daily' })

  const cleared = normalizeTaskUpdate({ repeatRule: null }, current)
  assert.equal(cleared.ok, true)
  assert.equal(cleared.value.repeat_rule, null)
  assert.ok(cleared.changedFields.includes('repeat_rule'))

  const bad = normalizeTaskUpdate({ repeatRule: { kind: 'monthly', day: 40 } }, current)
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some((line) => line.includes('repeatRule')))
})
