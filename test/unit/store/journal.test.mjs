import test from 'node:test'
import assert from 'node:assert/strict'

import { openLifeosStore } from '../../../src/store/lifeos-store.js'
import { newId } from '../../../src/domain/ids.js'
import { nowIso } from '../../../src/domain/time.js'
import { createFakeBackend, writeRaw } from './fake-backend.mjs'
import { captureOps, inboxItem, operationLog, rawRecord } from './fixtures.mjs'

async function openTestStore(backend) {
  return openLifeosStore(null, { backend, testMode: true })
}

test('journal：跨 unit 事务按 ops 顺序 apply，journal pending→committed', async () => {
  const { backend, state } = createFakeBackend()
  const store = await openTestStore(backend)
  assert.equal(store.status().degraded, false)

  const { raw, inbox, oplog, ops } = captureOps({ oplog: operationLog('req-cross-unit') })
  const mark = state.writeLog.length
  const result = await store.transaction(ops, { source: 'test', intent: { action: 'inbox.capture' } })
  assert.equal(result.applied, 3)
  assert.ok(result.journalId.startsWith('jrn_'))

  const appliedOrder = state.writeLog
    .slice(mark)
    .filter((w) => w.table !== 'journal')
    .map((w) => w.table)
  assert.deepEqual(appliedOrder, ['raw_record', 'inbox_item', 'operation_log'], '跨 unit 顺序必须与 ops 一致')

  assert.equal(store.get('lifeos_raw', 'raw_record', raw.id).raw_text, raw.raw_text)
  assert.equal(store.get('lifeos', 'inbox_item', inbox.id).title, inbox.title)
  assert.equal(store.get('lifeos_log', 'operation_log', oplog.id).action, oplog.action)
  assert.deepEqual(store.journalStatusCounts(), { pending: 0, committed: 1, failed: 0 })

  const journals = store.entries('lifeos_log', 'journal').map(([, record]) => record)
  assert.equal(journals[0].status, 'committed')
  assert.equal(journals[0].result, undefined) // 非必需字段
  await store.close()
})

test('journal：中途崩溃（第 2 个 op 抛错）→ 留 pending，重启重放自愈且幂等', async () => {
  const { backend, state } = createFakeBackend()
  const store = await openTestStore(backend)

  const { raw, inbox, oplog, ops } = captureOps({ oplog: operationLog('req-crash') })
  const putsBefore = state.puts
  state.failPutAt = putsBefore + 3 // journal(1) + raw(2) ok，inbox(3) 失败

  await assert.rejects(store.transaction(ops), (error) => {
    assert.equal(error.code, 'store_commit_failed')
    assert.ok(error.details.journalId)
    return true
  })

  // journal 保持 pending；第一个 op 已落盘，后续未落
  const pendingBeforeRestart = store.entries('lifeos_log', 'journal').map(([, record]) => record)
  assert.equal(pendingBeforeRestart.filter((j) => j.status === 'pending').length, 1)
  assert.ok(store.get('lifeos_raw', 'raw_record', raw.id), '第 1 个 op 应已生效')
  assert.equal(store.get('lifeos', 'inbox_item', inbox.id), undefined, '第 2 个 op 应未生效')
  await store.close()

  state.failPutAt = null // 模拟"崩溃后磁盘恢复"
  const store2 = await openTestStore(backend)
  assert.equal(store2.status().degraded, false)
  assert.deepEqual(store2.journalStatusCounts().pending, 0, '启动恢复后不应残留 pending')
  assert.equal(store2.journalStatusCounts().failed, 0)
  assert.ok(store2.get('lifeos_raw', 'raw_record', raw.id))
  assert.ok(store2.get('lifeos', 'inbox_item', inbox.id))
  assert.ok(store2.get('lifeos_log', 'operation_log', oplog.id))

  const again = await store2.recoverJournal()
  assert.deepEqual(again, { replayed: 0, rolledBack: 0, failed: 0 }, '已 committed，不重复重放')
  assert.equal(store2.entries('lifeos_raw', 'raw_record').length, 1, '重放不得重复创建')
  await store2.close()
})

test('journal：手工 pending journal 重放幂等（重复打开仍只有 1 份数据）', async () => {
  const { backend } = createFakeBackend()
  const store = await openTestStore(backend)
  const raw = rawRecord()
  const journalId = newId('jrn')
  await store.put('lifeos_log', 'journal', journalId, {
    id: journalId,
    status: 'pending',
    ops: [{ unit: 'lifeos_raw', table: 'raw_record', key: raw.id, value: raw }],
    createdAt: nowIso(),
  })
  assert.equal(store.journalStatusCounts().pending, 1)
  await store.close()

  const store2 = await openTestStore(backend)
  assert.equal(store2.journalStatusCounts().pending, 0)
  assert.equal(store2.journalStatusCounts().committed, 1)
  assert.equal(store2.entries('lifeos_raw', 'raw_record').length, 1)
  await store2.close()

  const store3 = await openTestStore(backend)
  assert.equal(store3.entries('lifeos_raw', 'raw_record').length, 1, '再次打开不得重复写入')
  assert.equal((await store3.recoverJournal()).replayed, 0)
  await store3.close()
})

test('journal：ops 的 unit/表 不合法时拒绝（不写 journal）', async () => {
  const { backend, state } = createFakeBackend()
  const store = await openTestStore(backend)
  const raw = rawRecord()
  const putsBefore = state.puts

  await assert.rejects(
    store.transaction([{ unit: 'lifeos', table: 'raw_record', key: raw.id, value: raw }]),
    (error) => error.code === 'unit_mismatch',
  )
  await assert.rejects(
    store.transaction([{ unit: 'lifeos', table: 'nope', key: raw.id, value: raw }]),
    (error) => error.code === 'table_not_found',
  )
  assert.equal(state.puts, putsBefore, '非法事务不得产生任何写入')
  assert.deepEqual(store.journalStatusCounts(), { pending: 0, committed: 0, failed: 0 })
  await store.close()
})

test('journal：损坏记录 → 标 failed 并进入只读降级', async () => {
  const { backend, data } = createFakeBackend()
  const store = await openTestStore(backend)
  const journalId = newId('jrn')
  // 直接向 fake 落盘注入损坏 journal（模拟文件损坏/半写）
  writeRaw(data, 'lifeos_log', 'journal', journalId, {
    id: journalId,
    status: 'pending',
    ops: 'BROKEN',
    createdAt: nowIso(),
  })
  await store.close()

  const store2 = await openTestStore(backend)
  assert.equal(store2.status().readOnly, true, '损坏 journal 应进入只读')
  assert.equal(store2.journalStatusCounts().failed, 1)
  await assert.rejects(
    store2.transaction([...captureOps().ops]),
    (error) => error.code === 'store_readonly',
  )
  assert.ok(store2.status().errors.some((error) => error.code === 'journal_corrupted'))
  await store2.close()
})

test('journal：committed 保留最近 100 条（FIFO 裁剪）', async () => {
  const { backend } = createFakeBackend()
  const store = await openTestStore(backend)
  for (let i = 0; i < 105; i++) {
    const raw = rawRecord()
    await store.transaction([{ unit: 'lifeos_raw', table: 'raw_record', key: raw.id, value: raw }])
  }
  const committed = store.entries('lifeos_log', 'journal').filter(([, record]) => record.status === 'committed')
  assert.equal(committed.length, 100)
  await store.close()
})
