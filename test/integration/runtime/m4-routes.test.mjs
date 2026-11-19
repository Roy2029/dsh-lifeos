/**
 * B：M4a HTTP 端点集成测试（v0.7；直调 handler，fake service）。
 *
 * 覆盖 PLAN §4 全部端点：成功 / 422 / 404 / 409 / SSE changed / GET flat 形状。
 * fake service 与真实 lifeos-service facade 同名同形；M4 路由在 routes.js 中按顺序聚合。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { API_VERSION } from '../../../src/client-shared/contract.js';
import { LifeosError } from '../../../src/application/errors.js';
import { createEventBus, createSseServer } from '../../../src/runtime/sse.js';
import { createRoutes } from '../../../src/runtime/routes.js';
import { call, callWrite } from '../helpers/fake-http.mjs';

const NOW = Date.parse('2026-11-14T04:00:00.000Z');
const SUFFIX = '01M78CRMDYHSJ7VSPH81DRT2WR';
const HABIT_ID = `hab_${SUFFIX}`;
const CHECKIN_ID = `hci_${SUFFIX}`;
const PROJECT_ID = `prj_${SUFFIX}`;
const GOAL_ID = `gol_${SUFFIX}`;
const WISH_ID = `wsh_${SUFFIX}`;
const LINK_ID = `lnk_${SUFFIX}`;

/* ───────────────────────── fake service / harness ───────────────────────── */

function makeService(overrides = {}) {
  const calls = [];
  const base = {
    listHabits: (filter) => {
      calls.push(['listHabits', filter]);
      return { items: [{ id: HABIT_ID, name: '阅读', rev: 1 }], today: { date: '2026-11-14' } };
    },
    createHabit: (input) => {
      calls.push(['createHabit', input]);
      return { habit: { id: HABIT_ID, name: input.name, rev: 1 }, revision: 1 };
    },
    getHabit: (id) => {
      calls.push(['getHabit', id]);
      return { habit: { id, name: '阅读', rev: 1 }, checkins: [{ id: CHECKIN_ID, local_date: '2026-11-13', status: 'done' }] };
    },
    updateHabit: (id, patch, opts) => {
      calls.push(['updateHabit', id, patch, opts]);
      return { habit: { id, name: patch.name ?? '阅读', rev: 2 }, revision: 2, diff: { name: ['阅读', patch.name] } };
    },
    archiveHabit: (id, opts) => {
      calls.push(['archiveHabit', id, opts]);
      return { habit: { id, status: 'archived', rev: 3 }, revision: 3 };
    },
    checkin: (args) => {
      calls.push(['checkin', args]);
      return {
        checkin: { id: CHECKIN_ID, habit_id: args.habitId, local_date: args.localDate ?? '2026-11-14', status: args.status },
        revision: 2,
        merged: false,
      };
    },
    uncheck: (args) => {
      calls.push(['uncheck', args]);
      return { ok: true, revision: 3 };
    },
    listCheckins: (args) => {
      calls.push(['listCheckins', args]);
      return { items: [{ id: CHECKIN_ID, local_date: '2026-11-13' }] };
    },
    getHabitStats: (args) => {
      calls.push(['getHabitStats', args]);
      return {
        range: { from: '2026-11-09', to: '2026-11-15' },
        today: { date: '2026-11-14' },
        habits: [{ habitId: HABIT_ID, name: '阅读', streak: { mode: args.streakMode, unit: 'day', value: 2, longest: 5 } }],
      };
    },
    getHabitMonth: (args) => {
      calls.push(['getHabitMonth', args]);
      return { month: args.month, days: ['2026-11-01'], rows: [{ habitId: HABIT_ID, cells: [] }] };
    },
    listProjects: (filter) => {
      calls.push(['listProjects', filter]);
      return { items: [{ id: PROJECT_ID, name: '项目A', rev: 1 }] };
    },
    createProject: (input) => {
      calls.push(['createProject', input]);
      return { project: { id: PROJECT_ID, name: input.name, rev: 1 }, revision: 1 };
    },
    getProject: (id) => {
      calls.push(['getProject', id]);
      return {
        project: { id, name: '项目A', rev: 1, progress: { mode: 'auto_by_tasks', done: 1, total: 2, pct: 50 } },
        tasks: [{ id: 'tsk_x', title: '任务' }],
        progress: { mode: 'auto_by_tasks', done: 1, total: 2, pct: 50, label: '1/2' },
        recentActivityAt: '2026-11-13T02:00:00.000Z',
      };
    },
    updateProject: (id, patch, opts) => {
      calls.push(['updateProject', id, patch, opts]);
      return { project: { id, name: patch.name ?? '项目A', rev: 2 }, revision: 2 };
    },
    archiveProject: (id, opts) => {
      calls.push(['archiveProject', id, opts]);
      return { project: { id, status: 'archived', rev: 3 }, revision: 3 };
    },
    listGoals: (filter) => {
      calls.push(['listGoals', filter]);
      return { items: [{ id: GOAL_ID, title: '目标A', rev: 1 }] };
    },
    createGoal: (input) => {
      calls.push(['createGoal', input]);
      return { goal: { id: GOAL_ID, title: input.title, rev: 1 }, revision: 1 };
    },
    getGoal: (id) => {
      calls.push(['getGoal', id]);
      return { goal: { id, title: '目标A', rev: 1 }, tasks: [], progress: { mode: 'manual', done: 0, total: 0, pct: 0 } };
    },
    updateGoal: (id, patch, opts) => {
      calls.push(['updateGoal', id, patch, opts]);
      return { goal: { id, title: patch.title ?? '目标A', rev: 2 }, revision: 2 };
    },
    listWishes: (filter) => {
      calls.push(['listWishes', filter]);
      return { items: [{ id: WISH_ID, title: '愿望A', rev: 1 }] };
    },
    createWish: (input) => {
      calls.push(['createWish', input]);
      return { wish: { id: WISH_ID, title: input.title, rev: 1 }, revision: 1 };
    },
    updateWish: (id, patch, opts) => {
      calls.push(['updateWish', id, patch, opts]);
      return { wish: { id, title: patch.title ?? '愿望A', rev: 2 }, revision: 2 };
    },
    convertWish: (id, args) => {
      calls.push(['convertWish', id, args]);
      return {
        wish: { id, title: '愿望A', status: 'committed', converted_to_goal_id: GOAL_ID, rev: 2 },
        goal: { id: GOAL_ID, title: args.goal.title, rev: 1 },
        link: { id: LINK_ID, from_type: 'wish', from_id: id, to_type: 'goal', to_id: GOAL_ID, link_type: 'converted_to' },
        revision: 2,
      };
    },
    getReviewSummary: (args) => {
      calls.push(['getReviewSummary', args]);
      return {
        period: args.period,
        anchor: args.anchor ?? '2026-11-14',
        range: { start: '2026-11-09', end: '2026-11-15', label: '2026-11-09 ~ 2026-11-15' },
        cards: { completed: 1, created: 2, open: 3, overdue: 0, habits_met: 1, habits_tracked: 2, inbox_pending: 0, inbox_to_confirm: 0 },
        habits: [],
        projects: [],
      };
    },
  };
  return { service: { ...base, ...overrides }, calls };
}

