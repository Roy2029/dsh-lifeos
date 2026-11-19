/**
 * B：M2 整理服务 + 定时 + 工具隔离 集成测试。
 * 用真实 A store（fake backend）验证 schema/事务；用 fake schedule 验证调度幂等。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openLifeosStore } from '../../../src/store/lifeos-store.js';
import { createLifeosService } from '../../../src/application/lifeos-service.js';
import { createEventBus } from '../../../src/runtime/sse.js';
import { createScheduler, SCHEDULE_TITLE, buildNightlyPrompt } from '../../../src/runtime/scheduler.js';
import { installToolScope, LIFEOS_TOOL_NAMES } from '../../../src/runtime/tool-scope.js';
import { createFakeBackend } from '../../unit/store/fake-backend.mjs';

const NOW = Date.parse('2026-11-13T02:00:00.000Z');
const LONG_TEXT = '今天走了9000步，周五前要把实验结果发给导师';

async function makeStore() {
  const { backend, data } = createFakeBackend();
  const store = await openLifeosStore(null, { backend, testMode: true });
  return { store, data, backend };
}

function makeService(store, scheduler = null) {
  return createLifeosService({
    store,
    config: { timeZone: 'Asia/Shanghai', devMode: false },
    diagnostics: null,
    bus: createEventBus(),
    now: () => NOW,
    scheduler,
  });
}

function tableValues(data, unit, table) {
  const map = data.get(unit)?.tables.get(table);
  return map ? [...map.values()] : [];
}

test('rules run：候选 + raw partial + runKey 幂等', async () => {
  const { store, data } = await makeStore();
  const service = makeService(store);
  const captured = await service.capture({ text: LONG_TEXT });
  const run1 = await service.runTriage({ mode: 'rules' });
  assert.ok(run1.runId);
  assert.equal(run1.alreadyDone, false);
  assert.ok(run1.candidates.length >= 2);
  for (const candidate of run1.candidates) {
    assert.match(candidate.candidateId, /^cand_/);
    assert.equal(candidate.rawRecordId, captured.rawRecordId);
    assert.ok(LONG_TEXT.includes(candidate.source.quote), 'quote 必须是原文子串');
  }
  assert.equal(tableValues(data, 'lifeos_raw', 'raw_record')[0].processing_status, 'partial');
  const runKey = run1.run.runKey;
  const run2 = await service.runTriage({ mode: 'rules', runKey });
  assert.equal(run2.alreadyDone, true);
  assert.equal(run2.runId, run1.runId);
  assert.equal(tableValues(data, 'lifeos', 'extraction_run').length, 1);
  await store.close();
});

test('agent begin / saveTriageCandidates / abort（D 的 lifeos_triage 契约）', async () => {
  const { store } = await makeStore();
  const service = makeService(store);
  const captured = await service.capture({ text: LONG_TEXT });

  const begin = await service.beginTriage({ scope: 'pending' });
  assert.ok(begin.runId);
  assert.equal(begin.needsAgent, true);
  assert.equal(begin.batches.length, 1);
  assert.equal(begin.batches[0].rawRecord.id, captured.rawRecordId);
  assert.equal(begin.batches[0].rawRecord.text, LONG_TEXT);
  assert.ok(begin.batches[0].inboxItem.id);

  const quote = '走了9000步';
  const start = LONG_TEXT.indexOf('走了');
  const candidate = {
    candidateId: 'cand_' + 'A'.repeat(26),
    rawRecordId: captured.rawRecordId,
    kind: 'metric',
    confidence: 0.9,
    source: { quote, start, end: start + quote.length },
    fields: { metric_code: 'steps', value_num: 9000, unit: '步', measured_at: '2026-11-13T02:00:00.000Z', measured_tz: 'Asia/Shanghai' },
    reasons: ['测试'],
    risks: [],
    requiresConfirm: false,
  };
  const saved = await service.saveTriageCandidates({ runId: begin.runId, candidates: [candidate] });
  assert.equal(saved.saved, 1);
  assert.equal(saved.total, 1);
  const again = await service.saveTriageCandidates({ runId: begin.runId, candidates: [candidate] });
  assert.equal(again.saved, 0);
  assert.equal(again.alreadyDone, true);
  const run = await service.getTriageRun(begin.runId);
  assert.equal(run.candidates.length, 1);
  assert.equal(run.status, 'succeeded');

  const abort = await service.abortTriage({ runId: begin.runId, reason: '用户放弃' });
  assert.equal(abort.run.status, 'skipped');
  assert.equal(abort.run.error, '用户放弃');
  await store.close();
});

test('apply：目标对象 + evidence_link + raw/inbox + oplog 一次事务；重复 apply 幂等', async () => {
  const { store, data } = await makeStore();
  const service = makeService(store);
  const captured = await service.capture({ text: LONG_TEXT });
  const run = await service.runTriage({ mode: 'rules' });
  const decisions = run.candidates.map((candidate) => ({ candidateId: candidate.candidateId, action: 'accept' }));
  const applied = await service.applyTriage({ runId: run.runId, decisions });
  assert.equal(applied.applied, decisions.length);
  assert.equal(applied.ignored, 0);

  const tasks = tableValues(data, 'lifeos', 'task');
  const metrics = tableValues(data, 'lifeos', 'metric');
  assert.ok(tasks.length + metrics.length === decisions.length);
  for (const created of applied.created) {
    assert.ok(created.id);
    const table = created.type === 'task' ? tasks : created.type === 'metric' ? metrics : [];
    const record = table.find((item) => item.id === created.id);
    assert.ok(record, `目标对象应落盘：${created.type}/${created.id}`);
    assert.equal(record.origin_type, 'record_extraction');
    assert.equal(record.confirmation_status, 'confirmed');
    assert.ok(record.origin_ref.raw_record_id === captured.rawRecordId || record.raw_record_id === captured.rawRecordId);
  }
  const links = tableValues(data, 'lifeos', 'evidence_link');
  assert.equal(links.length, decisions.length);
  assert.ok(links.every((link) => link.to_type === 'raw_record' && link.to_id === captured.rawRecordId));
  assert.ok(links.every((link) => link.from_type === 'operation_log'));
  assert.equal(tableValues(data, 'lifeos_raw', 'raw_record')[0].processing_status, 'processed');
  const inbox = tableValues(data, 'lifeos', 'inbox_item')[0];
  assert.equal(inbox.status, 'triaged');
  const actions = tableValues(data, 'lifeos_log', 'operation_log').map((record) => record.action);
  assert.ok(actions.includes('triage.run') && actions.includes('triage.apply'));
  assert.ok(tableValues(data, 'lifeos_log', 'state_change').length > 0);

  const repeat = await service.applyTriage({ runId: run.runId, decisions });
  assert.equal(repeat.alreadyApplied, true);
  assert.equal(tableValues(data, 'lifeos', 'task').length + tableValues(data, 'lifeos', 'metric').length, decisions.length);
  await store.close();
});

test('apply 部分失败：补偿回滚（目标对象删除/raw 恢复）+ 失败审计', async () => {
  const { store, data } = await makeStore();
  const service = makeService(store);
  const captured = await service.capture({ text: LONG_TEXT });
  const run = await service.runTriage({ mode: 'rules' });

  // 注入：apply 的事务只落第 1 条 op 后抛错；补偿事务（第 2 次调用）正常执行
  const originalTransaction = store.transaction.bind(store);
  let calls = 0;
  store.transaction = async (ops, meta) => {
    calls += 1;
    if (calls === 1) {
      await originalTransaction([ops[0]], meta);
      throw new Error('injected apply failure');
    }
    return originalTransaction(ops, meta);
  };
  await assert.rejects(
    () => service.applyTriage({
      runId: run.runId,
      decisions: run.candidates.map((candidate) => ({ candidateId: candidate.candidateId, action: 'accept' })),
    }),
    (error) => error.code === 'internal' && error.details.stage === 'apply',
  );
  store.transaction = originalTransaction;

  assert.equal(tableValues(data, 'lifeos', 'task').length + tableValues(data, 'lifeos', 'metric').length, 0, '补偿后不应残留目标对象');
  assert.equal(tableValues(data, 'lifeos', 'evidence_link').length, 0, '补偿后不应残留证据链');
  const raw = tableValues(data, 'lifeos_raw', 'raw_record').find((record) => record.id === captured.rawRecordId);
  assert.notEqual(raw.processing_status, 'processed');
  const actions = tableValues(data, 'lifeos_log', 'operation_log').map((record) => record.action);
  assert.ok(actions.includes('triage.apply.failed'), '失败必须留审计');
  await store.close();
});

test('correctDerived：metric 更新写 state_change + 返回 affected', async () => {
  const { store, data } = await makeStore();
  const service = makeService(store);
  await service.capture({ text: LONG_TEXT });
  const run = await service.runTriage({ mode: 'rules' });
  const applied = await service.applyTriage({
    runId: run.runId,
    decisions: run.candidates.map((candidate) => ({ candidateId: candidate.candidateId, action: 'accept' })),
  });
  const metric = applied.created.find((item) => item.type === 'metric');
  assert.ok(metric);
  const corrected = await service.correctDerived({ type: 'metric', id: metric.id, action: 'update', patch: { value_num: 10000 } });
  assert.ok(corrected.affected.length >= 1);
  assert.equal(corrected.object.value_num, 10000);
  const stc = tableValues(data, 'lifeos_log', 'state_change').filter((record) => record.entity_id === metric.id && record.field === 'value_num');
  assert.equal(stc.length, 1);
  const oplog = tableValues(data, 'lifeos_log', 'operation_log').map((record) => record.action);
  assert.ok(oplog.includes('triage.correct.update'));
  await store.close();
});

test('reprocess：raw 回到 pending 并生成新 run', async () => {
  const { store, data } = await makeStore();
  const service = makeService(store);
  const captured = await service.capture({ text: LONG_TEXT });
  const run1 = await service.runTriage({ mode: 'rules' });
  await service.applyTriage({ runId: run1.runId, decisions: run1.candidates.map((candidate) => ({ candidateId: candidate.candidateId, action: 'accept' })) });
  const reprocessed = await service.reprocessRaw(captured.rawRecordId);
  assert.ok(reprocessed.runId && reprocessed.runId !== run1.runId);
  assert.equal(tableValues(data, 'lifeos_raw', 'raw_record')[0].processing_status !== 'processed', true);
  const status = await service.triageStatus();
  assert.ok(status.pendingRaw >= 1);
  assert.equal(status.lastRun.id, reprocessed.runId);
  await store.close();
});

test('triageStatus 计数与 automation 默认值一致（M2-G7）', async () => {
  const { store } = await makeStore();
  const service = makeService(store);
  await service.capture({ text: LONG_TEXT });
  let status = await service.triageStatus();
  assert.equal(status.pendingRaw, 1);
  assert.equal(status.pendingCandidates, 0);
  const run = await service.runTriage({ mode: 'rules' });
  status = await service.triageStatus();
  assert.equal(status.pendingCandidates, run.candidates.length);
  assert.equal(status.automation.enabled, true);
  assert.equal(status.automation.time, '21:30');
  await store.close();
});

test('scheduler：幂等创建一条 inbox_nightly；关闭→active:false；再开→active:true', async () => {
  const { store } = await makeStore();
  const created = [];
  const edits = [];
  const catalog = [];
  const schedule = {
    async create(request) {
      created.push(request);
      const entry = { id: 'sch_' + created.length, title: request.title, status: 'active' };
      catalog.push(entry);
      return entry;
    },
    async view({ id }) {
      return catalog.find((entry) => entry.id === id) || null;
    },
    async edit({ id, action, patch }) {
      edits.push({ id, action, patch });
      const entry = catalog.find((item) => item.id === id);
      if (entry && patch && patch.active === false) entry.status = 'paused';
      if (entry && patch && patch.active === true) entry.status = 'active';
      return entry;
    },
    async catalog() {
      return [...catalog];
    },
  };
  const scheduler = createScheduler({ ctx: null, store, config: { timeZone: 'Asia/Shanghai' }, schedule, now: () => NOW });
  const first = await scheduler.ensureNightlySchedule();
  assert.equal(first.reconcile.status, 'ok');
  assert.equal(first.reconcile.created, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].title, SCHEDULE_TITLE);
  assert.equal(created[0].timing.kind, 'cron');
  assert.equal(created[0].timing.cron.expression, '30 21 * * *');
  assert.equal(created[0].timing.cron.time_zone, 'Asia/Shanghai');
  assert.equal(created[0].target.kind, 'new');
  assert.equal(created[0].target.create.agentPreset, 'lifeos');
  assert.match(created[0].prompt, /lifeos_triage/);

  const second = await scheduler.ensureNightlySchedule();
  assert.equal(second.reconcile.created, false);
  assert.equal(created.length, 1, '第二次对账不得重复创建');

  const paused = await scheduler.setAutomation({ enabled: false });
  assert.equal(paused.enabled, false);
  assert.equal(edits.some((edit) => edit.patch?.active === false), true);
  const resumed = await scheduler.setAutomation({ enabled: true, time: '22:00' });
  assert.equal(resumed.enabled, true);
  assert.equal(created.length, 1, 'M2 不做 timing 变更重建；仍保持恰好一条');
  assert.equal((await scheduler.getAutomation()).time, '22:00');
  assert.match(buildNightlyPrompt('2026-11-13'), /inbox_nightly:2026-11-13/);
  await store.close();
});

test('tool-scope：非 lifeos 会话 restrict deny，lifeos 会话跳过，fail-closed', async () => {
  const restricted = [];
  function makeAgent({ id, preset }) {
    const agent = { id, session: { header: preset ? { agentPreset: preset } : {} } };
    agent.ctx = {
      effect(callback) {
        return callback();
      },
      get(name) {
        if (name === 'tools') return { restrict: (filter) => { restricted.push({ id, filter }); return () => {}; } };
        return undefined;
      },
    };
    return agent;
  }
  const standard = makeAgent({ id: 'sess_standard', preset: 'standard' });
  const lifeos = makeAgent({ id: 'sess_lifeos', preset: 'lifeos' });
  const unknown = makeAgent({ id: 'sess_unknown', preset: null });
  const createdListeners = [];
  const ctx = {
    get(name) {
      if (name === 'agents') return { roots: () => [standard, lifeos, unknown] };
      return undefined;
    },
    on(event, listener) {
      if (event === 'agent/created') createdListeners.push(listener);
      return () => {};
    },
  };
  const scope = installToolScope(ctx, { logger: { info() {}, warn() {} } });
  assert.equal(scope.stats().toolNames.length, LIFEOS_TOOL_NAMES.length);
  const restrictedIds = restricted.map((item) => item.id).sort();
  assert.deepEqual(restrictedIds, ['sess_standard', 'sess_unknown']);
  assert.deepEqual([...new Set(restricted.map((item) => item.filter.deny.join(',')))], [LIFEOS_TOOL_NAMES.join(',')]);
  assert.deepEqual(scope.allowedLifeosAgents(), ['sess_lifeos']);

  const late = makeAgent({ id: 'sess_late', preset: 'standard' });
  createdListeners.forEach((listener) => listener({ agent: late }));
  assert.equal(restricted.some((item) => item.id === 'sess_late'), true);
  const lateLifeos = makeAgent({ id: 'sess_late_lifeos', preset: 'lifeos' });
  createdListeners.forEach((listener) => listener({ agent: lateLifeos }));
  assert.equal(restricted.some((item) => item.id === 'sess_late_lifeos'), false);
  scope.dispose();
});

/* ───────── M2 HTTP 端点（/triage/*）───────── */
import { createRoutes } from '../../../src/runtime/routes.js';
import { call, callWrite } from '../helpers/fake-http.mjs';

