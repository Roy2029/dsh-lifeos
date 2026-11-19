/** B：M3 契约 v0.6 测试（automation / suggestions / notifications）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_VERSION,
  ERROR_CODES,
  AUTOMATION_CHANGED_EVENT,
  SUGGESTION_EVENT,
  NOTIFICATION_EVENT,
  SUGGESTION_ACTIONS,
  SUGGESTION_RULE_TYPES,
  validateAutomationSettingsPatch,
  validateSuggestionAct,
  validateSuggestionQuery,
  validateNotificationsQuery,
  validateSuggestionId,
  validateNotificationId,
} from '../../src/client-shared/contract.js';

test('v0.6 版本/事件/规则/错误码', () => {
  assert.equal(API_VERSION, '0.7');
  assert.equal(AUTOMATION_CHANGED_EVENT, 'automation/changed');
  assert.equal(SUGGESTION_EVENT, 'suggestion');
  assert.equal(NOTIFICATION_EVENT, 'notification');
  assert.deepEqual([...SUGGESTION_ACTIONS], ['accept', 'dismiss', 'snooze']);
  assert.deepEqual([...SUGGESTION_RULE_TYPES], ['overdue_cleanup', 'inbox_backlog', 'habit_streak_risk', 'journal_morning']);
  assert.equal(ERROR_CODES.automation_unavailable, 503);
  assert.equal(ERROR_CODES.suggestion_unavailable, 503);
});

test('validateAutomationSettingsPatch：合法 patch 与边界拒绝', () => {
  const ok = validateAutomationSettingsPatch({
    morningBrief: { enabled: true, time: '08:00' },
    dnd: { start: '23:00', end: '07:00' },
    dailyBudget: 3,
    suggestions: { enabled: true, maxPerDay: 3 },
    deadlineReminder: { leadMinutes: 120 },
    dndPolicy: 'defer',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.patch.morningBrief.time, '08:00');
  assert.equal(ok.value.patch.dailyBudget, 3);

  assert.equal(validateAutomationSettingsPatch({}).ok, false);
  assert.equal(validateAutomationSettingsPatch({ morningBrief: { time: '25:00' } }).ok, false);
  assert.equal(validateAutomationSettingsPatch({ morningBrief: { enabled: 'yes' } }).ok, false);
  assert.equal(validateAutomationSettingsPatch({ dnd: { start: '08:00', end: '08:00' } }).ok, false);
  assert.equal(validateAutomationSettingsPatch({ dailyBudget: 9 }).ok, false);
  assert.equal(validateAutomationSettingsPatch({ suggestions: { maxPerDay: -1 } }).ok, false);
  assert.equal(validateAutomationSettingsPatch({ deadlineReminder: { leadMinutes: 1 } }).ok, false);
  assert.equal(validateAutomationSettingsPatch({ dndPolicy: 'sometimes' }).ok, false);
});

test('validateSuggestionAct / Query / NotificationsQuery', () => {
  const act = validateSuggestionAct({ action: 'snooze', snoozeMinutes: 60 });
  assert.equal(act.ok, true);
  assert.equal(act.value.snoozeMinutes, 60);
  assert.equal(validateSuggestionAct({ action: 'accept' }).ok, true);
  assert.equal(validateSuggestionAct({ action: 'reject' }).ok, false);
  assert.equal(validateSuggestionAct({ action: 'snooze', snoozeMinutes: 1 }).ok, false);

  assert.equal(validateSuggestionQuery(new URLSearchParams('status=pending&limit=10')).value.status, 'pending');
  assert.equal(validateSuggestionQuery(new URLSearchParams('status=all')).ok, true);
  assert.equal(validateSuggestionQuery(new URLSearchParams('status=nope')).ok, false);
  assert.equal(validateSuggestionQuery(new URLSearchParams('limit=51')).ok, false);

  assert.equal(validateNotificationsQuery(new URLSearchParams('limit=50')).value.limit, 50);
  assert.equal(validateNotificationsQuery(new URLSearchParams('status=expired')).ok, true);
  assert.equal(validateNotificationsQuery(new URLSearchParams('status=nope')).ok, false);
});

test('validateSuggestionId / validateNotificationId', () => {
  assert.equal(validateSuggestionId('sug_abc123').ok, true);
  assert.equal(validateSuggestionId('tsk_1').ok, false);
  assert.equal(validateSuggestionId('').ok, false);
  assert.equal(validateNotificationId('notif_abc123').ok, true);
  assert.equal(validateNotificationId('sug_1').ok, false);
});
