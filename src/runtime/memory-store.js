/**
 * B：降级/内存存储（A 的 store 未就绪或 open 失败时使用）。
 *
 * 目的：让插件永远能激活（G6 降级）。读返回空，写一律抛 `store_unavailable`，
 * 这样 HTTP 仍能返回结构化 503、Client 显示只读横幅，而不会崩宿主。
 * 实现 `LifeosStore` 契约（M0-PLAN §3.4），行为是"只读 + 永久空"。
 */

export class LifeosStoreError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'LifeosStoreError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function createMemoryStore(options = {}) {
  const reason = options.reason || 'store not opened';
  const backend = options.backend || 'memory';
  const unitNames = options.unitNames || ['lifeos', 'lifeos_raw', 'lifeos_log'];
  let opened = false;
  const data = new Map(unitNames.map((name) => [name, new Map()])); // unit -> table -> Map

  function assertOpen() {
    if (!opened) throw new LifeosStoreError('store_unavailable', `存储未打开：${reason}`);
  }

  function tableOf(unit, table) {
    assertOpen();
    const unitMap = data.get(unit);
    if (!unitMap) throw new LifeosStoreError('store_unavailable', `未知 unit：${unit}`);
    if (!unitMap.has(table)) unitMap.set(table, new Map());
    return unitMap.get(table);
  }

  function counts() {
    const units = {};
    for (const [unit, unitMap] of data) {
      let records = 0;
      for (const table of unitMap.values()) records += table.size;
      units[unit] = { open: opened, records };
    }
    return { units };
  }

  return {
    backend,
    degraded: true,
    reason,
    async open() {
      opened = true;
    },
    async close() {
      opened = false;
    },
    status() {
      return counts();
    },
    get(unit, table, key) {
      return tableOf(unit, table).get(key);
    },
    entries(unit, table) {
      return [...tableOf(unit, table).entries()];
    },
    async put() {
      throw new LifeosStoreError('store_unavailable', `只读模式（${reason}），禁止写入`);
    },
    async delete() {
      throw new LifeosStoreError('store_unavailable', `只读模式（${reason}），禁止删除`);
    },
    async transaction() {
      throw new LifeosStoreError('store_unavailable', `只读模式（${reason}），禁止事务写入`);
    },
    async recoverJournal() {
      return { replayed: 0, rolledBack: 0 };
    },
    rebuildIndexes() {
      return { rebuilt: 0 };
    },
  };
}
