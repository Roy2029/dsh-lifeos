/**
 * LifeOS HTTP 契约（B 所有；Host 与 Client 共用，零依赖纯 JS）。
 *
 * 版本：v0.7（M4a 习惯/项目/目标/愿望）——在 M0–M3 基础上增量扩展：
 *  - API_VERSION 0.7、错误码新增 invalid_state(409)
 *  - 习惯/打卡/项目/目标/愿望/回顾 参数校验（形状级；语义在 domain）
 *  - parseMonth / parseOptionalExpectedRev / 各类 :id 前缀校验
 *
 * 规则：本文件不做 IO、不 import 任何包；Host routes 与 Client fetch 封装都从这里取。
 */

export const API_VERSION = '0.7';
export const API_PREFIX = '/api/lifeos';
export const API_HEADER = 'X-LifeOS-Api';

/** 错误码表（冻结；M1 增加 conflict 的使用） */
export const ERROR_CODES = Object.freeze({
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_state: 409,
  validation_failed: 422,
  store_unavailable: 503,
  notes_unavailable: 503,
  automation_unavailable: 503,
  suggestion_unavailable: 503,
  path_forbidden: 422,
  file_too_large: 422,
  path_exists: 409,
  parent_not_found: 422,
  internal: 500,
});

export const ERROR_CODE_LIST = Object.freeze(Object.keys(ERROR_CODES));

export function errorStatus(code) {
  return ERROR_CODES[code] ?? 500;
}

/** 成功信封 */
export function ok(value, extra) {
  return extra && typeof extra === 'object' ? { ok: true, value, ...extra } : { ok: true, value };
}

/** 失败信封 */
export function err(code, message, details) {
  const error = { code, message: message || code };
  if (details !== undefined) error.details = details;
  return { ok: false, error };
}

export function isEnvelope(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.ok === 'boolean';
}

/* ───────────────────────── M0 保留（capture / M0 query） ───────────────────────── */

export const VIEWS = Object.freeze(['inbox_pending', 'today', 'all_tasks']);
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_CAPTURE_CHARS = 20000;
export const MAX_REQUEST_ID_CHARS = 128;
export const CAPTURE_SOURCES = Object.freeze(['panel', 'overlay', 'chat']);

const SOURCE_ALIASES = Object.freeze({
  panel: 'panel',
  overlay: 'overlay',
  chat: 'chat',
  composer: 'panel',
  quick: 'overlay',
  other: 'panel',
});

function fail(errors) {
  return { ok: false, errors };
}

export function validateCapture(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const rawText = body.text;
  if (typeof rawText !== 'string') errors.push('text 必须是字符串');
  else {
    const text = rawText.trim();
    if (text.length === 0) errors.push('text 不能为空');
    if (rawText.length > MAX_CAPTURE_CHARS) errors.push(`text 超过上限 ${MAX_CAPTURE_CHARS} 字符`);
  }
  let requestId = null;
  if (body.requestId !== undefined && body.requestId !== null) {
    if (typeof body.requestId !== 'string' || body.requestId.trim().length === 0) errors.push('requestId 必须是非空字符串');
    else if (body.requestId.length > MAX_REQUEST_ID_CHARS) errors.push(`requestId 超过上限 ${MAX_REQUEST_ID_CHARS} 字符`);
    else requestId = body.requestId.trim();
  }
  let source = 'panel';
  if (body.source !== undefined && body.source !== null) {
    if (typeof body.source !== 'string') errors.push('source 必须是字符串');
    else {
      const normalized = SOURCE_ALIASES[body.source];
      if (!normalized) errors.push(`source 非法：${body.source}`);
      else source = normalized;
    }
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { text: String(rawText).trim(), requestId, source } };
}

export function validateQuery(params) {
  const errors = [];
  const get = (name) => (params && typeof params.get === 'function' ? params.get(name) : null);
  const view = get('view');
  if (typeof view !== 'string' || view.length === 0) errors.push('view 必填');
  else if (!VIEWS.includes(view)) errors.push(`view 非法：${view}`);

  let limit = DEFAULT_LIMIT;
  const rawLimit = get('limit');
  if (rawLimit !== null && rawLimit !== '') {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) errors.push(`limit 必须是 1–${MAX_LIMIT} 的整数`);
    else limit = n;
  }
  let cursor = null;
  const rawCursor = get('cursor');
  if (rawCursor !== null && rawCursor !== '') {
    if (typeof rawCursor !== 'string' || rawCursor.length > 64) errors.push('cursor 非法');
    else cursor = rawCursor;
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { view, limit, cursor } };
}

/* ───────────────────────── M1 v0.2 枚举 ───────────────────────── */

export const TASK_VIEWS = Object.freeze(['today', 'overdue', 'next7', 'inbox', 'all']);
export const TASK_STATUSES = Object.freeze(['todo', 'doing', 'done', 'cancelled']);
export const TASK_OPEN_STATUSES = Object.freeze(['todo', 'doing']);
export const TASK_PRIORITIES = Object.freeze(['none', 'low', 'medium', 'high']);
export const TASK_ACTIONS = Object.freeze(['complete', 'reopen', 'cancel']);
export const PROJECT_STATUSES = Object.freeze(['active', 'paused', 'completed', 'cancelled', 'archived']);
export const TASK_GROUP_KEYS = Object.freeze(['overdue', 'today', 'tomorrow', 'next7', 'later', 'none']);
export const MAX_TITLE_CHARS = 500;
export const MAX_NOTES_CHARS = 20000;
export const MAX_TAGS_PER_TASK = 20;
export const MAX_CALENDAR_DAYS = 62;
export const MAX_UI_PREFS_BYTES = 8192;
/** M8 重复规则种类（task repeatRule）。 */
export const REPEAT_KINDS = Object.freeze(['daily', 'weekly', 'monthly']);

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z][a-z0-9]*_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isIsoTimestamp(value) {
  return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
}

export function isLocalDate(value) {
  if (typeof value !== 'string' || !LOCAL_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isEntityId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function optionalString(body, name, errors, { max = 1000, allowEmpty = false, pattern = null } = {}) {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    errors.push(`${name} 必须是字符串`);
    return null;
  }
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) {
    errors.push(`${name} 不能为空`);
    return null;
  }
  if (trimmed.length > max) errors.push(`${name} 超过上限 ${max} 字符`);
  if (pattern && !pattern.test(trimmed)) errors.push(`${name} 格式非法：${trimmed}`);
  return trimmed;
}

function normalizeTimeFields(body, errors, allowNull = true) {
  const out = {};
  for (const field of ['scheduledDate', 'dueDate']) {
    if (body[field] === undefined) continue;
    if (body[field] === null) {
      if (allowNull) out[field] = null;
      continue;
    }
    if (!isLocalDate(body[field])) errors.push(`${field} 必须是 YYYY-MM-DD`);
    else out[field] = body[field];
  }
  for (const field of ['scheduledStartAt', 'scheduledEndAt', 'dueAt']) {
    if (body[field] === undefined) continue;
    if (body[field] === null) {
      if (allowNull) out[field] = null;
      continue;
    }
    if (!isIsoTimestamp(body[field])) errors.push(`${field} 必须是 UTC ISO 时刻（...Z）`);
    else out[field] = body[field];
  }
  if (body.isAllDay !== undefined) {
    if (typeof body.isAllDay !== 'boolean') errors.push('isAllDay 必须是布尔值');
    else out.isAllDay = body.isAllDay;
  }
  return out;
}

/* ───────────────────────── M1 参数校验 ───────────────────────── */

/** GET /tasks 查询 */
export function validateTaskListQuery(params) {
  const errors = [];
  const get = (name) => (params && typeof params.get === 'function' ? params.get(name) : null);
  let view = 'all';
  const rawView = get('view');
  if (rawView !== null && rawView !== '') {
    if (!TASK_VIEWS.includes(rawView)) errors.push(`view 非法：${rawView}（允许：${TASK_VIEWS.join('|')}）`);
    else view = rawView;
  }
  const projectId = get('projectId');
  if (projectId !== null && projectId !== '' && !isEntityId(projectId)) errors.push('projectId 非法');
  const tagId = get('tagId');
  if (tagId !== null && tagId !== '' && !isEntityId(tagId)) errors.push('tagId 非法');
  const q = get('q');
  let query = null;
  if (q !== null && q !== '') {
    if (q.length > 200) errors.push('q 超过 200 字符');
    else query = q;
  }
  let limit = DEFAULT_LIMIT;
  const rawLimit = get('limit');
  if (rawLimit !== null && rawLimit !== '') {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) errors.push(`limit 必须是 1–${MAX_LIMIT} 的整数`);
    else limit = n;
  }
  const cursor = get('cursor');
  let cursorValue = null;
  if (cursor !== null && cursor !== '') {
    if (cursor.length > 64) errors.push('cursor 非法');
    else cursorValue = cursor;
  }
  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    value: {
      view,
      projectId: projectId || null,
      tagId: tagId || null,
      q: query,
      limit,
      cursor: cursorValue,
    },
  };
}

