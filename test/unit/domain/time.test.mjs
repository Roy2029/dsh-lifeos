import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_TIME_ZONE,
  addDays,
  compareLocalDate,
  formatLocalDate,
  isIsoTimestamp,
  isLocalDate,
  isValidTimeZone,
  localDate,
  localDateOfIso,
  localDayRangeIso,
  localDayStartIso,
  localDateTimeToIso,
  localDateRangeToIso,
  daysBetweenLocalDates,
  isLocalDateBetween,
  listLocalDates,
  isAllDayTask,
  taskAnchorLocalDate,
  isOpenTask,
  isTaskToday,
  isTaskOverdue,
  isTaskWithinNextDays,
  isTaskInbox,
  nowIso,
  parseLocalDate,
} from '../../../src/domain/time.js'

test('nowIso：UTC ISO-8601 毫秒精度', () => {
  assert.equal(nowIso(new Date('2026-11-12T12:00:00.000Z')), '2026-11-12T12:00:00.000Z')
  assert.equal(nowIso(Date.parse('2026-11-12T12:00:00.123Z')), '2026-11-12T12:00:00.123Z')
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.throws(() => nowIso('not a date'), TypeError)
})

test('localDate：按 Asia/Shanghai 归日（UTC+8）', () => {
  assert.equal(DEFAULT_TIME_ZONE, 'Asia/Shanghai')
  assert.equal(localDate('Asia/Shanghai', new Date('2026-11-12T15:59:59.999Z')), '2026-11-12')
  assert.equal(localDate('Asia/Shanghai', new Date('2026-11-12T16:00:00.000Z')), '2026-11-13')
  assert.equal(localDateOfIso('Asia/Shanghai', '2026-11-12T16:00:00.000Z'), '2026-11-13')
  // 默认 tz = Asia/Shanghai
  assert.equal(localDate(undefined, new Date('2026-11-12T16:00:00.000Z')), '2026-11-13')
})

test('isValidTimeZone', () => {
  assert.equal(isValidTimeZone('Asia/Shanghai'), true)
  assert.equal(isValidTimeZone('UTC'), true)
  assert.equal(isValidTimeZone('Not/AZone'), false)
  assert.equal(isValidTimeZone(''), false)
  assert.equal(isValidTimeZone(null), false)
})

test('isIsoTimestamp：只接受毫秒精度 + Z 结尾', () => {
  assert.equal(isIsoTimestamp('2026-11-12T12:00:00.000Z'), true)
  assert.equal(isIsoTimestamp('2026-11-12T12:00:00Z'), false)
  assert.equal(isIsoTimestamp('2026-11-12'), false)
  assert.equal(isIsoTimestamp('2026-11-12T12:00:00.000+08:00'), false)
  assert.equal(isIsoTimestamp(42), false)
})

test('isLocalDate / parseLocalDate / formatLocalDate', () => {
  assert.equal(isLocalDate('2026-11-12'), true)
  assert.equal(isLocalDate('2024-02-29'), true)
  assert.equal(isLocalDate('2026-02-29'), false)
  assert.equal(isLocalDate('2026-13-01'), false)
  assert.equal(isLocalDate('2026-1-1'), false)
  assert.deepEqual(parseLocalDate('2026-11-12'), { year: 2026, month: 11, day: 12 })
  assert.equal(parseLocalDate('2026-02-30'), null)
  assert.equal(formatLocalDate({ year: 2026, month: 1, day: 5 }), '2026-01-05')
})

test('addDays / compareLocalDate', () => {
  assert.equal(addDays('2026-11-12', 1), '2026-11-13')
  assert.equal(addDays('2026-11-12', -1), '2026-11-11')
  assert.equal(addDays('2026-02-28', 1), '2026-03-01')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(compareLocalDate('2026-11-12', '2026-11-13'), -1)
  assert.equal(compareLocalDate('2026-11-12', '2026-11-12'), 0)
  assert.equal(compareLocalDate('2026-11-13', '2026-11-12'), 1)
  assert.throws(() => addDays('bad', 1), TypeError)
})