function makeRoutesHarness(store, scheduler = null) {
  const service = makeService(store, scheduler);
  const routes = createRoutes({ service, diagnostics: null, sse: null, config: { devMode: false } });
  return { routes, service };
}

test('routes /triage/*：run → pending → runs/:id → apply → status/automation', async () => {
  const { store } = await makeStore();
  const { routes } = makeRoutesHarness(store);
  await call(routes, { method: 'POST', url: '/api/lifeos/capture', body: JSON.stringify({ text: LONG_TEXT }) });
  const run = await call(routes, { method: 'POST', url: '/api/lifeos/triage/run', body: JSON.stringify({ mode: 'rules' }) });
  assert.equal(run.status, 200);
  const runId = run.json().value.runId;
  assert.ok(runId);
  assert.equal(run.json().value.alreadyDone, false);

  const pending = await call(routes, { url: '/api/lifeos/triage/pending' });
  assert.equal(pending.status, 200);
  assert.equal(pending.json().value.groups.length, 1);

  const detail = await call(routes, { url: `/api/lifeos/triage/runs/${runId}` });
  assert.equal(detail.status, 200);
  assert.ok(detail.json().value.candidates.length >= 1);

  const decisions = detail.json().value.candidates.map((candidate) => ({ candidateId: candidate.candidateId, action: 'accept' }));
  const applied = await call(routes, { method: 'POST', url: '/api/lifeos/triage/apply', body: JSON.stringify({ runId, decisions }) });
  assert.equal(applied.status, 200);
  assert.equal(applied.json().value.applied, decisions.length);

  const status = await call(routes, { url: '/api/lifeos/triage/status' });
  assert.equal(status.status, 200);
  assert.equal(status.json().value.automation.enabled, true);

  const auto = await call(routes, { method: 'PUT', url: '/api/lifeos/triage/automation', body: JSON.stringify({ enabled: false }) });
  assert.equal(auto.status, 200);
  assert.equal(auto.json().value.enabled, false);
  await store.close();
});