/** POST /tasks */
export function validateCreateTask(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const title = optionalString(body, 'title', errors, { max: MAX_TITLE_CHARS, allowEmpty: false });
  const notes = optionalString(body, 'notes', errors, { max: MAX_NOTES_CHARS, allowEmpty: true });
  let priority = 'none';
  if (body.priority !== undefined && body.priority !== null) {
    if (!TASK_PRIORITIES.includes(body.priority)) errors.push(`priority 非法：${body.priority}`);
    else priority = body.priority;
  }
  let projectId = null;
  if (body.projectId !== undefined && body.projectId !== null) {
    if (!isEntityId(body.projectId) || !body.projectId.startsWith('prj_')) errors.push('projectId 必须是 prj_ 开头的 ID');
    else projectId = body.projectId;
  }
  let tagIds = [];
  if (body.tagIds !== undefined && body.tagIds !== null) {
    if (!Array.isArray(body.tagIds)) errors.push('tagIds 必须是数组');
    else if (body.tagIds.length > MAX_TAGS_PER_TASK) errors.push(`tagIds 最多 ${MAX_TAGS_PER_TASK} 个`);
    else {
      for (const tagId of body.tagIds) {
        if (!isEntityId(tagId) || !tagId.startsWith('tag_')) errors.push(`tagIds 含非法 ID：${tagId}`);
      }
      tagIds = [...new Set(body.tagIds)];
    }
  }
  const repeatRule = validateRepeatRule(body.repeatRule);
  if (!repeatRule.ok) errors.push(...repeatRule.errors);
  const time = normalizeTimeFields(body, errors);
  if (time.scheduledDate && time.scheduledStartAt) errors.push('scheduledDate 与 scheduledStartAt 互斥（二选一）');
  if (time.dueDate && time.dueAt) errors.push('dueDate 与 dueAt 互斥（二选一）');
  if (time.scheduledStartAt && time.scheduledEndAt && !(time.scheduledStartAt < time.scheduledEndAt)) {
    errors.push('scheduledEndAt 必须晚于 scheduledStartAt');
  }
  if (time.scheduledEndAt && !time.scheduledStartAt) errors.push('scheduledEndAt 需要同时提供 scheduledStartAt');
  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    value: { title, notes, priority, projectId, tagIds, repeatRule: repeatRule.value, ...time },
  };
}

const UPDATE_KEYS = new Set([
  'title',
  'notes',
  'priority',
  'projectId',
  'tagIds',
  'scheduledDate',
  'scheduledStartAt',
  'scheduledEndAt',
  'dueDate',
  'dueAt',
  'isAllDay',
  'repeatRule',
]);

/** PATCH /tasks/:id */
export function validateUpdateTask(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const keys = Object.keys(body);
  if (keys.length === 0) return fail(['至少提供一个要更新的字段']);
  const unknown = keys.filter((key) => !UPDATE_KEYS.has(key) && key !== 'expectedRev');
  if (unknown.length > 0) {
    return fail([`不允许更新的字段：${unknown.join(', ')}（状态请用 complete/reopen/cancel 端点）`]);
  }
  const patch = {};
  if (body.title !== undefined) {
    const title = optionalString(body, 'title', errors, { max: MAX_TITLE_CHARS, allowEmpty: false });
    if (title !== null) patch.title = title;
  }
  if (body.notes !== undefined) {
    if (body.notes === null) patch.notes = null;
    else {
      const notes = optionalString(body, 'notes', errors, { max: MAX_NOTES_CHARS, allowEmpty: true });
      if (notes !== null) patch.notes = notes;
    }
  }
  if (body.priority !== undefined) {
    if (!TASK_PRIORITIES.includes(body.priority)) errors.push(`priority 非法：${body.priority}`);
    else patch.priority = body.priority;
  }
  if (body.projectId !== undefined) {
    if (body.projectId === null) patch.projectId = null;
    else if (!isEntityId(body.projectId) || !body.projectId.startsWith('prj_')) errors.push('projectId 必须是 prj_ 开头的 ID');
    else patch.projectId = body.projectId;
  }
  if (body.tagIds !== undefined) {
    if (!Array.isArray(body.tagIds)) errors.push('tagIds 必须是数组');
    else if (body.tagIds.length > MAX_TAGS_PER_TASK) errors.push(`tagIds 最多 ${MAX_TAGS_PER_TASK} 个`);
    else {
      for (const tagId of body.tagIds) {
        if (!isEntityId(tagId) || !tagId.startsWith('tag_')) errors.push(`tagIds 含非法 ID：${tagId}`);
      }
      patch.tagIds = [...new Set(body.tagIds)];
    }
  }
  if (body.repeatRule !== undefined) {
    const repeatRule = validateRepeatRule(body.repeatRule);
    if (!repeatRule.ok) errors.push(...repeatRule.errors);
    else patch.repeatRule = repeatRule.value;
  }
  const time = normalizeTimeFields(body, errors);
  Object.assign(patch, time);
  if (patch.scheduledDate && patch.scheduledStartAt) errors.push('scheduledDate 与 scheduledStartAt 互斥（二选一）');
  if (patch.dueDate && patch.dueAt) errors.push('dueDate 与 dueAt 互斥（二选一）');
  if (patch.scheduledStartAt && patch.scheduledEndAt && !(patch.scheduledStartAt < patch.scheduledEndAt)) {
    errors.push('scheduledEndAt 必须晚于 scheduledStartAt');
  }
  if (patch.scheduledEndAt && !patch.scheduledStartAt) errors.push('scheduledEndAt 需要同时提供 scheduledStartAt');
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: patch };
}

/** POST /tasks/:id/reschedule */
export function validateReschedule(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const patch = normalizeTimeFields(body, errors, true);
  if (Object.keys(patch).length === 0) return fail(['至少提供 scheduledDate/scheduledStartAt/scheduledEndAt/dueDate/dueAt 之一']);
  if (patch.scheduledDate && patch.scheduledStartAt) errors.push('scheduledDate 与 scheduledStartAt 互斥（二选一）');
  if (patch.dueDate && patch.dueAt) errors.push('dueDate 与 dueAt 互斥（二选一）');
  if (patch.scheduledStartAt && patch.scheduledEndAt && !(patch.scheduledStartAt < patch.scheduledEndAt)) {
    errors.push('scheduledEndAt 必须晚于 scheduledStartAt');
  }
  if (patch.scheduledEndAt && !patch.scheduledStartAt) errors.push('scheduledEndAt 需要同时提供 scheduledStartAt');
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: patch };
}

/** GET /calendar */
export function validateCalendarQuery(params) {
  const errors = [];
  const get = (name) => (params && typeof params.get === 'function' ? params.get(name) : null);
  const from = get('from');
  const to = get('to');
  if (!isLocalDate(from)) errors.push('from 必须是 YYYY-MM-DD');
  if (!isLocalDate(to)) errors.push('to 必须是 YYYY-MM-DD');
  if (!errors.length) {
    if (from > to) errors.push('from 不能晚于 to');
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
    if (days > MAX_CALENDAR_DAYS) errors.push(`区间最多 ${MAX_CALENDAR_DAYS} 天`);
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { from, to } };
}

/** POST /projects */
export function validateCreateProject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const name = optionalString(body, 'name', errors, { max: 100, allowEmpty: false });
  let color = null;
  if (body.color !== undefined && body.color !== null) {
    if (typeof body.color !== 'string' || body.color.length > 32) errors.push('color 必须是 ≤32 字符的字符串');
    else color = body.color;
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { name, color } };
}

/** PATCH /projects/:id */
export function validateUpdateProject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const patch = {};
  if (body.name !== undefined) {
    const name = optionalString(body, 'name', errors, { max: 100, allowEmpty: false });
    if (name !== null) patch.name = name;
  }
  if (body.color !== undefined) {
    if (body.color === null) patch.color = null;
    else if (typeof body.color !== 'string' || body.color.length > 32) errors.push('color 必须是 ≤32 字符的字符串');
    else patch.color = body.color;
  }
  if (body.status !== undefined) {
    if (!PROJECT_STATUSES.includes(body.status)) errors.push(`status 非法：${body.status}`);
    else patch.status = body.status;
  }
  if (Object.keys(patch).length === 0) errors.push('至少提供一个要更新的字段');
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: patch };
}

/** POST /tags */
export function validateCreateTag(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const name = optionalString(body, 'name', errors, { max: 50, allowEmpty: false });
  let color = null;
  if (body.color !== undefined && body.color !== null) {
    if (typeof body.color !== 'string' || body.color.length > 32) errors.push('color 必须是 ≤32 字符的字符串');
    else color = body.color;
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { name, color } };
}

/**
 * repeatRule 形状校验：null | {kind:'daily'} | {kind:'weekly',days:number[]} | {kind:'monthly',day:number}。
 * weekly.days 1..7 整数、去重升序、非空；monthly.day 1..31；未知 kind 422。
 */
export function validateRepeatRule(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'object' || Array.isArray(value)) return fail(['repeatRule 必须是对象或 null']);
  const kind = value.kind;
  if (typeof kind !== 'string' || !REPEAT_KINDS.includes(kind)) {
    return fail([`repeatRule.kind 非法：${String(kind)}（允许：daily|weekly|monthly）`]);
  }
  if (kind === 'daily') return { ok: true, value: { kind: 'daily' } };
  if (kind === 'weekly') {
    if (!Array.isArray(value.days) || value.days.length === 0) {
      return fail(['repeatRule.days 必须是非空数组（1..7，1=周一）']);
    }
    const days = [];
    for (const day of value.days) {
      if (!Number.isInteger(day) || day < 1 || day > 7) {
        return fail([`repeatRule.days 只能包含 1..7 的整数：${String(day)}`]);
      }
      if (!days.includes(day)) days.push(day);
    }
    days.sort((a, b) => a - b);
    return { ok: true, value: { kind: 'weekly', days } };
  }
  if (!Number.isInteger(value.day) || value.day < 1 || value.day > 31) {
    return fail([`repeatRule.day 必须是 1..31 的整数：${String(value.day)}`]);
  }
  return { ok: true, value: { kind: 'monthly', day: value.day } };
}

const TAG_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/** PATCH /tags/:id body：{name?, color?, expectedRev?}，name/color 至少提供一个。 */
export function validateUpdateTag(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const allowed = new Set(['name', 'color', 'expectedRev']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return fail([`不允许更新的字段：${unknown.join(', ')}`]);
  const patch = {};
  if (body.name !== undefined) {
    const name = optionalString(body, 'name', errors, { max: 50, allowEmpty: false });
    if (name !== null) patch.name = name;
  }
  if (body.color !== undefined) {
    if (body.color === null) patch.color = null;
    else if (typeof body.color !== 'string' || !TAG_COLOR_RE.test(body.color)) errors.push('color 必须是 #RRGGBB 格式或 null');
    else patch.color = body.color;
  }
  if (Object.keys(patch).length === 0 && errors.length === 0) errors.push('至少提供一个要更新的字段（name/color）');
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: patch };
}

