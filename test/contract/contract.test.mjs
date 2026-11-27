import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_HEADER,
  API_PREFIX,
  API_VERSION,
  CAPTURE_SOURCES,
  ERROR_CODES,
  ERROR_CODE_LIST,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  VIEWS,
  decodeCursor,
  encodeCursor,
  err,
  errorStatus,
  isEnvelope,
  ok,
  responseHeaders,
  validateCapture,
  validateQuery,
} from '../../src/client-shared/contract.js';

test('contract: 冻结常量', () => {
  assert.equal(API_PREFIX, '/api/lifeos');
  assert.equal(API_VERSION, '0.7');
  assert.equal(API_HEADER, 'X-LifeOS-Api');
  assert.deepEqual([...VIEWS], ['inbox_pending', 'today', 'all_tasks']);
  assert.deepEqual([...CAPTURE_SOURCES], ['panel', 'overlay', 'chat']);
  assert.equal(DEFAULT_LIMIT, 20);
  assert.equal(MAX_LIMIT, 100);
});

test('contract: 错误码表冻结（M0-PLAN §3.3）', () => {
  assert.deepEqual(ERROR_CODES, {
    bad_request: 400,
    unauthorized: 401,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    invalid_state: 409,
    validation_failed: 422,
    store_unavailable: 503,
    notes_unavailable: 503,
    path_forbidden: 422,
    file_too_large: 422,
    path_exists: 409,
    parent_not_found: 422,
    automation_unavailable: 503,
    suggestion_unavailable: 503,
    internal: 500,
  });
  assert.deepEqual(ERROR_CODE_LIST, [
    'bad_request',
    'unauthorized',
    'forbidden',
    'not_found',
    'conflict',
    'invalid_state',
    'validation_failed',
    'store_unavailable',
    'notes_unavailable',
    'automation_unavailable',
    'suggestion_unavailable',
    'path_forbidden',
    'file_too_large',
    'path_exists',
    'parent_not_found',
    'internal',
  ]);
  assert.equal(errorStatus('store_unavailable'), 503);
  assert.equal(errorStatus('unknown_code'), 500);
});

test('contract: 信封 helpers', () => {
  assert.deepEqual(ok({ a: 1 }), { ok: true, value: { a: 1 } });
  assert.deepEqual(ok(1, { meta: true }), { ok: true, value: 1, meta: true });
  assert.deepEqual(err('bad_request', '坏请求'), {
    ok: false,
    error: { code: 'bad_request', message: '坏请求' },
  });
  assert.deepEqual(err('validation_failed', 'x', { errors: ['text'] }).error.details, { errors: ['text'] });
  assert.equal(isEnvelope({ ok: true }), true);
  assert.equal(isEnvelope({ value: 1 }), false);
  assert.equal(isEnvelope(null), false);
});

