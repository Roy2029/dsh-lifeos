import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openLifeosStore, UNIT_DESCRIPTORS } from '../../../src/store/lifeos-store.js'
import { BUSINESS_TABLES, UNIT, UNIT_TABLES } from '../../../src/domain/schemas.js'
import { localDate } from '../../../src/domain/time.js'
import { createFakeBackend } from '../../unit/store/fake-backend.mjs'
import { captureOps, inboxItem, task } from '../../unit/store/fixtures.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const TZ = 'Asia/Shanghai'

test('契约：3 unit descriptor（name/layout/表集一次定全）', () => {
  assert.deepEqual(Object.keys(UNIT_DESCRIPTORS).sort(), ['lifeos', 'lifeos_log', 'lifeos_raw'])
  assert.equal(UNIT_DESCRIPTORS.lifeos.layout, 'single')
  assert.equal(UNIT_DESCRIPTORS.lifeos_raw.layout, 'per-record')
  assert.equal(UNIT_DESCRIPTORS.lifeos_log.layout, 'per-record')
  assert.equal(UNIT_DESCRIPTORS.lifeos.tables.length, 27)
  assert.deepEqual(UNIT_DESCRIPTORS.lifeos_raw.tables, ['raw_record'])
  assert.deepEqual(UNIT_DESCRIPTORS.lifeos_log.tables, ['state_change', 'operation_log', 'journal'])
  for (const [name, descriptor] of Object.entries(UNIT_DESCRIPTORS)) {
    assert.equal(descriptor.name, name)
    // M18：core unit 迁移到 schema v4（habit_group + habit.icon/group_id），raw/log 仍 v1。
    assert.equal(descriptor.version, name === 'lifeos' ? 4 : 1)
    assert.deepEqual(descriptor.compatibleVersions, name === 'lifeos' ? [1, 2, 3, 4] : [1])
    assert.equal(descriptor.hasGlobal, true)
  }
  assert.equal(BUSINESS_TABLES.length, 30)
  assert.equal(UNIT_TABLES[UNIT.CORE].length + UNIT_TABLES[UNIT.RAW].length + UNIT_TABLES[UNIT.LOG].length, 31)
})

test('open：三 unit 打开、global 初始化、app_setting 默认值', async () => {
  const { backend } = createFakeBackend()
  const store = await openLifeosStore(null, { backend, timeZone: TZ })
  const status = store.status()
  assert.equal(status.degraded, false)
  assert.equal(status.readOnly, false)
  assert.equal(status.backend, 'fake-json')
  for (const unit of ['lifeos', 'lifeos_raw', 'lifeos_log']) {
    assert.equal(status.units[unit].open, true, `${unit} 应已打开`)
  }
  assert.equal(status.units.lifeos_log.records, 0)

  assert.equal(store.get('lifeos', 'app_setting', 'timezone').value_json, TZ)
  assert.equal(store.get('lifeos', 'app_setting', 'week_start').value_json, 'monday')
  assert.equal(store.entries('lifeos', 'app_setting').length, 4)
  assert.equal(store.get('lifeos_raw', 'raw_record', 'missing'), undefined)
  await store.close()
})

test('持久化：put/close/reopen 后数据仍在；delete 后消失', async () => {
  const { backend } = createFakeBackend()
  const store1 = await openLifeosStore(null, { backend })
  const inbox = inboxItem()
  await store1.put('lifeos', 'inbox_item', inbox.id, inbox)
  await store1.close()

  const store2 = await openLifeosStore(null, { backend })
  assert.equal(store2.get('lifeos', 'inbox_item', inbox.id).title, inbox.title)
  assert.equal(store2.entries('lifeos', 'inbox_item').length, 1)
  await store2.delete('lifeos', 'inbox_item', inbox.id)
  await store2.close()

  const store3 = await openLifeosStore(null, { backend })
  assert.equal(store3.get('lifeos', 'inbox_item', inbox.id), undefined)
  await store3.close()
})

test('单开约束：第二个 store 打开同 unit → 降级 already_open；释放后可再开', async () => {
  const { backend } = createFakeBackend()
  const storeA = await openLifeosStore(null, { backend, owner: 'owner-a' })
  assert.equal(storeA.status().degraded, false)

  const storeB = await openLifeosStore(null, { backend, owner: 'owner-b' })
  assert.equal(storeB.status().degraded, true)
  assert.ok(storeB.status().errors.some((error) => error.code === 'already_open'))
  assert.equal(storeB.status().units.lifeos.open, false)

  await storeA.close()
  const storeC = await openLifeosStore(null, { backend, owner: 'owner-c' })
  assert.equal(storeC.status().degraded, false)
  await storeC.close()
})

test('降级：open 失败不抛错，返回只读门面（G6）', async () => {
  const { backend } = createFakeBackend({ failOpen: true })
  const store = await openLifeosStore(null, { backend })
  const status = store.status()
  assert.equal(status.degraded, true)
  assert.equal(status.units.lifeos.open, false)
  assert.equal(store.entries('lifeos', 'inbox_item').length, 0)
  assert.equal(store.get('lifeos', 'inbox_item', 'x'), undefined)
  await assert.rejects(
    store.put('lifeos', 'inbox_item', 'inb', { title: 'x', status: 'captured' }),
    (error) => error.code === 'store_unavailable',
  )
  await assert.rejects(store.transaction([]), (error) => error.code === 'store_unavailable')
  await store.close()
})