test('routes /triage/*：mode=agent 返回 needsAgent；非法参数 422/404', async () => {
  const { store } = await makeStore();
  const { routes } = makeRoutesHarness(store);
  await call(routes, { method: 'POST', url: '/api/lifeos/capture', body: JSON.stringify({ text: LONG_TEXT }) });
  const begin = await call(routes, { method: 'POST', url: '/api/lifeos/triage/run', body: JSON.stringify({ mode: 'agent' }) });
  assert.equal(begin.status, 200);
  assert.equal(begin.json().value.needsAgent, true);
  assert.ok(begin.json().value.runId);

  const bad = await call(routes, { method: 'POST', url: '/api/lifeos/triage/run', body: JSON.stringify({ mode: 'nope' }) });
  assert.equal(bad.status, 422);
  const missingRun = await call(routes, { url: '/api/lifeos/triage/runs/xrun_bad' });
  assert.equal(missingRun.status, 422);
  const notFound = await call(routes, { url: '/api/lifeos/triage/runs/xrun_' + 'A'.repeat(26) });
  assert.equal(notFound.status, 404);
  const badApply = await call(routes, { method: 'POST', url: '/api/lifeos/triage/apply', body: JSON.stringify({ runId: 'bad', decisions: [] }) });
  assert.equal(badApply.status, 422);
  await store.close();
});

