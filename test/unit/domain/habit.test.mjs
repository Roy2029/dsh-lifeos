import test from 'node:test'
import assert from 'node:assert/strict'

import {
  computeCompletionRates,
  computeCoverage,
  computePeriodAchievement,
  computeStreak,
  describeFrequency,
  habitPeriodOf,
  isPlanDay,
  periodKey,
  periodRangeOfKey,
  planDaysBetween,
  validateFrequencyRule,
  weekKeyOf,
  weekStartOf,
  weekdayIndex,
  buildMonthMatrix,
} from '../../../src/domain/habit.js'

const TZ = 'Asia/Shanghai'
const TODAY = '2026-11-14'

function makeHabit(patch = {}) {
  return {
    id: 'hab_test',
    name: '阅读',
    description: null,
    status: 'active',
    frequency_rule: { kind: 'daily', interval: 1 },
    period_rule: null,
    target_json: null,
    checkin_mode: 'manual',
    start_date: '2026-11-01',
    end_date: null,
    paused_at: null,
    resumed_at: null,
    archived_at: null,
    time_hint: null,
    sort_order: 0,
    rev: 1,
    deleted_at: null,
    ...patch,
  }
}

function makeCheckin(date, status = 'done', patch = {}) {
  return {
    id: `hci_${date}`,
    habit_id: 'hab_test',
    local_date: date,
    status,
    checkin_kind: 'manual',
    deleted_at: null,
    rev: 1,
    ...patch,
  }
}

function checkinsOf(entries, habitId = 'hab_test') {
  return entries.map(([date, status]) => makeCheckin(date, status, { habit_id: habitId }))
}

// =====================================================================
// 频率规则校验 / 文案
// =====================================================================

test('validateFrequencyRule 接受四种日计划频率', () => {
  assert.deepEqual(validateFrequencyRule({ kind: 'daily' }), { ok: true, errors: [] })
  assert.deepEqual(validateFrequencyRule({ kind: 'daily', interval: 3 }), { ok: true, errors: [] })
  assert.deepEqual(validateFrequencyRule({ kind: 'weekly_days', days: ['MO', 'WE', 'FR'] }), { ok: true, errors: [] })
  assert.deepEqual(
    validateFrequencyRule({ kind: 'interval', days: 3, anchor_date: '2026-11-05' }),
    { ok: true, errors: [] },
  )
})

test('validateFrequencyRule 接受 weekly_count + period_rule', () => {
  const result = validateFrequencyRule(
    { kind: 'weekly_count', count: 3 },
    { periodRule: { period: 'week', target_count: 3 } },
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
})

test('validateFrequencyRule 拒绝 monthly_count（V1.5）', () => {
  const result = validateFrequencyRule({ kind: 'monthly_count', count: 2 }, { periodRule: { period: 'month', target_count: 2 } })
  assert.equal(result.ok, false)
  assert.match(result.errors[0], /monthly_count/)
})

test('validateFrequencyRule 拒绝缺 period_rule 或 target 不一致的 weekly_count', () => {
  const missing = validateFrequencyRule({ kind: 'weekly_count', count: 3 })
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.some((e) => /period_rule/.test(e)))

  const mismatch = validateFrequencyRule(
    { kind: 'weekly_count', count: 3 },
    { periodRule: { period: 'week', target_count: 2 } },
  )
  assert.equal(mismatch.ok, false)
  assert.ok(mismatch.errors.some((e) => /target_count/.test(e)))
})

