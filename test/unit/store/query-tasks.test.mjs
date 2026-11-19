import test from 'node:test'
import assert from 'node:assert/strict'

import { LifeosIndexes } from '../../../src/store/indexes.js'

const TZ = 'Asia/Shanghai'
const NOW = new Date('2026-11-13T02:00:00.000Z') // 北京时间 2026-11-13 10:00
const TODAY = '2026-11-13'
const TOMORROW = '2026-11-14'

let seq = 0
function task(id, fields = {}) {
  seq += 1
  const ordinal = String(id).replace(/[^0-9]/g, '').slice(-2) || String(seq).padStart(2, '0')
  return {
    id,
    title: fields.title ?? `任务 ${id}`,
    status: fields.status ?? 'todo',
    priority: fields.priority ?? 'none',
    created_at: fields.created_at ?? `2026-11-01T00:00:${ordinal}.000Z`,
    updated_at: fields.updated_at ?? `2026-11-01T00:00:${ordinal}.000Z`,
    rev: 1,
    ...fields,
  }
}

/**
 * 20 条种子任务（M1-G2）：
 * 覆盖 today（date/start/due_date/due_at）、overdue（due_date/due_at）、next7 边界、inbox、
 * 项目/标签筛选、归档/完成/取消排除、分组边界、排序。
 */
function seedTasks() {
  return [
    task('tsk_01', { scheduled_date: TODAY, time_kind: 'all_day', is_all_day: true, title: '今天·全天' }),
    task('tsk_02', {
      scheduled_start_at: '2026-11-13T02:00:00.000Z',
      scheduled_end_at: '2026-11-13T03:00:00.000Z',
      time_kind: 'span',
      title: '今天·时间段',
    }),
    task('tsk_03', { due_date: TODAY, title: '今天·截止日期' }),
    task('tsk_04', { due_at: '2026-11-13T15:00:00.000Z', title: '今天·截止时刻' }),
    task('tsk_05', { due_date: '2026-11-12', title: '逾期·截止日期' }),
    task('tsk_06', { due_at: '2026-11-12T04:00:00.000Z', title: '逾期·截止时刻' }),
    task('tsk_07', { status: 'done', scheduled_date: TODAY, completed_at: '2026-11-13T01:00:00.000Z', title: '已完成' }),
    task('tsk_08', { status: 'cancelled', due_date: '2026-11-12', title: '已取消' }),
    task('tsk_09', { scheduled_date: TOMORROW, time_kind: 'all_day', is_all_day: true, title: '明天' }),
    task('tsk_10', { scheduled_date: '2026-11-19', time_kind: 'all_day', is_all_day: true, title: 'next7 最后一天' }),
    task('tsk_11', { scheduled_date: '2026-11-20', time_kind: 'all_day', is_all_day: true, title: 'next7 之外' }),
    task('tsk_12', { title: '收件箱·无日期' }),
    task('tsk_13', { project_id: 'prj_1', title: '项目任务·无日期' }),
    task('tsk_14', {
      project_id: 'prj_1',
      scheduled_date: TODAY,
      time_kind: 'all_day',
      is_all_day: true,
      title: '项目任务·今天',
    }),
    task('tsk_15', { scheduled_date: '2026-11-12', time_kind: 'all_day', is_all_day: true, title: '计划日已过（非 due 逾期）' }),
    task('tsk_16', { due_date: TOMORROW, title: '明天截止' }),
    task('tsk_17', { archived_at: '2026-11-12T00:00:00.000Z', scheduled_date: TODAY, title: '已归档' }),
    task('tsk_18', { priority: 'high', title: '收件箱·高优先级' }),
    task('tsk_19', { status: 'doing', project_id: 'prj_2', title: '进行中·项目2' }),
    task('tsk_20', { due_at: '2026-11-13T00:30:00.000Z', title: '今天·已过截止时刻' }),
  ]
}

function seedTags() {
  return [
    { id: 'etag_01', tag_id: 'tag_1', entity_type: 'task', entity_id: 'tsk_01' },
    { id: 'etag_02', tag_id: 'tag_1', entity_type: 'task', entity_id: 'tsk_14' },
    { id: 'etag_03', tag_id: 'tag_2', entity_type: 'task', entity_id: 'tsk_12' },
  ]
}

