/**
 * M6 HTTP 路由（v0.8）：清单 / 分组 / 任务补充 / 笔记标签。
 *
 * 设计说明：
 * - 只写 Host 层：解析/校验请求、调用 lifeos-service facade、返回 flat value；
 *   `{ok,value}` 信封、CAS、SSE changed、operation_log 由 routes.js 与 service 统一处理。
 * - contract.js 是共享层（M6-PLAN §4 不在本实现写范围），因此这里自带 M6 参数校验器：
 *   旧 view/字段继续沿用 contract 的 validateCreateTask/validateUpdateTask/validateCalendarQuery
 *   语义，新参数（listId/groupId/parentTaskId/pinned/sortOrder、view=done|trash、month）
 *   在本地扩展。
 * - buildM6Routes(deps) 返回 [{method,pattern,handler}]，由 routes.js 聚合。
 */
import {
  DEFAULT_LIMIT,
  MAX_CALENDAR_DAYS,
  MAX_LIMIT,
  TASK_VIEWS,
  isEntityId,
  isLocalDate,
  parseExpectedRev,
  parseMonth,
  parseOptionalExpectedRev,
  validateCreateTask,
  validateUpdateTask,
} from '../client-shared/contract.js';
import { LifeosError } from '../application/errors.js';

const MAX_BODY_BYTES = 1024 * 1024;
const M6_TASK_VIEWS = Object.freeze([...TASK_VIEWS, 'done', 'trash']);
const TASK_BASE_KEYS = Object.freeze([
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
const TASK_EXTRA_KEYS = Object.freeze(['listId', 'groupId', 'parentTaskId', 'pinned', 'sortOrder']);
const MAX_LIST_NAME_CHARS = 100;
const MAX_SHORT_TEXT_CHARS = 64;
const MAX_ID_LIST = 500;

/* ───────────────────────── 请求辅助（与 routes.js/routes-m4.js 行为一致） ───────────────────────── */

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    const body = req.body;
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body)) return body.toString('utf8');
    return body;
  }
  if (!req || typeof req.on !== 'function') return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new LifeosError('bad_request', '请求体过大');
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function parseJsonBody(req) {
  const raw = await readBody(req);
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed === null || parsed === undefined ? {} : parsed;
  } catch {
    throw new LifeosError('bad_request', 'body 不是合法 JSON');
  }
}

function validated(result, label) {
  if (!result || result.ok !== true) {
    const errors = Array.isArray(result?.errors) && result.errors.length > 0
      ? result.errors
      : [`${label}参数不合法`];
    throw new LifeosError('validation_failed', `${label}参数不合法`, { errors });
  }
  return result.value;
}

function requiredRev(req, body) {
  const parsed = parseExpectedRev(req, body);
  if (!parsed.ok) {
    throw new LifeosError('validation_failed', '缺少或非法 CAS 版本', { errors: parsed.errors });
  }
  return parsed.value.expectedRev;
}

function optionalRev(req, body, url) {
  const parsed = parseOptionalExpectedRev(req, body, url);
  if (!parsed.ok) {
    throw new LifeosError('validation_failed', '非法 CAS 版本', { errors: parsed.errors });
  }
  return parsed.value.expectedRev;
}

function requireService(service, name, label) {
  if (!service || typeof service[name] !== 'function') {
    throw new LifeosError('store_unavailable', `${label}服务未就绪（缺少 ${name}）`);
  }
  return (...args) => service[name](...args);
}

function okValue(value) {
  return { ok: true, value };
}

