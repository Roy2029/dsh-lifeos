/** B：M4 v0.7 契约测试（习惯 / 项目 / 目标 / 愿望 / 回顾校验器）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_VERSION,
  ERROR_CODES,
  parseMonth,
  parseOptionalExpectedRev,
  validateCheckin,
  validateCheckinQuery,
  validateGoalCreate,
  validateGoalPatch,
  validateHabitCreate,
  validateHabitGroupCreate,
  validateHabitGroupId,
  validateHabitGroupPatch,
  validateHabitGroupReorder,
  validateHabitListQuery,
  validateHabitMonthQuery,
  validateHabitPatch,
  validateHabitStatsQuery,
  validateLocalDateParam,
  validateProjectCreate,
  validateProjectPatch,
  validateWishConvert,
  validateWishCreate,
  validateWishPatch,
} from '../../src/client-shared/contract.js';

const DAY = '2026-11-14';

test('v0.7 版本 + invalid_state 错误码', () => {
  assert.equal(API_VERSION, '0.7');
  assert.equal(ERROR_CODES.invalid_state, 409);
  assert.equal(ERROR_CODES.validation_failed, 422);
  assert.equal(ERROR_CODES.conflict, 409);
});

test('parseMonth / parseOptionalExpectedRev', () => {
  assert.equal(parseMonth('2026-11').ok, true);
  assert.equal(parseMonth('2026-13').ok, false);
  assert.equal(parseMonth('2026-1').ok, false);
  assert.equal(parseMonth(undefined).ok, false);

  const none = parseOptionalExpectedRev({ headers: {} }, {}, { searchParams: new URLSearchParams() });
  assert.equal(none.ok, true);
  assert.equal(none.value.expectedRev, null);
  const fromQuery = parseOptionalExpectedRev(
    { headers: {} },
    {},
    { searchParams: new URLSearchParams('expectedRev=3') },
  );
  assert.equal(fromQuery.value.expectedRev, 3);
  const fromHeader = parseOptionalExpectedRev({ headers: { 'if-match': 'W/"4"' } }, {}, null);
  assert.equal(fromHeader.value.expectedRev, 4);
  const mismatch = parseOptionalExpectedRev(
    { headers: { 'if-match': '2' } },
    { expectedRev: 3 },
    { searchParams: new URLSearchParams() },
  );
  assert.equal(mismatch.ok, false);
  assert.equal(validateLocalDateParam(DAY).ok, true);
  assert.equal(validateLocalDateParam('2026-02-30').ok, false);
});

test('validateHabitCreate：四种频率 / 默认值 / 拒绝 monthly_count', () => {
  const daily = validateHabitCreate({ name: '晨跑', frequency_rule: { kind: 'daily', interval: 1 }, start_date: DAY });
  assert.equal(daily.ok, true);
  assert.equal(daily.value.checkin_mode, 'either');
  assert.equal(daily.value.sort_order, 0);
  assert.deepEqual(daily.value.frequency_rule, { kind: 'daily', interval: 1 });

  const weekly = validateHabitCreate({
    name: '练琴',
    frequency_rule: { kind: 'weekly_days', days: ['mo', 'MO', 'WE'] },
    start_date: DAY,
  });
  assert.equal(weekly.ok, true);
  assert.deepEqual(weekly.value.frequency_rule.days, ['MO', 'WE']);

  const count = validateHabitCreate({ name: '健身', frequency_rule: { kind: 'weekly_count', count: 3 }, start_date: DAY });
  assert.equal(count.ok, true);

  const interval = validateHabitCreate({
    name: '复盘',
    frequency_rule: { kind: 'interval', days: 2, anchor_date: DAY },
    start_date: DAY,
  });
  assert.equal(interval.ok, true);

  assert.equal(validateHabitCreate({ frequency_rule: { kind: 'daily' } }).ok, false);
  const monthly = validateHabitCreate({ name: 'x', frequency_rule: { kind: 'monthly_count', count: 3 }, start_date: DAY });
  assert.equal(monthly.ok, false);
  assert.ok(monthly.errors.some((message) => message.includes('monthly_count')));
});

test('validateHabitPatch / Checkin / 查询参数', () => {
  assert.equal(validateHabitPatch({}).ok, false);
  assert.equal(validateHabitPatch({ status: 'nope' }).ok, false);
  const clearPeriod = validateHabitPatch({ period_rule: null });
  assert.equal(clearPeriod.ok, true);
  assert.equal(clearPeriod.value.period_rule, null);

  const checkin = validateCheckin({});
  assert.equal(checkin.ok, true);
  assert.equal(checkin.value.status, 'done');
  assert.equal(checkin.value.retro, false);
  assert.equal(validateCheckin({ status: 'unknown' }).ok, false);
  assert.equal(validateCheckin({ localDate: '2026-13-01' }).ok, false);
  assert.equal(validateCheckin({ retro: 'yes' }).ok, false);

  const query = validateCheckinQuery({ get: (name) => ({ from: DAY, to: '2026-11-20' })[name] ?? null });
  assert.equal(query.ok, true);
  assert.equal(validateCheckinQuery({ get: (name) => ({ from: '2026-11-20', to: DAY })[name] ?? null }).ok, false);

  assert.equal(validateHabitStatsQuery({ get: (name) => ({ mode: 'strict' })[name] ?? null }).value.mode, 'strict');
  assert.equal(validateHabitStatsQuery({ get: (name) => ({ mode: 'bad' })[name] ?? null }).ok, false);
  assert.equal(validateHabitMonthQuery({ get: () => '2026-11' }).value.month, '2026-11');
  assert.equal(validateHabitMonthQuery({ get: () => '2026-1' }).ok, false);
  assert.equal(validateHabitListQuery({ get: (name) => ({ status: 'active' })[name] ?? null }).value.status, 'active');
  assert.equal(validateHabitListQuery({ get: (name) => ({ status: 'nope' })[name] ?? null }).ok, false);
  assert.equal(
    validateHabitListQuery({ get: (name) => ({ includeArchived: '1' })[name] ?? null }).value.includeArchived,
    true,
  );
});

test('项目校验器：M1 兼容 + M4 字段', () => {
  const legacy = validateProjectCreate({ name: '项目A', color: '#f00' });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.value.name, '项目A');
  assert.equal(legacy.value.color, '#f00');
  assert.equal(legacy.value.status, 'active');
  assert.equal(validateProjectCreate({}).ok, false);

  const full = validateProjectCreate({
    name: '项目B',
    description: '说明',
    progress_mode: 'manual',
    progress_pct: 40,
    start_date: DAY,
    target_date: '2026-12-31',
  });
  assert.equal(full.ok, true);
  assert.equal(full.value.progress_mode, 'manual');
  assert.equal(validateProjectCreate({ name: 'x', progress_mode: 'nope' }).ok, false);
  assert.equal(validateProjectPatch({}).ok, false);
  assert.equal(validateProjectPatch({ status: 'archived' }).ok, true);
  assert.equal(validateProjectPatch({ target_date: null }).value.target_date, null);
});

test('目标 / 愿望校验器（含 convert）', () => {
  const goal = validateGoalCreate({ title: '目标A' });
  assert.equal(goal.ok, true);
  assert.equal(goal.value.horizon, 'mid');
  assert.equal(goal.value.progress_mode, 'manual');
  assert.equal(validateGoalCreate({}).ok, false);
  assert.equal(validateGoalCreate({ title: 'x', status: 'achieved' }).ok, false);
  assert.equal(validateGoalPatch({}).ok, false);
  assert.equal(validateGoalPatch({ status: 'achieved', abandoned_reason: null }).ok, true);

  const wish = validateWishCreate({ title: '愿望A' });
  assert.equal(wish.ok, true);
  assert.equal(validateWishCreate({}).ok, false);
  assert.equal(validateWishPatch({}).ok, false);
  assert.equal(validateWishPatch({ status: 'committed' }).ok, true);
  assert.equal(validateWishPatch({ converted_to_goal_id: 'bad' }).ok, false);

  const convert = validateWishConvert({ goal: { title: '由愿望转化' } });
  assert.equal(convert.ok, true);
  assert.equal(convert.value.goal.title, '由愿望转化');
  assert.equal(validateWishConvert({}).ok, false);
  assert.equal(validateWishConvert({ goal: {} }).ok, false);
});

test('M18 习惯分组校验器：id / create / patch / reorder', () => {
  const groupId = 'hgrp_01M78CRMDYHSJ7VSPH81DRT2WR';
  assert.equal(validateHabitGroupId(groupId).ok, true);
  assert.equal(validateHabitGroupId('hab_01M78CRMDYHSJ7VSPH81DRT2WR').ok, false);
  assert.equal(validateHabitGroupId('hgrp_bad').ok, false);

  const created = validateHabitGroupCreate({ name: '  清晨  ' });
  assert.equal(created.ok, true);
  assert.equal(created.value.name, '清晨');
  assert.equal(created.value.sort_order, undefined);
  assert.equal(validateHabitGroupCreate({}).ok, false);
  assert.equal(validateHabitGroupCreate({ name: 'x'.repeat(41) }).ok, false);

  const patched = validateHabitGroupPatch({ name: '早起', collapsed: true, sort_order: 3 });
  assert.equal(patched.ok, true);
  assert.deepEqual(patched.value, { name: '早起', collapsed: true, sort_order: 3 });
  assert.equal(validateHabitGroupPatch({}).ok, false);
  assert.equal(validateHabitGroupPatch({ name: null }).ok, false);
  assert.equal(validateHabitGroupPatch({ collapsed: 'yes' }).ok, false);

  const reordered = validateHabitGroupReorder({ ids: [groupId] });
  assert.equal(reordered.ok, true);
  assert.deepEqual(reordered.value.ids, [groupId]);
  assert.equal(validateHabitGroupReorder({ ids: [] }).ok, false);
  assert.equal(validateHabitGroupReorder({ ids: [groupId, groupId] }).ok, false);
  assert.equal(validateHabitGroupReorder({ ids: ['hab_01M78CRMDYHSJ7VSPH81DRT2WR'] }).ok, false);
  assert.equal(validateHabitGroupReorder({ ids: 'nope' }).ok, false);
});

test('M18 习惯 create/patch：icon 与 group_id（null 清空）', () => {
  const groupId = 'hgrp_01M78CRMDYHSJ7VSPH81DRT2WR';
  const base = { name: '晨跑', frequency_rule: { kind: 'daily', interval: 1 }, start_date: DAY };

  const withIcon = validateHabitCreate({ ...base, icon: ' 🏃 ', group_id: groupId });
  assert.equal(withIcon.ok, true);
  assert.equal(withIcon.value.icon, '🏃');
  assert.equal(withIcon.value.group_id, groupId);

  assert.equal(validateHabitCreate({ ...base, icon: '123456789' }).ok, false);
  assert.equal(validateHabitCreate({ ...base, group_id: 'hab_01M78CRMDYHSJ7VSPH81DRT2WR' }).ok, false);

  const cleared = validateHabitPatch({ icon: null, group_id: null });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.value.icon, null);
  assert.equal(cleared.value.group_id, null);

  const blank = validateHabitPatch({ icon: '   ' });
  assert.equal(blank.ok, true);
  assert.equal(blank.value.icon, null);

  assert.equal(validateHabitPatch({ icon: '123456789' }).ok, false);
  assert.equal(validateHabitPatch({ group_id: 'nope' }).ok, false);
});