function makeIndexes() {
  const indexes = new LifeosIndexes({ timeZone: TZ })
  const tasks = seedTasks()
  indexes.rebuild({
    lifeos: new Map([
      ['task', new Map(tasks.map((record) => [record.id, record]))],
      ['entity_tag', new Map(seedTags().map((record) => [record.id, record]))],
    ]),
  })
  return { indexes, tasks }
}

const OPTS = { timeZone: TZ, now: NOW }

function ids(result) {
  return result.items.map((item) => item.id)
}

test('counts：20 条种子任务的 5 个口径计数（不受筛选影响）', () => {
  const { indexes } = makeIndexes()
  const result = indexes.queryTasks({ view: 'all', ...OPTS })
  assert.deepEqual(result.counts, { today: 6, overdue: 3, next7: 8, inbox: 2, all: 17 })
  // 筛选不影响 counts（tab 徽标口径）
  const filtered = indexes.queryTasks({ view: 'all', projectId: 'prj_1', ...OPTS })
  assert.deepEqual(filtered.counts, result.counts)
})

test('today 视图：scheduled_date / scheduled_start_at / due_date / due_at 归日，排除已完成/取消/归档', () => {
  const { indexes } = makeIndexes()
  const result = indexes.queryTasks({ view: 'today', ...OPTS })
  assert.deepEqual(
    new Set(ids(result)),
    new Set(['tsk_01', 'tsk_02', 'tsk_03', 'tsk_04', 'tsk_14', 'tsk_20']),
  )
  // 排序：有时间在前（tsk_20 00:30Z < tsk_02 02:00Z < tsk_04 15:00Z），无时间在后
  assert.equal(result.items[0].id, 'tsk_20')
  const order = ids(result)
  assert.ok(order.indexOf('tsk_02') < order.indexOf('tsk_01'))
  assert.ok(order.indexOf('tsk_04') < order.indexOf('tsk_01'))
})

test('overdue 视图：due_date 昨天 / due_at 已过；今天到期不算；已完成/取消/归档排除', () => {
  const { indexes } = makeIndexes()
  const result = indexes.queryTasks({ view: 'overdue', ...OPTS })
  assert.deepEqual(new Set(ids(result)), new Set(['tsk_05', 'tsk_06', 'tsk_20']))
  // 最逾期在前（due 升序）
  assert.equal(result.items[0].id, 'tsk_05')
})

test('next7 视图：含今天与 today+6，不含 today+7 与逾期', () => {
  const { indexes } = makeIndexes()
  const result = indexes.queryTasks({ view: 'next7', ...OPTS })
  const set = new Set(ids(result))
  assert.equal(set.has('tsk_01'), true)
  assert.equal(set.has('tsk_10'), true, 'today+6 应包含')
  assert.equal(set.has('tsk_11'), false, 'today+7 不包含')
  assert.equal(set.has('tsk_05'), false, '逾期不包含')
  assert.deepEqual(set, new Set(['tsk_01', 'tsk_02', 'tsk_03', 'tsk_04', 'tsk_09', 'tsk_10', 'tsk_14', 'tsk_16']))
})

test('inbox 视图：无项目且无任何 scheduled/due', () => {
  const { indexes } = makeIndexes()
  const result = indexes.queryTasks({ view: 'inbox', ...OPTS })
  assert.deepEqual(new Set(ids(result)), new Set(['tsk_12', 'tsk_18']))
})

test('all 视图：全部未完成未归档（排除 done/cancelled/archived），无日期最后', () => {
  const { indexes } = makeIndexes()
  const result = indexes.queryTasks({ view: 'all', limit: 200, ...OPTS })
  const set = new Set(ids(result))
  assert.equal(result.items.length, 17)
  for (const excluded of ['tsk_07', 'tsk_08', 'tsk_17']) assert.equal(set.has(excluded), false)
  // 排序：锚定日最早的在前（11-12 的 tsk_05/tsk_15 并列，按 created_at）
  assert.deepEqual(result.items.slice(0, 3).map((item) => item.id), ['tsk_05', 'tsk_06', 'tsk_15'])
  const order = ids(result)
  const noneIds = ['tsk_12', 'tsk_13', 'tsk_18', 'tsk_19']
  const firstNoneIndex = Math.min(...noneIds.map((id) => order.indexOf(id)))
  const lastDatedIndex = Math.max(
    ...order.filter((id) => !noneIds.includes(id)).map((id) => order.indexOf(id)),
  )
  assert.ok(lastDatedIndex < firstNoneIndex, '无日期任务应全部排在最后')
})

