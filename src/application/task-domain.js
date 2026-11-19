/**
 * B：任务领域规则（M1 的临时适配层）。
 *
 * M1-PLAN 约定状态机由 A 的 `src/domain/task.js`、视图查询由 A 的
 * `indexes.queryTasks` 提供。截至本文件创建时 A 尚未交付这两个入口，
 * 为不阻塞 B/C/D，这里按 M1-PLAN §1.2/§1.3/§1.4 冻结口径实现**等价规则**，
 * 并在模块加载时尝试动态 import A 的 `domain/task.js`：
 *   - 若 A 导出同名函数（assertTransition/applyAction/normalizeTime），优先使用；
 *   - 否则使用本文本地实现。
 * A 交付后只需在本文件做一次切换，service/routes/contract 不变。
 *
 * 写入范围：src/application/**（B 所有），不改 A 的文件。
 */

import { addDays, isIsoTimestamp, isLocalDate, localDateOfIso } from '../domain/time.js';

/** A 的规则模块（若已交付） */
let external = null;
try {
  const mod = await import('../domain/task.js');
  if (mod && typeof mod === 'object') external = mod;
} catch {
  external = null;
}

export const USING_EXTERNAL_TASK_DOMAIN = Boolean(
  external && (typeof external.assertTransition === 'function' || typeof external.applyAction === 'function'),
);

export const OPEN_STATUSES = Object.freeze(['todo', 'doing']);
export const TASK_STATUSES = Object.freeze(['todo', 'doing', 'done', 'cancelled']);
export const PRIORITIES = Object.freeze(['none', 'low', 'medium', 'high']);
export const ACTION_TARGETS = Object.freeze({
  complete: Object.freeze({ from: Object.freeze(['todo', 'doing']), to: 'done' }),
  reopen: Object.freeze({ from: Object.freeze(['done', 'cancelled']), to: 'todo' }),
  cancel: Object.freeze({ from: Object.freeze(['todo', 'doing']), to: 'cancelled' }),
});

const PRIORITY_WEIGHT = Object.freeze({ none: 0, low: 1, medium: 2, high: 3 });

function ruleError(message, details) {
  const error = new Error(message);
  error.code = 'validation_failed';
  error.details = details;
  return error;
}

export function isOpen(task) {
  return Boolean(task) && OPEN_STATUSES.includes(task.status) && !task.deleted_at && !task.archived_at;
}

export function assertTransition(task, action) {
  if (external && typeof external.assertTransition === 'function') {
    return external.assertTransition(task, action);
  }
  const target = ACTION_TARGETS[action];
  if (!target) throw ruleError(`未知任务动作：${String(action)}`, { action });
  if (!target.from.includes(task.status)) {
    throw ruleError(`任务状态 ${task.status} 不允许 ${action}（允许：${target.from.join('|')}）`, {
      allowed: [...target.from],
      current: task.status,
      action,
    });
  }
  return true;
}

/**
 * 返回动作后的字段补丁（不修改入参）。
 * @returns {object} {status, completedAt, cancelledAt}
 */
export function applyAction(task, action, nowIso) {
  if (external && typeof external.applyAction === 'function') {
    return external.applyAction(task, action, nowIso);
  }
  assertTransition(task, action);
  if (action === 'complete') {
    return { status: 'done', completed_at: nowIso };
  }
  if (action === 'reopen') {
    return { status: 'todo', completed_at: null, cancelled_at: null };
  }
  return { status: 'cancelled', cancelled_at: nowIso };
}

/**
 * 时间形态归一化（M1-PLAN §1.3）：none / date(all_day) / span；due 仅截止。
 * 入参 current 为当前 task（可空），patch 为已校验的时间字段（可能含 null 清除）。
 * @returns {{fields: object, errors: string[]}}
 */
export function normalizeTime(current, patch) {
  if (external && typeof external.normalizeTime === 'function') {
    return external.normalizeTime(current, patch);
  }
  const base = current || {};
  // 显式 null 代表"清除"，必须覆盖 base；undefined/缺省才继承 base。
  const resolve = (name, column) => {
    if (Object.prototype.hasOwnProperty.call(patch, name)) return patch[name] ?? null;
    if (Object.prototype.hasOwnProperty.call(patch, column)) return patch[column] ?? null;
    const value = base[column] ?? base[name];
    return value ?? null;
  };
  const scheduledDate = resolve('scheduledDate', 'scheduled_date');
  const scheduledStartAt = resolve('scheduledStartAt', 'scheduled_start_at');
  const scheduledEndAt = resolve('scheduledEndAt', 'scheduled_end_at');
  const dueDate = resolve('dueDate', 'due_date');
  const dueAt = resolve('dueAt', 'due_at');
  const errors = [];

  if (scheduledDate !== null && !isLocalDate(scheduledDate)) errors.push('scheduledDate 必须是 YYYY-MM-DD');
  if (dueDate !== null && !isLocalDate(dueDate)) errors.push('dueDate 必须是 YYYY-MM-DD');
  for (const [name, value] of [
    ['scheduledStartAt', scheduledStartAt],
    ['scheduledEndAt', scheduledEndAt],
    ['dueAt', dueAt],
  ]) {
    if (value !== null && !isIsoTimestamp(value)) errors.push(`${name} 必须是 UTC ISO 时刻`);
  }
  if (scheduledDate !== null && scheduledStartAt !== null) errors.push('scheduledDate 与 scheduledStartAt 互斥（二选一）');
  if (dueDate !== null && dueAt !== null) errors.push('dueDate 与 dueAt 互斥（二选一）');
  if (scheduledStartAt !== null && scheduledEndAt !== null && !(scheduledStartAt < scheduledEndAt)) {
    errors.push('scheduledEndAt 必须晚于 scheduledStartAt');
  }
  if (scheduledEndAt !== null && scheduledStartAt === null) errors.push('scheduledEndAt 需要同时提供 scheduledStartAt');

  const timeKind = scheduledStartAt !== null ? 'span' : scheduledDate !== null ? 'all_day' : 'none';
  const isAllDay = scheduledDate !== null && scheduledStartAt === null;
  const fields = {
    scheduled_date: scheduledDate,
    scheduled_start_at: scheduledStartAt,
    scheduled_end_at: scheduledEndAt,
    scheduled_tz: scheduledDate || scheduledStartAt ? base.scheduled_tz ?? null : null,
    due_date: dueDate,
    due_at: dueAt,
    due_tz: dueAt ? base.due_tz ?? null : null,
    is_all_day: isAllDay,
    time_kind: timeKind,
  };
  return { fields, errors };
}

