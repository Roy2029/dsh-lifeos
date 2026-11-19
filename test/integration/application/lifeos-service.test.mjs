import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLifeosService, localDateInTz } from '../../../src/application/lifeos-service.js';
import { createEventBus } from '../../../src/runtime/sse.js';
import { createMemoryStore } from '../../../src/runtime/memory-store.js';
import { createFakeStore, sampleTask, createTestDiagnostics, seedTasks } from '../helpers/fake-store.mjs';

const CONFIG = { timeZone: 'Asia/Shanghai', devMode: false };
const FIXED_NOW = Date.parse('2026-11-12T14:00:00.000Z'); // 北京时间 11-12 22:00

function makeService(overrides = {}) {
  const store = overrides.store || createFakeStore();
  const diagnostics = overrides.diagnostics || createTestDiagnostics();
  const bus = overrides.bus || createEventBus();
  const service = createLifeosService({
    store,
    config: CONFIG,
    diagnostics,
    bus,
    now: () => FIXED_NOW,
    version: '0.0.1',
    ...overrides.deps,
  });
  return { service, store, diagnostics, bus };
}

test('service: status 空库为 ready 且 counts 全 0', () => {
  const { service, store } = makeService();
  const status = service.status();
  assert.equal(status.ok, true);
  assert.equal(status.degraded, false);
  assert.equal(status.backend, 'fake-memory');
  assert.deepEqual(status.counts, { inboxPending: 0, today: 0 });
  assert.deepEqual(Object.keys(status.units).sort(), ['lifeos', 'lifeos_log', 'lifeos_raw']);
  assert.equal(store.degraded, false);
});

test('service: capture 写 3 表（raw/inbox/oplog）且值符合冻结 schema 关键字段', async () => {
  const { service, store, bus } = makeService();
  const events = [];
  bus.subscribe((event) => events.push(event));

  const result = await service.capture({ text: '今天走了9000步，周五前把实验结果发给导师', source: 'panel' });
  assert.match(result.rawRecordId, /^rr_/);
  assert.match(result.inboxItemId, /^inb_/);
  assert.equal(store._transactions.length, 1);

  const ops = store._transactions[0];
  assert.equal(ops.length, 3);
  assert.deepEqual(
    ops.map((op) => `${op.unit}/${op.table}`),
    ['lifeos_raw/raw_record', 'lifeos/inbox_item', 'lifeos_log/operation_log'],
  );

  const raw = ops[0].value;
  assert.equal(raw.id, result.rawRecordId);
  assert.equal(raw.raw_text, '今天走了9000步，周五前把实验结果发给导师');
  assert.equal(raw.kind, 'note');
  assert.equal(raw.user_local_date, '2026-11-12');
  assert.equal(raw.tz, 'Asia/Shanghai');
  assert.equal(raw.processing_status, 'pending');
  assert.equal(raw.origin_type, 'user_stated');
  assert.equal(raw.raw_text_sha256.length, 64);
  assert.equal(raw.rev, 1);

  const inbox = ops[1].value;
  assert.equal(inbox.id, result.inboxItemId);
  assert.equal(inbox.raw_record_id, raw.id);
  assert.equal(inbox.status, 'captured');
  assert.equal(inbox.title.length <= 500, true);
  assert.deepEqual(inbox.origin_ref, { raw_record_id: raw.id });

  const oplog = ops[2].value;
  assert.match(oplog.id, /^opl_/);
  assert.equal(oplog.action, 'inbox.capture');
  assert.equal(oplog.target_id, inbox.id);
  assert.equal(oplog.actor_type, 'user');
  assert.equal(oplog.permission_level, 'L2');
  assert.equal(oplog.decision, 'allowed');
  assert.equal(oplog.status, 'applied');
  assert.equal(oplog.idempotency_key, null);
  assert.deepEqual(oplog.meta_json, { trace_id: null, source: 'panel' });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'changed');
  assert.equal(events[0].data.kind, 'capture');
  assert.deepEqual(events[0].data.ids, [raw.id, inbox.id]);
});

test('service: requestId 幂等（重复 capture 返回首次结果且不重复写）', async () => {
  const { service, store } = makeService();
  const first = await service.capture({ text: '记一下：周五交报告', requestId: 'req-1' });
  const second = await service.capture({ text: '记一下：周五交报告', requestId: 'req-1' });
  assert.deepEqual(second, { ...first, deduped: true });
  assert.equal(store._transactions.length, 1);

  const third = await service.capture({ text: '另一条', requestId: 'req-2' });
  assert.notEqual(third.inboxItemId, first.inboxItemId);
  assert.equal(store._transactions.length, 2);
});