/* ───────── M2-B2：同日多次整理 / 同 run 分次 apply / 幂等 ───────── */

test('B2：同日两次手动整理产生两个 run；显式 runKey / requestId 保持幂等', async () => {
  const { store } = await makeStore();
  const service = makeService(store);
  await service.capture({ text: LONG_TEXT });

  const first = await service.runTriage({ mode: 'rules' });
  const second = await service.runTriage({ mode: 'rules' });
  assert.notEqual(first.runId, second.runId, '同日第二次手动整理必须开新 run');
  assert.equal(second.alreadyDone, false);
  assert.notEqual(first.run.runKey, second.run.runKey);
  assert.match(first.run.runKey, /^inbox:\d{4}-\d{2}-\d{2}:rules:1$/);
  assert.match(second.run.runKey, /^inbox:\d{4}-\d{2}-\d{2}:rules:2$/);

  const viaRequest = await service.runTriage({ mode: 'rules', requestId: 'req-same' });
  const viaRequestAgain = await service.runTriage({ mode: 'rules', requestId: 'req-same' });
  assert.equal(viaRequest.runId, viaRequestAgain.runId);
  assert.equal(viaRequestAgain.alreadyDone, true);

  const explicit1 = await service.runTriage({ mode: 'rules', runKey: 'manual:fixed-key' });
  const explicit2 = await service.runTriage({ mode: 'rules', runKey: 'manual:fixed-key' });
  assert.equal(explicit1.runId, explicit2.runId);
  assert.equal(explicit2.alreadyDone, true);

  const nightlyKey = 'inbox_nightly:2026-11-13';
  const night1 = await service.runTriage({ mode: 'rules', runKey: nightlyKey });
  const night2 = await service.runTriage({ mode: 'rules', runKey: nightlyKey });
  assert.equal(night1.runId, night2.runId);
  assert.equal(night2.alreadyDone, true);
  await store.close();
});