test('validateFrequencyRule 拒绝非法天数/星期/锚点', () => {
  assert.equal(validateFrequencyRule(null).ok, false)
  assert.equal(validateFrequencyRule({ kind: 'unknown' }).ok, false)
  assert.equal(validateFrequencyRule({ kind: 'daily', interval: 0 }).ok, false)
  assert.equal(validateFrequencyRule({ kind: 'daily', interval: 1.5 }).ok, false)
  assert.equal(validateFrequencyRule({ kind: 'weekly_days', days: [] }).ok, false)
  assert.equal(validateFrequencyRule({ kind: 'weekly_days', days: ['XX'] }).ok, false)
  assert.equal(validateFrequencyRule({ kind: 'weekly_days', days: ['MO', 'MO'] }).ok, false)
  assert.equal(validateFrequencyRule({ kind: 'interval', days: 0 }).ok, false)
  assert.equal(validateFrequencyRule({ kind: 'interval', days: 2, anchor_date: '2026/11/05' }).ok, false)
  assert.equal(
    validateFrequencyRule({ kind: 'weekly_count', count: 1 }, { periodRule: { period: 'week', target_count: 1, week_start: 'friday' } }).ok,
    false,
  )
})

test('describeFrequency 输出人类可读文案', () => {
  assert.equal(describeFrequency({ kind: 'daily' }), '每天')
  assert.equal(describeFrequency({ kind: 'daily', interval: 2 }), '每 2 天')
  assert.equal(describeFrequency({ kind: 'weekly_days', days: ['MO', 'WE', 'FR'] }), '每周一、三、五')
  assert.equal(describeFrequency({ kind: 'weekly_days', days: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] }), '每天')
  assert.equal(describeFrequency({ kind: 'weekly_count', count: 3 }), '每周 3 次')
  assert.equal(describeFrequency({ kind: 'interval', days: 4 }), '每 4 天')
  assert.equal(describeFrequency(null), '')
})

// =====================================================================
// 周期键 / 计划日
// =====================================================================

test('weekdayIndex / weekStartOf / weekKeyOf 口径', () => {
  assert.equal(weekdayIndex('2026-11-02'), 0)
  assert.equal(weekdayIndex('2026-11-14'), 5)
  assert.equal(weekStartOf('2026-11-14'), '2026-11-09')
  assert.equal(weekStartOf('2026-11-14', 'sunday'), '2026-11-08')
  assert.equal(weekKeyOf('2026-11-14'), '2026-W46')
  assert.equal(weekKeyOf('2026-11-14', 'sunday'), '2026-W46')
  assert.equal(weekKeyOf('2026-11-01'), '2026-W44')
})

test('periodKey 兼容多种冻结调用形态', () => {
  assert.equal(periodKey('monday', '2026-11-14'), '2026-W46')
  assert.equal(periodKey('sunday', '2026-11-14'), '2026-W46')
  assert.equal(periodKey('week', '2026-11-14'), '2026-W46')
  assert.equal(periodKey(undefined, '2026-11-14'), '2026-11')
  assert.equal(periodKey('month', '2026-11-14'), '2026-11')
  assert.equal(periodKey({ period: 'week', week_start: 'sunday' }, '2026-11-14'), '2026-W46')
  assert.equal(periodKey({ period: 'month' }, '2026-11-14'), '2026-11')
  assert.throws(() => periodKey('monday', '2026/11/14'), TypeError)
})

test('periodRangeOfKey 还原区间并拒绝非法键', () => {
  assert.deepEqual(periodRangeOfKey('2026-W46'), {
    period: 'week',
    key: '2026-W46',
    start: '2026-11-09',
    end: '2026-11-15',
  })
  assert.deepEqual(periodRangeOfKey('2026-W46', 'sunday'), {
    period: 'week',
    key: '2026-W46',
    start: '2026-11-08',
    end: '2026-11-14',
  })
  assert.deepEqual(periodRangeOfKey('2026-11'), {
    period: 'month',
    key: '2026-11',
    start: '2026-11-01',
    end: '2026-11-30',
  })
  assert.equal(periodRangeOfKey('2026-W54'), null)
  assert.equal(periodRangeOfKey('2026-13'), null)
  assert.equal(periodRangeOfKey('nope'), null)
})