function makeHarness(serviceOverrides = {}) {
  const { service, calls } = makeService(serviceOverrides);
  const bus = createEventBus();
  const published = [];
  const originalPublish = bus.publish.bind(bus);
  bus.publish = (event) => {
    published.push(event);
    return originalPublish(event);
  };
  const sse = createSseServer({
    bus,
    heartbeatMs: 60000,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  const routes = createRoutes({
    service,
    diagnostics: null,
    sse,
    config: {},
    connection: null,
    bus,
    now: () => NOW,
  });
  return { routes, published, calls, service };
}

function changedKinds(published) {
  return published.filter((event) => event.type === 'changed').map((event) => event.data.kind);
}

/* ───────────────────────── 习惯 ───────────────────────── */

test('GET /habits：flat {items,today} + 过滤参数 + 422', async () => {
  const { routes, calls } = makeHarness();
  const res = await call(routes, { url: '/api/lifeos/habits?status=active&includeArchived=true' });
  assert.equal(res.status, 200);
  assert.equal(res.json().value.items.length, 1);
  assert.equal(res.json().value.items[0].id, HABIT_ID);
  assert.equal(res.json().value.today.date, '2026-11-14');
  assert.deepEqual(calls[0], ['listHabits', { status: 'active', includeArchived: true }]);

  const bad = await call(routes, { url: '/api/lifeos/habits?status=nope' });
  assert.equal(bad.status, 422);
  assert.equal(bad.json().error.code, 'validation_failed');
  const badInclude = await call(routes, { url: '/api/lifeos/habits?includeArchived=maybe' });
  assert.equal(badInclude.status, 422);
});

test('POST /habits：成功 {habit,revision} + SSE habit + 422（缺 name / monthly_count）', async () => {
  const { routes, calls, published } = makeHarness();
  const created = await callWrite(routes, {
    method: 'POST',
    url: '/api/lifeos/habits',
    body: { name: '阅读', frequency_rule: { kind: 'daily' }, start_date: '2026-11-01' },
  });
  assert.equal(created.status, 200);
  assert.equal(created.json().value.habit.id, HABIT_ID);
  assert.equal(created.json().value.revision, 1);
  assert.equal(created.headers['x-lifeos-api'], API_VERSION);
  assert.equal(calls[0][1].checkin_mode, 'either');
  assert.equal(calls[0][1].frequency_rule.interval, 1);
  assert.ok(changedKinds(published).includes('habit'));

  const noName = await callWrite(routes, { method: 'POST', url: '/api/lifeos/habits', body: { frequency_rule: { kind: 'daily' } } });
  assert.equal(noName.status, 422);
  const monthly = await callWrite(routes, {
    method: 'POST',
    url: '/api/lifeos/habits',
    body: { name: 'x', frequency_rule: { kind: 'monthly_count', count: 3 } },
  });
  assert.equal(monthly.status, 422);
});

test('GET /habits/stats 与 /habits/month：先于 /habits/:id 匹配 + flat 形状', async () => {
  const { routes, calls } = makeHarness();
  const stats = await call(routes, { url: '/api/lifeos/habits/stats?from=2026-11-09&to=2026-11-15&mode=strict' });
  assert.equal(stats.status, 200);
  assert.equal(stats.json().value.range.from, '2026-11-09');
  assert.equal(stats.json().value.today.date, '2026-11-14');
  assert.equal(stats.json().value.habits[0].streak.mode, 'strict');
  assert.equal(calls[0][0], 'getHabitStats');
  assert.equal(calls[0][1].streakMode, 'strict');

  const month = await call(routes, { url: '/api/lifeos/habits/month?month=2026-11' });
  assert.equal(month.status, 200);
  assert.equal(month.json().value.month, '2026-11');
  assert.ok(Array.isArray(month.json().value.rows));
  const badMonth = await call(routes, { url: '/api/lifeos/habits/month?month=2026-13' });
  assert.equal(badMonth.status, 422);

  const badStats = await call(routes, { url: '/api/lifeos/habits/stats?mode=nope' });
  assert.equal(badStats.status, 422);
});

test('GET /habits/:id：flat {habit,checkins} / 404 / 非法 id 422', async () => {
  const { routes } = makeHarness();
  const res = await call(routes, { url: `/api/lifeos/habits/${HABIT_ID}` });
  assert.equal(res.status, 200);
  assert.equal(res.json().value.habit.id, HABIT_ID);
  assert.equal(res.json().value.checkins.length, 1);

  const missing = await call(routes, { url: '/api/lifeos/habits/hab_bad' });
  assert.equal(missing.status, 422); // 非法 id 在进入服务前被拦截
  const notFound = makeHarness({
    getHabit: () => {
      throw new LifeosError('not_found', '习惯不存在');
    },
  });
  const missingReal = await call(notFound.routes, { url: `/api/lifeos/habits/${HABIT_ID}` });
  assert.equal(missingReal.status, 404);
  assert.equal(missingReal.json().error.code, 'not_found');

  const bad = await call(routes, { url: '/api/lifeos/habits/bad' });
  assert.equal(bad.status, 422);
});

test('PATCH /habits/:id：{patch,expectedRev} 成功 / 409 conflict(details.current) / 缺 rev 422', async () => {
  const { routes, calls, published } = makeHarness();
  const ok = await callWrite(routes, {
    method: 'PATCH',
    url: `/api/lifeos/habits/${HABIT_ID}`,
    body: { patch: { name: '读书' }, expectedRev: 1 },
    rev: 1,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json().value.habit.name, '读书');
  assert.equal(ok.json().value.revision, 2);
  assert.ok(ok.json().value.diff);
  assert.deepEqual(calls[0], ['updateHabit', HABIT_ID, { name: '读书' }, { expectedRev: 1 }]);
  assert.equal(published.filter((event) => event.data?.kind === 'habit').length, 1);

  const conflict = makeHarness({
    updateHabit: () => {
      throw new LifeosError('conflict', '习惯已被修改', { current: { id: HABIT_ID, rev: 3 }, expectedRev: 1, currentRev: 3 });
    },
  });
  const stale = await callWrite(conflict.routes, {
    method: 'PATCH',
    url: `/api/lifeos/habits/${HABIT_ID}`,
    body: { patch: { name: 'x' }, expectedRev: 1 },
    rev: 1,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json().error.code, 'conflict');
  assert.equal(stale.json().error.details.current.rev, 3);

  const noRev = await callWrite(routes, { method: 'PATCH', url: `/api/lifeos/habits/${HABIT_ID}`, body: { patch: { name: 'x' } } });
  assert.equal(noRev.status, 422);
  const emptyPatch = await callWrite(routes, {
    method: 'PATCH',
    url: `/api/lifeos/habits/${HABIT_ID}`,
    body: { patch: {}, expectedRev: 1 },
    rev: 1,
  });
  assert.equal(emptyPatch.status, 422);
});

test('POST /habits/:id/archive：{habit,revision} + SSE habit', async () => {
  const { routes, published } = makeHarness();
  const res = await callWrite(routes, {
    method: 'POST',
    url: `/api/lifeos/habits/${HABIT_ID}/archive`,
    body: { expectedRev: 2 },
    rev: 2,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json().value.habit.status, 'archived');
  assert.equal(res.json().value.revision, 3);
  const event = published.find((item) => item.type === 'changed' && item.data.kind === 'habit');
  assert.equal(event.data.action, 'archive');
});

test('checkin / uncheck / listCheckins：信封与 SSE', async () => {
  const { routes, calls, published } = makeHarness();
  const checked = await callWrite(routes, {
    method: 'POST',
    url: `/api/lifeos/habits/${HABIT_ID}/checkin`,
    body: { localDate: '2026-11-13', status: 'done', note: '读完一章' },
  });
  assert.equal(checked.status, 200);
  assert.equal(checked.json().value.checkin.id, CHECKIN_ID);
  assert.equal(checked.json().value.merged, false);
  assert.equal(calls[0][0], 'checkin');
  assert.equal(calls[0][1].habitId, HABIT_ID);
  assert.ok(changedKinds(published).includes('habit_checkin'));

  const invalid = await callWrite(routes, {
    method: 'POST',
    url: `/api/lifeos/habits/${HABIT_ID}/checkin`,
    body: { localDate: '2026/11/13' },
  });
  assert.equal(invalid.status, 422);

  const list = await call(routes, { url: `/api/lifeos/habits/${HABIT_ID}/checkins?from=2026-11-01&to=2026-11-30` });
  assert.equal(list.status, 200);
  assert.equal(list.json().value.items.length, 1);
  const badRange = await call(routes, { url: `/api/lifeos/habits/${HABIT_ID}/checkins?from=2026-11-30&to=2026-11-01` });
  assert.equal(badRange.status, 422);

  const removed = await callWrite(routes, {
    method: 'DELETE',
    url: `/api/lifeos/habits/${HABIT_ID}/checkins/2026-11-13`,
    rev: 3,
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.json().value.ok, true);
  assert.equal(removed.json().value.revision, 3);
  assert.equal(calls.at(-1)[0], 'uncheck');
  assert.equal(calls.at(-1)[1].localDate, '2026-11-13');

  const badDate = await callWrite(routes, {
    method: 'DELETE',
    url: `/api/lifeos/habits/${HABIT_ID}/checkins/2026-13-01`,
  });
  assert.equal(badDate.status, 422);
});

/* ───────────────────────── 项目 ───────────────────────── */

test('GET /projects：flat {items} + 过滤 + 422', async () => {
  const { routes, calls } = makeHarness();
  const res = await call(routes, { url: '/api/lifeos/projects?status=active&includeArchived=false' });
  assert.equal(res.status, 200);
  assert.equal(res.json().value.items.length, 1);
  assert.deepEqual(calls[0], ['listProjects', { status: 'active', includeArchived: false }]);
  const bad = await call(routes, { url: '/api/lifeos/projects?status=nope' });
  assert.equal(bad.status, 422);
});

test('POST /projects：M1 扁平 body 兼容 + {project,revision} + 409 重名', async () => {
  const { routes, calls, published } = makeHarness();
  const res = await callWrite(routes, { method: 'POST', url: '/api/lifeos/projects', body: { name: '项目A', color: '#f00' } });
  assert.equal(res.status, 200);
  assert.equal(res.json().value.project.id, PROJECT_ID);
  assert.equal(res.json().value.revision, 1);
  assert.equal(calls[0][1].color, '#f00');
  assert.ok(changedKinds(published).includes('project'));

  const dup = makeHarness({
    createProject: () => {
      throw new LifeosError('conflict', '项目已存在：项目A', { current: { id: PROJECT_ID } });
    },
  });
  const conflict = await callWrite(dup.routes, { method: 'POST', url: '/api/lifeos/projects', body: { name: '项目A' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json().error.code, 'conflict');

  const invalid = await callWrite(routes, { method: 'POST', url: '/api/lifeos/projects', body: { name: '' } });
  assert.equal(invalid.status, 422);
});

test('GET /projects/:id：flat {project,tasks,progress,recentActivityAt}', async () => {
  const { routes } = makeHarness();
  const res = await call(routes, { url: `/api/lifeos/projects/${PROJECT_ID}` });
  assert.equal(res.status, 200);
  const value = res.json().value;
  assert.equal(value.project.id, PROJECT_ID);
  assert.equal(value.tasks.length, 1);
  assert.equal(value.progress.pct, 50);
  assert.equal(value.recentActivityAt, '2026-11-13T02:00:00.000Z');
  const bad = await call(routes, { url: '/api/lifeos/projects/nope' });
  assert.equal(bad.status, 422);
});

test('PATCH /projects/:id：M1 扁平 body（{name} + rev）与 M4 {patch,expectedRev} 均可用', async () => {
  const { routes, calls } = makeHarness();
  const res = await callWrite(routes, {
    method: 'PATCH',
    url: `/api/lifeos/projects/${PROJECT_ID}`,
    body: { name: '项目B' },
    rev: 1,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json().value.project.name, '项目B');
  assert.equal(res.json().value.revision, 2);
  assert.deepEqual(calls[0].slice(1), [PROJECT_ID, { name: '项目B' }, 1]);

  const wrapped = await callWrite(routes, {
    method: 'PATCH',
    url: `/api/lifeos/projects/${PROJECT_ID}`,
    body: { patch: { progress_mode: 'manual' }, expectedRev: 2 },
    rev: 2,
  });
  assert.equal(wrapped.status, 200);
  assert.deepEqual(calls[1].slice(1), [PROJECT_ID, { progress_mode: 'manual' }, 2]);

  const stale = makeHarness({
    updateProject: () => {
      throw new LifeosError('conflict', '项目已被修改，请刷新后重试', { current: { id: PROJECT_ID, rev: 2 }, currentRev: 2, expectedRev: 1 });
    },
  });
  const conflict = await callWrite(stale.routes, {
    method: 'PATCH',
    url: `/api/lifeos/projects/${PROJECT_ID}`,
    body: { name: 'x' },
    rev: 1,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json().error.details.current.rev, 2);
});

test('POST /projects/:id/archive：{project,revision} + SSE project', async () => {
  const { routes, published } = makeHarness();
  const res = await callWrite(routes, {
    method: 'POST',
    url: `/api/lifeos/projects/${PROJECT_ID}/archive`,
    body: { expectedRev: 2 },
    rev: 2,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json().value.project.status, 'archived');
  assert.ok(published.some((event) => event.data?.kind === 'project' && event.data.action === 'archive'));
});

/* ───────────────────────── 目标 ───────────────────────── */

test('goals：列表 / 创建 / 详情 flat {goal,progress} / 更新', async () => {
  const { routes, calls, published } = makeHarness();
  const list = await call(routes, { url: '/api/lifeos/goals?includeArchived=true' });
  assert.equal(list.status, 200);
  assert.equal(list.json().value.items.length, 1);
  assert.deepEqual(calls.at(-1), ['listGoals', { status: null, includeArchived: true }]);

  const created = await callWrite(routes, { method: 'POST', url: '/api/lifeos/goals', body: { title: '目标A' } });
  assert.equal(created.status, 200);
  assert.equal(created.json().value.goal.id, GOAL_ID);
  assert.equal(created.json().value.revision, 1);
  assert.equal(calls.at(-1)[1].horizon, 'mid');

  const detail = await call(routes, { url: `/api/lifeos/goals/${GOAL_ID}` });
  assert.equal(detail.status, 200);
  assert.equal(detail.json().value.goal.id, GOAL_ID);
  assert.ok(detail.json().value.progress);

  const patched = await callWrite(routes, {
    method: 'PATCH',
    url: `/api/lifeos/goals/${GOAL_ID}`,
    body: { patch: { title: '目标B' }, expectedRev: 1 },
    rev: 1,
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json().value.goal.title, '目标B');
  assert.ok(changedKinds(published).includes('goal'));

  const invalid = await callWrite(routes, { method: 'POST', url: '/api/lifeos/goals', body: { title: '' } });
  assert.equal(invalid.status, 422);
});

/* ───────────────────────── 愿望 ───────────────────────── */

test('wishes：列表 / 创建 / 更新 / convert（{wish,goal,link,revision} + 双 SSE）', async () => {
  const { routes, calls, published } = makeHarness();
  const list = await call(routes, { url: '/api/lifeos/wishes' });
  assert.equal(list.status, 200);
  assert.equal(list.json().value.items.length, 1);

  const created = await callWrite(routes, { method: 'POST', url: '/api/lifeos/wishes', body: { title: '愿望A' } });
  assert.equal(created.status, 200);
  assert.equal(created.json().value.wish.id, WISH_ID);

  const patched = await callWrite(routes, {
    method: 'PATCH',
    url: `/api/lifeos/wishes/${WISH_ID}`,
    body: { patch: { status: 'considering' }, expectedRev: 1 },
    rev: 1,
  });
  assert.equal(patched.status, 200);

  const converted = await callWrite(routes, {
    method: 'POST',
    url: `/api/lifeos/wishes/${WISH_ID}/convert`,
    body: { goal: { title: '目标A' }, expectedRev: 2 },
    rev: 2,
  });
  assert.equal(converted.status, 200);
  const value = converted.json().value;
  assert.equal(value.wish.status, 'committed');
  assert.equal(value.goal.id, GOAL_ID);
  assert.equal(value.link.link_type, 'converted_to');
  assert.equal(value.revision, 2);
  const convertCall = calls.find((entry) => entry[0] === 'convertWish');
  assert.equal(convertCall[2].expectedRev, 2);
  const kinds = changedKinds(published);
  assert.ok(kinds.includes('wish'));
  assert.ok(kinds.includes('goal'));

  const noGoal = await callWrite(routes, {
    method: 'POST',
    url: `/api/lifeos/wishes/${WISH_ID}/convert`,
    body: { expectedRev: 2 },
    rev: 2,
  });
  assert.equal(noGoal.status, 422);

  const duplicate = makeHarness({
    convertWish: () => {
      throw new LifeosError('conflict', '愿望已转化', { current: { id: WISH_ID, rev: 3 } });
    },
  });
  const conflict = await callWrite(duplicate.routes, {
    method: 'POST',
    url: `/api/lifeos/wishes/${WISH_ID}/convert`,
    body: { goal: { title: '目标A' } },
  });
  assert.equal(conflict.status, 409);
});

/* ───────────────────────── 回顾 / 通用 ───────────────────────── */

test('GET /review/summary：透传摘要 + 422', async () => {
  const { routes, calls } = makeHarness();
  const res = await call(routes, { url: '/api/lifeos/review/summary?period=week&anchor=2026-11-14' });
  assert.equal(res.status, 200);
  assert.equal(res.json().value.period, 'week');
  assert.ok(res.json().value.cards);
  assert.deepEqual(calls.at(-1), ['getReviewSummary', { period: 'week', anchor: '2026-11-14' }]);
  const bad = await call(routes, { url: '/api/lifeos/review/summary?period=month' });
  assert.equal(bad.status, 422);
});

test('服务未就绪 → 503 store_unavailable；OPTIONS 允许 DELETE', async () => {
  const { routes } = makeHarness({ listHabits: undefined });
  const res = await call(routes, { url: '/api/lifeos/habits' });
  assert.equal(res.status, 503);
  assert.equal(res.json().error.code, 'store_unavailable');

  const options = await call(routes, { method: 'OPTIONS', url: '/api/lifeos/habits' });
  assert.equal(options.status, 204);
  assert.match(options.headers['access-control-allow-methods'], /DELETE/);
});
