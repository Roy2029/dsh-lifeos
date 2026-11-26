/**
 * M8 spike：schema v3 迁移（JSON 文件后端语义复刻，从 M6a 的 v2 测试演进）。
 *
 * 这份假后端严格按 DSH `@deepseek-ai/dsh-storage-json` 的真实行为实现：
 * - 数据文件 `<root>/<unit>.json`，形状 `{unit:{name,version},global,tables}`；
 * - 打开时若文件 version 不在 descriptor.version / compatibleVersions 内 → version-mismatch；
 * - 只装载 descriptor.tables 声明的表（缺表=空表；文件里未知表被忽略）；
 * - 打开本身不写文件；首次 setGlobal/putRecord 整文件原子写，并盖上 descriptor.version。
 *
 * M8 验收（task-47）：v1/v2 旧文件可读、task.repeat_rule 可写、迁移备份 `lifeos.json.bak-m8-*`
 * 生成且轮转保留 5 份、二次打开 skipped/up-to-date、备份失败时中止且不改坏数据。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openLifeosStore } from '../../../src/store/lifeos-store.js'
import { newId } from '../../../src/domain/ids.js'

const TZ = 'Asia/Shanghai'
const NOW = '2026-11-18T00:00:00.000Z'
const STAMP = '20261118T000000Z'

class FileStorageError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'FileStorageError'
    this.code = code
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function readUnitVersion(text) {
  return JSON.parse(text).unit.version
}

/**
 * 与 dsh-storage-json 等价的单文件 unit。state.version 在 open 时被描述符版本覆盖，
 * 因此首次写盘即把旧文件盖成 v3（旧 reader 之后会拒绝，回滚只能靠备份）。
 */
async function openFileUnit(root, descriptor) {
  const file = join(root, `${descriptor.name}.json`)
  const tables = new Map()
  let version = descriptor.version
  let global = null
  let loaded = false
  try {
    const text = await readFile(file, 'utf8')
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new FileStorageError('malformed', `unit ${descriptor.name} 数据损坏`)
    }
    if (!parsed || parsed.unit?.name !== descriptor.name) {
      throw new FileStorageError('malformed', `unit ${descriptor.name} 名称不匹配`)
    }
    const onDisk = Number(parsed.unit.version)
    const compatible = Array.isArray(descriptor.compatibleVersions) ? descriptor.compatibleVersions : []
    if (onDisk !== descriptor.version && !compatible.includes(onDisk)) {
      throw new FileStorageError(
        'version-mismatch',
        `unit ${descriptor.name} 版本 ${onDisk} 与描述符 ${descriptor.version} 不兼容`,
      )
    }
    if (!parsed.tables || typeof parsed.tables !== 'object') {
      throw new FileStorageError('malformed', `unit ${descriptor.name} tables 缺失`)
    }
    version = descriptor.version
    global = parsed.global ?? null
    for (const table of descriptor.tables) {
      const raw = parsed.tables[table]
      tables.set(table, new Map(raw && typeof raw === 'object' ? Object.entries(raw) : []))
    }
    loaded = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    for (const table of descriptor.tables) tables.set(table, new Map())
  }

  async function persist() {
    const serializedTables = {}
    for (const [table, map] of tables) serializedTables[table] = Object.fromEntries(map)
    const payload = { unit: { name: descriptor.name, version }, global, tables: serializedTables }
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
    await writeFile(tmp, JSON.stringify(payload))
    const { rename } = await import('node:fs/promises')
    await rename(tmp, file)
  }

  function tableOf(table) {
    const map = tables.get(table)
    if (!map) throw new FileStorageError('table-not-found', `unit ${descriptor.name} 未声明表 ${table}`)
    return map
  }

  return {
    descriptor,
    loaded,
    file,
    async loadAll() {
      const out = {}
      for (const [table, map] of tables) out[table] = Object.fromEntries(map)
      return { tables: out, global: clone(global) }
    },
    async putRecord(table, key, record) {
      tableOf(table).set(key, clone(record))
      await persist()
    },
    async deleteRecord(table, key) {
      tableOf(table).delete(key)
      await persist()
    },
    async deleteRecords(table, keys) {
      const map = tableOf(table)
      for (const key of keys ?? []) map.delete(key)
      await persist()
    },
    async setGlobal(value) {
      global = clone(value)
      await persist()
    },
    async close() {},
  }
}

