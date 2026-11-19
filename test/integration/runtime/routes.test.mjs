import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLifeosService } from '../../../src/application/lifeos-service.js';
import { createDiagnostics } from '../../../src/runtime/diagnostics.js';
import { createEventBus } from '../../../src/runtime/sse.js';
import { createSseServer } from '../../../src/runtime/sse.js';
import { createRoutes } from '../../../src/runtime/routes.js';
import { createMemoryStore } from '../../../src/runtime/memory-store.js';
import { createFakeStore, createTestDiagnostics } from '../helpers/fake-store.mjs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOST = '127.0.0.1:52508';

function makeReq({ method = 'GET', url = '/api/lifeos/health', headers = {}, body } = {}) {
  const listeners = new Map();
  return {
    method,
    url,
    headers: { host: HOST, ...headers },
    body,
    on(event, fn) {
      listeners.set(event, fn);
    },
    emit(event, ...args) {
      const fn = listeners.get(event);
      if (fn) fn(...args);
    },
    listeners,
  };
}

function makeRes() {
  const chunks = [];
  const headers = {};
  return {
    statusCode: 0,
    headers,
    ended: false,
    on() {},
    setHeader(key, value) {
      headers[key.toLowerCase()] = value;
    },
    writeHead(code, extra) {
      this.statusCode = code;
      if (extra) for (const [key, value] of Object.entries(extra)) headers[key.toLowerCase()] = value;
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk));
      this.ended = true;
    },
    text() {
      return chunks.join('');
    },
    json() {
      return JSON.parse(this.text());
    },
  };
}

async function call(routes, { method, url, headers, body }) {
  const req = makeReq({ method, url, headers, body });
  const res = makeRes();
  await routes.handle(req, res);
  return { req, res, status: res.statusCode, json: () => res.json() };
}

function makeRoutes(overrides = {}) {
  const store = overrides.store || createFakeStore();
  const diagnostics = overrides.diagnostics || createTestDiagnostics();
  const bus = createEventBus();
  const sse =
    overrides.sse ||
    createSseServer({ bus, heartbeatMs: 60000, setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} });
  const service = createLifeosService({
    store,
    config: Object.assign({ timeZone: 'Asia/Shanghai', devMode: false }, overrides.config || {}),
    diagnostics,
    bus,
    now: () => Date.parse('2026-11-12T14:00:00.000Z'),
  });
  const routes = createRoutes({
    service,
    diagnostics,
    sse,
    config: Object.assign({ devMode: false }, overrides.config || {}),
    connection: overrides.connection || null,
  });
  return { routes, service, store, diagnostics, bus, sse };
}

test('routes: 信封头与健康检查', async () => {
  const { routes } = makeRoutes();
  const { status, res } = await call(routes, { url: '/api/lifeos/health' });
  assert.equal(status, 200);
  assert.equal(res.headers['x-lifeos-api'], '0.7');
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.value.status.ok, true);
  assert.equal(typeof body.value.uptimeMs, 'number');
  assert.ok(body.value.gates && typeof body.value.gates === 'object');
});

test('routes: bootstrap 返回 today/counts/settings/apiVersion 与降级状态', async () => {
  const { routes } = makeRoutes();
  const { status, res } = await call(routes, { url: '/api/lifeos/bootstrap' });
  assert.equal(status, 200);
  const value = res.json().value;
  assert.equal(value.degraded, false);
  assert.equal(typeof value.backend, 'string');
  assert.equal(typeof value.version, 'string');
});

test('routes: capture -> query 全链路', async () => {
  const { routes } = makeRoutes();
  const captured = await call(routes, {
    method: 'POST',
    url: '/api/lifeos/capture',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '周五前交实验结果', source: 'panel', requestId: 'r-1' }),
  });
  assert.equal(captured.status, 200);
  const captureBody = captured.res.json();
  assert.equal(captureBody.ok, true);
  assert.match(captureBody.value.rawRecordId, /^rr_/);
  assert.match(captureBody.value.inboxItemId, /^inb_/);

  const inbox = await call(routes, { url: '/api/lifeos/query?view=inbox_pending&limit=10' });
  assert.equal(inbox.status, 200);
  const inboxBody = inbox.res.json();
  assert.equal(inboxBody.ok, true);
  assert.equal(inboxBody.value.items.length, 1);
  assert.equal(inboxBody.value.nextCursor, null);

  const today = await call(routes, { url: '/api/lifeos/query?view=today' });
  assert.equal(today.status, 200);
  assert.equal(today.res.json().ok, true);
});

