/** B：M3 路由测试（automation / suggestions / notifications + SSE 广播）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEventBus, createSseServer } from '../../../src/runtime/sse.js';
import { createRoutes } from '../../../src/runtime/routes.js';
import { LifeosError } from '../../../src/application/errors.js';
import { call, callWrite } from '../helpers/fake-http.mjs';

function fakeService() {
  return { status: () => ({ ok: true, degraded: false, units: {}, counts: {}, version: 'test', timeZone: 'Asia/Shanghai', backend: 'fake', diagnosticsPath: null }) };
}

function makeAutomation() {
  const calls = { patchSettings: 0, reconcile: 0, runRoutine: 0 };
  let settings = { suggestions: { enabled: true, maxPerDay: 2 }, dnd: { start: '22:45', end: '07:30' }, nightlyInbox: { enabled: true, time: '21:30' } };
  return {
    calls,
    getSettings: () => ({ ...settings }),
    async patchSettings(patch) {
      calls.patchSettings += 1;
      settings = { ...settings, ...patch, suggestions: { ...settings.suggestions, ...(patch.suggestions || {}) } };
      return { ...settings };
    },
    async reconcile() {
      calls.reconcile += 1;
      return { impacted: [{ routine: 'nightlyInbox', status: 'ok' }] };
    },
    async getStatus() {
      return { settings, routines: { nightlyInbox: { enabled: true, time: '21:30', nextRun: '2026-11-14T13:30:00.000Z' } }, dnd: settings.dnd, dailyBudget: 2, source: 'fake' };
    },
    async runRoutine(key) {
      calls.runRoutine += 1;
      if (key !== 'morningBrief') return { status: 'invalid', key };
      return {
        status: 'delivered',
        key,
        scheduleId: 'sch_morning',
        ranAt: '2026-11-14T04:00:00.000Z',
        sessionId: 'session-fake',
        delivery: { id: 'sch_morning', code: null, lastDelivery: { at: '2026-11-14T04:00:00.000Z', sessionId: 'session-fake' } },
      };
    },
  };
}

function makeSuggestions() {
  const suggestions = new Map([
    ['sug_1', { id: 'sug_1', title: '逾期任务', status: 'pending', action: null }],
    ['sug_2', { id: 'sug_2', title: '待整理', status: 'snoozed', action: null }],
  ]);
  const notifications = new Map([
    ['notif_1', { id: 'notif_1', kind: 'coach_nudge', title: 't1', body: 'b1', status: 'pending', readAt: null }],
  ]);
  return {
    list: ({ status }) => ({
      items: [...suggestions.values()].filter((item) => status === 'all' || item.status === status),
      counts: { total: suggestions.size },
    }),
    async act(id, action) {
      const suggestion = suggestions.get(id);
      if (!suggestion) throw new LifeosError('not_found', `建议不存在：${id}`);
      const next = { ...suggestion, status: action.action === 'accept' ? 'accepted' : action.action === 'dismiss' ? 'dismissed' : 'snoozed' };
      suggestions.set(id, next);
      return { suggestion: next, action: action.action };
    },
    listNotifications: ({ limit }) => ({ items: [...notifications.values()].slice(0, limit), unread: [...notifications.values()].filter((item) => !item.readAt).length }),
    async markRead(id) {
      const notification = notifications.get(id);
      if (!notification) throw new LifeosError('not_found', `通知不存在：${id}`);
      notifications.set(id, { ...notification, status: 'delivered', readAt: '2026-11-14T04:00:00.000Z' });
      return { id, readAt: '2026-11-14T04:00:00.000Z', status: 'delivered' };
    },
  };
}

function makeHarness(overrides = {}) {
  const bus = createEventBus();
  const published = [];
  const originalPublish = bus.publish.bind(bus);
  bus.publish = (event) => {
    published.push(event);
    return originalPublish(event);
  };
  const sse = createSseServer({ bus, heartbeatMs: 60000, setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} });
  const automation = overrides.automation === undefined ? makeAutomation() : overrides.automation;
  const suggestions = overrides.suggestions === undefined ? makeSuggestions() : overrides.suggestions;
  const routes = createRoutes({
    service: fakeService(),
    diagnostics: null,
    sse,
    config: {},
    connection: null,
    automation,
    suggestions,
    bus,
    now: () => Date.parse('2026-11-14T04:00:00.000Z'),
  });
  return { routes, bus, published, sse, automation, suggestions };
}

const json = (value) => value;

test('GET/PUT /automation：读取、patchSettings+reconcile、SSE automation/changed', async () => {
  const { routes, published } = makeHarness();
  const get = await call(routes, { url: '/api/lifeos/automation' });
  assert.equal(get.status, 200);
  assert.equal(get.json().value.settings.suggestions.enabled, true);

  const put = await callWrite(routes, {
    method: 'PUT',
    url: '/api/lifeos/automation',
    body: { morningBrief: { time: '08:00' }, suggestions: { maxPerDay: 3 } },
  });
  assert.equal(put.status, 200);
  assert.equal(put.json().value.impacted.length, 1);
  assert.equal(put.json().value.settings.suggestions.maxPerDay, 3);
  assert.equal(published.some((event) => event.type === 'automation/changed'), true);
  assert.equal(published.some((event) => event.type === 'automation/changed' && Array.isArray(event.data.impacted)), true);

  const invalid = await callWrite(routes, { method: 'PUT', url: '/api/lifeos/automation', body: { morningBrief: { time: '25:00' } } });
  assert.equal(invalid.status, 422);
  const empty = await callWrite(routes, { method: 'PUT', url: '/api/lifeos/automation', body: {} });
  assert.equal(empty.status, 422);
});

test('GET/PUT /automation：A 真实包装形状 {settings:{...}} 必须解包为扁平 settings', async () => {
  const settings = {
    morningBrief: { enabled: true, time: '08:35' },
    eveningReview: { enabled: true, time: '21:00' },
    nightlyInbox: { enabled: true, time: '21:30' },
    dailyBudget: 2,
    dnd: { start: '22:45', end: '07:30' },
    suggestions: { enabled: true, maxPerDay: 2 },
  };
  const wrapped = {
    getSettings: () => ({ settings: { ...settings }, revision: 11, valid: true, routines: [] }),
    async patchSettings(patch) {
      return {
        settings: { ...settings, ...patch, morningBrief: { ...settings.morningBrief, ...(patch.morningBrief || {}) } },
        revision: 12,
        diff: { impacted: ['morningBrief'] },
        impacted: ['morningBrief'],
      };
    },
    async reconcile() { return { impacted: ['morningBrief'] } },
  };
  const { routes } = makeHarness({ automation: wrapped });
  const get = await call(routes, { url: '/api/lifeos/automation' });
  assert.equal(get.status, 200);
  assert.equal(get.json().value.settings.morningBrief.time, '08:35');
  assert.equal(get.json().value.settings.morningBrief.enabled, true);
  assert.equal(get.json().value.settings.dailyBudget, 2);
  assert.equal(get.json().value.settings.settings, undefined, 'settings 不能再嵌套一层');
  assert.equal(get.json().value.revision, 11);

  const put = await callWrite(routes, {
    method: 'PUT',
    url: '/api/lifeos/automation',
    body: { morningBrief: { time: '07:45' } },
  });
  assert.equal(put.status, 200);
  assert.equal(put.json().value.settings.morningBrief.time, '07:45');
  assert.equal(put.json().value.settings.settings, undefined, 'PUT 的 settings 也必须是扁平设置');
});

test('GET /automation/status：返回 routine/dnd/budget', async () => {
  const { routes } = makeHarness();
  const status = await call(routes, { url: '/api/lifeos/automation/status' });
  assert.equal(status.status, 200);
  assert.equal(status.json().value.source, 'fake');
  assert.equal(status.json().value.dailyBudget, 2);
});

test('POST /automation/run：立即运行 routine（key 校验 + SSE）', async () => {
  const { routes, published } = makeHarness();
  const ok = await callWrite(routes, { method: 'POST', url: '/api/lifeos/automation/run', body: { key: 'morningBrief' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json().value.status, 'delivered');
  assert.equal(ok.json().value.sessionId, 'session-fake');
  assert.equal(published.some((event) => event.type === 'automation/changed' && event.data.run === 'morningBrief'), true);

  const unknownKey = await callWrite(routes, { method: 'POST', url: '/api/lifeos/automation/run', body: { key: 'nope' } });
  assert.equal(unknownKey.status, 422);
  const missingKey = await callWrite(routes, { method: 'POST', url: '/api/lifeos/automation/run', body: {} });
  assert.equal(missingKey.status, 422);
});

test('GET /suggestions + POST /suggestions/:id/act（accept/dismiss/snooze + 校验）', async () => {
  const { routes, published } = makeHarness();
  const pending = await call(routes, { url: '/api/lifeos/suggestions?status=pending' });
  assert.equal(pending.status, 200);
  assert.equal(pending.json().value.items.length, 1);
  assert.equal(pending.json().value.items[0].id, 'sug_1');

  const accepted = await callWrite(routes, { method: 'POST', url: '/api/lifeos/suggestions/sug_1/act', body: json({ action: 'accept' }) });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json().value.suggestion.status, 'accepted');
  assert.equal(published.some((event) => event.type === 'suggestion'), true);

  const dismissed = await callWrite(routes, { method: 'POST', url: '/api/lifeos/suggestions/sug_1/act', body: { action: 'dismiss' } });
  assert.equal(dismissed.status, 200);

  const badAction = await callWrite(routes, { method: 'POST', url: '/api/lifeos/suggestions/sug_1/act', body: { action: 'explode' } });
  assert.equal(badAction.status, 422);
  const badId = await callWrite(routes, { method: 'POST', url: '/api/lifeos/suggestions/not-an-id/act', body: { action: 'accept' } });
  assert.equal(badId.status, 422);
  const missing = await callWrite(routes, { method: 'POST', url: '/api/lifeos/suggestions/sug_404/act', body: { action: 'accept' } });
  assert.equal(missing.status, 404);
});

test('GET /notifications + POST /notifications/:id/read', async () => {
  const { routes, published } = makeHarness();
  const list = await call(routes, { url: '/api/lifeos/notifications?limit=10' });
  assert.equal(list.status, 200);
  assert.equal(list.json().value.unread, 1);
  const read = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notifications/notif_1/read' });
  assert.equal(read.status, 200);
  assert.equal(read.json().value.status, 'delivered');
  assert.equal(published.some((event) => event.type === 'notification'), true);
  const bad = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notifications/nope/read' });
  assert.equal(bad.status, 422);
});

test('服务未装配：automation/suggestions 端点 503，M2 健康检查不回归', async () => {
  const { routes } = makeHarness({ automation: null, suggestions: null });
  assert.equal((await call(routes, { url: '/api/lifeos/automation' })).status, 503);
  assert.equal((await call(routes, { url: '/api/lifeos/suggestions' })).status, 503);
  assert.equal((await call(routes, { url: '/api/lifeos/notifications' })).status, 503);
  const health = await call(routes, { url: '/api/lifeos/health' });
  assert.equal(health.status, 200);
});