/** /tags/:id 的 ID 校验（tag_ 前缀）。 */
export function validateTagId(id) {
  if (!isEntityId(id) || !String(id).startsWith('tag_')) return fail([`标签 ID 非法：${id}`]);
  return { ok: true, value: id };
}

function utf8ByteLength(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  let bytes = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** PUT /ui-prefs（整体 merge patch） */
export function validateUiPrefs(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  let bytes = 0;
  try {
    bytes = utf8ByteLength(JSON.stringify(body));
  } catch {
    return fail(['prefs 必须是可 JSON 序列化的对象']);
  }
  if (bytes > MAX_UI_PREFS_BYTES) errors.push(`prefs 超过 ${MAX_UI_PREFS_BYTES} 字节`);
  for (const key of Object.keys(body)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key)) errors.push(`prefs key 非法：${key}`);
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: body };
}

/* ───────────────────────── CAS / If-Match ───────────────────────── */

/**
 * 解析写请求的期望版本：优先 If-Match 头，其次 body.expectedRev。
 * 两者都提供且不一致 → 返回错误。
 * @returns {{ok:true,value:{expectedRev:number|null}}|{ok:false,errors:string[]}}
 */
export function parseExpectedRev(req, body) {
  const errors = [];
  const headers = (req && req.headers) || {};
  const rawHeader = headers['if-match'] ?? headers['If-Match'] ?? null;
  let headerRev = null;
  if (rawHeader !== null && rawHeader !== undefined && rawHeader !== '') {
    const normalized = String(rawHeader).trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    const n = Number(normalized);
    if (!Number.isInteger(n) || n < 1) errors.push('If-Match 必须是正整数 rev');
    else headerRev = n;
  }
  let bodyRev = null;
  if (body && typeof body === 'object' && body.expectedRev !== undefined && body.expectedRev !== null) {
    const n = Number(body.expectedRev);
    if (!Number.isInteger(n) || n < 1) errors.push('expectedRev 必须是正整数');
    else bodyRev = n;
  }
  if (headerRev !== null && bodyRev !== null && headerRev !== bodyRev) {
    errors.push('If-Match 与 expectedRev 不一致');
  }
  if (errors.length > 0) return fail(errors);
  const expectedRev = headerRev ?? bodyRev;
  if (expectedRev === null) errors.push('写操作必须提供 If-Match 头或 expectedRev');
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { expectedRev } };
}

/** 解析 :id 路径参数 */
export function validateTaskId(id) {
  if (!isEntityId(id) || !String(id).startsWith('tsk_')) return fail(['id 必须是 tsk_ 开头的任务 ID']);
  return { ok: true, value: id };
}

export function validateProjectId(id) {
  if (!isEntityId(id) || !String(id).startsWith('prj_')) return fail(['id 必须是 prj_ 开头的项目 ID']);
  return { ok: true, value: id };
}

/* ───────────────────────── 游标 / 响应头（M0 保留） ───────────────────────── */

export function decodeCursor(cursor) {
  if (cursor === null || cursor === undefined || cursor === '') return 0;
  const n = Number(cursor);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export function encodeCursor(offset) {
  if (!Number.isInteger(offset) || offset < 0) return null;
  return String(offset);
}

export function responseHeaders() {
  return {
    'content-type': 'application/json; charset=utf-8',
    [API_HEADER]: API_VERSION,
    'cache-control': 'no-store',
  };
}

/* ───────────────────────── M2 v0.3：整理 / 自动化 ───────────────────────── */

export const TRIAGE_MODES = Object.freeze(['rules', 'agent', 'both']);
export const CANDIDATE_KINDS = Object.freeze(['task', 'event', 'metric', 'habit_checkin', 'wish', 'ignore']);
export const TRIAGE_DECISIONS = Object.freeze(['accept', 'edit', 'ignore']);
export const CORRECT_TYPES = Object.freeze(['task', 'event', 'metric', 'habit_checkin']);
export const CORRECT_ACTIONS = Object.freeze(['update', 'revoke']);
export const AUTOMATION_DEFAULT_TIME = '21:30';

const RUN_ID_RE = /^xrun_[0-9A-HJKMNP-TV-Z]{26}$/;

/** POST /triage/run */
export function validateTriageRun(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  let mode = 'rules';
  if (body.mode !== undefined && body.mode !== null) {
    if (!TRIAGE_MODES.includes(body.mode)) errors.push(`mode 非法：${body.mode}（允许：${TRIAGE_MODES.join('|')}）`);
    else mode = body.mode;
  }
  let rawRecordIds = null;
  if (body.rawRecordIds !== undefined && body.rawRecordIds !== null) {
    if (!Array.isArray(body.rawRecordIds)) errors.push('rawRecordIds 必须是数组');
    else if (body.rawRecordIds.length > 50) errors.push('rawRecordIds 最多 50 条');
    else {
      for (const id of body.rawRecordIds) {
        if (typeof id !== 'string' || !id.startsWith('rr_')) errors.push(`rawRecordIds 含非法 ID：${id}`);
      }
      rawRecordIds = [...new Set(body.rawRecordIds)];
    }
  }
  let runKey = null;
  if (body.runKey !== undefined && body.runKey !== null) {
    if (typeof body.runKey !== 'string' || body.runKey.length === 0 || body.runKey.length > 120) errors.push('runKey 非法');
    else runKey = body.runKey;
  }
  let limit = 20;
  if (body.limit !== undefined && body.limit !== null) {
    const n = Number(body.limit);
    if (!Number.isInteger(n) || n < 1 || n > 50) errors.push('limit 必须是 1–50 的整数');
    else limit = n;
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { mode, rawRecordIds, runKey, limit, requestId: typeof body.requestId === 'string' ? body.requestId : null } };
}

/** POST /triage/apply */
export function validateTriageApply(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  if (typeof body.runId !== 'string' || !RUN_ID_RE.test(body.runId)) errors.push('runId 必须是 xrun_ 开头的 ID');
  if (!Array.isArray(body.decisions) || body.decisions.length === 0) errors.push('decisions 必须是非空数组');
  else if (body.decisions.length > 200) errors.push('decisions 最多 200 条');
  else {
    for (const decision of body.decisions) {
      if (!decision || typeof decision !== 'object') {
        errors.push('decision 必须是对象');
        continue;
      }
      if (typeof decision.candidateId !== 'string' || !decision.candidateId.startsWith('cand_')) {
        errors.push(`candidateId 非法：${decision.candidateId}`);
      }
      if (!TRIAGE_DECISIONS.includes(decision.action)) errors.push(`decision.action 非法：${decision.action}`);
      if (decision.patch !== undefined && (decision.patch === null || typeof decision.patch !== 'object' || Array.isArray(decision.patch))) {
        errors.push('decision.patch 必须是对象');
      }
    }
  }
  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    value: {
      runId: body.runId,
      decisions: body.decisions.map((decision) => ({
        candidateId: decision.candidateId,
        action: decision.action,
        patch: decision.patch || undefined,
      })),
      requestId: typeof body.requestId === 'string' ? body.requestId : null,
    },
  };
}

/** POST /triage/reprocess */
export function validateTriageReprocess(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  if (typeof body.rawRecordId !== 'string' || !body.rawRecordId.startsWith('rr_')) {
    return fail(['rawRecordId 必须是 rr_ 开头的 ID']);
  }
  return { ok: true, value: { rawRecordId: body.rawRecordId, requestId: typeof body.requestId === 'string' ? body.requestId : null } };
}

/** POST /triage/correct */
export function validateTriageCorrect(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  if (!CORRECT_TYPES.includes(body.type)) errors.push(`type 非法：${body.type}（允许：${CORRECT_TYPES.join('|')}）`);
  if (typeof body.id !== 'string' || body.id.length === 0) errors.push('id 必填');
  const action = body.action === undefined ? 'update' : body.action;
  if (!CORRECT_ACTIONS.includes(action)) errors.push(`action 非法：${action}`);
  if (body.patch !== undefined && (body.patch === null || typeof body.patch !== 'object' || Array.isArray(body.patch))) {
    errors.push('patch 必须是对象');
  }
  if (body.reason !== undefined && typeof body.reason !== 'string') errors.push('reason 必须是字符串');
  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    value: {
      type: body.type,
      id: body.id,
      action,
      patch: body.patch || undefined,
      reason: body.reason,
      requestId: typeof body.requestId === 'string' ? body.requestId : null,
    },
  };
}

/** GET /triage/runs/:id */
export function validateRunId(id) {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) return fail(['runId 必须是 xrun_ 开头的 ID']);
  return { ok: true, value: id };
}

/** PUT /triage/automation */
export function validateAutomationPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const patch = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') errors.push('enabled 必须是布尔值');
    else patch.enabled = body.enabled;
  }
  if (body.time !== undefined) {
    if (typeof body.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) errors.push('time 必须是 HH:mm');
    else patch.time = body.time;
  }
  if (Object.keys(patch).length === 0) errors.push('至少提供 enabled 或 time');
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: patch };
}

/* ───────────────────────── M2.5 v0.4：本地文件夹笔记 ───────────────────────── */

export const NOTES_CHANGED_EVENT = 'notes/changed';
export const NOTE_CHANGE_KINDS = Object.freeze(['add', 'change', 'unlink']);
export const NOTE_EXTENSIONS = Object.freeze(['.md', '.markdown', '.txt']);
export const MAX_NOTE_PATH_CHARS = 1024;
export const MAX_NOTE_READ_BYTES = 2 * 1024 * 1024;
export const MAX_NOTE_QUERY_CHARS = 200;
export const DEFAULT_NOTE_TREE_DEPTH = 4;
export const MAX_NOTE_TREE_DEPTH = 8;

