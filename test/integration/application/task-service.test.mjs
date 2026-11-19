/**
 * B：M1 任务/项目/标签/ui-prefs/日历 服务层集成测试（fake store，不起 HTTP）。
 * 覆盖：CRUD、状态机合法/非法、CAS 409、时间形态、视图/筛选/分组、日历、prefs。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLifeosService } from '../../../src/application/lifeos-service.js';
import { createEventBus } from '../../../src/runtime/sse.js';
import { createFakeStore } from '../helpers/fake-store.mjs';

// 固定"现在"：UTC 2026-11-13T02:00Z = 北京 10:00，本地日 2026-11-13
const NOW = Date.parse('2026-11-13T02:00:00.000Z');

function makeService() {
  const store = createFakeStore();
  const events = [];
  const bus = createEventBus();
  bus.subscribe((event) => events.push(event));
  const service = createLifeosService({
    store,
    config: { timeZone: 'Asia/Shanghai', devMode: false },
    diagnostics: null,
    bus,
    now: () => NOW,
  });
  return { service, store, events };
}

async function createTask(service, overrides = {}) {
  return service.createTask({ title: '任务A', ...overrides });
}

test('createTask：落 task + state_change(__created__) + oplog 三表，返回 rev=1', async () => {
  const { service, store, events } = makeService();
  const created = await createTask(service, { priority: 'high', scheduledDate: '2026-11-13' });
  assert.match(created.task.id, /^tsk_/);
  assert.equal(created.rev, 1);
  assert.equal(created.task.status, 'todo');
  assert.equal(created.task.priority, 'high');
  assert.equal(created.task.scheduledDate, '2026-11-13');
  assert.equal(created.task.isAllDay, true);
  assert.equal(created.task.timeKind, 'all_day');

  const taskOps = store._transactions[0].filter((op) => op.table === 'task');
  assert.equal(taskOps.length, 1);
  const changes = store._transactions[0].filter((op) => op.table === 'state_change');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].value.field, '__created__');
  const oplogs = store._transactions[0].filter((op) => op.table === 'operation_log');
  assert.equal(oplogs.length, 1);
  assert.equal(oplogs[0].value.action, 'task.create');
  assert.equal(events.some((event) => event.data.kind === 'task'), true);
});

test('getTask / listTasks：返回 TaskLite；不存在返回 null', async () => {
  const { service } = makeService();
  const created = await createTask(service, { notes: '备注' });
  const got = service.getTask(created.task.id);
  assert.equal(got.title, '任务A');
  assert.equal(got.notes, '备注');
  assert.equal(service.getTask('tsk_01M78CRMDYHSJ7VSPH81DRT2WR'), null);
  const listed = service.listTasks({ view: 'all' });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].id, created.task.id);
});

test('updateTask：局部更新 + CAS rev+1 + state_change 字段级', async () => {
  const { service, store } = makeService();
  const created = await createTask(service);
  const updated = await service.updateTask(created.task.id, { title: '改名', priority: 'low' }, 1);
  assert.equal(updated.task.title, '改名');
  assert.equal(updated.task.priority, 'low');
  assert.equal(updated.rev, 2);
  const tx = store._transactions[1];
  const changeFields = tx.filter((op) => op.table === 'state_change').map((op) => op.value.field).sort();
  assert.deepEqual(changeFields, ['priority', 'title']);
  assert.equal(tx.filter((op) => op.table === 'operation_log')[0].value.action, 'task.update');
});

test('updateTask：CAS 冲突 -> conflict + details.current；非写字段 422', async () => {
  const { service } = makeService();
  const created = await createTask(service);
  await assert.rejects(
    async () => service.updateTask(created.task.id, { title: 'x' }, 99),
    (error) => error.code === 'conflict' && error.details.current.id === created.task.id && error.details.currentRev === 1,
  );
  await assert.rejects(
    async () => service.updateTask(created.task.id, { title: 'x' }, undefined),
    (error) => error.code === 'validation_failed',
  );
  await assert.rejects(
    async () => service.updateTask('tsk_01M78CRMDYHSJ7VSPH81DRT2WR', { title: 'x' }, 1),
    (error) => error.code === 'not_found',
  );
});

test('状态机：complete/reopen/cancel 合法链路 + state_change/oplog', async () => {
  const { service, store } = makeService();
  const created = await createTask(service);
  const done = await service.completeTask(created.task.id, 1);
  assert.equal(done.task.status, 'done');
  assert.notEqual(done.task.completedAt, null);
  const reopened = await service.reopenTask(created.task.id, 2);
  assert.equal(reopened.task.status, 'todo');
  assert.equal(reopened.task.completedAt, null);
  const cancelled = await service.cancelTask(created.task.id, 3);
  assert.equal(cancelled.task.status, 'cancelled');
  assert.notEqual(cancelled.task.cancelledAt, null);

  const actions = store._transactions
    .map((tx) => tx.filter((op) => op.table === 'operation_log')[0]?.value.action)
    .filter(Boolean);
  assert.deepEqual(actions, ['task.create', 'task.complete', 'task.reopen', 'task.cancel']);
  const stc = store._transactions.flatMap((tx) => tx.filter((op) => op.table === 'state_change')).map((op) => op.value);
  assert.ok(stc.some((record) => record.field === 'status' && record.new_value === 'done'));
});

test('状态机非法转换 -> validation_failed + allowed（M1-G1 4 条非法）', async () => {
  const { service } = makeService();
  const created = await createTask(service);
  await service.completeTask(created.task.id, 1); // todo -> done
  await assert.rejects(async () => service.completeTask(created.task.id, 2), (e) => e.code === 'validation_failed');
  const reopened = await service.reopenTask(created.task.id, 2); // done -> todo
  await assert.rejects(async () => service.reopenTask(created.task.id, 3), (e) => e.code === 'validation_failed');
  await service.cancelTask(created.task.id, 3); // todo -> cancelled
  await assert.rejects(
    async () => service.completeTask(created.task.id, 4),
    (e) => e.code === 'validation_failed' && Array.isArray(e.details.allowed),
  );
  await assert.rejects(async () => service.cancelTask(created.task.id, 4), (e) => e.code === 'validation_failed');
});

test('rescheduleTask：日期/时间段/清除 + state_change', async () => {
  const { service, store } = makeService();
  const created = await createTask(service);
  const rescheduled = await service.rescheduleTask(created.task.id, { scheduledDate: '2026-11-20' }, 1);
  assert.equal(rescheduled.task.scheduledDate, '2026-11-20');
  const span = await service.rescheduleTask(
    created.task.id,
    { scheduledDate: null, scheduledStartAt: '2026-11-20T10:00:00.000Z', scheduledEndAt: '2026-11-20T11:00:00.000Z' },
    2,
  );
  assert.equal(span.task.timeKind, 'span');
  assert.equal(span.task.isAllDay, false);
  const cleared = await service.rescheduleTask(created.task.id, { scheduledStartAt: null, scheduledEndAt: null }, 3);
  assert.equal(cleared.task.timeKind, 'none');
  const stc = store._transactions.flatMap((tx) => tx.filter((op) => op.table === 'state_change')).map((op) => op.value);
  assert.ok(stc.some((record) => record.field === 'scheduled_date'));
  await assert.rejects(
    async () => service.rescheduleTask(created.task.id, { scheduledDate: '2026-11-20', scheduledStartAt: '2026-11-20T10:00:00.000Z' }, 4),
    (e) => e.code === 'validation_failed',
  );
  await assert.rejects(
    async () => service.rescheduleTask(created.task.id, { scheduledStartAt: '2026-11-20T11:00:00.000Z', scheduledEndAt: '2026-11-20T10:00:00.000Z' }, 4),
    (e) => e.code === 'validation_failed',
  );
});

test('视图口径：today/overdue/next7/inbox/all + counts（20 条种子）', async () => {
  const { service } = makeService();
  const mk = (title, extra = {}) => service.createTask({ title, ...extra });
  await mk('今日-日期', { scheduledDate: '2026-11-13' });
  await mk('今日-时间', { scheduledStartAt: '2026-11-13T10:00:00.000Z', scheduledEndAt: '2026-11-13T11:00:00.000Z' });
  await mk('逾期-截止', { dueDate: '2026-11-10' });
  await mk('明天', { scheduledDate: '2026-11-14' });
  await mk('最近7天', { scheduledDate: '2026-11-18' });
  await mk('以后', { scheduledDate: '2026-12-01' });
  await mk('无日期');
  await mk('收件箱', {});
  const p = await service.createProject({ name: '项目X' });
  await mk('有项目', { projectId: p.project.id });
  await mk('优先级高', { priority: 'high' });

  const today = service.listTasks({ view: 'today' });
  assert.deepEqual(today.items.map((task) => task.title).sort(), ['今日-时间', '今日-日期'].sort());
  const overdue = service.listTasks({ view: 'overdue' });
  assert.equal(overdue.items.some((task) => task.title === '逾期-截止'), true);
  const next7 = service.listTasks({ view: 'next7' });
  assert.deepEqual(next7.items.map((task) => task.title).sort(), ['今日-时间', '今日-日期', '明天', '最近7天'].sort());
  const inbox = service.listTasks({ view: 'inbox' });
  assert.equal(inbox.items.some((task) => task.title === '无日期'), true);
  assert.equal(inbox.counts.all, 10);
  assert.equal(today.counts.overdue, 1);
  const groups = service.listTasks({ view: 'all' }).groups;
  assert.ok(groups.some((group) => group.key === 'today'));
  assert.ok(groups.some((group) => group.key === 'none'));
});

test('筛选：projectId / tagId / q 组合 + 分页 cursor', async () => {
  const { service } = makeService();
  const project = (await service.createProject({ name: '项目P' })).project;
  const tag = (await service.createTag({ name: '深度工作' })).tag;
  const a = await service.createTask({ title: 'Alpha 报告', projectId: project.id, tagIds: [tag.id] });
  await service.createTask({ title: 'Beta', projectId: project.id });
  await service.createTask({ title: 'Gamma 报告' });

  const byProject = service.listTasks({ projectId: project.id });
  assert.equal(byProject.items.length, 2);
  const byTag = service.listTasks({ tagId: tag.id });
  assert.deepEqual(byTag.items.map((task) => task.id), [a.task.id]);
  const byQ = service.listTasks({ q: '报告' });
  assert.equal(byQ.items.length, 2);
  const page1 = service.listTasks({ view: 'all', limit: 1 });
  assert.equal(page1.items.length, 1);
  assert.equal(page1.nextCursor, page1.items[0].id);
  const page2 = service.listTasks({ view: 'all', limit: 1, cursor: page1.nextCursor });
  assert.equal(page2.items.length, 1);
});

test('getCalendar：days 覆盖区间 + unscheduled', async () => {
  const { service } = makeService();
  await service.createTask({ title: '有日期', scheduledDate: '2026-11-15' });
  await service.createTask({ title: '有时间', scheduledStartAt: '2026-11-16T10:00:00.000Z', scheduledEndAt: '2026-11-16T11:00:00.000Z' });
  await service.createTask({ title: '未排期' });
  const calendar = service.getCalendar('2026-11-13', '2026-11-17');
  assert.equal(calendar.days.length, 5);
  assert.deepEqual(calendar.days.find((day) => day.date === '2026-11-15').tasks.map((task) => task.title), ['有日期']);
  assert.deepEqual(calendar.days.find((day) => day.date === '2026-11-16').tasks.map((task) => task.title), ['有时间']);
  assert.deepEqual(calendar.unscheduled.map((task) => task.title), ['未排期']);
});

test('项目：创建/重复 409/列表/更新 CAS', async () => {
  const { service } = makeService();
  const created = await service.createProject({ name: '项目A', color: '#f00' });
  assert.match(created.project.id, /^prj_/);
  assert.equal(created.project.status, 'active');
  await assert.rejects(async () => service.createProject({ name: '项目A' }), (e) => e.code === 'conflict');
  const updated = await service.updateProject(created.project.id, { name: '项目B', color: '#0f0' }, 1);
  assert.equal(updated.project.name, '项目B');
  assert.equal(updated.project.rev, 2);
  await assert.rejects(async () => service.updateProject(created.project.id, { name: 'x' }, 1), (e) => e.code === 'conflict');
  await assert.rejects(
    async () => service.updateProject('prj_01M78CRMDYHSJ7VSPH81DRT2WR', { name: 'x' }, 1),
    (e) => e.code === 'not_found',
  );
  assert.equal(service.listProjects().items.length, 1);
});

test('标签：创建/重复 409/列表；任务打标签后 TaskLite.tags 带出', async () => {
  const { service } = makeService();
  const tag = await service.createTag({ name: '重要', color: '#00f' });
  assert.match(tag.tag.id, /^tag_/);
  await assert.rejects(async () => service.createTag({ name: '重要' }), (e) => e.code === 'conflict');
  assert.equal(service.listTags().items.length, 1);
  const task = await service.createTask({ title: '带标签', tagIds: [tag.tag.id] });
  assert.equal(task.task.tags.length, 1);
  assert.equal(task.task.tags[0].name, '重要');
});

test('ui-prefs：默认空 / merge 写入 / 读回', async () => {
  const { service } = makeService();
  assert.deepEqual(service.getUiPrefs().prefs, {});
  await service.setUiPrefs({ tab: 'todo', filters: { projectId: null } });
  await service.setUiPrefs({ group: 'project' });
  assert.deepEqual(service.getUiPrefs().prefs, { tab: 'todo', filters: { projectId: null }, group: 'project' });
});

test('today()：M1 扩展字段 overdue + 保留 M0 字段', async () => {
  const { service } = makeService();
  await service.createTask({ title: '今日', scheduledDate: '2026-11-13' });
  await service.createTask({ title: '逾期', dueDate: '2026-11-01' });
  const today = service.today();
  assert.equal(today.date, '2026-11-13');
  assert.deepEqual(today.tasks.map((task) => task.title), ['今日']);
  assert.equal(today.overdue.length, 1);
  assert.equal(today.overdue[0].title, '逾期');
  assert.equal(typeof today.inboxCount, 'number');
});
