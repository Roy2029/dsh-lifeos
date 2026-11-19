/**
 * B：HTTP 路由（M0 v0.1 + M1 v0.2 增量）。
 *
 * - 唯一注册点：`ctx.webServer.register({kind:'prefix', path:'/api/lifeos', handler})`
 * - 统一信封 {ok:true,value} / {ok:false,error:{code,message,details?}}；响应头 X-LifeOS-Api: 0.2
 * - 鉴权：优先 ctx.connection.requestRejection；不可用时回退 host/origin 同源校验
 * - CAS：写请求接受 If-Match 头或 body.expectedRev（contract.parseExpectedRev）
 * - 直调测试：createRoutes().handle(fakeReq,fakeRes)，不真起 HTTP
 *
 * M0 端点全部保留（health/bootstrap/capture/query/dev 子路由/events）；M1 新增 §3 端点表。
 */

import {
  API_HEADER,
  ERROR_CODE_LIST,
  API_PREFIX,
  API_VERSION,
  err,
  errorStatus,
  ok,
  parseExpectedRev,
  parseOptionalExpectedRev,
  responseHeaders,
  validateCapture,
  validateCreateTag,
  validateTagId,
  validateUpdateTag,
  validateQuery,
  validateReschedule,
  validateTaskId,
  validateUiPrefs,
  validateTriageRun,
  validateTriageApply,
  validateTriageReprocess,
  validateTriageCorrect,
  validateRunId,
  validateAutomationPatch,
  validateNotesConfig,
  validateNotesTreeQuery,
  validateNotesFileQuery,
  validateNotesWrite,
  validateNotesCreate,
  validateNotesRename,
  validateNotesRemove,
  validateNotesSearchQuery,
  validateNotesSnapshot,
  validateNotesFolder,
  validateAutomationSettingsPatch,
  validateSuggestionAct,
  validateSuggestionQuery,
  validateNotificationsQuery,
  validateSuggestionId,
  validateNotificationId,
} from '../client-shared/contract.js';
import { LifeosError } from '../application/errors.js';
import { buildM4Routes } from './routes-m4.js';
import {
  buildM6Routes,
  validateM6CalendarQuery,
  validateM6TaskCreateBody,
  validateM6TaskUpdateBody,
  validateM6TaskListQuery,
} from './routes-m6.js';

const MAX_BODY_BYTES = 1024 * 1024;
const ERROR_CODES_KEYS = new Set(ERROR_CODE_LIST);

function asHeaders(res, extra) {
  if (!res || typeof res.setHeader !== 'function') return;
  const headers = { ...responseHeaders(), [API_HEADER]: API_VERSION, ...(extra || {}) };
  for (const [key, value] of Object.entries(headers)) {
    try {
      res.setHeader(key, value);
    } catch {
      /* ignore */
    }
  }
}

export function sendJson(res, statusCode, envelope) {
  const body = JSON.stringify(envelope);
  asHeaders(res, { 'content-length': Buffer.byteLength(body) });
  try {
    if (typeof res.writeHead === 'function') res.writeHead(statusCode);
    else res.statusCode = statusCode;
  } catch {
    /* ignore */
  }
  try {
    if (typeof res.end === 'function') res.end(body);
  } catch {
    /* ignore */
  }
}