function failValue(errors) {
  return { ok: false, errors: Array.isArray(errors) ? errors : [String(errors)] };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkPrefixedId(value, prefix, label, errors, { allowNull = false } = {}) {
  if (value === null && allowNull) return null;
  if (typeof value !== 'string' || !isEntityId(value) || !value.startsWith(prefix)) {
    errors.push(`${label} 必须是 ${prefix} 开头的 ID`);
    return null;
  }
  return value;
}

function validatePrefixedId(id, prefix, label) {
  if (!isEntityId(id) || !String(id).startsWith(prefix)) {
    throw new LifeosError('validation_failed', `${label} ID 非法`, { errors: [`${label} ID 必须以 ${prefix} 开头`] });
  }
  return id;
}

/** 重排请求：ids 非空唯一数组；expectedRevs 可选 {id:rev}。 */
function validateReorderBody(body, label, prefix) {
  if (!isPlainObject(body)) return failValue([`${label}请求体必须是对象`]);
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0) return failValue(['ids 必须是非空数组']);
  if (ids.length > MAX_ID_LIST) return failValue([`ids 最多 ${MAX_ID_LIST} 项`]);
  const errors = [];
  const seen = new Set();
  const normalized = [];
  for (const raw of ids) {
    if (typeof raw !== 'string' || !isEntityId(raw) || !raw.startsWith(prefix)) {
      errors.push(`ids 含非法 ${label} ID：${raw}`);
      continue;
    }
    if (seen.has(raw)) errors.push(`ids 重复：${raw}`);
    seen.add(raw);
    normalized.push(raw);
  }
  let expectedRevs = null;
  if (body.expectedRevs !== undefined && body.expectedRevs !== null) {
    if (!isPlainObject(body.expectedRevs)) {
      errors.push('expectedRevs 必须是 {id: rev} 对象');
    } else {
      expectedRevs = {};
      for (const [id, rev] of Object.entries(body.expectedRevs)) {
        const n = Number(rev);
        if (!Number.isInteger(n) || n < 1) errors.push(`expectedRevs[${id}] 必须是正整数`);
        else expectedRevs[id] = n;
      }
    }
  }
  if (errors.length > 0) return failValue(errors);
  return okValue({ ids: normalized, expectedRevs });
}

/* ───────────────────────── 清单 / 分组 参数校验 ───────────────────────── */

function normalizeName(value, errors) {
  if (typeof value !== 'string') {
    errors.push('name 必须是字符串');
    return null;
  }
  const name = value.trim();
  if (name.length === 0) {
    errors.push('name 不能为空');
    return null;
  }
  if (name.length > MAX_LIST_NAME_CHARS) {
    errors.push(`name ≤ ${MAX_LIST_NAME_CHARS} 字符`);
    return null;
  }
  return name;
}

function normalizeShortText(value, label, errors) {
  if (value === null) return null;
  if (typeof value !== 'string') {
    errors.push(`${label} 必须是字符串或 null`);
    return null;
  }
  const text = value.trim();
  if (text.length > MAX_SHORT_TEXT_CHARS) {
    errors.push(`${label} ≤ ${MAX_SHORT_TEXT_CHARS} 字符`);
    return null;
  }
  return text.length === 0 ? null : text;
}

function normalizeSortOrder(value, errors) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 1000000000) {
    errors.push('sortOrder 必须是 0..1000000000 的整数');
    return undefined;
  }
  return n;
}

function validateListCreateBody(body) {
  if (!isPlainObject(body)) return failValue(['请求体必须是对象']);
  const errors = [];
  const name = normalizeName(body.name, errors);
  const color = body.color === undefined ? null : normalizeShortText(body.color, 'color', errors);
  const icon = body.icon === undefined ? null : normalizeShortText(body.icon, 'icon', errors);
  const sortOrder = normalizeSortOrder(body.sortOrder, errors);
  if (errors.length > 0) return failValue(errors);
  const value = { name, color, icon };
  if (sortOrder !== undefined) value.sortOrder = sortOrder;
  return okValue(value);
}

