/**
 * LifeOS — 内存索引与视图查询（A 线：store）
 *
 * 原则（design/08 §6.2）：索引是内存派生物，不落盘、不双写真相；
 * 启动时由 store 内存 Map 单遍重建，写路径同步增量维护。
 *
 * M0 索引：raw/byStatus、inbox/byStatus、task/byStatus+byDue、operation_log/byRequestId、journal pending。
 * M1 新增（M1-PLAN §1.5）：tasksByStatus、tasksByProject、tasksByScheduledDate、tasksByDue、entitiesByTag；
 * 视图查询 `queryTasks({view,projectId,tagId,q,limit,cursor})` → {items, groups, nextCursor, counts}，
 * 口径严格按 M1-PLAN §1.4 + design/04 §7.9（today 含 due_at 归日；next7 含今天、不含逾期）。
 */

import { addDays, isTaskInbox, isTaskOverdue, isTaskToday, isTaskWithinNextDays, localDate, localDateOfIso, taskAnchorLocalDate } from '../domain/time.js'
import { TASK_OPEN_STATUSES } from '../domain/task.js'

const INBOX_PENDING_STATUSES = ['captured', 'triaged', 'needs_review']
const PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1, none: 0 }
const TASK_VIEWS = ['today', 'overdue', 'next7', 'inbox', 'all', 'done', 'trash']
const GROUP_DEFS = [
  ['overdue', '逾期'],
  ['today', '今天'],
  ['tomorrow', '明天'],
  ['next7', '最近 7 天'],
  ['later', '以后'],
  ['none', '无日期'],
]

function addToMapSet(map, key, id) {
  let set = map.get(key)
  if (!set) {
    set = new Set()
    map.set(key, set)
  }
  set.add(id)
}

function removeFromMapSet(map, key, id) {
  const set = map.get(key)
  if (!set) return
  set.delete(id)
  if (set.size === 0) map.delete(key)
}

function clampLimit(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 50
  return Math.max(1, Math.min(200, Math.trunc(n)))
}

/** 可比较键：null/undefined 视为最大（排序时最后）。 */
function cmpNullable(a, b) {
  const hasA = a !== null && a !== undefined && a !== ''
  const hasB = b !== null && b !== undefined && b !== ''
  if (!hasA && !hasB) return 0
  if (!hasA) return 1
  if (!hasB) return -1
  if (a === b) return 0
  return a < b ? -1 : 1
}

export class LifeosIndexes {
  constructor({ timeZone = 'Asia/Shanghai' } = {}) {
    this.timeZone = timeZone
    /** @type {Map<string, Map<string, any>>} table → key → record */
    this.byTable = new Map()
    /** @type {Map<string, Set<string>>} status → raw_record keys */
    this.rawByStatus = new Map()
    /** @type {Map<string, Set<string>>} status → inbox_item keys */
    this.inboxByStatus = new Map()
    /** @type {Map<string, Set<string>>} status → task keys */
    this.taskByStatus = new Map()
    /** @type {Map<string, Set<string>>} projectId → task keys */
    this.taskByProject = new Map()
    /** @type {Map<string, Set<string>>} 锚定自然日（scheduled_date / scheduled_start_at 归日）→ task keys */
    this.taskByScheduledDate = new Map()
    /** @type {Map<string, Set<string>>} 截止自然日（due_date / due_at 归日）→ task keys */
    this.taskByDue = new Map()
    /** @type {Map<string, Set<string>>} listId → task keys（M6） */
    this.taskByList = new Map()
    /** @type {Map<string, Set<string>>} groupId → task keys（M6） */
    this.taskByGroup = new Map()
    /** @type {Map<string, Set<string>>} tagId → Set<'entity_type:entity_id'> */
    this.entitiesByTag = new Map()
    /** @type {Map<string, string>} requestId → operation_log key */
    this.oplogByRequestId = new Map()
    /** @type {Map<string, any>} journalId → pending journal record */
    this.journalPending = new Map()
  }

