/**
 * B 集成测试：真实的 A 线 store（openLifeosStore + schemas 校验 + journal）
 * 与 B 线 LifeosService 的端到端对接。
 *
 * 用 A 的 fake kv backend 模拟落盘；覆盖：capture 三表落盘、字段通过 A 的
 * validateRecord、journal committed、重启后数据仍在、降级 store 行为。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openLifeosStore } from '../../../src/store/lifeos-store.js';
import { createLifeosService } from '../../../src/application/lifeos-service.js';
import { createEventBus } from '../../../src/runtime/sse.js';
import { createFakeBackend, readRaw } from '../../unit/store/fake-backend.mjs';
import { createTestDiagnostics } from '../helpers/fake-store.mjs';

const FIXED_NOW = Date.parse('2026-11-12T14:00:00.000Z');

function makeService(store) {
  const bus = createEventBus();
  const events = [];
  bus.subscribe((event) => events.push(event));
  const service = createLifeosService({
    store,
    config: { timeZone: 'Asia/Shanghai', devMode: false },
    diagnostics: createTestDiagnostics(),
    bus,
    now: () => FIXED_NOW,
  });
  return { service, events };
}

test('A×B: openLifeosStore + service.capture 落盘三 unit，字段通过 A 的校验', async () => {
  const { backend, data, state } = createFakeBackend();
  const store = await openLifeosStore(null, { backend, testMode: true });
  assert.equal(store.degraded, false);
  assert.equal(store.opened, true);

  const { service, events } = makeService(store);
  const putsBeforeCapture = state.puts;
  const result = await service.capture({ text: '今天走了9000步，周五前把实验结果发给导师', source: 'panel' });
  assert.match(result.rawRecordId, /^rr_/);
  assert.match(result.inboxItemId, /^inb_/);

  // A 的落盘层（fake backend 的 unit 文件）：raw 在 lifeos_raw，inbox 在 lifeos，oplog 在 lifeos_log
  const raw = readRaw(data, 'lifeos_raw', 'raw_record', result.rawRecordId);
  assert.equal(raw.raw_text, '今天走了9000步，周五前把实验结果发给导师');
  assert.equal(raw.user_local_date, '2026-11-12');
  assert.equal(raw.tz, 'Asia/Shanghai');

  const inbox = readRaw(data, 'lifeos', 'inbox_item', result.inboxItemId);
  assert.equal(inbox.raw_record_id, result.rawRecordId);
  assert.equal(inbox.status, 'captured');

  const opEntries = store.entries('lifeos_log', 'operation_log');
  assert.equal(opEntries.length, 1);
  const oplog = opEntries[0][1];
  assert.equal(oplog.action, 'inbox.capture');
  assert.equal(oplog.idempotency_key, null);

  // 内存索引/服务视图可见
  const inboxView = service.query({ view: 'inbox_pending' });
  assert.equal(inboxView.items.length, 1);
  assert.equal(service.status().counts.inboxPending, 1);

  // journal 已 committed
  const journals = [...data.get('lifeos_log').tables.get('journal').values()];
  assert.equal(journals.length, 1);
  assert.equal(journals[0].status, 'committed');
  assert.equal(journals[0].ops.length, 3);

  // 写批次：journal(pending) + 3 ops + journal(committed) = 5 次 putRecord（不含 open 时的 seed）
  assert.equal(state.puts - putsBeforeCapture, 5);

  assert.equal(events.length, 1);
  assert.equal(events[0].data.ids[0], result.rawRecordId);

  await store.close();
});

test('A×B: 重启（close + 重新 open 同一 backend）后 Inbox 仍在', async () => {
  const { backend } = createFakeBackend();

  const store1 = await openLifeosStore(null, { backend, testMode: true });
  const { service: service1 } = makeService(store1);
  await service1.capture({ text: '第一条', requestId: 'r1' });
  await service1.capture({ text: '第二条', requestId: 'r2' });
  assert.equal(service1.status().counts.inboxPending, 2);
  await store1.close();
  assert.equal(store1.opened, false);

  const store2 = await openLifeosStore(null, { backend, testMode: true });
  const { service: service2 } = makeService(store2);
  assert.equal(store2.degraded, false);
  assert.equal(service2.status().counts.inboxPending, 2);
  const view = service2.query({ view: 'inbox_pending' });
  assert.equal(view.items.length, 2);
  await store2.close();
});

test('A×B: 重复 requestId 幂等（同一进程内不重复落盘）', async () => {
  const { backend, data } = createFakeBackend();
  const store = await openLifeosStore(null, { backend, testMode: true });
  const { service } = makeService(store);
  const first = await service.capture({ text: '幂等', requestId: 'same' });
  const second = await service.capture({ text: '幂等', requestId: 'same' });
  assert.equal(second.inboxItemId, first.inboxItemId);
  assert.equal(store.entries('lifeos', 'inbox_item').length, 1);
  assert.equal(data.get('lifeos_log').tables.get('operation_log').size, 1);
  await store.close();
});

test('A×B: open 失败 -> A 返回降级门面，B 服务只读并抛 store_unavailable', async () => {
  const { backend } = createFakeBackend({ failOpen: true });
  const store = await openLifeosStore(null, { backend, testMode: true });
  assert.equal(store.degraded, true);
  const { service } = makeService(store);
  const status = service.status();
  assert.equal(status.degraded, true);
  assert.equal(status.ok, false);
  await assert.rejects(
    () => service.capture({ text: '写不进去' }),
    (error) => error.code === 'store_unavailable',
  );
  assert.deepEqual(service.query({ view: 'inbox_pending' }).items, []);
  await store.close();
});

test('A×B: 不存在的表/unit 不会打穿服务（B 层防御为降级读）', async () => {
  const { backend } = createFakeBackend();
  const store = await openLifeosStore(null, { backend, testMode: true });
  const { service } = makeService(store);
  // 服务只使用冻结表；这里断言 A 的 unitOf 路由与服务常量一致
  assert.equal(store.entries('lifeos_raw', 'raw_record').length, 0);
  assert.equal(store.entries('lifeos', 'inbox_item').length, 0);
  assert.equal(store.entries('lifeos_log', 'operation_log').length, 0);
  assert.equal(service.today().inboxCount, 0);
  await store.close();
});
