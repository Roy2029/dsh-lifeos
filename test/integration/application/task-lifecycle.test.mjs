/**
 * B：M1 A×B 集成（真实 A store + fake backend）：创建→更新→完成→重开→取消→改期
 * 全长链路 + state_change/operation_log 落盘断言 + 重载后数据仍在。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openLifeosStore } from '../../../src/store/lifeos-store.js';
import { createLifeosService } from '../../../src/application/lifeos-service.js';
import { createEventBus } from '../../../src/runtime/sse.js';
import { createFakeBackend, readRaw } from '../../unit/store/fake-backend.mjs';

const NOW = Date.parse('2026-11-13T02:00:00.000Z');

function makeService(store) {
  return createLifeosService({
    store,
    config: { timeZone: 'Asia/Shanghai', devMode: false },
    diagnostics: null,
    bus: createEventBus(),
    now: () => NOW,
  });
}

function tableRecords(data, unit, table) {
  const map = data.get(unit)?.tables.get(table);
  return map ? [...map.values()] : [];
}

test('A×B 生命周期：创建→更新→完成→重开→取消→改期，state_change/oplog 完整', async () => {
  const { backend, data } = createFakeBackend();
  const store = await openLifeosStore(null, { backend, testMode: true });
  const service = makeService(store);

  // 创建
  const created = await service.createTask({
    title: '写实验结果',
    priority: 'high',
    scheduledDate: '2026-11-14',
    tagIds: [],
  });
  const id = created.task.id;
  assert.equal(created.task.status, 'todo');
  assert.equal(created.rev, 1);
  let raw = readRaw(data, 'lifeos', 'task', id);
  assert.equal(raw.title, '写实验结果');
  assert.equal(raw.time_kind, 'all_day');
  assert.equal(raw.scheduled_date, '2026-11-14');

  // 更新
  const updated = await service.updateTask(id, { title: '写实验结果（v2）', priority: 'low' }, 1);
  assert.equal(updated.rev, 2);
  assert.equal(readRaw(data, 'lifeos', 'task', id).title, '写实验结果（v2）');

  // 完成
  const done = await service.completeTask(id, 2);
  assert.equal(done.task.status, 'done');
  raw = readRaw(data, 'lifeos', 'task', id);
  assert.equal(raw.status, 'done');
  assert.ok(raw.completed_at);

  // 重开
  const reopened = await service.reopenTask(id, 3);
  assert.equal(reopened.task.status, 'todo');
  assert.equal(readRaw(data, 'lifeos', 'task', id).completed_at, null);

  // 取消
  const cancelled = await service.cancelTask(id, 4);
  assert.equal(cancelled.task.status, 'cancelled');
  assert.equal(readRaw(data, 'lifeos', 'task', id).status, 'cancelled');

  // 改期（取消态也允许改期，M1 未禁止）
  const rescheduled = await service.rescheduleTask(
    id,
    { scheduledDate: null, scheduledStartAt: '2026-11-15T02:00:00.000Z', scheduledEndAt: '2026-11-15T03:00:00.000Z' },
    5,
  );
  assert.equal(rescheduled.task.timeKind, 'span');
  assert.equal(readRaw(data, 'lifeos', 'task', id).time_kind, 'span');

  // state_change：__created__ + 字段级变更
  const changes = tableRecords(data, 'lifeos_log', 'state_change');
  const fields = changes.map((record) => record.field);
  assert.ok(fields.includes('__created__'), '创建应写 state_change(__created__)');
  assert.ok(fields.includes('title'));
  assert.ok(fields.includes('priority'));
  assert.ok(fields.includes('status'));
  assert.ok(fields.includes('completed_at'));
  assert.ok(fields.includes('scheduled_start_at'));
  for (const record of changes) {
    assert.equal(record.entity_type, 'task');
    assert.equal(record.entity_id, id);
    assert.equal(typeof record.changed_at, 'string');
  }

  // operation_log：动作序列 + CAS rev 递增 + 幂等键可空
  const oplogs = tableRecords(data, 'lifeos_log', 'operation_log').sort((a, b) =>
    String(a.occurred_at).localeCompare(String(b.occurred_at)),
  );
  const actions = oplogs.map((record) => record.action);
  assert.deepEqual(
    actions.filter((action) => action.startsWith('task.')),
    ['task.create', 'task.update', 'task.complete', 'task.reopen', 'task.cancel', 'task.reschedule'],
  );
  for (const record of oplogs.filter((item) => item.action.startsWith('task.'))) {
    assert.equal(record.target_id, id);
    assert.equal(record.actor_type, 'user');
    assert.equal(record.decision, 'allowed');
    assert.equal(record.status, 'applied');
    assert.equal(record.reversible, true);
  }
  const completeLog = oplogs.find((record) => record.action === 'task.complete');
  assert.deepEqual(completeLog.before_json, { status: 'todo' });
  assert.deepEqual(completeLog.after_json, { status: 'done' });
  assert.ok(Array.isArray(completeLog.state_change_ids) && completeLog.state_change_ids.length >= 1);

  // 最终 rev = 6（1 创建 + 5 次写）
  assert.equal(readRaw(data, 'lifeos', 'task', id).rev, 6);

  await store.close();
});

test('A×B 持久化：重载后任务/项目/标签/ui-prefs 仍在，列表口径一致', async () => {
  const { backend } = createFakeBackend();
  const store1 = await openLifeosStore(null, { backend, testMode: true });
  const service1 = makeService(store1);
  const project = (await service1.createProject({ name: '项目P' })).project;
  const tag = (await service1.createTag({ name: '重要' })).tag;
  const task = await service1.createTask({
    title: '持久化任务',
    projectId: project.id,
    tagIds: [tag.id],
    scheduledDate: '2026-11-13',
  });
  await service1.setUiPrefs({ tab: 'todo' });
  await store1.close();

  const store2 = await openLifeosStore(null, { backend, testMode: true });
  const service2 = makeService(store2);
  const got = service2.getTask(task.task.id);
  assert.equal(got.title, '持久化任务');
  assert.equal(got.projectName, '项目P');
  assert.deepEqual(got.tags.map((item) => item.name), ['重要']);
  assert.equal(service2.listProjects().items.length, 1);
  assert.equal(service2.listTags().items.length, 1);
  assert.equal(service2.listTasks({ view: 'today' }).items.length, 1);
  assert.equal(service2.getUiPrefs().prefs.tab, 'todo');
  await store2.close();
});

test('A×B CAS：用旧 rev 写第二次 → conflict 且磁盘数据未被覆盖', async () => {
  const { backend, data } = createFakeBackend();
  const store = await openLifeosStore(null, { backend, testMode: true });
  const service = makeService(store);
  const created = await service.createTask({ title: 'CAS', priority: 'none' });
  const id = created.task.id;
  const first = await service.updateTask(id, { title: '第一次' }, 1);
  assert.equal(first.rev, 2);
  await assert.rejects(
    async () => service.updateTask(id, { title: '第二次-旧rev' }, 1),
    (error) => error.code === 'conflict' && error.details.currentRev === 2,
  );
  assert.equal(readRaw(data, 'lifeos', 'task', id).title, '第一次');
  await store.close();
});