test('habitPeriodOf 只对周期型习惯返回粒度', () => {
  assert.equal(habitPeriodOf(makeHabit()), null)
  assert.equal(habitPeriodOf(makeHabit({ frequency_rule: { kind: 'weekly_days', days: ['MO'] } })), null)
  assert.equal(habitPeriodOf(makeHabit({ frequency_rule: { kind: 'weekly_count', count: 2 } })), 'week')
  assert.equal(habitPeriodOf(makeHabit({ frequency_rule: { kind: 'monthly_count', count: 2 } })), 'month')
})

test('isPlanDay 按 daily/weekly_days/interval 产生计划日', () => {
  assert.equal(isPlanDay(makeHabit(), '2026-11-01'), true)
  assert.equal(isPlanDay(makeHabit(), '2026-10-31'), false)

  const everyTwo = makeHabit({ frequency_rule: { kind: 'daily', interval: 2 } })
  assert.equal(isPlanDay(everyTwo, '2026-11-01'), true)
  assert.equal(isPlanDay(everyTwo, '2026-11-02'), false)
  assert.equal(isPlanDay(everyTwo, '2026-11-03'), true)

  const weekly = makeHabit({ frequency_rule: { kind: 'weekly_days', days: ['MO', 'WE', 'FR'] } })
  assert.equal(isPlanDay(weekly, '2026-11-02'), true)
  assert.equal(isPlanDay(weekly, '2026-11-03'), false)
  assert.equal(isPlanDay(weekly, '2026-11-06'), true)

  const interval = makeHabit({ frequency_rule: { kind: 'interval', days: 3, anchor_date: '2026-11-05' } })
  assert.equal(isPlanDay(interval, '2026-11-05'), true)
  assert.equal(isPlanDay(interval, '2026-11-08'), true)
  assert.equal(isPlanDay(interval, '2026-11-06'), false)
  assert.equal(isPlanDay(interval, '2026-11-04'), false)

  const monthly = makeHabit({ frequency_rule: { kind: 'weekly_count', count: 2 }, period_rule: { period: 'week', target_count: 2 } })
  assert.equal(isPlanDay(monthly, '2026-11-02'), false)
  assert.equal(planDaysBetween(monthly, '2026-11-01', '2026-11-30').length, 0)
})

test('isPlanDay 尊重 end_date；planDaysBetween 升序且裁剪区间', () => {
  const habit = makeHabit({ start_date: '2026-11-01', end_date: '2026-11-10' })
  assert.equal(isPlanDay(habit, '2026-11-10'), true)
  assert.equal(isPlanDay(habit, '2026-11-11'), false)

  assert.deepEqual(planDaysBetween(makeHabit(), '2026-11-01', '2026-11-07'), [
    '2026-11-01',
    '2026-11-02',
    '2026-11-03',
    '2026-11-04',
    '2026-11-05',
    '2026-11-06',
    '2026-11-07',
  ])
  assert.deepEqual(planDaysBetween(makeHabit(), '2026-11-15', '2026-11-14'), [])
  assert.equal(
    planDaysBetween(makeHabit({ frequency_rule: { kind: 'weekly_days', days: ['MO', 'FR'] } }), '2026-11-02', '2026-11-08').length,
    2,
  )
  assert.deepEqual(
    planDaysBetween(makeHabit({ start_date: '2026-11-01', end_date: '2026-11-03' }), '2026-11-01', '2026-11-30'),
    ['2026-11-01', '2026-11-02', '2026-11-03'],
  )
})

// =====================================================================
// streak
// =====================================================================