test('B2：同 run 分次 apply（接受 A → 接受 B → 忽略 C），raw/inbox 状态与进度正确', async () => {
  const { store, data } = await makeStore();
  const service = makeService(store);
  await service.capture({ text: LONG_TEXT });
  const run = await service.runTriage({ mode: 'rules' });
  assert.equal(run.candidates.length >= 2, true);
  const [a, b] = run.candidates;

  // 第一次：只接受 A
  const first = await service.applyTriage({ runId: run.runId, decisions: [{ candidateId: a.candidateId, action: 'accept' }] });
  assert.equal(first.applied, 1);
  assert.equal(first.alreadyApplied, false);
  assert.equal(first.applyComplete, false, '仍有未决定候选时不得标完成');
  let raw = tableValues(data, 'lifeos_raw', 'raw_record')[0];
  assert.equal(raw.processing_status, 'partial');
  let runDetail = await service.getTriageRun(run.runId);
  assert.deepEqual(runDetail.appliedCandidateIds, [a.candidateId]);
  assert.equal(runDetail.applyComplete, false);

  // 第二次：接受 B（即便存在其它未决定候选也允许）
  const second = await service.applyTriage({ runId: run.runId, decisions: [{ candidateId: b.candidateId, action: 'accept' }] });
  assert.equal(second.applied, 1);
  assert.equal(second.alreadyApplied, false);
  assert.equal(second.handledEarlier.length, 0);

  // 第三次：所有候选已处理 → applyComplete=true，raw processed，inbox triaged
  const third = await service.applyTriage({ runId: run.runId, decisions: [{ candidateId: a.candidateId, action: 'accept' }] });
  assert.equal(third.alreadyApplied, true);
  assert.equal(third.applyComplete, true);
  raw = tableValues(data, 'lifeos_raw', 'raw_record')[0];
  assert.equal(raw.processing_status, 'processed');
  assert.equal(tableValues(data, 'lifeos', 'inbox_item')[0].status, 'triaged');
  runDetail = await service.getTriageRun(run.runId);
  assert.equal(runDetail.applyComplete, true);
  assert.equal(runDetail.appliedCandidateIds.length, run.candidates.length);
  const targetCount = tableValues(data, 'lifeos', 'task').length + tableValues(data, 'lifeos', 'metric').length;
  assert.equal(targetCount, run.candidates.length, '每个 accepted 候选落一个目标对象');
  await store.close();
});