const NOTE_TEMP_RE = /(^|\/)(~\$[^/]*|\.#[^/]*|#[^/]*#$|[^/]*\.(tmp|swp|swx|part|bak~)|\.DS_Store|Thumbs\.db)$/i;
const NOTE_IGNORED_DIR_RE = /(^|\/)(\.lifeos-history|\.trash|\.git|node_modules)(\/|$)/i;

/** 逻辑相对路径 → 校验；返回 {ok,value:{path}} 或 {ok:false,errors} */
export function validateNotePath(input, { allowEmpty = false } = {}) {
  const errors = [];
  if (typeof input !== 'string') return fail(['path 必须是字符串']);
  const value = input.trim();
  if (value.length === 0) {
    if (allowEmpty) return { ok: true, value: '' };
    return fail(['path 不能为空']);
  }
  if (value.length > MAX_NOTE_PATH_CHARS) errors.push(`path 超过 ${MAX_NOTE_PATH_CHARS} 字符`);
  if (value.includes('\u0000')) errors.push('path 不得包含 NUL');
  if (/^[a-zA-Z]:/.test(value) || value.startsWith('/') || value.startsWith('\\')) errors.push('path 必须是相对笔记目录的路径');
  if (value.includes('\\')) errors.push('path 必须使用 / 作为分隔符');
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    errors.push('path 不得包含空段、. 或 ..');
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) errors.push('path 不得包含控制字符');
  if (NOTE_IGNORED_DIR_RE.test(`/${value}`) || NOTE_TEMP_RE.test(`/${value}`)) errors.push('path 指向受保护目录/临时文件');
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { path: value } };
}

/** 文件路径（必须可编辑扩展名） */
export function validateNoteFilePath(input) {
  const base = validateNotePath(input, { allowEmpty: false });
  if (!base.ok) return base;
  const ext = base.value.path.slice(base.value.path.lastIndexOf('.')).toLowerCase();
  if (!NOTE_EXTENSIONS.includes(ext)) {
    return fail([`不支持的笔记扩展名（允许：${NOTE_EXTENSIONS.join('|')}）`]);
  }
  return base;
}

function normalizeNoteExt(path) {
  const last = path.slice(path.lastIndexOf('.')).toLowerCase();
  return NOTE_EXTENSIONS.includes(last) ? path : `${path}.md`;
}

function normalizeRequestId(body, headers) {
  const fromBody = body && typeof body.requestId === 'string' ? body.requestId.trim() : '';
  if (fromBody) return fromBody.slice(0, 128);
  if (headers && typeof headers === 'object') {
    const header = headers['x-request-id'] ?? headers['X-Request-Id'];
    if (typeof header === 'string' && header.trim().length > 0) return header.trim().slice(0, 128);
  }
  return null;
}

/** PUT /notes/config：{dir?, options?, create?}（至少要有一项） */
export function validateNotesConfig(body, headers) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const value = { requestId: normalizeRequestId(body, headers) };
  if (body.dir !== undefined) {
    if (typeof body.dir !== 'string' || body.dir.trim().length === 0 || body.dir.length > MAX_NOTE_PATH_CHARS) {
      errors.push('dir 必须是非空字符串（≤1024 字符）');
    } else if (body.dir.includes('\u0000')) errors.push('dir 不得包含 NUL');
    else value.dir = body.dir.trim();
  }
  if (body.create !== undefined) {
    if (typeof body.create !== 'boolean') errors.push('create 必须是布尔值');
    else value.create = body.create;
  }
  if (body.options !== undefined) {
    if (!body.options || typeof body.options !== 'object' || Array.isArray(body.options)) errors.push('options 必须是对象');
    else value.options = body.options;
  }
  if (value.dir === undefined && value.options === undefined) errors.push('至少提供 dir 或 options');
  if (errors.length > 0) return fail(errors);
  return { ok: true, value };
}

/** GET /notes/tree?dir=&depth= */
export function validateNotesTreeQuery(params) {
  const errors = [];
  const get = (name) => (params && typeof params.get === 'function' ? params.get(name) : null);
  let dir = '';
  const rawDir = get('dir');
  if (rawDir !== null && rawDir !== '') {
    const validated = validateNotePath(rawDir, { allowEmpty: true });
    if (!validated.ok) errors.push(...validated.errors);
    else dir = validated.value;
  }
  let depth = DEFAULT_NOTE_TREE_DEPTH;
  const rawDepth = get('depth');
  if (rawDepth !== null && rawDepth !== '') {
    const n = Number(rawDepth);
    if (!Number.isInteger(n) || n < 1 || n > MAX_NOTE_TREE_DEPTH) errors.push(`depth 必须是 1–${MAX_NOTE_TREE_DEPTH} 的整数`);
    else depth = n;
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { dir, depth } };
}

/** GET /notes/file?path= / GET /notes/history?path= */
export function validateNotesFileQuery(params) {
  const get = (name) => (params && typeof params.get === 'function' ? params.get(name) : null);
  return validateNoteFilePath(get('path'));
}

/** PUT /notes/file：{path, content, baseHash?, requestId?} */
export function validateNotesWrite(body, headers) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const pathResult = validateNoteFilePath(body.path);
  if (!pathResult.ok) errors.push(...pathResult.errors);
  if (typeof body.content !== 'string') errors.push('content 必须是字符串');
  else if (body.content.length > MAX_NOTE_READ_BYTES) errors.push('content 超过 2MB 上限');
  let baseHash = null;
  if (body.baseHash !== undefined && body.baseHash !== null) {
    if (typeof body.baseHash !== 'string' || body.baseHash.length < 8 || body.baseHash.length > 128) {
      errors.push('baseHash 必须是 8–128 字符字符串');
    } else baseHash = body.baseHash;
  }
  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    value: { path: pathResult.value.path, content: body.content, baseHash, requestId: normalizeRequestId(body, headers) },
  };
}

/** 新建/重命名目标：无扩展名自动补 .md；有扩展名必须在白名单内，否则报错。 */
function resolveCreatePath(rawPath, errors) {
  const lower = rawPath.toLowerCase();
  const lastSlash = lower.lastIndexOf('/');
  const lastDot = lower.lastIndexOf('.');
  const hasExt = lastDot > lastSlash;
  if (!hasExt) return `${rawPath}.md`;
  const ext = lower.slice(lastDot);
  if (!NOTE_EXTENSIONS.includes(ext)) errors.push(`不支持的笔记扩展名：${ext}（允许：${NOTE_EXTENSIONS.join('|')}）`);
  return rawPath;
}
/** POST /notes/file：{path, content?, requestId?} */
export function validateNotesCreate(body, headers) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const pathResult = validateNotePath(body.path);
  if (!pathResult.ok) errors.push(...pathResult.errors);
  let path = pathResult.ok ? resolveCreatePath(pathResult.value.path, errors) : null;
  if (body.content !== undefined && typeof body.content !== 'string') errors.push('content 必须是字符串');
  if (typeof body.content === 'string' && body.content.length > MAX_NOTE_READ_BYTES) errors.push('content 超过 2MB 上限');
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { path, content: typeof body.content === 'string' ? body.content : '', requestId: normalizeRequestId(body, headers) } };
}

/** POST /notes/rename：{path,toPath,requestId?}。允许文件或文件夹。 */
export function validateNotesRename(body, headers) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const from = validateNotePath(body.path);
  if (!from.ok) errors.push(...from.errors);
  const to = validateNotePath(body.toPath);
  if (!to.ok) errors.push(...to.errors.map((error) => `toPath: ${error}`));
  // 文件重命名保留 M2.5 的"无扩展名补 .md"；文件夹不改名尾
  const fromIsFile = from.ok && NOTE_EXTENSIONS.includes(from.value.path.slice(from.value.path.lastIndexOf('.')).toLowerCase());
  const toPath = to.ok && fromIsFile ? resolveCreatePath(to.value.path, errors) : to.ok ? to.value.path : null;
  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    value: {
      path: from.value.path,
      toPath,
      requestId: normalizeRequestId(body, headers),
    },
  };
}

/** POST /notes/remove：{path, trash?}（trash 默认 true）。允许文件或文件夹。 */
export function validateNotesRemove(body, headers) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const pathResult = validateNotePath(body.path);
  if (!pathResult.ok) errors.push(...pathResult.errors);
  let trash = true;
  if (body.trash !== undefined) {
    if (typeof body.trash !== 'boolean') errors.push('trash 必须是布尔值');
    else trash = body.trash;
  }
  let recursive = false;
  if (body.recursive !== undefined) {
    if (typeof body.recursive !== 'boolean') errors.push('recursive 必须是布尔值');
    else recursive = body.recursive;
  }
  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    value: { path: pathResult.value.path, trash, recursive, requestId: normalizeRequestId(body, headers) },
  };
}

/** POST /notes/folder：{path, recursive?/parents?, requestId?} */
export function validateNotesFolder(body, headers) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const pathResult = validateNotePath(body.path);
  if (!pathResult.ok) errors.push(...pathResult.errors);
  const rawRecursive = body.recursive !== undefined ? body.recursive : body.parents;
  let recursive = false;
  if (rawRecursive !== undefined) {
    if (typeof rawRecursive !== 'boolean') errors.push('recursive/parents 必须是布尔值');
    else recursive = rawRecursive;
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { path: pathResult.value.path, recursive, requestId: normalizeRequestId(body, headers) } };
}

/** GET /notes/search?q=&limit= */
export function validateNotesSearchQuery(params) {
  const errors = [];
  const get = (name) => (params && typeof params.get === 'function' ? params.get(name) : null);
  const q = get('q');
  if (typeof q !== 'string' || q.trim().length === 0) errors.push('q 必填');
  else if (q.length > MAX_NOTE_QUERY_CHARS) errors.push(`q 超过 ${MAX_NOTE_QUERY_CHARS} 字符`);
  let limit = 20;
  const rawLimit = get('limit');
  if (rawLimit !== null && rawLimit !== '') {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > 100) errors.push('limit 必须是 1–100 的整数');
    else limit = n;
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { q: String(q).trim(), limit } };
}

/** POST /notes/snapshot：{path, requestId?} */
export function validateNotesSnapshot(body, headers) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const pathResult = validateNoteFilePath(body.path);
  if (!pathResult.ok) return pathResult;
  return { ok: true, value: { path: pathResult.value.path, requestId: normalizeRequestId(body, headers) } };
}

