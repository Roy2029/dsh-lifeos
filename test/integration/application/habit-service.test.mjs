import test from 'node:test'
import assert from 'node:assert/strict'

import { openLifeosStore } from '../../../src/store/lifeos-store.js'
import { createHabitOps } from '../../../src/application/habit-service.js'
import { createFakeBackend } from '../../unit/store/fake-backend.mjs'
import { addDays, nowIso } from '../../../src/domain/time.js'
import { newId } from '../../../src/domain/ids.js'
import { validateRecord } from '../../../src/domain/schemas.js'

const TZ = 'Asia/Shanghai'
const BASE_MS = Date.parse('2026-11-14T05:00:00.000Z') // 北京时间 2026-11-14 13:00
const TODAY = '2026-11-14'

async function setup(t, deps = {}) {
  const { backend } = createFakeBackend()
  const store = await openLifeosStore(null, {
    backend,
    testMode: true,
    seed: true,
    timeZone: TZ,
    now: () => '2026-11-14T05:00:00.000Z',
  })
  t.after(async () => {
    await store.close()
  })
  const events = []
  const ops = createHabitOps({
    store,
    now: () => BASE_MS,
    timeZone: TZ,
    emitChanged: (kind, ids, extra) => events.push({ kind, ids, extra }),
    ...deps,
  })
  return { store, ops, events }
}