  /** 清空全部索引。 */
  clear() {
    this.byTable.clear()
    this.rawByStatus.clear()
    this.inboxByStatus.clear()
    this.taskByStatus.clear()
    this.taskByProject.clear()
    this.taskByScheduledDate.clear()
    this.taskByDue.clear()
    this.taskByList.clear()
    this.taskByGroup.clear()
    this.entitiesByTag.clear()
    this.oplogByRequestId.clear()
    this.journalPending.clear()
  }

  /**
   * 从 store 内存表重建全部索引。
   * @param {Record<string, Map<string, Map<string, any>>>} memoryByUnit unit → table → key → record
   */
  rebuild(memoryByUnit) {
    this.clear()
    for (const tables of Object.values(memoryByUnit ?? {})) {
      for (const [table, entries] of tables) {
        for (const [key, record] of entries) this.upsert(table, key, record)
      }
    }
  }

  /**
   * 插入/覆盖一条记录索引。
   */
  upsert(table, key, record) {
    if (!record || typeof record !== 'object') return
    this.remove(table, key)
    let tableMap = this.byTable.get(table)
    if (!tableMap) {
      tableMap = new Map()
      this.byTable.set(table, tableMap)
    }
    tableMap.set(key, record)

    if (table === 'raw_record') {
      addToMapSet(this.rawByStatus, record.processing_status ?? 'pending', key)
    } else if (table === 'inbox_item') {
      addToMapSet(this.inboxByStatus, record.status ?? 'captured', key)
    } else if (table === 'task') {
      addToMapSet(this.taskByStatus, record.status ?? 'todo', key)
      if (record.project_id) addToMapSet(this.taskByProject, record.project_id, key)
      const scheduledDay = this._scheduledDay(record)
      if (scheduledDay) addToMapSet(this.taskByScheduledDate, scheduledDay, key)
      const dueDay = this._dueDay(record)
      if (dueDay) addToMapSet(this.taskByDue, dueDay, key)
      if (record.list_id) addToMapSet(this.taskByList, record.list_id, key)
      if (record.group_id) addToMapSet(this.taskByGroup, record.group_id, key)
    } else if (table === 'entity_tag') {
      if (record.tag_id && record.entity_type && record.entity_id) {
        addToMapSet(this.entitiesByTag, record.tag_id, `${record.entity_type}:${record.entity_id}`)
      }
    } else if (table === 'operation_log') {
      const requestId = this._requestIdOf(record)
      if (requestId) this.oplogByRequestId.set(requestId, key)
    } else if (table === 'journal') {
      if (record.status === 'pending') this.journalPending.set(key, record)
    }
  }

  /** 删除一条记录索引。 */
  remove(table, key) {
    const tableMap = this.byTable.get(table)
    if (!tableMap) return
    const record = tableMap.get(key)
    tableMap.delete(key)
    if (!record) return
    if (table === 'raw_record') {
      removeFromMapSet(this.rawByStatus, record.processing_status ?? 'pending', key)
    } else if (table === 'inbox_item') {
      removeFromMapSet(this.inboxByStatus, record.status ?? 'captured', key)
    } else if (table === 'task') {
      removeFromMapSet(this.taskByStatus, record.status ?? 'todo', key)
      if (record.project_id) removeFromMapSet(this.taskByProject, record.project_id, key)
      const scheduledDay = this._scheduledDay(record)
      if (scheduledDay) removeFromMapSet(this.taskByScheduledDate, scheduledDay, key)
      const dueDay = this._dueDay(record)
      if (dueDay) removeFromMapSet(this.taskByDue, dueDay, key)
      if (record.list_id) removeFromMapSet(this.taskByList, record.list_id, key)
      if (record.group_id) removeFromMapSet(this.taskByGroup, record.group_id, key)
    } else if (table === 'entity_tag') {
      if (record.tag_id && record.entity_type && record.entity_id) {
        removeFromMapSet(this.entitiesByTag, record.tag_id, `${record.entity_type}:${record.entity_id}`)
      }
    } else if (table === 'operation_log') {
      const requestId = this._requestIdOf(record)
      if (requestId) this.oplogByRequestId.delete(requestId)
    } else if (table === 'journal') {
      this.journalPending.delete(key)
    }
  }

