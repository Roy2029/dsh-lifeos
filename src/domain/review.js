/**
 * A：M4 回顾领域纯函数（M4-PLAN §3.4，口径对齐 design/04 §7.8）。
 *
 * 纯函数：输入已聚合的数据（tasks/habits/habitStats/inboxCounts/projectStats），
 * 输出回顾 tab 的周/月摘要；不读 store、不依赖服务层。
 *
 * 口径：
 *  - completed = 期间内 completed_at 的任务数（排除已归档/已删）；
 *  - created = 期间内 created_at 的任务数；
 *  - open = 当前未完成（todo/doing）；
 *  - overdue = due_date/due_at 已过且未完成（中性展示，不做评判）；
 *  - habits_met = 期间达标周期数（优先用 habitStats 明细里携带的周期历史，否则用当前周期 met）；
 *  - inbox 用 counts（pending / to_confirm）直接透传。
 */

import { addDays, isLocalDate, localDate, localDateOfIso } from './time.js'
import { weekStartOf } from './habit.js'

const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function monthEndOf(dateString) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString)
  if (!parts) return dateString
  const year = Number(parts[1])
  const month = Number(parts[2])
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`
}

function resolveAnchor(period, anchorLocalDate, timeZone) {
  if (isLocalDate(anchorLocalDate)) return anchorLocalDate
  // 未传 anchor 时按“当前时刻”兜底；测试/服务层应显式传入。
  return localDate(timeZone, new Date())
}

/**
 * 计算回顾区间。
 * @param {'week'|'month'} period
 * @param {string} [anchorLocalDate]
 * @param {string} [weekStart]
 * @param {string} [timeZone]
 * @returns {{period: string, anchor: string, range: {start: string, end: string, label: string}}}
 */
export function resolveReviewRange(period, anchorLocalDate, weekStart = 'monday', timeZone = DEFAULT_TIME_ZONE) {
  const mode = period === 'month' ? 'month' : 'week'
  const anchor = resolveAnchor(mode, anchorLocalDate, timeZone)
  let start
  let end
  if (mode === 'month') {
    start = `${anchor.slice(0, 8)}01`
    end = monthEndOf(start)
  } else {
    start = weekStartOf(anchor, weekStart === 'sunday' ? 'sunday' : 'monday')
    end = addDays(start, 6)
  }
  return { period: mode, anchor, range: { start, end, label: `${start} ~ ${end}` } }
}

function localDateInRange(timeZone, iso, start, end) {
  if (typeof iso !== 'string' || iso.length === 0) return false
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return false
  const date = localDateOfIso(timeZone, parsed.toISOString())
  return date >= start && date <= end
}

function isLiveTask(task) {
  return isPlainObject(task) && !task.deleted_at && !task.archived_at
}

function isDoneTask(task) {
  return task.status === 'done'
}

function isOpenTask(task) {
  return task.status === 'todo' || task.status === 'doing'
}

function taskDueDate(timeZone, task) {
  if (isLocalDate(task.due_date)) return task.due_date
  if (typeof task.due_at === 'string' && task.due_at.length > 0) {
    const parsed = new Date(task.due_at)
    if (!Number.isNaN(parsed.getTime())) return localDateOfIso(timeZone, parsed.toISOString())
  }
  return null
}

function normalizeInboxCounts(inboxCounts) {
  if (!isPlainObject(inboxCounts)) return { pending: 0, toConfirm: 0 }
  const pending = inboxCounts.pending ?? inboxCounts.inbox_pending ?? inboxCounts.inboxPending ?? 0
  const toConfirm =
    inboxCounts.toConfirm ??
    inboxCounts.to_confirm ??
    inboxCounts.inbox_to_confirm ??
    inboxCounts.inboxToConfirm ??
    0
  return { pending: Math.max(0, toNumber(pending)), toConfirm: Math.max(0, toNumber(toConfirm)) }
}

function statsId(item) {
  return item.habitId ?? item.habit_id ?? item.id ?? null
}

function statsName(item, habit) {
  return item?.name ?? habit?.name ?? ''
}

function metPeriodsOf(item, range) {
  const list = Array.isArray(item?.periods) ? item.periods : Array.isArray(item?.history) ? item.history : null
  if (!list) {
    const met = item?.period?.met === true || item?.met === true
    return met ? 1 : 0
  }
  let count = 0
  for (const entry of list) {
    if (!isPlainObject(entry) || entry.met !== true) continue
    const start = isLocalDate(entry.start) ? entry.start : null
    if (start) {
      if (start >= range.start && start <= range.end) count += 1
      continue
    }
    const key = typeof entry.key === 'string' ? entry.key : ''
    if (key && key >= `${range.start.slice(0, 4)}` && key <= `${range.end.slice(0, 4)}-99`) count += 1
  }
  return count
}

/**
 * 组装回顾摘要。
 * @param {object} input
 * @param {'week'|'month'} [input.period]
 * @param {string} [input.anchorLocalDate]
 * @param {string} [input.timeZone]
 * @param {string} [input.weekStart]
 * @param {object[]} [input.tasks]
 * @param {object[]} [input.habits]
 * @param {object[]} [input.habitStats]
 * @param {object} [input.inboxCounts]
 * @param {object[]|object} [input.projectStats]
 */
export function buildReviewSummary(input = {}) {
  const payload = isPlainObject(input) ? input : {}
  const timeZone = typeof payload.timeZone === 'string' && payload.timeZone.length > 0 ? payload.timeZone : DEFAULT_TIME_ZONE
  const weekStart = payload.weekStart === 'sunday' ? 'sunday' : 'monday'
  const period = payload.period === 'month' ? 'month' : 'week'
  const resolved = resolveReviewRange(period, payload.anchorLocalDate, weekStart, timeZone)
  const { start, end } = resolved.range

  const tasks = Array.isArray(payload.tasks) ? payload.tasks.filter(isLiveTask) : []
  let completed = 0
  let created = 0
  let open = 0
  let overdue = 0
  for (const task of tasks) {
    if (localDateInRange(timeZone, task.completed_at, start, end) && isDoneTask(task)) completed += 1
    if (localDateInRange(timeZone, task.created_at, start, end)) created += 1
    if (isOpenTask(task)) open += 1
    if (!isDoneTask(task) && task.status !== 'cancelled') {
      const due = taskDueDate(timeZone, task)
      if (due && due < resolved.anchor) overdue += 1
    }
  }

  const habits = Array.isArray(payload.habits) ? payload.habits.filter(isPlainObject) : []
  const habitStats = Array.isArray(payload.habitStats) ? payload.habitStats.filter(isPlainObject) : []
  const habitById = new Map()
  for (const habit of habits) if (habit.id && !habit.deleted_at) habitById.set(habit.id, habit)

  const habitSource = habitStats.length > 0
    ? habitStats
    : habits.map((habit) => ({ habitId: habit.id, name: habit.name, period: null, coverage: null }))
  let habitsMet = 0
  const habitRows = habitSource.map((item) => {
    const id = statsId(item)
    const habit = id ? habitById.get(id) : null
    const target = item?.period?.target ?? item?.target ?? null
    const achieved = item?.period?.achieved ?? item?.achieved ?? 0
    const coverageRaw = isPlainObject(item?.coverage) ? item.coverage : null
    habitsMet += metPeriodsOf(item, resolved.range)
    return {
      habitId: id,
      name: statsName(item, habit),
      target: typeof target === 'number' && Number.isFinite(target) ? target : null,
      achieved: toNumber(achieved),
      met: item?.period?.met === true || item?.met === true,
      coverage: {
        recorded: toNumber(coverageRaw?.recorded),
        expected: toNumber(coverageRaw?.expected),
      },
    }
  })

  const inbox = normalizeInboxCounts(payload.inboxCounts)
  const projectSource = Array.isArray(payload.projectStats)
    ? payload.projectStats
    : isPlainObject(payload.projectStats)
      ? Object.values(payload.projectStats)
      : []
  const projects = projectSource
    .filter((item) => isPlainObject(item))
    .map((item) => {
      const progress = isPlainObject(item.progress) ? item.progress : null
      const done = progress ? progress.done : item.done
      const total = progress ? progress.total : item.total
      return {
        id: item.id ?? item.projectId ?? item.project_id ?? null,
        name: item.name ?? '',
        done: typeof done === 'number' && Number.isFinite(done) ? done : null,
        total: typeof total === 'number' && Number.isFinite(total) ? total : null,
      }
    })

  return {
    period: resolved.period,
    anchor: resolved.anchor,
    range: { start, end, label: resolved.range.label },
    cards: {
      completed,
      created,
      open,
      overdue,
      habits_met: habitsMet,
      habits_tracked: habitRows.length,
      inbox_pending: inbox.pending,
      inbox_to_confirm: inbox.toConfirm,
    },
    habits: habitRows,
    projects,
  }
}
