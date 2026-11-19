/**
 * LifeOS — Task 领域规则（A 线：domain）
 *
 * M1 契约：`M1-PLAN.md` §1.2 状态机 / §1.3 时间形态。
 * - 状态机：todo → doing → done；todo/doing → cancelled；done/cancelled → todo（重开）。
 * - 时间三形态：无时间 / 日期（scheduled_date + is_all_day=true）/ 时间段（start < end）。
 *   另有"仅截止"（due_date 或 due_at，互斥，不参与日历块）。
 * - 全部为纯函数：不写库、不生成 id/rev（由 store/B 服务负责）。
 * 零依赖：仅使用同目录 time.js。
 */

import { isIsoTimestamp, isLocalDate, nowIso } from './time.js'

export const TASK_STATUSES = Object.freeze(['todo', 'doing', 'done', 'cancelled'])
export const TASK_OPEN_STATUSES = Object.freeze(['todo', 'doing'])
export const TASK_ACTIONS = Object.freeze(['start', 'complete', 'cancel', 'reopen'])
export const TASK_PRIORITIES = Object.freeze(['none', 'low', 'medium', 'high'])
export const TASK_TIME_KINDS = Object.freeze(['none', 'all_day', 'span'])
/** M8 重复规则种类（task.repeat_rule / API repeatRule）。 */
export const REPEAT_KINDS = Object.freeze(['daily', 'weekly', 'monthly'])

/**
 * 合法转换表：status → { action: nextStatus }。
 * done/cancelled 只能 reopen 回 todo，不允许直接到 doing。
 */
export const TASK_TRANSITIONS = Object.freeze({
  todo: Object.freeze({ start: 'doing', complete: 'done', cancel: 'cancelled' }),
  doing: Object.freeze({ complete: 'done', cancel: 'cancelled' }),
  done: Object.freeze({ reopen: 'todo' }),
  cancelled: Object.freeze({ reopen: 'todo' }),
})

export const TASK_ACTION_LABELS = Object.freeze({
  start: '开始',
  complete: '完成',
  cancel: '取消',
  reopen: '重开',
})

/** 某状态下允许的动作列表。 */
export function allowedActions(status) {
  return Object.keys(TASK_TRANSITIONS[status] ?? {})
}

/** 指定状态下某动作是否合法。 */
export function canTransition(status, action) {
  return Boolean(TASK_TRANSITIONS[status]?.[action])
}

/**
 * 执行一次状态转换（纯函数，不修改入参）。
 * @param {object} task 任务记录（至少含 status）
 * @param {'start'|'complete'|'cancel'|'reopen'} action
 * @param {{now?: string}} [options]
 * @returns {{ok: true, task: object, changedFields: string[], nextStatus: string} | {ok: false, errors: string[], allowed: string[]}}
 */
export function transitionTask(task, action, options = {}) {
  const current = task && typeof task === 'object' ? task.status : undefined
  if (!TASK_STATUSES.includes(current)) {
    return { ok: false, errors: [`task.status 非法：${String(current)}`], allowed: [...TASK_ACTIONS] }
  }
  const nextStatus = TASK_TRANSITIONS[current]?.[action]
  if (!nextStatus) {
    return {
      ok: false,
      errors: [`非法转换：${current} --${String(action)}-->（允许动作：${allowedActions(current).join('|') || '无'}）`],
      allowed: allowedActions(current),
    }
  }
  const now = typeof options.now === 'string' && isIsoTimestamp(options.now) ? options.now : nowIso()
  const next = { ...task, status: nextStatus }
  const changedFields = ['status']
  if (action === 'complete') {
    next.completed_at = now
    changedFields.push('completed_at')
  } else if (action === 'cancel') {
    next.cancelled_at = now
    changedFields.push('cancelled_at')
  } else if (action === 'reopen') {
    if (next.completed_at !== null && next.completed_at !== undefined) changedFields.push('completed_at')
    if (next.cancelled_at !== null && next.cancelled_at !== undefined) changedFields.push('cancelled_at')
    next.completed_at = null
    next.cancelled_at = null
  }
  return { ok: true, task: next, changedFields, nextStatus }
}

/**
 * 直接改 status（PATCH {status}）的合法性：映射为等价动作。
 * @returns {{ok: true, action: string|null, nextStatus: string} | {ok: false, errors: string[], allowed: string[]}}
 */