/** 供 routes 使用：从 body/headers 取幂等键 */
export function noteRequestId(body, headers) {
  return normalizeRequestId(body, headers);
}

/* ───────────────────────── M3 v0.6：自动化 / 建议 / 通知 ───────────────────────── */

export const AUTOMATION_CHANGED_EVENT = 'automation/changed';
export const SUGGESTION_EVENT = 'suggestion';
export const NOTIFICATION_EVENT = 'notification';

export const SUGGESTION_ACTIONS = Object.freeze(['accept', 'dismiss', 'snooze']);
export const SUGGESTION_VIEW_STATUSES = Object.freeze(['pending', 'snoozed', 'accepted', 'dismissed', 'expired', 'all']);
export const SUGGESTION_RULE_TYPES = Object.freeze(['overdue_cleanup', 'inbox_backlog', 'habit_streak_risk', 'journal_morning']);
export const AUTOMATION_ROUTINES = Object.freeze(['morningBrief', 'eveningReview', 'habitNudge', 'nightlyInbox']);
export const DND_POLICIES = Object.freeze(['skip', 'defer']);

const HH_MM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SUGGESTION_ID_RE = /^sug_[A-Za-z0-9]+$/;
const NOTIFICATION_ID_RE = /^notif_[A-Za-z0-9]+$/;

function validTimeOfDay(value) {
  return typeof value === 'string' && HH_MM_RE.test(value);
}

/** PUT /automation：部分设置 patch（深合并由 A 的 patchSettings 负责）。 */
export function validateAutomationSettingsPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const patch = {};
  const checkRoutine = (key, requireEnabled = false) => {
    const value = body[key];
    if (value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${key} 必须是对象`);
      return;
    }
    const next = {};
    if (value.enabled !== undefined) {
      if (typeof value.enabled !== 'boolean') errors.push(`${key}.enabled 必须是布尔值`);
      else next.enabled = value.enabled;
    } else if (requireEnabled) {
      errors.push(`${key}.enabled 必填`);
    }
    if (value.time !== undefined) {
      if (!validTimeOfDay(value.time)) errors.push(`${key}.time 必须是 HH:mm`);
      else next.time = value.time;
    }
    if (Object.keys(next).length > 0) patch[key] = next;
  };
  for (const key of AUTOMATION_ROUTINES) checkRoutine(key);
  if (body.deadlineReminder !== undefined) {
    const value = body.deadlineReminder;
    if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('deadlineReminder 必须是对象');
    else {
      const next = {};
      if (value.enabled !== undefined) {
        if (typeof value.enabled !== 'boolean') errors.push('deadlineReminder.enabled 必须是布尔值');
        else next.enabled = value.enabled;
      }
      if (value.leadMinutes !== undefined) {
        const lead = Number(value.leadMinutes);
        if (!Number.isInteger(lead) || lead < 5 || lead > 1440) errors.push('deadlineReminder.leadMinutes 必须是 5–1440 整数');
        else next.leadMinutes = lead;
      }
      if (value.dueDateAt !== undefined) {
        if (!validTimeOfDay(value.dueDateAt)) errors.push('deadlineReminder.dueDateAt 必须是 HH:mm');
        else next.dueDateAt = value.dueDateAt;
      }
      if (Object.keys(next).length > 0) patch.deadlineReminder = next;
    }
  }
  if (body.dnd !== undefined) {
    const value = body.dnd;
    if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('dnd 必须是对象');
    else {
      const next = {};
      if (value.start !== undefined) {
        if (!validTimeOfDay(value.start)) errors.push('dnd.start 必须是 HH:mm');
        else next.start = value.start;
      }
      if (value.end !== undefined) {
        if (!validTimeOfDay(value.end)) errors.push('dnd.end 必须是 HH:mm');
        else next.end = value.end;
      }
      if (next.start && next.end && next.start === next.end) errors.push('dnd 不允许全天（start=end）');
      if (Object.keys(next).length > 0) patch.dnd = next;
    }
  }
  if (body.dailyBudget !== undefined) {
    const budget = Number(body.dailyBudget);
    if (!Number.isInteger(budget) || budget < 0 || budget > 5) errors.push('dailyBudget 必须是 0–5 整数');
    else patch.dailyBudget = budget;
  }
  if (body.suggestions !== undefined) {
    const value = body.suggestions;
    if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('suggestions 必须是对象');
    else {
      const next = {};
      if (value.enabled !== undefined) {
        if (typeof value.enabled !== 'boolean') errors.push('suggestions.enabled 必须是布尔值');
        else next.enabled = value.enabled;
      }
      if (value.maxPerDay !== undefined) {
        const max = Number(value.maxPerDay);
        if (!Number.isInteger(max) || max < 0 || max > 5) errors.push('suggestions.maxPerDay 必须是 0–5 整数');
        else next.maxPerDay = max;
      }
      if (Object.keys(next).length > 0) patch.suggestions = next;
    }
  }
  if (body.dndPolicy !== undefined) {
    if (!DND_POLICIES.includes(body.dndPolicy)) errors.push(`dndPolicy 必须是 ${DND_POLICIES.join('|')}`);
    else patch.dndPolicy = body.dndPolicy;
  }
  if (errors.length > 0) return fail(errors);
  if (Object.keys(patch).length === 0) return fail(['至少提供一项设置']);
  return { ok: true, value: { patch } };
}

/** POST /suggestions/:id/act */
export function validateSuggestionAct(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const action = body.action;
  if (!SUGGESTION_ACTIONS.includes(action)) errors.push(`action 必须是 ${SUGGESTION_ACTIONS.join('|')}`);
  let snoozeMinutes = null;
  if (body.snoozeMinutes !== undefined) {
    const minutes = Number(body.snoozeMinutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) errors.push('snoozeMinutes 必须是 5–1440 整数');
    else snoozeMinutes = minutes;
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { action, snoozeMinutes } };
}

/** GET /suggestions?status=&limit= */
export function validateSuggestionQuery(params) {
  const get = (name) => (params && typeof params.get === 'function' ? params.get(name) : null);
  const errors = [];
  let status = 'pending';
  const rawStatus = get('status');
  if (rawStatus !== null && rawStatus !== '') {
    if (!SUGGESTION_VIEW_STATUSES.includes(rawStatus)) errors.push(`status 必须是 ${SUGGESTION_VIEW_STATUSES.join('|')}`);
    else status = rawStatus;
  }
  let limit = 20;
  const rawLimit = get('limit');
  if (rawLimit !== null && rawLimit !== '') {
    const value = Number(rawLimit);
    if (!Number.isInteger(value) || value < 1 || value > 50) errors.push('limit 必须是 1–50 整数');
    else limit = value;
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { status, limit } };
}

/** GET /notifications?status=&limit= */
export function validateNotificationsQuery(params) {
  const get = (name) => (params && typeof params.get === 'function' ? params.get(name) : null);
  const errors = [];
  let limit = 50;
  const rawLimit = get('limit');
  if (rawLimit !== null && rawLimit !== '') {
    const value = Number(rawLimit);
    if (!Number.isInteger(value) || value < 1 || value > 50) errors.push('limit 必须是 1–50 整数');
    else limit = value;
  }
  let status = null;
  const rawStatus = get('status');
  if (rawStatus !== null && rawStatus !== '') {
    if (!['pending', 'delivered', 'dismissed', 'expired'].includes(rawStatus)) errors.push('status 非法');
    else status = rawStatus;
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { status, limit } };
}

export function validateSuggestionId(id) {
  if (typeof id !== 'string' || !SUGGESTION_ID_RE.test(id)) return fail(['id 必须是 sug_ 前缀']);
  return { ok: true, value: { id } };
}

export function validateNotificationId(id) {
  if (typeof id !== 'string' || !NOTIFICATION_ID_RE.test(id)) return fail(['id 必须是 notif_ 前缀']);
  return { ok: true, value: { id } };
}

/* ───────────────────────── M4 v0.7：习惯 / 项目 / 目标 / 愿望 / 回顾 ───────────────────────── */

export const HABIT_STATUSES = Object.freeze(['active', 'paused', 'archived']);
export const HABIT_FREQUENCY_KINDS = Object.freeze(['daily', 'weekly_days', 'weekly_count', 'interval']);
export const HABIT_CHECKIN_STATUSES = Object.freeze(['done', 'partial', 'skipped', 'not_done']);
export const HABIT_CHECKIN_MODES = Object.freeze(['manual', 'event_auto', 'either']);
export const HABIT_STREAK_MODES = Object.freeze(['grace', 'strict']);
export const PERIOD_KINDS = Object.freeze(['week', 'month']);
export const WEEK_STARTS = Object.freeze(['monday', 'sunday']);
export const WEEKDAY_CODES = Object.freeze(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
export const PROJECT_PROGRESS_MODES = Object.freeze(['auto_by_tasks', 'manual']);
export const GOAL_STATUSES = Object.freeze(['active', 'paused', 'achieved', 'abandoned']);
export const GOAL_HORIZONS = Object.freeze(['short', 'mid', 'long']);
export const GOAL_PROGRESS_MODES = Object.freeze(['manual', 'auto_by_projects', 'auto_by_tasks']);
export const WISH_STATUSES = Object.freeze(['captured', 'considering', 'committed', 'deferred', 'discarded']);
export const REVIEW_PERIODS = Object.freeze(['week']);

const MONTH_RE = /^\d{4}-\d{2}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalLocalDate(body, name, errors) {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (!isLocalDate(value)) {
    errors.push(`${name} 必须是 YYYY-MM-DD`);
    return null;
  }
  return value;
}

function optionalEnum(body, name, errors, allowed) {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (!allowed.includes(value)) {
    errors.push(`${name} 必须是 ${allowed.join('|')}`);
    return null;
  }
  return value;
}

function optionalInt(body, name, errors, { min = -1000000, max = 1000000 } = {}) {
  const value = body[name];
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${name} 必须是 ${min}–${max} 整数`);
    return null;
  }
  return n;
}

function optionalPercent(body, name, errors) {
  const value = body[name];
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    errors.push(`${name} 必须是 0–100 的数字`);
    return null;
  }
  return n;
}