function validateListPatchBody(body) {
  if (!isPlainObject(body)) return failValue(['请求体必须是对象']);
  const errors = [];
  const value = {};
  if (Object.prototype.hasOwnProperty.call(body, 'name')) value.name = normalizeName(body.name, errors);
  if (Object.prototype.hasOwnProperty.call(body, 'color')) value.color = normalizeShortText(body.color, 'color', errors);
  if (Object.prototype.hasOwnProperty.call(body, 'icon')) value.icon = normalizeShortText(body.icon, 'icon', errors);
  if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) value.sortOrder = normalizeSortOrder(body.sortOrder, errors);
  if (Object.keys(value).length === 0) errors.push('至少提供一个可更新字段（name/color/icon/sortOrder）');
  if (errors.length > 0) return failValue(errors);
  return okValue(value);
}

function validateGroupCreateBody(body) {
  if (!isPlainObject(body)) return failValue(['请求体必须是对象']);
  const errors = [];
  const name = normalizeName(body.name, errors);
  const color = body.color === undefined ? null : normalizeShortText(body.color, 'color', errors);
  const sortOrder = normalizeSortOrder(body.sortOrder, errors);
  let collapsed = false;
  if (body.collapsed !== undefined) {
    if (typeof body.collapsed !== 'boolean') errors.push('collapsed 必须是布尔值');
    else collapsed = body.collapsed;
  }
  if (errors.length > 0) return failValue(errors);
  const value = { name, color, collapsed };
  if (sortOrder !== undefined) value.sortOrder = sortOrder;
  return okValue(value);
}

function validateGroupPatchBody(body) {
  if (!isPlainObject(body)) return failValue(['请求体必须是对象']);
  const errors = [];
  const value = {};
  if (Object.prototype.hasOwnProperty.call(body, 'name')) value.name = normalizeName(body.name, errors);
  if (Object.prototype.hasOwnProperty.call(body, 'color')) value.color = normalizeShortText(body.color, 'color', errors);
  if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) value.sortOrder = normalizeSortOrder(body.sortOrder, errors);
  if (Object.prototype.hasOwnProperty.call(body, 'collapsed')) {
    if (typeof body.collapsed !== 'boolean') errors.push('collapsed 必须是布尔值');
    else value.collapsed = body.collapsed;
  }
  if (Object.keys(value).length === 0) errors.push('至少提供一个可更新字段（name/color/collapsed/sortOrder）');
  if (errors.length > 0) return failValue(errors);
  return okValue(value);
}

/* ───────────────────────── 任务参数校验（M6 超集） ───────────────────────── */

function validateTaskExtras(body, errors) {
  const value = {};
  if (Object.prototype.hasOwnProperty.call(body, 'listId')) {
    value.listId = body.listId === null ? null : checkPrefixedId(body.listId, 'lst_', 'listId', errors, { allowNull: true });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'groupId')) {
    value.groupId = body.groupId === null ? null : checkPrefixedId(body.groupId, 'grp_', 'groupId', errors, { allowNull: true });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'parentTaskId')) {
    value.parentTaskId = body.parentTaskId === null
      ? null
      : checkPrefixedId(body.parentTaskId, 'tsk_', 'parentTaskId', errors, { allowNull: true });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'pinned')) {
    if (typeof body.pinned !== 'boolean') errors.push('pinned 必须是布尔值');
    else value.pinned = body.pinned;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) {
    value.sortOrder = normalizeSortOrder(body.sortOrder, errors);
  }
  return value;
}

function validateM6TaskCreateBody(body) {
  if (!isPlainObject(body)) return failValue(['请求体必须是对象']);
  const base = {};
  for (const key of TASK_BASE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) base[key] = body[key];
  }
  const baseResult = validateCreateTask(base);
  if (!baseResult.ok) return baseResult;
  const errors = [];
  const extras = validateTaskExtras(body, errors);
  if (errors.length > 0) return failValue(errors);
  return okValue({ ...baseResult.value, ...extras });
}

