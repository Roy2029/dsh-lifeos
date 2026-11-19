/**
 * B：运行诊断（M0-PLAN §3.8）。
 *
 * 产物（仓库根；gitignore）：
 *  - runtime-diagnostics.json      ：{at,pid,stage,ok,gates,units,counts,errors[],config,uptimeMs}
 *  - runtime-client-report.json    ：Client 自检回传（G5 门禁用）
 *
 * 约束：写诊断失败绝不能影响插件；errors 环形最多 20 条；不写用户原文。
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_ERRORS = 20;
const DEFAULT_DIAG = fileURLToPath(new URL('../../runtime-diagnostics.json', import.meta.url));
const DEFAULT_CLIENT = fileURLToPath(new URL('../../runtime-client-report.json', import.meta.url));

function nowIso(now) {
  try {
    return new Date(now()).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.diagnosticsPath]
 * @param {string} [options.clientReportPath]
 * @param {number} [options.pid]
 * @param {()=>number} [options.now]
 */
export function createDiagnostics(options = {}) {
  const diagnosticsPath = options.diagnosticsPath || DEFAULT_DIAG;
  const clientReportPath = options.clientReportPath || DEFAULT_CLIENT;
  const pid = options.pid ?? (typeof process !== 'undefined' ? process.pid : 0);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const startedAt = now();

  const state = {
    at: null,
    pid,
    stage: 'created',
    ok: false,
    gates: {},
    units: {},
    counts: {},
    errors: [],
    config: null,
    backend: null,
    version: null,
    uptimeMs: 0,
  };
  let clientReport = null;
  const clientReportHistory = [];
  const trace = [];

  function snapshot() {
    return JSON.parse(
      JSON.stringify({
        ...state,
        at: state.at || nowIso(now),
        uptimeMs: now() - startedAt,
        trace: [...trace],
      }),
    );
  }

  function write() {
    state.at = nowIso(now);
    state.uptimeMs = now() - startedAt;
    try {
      writeFileSync(diagnosticsPath, JSON.stringify(snapshot(), null, 2), 'utf8');
    } catch {
      /* 诊断失败不影响插件 */
    }
  }

  return {
    paths: { diagnostics: diagnosticsPath, clientReport: clientReportPath },
    get state() {
      return state;
    },
    setStage(stage, patch = {}) {
      state.stage = stage;
      if (patch.ok !== undefined) state.ok = Boolean(patch.ok);
      if (patch.units !== undefined) state.units = patch.units;
      if (patch.counts !== undefined) state.counts = patch.counts;
      if (patch.config !== undefined) state.config = patch.config;
      if (patch.backend !== undefined) state.backend = patch.backend;
      if (patch.version !== undefined) state.version = patch.version;
      trace.push(`${stage}${patch.detail ? `: ${patch.detail}` : ''}`);
      write();
      return snapshot();
    },
    setGate(name, status, detail) {
      state.gates[name] = detail === undefined ? status : { status, detail };
      write();
      return snapshot();
    },
    recordError(code, message, details) {
      const entry = {
        at: nowIso(now),
        code: String(code || 'internal'),
        message: String(message || '').slice(0, 500),
      };
      if (details !== undefined) entry.details = details;
      state.errors.push(entry);
      while (state.errors.length > MAX_ERRORS) state.errors.shift();
      write();
      return entry;
    },
    getErrors() {
      return [...state.errors];
    },
    clientReport(payload) {
      if (clientReport) {
        clientReportHistory.push(clientReport);
        while (clientReportHistory.length > 10) clientReportHistory.shift();
      }
      clientReport = {
        at: nowIso(now),
        pid,
        report: payload && typeof payload === 'object' ? payload : { value: payload },
      };
      state.gates.G5 = { status: true, detail: 'client-report received' };
      try {
        writeFileSync(
          clientReportPath,
          JSON.stringify(Object.assign({}, clientReport, { history: clientReportHistory }), null, 2),
          'utf8',
        );
      } catch {
        /* ignore */
      }
      write();
      return { received: true, at: clientReport.at };
    },
    getClientReport() {
      return clientReport;
    },
    snapshot,
    write,
  };
}