test('contract: responseHeaders 含契约头与 no-store', () => {
  const headers = responseHeaders();
  assert.equal(headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(headers[API_HEADER], API_VERSION);
  assert.equal(headers['cache-control'], 'no-store');
});

test('contract: validateCapture 正常/别名/修正', () => {
  const good = validateCapture({ text: '  今天走了 9000 步 ', source: 'chat', requestId: 'r1' });
  assert.equal(good.ok, true);
  assert.equal(good.value.text, '今天走了 9000 步');
  assert.equal(good.value.source, 'chat');
  assert.equal(good.value.requestId, 'r1');

  assert.equal(validateCapture({ text: 'x' }).value.source, 'panel');
  assert.equal(validateCapture({ text: 'x', source: 'composer' }).value.source, 'panel');
  assert.equal(validateCapture({ text: 'x', source: 'quick' }).value.source, 'overlay');
  assert.equal(validateCapture({ text: 'x', requestId: null }).value.requestId, null);
});

test('contract: validateCapture 拒绝非法输入', () => {
  for (const bad of [null, undefined, 'x', [], {}]) {
    const result = validateCapture(bad);
    assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(bad)}`);
    assert.ok(result.errors.length > 0);
  }
  assert.equal(validateCapture({ text: '' }).ok, false);
  assert.equal(validateCapture({ text: '   ' }).ok, false);
  assert.equal(validateCapture({ text: 123 }).ok, false);
  assert.equal(validateCapture({ text: 'x'.repeat(20001) }).ok, false);
  assert.equal(validateCapture({ text: 'x', source: 'nope' }).ok, false);
  assert.equal(validateCapture({ text: 'x', requestId: '' }).ok, false);
  assert.equal(validateCapture({ text: 'x', requestId: 'r'.repeat(129) }).ok, false);
});

test('contract: validateQuery 正常/默认值', () => {
  const params = new URLSearchParams('view=today');
  const result = validateQuery(params);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { view: 'today', limit: DEFAULT_LIMIT, cursor: null });

  const withAll = validateQuery(new URLSearchParams('view=inbox_pending&limit=50&cursor=100'));
  assert.deepEqual(withAll.value, { view: 'inbox_pending', limit: 50, cursor: '100' });
});

test('contract: validateQuery 拒绝非法输入', () => {
  assert.equal(validateQuery(new URLSearchParams('')).ok, false);
  assert.equal(validateQuery(new URLSearchParams('view=nope')).ok, false);
  assert.equal(validateQuery(new URLSearchParams('view=today&limit=0')).ok, false);
  assert.equal(validateQuery(new URLSearchParams('view=today&limit=101')).ok, false);
  assert.equal(validateQuery(new URLSearchParams('view=today&limit=abc')).ok, false);
});

test('contract: cursor 编解码', () => {
  assert.equal(encodeCursor(0), '0');
  assert.equal(encodeCursor(42), '42');
  assert.equal(encodeCursor(-1), null);
  assert.equal(decodeCursor('42'), 42);
  assert.equal(decodeCursor(null), 0);
  assert.equal(decodeCursor('abc'), 0);
});

/* ───────────── v0.2（M1）契约增量 ───────────── */

import {
  TASK_VIEWS,
  TASK_STATUSES,
  TASK_PRIORITIES,
  PROJECT_STATUSES,
  TASK_GROUP_KEYS,
  validateTaskListQuery,
  validateCreateTask,
  validateUpdateTask,
  validateReschedule,
  validateCalendarQuery,
  validateCreateProject,
  validateUpdateProject,
  validateCreateTag,
  validateUiPrefs,
  parseExpectedRev,
  validateTaskId,
} from '../../src/client-shared/contract.js';

const TSK = 'tsk_01M78CRMDYHSJ7VSPH81DRT2WR';

test('v0.2 枚举冻结', () => {
  assert.deepEqual([...TASK_VIEWS], ['today', 'overdue', 'next7', 'inbox', 'all']);
  assert.deepEqual([...TASK_STATUSES], ['todo', 'doing', 'done', 'cancelled']);
  assert.deepEqual([...TASK_PRIORITIES], ['none', 'low', 'medium', 'high']);
  assert.deepEqual([...PROJECT_STATUSES], ['active', 'paused', 'completed', 'cancelled', 'archived']);
  assert.deepEqual([...TASK_GROUP_KEYS], ['overdue', 'today', 'tomorrow', 'next7', 'later', 'none']);
});

test('validateTaskListQuery：默认值/筛选/非法', () => {
  const def = validateTaskListQuery(new URLSearchParams(''));
  assert.equal(def.ok, true);
  assert.deepEqual(def.value, { view: 'all', projectId: null, tagId: null, q: null, limit: 20, cursor: null });
  const full = validateTaskListQuery(new URLSearchParams('view=overdue&limit=5&q=报告&cursor=tsk_x'));
  assert.equal(full.value.view, 'overdue');
  assert.equal(full.value.limit, 5);
  assert.equal(full.value.q, '报告');
  assert.equal(validateTaskListQuery(new URLSearchParams('view=nope')).ok, false);
  assert.equal(validateTaskListQuery(new URLSearchParams('view=all&limit=999')).ok, false);
  assert.equal(validateTaskListQuery(new URLSearchParams('view=all&projectId=bad')).ok, false);
});

test('validateCreateTask：合法/互斥/非法', () => {
  const ok1 = validateCreateTask({
    title: '  写报告  ',
    priority: 'high',
    scheduledDate: '2026-11-13',
    dueDate: '2026-11-15',
    tagIds: ['tag_01M78CRMDYHSJ7VSPH81DRT2WR'],
  });
  assert.equal(ok1.ok, true);
  assert.equal(ok1.value.title, '写报告');
  assert.equal(ok1.value.priority, 'high');
  assert.equal(ok1.value.scheduledDate, '2026-11-13');
  assert.equal(ok1.value.dueDate, '2026-11-15');
  assert.equal(validateCreateTask({ title: '' }).ok, false);
  assert.equal(validateCreateTask({ title: 'x', priority: 'urgent' }).ok, false);
  assert.equal(validateCreateTask({ title: 'x', scheduledDate: '2026-13-01' }).ok, false);
  assert.equal(validateCreateTask({ title: 'x', dueDate: '2026-11-15', dueAt: '2026-11-15T10:00:00.000Z' }).ok, false);
  assert.equal(validateCreateTask({ title: 'x', tagIds: ['bad'] }).ok, false);
});

test('validateUpdateTask：白名单/状态不可改/时间互斥', () => {
  const ok1 = validateUpdateTask({ title: '新标题', priority: 'low', scheduledDate: null });
  assert.equal(ok1.ok, true);
  assert.equal(ok1.value.title, '新标题');
  assert.equal(ok1.value.scheduledDate, null);
  const status = validateUpdateTask({ status: 'done' });
  assert.equal(status.ok, false);
  assert.match(status.errors[0], /不允许更新的字段/);
  assert.equal(validateUpdateTask({}).ok, false);
  assert.equal(validateUpdateTask({ title: 'x', scheduledDate: '2026-11-13', scheduledStartAt: '2026-11-13T10:00:00.000Z' }).ok, false);
});

/* M20：清单/分组归属可随创建与更新一起提交（快速记录分类、日历弹窗） */
test('M20 任务契约接受 listId/groupId（创建与更新）', () => {
  const listId = 'lst_01M78CRMDYHSJ7VSPH81DRT2WR';
  const groupId = 'grp_01M78CRMDYHSJ7VSPH81DRT2WR';
  const created = validateCreateTask({ title: '买牛奶', listId, groupId });
  assert.equal(created.ok, true);
  assert.equal(created.value.listId, listId);
  assert.equal(created.value.groupId, groupId);
  const bare = validateCreateTask({ title: '买牛奶' });
  assert.equal(bare.value.listId, null);
  assert.equal(bare.value.groupId, null);
  assert.equal(validateCreateTask({ title: 'x', listId: 'bad' }).ok, false);
  assert.equal(validateCreateTask({ title: 'x', groupId: 'lst_01M78CRMDYHSJ7VSPH81DRT2WR' }).ok, false);

  const patched = validateUpdateTask({ listId, groupId: null });
  assert.equal(patched.ok, true);
  assert.equal(patched.value.listId, listId);
  assert.equal(patched.value.groupId, null);
  assert.equal(validateUpdateTask({ listId: 'grp_bad' }).ok, false);
});

test('validateReschedule：至少一项/端点时间合法', () => {
  assert.equal(validateReschedule({}).ok, false);
  const ok1 = validateReschedule({ scheduledDate: '2026-11-20' });
  assert.equal(ok1.ok, true);
  assert.equal(ok1.value.scheduledDate, '2026-11-20');
  const cleared = validateReschedule({ scheduledDate: null, dueDate: null });
  assert.equal(cleared.ok, true);
  assert.equal(validateReschedule({ scheduledStartAt: '2026-11-13T10:00:00.000Z', scheduledEndAt: '2026-11-13T09:00:00.000Z' }).ok, false);
  assert.equal(validateReschedule({ dueDate: '2026-11-13', dueAt: '2026-11-13T10:00:00.000Z' }).ok, false);
});

test('validateCalendarQuery：区间/长度上限', () => {
  const ok1 = validateCalendarQuery(new URLSearchParams('from=2026-11-01&to=2026-11-30'));
  assert.equal(ok1.ok, true);
  assert.equal(validateCalendarQuery(new URLSearchParams('from=2026-11-30&to=2026-11-01')).ok, false);
  assert.equal(validateCalendarQuery(new URLSearchParams('from=2026-01-01&to=2026-12-31')).ok, false);
  assert.equal(validateCalendarQuery(new URLSearchParams('from=bad&to=2026-11-01')).ok, false);
});

test('项目/标签/prefs 校验', () => {
  assert.equal(validateCreateProject({ name: '项目A', color: '#fff' }).ok, true);
  assert.equal(validateCreateProject({ name: '' }).ok, false);
  assert.equal(validateUpdateProject({ status: 'archived' }).ok, true);
  assert.equal(validateUpdateProject({ status: 'nope' }).ok, false);
  assert.equal(validateCreateTag({ name: '深度工作' }).ok, true);
  assert.equal(validateCreateTag({ name: 'x'.repeat(51) }).ok, false);
  assert.equal(validateUiPrefs({ tab: 'todo', filters: { projectId: 'x' } }).ok, true);
  assert.equal(validateUiPrefs([]).ok, false);
  assert.equal(validateUiPrefs({ 'bad key': 1 }).ok, false);
});

test('parseExpectedRev：If-Match / expectedRev / 冲突', () => {
  const fromHeader = parseExpectedRev({ headers: { 'if-match': '"3"' } }, {});
  assert.deepEqual(fromHeader, { ok: true, value: { expectedRev: 3 } });
  const fromBody = parseExpectedRev({ headers: {} }, { expectedRev: 5 });
  assert.equal(fromBody.value.expectedRev, 5);
  const weak = parseExpectedRev({ headers: { 'If-Match': 'W/"7"' } }, {});
  assert.equal(weak.value.expectedRev, 7);
  const mismatch = parseExpectedRev({ headers: { 'if-match': '3' } }, { expectedRev: 4 });
  assert.equal(mismatch.ok, false);
  const missing = parseExpectedRev({ headers: {} }, {});
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /必须提供/);
  assert.equal(parseExpectedRev({ headers: { 'if-match': '0' } }, {}).ok, false);
});

test('validateTaskId：前缀校验', () => {
  assert.equal(validateTaskId(TSK).ok, true);
  assert.equal(validateTaskId('tsk_bad').ok, false);
  assert.equal(validateTaskId('prj_01M78CRMDYHSJ7VSPH81DRT2WR').ok, false);
});