function validateM6TaskUpdateBody(body) {
  if (!isPlainObject(body)) return failValue(['请求体必须是对象']);
  const allowed = new Set([...TASK_BASE_KEYS, ...TASK_EXTRA_KEYS, 'expectedRev', 'idempotencyKey']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return failValue([`未知字段：${unknown.join(', ')}`]);
  const base = {};
  for (const key of TASK_BASE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) base[key] = body[key];
  }
  let baseValue = {};
  const baseKeys = Object.keys(base);
  if (baseKeys.length > 0) {
    const baseResult = validateUpdateTask(base);
    if (!baseResult.ok) return baseResult;
    baseValue = baseResult.value;
  }
  const errors = [];
  const extras = validateTaskExtras(body, errors);
  if (errors.length > 0) return failValue(errors);
  const merged = { ...baseValue, ...extras };
  if (Object.keys(merged).length === 0) {
    return failValue(['至少提供一个可更新字段']);
  }
  return okValue(merged);
}

function validateM6TaskListQuery(params) {
  const errors = [];
  const out = {
    view: 'all',
    projectId: null,
    tagId: null,
    listId: null,
    groupId: null,
    q: null,
    from: null,
    to: null,
    limit: DEFAULT_LIMIT,
    cursor: null,
  };
  const view = params.get('view');
  if (view !== null && view !== '') {
    if (!M6_TASK_VIEWS.includes(view)) errors.push(`view 必须是 ${M6_TASK_VIEWS.join('|')}`);
    else out.view = view;
  }
  const ids = [
    ['projectId', 'prj_', '项目 ID'],
    ['tagId', 'tag_', '标签 ID'],
    ['listId', 'lst_', '清单 ID'],
    ['groupId', 'grp_', '分组 ID'],
  ];
  for (const [key, prefix, label] of ids) {
    const raw = params.get(key);
    if (raw === null || raw === '') continue;
    if (!isEntityId(raw) || !raw.startsWith(prefix)) errors.push(`${label}必须是 ${prefix} 开头`);
    else out[key] = raw;
  }
  const q = params.get('q');
  if (q !== null && q !== '') {
    if (q.length > 200) errors.push('q ≤ 200 字符');
    else out.q = q;
  }
  const from = params.get('from');
  if (from !== null && from !== '') {
    if (!isLocalDate(from)) errors.push('from 必须是 YYYY-MM-DD');
    else out.from = from;
  }
  const to = params.get('to');
  if (to !== null && to !== '') {
    if (!isLocalDate(to)) errors.push('to 必须是 YYYY-MM-DD');
    else out.to = to;
  }
  if (out.from && out.to && out.from > out.to) errors.push('from 不能晚于 to');
  const limitRaw = params.get('limit');
  if (limitRaw !== null && limitRaw !== '') {
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) errors.push(`limit 必须是 1..${MAX_LIMIT} 整数`);
    else out.limit = limit;
  }
  const cursor = params.get('cursor');
  if (cursor !== null && cursor !== '') {
    if (cursor.length > 64) errors.push('cursor ≤ 64 字符');
    else out.cursor = cursor;
  }
  if (errors.length > 0) return failValue(errors);
  return okValue(out);
}

function validateMoveTaskBody(body) {
  if (!isPlainObject(body)) return failValue(['请求体必须是对象']);
  const errors = [];
  const value = {};
  for (const [key, prefix, label] of [
    ['listId', 'lst_', 'listId'],
    ['groupId', 'grp_', 'groupId'],
    ['parentTaskId', 'tsk_', 'parentTaskId'],
  ]) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      value[key] = body[key] === null ? null : checkPrefixedId(body[key], prefix, label, errors, { allowNull: true });
    }
  }
  if (Object.keys(value).length === 0) errors.push('至少提供 listId/groupId/parentTaskId 之一');
  if (errors.length > 0) return failValue(errors);
  return okValue(value);
}

function validateDuplicateTaskBody(body) {
  if (!isPlainObject(body)) return failValue(['请求体必须是对象']);
  const errors = [];
  const value = {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim().length === 0) {
      errors.push('title 必须是非空字符串');
    } else {
      value.title = body.title.trim();
    }
  }
  if (errors.length > 0) return failValue(errors);
  return okValue(value);
}

/* ───────────────────────── 日历参数校验（M6 扩展） ───────────────────────── */

