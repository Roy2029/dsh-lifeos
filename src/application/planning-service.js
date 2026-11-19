/**
 * A：M4a 规划应用服务（项目 / 目标 / 愿望）。
 *
 * 契约：M4-PLAN §3.3（view 形状/进度口径）+ §1.3（实体状态机）。
 * 原则：
 *  - 所有写走 store.transaction（journal-first），一次提交 = 实体记录 + state_change + operation_log；
 *  - 每次更新带 expectedRev（CAS；HTTP 传数字或 {expectedRev} 均可），冲突抛 LifeosError('conflict', details.current)；
 *  - project/goal/wish 的 create/update 返回 view（含 rev）+ revision；任务明细直接读 task 表（驼峰 taskLite）；
 *  - auto_by_projects 目标进度暂降级 manual 并回 warnings（M4a 无项目→目标聚合）。
 *
 * 零第三方依赖；不 import `@deepseek-ai/*` 或 zod。
 */

import { LifeosError } from './errors.js'
import { isLocalDate } from '../domain/time.js'
import { newId as defaultNewId } from '../domain/ids.js'

const CORE = 'lifeos'
const LOG = 'lifeos_log'

const PROJECT_STATUSES = ['active', 'paused', 'completed', 'cancelled', 'archived']
const PROJECT_PROGRESS_MODES = ['auto_by_tasks', 'manual']
const GOAL_STATUSES = ['active', 'paused', 'achieved', 'abandoned']
const GOAL_HORIZONS = ['short', 'mid', 'long']
const GOAL_PROGRESS_MODES = ['manual', 'auto_by_projects', 'auto_by_tasks']
const WISH_STATUSES = ['captured', 'considering', 'committed', 'deferred', 'discarded']

const PROJECT_FIELD_MAP = Object.freeze({
  name: 'name',
  description: 'description',
  color: 'color',
  status: 'status',
  start_date: 'start_date',
  startDate: 'start_date',
  target_date: 'target_date',
  targetDate: 'target_date',
  progress_mode: 'progress_mode',
  progressMode: 'progress_mode',
  progress_pct: 'progress_pct',
  progressPct: 'progress_pct',
  sort_order: 'sort_order',
  sortOrder: 'sort_order',
})

const GOAL_FIELD_MAP = Object.freeze({
  title: 'title',
  description: 'description',
  success_criteria: 'success_criteria',
  successCriteria: 'success_criteria',
  horizon: 'horizon',
  status: 'status',
  start_date: 'start_date',
  startDate: 'start_date',
  target_date: 'target_date',
  targetDate: 'target_date',
  abandoned_reason: 'abandoned_reason',
  abandonedReason: 'abandoned_reason',
  progress_mode: 'progress_mode',
  progressMode: 'progress_mode',
  progress_pct: 'progress_pct',
  progressPct: 'progress_pct',
  sort_order: 'sort_order',
  sortOrder: 'sort_order',
})

const WISH_FIELD_MAP = Object.freeze({
  title: 'title',
  description: 'description',
  status: 'status',
  review_at: 'review_at',
  reviewAt: 'review_at',
  sort_order: 'sort_order',
  sortOrder: 'sort_order',
})

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toMs(now) {
  if (now instanceof Date) return now.getTime()
  if (typeof now === 'number' && Number.isFinite(now)) return now
  return Date.now()
}

function iso(ms) {
  return new Date(ms).toISOString()
}

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value
}

function clampPercent(value) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return Math.min(100, Math.max(0, Math.round(number)))
}

function validationError(message, errors) {
  return new LifeosError('validation_failed', message, { errors: Array.isArray(errors) ? errors : [message] })
}

function pickFields(input, fieldMap) {
  const out = {}
  if (!isPlainObject(input)) return out
  for (const [key, canonical] of Object.entries(fieldMap)) {
    if (input[key] === undefined) continue
    out[canonical] = input[key]
  }
  return out
}

function expectedRevOf(value) {
  if (isPlainObject(value)) return value.expectedRev
  return value
}

/**
 * @param {{
 *   store: object,
 *   newId?: (prefix:string)=>string,
 *   now?: ()=>number|Date,
 *   timeZone?: string,
 *   emitChanged?: (kind:string, ids:string[], extra?:object)=>void,
 *   actorType?: string,
 * }} deps
 */