test('all 视图排序：日期升序 → 同日优先级降序 → created_at', () => {
  const indexes = new LifeosIndexes({ timeZone: TZ })
  indexes.rebuild({
    lifeos: new Map([
      [
        'task',
        new Map(
          [
            task('tsk_a', { scheduled_date: TODAY, priority: 'low', created_at: '2026-11-01T00:00:01.000Z' }),
            task('tsk_b', { scheduled_date: TODAY, priority: 'high', created_at: '2026-11-01T00:00:02.000Z' }),
            task('tsk_c', { scheduled_date: TODAY, priority: 'medium', created_at: '2026-11-01T00:00:03.000Z' }),
            task('tsk_d', { created_at: '2026-11-01T00:00:04.000Z' }),
          ].map((record) => [record.id, record]),
        ),
      ],
    ]),
  })
  const order = ids(indexes.queryTasks({ view: 'all', ...OPTS }))
  assert.deepEqual(order, ['tsk_b', 'tsk_c', 'tsk_a', 'tsk_d'])
})

test('groups：逾期/今天/明天/最近7天/以后/无日期 边界与计数（20 种子）', () => {
  const { indexes } = makeIndexes()
  const result = indexes.queryTasks({ view: 'all', limit: 200, ...OPTS })
  assert.ok(Array.isArray(result.groups))
  assert.deepEqual(
    result.groups.map((group) => group.key),
    ['overdue', 'today', 'tomorrow', 'next7', 'later', 'none'],
  )
  const countOf = Object.fromEntries(result.groups.map((group) => [group.key, group.count]))
  assert.deepEqual(countOf, { overdue: 4, today: 5, tomorrow: 2, next7: 1, later: 1, none: 4 })
  const allItems = result.groups.flatMap((group) => group.items)
  assert.equal(allItems.length, 17)
  // 分组边界归属
  const groupOf = Object.fromEntries(
    result.groups.flatMap((group) => group.items.map((item) => [item.id, group.key])),
  )
  assert.equal(groupOf.tsk_05, 'overdue')
  assert.equal(groupOf.tsk_15, 'overdue', '计划日已过归入逾期组')
  assert.equal(groupOf.tsk_20, 'overdue', 'due_at 已过归入逾期组')
  assert.equal(groupOf.tsk_01, 'today')
  assert.equal(groupOf.tsk_09, 'tomorrow')
  assert.equal(groupOf.tsk_10, 'next7')
  assert.equal(groupOf.tsk_11, 'later')
  assert.equal(groupOf.tsk_12, 'none')
  // groups 项为完整记录
  assert.equal(result.groups[0].label, '逾期')
  assert.ok(result.groups[0].items[0].title)
})

test('today 视图也返回 groups（逾期折叠 + 今天）', () => {
  const { indexes } = makeIndexes()
  const result = indexes.queryTasks({ view: 'today', ...OPTS })
  assert.ok(Array.isArray(result.groups))
  assert.deepEqual(
    result.groups.map((group) => group.key),
    ['overdue', 'today', 'tomorrow', 'next7', 'later', 'none'],
  )
  const overdue = result.groups.find((group) => group.key === 'overdue')
  assert.deepEqual(new Set(overdue.items.map((item) => item.id)), new Set(['tsk_05', 'tsk_06', 'tsk_20', 'tsk_15']))
})

test('筛选：projectId / tagId / q / 组合', () => {
  const { indexes } = makeIndexes()
  assert.deepEqual(
    new Set(ids(indexes.queryTasks({ view: 'all', projectId: 'prj_1', ...OPTS }))),
    new Set(['tsk_13', 'tsk_14']),
  )
  assert.deepEqual(
    new Set(ids(indexes.queryTasks({ view: 'all', tagId: 'tag_1', ...OPTS }))),
    new Set(['tsk_01', 'tsk_14']),
  )
  assert.deepEqual(
    new Set(ids(indexes.queryTasks({ view: 'all', q: '截止', ...OPTS }))),
    new Set(['tsk_03', 'tsk_04', 'tsk_05', 'tsk_06', 'tsk_16', 'tsk_20']),
  )
  const combo = indexes.queryTasks({ view: 'all', projectId: 'prj_1', tagId: 'tag_1', ...OPTS })
  assert.deepEqual(ids(combo), ['tsk_14'])
  const noMatch = indexes.queryTasks({ view: 'all', q: '不存在的关键词', ...OPTS })
  assert.equal(noMatch.items.length, 0)
})

