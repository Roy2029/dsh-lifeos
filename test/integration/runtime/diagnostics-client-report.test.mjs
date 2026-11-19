import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDiagnostics } from '../../../src/runtime/diagnostics.js';

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'lifeos-diag-'));
  return {
    diagnosticsPath: join(dir, 'runtime-diagnostics.json'),
    clientReportPath: join(dir, 'runtime-client-report.json'),
  };
}

test('diagnostics: clientReport 保留最近 10 次历史，新报告覆盖 report 但旧报告进入 history', () => {
  const paths = tempPaths();
  const diag = createDiagnostics({
    diagnosticsPath: paths.diagnosticsPath,
    clientReportPath: paths.clientReportPath,
    pid: 1234,
    now: () => 1700000000000,
  });

  diag.clientReport({ phase: 'm1-selfcheck', final: true, m1: { ok: true } });
  diag.clientReport({ phase: 'm6-selfcheck', final: true, m6: { ok: true, steps: [{ id: 'task', ok: true }] } });

  const file = JSON.parse(readFileSync(paths.clientReportPath, 'utf8'));
  assert.equal(file.report.phase, 'm6-selfcheck');
  assert.equal(file.report.m6.ok, true);
  assert.equal(Array.isArray(file.history), true);
  assert.equal(file.history.length, 1);
  assert.equal(file.history[0].report.phase, 'm1-selfcheck');

  // 继续写入时 history 增长，但只保留最近 10 条
  for (let i = 0; i < 12; i += 1) {
    diag.clientReport({ phase: 'probe-' + i, final: true });
  }
  const again = JSON.parse(readFileSync(paths.clientReportPath, 'utf8'));
  assert.equal(again.history.length, 10);
  assert.equal(again.history[0].report.phase, 'probe-1');
  assert.equal(again.history[9].report.phase, 'probe-10');
  assert.equal(again.report.phase, 'probe-11');
});


