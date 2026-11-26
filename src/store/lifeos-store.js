/**
 * LifeOS — 3 unit kv 存储门面（A 线）
 *
 * 冻结契约：M0-PLAN §3.4 / §3.5；分存：design/08 §4（lifeos single / lifeos_raw per-record / lifeos_log per-record）。
 *
 * 设计要点：
 * - 零 `@deepseek-ai/*` / 零第三方依赖；只通过 `ctx.get('storage')`（或注入的 fake backend）拿低层 kv。
 * - `openLifeosStore(ctx, options)` **永不 throw 到宿主**：任何 open 失败都返回降级只读门面（G6）。
 * - 写路径：`put/delete` 低层直写（用于 seed/测试/非事务写）；业务写走 `transaction(ops)` = journal-first。
 * - journal 覆盖跨 unit 写；启动 `recoverJournal()` 幂等重放 pending；损坏 journal → failed + 只读降级。
 * - 单开约束：同一进程内同一 unit 只允许一个 owner 打开（测试可用 testMode 跳过）。
 */

import { copyFile, readdir, readFile, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { newId } from '../domain/ids.js'
import { nowIso } from '../domain/time.js'
import {
  JOURNAL_TABLE,
  TABLE_SPECS,
  UNIT,
  UNIT_NAMES,
  UNIT_TABLES,
  isKnownTable,
  normalizeRecord,
  unitOf,
  validateRecord,
} from '../domain/schemas.js'
import { StoreError, STORE_ERROR_CODES as CODES } from './errors.js'
import { createIndexes } from './indexes.js'

const UNIT_LAYOUT = Object.freeze({
  [UNIT.CORE]: 'single',
  [UNIT.RAW]: 'per-record',
  [UNIT.LOG]: 'per-record',
})

/**
 * M8 schema v3：CORE 从 2 → 3（task 新增可空 repeat_rule 重复规则字段）。
 * raw/log unit 结构未变，保持 1。
 * JSON 后端用 `version === descriptor.version || compatibleVersions.includes(version)` 判断兼容，
 * 所以现有 v1/v2 数据文件可无痛打开，首次写入时原子盖上 version=3。
 * 注：M8 按 task-47 契约把当前版本也列入 compatibleVersions（JSON 判断下冗余无害）；
 * 历史注释要求只列旧版本，此处保留任务契约原文以与 Lead/task 描述一致。
 */
/**
 * M18 schema v4：CORE 从 3 → 4（new habit_group 表 + habit.icon/habit.group_id 可空字段）。
 * raw/log unit 结构未变，保持 1。
 * JSON 后端用 `version === descriptor.version || compatibleVersions.includes(version)` 判断兼容，
 * 所以现有 v1/v2/v3 数据文件可无痛打开，首次写入时原子盖上 version=4。
 * 注：沿用 M8 约定把当前版本也列入 compatibleVersions（JSON 判断下冗余无害）。
 */
export const UNIT_SCHEMA_VERSION = Object.freeze({ [UNIT.CORE]: 4, [UNIT.RAW]: 1, [UNIT.LOG]: 1 })

const UNIT_VERSION = UNIT_SCHEMA_VERSION

/** 每个 unit 可兼容读取的版本号（M18：CORE 列 [1,2,3,4]；其余 unit 仍不含当前版本）。 */
const UNIT_COMPATIBLE = Object.freeze({
  [UNIT.CORE]: Object.freeze([1, 2, 3, 4]),
  [UNIT.RAW]: Object.freeze([1]),
  [UNIT.LOG]: Object.freeze([1]),
})

/** M8 迁移备份：`lifeos.json.bak-m8-<UTC时间戳>`，保留最近 5 份。 */
export const MIGRATION_BACKUP_RETAIN = 5
const BAK_PREFIX = `${UNIT.CORE}.json.bak-m8-`
export const MIGRATION_BACKUP_RE = new RegExp(`^${UNIT.CORE.replace('.', '\\.')}\\.json\\.bak-m8-`)

/** 三 unit 的 descriptor（表名一次定全）。 */
export const UNIT_DESCRIPTORS = Object.freeze(
  Object.fromEntries(
    UNIT_NAMES.map((unit) => [
      unit,
      Object.freeze({
        name: unit,
        version: UNIT_VERSION[unit],
        layout: UNIT_LAYOUT[unit],
        hasGlobal: true,
        compatibleVersions: Object.freeze([...UNIT_COMPATIBLE[unit]]),
        tables: Object.freeze([...UNIT_TABLES[unit]]),
      }),
    ]),
  ),
)

const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/
const TABLE_NAME_RE = /^[a-z][a-z0-9_]*$/
const JOURNAL_RETAIN_COMMITTED = 100

/** 进程内单开登记：unit 名 → owner token */
const OPEN_UNITS = new Map()

function cloneJson(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从 ctx 上取宿主 storage 服务（Cordis：ctx.get('storage')；同时兼容直接属性）。 */
export function resolveStorage(ctx) {
  if (!ctx || typeof ctx !== 'object') return null
  if (typeof ctx.get === 'function') {
    try {
      const storage = ctx.get('storage')
      if (storage) return storage
    } catch {
      /* 服务未注册：继续尝试属性访问 */
    }
  }
  return ctx.storage ?? null
}

/**
 * 从 backend 注册表挑一个带 kv facet 的后端。
 * @returns {{name: string, backend: any}}
 */
export function pickBackend(storage) {
  const registry = storage?.backend
  if (!registry || typeof registry.get !== 'function') {
    throw new StoreError(CODES.STORE_UNAVAILABLE, 'storage 服务没有 backend 注册表')
  }
  const usable = (name) => {
    try {
      const backend = registry.get(name)
      if (backend && typeof backend.kv?.open === 'function') return { name, backend }
    } catch {
      /* 名字不存在时 get 可能抛错，继续 */
    }
    return null
  }
  for (const preferred of ['json', 'storage-json', 'default']) {
    const hit = usable(preferred)
    if (hit) return hit
  }
  let names = []
  try {
    names = typeof registry.names === 'function' ? registry.names() : []
  } catch {
    names = []
  }
  for (const name of names) {
    const hit = usable(name)
    if (hit) return hit
  }
  throw new StoreError(CODES.STORE_UNAVAILABLE, `没有可用的 kv 后端（已注册：${names.join(', ') || '未知'}）`)
}

/** descriptor 字段容忍度：逐级降级尝试（不同 storage 版本字段可选）。 */
function descriptorVariants(descriptor) {
  const base = {
    name: descriptor.name,
    version: descriptor.version,
    tables: [...descriptor.tables],
    hasGlobal: descriptor.hasGlobal,
  }
  return [
    { ...base, layout: descriptor.layout, compatibleVersions: [...descriptor.compatibleVersions] },
    { ...base, layout: descriptor.layout },
    { ...base, compatibleVersions: [...descriptor.compatibleVersions] },
    base,
  ]
}

/**
 * 从 JSON 后端实例上取存储根目录（DSH 的 JsonStorageBackend 把 root 放在实例字段；
 * 同时兼容 config/options/storageRoot 等派生形态）。拿不到（内存/fake 后端）返回 null。
 */
export function jsonBackendRoot(backend) {
  if (!backend || typeof backend !== 'object') return null
  const candidates = [backend.root, backend.config?.root, backend.options?.root, backend.storageRoot]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return null
}

/** ISO 时间 → 文件名安全的时间戳（20261118T013000Z）。 */
function backupTimestamp(isoValue) {
  const text = typeof isoValue === 'string' ? isoValue : new Date(isoValue ?? Date.now()).toISOString()
  return text.replace(/[-:]/g, '').replace(/\.(\d+)Z$/, 'Z')
}

/** `<file>.bak-m8-<stamp>`（同秒冲突时追加 -1/-2…）。 */
async function uniqueBackupPath(file, stamp) {
  const base = `${file}.bak-m8-${stamp}`
  let candidate = base
  for (let index = 1; index <= 99; index += 1) {
    try {
      await readFile(candidate)
      candidate = `${base}-${index}`
    } catch (error) {
      if (error?.code === 'ENOENT') return candidate
      throw error
    }
  }
  throw new Error(`无法为 ${file} 生成唯一迁移备份文件名`)
}

/** 只保留最新 retain 份 `lifeos.json.bak-m8-*`，返回被清理的文件名。 */
async function pruneMigrationBackups(root, retain = MIGRATION_BACKUP_RETAIN) {
  const removed = []
  let names = []
  try {
    names = await readdir(root)
  } catch {
    return removed
  }
  const backups = names
    .filter((name) => MIGRATION_BACKUP_RE.test(name))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  for (const name of backups.slice(Math.max(0, retain))) {
    try {
      await unlink(join(root, name))
      removed.push(name)
    } catch {
      /* 轮转失败不阻塞迁移（备份主文件已成功） */
    }
  }
  return removed
}

function validateDescriptor(descriptor) {  if (!descriptor || typeof descriptor !== 'object') throw new Error('descriptor 必须是对象')
  if (typeof descriptor.name !== 'string' || !UNIT_NAME_RE.test(descriptor.name)) {
    throw new Error(`unit 名不合法：${String(descriptor.name)}`)
  }
  if (!Array.isArray(descriptor.tables) || descriptor.tables.length === 0) {
    throw new Error('descriptor.tables 必须是非空数组')
  }
  const seen = new Set()
  for (const table of descriptor.tables) {
    if (typeof table !== 'string' || !TABLE_NAME_RE.test(table)) {
      throw new Error(`表名不合法：${String(table)}`)
    }
    if (seen.has(table)) throw new Error(`descriptor.tables 重复：${table}`)
    seen.add(table)
  }
}

function assertUnitObject(unit) {
  for (const fn of ['loadAll', 'putRecord', 'deleteRecord', 'setGlobal', 'close']) {
    if (typeof unit?.[fn] !== 'function') throw new Error(`kv unit 缺少方法：${fn}`)
  }
}

async function openUnit(backend, descriptor) {
  validateDescriptor(descriptor)
  let lastError
  for (const variant of descriptorVariants(descriptor)) {
    try {
      const unit = await backend.kv.open(variant)
      assertUnitObject(unit)
      return unit
    } catch (error) {
      lastError = error
    }
  }
  throw new StoreError(
    CODES.STORE_UNAVAILABLE,
    `打开 unit ${descriptor.name} 失败：${lastError?.message ?? lastError}`,
    { unit: descriptor.name },
  )
}

function emptyMemory() {
  const memory = {}
  for (const unit of UNIT_NAMES) {
    memory[unit] = new Map()
    for (const table of UNIT_TABLES[unit]) memory[unit].set(table, new Map())
  }
  return memory
}

/**
 * 打开 LifeOS 存储门面。**不会 throw**：失败时返回降级门面（status().degraded === true）。
 * @param {object|null} ctx Cordis 插件上下文（或含 storage 的对象；测试可传 null + options.backend）
 * @param {{timeZone?: string, backend?: any, testMode?: boolean, seed?: boolean, owner?: string, now?: string|(()=>string)}} [options]
 * @returns {Promise<LifeosStore>}
 */
export async function openLifeosStore(ctx, options = {}) {
  const store = new LifeosStore(ctx, options)
  try {
    await store.open()
  } catch (error) {
    store._markDegraded(error)
  }
  return store
}

export class LifeosStore {
  /**
   * @param {object|null} ctx
   * @param {object} [options]
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx ?? null
    this.options = {
      timeZone: 'Asia/Shanghai',
      backend: null,
      testMode: false,
      seed: true,
      owner: null,
      now: null,
      ...options,
    }
    const requestedTimeZone = this.options.timeZone ?? this.options.config?.timeZone
    this.timeZone =
      typeof requestedTimeZone === 'string' && requestedTimeZone.length > 0 ? requestedTimeZone : 'Asia/Shanghai'
    this.owner = this.options.owner ?? `lifeos-host-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    /** @type {Map<string, {unit: any, layout: string, open: boolean}>} */
    this.units = new Map()
    /** @type {Record<string, Map<string, Map<string, any>>>} */
    this.memory = emptyMemory()
    this.globals = Object.create(null)
    this.indexes = createIndexes({ timeZone: this.timeZone })
    this.backendName = null
    this.backend = null
    this.opened = false
    this.degraded = false
    this.readOnly = false
    this.errors = []
    this.revision = 0
    this._claimed = []
    /** @type {null | {status:string, fromVersion:number|null, toVersion:number, backupPath:string|null, retained:string[], skipped:string|null, at:string|null}} */
    this.migration = null
  }

  _now() {
    const n = this.options.now
    if (typeof n === 'function') return n()
    if (typeof n === 'string') return n
    return nowIso()
  }

  _markDegraded(error) {
    const err = error instanceof StoreError ? error : new StoreError(CODES.STORE_UNAVAILABLE, String(error?.message ?? error))
    this.degraded = true
    this.errors.push({ at: nowIso(), code: err.code, message: err.message })
    this._releaseUnits()
    return this
  }

  async open() {
    if (this.opened) return this
    try {
      if (this.options.backend) {
        this.backend = this.options.backend
        this.backendName = this.options.backend.name ?? 'injected'
      } else {
        const storage = resolveStorage(this.ctx)
        if (!storage) {
          throw new StoreError(CODES.STORE_UNAVAILABLE, '宿主未提供 storage 服务')
        }
        const picked = pickBackend(storage)
        this.backend = picked.backend
        this.backendName = picked.name
      }
      if (typeof this.backend?.kv?.open !== 'function') {
        throw new StoreError(CODES.STORE_UNAVAILABLE, 'backend 没有 kv facet')
      }

      // 单开约束（同进程、同 unit 只允许一个 owner）
      if (!this.options.testMode) {
        for (const unit of UNIT_NAMES) {
          const owner = OPEN_UNITS.get(unit)
          if (owner && owner !== this.owner) {
            throw new StoreError(CODES.ALREADY_OPEN, `unit ${unit} 已被打开`, { unit })
          }
        }
      }

      // M8 迁移前备份：必须在任何写之前完成（旧 reader 会拒绝 v3 stamp，回滚只能靠备份）。
      this.migration = await this._prepareMigrationBackup()

      for (const unitName of UNIT_NAMES) {
        const descriptor = UNIT_DESCRIPTORS[unitName]
        const unit = await openUnit(this.backend, descriptor)
        this.units.set(unitName, { unit, layout: descriptor.layout, open: true })
        if (!this.options.testMode) {
          OPEN_UNITS.set(unitName, this.owner)
          this._claimed.push(unitName)
        }
        const loaded = await unit.loadAll()
        this.globals[unitName] = loaded?.global ?? null
        const tables = loaded?.tables ?? {}
        const unitMemory = this.memory[unitName]
        for (const table of UNIT_TABLES[unitName]) {
          if (!unitMemory.has(table)) unitMemory.set(table, new Map())
        }
        for (const [table, entries] of Object.entries(tables)) {
          if (!unitMemory.has(table)) unitMemory.set(table, new Map())
          const map = unitMemory.get(table)
          for (const [key, value] of Object.entries(entries ?? {})) map.set(key, value)
        }
      }

      this.opened = true
      await this._applyMigration()
      this.rebuildIndexes()
      await this.recoverJournal()
      if (this.options.seed) await this._seedDefaults()
      this.rebuildIndexes()
      return this
    } catch (error) {
      await this.close().catch(() => {})
      this._markDegraded(error)
      return this
    }
  }

  async close() {
    for (const { unit } of this.units.values()) {
      try {
        await unit.close()
      } catch {
        /* close 失败不影响其它 unit */
      }
    }
    this.units.clear()
    this._releaseUnits()
    this.opened = false
    return undefined
  }

  _releaseUnits() {
    for (const unitName of this._claimed) {
      if (OPEN_UNITS.get(unitName) === this.owner) OPEN_UNITS.delete(unitName)
    }
    this._claimed = []
  }

  _assertWritable() {
    if (this.degraded) {
      throw new StoreError(CODES.STORE_UNAVAILABLE, '存储不可用（降级只读）', { errors: this.errors.slice(-3) })
    }
    if (this.readOnly) {
      throw new StoreError(CODES.STORE_READONLY, '存储处于只读模式', { errors: this.errors.slice(-3) })
    }
    if (!this.opened) throw new StoreError(CODES.STORE_UNAVAILABLE, '存储尚未打开')
  }

  _assertUnitTable(unit, table) {
    if (!UNIT_NAMES.includes(unit)) {
      throw new StoreError(CODES.UNIT_MISMATCH, `未知 unit：${String(unit)}`, { unit })
    }
    if (!isKnownTable(table)) {
      throw new StoreError(CODES.TABLE_NOT_FOUND, `未知表：${String(table)}`, { table })
    }
    const expected = unitOf(table)
    if (expected !== unit) {
      throw new StoreError(CODES.UNIT_MISMATCH, `表 ${table} 属于 ${expected}，不能通过 ${unit} 访问`, {
        unit,
        table,
        expected,
      })
    }
  }

  _handle(unit) {
    const handle = this.units.get(unit)
    if (!handle || !handle.open) throw new StoreError(CODES.STORE_UNAVAILABLE, `unit ${unit} 未打开`)
    return handle
  }

  /** 读取一条记录（返回深拷贝；降级模式返回 undefined）。 */
  get(unit, table, key) {
    if (this.degraded) return undefined
    this._assertUnitTable(unit, table)
    const record = this.memory[unit]?.get(table)?.get(key)
    return cloneJson(record)
  }

  /** 读取整表：按 key 升序返回 [key, record] 数组（深拷贝；降级模式返回空数组）。 */
  entries(unit, table) {
    if (this.degraded) return []
    this._assertUnitTable(unit, table)
    const map = this.memory[unit]?.get(table)
    if (!map) return []
    return [...map.keys()].sort().map((key) => [key, cloneJson(map.get(key))])
  }

  /** 表记录数。 */
  count(unit, table) {
    if (this.degraded) return 0
    this._assertUnitTable(unit, table)
    return this.memory[unit]?.get(table)?.size ?? 0
  }

  /** 批量读取（缺失 key 跳过；深拷贝；降级模式返回空数组）。 */
  getMany(unit, table, keys) {
    if (this.degraded || !Array.isArray(keys)) return []
    this._assertUnitTable(unit, table)
    const map = this.memory[unit]?.get(table)
    if (!map) return []
    const out = []
    for (const key of keys) {
      if (typeof key === 'string' && map.has(key)) out.push(cloneJson(map.get(key)))
    }
    return out
  }

  /** 整表纯记录数组（= entries 的 value 列表，按 key 升序；深拷贝）。 */
  records(unit, table) {
    return this.entries(unit, table).map(([, record]) => record)
  }

  /**
   * M1 任务视图查询（委托内存索引，口径见 M1-PLAN §1.4）。
   * @param {{view?:string, projectId?:string, tagId?:string, q?:string, limit?:number, cursor?:string|null, now?:Date|number|string}} [options]
   */
  queryTasks(options = {}) {
    if (this.degraded) {
      return {
        items: [],
        groups: null,
        nextCursor: null,
        counts: { today: 0, overdue: 0, next7: 0, inbox: 0, all: 0 },
      }
    }
    const result = this.indexes.queryTasks({ ...options, timeZone: options.timeZone ?? this.timeZone })
    return {
      items: cloneJson(result.items),
      groups: result.groups
        ? result.groups.map((group) => ({ ...group, items: cloneJson(group.items) }))
        : null,
      nextCursor: result.nextCursor,
      counts: result.counts,
    }
  }

  /** CAS：读 rev 校验辅助（冲突抛 StoreError.code='conflict'，details 带 current）。 */
  assertRev(record, expectedRev) {
    if (!record || typeof record !== 'object') {
      throw new StoreError(CODES.CONFLICT, '记录不存在或已被删除', { expectedRev, current: null })
    }
    if (expectedRev === undefined || expectedRev === null) {
      throw new StoreError(CODES.CONFLICT, '缺少 expectedRev（CAS 必填）', {
        expectedRev,
        current: { id: record.id, rev: record.rev },
      })
    }
    if (Number(expectedRev) !== Number(record.rev)) {
      throw new StoreError(CODES.CONFLICT, `版本冲突：当前 rev=${record.rev}`, {
        expectedRev,
        current: { ...record },
      })
    }
    return record
  }

  async _rawPut(unit, table, key, value) {
    const handle = this._handle(unit)
    await handle.unit.putRecord(table, key, value)
    const map = this.memory[unit].get(table)
    map.set(key, value)
    this.indexes.upsert(table, key, value)
    return value
  }

  async _rawDelete(unit, table, key) {
    const handle = this._handle(unit)
    await handle.unit.deleteRecord(table, key)
    this.memory[unit].get(table)?.delete(key)
    this.indexes.remove(table, key)
  }

  /** 写入前规范化 + 校验；返回可落盘的完整记录。 */
  _prepare(table, key, value) {
    if (!isPlainObject(value)) {
      throw new StoreError(CODES.VALIDATION_FAILED, `${table} 记录必须是对象`, { table })
    }
    const spec = TABLE_SPECS[table]
    const normalized = normalizeRecord(table, value, { key, now: this._now() })
    if (spec.keyMode !== 'key' && normalized.id !== key) {
      throw new StoreError(CODES.VALIDATION_FAILED, `${table} 记录 id 与 key 不一致`, {
        table,
        key,
        id: normalized.id,
      })
    }
    const result = validateRecord(table, normalized)
    if (!result.ok) {
      throw new StoreError(CODES.VALIDATION_FAILED, `${table} 记录校验失败：${result.errors[0]}`, {
        table,
        key,
        errors: result.errors,
      })
    }
    return normalized
  }

  /**
   * 低层直写（立即落盘）。业务写优先用 `transaction`。
   * @returns {Promise<object>} 规范化后的记录
   */
  async put(unit, table, key, value) {
    this._assertWritable()
    this._assertUnitTable(unit, table)
    if (typeof key !== 'string' || key.length === 0) {
      throw new StoreError(CODES.VALIDATION_FAILED, 'key 必须是非空字符串', { table })
    }
    const prepared = this._prepare(table, key, value)
    await this._rawPut(unit, table, key, prepared)
    return cloneJson(prepared)
  }

  /** 低层直删（物理删除；软删由业务层写 deleted_at 表达）。 */
  async delete(unit, table, key) {
    this._assertWritable()
    this._assertUnitTable(unit, table)
    if (typeof key !== 'string' || key.length === 0) {
      throw new StoreError(CODES.VALIDATION_FAILED, 'key 必须是非空字符串', { table })
    }
    await this._rawDelete(unit, table, key)
  }

  /** 校验并规范化事务 ops；返回可直接落盘的 ops。 */
  _prepareOps(ops) {
    if (!Array.isArray(ops) || ops.length === 0) {
      throw new StoreError(CODES.VALIDATION_FAILED, 'transaction(ops) 需要非空数组')
    }
    return ops.map((op, index) => {
      if (!isPlainObject(op)) {
        throw new StoreError(CODES.VALIDATION_FAILED, `ops[${index}] 必须是对象`)
      }
      const { unit, table, key } = op
      this._assertUnitTable(unit, table)
      if (table === JOURNAL_TABLE) {
        throw new StoreError(CODES.VALIDATION_FAILED, '事务内不允许写 journal 表')
      }
      if (typeof key !== 'string' || key.length === 0) {
        throw new StoreError(CODES.VALIDATION_FAILED, `ops[${index}].key 必须是非空字符串`)
      }
      if (op.value === null) return { unit, table, key, value: null }
      return { unit, table, key, value: this._prepare(table, key, op.value) }
    })
  }

  /**
   * journal-first 事务（M0-PLAN §3.5）。
   * @param {Array<{unit: string, table: string, key: string, value: object|null}>} ops
   * @param {{source?: string, intent?: object}} [meta]
   * @returns {Promise<{journalId: string, applied: number, revision: number}>}
   */
  async transaction(ops, meta = {}) {
    this._assertWritable()
    const prepared = this._prepareOps(ops)
    const journalId = newId('jrn')
    const createdAt = this._now()
    const journal = {
      id: journalId,
      status: 'pending',
      ops: prepared,
      createdAt,
      updatedAt: createdAt,
      source: typeof meta.source === 'string' ? meta.source : 'service',
      intent: isPlainObject(meta.intent) ? meta.intent : null,
    }
    const journalCheck = validateRecord(JOURNAL_TABLE, journal)
    if (!journalCheck.ok) {
      throw new StoreError(CODES.VALIDATION_FAILED, `journal 记录校验失败：${journalCheck.errors[0]}`, {
        errors: journalCheck.errors,
      })
    }

    // 1) 先写 journal（必须成功）
    try {
      await this._rawPut(UNIT.LOG, JOURNAL_TABLE, journalId, journal)
    } catch (error) {
      throw new StoreError(CODES.STORE_UNAVAILABLE, `写 journal 失败：${error?.message ?? error}`, { journalId })
    }

    // 2) 按 ops 顺序 apply（跨 unit 顺序执行）
    try {
      for (const op of prepared) await this._applyOp(op)
    } catch (error) {
      // journal 保持 pending，等待启动/下次恢复重放（模拟崩溃；真实进程崩溃时同样处理）
      throw new StoreError(CODES.STORE_COMMIT_FAILED, `事务提交中断（journal=${journalId}）：${error?.message ?? error}`, {
        journalId,
        cause: String(error?.message ?? error),
      })
    }

    // 3) 标记 committed
    this.revision += 1
    const committed = { ...journal, status: 'committed', updatedAt: this._now(), revision: this.revision }
    await this._rawPut(UNIT.LOG, JOURNAL_TABLE, journalId, committed)

    // 4) 保留最近 100 条 committed（FIFO 清理）
    await this._pruneCommittedJournals()
    return { journalId, applied: prepared.length, revision: this.revision }
  }

  async _applyOp(op) {
    const handle = this._handle(op.unit)
    const map = this.memory[op.unit].get(op.table)
    if (op.value === null) {
      await handle.unit.deleteRecord(op.table, op.key)
      map.delete(op.key)
      this.indexes.remove(op.table, op.key)
    } else {
      await handle.unit.putRecord(op.table, op.key, op.value)
      map.set(op.key, op.value)
      this.indexes.upsert(op.table, op.key, op.value)
    }
  }

  async _pruneCommittedJournals() {
    const journalMap = this.memory[UNIT.LOG].get(JOURNAL_TABLE)
    const committed = [...journalMap.entries()]
      .filter(([, record]) => record?.status === 'committed')
      .sort((a, b) => {
        const ta = a[1]?.createdAt ?? ''
        const tb = b[1]?.createdAt ?? ''
        if (ta === tb) return a[0].localeCompare(b[0])
        return ta < tb ? -1 : 1
      })
    const excess = committed.length - JOURNAL_RETAIN_COMMITTED
    for (let i = 0; i < excess; i++) await this._rawDelete(UNIT.LOG, JOURNAL_TABLE, committed[i][0])
  }

  /**
   * 启动恢复：扫描 pending journal，幂等重放 → committed；损坏则标 failed 并进入只读。
   * @returns {Promise<{replayed: number, rolledBack: number, failed: number}>}
   */
  async recoverJournal() {
    const result = { replayed: 0, rolledBack: 0, failed: 0 }
    if (this.degraded || !this.opened) return result
    const pending = this.indexes.pendingJournals()
    for (const record of pending) {
      const journalId = record?.id
      const journalCheck = validateRecord(JOURNAL_TABLE, record)
      if (!journalCheck.ok) {
        await this._failJournal(record, `journal 记录损坏：${journalCheck.errors[0]}`)
        result.failed += 1
        result.rolledBack += 1
        continue
      }
      try {
        for (const op of record.ops) await this._applyOp(op)
        const committed = { ...record, status: 'committed', updatedAt: this._now() }
        await this._rawPut(UNIT.LOG, JOURNAL_TABLE, journalId, committed)
        result.replayed += 1
      } catch (error) {
        await this._failJournal(record, `重放失败：${error?.message ?? error}`)
        result.failed += 1
        result.rolledBack += 1
      }
    }
    if (result.replayed > 0 || result.failed > 0) this.rebuildIndexes()
    return result
  }

  async _failJournal(record, message) {
    const failed = {
      ...record,
      status: 'failed',
      error: String(message).slice(0, 500),
      updatedAt: this._now(),
    }
    try {
      await this._rawPut(UNIT.LOG, JOURNAL_TABLE, record.id, failed)
    } catch {
      /* 写失败不覆盖原始错误 */
    }
    this.readOnly = true
    this.errors.push({ at: nowIso(), code: CODES.JOURNAL_CORRUPTED, message: `${record?.id}: ${message}` })
  }

  /**
   * M8 迁移准备：检测 `<jsonRoot>/lifeos.json` 的 unit.version 是否低于当前 descriptor 版本；
   * 低于则复制 `.bak-m8-<ts>` 并轮转保留最近 5 份。备份失败 → 抛错降级（绝不在未备份时写数据）。
   */
  async _prepareMigrationBackup() {
    const toVersion = UNIT_DESCRIPTORS[UNIT.CORE].version
    const info = {
      status: 'none',
      fromVersion: null,
      toVersion,
      backupPath: null,
      retained: [],
      skipped: null,
      at: this._now(),
    }
    const root = jsonBackendRoot(this.backend)
    if (!root) {
      if (toVersion > 1) info.skipped = 'no-json-root'
      return info
    }
    info.root = root
    const file = join(root, `${UNIT.CORE}.json`)
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        info.skipped = 'no-data-file'
        return info
      }
      throw new StoreError(CODES.STORE_UNAVAILABLE, `读取迁移目标文件失败：${file}`, {
        file,
        cause: String(error?.message ?? error),
      })
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      info.skipped = 'unparsable-file'
      return info
    }
    const stamp = Number(parsed?.unit?.version)
    if (!Number.isFinite(stamp)) {
      info.skipped = 'no-unit-version'
      return info
    }
    info.fromVersion = stamp
    if (stamp >= toVersion) {
      info.skipped = 'up-to-date'
      return info
    }
    const backupPath = await uniqueBackupPath(file, backupTimestamp(info.at))
    try {
      await copyFile(file, backupPath)
    } catch (error) {
      throw new StoreError(CODES.STORE_UNAVAILABLE, `schema 迁移备份失败，已中止（未写数据）：${file}`, {
        file,
        backupPath,
        cause: String(error?.message ?? error),
      })
    }
    info.backupPath = backupPath
    info.retained = await pruneMigrationBackups(root, this.options.backupRetain ?? MIGRATION_BACKUP_RETAIN)
    info.status = 'backed-up'
    return info
  }

  /**
   * 落实 schema 迁移：global 补 schema_version/迁移标记。
   * 该写入会让 JSON 后端在原子替换时把 unit stamp 盖上 v3（此后旧 reader 必须靠备份回滚）。
   */
  async _applyMigration() {
    const toVersion = UNIT_DESCRIPTORS[UNIT.CORE].version
    const info = this.migration || {
      status: 'none',
      fromVersion: null,
      toVersion,
      backupPath: null,
      retained: [],
      skipped: null,
      at: this._now(),
    }
    const global = this.globals[UNIT.CORE]
    const globalVersion = Number(global?.schema_version)
    const needsMigration =
      (Number.isFinite(globalVersion) && globalVersion < toVersion) ||
      (Number.isFinite(info.fromVersion) && info.fromVersion < toVersion)
    if (!needsMigration) {
      if (!this.migration) this.migration = info
      this.migration.status = info.status === 'backed-up' ? 'completed' : 'none'
      return this.migration
    }
    const current = isPlainObject(global) ? { ...global } : {}
    const next = {
      ...current,
      schema_version: toVersion,
      migrated_from: Number.isFinite(globalVersion) ? globalVersion : (info.fromVersion ?? null),
      migrated_at: this._now(),
    }
    const handle = this._handle(UNIT.CORE)
    await handle.unit.setGlobal(next)
    this.globals[UNIT.CORE] = next
    this.migration = {
      ...info,
      status: 'completed',
      fromVersion: Number.isFinite(info.fromVersion) ? info.fromVersion : Number.isFinite(globalVersion) ? globalVersion : null,
      migratedAt: next.migrated_at,
    }
    return this.migration
  }

  async _seedDefaults() {
    const coreHandle = this._handle(UNIT.CORE)
    const coreGlobal = this.globals[UNIT.CORE]
    if (!coreGlobal || typeof coreGlobal.schema_version !== 'number') {
      const value = {
        schema_version: UNIT_DESCRIPTORS[UNIT.CORE].version,
        timezone: this.timeZone,
        week_start: 'monday',
        settings_revision: 1,
        store: 'kv-json',
        freeze: 'v1.0-freeze',
        created_at: this._now(),
      }
      await coreHandle.unit.setGlobal(value)
      this.globals[UNIT.CORE] = value
    }
    const settingsMap = this.memory[UNIT.CORE].get('app_setting')
    if (settingsMap && settingsMap.size === 0) {
      const now = this._now()
      const seed = {
        timezone: this.timeZone,
        week_start: 'monday',
        settings_revision: 1,
        api_version: '0.1',
      }
      for (const [key, value_json] of Object.entries(seed)) {
        await this._rawPut(UNIT.CORE, 'app_setting', key, {
          key,
          value_json,
          updated_at: now,
          schema_version: 1,
        })
      }
    }
    // M1：默认清单"收件箱"（只一条，幂等；已有任何 list 记录则跳过）
    const listMap = this.memory[UNIT.CORE].get('list')
    if (listMap && listMap.size === 0) {
      const now = this._now()
      const id = newId('lst')
      const record = {
        id,
        name: '收件箱',
        kind: 'inbox',
        color: null,
        icon: null,
        sort_order: 0,
        is_default: true,
        created_at: now,
        updated_at: now,
        rev: 1,
        deleted_at: null,
        origin_type: 'system',
        origin_ref: null,
        origin_key: null,
        confidence: null,
        confirmation_status: 'not_required',
        evidence_refs: [],
        schema_version: 1,
        meta_json: { seeded: 'm1' },
      }
      const check = validateRecord('list', record)
      if (check.ok) await this._rawPut(UNIT.CORE, 'list', id, record)
    }
  }

  /** 重建全部内存索引。 */
  rebuildIndexes() {
    this.indexes.rebuild(this.memory)
    return this.indexes
  }

  /** 表/unit 概要（B 用于 status()/诊断）。 */
  status() {
    /** @type {Record<string, {open: boolean, records: number}>} */
    const units = {}
    for (const unit of UNIT_NAMES) {
      const handle = this.units.get(unit)
      let records = 0
      const unitMemory = this.memory[unit]
      if (unitMemory) for (const map of unitMemory.values()) records += map.size
      units[unit] = { open: Boolean(handle?.open) && !this.degraded, records }
    }
    return {
      units,
      degraded: this.degraded,
      readOnly: this.readOnly,
      backend: this.backendName,
      revision: this.revision,
      schemaVersion: UNIT_DESCRIPTORS[UNIT.CORE].version,
      migration: this.migration,
      counts: {
        inboxPending: this.degraded ? 0 : this.indexes.countInboxPending(),
        tasks: this.degraded ? 0 : (this.memory[UNIT.CORE].get('task')?.size ?? 0),
      },
      errors: this.errors.slice(-5),
    }
  }

  /** journal 计数（测试/诊断）。 */
  journalStatusCounts() {
    const map = this.memory[UNIT.LOG]?.get(JOURNAL_TABLE)
    const counts = { pending: 0, committed: 0, failed: 0 }
    if (map) {
      for (const record of map.values()) {
        if (record && typeof record.status === 'string' && record.status in counts) counts[record.status] += 1
      }
    }
    return counts
  }
}

export { JOURNAL_RETAIN_COMMITTED }

/** 默认导出（B 的 store-loader 兼容 default.openLifeosStore 形态）。 */
export default { openLifeosStore, UNIT_DESCRIPTORS }