test('校验：不合法记录/错误 unit/未知表/严格时间格式', async () => {
  const { backend } = createFakeBackend()
  const store = await openLifeosStore(null, { backend, testMode: true })
  const inbox = inboxItem()

  await assert.rejects(
    store.put('lifeos', 'inbox_item', inbox.id, { ...inbox, status: 'nope' }),
    (error) => {
      assert.equal(error.code, 'validation_failed')
      assert.ok(error.details.errors.some((line) => line.includes('status')))
      return true
    },
  )
  await assert.rejects(
    store.put('lifeos', 'raw_record', 'rr_x', { raw_text: 'x' }),
    (error) => error.code === 'unit_mismatch',
  )
  await assert.rejects(
    store.put('lifeos', 'nope', 'x_1', { title: 'x' }),
    (error) => error.code === 'table_not_found',
  )
  await assert.rejects(
    store.put('lifeos', 'task', inbox.id, task()),
    (error) => error.code === 'validation_failed',
    'key 必须与记录 id 一致',
  )
  const rawId = 'rr_01ARZ3NDEKTSV4RRFFQ69G5FAV'
  await assert.rejects(
    store.put('lifeos_raw', 'raw_record', rawId, {
      id: rawId,
      raw_text: 'x',
      user_local_date: '2026-11-12',
      tz: TZ,
      created_at: '2026-11-12T12:00:00Z', // 缺毫秒 → 不规范
    }),
    (error) => error.code === 'validation_failed',
  )
  await store.close()
})

test('端到端：capture 事务写入 3 unit + 索引查询 + 幂等 requestId 反查', async () => {
  const { backend } = createFakeBackend()
  const store = await openLifeosStore(null, { backend, timeZone: TZ })
  const { raw, inbox, oplog, ops } = captureOps()
  await store.transaction(ops, { source: 'capture' })

  assert.equal(store.get('lifeos_raw', 'raw_record', raw.id).id, raw.id)
  assert.equal(store.entries('lifeos', 'inbox_item').length, 1)
  assert.equal(store.status().counts.inboxPending, 1)
  assert.equal(store.indexes.requestIdToOplog(oplog.idempotency_key), oplog.id)

  // 今日任务索引
  const today = localDate(TZ)
  const t1 = task({ scheduled_date: today, priority: 'high' })
  await store.put('lifeos', 'task', t1.id, t1)
  const todayResult = store.indexes.query('today')
  assert.equal(todayResult.items.length, 1)
  assert.equal(todayResult.items[0].id, t1.id)
  await store.close()
})

test('索引：rebuildIndexes 与写路径一致（journal pending 归零、收件箱计数）', async () => {
  const { backend } = createFakeBackend()
  const store = await openLifeosStore(null, { backend, testMode: true })
  const inboxA = inboxItem()
  const inboxB = inboxItem({ status: 'triaged' })
  await store.put('lifeos', 'inbox_item', inboxA.id, inboxA)
  await store.put('lifeos', 'inbox_item', inboxB.id, inboxB)
  assert.equal(store.indexes.countInboxPending(), 2)
  store.rebuildIndexes()
  assert.equal(store.indexes.countInboxPending(), 2)
  assert.equal(store.journalStatusCounts().pending, 0)
  await store.close()
})

test('ctx 解析：通过 ctx.get(\'storage\') 取 backend；loader 风格 options（timeZone/config）兼容', async () => {
  const { backend } = createFakeBackend()
  const ctx = { get: (name) => (name === 'storage' ? { backend } : undefined) }
  const store = await openLifeosStore(ctx, {
    timeZone: undefined,
    config: { timeZone: 'Asia/Shanghai' },
    diagnostics: null,
    units: {},
    logger: () => {},
    testMode: true,
  })
  assert.equal(store.status().degraded, false)
  assert.equal(store.timeZone, 'Asia/Shanghai')
  await store.close()

  // ctx 无 storage 且无 backend → 降级（不抛错）
  const noStorage = await openLifeosStore({ get: () => undefined })
  assert.equal(noStorage.status().degraded, true)
  await noStorage.close()
})

test('零依赖：src/domain 与 src/store 不得 import @deepseek-ai/*、zod 或第三方包', () => {
  const roots = [join(REPO_ROOT, 'src', 'domain'), join(REPO_ROOT, 'src', 'store')]
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full)
    }
  }
  for (const root of roots) walk(root)
  assert.ok(files.length >= 5, `应扫描到 domain/store 源文件，实际 ${files.length}`)

  const builtinPrefixes = ['node:']
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      const isImportLine = line.startsWith('import ') || (line.startsWith('export ') && line.includes(' from '))
      if (!isImportLine) continue
      const match = /from\s+['"]([^'"]+)['"]/.exec(line) ?? /import\s+['"]([^'"]+)['"]/.exec(line)
      if (!match) continue
      const specifier = match[1]
      assert.equal(specifier.startsWith('@deepseek-ai/'), false, `${file} 不得 import @deepseek-ai/*`)
      assert.notEqual(specifier, 'zod', `${file} 不得 import zod`)
      const isBuiltin = builtinPrefixes.some((prefix) => specifier.startsWith(prefix))
      const isLocal = specifier.startsWith('.') || specifier.startsWith('/')
      assert.ok(isBuiltin || isLocal, `${file} 引用了非 node: 内置模块：${specifier}`)
    }
  }
})