export function validateStatusChange(fromStatus, toStatus) {
  if (!TASK_STATUSES.includes(fromStatus)) {
    return { ok: false, errors: [`当前 status 非法：${String(fromStatus)}`], allowed: [] }
  }
  if (!TASK_STATUSES.includes(toStatus)) {
    return { ok: false, errors: [`目标 status 非法：${String(toStatus)}`], allowed: [...TASK_STATUSES] }
  }
  if (fromStatus === toStatus) return { ok: true, action: null, nextStatus: toStatus }
  const entry = Object.entries(TASK_TRANSITIONS[fromStatus] ?? {}).find(([, next]) => next === toStatus)
  if (!entry) {
    return {
      ok: false,
      errors: [`不允许从 ${fromStatus} 直接改到 ${toStatus}（请用 complete/cancel/reopen 动作）`],
      allowed: allowedActions(fromStatus),
    }
  }
  return { ok: true, action: entry[0], nextStatus: toStatus }
}

function pick(input, snake, camel) {
  if (!input || typeof input !== 'object') return undefined
  if (input[snake] !== undefined) return input[snake]
  if (camel && input[camel] !== undefined) return input[camel]
  return undefined
}

function normalizeOptionalString(value) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * 规范化任务的重复规则（M8；API 字段 repeatRule，存储字段 repeat_rule）。
 *
 * 形状：null | {kind:'daily'} | {kind:'weekly', days:number[]} | {kind:'monthly', day:number}
 * - weekly.days：1..7 的整数（1=周一），去重后升序，非空；
 * - monthly.day：1..31 的整数；
 * - daily 的多余字段忽略（只保留 kind）；其他 kind 的非白名单字段同样丢弃。
 *
 * @param {unknown} value 用户输入（undefined/未提供 → null）
 * @returns {{ok: true, value: null|object} | {ok: false, errors: string[]}}
 */
export function normalizeRepeatRule(value) {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['repeatRule 必须是对象或 null'] }
  }
  const kind = value.kind
  if (typeof kind !== 'string' || !REPEAT_KINDS.includes(kind)) {
    return { ok: false, errors: [`repeatRule.kind 非法：${String(kind)}（允许：daily|weekly|monthly）`] }
  }
  if (kind === 'daily') return { ok: true, value: { kind: 'daily' } }
  if (kind === 'weekly') {
    if (!Array.isArray(value.days) || value.days.length === 0) {
      return { ok: false, errors: ['repeatRule.days 必须是非空数组（1..7，1=周一）'] }
    }
    const days = []
    for (const day of value.days) {
      if (!Number.isInteger(day) || day < 1 || day > 7) {
        return { ok: false, errors: [`repeatRule.days 只能包含 1..7 的整数：${String(day)}`] }
      }
      if (!days.includes(day)) days.push(day)
    }
    days.sort((a, b) => a - b)
    return { ok: true, value: { kind: 'weekly', days } }
  }
  if (!Number.isInteger(value.day) || value.day < 1 || value.day > 31) {
    return { ok: false, errors: [`repeatRule.day 必须是 1..31 的整数：${String(value.day)}`] }
  }
  return { ok: true, value: { kind: 'monthly', day: value.day } }
}

/**
 * 规范化新建/更新任务的输入（接受 snake_case 与 API 的 camelCase）。
 *
 * 结果字段（存储形态，不含 id/status/rev；创建时由调用方补）：
 * title, notes, priority, project_id,
 * scheduled_date, scheduled_start_at, scheduled_end_at, is_all_day, time_kind,
 * due_date, due_at, repeat_rule
 *
 * @param {object} input 用户输入（可含 camelCase）
 * @param {{current?: object|null}} [options] 更新时传当前记录（未提供字段沿用 current）
 * @returns {{ok: true, value: object, changedFields: string[]} | {ok: false, errors: string[]}}
 */