test('grace streak 容忍 skipped/unknown，missed/partial 打断', () => {
  const entries = [
    ['2026-11-10', 'done'],
    ['2026-11-11', 'done'],
    ['2026-11-12', 'skipped'],
    ['2026-11-13', 'done'],
    ['2026-11-14', 'done'],
  ]
  const checkins = checkinsOf(entries)
  const grace = computeStreak({ habit: makeHabit(), checkins, asOf: TODAY, mode: 'grace', timeZone: TZ })
  assert.deepEqual(grace, { mode: 'grace', unit: 'day', value: 4, longest: 4, lastCountedUnit: '2026-11-14' })

  const strict = computeStreak({ habit: makeHabit(), checkins, asOf: TODAY, mode: 'strict', timeZone: TZ })
  assert.deepEqual(strict, { mode: 'strict', unit: 'day', value: 2, longest: 2, lastCountedUnit: '2026-11-14' })

  const broken = checkinsOf([
    ['2026-11-10', 'done'],
    ['2026-11-11', 'partial'],
    ['2026-11-12', 'done'],
  ])
  const brokenGrace = computeStreak({ habit: makeHabit(), checkins: broken, asOf: TODAY, mode: 'grace', timeZone: TZ })
  assert.equal(brokenGrace.value, 1)
  assert.equal(brokenGrace.longest, 1)
  assert.equal(brokenGrace.lastCountedUnit, '2026-11-12')
})

test('grace unknown 不打断但也不延长；strict 遇到 unknown 停止', () => {
  const checkins = checkinsOf([
    ['2026-11-10', 'done'],
    ['2026-11-12', 'done'],
  ])
  const grace = computeStreak({ habit: makeHabit(), checkins, asOf: TODAY, mode: 'grace', timeZone: TZ })
  assert.equal(grace.value, 2)
  assert.equal(grace.longest, 2)

  const strict = computeStreak({ habit: makeHabit(), checkins, asOf: TODAY, mode: 'strict', timeZone: TZ })
  assert.equal(strict.value, 0)
  assert.equal(strict.longest, 1)
  assert.equal(strict.lastCountedUnit, '2026-11-12')
})

test('当天未记录视为 pending：不打断也不延长 streak', () => {
  const checkins = checkinsOf([
    ['2026-11-12', 'done'],
    ['2026-11-13', 'done'],
  ])
  const grace = computeStreak({ habit: makeHabit(), checkins, asOf: TODAY, mode: 'grace', timeZone: TZ })
  assert.equal(grace.value, 2)
  assert.equal(grace.lastCountedUnit, '2026-11-13')
  assert.equal(grace.longest, 2)
})

test('paused 区间跳过：暂停日不打断也不计入', () => {
  const habit = makeHabit({
    paused_at: '2026-11-12T02:00:00.000Z',
    resumed_at: '2026-11-14T02:00:00.000Z',
  })
  const checkins = checkinsOf([
    ['2026-11-10', 'done'],
    ['2026-11-11', 'done'],
    ['2026-11-14', 'done'],
  ])
  const grace = computeStreak({ habit, checkins, asOf: TODAY, mode: 'grace', timeZone: TZ })
  assert.equal(grace.value, 3)
  assert.equal(grace.lastCountedUnit, '2026-11-14')
})

test('weekly_count 用周周期计算 streak', () => {
  const habit = makeHabit({
    start_date: '2026-11-02',
    frequency_rule: { kind: 'weekly_count', count: 2 },
    period_rule: { period: 'week', target_count: 2 },
  })
  const checkins = checkinsOf([
    ['2026-11-02', 'done'],
    ['2026-11-03', 'done'],
    ['2026-11-09', 'done'],
    ['2026-11-16', 'done'],
    ['2026-11-17', 'done'],
  ])
  const streak = computeStreak({ habit, checkins, asOf: '2026-11-23', mode: 'grace', timeZone: TZ })
  assert.equal(streak.unit, 'week')
  assert.equal(streak.value, 1)
  assert.equal(streak.longest, 1)
  assert.equal(streak.lastCountedUnit, '2026-W47')
})

// =====================================================================
// coverage / 完成率 / 周期达标
// =====================================================================

