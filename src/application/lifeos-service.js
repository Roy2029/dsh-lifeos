/**
 * B：应用服务门面（M0-PLAN §3.2）。
 *
 * 唯一写入口：capture 走 journal-first（交给 A 的 store.transaction），写成功后
 * emit `changed` 供 SSE 推送。所有方法都可在 degraded 内存 store 下安全调用：
 * 读返回空、写抛结构化 `store_unavailable`。
 *
 * 记录构造严格对齐 design/08 冻结 schema（raw_record §5.3 / inbox_item 04 §4.2 /
 * operation_log 04 §4.22）；trace_id 放 operation_log.meta_json（避免改冻结列）。
 */

import {
  API_VERSION,
  decodeCursor,
  encodeCursor,
  isLocalDate,
  MAX_LIMIT,
  validateCapture,
  VIEWS,
} from '../client-shared/contract.js';
import { newId as defaultNewId, sha256Hex as defaultSha256 } from '../runtime/ids.js';
import { buildReviewSummary, resolveReviewRange } from '../domain/review.js';
import { LifeosError } from './errors.js';
import { createHabitOps } from './habit-service.js';
import { createPlanningOps } from './planning-service.js';
import { createTaskOps } from './task-service.js';
import { createNotesTagOps } from './notes-tag-service.js';
import { createTriageOps } from './triage-service.js';

export const UNITS = Object.freeze({ core: 'lifeos', raw: 'lifeos_raw', log: 'lifeos_log' });
const CAPTURE_CACHE_LIMIT = 200;

export { LifeosError };

function asIso(ms) {
  return new Date(ms).toISOString();
}

export function localDateInTz(ms, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ms));
    const pick = (type) => parts.find((p) => p.type === type)?.value;
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) : text;
}

function liteTask(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    work_kind: task.work_kind,
    time_kind: task.time_kind,
    scheduled_date: task.scheduled_date ?? null,
    scheduled_start_at: task.scheduled_start_at ?? null,
    due_date: task.due_date ?? null,
    due_at: task.due_at ?? null,
    project_id: task.project_id ?? null,
    updated_at: task.updated_at,
  };
}

function liteInbox(item) {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    raw_record_id: item.raw_record_id ?? null,
    priority: item.priority,
    created_at: item.created_at,
  };
}

function isOpenTask(task) {
  return task && (task.status === 'todo' || task.status === 'doing') && !task.deleted_at && !task.archived_at;
}

function isPendingInbox(item) {
  return (
    item &&
    (item.status === 'captured' || item.status === 'needs_review') &&
    !item.deleted_at
  );
}

/**
 * @param {object} deps
 * @param {object} deps.store LifeosStore（A 实现或内存降级实现）
 * @param {object} [deps.config]
 * @param {object} [deps.diagnostics]
 * @param {object} [deps.bus] createEventBus()
 * @param {{newId?:Function, sha256Hex?:Function}} [deps.ids]
 * @param {()=>number} [deps.now]
 * @param {string} [deps.version]
 */