function dayDiff(from, to) {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return NaN;
  return Math.floor((toMs - fromMs) / 86400000) + 1;
}

function lastDayOfMonth(month) {
  const [year, mon] = month.split('-').map(Number);
  const day = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

function validateM6CalendarQuery(params) {
  const errors = [];
  const fromRaw = params.get('from');
  const toRaw = params.get('to');
  const monthRaw = params.get('month');
  let from = null;
  let to = null;
  let month = null;
  if ((fromRaw !== null && fromRaw !== '') || (toRaw !== null && toRaw !== '')) {
    if (fromRaw === null || fromRaw === '' || toRaw === null || toRaw === '') {
      errors.push('from 与 to 必须同时提供');
    } else if (!isLocalDate(fromRaw) || !isLocalDate(toRaw)) {
      errors.push('from/to 必须是 YYYY-MM-DD');
    } else {
      from = fromRaw;
      to = toRaw;
    }
  } else if (monthRaw !== null && monthRaw !== '') {
    const parsed = parseMonth(monthRaw);
    if (!parsed.ok) return parsed;
    month = parsed.value;
    from = `${month}-01`;
    to = lastDayOfMonth(month);
  } else {
    errors.push('必须提供 from/to 或 month');
  }
  if (from && to && !errors.includes('from/to 必须是 YYYY-MM-DD')) {
    const days = dayDiff(from, to);
    if (!Number.isInteger(days) || days < 1) {
      errors.push('日期区间非法');
    } else if (days > MAX_CALENDAR_DAYS) {
      errors.push(`日期区间最多 ${MAX_CALENDAR_DAYS} 天`);
    } else if (from > to) {
      errors.push('from 不能晚于 to');
    }
  }
  if (errors.length > 0) return failValue(errors);
  return okValue({ from, to, month });
}

/* ───────────────────────── 笔记标签参数校验 ───────────────────────── */

function validateNotesTagMap(map) {
  const errors = [];
  if (!isPlainObject(map)) return { errors: ['tags 必须是 {路径: [标签]} 对象'], tags: null };
  const tags = {};
  for (const [rawPath, rawTags] of Object.entries(map)) {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0 || rawPath.length > 1024) {
      errors.push('tags 的路径必须是非空字符串（≤1024）');
      continue;
    }
    if (!Array.isArray(rawTags)) {
      errors.push(`tags["${rawPath}"] 必须是数组`);
      continue;
    }
    const list = [];
    for (const raw of rawTags) {
      if (typeof raw !== 'string' || raw.trim().length === 0 || raw.trim().length > 50) {
        errors.push(`tags["${rawPath}"] 含非法标签（非空字符串 ≤50）`);
        continue;
      }
      list.push(raw.trim());
    }
    if (new Set(list).size !== list.length) errors.push(`tags["${rawPath}"] 含重复标签`);
    if (list.length > 32) errors.push(`tags["${rawPath}"] 最多 32 个标签`);
    if (list.length > 0) tags[rawPath.trim()] = list;
  }
  return { errors, tags };
}

function validateNotesTagsPutBody(body) {
  if (!isPlainObject(body)) return failValue(['请求体必须是对象']);
  const { errors, tags } = validateNotesTagMap(body.tags);
  if (!isPlainObject(body.tags) || tags === null) errors.push('tags 必填');
  if (errors.length > 0) return failValue(errors);
  const value = { tags };
  if (body.expectedRev !== undefined) value.expectedRev = body.expectedRev;
  if (body.idempotencyKey !== undefined) value.idempotencyKey = body.idempotencyKey;
  return okValue(value);
}