test('computeCoverage 统计计划日记录与 unknown', () => {
  const checkins = checkinsOf([
    ['2026-11-01', 'done'],
    ['2026-11-02', 'done'],
    ['2026-11-04', 'skipped'],
    ['2026-11-05', 'done'],
  ])
  const coverage = computeCoverage({
    habit: makeHabit(),
    checkins,
    from: '2026-11-01',
    to: '2026-11-10',
    asOf: TODAY,
    timeZone: TZ,
  })
  assert.deepEqual(coverage, { recorded: 4, expected: 10, ratio: 0.4, unknownDays: 6, windowDays: 10 })
})

test('computeCoverage 暂停日不计入分母', () => {
  const habit = makeHabit({
    paused_at: '2026-11-03T02:00:00.000Z',
    resumed_at: '2026-11-05T02:00:00.000Z',
  })
  const coverage = computeCoverage({
    habit,
    checkins: checkinsOf([['2026-11-01', 'done']]),
    from: '2026-11-01',
    to: '2026-11-08',
    asOf: TODAY,
    timeZone: TZ,
  })
  assert.equal(coverage.expected, 6)
  assert.equal(coverage.recorded, 1)
  assert.equal(coverage.windowDays, 8)
})

test('computeCoverage 周频习惯按已结束周期计数', () => {
  const habit = makeHabit({
    frequency_rule: { kind: 'weekly_count', count: 2 },
    period_rule: { period: 'week', target_count: 2 },
  })
  const checkins = checkinsOf([
    ['2026-11-03', 'done'],
    ['2026-11-10', 'done'],
  ])
  const coverage = computeCoverage({
    habit,
    checkins,
    from: '2026-11-01',
    to: '2026-11-30',
    asOf: '2026-12-01',
    timeZone: TZ,
  })
  assert.equal(coverage.expected, 4)
  assert.equal(coverage.recorded, 2)
  assert.equal(coverage.unknownDays, 2)
  assert.equal(coverage.windowDays, 30)
})

test('computeCoverage 归档后不再产生预期', () => {
  const habit = makeHabit({ status: 'archived', archived_at: '2026-11-06T02:00:00.000Z' })
  const coverage = computeCoverage({
    habit,
    checkins: [],
    from: '2026-11-01',
    to: '2026-11-14',
    asOf: TODAY,
    timeZone: TZ,
  })
  assert.equal(coverage.expected, 5)
})

test('computeCompletionRates 三口径', () => {
  const checkins = checkinsOf([
    ['2026-11-01', 'done'],
    ['2026-11-02', 'done'],
    ['2026-11-03', 'not_done'],
    ['2026-11-04', 'partial'],
    ['2026-11-05', 'skipped'],
  ])
  const rates = computeCompletionRates({
    habit: makeHabit(),
    checkins,
    from: '2026-11-01',
    to: '2026-11-07',
    asOf: TODAY,
    timeZone: TZ,
  })
  assert.deepEqual(rates, { strict: 0.286, recorded: 0.571, period: null })

  const withPeriodRule = makeHabit({ period_rule: { period: 'week', target_count: 3 } })
  const periodRates = computeCompletionRates({
    habit: withPeriodRule,
    checkins,
    from: '2026-11-01',
    to: '2026-11-07',
    asOf: TODAY,
    timeZone: TZ,
  })
  assert.equal(periodRates.period, 0)
})

test('computePeriodAchievement 支持计划日目标与 period_rule 目标', () => {
  const checkins = checkinsOf([
    ['2026-11-02', 'done'],
    ['2026-11-03', 'done'],
    ['2026-11-04', 'done'],
    ['2026-11-05', 'done'],
  ])
  const byPlanDays = computePeriodAchievement({
    habit: makeHabit(),
    checkins,
    periodKey: '2026-W45',
    weekStart: 'monday',
  })
  assert.deepEqual(byPlanDays, {
    period: 'week',
    key: '2026-W45',
    start: '2026-11-02',
    end: '2026-11-08',
    target: 7,
    achieved: 4,
    met: false,
  })

  const byRule = computePeriodAchievement({
    habit: makeHabit({ period_rule: { period: 'week', target_count: 3 } }),
    checkins,
    periodKey: '2026-W45',
    weekStart: 'monday',
  })
  assert.equal(byRule.target, 3)
  assert.equal(byRule.met, true)

  const weeklyCount = computePeriodAchievement({
    habit: makeHabit({
      frequency_rule: { kind: 'weekly_count', count: 4 },
      period_rule: { period: 'week', target_count: 4 },
    }),
    checkins,
    periodKey: '2026-W45',
    weekStart: 'monday',
  })
  assert.equal(weeklyCount.target, 4)
  assert.equal(weeklyCount.achieved, 4)
  assert.equal(weeklyCount.met, true)
})