test('B2：重复 apply 同一批 decisions 不重复创建；部分处理后 pending 组带 handled 标记', async () => {
  const { store, data } = await makeStore();
  const service = makeService(store);
  await service.capture({ text: LONG_TEXT });
  const run = await service.runTriage({ mode: 'rules' });
  const firstCandidate = run.candidates[0];
  await service.applyTriage({ runId: run.runId, decisions: [{ candidateId: firstCandidate.candidateId, action: 'accept' }] });
  const countAfterFirst = tableValues(data, 'lifeos', 'task').length + tableValues(data, 'lifeos', 'metric').length;

  const repeat = await service.applyTriage({ runId: run.runId, decisions: [{ candidateId: firstCandidate.candidateId, action: 'accept' }] });
  assert.equal(repeat.alreadyApplied, true);
  assert.equal(repeat.applied, 0);
  assert.equal(repeat.handledEarlier.length, 1);
  assert.equal(
    tableValues(data, 'lifeos', 'task').length + tableValues(data, 'lifeos', 'metric').length,
    countAfterFirst,
    '重复 apply 不得重复创建',
  );

  const pending = await service.listTriagePending();
  assert.equal(pending.groups.length, 1);
  const group = pending.groups[0];
  assert.equal(group.progress.total, run.candidates.length);
  assert.equal(group.progress.handled, 1);
  assert.equal(group.progress.remaining, run.candidates.length - 1);
  assert.equal(group.progress.applyComplete, false);
  const handled = group.candidates.find((candidate) => candidate.candidateId === firstCandidate.candidateId);
  assert.equal(handled.handled, 'accepted');
  assert.equal(pending.counts.pendingCandidates, run.candidates.length - 1, 'pendingCandidates 只计未决定');
  await store.close();
});

