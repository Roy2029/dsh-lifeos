/** B：M3 装配裁决测试（automation-service vs legacy M2 nightly，防重复注册）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAutomationRuntime, retryAutomationReconcile } from '../../../src/runtime/scheduler.js';
import { createFakeStore } from '../helpers/fake-store.mjs';

const silentLogger = { warn() {}, info() {} };

function makeLegacyScheduler() {
  const calls = { ensureNightlySchedule: 0 };
  return {
    calls,
    async ensureNightlySchedule() {
      calls.ensureNightlySchedule += 1;
      return { scheduleId: 'sch_legacy_night', reconcile: { status: 'ok' } };
    },
    async getAutomation() {
      return { enabled: true, time: '21:30', scheduleId: 'sch_legacy_night', lastRun: null };
    },
  };
}

function makeScheduleAdapter() {
  const calls = { create: 0, view: 0, edit: 0, list: 0 };
  return {
    calls,
    available: true,
    async view() { calls.view += 1; return null; },
    async create(request) { calls.create += 1; return 'sch_new'; },
    async edit() { calls.edit += 1; return { ok: true }; },
    async list() { calls.list += 1; return []; },
    async catalog() { return []; },
  };
}

function fakeAutomationService({ reconcileStatus = 'ok', scheduleId = 'sch_auto_night' } = {}) {
  const calls = { reconcileSchedules: 0, reconcileReminders: 0 };
  return {
    calls,
    getSettings: async () => ({ nightlyInbox: { enabled: true, time: '21:30' } }),
    async reconcileSchedules() {
      calls.reconcileSchedules += 1;
      return {
        status: reconcileStatus,
        schedules: [{ key: 'nightlyInbox', routine: 'nightlyInbox', scheduleId, status: 'active' }],
        impacted: ['nightlyInbox'],
        errors: [],
      };
    },
    async reconcileReminders() {
      calls.reconcileReminders += 1;
      return { status: 'ok' };
    },
    async getStatus() { return { source: 'fake-automation' }; },
  };
}

test('automation 可用：传 schedule adapter（不传 legacy scheduler），不走 legacy nightly', async () => {
  const store = createFakeStore();
  const legacyScheduler = makeLegacyScheduler();
  const adapter = makeScheduleAdapter();
  const service = fakeAutomationService();
  let factoryDeps = null;
  const runtime = await createAutomationRuntime({
    store,
    schedule: adapter,
    legacyScheduler,
    config: { timeZone: 'Asia/Shanghai' },
    logger: silentLogger,
    loadAutomation: async () => ({
      source: './src/application/automation-service.js',
      factory: async (deps) => {
        factoryDeps = deps;
        return service;
      },
    }),
  });

  assert.equal(runtime.usedFallback, false);
  assert.equal(runtime.legacyNightlyNeeded, false);
  assert.equal(runtime.legacyNightlyCalled, false);
  assert.equal(legacyScheduler.calls.ensureNightlySchedule, 0, 'automation 可用时绝不调用 legacy ensureNightlySchedule');
  assert.equal(factoryDeps.schedule, adapter, 'A 的 factory 必须收到 schedule adapter');
  assert.equal('scheduler' in factoryDeps, false, '不得把 legacy scheduler 传给 A');
  assert.equal(service.calls.reconcileSchedules, 1);
  assert.equal(service.calls.reconcileReminders, 1);
  assert.equal(runtime.nightly.scheduleId, 'sch_auto_night');
  assert.equal(runtime.nightly.status, 'active');
  assert.equal(runtime.nightly.source, 'automation-service');
  assert.equal(runtime.errors.length, 0);
});

test('A 的 factory 抛错：降级 fallback，且由 fallback 调用 legacy nightly（恰好一次）', async () => {
  const store = createFakeStore();
  const legacyScheduler = makeLegacyScheduler();
  const adapter = makeScheduleAdapter();
  const runtime = await createAutomationRuntime({
    store,
    schedule: adapter,
    legacyScheduler,
    logger: silentLogger,
    loadAutomation: async () => ({
      source: 'broken',
      factory: async () => {
        throw new Error('boom');
      },
    }),
  });

  assert.equal(runtime.usedFallback, true);
  assert.equal(runtime.legacyNightlyNeeded, true);
  assert.equal(runtime.legacyNightlyCalled, true);
  assert.equal(legacyScheduler.calls.ensureNightlySchedule, 1, 'fallback 下 legacy nightly 恰好一次');
  assert.equal(runtime.errors.some((message) => message.includes('boom')), true);
  assert.equal(runtime.nightly.source, 'fallback-legacy');
});

test('automation 模块缺失：fallback 生效并调用 legacy nightly 一次', async () => {
  const store = createFakeStore();
  const legacyScheduler = makeLegacyScheduler();
  const runtime = await createAutomationRuntime({
    store,
    schedule: makeScheduleAdapter(),
    legacyScheduler,
    logger: silentLogger,
    loadAutomation: async () => null,
  });
  assert.equal(runtime.usedFallback, true);
  assert.equal(runtime.legacyNightlyNeeded, true);
  assert.equal(legacyScheduler.calls.ensureNightlySchedule, 1);
  assert.equal(runtime.automation.source, 'fallback');
});

test('automation 可用但 reconcile 抛错：记录错误、legacy 仍不调用', async () => {
  const store = createFakeStore();
  const legacyScheduler = makeLegacyScheduler();
  const service = fakeAutomationService();
  service.reconcileSchedules = async () => {
    throw new Error('reconcile boom');
  };
  const runtime = await createAutomationRuntime({
    store,
    schedule: makeScheduleAdapter(),
    legacyScheduler,
    logger: silentLogger,
    loadAutomation: async () => ({ factory: async () => service }),
  });
  assert.equal(runtime.usedFallback, false);
  assert.equal(runtime.legacyNightlyNeeded, false);
  assert.equal(legacyScheduler.calls.ensureNightlySchedule, 0);
  assert.equal(runtime.errors.some((message) => message.includes('reconcile boom')), true);
  assert.equal(runtime.nightly.status, 'error');
});

test('提醒对账的 errors 必须并入启动错误（防 M3.G1 为 true 但提醒未创建）', async () => {
  const store = createFakeStore();
  const service = fakeAutomationService();
  service.reconcileReminders = async () => ({
    status: 'error',
    errors: ['提交报名信息: This Host cannot create Sessions; choose an existing Session target.'],
  });
  const runtime = await createAutomationRuntime({
    store,
    schedule: makeScheduleAdapter(),
    config: { timeZone: 'Asia/Shanghai' },
    logger: silentLogger,
    loadAutomation: async () => ({ factory: async () => service }),
  });
  assert.equal(runtime.usedFallback, false);
  assert.equal(runtime.errors.length, 1);
  assert.match(runtime.errors[0], /提醒对账/);
  assert.match(runtime.errors[0], /cannot create Sessions/);
});

/* ── 启动补偿：sessionController 时序竞态 ─────────────────────── */

