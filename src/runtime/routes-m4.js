/**
 * M4 HTTP 路由（v0.7）：习惯 / 打卡 / 项目 / 目标 / 愿望 / 回顾。
 *
 * 设计说明：
 * - 本模块只负责 HTTP 层：解析/校验请求、调用 lifeos-service facade、归一化响应为
 *   PLAN §4 规定的 flat value 形状、写成功后发布 SSE changed 事件。
 * - 为了不和 routes.js 形成循环 import，这里保留 parseJsonBody/validated/CAS 解析的
 *   极小本地副本（与 routes.js 行为一致）。
 * - buildM4Routes(deps) 返回 [{method,pattern,handler}]，由 routes.js 按顺序聚合；数组
 *   顺序即匹配顺序，因此 /habits/stats、/habits/month 必须排在 /habits/:id 之前。
 */
import {
  parseExpectedRev,
  parseOptionalExpectedRev,
  validateCheckin,
  validateCheckinQuery,
  validateGoalCreate,
  validateGoalId,
  validateGoalListQuery,
  validateGoalPatch,
  validateHabitCreate,
  validateHabitGroupCreate,
  validateHabitGroupId,
  validateHabitGroupPatch,
  validateHabitGroupReorder,
  validateHabitId,
  validateHabitListQuery,
  validateHabitMonthQuery,
  validateHabitPatch,
  validateHabitStatsQuery,
  validateLocalDateParam,
  validateProjectCreate,
  validateProjectId,
  validateProjectListQuery,
  validateProjectPatch,
  validateReviewSummaryQuery,
  validateWishConvert,
  validateWishCreate,
  validateWishId,
  validateWishListQuery,
  validateWishPatch,
} from '../client-shared/contract.js';
import { LifeosError } from '../application/errors.js';

const MAX_BODY_BYTES = 1024 * 1024;

/* ───────────────────────── 请求辅助（routes.js 副本） ───────────────────────── */

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

function publishChanged(deps, kind, ids, action, extra) {
  try {
    const bus = deps?.bus;
    if (!bus || typeof bus.publish !== 'function') return;
    bus.publish({
      type: 'changed',
      data: {
        kind,
        ids: Array.isArray(ids) ? ids.filter(Boolean) : [],
        action,
        at: new Date().toISOString(),
        ...(extra || {}),
      },
    });
  } catch {
    // 事件只是提示，失败不阻塞写请求
  }
}

/** 服务方法缺失时统一 503，避免客户端看到 TypeError 500。 */
function requireService(service, name, label) {
  if (!service || typeof service[name] !== 'function') {
    throw new LifeosError('store_unavailable', `${label}服务未就绪（缺少 ${name}）`);
  }
  return (...args) => service[name](...args);
}

/* ───────────────────────── 响应归一化（保持 PLAN §4 flat 形状） ───────────────────────── */

function itemsOf(result) {
  return Array.isArray(result?.items) ? result.items : [];
}

function withRevision(result, entityKey) {
  const value = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  const entity = value[entityKey] ?? null;
  let revision = value.revision;
  if (!Number.isInteger(revision)) {
    revision = Number.isInteger(entity?.rev) ? entity.rev : null;
  }
  return { ...value, revision };
}

function habitDetail(result) {
  const source = result && typeof result === 'object' ? result : {};
  const habit = source.habit ?? (source.id ? source : null);
  return { habit, checkins: Array.isArray(source.checkins) ? source.checkins : [] };
}

function projectDetail(result) {
  const source = result && typeof result === 'object' ? result : {};
  const project = source.project ?? source.projectView ?? (source.id ? source : null);
  const progress = source.progress ?? (project && typeof project === 'object' ? project.progress ?? null : null);
  return {
    project,
    tasks: Array.isArray(source.tasks) ? source.tasks : [],
    progress,
    recentActivityAt: source.recentActivityAt ?? null,
  };
}

function goalDetail(result) {
  const source = result && typeof result === 'object' ? result : {};
  const goal = source.goal ?? (source.id ? source : null);
  const progress = source.progress ?? (goal && typeof goal === 'object' ? goal.progress ?? null : null);
  return { goal, progress };
}

function statsValue(result) {
  const source = result && typeof result === 'object' ? result : {};
  return {
    range: source.range ?? null,
    today: source.today ?? null,
    habits: Array.isArray(source.habits) ? source.habits : [],
  };
}

/* ───────────────────────── 路由表 ───────────────────────── */