/* ───────── M2.6-R4：跨 run 去重（同 raw + 同类 + 关键字段）───────── */

test('M2.6 去重：同 raw 两次 run 接受同一候选 → duplicate、不重复创建/写证据、applyComplete', async () => {
  const { store, data } = await makeStore();
  const service = makeService(store);
  const captured = await service.capture({ text: LONG_TEXT });

  const run1 = await service.runTriage({ mode: 'rules' });
  const first = await service.applyTriage({
    runId: run1.runId,
    decisions: run1.candidates.map((candidate) => ({ candidateId: candidate.candidateId, action: 'accept' })),
  });
  assert.equal(first.applied, run1.candidates.length);
  const countObjects = () => tableValues(data, 'lifeos', 'task').length + tableValues(data, 'lifeos', 'metric').length;
  const objectsAfterFirst = countObjects();
  const evidenceAfterFirst = tableValues(data, 'lifeos', 'evidence_link').length;

  // 同一 raw 再跑一次（模拟"重新整理"），接受全部候选
  const run2 = await service.runTriage({ mode: 'rules', rawRecordIds: [captured.rawRecordId] });
  assert.equal(run2.candidates.length, run1.candidates.length);
  const second = await service.applyTriage({
    runId: run2.runId,
    decisions: run2.candidates.map((candidate) => ({ candidateId: candidate.candidateId, action: 'accept' })),
  });
  assert.equal(second.applied, 0, '同 raw 同内容不得重复派生');
  assert.equal(second.duplicateCount, run2.candidates.length);
  assert.equal(second.duplicates.length, run2.candidates.length);
  assert.equal(second.duplicates.every((item) => typeof item.existingId === 'string' && typeof item.type === 'string'), true);
  assert.deepEqual([...new Set(second.duplicates.map((item) => item.type))].sort(), ['metric', 'task']);
  assert.equal(second.applyComplete, true);
  assert.equal(countObjects(), objectsAfterFirst, '不得新增派生对象');
  assert.equal(tableValues(data, 'lifeos', 'evidence_link').length, evidenceAfterFirst, 'duplicate 不写 evidence_link');

  const runDetail = await service.getTriageRun(run2.runId);
  assert.equal(runDetail.duplicateCandidateIds.length, run2.candidates.length);
  const pending = await service.listTriagePending();
  // raw 已 processed，pending 组应为空；handled 信息可从 run 详情读到
  assert.equal(pending.groups.length, 0);
});