  _scheduledDay(record) {
    if (record.scheduled_date) return record.scheduled_date
    if (record.scheduled_start_at) return localDateOfIso(this.timeZone, record.scheduled_start_at)
    return null
  }

  _dueDay(record) {
    if (record.due_date) return record.due_date
    if (record.due_at) return localDateOfIso(this.timeZone, record.due_at)
    return null
  }

  _requestIdOf(record) {
    if (typeof record.idempotency_key === 'string') return record.idempotency_key
    if (record.meta_json && typeof record.meta_json.request_id === 'string') return record.meta_json.request_id
    if (typeof record.request_id === 'string') return record.request_id
    return null
  }

  /** 取一条记录（只读，返回索引内引用）。 */
  get(table, key) {
    const tableMap = this.byTable.get(table)
    return tableMap ? tableMap.get(key) : undefined
  }

  /** 某状态下的 id 列表（升序）。 */
  idsByStatus(table, status) {
    const map =
      table === 'raw_record'
        ? this.rawByStatus
        : table === 'inbox_item'
          ? this.inboxByStatus
          : table === 'task'
            ? this.taskByStatus
            : null
    if (!map) return []
    return [...(map.get(status) ?? [])].sort()
  }

  /** 收件箱待处理数量（captured/triaged/needs_review）。 */
  countInboxPending() {
    let count = 0
    for (const status of INBOX_PENDING_STATUSES) count += this.inboxByStatus.get(status)?.size ?? 0
    return count
  }

  /** 某天计划/截止的任务 id。 */
  taskIdsByScheduledDate(dayKey) {
    return [...(this.taskByScheduledDate.get(dayKey) ?? [])].sort()
  }

  taskIdsByDueDay(dayKey) {
    return [...(this.taskByDue.get(dayKey) ?? [])].sort()
  }

  taskIdsByProject(projectId) {
    return [...(this.taskByProject.get(projectId) ?? [])].sort()
  }

  /** 某标签下的实体（'task:tsk_x' 形态）。 */
  entitiesOfTag(tagId) {
    return [...(this.entitiesByTag.get(tagId) ?? [])].sort()
  }

  /** pending journal 列表（按 createdAt 升序，恢复用）。 */
  pendingJournals() {
    return [...this.journalPending.values()].sort((a, b) => {
      const ta = a?.createdAt ?? ''
      const tb = b?.createdAt ?? ''
      if (ta === tb) return String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
      return ta < tb ? -1 : 1
    })
  }

  /** operation_log 的 requestId 反查。 */
  requestIdToOplog(requestId) {
    return this.oplogByRequestId.get(requestId) ?? null
  }

  // -------------------------------------------------------------------------
  // M1：任务视图查询
  // -------------------------------------------------------------------------

  _openTaskIds() {
    const ids = []
    for (const status of TASK_OPEN_STATUSES) ids.push(...this.idsByStatus('task', status))
    return ids.filter((id) => {
      const task = this.get('task', id)
      return task && !task.archived_at && !task.deleted_at
    })
  }

  /** 已完成（非删除）任务 id（M6 view=done）。 */
  _doneTaskIds() {
    return this.idsByStatus('task', 'done').filter((id) => {
      const task = this.get('task', id)
      return task && !task.deleted_at
    })
  }

  /** 回收站任务 id（M6 view=trash，deleted_at 软删）。 */
  _trashedTaskIds() {
    const ids = []
    for (const status of ['todo', 'doing', 'done', 'cancelled']) ids.push(...this.idsByStatus('task', status))
    return ids.filter((id) => {
      const task = this.get('task', id)
      return task && Boolean(task.deleted_at)
    })
  }

