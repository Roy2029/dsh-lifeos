/**
 * B 集成测试：Host 入口 index.js 的装配（用 fake Cordis ctx + A 的 fake kv backend）。
 *
 * 目标（对应 M0 门禁 G1/G2/G3 + 诊断）：
 *  - apply 不抛宿主；ctx.provide('lifeos', service) 被调用；
 *  - webServer 注册 prefix 路由；
 *  - agentPresets.register 收到 D 线的 lifeos preset；
 *  - runtime-diagnostics.json 落盘 stage=ready，gates G1/G2/G3 通过；
 *  - enabled=false 时不注册任何东西；重复 apply 不崩。
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { apply, name, inject, normalizeConfig, DEFAULT_CONFIG } from '../../../index.js';
import { createFakeBackend } from '../../unit/store/fake-backend.mjs';

const pendingEffects = [];

function makeCtx({ backend } = {}) {
  const effects = [];
  pendingEffects.push(effects);
  const provided = new Map();
  const routes = [];
  const presets = [];
  const logs = [];
  const storage = {
    backend: {
      get: (key) => (key === 'json' || key === 'storage-json' || key === 'default' ? backend : null),
      names: () => ['json'],
    },
  };
  const ctx = {
    get(serviceName) {
      if (serviceName === 'storage') return storage;
      if (serviceName === 'connection') return null;
      if (serviceName === 'agentPresets') return ctx.agentPresets;
      if (serviceName === 'webServer') return ctx.webServer;
      if (serviceName === 'tools') return ctx.tools;
      return undefined;
    },
    provide(serviceName, instance) {
      provided.set(serviceName, instance);
      return () => provided.delete(serviceName);
    },
    effect(callback, label) {
      const teardown = callback();
      effects.push({ label, teardown });
      return () => {};
    },
    logger() {
      return {
        info: (msg) => logs.push(['info', msg]),
        warn: (msg) => logs.push(['warn', msg]),
        error: (msg) => logs.push(['error', msg]),
      };
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    agentPresets: {
      async register(definition) {
        presets.push(definition);
        return async () => {};
      },
    },
    tools: {},
    storage,
  };
  return { ctx, effects, provided, routes, presets, logs, storage };
}

async function cleanup(effects) {
  for (const effect of [...effects].reverse()) {
    if (effect.done) continue;
    effect.done = true;
    try {
      const result = typeof effect.teardown === 'function' ? effect.teardown() : undefined;
      if (result && typeof result.then === 'function') await result;
    } catch {
      /* ignore */
    }
  }
}

afterEach(async () => {
  const batches = pendingEffects.splice(0);
  for (const effects of batches) await cleanup(effects);
});

function diagPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'lifeos-index-'));
  return {
    dir,
    diagnosticsPath: join(dir, 'runtime-diagnostics.json'),
    clientReportPath: join(dir, 'runtime-client-report.json'),
  };
}

function readDiag(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('index: 常量与配置归一化', () => {
  assert.equal(name, 'lifeos');
  assert.deepEqual(inject, ['storage', 'webServer', 'tools', 'agentPresets']);
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(DEFAULT_CONFIG.version, pkg.version, 'DEFAULT_CONFIG.version 必须来自 package.json');
  const { config, warnings } = normalizeConfig({
    enabled: true,
    timeZone: 'Asia/Shanghai',
    devMode: true,
    heartbeatMs: 5000,
    units: { core: 'lifeos', raw: 'lifeos_raw', log: 'lifeos_log' },
    unknownField: 'ignored',
  });
  assert.equal(config.timeZone, 'Asia/Shanghai');
  assert.equal(config.devMode, true);
  assert.equal(config.heartbeatMs, 5000);
  assert.deepEqual(warnings, []);

  const bad = normalizeConfig({ enabled: 'yes', timeZone: 'Not/AZone', heartbeatMs: -1, httpPrefix: 'nope' });
  assert.equal(bad.config.enabled, DEFAULT_CONFIG.enabled);
  assert.equal(bad.config.timeZone, DEFAULT_CONFIG.timeZone);
  assert.equal(bad.warnings.length >= 3, true);
});

test('index: apply 装配 ready（A store + D preset + HTTP + provide + 诊断）', async () => {
  const { backend } = createFakeBackend();
  const { ctx, effects, provided, routes, presets } = makeCtx({ backend });
  const paths = diagPaths();

  await apply(ctx, {
    enabled: true,
    timeZone: 'Asia/Shanghai',
    devMode: false,
    heartbeatMs: 60000,
    diagnosticsPath: paths.diagnosticsPath,
    clientReportPath: paths.clientReportPath,
  });

  // 服务暴露（单例）
  assert.equal(provided.has('lifeos'), true);
  const service = provided.get('lifeos');
  assert.equal(service.status().ok, true);
  assert.equal(service.status().degraded, false);
  assert.equal(typeof service.capture, 'function');
  assert.equal(typeof service.today, 'function');
  assert.equal(typeof service.query, 'function');

  // HTTP prefix 路由
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, '/api/lifeos');
  assert.equal(typeof routes[0].handler, 'function');

  // preset（D 线）
  assert.equal(presets.length, 1);
  assert.equal(presets[0].id, 'lifeos');
  assert.equal(presets[0].plugins[0].name, 'dsh-lifeos/agent');

  // effect 持有：store/sse/http/preset/provide 至少 5 个
  assert.ok(effects.length >= 5);
  assert.ok(effects.some((effect) => effect.label === 'lifeos.store'));
  assert.ok(effects.some((effect) => effect.label === 'lifeos.sse'));

  // 诊断文件
  const diag = readDiag(paths.diagnosticsPath);
  assert.equal(diag.stage, 'ready');
  assert.equal(diag.ok, true);
  assert.equal(diag.gates.G1.status, true);
  assert.equal(diag.gates.G2.status, true);
  assert.equal(diag.gates.G3.status, true);
  assert.equal(diag.gates.G4.status, true);
  assert.equal(diag.units.lifeos.open, true);
  assert.equal(diag.backend, 'json');

  await cleanup(effects);
});