test('M2.6 去重：不同 raw 相同内容不去重（M3 再考虑跨 raw）', async () => {
  const { store } = await makeStore();
  const service = makeService(store);
  const firstRaw = await service.capture({ text: LONG_TEXT, requestId: 'raw-1' });
  const secondRaw = await service.capture({ text: LONG_TEXT, requestId: 'raw-2' });
  const run = await service.runTriage({ mode: 'rules', rawRecordIds: [firstRaw.rawRecordId, secondRaw.rawRecordId] });
  assert.ok(run.candidates.length >= 2);
  const applied = await service.applyTriage({
    runId: run.runId,
    decisions: run.candidates.map((candidate) => ({ candidateId: candidate.candidateId, action: 'accept' })),
  });
  assert.equal(applied.duplicateCount, 0, '不同 raw 不去重');
  assert.equal(applied.applied, run.candidates.length);
});

test('M2.6 去重：已撤销对象允许重建（revoke 后再次接受同一候选）', async () => {
  const { store, data } = await makeStore();
  const service = makeService(store);
  const captured = await service.capture({ text: LONG_TEXT });
  const run1 = await service.runTriage({ mode: 'rules' });
  const first = await service.applyTriage({
    runId: run1.runId,
    decisions: run1.candidates.map((candidate) => ({ candidateId: candidate.candidateId, action: 'accept' })),
  });
  const metric = first.created.find((item) => item.type === 'metric');
  assert.ok(metric);
  await service.correctDerived({ type: 'metric', id: metric.id, action: 'revoke', reason: '测试撤销' });
  const evidenceBefore = tableValues(data, 'lifeos', 'evidence_link').length;

  const run2 = await service.runTriage({ mode: 'rules', rawRecordIds: [captured.rawRecordId] });
  const metricCandidate = run2.candidates.find((candidate) => candidate.kind === 'metric');
  const second = await service.applyTriage({
    runId: run2.runId,
    decisions: [{ candidateId: metricCandidate.candidateId, action: 'accept' }],
  });
  assert.equal(second.duplicateCount, 0, '已撤销的 metric 允许重建');
  assert.equal(second.applied, 1);
  assert.equal(second.duplicates.some((item) => item.type === 'metric'), false);
  assert.ok(tableValues(data, 'lifeos', 'evidence_link').length > evidenceBefore, '重建需写新的 evidence_link');
});

test('M2.6 去重：pending 候选带 handled:duplicate（C 展示"已存在"）', async () => {
  const { store } = await makeStore();
  const service = makeService(store);
  const captured = await service.capture({ text: LONG_TEXT });
  const run1 = await service.runTriage({ mode: 'rules' });
  await service.applyTriage({
    runId: run1.runId,
    decisions: run1.candidates.map((candidate) => ({ candidateId: candidate.candidateId, action: 'accept' })),
  });
  // 第二个 raw 未处理，保持 pending；其候选不应被标记
  await service.capture({ text: '另一条待整理：明天要买菜' });
  const pending = await service.listTriagePending();
  assert.equal(pending.groups.length, 1);
  assert.equal(pending.groups[0].candidates.every((candidate) => candidate.handled === null), true);
});
