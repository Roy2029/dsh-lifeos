/** B：M3 建议服务测试（规则生成/去重/预算/snooze/dismiss/通知）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSuggestionService } from '../../../src/application/suggestion-service.js';
import { normalizeRecord, validateRecord } from '../../../src/domain/schemas.js';
import { createFakeStore } from '../helpers/fake-store.mjs';

const TZ = 'Asia/Shanghai';
const NOW = Date.parse('2026-11-14T03:30:00.000Z'); // 本地 11:30 > 10:00

function setMaxPerDay(store, maxPerDay) {
  store.put('lifeos', 'app_setting', 'automation', {
    key: 'automation', id: 'automation', value_json: { suggestions: { enabled: true, maxPerDay } }, rev: 1,
  });
}

function seed(store, unit, table, value) {
  const id = value.id;
  store.put(unit, table, id, value);
  return value;
}

function makeService(overrides = {}) {
  const store = createFakeStore();
  const clock = { now: NOW };
  const service = createSuggestionService({
    store,
    timeZone: TZ,
    now: () => clock.now,
    emitChanged: () => {},
    ...overrides,
  });
  return { store, service, clock };
}

function seedData(store) {
  seed(store, 'lifeos', 'task', {
    id: 'tsk_overdue', status: 'todo', title: '逾期任务', due_date: '2026-11-10', created_at: '2026-11-01T00:00:00.000Z', rev: 1,
  });
  for (let index = 0; index < 3; index += 1) {
    seed(store, 'lifeos_raw', 'raw_record', {
      id: `rr_${index}`, raw_text: `记录 ${index}`, processing_status: 'pending', created_at: '2026-11-13T02:00:00.000Z', rev: 1,
    });
  }
  seed(store, 'lifeos', 'habit', { id: 'hab_1', name: '早睡', created_at: '2026-11-01T00:00:00.000Z', rev: 1 });
  seed(store, 'lifeos', 'habit_checkin', {
    id: 'hck_1', habit_id: 'hab_1', local_date: '2026-11-10', status: 'done', created_at: '2026-11-10T00:00:00.000Z', rev: 1,
  });
}

/** 生产 store 写路径会 normalize+validate；fake store 不校验，这里补上，防止字段缺失只在实机暴露。 */
function assertWritesValid(store) {
  for (const ops of store._transactions) {
    for (const op of ops) {
      if (op.value === null) continue;
      const normalized = normalizeRecord(op.table, op.value, { key: op.key, now: '2026-11-14T03:30:00.000Z' });
      const result = validateRecord(op.table, normalized);
      assert.equal(result.ok, true, `${op.table} 写入不合规：${result.errors.join('; ')}`);
    }
  }
}

test('generate：四条规则 + outbox + oplog，幂等与同类同日去重', async () => {
  const { store, service } = makeService();
  seedData(store);
  setMaxPerDay(store, 5);
  const first = await service.generate({ now: NOW });
  assertWritesValid(store);
  const rules = first.generated.map((item) => item.ruleType).sort();
  assert.deepEqual(rules, ['habit_streak_risk', 'inbox_backlog', 'journal_morning', 'overdue_cleanup']);
  assert.equal(first.generated.length, 4);
  assert.equal(store.entries('lifeos', 'notification_outbox').length, 4);
  assert.equal(store.entries('lifeos_log', 'operation_log').length, 4, '每条建议写一条 operation_log');

  const second = await service.generate({ now: NOW });
  assert.equal(second.generated.length, 0, '同类同日不得重复');
  assert.equal(second.skipped.every((item) => item.reason === 'dedupe_or_cooldown'), true);
  assert.equal(store.entries('lifeos', 'assistant_suggestion').length, 4);
});

test('generate：预算 maxPerDay 生效（0 条 / 2 条 / 调高后补足受去重限制）', async () => {
  const { store, service } = makeService();
  seedData(store);
  store.put('lifeos', 'app_setting', 'automation', {
    key: 'automation', id: 'automation', value_json: { suggestions: { enabled: true, maxPerDay: 2 } }, rev: 1,
  });
  const capped = await service.generate({ now: NOW });
  assert.equal(capped.generated.length, 2);
  assert.equal(capped.counts.maxPerDay, 2);
  assert.equal(capped.skipped.filter((item) => item.reason === 'budget').length, 2);

  const disabledStore = createFakeStore();
  seedData(disabledStore);
  disabledStore.put('lifeos', 'app_setting', 'automation', {
    key: 'automation', id: 'automation', value_json: { suggestions: { enabled: false, maxPerDay: 2 } }, rev: 1,
  });
  const disabledService = createSuggestionService({ store: disabledStore, timeZone: TZ, now: () => NOW });
  const disabledResult = await disabledService.generate({ now: NOW });
  assert.equal(disabledResult.generated.length, 0);
  assert.equal(disabledResult.skipped, 'disabled');
});