export function buildM4Routes(deps) {
  const { service } = deps;

  return [
    /* ── 习惯 ─────────────────────────────────────────── */
    {
      method: 'GET',
      pattern: '/habits',
      handler: async (ctx) => {
        const filter = validated(validateHabitListQuery(ctx.url.searchParams), 'query');
        const result = await requireService(service, 'listHabits', '习惯')(filter);
        const source = result && typeof result === 'object' ? result : {};
        return { items: itemsOf(result), today: source.today ?? null };
      },
    },
    {
      method: 'POST',
      pattern: '/habits',
      handler: async (ctx) => {
        const input = validated(validateHabitCreate(await parseJsonBody(ctx.req)), 'habit');
        const result = withRevision(await requireService(service, 'createHabit', '习惯')(input), 'habit');
        const habit = result.habit ?? null;
        publishChanged(deps, 'habit', [habit?.id], 'create');
        return result;
      },
    },
    // 注意：/habits/stats、/habits/month 必须先于 /habits/:id 注册
    {
      method: 'GET',
      pattern: '/habits/stats',
      handler: async (ctx) => {
        const query = validated(validateHabitStatsQuery(ctx.url.searchParams), 'query');
        const args = { from: query.from ?? undefined, to: query.to ?? undefined, streakMode: query.mode };
        return statsValue(await requireService(service, 'getHabitStats', '习惯')(args));
      },
    },
    {
      method: 'GET',
      pattern: '/habits/month',
      handler: async (ctx) => {
        const query = validated(validateHabitMonthQuery(ctx.url.searchParams), 'query');
        const result = await requireService(service, 'getHabitMonth', '习惯')({ month: query.month });
        return result && typeof result === 'object' ? result : { month: query.month, days: [], rows: [] };
      },
    },
    {
      method: 'GET',
      pattern: '/habits/:id',
      handler: async (ctx) => {
        const id = validated(validateHabitId(ctx.params.id), 'id');
        return habitDetail(await requireService(service, 'getHabit', '习惯')(id));
      },
    },
    {
      method: 'PATCH',
      pattern: '/habits/:id',
      handler: async (ctx) => {
        const id = validated(validateHabitId(ctx.params.id), 'id');
        const body = await parseJsonBody(ctx.req);
        const patch = validated(validateHabitPatch(body.patch !== undefined ? body.patch : body), 'habit');
        const expectedRev = requiredRev(ctx.req, body);
        const result = withRevision(
          await requireService(service, 'updateHabit', '习惯')(id, patch, { expectedRev }),
          'habit',
        );
        publishChanged(deps, 'habit', [id], 'update');
        return result;
      },
    },
    {
      method: 'POST',
      pattern: '/habits/:id/archive',
      handler: async (ctx) => {
        const id = validated(validateHabitId(ctx.params.id), 'id');
        const body = await parseJsonBody(ctx.req);
        const expectedRev = requiredRev(ctx.req, body);
        const result = withRevision(
          await requireService(service, 'archiveHabit', '习惯')(id, { expectedRev }),
          'habit',
        );
        publishChanged(deps, 'habit', [id], 'archive');
        return result;
      },
    },
    {
      method: 'POST',
      pattern: '/habits/:id/checkin',
      handler: async (ctx) => {
        const id = validated(validateHabitId(ctx.params.id), 'id');
        const input = validated(validateCheckin(await parseJsonBody(ctx.req)), 'checkin');
        const args = { habitId: id, status: input.status, retro: input.retro };
        if (input.localDate !== null) args.localDate = input.localDate;
        if (input.value !== null) args.value = input.value;
        if (input.note !== null) args.note = input.note;
        const result = withRevision(await requireService(service, 'checkin', '习惯')(args), 'checkin');
        const merged = result.merged === true;
        publishChanged(deps, 'habit_checkin', [id], merged ? 'merge' : 'checkin', {
          localDate: result.checkin?.local_date ?? input.localDate ?? null,
          merged,
        });
        return { ...result, merged };
      },
    },
    {
      method: 'GET',
      pattern: '/habits/:id/checkins',
      handler: async (ctx) => {
        const id = validated(validateHabitId(ctx.params.id), 'id');
        const query = validated(validateCheckinQuery(ctx.url.searchParams), 'query');
        const args = { habitId: id };
        if (query.from) args.from = query.from;
        if (query.to) args.to = query.to;
        const result = await requireService(service, 'listCheckins', '习惯')(args);
        return { items: itemsOf(result) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/habits/:id/checkins/:date',
      handler: async (ctx) => {
        const id = validated(validateHabitId(ctx.params.id), 'id');
        const localDate = validated(validateLocalDateParam(ctx.params.date), 'date');
        const body = await parseJsonBody(ctx.req);
        const expectedRev = optionalRev(ctx.req, body, ctx.url);
        const args = { habitId: id, localDate };
        if (expectedRev !== null) args.expectedRev = expectedRev;
        const result = await requireService(service, 'uncheck', '习惯')(args);
        publishChanged(deps, 'habit_checkin', [id], 'uncheck', { localDate });
        return { ok: true, revision: Number.isInteger(result?.revision) ? result.revision : null };
      },
    },

    /* ── 习惯分组（M18）────────────────────────────────── */
    {
      method: 'GET',
      pattern: '/habit-groups',
      handler: async () => ({
        items: itemsOf(await requireService(service, 'listHabitGroups', '习惯分组')()),
      }),
    },
    {
      method: 'POST',
      pattern: '/habit-groups',
      handler: async (ctx) => {
        const input = validated(validateHabitGroupCreate(await parseJsonBody(ctx.req)), 'habit_group');
        const result = withRevision(
          await requireService(service, 'createHabitGroup', '习惯分组')(input),
          'group',
        );
        publishChanged(deps, 'habit_group', [result.group?.id], 'create');
        return result;
      },
    },
    {
      method: 'POST',
      pattern: '/habit-groups/reorder',
      handler: async (ctx) => {
        const input = validated(validateHabitGroupReorder(await parseJsonBody(ctx.req)), 'habit_group_order');
        const result = await requireService(service, 'reorderHabitGroups', '习惯分组')(input);
        publishChanged(deps, 'habit_group', input.ids, 'reorder');
        return { items: itemsOf(result) };
      },
    },
    {
      method: 'PATCH',
      pattern: '/habit-groups/:id',
      handler: async (ctx) => {
        const id = validated(validateHabitGroupId(ctx.params.id), 'id');
        const body = await parseJsonBody(ctx.req);
        const patch = validated(
          validateHabitGroupPatch(body.patch !== undefined ? body.patch : body),
          'habit_group',
        );
        const expectedRev = requiredRev(ctx.req, body);
        const result = withRevision(
          await requireService(service, 'updateHabitGroup', '习惯分组')(id, patch, { expectedRev }),
          'group',
        );
        publishChanged(deps, 'habit_group', [id], 'update');
        return result;
      },
    },
    {
      method: 'DELETE',
      pattern: '/habit-groups/:id',
      handler: async (ctx) => {
        const id = validated(validateHabitGroupId(ctx.params.id), 'id');
        const body = await parseJsonBody(ctx.req);
        const expectedRev = requiredRev(ctx.req, body);
        const result = await requireService(service, 'deleteHabitGroup', '习惯分组')(id, { expectedRev });
        publishChanged(deps, 'habit_group', [id], 'delete', {
          movedToUngrouped: Array.isArray(result?.movedToUngrouped) ? result.movedToUngrouped : [],
        });
        return {
          ok: true,
          revision: Number.isInteger(result?.revision) ? result.revision : null,
          movedToUngrouped: Array.isArray(result?.movedToUngrouped) ? result.movedToUngrouped : [],
        };
      },
    },

    /* ── 项目 ─────────────────────────────────────────── */
    {
      method: 'GET',
      pattern: '/projects',
      handler: async (ctx) => {
        const filter = validated(validateProjectListQuery(ctx.url.searchParams), 'query');
        return { items: itemsOf(await requireService(service, 'listProjects', '项目')(filter)) };
      },
    },
    {
      method: 'POST',
      pattern: '/projects',
      handler: async (ctx) => {
        const input = validated(validateProjectCreate(await parseJsonBody(ctx.req)), 'project');
        const result = withRevision(await requireService(service, 'createProject', '项目')(input), 'project');
        const project = result.project ?? null;
        publishChanged(deps, 'project', [project?.id], 'create');
        return result;
      },
    },
    {
      method: 'GET',
      pattern: '/projects/:id',
      handler: async (ctx) => {
        const id = validated(validateProjectId(ctx.params.id), 'id');
        return projectDetail(await requireService(service, 'getProject', '项目')(id));
      },
    },
    {
      method: 'PATCH',
      pattern: '/projects/:id',
      handler: async (ctx) => {
        const id = validated(validateProjectId(ctx.params.id), 'id');
        const body = await parseJsonBody(ctx.req);
        const patch = validated(validateProjectPatch(body.patch !== undefined ? body.patch : body), 'project');
        const expectedRev = requiredRev(ctx.req, body);
        const result = withRevision(
          await requireService(service, 'updateProject', '项目')(id, patch, expectedRev),
          'project',
        );
        publishChanged(deps, 'project', [id], 'update');
        return result;
      },
    },
    {
      method: 'POST',
      pattern: '/projects/:id/archive',
      handler: async (ctx) => {
        const id = validated(validateProjectId(ctx.params.id), 'id');
        const body = await parseJsonBody(ctx.req);
        const expectedRev = requiredRev(ctx.req, body);
        const result = withRevision(
          await requireService(service, 'archiveProject', '项目')(id, { expectedRev }),
          'project',
        );
        publishChanged(deps, 'project', [id], 'archive');
        return result;
      },
    },

    /* ── 目标 ─────────────────────────────────────────── */
    {
      method: 'GET',
      pattern: '/goals',
      handler: async (ctx) => {
        const filter = validated(validateGoalListQuery(ctx.url.searchParams), 'query');
        return { items: itemsOf(await requireService(service, 'listGoals', '目标')(filter)) };
      },
    },
    {
      method: 'POST',
      pattern: '/goals',
      handler: async (ctx) => {
        const input = validated(validateGoalCreate(await parseJsonBody(ctx.req)), 'goal');
        const result = withRevision(await requireService(service, 'createGoal', '目标')(input), 'goal');
        const goal = result.goal ?? null;
        publishChanged(deps, 'goal', [goal?.id], 'create');
        return result;
      },
    },
    {
      method: 'GET',
      pattern: '/goals/:id',
      handler: async (ctx) => {
        const id = validated(validateGoalId(ctx.params.id), 'id');
        return goalDetail(await requireService(service, 'getGoal', '目标')(id));
      },
    },
    {
      method: 'PATCH',
      pattern: '/goals/:id',
      handler: async (ctx) => {
        const id = validated(validateGoalId(ctx.params.id), 'id');
        const body = await parseJsonBody(ctx.req);
        const patch = validated(validateGoalPatch(body.patch !== undefined ? body.patch : body), 'goal');
        const expectedRev = requiredRev(ctx.req, body);
        const result = withRevision(
          await requireService(service, 'updateGoal', '目标')(id, patch, { expectedRev }),
          'goal',
        );
        publishChanged(deps, 'goal', [id], 'update');
        return result;
      },
    },

    /* ── 愿望 ─────────────────────────────────────────── */
    {
      method: 'GET',
      pattern: '/wishes',
      handler: async (ctx) => {
        const filter = validated(validateWishListQuery(ctx.url.searchParams), 'query');
        return { items: itemsOf(await requireService(service, 'listWishes', '愿望')(filter)) };
      },
    },
    {
      method: 'POST',
      pattern: '/wishes',
      handler: async (ctx) => {
        const input = validated(validateWishCreate(await parseJsonBody(ctx.req)), 'wish');
        const result = withRevision(await requireService(service, 'createWish', '愿望')(input), 'wish');
        const wish = result.wish ?? null;
        publishChanged(deps, 'wish', [wish?.id], 'create');
        return result;
      },
    },
    {
      method: 'PATCH',
      pattern: '/wishes/:id',
      handler: async (ctx) => {
        const id = validated(validateWishId(ctx.params.id), 'id');
        const body = await parseJsonBody(ctx.req);
        const patch = validated(validateWishPatch(body.patch !== undefined ? body.patch : body), 'wish');
        const expectedRev = requiredRev(ctx.req, body);
        const result = withRevision(
          await requireService(service, 'updateWish', '愿望')(id, patch, { expectedRev }),
          'wish',
        );
        publishChanged(deps, 'wish', [id], 'update');
        return result;
      },
    },
    {
      method: 'POST',
      pattern: '/wishes/:id/convert',
      handler: async (ctx) => {
        const id = validated(validateWishId(ctx.params.id), 'id');
        const body = await parseJsonBody(ctx.req);
        const goalInput = validated(validateWishConvert(body), 'wish').goal;
        const expectedRev = optionalRev(ctx.req, body, ctx.url);
        const args = { goal: goalInput };
        if (expectedRev !== null) args.expectedRev = expectedRev;
        const result = withRevision(await requireService(service, 'convertWish', '愿望')(id, args), 'wish');
        const wish = result.wish ?? null;
        const goal = result.goal ?? null;
        publishChanged(deps, 'wish', [wish?.id ?? id], 'convert', { goalId: goal?.id ?? null });
        publishChanged(deps, 'goal', [goal?.id], 'create', { wishId: wish?.id ?? id });
        return result;
      },
    },

    /* ── 回顾 ─────────────────────────────────────────── */
    {
      method: 'GET',
      pattern: '/review/summary',
      handler: async (ctx) => {
        const query = validated(validateReviewSummaryQuery(ctx.url.searchParams), 'query');
        const args = { period: query.period };
        if (query.anchor) args.anchor = query.anchor;
        const result = await requireService(service, 'getReviewSummary', '回顾')(args);
        return result && typeof result === 'object' ? result : null;
      },
    },
  ];
}

export default buildM4Routes;