function createFileBackend(root) {
  return {
    name: 'json',
    root,
    kv: {
      async open(descriptor) {
        return openFileUnit(root, descriptor)
      },
    },
  }
}

function fixtureTask(overrides = {}) {
  const id = overrides.id ?? newId('tsk')
  return {
    id,
    title: '迁移前的旧任务',
    status: 'todo',
    priority: 'none',
    time_kind: 'none',
    work_kind: 'action',
    sort_order: 0,
    list_id: null,
    parent_task_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    rev: 1,
    schema_version: 1,
    ...overrides,
  }
}

/** 写一份指定 unit/global 版本的旧数据文件（v1 或 v2 迁移前形态）。 */
async function writeFixtureFile(dir, { unitVersion = 1, globalVersion = unitVersion, taskRecord = fixtureTask(), backups = [] } = {}) {
  const file = join(dir, 'lifeos.json')
  const payload = {
    unit: { name: 'lifeos', version: unitVersion },
    global: { schema_version: globalVersion, timezone: TZ, week_start: 'monday', created_at: '2026-01-01T00:00:00.000Z' },
    tables: {
      task: { [taskRecord.id]: taskRecord },
      app_setting: {
        timezone: { key: 'timezone', value_json: TZ, updated_at: '2026-01-01T00:00:00.000Z' },
        week_start: { key: 'week_start', value_json: 'monday', updated_at: '2026-01-01T00:00:00.000Z' },
      },
    },
  }
  await writeFile(file, JSON.stringify(payload))
  for (const name of backups) {
    await writeFile(
      join(dir, name),
      JSON.stringify({ unit: { name: 'lifeos', version: unitVersion }, global: null, tables: {} }),
    )
  }
  return file
}

async function makeDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lifeos-m8-migrate-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

test('迁移 spike：v1 文件 → 备份 bak-m8、schemaVersion 4、旧记录可读、repeat_rule 可写、重开正常', async (t) => {
  const dir = await makeDir(t)
  const oldTask = fixtureTask()
  const file = await writeFixtureFile(dir, { unitVersion: 1, taskRecord: oldTask })

  const store = await openLifeosStore(null, {
    backend: createFileBackend(dir),
    timeZone: TZ,
    testMode: true,
    now: NOW,
  })
  assert.equal(store.status().degraded, false)
  assert.equal(store.status().schemaVersion, 4)
  const migration = store.status().migration
  assert.equal(migration.status, 'completed')
  assert.equal(migration.fromVersion, 1)
  assert.equal(migration.toVersion, 4)
  assert.ok(migration.backupPath, '应生成迁移备份')
  assert.ok(migration.backupPath.startsWith(join(dir, 'lifeos.json.bak-m8-')), migration.backupPath)

  // 备份内容必须仍是迁移前的 v1 原样数据。
  const backupText = await readFile(migration.backupPath, 'utf8')
  assert.equal(readUnitVersion(backupText), 1)
  assert.equal(JSON.parse(backupText).tables.task[oldTask.id].title, oldTask.title)

  // 旧记录可读（v1 记录没有 repeat_rule）。
  const loaded = store.get('lifeos', 'task', oldTask.id)
  assert.ok(loaded)
  assert.equal(loaded.title, oldTask.title)
  assert.equal(loaded.repeat_rule, undefined)

  // 新字段 repeat_rule 可写（v3 语义：weekly 去重升序；此处直接写归一后的存储形态）。
  await store.put('lifeos', 'task', oldTask.id, {
    ...loaded,
    repeat_rule: { kind: 'weekly', days: [1, 3] },
    updated_at: NOW,
    rev: 2,
  })
  assert.deepEqual(store.get('lifeos', 'task', oldTask.id).repeat_rule, { kind: 'weekly', days: [1, 3] })

  // 新表 group 仍可写（v1 文件里不存在该表 → 空表；防止 v2 迁移能力回退）。
  const listId = newId('lst')
  const groupId = newId('grp')
  await store.put('lifeos', 'list', listId, { id: listId, name: '工作', kind: 'normal' })
  await store.put('lifeos', 'group', groupId, { id: groupId, list_id: listId, name: '本周' })
  assert.equal(store.get('lifeos', 'group', groupId).name, '本周')

  await store.close()

  // 首次写后文件 stamp 已经是 4。
  assert.equal(readUnitVersion(await readFile(file, 'utf8')), 4)

  // 重开（v4 描述符）→ 旧记录、repeat_rule、新表数据都在。
  const reopened = await openLifeosStore(null, {
    backend: createFileBackend(dir),
    timeZone: TZ,
    testMode: true,
    now: NOW,
  })
  assert.equal(reopened.status().degraded, false)
  assert.equal(reopened.status().migration.status, 'none')
  assert.equal(reopened.status().migration.skipped, 'up-to-date')
  assert.equal(reopened.get('lifeos', 'task', oldTask.id).title, oldTask.title)
  assert.deepEqual(reopened.get('lifeos', 'task', oldTask.id).repeat_rule, { kind: 'weekly', days: [1, 3] })
  assert.equal(reopened.get('lifeos', 'group', groupId).name, '本周')
  await reopened.close()
})

