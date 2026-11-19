import test from 'node:test'
import assert from 'node:assert/strict'

import { LifeosIndexes } from '../../../src/store/indexes.js'
import { localDate } from '../../../src/domain/time.js'

const TZ = 'Asia/Shanghai'

function memoryOf({ raw = [], inbox = [], tasks = [], oplogs = [], journals = [] }) {
  const table = (records) => new Map(records.map((r) => [r.id, r]))
  return {
    lifeos_raw: new Map([['raw_record', table(raw)]]),
    lifeos: new Map([
      ['inbox_item', table(inbox)],
      ['task', table(tasks)],
    ]),
    lifeos_log: new Map([
      ['operation_log', table(oplogs)],
      ['journal', table(journals)],
    ]),
  }
}

test('rebuild/upsert/remove：基础索引与状态计数', () => {
  const indexes = new LifeosIndexes({ timeZone: TZ })
  indexes.rebuild(
    memoryOf({
      raw: [
        { id: 'rr_1', raw_text: 'a', processing_status: 'pending' },
        { id: 'rr_2', raw_text: 'b', processing_status: 'processed' },
      ],
      inbox: [
        { id: 'inb_1', title: 'a', status: 'captured' },
        { id: 'inb_2', title: 'b', status: 'triaged' },
        { id: 'inb_3', title: 'c', status: 'promoted' },
      ],
      tasks: [
        { id: 'tsk_1', title: 'a', status: 'todo', due_date: '2026-11-13' },
        { id: 'tsk_2', title: 'b', status: 'done', due_at: '2026-11-12T02:00:00.000Z' },
      ],
    }),
  )
  assert.equal(indexes.idsByStatus('raw_record', 'pending').length, 1)
  assert.equal(indexes.idsByStatus('inbox_item', 'captured').length, 1)
  assert.equal(indexes.countInboxPending(), 2)
  assert.deepEqual(indexes.taskIdsByDueDay('2026-11-13'), ['tsk_1'])
  assert.deepEqual(indexes.taskIdsByDueDay('2026-11-12'), ['tsk_2'])

  indexes.upsert('inbox_item', 'inb_4', { id: 'inb_4', title: 'd', status: 'needs_review' })
  assert.equal(indexes.countInboxPending(), 3)
  indexes.remove('inbox_item', 'inb_4')
  assert.equal(indexes.countInboxPending(), 2)
  assert.equal(indexes.get('task', 'tsk_1').title, 'a')
})

test('operation_log：requestId（idempotency_key / meta_json）反查', () => {
  const indexes = new LifeosIndexes({ timeZone: TZ })
  indexes.upsert('operation_log', 'opl_1', {
    id: 'opl_1',
    action: 'capture',
    idempotency_key: 'req-1',
    meta_json: { request_id: 'req-1' },
  })
  indexes.upsert('operation_log', 'opl_2', { id: 'opl_2', action: 'capture', meta_json: { request_id: 'req-2' } })
  assert.equal(indexes.requestIdToOplog('req-1'), 'opl_1')
  assert.equal(indexes.requestIdToOplog('req-2'), 'opl_2')
  assert.equal(indexes.requestIdToOplog('missing'), null)
  indexes.remove('operation_log', 'opl_2')
  assert.equal(indexes.requestIdToOplog('req-2'), null)
})

test('journalPending：按 createdAt 升序（恢复顺序）', () => {
  const indexes = new LifeosIndexes({ timeZone: TZ })
  indexes.upsert('journal', 'jrn_b', { id: 'jrn_b', status: 'pending', createdAt: '2026-11-12T00:00:02.000Z' })
  indexes.upsert('journal', 'jrn_a', { id: 'jrn_a', status: 'pending', createdAt: '2026-11-12T00:00:01.000Z' })
  indexes.upsert('journal', 'jrn_c', { id: 'jrn_c', status: 'committed', createdAt: '2026-11-12T00:00:00.000Z' })
  assert.deepEqual(
    indexes.pendingJournals().map((j) => j.id),
    ['jrn_a', 'jrn_b'],
  )
  indexes.upsert('journal', 'jrn_b', { id: 'jrn_b', status: 'committed', createdAt: '2026-11-12T00:00:02.000Z' })
  assert.deepEqual(
    indexes.pendingJournals().map((j) => j.id),
    ['jrn_a'],
  )
})

test('query：inbox_pending 排序与游标分页', () => {
  const indexes = new LifeosIndexes({ timeZone: TZ })
  const inbox = []
  for (let i = 0; i < 5; i++) {
    inbox.push({
      id: `inb_${i}`,
      title: `t${i}`,
      status: 'captured',
      created_at: `2026-11-12T00:00:0${i}.000Z`,
    })
  }
  indexes.rebuild(memoryOf({ inbox }))
  const page1 = indexes.query('inbox_pending', { limit: 2 })
  assert.deepEqual(
    page1.items.map((r) => r.id),
    ['inb_4', 'inb_3'],
  )
  assert.equal(page1.nextCursor, 'inb_3')
  const page2 = indexes.query('inbox_pending', { limit: 2, cursor: page1.nextCursor })
  assert.deepEqual(
    page2.items.map((r) => r.id),
    ['inb_2', 'inb_1'],
  )
  const page3 = indexes.query('inbox_pending', { limit: 2, cursor: page2.nextCursor })
  assert.deepEqual(page3.items.map((r) => r.id), ['inb_0'])
  assert.equal(page3.nextCursor, null)
  assert.throws(() => indexes.query('nope'), TypeError)
})

test('query：today（scheduled_date / due_date / scheduled_start_at 归日）', () => {
  const indexes = new LifeosIndexes({ timeZone: TZ })
  const today = localDate(TZ)
  indexes.rebuild(
    memoryOf({
      tasks: [
        { id: 'tsk_a', title: 'a', status: 'todo', scheduled_date: today, priority: 'high' },
        { id: 'tsk_b', title: 'b', status: 'doing', due_date: today, priority: 'low' },
        { id: 'tsk_c', title: 'c', status: 'todo', scheduled_start_at: '2026-01-01T00:00:00.000Z' },
        { id: 'tsk_d', title: 'd', status: 'done', scheduled_date: today },
      ],
    }),
  )
  const items = indexes.query('today').items
  assert.deepEqual(
    items.map((r) => r.id),
    ['tsk_a', 'tsk_b'],
  )
  // 优先级排序：high 在前
  assert.equal(items[0].priority, 'high')
  const all = indexes.query('all_tasks', { limit: 10 }).items
  assert.equal(all.length, 4)
  assert.equal(all[0].status, 'done')
})

test('paginate：cursor 不存在时从头开始，limit 截断到 1..200', () => {
  const indexes = new LifeosIndexes({ timeZone: TZ })
  indexes.upsert('inbox_item', 'inb_1', { id: 'inb_1', status: 'captured', created_at: '2026-11-12T00:00:01.000Z' })
  indexes.upsert('inbox_item', 'inb_2', { id: 'inb_2', status: 'captured', created_at: '2026-11-12T00:00:02.000Z' })
  const res = indexes.query('inbox_pending', { limit: 0, cursor: 'missing' })
  assert.equal(res.items.length, 1) // limit 下限 1
  const many = indexes.query('inbox_pending', { limit: 999 })
  assert.equal(many.items.length, 2)
})