function allowMethods(res) {
  if (res && typeof res.setHeader === 'function') {
    try {
      res.setHeader('allow', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      res.setHeader(
        'access-control-allow-headers',
        `content-type, last-event-id, if-match, ${API_HEADER}`,
      );
    } catch {
      /* ignore */
    }
  }
}

/** host 头是否 loopback（M0 只允许本机） */
export function isLoopbackHostHeader(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const lower = value.trim().toLowerCase();
  let hostname = lower;
  if (lower.startsWith('[')) {
    const end = lower.indexOf(']');
    if (end < 0) return false;
    hostname = lower.slice(0, end + 1);
  } else {
    hostname = lower.split(':')[0];
  }
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

function readHeader(req, name) {
  const headers = req && req.headers ? req.headers : {};
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/** 回退鉴权：host/origin 同源。返回 null=通过，否则返回错误信封 */
export function fallbackAuth(req) {
  const host = readHeader(req, 'host');
  if (!isLoopbackHostHeader(host)) return err('unauthorized', '仅允许本机 loopback 请求');
  const origin = readHeader(req, 'origin');
  if (origin !== undefined && origin !== null && origin !== '') {
    let parsed;
    try {
      parsed = new URL(String(origin));
    } catch {
      return err('unauthorized', 'origin 非法');
    }
    if (!isLoopbackHostHeader(parsed.host)) return err('unauthorized', '仅允许同源请求');
  }
  return null;
}

function readBody(req) {
  if (req && req.body !== undefined) return Promise.resolve(req.body);
  if (!req || typeof req.on !== 'function') return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new LifeosError('bad_request', `请求体超过 ${MAX_BODY_BYTES} 字节`));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!failed) reject(error);
    });
  });
}

async function parseJsonBody(req) {
  const body = await readBody(req);
  if (body === null || body === undefined || body === '') return {};
  if (typeof body === 'object') return body;
  try {
    return JSON.parse(String(body));
  } catch {
    throw new LifeosError('bad_request', 'body 不是合法 JSON');
  }
}

const NOTE_ERROR_ALIASES = Object.freeze({
  PATH_FORBIDDEN: 'path_forbidden',
  INVALID_PATH: 'path_forbidden',
  PATH_ESCAPE: 'path_forbidden',
  FILE_TOO_LARGE: 'file_too_large',
  NOT_FOUND: 'not_found',
  ENOENT: 'not_found',
  CONFLICT: 'conflict',
  PATH_EXISTS: 'path_exists',
  PARENT_NOT_FOUND: 'parent_not_found',
  ENOENT_PARENT: 'parent_not_found',
  EEXIST: 'path_exists',
  EACCES: 'path_forbidden',
  EPERM: 'path_forbidden',
  EISDIR: 'validation_failed',
  ENOTDIR: 'validation_failed',
  NOTES_UNAVAILABLE: 'notes_unavailable',
});

function noteErrorCode(error) {
  const raw = error && typeof error.code === 'string' ? error.code : '';
  if (!raw) return null;
  if (ERROR_CODES_KEYS.has(raw)) return raw;
  if (NOTE_ERROR_ALIASES[raw]) return NOTE_ERROR_ALIASES[raw];
  if (NOTE_ERROR_ALIASES[raw.toUpperCase()]) return NOTE_ERROR_ALIASES[raw.toUpperCase()];
  return null;
}

