/**
 * B：M1 看板应用服务（任务/项目/标签/ui-prefs/日历）。
 *
 * 契约：M1-PLAN §2（服务 API）+ §3（HTTP 由 routes 层调用本模块）。
 * 原则：
 *  - 所有写走 store.transaction（journal-first）；任务写 = task + state_change + operation_log（+ entity_tag）一次原子提交；
 *  - 每次更新带 expectedRev（CAS）；冲突抛 LifeosError('conflict', details.current)；
 *  - 状态机/时间归一化/视图口径在 task-domain.js（A 交付 domain/task.js 后自动切换）；
 *  - 视图查询优先用 A 的 store.indexes.queryTasks（若已交付），否则内存过滤（本文件的 fallback）。
 *
 * 不 import 第三方包；不直接改 store 内部状态（只用 get/entries/transaction/rebuildIndexes）。
 */

import { LifeosError } from './errors.js';
import { normalizeRepeatRule } from '../domain/task.js';
import { taskAnchorLocalDate } from '../domain/time.js';
import {
  applyAction,
  assertTransition,
  groupOf,
  isOpen,
  matchesView,
  normalizeTime,
  PRIORITY_WEIGHT,
  sortDefault,
} from './task-domain.js';
import {
  decodeCursor as _unusedDecodeCursor,
  DEFAULT_LIMIT,
  isEntityId,
  MAX_LIMIT,
  TASK_GROUP_KEYS,
} from '../client-shared/contract.js';

const CORE = 'lifeos';
const LOG = 'lifeos_log';
const OPEN = ['todo', 'doing'];
const PREF_KEY = 'ui_prefs';