function sessionTargetError(label) {
  return `${label}: This Host cannot create Sessions; choose an existing Session target.`;
}

test('retryAutomationReconcile：前 N 次 session 目标错误，就绪后成功并回报 attempt/result', async () => {
  let calls = 0;
  const automation = {
    async reconcileSchedules() {
      calls += 1;
      if (calls < 3) return { status: 'error', schedules: [], impacted: [], errors: [sessionTargetError('morningBrief')] };
      return {
        status: 'ok',
        schedules: [{ key: 'nightlyInbox', status: 'active', scheduleId: 'sch_night' }],
        impacted: ['morningBrief', 'nightlyInbox'],
        errors: [],
      };
    },
    async reconcileReminders() {
      return { status: 'ok', created: 1, errors: [] };
    },
  };
  const info = await new Promise((resolve, reject) => {
    const handle = retryAutomationReconcile({
      automation,
      intervalMs: 0,
      maxAttempts: 5,
      onSuccess: resolve,
      onFailure: (failure) => reject(new Error(`不应失败：${failure.reason}`)),
    });
    setTimeout(() => {
      handle.stop();
      reject(new Error('重试超时'));
    }, 2000);
  });
  assert.equal(info.attempt, 3);
  assert.equal(calls, 3);
  assert.equal(info.result.status, 'ok');
  assert.equal(info.reminders.created, 1);
});

test('retryAutomationReconcile：非 session 目标错误不重试，立即 onFailure(non-retryable)', async () => {
  let calls = 0;
  const automation = {
    async reconcileSchedules() {
      calls += 1;
      return { status: 'error', errors: ['morningBrief: schedule/create rejected'] };
    },
  };
  const failure = await new Promise((resolve, reject) => {
    retryAutomationReconcile({
      automation,
      intervalMs: 0,
      maxAttempts: 10,
      onSuccess: () => reject(new Error('不应成功')),
      onFailure: resolve,
    });
    setTimeout(() => reject(new Error('超时')), 2000);
  });
  assert.equal(failure.reason, 'non-retryable');
  assert.equal(failure.attempts, 1);
  assert.equal(calls, 1, '非可重试错误只尝试一次');
});

test('retryAutomationReconcile：达到 maxAttempts 后 onFailure(max-attempts)，且 stop 后不再尝试', async () => {
  let calls = 0;
  const automation = {
    async reconcileSchedules() {
      calls += 1;
      return { status: 'error', errors: [sessionTargetError('morningBrief')] };
    },
  };
  const failure = await new Promise((resolve, reject) => {
    retryAutomationReconcile({
      automation,
      intervalMs: 0,
      maxAttempts: 3,
      onSuccess: () => reject(new Error('不应成功')),
      onFailure: resolve,
    });
    setTimeout(() => reject(new Error('超时')), 2000);
  });
  assert.equal(failure.reason, 'max-attempts');
  assert.equal(calls, 3);

  calls = 0;
  const handle = retryAutomationReconcile({
    automation: {
      async reconcileSchedules() {
        calls += 1;
        return { errors: [sessionTargetError('x')] };
      },
    },
    intervalMs: 5,
    maxAttempts: 10,
    onSuccess: () => {},
    onFailure: () => {},
  });
  handle.stop();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, 0, 'stop() 后不得再尝试');
});