function optionalJsonObject(body, name, errors) {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    errors.push(`${name} 必须是 JSON 对象`);
    return null;
  }
  return value;
}

/** 创建类输入：省略未提供的可空字段（服务层按缺省值处理；显式 null 仅 PATCH 用于清空） */
function compactCreateValue(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && item !== undefined) out[key] = item;
  }
  return out;
}

/** YYYY-MM → 合法月份字符串；非法返回 fail(errors) */
export function parseMonth(value) {
  if (typeof value !== 'string' || !MONTH_RE.test(value)) return fail(['month 必须是 YYYY-MM']);
  const [year, month] = value.split('-').map(Number);
  if (year < 1970 || year > 2100 || month < 1 || month > 12) return fail(['month 不是合法月份']);
  return { ok: true, value };
}

/**
 * 可选 expectedRev：If-Match 头 / body.expectedRev / query expectedRev 三者取其一，全缺省 → null。
 * 用于 DELETE、convert 等 expectedRev 可选的写端点。
 */
export function parseOptionalExpectedRev(req, body, url) {
  const errors = [];
  const headers = (req && req.headers) || {};
  const rawHeader = headers['if-match'] ?? headers['If-Match'] ?? null;
  let headerRev = null;
  if (rawHeader !== null && rawHeader !== undefined && rawHeader !== '') {
    const normalized = String(rawHeader).trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    const n = Number(normalized);
    if (!Number.isInteger(n) || n < 1) errors.push('If-Match 必须是正整数 rev');
    else headerRev = n;
  }
  let bodyRev = null;
  if (body && typeof body === 'object' && body.expectedRev !== undefined && body.expectedRev !== null) {
    const n = Number(body.expectedRev);
    if (!Number.isInteger(n) || n < 1) errors.push('expectedRev 必须是正整数');
    else bodyRev = n;
  }
  let queryRev = null;
  const rawQuery = url && typeof url.searchParams?.get === 'function' ? url.searchParams.get('expectedRev') : null;
  if (rawQuery !== null && rawQuery !== undefined && rawQuery !== '') {
    const n = Number(rawQuery);
    if (!Number.isInteger(n) || n < 1) errors.push('expectedRev 必须是正整数');
    else queryRev = n;
  }
  const present = [headerRev, bodyRev, queryRev].filter((rev) => rev !== null);
  if (present.length > 1 && new Set(present).size > 1) errors.push('expectedRev 来源不一致');
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { expectedRev: present.length > 0 ? present[0] : null } };
}

/** 频率规则形状校验（语义在 domain/habit.js） */
function validateFrequencyRuleShape(rule, errors) {
  if (!isPlainObject(rule)) {
    errors.push('frequency_rule 必须是 JSON 对象');
    return null;
  }
  const kind = rule.kind;
  if (kind === 'monthly_count') {
    errors.push('M4a 暂不支持 monthly_count 频率');
    return null;
  }
  if (!HABIT_FREQUENCY_KINDS.includes(kind)) {
    errors.push(`frequency_rule.kind 必须是 ${HABIT_FREQUENCY_KINDS.join('|')}`);
    return null;
  }
  const out = { kind };
  if (kind === 'daily') {
    const interval = rule.interval === undefined ? 1 : Number(rule.interval);
    if (!Number.isInteger(interval) || interval < 1 || interval > 365) errors.push('frequency_rule.interval 必须是 1–365 整数');
    else out.interval = interval;
  } else if (kind === 'weekly_days') {
    if (!Array.isArray(rule.days) || rule.days.length === 0) {
      errors.push('frequency_rule.days 必须是非空数组');
    } else {
      const seen = new Set();
      const days = [];
      for (const day of rule.days) {
        const code = typeof day === 'string' ? day.toUpperCase() : '';
        if (!WEEKDAY_CODES.includes(code)) {
          errors.push(`frequency_rule.days 含非法星期：${day}`);
          continue;
        }
        if (!seen.has(code)) {
          seen.add(code);
          days.push(code);
        }
      }
      out.days = days;
    }
  } else if (kind === 'weekly_count') {
    const count = Number(rule.count);
    if (!Number.isInteger(count) || count < 1 || count > 7) errors.push('frequency_rule.count 必须是 1–7 整数');
    else out.count = count;
  } else {
    const days = Number(rule.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) errors.push('frequency_rule.days 必须是 1–365 整数');
    else out.days = days;
    if (rule.anchor_date !== undefined && rule.anchor_date !== null) {
      if (!isLocalDate(rule.anchor_date)) errors.push('frequency_rule.anchor_date 必须是 YYYY-MM-DD');
      else out.anchor_date = rule.anchor_date;
    }
  }
  return out;
}

/** 周期目标规则形状校验（可空） */
function validatePeriodRuleShape(rule, errors) {
  if (rule === undefined || rule === null) return null;
  if (!isPlainObject(rule)) {
    errors.push('period_rule 必须是 JSON 对象');
    return null;
  }
  const out = {};
  if (!PERIOD_KINDS.includes(rule.period)) errors.push(`period_rule.period 必须是 ${PERIOD_KINDS.join('|')}`);
  else out.period = rule.period;
  const target = Number(rule.target_count);
  if (!Number.isInteger(target) || target < 1 || target > 366) errors.push('period_rule.target_count 必须是 1–366 整数');
  else out.target_count = target;
  if (rule.week_start !== undefined && rule.week_start !== null) {
    if (!WEEK_STARTS.includes(rule.week_start)) errors.push(`period_rule.week_start 必须是 ${WEEK_STARTS.join('|')}`);
    else out.week_start = rule.week_start;
  }
  return out;
}

export function validateHabitId(id) {
  if (!isEntityId(id) || !String(id).startsWith('hab_')) return fail(['id 必须是 hab_ 开头的习惯 ID']);
  return { ok: true, value: id };
}

export function validateHabitGroupId(id) {
  if (!isEntityId(id) || !String(id).startsWith('hgrp_')) return fail(['id 必须是 hgrp_ 开头的习惯分组 ID']);
  return { ok: true, value: id };
}

const HABIT_GROUP_NAME_MAX = 40;
const HABIT_ICON_MAX = 8;

/** 习惯图标：单个 emoji（长度上限 8 个 UTF-16 单元），null/''/undefined → null（清除，回落按名称推导） */
function optionalHabitIcon(body, name, errors) {
  const value = body[name];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    errors.push(`${name} 必须是字符串`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > HABIT_ICON_MAX) {
    errors.push(`${name} 超过上限 ${HABIT_ICON_MAX} 字符`);
    return null;
  }
  return trimmed;
}

/** 习惯分组引用：null / 缺省 → null（未分组），字符串必须 hgrp_ 前缀 */
function optionalHabitGroupRef(body, name, errors) {
  const value = body[name];
  if (value === undefined || value === null || value === '') return null;
  if (!isEntityId(value) || !String(value).startsWith('hgrp_')) {
    errors.push(`${name} 必须是 hgrp_ 开头的分组 ID`);
    return null;
  }
  return value;
}

/** POST /habit-groups */
export function validateHabitGroupCreate(body) {
  if (!isPlainObject(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  if (body.name === undefined || body.name === null) errors.push('name 必填');
  const name = optionalString(body, 'name', errors, { max: HABIT_GROUP_NAME_MAX, allowEmpty: false });
  const sortOrder = optionalInt(body, 'sort_order', errors);
  let collapsed = null;
  if (body.collapsed !== undefined && body.collapsed !== null) {
    if (typeof body.collapsed !== 'boolean') errors.push('collapsed 必须是布尔值');
    else collapsed = body.collapsed;
  }
  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    value: compactCreateValue({
      name: name === null ? null : name.trim(),
      sort_order: sortOrder,
      collapsed,
    }),
  };
}

/** PATCH /habit-groups/:id 的 patch 对象 */
export function validateHabitGroupPatch(patch) {
  if (!isPlainObject(patch)) return fail(['patch 必须是 JSON 对象']);
  const errors = [];
  const out = {};
  if (patch.name !== undefined) {
    if (patch.name === null) errors.push('name 不能为空');
    else {
      const name = optionalString(patch, 'name', errors, { max: HABIT_GROUP_NAME_MAX, allowEmpty: false });
      if (name !== null) out.name = name.trim();
    }
  }
  if (patch.sort_order !== undefined) {
    const value = optionalInt(patch, 'sort_order', errors);
    if (value !== null) out.sort_order = value;
  }
  if (patch.collapsed !== undefined) {
    if (typeof patch.collapsed !== 'boolean') errors.push('collapsed 必须是布尔值');
    else out.collapsed = patch.collapsed;
  }
  if (Object.keys(out).length === 0) errors.push('至少提供一个要更新的字段');
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: out };
}