test('index: apply 后 HTTP handler 端到端（health/capture/query/SSE）', async () => {
  const { backend } = createFakeBackend();
  const { ctx, effects, routes } = makeCtx({ backend });
  const paths = diagPaths();
  await apply(ctx, {
    enabled: true,
    heartbeatMs: 60000,
    diagnosticsPath: paths.diagnosticsPath,
    clientReportPath: paths.clientReportPath,
  });
  const handler = routes[0].handler;

  function makeRes() {
    const chunks = [];
    const headers = {};
    return {
      statusCode: 0,
      headers,
      on() {},
      setHeader(key, value) {
        headers[key.toLowerCase()] = value;
      },
      writeHead(code, extra) {
        this.statusCode = code;
        if (extra) Object.assign(headers, extra);
      },
      write(chunk) {
        chunks.push(String(chunk));
        return true;
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(String(chunk));
        this.ended = true;
      },
      json() {
        return JSON.parse(chunks.join(''));
      },
      text() {
        return chunks.join('');
      },
    };
  }

  const healthReq = { method: 'GET', url: '/api/lifeos/health', headers: { host: '127.0.0.1:52508' }, on() {} };
  const healthRes = makeRes();
  await handler(healthReq, healthRes);
  assert.equal(healthRes.statusCode, 200);
  assert.equal(healthRes.headers['x-lifeos-api'], '0.7');
  assert.equal(healthRes.json().ok, true);

  const capReq = {
    method: 'POST',
    url: '/api/lifeos/capture',
    headers: { host: '127.0.0.1:52508' },
    body: JSON.stringify({ text: '装配端到端测试' }),
    on() {},
  };
  const capRes = makeRes();
  await handler(capReq, capRes);
  assert.equal(capRes.statusCode, 200);
  assert.match(capRes.json().value.inboxItemId, /^inb_/);

  const queryReq = { method: 'GET', url: '/api/lifeos/query?view=inbox_pending', headers: { host: '127.0.0.1:52508' }, on() {} };
  const queryRes = makeRes();
  await handler(queryReq, queryRes);
  assert.equal(queryRes.json().value.items.length, 1);

  // SSE
  const sseReq = { method: 'GET', url: '/api/lifeos/events', headers: { host: '127.0.0.1:52508' }, on() {} };
  const sseRes = makeRes();
  await handler(sseReq, sseRes);
  assert.match(sseRes.headers['content-type'], /text\/event-stream/);
  assert.match(sseRes.text(), /event: hello/);
  await cleanup(effects);
});

test('index: enabled=false 不注册任何组件，stage=disabled', async () => {
  const { ctx, effects, provided, routes, presets } = makeCtx();
  const paths = diagPaths();
  await apply(ctx, {
    enabled: false,
    diagnosticsPath: paths.diagnosticsPath,
    clientReportPath: paths.clientReportPath,
  });
  assert.equal(provided.size, 0);
  assert.equal(routes.length, 0);
  assert.equal(presets.length, 0);
  assert.equal(effects.length, 0);
  const diag = readDiag(paths.diagnosticsPath);
  assert.equal(diag.stage, 'disabled');
  await cleanup(effects);
});

test('index: 存储 open 失败 -> 降级激活（provide 仍在、stage=degraded、不抛）', async () => {
  const { backend } = createFakeBackend({ failOpen: true });
  const { ctx, effects, provided, routes } = makeCtx({ backend });
  const paths = diagPaths();
  await assert.doesNotReject(() =>
    apply(ctx, {
      enabled: true,
      diagnosticsPath: paths.diagnosticsPath,
      clientReportPath: paths.clientReportPath,
    }),
  );
  assert.equal(provided.has('lifeos'), true);
  assert.equal(provided.get('lifeos').status().degraded, true);
  assert.equal(routes.length, 1, '降级时仍注册 HTTP 以返回结构化 503');
  const diag = readDiag(paths.diagnosticsPath);
  assert.equal(diag.stage, 'degraded');
  assert.equal(diag.gates.G2.status, false);
  assert.equal(diag.gates.G6.status, true);

  // 降级下 capture -> 503 store_unavailable
  const capReq = {
    method: 'POST',
    url: '/api/lifeos/capture',
    headers: { host: '127.0.0.1:52508' },
    body: JSON.stringify({ text: 'x' }),
    on() {},
  };
  const res = {
    statusCode: 0,
    headers: {},
    on() {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    writeHead(code, extra) {
      this.statusCode = code;
      if (extra) Object.assign(this.headers, extra);
    },
    write() {
      return true;
    },
    end(chunk) {
      this.body = chunk;
    },
  };
  await routes[0].handler(capReq, res);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).error.code, 'store_unavailable');
  await cleanup(effects);
});