test('迁移 spike：v2 文件 → 备份 bak-m8、fromVersion 2、旧字段可读、repeat_rule 可写、二次打开 skipped', async (t) => {
  const dir = await makeDir(t)
  const oldTask = fixtureTask({
    title: 'v2 旧任务',
    group_id: null,
    pinned: false,
    schema_version: 2,
  })
  const file = await writeFixtureFile(dir, { unitVersion: 2, globalVersion: 2, taskRecord: oldTask })

  const store = await openLifeosStore(null, {
    backend: createFileBackend(dir),
    timeZone: TZ,
    testMode: true,
    now: NOW,
  })
  assert.equal(store.status().degraded, false)
  assert.equal(store.status().schemaVersion, 4)
  const migration = store.status().migration
  assert.equal(migration.status, 'completed')
  assert.equal(migration.fromVersion, 2)
  assert.equal(migration.toVersion, 4)
  assert.ok(migration.backupPath.startsWith(join(dir, 'lifeos.json.bak-m8-')), migration.backupPath)

  // 备份是 v2 原样文件。
  const backupText = await readFile(migration.backupPath, 'utf8')
  assert.equal(readUnitVersion(backupText), 2)
  assert.equal(JSON.parse(backupText).global.schema_version, 2)
  assert.equal(JSON.parse(backupText).tables.task[oldTask.id].title, oldTask.title)

  // 旧记录（v2 字段）可读；repeat_rule 未设置。
  const loaded = store.get('lifeos', 'task', oldTask.id)
  assert.equal(loaded.title, oldTask.title)
  assert.equal(loaded.pinned, false)
  assert.equal(loaded.repeat_rule, undefined)

  // 写入 v4 新字段后持久化。
  await store.put('lifeos', 'task', oldTask.id, {
    ...loaded,
    repeat_rule: { kind: 'monthly', day: 15 },
    updated_at: NOW,
    rev: 2,
  })
  await store.close()
  assert.equal(readUnitVersion(await readFile(file, 'utf8')), 4)

  const reopened = await openLifeosStore(null, {
    backend: createFileBackend(dir),
    timeZone: TZ,
    testMode: true,
    now: NOW,
  })
  assert.equal(reopened.status().degraded, false)
  assert.equal(reopened.status().migration.status, 'none')
  assert.equal(reopened.status().migration.skipped, 'up-to-date')
  assert.deepEqual(reopened.get('lifeos', 'task', oldTask.id).repeat_rule, { kind: 'monthly', day: 15 })
  await reopened.close()
})