function validateNotesTagsBatchBody(body) {
  if (!isPlainObject(body)) return failValue(['请求体必须是对象']);
  const errors = [];
  const updates = [];
  const removePaths = [];
  if (body.updates !== undefined) {
    if (!Array.isArray(body.updates)) {
      errors.push('updates 必须是数组');
    } else {
      for (const item of body.updates) {
        if (!isPlainObject(item)) {
          errors.push('updates 项必须是 {path, tags}');
          continue;
        }
        if (typeof item.path !== 'string' || item.path.trim().length === 0 || item.path.length > 1024) {
          errors.push('updates[].path 必须是非空字符串（≤1024）');
          continue;
        }
        const { errors: tagErrors, tags } = validateNotesTagMap({ [item.path]: item.tags });
        if (tagErrors.length > 0) {
          errors.push(...tagErrors);
          continue;
        }
        updates.push({ path: item.path.trim(), tags: tags[item.path.trim()] ?? [] });
      }
    }
  }
  if (body.removePaths !== undefined) {
    if (!Array.isArray(body.removePaths)) {
      errors.push('removePaths 必须是数组');
    } else {
      for (const raw of body.removePaths) {
        if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > 1024) {
          errors.push('removePaths 项必须是非空字符串（≤1024）');
          continue;
        }
        removePaths.push(raw.trim());
      }
    }
  }
  if (updates.length === 0 && removePaths.length === 0) errors.push('至少提供 updates 或 removePaths');
  const value = { updates, removePaths };
  if (body.expectedRev !== undefined) value.expectedRev = body.expectedRev;
  return errors.length > 0 ? failValue(errors) : okValue(value);
}

/* ───────────────────────── 路由表 ───────────────────────── */

