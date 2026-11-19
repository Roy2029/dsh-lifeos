/** B：M2 v0.3 契约测试（整理 / 自动化 / 工具名单）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_VERSION,
  TRIAGE_MODES,
  CANDIDATE_KINDS,
  TRIAGE_DECISIONS,
  CORRECT_TYPES,
  CORRECT_ACTIONS,
  validateTriageRun,
  validateTriageApply,
  validateTriageReprocess,
  validateTriageCorrect,
  validateRunId,
  validateAutomationPatch,
} from '../../src/client-shared/contract.js';
import { LIFEOS_TOOL_NAMES, isLifeosAgent } from '../../src/agent/tool-names.js';

test('v0.3 版本与整理枚举冻结', () => {
  assert.equal(API_VERSION, '0.7');
  assert.deepEqual([...TRIAGE_MODES], ['rules', 'agent', 'both']);
  assert.deepEqual([...CANDIDATE_KINDS], ['task', 'event', 'metric', 'habit_checkin', 'wish', 'ignore']);
  assert.deepEqual([...TRIAGE_DECISIONS], ['accept', 'edit', 'ignore']);
  assert.deepEqual([...CORRECT_TYPES], ['task', 'event', 'metric', 'habit_checkin']);
  assert.deepEqual([...CORRECT_ACTIONS], ['update', 'revoke']);
});

test('validateTriageRun：默认/模式/limit/非法', () => {
  const def = validateTriageRun({});
  assert.equal(def.ok, true);
  assert.equal(def.value.mode, 'rules');
  assert.equal(def.value.limit, 20);
  assert.equal(validateTriageRun({ mode: 'agent', limit: 5 }).value.mode, 'agent');
  assert.equal(validateTriageRun({ mode: 'nope' }).ok, false);
  assert.equal(validateTriageRun({ limit: 0 }).ok, false);
  assert.equal(validateTriageRun({ rawRecordIds: ['bad'] }).ok, false);
  assert.equal(validateTriageRun({ rawRecordIds: ['rr_' + 'A'.repeat(26)] }).ok, true);
});

test('validateTriageApply：decisions 结构', () => {
  const runId = 'xrun_' + 'A'.repeat(26);
  const candidateId = 'cand_' + 'B'.repeat(26);
  const ok1 = validateTriageApply({ runId, decisions: [{ candidateId, action: 'accept' }] });
  assert.equal(ok1.ok, true);
  assert.equal(ok1.value.decisions[0].action, 'accept');
  assert.equal(validateTriageApply({ runId: 'bad', decisions: [] }).ok, false);
  assert.equal(validateTriageApply({ runId, decisions: [] }).ok, false);
  assert.equal(validateTriageApply({ runId, decisions: [{ candidateId, action: 'nope' }] }).ok, false);
});

test('validateTriageReprocess / Correct / RunId / Automation', () => {
  assert.equal(validateTriageReprocess({ rawRecordId: 'rr_' + 'A'.repeat(26) }).ok, true);
  assert.equal(validateTriageReprocess({}).ok, false);
  assert.equal(validateTriageCorrect({ type: 'metric', id: 'mtr_x', action: 'update', patch: { value_num: 1 } }).ok, true);
  assert.equal(validateTriageCorrect({ type: 'nope', id: 'x' }).ok, false);
  assert.equal(validateTriageCorrect({ type: 'task', id: 'x', action: 'nope' }).ok, false);
  assert.equal(validateRunId('xrun_' + 'A'.repeat(26)).ok, true);
  assert.equal(validateRunId('bad').ok, false);
  assert.equal(validateAutomationPatch({ enabled: false }).ok, true);
  assert.equal(validateAutomationPatch({ time: '21:30' }).ok, true);
  assert.equal(validateAutomationPatch({ time: '25:00' }).ok, false);
  assert.equal(validateAutomationPatch({}).ok, false);
});

test('P0 工具名单单一来源 + isLifeosAgent fail-closed', () => {
  assert.deepEqual([...LIFEOS_TOOL_NAMES], [
    'lifeos_today',
    'lifeos_capture',
    'lifeos_task',
    'lifeos_triage',
    'lifeos_correct',
    'lifeos_notes',
    'lifeos_settings',
    'lifeos_habit',
    'lifeos_project',
    'lifeos_goal',
  ]);
  assert.equal(isLifeosAgent({ session: { header: { agentPreset: 'lifeos' } } }), true);
  assert.equal(isLifeosAgent({ session: { header: { agentPreset: 'standard' } } }), false);
  assert.equal(isLifeosAgent({}), false);
  assert.equal(isLifeosAgent(null), false);
});