export function createPlanningOps(deps = {}) {
  const { store } = deps
  if (!store || typeof store.get !== 'function' || typeof store.transaction !== 'function') {
    throw new LifeosError('validation_failed', 'createPlanningOps 需要 LifeosStore')
  }
  const newId = typeof deps.newId === 'function' ? deps.newId : (prefix) => defaultNewId(prefix)
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const emitChanged = typeof deps.emitChanged === 'function' ? deps.emitChanged : null
  const actorType = typeof deps.actorType === 'string' && deps.actorType.length > 0 ? deps.actorType : 'user'

  function currentIso() {
    return iso(toMs(now()))
  }

  function assertWritable() {
    if (store.degraded === true) throw new LifeosError('store_unavailable', '存储不可用（只读降级）')
  }

  function emit(kind, ids, extra) {
    if (!emitChanged) return
    try {
      emitChanged(kind, ids, extra)
    } catch {
      /* 事件失败不影响写入结果 */
    }
  }

  /* ── 读工具 ─────────────────────────────────────────────── */

  function entries(table) {
    try {
      return store.entries(CORE, table)
    } catch {
      return []
    }
  }

  function recordsOf(table) {
    return entries(table)
      .map(([, record]) => record)
      .filter((record) => isPlainObject(record) && !record.deleted_at)
  }

  function allProjects() {
    return recordsOf('project')
  }

  function allGoals() {
    return recordsOf('goal')
  }

  function allWishes() {
    return recordsOf('wish')
  }

  function allTasks() {
    return recordsOf('task')
  }

  function allLinks() {
    return recordsOf('entity_link')
  }

  function getRecord(table, id) {
    try {
      const record = store.get(CORE, table, id)
      return record && !record.deleted_at ? record : null
    } catch {
      return null
    }
  }

  function sortByOrderThenCreated(items) {
    return items
      .slice()
      .sort(
        (a, b) =>
          (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
          String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')),
      )
  }

  /* ── 视图 / 进度 ────────────────────────────────────────── */

  function tasksOfProject(projectId) {
    return allTasks().filter((task) => task.project_id === projectId)
  }

  function tasksOfGoal(goalId) {
    return allTasks().filter((task) => task.goal_id === goalId)
  }

  function countProgress(tasks) {
    const relevant = tasks.filter((task) => !task.deleted_at && task.status !== 'cancelled')
    const total = relevant.length
    const done = relevant.filter((task) => task.status === 'done').length
    return { total, done }
  }

  function projectProgress(project, tasks) {
    const mode = project.progress_mode === 'manual' ? 'manual' : 'auto_by_tasks'
    if (mode === 'manual') {
      const pct = clampPercent(project.progress_pct ?? 0)
      return { mode, done: null, total: null, pct, label: `手动进度 ${pct}%` }
    }
    const { total, done } = countProgress(tasks)
    if (total === 0) return null
    const pct = Math.round((done / total) * 100)
    return { mode, done, total, pct, label: `任务完成 ${done}/${total}（根据任务计算）` }
  }

  function projectView(project, tasks = []) {
    const progress = projectProgress(project, tasks)
    const liveTasks = tasks.filter((task) => !task.deleted_at && task.status !== 'cancelled')
    return {
      id: project.id,
      name: project.name,
      description: project.description ?? null,
      color: project.color ?? null,
      status: project.status ?? 'active',
      start_date: project.start_date ?? null,
      target_date: project.target_date ?? null,
      progress_mode: project.progress_mode ?? 'auto_by_tasks',
      progress_pct: clampPercent(project.progress_pct ?? 0),
      sort_order: project.sort_order ?? 0,
      rev: project.rev ?? 1,
      created_at: project.created_at ?? null,
      updated_at: project.updated_at ?? null,
      completed_at: project.completed_at ?? null,
      paused_at: project.paused_at ?? null,
      archived_at: project.archived_at ?? null,
      progress,
      has_tasks: liveTasks.length > 0,
    }
  }

  function goalProgress(goal, tasks) {
    const mode = GOAL_PROGRESS_MODES.includes(goal.progress_mode) ? goal.progress_mode : 'manual'
    if (mode === 'auto_by_tasks') {
      const { total, done } = countProgress(tasks)
      return { mode, done, total, pct: total === 0 ? null : Math.round((done / total) * 100) }
    }
    return { mode, done: null, total: null, pct: clampPercent(goal.progress_pct ?? 0) }
  }

  function goalView(goal, tasks = []) {
    return {
      id: goal.id,
      title: goal.title,
      description: goal.description ?? null,
      success_criteria: goal.success_criteria ?? null,
      horizon: goal.horizon ?? 'mid',
      status: goal.status ?? 'active',
      start_date: goal.start_date ?? null,
      target_date: goal.target_date ?? null,
      achieved_at: goal.achieved_at ?? null,
      abandoned_reason: goal.abandoned_reason ?? null,
      progress_mode: goal.progress_mode ?? 'manual',
      progress_pct: clampPercent(goal.progress_pct ?? 0),
      archived_at: goal.archived_at ?? null,
      sort_order: goal.sort_order ?? 0,
      rev: goal.rev ?? 1,
      created_at: goal.created_at ?? null,
      updated_at: goal.updated_at ?? null,
      progress: goalProgress(goal, tasks),
    }
  }

  function wishView(wish) {
    return {
      id: wish.id,
      title: wish.title,
      description: wish.description ?? null,
      status: wish.status ?? 'captured',
      converted_to_goal_id: wish.converted_to_goal_id ?? null,
      converted_at: wish.converted_at ?? null,
      review_at: wish.review_at ?? null,
      sort_order: wish.sort_order ?? 0,
      rev: wish.rev ?? 1,
      created_at: wish.created_at ?? null,
      updated_at: wish.updated_at ?? null,
    }
  }

  function taskLite(task) {
    return {
      id: task.id,
      title: task.title,
      notes: task.notes ?? null,
      status: task.status,
      priority: task.priority ?? 'none',
      projectId: task.project_id ?? null,
      goalId: task.goal_id ?? null,
      scheduledDate: task.scheduled_date ?? null,
      scheduledStartAt: task.scheduled_start_at ?? null,
      scheduledEndAt: task.scheduled_end_at ?? null,
      isAllDay: task.is_all_day === true,
      dueDate: task.due_date ?? null,
      dueAt: task.due_at ?? null,
      completedAt: task.completed_at ?? null,
      cancelledAt: task.cancelled_at ?? null,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      rev: task.rev,
      timeKind: task.time_kind ?? 'none',
      workKind: task.work_kind ?? 'action',
      archivedAt: task.archived_at ?? null,
    }
  }

  function recentActivityAt(project, tasks) {
    const stamps = [project.updated_at, project.completed_at]
    for (const task of tasks) {
      stamps.push(task.updated_at, task.completed_at)
    }
    const valid = stamps.filter((value) => typeof value === 'string' && value.length > 0)
    if (valid.length === 0) return null
    valid.sort()
    return valid[valid.length - 1]
  }

  /* ── 写入辅助 ─────────────────────────────────────────────── */

  function stateChangeRecords(entityType, entityId, diffs, nowIso, revAfter) {
    return diffs.map((diff) => ({
      id: newId('stc'),
      entity_type: entityType,
      entity_id: entityId,
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
    }))
  }

  function oplogRecord({ action, targetType, targetId, targetIds, before, after, stateChangeIds, nowIso, idempotencyKey, meta }) {
    return {
      id: newId('opl'),
      actor_type: actorType,
      actor_ref: null,
      action,
      target_type: targetType,
      target_id: targetId,
      target_ids_json: Array.isArray(targetIds) ? targetIds : [targetId],
      permission_id: null,
      permission_level: 'L2',
      decision: 'allowed',
      status: 'applied',
      before_json: before ?? null,
      after_json: after ?? null,
      diff_json: null,
      state_change_ids: stateChangeIds ?? [],
      evidence_refs: [],
      undo_of_id: null,
      reversible: true,
      undo_patch_json: null,
      reason: null,
      idempotency_key: typeof idempotencyKey === 'string' && idempotencyKey.length > 0 ? idempotencyKey : null,
      occurred_at: nowIso,
      duration_ms: null,
      error: null,
      meta_json: meta ?? { source: 'm4a' },
    }
  }

  function commit(ops, { kind, ids, extra }) {
    return store.transaction(ops).then(() => {
      emit(kind, ids, extra)
      return { revision: extra?.revision ?? null }
    })
  }

  function diffOf(before, after, fields) {
    const diffs = []
    for (const field of fields) {
      const oldValue = before[field] === undefined ? null : before[field]
      const newValue = after[field] === undefined ? null : after[field]
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue
      diffs.push({ field, oldValue, newValue })
    }
    return diffs
  }

  function requireExpectedRev(value) {
    const rev = expectedRevOf(value)
    if (!Number.isInteger(rev) || rev < 1) {
      throw validationError('写操作必须提供正整数 expectedRev（If-Match）', ['expectedRev 缺失或非法'])
    }
    return rev
  }

  function assertRev(entityLabel, record, expectedRev, viewBuilder) {
    if (record.rev !== expectedRev) {
      throw new LifeosError('conflict', `${entityLabel}已被修改，请刷新后重试`, {
        current: viewBuilder(),
        expectedRev,
        currentRev: record.rev,
      })
    }
  }

  function assertLocalDateField(field, value, errors) {
    if (value === undefined || value === null) return
    if (!isLocalDate(value)) errors.push(`${field}: 必须是 YYYY-MM-DD 自然日`)
  }

  function assertStringField(field, value, errors) {
    if (value === undefined || value === null) return
    if (typeof value !== 'string') errors.push(`${field}: 必须是字符串`)
  }

  function assertPercentField(field, value, errors) {
    if (value === undefined || value === null) return
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      errors.push(`${field}: 必须是 0..100 的数字`)
    }
  }

  function assertSortOrderField(value, errors) {
    if (value === undefined || value === null) return
    if (!Number.isInteger(value) || value < 0) errors.push('sort_order: 必须是 >=0 的整数')
  }

  function projectFieldsFrom(input) {
    const values = pickFields(input, PROJECT_FIELD_MAP)
    const errors = []
    if (values.name !== undefined) {
      if (typeof values.name !== 'string' || values.name.trim().length === 0) errors.push('name 必填')
      else values.name = values.name.trim()
    }
    assertStringField('description', values.description, errors)
    assertStringField('color', values.color, errors)
    assertLocalDateField('start_date', values.start_date, errors)
    assertLocalDateField('target_date', values.target_date, errors)
    assertPercentField('progress_pct', values.progress_pct, errors)
    assertSortOrderField(values.sort_order, errors)
    if (values.status !== undefined && !PROJECT_STATUSES.includes(values.status)) {
      errors.push(`status: 必须是 ${PROJECT_STATUSES.join('/')}`)
    }
    if (values.progress_mode !== undefined && !PROJECT_PROGRESS_MODES.includes(values.progress_mode)) {
      errors.push(`progress_mode: 必须是 ${PROJECT_PROGRESS_MODES.join('/')}`)
    }
    if (values.start_date && values.target_date && values.start_date > values.target_date) {
      errors.push('target_date: 不能早于 start_date')
    }
    if (errors.length > 0) throw validationError('项目字段不合法', errors)
    return values
  }

  function goalFieldsFrom(input) {
    const values = pickFields(input, GOAL_FIELD_MAP)
    const errors = []
    if (values.title !== undefined) {
      if (typeof values.title !== 'string' || values.title.trim().length === 0) errors.push('title 必填')
      else values.title = values.title.trim()
    }
    assertStringField('description', values.description, errors)
    assertStringField('success_criteria', values.success_criteria, errors)
    assertStringField('abandoned_reason', values.abandoned_reason, errors)
    assertLocalDateField('start_date', values.start_date, errors)
    assertLocalDateField('target_date', values.target_date, errors)
    assertPercentField('progress_pct', values.progress_pct, errors)
    assertSortOrderField(values.sort_order, errors)
    if (values.status !== undefined && !GOAL_STATUSES.includes(values.status)) {
      errors.push(`status: 必须是 ${GOAL_STATUSES.join('/')}`)
    }
    if (values.horizon !== undefined && !GOAL_HORIZONS.includes(values.horizon)) {
      errors.push(`horizon: 必须是 ${GOAL_HORIZONS.join('/')}`)
    }
    if (values.progress_mode !== undefined && !GOAL_PROGRESS_MODES.includes(values.progress_mode)) {
      errors.push(`progress_mode: 必须是 ${GOAL_PROGRESS_MODES.join('/')}`)
    }
    if (values.start_date && values.target_date && values.start_date > values.target_date) {
      errors.push('target_date: 不能早于 start_date')
    }
    if (errors.length > 0) throw validationError('目标字段不合法', errors)
    return values
  }

  function wishFieldsFrom(input) {
    const values = pickFields(input, WISH_FIELD_MAP)
    const errors = []
    if (values.title !== undefined) {
      if (typeof values.title !== 'string' || values.title.trim().length === 0) errors.push('title 必填')
      else values.title = values.title.trim()
    }
    assertStringField('description', values.description, errors)
    assertLocalDateField('review_at', values.review_at, errors)
    assertSortOrderField(values.sort_order, errors)
    if (values.status !== undefined && !WISH_STATUSES.includes(values.status)) {
      errors.push(`status: 必须是 ${WISH_STATUSES.join('/')}`)
    }
    if (errors.length > 0) throw validationError('愿望字段不合法', errors)
    return values
  }

  /* ── 项目 ─────────────────────────────────────────────── */

  function listProjects(input = {}) {
    const query = isPlainObject(input) ? input : {}
    const includeArchived = query.includeArchived === true
    const status = typeof query.status === 'string' ? query.status : null
    let items = sortByOrderThenCreated(allProjects())
    if (status) items = items.filter((project) => (project.status ?? 'active') === status)
    if (!includeArchived) items = items.filter((project) => (project.status ?? 'active') !== 'archived')
    const tasks = allTasks()
    return {
      items: items.map((project) =>
        projectView(project, tasks.filter((task) => task.project_id === project.id)),
      ),
    }
  }

  function getProject(id) {
    const project = getRecord('project', id)
    if (!project) throw new LifeosError('not_found', `项目不存在：${id}`, { id })
    const tasks = tasksOfProject(id)
    const progress = projectProgress(project, tasks)
    return {
      project: projectView(project, tasks),
      tasks: sortByOrderThenCreated(tasks).map(taskLite),
      progress,
      recentActivityAt: recentActivityAt(project, tasks),
    }
  }

  function createProject(input = {}) {
    assertWritable()
    const nowIso = currentIso()
    const values = projectFieldsFrom(input)
    if (!values.name) throw validationError('项目 name 必填', ['name 必填'])
    const name = values.name
    const tasks = allTasks()
    const duplicate = allProjects().find(
      (project) => String(project.name ?? '').trim().toLowerCase() === name.toLowerCase(),
    )
    if (duplicate) {
      throw new LifeosError('conflict', `项目已存在：${name}`, {
        current: projectView(duplicate, tasks.filter((task) => task.project_id === duplicate.id)),
      })
    }
    const record = {
      id: newId('prj'),
      name,
      description: values.description ?? null,
      color: values.color ?? null,
      status: values.status ?? 'active',
      start_date: values.start_date ?? null,
      target_date: values.target_date ?? null,
      progress_mode: values.progress_mode ?? 'auto_by_tasks',
      progress_pct: clampPercent(values.progress_pct ?? 0),
      sort_order: values.sort_order ?? 0,
      completed_at: null,
      paused_at: null,
      archived_at: null,
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      schema_version: 1,
      deleted_at: null,
      origin_type: 'user_stated',
      origin_ref: null,
      origin_key: null,
      confirmation_status: 'not_required',
      evidence_refs: [],
      meta_json: null,
    }
    if (record.status === 'completed') record.completed_at = nowIso
    if (record.status === 'paused') record.paused_at = nowIso
    if (record.status === 'archived') record.archived_at = nowIso
    const view = projectView(record, [])
    const oplog = oplogRecord({
      action: 'project.create',
      targetType: 'project',
      targetId: record.id,
      targetIds: [record.id],
      after: view,
      nowIso,
    })
    return store
      .transaction([
        { unit: CORE, table: 'project', key: record.id, value: record },
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emit('project', [record.id], { action: 'create' })
        return { project: view, revision: record.rev }
      })
  }

  function updateProject(id, patch = {}, revInput) {
    assertWritable()
    const expectedRev = requireExpectedRev(revInput)
    const current = getRecord('project', id)
    if (!current) throw new LifeosError('not_found', `项目不存在：${id}`, { id })
    if (current.rev !== expectedRev) {
      throw new LifeosError('conflict', '项目已被修改，请刷新后重试', {
        current: projectView(current, tasksOfProject(id)),
        expectedRev,
        currentRev: current.rev,
      })
    }
    const values = projectFieldsFrom(patch)
    if (values.status === 'archived') {
      throw new LifeosError('invalid_state', '归档项目请使用 archiveProject（POST /projects/:id/archive）', { id })
    }
    if (values.name !== undefined) {
      const name = values.name
      const duplicate = allProjects().find(
        (project) => project.id !== id && String(project.name ?? '').trim().toLowerCase() === name.toLowerCase(),
      )
      if (duplicate) {
        throw new LifeosError('conflict', `项目已存在：${name}`, {
          current: projectView(duplicate, tasksOfProject(duplicate.id)),
        })
      }
    }
    const nowIso = currentIso()
    const next = { ...current, ...values, updated_at: nowIso, rev: current.rev + 1 }
    if (values.status === 'completed' && !next.completed_at) next.completed_at = nowIso
    if (values.status === 'paused' && !next.paused_at) next.paused_at = nowIso
    if (values.progress_pct !== undefined) next.progress_pct = clampPercent(values.progress_pct)
    const changedFields = Object.keys(values).filter((field) => field !== 'status' || values.status !== current.status)
    const diffs = diffOf(current, next, changedFields)
    const view = projectView(next, tasksOfProject(id))
    const changes = stateChangeRecords('project', id, diffs, nowIso, next.rev)
    const oplog = oplogRecord({
      action: 'project.update',
      targetType: 'project',
      targetId: id,
      targetIds: [id],
      before: projectView(current, tasksOfProject(id)),
      after: view,
      stateChangeIds: changes.map((record) => record.id),
      nowIso,
    })
    return store
      .transaction([
        { unit: CORE, table: 'project', key: id, value: next },
        ...changes.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emit('project', [id], { action: 'update' })
        return { project: view, revision: next.rev, diff: diffs.map((diff) => ({ field: diff.field, oldValue: diff.oldValue, newValue: diff.newValue })) }
      })
  }

  function archiveProject(id, revInput) {
    assertWritable()
    const expectedRev = requireExpectedRev(revInput)
    const current = getRecord('project', id)
    if (!current) throw new LifeosError('not_found', `项目不存在：${id}`, { id })
    if (current.rev !== expectedRev) {
      throw new LifeosError('conflict', '项目已被修改，请刷新后重试', {
        current: projectView(current, tasksOfProject(id)),
        expectedRev,
        currentRev: current.rev,
      })
    }
    const nowIso = currentIso()
    const next = { ...current, status: 'archived', archived_at: nowIso, updated_at: nowIso, rev: current.rev + 1 }
    const view = projectView(next, tasksOfProject(id))
    const changes = stateChangeRecords(
      'project',
      id,
      [{ field: 'status', oldValue: current.status, newValue: 'archived' }],
      nowIso,
      next.rev,
    )
    const oplog = oplogRecord({
      action: 'project.archive',
      targetType: 'project',
      targetId: id,
      targetIds: [id],
      before: projectView(current, tasksOfProject(id)),
      after: view,
      stateChangeIds: changes.map((record) => record.id),
      nowIso,
    })
    return store
      .transaction([
        { unit: CORE, table: 'project', key: id, value: next },
        ...changes.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emit('project', [id], { action: 'archive' })
        return { project: view, revision: next.rev }
      })
  }

  /* ── 目标 ─────────────────────────────────────────────── */

  function listGoals(input = {}) {
    const query = isPlainObject(input) ? input : {}
    const includeArchived = query.includeArchived === true
    const status = typeof query.status === 'string' ? query.status : null
    let items = sortByOrderThenCreated(allGoals())
    if (status) items = items.filter((goal) => (goal.status ?? 'active') === status)
    if (!includeArchived) items = items.filter((goal) => !goal.archived_at)
    const tasks = allTasks()
    return {
      items: items.map((goal) => goalView(goal, tasks.filter((task) => task.goal_id === goal.id))),
    }
  }

  function getGoal(id) {
    const goal = getRecord('goal', id)
    if (!goal) throw new LifeosError('not_found', `目标不存在：${id}`, { id })
    const tasks = tasksOfGoal(id)
    return {
      goal: goalView(goal, tasks),
      tasks: sortByOrderThenCreated(tasks).map(taskLite),
      progress: goalProgress(goal, tasks),
    }
  }

  function applyGoalLifecycle(record, values, nowIso) {
    if (values.status === 'achieved') {
      record.achieved_at = record.achieved_at ?? nowIso
      record.abandoned_reason = null
      return
    }
    if (values.status === 'abandoned') {
      const reason = values.abandoned_reason ?? record.abandoned_reason
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw validationError('放弃目标必须提供 abandoned_reason', ['abandoned_reason 必填'])
      }
      record.abandoned_reason = reason.trim()
      record.achieved_at = null
      return
    }
    if (values.status !== undefined) {
      record.achieved_at = null
    }
  }

  function createGoal(input = {}) {
    assertWritable()
    const nowIso = currentIso()
    const values = goalFieldsFrom(input)
    if (!values.title) throw validationError('目标 title 必填', ['title 必填'])
    const warnings = []
    let progressMode = values.progress_mode ?? 'manual'
    if (progressMode === 'auto_by_projects') {
      progressMode = 'manual'
      warnings.push('auto_by_projects 在 M4a 暂未实现，已降级为 manual')
    }
    const record = {
      id: newId('gol'),
      title: values.title,
      description: values.description ?? null,
      success_criteria: values.success_criteria ?? null,
      horizon: values.horizon ?? 'mid',
      status: values.status ?? 'active',
      start_date: values.start_date ?? null,
      target_date: values.target_date ?? null,
      achieved_at: null,
      abandoned_reason: null,
      progress_mode: progressMode,
      progress_pct: clampPercent(values.progress_pct ?? 0),
      archived_at: null,
      sort_order: values.sort_order ?? 0,
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      schema_version: 1,
      deleted_at: null,
      origin_type: 'user_stated',
      origin_ref: null,
      origin_key: null,
      confirmation_status: 'not_required',
      evidence_refs: [],
      meta_json: null,
    }
    applyGoalLifecycle(record, values, nowIso)
    const view = goalView(record, [])
    const oplog = oplogRecord({
      action: 'goal.create',
      targetType: 'goal',
      targetId: record.id,
      targetIds: [record.id],
      after: view,
      nowIso,
    })
    return store
      .transaction([
        { unit: CORE, table: 'goal', key: record.id, value: record },
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emit('goal', [record.id], { action: 'create' })
        return { goal: view, revision: record.rev, warnings }
      })
  }

  function updateGoal(id, patch = {}, revInput) {
    assertWritable()
    const expectedRev = requireExpectedRev(revInput)
    const current = getRecord('goal', id)
    if (!current) throw new LifeosError('not_found', `目标不存在：${id}`, { id })
    if (current.rev !== expectedRev) {
      throw new LifeosError('conflict', '目标已被修改，请刷新后重试', {
        current: goalView(current, tasksOfGoal(id)),
        expectedRev,
        currentRev: current.rev,
      })
    }
    const values = goalFieldsFrom(patch)
    const warnings = []
    if (values.progress_mode === 'auto_by_projects') {
      values.progress_mode = 'manual'
      warnings.push('auto_by_projects 在 M4a 暂未实现，已降级为 manual')
    }
    const nowIso = currentIso()
    const next = { ...current, ...values, updated_at: nowIso, rev: current.rev + 1 }
    if (values.progress_pct !== undefined) next.progress_pct = clampPercent(values.progress_pct)
    applyGoalLifecycle(next, values, nowIso)
    const diffs = diffOf(current, next, Object.keys(values))
    const view = goalView(next, tasksOfGoal(id))
    const changes = stateChangeRecords('goal', id, diffs, nowIso, next.rev)
    const oplog = oplogRecord({
      action: 'goal.update',
      targetType: 'goal',
      targetId: id,
      targetIds: [id],
      before: goalView(current, tasksOfGoal(id)),
      after: view,
      stateChangeIds: changes.map((record) => record.id),
      nowIso,
    })
    return store
      .transaction([
        { unit: CORE, table: 'goal', key: id, value: next },
        ...changes.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emit('goal', [id], { action: 'update' })
        return { goal: view, revision: next.rev, diff: diffs, warnings }
      })
  }

  function archiveGoal(id, revInput) {
    assertWritable()
    const expectedRev = requireExpectedRev(revInput)
    const current = getRecord('goal', id)
    if (!current) throw new LifeosError('not_found', `目标不存在：${id}`, { id })
    if (current.rev !== expectedRev) {
      throw new LifeosError('conflict', '目标已被修改，请刷新后重试', {
        current: goalView(current, tasksOfGoal(id)),
        expectedRev,
        currentRev: current.rev,
      })
    }
    const nowIso = currentIso()
    const next = { ...current, archived_at: nowIso, updated_at: nowIso, rev: current.rev + 1 }
    const view = goalView(next, tasksOfGoal(id))
    const changes = stateChangeRecords(
      'goal',
      id,
      [{ field: 'archived_at', oldValue: current.archived_at ?? null, newValue: nowIso }],
      nowIso,
      next.rev,
    )
    const oplog = oplogRecord({
      action: 'goal.archive',
      targetType: 'goal',
      targetId: id,
      targetIds: [id],
      before: goalView(current, tasksOfGoal(id)),
      after: view,
      stateChangeIds: changes.map((record) => record.id),
      nowIso,
    })
    return store
      .transaction([
        { unit: CORE, table: 'goal', key: id, value: next },
        ...changes.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emit('goal', [id], { action: 'archive' })
        return { goal: view, revision: next.rev }
      })
  }

  /* ── 愿望 ─────────────────────────────────────────────── */

  function listWishes(input = {}) {
    const query = isPlainObject(input) ? input : {}
    const status = typeof query.status === 'string' ? query.status : null
    let items = sortByOrderThenCreated(allWishes())
    if (status) items = items.filter((wish) => (wish.status ?? 'captured') === status)
    return { items: items.map(wishView) }
  }

  function getWish(id) {
    const wish = getRecord('wish', id)
    if (!wish) throw new LifeosError('not_found', `愿望不存在：${id}`, { id })
    const link =
      allLinks().find(
        (item) =>
          item.from_type === 'wish' && item.from_id === id && item.link_type === 'converted_to' && !item.deleted_at,
      ) ?? null
    return { wish: wishView(wish), link }
  }

  function createWish(input = {}) {
    assertWritable()
    const nowIso = currentIso()
    const values = wishFieldsFrom(input)
    if (!values.title) throw validationError('愿望 title 必填', ['title 必填'])
    if (values.status === 'committed') {
      throw validationError('新建愿望不能直接为 committed（请用 convertWish 转化）', ['status: 不允许 committed'])
    }
    const record = {
      id: newId('wsh'),
      title: values.title,
      description: values.description ?? null,
      status: values.status ?? 'captured',
      converted_to_goal_id: null,
      converted_at: null,
      review_at: values.review_at ?? null,
      sort_order: values.sort_order ?? 0,
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      schema_version: 1,
      deleted_at: null,
      origin_type: 'user_stated',
      origin_ref: null,
      origin_key: null,
      confirmation_status: 'not_required',
      evidence_refs: [],
      meta_json: null,
    }
    const view = wishView(record)
    const oplog = oplogRecord({
      action: 'wish.create',
      targetType: 'wish',
      targetId: record.id,
      targetIds: [record.id],
      after: view,
      nowIso,
    })
    return store
      .transaction([
        { unit: CORE, table: 'wish', key: record.id, value: record },
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emit('wish', [record.id], { action: 'create' })
        return { wish: view, revision: record.rev }
      })
  }

  function updateWish(id, patch = {}, revInput) {
    assertWritable()
    const expectedRev = requireExpectedRev(revInput)
    const current = getRecord('wish', id)
    if (!current) throw new LifeosError('not_found', `愿望不存在：${id}`, { id })
    if (current.rev !== expectedRev) {
      throw new LifeosError('conflict', '愿望已被修改，请刷新后重试', {
        current: wishView(current),
        expectedRev,
        currentRev: current.rev,
      })
    }
    const values = wishFieldsFrom(patch)
    if (values.status === 'committed' && !current.converted_to_goal_id) {
      throw validationError('committed 愿望必须已有 converted_to_goal_id（请用 convertWish）', [
        'converted_to_goal_id 缺失',
      ])
    }
    const nowIso = currentIso()
    const next = { ...current, ...values, updated_at: nowIso, rev: current.rev + 1 }
    const diffs = diffOf(current, next, Object.keys(values))
    const view = wishView(next)
    const changes = stateChangeRecords('wish', id, diffs, nowIso, next.rev)
    const oplog = oplogRecord({
      action: 'wish.update',
      targetType: 'wish',
      targetId: id,
      targetIds: [id],
      before: wishView(current),
      after: view,
      stateChangeIds: changes.map((record) => record.id),
      nowIso,
    })
    return store
      .transaction([
        { unit: CORE, table: 'wish', key: id, value: next },
        ...changes.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emit('wish', [id], { action: 'update' })
        return { wish: view, revision: next.rev, diff: diffs }
      })
  }

  /**
   * 愿望 → 目标：单事务写入 goal + wish.converted_to_goal_id/status + entity_link + oplog/state_change。
   * @returns {Promise<{wish: object, goal: object, link: object, revision: number}>}
   */
  function convertWish(id, input = {}) {
    assertWritable()
    const payload = isPlainObject(input) ? input : {}
    const wish = getRecord('wish', id)
    if (!wish) throw new LifeosError('not_found', `愿望不存在：${id}`, { id })
    if (wish.converted_to_goal_id || wish.status === 'committed') {
      throw new LifeosError('conflict', '愿望已转化，不能重复转化', { current: wishView(wish) })
    }
    const optionalRev = expectedRevOf(payload)
    if (optionalRev !== undefined && optionalRev !== null) {
      if (!Number.isInteger(optionalRev) || optionalRev < 1) {
        throw validationError('expectedRev 必须是正整数', ['expectedRev 非法'])
      }
      if (wish.rev !== optionalRev) {
        throw new LifeosError('conflict', '愿望已被修改，请刷新后重试', {
          current: wishView(wish),
          expectedRev: optionalRev,
          currentRev: wish.rev,
        })
      }
    }
    const goalInput = isPlainObject(payload.goal) ? payload.goal : null
    if (!goalInput) throw validationError('convertWish 需要 goal 对象', ['goal 必填'])
    const nowIso = currentIso()
    const goalValues = goalFieldsFrom({ ...goalInput, title: goalInput.title ?? wish.title })
    const warnings = []
    let progressMode = goalValues.progress_mode ?? 'manual'
    if (progressMode === 'auto_by_projects') {
      progressMode = 'manual'
      warnings.push('auto_by_projects 在 M4a 暂未实现，已降级为 manual')
    }
    const goalRecord = {
      id: newId('gol'),
      title: goalValues.title,
      description: goalValues.description ?? wish.description ?? null,
      success_criteria: goalValues.success_criteria ?? null,
      horizon: goalValues.horizon ?? 'mid',
      status: goalValues.status ?? 'active',
      start_date: goalValues.start_date ?? null,
      target_date: goalValues.target_date ?? null,
      achieved_at: null,
      abandoned_reason: null,
      progress_mode: progressMode,
      progress_pct: clampPercent(goalValues.progress_pct ?? 0),
      archived_at: null,
      sort_order: goalValues.sort_order ?? 0,
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      schema_version: 1,
      deleted_at: null,
      origin_type: 'user_stated',
      origin_ref: null,
      origin_key: null,
      confirmation_status: 'not_required',
      evidence_refs: [],
      meta_json: { source: 'wish', wish_id: id },
    }
    applyGoalLifecycle(goalRecord, goalValues, nowIso)
    const wishNext = {
      ...wish,
      status: 'committed',
      converted_to_goal_id: goalRecord.id,
      converted_at: nowIso,
      updated_at: nowIso,
      rev: wish.rev + 1,
    }
    const link = {
      id: newId('lnk'),
      from_type: 'wish',
      from_id: id,
      to_type: 'goal',
      to_id: goalRecord.id,
      link_type: 'converted_to',
      weight: 1,
      created_at: nowIso,
      updated_at: nowIso,
      rev: 1,
      schema_version: 1,
      deleted_at: null,
      origin_type: 'user_stated',
      origin_ref: null,
      confirmation_status: 'not_required',
      evidence_refs: [],
      meta_json: null,
    }
    const changes = stateChangeRecords(
      'wish',
      id,
      [
        { field: 'status', oldValue: wish.status, newValue: 'committed' },
        { field: 'converted_to_goal_id', oldValue: wish.converted_to_goal_id ?? null, newValue: goalRecord.id },
      ],
      nowIso,
      wishNext.rev,
    )
    const goalViewRecord = goalView(goalRecord, [])
    const wishViewRecord = wishView(wishNext)
    const oplog = oplogRecord({
      action: 'wish.convert',
      targetType: 'wish',
      targetId: id,
      targetIds: [id, goalRecord.id],
      before: wishView(wish),
      after: { wish: wishViewRecord, goal: goalViewRecord },
      stateChangeIds: changes.map((record) => record.id),
      nowIso,
      meta: { source: 'm4a', goalId: goalRecord.id, linkId: link.id },
    })
    return store
      .transaction([
        { unit: CORE, table: 'goal', key: goalRecord.id, value: goalRecord },
        { unit: CORE, table: 'wish', key: id, value: wishNext },
        { unit: CORE, table: 'entity_link', key: link.id, value: link },
        ...changes.map((record) => ({ unit: LOG, table: 'state_change', key: record.id, value: record })),
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emit('goal', [goalRecord.id], { action: 'create', fromWish: id })
        emit('wish', [id], { action: 'convert', goalId: goalRecord.id })
        return { wish: wishViewRecord, goal: goalViewRecord, link, revision: wishNext.rev, warnings }
      })
  }

  return {
    // project
    listProjects,
    getProject,
    createProject,
    updateProject,
    archiveProject,
    // goal
    listGoals,
    getGoal,
    createGoal,
    updateGoal,
    archiveGoal,
    // wish
    listWishes,
    getWish,
    createWish,
    updateWish,
    convertWish,
  }
}

export { PROJECT_STATUSES, GOAL_STATUSES, WISH_STATUSES, GOAL_HORIZONS }