export function buildM6Routes(deps) {
  const { service } = deps;

  return [
    /* ── 清单 ─────────────────────────────────────────── */
    {
      method: 'GET',
      pattern: '/lists',
      handler: async () => requireService(service, 'listLists', '清单')(),
    },
    {
      method: 'POST',
      pattern: '/lists',
      handler: async (ctx) => {
        const body = await parseJsonBody(ctx.req);
        const input = validated(validateListCreateBody(body), 'body');
        return service.createList(input);
      },
    },
    {
      method: 'POST',
      pattern: '/lists/reorder',
      handler: async (ctx) => {
        const body = await parseJsonBody(ctx.req);
        const input = validated(validateReorderBody(body, '清单', 'lst_'), 'body');
        return service.reorderLists(input);
      },
    },
    {
      method: 'PATCH',
      pattern: '/lists/:id',
      handler: async (ctx) => {
        const id = validatePrefixedId(ctx.params.id, 'lst_', '清单');
        const body = await parseJsonBody(ctx.req);
        const patchBody = body.patch !== undefined ? body.patch : body;
        const patch = validated(validateListPatchBody(patchBody), 'body');
        const expectedRev = requiredRev(ctx.req, body);
        return service.updateList(id, patch, expectedRev);
      },
    },
    {
      method: 'DELETE',
      pattern: '/lists/:id',
      handler: async (ctx) => {
        const id = validatePrefixedId(ctx.params.id, 'lst_', '清单');
        const moveToRaw = ctx.url.searchParams.get('moveTo');
        const moveTo = moveToRaw === null || moveToRaw === '' ? null : validatePrefixedId(moveToRaw, 'lst_', '目标清单');
        const expectedRev = optionalRev(ctx.req, null, ctx.url);
        return service.deleteList(id, { moveTo, expectedRev });
      },
    },
    /* ── 分组 ─────────────────────────────────────────── */
    {
      method: 'GET',
      pattern: '/lists/:id/groups',
      handler: async (ctx) => {
        const id = validatePrefixedId(ctx.params.id, 'lst_', '清单');
        return service.getListGroups(id);
      },
    },
    {
      method: 'POST',
      pattern: '/lists/:id/groups',
      handler: async (ctx) => {
        const id = validatePrefixedId(ctx.params.id, 'lst_', '清单');
        const body = await parseJsonBody(ctx.req);
        const input = validated(validateGroupCreateBody(body), 'body');
        return service.createGroup(id, input);
      },
    },
    {
      method: 'POST',
      pattern: '/groups/reorder',
      handler: async (ctx) => {
        const body = await parseJsonBody(ctx.req);
        const input = validated(validateReorderBody(body, '分组', 'grp_'), 'body');
        return service.reorderGroups(input);
      },
    },
    {
      method: 'PATCH',
      pattern: '/groups/:id',
      handler: async (ctx) => {
        const id = validatePrefixedId(ctx.params.id, 'grp_', '分组');
        const body = await parseJsonBody(ctx.req);
        const patchBody = body.patch !== undefined ? body.patch : body;
        const patch = validated(validateGroupPatchBody(patchBody), 'body');
        const expectedRev = requiredRev(ctx.req, body);
        return service.updateGroup(id, patch, expectedRev);
      },
    },
    {
      method: 'DELETE',
      pattern: '/groups/:id',
      handler: async (ctx) => {
        const id = validatePrefixedId(ctx.params.id, 'grp_', '分组');
        const moveToRaw = ctx.url.searchParams.get('moveTo');
        const moveTo = moveToRaw === null || moveToRaw === '' ? null : validatePrefixedId(moveToRaw, 'grp_', '目标分组');
        const expectedRev = optionalRev(ctx.req, null, ctx.url);
        return service.deleteGroup(id, { moveTo, expectedRev });
      },
    },
    /* ── 任务补充 ─────────────────────────────────────── */
    {
      method: 'POST',
      pattern: '/tasks/:id/move',
      handler: async (ctx) => {
        const id = validatePrefixedId(ctx.params.id, 'tsk_', '任务');
        const body = await parseJsonBody(ctx.req);
        const input = validated(validateMoveTaskBody(body), 'body');
        const expectedRev = requiredRev(ctx.req, body);
        return service.moveTask(id, input, expectedRev);
      },
    },
    {
      method: 'POST',
      pattern: '/tasks/:id/duplicate',
      handler: async (ctx) => {
        const id = validatePrefixedId(ctx.params.id, 'tsk_', '任务');
        const body = await parseJsonBody(ctx.req);
        const input = validated(validateDuplicateTaskBody(body), 'body');
        return service.duplicateTask(id, input);
      },
    },
    {
      method: 'POST',
      pattern: '/tasks/:id/restore',
      handler: async (ctx) => {
        const id = validatePrefixedId(ctx.params.id, 'tsk_', '任务');
        const body = await parseJsonBody(ctx.req);
        const expectedRev = requiredRev(ctx.req, body);
        return service.restoreTask(id, expectedRev);
      },
    },
    {
      method: 'DELETE',
      pattern: '/tasks/:id',
      handler: async (ctx) => {
        const id = validatePrefixedId(ctx.params.id, 'tsk_', '任务');
        const purgeRaw = ctx.url.searchParams.get('purge');
        const purge = purgeRaw === '1' || purgeRaw === 'true';
        const expectedRev = optionalRev(ctx.req, null, ctx.url);
        return service.deleteTask(id, { purge, expectedRev });
      },
    },
    /* ── 笔记标签 ─────────────────────────────────────── */
    {
      method: 'GET',
      pattern: '/notes/tags',
      handler: async () => requireService(service, 'getNotesTags', '笔记标签')(),
    },
    {
      method: 'PUT',
      pattern: '/notes/tags',
      handler: async (ctx) => {
        const body = await parseJsonBody(ctx.req);
        const input = validated(validateNotesTagsPutBody(body), 'body');
        const expectedRev = optionalRev(ctx.req, body, ctx.url);
        return service.putNotesTags({ ...input, expectedRev });
      },
    },
    {
      method: 'POST',
      pattern: '/notes/tags/batch',
      handler: async (ctx) => {
        const body = await parseJsonBody(ctx.req);
        const input = validated(validateNotesTagsBatchBody(body), 'body');
        const expectedRev = optionalRev(ctx.req, body, ctx.url);
        return service.batchNotesTags({ ...input, expectedRev });
      },
    },
  ];
}

export default buildM6Routes;

export {
  validateM6CalendarQuery,
  validateM6TaskCreateBody,
  validateM6TaskListQuery,
  validateM6TaskUpdateBody,
};