test('分页：limit + cursor 不重不漏，nextCursor 语义正确', () => {
  const { indexes } = makeIndexes()
  const all = indexes.queryTasks({ view: 'all', limit: 200, ...OPTS })
  const page1 = indexes.queryTasks({ view: 'all', limit: 5, ...OPTS })
  assert.equal(page1.items.length, 5)
  assert.equal(page1.nextCursor, page1.items[4].id)
  const page2 = indexes.queryTasks({ view: 'all', limit: 5, cursor: page1.nextCursor, ...OPTS })
  assert.equal(page2.items.length, 5)
  assert.equal(page2.items[0].id, all.items[5].id)
  const page3 = indexes.queryTasks({ view: 'all', limit: 5, cursor: page2.nextCursor, ...OPTS })
  const page4 = indexes.queryTasks({ view: 'all', limit: 5, cursor: page3.nextCursor, ...OPTS })
  const collected = [...page1.items, ...page2.items, ...page3.items, ...page4.items].map((item) => item.id)
  assert.deepEqual(collected, all.items.map((item) => item.id))
  assert.equal(page4.nextCursor, null)
  // 非法 cursor 从头开始；limit 夹取
  assert.equal(indexes.queryTasks({ view: 'all', limit: 1, cursor: 'nope', ...OPTS }).items.length, 1)
  assert.equal(indexes.queryTasks({ view: 'all', limit: 999, ...OPTS }).items.length, 17)
  assert.throws(() => indexes.queryTasks({ view: 'bad', ...OPTS }), TypeError)
})

test('索引一致性：增量 upsert/remove 与全量 rebuild 结果一致', () => {
  const { indexes } = makeIndexes()
  const snapshot = JSON.parse(JSON.stringify(indexes.queryTasks({ view: 'all', limit: 200, ...OPTS })))

  const extra = task('tsk_new', { scheduled_date: TOMORROW, time_kind: 'all_day', is_all_day: true, title: '新增' })
  indexes.upsert('task', extra.id, extra)
  assert.ok(ids(indexes.queryTasks({ view: 'today', ...OPTS })).length >= 6)
  assert.equal(indexes.taskIdsByScheduledDate(TOMORROW).includes('tsk_new'), true)
  assert.equal(indexes.queryTasks({ view: 'all', limit: 200, ...OPTS }).counts.all, 18)

  indexes.remove('task', 'tsk_new')
  assert.equal(indexes.queryTasks({ view: 'all', limit: 200, ...OPTS }).counts.all, 17)

  // 重建后与增量维护一致
  const memory = {
    lifeos: new Map([
      ['task', new Map(seedTasks().map((record) => [record.id, record]))],
      ['entity_tag', new Map(seedTags().map((record) => [record.id, record]))],
    ]),
  }
  indexes.rebuild(memory)
  assert.deepEqual(indexes.queryTasks({ view: 'all', limit: 200, ...OPTS }), snapshot)

  // 删除任务时各索引同步清理
  indexes.remove('task', 'tsk_14')
  assert.equal(indexes.queryTasks({ view: 'all', projectId: 'prj_1', ...OPTS }).items.length, 1)
  assert.equal(indexes.taskIdsByScheduledDate(TODAY).includes('tsk_14'), false)
  // 标签关系在 entity_tag 表中，删除任务不自动级联关系（由上层事务维护）；删除关系后索引同步
  indexes.remove('entity_tag', 'etag_02')
  assert.equal(indexes.entitiesOfTag('tag_1').includes('task:tsk_14'), false)
})

test('标签索引：entitiesByTag 反向维护与 rebuild 一致', () => {
  const { indexes } = makeIndexes()
  assert.deepEqual(indexes.entitiesOfTag('tag_1'), ['task:tsk_01', 'task:tsk_14'])
  const etag = { id: 'etag_04', tag_id: 'tag_1', entity_type: 'task', entity_id: 'tsk_02' }
  indexes.upsert('entity_tag', etag.id, etag)
  assert.deepEqual(indexes.entitiesOfTag('tag_1'), ['task:tsk_01', 'task:tsk_02', 'task:tsk_14'])
  indexes.remove('entity_tag', 'etag_02')
  assert.equal(indexes.entitiesOfTag('tag_1').includes('task:tsk_14'), false)
})