export function normalizeTaskInput(input, options = {}) {
  const errors = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['input 必须是对象'] }
  }
  const current = options.current && typeof options.current === 'object' ? options.current : null
  const changedFields = []

  const read = (snake, camel, fallback) => {
    const provided = pick(input, snake, camel)
    if (provided !== undefined) return provided
    if (current && current[snake] !== undefined && current[snake] !== null) return current[snake]
    return fallback
  }

  // title
  let title = read('title', 'title', current?.title ?? '')
  if (typeof title !== 'string') {
    errors.push('title 必须是字符串')
    title = ''
  } else {
    title = title.trim()
  }
  if (!title) errors.push('title 不能为空')
  if (title.length > 500) errors.push('title 不能超过 500 字符')

  // notes
  let notes = read('notes', 'notes', current?.notes ?? null)
  notes = normalizeOptionalString(notes)
  if (notes !== undefined && notes !== null && typeof notes !== 'string') errors.push('notes 必须是字符串或 null')
  if (typeof notes === 'string' && notes.length > 20000) errors.push('notes 不能超过 20000 字符')

  // priority
  const priorityRaw = read('priority', 'priority', current?.priority ?? 'none')
  let priority = priorityRaw
  if (priority === null || priority === undefined) priority = 'none'
  if (!TASK_PRIORITIES.includes(priority)) errors.push(`priority 必须是 ${TASK_PRIORITIES.join('|')}`)

  // project
  const projectIdRaw = read('project_id', 'projectId', current?.project_id ?? null)
  const project_id = normalizeOptionalString(projectIdRaw)
  if (project_id !== undefined && project_id !== null && typeof project_id !== 'string') {
    errors.push('project_id 必须是字符串或 null')
  }

  // 时间字段（null = 清除；未提供 = 沿用 current）
  const scheduledDateRaw = read('scheduled_date', 'scheduledDate', current?.scheduled_date ?? null)
  const startRaw = read('scheduled_start_at', 'scheduledStartAt', current?.scheduled_start_at ?? null)
  const endRaw = read('scheduled_end_at', 'scheduledEndAt', current?.scheduled_end_at ?? null)
  const allDayRaw = read('is_all_day', 'isAllDay', current?.is_all_day ?? undefined)
  const dueDateRaw = read('due_date', 'dueDate', current?.due_date ?? null)
  const dueAtRaw = read('due_at', 'dueAt', current?.due_at ?? null)

  const scheduled_date = scheduledDateRaw === null || scheduledDateRaw === undefined ? null : scheduledDateRaw
  const scheduled_start_at = startRaw === null || startRaw === undefined ? null : startRaw
  const scheduled_end_at = endRaw === null || endRaw === undefined ? null : endRaw
  const due_date = dueDateRaw === null || dueDateRaw === undefined ? null : dueDateRaw
  const due_at = dueAtRaw === null || dueAtRaw === undefined ? null : dueAtRaw

  if (scheduled_date !== null && !isLocalDate(scheduled_date)) errors.push('scheduled_date 必须是 YYYY-MM-DD')
  if (scheduled_start_at !== null && !isIsoTimestamp(scheduled_start_at)) {
    errors.push('scheduled_start_at 必须是 UTC ISO 时刻（毫秒 + Z）')
  }
  if (scheduled_end_at !== null && !isIsoTimestamp(scheduled_end_at)) {
    errors.push('scheduled_end_at 必须是 UTC ISO 时刻（毫秒 + Z）')
  }
  if (due_date !== null && !isLocalDate(due_date)) errors.push('due_date 必须是 YYYY-MM-DD')
  if (due_at !== null && !isIsoTimestamp(due_at)) errors.push('due_at 必须是 UTC ISO 时刻（毫秒 + Z）')

  // 形态互斥/顺序（M1-PLAN §1.3）
  const hasDate = scheduled_date !== null
  const hasStart = scheduled_start_at !== null
  const hasEnd = scheduled_end_at !== null
  if (hasDate && (hasStart || hasEnd)) errors.push('scheduled_date 与 scheduled_start_at/end_at 互斥（日期型或时间段型二选一）')
  if (hasStart !== hasEnd) errors.push('时间段必须同时提供 scheduled_start_at 与 scheduled_end_at')
  if (hasStart && hasEnd && scheduled_start_at >= scheduled_end_at) {
    errors.push('scheduled_start_at 必须早于 scheduled_end_at')
  }
  if (due_date !== null && due_at !== null) errors.push('due_date 与 due_at 互斥')
  if (allDayRaw !== undefined && allDayRaw !== null && typeof allDayRaw !== 'boolean') {
    errors.push('is_all_day 必须是布尔值')
  }
  // 显式传入 is_all_day 时才做形态冲突校验；从 current 继承的值不应阻止"改期切换形态"
  const allDayExplicit = pick(input, 'is_all_day', 'isAllDay')
  if (hasDate && allDayExplicit === false) errors.push('日期型任务必须 is_all_day=true')
  if (hasStart && allDayExplicit === true) errors.push('时间段任务必须 is_all_day=false')

  let isAllDay = false
  if (hasDate) isAllDay = true
  else if (hasStart) isAllDay = false
  else if (typeof allDayExplicit === 'boolean') isAllDay = allDayExplicit
  else if (typeof allDayRaw === 'boolean') isAllDay = allDayRaw

  let time_kind = 'none'
  if (hasDate) time_kind = 'all_day'
  else if (hasStart) time_kind = 'span'

  // repeat_rule（M8；输入字段 repeatRule，null 表示清除，undefined 沿用 current）
  const repeatRule = normalizeRepeatRule(read('repeat_rule', 'repeatRule', current?.repeat_rule ?? null))
  if (!repeatRule.ok) errors.push(...repeatRule.errors)

  if (errors.length > 0) return { ok: false, errors }

  const value = {
    title,
    notes,
    priority,
    project_id,
    scheduled_date,
    scheduled_start_at,
    scheduled_end_at,
    is_all_day: isAllDay,
    time_kind,
    due_date,
    due_at,
    repeat_rule: repeatRule.value,
  }
  if (current) {
    for (const [field, next] of Object.entries(value)) {
      const before = current[field] === undefined ? null : current[field]
      if (JSON.stringify(before) !== JSON.stringify(next)) changedFields.push(field)
    }
  }
  return { ok: true, value, changedFields }
}