export function createLifeosService(deps) {
  const store = deps.store;
  if (!store || typeof store.get !== 'function' || typeof store.transaction !== 'function') {
    throw new TypeError('createLifeosService requires a LifeosStore');
  }
  const config = deps.config || {};
  const diagnostics = deps.diagnostics || null;
  const bus = deps.bus || null;
  const ids = deps.ids || {};
  const newId = typeof ids.newId === 'function' ? ids.newId : defaultNewId;
  const sha256 = typeof ids.sha256Hex === 'function' ? ids.sha256Hex : defaultSha256;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const version = deps.version || '0.0.1';
  const timeZone = config.timeZone || 'Asia/Shanghai';
  const devMode = config.devMode === true;
  const clientSelfCheck = config.clientSelfCheck === true;

  /** requestId -> {result, at, order}（M0 内存幂等；进程重启后由 operation_log.idempotency_key 兜底查询） */
  const captureCache = new Map();

  function degraded() {
    return store.degraded === true;
  }

  function safeEntries(unit, table) {
    try {
      const rows = store.entries(unit, table);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  function safeStatus() {
    try {
      return store.status();
    } catch {
      return { units: {} };
    }
  }

  function counts() {
    const inboxPending = safeEntries(UNITS.core, 'inbox_item').filter(([, item]) => isPendingInbox(item)).length;
    const todayDate = localDateInTz(now(), timeZone);
    const today = safeEntries(UNITS.core, 'task').filter(([, task]) => {
      if (!isOpenTask(task)) return false;
      const day =
        task.scheduled_date ||
        task.due_date ||
        (task.scheduled_start_at ? String(task.scheduled_start_at).slice(0, 10) : null) ||
        (task.due_at ? String(task.due_at).slice(0, 10) : null);
      return day === todayDate;
    }).length;
    return { inboxPending, today };
  }

  function emitChanged(kind, idsList, extra) {
    if (!bus || typeof bus.publish !== 'function') return;
    try {
      bus.publish({ type: 'changed', data: { kind, ids: idsList, at: asIso(now()), ...(extra || {}) } });
    } catch {
      /* 广播失败不影响写结果 */
    }
  }

  function refreshDiagnosticsCounts() {
    if (!diagnostics || typeof diagnostics.setStage !== 'function') return;
    try {
      const c = counts();
      diagnostics.setStage(degraded() ? 'degraded' : 'ready', { counts: c, units: safeStatus().units, ok: !degraded() });
    } catch {
      /* ignore */
    }
  }

  // M1 看板操作（任务/项目/标签/ui-prefs/日历）。写路径内部走 store.transaction。
  const taskOps = createTaskOps({
    store,
    newId,
    now,
    timeZone,
    emitChanged,
    todayLocal: () => localDateInTz(now(), timeZone),
  });

  // M6 笔记标签（v0.8）：app_setting['notes.tags']，仅元数据，不触碰笔记文件。
  const notesTagOps = createNotesTagOps({ store, newId, now, emitChanged });

  /** 周起始：app_setting['week_start'].value_json（'monday'|'sunday'），缺省 monday。 */
  function readWeekStart() {
    try {
      const record = store.get(UNITS.core, 'app_setting', 'week_start');
      const raw = record ? record.value_json : null;
      const value = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? raw.value : null;
      return value === 'sunday' ? 'sunday' : 'monday';
    } catch {
      return 'monday';
    }
  }

  const weekStart = readWeekStart();

  // M4 习惯（v0.7）。weekStart 装配时确定；语义与 getHabitMonth/Stats 共用。
  const habitOps = createHabitOps({
    store,
    newId,
    now,
    timeZone,
    weekStart,
    emitChanged,
    todayLocal: () => localDateInTz(now(), timeZone),
  });

  // M4 规划（项目/目标/愿望，v0.7）。与 M1 共用 project 表，写后 emit changed。
  const planningOps = createPlanningOps({ store, newId, now, timeZone, emitChanged });

  // M2 整理（Inbox → 候选 → 确认落库）。scheduler 由 index 注入（可空）。
  const triageOps = createTriageOps({
    store,
    newId,
    now,
    timeZone,
    emitChanged,
    scheduler: deps.scheduler || null,
    diagnostics,
  });

  function makeRawRecord(input, idsOut, atMs) {    const iso = asIso(atMs);
    return {
      id: idsOut.rawRecordId,
      kind: 'note',
      raw_text: input.text,
      content_format: 'plain',
      channel: input.source === 'chat' ? 'chat' : 'composer',
      user_local_date: localDateInTz(atMs, timeZone),
      tz: timeZone,
      source_conversation_id: null,
      source_message_id: null,
      processing_status: 'pending',
      processed_at: null,
      processed_by: null,
      raw_text_sha256: sha256(input.text),
      client_created_at: null,
      created_at: iso,
      updated_at: iso,
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
  }

  function makeInboxItem(input, idsOut, atMs) {
    const iso = asIso(atMs);
    const firstLine = input.text.split(/\r?\n/).find((line) => line.trim().length > 0) || input.text;
    return {
      id: idsOut.inboxItemId,
      title: truncate(firstLine.trim(), 500),
      body: input.text.length > firstLine.length ? input.text : null,
      raw_record_id: idsOut.rawRecordId,
      status: 'captured',
      suggested_kind: 'none',
      suggestion_confidence: null,
      priority: 'none',
      due_date: null,
      list_id: null,
      promoted_to_type: null,
      promoted_to_id: null,
      triaged_at: null,
      dismissed_at: null,
      dismissed_reason: null,
      sort_order: 0,
      created_at: iso,
      updated_at: iso,
      rev: 1,
      deleted_at: null,
      origin_type: 'user_stated',
      origin_ref: { raw_record_id: idsOut.rawRecordId },
      origin_key: null,
      confidence: null,
      confirmation_status: 'not_required',
      evidence_refs: [{ type: 'raw_record', id: idsOut.rawRecordId }],
      schema_version: 1,
      meta_json: null,
    };
  }

  function makeOperationLog(idsOut, input, requestId, atMs, durationMs, traceId) {
    return {
      id: idsOut.oplogId,
      actor_type: input.source === 'chat' ? 'agent' : 'user',
      actor_ref: input.clientRef || null,
      action: 'inbox.capture',
      target_type: 'inbox_item',
      target_id: idsOut.inboxItemId,
      target_ids_json: [idsOut.rawRecordId, idsOut.inboxItemId],
      permission_id: null,
      permission_level: 'L2',
      decision: 'allowed',
      status: 'applied',
      before_json: null,
      after_json: { inbox_status: 'captured', chars: input.text.length },
      diff_json: null,
      state_change_ids: null,
      evidence_refs: [{ type: 'raw_record', id: idsOut.rawRecordId }],
      undo_of_id: null,
      reversible: true,
      undo_patch_json: null,
      reason: 'm0.capture',
      idempotency_key: requestId ? `http:capture:${requestId}` : null,
      occurred_at: asIso(atMs),
      duration_ms: durationMs,
      error: null,
      meta_json: { trace_id: traceId || null, source: input.source },
    };
  }

  async function capture(rawInput) {
    const started = now();
    const validated = validateCapture(rawInput);
    if (!validated.ok) throw new LifeosError('validation_failed', 'capture 参数不合法', { errors: validated.errors });
    const input = validated.value;
    if (degraded()) throw new LifeosError('store_unavailable', '存储不可用，当前为只读降级模式');

    if (input.requestId) {
      const cached = captureCache.get(input.requestId);
      if (cached) return { ...cached.result, deduped: true };
    }

    const atMs = now();
    const idsOut = {
      rawRecordId: newId('rr', atMs),
      inboxItemId: newId('inb', atMs),
      oplogId: newId('opl', atMs),
    };
    const raw = makeRawRecord(input, idsOut, atMs);
    const inbox = makeInboxItem(input, idsOut, atMs);
    const oplog = makeOperationLog(idsOut, input, input.requestId, atMs, Math.max(0, atMs - started), rawInput?.traceId || null);
    const ops = [
      { unit: UNITS.raw, table: 'raw_record', key: raw.id, value: raw },
      { unit: UNITS.core, table: 'inbox_item', key: inbox.id, value: inbox },
      { unit: UNITS.log, table: 'operation_log', key: oplog.id, value: oplog },
    ];

    try {
      await store.transaction(ops);
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : 'internal';
      diagnostics?.recordError?.(code, `capture 事务失败：${error?.message || error}`);
      throw new LifeosError(code === 'store_unavailable' ? 'store_unavailable' : 'internal', `记录失败：${error?.message || error}`, {
        stage: 'journal',
      });
    }

    const result = { rawRecordId: raw.id, inboxItemId: inbox.id };
    if (input.requestId) {
      captureCache.set(input.requestId, { result, at: atMs });
      while (captureCache.size > CAPTURE_CACHE_LIMIT) {
        const oldest = captureCache.keys().next().value;
        captureCache.delete(oldest);
      }
    }
    emitChanged('capture', [raw.id, inbox.id]);
    refreshDiagnosticsCounts();
    return result;
  }

  function today() {
    const date = localDateInTz(now(), timeZone);
    const { todayTasks, overdue } = taskOps.todayTasks();
    const tasks = todayTasks;
    const inboxCount = safeEntries(UNITS.core, 'inbox_item').filter(([, item]) => isPendingInbox(item)).length;
    return { date, tasks, overdue, inboxCount };
  }

  /**
   * M4 回顾摘要（v0.7）：服务层只组装数据，口径由 domain/review.js buildReviewSummary 决定。
   */
  function getReviewSummary(input = {}) {
    const query = input && typeof input === 'object' ? input : {};
    const period = query.period === 'month' ? 'month' : 'week';
    const anchor = isLocalDate(query.anchor) ? query.anchor : localDateInTz(now(), timeZone);
    const { range } = resolveReviewRange(period, anchor, weekStart, timeZone);
    const stats = habitOps.getStats({ from: range.start, to: range.end });
    const taskRows = safeEntries(UNITS.core, 'task').map(([, row]) => row);
    const habitRows = safeEntries(UNITS.core, 'habit').map(([, row]) => row);
    const inboxRows = safeEntries(UNITS.core, 'inbox_item').map(([, row]) => row);
    const projectRows = safeEntries(UNITS.core, 'project')
      .map(([, row]) => row)
      .filter((project) => !project.deleted_at && (project.status ?? 'active') !== 'archived');
    const projectStats = projectRows.map((project) => {
      const tasks = taskRows.filter(
        (task) => task.project_id === project.id && !task.deleted_at && task.status !== 'cancelled',
      );
      return {
        id: project.id,
        name: project.name,
        done: tasks.filter((task) => task.status === 'done').length,
        total: tasks.length,
      };
    });
    return buildReviewSummary({
      period,
      anchorLocalDate: anchor,
      timeZone,
      weekStart,
      tasks: taskRows,
      habits: habitRows,
      habitStats: stats.habits,
      inboxCounts: {
        pending: inboxRows.filter(isPendingInbox).length,
        toConfirm: inboxRows.filter((item) => !item.deleted_at && item.status === 'needs_review').length,
      },
      projectStats,
    });
  }

  function query(rawInput) {    const view = rawInput && typeof rawInput.view === 'string' ? rawInput.view : '';
    if (!VIEWS.includes(view)) throw new LifeosError('validation_failed', `view 非法：${view || '空'}`);
    const limit = Math.min(Math.max(Number(rawInput.limit) || 20, 1), MAX_LIMIT);
    const offset = decodeCursor(rawInput.cursor);

    let rows;
    if (view === 'inbox_pending') {
      rows = safeEntries(UNITS.core, 'inbox_item')
        .map(([, item]) => item)
        .filter(isPendingInbox)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .map(liteInbox);
    } else if (view === 'today') {
      rows = today().tasks;
    } else {
      rows = safeEntries(UNITS.core, 'task')
        .map(([, task]) => task)
        .filter((task) => isOpenTask(task))
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
        .map(liteTask);
    }
    const slice = rows.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    return { items: slice, nextCursor: nextOffset < rows.length ? encodeCursor(nextOffset) : null };
  }

  function backendName() {
    if (typeof store.backendName === 'string' && store.backendName.length > 0) return store.backendName;
    if (typeof store.backend === 'string' && store.backend.length > 0) return store.backend;
    if (store.backend && typeof store.backend.name === 'string') return store.backend.name;
    return 'unknown';
  }

  function status() {
    const isDegraded = degraded();
    const unitStatus = safeStatus().units || {};
    return {
      ok: !isDegraded,
      degraded: isDegraded,
      units: unitStatus,
      counts: counts(),
      version,
      timeZone,
      devMode,
      backend: backendName(),
      diagnosticsPath: diagnostics?.paths?.diagnostics || null,
    };
  }

  function bootstrap() {
    const isDegraded = degraded();
    return {
      today: today(),
      counts: counts(),
      settings: { timeZone, devMode, weekStart, clientSelfCheck },
      flags: { devMode, clientSelfCheck },
      apiVersion: API_VERSION,
      version,
      // S2：让客户端能感知降级/只读状态并提示用户，而不是静默内存模式。
      degraded: isDegraded,
      backend: backendName(),
      projects: planningOps.listProjects().items,
      tags: taskOps.listTags().items,
      uiPrefs: taskOps.getUiPrefs().prefs,
    };
  }

  /**
   * M0/M1 自检专用：清理 Client 激活自检写入的 raw_record / inbox_item / task / project / tag。
   * 仅当 devMode 或 clientSelfCheck 打开时由路由层放行；不属于用户能力。
   */
  async function devCleanup(input = {}) {
    const rawRecordId = typeof input.rawRecordId === 'string' ? input.rawRecordId : '';
    const inboxItemId = typeof input.inboxItemId === 'string' ? input.inboxItemId : '';
    const asIds = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id.length > 0) : []);
    const taskIds = asIds(input.taskIds);
    const projectIds = asIds(input.projectIds);
    const tagIds = asIds(input.tagIds);
    const eventIds = asIds(input.eventIds);
    const metricIds = asIds(input.metricIds);
    const habitCheckinIds = asIds(input.habitCheckinIds);
    const wishIds = asIds(input.wishIds);
    const runIds = asIds(input.runIds);
    const evidenceIds = asIds(input.evidenceIds);
    const deleted = {
      raw: false,
      inbox: false,
      tasks: 0,
      events: 0,
      metrics: 0,
      habitCheckins: 0,
      wishes: 0,
      projects: 0,
      tags: 0,
      runs: 0,
      evidenceLinks: 0,
      entityTags: 0,
    };
    if (rawRecordId) {
      deleted.raw = await store.delete('lifeos_raw', 'raw_record', rawRecordId);
    }
    if (inboxItemId) {
      deleted.inbox = await store.delete('lifeos', 'inbox_item', inboxItemId);
    }
    /** @type {Array<[string,string,string[],keyof typeof deleted]>} */
    const tablePlan = [
      ['lifeos', 'task', taskIds, 'tasks'],
      ['lifeos', 'event', eventIds, 'events'],
      ['lifeos', 'metric', metricIds, 'metrics'],
      ['lifeos', 'habit_checkin', habitCheckinIds, 'habitCheckins'],
      ['lifeos', 'wish', wishIds, 'wishes'],
      ['lifeos', 'project', projectIds, 'projects'],
      ['lifeos', 'tag', tagIds, 'tags'],
      ['lifeos', 'extraction_run', runIds, 'runs'],
      ['lifeos', 'evidence_link', evidenceIds, 'evidenceLinks'],
    ];
    for (const [unit, table, ids, counter] of tablePlan) {
      for (const id of ids) {
        try {
          if (await store.delete(unit, table, id)) deleted[counter] += 1;
        } catch {
          /* ignore */
        }
      }
    }
    // 清理指向已删除对象的 evidence_link（from_id / to_id）
    try {
      const removedIds = new Set([
        ...taskIds,
        ...eventIds,
        ...metricIds,
        ...habitCheckinIds,
        ...wishIds,
        ...projectIds,
        ...tagIds,
        rawRecordId,
      ]);
      if (removedIds.size > 0) {
        for (const [key, value] of store.entries('lifeos', 'evidence_link')) {
          const fromId = value?.from_id || value?.fromId;
          const toId = value?.to_id || value?.toId;
          if ((fromId && removedIds.has(fromId)) || (toId && removedIds.has(toId))) {
            await store.delete('lifeos', 'evidence_link', key);
            deleted.evidenceLinks += 1;
          }
        }
      }
    } catch {
      /* ignore */
    }
    // 清理任务/项目上的 entity_tag 关联（自检数据）
    try {
      const targets = new Set([...taskIds, ...projectIds]);
      if (targets.size > 0) {
        for (const [key, value] of store.entries('lifeos', 'entity_tag')) {
          const entityId = value?.entity_id || value?.entityId;
          if (entityId && targets.has(entityId)) {
            await store.delete('lifeos', 'entity_tag', key);
            deleted.entityTags += 1;
          }
        }
      }
    } catch {
      /* ignore */
    }
    try {
      store.rebuildIndexes?.();
    } catch {
      /* ignore */
    }
    return { deleted, counts: counts() };
  }

  function diag() {
    return {
      status: status(),
      diagnostics: diagnostics?.snapshot?.() || null,
      errors: diagnostics?.getErrors?.() || [],
      clientReport: diagnostics?.getClientReport?.() || null,
    };
  }

  return {
    get degraded() {
      return degraded();
    },
    get store() {
      return store;
    },
    status,
    bootstrap,
    capture,
    today,
    query,
    diag,
    devCleanup,
    // M1 看板（v0.2）
    listTasks: taskOps.listTasks,
    getTask: taskOps.getTask,
    createTask: taskOps.createTask,
    updateTask: taskOps.updateTask,
    completeTask: taskOps.completeTask,
    reopenTask: taskOps.reopenTask,
    cancelTask: taskOps.cancelTask,
    rescheduleTask: taskOps.rescheduleTask,
    getCalendar: taskOps.getCalendar,
    listTags: taskOps.listTags,
    createTag: taskOps.createTag,
    updateTag: taskOps.updateTag,
    deleteTag: taskOps.deleteTag,
    getUiPrefs: taskOps.getUiPrefs,
    setUiPrefs: taskOps.setUiPrefs,
    // M6 清单/分组/任务补充（v0.8）
    getTaskDetail: taskOps.getTaskDetail,
    moveTask: taskOps.moveTask,
    duplicateTask: taskOps.duplicateTask,
    restoreTask: taskOps.restoreTask,
    deleteTask: taskOps.deleteTask,
    listLists: taskOps.listLists,
    createList: taskOps.createList,
    updateList: taskOps.updateList,
    deleteList: taskOps.deleteList,
    reorderLists: taskOps.reorderLists,
    getListGroups: taskOps.getListGroups,
    createGroup: taskOps.createGroup,
    updateGroup: taskOps.updateGroup,
    deleteGroup: taskOps.deleteGroup,
    reorderGroups: taskOps.reorderGroups,
    // M19 #20 任务 ⇄ Markdown
    exportTasksMarkdown: taskOps.exportTasksMarkdown,
    importTasksMarkdown: taskOps.importTasksMarkdown,
    // M6 笔记标签（v0.8）
    getNotesTags: notesTagOps.getNotesTags,
    putNotesTags: notesTagOps.putNotesTags,
    batchNotesTags: notesTagOps.batchNotesTags,
    // M2 整理（v0.3）
    runTriage: triageOps.runTriage,
    beginTriage: triageOps.beginTriage,
    saveTriageCandidates: triageOps.saveTriageCandidates,
    abortTriage: triageOps.abortTriage,
    listTriagePending: triageOps.listTriagePending,
    getTriageRun: triageOps.getTriageRun,
    applyTriage: triageOps.applyTriage,
    reprocessRaw: triageOps.reprocessRaw,
    correctDerived: triageOps.correctDerived,
    triageStatus: triageOps.triageStatus,
    getAutomation: triageOps.getAutomation,
    setAutomation: triageOps.setAutomation,
    // M4 习惯（v0.7）
    listHabits: habitOps.listHabits,
    getHabit: habitOps.getHabit,
    createHabit: habitOps.createHabit,
    updateHabit: habitOps.updateHabit,
    archiveHabit: habitOps.archiveHabit,
    checkin: habitOps.checkin,
    uncheck: habitOps.uncheck,
    listCheckins: habitOps.listCheckins,
    getHabitStats: habitOps.getStats,
    getHabitMonth: habitOps.getMonth,
    getStats: habitOps.getStats,
    getMonth: habitOps.getMonth,
    todayHabits: habitOps.todayHabits,
    // M18 习惯分组（schema v4）
    listHabitGroups: habitOps.listHabitGroups,
    createHabitGroup: habitOps.createHabitGroup,
    updateHabitGroup: habitOps.updateHabitGroup,
    deleteHabitGroup: habitOps.deleteHabitGroup,
    reorderHabitGroups: habitOps.reorderHabitGroups,
    // M4 规划（v0.7；替代 M1 taskOps 的项目三方法）
    listProjects: planningOps.listProjects,
    getProject: planningOps.getProject,
    createProject: planningOps.createProject,
    updateProject: planningOps.updateProject,
    archiveProject: planningOps.archiveProject,
    listGoals: planningOps.listGoals,
    getGoal: planningOps.getGoal,
    createGoal: planningOps.createGoal,
    updateGoal: planningOps.updateGoal,
    archiveGoal: planningOps.archiveGoal,
    listWishes: planningOps.listWishes,
    getWish: planningOps.getWish,
    createWish: planningOps.createWish,
    updateWish: planningOps.updateWish,
    convertWish: planningOps.convertWish,
    // M4 回顾（v0.7）
    getReviewSummary,
    // 供 index / 测试使用
    _internals: { localDateInTz, isPendingInbox, isOpenTask, taskOps: taskOps._internals, notesTagOps: notesTagOps._internals },
  };
}
