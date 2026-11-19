import test from 'node:test'
import assert from 'node:assert/strict'

import { buildReviewSummary, resolveReviewRange } from '../../../src/domain/review.js'

const TZ = 'Asia/Shanghai'
const ANCHOR = '2026-11-14'

function makeTask(patch = {}) {
  return {
    id: 'tsk_x',
    title: '任务',
    status: 'todo',
    created_at: '2026-10-01T02:00:00.000Z',
    updated_at: '2026-10-01T02:00:00.000Z',
    completed_at: null,
    deleted_at: null,
    archived_at: null,
    due_date: null,
    due_at: null,
    ...patch,
  }
}

function makeStats(patch = {}) {
  return {
    habitId: 'hab_one',
    name: '阅读',
    period: { key: '2026-W46', period: 'week', target: 3, achieved: 2, met: true },
    coverage: { recorded: 8, expected: 10 },
    ...patch,
  }
}

// =====================================================================
// resolveReviewRange
// =====================================================================

test('resolveReviewRange 周区间按 weekStart 对齐', () => {
  assert.deepEqual(resolveReviewRange('week', ANCHOR, 'monday', TZ), {
    period: 'week',
    anchor: ANCHOR,
    range: { start: '2026-11-09', end: '2026-11-15', label: '2026-11-09 ~ 2026-11-15' },
  })
  assert.deepEqual(resolveReviewRange('week', ANCHOR, 'sunday', TZ).range, {
    start: '2026-11-08',
    end: '2026-11-14',
    label: '2026-11-08 ~ 2026-11-14',
  })
})

test('resolveReviewRange 月区间为自然月', () => {
  assert.deepEqual(resolveReviewRange('month', ANCHOR, 'monday', TZ), {
    period: 'month',
    anchor: ANCHOR,
    range: { start: '2026-11-01', end: '2026-11-30', label: '2026-11-01 ~ 2026-11-30' },
  })
  assert.equal(resolveReviewRange('month', '2026-02-10', 'monday', TZ).range.end, '2026-02-28')
  assert.equal(resolveReviewRange('unknown', ANCHOR, 'monday', TZ).period, 'week')
})

// =====================================================================
// 任务卡片
// =====================================================================

test('buildReviewSummary 周回顾统计任务卡片', () => {
  const tasks = [
    makeTask({
      id: 'tsk_done_in_period',
      status: 'done',
      completed_at: '2026-11-12T03:00:00.000Z', // 北京 11-12 11:00
    }),
    makeTask({
      id: 'tsk_open_overdue',
      status: 'todo',
      due_date: '2026-11-10',
      created_at: '2026-11-10T02:00:00.000Z',
    }),
    makeTask({
      id: 'tsk_doing_not_due',
      status: 'doing',
      due_at: '2026-11-16T00:00:00.000Z', // 北京 11-16 08:00，未过期
      created_at: '2026-11-13T02:00:00.000Z',
    }),
    makeTask({ id: 'tsk_done_outside', status: 'done', completed_at: '2026-10-20T02:00:00.000Z' }),
    makeTask({ id: 'tsk_cancelled', status: 'cancelled', due_date: '2026-11-01' }),
    makeTask({ id: 'tsk_archived', status: 'todo', archived_at: '2026-11-02T02:00:00.000Z' }),
    makeTask({ id: 'tsk_deleted', status: 'todo', deleted_at: '2026-11-02T02:00:00.000Z' }),
  ]
  const summary = buildReviewSummary({ period: 'week', anchorLocalDate: ANCHOR, timeZone: TZ, tasks })
  assert.deepEqual(summary.cards, {
    completed: 1,
    created: 2,
    open: 2,
    overdue: 1,
    habits_met: 0,
    habits_tracked: 0,
    inbox_pending: 0,
    inbox_to_confirm: 0,
  })
  assert.deepEqual(summary.range, { start: '2026-11-09', end: '2026-11-15', label: '2026-11-09 ~ 2026-11-15' })
  assert.deepEqual(summary.habits, [])
  assert.deepEqual(summary.projects, [])
})

test('buildReviewSummary 月回顾统计整月任务', () => {
  const tasks = [
    makeTask({ status: 'done', completed_at: '2026-11-01T02:00:00.000Z' }),
    makeTask({ status: 'done', completed_at: '2026-11-30T12:00:00.000Z' }), // 北京 11-30 20:00
    makeTask({ status: 'done', completed_at: '2026-10-31T20:00:00.000Z' }), // 北京 11-01 04:00！应计入
    makeTask({ status: 'done', completed_at: '2026-12-01T02:00:00.000Z' }),
  ]
  const summary = buildReviewSummary({ period: 'month', anchorLocalDate: ANCHOR, timeZone: TZ, tasks })
  assert.equal(summary.period, 'month')
  assert.equal(summary.cards.completed, 3)
})

// =====================================================================
// 习惯卡片
// =====================================================================