/** POST /habit-groups/reorder：ids 为拖拽后的完整顺序 */
export function validateHabitGroupReorder(body) {
  if (!isPlainObject(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    errors.push('ids 必须是非空数组');
  } else if (ids.length > 200) {
    errors.push('ids 最多 200 项');
  } else {
    const seen = new Set();
    for (const id of ids) {
      if (!isEntityId(id) || !String(id).startsWith('hgrp_')) {
        errors.push('ids 含非法习惯分组 ID');
        break;
      }
      if (seen.has(id)) {
        errors.push('ids 不能重复');
        break;
      }
      seen.add(id);
    }
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { ids: [...ids] } };
}

export function validateGoalId(id) {
  if (!isEntityId(id) || !String(id).startsWith('gol_')) return fail(['id 必须是 gol_ 开头的目标 ID']);
  return { ok: true, value: id };
}

export function validateWishId(id) {
  if (!isEntityId(id) || !String(id).startsWith('wsh_')) return fail(['id 必须是 wsh_ 开头的愿望 ID']);
  return { ok: true, value: id };
}

/** 路径里的本地日期参数 */
export function validateLocalDateParam(value, label = 'date') {
  if (!isLocalDate(value)) return fail([`${label} 必须是 YYYY-MM-DD`]);
  return { ok: true, value };
}

/** POST /habits */
export function validateHabitCreate(body) {
  if (!isPlainObject(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const name = optionalString(body, 'name', errors, { max: 200, allowEmpty: false });
  if (body.name === undefined || body.name === null) errors.push('name 必填');
  const description = optionalString(body, 'description', errors, { max: 2000, allowEmpty: true });
  const frequencyRule = body.frequency_rule === undefined
    ? (errors.push('frequency_rule 必填'), null)
    : validateFrequencyRuleShape(body.frequency_rule, errors);
  const periodRule = validatePeriodRuleShape(body.period_rule, errors);
  const targetJson = optionalJsonObject(body, 'target_json', errors);
  const checkinMode = optionalEnum(body, 'checkin_mode', errors, HABIT_CHECKIN_MODES);
  const startDate = optionalLocalDate(body, 'start_date', errors);
  const endDate = optionalLocalDate(body, 'end_date', errors);
  const timeHint = optionalString(body, 'time_hint', errors, { max: 40, allowEmpty: true });
  const sortOrder = optionalInt(body, 'sort_order', errors);
  const icon = optionalHabitIcon(body, 'icon', errors);
  const groupId = optionalHabitGroupRef(body, 'group_id', errors);
  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    value: compactCreateValue({
      name,
      description,
      frequency_rule: frequencyRule,
      period_rule: periodRule,
      target_json: targetJson,
      checkin_mode: checkinMode ?? 'either',
      start_date: startDate,
      end_date: endDate,
      time_hint: timeHint,
      sort_order: sortOrder ?? 0,
      icon,
      group_id: groupId,
    }),
  };
}

/** PATCH /habits/:id 的 patch 对象 */
export function validateHabitPatch(patch) {
  if (!isPlainObject(patch)) return fail(['patch 必须是 JSON 对象']);
  const errors = [];
  const out = {};
  if (patch.name !== undefined) {
    const name = optionalString(patch, 'name', errors, { max: 200, allowEmpty: false });
    if (name !== null) out.name = name;
  }
  if (patch.description !== undefined) {
    if (patch.description === null) out.description = null;
    else {
      const description = optionalString(patch, 'description', errors, { max: 2000, allowEmpty: true });
      if (description !== null) out.description = description;
    }
  }
  if (patch.status !== undefined) {
    if (!HABIT_STATUSES.includes(patch.status)) errors.push(`status 必须是 ${HABIT_STATUSES.join('|')}`);
    else out.status = patch.status;
  }
  if (patch.frequency_rule !== undefined) {
    const rule = validateFrequencyRuleShape(patch.frequency_rule, errors);
    if (rule) out.frequency_rule = rule;
  }
  if (patch.period_rule !== undefined) {
    if (patch.period_rule === null) out.period_rule = null;
    else {
      const rule = validatePeriodRuleShape(patch.period_rule, errors);
      if (rule) out.period_rule = rule;
    }
  }
  if (patch.target_json !== undefined) {
    if (patch.target_json === null) out.target_json = null;
    else {
      const value = optionalJsonObject(patch, 'target_json', errors);
      if (value !== null) out.target_json = value;
    }
  }
  if (patch.checkin_mode !== undefined) {
    const mode = optionalEnum(patch, 'checkin_mode', errors, HABIT_CHECKIN_MODES);
    if (mode !== null) out.checkin_mode = mode;
  }
  if (patch.start_date !== undefined) {
    if (patch.start_date === null) out.start_date = null;
    else {
      const value = optionalLocalDate(patch, 'start_date', errors);
      if (value !== null) out.start_date = value;
    }
  }
  if (patch.end_date !== undefined) {
    if (patch.end_date === null) out.end_date = null;
    else {
      const value = optionalLocalDate(patch, 'end_date', errors);
      if (value !== null) out.end_date = value;
    }
  }
  if (patch.time_hint !== undefined) {
    if (patch.time_hint === null) out.time_hint = null;
    else {
      const value = optionalString(patch, 'time_hint', errors, { max: 40, allowEmpty: true });
      if (value !== null) out.time_hint = value;
    }
  }
  if (patch.sort_order !== undefined) {
    const value = optionalInt(patch, 'sort_order', errors);
    if (value !== null) out.sort_order = value;
  }
  if (patch.icon !== undefined) {
    out.icon = patch.icon === null ? null : optionalHabitIcon(patch, 'icon', errors);
  }
  if (patch.group_id !== undefined) {
    out.group_id = patch.group_id === null ? null : optionalHabitGroupRef(patch, 'group_id', errors);
  }
  if (Object.keys(out).length === 0) errors.push('至少提供一个要更新的字段');
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: out };
}

/** POST /habits/:id/checkin */
export function validateCheckin(body) {
  if (!isPlainObject(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  let localDate = null;
  if (body.localDate !== undefined && body.localDate !== null) {
    if (!isLocalDate(body.localDate)) errors.push('localDate 必须是 YYYY-MM-DD');
    else localDate = body.localDate;
  }
  const status = optionalEnum(body, 'status', errors, HABIT_CHECKIN_STATUSES) ?? 'done';
  let value = null;
  if (body.value !== undefined && body.value !== null) {
    if (typeof body.value === 'number' && Number.isFinite(body.value)) value = body.value;
    else if (isPlainObject(body.value)) value = body.value;
    else errors.push('value 必须是数字或 JSON 对象');
  }
  let note = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') errors.push('note 必须是字符串');
    else if (body.note.length > 1000) errors.push('note 超过上限 1000 字符');
    else note = body.note;
  }
  let retro = false;
  if (body.retro !== undefined) {
    if (typeof body.retro !== 'boolean') errors.push('retro 必须是布尔值');
    else retro = body.retro;
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { localDate, status, value, note, retro } };
}

/** GET /habits/:id/checkins?from=&to= */
export function validateCheckinQuery(params) {
  const get = (name) => (params && typeof params.get === 'function' ? params.get(name) : null);
  const errors = [];
  const from = get('from');
  const to = get('to');
  if (from !== null && from !== '' && !isLocalDate(from)) errors.push('from 必须是 YYYY-MM-DD');
  if (to !== null && to !== '' && !isLocalDate(to)) errors.push('to 必须是 YYYY-MM-DD');
  if (from && to && isLocalDate(from) && isLocalDate(to)) {
    if (from > to) errors.push('from 不能晚于 to');
    else {
      const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
      if (days > 366) errors.push('区间最多 366 天');
    }
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { from: from || null, to: to || null } };
}

function validateStatusListQuery(params, statuses) {
  const get = (name) => (params && typeof params.get === 'function' ? params.get(name) : null);
  const errors = [];
  let status = null;
  const rawStatus = get('status');
  if (rawStatus !== null && rawStatus !== '') {
    if (!statuses.includes(rawStatus)) errors.push(`status 必须是 ${statuses.join('|')}`);
    else status = rawStatus;
  }
  let includeArchived = false;
  const rawInclude = get('includeArchived');
  if (rawInclude !== null && rawInclude !== '') {
    const lower = String(rawInclude).toLowerCase();
    if (lower === 'true' || lower === '1') includeArchived = true;
    else if (lower === 'false' || lower === '0') includeArchived = false;
    else errors.push('includeArchived 必须是布尔值');
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { status, includeArchived } };
}

export function validateHabitListQuery(params) {
  return validateStatusListQuery(params, HABIT_STATUSES);
}

export function validateProjectListQuery(params) {
  return validateStatusListQuery(params, PROJECT_STATUSES);
}

export function validateGoalListQuery(params) {
  return validateStatusListQuery(params, GOAL_STATUSES);
}

export function validateWishListQuery(params) {
  return validateStatusListQuery(params, WISH_STATUSES);
}

/** GET /habits/stats?from=&to=&mode= */
export function validateHabitStatsQuery(params) {
  const get = (name) => (params && typeof params.get === 'function' ? params.get(name) : null);
  const errors = [];
  const from = get('from');
  const to = get('to');
  if (from !== null && from !== '' && !isLocalDate(from)) errors.push('from 必须是 YYYY-MM-DD');
  if (to !== null && to !== '' && !isLocalDate(to)) errors.push('to 必须是 YYYY-MM-DD');
  if (from && to && isLocalDate(from) && isLocalDate(to)) {
    if (from > to) errors.push('from 不能晚于 to');
    else {
      const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
      if (days > 366) errors.push('区间最多 366 天');
    }
  }
  let mode = 'grace';
  const rawMode = get('mode');
  if (rawMode !== null && rawMode !== '') {
    if (!HABIT_STREAK_MODES.includes(rawMode)) errors.push(`mode 必须是 ${HABIT_STREAK_MODES.join('|')}`);
    else mode = rawMode;
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { from: from || null, to: to || null, mode } };
}

/** GET /habits/month?month=YYYY-MM */
export function validateHabitMonthQuery(params) {
  const get = (name) => (params && typeof params.get === 'function' ? params.get(name) : null);
  const parsed = parseMonth(get('month'));
  if (!parsed.ok) return parsed;
  return { ok: true, value: { month: parsed.value } };
}

/** GET /review/summary?period=week&anchor= */
export function validateReviewSummaryQuery(params) {
  const get = (name) => (params && typeof params.get === 'function' ? params.get(name) : null);
  const errors = [];
  let period = 'week';
  const rawPeriod = get('period');
  if (rawPeriod !== null && rawPeriod !== '') {
    if (!REVIEW_PERIODS.includes(rawPeriod)) errors.push(`period 必须是 ${REVIEW_PERIODS.join('|')}`);
    else period = rawPeriod;
  }
  let anchor = null;
  const rawAnchor = get('anchor');
  if (rawAnchor !== null && rawAnchor !== '') {
    if (!isLocalDate(rawAnchor)) errors.push('anchor 必须是 YYYY-MM-DD');
    else anchor = rawAnchor;
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: { period, anchor } };
}

/** POST /projects（M4；兼容 M1 的 {name,color}） */
export function validateProjectCreate(body) {
  if (!isPlainObject(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const name = optionalString(body, 'name', errors, { max: 100, allowEmpty: false });
  if (body.name === undefined || body.name === null) errors.push('name 必填');
  const description = optionalString(body, 'description', errors, { max: 2000, allowEmpty: true });
  let color = null;
  if (body.color !== undefined && body.color !== null) {
    if (typeof body.color !== 'string' || body.color.length > 32) errors.push('color 必须是 ≤32 字符的字符串');
    else color = body.color;
  }
  const startDate = optionalLocalDate(body, 'start_date', errors);
  const targetDate = optionalLocalDate(body, 'target_date', errors);
  const progressMode = optionalEnum(body, 'progress_mode', errors, PROJECT_PROGRESS_MODES);
  const progressPct = optionalPercent(body, 'progress_pct', errors);
  const sortOrder = optionalInt(body, 'sort_order', errors);
  const status = optionalEnum(body, 'status', errors, PROJECT_STATUSES) ?? 'active';
  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    value: compactCreateValue({
      name,
      description,
      color,
      start_date: startDate,
      target_date: targetDate,
      progress_mode: progressMode,
      progress_pct: progressPct,
      sort_order: sortOrder ?? 0,
      status,
    }),
  };
}

/** PATCH /projects/:id 的 patch 对象 */
export function validateProjectPatch(patch) {
  if (!isPlainObject(patch)) return fail(['patch 必须是 JSON 对象']);
  const errors = [];
  const out = {};
  if (patch.name !== undefined) {
    const name = optionalString(patch, 'name', errors, { max: 100, allowEmpty: false });
    if (name !== null) out.name = name;
  }
  if (patch.description !== undefined) {
    if (patch.description === null) out.description = null;
    else {
      const description = optionalString(patch, 'description', errors, { max: 2000, allowEmpty: true });
      if (description !== null) out.description = description;
    }
  }
  if (patch.color !== undefined) {
    if (patch.color === null) out.color = null;
    else if (typeof patch.color !== 'string' || patch.color.length > 32) errors.push('color 必须是 ≤32 字符的字符串');
    else out.color = patch.color;
  }
  if (patch.status !== undefined) {
    if (!PROJECT_STATUSES.includes(patch.status)) errors.push(`status 必须是 ${PROJECT_STATUSES.join('|')}`);
    else out.status = patch.status;
  }
  if (patch.start_date !== undefined) {
    if (patch.start_date === null) out.start_date = null;
    else {
      const value = optionalLocalDate(patch, 'start_date', errors);
      if (value !== null) out.start_date = value;
    }
  }
  if (patch.target_date !== undefined) {
    if (patch.target_date === null) out.target_date = null;
    else {
      const value = optionalLocalDate(patch, 'target_date', errors);
      if (value !== null) out.target_date = value;
    }
  }
  if (patch.progress_mode !== undefined) {
    const mode = optionalEnum(patch, 'progress_mode', errors, PROJECT_PROGRESS_MODES);
    if (mode !== null) out.progress_mode = mode;
  }
  if (patch.progress_pct !== undefined) {
    if (patch.progress_pct === null) out.progress_pct = null;
    else {
      const value = optionalPercent(patch, 'progress_pct', errors);
      if (value !== null) out.progress_pct = value;
    }
  }
  if (patch.sort_order !== undefined) {
    const value = optionalInt(patch, 'sort_order', errors);
    if (value !== null) out.sort_order = value;
  }
  if (Object.keys(out).length === 0) errors.push('至少提供一个要更新的字段');
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: out };
}

/** POST /goals */
export function validateGoalCreate(body) {
  if (!isPlainObject(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const title = optionalString(body, 'title', errors, { max: MAX_TITLE_CHARS, allowEmpty: false });
  if (body.title === undefined || body.title === null) errors.push('title 必填');
  const description = optionalString(body, 'description', errors, { max: 2000, allowEmpty: true });
  const successCriteria = optionalString(body, 'success_criteria', errors, { max: 2000, allowEmpty: true });
  const horizon = optionalEnum(body, 'horizon', errors, GOAL_HORIZONS);
  const startDate = optionalLocalDate(body, 'start_date', errors);
  const targetDate = optionalLocalDate(body, 'target_date', errors);
  const progressMode = optionalEnum(body, 'progress_mode', errors, GOAL_PROGRESS_MODES);
  const progressPct = optionalPercent(body, 'progress_pct', errors);
  const sortOrder = optionalInt(body, 'sort_order', errors);
  let status = 'active';
  if (body.status !== undefined) {
    if (!['active', 'paused'].includes(body.status)) errors.push('status 只能是 active|paused');
    else status = body.status;
  }
  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    value: compactCreateValue({
      title,
      description,
      success_criteria: successCriteria,
      horizon: horizon ?? 'mid',
      start_date: startDate,
      target_date: targetDate,
      progress_mode: progressMode ?? 'manual',
      progress_pct: progressPct,
      sort_order: sortOrder ?? 0,
      status,
    }),
  };
}

/** PATCH /goals/:id 的 patch 对象 */
export function validateGoalPatch(patch) {
  if (!isPlainObject(patch)) return fail(['patch 必须是 JSON 对象']);
  const errors = [];
  const out = {};
  if (patch.title !== undefined) {
    const title = optionalString(patch, 'title', errors, { max: MAX_TITLE_CHARS, allowEmpty: false });
    if (title !== null) out.title = title;
  }
  for (const field of ['description', 'success_criteria', 'abandoned_reason']) {
    if (patch[field] === undefined) continue;
    if (patch[field] === null) out[field] = null;
    else {
      const value = optionalString(patch, field, errors, { max: 2000, allowEmpty: true });
      if (value !== null) out[field] = value;
    }
  }
  if (patch.status !== undefined) {
    if (!GOAL_STATUSES.includes(patch.status)) errors.push(`status 必须是 ${GOAL_STATUSES.join('|')}`);
    else out.status = patch.status;
  }
  if (patch.horizon !== undefined) {
    const horizon = optionalEnum(patch, 'horizon', errors, GOAL_HORIZONS);
    if (horizon !== null) out.horizon = horizon;
  }
  if (patch.start_date !== undefined) {
    if (patch.start_date === null) out.start_date = null;
    else {
      const value = optionalLocalDate(patch, 'start_date', errors);
      if (value !== null) out.start_date = value;
    }
  }
  if (patch.target_date !== undefined) {
    if (patch.target_date === null) out.target_date = null;
    else {
      const value = optionalLocalDate(patch, 'target_date', errors);
      if (value !== null) out.target_date = value;
    }
  }
  if (patch.progress_mode !== undefined) {
    const mode = optionalEnum(patch, 'progress_mode', errors, GOAL_PROGRESS_MODES);
    if (mode !== null) out.progress_mode = mode;
  }
  if (patch.progress_pct !== undefined) {
    if (patch.progress_pct === null) out.progress_pct = null;
    else {
      const value = optionalPercent(patch, 'progress_pct', errors);
      if (value !== null) out.progress_pct = value;
    }
  }
  if (patch.sort_order !== undefined) {
    const value = optionalInt(patch, 'sort_order', errors);
    if (value !== null) out.sort_order = value;
  }
  if (Object.keys(out).length === 0) errors.push('至少提供一个要更新的字段');
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: out };
}

/** POST /wishes */
export function validateWishCreate(body) {
  if (!isPlainObject(body)) return fail(['body 必须是 JSON 对象']);
  const errors = [];
  const title = optionalString(body, 'title', errors, { max: MAX_TITLE_CHARS, allowEmpty: false });
  if (body.title === undefined || body.title === null) errors.push('title 必填');
  const description = optionalString(body, 'description', errors, { max: 2000, allowEmpty: true });
  const reviewAt = optionalLocalDate(body, 'review_at', errors);
  const sortOrder = optionalInt(body, 'sort_order', errors);
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: compactCreateValue({ title, description, review_at: reviewAt, sort_order: sortOrder ?? 0 }) };
}

/** PATCH /wishes/:id 的 patch 对象 */
export function validateWishPatch(patch) {
  if (!isPlainObject(patch)) return fail(['patch 必须是 JSON 对象']);
  const errors = [];
  const out = {};
  if (patch.title !== undefined) {
    const title = optionalString(patch, 'title', errors, { max: MAX_TITLE_CHARS, allowEmpty: false });
    if (title !== null) out.title = title;
  }
  if (patch.description !== undefined) {
    if (patch.description === null) out.description = null;
    else {
      const value = optionalString(patch, 'description', errors, { max: 2000, allowEmpty: true });
      if (value !== null) out.description = value;
    }
  }
  if (patch.status !== undefined) {
    if (!WISH_STATUSES.includes(patch.status)) errors.push(`status 必须是 ${WISH_STATUSES.join('|')}`);
    else out.status = patch.status;
  }
  if (patch.review_at !== undefined) {
    if (patch.review_at === null) out.review_at = null;
    else {
      const value = optionalLocalDate(patch, 'review_at', errors);
      if (value !== null) out.review_at = value;
    }
  }
  if (patch.converted_to_goal_id !== undefined) {
    if (patch.converted_to_goal_id === null) out.converted_to_goal_id = null;
    else if (!isEntityId(patch.converted_to_goal_id) || !String(patch.converted_to_goal_id).startsWith('gol_')) errors.push('converted_to_goal_id 必须是 gol_ 开头的目标 ID');
    else out.converted_to_goal_id = patch.converted_to_goal_id;
  }
  if (patch.sort_order !== undefined) {
    const value = optionalInt(patch, 'sort_order', errors);
    if (value !== null) out.sort_order = value;
  }
  if (Object.keys(out).length === 0) errors.push('至少提供一个要更新的字段');
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: out };
}

/** POST /wishes/:id/convert */
export function validateWishConvert(body) {
  if (!isPlainObject(body)) return fail(['body 必须是 JSON 对象']);
  if (!isPlainObject(body.goal)) return fail(['goal 必须是 JSON 对象']);
  const goal = validateGoalCreate(body.goal);
  if (!goal.ok) return goal;
  return { ok: true, value: { goal: goal.value } };
}
