/**
 * B：M1 HTTP 端点集成测试（直调 handler；fake store）。
 * 每个写端点覆盖成功 + 至少一种错误（409/422/404）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLifeosService } from '../../../src/application/lifeos-service.js';
import { createEventBus } from '../../../src/runtime/sse.js';
import { createSseServer } from '../../../src/runtime/sse.js';
import { createRoutes } from '../../../src/runtime/routes.js';
import { createFakeStore } from '../helpers/fake-store.mjs';
import { call, callWrite } from '../helpers/fake-http.mjs';

const NOW = Date.parse('2026-11-13T02:00:00.000Z');

function makeRoutes() {
  const store = createFakeStore();
  const bus = createEventBus();
  const sse = createSseServer({ bus, heartbeatMs: 60000, setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} });
  const service = createLifeosService({
    store,
    config: { timeZone: 'Asia/Shanghai', devMode: false },
    diagnostics: null,
    bus,
    now: () => NOW,
  });
  const routes = createRoutes({ service, diagnostics: null, sse, config: { devMode: false } });
  return { routes, service, store, sse };
}

async function createViaApi(routes, body = { title: '任务A' }) {
  return callWrite(routes, { method: 'POST', url: '/api/lifeos/tasks', body });
}

test('GET /tasks：默认参数 + 视图 + 非法 422', async () => {
  const { routes } = makeRoutes();
  const empty = await call(routes, { url: '/api/lifeos/tasks' });
  assert.equal(empty.status, 200);
  assert.equal(empty.json().ok, true);
  assert.equal(empty.json().value.items.length, 0);
  assert.equal(empty.json().value.view, 'all');
  assert.ok(empty.json().value.counts);

  const bad = await call(routes, { url: '/api/lifeos/tasks?view=nope' });
  assert.equal(bad.status, 422);
  assert.equal(bad.json().error.code, 'validation_failed');
});

test('POST /tasks：成功 200 / 校验失败 422', async () => {
  const { routes } = makeRoutes();
  const created = await createViaApi(routes, { title: '写报告', priority: 'high', scheduledDate: '2026-11-13' });
  assert.equal(created.status, 200);
  const task = created.json().value.task;
  assert.match(task.id, /^tsk_/);
  assert.equal(task.priority, 'high');
  assert.equal(created.json().value.rev, 1);

  const invalid = await createViaApi(routes, { title: '  ' });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.json().error.code, 'validation_failed');
  const badTime = await createViaApi(routes, { title: 'x', dueDate: '2026-11-13', dueAt: '2026-11-13T10:00:00.000Z' });
  assert.equal(badTime.status, 422);
});

test('GET /tasks/:id：成功 / 404（不存在 + 非法 id）', async () => {
  const { routes } = makeRoutes();
  const created = await createViaApi(routes);
  const id = created.json().value.task.id;
  const got = await call(routes, { url: `/api/lifeos/tasks/${id}` });
  assert.equal(got.status, 200);
  assert.equal(got.json().value.task.id, id);
  const missing = await call(routes, { url: '/api/lifeos/tasks/tsk_01M78CRMDYHSJ7VSPH81DRT2WR' });
  assert.equal(missing.status, 404);
  assert.equal(missing.json().error.code, 'not_found');
  const bad = await call(routes, { url: '/api/lifeos/tasks/bad' });
  assert.equal(bad.status, 422);
});

test('PATCH /tasks/:id：If-Match 成功 / 409 冲突 / 422 缺 CAS', async () => {
  const { routes } = makeRoutes();
  const created = await createViaApi(routes);
  const id = created.json().value.task.id;

  const patched = await callWrite(routes, { method: 'PATCH', url: `/api/lifeos/tasks/${id}`, body: { title: '改名' }, rev: 1 });
  assert.equal(patched.status, 200);
  assert.equal(patched.json().value.task.title, '改名');
  assert.equal(patched.json().value.rev, 2);

  const conflict = await callWrite(routes, { method: 'PATCH', url: `/api/lifeos/tasks/${id}`, body: { title: '旧' }, rev: 1 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json().error.code, 'conflict');
  assert.equal(conflict.json().error.details.current.id, id);

  const noCas = await call(routes, { method: 'PATCH', url: `/api/lifeos/tasks/${id}`, body: JSON.stringify({ title: 'x' }) });
  assert.equal(noCas.status, 422);

  const badField = await callWrite(routes, { method: 'PATCH', url: `/api/lifeos/tasks/${id}`, body: { status: 'done' }, rev: 2 });
  assert.equal(badField.status, 422);
});

test('动作端点 complete/reopen/cancel：成功 + 409/422', async () => {
  const { routes } = makeRoutes();
  const created = await createViaApi(routes);
  const id = created.json().value.task.id;

  const done = await callWrite(routes, { method: 'POST', url: `/api/lifeos/tasks/${id}/complete`, rev: 1 });
  assert.equal(done.status, 200);
  assert.equal(done.json().value.task.status, 'done');

  const illegal = await callWrite(routes, { method: 'POST', url: `/api/lifeos/tasks/${id}/complete`, rev: 2 });
  assert.equal(illegal.status, 422);
  assert.ok(Array.isArray(illegal.json().error.details.allowed));

  const reopened = await callWrite(routes, { method: 'POST', url: `/api/lifeos/tasks/${id}/reopen`, rev: 2 });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.json().value.task.status, 'todo');

  const cancelled = await callWrite(routes, { method: 'POST', url: `/api/lifeos/tasks/${id}/cancel`, rev: 3 });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json().value.task.status, 'cancelled');

  const stale = await callWrite(routes, { method: 'POST', url: `/api/lifeos/tasks/${id}/cancel`, rev: 3 });
  assert.equal(stale.status, 409);

  const noCas = await call(routes, { method: 'POST', url: `/api/lifeos/tasks/${id}/reopen` });
  assert.equal(noCas.status, 422);

  const missing = await callWrite(routes, { method: 'POST', url: '/api/lifeos/tasks/tsk_01M78CRMDYHSJ7VSPH81DRT2WR/complete', rev: 1 });
  assert.equal(missing.status, 404);
});

test('POST /tasks/:id/reschedule：成功 / 422（时间互斥/缺 CAS）', async () => {
  const { routes } = makeRoutes();
  const created = await createViaApi(routes);
  const id = created.json().value.task.id;
  const moved = await callWrite(routes, { method: 'POST', url: `/api/lifeos/tasks/${id}/reschedule`, body: { scheduledDate: '2026-11-20' }, rev: 1 });
  assert.equal(moved.status, 200);
  assert.equal(moved.json().value.task.scheduledDate, '2026-11-20');

  const bad = await callWrite(routes, {
    method: 'POST',
    url: `/api/lifeos/tasks/${id}/reschedule`,
    body: { scheduledStartAt: '2026-11-20T11:00:00.000Z', scheduledEndAt: '2026-11-20T10:00:00.000Z' },
    rev: 2,
  });
  assert.equal(bad.status, 422);

  const empty = await callWrite(routes, { method: 'POST', url: `/api/lifeos/tasks/${id}/reschedule`, body: {}, rev: 2 });
  assert.equal(empty.status, 422);
});

test('GET /calendar：成功 / 区间非法 422', async () => {
  const { routes } = makeRoutes();
  await createViaApi(routes, { title: '有日期', scheduledDate: '2026-11-15' });
  const ok1 = await call(routes, { url: '/api/lifeos/calendar?from=2026-11-13&to=2026-11-17' });
  assert.equal(ok1.status, 200);
  assert.equal(ok1.json().value.days.length, 5);
  assert.equal(ok1.json().value.days.find((day) => day.date === '2026-11-15').tasks.length, 1);
  const bad = await call(routes, { url: '/api/lifeos/calendar?from=2026-11-17&to=2026-11-13' });
  assert.equal(bad.status, 422);
});

test('项目端点：GET/POST/PATCH（409/422/404）', async () => {
  const { routes } = makeRoutes();
  const list0 = await call(routes, { url: '/api/lifeos/projects' });
  assert.equal(list0.json().value.items.length, 0);
  const created = await callWrite(routes, { method: 'POST', url: '/api/lifeos/projects', body: { name: '项目A', color: '#f00' } });
  assert.equal(created.status, 200);
  const project = created.json().value.project;
  assert.match(project.id, /^prj_/);

  const dup = await callWrite(routes, { method: 'POST', url: '/api/lifeos/projects', body: { name: '项目A' } });
  assert.equal(dup.status, 409);

  const patched = await callWrite(routes, { method: 'PATCH', url: `/api/lifeos/projects/${project.id}`, body: { name: '项目B' }, rev: 1 });
  assert.equal(patched.status, 200);
  assert.equal(patched.json().value.project.name, '项目B');

  const stale = await callWrite(routes, { method: 'PATCH', url: `/api/lifeos/projects/${project.id}`, body: { name: 'x' }, rev: 1 });
  assert.equal(stale.status, 409);

  const invalid = await callWrite(routes, { method: 'POST', url: '/api/lifeos/projects', body: { name: '' } });
  assert.equal(invalid.status, 422);
  const missing = await callWrite(routes, { method: 'PATCH', url: '/api/lifeos/projects/prj_01M78CRMDYHSJ7VSPH81DRT2WR', body: { name: 'x' }, rev: 1 });
  assert.equal(missing.status, 404);
});

test('标签端点：GET/POST（409/422）', async () => {
  const { routes } = makeRoutes();
  assert.equal((await call(routes, { url: '/api/lifeos/tags' })).json().value.items.length, 0);
  const created = await callWrite(routes, { method: 'POST', url: '/api/lifeos/tags', body: { name: '深度工作' } });
  assert.equal(created.status, 200);
  assert.match(created.json().value.tag.id, /^tag_/);
  const dup = await callWrite(routes, { method: 'POST', url: '/api/lifeos/tags', body: { name: '深度工作' } });
  assert.equal(dup.status, 409);
  const invalid = await callWrite(routes, { method: 'POST', url: '/api/lifeos/tags', body: {} });
  assert.equal(invalid.status, 422);
});

test('ui-prefs 端点：GET 默认 / PUT 写入 / 422 非法', async () => {
  const { routes } = makeRoutes();
  const before = await call(routes, { url: '/api/lifeos/ui-prefs' });
  assert.equal(before.status, 200);
  assert.deepEqual(before.json().value.prefs, {});
  const put = await callWrite(routes, { method: 'PUT', url: '/api/lifeos/ui-prefs', body: { tab: 'todo' } });
  assert.equal(put.status, 200);
  assert.equal(put.json().value.prefs.tab, 'todo');
  const invalid = await callWrite(routes, { method: 'PUT', url: '/api/lifeos/ui-prefs', body: [] });
  assert.equal(invalid.status, 422);
});

test('M0 兼容：/query、/capture、/health 仍工作且版本头 0.2', async () => {
  const { routes } = makeRoutes();
  const health = await call(routes, { url: '/api/lifeos/health' });
  assert.equal(health.status, 200);
  assert.equal(health.headers['x-lifeos-api'], '0.7');
  const captured = await call(routes, {
    method: 'POST',
    url: '/api/lifeos/capture',
    body: JSON.stringify({ text: 'M0 兼容捕获' }),
  });
  assert.equal(captured.status, 200);
  assert.match(captured.json().value.inboxItemId, /^inb_/);
  const q = await call(routes, { url: '/api/lifeos/query?view=inbox_pending' });
  assert.equal(q.status, 200);
  assert.equal(q.json().value.items.length, 1);
});

/* M20：快速记录/日历弹窗把清单与分组一起提交（服务层已支持，契约此前会 422） */
test('POST /tasks 与 PATCH /tasks/:id 接受 listId/groupId', async () => {
  const { routes, service } = makeRoutes()
  const list = await service.createList({ name: '生活' })
  const group = await service.createGroup(list.list.id, { name: '采购' })
  const created = await createViaApi(routes, {
    title: '买牛奶',
    listId: list.list.id,
    groupId: group.group.id,
  })
  assert.equal(created.status, 200)
  const task = created.json().value.task
  assert.equal(task.listId, list.list.id)
  assert.equal(task.groupId, group.group.id)

  const moved = await callWrite(routes, {
    method: 'PATCH',
    url: `/api/lifeos/tasks/${task.id}`,
    body: { listId: list.list.id, groupId: null },
    rev: task.rev,
  })
  assert.equal(moved.status, 200)
  assert.equal(moved.json().value.task.groupId, null)

  const bad = await createViaApi(routes, { title: 'x', listId: 'grp_wrong' })
  assert.equal(bad.status, 422)
})