// =====================================================================
// 月矩阵
// =====================================================================

test('buildMonthMatrix 输出行/格状态与今天标记', () => {
  const habit = makeHabit()
  const checkins = [
    makeCheckin('2026-11-10', 'skipped'),
    makeCheckin('2026-11-12', 'done'),
    makeCheckin('2026-11-13', 'partial'),
  ]
  const matrix = buildMonthMatrix({
    habits: [habit],
    checkins,
    month: '2026-11',
    todayLocal: TODAY,
    timeZone: TZ,
  })
  assert.equal(matrix.month, '2026-11')
  assert.equal(matrix.days.length, 30)
  assert.equal(matrix.today, TODAY)
  assert.equal(matrix.week_start, 'monday')
  assert.equal(matrix.rows.length, 1)
  const row = matrix.rows[0]
  assert.equal(row.habitId, 'hab_test')
  assert.equal(row.frequency_text, '每天')
  const byDate = new Map(row.cells.map((cell) => [cell.date, cell]))
  assert.equal(byDate.get('2026-10-31'), undefined)
  assert.equal(byDate.get('2026-11-01').status, 'unknown')
  assert.equal(byDate.get('2026-11-09').status, 'unknown')
  assert.equal(byDate.get('2026-11-10').status, 'skipped')
  assert.equal(byDate.get('2026-11-12').status, 'done')
  assert.equal(byDate.get('2026-11-12').checkin_id, 'hci_2026-11-12')
  assert.equal(byDate.get('2026-11-13').status, 'partial')
  assert.equal(byDate.get('2026-11-14').is_today, true)
  assert.equal(byDate.get('2026-11-14').status, 'unknown')
  assert.equal(byDate.get('2026-11-15').status, null)
})

test('buildMonthMatrix 暂停/归档/未来格', () => {
  const paused = makeHabit({
    id: 'hab_paused',
    paused_at: '2026-11-05T02:00:00.000Z',
    resumed_at: '2026-11-08T02:00:00.000Z',
  })
  const archived = makeHabit({
    id: 'hab_archived',
    status: 'archived',
    archived_at: '2026-11-06T02:00:00.000Z',
  })
  const matrix = buildMonthMatrix({
    habits: [paused, archived],
    checkins: [],
    month: '2026-11',
    todayLocal: TODAY,
    timeZone: TZ,
  })
  const pausedRow = matrix.rows.find((row) => row.habitId === 'hab_paused')
  const pausedCells = new Map(pausedRow.cells.map((cell) => [cell.date, cell.status]))
  assert.equal(pausedCells.get('2026-11-05'), 'paused')
  assert.equal(pausedCells.get('2026-11-06'), 'paused')
  assert.equal(pausedCells.get('2026-11-07'), 'paused')
  assert.equal(pausedCells.get('2026-11-08'), 'unknown')
  assert.equal(pausedCells.get('2026-11-15'), null)

  const archivedRow = matrix.rows.find((row) => row.habitId === 'hab_archived')
  const archivedCells = new Map(archivedRow.cells.map((cell) => [cell.date, cell.status]))
  assert.equal(archivedCells.get('2026-11-05'), 'unknown')
  assert.equal(archivedCells.get('2026-11-06'), null)
  assert.equal(archivedCells.get('2026-11-10'), null)
})
