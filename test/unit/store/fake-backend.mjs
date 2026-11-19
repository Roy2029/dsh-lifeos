/**
 * Fake kv backend（A 线测试用；不依赖真实 profile）
 *
 * 模拟 `ctx.storage.backend.kv`：
 * - `open(descriptor)` → unit { loadAll, putRecord, deleteRecord, setGlobal, close }
 * - 数据在内存 Map 中跨 open/close 保留（模拟 JSON 文件持久化）
 * - 写入经过 JSON 深拷贝（模拟序列化，暴露不可序列化值）
 * - 可注入失败：failOpen / failOpenUnits / failPutAt（按 putRecord 调用计数）
 */

const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/
const TABLE_NAME_RE = /^[a-z][a-z0-9_]*$/

function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

/**
 * @param {{failOpen?: boolean, failOpenUnits?: string[]}} [options]
 * @returns {{backend: any, state: any, data: Map<string, {descriptor: any, global: any, tables: Map<string, Map<string, any>>}>}}
 */
export function createFakeBackend(options = {}) {
  const state = {
    opens: 0,
    closes: 0,
    puts: 0,
    deletes: 0,
    writeLog: [],
    failOpen: Boolean(options.failOpen),
    failOpenUnits: new Set(options.failOpenUnits ?? []),
    failPutAt: null,
  }
  /** @type {Map<string, {descriptor: any, global: any, tables: Map<string, Map<string, any>>}>} */
  const data = new Map()

  const backend = {
    name: 'fake-json',
    kv: {
      async open(descriptor) {
        state.opens += 1
        if (state.failOpen) throw new Error('fake: open failed (injected)')
        if (state.failOpenUnits.has(descriptor?.name)) {
          throw new Error(`fake: open failed for unit ${descriptor.name} (injected)`)
        }
        if (typeof descriptor?.name !== 'string' || !UNIT_NAME_RE.test(descriptor.name)) {
          throw new Error(`fake: invalid unit name ${String(descriptor?.name)}`)
        }
        if (!Array.isArray(descriptor.tables) || descriptor.tables.length === 0) {
          throw new Error('fake: descriptor.tables required')
        }
        for (const table of descriptor.tables) {
          if (typeof table !== 'string' || !TABLE_NAME_RE.test(table)) {
            throw new Error(`fake: invalid table name ${String(table)}`)
          }
        }
        let record = data.get(descriptor.name)
        if (!record) {
          record = { descriptor: clone(descriptor), global: null, tables: new Map() }
          data.set(descriptor.name, record)
        }
        for (const table of descriptor.tables) {
          if (!record.tables.has(table)) record.tables.set(table, new Map())
        }
        const tables = record.tables
        return {
          descriptor: clone(descriptor),
          async loadAll() {
            const out = { global: clone(record.global), tables: {} }
            for (const [table, tableMap] of tables) {
              const entries = {}
              for (const [key, value] of tableMap) entries[key] = clone(value)
              out.tables[table] = entries
            }
            return out
          },
          async putRecord(table, key, value) {
            state.puts += 1
            state.writeLog.push({ unit: descriptor.name, table, key })
            if (state.failPutAt !== null && state.puts >= state.failPutAt) {
              throw new Error('fake: put failed (injected)')
            }
            if (!tables.has(table)) tables.set(table, new Map())
            tables.get(table).set(key, clone(value))
          },
          async deleteRecord(table, key) {
            state.deletes += 1
            state.writeLog.push({ unit: descriptor.name, table, key, deleted: true })
            if (state.failPutAt !== null && state.puts + state.deletes >= state.failPutAt) {
              throw new Error('fake: delete failed (injected)')
            }
            tables.get(table)?.delete(key)
          },
          async setGlobal(value) {
            record.global = clone(value)
          },
          async close() {
            state.closes += 1
          },
        }
      },
    },
    get(name) {
      if (name === 'json' || name === 'storage-json' || name === 'default') return backend
      return null
    },
    names() {
      return ['json']
    },
  }

  return { backend, state, data }
}

/** 读取 fake 落盘中的原始记录（测试断言用）。 */
export function readRaw(data, unit, table, key) {
  return data.get(unit)?.tables.get(table)?.get(key)
}

/** 写入 fake 落盘中的原始记录（测试注入损坏数据用）。 */
export function writeRaw(data, unit, table, key, value) {
  const record = data.get(unit)
  if (!record) throw new Error(`fake: unit ${unit} not opened`)
  if (!record.tables.has(table)) record.tables.set(table, new Map())
  record.tables.get(table).set(key, clone(value))
}
