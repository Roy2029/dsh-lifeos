/**
 * B 测试辅助：内存 LifeosStore（严格实现 M0-PLAN §3.4 契约）。
 * 不是生产代码；只用于 service/routes 的集成测试。
 */

export function createFakeStore(options = {}) {
  const units = options.units || {
    lifeos: { layout: 'single', tables: new Map() },
    lifeos_raw: { layout: 'per-record', tables: new Map() },
    lifeos_log: { layout: 'per-record', tables: new Map() },
  };
  const transactions = [];
  const recoverResult = options.recoverResult || { replayed: 0, rolledBack: 0 };
  let opened = false;
  let transactionError = options.transactionError || null;

  function tableOf(unit, table) {
    const u = units[unit];
    if (!u) throw Object.assign(new Error(`unknown unit ${unit}`), { code: 'store_unavailable' });
    if (!u.tables.has(table)) u.tables.set(table, new Map());
    return u.tables.get(table);
  }

  const store = {
    backend: 'fake-memory',
    degraded: false,
    opened,
    get(unit, table, key) {
      return tableOf(unit, table).get(key);
    },
    entries(unit, table) {
      return [...tableOf(unit, table).entries()];
    },
    async put(unit, table, key, value) {
      tableOf(unit, table).set(key, value);
    },
    async delete(unit, table, key) {
      tableOf(unit, table).delete(key);
    },
    async transaction(ops) {
      if (transactionError) throw transactionError;
      transactions.push(ops);
      for (const op of ops) {
        const table = tableOf(op.unit, op.table);
        if (op.value === null) table.delete(op.key);
        else table.set(op.key, op.value);
      }
    },
    async recoverJournal() {
      return recoverResult;
    },
    rebuildIndexes() {
      return { rebuilt: 0 };
    },
    status() {
      const out = {};
      for (const [name, unit] of Object.entries(units)) {
        let records = 0;
        for (const table of unit.tables.values()) records += table.size;
        out[name] = { open: true, records };
      }
      return { units: out };
    },
    async open() {
      opened = true;
    },
    async close() {
      opened = false;
    },
    // 测试观测
    _transactions: transactions,
    _setTransactionError(error) {
      transactionError = error;
    },
  };
  store.degraded = options.degraded === true;
  return store;
}

export function seedTasks(store, tasks) {
  const table = 'task';
  store.get('lifeos', table, '__noop__');
  for (const task of tasks) store.put('lifeos', table, task.id, task);
}

export const sampleTask = (overrides = {}) => ({
  id: 'tsk_00000000000000000000000001',
  title: '测试任务',
  status: 'todo',
  priority: 'medium',
  work_kind: 'action',
  time_kind: 'date',
  scheduled_date: null,
  scheduled_start_at: null,
  due_date: null,
  due_at: null,
  project_id: null,
  archived_at: null,
  deleted_at: null,
  sort_order: 1,
  created_at: '2026-11-12T10:00:00.000Z',
  updated_at: '2026-11-12T10:00:00.000Z',
  ...overrides,
});

export function createTestDiagnostics() {
  const errors = [];
  let stage = 'created';
  const writes = [];
  return {
    paths: { diagnostics: '<mem>/runtime-diagnostics.json', clientReport: '<mem>/runtime-client-report.json' },
    state: { stage, gates: {}, errors },
    getErrors() {
      return errors;
    },
    setStage(next, patch = {}) {
      stage = next;
      this.state.stage = next;
      if (patch.counts) this.state.counts = patch.counts;
      writes.push({ stage: next, at: patch });
      return this.snapshot();
    },
    setGate(name, status, detail) {
      this.state.gates[name] = detail === undefined ? status : { status, detail };
      return this.snapshot();
    },
    recordError(code, message, details) {
      const entry = { code, message, details };
      errors.push(entry);
      return entry;
    },
    clientReport(payload) {
      this.state.clientReport = payload;
      return { received: true };
    },
    getClientReport() {
      return this.state.clientReport || null;
    },
    snapshot() {
      return JSON.parse(JSON.stringify({ stage: this.state.stage, gates: this.state.gates, errors }));
    },
    write() {},
    writes,
  };
}