test('act：accept 写 accepted/follow_up；dismiss 7 天降权；snooze 到期前隐藏', async () => {
  const { store, service, clock } = makeService();
  seedData(store);
  setMaxPerDay(store, 5);
  const generated = await service.generate({ now: NOW });
  const overdue = generated.generated.find((item) => item.ruleType === 'overdue_cleanup');
  assert.ok(overdue);

  const accepted = await service.act(overdue.id, { action: 'accept' });
  assert.equal(accepted.suggestion.status, 'accepted');
  const record = store.get('lifeos', 'assistant_suggestion', overdue.id);
  assert.equal(record.status, 'accepted');
  assert.equal(typeof record.accepted_at, 'string');
  assert.equal(typeof record.follow_up_at, 'string');

  const inbox = generated.generated.find((item) => item.ruleType === 'inbox_backlog');
  const dismissed = await service.act(inbox.id, { action: 'dismiss' });
  assert.equal(dismissed.suggestion.status, 'dismissed');
  const dismissedRecord = store.get('lifeos', 'assistant_suggestion', inbox.id);
  assert.equal(dismissedRecord.status, 'rejected');
  assert.ok(Date.parse(dismissedRecord.cooldown_until) > NOW, 'dismiss 必须写 7 天冷却');

  // 次日（本地 11-15）dismiss 冷却期内不得重现 inbox_backlog
  const tomorrow = Date.parse('2026-11-15T03:30:00.000Z');
  const nextDay = await service.generate({ now: tomorrow });
  assert.equal(nextDay.generated.some((item) => item.ruleType === 'inbox_backlog'), false, '7 天内同类不出现');

  const journal = generated.generated.find((item) => item.ruleType === 'journal_morning');
  const snoozed = await service.act(journal.id, { action: 'snooze', snoozeMinutes: 60 });
  assert.equal(snoozed.suggestion.status, 'snoozed');
  assert.ok(snoozed.suggestion.snoozeUntil);
  const pendingNow = service.list({ status: 'pending' });
  assert.equal(pendingNow.items.some((item) => item.id === journal.id), false, 'snooze 未到期不出现');

  clock.now = NOW + 61 * 60000;
  const pendingLater = service.list({ status: 'pending' });
  assert.equal(pendingLater.items.some((item) => item.id === journal.id), true, 'snooze 到期后重现');
  assertWritesValid(store);
});

test('notifications：list/unread/read 徽标', async () => {
  const { store, service } = makeService();
  seedData(store);
  setMaxPerDay(store, 5);
  await service.generate({ now: NOW });
  const list = service.listNotifications({ limit: 10 });
  assert.equal(list.items.length, 4);
  assert.equal(list.unread, 4);
  assert.equal(list.items.every((item) => item.kind === 'coach_nudge'), true);
  assert.equal(list.items.every((item) => item.sourceType === 'suggestion'), true);

  const firstId = list.items[0].id;
  const read = await service.markRead(firstId);
  assert.equal(typeof read.readAt, 'string');
  const after = service.listNotifications({ limit: 10 });
  assert.equal(after.unread, 3);
  assert.equal(typeof after.items.find((item) => item.id === firstId).readAt, 'string');

  assert.equal((await service.listNotifications({ status: 'pending' })).items.every((item) => item.status === 'pending'), true);
  assertWritesValid(store);
});

test('generate：无数据时晨记建议仍生成（>10:00 且今天无记录），有数据时不生成', async () => {
  const empty = createFakeStore();
  const service = createSuggestionService({ store: empty, timeZone: TZ, now: () => NOW });
  const result = await service.generate({ now: NOW });
  assert.equal(result.generated.some((item) => item.ruleType === 'journal_morning'), true);

  const withRecord = createFakeStore();
  seed(withRecord, 'lifeos_raw', 'raw_record', {
    id: 'rr_today', raw_text: '今天晨记', processing_status: 'pending', created_at: '2026-11-14T02:00:00.000Z', rev: 1,
  });
  const service2 = createSuggestionService({ store: withRecord, timeZone: TZ, now: () => NOW });
  const result2 = await service2.generate({ now: NOW });
  assert.equal(result2.generated.some((item) => item.ruleType === 'journal_morning'), false);
});

test('status：计数与预算一致', async () => {
  const { store, service } = makeService();
  seedData(store);
  setMaxPerDay(store, 5);
  await service.generate({ now: NOW });
  const status = service.status();
  assert.equal(status.todayGenerated, 4);
  assert.equal(status.pending, 4);
  assert.equal(status.maxPerDay, 5);
  assert.equal(status.unreadNotifications, 4);
});

test('ID 契约：未注入 newId 时兜底仍产出 sug_+26 位 Crockford（真实 store 校验不能拒绝）', async () => {
  const store = createFakeStore();
  seedData(store);
  const service = createSuggestionService({ store, timeZone: TZ, now: () => NOW });
  const ID_RE = /^sug_[0-9A-HJKMNP-TV-Z]{26}$/;
  const first = await service.generate({ now: NOW });
  assert.equal(first.generated.length > 0, true);
  for (const item of first.generated) {
    assert.match(item.id, ID_RE, `建议 ID 不合法：${item.id}`);
  }
  for (const [, record] of store.entries('lifeos', 'notification_outbox')) {
    assert.match(record.id, /^notif_[0-9A-HJKMNP-TV-Z]{26}$/, `通知 ID 不合法：${record.id}`);
  }
});