  /** listId 过滤：收集箱 list（kind='inbox'）同时匹配 list_id 为空的任务（默认收集箱=无 list）。 */
  _taskListMatches(task, listId) {
    if (!listId) return true
    if (!task.list_id) {
      const list = this.get('list', listId)
      return Boolean(list && list.kind === 'inbox')
    }
    return task.list_id === listId
  }

  _matchTaskFilters(taskId, options) {
    const task = this.get('task', taskId)
    if (!task) return false
    if (options.projectId) {
      if (task.project_id !== options.projectId) return false
    }
    if (options.tagId) {
      const set = this.entitiesByTag.get(options.tagId)
      if (!set || !set.has(`task:${taskId}`)) return false
    }
    if (options.listId && !this._taskListMatches(task, options.listId)) return false
    if (options.groupId && task.group_id !== options.groupId) return false
    if (options.from || options.to) {
      const anchor = taskAnchorLocalDate(task, options.timeZone ?? this.timeZone)
      if (!anchor) return false
      if (options.from && anchor < options.from) return false
      if (options.to && anchor > options.to) return false
    }
    if (typeof options.q === 'string' && options.q.trim().length > 0) {
      const needle = options.q.trim().toLowerCase()
      const haystack = `${task.title ?? ''}\n${task.notes ?? ''}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  }

  _viewFilter(view, task, { timeZone, now }) {
    if (view === 'all') return true
    if (view === 'today') return isTaskToday(task, { timeZone, now })
    if (view === 'overdue') return isTaskOverdue(task, { timeZone, now })
    if (view === 'next7') return isTaskWithinNextDays(task, { timeZone, now, days: 7 })
    if (view === 'inbox') return isTaskInbox(task)
    if (view === 'done') return task.status === 'done' && !task.deleted_at
    if (view === 'trash') return Boolean(task.deleted_at)
    return false
  }

  _compareTask(view, a, b, ctx) {
    const ta = this.get('task', a)
    const tb = this.get('task', b)
    if (!ta) return 1
    if (!tb) return -1
    const priorityDelta = (PRIORITY_WEIGHT[tb.priority] ?? 0) - (PRIORITY_WEIGHT[ta.priority] ?? 0)

    if (view === 'done') {
      // 最近完成在前（null 最后）
      const byCompleted = cmpNullable(tb.completed_at ?? null, ta.completed_at ?? null)
      if (byCompleted !== 0) return byCompleted
      if (priorityDelta !== 0) return priorityDelta
    } else if (view === 'trash') {
      // 最近删除在前（null 最后）
      const byDeleted = cmpNullable(tb.deleted_at ?? null, ta.deleted_at ?? null)
      if (byDeleted !== 0) return byDeleted
    } else if (view === 'overdue') {
      const dueKeyOf = (task) => {
        if (task.due_at) return Date.parse(task.due_at)
        if (task.due_date) return Date.parse(`${task.due_date}T00:00:00.000Z`)
        return null
      }
      const dueA = dueKeyOf(ta)
      const dueB = dueKeyOf(tb)
      const byDue = cmpNullable(dueA, dueB)
      if (byDue !== 0) return byDue
      if (priorityDelta !== 0) return priorityDelta
    } else if (view === 'today') {
      const timeA = ta.scheduled_start_at ? Date.parse(ta.scheduled_start_at) : ta.due_at ? Date.parse(ta.due_at) : null
      const timeB = tb.scheduled_start_at ? Date.parse(tb.scheduled_start_at) : tb.due_at ? Date.parse(tb.due_at) : null
      const byTime = cmpNullable(timeA, timeB)
      if (byTime !== 0) return byTime
      if (priorityDelta !== 0) return priorityDelta
    } else {
      const dayA = taskAnchorLocalDate(ta, ctx.timeZone)
      const dayB = taskAnchorLocalDate(tb, ctx.timeZone)
      const byDay = cmpNullable(dayA, dayB)
      if (byDay !== 0) return byDay
      const timeA = ta.scheduled_start_at ? Date.parse(ta.scheduled_start_at) : null
      const timeB = tb.scheduled_start_at ? Date.parse(tb.scheduled_start_at) : null
      const byTime = cmpNullable(timeA, timeB)
      if (byTime !== 0) return byTime
      if (priorityDelta !== 0) return priorityDelta
    }

    const byCreated = cmpNullable(ta.created_at ?? '', tb.created_at ?? '')
    if (byCreated !== 0) return byCreated
    return String(a).localeCompare(String(b))
  }

  _groupKeyOf(task, { timeZone, today, tomorrow, horizon, now }) {
    if (isTaskOverdue(task, { timeZone, now })) return 'overdue'
    const anchor = taskAnchorLocalDate(task, timeZone)
    if (!anchor) return 'none'
    if (anchor < today) return 'overdue'
    if (anchor === today) return 'today'
    if (anchor === tomorrow) return 'tomorrow'
    if (anchor <= horizon) return 'next7'
    return 'later'
  }

  _buildTaskGroups(ids, ctx) {
    const buckets = new Map(GROUP_DEFS.map(([key]) => [key, []]))
    for (const id of ids) {
      const task = this.get('task', id)
      if (!task) continue
      const key = this._groupKeyOf(task, ctx)
      buckets.get(key).push(task)
    }
    return GROUP_DEFS.map(([key, label]) => {
      const items = buckets.get(key)
      return { key, label, count: items.length, items }
    })
  }

  _taskCounts(ids, ctx) {
    const counts = { today: 0, overdue: 0, next7: 0, inbox: 0, all: ids.length }
    for (const id of ids) {
      const task = this.get('task', id)
      if (!task) continue
      if (isTaskToday(task, ctx)) counts.today += 1
      if (isTaskOverdue(task, ctx)) counts.overdue += 1
      if (isTaskWithinNextDays(task, { ...ctx, days: 7 })) counts.next7 += 1
      if (isTaskInbox(task)) counts.inbox += 1
    }
    return counts
  }

  /**
   * M1/M6 视图查询（B 的 listTasks 直接消费）。
   * M6 扩展：view=done|trash + listId/groupId/from/to 过滤；counts 仍固定 5 键（未完成口径）。
   * @param {{view?: 'today'|'overdue'|'next7'|'inbox'|'all'|'done'|'trash', projectId?: string, tagId?: string, listId?: string|null, groupId?: string|null, from?: string|null, to?: string|null, q?: string, limit?: number, cursor?: string|null, timeZone?: string, now?: Date|number|string}} [options]
   * @returns {{items: any[], groups: Array<{key:string,label:string,count:number,items:any[]}>, nextCursor: string|null, counts: {today:number,overdue:number,next7:number,inbox:number,all:number}}}
   */
  queryTasks(options = {}) {
    const view = options.view ?? 'all'
    if (!TASK_VIEWS.includes(view)) throw new TypeError(`unknown task view: ${String(view)}`)
    const timeZone = options.timeZone ?? this.timeZone
    const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now())
    if (Number.isNaN(now.getTime())) throw new TypeError('invalid now in queryTasks')

    const ctx = { timeZone, now }
    const openIds = this._openTaskIds()
    const counts = this._taskCounts(openIds, ctx)
    const baseIds = view === 'done' ? this._doneTaskIds() : view === 'trash' ? this._trashedTaskIds() : openIds

    let ids = baseIds.filter((id) => this._matchTaskFilters(id, { ...options, timeZone }))
    ids = ids.filter((id) => {
      const task = this.get('task', id)
      return task ? this._viewFilter(view, task, ctx) : false
    })
    ids.sort((a, b) => this._compareTask(view, a, b, ctx))

    const limit = clampLimit(options.limit ?? 50)
    const cursor = options.cursor ?? null
    let groups = null
    if (view === 'all' || view === 'today') {
      const today = localDate(timeZone, now)
      // 分组基于"筛选后、未按 view 过滤"的全部 open 任务：today 视图也要能拿到逾期折叠组
      const groupBase = openIds.filter((id) => this._matchTaskFilters(id, { ...options, timeZone }))
      groups = this._buildTaskGroups(groupBase, {
        timeZone,
        today,
        tomorrow: addDays(today, 1),
        horizon: addDays(today, 6),
        now,
      })
    }
    const page = this.paginate(ids, limit, cursor, (id) => this.get('task', id))
    return { items: page.items, groups, nextCursor: page.nextCursor, counts }
  }

  // -------------------------------------------------------------------------
  // M0 兼容视图（inbox_pending / today / all_tasks）
  // -------------------------------------------------------------------------

  query(view, options = {}) {
    const { limit = 20, cursor = null, timeZone = this.timeZone } = options
    const max = clampLimit(limit)
    let ids = []
    if (view === 'inbox_pending') {
      const all = []
      for (const status of INBOX_PENDING_STATUSES) all.push(...this.idsByStatus('inbox_item', status))
      ids = all.sort((a, b) => this._compareByField('inbox_item', 'created_at', b, a))
    } else if (view === 'today') {
      const todayLocal = localDate(timeZone)
      const open = [...this.idsByStatus('task', 'todo'), ...this.idsByStatus('task', 'doing')]
      ids = open
        .filter((id) => this._taskIsToday(this.get('task', id), todayLocal, timeZone))
        .sort((a, b) => this._compareTaskToday(a, b))
    } else if (view === 'all_tasks') {
      ids = []
      for (const status of ['todo', 'doing', 'done', 'cancelled']) ids.push(...this.idsByStatus('task', status))
      ids = ids.sort((a, b) => this._compareByField('task', 'updated_at', b, a))
    } else {
      throw new TypeError(`unknown view: ${String(view)}`)
    }
    return this.paginate(ids, max, cursor, (id) => this.get(view === 'inbox_pending' ? 'inbox_item' : 'task', id))
  }

  _taskIsToday(record, todayLocal, timeZone) {
    if (!record) return false
    if (record.scheduled_date === todayLocal) return true
    if (record.due_date === todayLocal) return true
    if (record.scheduled_start_at && localDateOfIso(timeZone, record.scheduled_start_at) === todayLocal) return true
    if (record.due_at && localDateOfIso(timeZone, record.due_at) === todayLocal) return true
    return false
  }

  _compareByField(table, field, a, b) {
    const ra = this.get(table, a)
    const rb = this.get(table, b)
    const va = ra?.[field] ?? ''
    const vb = rb?.[field] ?? ''
    if (va === vb) return String(a).localeCompare(String(b))
    return va < vb ? -1 : 1
  }

  _compareTaskToday(a, b) {
    const ra = this.get('task', a)
    const rb = this.get('task', b)
    const pa = PRIORITY_WEIGHT[ra?.priority] ?? 0
    const pb = PRIORITY_WEIGHT[rb?.priority] ?? 0
    if (pa !== pb) return pb - pa
    const ta = ra?.due_at ?? ra?.scheduled_start_at ?? ''
    const tb = rb?.due_at ?? rb?.scheduled_start_at ?? ''
    if (ta !== tb) return ta === '' ? 1 : tb === '' ? -1 : ta < tb ? -1 : 1
    return String(a).localeCompare(String(b))
  }

  /** 游标分页（cursor = 上一页最后一个 id）。 */
  paginate(ids, limit, cursor, getRecord) {
    let start = 0
    if (cursor) {
      const idx = ids.indexOf(cursor)
      start = idx >= 0 ? idx + 1 : 0
    }
    const slice = ids.slice(start, start + limit)
    const nextCursor = start + limit < ids.length ? slice[slice.length - 1] ?? null : null
    const items = slice.map((id) => getRecord(id)).filter((record) => record !== undefined)
    return { items, nextCursor }
  }
}

/** 便捷工厂（与 store 解耦，可单独单测）。 */
export function createIndexes(options) {
  return new LifeosIndexes(options)
}

export { INBOX_PENDING_STATUSES, TASK_OPEN_STATUSES, TASK_VIEWS, GROUP_DEFS, PRIORITY_WEIGHT }