test('localDayStartIso / localDayRangeIso：Asia/Shanghai 与 DST 时区', () => {
  assert.equal(localDayStartIso('Asia/Shanghai', '2026-11-12'), '2026-11-11T16:00:00.000Z')
  assert.deepEqual(localDayRangeIso('Asia/Shanghai', '2026-11-12'), {
    startIso: '2026-11-11T16:00:00.000Z',
    endIso: '2026-11-12T16:00:00.000Z',
  })
  // 美国 2026-03-08 进入夏令时：本地日只有 23 小时
  const range = localDayRangeIso('America/New_York', '2026-03-08')
  assert.equal(range.startIso, '2026-03-08T05:00:00.000Z')
  assert.equal(range.endIso, '2026-03-09T04:00:00.000Z')
  const hours = (Date.parse(range.endIso) - Date.parse(range.startIso)) / 3_600_000
  assert.equal(hours, 23)
})


// ---------------------------------------------------------------------------
// M1 时间矩阵：本地日/UTC 互转、今天/未来7天/逾期/收件箱判定
// ---------------------------------------------------------------------------

const TZ = 'Asia/Shanghai'
const NOW = new Date('2026-11-13T02:00:00.000Z') // 北京时间 2026-11-13 10:00
const TODAY = '2026-11-13'

test('localDateTimeToIso：本地日期+时分 → UTC', () => {
  assert.equal(localDateTimeToIso(TZ, TODAY, '10:00'), '2026-11-13T02:00:00.000Z')
  assert.equal(localDateTimeToIso(TZ, TODAY, '00:00'), localDayStartIso(TZ, TODAY))
  assert.throws(() => localDateTimeToIso(TZ, TODAY, '24:00'), TypeError)
  assert.throws(() => localDateTimeToIso(TZ, TODAY, '10:60'), TypeError)
})

test('localDateRangeToIso / daysBetweenLocalDates / isLocalDateBetween / listLocalDates', () => {
  assert.deepEqual(localDateRangeToIso(TZ, TODAY, TODAY), {
    startIso: '2026-11-12T16:00:00.000Z',
    endExclusiveIso: '2026-11-13T16:00:00.000Z',
  })
  assert.equal(daysBetweenLocalDates(TODAY, '2026-11-19'), 6)
  assert.equal(daysBetweenLocalDates('2026-11-19', TODAY), -6)
  assert.equal(isLocalDateBetween(TODAY, TODAY, '2026-11-19'), true)
  assert.equal(isLocalDateBetween('2026-11-20', TODAY, '2026-11-19'), false)
  assert.deepEqual(listLocalDates(TODAY, '2026-11-15'), ['2026-11-13', '2026-11-14', '2026-11-15'])
  assert.equal(listLocalDates(TODAY, '2027-11-13').length, 366, '最多 366 天防爆炸')
})

test('isAllDayTask / taskAnchorLocalDate 优先级', () => {
  assert.equal(isAllDayTask({ scheduled_date: TODAY }), true)
  assert.equal(isAllDayTask({ is_all_day: true }), true)
  assert.equal(isAllDayTask({ scheduled_start_at: '2026-11-13T02:00:00.000Z' }), false)
  assert.equal(isAllDayTask(null), false)

  assert.equal(taskAnchorLocalDate({ scheduled_date: TODAY }, TZ), TODAY)
  assert.equal(taskAnchorLocalDate({ scheduled_start_at: '2026-11-14T02:00:00.000Z' }, TZ), '2026-11-14')
  assert.equal(taskAnchorLocalDate({ due_date: '2026-11-15' }, TZ), '2026-11-15')
  assert.equal(taskAnchorLocalDate({ due_at: '2026-11-16T02:00:00.000Z' }, TZ), '2026-11-16')
  assert.equal(taskAnchorLocalDate({}, TZ), null)
  // scheduled 优先于 due
  assert.equal(taskAnchorLocalDate({ scheduled_date: TODAY, due_date: '2026-12-01' }, TZ), TODAY)
})