async function expectCode(fn, code) {
  await assert.rejects(
    async () => fn(),
    (error) => {
      assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}: ${error.message}`)
      return true
    },
  )
}

function logRows(store, table) {
  return store.entries('lifeos_log', table).map(([, record]) => record)
}

function recordRows(store, table) {
  return store.entries('lifeos', table).map(([, record]) => record)
}

/** 真实 normalizeRecord + validateRecord 口径校验（store.transaction 已校验，这里显式再断言一遍）。 */
function assertAllWritesValid(store) {
  for (const table of ['habit', 'habit_checkin', 'project', 'goal', 'wish', 'entity_link']) {
    for (const record of recordRows(store, table)) {
      const result = validateRecord(table, record)
      assert.equal(result.ok, true, `${table} 记录非法：${result.errors.join('; ')}`)
    }
  }
  for (const table of ['operation_log', 'state_change']) {
    for (const record of logRows(store, table)) {
      const result = validateRecord(table, record)
      assert.equal(result.ok, true, `${table} 记录非法：${result.errors.join('; ')}`)
    }
  }
}

function makeDailyHabit(ops, patch = {}) {
  return ops.createHabit({
    name: '阅读',
    frequency_rule: { kind: 'daily', interval: 1 },
    start_date: '2026-11-01',
    time_hint: '睡前',
    ...patch,
  })
}

// =====================================================================
// 创建 / 列表 / 详情
// =====================================================================

test('createHabit 返回 view 并写入合法记录 + oplog', async (t) => {
  const { store, ops, events } = await setup(t)
  const created = await ops.createHabit({
    name: '阅读',
    description: '每天读书 20 页',
    frequency_rule: { kind: 'daily', interval: 1 },
    start_date: '2026-11-01',
    time_hint: '睡前',
  })

  assert.equal(created.revision, 1)
  const habit = created.habit
  assert.equal(habit.name, '阅读')
  assert.equal(habit.description, '每天读书 20 页')
  assert.equal(habit.status, 'active')
  assert.equal(habit.checkin_mode, 'manual')
  assert.equal(habit.start_date, '2026-11-01')
  assert.equal(habit.frequency_text, '每天')
  assert.equal(habit.today_status, 'pending')
  assert.equal(habit.today_checkin_id, null)
  assert.equal(habit.rev, 1)
  assert.match(habit.id, /^hab_/)
  assert.match(habit.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

  const list = ops.listHabits({})
  assert.equal(list.today, TODAY)
  assert.equal(list.items.length, 1)
  assert.equal(list.items[0].id, habit.id)

  const detail = ops.getHabit(habit.id)
  assert.equal(detail.habit.id, habit.id)
  assert.deepEqual(detail.checkins, [])

  const oplogs = logRows(store, 'operation_log')
  assert.equal(oplogs.length, 1)
  assert.equal(oplogs[0].action, 'habit.create')
  assert.equal(oplogs[0].permission_level, 'L2')
  assert.equal(oplogs[0].occurred_at, '2026-11-14T05:00:00.000Z')
  assert.equal(oplogs[0].status, 'applied')
  assert.deepEqual(events.map((event) => event.kind), ['habit'])
  assertAllWritesValid(store)
})

test('createHabit 缺省 start_date=今天、支持 weekly_count 频率', async (t) => {
  const { ops } = await setup(t)
  const created = await ops.createHabit({
    name: '跑步',
    frequency_rule: { kind: 'weekly_count', count: 3 },
    period_rule: { period: 'week', target_count: 3 },
  })
  assert.equal(created.habit.start_date, TODAY)
  assert.equal(created.habit.frequency_text, '每周 3 次')

  const detail = ops.getHabit(created.habit.id)
  assert.equal(detail.habit.period_rule.target_count, 3)
})

test('createHabit 拒绝非法频率/名称/日期', async (t) => {
  const { ops } = await setup(t)
  await expectCode(() => ops.createHabit({ name: '' }), 'validation_failed')
  await expectCode(
    () => ops.createHabit({ name: '月度', frequency_rule: { kind: 'monthly_count', count: 1 } }),
    'validation_failed',
  )
  await expectCode(
    () => ops.createHabit({ name: '周频', frequency_rule: { kind: 'weekly_count', count: 3 } }),
    'validation_failed',
  )
  await expectCode(
    () =>
      ops.createHabit({
        name: '周频',
        frequency_rule: { kind: 'weekly_count', count: 3 },
        period_rule: { period: 'week', target_count: 2 },
      }),
    'validation_failed',
  )
  await expectCode(
    () => ops.createHabit({ name: '坏日期', start_date: '2026/11/01' }),
    'validation_failed',
  )
  await expectCode(
    () =>
      ops.createHabit({
        name: '倒序区间',
        frequency_rule: { kind: 'daily', interval: 1 },
        start_date: '2026-11-10',
        end_date: '2026-11-01',
      }),
    'validation_failed',
  )
})

// =====================================================================
// 打卡 / 幂等 / 合并 / 撤销
// =====================================================================

test('checkin 当天打卡、幂等、合并更新与 oplog', async (t) => {
  const { store, ops, events } = await setup(t)
  const { habit } = await makeDailyHabit(ops)
  const first = await ops.checkin({ habitId: habit.id })
  assert.equal(first.merged, false)
  assert.equal(first.revision, 1)
  assert.equal(first.checkin.local_date, TODAY)
  assert.equal(first.checkin.status, 'done')
  assert.equal(first.checkin.checkin_kind, 'manual')
  assert.equal(first.checkin.backfilled_at, null)
  assert.match(first.checkin.id, /^hci_/)

  const oplogCount = logRows(store, 'operation_log').length
  const stateCount = logRows(store, 'state_change').length
  const again = await ops.checkin({ habitId: habit.id })
  assert.equal(again.merged, false)
  assert.equal(again.revision, 1)
  assert.equal(logRows(store, 'operation_log').length, oplogCount)
  assert.equal(logRows(store, 'state_change').length, stateCount)

  const merged = await ops.checkin({ habitId: habit.id, status: 'partial', note: '只读了 10 页' })
  assert.equal(merged.merged, true)
  assert.equal(merged.revision, 2)
  assert.equal(merged.checkin.status, 'partial')
  assert.equal(merged.checkin.note, '只读了 10 页')

  const stored = recordRows(store, 'habit_checkin')
  assert.equal(stored.length, 1)
  assert.equal(stored[0].rev, 2)

  const view = ops.listHabits({}).items[0]
  assert.equal(view.today_status, 'partial')
  assert.equal(view.today_checkin_id, merged.checkin.id)

  const checkinLogs = logRows(store, 'operation_log').filter((row) => row.action === 'habit.checkin')
  assert.equal(checkinLogs.length, 2)
  assert.equal(checkinLogs[1].permission_level, 'L2')
  assert.equal(checkinLogs[1].target_type, 'habit_checkin')
  assert.equal(checkinLogs[1].actor_type, 'user')
  assert.match(checkinLogs[1].occurred_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

  const todayStatuses = events.filter((event) => event.kind === 'habit_checkin')
  assert.equal(todayStatuses.length, 2)
  assertAllWritesValid(store)
})

test('checkin 日期边界：未来/早于开始日/补记窗口', async (t) => {
  const { ops } = await setup(t)
  const { habit } = await makeDailyHabit(ops)

  await expectCode(() => ops.checkin({ habitId: habit.id, localDate: '2026-11-15' }), 'validation_failed')
  await expectCode(() => ops.checkin({ habitId: habit.id, localDate: '2026-10-31', retro: true }), 'validation_failed')
  await expectCode(() => ops.checkin({ habitId: habit.id, localDate: '2026-11-13' }), 'validation_failed')
  await expectCode(
    () => ops.checkin({ habitId: habit.id, localDate: '2026-11-06', retro: true }),
    'validation_failed',
  )

  const retro = await ops.checkin({ habitId: habit.id, localDate: '2026-11-07', retro: true, status: 'done' })
  assert.equal(retro.checkin.checkin_kind, 'retro')
  assert.equal(retro.checkin.backfilled_at, '2026-11-14T05:00:00.000Z')

  const yesterday = await ops.checkin({ habitId: habit.id, localDate: '2026-11-13', retro: true })
  assert.equal(yesterday.checkin.checkin_kind, 'retro')
})

test('uncheck 软删、CAS、恢复同一行', async (t) => {
  const { store, ops, events } = await setup(t)
  const { habit } = await makeDailyHabit(ops)
  await ops.checkin({ habitId: habit.id, localDate: '2026-11-13', retro: true })

  const unchecked = await ops.uncheck({ habitId: habit.id, localDate: '2026-11-13' })
  assert.equal(unchecked.ok, true)
  assert.equal(unchecked.revision, 2)
  const deleted = recordRows(store, 'habit_checkin')[0]
  assert.notEqual(deleted.deleted_at, null)
  assert.equal(ops.listCheckins({ habitId: habit.id, from: '2026-11-01', to: TODAY }).items.length, 0)

  await expectCode(() => ops.uncheck({ habitId: habit.id, localDate: '2026-11-13' }), 'not_found')
  await expectCode(() => ops.uncheck({ habitId: habit.id, localDate: '2026-11-12' }), 'not_found')

  const restored = await ops.checkin({ habitId: habit.id, localDate: '2026-11-13', retro: true, status: 'done' })
  assert.equal(restored.merged, false)
  assert.equal(restored.revision, 3)
  assert.equal(recordRows(store, 'habit_checkin').length, 1)
  assert.equal(restored.checkin.id, deleted.id)

  const recheck = await ops.checkin({ habitId: habit.id, localDate: '2026-11-13', retro: true, status: 'done' })
  assert.equal(recheck.merged, false)

  const checkinId = restored.checkin.id
  const casHabit = await makeDailyHabit(ops, { name: '跑步' })
  await ops.checkin({ habitId: casHabit.habit.id })
  await assert.rejects(
    async () => ops.uncheck({ habitId: casHabit.habit.id, localDate: TODAY, expectedRev: 9 }),
    (error) => {
      assert.equal(error.code, 'conflict')
      assert.equal(error.details.currentRev, 1)
      assert.equal(error.details.expectedRev, 9)
      return true
    },
  )
  assert.ok(checkinId)
  assert.equal(events.filter((event) => event.kind === 'habit').length >= 2, true)
})

// =====================================================================
// 暂停 / 归档拒绝新打卡
// =====================================================================

test('暂停与恢复：写 paused_at/resumed_at 并拒绝打卡', async (t) => {
  const { store, ops } = await setup(t)
  const { habit } = await makeDailyHabit(ops)

  const paused = await ops.updateHabit(habit.id, { status: 'paused' }, { expectedRev: 1 })
  assert.equal(paused.revision, 2)
  assert.equal(paused.habit.status, 'paused')
  assert.notEqual(paused.habit.paused_at, null)
  await expectCode(() => ops.checkin({ habitId: habit.id }), 'invalid_state')

  const resumed = await ops.updateHabit(habit.id, { status: 'active' }, { expectedRev: 2 })
  assert.equal(resumed.revision, 3)
  assert.equal(resumed.habit.status, 'active')
  assert.notEqual(resumed.habit.resumed_at, null)
  const ok = await ops.checkin({ habitId: habit.id })
  assert.equal(ok.checkin.status, 'done')
  assertAllWritesValid(store)
})

test('归档后拒绝打卡且不可恢复', async (t) => {
  const { store, ops } = await setup(t)
  const { habit } = await makeDailyHabit(ops)

  const archived = await ops.archiveHabit(habit.id, { expectedRev: 1 })
  assert.equal(archived.revision, 2)
  assert.equal(archived.habit.status, 'archived')
  assert.notEqual(archived.habit.archived_at, null)
  await expectCode(() => ops.checkin({ habitId: habit.id }), 'invalid_state')
  await expectCode(
    () => ops.updateHabit(habit.id, { status: 'active' }, { expectedRev: 2 }),
    'invalid_state',
  )

  assert.equal(ops.listHabits({}).items.length, 0)
  assert.equal(ops.listHabits({ includeArchived: true }).items.length, 1)
  assert.equal(ops.getStats({}).habits.length, 0)
  assert.equal(ops.getStats({ habitIds: [habit.id] }).habits.length, 1)
  assertAllWritesValid(store)
})

// =====================================================================
// 更新 / CAS
// =====================================================================

test('updateHabit CAS 与 diff', async (t) => {
  const { ops } = await setup(t)
  const { habit } = await makeDailyHabit(ops)

  await expectCode(() => ops.updateHabit(habit.id, { name: '新名字' }), 'validation_failed')

  const updated = await ops.updateHabit(
    habit.id,
    { name: '深度阅读', time_hint: '晨间', description: '45 分钟' },
    { expectedRev: 1 },
  )
  assert.equal(updated.revision, 2)
  assert.equal(updated.habit.name, '深度阅读')
  assert.equal(updated.habit.time_hint, '晨间')
  assert.ok(Array.isArray(updated.diff))
  const fields = updated.diff.map((entry) => entry.field)
  assert.ok(fields.includes('name'))
  assert.ok(fields.includes('time_hint'))
  assert.ok(fields.includes('description'))
  assert.equal(updated.diff.find((entry) => entry.field === 'name').newValue, '深度阅读')

  await assert.rejects(
    async () => ops.updateHabit(habit.id, { name: '再次改名' }, { expectedRev: 1 }),
    (error) => {
      assert.equal(error.code, 'conflict')
      assert.equal(error.details.currentRev, 2)
      assert.equal(error.details.expectedRev, 1)
      assert.equal(error.details.current.name, '深度阅读')
      return true
    },
  )

  await assert.rejects(
    async () => ops.updateHabit('hab_missing', { name: 'x' }, { expectedRev: 1 }),
    (error) => {
      assert.equal(error.code, 'not_found')
      return true
    },
  )
})

// =====================================================================
// 统计 / 月矩阵 / 今日
// =====================================================================

test('getStats 返回 streak/coverage/period/today', async (t) => {
  const { ops } = await setup(t)
  const { habit } = await makeDailyHabit(ops)
  await ops.checkin({ habitId: habit.id, localDate: '2026-11-10', retro: true, status: 'done' })
  await ops.checkin({ habitId: habit.id, localDate: '2026-11-11', retro: true, status: 'skipped' })
  await ops.checkin({ habitId: habit.id, localDate: '2026-11-12', retro: true, status: 'done' })
  await ops.checkin({ habitId: habit.id, status: 'partial', note: '读了一半' })

  const grace = ops.getStats({ from: '2026-11-01', to: TODAY })
  assert.deepEqual(grace.range, { from: '2026-11-01', to: TODAY })
  assert.equal(grace.today, TODAY)
  assert.equal(grace.habits.length, 1)
  const item = grace.habits[0]
  assert.equal(item.habitId, habit.id)
  assert.equal(item.frequency_text, '每天')
  assert.equal(item.streak.mode, 'grace')
  assert.equal(item.streak.unit, 'day')
  assert.equal(item.streak.value, 0) // 今天 partial 视为未达成，清零；11-10 与 11-12 之间 skipped 容忍
  assert.equal(item.streak.longest, 2)
  assert.equal(item.streak.lastCountedUnit, '2026-11-12')
  assert.deepEqual(item.coverage, {
    recorded: 4,
    expected: 14,
    ratio: 0.286,
    unknownDays: 10,
    windowDays: 14,
  })
  assert.equal(item.period.key, '2026-W46')
  assert.equal(item.period.period, 'week')
  assert.equal(item.period.target, 7)
  assert.equal(item.period.achieved, 2)
  assert.equal(item.period.met, false)
  assert.equal(item.today.status, 'partial')

  const strict = ops.getStats({ from: '2026-11-01', to: TODAY, mode: 'strict' }).habits[0]
  assert.equal(strict.streak.mode, 'strict')
  assert.equal(strict.streak.value, 0) // 今天 partial 清零，且 11-11 skipped / 11-13 unknown 均打断
  assert.equal(strict.streak.longest, 1)
  assert.equal(strict.streak.lastCountedUnit, '2026-11-12')
})

test('getStats 默认窗口近 14 天且过滤 habitIds', async (t) => {
  const { ops } = await setup(t)
  const a = await makeDailyHabit(ops, { name: 'A' })
  const b = await makeDailyHabit(ops, { name: 'B' })

  const stats = ops.getStats({})
  assert.deepEqual(stats.range, { from: '2026-11-01', to: TODAY })
  assert.equal(stats.habits.length, 2)

  const onlyB = ops.getStats({ habitIds: [b.habit.id] })
  assert.equal(onlyB.habits.length, 1)
  assert.equal(onlyB.habits[0].habitId, b.habit.id)
  assert.ok(a.habit.id)
})

test('getMonth 输出月矩阵，支持 weekStart 配置与归档过滤', async (t) => {
  const { store, ops } = await setup(t)
  const { habit } = await makeDailyHabit(ops)
  await ops.checkin({ habitId: habit.id, localDate: '2026-11-10', retro: true, status: 'skipped' })
  await ops.checkin({ habitId: habit.id, localDate: '2026-11-12', retro: true, status: 'done' })
  await ops.checkin({ habitId: habit.id, status: 'partial' })

  const matrix = ops.getMonth({ month: '2026-11' })
  assert.equal(matrix.month, '2026-11')
  assert.equal(matrix.rows.length, 1)
  const cells = new Map(matrix.rows[0].cells.map((cell) => [cell.date, cell]))
  assert.equal(cells.get('2026-11-09').status, 'unknown')
  assert.equal(cells.get('2026-11-10').status, 'skipped')
  assert.equal(cells.get('2026-11-12').status, 'done')
  assert.equal(cells.get('2026-11-14').status, 'partial')
  assert.equal(cells.get('2026-11-14').is_today, true)
  assert.equal(cells.get('2026-11-15').status, null)
  assert.equal(matrix.week_start, 'monday')

  // app_setting 覆盖 week_start
  await store.put('lifeos', 'app_setting', 'week_start', {
    key: 'week_start',
    id: 'week_start',
    value_json: 'sunday',
    updated_at: nowIso(),
    schema_version: 1,
  })
  const sundayOps = createHabitOps({ store, now: () => BASE_MS, timeZone: TZ })
  assert.equal(sundayOps.getMonth({ month: '2026-11' }).week_start, 'sunday')
  const mondayOps = createHabitOps({ store, now: () => BASE_MS, timeZone: TZ, weekStart: 'monday' })
  assert.equal(mondayOps.getMonth({ month: '2026-11' }).week_start, 'monday') // 显式 deps.weekStart 优先

  await expectCode(() => ops.getMonth({ month: '2026-13' }), 'validation_failed')
})

test('todayHabits 输出今日状态与 target_text', async (t) => {
  const { ops } = await setup(t)
  const { habit } = await makeDailyHabit(ops)
  await ops.checkin({ habitId: habit.id })

  const weeklyDays = await ops.createHabit({
    name: '健身',
    frequency_rule: { kind: 'weekly_days', days: ['MO', 'WE', 'FR'] },
    time_hint: '下班后',
  })
  const weeklyCount = await ops.createHabit({
    name: '跑步',
    frequency_rule: { kind: 'weekly_count', count: 3 },
    period_rule: { period: 'week', target_count: 3 },
  })

  const items = ops.todayHabits()
  assert.equal(items.length, 3)
  const byId = new Map(items.map((item) => [item.habitId, item]))
  const daily = byId.get(habit.id)
  assert.equal(daily.today_status, 'done')
  assert.equal(daily.today_checkin_id !== null, true)
  assert.equal(daily.target_text, null)
  assert.equal(daily.time_hint, '睡前')
  assert.equal(daily.streak.unit, 'day')
  assert.equal(byId.get(weeklyDays.habit.id).target_text, '每周 3 天')
  assert.equal(byId.get(weeklyCount.habit.id).target_text, '本周 3 次')
})

// =====================================================================
// 性能：500 条 checkin 的 stats/month < 100ms
// =====================================================================

test('500 条 checkin 的 getStats/getMonth 在 100ms 内', async (t) => {
  const { store, ops } = await setup(t)
  const startDate = addDays(TODAY, -499)
  const { habit } = await ops.createHabit({
    name: '每日打卡',
    frequency_rule: { kind: 'daily', interval: 1 },
    start_date: startDate,
  })

  const opsBatch = []
  for (let index = 0; index < 500; index += 1) {
    const id = newId('hci')
    opsBatch.push({
      unit: 'lifeos',
      table: 'habit_checkin',
      key: id,
      value: {
        id,
        habit_id: habit.id,
        local_date: addDays(startDate, index),
        status: 'done',
        checkin_kind: 'manual',
      },
    })
  }
  await store.transaction(opsBatch)
  assert.equal(recordRows(store, 'habit_checkin').length, 500)

  ops.getStats({})
  ops.getMonth({ month: '2026-11' })

  const statsStarted = performance.now()
  const stats = ops.getStats({})
  const statsElapsed = performance.now() - statsStarted
  assert.equal(stats.habits.length, 1)
  assert.ok(statsElapsed < 100, `getStats 耗时 ${statsElapsed.toFixed(1)}ms，要求 < 100ms`)

  const monthStarted = performance.now()
  const month = ops.getMonth({ month: '2026-11' })
  const monthElapsed = performance.now() - monthStarted
  assert.equal(month.rows.length, 1)
  assert.equal(month.days.length, 30)
  assert.ok(monthElapsed < 100, `getMonth 耗时 ${monthElapsed.toFixed(1)}ms，要求 < 100ms`)

  assertAllWritesValid(store)
})

// ── M18 习惯分组（schema v4）─────────────────────────────────────

test('M18 分组：创建/重命名/折叠/排序，序号从 0 递增且事件带 habit_group', async (t) => {
  const { store, ops, events } = await setup(t)

  const morning = await ops.createHabitGroup({ name: '  清晨  ' })
  assert.match(morning.group.id, /^hgrp_/)
  assert.equal(morning.group.name, '清晨')
  assert.equal(morning.group.sort_order, 0)
  assert.equal(morning.group.collapsed, false)
  assert.equal(morning.revision, 1)

  const evening = await ops.createHabitGroup({ name: '睡前' })
  assert.equal(evening.group.sort_order, 1)

  const listed = ops.listHabitGroups()
  assert.deepEqual(listed.items.map((group) => group.name), ['清晨', '睡前'])

  const renamed = await ops.updateHabitGroup(morning.group.id, { name: '早起' }, { expectedRev: 1 })
  assert.equal(renamed.group.name, '早起')
  assert.equal(renamed.revision, 2)
  assert.deepEqual(renamed.diff.map((entry) => entry.field), ['name'])

  // 无变化的 patch 不写库、不涨 rev
  const noop = await ops.updateHabitGroup(morning.group.id, { name: '早起' }, { expectedRev: 2 })
  assert.equal(noop.revision, 2)
  assert.deepEqual(noop.diff, [])

  const collapsed = await ops.updateHabitGroup(evening.group.id, { collapsed: true }, { expectedRev: 1 })
  assert.equal(collapsed.group.collapsed, true)

  // 陈旧 rev → conflict
  await expectCode(() => ops.updateHabitGroup(morning.group.id, { name: '晚起' }, { expectedRev: 1 }), 'conflict')

  // 空名/超长名 → validation_failed
  await expectCode(() => ops.createHabitGroup({ name: '   ' }), 'validation_failed')
  await expectCode(() => ops.createHabitGroup({ name: 'x'.repeat(41) }), 'validation_failed')

  // 排序：逆序后 sort_order 跟随目标顺序
  const reordered = await ops.reorderHabitGroups({ ids: [evening.group.id, morning.group.id] })
  assert.deepEqual(reordered.items.map((group) => group.name), ['睡前', '早起'])
  assert.deepEqual(reordered.items.map((group) => group.sort_order), [0, 1])

  // 重复 id / 缺 id 被拒绝
  await expectCode(() => ops.reorderHabitGroups({ ids: [morning.group.id, morning.group.id] }), 'validation_failed')
  await expectCode(() => ops.reorderHabitGroups({ ids: ['hgrp_missing'] }), 'not_found')

  // 事件
  const kinds = events.filter((event) => event.kind === 'habit_group').map((event) => event.extra.action)
  assert.ok(kinds.includes('create'))
  assert.ok(kinds.includes('update'))
  assert.ok(kinds.includes('reorder'))

  // 落库记录合法（含 habit_group 表）
  for (const record of recordRows(store, 'habit_group')) {
    assert.equal(validateRecord('habit_group', record).ok, true, record.name)
  }
  assert.ok(logRows(store, 'operation_log').some((row) => row.action === 'habit_group.reorder'))
})

test('M18 分组：习惯归属、图标写入、删组回「未分组」且打卡不受影响', async (t) => {
  const { store, ops, events } = await setup(t)
  const group = await ops.createHabitGroup({ name: '健身' })

  const created = await ops.createHabit({
    name: '俯卧撑',
    frequencyRule: { kind: 'daily', interval: 1 },
    startDate: TODAY,
    groupId: group.group.id,
    icon: '💪',
  })
  assert.equal(created.habit.group_id, group.group.id)
  assert.equal(created.habit.icon, '💪')

  // 未知分组被拒绝
  await expectCode(
    () =>
      ops.createHabit({
        name: '引体向上',
        frequencyRule: { kind: 'daily', interval: 1 },
        startDate: TODAY,
        groupId: 'hgrp_missing',
      }),
    'validation_failed',
  )
  // 图标超长被拒绝
  await expectCode(
    () =>
      ops.createHabit({
        name: '深蹲',
        frequencyRule: { kind: 'daily', interval: 1 },
        startDate: TODAY,
        icon: '💪💪💪💪💪',
      }),
    'validation_failed',
  )

  // 打卡
  await ops.checkin({ habitId: created.habit.id, localDate: TODAY, status: 'done' })
  const checkinsBefore = recordRows(store, 'habit_checkin').length

  // 归组/改图标（update 走 patch）
  const moved = await ops.updateHabit(created.habit.id, { groupId: null, icon: null }, { expectedRev: 1 })
  assert.equal(moved.habit.group_id, null)
  assert.equal(moved.habit.icon, null)
  const movedBack = await ops.updateHabit(created.habit.id, { groupId: group.group.id, icon: '🏋️' }, { expectedRev: 2 })
  assert.equal(movedBack.habit.group_id, group.group.id)

  // 删组：习惯回未分组、打卡记录不变、事件同时通知 habit_group 与 habit
  const deleted = await ops.deleteHabitGroup(group.group.id, { expectedRev: 1 })
  assert.equal(deleted.deleted, true)
  assert.deepEqual(deleted.movedToUngrouped, [created.habit.id])
  assert.equal(recordRows(store, 'habit_checkin').length, checkinsBefore)

  const after = await ops.getHabit(created.habit.id)
  assert.equal(after.habit.group_id, null)

  // 软删后列表不再出现，且不能重复删除
  assert.equal(ops.listHabitGroups().items.length, 0)
  await expectCode(() => ops.deleteHabitGroup(group.group.id, { expectedRev: 2 }), 'not_found')

  const habitEvents = events.filter((event) => event.kind === 'habit')
  assert.ok(habitEvents.some((event) => event.ids.includes(created.habit.id) && event.extra.action === 'update'))
  assertAllWritesValid(store)
})