/** 更新：patch 覆盖 current 后复用 normalizeTaskInput。 */
export function normalizeTaskUpdate(patch, current, options = {}) {
  if (!current || typeof current !== 'object') return { ok: false, errors: ['current 任务记录缺失'] }
  return normalizeTaskInput(patch, { ...options, current })
}

/** 由已规范化字段派生 time_kind（供详情展示/迁移用）。 */
export function timeKindOf(task) {
  if (!task || typeof task !== 'object') return 'none'
  if (task.scheduled_date) return 'all_day'
  if (task.scheduled_start_at && task.scheduled_end_at) return 'span'
  return 'none'
}


// ---------------------------------------------------------------------------
// 兼容导出：B 的 `src/application/task-domain.js` 适配层按以下名字动态探测
// （若存在则切换到 A 的实现）。语义与本文件主 API 一致，仅签名适配。
// ---------------------------------------------------------------------------

function throwRuleError(message, details) {
  const error = new Error(message)
  error.code = 'validation_failed'
  error.details = details
  throw error
}

/** 断言动作合法；不合法 throw（error.code='validation_failed', details.allowed）。 */
export function assertTransition(task, action) {
  if (!task || typeof task !== 'object') {
    throwRuleError('task 记录缺失', { action })
  }
  const next = TASK_TRANSITIONS[task.status]?.[action]
  if (!next) {
    throwRuleError(`任务状态 ${String(task.status)} 不允许 ${String(action)}（允许：${allowedActions(task.status).join('|') || '无'}）`, {
      allowed: allowedActions(task.status),
      current: task.status,
      action,
    })
  }
  return true
}

/** 动作后的字段补丁（不修改入参）：{status, completed_at?, cancelled_at?}。 */
export function applyAction(task, action, nowIsoString) {
  assertTransition(task, action)
  const now = typeof nowIsoString === 'string' && isIsoTimestamp(nowIsoString) ? nowIsoString : nowIso()
  if (action === 'complete') return { status: 'done', completed_at: now }
  if (action === 'reopen') return { status: 'todo', completed_at: null, cancelled_at: null }
  return { status: 'cancelled', cancelled_at: now }
}

/**
 * 时间形态归一化（B 适配层签名）：兼容 camelCase patch 与 snake_case current。
 * @returns {{fields: object, errors: string[]}}
 */
export function normalizeTime(current, patch) {
  const result = normalizeTaskInput(patch ?? {}, { current: current ?? null })
  if (!result.ok) return { fields: {}, errors: result.errors }
  const base = current ?? {}
  const clearedSchedule = result.value.scheduled_date === null && result.value.scheduled_start_at === null
  const clearedDue = result.value.due_at === null
  return {
    fields: {
      scheduled_date: result.value.scheduled_date,
      scheduled_start_at: result.value.scheduled_start_at,
      scheduled_end_at: result.value.scheduled_end_at,
      scheduled_tz: clearedSchedule ? null : base.scheduled_tz ?? null,
      due_date: result.value.due_date,
      due_at: result.value.due_at,
      due_tz: clearedDue ? null : base.due_tz ?? null,
      is_all_day: result.value.is_all_day,
      time_kind: result.value.time_kind,
    },
    errors: [],
  }
}