test('迁移备份轮转：只保留最近 5 份 bak-m8-*，最新的等于迁移前文件', async (t) => {
  const dir = await makeDir(t)
  const backups = [
    'lifeos.json.bak-m8-20260101T000000Z',
    'lifeos.json.bak-m8-20260102T000000Z',
    'lifeos.json.bak-m8-20260103T000000Z',
    'lifeos.json.bak-m8-20260104T000000Z',
    'lifeos.json.bak-m8-20260105T000000Z',
    'lifeos.json.bak-m8-20260106T000000Z',
  ]
  await writeFixtureFile(dir, { unitVersion: 2, globalVersion: 2, backups })
  const store = await openLifeosStore(null, {
    backend: createFileBackend(dir),
    timeZone: TZ,
    testMode: true,
    now: NOW,
  })
  const migration = store.status().migration
  assert.equal(migration.status, 'completed')
  assert.equal(migration.retained.length, 2)
  await store.close()

  const names = (await readdir(dir)).filter((name) => name.startsWith('lifeos.json.bak-m8-'))
  assert.equal(names.length, 5)
  assert.ok(names.includes(`lifeos.json.bak-m8-${STAMP}`), names.join(','))
  assert.equal(names.includes('lifeos.json.bak-m8-20260101T000000Z'), false)
  const latest = JSON.parse(await readFile(join(dir, `lifeos.json.bak-m8-${STAMP}`), 'utf8'))
  assert.equal(latest.unit.version, 2)
})

test('回滚：v3 stamp 被 v2 reader 拒绝；用备份恢复后 v2 reader 仍能读旧数据', async (t) => {
  const dir = await makeDir(t)
  const oldTask = fixtureTask({ title: '回滚前旧任务', group_id: 'grp_x', pinned: true, schema_version: 2 })
  await writeFixtureFile(dir, { unitVersion: 2, globalVersion: 2, taskRecord: oldTask })
  const store = await openLifeosStore(null, {
    backend: createFileBackend(dir),
    timeZone: TZ,
    testMode: true,
    now: NOW,
  })
  const backupPath = store.status().migration.backupPath
  const listId = newId('lst')
  await store.put('lifeos', 'list', listId, { id: listId, name: '工作', kind: 'normal' })
  await store.close()

  // 旧 reader（v3 描述符）拒绝 v4 stamp。
  const oldDescriptor = { name: 'lifeos', version: 3, compatibleVersions: [1, 2, 3], tables: ['task'] }
  await assert.rejects(
    () => openFileUnit(dir, oldDescriptor),
    (error) => error?.code === 'version-mismatch',
  )

  // 用迁移备份覆盖文件 → 旧 reader 恢复可读，旧数据不丢。
  const file = join(dir, 'lifeos.json')
  await copyFile(backupPath, file)
  const unit = await openFileUnit(dir, oldDescriptor)
  const loaded = await unit.loadAll()
  assert.equal(loaded.tables.task[oldTask.id].title, oldTask.title)
  assert.equal(loaded.tables.task[oldTask.id].pinned, true)
  assert.equal(readUnitVersion(await readFile(file, 'utf8')), 2)
})

test('新库首次打开：无旧文件 → 不备份、直接以 v4 落盘', async (t) => {
  const dir = await makeDir(t)
  const store = await openLifeosStore(null, {
    backend: createFileBackend(dir),
    timeZone: TZ,
    testMode: true,
    now: NOW,
  })
  assert.equal(store.status().degraded, false)
  const migration = store.status().migration
  assert.equal(migration.status, 'none')
  assert.equal(migration.skipped, 'no-data-file')
  assert.equal(store.status().schemaVersion, 4)
  await store.close()
  assert.equal(readUnitVersion(await readFile(join(dir, 'lifeos.json'), 'utf8')), 4)
})