test('isOpenTask / isTaskToday 矩阵（scheduled_date / start 归日 / due_date / due_at 归日）', () => {
  assert.equal(isOpenTask({ status: 'todo' }), true)
  assert.equal(isOpenTask({ status: 'doing' }), true)
  assert.equal(isOpenTask({ status: 'done' }), false)
  assert.equal(isOpenTask({ status: 'cancelled' }), false)
  assert.equal(isOpenTask({ status: 'todo', archived_at: '2026-11-01T00:00:00.000Z' }), false)

  const opts = { timeZone: TZ, now: NOW }
  assert.equal(isTaskToday({ scheduled_date: TODAY }, opts), true)
  assert.equal(isTaskToday({ scheduled_start_at: '2026-11-13T02:00:00.000Z' }, opts), true)
  assert.equal(isTaskToday({ due_date: TODAY }, opts), true)
  assert.equal(isTaskToday({ due_at: '2026-11-13T15:00:00.000Z' }, opts), true)
  assert.equal(isTaskToday({ scheduled_date: '2026-11-14' }, opts), false)
  assert.equal(isTaskToday({ due_at: '2026-11-12T15:00:00.000Z' }, opts), false)
  // UTC 跨日：北京时间 11-14 00:30 = UTC 11-13 16:30 → 归日 11-14
  assert.equal(isTaskToday({ due_at: '2026-11-13T16:30:00.000Z' }, opts), false)
})

test('isTaskOverdue 矩阵（due_date / due_at / 已关闭排除）', () => {
  const opts = { timeZone: TZ, now: NOW }
  assert.equal(isTaskOverdue({ status: 'todo', due_date: '2026-11-12' }, opts), true)
  assert.equal(isTaskOverdue({ status: 'todo', due_at: '2026-11-13T01:00:00.000Z' }, opts), true)
  assert.equal(isTaskOverdue({ status: 'todo', due_date: TODAY }, opts), false, '今天到期未逾期')
  assert.equal(isTaskOverdue({ status: 'todo', due_at: '2026-11-13T03:00:00.000Z' }, opts), false)
  assert.equal(isTaskOverdue({ status: 'done', due_date: '2026-11-01' }, opts), false)
  assert.equal(isTaskOverdue({ status: 'cancelled', due_date: '2026-11-01' }, opts), false)
  assert.equal(isTaskOverdue({ status: 'todo', due_date: '2026-11-01', archived_at: NOW.toISOString() }, opts), false)
})

test('isTaskWithinNextDays 边界：含今天与 today+6，不含 today+7 与逾期', () => {
  const opts = { timeZone: TZ, now: NOW, days: 7 }
  assert.equal(isTaskWithinNextDays({ status: 'todo', scheduled_date: TODAY }, opts), true)
  assert.equal(isTaskWithinNextDays({ status: 'todo', scheduled_date: '2026-11-19' }, opts), true)
  assert.equal(isTaskWithinNextDays({ status: 'todo', scheduled_date: '2026-11-20' }, opts), false)
  assert.equal(isTaskWithinNextDays({ status: 'todo', scheduled_start_at: '2026-11-19T02:00:00.000Z' }, opts), true)
  assert.equal(isTaskWithinNextDays({ status: 'todo', due_date: '2026-11-12' }, opts), false, '逾期不进 next7')
  assert.equal(isTaskWithinNextDays({ status: 'todo' }, opts), false)
  assert.equal(isTaskWithinNextDays({ status: 'done', scheduled_date: TODAY }, opts), false)
})

test('isTaskInbox：无 project、无任何 scheduled/due', () => {
  assert.equal(isTaskInbox({ status: 'todo' }), true)
  assert.equal(isTaskInbox({ status: 'todo', project_id: 'prj_1' }), false)
  assert.equal(isTaskInbox({ status: 'todo', scheduled_date: TODAY }), false)
  assert.equal(isTaskInbox({ status: 'todo', due_at: '2026-11-14T02:00:00.000Z' }), false)
  assert.equal(isTaskInbox({ status: 'done' }), false)
})
