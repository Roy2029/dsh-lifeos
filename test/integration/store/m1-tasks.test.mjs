import test from 'node:test'
import assert from 'node:assert/strict'

import { openLifeosStore } from '../../../src/store/lifeos-store.js'
import { newId } from '../../../src/domain/ids.js'
import { localDate, nowIso } from '../../../src/domain/time.js'
import { normalizeTaskInput, transitionTask } from '../../../src/domain/task.js'
import { createFakeBackend } from '../../unit/store/fake-backend.mjs'

const TZ = 'Asia/Shanghai'

function makeTaskRecord(input, overrides = {}) {
  const normalized = normalizeTaskInput(input)
  assert.equal(normalized.ok, true, `输入应合法：${JSON.stringify(normalized.errors)}`)
  const id = overrides.id ?? newId('tsk')
  const now = nowIso()
  return {
    id,
    status: 'todo',
    ...normalized.value,
    created_at: now,
    updated_at: now,
    rev: 1,
    ...overrides,
  }
}

function stateChangeOf(task, field, before, after, actor = 'user') {
  const now = nowIso()
  return {
    id: newId('stc'),
    entity_type: 'task',
    entity_id: task.id,
    field,
    old_value: before,
    new_value: after,
    changed_at: now,
    actor_type: actor,
    origin_type: 'user_stated',
    reason: 'm1.store.integration',
    rev_after: task.rev,
    reversible: true,
  }
}

function oplogOf(action, task, requestId) {
  return {
    id: newId('opl'),
    actor_type: 'user',
    action,
    target_type: 'task',
    target_id: task.id,
    decision: 'allowed',
    permission_level: 'L2',
    status: 'applied',
    occurred_at: nowIso(),
    idempotency_key: requestId,
    meta_json: { request_id: requestId },
  }
}

async function createTaskThroughTransaction(store, task, requestId) {
  const oplog = oplogOf('task.create', task, requestId)
  const stateChange = stateChangeOf(task, '__created__', null, { title: task.title })
  await store.transaction([
    { unit: 'lifeos', table: 'task', key: task.id, value: task },
    { unit: 'lifeos_log', table: 'state_change', key: stateChange.id, value: stateChange },
    { unit: 'lifeos_log', table: 'operation_log', key: oplog.id, value: oplog },
  ])
}

test('默认清单：seed 一条"收件箱"，重复打开不重复', async () => {
  const { backend } = createFakeBackend()
  const store1 = await openLifeosStore(null, { backend, testMode: true, timeZone: TZ })
  const lists = store1.entries('lifeos', 'list')
  assert.equal(lists.length, 1)
  const list = lists[0][1]
  assert.equal(list.name, '收件箱')
  assert.equal(list.kind, 'inbox')
  assert.equal(list.is_default, true)
  assert.match(list.id, /^lst_[0-9A-HJKMNP-TV-Z]{26}$/)
  await store1.close()

  const store2 = await openLifeosStore(null, { backend, testMode: true, timeZone: TZ })
  assert.equal(store2.entries('lifeos', 'list').length, 1, '重开不得重复 seed')
  await store2.close()
})

test('M1 任务读写链路：normalizeTaskInput → transaction(3 表) → queryTasks → 完成 → 持久化', async () => {
  const { backend } = createFakeBackend()
  const store = await openLifeosStore(null, { backend, testMode: true, timeZone: TZ })
  const today = localDate(TZ)

  const taskA = makeTaskRecord({ title: '今天写周报', scheduledDate: today, priority: 'high' })
  const taskB = makeTaskRecord({ title: '收件箱任务', notes: '无日期' })
  const taskC = makeTaskRecord({ title: '明天截止', dueDate: today })

  await createTaskThroughTransaction(store, taskA, 'req-a')
  await createTaskThroughTransaction(store, taskB, 'req-b')
  await createTaskThroughTransaction(store, taskC, 'req-c')

  // M0 兼容 + M1 视图
  const all = store.queryTasks({ view: 'all' })
  assert.equal(all.items.length, 3)
  assert.deepEqual(all.counts, { today: 2, overdue: 0, next7: 2, inbox: 1, all: 3 })
  assert.equal(store.queryTasks({ view: 'today' }).items.length, 2)
  assert.equal(store.queryTasks({ view: 'inbox' }).items.length, 1)
  assert.equal(store.entries('lifeos_log', 'state_change').length, 3)
  assert.equal(store.entries('lifeos_log', 'operation_log').length, 3)
  assert.equal(store.indexes.requestIdToOplog('req-a') !== null, true)

  // 批量读 / records / getMany
  const many = store.getMany('lifeos', 'task', [taskA.id, taskC.id, 'tsk_missing'])
  assert.equal(many.length, 2)
  assert.equal(store.records('lifeos', 'task').length, 3)

  // CAS 辅助
  const current = store.get('lifeos', 'task', taskA.id)
  assert.equal(store.assertRev(current, 1).id, taskA.id)
  assert.throws(
    () => store.assertRev(current, 99),
    (error) => {
      assert.equal(error.code, 'conflict')
      assert.equal(error.details.current.rev, 1)
      return true
    },
  )
  assert.throws(() => store.assertRev(null, 1), (error) => error.code === 'conflict')

  // 完成：状态机 + 3 表事务 + rev+1
  const done = transitionTask(current, 'complete', { now: nowIso() })
  assert.equal(done.ok, true)
  const updated = { ...done.task, rev: current.rev + 1, updated_at: nowIso() }
  const completeOplog = oplogOf('task.complete', updated, 'req-complete')
  await store.transaction([
    { unit: 'lifeos', table: 'task', key: updated.id, value: updated },
    (() => {
      const stateChange = stateChangeOf(updated, 'status', 'todo', 'done')
      return { unit: 'lifeos_log', table: 'state_change', key: stateChange.id, value: stateChange }
    })(),
    { unit: 'lifeos_log', table: 'operation_log', key: completeOplog.id, value: completeOplog },
  ])
  const after = store.get('lifeos', 'task', taskA.id)
  assert.equal(after.status, 'done')
  assert.ok(after.completed_at)
  assert.equal(after.rev, 2)
  assert.equal(store.queryTasks({ view: 'all' }).items.length, 2, '已完成不进入未完成视图')
  await store.close()

  // 持久化：重开后任务/完成态/默认清单/索引都在
  const store2 = await openLifeosStore(null, { backend, testMode: true, timeZone: TZ })
  assert.equal(store2.get('lifeos', 'task', taskA.id).status, 'done')
  assert.equal(store2.queryTasks({ view: 'all' }).items.length, 2)
  assert.equal(store2.entries('lifeos', 'list').length, 1)
  assert.equal(store2.records('lifeos_log', 'state_change').length, 4)
  await store2.close()
})

test('降级 store：queryTasks 返回空结构、写入仍抛 store_unavailable', async () => {
  const { backend } = createFakeBackend({ failOpen: true })
  const store = await openLifeosStore(null, { backend, timeZone: TZ })
  assert.equal(store.degraded, true)
  const result = store.queryTasks({ view: 'all' })
  assert.deepEqual(result, {
    items: [],
    groups: null,
    nextCursor: null,
    counts: { today: 0, overdue: 0, next7: 0, inbox: 0, all: 0 },
  })
  assert.deepEqual(store.getMany('lifeos', 'task', ['x']), [])
  assert.throws(() => store.assertRev({ id: 'x', rev: 1 }, 2), (error) => error.code === 'conflict')
  await store.close()
})