function errorEnvelope(error) {
  if (error instanceof LifeosError) {
    const alias = noteErrorCode(error);
    return { code: alias || error.code, message: error.message, details: error.details };
  }
  const aliased = noteErrorCode(error);
  if (aliased) {
    const details = error.details !== undefined
      ? error.details
      : error.currentHash !== undefined || error.mtime !== undefined
        ? { currentHash: error.currentHash ?? null, mtime: error.mtime ?? null }
        : undefined;
    return { code: aliased, message: String(error.message || aliased), details };
  }
  if (error && typeof error.code === 'string' && typeof errorStatus(error.code) === 'number') {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { code: 'internal', message: '内部错误' };
}

async function withIdempotency(cache, key, fn) {
  if (!key) return fn();
  if (cache.has(key)) return cache.get(key);
  const promise = Promise.resolve()
    .then(fn)
    .catch((error) => {
      cache.delete(key);
      throw error;
    });
  cache.set(key, promise);
  while (cache.size > 200) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return promise;
}

function requireAutomation(deps) {
  const automation = deps && deps.automation;
  if (!automation) throw new LifeosError('automation_unavailable', '自动化服务未就绪');
  return automation;
}

/** A 的 getSettings()/patchSettings() 返回 {settings, revision, ...} 包装对象；
 *  GET/PUT /automation 的契约是 value = {settings: <扁平设置>, ...元数据}。
 *  这里把 settings 解包成扁平设置本体，同时保留 revision/diff/impacted 等元数据。 */
function flattenSettingsView(view) {
  const source = view && typeof view === 'object' && !Array.isArray(view) ? view : {};
  const nested = source.settings && typeof source.settings === 'object' && !Array.isArray(source.settings)
    ? source.settings
    : null;
  // 兼容双层包装（{settings:{settings:{...}}}）：继续向内解一层。
  const inner = nested && nested.settings && typeof nested.settings === 'object' && !Array.isArray(nested.settings)
    ? nested.settings
    : nested;
  const settings = inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : source;
  return Object.assign({}, source, { settings });
}

function requireSuggestions(deps) {
  const suggestions = deps && deps.suggestions;
  if (!suggestions) throw new LifeosError('suggestion_unavailable', '建议服务未就绪');
  return suggestions;
}

function publishBusEvent(deps, type, data) {
  try {
    if (deps && deps.bus && typeof deps.bus.publish === 'function') deps.bus.publish({ type, data });
  } catch {
    /* SSE 广播失败不影响业务 */
  }
}

function requireNotes(deps) {
  const notes = deps && deps.notes;
  if (!notes) throw new LifeosError('notes_unavailable', '笔记服务未就绪（note-service 未装配）');
  return notes;
}

function validated(result, label) {
  if (result && result.ok) return result.value;
  throw new LifeosError('validation_failed', `${label}参数不合法`, { errors: result?.errors || [`${label}非法`] });
}

function casRev(req, body) {
  const parsed = parseExpectedRev(req, body);
  if (!parsed.ok) throw new LifeosError('validation_failed', '缺少或非法 CAS 版本', { errors: parsed.errors });
  return parsed.value.expectedRev;
}

/**
 * 路由表：[{method, pattern, handler}]。
 * pattern 用 `/tasks/:id/complete` 形式；handler(ctx) 返回值直接进 {ok,value}。
 */
function buildRoutes(deps) {
  const { service, diagnostics, config } = deps;

  // S1（2026-11-18 代码审查）：开发/自检工具必须显式开启后才能访问，
  // 避免正式安装包里任意页面/会话都能清库或读取诊断信息。
  function requireDevAccess() {
    if (config && (config.devMode === true || config.clientSelfCheck === true)) return;
    throw new LifeosError('forbidden', '该接口仅在开发模式（devMode）或客户端自检（clientSelfCheck）开启时可用');
  }

  return [
    // ── M0 保留 ─────────────────────────────────────────────
    {
      method: 'GET',
      pattern: '/health',
      handler: () => ({ status: service.status(), gates: diagnostics?.state?.gates || {}, uptimeMs: deps.uptimeMs() }),
    },
    { method: 'GET', pattern: '/bootstrap', handler: () => service.bootstrap() },
    {
      method: 'POST',
      pattern: '/capture',
      // M0 兼容：直接把原始 body 交给 service 校验/写入（service 内含 validateCapture）
      raw: true,
    },
    {
      method: 'GET',
      pattern: '/query',
      handler: (ctx) => service.query(validated(validateQuery(ctx.url.searchParams), 'query')),
    },
    {
      method: 'POST',
      pattern: '/dev/client-report',
      handler: async (ctx) => {
        const body = await parseJsonBody(ctx.req);
        diagnostics?.clientReport?.(body);
        return { received: true };
      },
    },
    {
      method: 'POST',
      pattern: '/dev/capture-cleanup',
      handler: async (ctx) => {
        requireDevAccess();
        return service.devCleanup(await parseJsonBody(ctx.req));
      },
    },
    {
      method: 'GET',
      pattern: '/dev/status',
      handler: () => {
        requireDevAccess();
        return {
          ...service.status(),
          gates: diagnostics?.state?.gates || {},
          recentErrors: diagnostics?.getErrors?.() || [],
          clientReport: diagnostics?.getClientReport?.() || null,
          sseClients: deps.sse ? deps.sse.clientCount() : 0,
          devMode: config.devMode === true,
          uptimeMs: deps.uptimeMs(),
        };
      },
    },

    // ── M1 任务（M6 扩展：清单/分组/层级/回收站/日历区间）────────
    {
      method: 'GET',
      pattern: '/tasks',
      handler: (ctx) => service.listTasks(validated(validateM6TaskListQuery(ctx.url.searchParams), 'tasks')),
    },
    {
      method: 'POST',
      pattern: '/tasks',
      handler: async (ctx) => {
        const body = await parseJsonBody(ctx.req);
        const input = validated(validateM6TaskCreateBody(body), 'task');
        return service.createTask({ ...input, idempotencyKey: body.idempotencyKey });
      },
    },
    {
      method: 'GET',
      pattern: '/tasks/:id',
      handler: (ctx) => {
        const id = validated(validateTaskId(ctx.params.id), 'id');
        if (typeof service.getTaskDetail === 'function') {
          const detail = service.getTaskDetail(id);
          if (!detail) throw new LifeosError('not_found', `任务不存在：${id}`, { id });
          return { task: detail.task, children: detail.children, path: detail.path };
        }
        const task = service.getTask(id);
        if (!task) throw new LifeosError('not_found', `任务不存在：${id}`, { id });
        return { task, children: [], path: [] };
      },
    },
    {
      method: 'PATCH',
      pattern: '/tasks/:id',
      handler: async (ctx) => {
        const id = validated(validateTaskId(ctx.params.id), 'id');
        const body = await parseJsonBody(ctx.req);
        const patchBody = body.patch !== undefined ? body.patch : body;
        const patch = validated(validateM6TaskUpdateBody(patchBody), 'task');
        const expectedRev = casRev(ctx.req, body);
        return service.updateTask(id, patch, expectedRev);
      },
    },
    {
      method: 'POST',
      pattern: '/tasks/:id/complete',
      handler: async (ctx) => actionRoute(ctx, 'completeTask'),
    },
    {
      method: 'POST',
      pattern: '/tasks/:id/reopen',
      handler: async (ctx) => actionRoute(ctx, 'reopenTask'),
    },
    {
      method: 'POST',
      pattern: '/tasks/:id/cancel',
      handler: async (ctx) => actionRoute(ctx, 'cancelTask'),
    },
    {
      method: 'POST',
      pattern: '/tasks/:id/reschedule',
      handler: async (ctx) => {
        const id = validated(validateTaskId(ctx.params.id), 'id');
        const body = await parseJsonBody(ctx.req);
        const patch = validated(validateReschedule(body), 'reschedule');
        const expectedRev = casRev(ctx.req, body);
        return service.rescheduleTask(id, patch, expectedRev);
      },
    },
    {
      method: 'GET',
      pattern: '/calendar',
      handler: (ctx) => {
        const range = validated(validateM6CalendarQuery(ctx.url.searchParams), 'calendar');
        return service.getCalendar(range.from, range.to);
      },
    },

    // ── M6 清单 / 分组 / 任务补充 / 笔记标签（v0.8）────────────
    ...buildM6Routes({ service, bus: deps.bus }),

    // ── M4 习惯 / 打卡 / 项目 / 目标 / 愿望 / 回顾（v0.7）────────
    ...buildM4Routes({ service, bus: deps.bus }),

    // ── 标签 / 设置 ─────────────────────────────────────────
    { method: 'GET', pattern: '/tags', handler: () => service.listTags() },
    {
      method: 'POST',
      pattern: '/tags',
      handler: async (ctx) => service.createTag(validated(validateCreateTag(await parseJsonBody(ctx.req)), 'tag')),
    },
    {
      method: 'PATCH',
      pattern: '/tags/:id',
      handler: async (ctx) => {
        const id = validated(validateTagId(ctx.params.id), 'tagId');
        const body = await parseJsonBody(ctx.req);
        const patch = validated(validateUpdateTag(body), 'tag');
        const rev = parseOptionalExpectedRev(ctx.req, body, ctx.url);
        if (!rev.ok) throw new LifeosError('validation_failed', '缺少或非法 CAS 版本', { errors: rev.errors });
        return service.updateTag(id, patch, rev.value.expectedRev);
      },
    },
    {
      method: 'DELETE',
      pattern: '/tags/:id',
      handler: async (ctx) => {
        const id = validated(validateTagId(ctx.params.id), 'tagId');
        const body = await parseJsonBody(ctx.req);
        const rev = parseOptionalExpectedRev(ctx.req, body, ctx.url);
        if (!rev.ok) throw new LifeosError('validation_failed', '缺少或非法 CAS 版本', { errors: rev.errors });
        return service.deleteTag(id, rev.value.expectedRev);
      },
    },
    { method: 'GET', pattern: '/ui-prefs', handler: () => service.getUiPrefs() },

    // ── M2 整理（v0.3）──────────────────────────────────────────
    {
      method: 'POST',
      pattern: '/triage/run',
      handler: async (ctx) => service.runTriage(validated(validateTriageRun(await parseJsonBody(ctx.req)), 'triage.run')),
    },
    { method: 'GET', pattern: '/triage/pending', handler: () => service.listTriagePending() },
    {
      method: 'GET',
      pattern: '/triage/runs/:id',
      handler: (ctx) => service.getTriageRun(validated(validateRunId(ctx.params.id), 'runId')),
    },
    {
      method: 'POST',
      pattern: '/triage/apply',
      handler: async (ctx) => service.applyTriage(validated(validateTriageApply(await parseJsonBody(ctx.req)), 'triage.apply')),
    },
    {
      method: 'POST',
      pattern: '/triage/reprocess',
      handler: async (ctx) => service.reprocessRaw(validated(validateTriageReprocess(await parseJsonBody(ctx.req)), 'triage.reprocess').rawRecordId),
    },
    {
      method: 'POST',
      pattern: '/triage/correct',
      handler: async (ctx) => service.correctDerived(validated(validateTriageCorrect(await parseJsonBody(ctx.req)), 'triage.correct')),
    },
    { method: 'GET', pattern: '/triage/status', handler: () => service.triageStatus() },
    { method: 'GET', pattern: '/triage/automation', handler: () => service.getAutomation() },
    {
      method: 'PUT',
      pattern: '/triage/automation',
      handler: async (ctx) => service.setAutomation(validated(validateAutomationPatch(await parseJsonBody(ctx.req)), 'automation')),
    },
    {
      method: 'PUT',
      pattern: '/ui-prefs',
      handler: async (ctx) => service.setUiPrefs(validated(validateUiPrefs(await parseJsonBody(ctx.req)), 'ui-prefs')),
    },
    // ── M2.5 笔记（v0.4）──────────────────────────────────────────
    { method: 'GET', pattern: '/notes/config', handler: () => requireNotes(deps).getConfig() },
    {
      method: 'PUT',
      pattern: '/notes/config',
      handler: async (ctx) => {
        const value = validated(validateNotesConfig(await parseJsonBody(ctx.req), ctx.req.headers), 'notes.config');
        return withIdempotency(deps.noteIdempotency, value.requestId ? `notes.config:${value.requestId}` : null, async () => {
          const notes = requireNotes(deps);
          const input = {};
          if (value.dir !== undefined) input.dir = value.dir;
          if (value.options !== undefined) input.options = value.options;
          if (value.create !== undefined) input.create = value.create;
          const result = await notes.setConfig(input);
          try {
            deps.onNotesConfig?.(result);
          } catch {
            /* 配置回调失败不影响返回 */
          }
          return result;
        });
      },
    },
    {
      method: 'GET',
      pattern: '/notes/tree',
      handler: (ctx) => {
        const query = validated(validateNotesTreeQuery(ctx.url.searchParams), 'notes.tree');
        return requireNotes(deps).list(query);
      },
    },
    {
      method: 'GET',
      pattern: '/notes/file',
      handler: (ctx) => {
        const query = validated(validateNotesFileQuery(ctx.url.searchParams), 'notes.file');
        return requireNotes(deps).read(query);
      },
    },
    {
      method: 'PUT',
      pattern: '/notes/file',
      handler: async (ctx) => {
        const value = validated(validateNotesWrite(await parseJsonBody(ctx.req), ctx.req.headers), 'notes.write');
        return withIdempotency(deps.noteIdempotency, value.requestId ? `notes.write:${value.requestId}` : null, () =>
          requireNotes(deps).write({ path: value.path, content: value.content, baseHash: value.baseHash }),
        );
      },
    },
    {
      method: 'POST',
      pattern: '/notes/file',
      handler: async (ctx) => {
        const value = validated(validateNotesCreate(await parseJsonBody(ctx.req), ctx.req.headers), 'notes.create');
        return withIdempotency(deps.noteIdempotency, value.requestId ? `notes.create:${value.requestId}` : null, () =>
          requireNotes(deps).create({ path: value.path, content: value.content }),
        );
      },
    },
    {
      method: 'POST',
      pattern: '/notes/rename',
      handler: async (ctx) => {
        const value = validated(validateNotesRename(await parseJsonBody(ctx.req), ctx.req.headers), 'notes.rename');
        return withIdempotency(deps.noteIdempotency, value.requestId ? `notes.rename:${value.requestId}` : null, () =>
          requireNotes(deps).rename({ path: value.path, toPath: value.toPath }),
        );
      },
    },
    {
      method: 'POST',
      pattern: '/notes/remove',
      handler: async (ctx) => {
        const value = validated(validateNotesRemove(await parseJsonBody(ctx.req), ctx.req.headers), 'notes.remove');
        return withIdempotency(deps.noteIdempotency, value.requestId ? `notes.remove:${value.requestId}` : null, () =>
          requireNotes(deps).remove({ path: value.path, trash: value.trash, recursive: value.recursive }),
        );
      },
    },
    {
      method: 'POST',
      pattern: '/notes/folder',
      handler: async (ctx) => {
        const value = validated(validateNotesFolder(await parseJsonBody(ctx.req), ctx.req.headers), 'notes.folder');
        return withIdempotency(deps.noteIdempotency, value.requestId ? `notes.folder:${value.requestId}` : null, () => {
          const notes = requireNotes(deps);
          const mkdir = typeof notes.mkdir === 'function' ? notes.mkdir : typeof notes.createFolder === 'function' ? notes.createFolder : notes.makeDirectory;
          if (typeof mkdir !== 'function') {
            throw new LifeosError('notes_unavailable', 'note-service 未提供 mkdir（A 线 M2.6 未就绪）');
          }
          return mkdir.call(notes, { path: value.path, recursive: value.recursive });
        });
      },
    },
    {
      method: 'GET',
      pattern: '/notes/search',
      handler: (ctx) => {
        const query = validated(validateNotesSearchQuery(ctx.url.searchParams), 'notes.search');
        return requireNotes(deps).search(query);
      },
    },
    {
      method: 'GET',
      pattern: '/notes/history',
      handler: (ctx) => {
        const query = validated(validateNotesFileQuery(ctx.url.searchParams), 'notes.history');
        return requireNotes(deps).history({ path: query.path });
      },
    },
    {
      method: 'POST',
      pattern: '/notes/snapshot',
      handler: async (ctx) => {
        const value = validated(validateNotesSnapshot(await parseJsonBody(ctx.req), ctx.req.headers), 'notes.snapshot');
        return withIdempotency(deps.noteIdempotency, value.requestId ? `notes.snapshot:${value.requestId}` : null, () =>
          requireNotes(deps).snapshot({ path: value.path }),
        );
      },
    },
    // ── M3 自动化 / 建议 / 通知（v0.6）────────────────────────────
    {
      method: 'GET',
      pattern: '/automation',
      handler: async () => flattenSettingsView(await requireAutomation(deps).getSettings()),
    },
    {
      method: 'PUT',
      pattern: '/automation',
      handler: async (ctx) => {
        const value = validated(validateAutomationSettingsPatch(await parseJsonBody(ctx.req)), 'automation');
        const automation = requireAutomation(deps);
        const flattened = flattenSettingsView(await automation.patchSettings(value.patch));
        let reconciled = { impacted: [] };
        if (typeof automation.reconcile === 'function') {
          reconciled = (await automation.reconcile()) || { impacted: [] };
        }
        publishBusEvent(deps, 'automation/changed', { settings: flattened.settings, impacted: reconciled.impacted || [] });
        return { settings: flattened.settings, impacted: reconciled.impacted || [] };
      },
    },
    {
      method: 'GET',
      pattern: '/automation/status',
      handler: async () => requireAutomation(deps).getStatus(),
    },
    {
      method: 'POST',
      pattern: '/automation/run',
      handler: async (ctx) => {
        const body = (await parseJsonBody(ctx.req)) || {};
        const key = typeof body.key === 'string' ? body.key : '';
        if (!key) throw new LifeosError('validation_failed', '缺少 routine key');
        const automation = requireAutomation(deps);
        if (typeof automation.runRoutine !== 'function') {
          throw new LifeosError('automation_unavailable', '手动运行未就绪');
        }
        const value = await automation.runRoutine(key);
        if (value.status === 'invalid') {
          throw new LifeosError('validation_failed', `未知 routine key：${key}`, {
            allowed: ['morningBrief', 'eveningReview', 'habitNudge', 'nightlyInbox'],
          });
        }
        if (value.status === 'unavailable') {
          throw new LifeosError('automation_unavailable', '宿主 schedule.run 不可用');
        }
        publishBusEvent(deps, 'automation/changed', { run: key, status: value.status });
        return value;
      },
    },
    {
      method: 'GET',
      pattern: '/suggestions',
      handler: (ctx) => {
        const query = validated(validateSuggestionQuery(ctx.url.searchParams), 'suggestions');
        return requireSuggestions(deps).list(query);
      },
    },
    {
      method: 'POST',
      pattern: '/suggestions/:id/act',
      handler: async (ctx) => {
        const id = validated(validateSuggestionId(ctx.params.id), 'suggestionId').id;
        const value = validated(validateSuggestionAct(await parseJsonBody(ctx.req)), 'suggestionAct');
        const result = await requireSuggestions(deps).act(id, value);
        publishBusEvent(deps, 'suggestion', { action: value.action, suggestion: result.suggestion });
        return result;
      },
    },
    {
      method: 'GET',
      pattern: '/notifications',
      handler: (ctx) => {
        const query = validated(validateNotificationsQuery(ctx.url.searchParams), 'notifications');
        return requireSuggestions(deps).listNotifications(query);
      },
    },
    {
      method: 'POST',
      pattern: '/notifications/:id/read',
      handler: async (ctx) => {
        const id = validated(validateNotificationId(ctx.params.id), 'notificationId').id;
        const result = await requireSuggestions(deps).markRead(id);
        publishBusEvent(deps, 'notification', { action: 'read', notification: result });
        return result;
      },
    },
  ];

  async function actionRoute(ctx, method) {
    const id = validated(validateTaskId(ctx.params.id), 'id');
    let body = {};
    try {
      body = await parseJsonBody(ctx.req);
    } catch {
      body = {};
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    const expectedRev = casRev(ctx.req, body);
    return service[method](id, expectedRev);
  }
}

/** 匹配 pattern（支持 :param） */
function matchPattern(pattern, pathname) {
  if (!pattern.includes(':')) return pattern === pathname ? {} : null;
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const patternPart = patternParts[i];
    const pathPart = pathParts[i];
    if (patternPart.startsWith(':')) {
      if (!pathPart) return null;
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
    } else if (patternPart !== pathPart) {
      return null;
    }
  }
  return params;
}

/**
 * @param {object} deps
 * @param {object} deps.service createLifeosService()
 * @param {object} [deps.diagnostics]
 * @param {object} [deps.sse] createSseServer()
 * @param {object} [deps.config]
 * @param {object} [deps.connection] ctx.get('connection')
 * @param {string} [deps.apiPrefix]
 * @param {()=>number} [deps.now]
 */
export function createRoutes(deps) {
  const service = deps.service;
  const diagnostics = deps.diagnostics || null;
  const sse = deps.sse || null;
  const config = deps.config || {};
  const connection = deps.connection || null;
  const apiPrefix = deps.apiPrefix || API_PREFIX;
  const noteIdempotency = new Map();
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const startedAt = now();
  const routes = buildRoutes({ ...deps, noteIdempotency, uptimeMs: () => now() - startedAt });

  function authorize(req) {
    if (connection && typeof connection.requestRejection === 'function') {
      try {
        const rejection = connection.requestRejection(req);
        if (rejection !== undefined && rejection !== null && rejection !== false) {
          return err('forbidden', '请求未通过连接层校验');
        }
        return null;
      } catch (error) {
        diagnostics?.recordError?.('internal', `connection 校验异常：${error?.message || error}`);
        return err('forbidden', '请求校验失败');
      }
    }
    return fallbackAuth(req);
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req && req.url ? req.url : '/', 'http://127.0.0.1');
    } catch {
      url = new URL('/', 'http://127.0.0.1');
    }
    allowMethods(res);

    if (req && req.method === 'OPTIONS') {
      try {
        res.statusCode = 204;
        if (typeof res.end === 'function') res.end();
      } catch {
        /* ignore */
      }
      return;
    }

    const rejection = authorize(req);
    if (rejection) {
      sendJson(res, errorStatus(rejection.error.code), rejection);
      return;
    }

    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (!pathname.startsWith(apiPrefix)) {
      sendJson(res, 404, err('not_found', `未知路径：${pathname}`));
      return;
    }
    const relative = pathname.slice(apiPrefix.length) || '/';

    // SSE：/events（GET，长连接，生命周期由 sse 模块接管）
    if (relative === '/events' && req.method === 'GET') {
      if (!sse) {
        sendJson(res, 503, err('store_unavailable', 'SSE 不可用'));
        return;
      }
      sse.handle(req, res);
      return;
    }

    const method = (req.method || 'GET').toUpperCase();
    let matched = null;
    let params = null;
    for (const route of routes) {
      if (route.method !== method) continue;
      const result = matchPattern(route.pattern, relative);
      if (result !== null) {
        matched = route;
        params = result;
        break;
      }
    }
    if (!matched) {
      sendJson(res, 404, err('not_found', `未知端点：${method} ${relative}`));
      return;
    }

    try {
      const handlerCtx = { req, res, url, params, method };
      let value;
      if (matched.raw) {
        // M0 capture：保持原行为，直接把原始 body 交给 service 校验
        const body = await parseJsonBody(req);
        value = await service.capture(body);
      } else {
        value = await matched.handler(handlerCtx);
      }
      sendJson(res, 200, ok(value));
    } catch (error) {
      const envelopeError = errorEnvelope(error);
      const status = errorStatus(envelopeError.code);
      if (status >= 500 || envelopeError.code === 'internal') {
        diagnostics?.recordError?.(envelopeError.code, envelopeError.message);
      }
      sendJson(res, status, { ok: false, error: envelopeError });
    }
  }

  return {
    handle,
    authorize,
    routes,
    apiPrefix,
    get routeKeys() {
      return [...routes.map((route) => `${route.method} ${route.pattern}`), 'GET /events'];
    },
  };
}

/** 在真实 Cordis 上下文里注册；返回 disposer（由调用方用 ctx.effect 持有） */
export function registerHostRoutes(ctx, deps) {
  const routes = createRoutes(deps);
  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: deps.apiPrefix || API_PREFIX,
    handler: routes.handle,
  });
  return { routes, dispose };
}

/** 供 index.js / 测试使用（M0 兼容保留） */
export { errorEnvelope };