test('v3 → v4：旧 habit 无 icon/group_id 仍可读，habit_group 可写，二次打开 skipped', async (t) => {
  const dir = await makeDir(t)
  const habitId = newId('hab')
  const oldHabit = {
    id: habitId,
    name: '晨间拉伸',
    status: 'active',
    frequency_rule: { kind: 'daily' },
    checkin_mode: 'either',
    sort_order: 0,
    start_date: '2026-01-01',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    rev: 1,
    schema_version: 3,
  }
  const file = join(dir, 'lifeos.json')
  await writeFile(
    file,
    JSON.stringify({
      unit: { name: 'lifeos', version: 3 },
      global: { schema_version: 3, timezone: TZ, week_start: 'monday', created_at: '2026-01-01T00:00:00.000Z' },
      tables: { habit: { [habitId]: oldHabit } },
    }),
  )

  const store = await openLifeosStore(null, {
    backend: createFileBackend(dir),
    timeZone: TZ,
    testMode: true,
    now: NOW,
  })
  assert.equal(store.status().degraded, false)
  assert.equal(store.status().schemaVersion, 4)
  const migration = store.status().migration
  assert.equal(migration.status, 'completed')
  assert.equal(migration.fromVersion, 3)
  assert.equal(migration.toVersion, 4)
  // 备份是 v3 原样文件（迁移前数据无损）。
  const backupText = await readFile(migration.backupPath, 'utf8')
  assert.equal(readUnitVersion(backupText), 3)
  assert.equal(JSON.parse(backupText).tables.habit[habitId].name, '晨间拉伸')

  // 旧 habit 可读：没有 icon/group_id 不崩，语义为「按名称推导 + 未分组」。
  const loaded = store.get('lifeos', 'habit', habitId)
  assert.equal(loaded.name, '晨间拉伸')
  assert.equal(loaded.icon, undefined)
  assert.equal(loaded.group_id, undefined)

  // v4 新表 habit_group 可写，habit 可写入 icon/group_id。
  const groupId = newId('hgrp')
  await store.put('lifeos', 'habit_group', groupId, { id: groupId, name: '清晨' })
  assert.equal(store.get('lifeos', 'habit_group', groupId).name, '清晨')
  await store.put('lifeos', 'habit', habitId, {
    ...loaded,
    icon: '🌅',
    group_id: groupId,
    updated_at: NOW,
    rev: 2,
  })
  assert.equal(store.get('lifeos', 'habit', habitId).icon, '🌅')
  assert.equal(store.get('lifeos', 'habit', habitId).group_id, groupId)
  await store.close()
  assert.equal(readUnitVersion(await readFile(file, 'utf8')), 4)

  // 幂等：二次打开不再迁移，数据都在。
  const reopened = await openLifeosStore(null, {
    backend: createFileBackend(dir),
    timeZone: TZ,
    testMode: true,
    now: NOW,
  })
  assert.equal(reopened.status().migration.status, 'none')
  assert.equal(reopened.status().migration.skipped, 'up-to-date')
  assert.equal(reopened.get('lifeos', 'habit', habitId).icon, '🌅')
  assert.equal(reopened.get('lifeos', 'habit_group', groupId).name, '清晨')
  await reopened.close()
})

test('备份失败必须中止迁移：数据文件保持 v2 原样、store 只读降级', async (t) => {
  const dir = await makeDir(t)
  const oldTask = fixtureTask({ title: '备份失败时不得改动', schema_version: 2 })
  const file = await writeFixtureFile(dir, { unitVersion: 2, globalVersion: 2, taskRecord: oldTask })
  const before = await readFile(file, 'utf8')

  // 在唯一备份路径上放一个目录 → uniqueBackupPath 的 readFile 探测失败 → 迁移备份抛错。
  await mkdir(join(dir, `lifeos.json.bak-m8-${STAMP}`), { recursive: true })

  const store = await openLifeosStore(null, {
    backend: createFileBackend(dir),
    timeZone: TZ,
    testMode: true,
    now: NOW,
  })
  assert.equal(store.status().degraded, true, '备份失败后 store 必须降级（只读）')

  // 数据文件一个字节都没变（仍是 v2，旧数据完整）。
  const after = await readFile(file, 'utf8')
  assert.equal(after, before)
  assert.equal(readUnitVersion(after), 2)
  assert.equal(JSON.parse(after).global.schema_version, 2)
  assert.equal(JSON.parse(after).tables.task[oldTask.id].title, oldTask.title)
})