/** 视图口径（M1-PLAN §1.4） */
export function matchesView(task, view, ctx) {
  const { todayLocal, nowIso } = ctx;
  if (!task || !isOpen(task)) return false;
  const scheduledDate = task.scheduled_date ?? null;
  const startAt = task.scheduled_start_at ?? null;
  const dueDate = task.due_date ?? null;
  const dueAt = task.due_at ?? null;
  const dayOf = (iso) => (iso ? localDateOfIso(ctx.timeZone, iso) : null);
  const tomorrow = addDays(todayLocal, 1);
  const endOfNext7 = addDays(todayLocal, 6);

  if (view === 'today') {
    return (
      scheduledDate === todayLocal ||
      (startAt !== null && dayOf(startAt) === todayLocal) ||
      dueDate === todayLocal ||
      (dueAt !== null && dayOf(dueAt) === todayLocal)
    );
  }
  if (view === 'overdue') {
    if (dueDate !== null && dueDate < todayLocal) return true;
    if (dueAt !== null && dueAt < nowIso) return true;
    return scheduledDate !== null && scheduledDate < todayLocal;
  }
  if (view === 'next7') {
    const inWindow = (day) => day !== null && day >= todayLocal && day <= endOfNext7;
    return inWindow(scheduledDate) || inWindow(dayOf(startAt)) || inWindow(dueDate) || inWindow(dayOf(dueAt));
  }
  if (view === 'inbox') {
    return (
      !task.project_id &&
      scheduledDate === null &&
      startAt === null &&
      dueDate === null &&
      dueAt === null
    );
  }
  return true; // all
}

/** 分组键（服务端返回，客户端渲染） */
export function groupOf(task, ctx) {
  const { todayLocal, nowIso } = ctx;
  const tomorrow = addDays(todayLocal, 1);
  const endOfNext7 = addDays(todayLocal, 6);
  const dayOf = (iso) => (iso ? localDateOfIso(ctx.timeZone, iso) : null);
  const scheduledDate = task.scheduled_date ?? null;
  const dueDate = task.due_date ?? null;
  const dueAt = task.due_at ?? null;
  const startDay = dayOf(task.scheduled_start_at);
  if ((dueDate !== null && dueDate < todayLocal) || (dueAt !== null && dueAt < nowIso) || (scheduledDate !== null && scheduledDate < todayLocal)) {
    return 'overdue';
  }
  if (
    scheduledDate === todayLocal ||
    startDay === todayLocal ||
    dueDate === todayLocal ||
    (dueAt !== null && dayOf(dueAt) === todayLocal)
  ) {
    return 'today';
  }
  const days = [scheduledDate, startDay, dueDate, dayOf(dueAt)].filter((day) => day !== null);
  if (days.includes(tomorrow)) return 'tomorrow';
  if (days.some((day) => day > tomorrow && day <= endOfNext7)) return 'next7';
  if (days.some((day) => day > endOfNext7)) return 'later';
  return 'none';
}

/** 默认排序：无日期最后 → 日期升序 → 优先级降序 → created_at */
export function sortDefault(a, b) {
  const dateA = a.scheduled_date ?? (a.scheduled_start_at ? String(a.scheduled_start_at).slice(0, 10) : null) ?? a.due_date ?? null;
  const dateB = b.scheduled_date ?? (b.scheduled_start_at ? String(b.scheduled_start_at).slice(0, 10) : null) ?? b.due_date ?? null;
  if (dateA !== dateB) {
    if (dateA === null) return 1;
    if (dateB === null) return -1;
    return dateA < dateB ? -1 : 1;
  }
  const pa = PRIORITY_WEIGHT[a.priority] ?? 0;
  const pb = PRIORITY_WEIGHT[b.priority] ?? 0;
  if (pa !== pb) return pb - pa;
  const ca = String(a.created_at ?? '');
  const cb = String(b.created_at ?? '');
  if (ca !== cb) return ca < cb ? -1 : 1;
  return String(a.id).localeCompare(String(b.id));
}

export { PRIORITY_WEIGHT, ruleError };