function iso(ms) {
  return new Date(ms).toISOString();
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {object} deps
 * @param {object} deps.store LifeosStore
 * @param {(prefix?:string)=>string} deps.newId
 * @param {()=>number} deps.now
 * @param {string} deps.timeZone
 * @param {(kind:string, ids:string[], extra?:object)=>void} deps.emitChanged
 * @param {string} [deps.actorType='user']
 * @param {(task:object, ctx:{action:string})=>any} [deps.onTaskWrite] 写后钩子（M3 截止提醒同步，软失败）
 * @param {object} [deps.logger]
 */
export function createTaskOps(deps) {
  const { store, newId, now, timeZone, emitChanged } = deps;
  const actorType = deps.actorType || 'user';
  const onTaskWrite = typeof deps.onTaskWrite === 'function' ? deps.onTaskWrite : null;
  const logger = deps.logger || null;

  /** 写后钩子（M3 截止提醒同步）：软失败，绝不影响主流程。 */
  function notifyTaskWrite(task, action) {
    if (!onTaskWrite) return Promise.resolve();
    return Promise.resolve()
      .then(() => onTaskWrite(task, { action }))
      .catch((error) => {
        try {
          logger?.warn?.({
            event: 'task.reminder_sync_failed',
            action,
            taskId: task?.id,
            error: String(error?.message ?? error),
          });
        } catch {
          /* ignore */
        }
      });
  }

  /* ── 读工具 ─────────────────────────────────────────────── */

  function entries(table) {
    try {
      return store.entries(CORE, table);
    } catch {
      return [];
    }
  }

  function allTasks() {
    return entries('task').map(([, task]) => task).filter((task) => task && !task.deleted_at);
  }

  function allProjects() {
    return entries('project').map(([, project]) => project).filter((project) => project && !project.deleted_at);
  }

  function allTags() {
    return entries('tag').map(([, tag]) => tag).filter((tag) => tag && !tag.deleted_at);
  }

  function allEntityTags() {
    return entries('entity_tag').map(([, link]) => link).filter((link) => link && !link.deleted_at);
  }

  function getTaskRecord(id) {
    try {
      const record = store.get(CORE, 'task', id);
      return record && !record.deleted_at ? record : null;
    } catch {
      return null;
    }
  }

  function getProjectRecord(id) {
    try {
      const record = store.get(CORE, 'project', id);
      return record && !record.deleted_at ? record : null;
    } catch {
      return null;
    }
  }

  function getTagRecord(id) {
    try {
      const record = store.get(CORE, 'tag', id);
      return record && !record.deleted_at ? record : null;
    } catch {
      return null;
    }
  }

  function allLists() {
    return entries('list').map(([, list]) => list).filter((list) => list && !list.deleted_at && !list.archived_at);
  }

  function allGroups() {
    return entries('group').map(([, group]) => group).filter((group) => group && !group.deleted_at && !group.archived_at);
  }

  function getListRecord(id) {
    try {
      const record = store.get(CORE, 'list', id);
      return record && !record.deleted_at ? record : null;
    } catch {
      return null;
    }
  }

  function getGroupRecord(id) {
    try {
      const record = store.get(CORE, 'group', id);
      return record && !record.deleted_at ? record : null;
    } catch {
      return null;
    }
  }

  /** 读任务记录（含已软删；delete/restore 用）。 */
  function getTaskAny(id) {
    try {
      const record = store.get(CORE, 'task', id);
      return record && typeof record === 'object' ? record : null;
    } catch {
      return null;
    }
  }

  /* ── 视图快照（每次调用构建；M1 规模 ≤1 万条可接受） ───────── */

  function snapshot() {
    const rawTasks = entries('task').map(([, task]) => task).filter((task) => task && typeof task === 'object');
    const tasks = rawTasks.filter((task) => !task.deleted_at);
    const projects = new Map(allProjects().map((project) => [project.id, project]));
    const tags = new Map(allTags().map((tag) => [tag.id, tag]));
    const entityTags = allEntityTags();
    const tagsByTask = new Map();
    for (const link of entityTags) {
      if (link.entity_type !== 'task') continue;
      if (!tagsByTask.has(link.entity_id)) tagsByTask.set(link.entity_id, []);
      tagsByTask.get(link.entity_id).push(link.tag_id);
    }
    return { tasks, rawTasks, projects, tags, tagsByTask, todayLocal: deps.todayLocal(), nowIso: iso(now()) };
  }

  function taskLite(task, ctx) {
    const project = task.project_id ? ctx.projects.get(task.project_id) : null;
    const tagIds = ctx.tagsByTask.get(task.id) || [];
    return {
      id: task.id,
      title: task.title,
      notes: task.notes ?? null,
      status: task.status,
      priority: task.priority ?? 'none',
      projectId: task.project_id ?? null,
      projectName: project ? project.name : null,
      tags: tagIds.map((tagId) => ctx.tags.get(tagId)).filter(Boolean).map(tagLite),
      scheduledDate: task.scheduled_date ?? null,
      scheduledStartAt: task.scheduled_start_at ?? null,
      scheduledEndAt: task.scheduled_end_at ?? null,
      isAllDay: task.is_all_day === true,
      dueDate: task.due_date ?? null,
      dueAt: task.due_at ?? null,
      repeatRule: task.repeat_rule ?? null,
      listId: task.list_id ?? null,
      groupId: task.group_id ?? null,
      parentTaskId: task.parent_task_id ?? null,
      pinned: task.pinned === true,
      sortOrder: task.sort_order ?? 0,
      deletedAt: task.deleted_at ?? null,
      completedAt: task.completed_at ?? null,
      cancelledAt: task.cancelled_at ?? null,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      rev: task.rev,
      timeKind: task.time_kind ?? 'none',
      workKind: task.work_kind ?? 'action',
      archivedAt: task.archived_at ?? null,
    };
  }

  function projectLite(project) {
    return {
      id: project.id,
      name: project.name,
      color: project.color ?? null,
      status: project.status ?? 'active',
      sortOrder: project.sort_order ?? 0,
      rev: project.rev,
      createdAt: project.created_at,
      updatedAt: project.updated_at,
    };
  }

  function tagLite(tag) {
    return { id: tag.id, name: tag.name, color: tag.color ?? null, rev: tag.rev };
  }

  function listLite(list) {
    return {
      id: list.id,
      name: list.name,
      kind: list.kind ?? 'normal',
      color: list.color ?? null,
      icon: list.icon ?? null,
      sortOrder: list.sort_order ?? 0,
      isDefault: list.is_default === true,
      rev: list.rev,
      createdAt: list.created_at,
      updatedAt: list.updated_at,
    };
  }

  function groupLite(group) {
    return {
      id: group.id,
      listId: group.list_id,
      name: group.name,
      color: group.color ?? null,
      sortOrder: group.sort_order ?? 0,
      collapsed: group.collapsed === true,
      rev: group.rev,
      createdAt: group.created_at,
      updatedAt: group.updated_at,
    };
  }

  /** 任务是否属于某清单（收集箱同时含 list_id 为空的任务）。 */
  function listTaskMatches(list, task) {
    if (!task || task.deleted_at) return false;
    if (!task.list_id) return list.kind === 'inbox';
    return task.list_id === list.id;
  }

  /** 清单视图（含任务计数，M6 §1-2）。 */
  function listSummaries() {
    const ctx = snapshot();
    const lists = allLists().sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.created_at).localeCompare(String(b.created_at)),
    );
    return lists.map((list) => {
      const scoped = ctx.tasks.filter((task) => listTaskMatches(list, task));
      return {
        ...listLite(list),
        count: scoped.length,
        openCount: scoped.filter((task) => isOpen(task) && !task.archived_at).length,
        doneCount: scoped.filter((task) => task.status === 'done').length,
      };
    });
  }

  /** 分组视图（含任务计数；listId 省略时返回全部）。 */
  function groupSummaries(listId) {
    const ctx = snapshot();
    const groups = allGroups()
      .filter((group) => !listId || group.list_id === listId)
      .sort(
        (a, b) =>
          (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.created_at).localeCompare(String(b.created_at)),
      );
    return groups.map((group) => {
      const scoped = ctx.tasks.filter((task) => !task.deleted_at && task.group_id === group.id);
      return {
        ...groupLite(group),
        count: scoped.length,
        openCount: scoped.filter((task) => isOpen(task) && !task.archived_at).length,
      };
    });
  }

  /** 任务层级深度（根任务 = 1）。 */
  function depthOf(task) {
    let depth = 1;
    let cursor = task;
    const seen = new Set([task.id]);
    while (cursor && cursor.parent_task_id) {
      if (seen.has(cursor.parent_task_id)) break;
      seen.add(cursor.parent_task_id);
      const parent = getTaskRecord(cursor.parent_task_id);
      if (!parent) break;
      depth += 1;
      cursor = parent;
    }
    return depth;
  }

  /** 子任务子树：返回后代 id 列表与子树高度（含根 = 1）。 */
  function subtreeOf(rootId) {
    const ctx = snapshot();
    const byParent = new Map();
    for (const task of ctx.rawTasks) {
      if (!task || task.deleted_at || !task.parent_task_id) continue;
      if (!byParent.has(task.parent_task_id)) byParent.set(task.parent_task_id, []);
      byParent.get(task.parent_task_id).push(task);
    }
    const ids = [];
    const seen = new Set([rootId]);
    let frontier = [rootId];
    let height = 1;
    while (frontier.length > 0) {
      const next = [];
      for (const parentId of frontier) {
        for (const child of byParent.get(parentId) || []) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          ids.push(child.id);
          next.push(child.id);
        }
      }
      if (next.length > 0) height += 1;
      frontier = next;
    }
    return { ids, height };
  }

  /**
   * 解析任务归属（listId/groupId/parentTaskId），校验清单/分组/父任务存在性、
   * 分组与清单一致、父任务成环；返回归一化后的 {listId, groupId, parentTaskId}。
   * @param {{task?:object|null, listId?:string|null|undefined, groupId?:string|null|undefined, parentTaskId?:string|null|undefined}} input
   */
  function resolvePlacement(input = {}) {
    const task = input.task || null;
    let listId = Object.prototype.hasOwnProperty.call(input, 'listId') ? input.listId : task ? (task.list_id ?? null) : null;
    let groupId = Object.prototype.hasOwnProperty.call(input, 'groupId') ? input.groupId : task ? (task.group_id ?? null) : null;
    let parentTaskId = Object.prototype.hasOwnProperty.call(input, 'parentTaskId')
      ? input.parentTaskId
      : task
        ? (task.parent_task_id ?? null)
        : null;

    if (listId) {
      const list = getListRecord(listId);
      if (!list) throw new LifeosError('validation_failed', `清单不存在：${listId}`, { listId });
    }
    /* 跨清单移动且未显式指定 target groupId：旧分组属于原清单，自动落到目标清单的未分组。
       必须在 groupId 归属校验之前清空，否则会被判成「分组不属于目标清单」。 */
    if (listId && task && !Object.prototype.hasOwnProperty.call(input, 'groupId') && task.group_id) {
      const oldGroup = getGroupRecord(task.group_id);
      if (oldGroup && oldGroup.list_id !== listId) groupId = null;
    }
    if (groupId) {
      const group = getGroupRecord(groupId);
      if (!group) throw new LifeosError('validation_failed', `分组不存在：${groupId}`, { groupId });
      if (listId && group.list_id !== listId) {
        throw new LifeosError('validation_failed', '分组不属于目标清单', { groupId, listId });
      }
      if (!listId) listId = group.list_id ?? null;
    }
    if (listId && !groupId && task && task.group_id) {
      const oldGroup = getGroupRecord(task.group_id);
      if (oldGroup && oldGroup.list_id !== listId) groupId = null; // 跨清单移动自动清分组
    }
    if (parentTaskId) {
      const parent = getTaskRecord(parentTaskId);
      if (!parent) throw new LifeosError('parent_not_found', `父任务不存在：${parentTaskId}`, { parentTaskId });
      if (task && parent.id === task.id) {
        throw new LifeosError('invalid_state', '任务不能作为自己的父任务', { id: task.id });
      }
      if (task) {
        let cursor = parent;
        const seen = new Set();
        while (cursor) {
          if (cursor.id === task.id) {
            throw new LifeosError('invalid_state', '父任务成环', { parentTaskId });
          }
          if (seen.has(cursor.id)) break;
          seen.add(cursor.id);
          cursor = cursor.parent_task_id ? getTaskAny(cursor.parent_task_id) : null;
        }
      }
      if (!task) {
        // 新建子任务：未显式指定时继承父任务的清单/分组
        if (!Object.prototype.hasOwnProperty.call(input, 'listId') && !listId) listId = parent.list_id ?? null;
        if (!Object.prototype.hasOwnProperty.call(input, 'groupId') && !groupId) groupId = parent.group_id ?? null;
      }
    }
    return {
      listId: listId ?? null,
      groupId: groupId ?? null,
      parentTaskId: parentTaskId ?? null,
    };
  }

  /** 任务通用写入 oplog（list/group 的审计也走这里）。 */
  function genericOplog({ action, targetType, targetId, before, after, nowIso, targetIds }) {
    return oplogRecord({
      action,
      taskId: targetId,
      targetType,
      before,
      after,
      stateChangeIds: [],
      nowIso,
      targetIds: targetIds || [targetId],
    });
  }
  function computeCounts(tasks, ctx) {
    const counts = { today: 0, overdue: 0, next7: 0, inbox: 0, all: 0 };
    for (const task of tasks) {
      if (!isOpen(task)) continue;
      counts.all += 1;
      if (matchesView(task, 'today', ctx)) counts.today += 1;
      if (matchesView(task, 'overdue', ctx)) counts.overdue += 1;
      if (matchesView(task, 'next7', ctx)) counts.next7 += 1;
      if (matchesView(task, 'inbox', ctx)) counts.inbox += 1;
    }
    return counts;
  }

  /**
   * 视图查询。优先 A 的 indexes.queryTasks（若已交付），否则本地过滤。
   * @returns {{items:object[], groups:Array, nextCursor:string|null, counts:object}}
   */
  function listTasks(input = {}) {
    const view = input.view || 'all';
    const limit = Math.min(Math.max(Number(input.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const cursor = typeof input.cursor === 'string' && input.cursor.length > 0 ? input.cursor : null;
    const q = typeof input.q === 'string' && input.q.trim().length > 0 ? input.q.trim().toLowerCase() : null;
    const projectId = input.projectId || null;
    const tagId = input.tagId || null;
    const listId = input.listId || null;
    const groupId = input.groupId || null;
    const from = input.from || null;
    const to = input.to || null;
    const lists = listSummaries();

    // 优先 A 的视图查询（M1-PLAN §1.5：视图调 indexes.queryTasks）；返回 TaskLite 供 Client/契约使用。
    const indexQuery = store.indexes && typeof store.indexes.queryTasks === 'function' ? store.indexes.queryTasks : null;
    if (indexQuery) {
      const result = indexQuery.call(store.indexes, {
        view,
        projectId,
        tagId,
        listId,
        groupId,
        from,
        to,
        q: q ?? undefined,
        limit,
        cursor,
        timeZone,
        now: new Date(now()),
      });
      const ctx = snapshot();
      const toLite = (record) => (record && record.id ? taskLite(record, ctx) : null);
      return {
        items: (result.items || []).map(toLite).filter(Boolean),
        groups: (result.groups || []).map((group) => {
          const items = (group.items || []).map(toLite).filter(Boolean);
          return { key: group.key, count: group.count ?? items.length, taskIds: items.map((task) => task.id), items };
        }),
        nextCursor: result.nextCursor ?? null,
        counts: result.counts,
        view,
        limit,
        lists,
      };
    }

    const ctx = snapshot();
    const matchesFilters = (task) => {
      if (projectId && task.project_id !== projectId) return false;
      if (tagId && !(ctx.tagsByTask.get(task.id) || []).includes(tagId)) return false;
      if (listId) {
        if (task.list_id) {
          if (task.list_id !== listId) return false;
        } else {
          const list = getListRecord(listId);
          if (!list || list.kind !== 'inbox') return false;
        }
      }
      if (groupId && task.group_id !== groupId) return false;
      if (from || to) {
        const anchor = taskAnchorLocalDate(task, timeZone);
        if (!anchor) return false;
        if (from && anchor < from) return false;
        if (to && anchor > to) return false;
      }
      if (q) {
        const haystack = `${task.title ?? ''}\n${task.notes ?? ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    };
    const openScoped = ctx.tasks.filter((task) => isOpen(task) && !task.archived_at && matchesFilters(task));
    const counts = computeCounts(openScoped, ctx);

    let rows;
    if (view === 'trash') {
      rows = ctx.rawTasks.filter((task) => task.deleted_at && matchesFilters(task));
      rows.sort((a, b) => compareNullableDesc(a.deleted_at, b.deleted_at) || String(a.id).localeCompare(String(b.id)));
    } else if (view === 'done') {
      rows = ctx.tasks.filter((task) => task.status === 'done' && matchesFilters(task));
      rows.sort(
        (a, b) =>
          compareNullableDesc(a.completed_at, b.completed_at) ||
          (PRIORITY_WEIGHT[b.priority] ?? 0) - (PRIORITY_WEIGHT[a.priority] ?? 0) ||
          String(a.id).localeCompare(String(b.id)),
      );
    } else {
      rows = openScoped.filter((task) => matchesView(task, view, ctx)).slice().sort(sortDefault);
    }

    const startIndex = cursor ? Math.max(0, rows.findIndex((task) => task.id === cursor) + 1) : 0;
    const page = rows.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < rows.length ? page[page.length - 1]?.id ?? null : null;

    const groups = [];
    for (const key of TASK_GROUP_KEYS) {
      const groupTasks = openScoped.filter((task) => groupOf(task, ctx) === key);
      if (groupTasks.length === 0) continue;
      groups.push({ key, count: groupTasks.length, taskIds: groupTasks.map((task) => task.id), items: groupTasks.map((task) => taskLite(task, ctx)) });
    }

    return { items: page.map((task) => taskLite(task, ctx)), groups, nextCursor, counts, view, limit, lists };
  }

  /** null 排最后、非 null 按降序比较（done/trash 排序用）。 */
  function compareNullableDesc(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (a === b) return 0;
    return a < b ? 1 : -1;
  }

  function getTaskDetail(id) {
    const task = getTaskRecord(id);
    if (!task) return null;
    const ctx = snapshot();
    const children = ctx.tasks
      .filter((child) => child.parent_task_id === id && !child.archived_at)
      .sort(sortDefault)
      .map((child) => taskLite(child, ctx));
    const path = [];
    const seen = new Set([id]);
    let cursorTask = task;
    while (cursorTask) {
      path.unshift({ id: cursorTask.id, title: cursorTask.title });
      const parentId = cursorTask.parent_task_id;
      if (!parentId || seen.has(parentId)) break;
      seen.add(parentId);
      cursorTask = getTaskRecord(parentId);
    }
    return { task: taskLite(task, ctx), children, path };
  }

  function getTask(id) {
    const task = getTaskRecord(id);
    if (!task) return null;
    return taskLite(task, snapshot());
  }

  /* ── 写工具 ─────────────────────────────────────────────── */

  function assertWritable() {
    if (store.degraded === true) throw new LifeosError('store_unavailable', '存储不可用（只读降级）');
  }

  function readForWrite(id, expectedRev) {
    assertWritable();
    if (!Number.isInteger(expectedRev) || expectedRev < 1) {
      throw new LifeosError('validation_failed', '写操作必须提供正整数 expectedRev（If-Match）', {
        errors: ['expectedRev 缺失或非法'],
      });
    }
    const task = getTaskRecord(id);
    if (!task) throw new LifeosError('not_found', `任务不存在：${id}`, { id });
    if (task.rev !== expectedRev) {
      throw new LifeosError('conflict', '任务已被修改，请刷新后重试', {
        current: taskLite(task, snapshot()),
        expectedRev,
        currentRev: task.rev,
      });
    }
    return task;
  }

  function stateChangeRecords(taskId, diffs, nowIso, revAfter) {
    return diffs.map((diff) => ({
      id: newId('stc'),
      entity_type: 'task',
      entity_id: taskId,
      field: diff.field,
      old_value: diff.oldValue === undefined ? null : diff.oldValue,
      new_value: diff.newValue === undefined ? null : diff.newValue,
      changed_at: nowIso,
      actor_type: actorType,
      actor_ref: null,
      origin_type: 'user_stated',
      reason: null,
      permission_id: null,
      operation_log_id: null,
      rev_after: revAfter,
      reversible: true,
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      schema_version: 1,
      meta_json: null,
    }));
  }

  function oplogRecord({ action, taskId, targetType = 'task', before, after, stateChangeIds, nowIso, idempotencyKey, targetIds }) {
    return {
      id: newId('opl'),
      actor_type: actorType,
      actor_ref: null,
      action,
      target_type: targetType,
      target_id: taskId,
      target_ids_json: Array.isArray(targetIds) ? targetIds : [taskId],
      permission_id: null,
      permission_level: 'L2',
      decision: 'allowed',
      status: 'applied',
      before_json: before ?? null,
      after_json: after ?? null,
      diff_json: null,
      state_change_ids: stateChangeIds,
      evidence_refs: [],
      undo_of_id: null,
      reversible: true,
      undo_patch_json: null,
      reason: null,
      idempotency_key: typeof idempotencyKey === 'string' && idempotencyKey.length > 0 ? idempotencyKey : null,
      occurred_at: nowIso,
      duration_ms: null,
      error: null,
      meta_json: { source: 'm1' },
    };
  }

  async function commit(ops, { kind, taskId, extra }) {
    await store.transaction(ops);
    emitChanged(kind, [taskId], extra);
    return { ops: ops.length };
  }

  function makeTaskRecord(input, ctx, nowIso) {
    const time = normalizeTime(null, input);
    if (time.errors.length > 0) throw new LifeosError('validation_failed', '时间字段不合法', { errors: time.errors });
    const repeat = normalizeRepeatRule(input.repeatRule);
    if (!repeat.ok) throw new LifeosError('validation_failed', 'repeatRule 不合法', { errors: repeat.errors });
    const record = {
      id: newId('tsk'),
      title: input.title,
      notes: input.notes ?? null,
      work_kind: 'action',
      time_kind: time.fields.time_kind,
      scheduled_date: time.fields.scheduled_date,
      scheduled_start_at: time.fields.scheduled_start_at,
      scheduled_end_at: time.fields.scheduled_end_at,
      scheduled_tz: time.fields.scheduled_tz,
      is_all_day: time.fields.is_all_day,
      due_date: time.fields.due_date,
      due_at: time.fields.due_at,
      due_tz: time.fields.due_tz,
      status: 'todo',
      priority: input.priority ?? 'none',
      project_id: input.projectId ?? null,
      goal_id: null,
      parent_task_id: input.parentTaskId ?? null,
      list_id: input.listId ?? null,
      group_id: input.groupId ?? null,
      pinned: input.pinned === true,
      estimate_minutes: null,
      completed_at: null,
      completed_origin: null,
      cancelled_at: null,
      cancelled_reason: null,
      archived_at: null,
      recurrence_rule: null,
      recurrence_tz: null,
      repeat_rule: repeat.value,
      sort_order: Number.isInteger(input.sortOrder) ? input.sortOrder : 0,
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      deleted_at: null,
      origin_type: 'user_stated',
      origin_ref: null,
      origin_key: null,
      confidence: null,
      confirmation_status: 'not_required',
      evidence_refs: [],
      schema_version: 1,
      meta_json: { source: 'm1' },
    };
    return record;
  }

  function assertProjectExists(projectId) {
    if (!projectId) return;
    if (!getProjectRecord(projectId)) throw new LifeosError('validation_failed', `项目不存在：${projectId}`, { projectId });
  }

  function assertTagsExist(tagIds) {
    for (const tagId of tagIds || []) {
      if (!getTagRecord(tagId)) throw new LifeosError('validation_failed', `标签不存在：${tagId}`, { tagId });
    }
  }

  function entityTagOps(taskId, fromTagIds, toTagIds, nowIso) {
    const ops = [];
    const from = new Set(fromTagIds || []);
    const to = new Set(toTagIds || []);
    for (const link of allEntityTags()) {
      if (link.entity_type !== 'task' || link.entity_id !== taskId) continue;
      if (!to.has(link.tag_id)) ops.push({ unit: CORE, table: 'entity_tag', key: link.id, value: null });
    }
    const existing = new Set(
      allEntityTags()
        .filter((link) => link.entity_type === 'task' && link.entity_id === taskId)
        .map((link) => link.tag_id),
    );
    for (const tagId of to) {
      if (from.has(tagId) && existing.has(tagId)) continue;
      if (existing.has(tagId)) continue;
      const linkId = newId('etag');
      ops.push({
        unit: CORE,
        table: 'entity_tag',
        key: linkId,
        value: {
          id: linkId,
          tag_id: tagId,
          entity_type: 'task',
          entity_id: taskId,
          created_at: nowIso,
          updated_at: nowIso,
          rev: 1,
          schema_version: 1,
          meta_json: null,
        },
      });
    }
    return ops;
  }

  /* ── 公开方法 ──────────────────────────────────────────── */

  function createTask(input) {
    assertWritable();
    if (!input || typeof input !== 'object' || typeof input.title !== 'string' || input.title.trim().length === 0) {
      throw new LifeosError('validation_failed', 'title 必填', { errors: ['title 必填'] });
    }
    assertProjectExists(input.projectId);
    assertTagsExist(input.tagIds);
    const placementInput = {};
    for (const key of ['listId', 'groupId', 'parentTaskId']) {
      if (Object.prototype.hasOwnProperty.call(input, key)) placementInput[key] = input[key] ?? null;
    }
    const placement = resolvePlacement(placementInput);
    if (placement.parentTaskId) {
      const parent = getTaskRecord(placement.parentTaskId);
      if (parent && depthOf(parent) + 1 > 3) {
        throw new LifeosError('invalid_state', '任务层级最多 3 层', { maxDepth: 3, parentTaskId: placement.parentTaskId });
      }
    }
    const nowIso = iso(now());
    const ctx = snapshot();
    const record = makeTaskRecord({ ...input, ...placement, title: input.title.trim() }, ctx, nowIso);
    const createdChange = {
      id: newId('stc'),
      entity_type: 'task',
      entity_id: record.id,
      field: '__created__',
      old_value: null,
      new_value: { title: record.title, status: record.status },
      changed_at: nowIso,
      actor_type: actorType,
      actor_ref: null,
      origin_type: 'user_stated',
      reason: null,
      permission_id: null,
      operation_log_id: null,
      rev_after: 1,
      reversible: true,
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      schema_version: 1,
      meta_json: null,
    };
    const oplog = oplogRecord({
      action: 'task.create',
      taskId: record.id,
      before: null,
      after: { title: record.title, status: record.status },
      stateChangeIds: [createdChange.id],
      nowIso,
      idempotencyKey: input.idempotencyKey,
    });
    const ops = [
      { unit: CORE, table: 'task', key: record.id, value: record },
      { unit: LOG, table: 'state_change', key: createdChange.id, value: createdChange },
      ...entityTagOps(record.id, [], input.tagIds, nowIso),
      { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
    ];
    return commit(ops, { kind: 'task', taskId: record.id, extra: { action: 'create' } }).then(async () => {
      await notifyTaskWrite(record, 'create');
      return {
        task: taskLite(record, snapshot()),
        rev: record.rev,
      };
    });
  }

  function updateTask(id, patch, expectedRev) {
    const current = readForWrite(id, expectedRev);
    const nowIso = iso(now());
    const time = normalizeTime(current, patch);
    if (time.errors.length > 0) throw new LifeosError('validation_failed', '时间字段不合法', { errors: time.errors });
    if (patch.projectId) assertProjectExists(patch.projectId);
    if (patch.tagIds) assertTagsExist(patch.tagIds);
    if (patch.repeatRule !== undefined) {
      const repeat = normalizeRepeatRule(patch.repeatRule);
      if (!repeat.ok) throw new LifeosError('validation_failed', 'repeatRule 不合法', { errors: repeat.errors });
      patch = { ...patch, repeatRule: repeat.value };
    }

    const hierarchyKeys = ['listId', 'groupId', 'parentTaskId'];
    if (hierarchyKeys.some((key) => Object.prototype.hasOwnProperty.call(patch, key))) {
      const placementInput = {};
      for (const key of hierarchyKeys) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) placementInput[key] = patch[key] ?? null;
      }
      const placement = resolvePlacement({ task: current, ...placementInput });
      if (placement.parentTaskId) {
        const parent = getTaskRecord(placement.parentTaskId);
        if (parent && depthOf(parent) + 1 > 3) {
          throw new LifeosError('invalid_state', '任务层级最多 3 层', { maxDepth: 3, parentTaskId: placement.parentTaskId });
        }
      }
      patch = { ...patch, listId: placement.listId, groupId: placement.groupId, parentTaskId: placement.parentTaskId };
    }

    const fieldMap = {
      title: 'title',
      notes: 'notes',
      priority: 'priority',
      projectId: 'project_id',
      listId: 'list_id',
      groupId: 'group_id',
      parentTaskId: 'parent_task_id',
      pinned: 'pinned',
      sortOrder: 'sort_order',
      repeatRule: 'repeat_rule',
    };
    const next = { ...current, ...time.fields, updated_at: nowIso, rev: current.rev + 1 };
    const diffs = [];
    for (const [inputKey, column] of Object.entries(fieldMap)) {
      if (!Object.prototype.hasOwnProperty.call(patch, inputKey)) continue;
      const nextValue = patch[inputKey] === undefined ? current[column] : patch[inputKey];
      if (current[column] !== nextValue) {
        diffs.push({ field: column, oldValue: current[column] ?? null, newValue: nextValue ?? null });
        next[column] = nextValue;
      }
    }
    for (const column of [
      'scheduled_date',
      'scheduled_start_at',
      'scheduled_end_at',
      'due_date',
      'due_at',
      'is_all_day',
      'time_kind',
    ]) {
      if (current[column] !== next[column]) diffs.push({ field: column, oldValue: current[column] ?? null, newValue: next[column] ?? null });
    }
    if (patch.tagIds) {
      const existing = (snapshot().tagsByTask.get(id) || []).slice().sort();
      const desired = [...new Set(patch.tagIds)].sort();
      if (existing.join(',') !== desired.join(',')) {
        diffs.push({ field: 'tag_ids', oldValue: existing, newValue: desired });
      }
    }
    if (diffs.length === 0) return { task: taskLite(current, snapshot()), rev: current.rev };

    const stateChanges = stateChangeRecords(id, diffs, nowIso, next.rev);
    const oplog = oplogRecord({
      action: 'task.update',
      taskId: id,
      before: Object.fromEntries(diffs.map((diff) => [diff.field, diff.oldValue])),
      after: Object.fromEntries(diffs.map((diff) => [diff.field, diff.newValue])),
      stateChangeIds: stateChanges.map((record) => record.id),
      nowIso,
      idempotencyKey: patch.idempotencyKey,
    });
    const ops = [
      { unit: CORE, table: 'task', key: id, value: next },
      ...(patch.tagIds ? entityTagOps(id, currentTagIds(id), patch.tagIds, nowIso) : []),
      ...stateChanges.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
      { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
    ];
    return commit(ops, { kind: 'task', taskId: id, extra: { action: 'update' } }).then(async () => {
      await notifyTaskWrite(next, 'update');
      return {
        task: taskLite(next, snapshot()),
        rev: next.rev,
      };
    });
  }

  function currentTagIds(taskId) {
    return allEntityTags()
      .filter((link) => link.entity_type === 'task' && link.entity_id === taskId)
      .map((link) => link.tag_id);
  }

  function runAction(id, action, expectedRev) {
    const current = readForWrite(id, expectedRev);
    assertTransition(current, action);
    const nowIso = iso(now());
    const patch = applyAction(current, action, nowIso);
    const next = { ...current, ...patch, updated_at: nowIso, rev: current.rev + 1 };
    const diffs = Object.keys(patch)
      .filter((column) => (current[column] ?? null) !== (next[column] ?? null))
      .map((column) => ({ field: column, oldValue: current[column] ?? null, newValue: next[column] ?? null }));
    const stateChanges = stateChangeRecords(id, diffs, nowIso, next.rev);
    const oplog = oplogRecord({
      action: `task.${action}`,
      taskId: id,
      before: { status: current.status },
      after: { status: next.status },
      stateChangeIds: stateChanges.map((record) => record.id),
      nowIso,
    });
    const ops = [
      { unit: CORE, table: 'task', key: id, value: next },
      ...stateChanges.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
      { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
    ];
    return commit(ops, { kind: 'task', taskId: id, extra: { action } }).then(async () => {
      await notifyTaskWrite(next, action);
      return { task: taskLite(next, snapshot()) };
    });
  }

  function completeTask(id, expectedRev) {
    return runAction(id, 'complete', expectedRev);
  }
  function reopenTask(id, expectedRev) {
    return runAction(id, 'reopen', expectedRev);
  }
  function cancelTask(id, expectedRev) {
    return runAction(id, 'cancel', expectedRev);
  }

  function rescheduleTask(id, input, expectedRev) {
    const current = readForWrite(id, expectedRev);
    const nowIso = iso(now());
    const time = normalizeTime(current, input);
    if (time.errors.length > 0) throw new LifeosError('validation_failed', '时间字段不合法', { errors: time.errors });
    const next = { ...current, ...time.fields, updated_at: nowIso, rev: current.rev + 1 };
    const diffs = [];
    for (const column of ['scheduled_date', 'scheduled_start_at', 'scheduled_end_at', 'due_date', 'due_at', 'is_all_day', 'time_kind']) {
      if (current[column] !== next[column]) diffs.push({ field: column, oldValue: current[column] ?? null, newValue: next[column] ?? null });
    }
    if (diffs.length === 0) return { task: taskLite(current, snapshot()) };
    const stateChanges = stateChangeRecords(id, diffs, nowIso, next.rev);
    const oplog = oplogRecord({
      action: 'task.reschedule',
      taskId: id,
      before: Object.fromEntries(diffs.map((diff) => [diff.field, diff.oldValue])),
      after: Object.fromEntries(diffs.map((diff) => [diff.field, diff.newValue])),
      stateChangeIds: stateChanges.map((record) => record.id),
      nowIso,
    });
    const ops = [
      { unit: CORE, table: 'task', key: id, value: next },
      ...stateChanges.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
      { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
    ];
    return commit(ops, { kind: 'task', taskId: id, extra: { action: 'reschedule' } }).then(async () => {
      await notifyTaskWrite(next, 'reschedule');
      return {
        task: taskLite(next, snapshot()),
      };
    });
  }

  /* ── M6：清单 / 分组 / 任务补充操作 ───────────────────────── */

  function listSummaryOf(record) {
    return listSummaries().find((item) => item.id === record.id) || { ...listLite(record), count: 0, openCount: 0, doneCount: 0 };
  }

  function groupSummaryOf(record) {
    return groupSummaries(record.list_id).find((item) => item.id === record.id) || { ...groupLite(record), count: 0, openCount: 0 };
  }

  function readListForWrite(id, expectedRev) {
    assertWritable();
    if (!Number.isInteger(expectedRev) || expectedRev < 1) {
      throw new LifeosError('validation_failed', '写操作必须提供正整数 expectedRev（If-Match）', { errors: ['expectedRev 缺失或非法'] });
    }
    const record = getListRecord(id);
    if (!record) throw new LifeosError('not_found', `清单不存在：${id}`, { id });
    if (record.rev !== expectedRev) {
      throw new LifeosError('conflict', '清单已被修改，请刷新后重试', {
        current: listSummaryOf(record),
        expectedRev,
        currentRev: record.rev,
      });
    }
    return record;
  }

  function readGroupForWrite(id, expectedRev) {
    assertWritable();
    if (!Number.isInteger(expectedRev) || expectedRev < 1) {
      throw new LifeosError('validation_failed', '写操作必须提供正整数 expectedRev（If-Match）', { errors: ['expectedRev 缺失或非法'] });
    }
    const record = getGroupRecord(id);
    if (!record) throw new LifeosError('not_found', `分组不存在：${id}`, { id });
    if (record.rev !== expectedRev) {
      throw new LifeosError('conflict', '分组已被修改，请刷新后重试', {
        current: groupSummaryOf(record),
        expectedRev,
        currentRev: record.rev,
      });
    }
    return record;
  }

  async function createList(input = {}) {
    assertWritable();
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new LifeosError('validation_failed', 'name 必填', { errors: ['name 必填'] });
    if (name.length > 100) throw new LifeosError('validation_failed', 'name 过长', { errors: ['name ≤ 100'] });
    const duplicate = allLists().find((list) => String(list.name).toLowerCase() === name.toLowerCase());
    if (duplicate) throw new LifeosError('conflict', `清单已存在：${name}`, { current: listLite(duplicate) });
    const nowIso = iso(now());
    const maxOrder = allLists().reduce((max, list) => Math.max(max, list.sort_order ?? 0), 0);
    const record = {
      id: newId('lst'),
      name,
      kind: 'normal',
      color: input.color ?? null,
      icon: input.icon ?? null,
      sort_order: Number.isInteger(input.sortOrder) ? input.sortOrder : maxOrder + 1,
      is_default: false,
      created_at: nowIso,
      updated_at: nowIso,
      archived_at: null,
      rev: 1,
      deleted_at: null,
      origin_type: 'user_stated',
      origin_ref: null,
      origin_key: null,
      confidence: null,
      confirmation_status: 'not_required',
      evidence_refs: [],
      schema_version: 1,
      meta_json: null,
    };
    const oplog = genericOplog({
      action: 'list.create',
      targetType: 'list',
      targetId: record.id,
      before: null,
      after: { name: record.name },
      nowIso,
    });
    await store.transaction([
      { unit: CORE, table: 'list', key: record.id, value: record },
      { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
    ]);
    emitChanged('list', [record.id], { action: 'create' });
    return { list: { ...listLite(record), count: 0, openCount: 0, doneCount: 0 } };
  }

  async function updateList(id, patch = {}, expectedRev) {
    const current = readListForWrite(id, expectedRev);
    const nowIso = iso(now());
    const next = { ...current, updated_at: nowIso, rev: current.rev + 1 };
    const diffs = [];
    const fieldMap = { name: 'name', color: 'color', icon: 'icon', sortOrder: 'sort_order' };
    for (const [inputKey, column] of Object.entries(fieldMap)) {
      if (!Object.prototype.hasOwnProperty.call(patch, inputKey)) continue;
      let value = patch[inputKey];
      if (inputKey === 'name') {
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new LifeosError('validation_failed', 'name 必填', { errors: ['name 必填'] });
        }
        value = value.trim();
        if (value.length > 100) throw new LifeosError('validation_failed', 'name 过长', { errors: ['name ≤ 100'] });
        const duplicate = allLists().find((list) => list.id !== id && String(list.name).toLowerCase() === value.toLowerCase());
        if (duplicate) throw new LifeosError('conflict', `清单已存在：${value}`, { current: listLite(duplicate) });
      }
      if (inputKey === 'sortOrder' && !Number.isInteger(value)) continue;
      if ((current[column] ?? null) !== (value ?? null)) {
        diffs.push({ field: column, oldValue: current[column] ?? null, newValue: value ?? null });
        next[column] = value ?? null;
      }
    }
    if (diffs.length === 0) return { list: listSummaryOf(current) };
    const oplog = genericOplog({
      action: 'list.update',
      targetType: 'list',
      targetId: id,
      before: Object.fromEntries(diffs.map((diff) => [diff.field, diff.oldValue])),
      after: Object.fromEntries(diffs.map((diff) => [diff.field, diff.newValue])),
      nowIso,
    });
    await store.transaction([
      { unit: CORE, table: 'list', key: id, value: next },
      { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
    ]);
    emitChanged('list', [id], { action: 'update' });
    return { list: listSummaryOf(next) };
  }

  async function deleteList(id, input = {}) {
    const current = readListForWrite(id, input.expectedRev);
    /* 收集箱视图=无清单任务，默认 inbox 清单只是 M1 seed 的普通记录，可删除（任务回到收集箱） */
    const nowIso = iso(now());
    let moveTo = Object.prototype.hasOwnProperty.call(input, 'moveTo') ? input.moveTo : null;
    if (moveTo) {
      const target = getListRecord(moveTo);
      if (!target) throw new LifeosError('validation_failed', `目标清单不存在：${moveTo}`, { moveTo });
      if (target.id === id) throw new LifeosError('validation_failed', '不能移动到自身', { moveTo });
      if (target.kind === 'inbox') moveTo = null; // 收集箱 = 无清单
    } else {
      moveTo = null;
    }
    const ctx = snapshot();
    const ops = [];
    let movedTasks = 0;
    for (const task of ctx.rawTasks) {
      if (task.list_id !== id) continue;
      ops.push({
        unit: CORE,
        table: 'task',
        key: task.id,
        value: { ...task, list_id: moveTo ?? null, group_id: null, updated_at: nowIso, rev: (task.rev ?? 1) + 1 },
      });
      movedTasks += 1;
    }
    let deletedGroups = 0;
    for (const group of allGroups().filter((item) => item.list_id === id)) {
      ops.push({
        unit: CORE,
        table: 'group',
        key: group.id,
        value: { ...group, deleted_at: nowIso, updated_at: nowIso, rev: (group.rev ?? 1) + 1 },
      });
      deletedGroups += 1;
    }
    ops.push({
      unit: CORE,
      table: 'list',
      key: id,
      value: { ...current, deleted_at: nowIso, archived_at: nowIso, updated_at: nowIso, rev: current.rev + 1 },
    });
    const oplog = genericOplog({
      action: 'list.delete',
      targetType: 'list',
      targetId: id,
      before: { name: current.name },
      after: { moveTo: moveTo ?? null, movedTasks, deletedGroups },
      nowIso,
    });
    ops.push({ unit: LOG, table: 'operation_log', key: oplog.id, value: oplog });
    await store.transaction(ops);
    emitChanged('list', [id], { action: 'delete' });
    return { listId: id, moveTo: moveTo ?? null, movedTasks, deletedGroups };
  }

  async function reorderLists(input = {}) {
    assertWritable();
    const ids = Array.isArray(input.ids) ? input.ids : [];
    if (ids.length === 0) throw new LifeosError('validation_failed', 'ids 必填', { errors: ['ids 必填'] });
    const expectedRevs = input.expectedRevs && typeof input.expectedRevs === 'object' ? input.expectedRevs : null;
    const nowIso = iso(now());
    const ops = [];
    const seen = new Set();
    for (let index = 0; index < ids.length; index += 1) {
      const listId = ids[index];
      if (typeof listId !== 'string' || seen.has(listId)) {
        throw new LifeosError('validation_failed', 'ids 非法或重复', { errors: ['ids 非法或重复'] });
      }
      seen.add(listId);
      const record = getListRecord(listId);
      if (!record) throw new LifeosError('not_found', `清单不存在：${listId}`, { id: listId });
      if (expectedRevs && expectedRevs[listId] !== undefined && Number(expectedRevs[listId]) !== record.rev) {
        throw new LifeosError('conflict', '清单已被修改，请刷新后重试', {
          current: listLite(record),
          expectedRev: Number(expectedRevs[listId]),
          currentRev: record.rev,
        });
      }
      ops.push({ unit: CORE, table: 'list', key: listId, value: { ...record, sort_order: index, updated_at: nowIso, rev: record.rev + 1 } });
    }
    const oplog = genericOplog({ action: 'list.reorder', targetType: 'list', targetId: ids[0], before: null, after: { ids }, nowIso, targetIds: ids });
    ops.push({ unit: LOG, table: 'operation_log', key: oplog.id, value: oplog });
    await store.transaction(ops);
    emitChanged('list', ids, { action: 'reorder' });
    return { items: listSummaries() };
  }

  async function getListGroups(listId) {
    const list = getListRecord(listId);
    if (!list) throw new LifeosError('not_found', `清单不存在：${listId}`, { id: listId });
    return { list: listSummaryOf(list), items: groupSummaries(listId) };
  }

  function listLists() {
    return { items: listSummaries() };
  }

  function assertGroupName(listId, name, ignoreId) {
    if (!name) throw new LifeosError('validation_failed', 'name 必填', { errors: ['name 必填'] });
    if (name.length > 100) throw new LifeosError('validation_failed', 'name 过长', { errors: ['name ≤ 100'] });
    const duplicate = allGroups().find(
      (group) => group.list_id === listId && group.id !== ignoreId && String(group.name).toLowerCase() === name.toLowerCase(),
    );
    if (duplicate) throw new LifeosError('conflict', `分组已存在：${name}`, { current: groupLite(duplicate) });
  }

  async function createGroup(listId, input = {}) {
    assertWritable();
    const list = getListRecord(listId);
    if (!list) throw new LifeosError('not_found', `清单不存在：${listId}`, { id: listId });
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    assertGroupName(listId, name, null);
    const nowIso = iso(now());
    const maxOrder = allGroups()
      .filter((group) => group.list_id === listId)
      .reduce((max, group) => Math.max(max, group.sort_order ?? 0), 0);
    const record = {
      id: newId('grp'),
      list_id: listId,
      name,
      color: input.color ?? null,
      icon: input.icon ?? null,
      sort_order: Number.isInteger(input.sortOrder) ? input.sortOrder : maxOrder + 1,
      collapsed: input.collapsed === true,
      created_at: nowIso,
      updated_at: nowIso,
      archived_at: null,
      rev: 1,
      deleted_at: null,
      origin_type: 'user_stated',
      origin_ref: null,
      origin_key: null,
      confidence: null,
      confirmation_status: 'not_required',
      evidence_refs: [],
      schema_version: 1,
      meta_json: null,
    };
    const oplog = genericOplog({ action: 'group.create', targetType: 'group', targetId: record.id, before: null, after: { name: record.name, listId }, nowIso });
    await store.transaction([
      { unit: CORE, table: 'group', key: record.id, value: record },
      { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
    ]);
    emitChanged('group', [record.id], { action: 'create', listId });
    return { group: { ...groupLite(record), count: 0, openCount: 0 } };
  }

  async function updateGroup(id, patch = {}, expectedRev) {
    const current = readGroupForWrite(id, expectedRev);
    const nowIso = iso(now());
    const next = { ...current, updated_at: nowIso, rev: current.rev + 1 };
    const diffs = [];
    const fieldMap = { name: 'name', color: 'color', icon: 'icon', collapsed: 'collapsed', sortOrder: 'sort_order' };
    for (const [inputKey, column] of Object.entries(fieldMap)) {
      if (!Object.prototype.hasOwnProperty.call(patch, inputKey)) continue;
      let value = patch[inputKey];
      if (inputKey === 'name') {
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new LifeosError('validation_failed', 'name 必填', { errors: ['name 必填'] });
        }
        value = value.trim();
        assertGroupName(current.list_id, value, id);
      }
      if (inputKey === 'collapsed' && typeof value !== 'boolean') continue;
      if (inputKey === 'sortOrder' && !Number.isInteger(value)) continue;
      if ((current[column] ?? null) !== (value ?? null)) {
        diffs.push({ field: column, oldValue: current[column] ?? null, newValue: value ?? null });
        next[column] = value ?? null;
      }
    }
    if (diffs.length === 0) return { group: groupSummaryOf(current) };
    const oplog = genericOplog({
      action: 'group.update',
      targetType: 'group',
      targetId: id,
      before: Object.fromEntries(diffs.map((diff) => [diff.field, diff.oldValue])),
      after: Object.fromEntries(diffs.map((diff) => [diff.field, diff.newValue])),
      nowIso,
    });
    await store.transaction([
      { unit: CORE, table: 'group', key: id, value: next },
      { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
    ]);
    emitChanged('group', [id], { action: 'update' });
    return { group: groupSummaryOf(next) };
  }

  async function deleteGroup(id, input = {}) {
    const current = readGroupForWrite(id, input.expectedRev);
    const nowIso = iso(now());
    let moveTo = Object.prototype.hasOwnProperty.call(input, 'moveTo') ? input.moveTo : null;
    if (moveTo) {
      const target = getGroupRecord(moveTo);
      if (!target) throw new LifeosError('validation_failed', `目标分组不存在：${moveTo}`, { moveTo });
      if (target.id === id) throw new LifeosError('validation_failed', '不能移动到自身', { moveTo });
      if (target.list_id !== current.list_id) throw new LifeosError('validation_failed', '目标分组不在同一清单', { moveTo });
    } else {
      moveTo = null;
    }
    const ctx = snapshot();
    const ops = [];
    let movedTasks = 0;
    for (const task of ctx.rawTasks) {
      if (task.group_id !== id) continue;
      ops.push({
        unit: CORE,
        table: 'task',
        key: task.id,
        value: { ...task, group_id: moveTo ?? null, updated_at: nowIso, rev: (task.rev ?? 1) + 1 },
      });
      movedTasks += 1;
    }
    ops.push({
      unit: CORE,
      table: 'group',
      key: id,
      value: { ...current, deleted_at: nowIso, updated_at: nowIso, rev: current.rev + 1 },
    });
    const oplog = genericOplog({
      action: 'group.delete',
      targetType: 'group',
      targetId: id,
      before: { name: current.name },
      after: { moveTo: moveTo ?? null, movedTasks },
      nowIso,
    });
    ops.push({ unit: LOG, table: 'operation_log', key: oplog.id, value: oplog });
    await store.transaction(ops);
    emitChanged('group', [id], { action: 'delete' });
    return { groupId: id, moveTo: moveTo ?? null, movedTasks };
  }

  async function reorderGroups(input = {}) {
    assertWritable();
    const ids = Array.isArray(input.ids) ? input.ids : [];
    if (ids.length === 0) throw new LifeosError('validation_failed', 'ids 必填', { errors: ['ids 必填'] });
    const expectedRevs = input.expectedRevs && typeof input.expectedRevs === 'object' ? input.expectedRevs : null;
    const nowIso = iso(now());
    const ops = [];
    const seen = new Set();
    let listId = null;
    for (let index = 0; index < ids.length; index += 1) {
      const groupId = ids[index];
      if (typeof groupId !== 'string' || seen.has(groupId)) {
        throw new LifeosError('validation_failed', 'ids 非法或重复', { errors: ['ids 非法或重复'] });
      }
      seen.add(groupId);
      const record = getGroupRecord(groupId);
      if (!record) throw new LifeosError('not_found', `分组不存在：${groupId}`, { id: groupId });
      if (listId && record.list_id !== listId) {
        throw new LifeosError('validation_failed', 'ids 必须属于同一清单', { errors: ['ids 必须属于同一清单'] });
      }
      listId = record.list_id;
      if (expectedRevs && expectedRevs[groupId] !== undefined && Number(expectedRevs[groupId]) !== record.rev) {
        throw new LifeosError('conflict', '分组已被修改，请刷新后重试', {
          current: groupLite(record),
          expectedRev: Number(expectedRevs[groupId]),
          currentRev: record.rev,
        });
      }
      ops.push({ unit: CORE, table: 'group', key: groupId, value: { ...record, sort_order: index, updated_at: nowIso, rev: record.rev + 1 } });
    }
    const oplog = genericOplog({ action: 'group.reorder', targetType: 'group', targetId: ids[0], before: null, after: { ids }, nowIso, targetIds: ids });
    ops.push({ unit: LOG, table: 'operation_log', key: oplog.id, value: oplog });
    await store.transaction(ops);
    emitChanged('group', ids, { action: 'reorder' });
    return { items: groupSummaries(listId) };
  }

  async function moveTask(id, input = {}, expectedRev) {
    const current = readForWrite(id, expectedRev);
    const nowIso = iso(now());
    const placementInput = {};
    for (const key of ['listId', 'groupId', 'parentTaskId']) {
      if (Object.prototype.hasOwnProperty.call(input, key)) placementInput[key] = input[key] ?? null;
    }
    const placement = resolvePlacement({ task: current, ...placementInput });
    const subtree = subtreeOf(id);
    const movedDepth = placement.parentTaskId ? depthOf(getTaskRecord(placement.parentTaskId)) + 1 : 1;
    if (movedDepth + subtree.height - 1 > 3) {
      throw new LifeosError('invalid_state', '任务层级最多 3 层', { maxDepth: 3, id });
    }
    const next = {
      ...current,
      list_id: placement.listId,
      group_id: placement.groupId,
      parent_task_id: placement.parentTaskId,
      updated_at: nowIso,
      rev: current.rev + 1,
    };
    const diffs = [];
    for (const column of ['list_id', 'group_id', 'parent_task_id']) {
      if ((current[column] ?? null) !== (next[column] ?? null)) {
        diffs.push({ field: column, oldValue: current[column] ?? null, newValue: next[column] ?? null });
      }
    }
    if (diffs.length === 0) return { task: taskLite(current, snapshot()), moved: 0 };
    const stateChanges = stateChangeRecords(id, diffs, nowIso, next.rev);
    const ops = [{ unit: CORE, table: 'task', key: id, value: next }];
    let moved = 0;
    for (const childId of subtree.ids) {
      const child = getTaskRecord(childId);
      if (!child) continue;
      if ((child.list_id ?? null) === (placement.listId ?? null) && (child.group_id ?? null) === (placement.groupId ?? null)) continue;
      ops.push({
        unit: CORE,
        table: 'task',
        key: childId,
        value: { ...child, list_id: placement.listId, group_id: placement.groupId, updated_at: nowIso, rev: child.rev + 1 },
      });
      moved += 1;
    }
    ops.push(...stateChanges.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })));
    const oplog = oplogRecord({
      action: 'task.move',
      taskId: id,
      before: Object.fromEntries(diffs.map((diff) => [diff.field, diff.oldValue])),
      after: Object.fromEntries(diffs.map((diff) => [diff.field, diff.newValue])),
      stateChangeIds: stateChanges.map((record) => record.id),
      nowIso,
      targetIds: [id, ...subtree.ids],
    });
    ops.push({ unit: LOG, table: 'operation_log', key: oplog.id, value: oplog });
    await store.transaction(ops);
    emitChanged('task', [id, ...subtree.ids], { action: 'move' });
    await notifyTaskWrite(next, 'move');
    return { task: taskLite(next, snapshot()), moved };
  }

  async function duplicateTask(id, input = {}) {
    assertWritable();
    const source = getTaskRecord(id);
    if (!source) throw new LifeosError('not_found', `任务不存在：${id}`, { id });
    const nowIso = iso(now());
    const ctx = snapshot();
    const fallbackTitle = source.title ? `${source.title} (副本)` : '任务 (副本)';
    const requested = typeof input.title === 'string' && input.title.trim().length > 0 ? input.title.trim() : fallbackTitle;
    const title = requested.length > 500 ? requested.slice(0, 500) : requested;
    const timeInput = {};
    if (source.scheduled_start_at) {
      timeInput.scheduledStartAt = source.scheduled_start_at;
      if (source.scheduled_end_at) timeInput.scheduledEndAt = source.scheduled_end_at;
    } else if (source.scheduled_date) {
      timeInput.scheduledDate = source.scheduled_date;
    }
    if (source.due_at) timeInput.dueAt = source.due_at;
    else if (source.due_date) timeInput.dueDate = source.due_date;
    const record = makeTaskRecord(
      {
        ...timeInput,
        title,
        notes: source.notes ?? null,
        priority: source.priority,
        projectId: source.project_id,
        listId: source.list_id,
        groupId: source.group_id,
        parentTaskId: source.parent_task_id,
        pinned: false,
        sortOrder: (source.sort_order ?? 0) + 1,
      },
      ctx,
      nowIso,
    );
    const sourceTags = currentTagIds(id);
    const createdChange = {
      id: newId('stc'),
      entity_type: 'task',
      entity_id: record.id,
      field: '__created__',
      old_value: null,
      new_value: { title: record.title, status: record.status, duplicatedFrom: id },
      changed_at: nowIso,
      actor_type: actorType,
      actor_ref: null,
      origin_type: 'user_stated',
      reason: null,
      permission_id: null,
      operation_log_id: null,
      rev_after: 1,
      reversible: true,
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      schema_version: 1,
      meta_json: null,
    };
    const oplog = oplogRecord({
      action: 'task.duplicate',
      taskId: record.id,
      before: null,
      after: { title: record.title, sourceTaskId: id },
      stateChangeIds: [createdChange.id],
      nowIso,
      targetIds: [record.id, id],
    });
    await store.transaction([
      { unit: CORE, table: 'task', key: record.id, value: record },
      { unit: LOG, table: 'state_change', key: createdChange.id, value: createdChange },
      ...entityTagOps(record.id, [], sourceTags, nowIso),
      { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
    ]);
    emitChanged('task', [record.id], { action: 'duplicate', sourceTaskId: id });
    await notifyTaskWrite(record, 'duplicate');
    return { task: taskLite(record, snapshot()), sourceTaskId: id };
  }

  async function restoreTask(id, expectedRev) {
    assertWritable();
    if (!Number.isInteger(expectedRev) || expectedRev < 1) {
      throw new LifeosError('validation_failed', '写操作必须提供正整数 expectedRev（If-Match）', { errors: ['expectedRev 缺失或非法'] });
    }
    const current = getTaskAny(id);
    if (!current) throw new LifeosError('not_found', `任务不存在：${id}`, { id });
    if (!current.deleted_at) throw new LifeosError('invalid_state', '任务不在回收站', { id });
    if (current.rev !== expectedRev) {
      throw new LifeosError('conflict', '任务已被修改，请刷新后重试', {
        current: taskLite(current, snapshot()),
        expectedRev,
        currentRev: current.rev,
      });
    }
    const nowIso = iso(now());
    const next = { ...current, deleted_at: null, updated_at: nowIso, rev: current.rev + 1 };
    const stateChanges = stateChangeRecords(id, [{ field: 'deleted_at', oldValue: current.deleted_at, newValue: null }], nowIso, next.rev);
    const oplog = oplogRecord({
      action: 'task.restore',
      taskId: id,
      before: { deleted_at: current.deleted_at },
      after: { deleted_at: null },
      stateChangeIds: stateChanges.map((record) => record.id),
      nowIso,
    });
    await store.transaction([
      { unit: CORE, table: 'task', key: id, value: next },
      ...stateChanges.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
      { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
    ]);
    emitChanged('task', [id], { action: 'restore' });
    await notifyTaskWrite(next, 'restore');
    return { task: taskLite(next, snapshot()) };
  }

  async function deleteTask(id, input = {}) {
    assertWritable();
    const current = getTaskAny(id);
    if (!current) throw new LifeosError('not_found', `任务不存在：${id}`, { id });
    const expectedRev = input.expectedRev;
    if (!Number.isInteger(expectedRev) || expectedRev < 1) {
      throw new LifeosError('validation_failed', '写操作必须提供正整数 expectedRev（If-Match）', { errors: ['expectedRev 缺失或非法'] });
    }
    if (current.rev !== expectedRev) {
      throw new LifeosError('conflict', '任务已被修改，请刷新后重试', {
        current: taskLite(current, snapshot()),
        expectedRev,
        currentRev: current.rev,
      });
    }
    const nowIso = iso(now());
    const purge = input.purge === true || input.purge === 1;
    if (purge) {
      const oplog = oplogRecord({
        action: 'task.purge',
        taskId: id,
        before: { title: current.title, deletedAt: current.deleted_at ?? null },
        after: null,
        stateChangeIds: [],
        nowIso,
      });
      await store.transaction([
        { unit: CORE, table: 'task', key: id, value: null },
        ...entityTagOps(id, currentTagIds(id), [], nowIso),
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ]);
      emitChanged('task', [id], { action: 'purge' });
      return { purged: true, id, task: null };
    }
    const next = { ...current, deleted_at: nowIso, updated_at: nowIso, rev: current.rev + 1 };
    const stateChanges = stateChangeRecords(id, [{ field: 'deleted_at', oldValue: current.deleted_at ?? null, newValue: nowIso }], nowIso, next.rev);
    const oplog = oplogRecord({
      action: 'task.delete',
      taskId: id,
      before: { deleted_at: current.deleted_at ?? null },
      after: { deleted_at: nowIso },
      stateChangeIds: stateChanges.map((record) => record.id),
      nowIso,
    });
    await store.transaction([
      { unit: CORE, table: 'task', key: id, value: next },
      ...stateChanges.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
      { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
    ]);
    emitChanged('task', [id], { action: 'delete' });
    return { task: taskLite(next, snapshot()), rev: next.rev };
  }

  function getCalendar(fromLocalDate, toLocalDate, tz = timeZone) {
    const ctx = snapshot();
    const open = ctx.tasks.filter((task) => isOpen(task));
    const dayMap = new Map();
    for (const task of open) {
      const days = new Set();
      if (task.scheduled_date) days.add(task.scheduled_date);
      if (task.scheduled_start_at) {
        const day = localDateOfIsoSafe(tz, task.scheduled_start_at);
        if (day) days.add(day);
      }
      for (const day of days) {
        if (day < fromLocalDate || day > toLocalDate) continue;
        if (!dayMap.has(day)) dayMap.set(day, []);
        dayMap.get(day).push(taskLite(task, ctx));
      }
    }
    const days = [];
    let cursor = fromLocalDate;
    while (cursor <= toLocalDate) {
      const dayTasks = (dayMap.get(cursor) || []).slice().sort(sortDefault);
      days.push({
        date: cursor,
        tasks: dayTasks,
        timed: dayTasks.filter((task) => task.isAllDay !== true),
        allDay: dayTasks.filter((task) => task.isAllDay === true),
      });
      cursor = addOneDay(cursor);
    }
    const unscheduled = open
      .filter((task) => !task.scheduled_date && !task.scheduled_start_at)
      .sort(sortDefault)
      .map((task) => taskLite(task, ctx));
    return { days, unscheduled, from: fromLocalDate, to: toLocalDate };
  }

  function localDateOfIsoSafe(tz, isoValue) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(isoValue));
      const pick = (type) => parts.find((part) => part.type === type)?.value;
      return `${pick('year')}-${pick('month')}-${pick('day')}`;
    } catch {
      return null;
    }
  }

  function addOneDay(day) {
    const ms = Date.parse(`${day}T00:00:00Z`) + 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }

  /* ── 项目 / 标签 / 设置 ─────────────────────────────────── */

  function listProjects() {
    return { items: allProjects().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.created_at).localeCompare(String(b.created_at))).map(projectLite) };
  }

  function createProject(input) {
    assertWritable();
    const nowIso = iso(now());
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new LifeosError('validation_failed', 'name 必填', { errors: ['name 必填'] });
    const duplicate = allProjects().find((project) => String(project.name).toLowerCase() === name.toLowerCase());
    if (duplicate) throw new LifeosError('conflict', `项目已存在：${name}`, { current: projectLite(duplicate) });
    const record = {
      id: newId('prj'),
      name,
      color: input.color ?? null,
      status: 'active',
      sort_order: 0,
      progress_mode: 'auto_by_tasks',
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      deleted_at: null,
      origin_type: 'user_stated',
      origin_ref: null,
      origin_key: null,
      confidence: null,
      confirmation_status: 'not_required',
      evidence_refs: [],
      schema_version: 1,
      meta_json: null,
    };
    const oplog = {
      id: newId('opl'),
      actor_type: actorType,
      actor_ref: null,
      action: 'project.create',
      target_type: 'project',
      target_id: record.id,
      target_ids_json: [record.id],
      permission_level: 'L2',
      decision: 'allowed',
      status: 'applied',
      occurred_at: nowIso,
      reversible: true,
      evidence_refs: [],
      meta_json: { source: 'm1' },
    };
    return store
      .transaction([
        { unit: CORE, table: 'project', key: record.id, value: record },
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emitChanged('project', [record.id], { action: 'create' });
        return { project: projectLite(record) };
      });
  }

  function updateProject(id, patch, expectedRev) {
    assertWritable();
    if (!Number.isInteger(expectedRev) || expectedRev < 1) {
      throw new LifeosError('validation_failed', '写操作必须提供正整数 expectedRev（If-Match）', { errors: ['expectedRev 缺失'] });
    }
    const current = getProjectRecord(id);
    if (!current) throw new LifeosError('not_found', `项目不存在：${id}`, { id });
    if (current.rev !== expectedRev) {
      throw new LifeosError('conflict', '项目已被修改，请刷新后重试', { current: projectLite(current), expectedRev, currentRev: current.rev });
    }
    const nowIso = iso(now());
    const next = { ...current, updated_at: nowIso, rev: current.rev + 1 };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.color !== undefined) next.color = patch.color;
    if (patch.status !== undefined) next.status = patch.status;
    return store
      .transaction([{ unit: CORE, table: 'project', key: id, value: next }])
      .then(() => {
        emitChanged('project', [id], { action: 'update' });
        return { project: projectLite(next) };
      });
  }

  function listTags() {
    return { items: allTags().sort((a, b) => String(a.name).localeCompare(String(b.name))).map(tagLite) };
  }

  function createTag(input) {
    assertWritable();
    const nowIso = iso(now());
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new LifeosError('validation_failed', 'name 必填', { errors: ['name 必填'] });
    const duplicate = allTags().find((tag) => String(tag.name).toLowerCase() === name.toLowerCase());
    if (duplicate) throw new LifeosError('conflict', `标签已存在：${name}`, { current: tagLite(duplicate) });
    const record = {
      id: newId('tag'),
      name,
      color: input.color ?? null,
      usage_count: 0,
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      deleted_at: null,
      origin_type: 'user_stated',
      origin_ref: null,
      origin_key: null,
      confidence: null,
      confirmation_status: 'not_required',
      evidence_refs: [],
      schema_version: 1,
      meta_json: null,
    };
    return store
      .transaction([{ unit: CORE, table: 'tag', key: record.id, value: record }])
      .then(() => {
        emitChanged('tag', [record.id], { action: 'create' });
        return { tag: tagLite(record) };
      });
  }

  /** 标签写前校验：存在性 + 可选 CAS（expectedRev 为 null 时不做版本检查）。 */
  function readTagForWrite(id, expectedRev) {
    assertWritable();
    const current = getTagRecord(id);
    if (!current) throw new LifeosError('not_found', `标签不存在：${id}`, { id });
    if (expectedRev !== null && expectedRev !== undefined) {
      if (!Number.isInteger(expectedRev) || expectedRev < 1) {
        throw new LifeosError('validation_failed', 'expectedRev 必须是正整数', { errors: ['expectedRev 必须是正整数'] });
      }
      if (current.rev !== expectedRev) {
        throw new LifeosError('conflict', '标签已被修改，请刷新后重试', {
          current: tagLite(current),
          expectedRev,
          currentRev: current.rev,
        });
      }
    }
    return current;
  }

  /** PATCH /tags/:id：重命名 / 改颜色（可选 CAS）。 */
  function updateTag(id, patch, expectedRev = null) {
    const current = readTagForWrite(id, expectedRev);
    const nowIso = iso(now());
    const next = { ...current };
    const diffs = [];
    if (patch.name !== undefined) {
      const name = typeof patch.name === 'string' ? patch.name.trim() : '';
      if (!name) throw new LifeosError('validation_failed', 'name 必填', { errors: ['name 必填'] });
      if (name.length > 50) {
        throw new LifeosError('validation_failed', 'name 不能超过 50 字符', { errors: ['name 不能超过 50 字符'] });
      }
      const duplicate = allTags().find((tag) => tag.id !== id && String(tag.name).toLowerCase() === name.toLowerCase());
      if (duplicate) throw new LifeosError('conflict', `标签已存在：${name}`, { current: tagLite(duplicate) });
      if (name !== current.name) diffs.push({ field: 'name', oldValue: current.name, newValue: name });
      next.name = name;
    }
    if (patch.color !== undefined) {
      const color = patch.color === null ? null : patch.color;
      if (color !== null && (typeof color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(color))) {
        throw new LifeosError('validation_failed', 'color 必须是 #RRGGBB 格式或 null', {
          errors: ['color 必须是 #RRGGBB 格式或 null'],
        });
      }
      if (color !== (current.color ?? null)) diffs.push({ field: 'color', oldValue: current.color ?? null, newValue: color });
      next.color = color;
    }
    if (diffs.length === 0) return Promise.resolve({ tag: tagLite(current), revision: current.rev });
    next.updated_at = nowIso;
    next.rev = current.rev + 1;
    const oplog = oplogRecord({
      action: 'tag.update',
      targetType: 'tag',
      taskId: id,
      before: Object.fromEntries(diffs.map((diff) => [diff.field, diff.oldValue])),
      after: Object.fromEntries(diffs.map((diff) => [diff.field, diff.newValue])),
      nowIso,
    });
    return store
      .transaction([
        { unit: CORE, table: 'tag', key: id, value: next },
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emitChanged('tag', [id], { action: 'update' });
        return { tag: tagLite(next), revision: next.rev };
      });
  }

  /**
   * DELETE /tags/:id：删除标签记录，并清理所有任务与该标签的 entity_tag 关联；
   * 任务记录本身不动（GET /tasks、GET /tasks/:id 仍可读，tags 中不再出现该标签）。
   */
  function deleteTag(id, expectedRev = null) {
    const current = readTagForWrite(id, expectedRev);
    const nowIso = iso(now());
    const links = allEntityTags().filter((link) => link.tag_id === id);
    const ops = [{ unit: CORE, table: 'tag', key: id, value: null }];
    for (const link of links) ops.push({ unit: CORE, table: 'entity_tag', key: link.id, value: null });
    const oplog = oplogRecord({
      action: 'tag.delete',
      targetType: 'tag',
      taskId: id,
      before: { name: current.name, color: current.color ?? null, rev: current.rev },
      after: null,
      nowIso,
    });
    ops.push({ unit: LOG, table: 'operation_log', key: oplog.id, value: oplog });
    return store.transaction(ops).then(() => {
      emitChanged('tag', [id], { action: 'delete' });
      return { deleted: true, id };
    });
  }

  function readUiPrefs() {
    try {
      const record = store.get(CORE, 'app_setting', PREF_KEY);
      if (record && isPlainObject(record.value_json)) return { prefs: record.value_json, rev: record.rev ?? 1 };
    } catch {
      /* degraded / missing */
    }
    return { prefs: {}, rev: 1 };
  }

  function getUiPrefs() {
    return readUiPrefs();
  }

  function setUiPrefs(patch) {
    assertWritable();
    if (!isPlainObject(patch)) throw new LifeosError('validation_failed', 'prefs 必须是对象');
    const nowIso = iso(now());
    const current = readUiPrefs();
    const merged = { ...current.prefs, ...patch };
    const record = {
      key: PREF_KEY,
      id: PREF_KEY,
      value_json: merged,
      updated_at: nowIso,
    };
    return store
      .transaction([{ unit: CORE, table: 'app_setting', key: PREF_KEY, value: record }])
      .then(() => {
        emitChanged('ui_prefs', [], { keys: Object.keys(patch) });
        return { prefs: merged };
      });
  }

  function todayTasks() {
    const ctx = snapshot();
    const open = ctx.tasks.filter((task) => isOpen(task));
    const todayTasks = open
      .filter((task) => matchesView(task, 'today', ctx))
      .sort((a, b) => {
        const ta = a.scheduled_start_at ?? a.due_at ?? '';
        const tb = b.scheduled_start_at ?? b.due_at ?? '';
        if (ta !== tb) return ta === '' ? 1 : tb === '' ? -1 : ta < tb ? -1 : 1;
        return (PRIORITY_WEIGHT[b.priority] ?? 0) - (PRIORITY_WEIGHT[a.priority] ?? 0) || String(a.id).localeCompare(String(b.id));
      })
      .map((task) => taskLite(task, ctx));
    const overdue = open
      .filter((task) => matchesView(task, 'overdue', ctx))
      .sort(sortDefault)
      .map((task) => taskLite(task, ctx));
    return { todayTasks, overdue };
  }

  return {
    listTasks,
    getTask,
    getTaskDetail,
    createTask,
    updateTask,
    completeTask,
    reopenTask,
    cancelTask,
    rescheduleTask,
    moveTask,
    duplicateTask,
    restoreTask,
    deleteTask,
    getCalendar,
    listLists,
    createList,
    updateList,
    deleteList,
    reorderLists,
    getListGroups,
    createGroup,
    updateGroup,
    deleteGroup,
    reorderGroups,
    listProjects,
    createProject,
    updateProject,
    listTags,
    createTag,
    updateTag,
    deleteTag,
    getUiPrefs,
    setUiPrefs,
    todayTasks,
    // 供测试/调试
    _internals: {
      snapshot,
      taskLite,
      projectLite,
      tagLite,
      listLite,
      groupLite,
      computeCounts,
      listSummaries,
      groupSummaries,
      depthOf,
      subtreeOf,
      resolvePlacement,
    },
  };
}