test('buildReviewSummary 习惯卡片取 period/coverage 并统计达标', () => {
  const habits = [{ id: 'hab_one', name: '阅读', deleted_at: null }]
  const habitStats = [makeStats()]
  const summary = buildReviewSummary({
    period: 'week',
    anchorLocalDate: ANCHOR,
    timeZone: TZ,
    habits,
    habitStats,
  })
  assert.equal(summary.cards.habits_met, 1)
  assert.equal(summary.cards.habits_tracked, 1)
  assert.deepEqual(summary.habits, [
    {
      habitId: 'hab_one',
      name: '阅读',
      target: 3,
      achieved: 2,
      met: true,
      coverage: { recorded: 8, expected: 10 },
    },
  ])
})

test('buildReviewSummary 用周期历史统计区间内达标数', () => {
  const habitStats = [
    {
      habitId: 'hab_one',
      name: '阅读',
      periods: [
        { key: '2026-W44', start: '2026-10-26', met: true }, // 区间外
        { key: '2026-W46', start: '2026-11-09', met: true }, // 区间内
        { key: '2026-W47', start: '2026-11-16', met: false }, // 区间外
      ],
      coverage: { recorded: 5, expected: 7 },
    },
  ]
  const summary = buildReviewSummary({ period: 'week', anchorLocalDate: ANCHOR, timeZone: TZ, habitStats })
  assert.equal(summary.cards.habits_met, 1)
  assert.equal(summary.habits[0].met, false)
  assert.equal(summary.habits[0].achieved, 0)
  assert.equal(summary.habits[0].target, null)
})

test('buildReviewSummary 无 habitStats 时降级为习惯列表', () => {
  const summary = buildReviewSummary({
    period: 'week',
    anchorLocalDate: ANCHOR,
    timeZone: TZ,
    habits: [{ id: 'hab_one', name: '阅读' }, { id: 'hab_two', name: '跑步' }],
  })
  assert.equal(summary.cards.habits_tracked, 2)
  assert.equal(summary.cards.habits_met, 0)
  assert.deepEqual(
    summary.habits.map((item) => item.habitId),
    ['hab_one', 'hab_two'],
  )
  assert.deepEqual(summary.habits[0].coverage, { recorded: 0, expected: 0 })
})

// =====================================================================
// 收件箱 / 项目
// =====================================================================

test('buildReviewSummary 透传 inbox 计数并兼容多种键名', () => {
  const snake = buildReviewSummary({
    period: 'week',
    anchorLocalDate: ANCHOR,
    timeZone: TZ,
    inboxCounts: { inbox_pending: 3, inbox_to_confirm: 2 },
  })
  assert.equal(snake.cards.inbox_pending, 3)
  assert.equal(snake.cards.inbox_to_confirm, 2)

  const camel = buildReviewSummary({
    period: 'week',
    anchorLocalDate: ANCHOR,
    timeZone: TZ,
    inboxCounts: { pending: 1, toConfirm: 4 },
  })
  assert.equal(camel.cards.inbox_pending, 1)
  assert.equal(camel.cards.inbox_to_confirm, 4)
})

test('buildReviewSummary 项目卡片读取 progress 或 done/total', () => {
  const asArray = buildReviewSummary({
    period: 'week',
    anchorLocalDate: ANCHOR,
    timeZone: TZ,
    projectStats: [
      { id: 'prj_a', name: 'A 项目', progress: { done: 5, total: 12 } },
      { projectId: 'prj_b', name: 'B 项目', done: 2, total: 4 },
      { project_id: 'prj_c', name: 'C 项目', progress: { done: null, total: null } },
    ],
  })
  assert.deepEqual(asArray.projects, [
    { id: 'prj_a', name: 'A 项目', done: 5, total: 12 },
    { id: 'prj_b', name: 'B 项目', done: 2, total: 4 },
    { id: 'prj_c', name: 'C 项目', done: null, total: null },
  ])

  const asObject = buildReviewSummary({
    period: 'week',
    anchorLocalDate: ANCHOR,
    timeZone: TZ,
    projectStats: { prj_a: { id: 'prj_a', name: 'A 项目', progress: { done: 1, total: 3 } } },
  })
  assert.deepEqual(asObject.projects, [{ id: 'prj_a', name: 'A 项目', done: 1, total: 3 }])
})

// =====================================================================
// 空输入 / 默认值
// =====================================================================

test('buildReviewSummary 空输入安全且卡片归零', () => {
  const summary = buildReviewSummary({})
  assert.equal(summary.period, 'week')
  assert.match(summary.anchor, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(summary.range.start, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(summary.range.end, /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual(summary.cards, {
    completed: 0,
    created: 0,
    open: 0,
    overdue: 0,
    habits_met: 0,
    habits_tracked: 0,
    inbox_pending: 0,
    inbox_to_confirm: 0,
  })
  assert.deepEqual(summary.habits, [])
  assert.deepEqual(summary.projects, [])
  assert.equal(buildReviewSummary(null).cards.completed, 0)
})