test('routes: capture 幂等（同 requestId 同结果）', async () => {
  const { routes } = makeRoutes();
  const body = JSON.stringify({ text: '幂等测试', requestId: 'dup-1' });
  const first = await call(routes, { method: 'POST', url: '/api/lifeos/capture', body });
  const second = await call(routes, { method: 'POST', url: '/api/lifeos/capture', body });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const a = first.res.json().value;
  const b = second.res.json().value;
  assert.equal(a.inboxItemId, b.inboxItemId);
  assert.equal(a.rawRecordId, b.rawRecordId);
});

test('routes: 校验失败 422 validation_failed', async () => {
  const { routes } = makeRoutes();
  const empty = await call(routes, { method: 'POST', url: '/api/lifeos/capture', body: '{"text":"  "}' });
  assert.equal(empty.status, 422);
  assert.equal(empty.res.json().error.code, 'validation_failed');

  const badJson = await call(routes, { method: 'POST', url: '/api/lifeos/capture', body: '{bad' });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.res.json().error.code, 'bad_request');

  const badQuery = await call(routes, { url: '/api/lifeos/query?view=nope' });
  assert.equal(badQuery.status, 422);
  assert.equal(badQuery.res.json().error.code, 'validation_failed');
});

test('routes: 404 未知端点/未知路径', async () => {
  const { routes } = makeRoutes();
  const unknown = await call(routes, { url: '/api/lifeos/nope' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.res.json().error.code, 'not_found');
  const wrongMethod = await call(routes, { method: 'POST', url: '/api/lifeos/health' });
  assert.equal(wrongMethod.status, 404);
});

test('routes: 鉴权回退（无 host / 非本机 host / 跨源 origin = 401）', async () => {
  const { routes } = makeRoutes();
  const noHost = makeReq({ url: '/api/lifeos/health', headers: {} });
  noHost.headers = {};
  const res1 = makeRes();
  await routes.handle(noHost, res1);
  assert.equal(res1.statusCode, 401);

  const foreign = await call(routes, { url: '/api/lifeos/health', headers: { host: 'evil.example.com' } });
  assert.equal(foreign.status, 401);

  const crossOrigin = await call(routes, {
    url: '/api/lifeos/health',
    headers: { origin: 'http://evil.example.com' },
  });
  assert.equal(crossOrigin.status, 401);

  const localhost = await call(routes, { url: '/api/lifeos/health', headers: { host: 'localhost:52508' } });
  assert.equal(localhost.status, 200);
});

test('routes: connection.requestRejection 优先（返回 403）', async () => {
  const { routes } = makeRoutes({ connection: { requestRejection: () => ({ rejected: true }) } });
  const result = await call(routes, { url: '/api/lifeos/health' });
  assert.equal(result.status, 403);
  assert.equal(result.res.json().error.code, 'forbidden');
});

test('routes: OPTIONS 204', async () => {
  const { routes } = makeRoutes();
  const result = await call(routes, { method: 'OPTIONS', url: '/api/lifeos/capture' });
  assert.equal(result.status, 204);
  assert.equal(result.res.headers['access-control-allow-methods'], 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
});

test('routes: dev/client-report 写诊断', async () => {
  const diagnostics = createTestDiagnostics();
  const { routes } = makeRoutes({ diagnostics });
  const result = await call(routes, {
    method: 'POST',
    url: '/api/lifeos/dev/client-report',
    body: JSON.stringify({ panel: 'ok', bootstrapOk: true, sse: 'hello' }),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.res.json().value, { received: true });
  assert.equal(diagnostics.getClientReport().panel, 'ok');
});

test('routes: dev/status 默认被拒绝（forbidden），devMode 开启后返回诊断', async () => {
  const denied = await call(makeRoutes().routes, { url: '/api/lifeos/dev/status' });
  assert.equal(denied.status, 403);
  assert.equal(denied.res.json().error.code, 'forbidden');

  const { routes, sse } = makeRoutes({ config: { devMode: true } });
  const result = await call(routes, { url: '/api/lifeos/dev/status' });
  assert.equal(result.status, 200);
  const value = result.res.json().value;
  assert.equal(value.sseClients, 0);
  assert.ok(Array.isArray(value.recentErrors));
  assert.equal(value.devMode, true);
  assert.equal(typeof sse.clientCount(), 'number');
});

test('routes: dev/capture-cleanup 默认被拒绝，clientSelfCheck 开启后放行', async () => {
  const denied = await call(makeRoutes().routes, {
    method: 'POST',
    url: '/api/lifeos/dev/capture-cleanup',
    body: JSON.stringify({}),
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.res.json().error.code, 'forbidden');

  const { routes } = makeRoutes({ config: { clientSelfCheck: true } });
  const allowed = await call(routes, {
    method: 'POST',
    url: '/api/lifeos/dev/capture-cleanup',
    body: JSON.stringify({}),
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.res.json().value.deleted.raw, false);
});

test('routes: degraded store -> 503 store_unavailable + health 可见 degraded', async () => {
  const store = createMemoryStore({ reason: '单测降级' });
  await store.open();
  const { routes } = makeRoutes({ store });
  const health = await call(routes, { url: '/api/lifeos/health' });
  assert.equal(health.status, 200);
  assert.equal(health.res.json().value.status.degraded, true);

  const capture = await call(routes, {
    method: 'POST',
    url: '/api/lifeos/capture',
    body: JSON.stringify({ text: '写不进去' }),
  });
  assert.equal(capture.status, 503);
  assert.equal(capture.res.json().error.code, 'store_unavailable');
});

test('routes: SSE 连接收到 hello，capture 后收到 changed', async () => {
  const { routes, res: _ } = makeRoutes();
  const req = makeReq({ url: '/api/lifeos/events', headers: { accept: 'text/event-stream' } });
  const res = makeRes();
  await routes.handle(req, res);
  const stream1 = res.text();
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.match(stream1, /event: hello/);
  assert.match(stream1, /retry: 3000/);

  const captured = await call(routes, {
    method: 'POST',
    url: '/api/lifeos/capture',
    body: JSON.stringify({ text: '触发 SSE' }),
  });
  assert.equal(captured.status, 200);
  const stream2 = res.text();
  assert.match(stream2, /event: changed/);
  assert.match(stream2, /"kind":"capture"/);
  const ids = captured.res.json().value;
  assert.ok(stream2.includes(ids.inboxItemId));
});

test('routes: SSE Last-Event-ID 续传（回放环形缓冲）', async () => {
  const { routes, bus, sse } = makeRoutes();
  bus.publish({ type: 'changed', data: { kind: 'capture', ids: ['inb_old'] } }); // id=1
  bus.publish({ type: 'changed', data: { kind: 'capture', ids: ['inb_new'] } }); // id=2
  const req = makeReq({
    url: '/api/lifeos/events',
    headers: { 'last-event-id': '1' },
  });
  const res = makeRes();
  await routes.handle(req, res);
  const text = res.text();
  assert.match(text, /id: 2/);
  assert.match(text, /event: changed/);
  assert.match(text, /inb_new/);
  assert.ok(!text.includes('inb_old'), '不应回放已确认的旧事件');
  assert.match(text, /event: hello/);
  sse.close();
});

test('routes: SSE 缓冲滚出时下发 resync', async () => {
  const bus = createEventBus();
  const sse = createSseServer({
    bus,
    ringSize: 2,
    heartbeatMs: 60000,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  const { routes } = makeRoutes({ sse, bus });
  for (let i = 0; i < 5; i += 1) bus.publish({ type: 'changed', data: { kind: 'test', ids: [String(i)] } });
  const req = makeReq({ url: '/api/lifeos/events', headers: { 'last-event-id': '1' } });
  const res = makeRes();
  await routes.handle(req, res);
  const text = res.text();
  assert.match(text, /event: resync/);
  assert.match(text, /event: hello/);
  sse.close();
});

test('diagnostics: 真实文件写入 + 错误环形 + client-report 文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeos-diag-'));
  const diagnostics = createDiagnostics({
    diagnosticsPath: join(dir, 'runtime-diagnostics.json'),
    clientReportPath: join(dir, 'runtime-client-report.json'),
  });
  diagnostics.setStage('ready', { ok: true, counts: { inboxPending: 1 } });
  diagnostics.setGate('G2', true, { backend: 'json' });
  for (let i = 0; i < 25; i += 1) diagnostics.recordError('internal', `err-${i}`);
  assert.equal(diagnostics.getErrors().length, 20);
  assert.equal(diagnostics.getErrors()[19].message, 'err-24');
  const report = diagnostics.clientReport({ panel: 'ok' });
  assert.equal(report.received, true);
  assert.equal(diagnostics.getClientReport().report.panel, 'ok');

  const { readFileSync } = await import('node:fs');
  const snapshot = JSON.parse(readFileSync(join(dir, 'runtime-diagnostics.json'), 'utf8'));
  assert.equal(snapshot.stage, 'ready');
  assert.equal(snapshot.gates.G2.status, true);
  assert.equal(snapshot.errors.length, 20);
  const client = JSON.parse(readFileSync(join(dir, 'runtime-client-report.json'), 'utf8'));
  assert.equal(client.report.panel, 'ok');
});