test('service: requestId 幂等键写入 operation_log', async () => {
  const { service, store } = makeService();
  await service.capture({ text: 'x', requestId: 'req-9' });
  const oplog = store._transactions[0][2].value;
  assert.equal(oplog.idempotency_key, 'http:capture:req-9');
});

test('service: 长文本 -> inbox.title 截断、body 保留', async () => {
  const { service, store } = makeService();
  const longText = `${'标题'.repeat(400)}\n第二行正文`;
  await service.capture({ text: longText });
  const inbox = store._transactions[0][1].value;
  assert.equal(inbox.title.length, 500);
  assert.equal(inbox.body, longText);
});

test('service: query 三种视图 + 分页游标', async () => {
  const store = createFakeStore();
  seedTasks(store, [
    sampleTask({ id: 'tsk_00000000000000000000000001', title: 'A' }),
    sampleTask({
      id: 'tsk_00000000000000000000000002',
      title: 'B',
      status: 'done',
      updated_at: '2026-11-12T11:00:00.000Z',
    }),
  ]);
  const { service } = makeService({ store });
  await service.capture({ text: '收件箱条目 1' });
  await service.capture({ text: '收件箱条目 2' });

  const inbox = service.query({ view: 'inbox_pending', limit: 1 });
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.nextCursor, '1');
  assert.match(inbox.items[0].id, /^inb_/);

  const page2 = service.query({ view: 'inbox_pending', limit: 1, cursor: inbox.nextCursor });
  assert.equal(page2.items.length, 1);
  assert.equal(page2.nextCursor, null);

  const all = service.query({ view: 'all_tasks' });
  assert.equal(all.items.length, 1);
  assert.equal(all.items[0].id, 'tsk_00000000000000000000000001');

  const todayView = service.query({ view: 'today' });
  assert.equal(Array.isArray(todayView.items), true);
});

test('service: today 返回日期 + 任务 + inboxCount', async () => {
  const store = createFakeStore();
  seedTasks(store, [
    sampleTask({ title: '今日任务', scheduled_date: '2026-11-12', id: 'tsk_00000000000000000000000003' }),
    sampleTask({ title: '明天任务', scheduled_date: '2026-11-13', id: 'tsk_00000000000000000000000004' }),
  ]);
  const { service } = makeService({ store });
  await service.capture({ text: '一条收件箱' });
  const today = service.today();
  assert.equal(today.date, '2026-11-12');
  assert.equal(today.inboxCount, 1);
  assert.deepEqual(
    today.tasks.map((task) => task.title),
    ['今日任务'],
  );
});

test('service: degraded（内存降级 store）读空、写抛 store_unavailable', async () => {
  const store = createMemoryStore({ reason: '测试降级' });
  await store.open();
  const { service } = makeService({ store });
  const status = service.status();
  assert.equal(status.ok, false);
  assert.equal(status.degraded, true);
  assert.deepEqual(status.counts, { inboxPending: 0, today: 0 });

  await assert.rejects(
    () => service.capture({ text: '写不进去' }),
    (error) => error.code === 'store_unavailable',
  );
  assert.deepEqual(service.query({ view: 'inbox_pending' }).items, []);
  assert.equal(service.today().tasks.length, 0);
});

test('service: 事务失败 -> 结构化 internal + 诊断记录', async () => {
  const store = createFakeStore();
  store._setTransactionError(Object.assign(new Error('磁盘满了'), { code: 'internal' }));
  const diagnostics = createTestDiagnostics();
  const { service } = makeService({ store, diagnostics });
  await assert.rejects(
    () => service.capture({ text: 'x' }),
    (error) => error.code === 'internal' && error.details.stage === 'journal',
  );
  assert.equal(diagnostics.getErrors().length, 1);
  assert.match(diagnostics.getErrors()[0].message, /capture 事务失败/);
});

test('service: 非法参数防御（service 层也校验）', async () => {
  const { service, store } = makeService();
  await assert.rejects(
    () => service.capture({ text: '' }),
    (error) => error.code === 'validation_failed' && Array.isArray(error.details.errors),
  );
  assert.equal(store._transactions.length, 0);
  assert.throws(() => service.query({ view: 'nope' }), (error) => error.code === 'validation_failed');
});

test('localDateInTz: 时区归日正确（UTC 14:00 = 北京 22:00）', () => {
  assert.equal(localDateInTz(FIXED_NOW, 'Asia/Shanghai'), '2026-11-12');
  assert.equal(localDateInTz(Date.parse('2026-11-12T17:00:00.000Z'), 'Asia/Shanghai'), '2026-11-13');
  assert.equal(localDateInTz(FIXED_NOW, 'UTC'), '2026-11-12');
  // 非法时区回退为 UTC 日期，不抛
  assert.equal(localDateInTz(FIXED_NOW, 'Not/AZone'), '2026-11-12');
});
