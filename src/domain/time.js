/**
 * LifeOS — 时间纯函数（A 线：领域层）
 *
 * 约定（见 design/08 §5.1 与 design/04 §2.4）：
 * - 时刻（TS）：UTC ISO-8601，毫秒精度，以 `Z` 结尾；落盘一律 UTC。
 * - 自然日（D）：`YYYY-MM-DD`，属于某个 IANA 时区下的自然日；**不能由 UTC 时刻反推**，
 *   必须用 localDate(tz, at) 计算。
 * - 默认时区 Asia/Shanghai（M0 冻结配置）。
 */

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

const formatterCache = new Map()

function formatterFor(timeZone) {
  const key = String(timeZone)
  let fmt = formatterCache.get(key)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: key,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatterCache.set(key, fmt)
  }
  return fmt
}

function partsOf(timeZone, date) {
  const parts = formatterFor(timeZone).formatToParts(date)
  const out = {}
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = p.value
  }
  return out
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 当前时刻的 UTC ISO 字符串（毫秒精度）。可传入 Date/时间戳用于测试。 */
export function nowIso(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) throw new TypeError('invalid date for nowIso')
  return d.toISOString()
}

/** IANA 时区是否合法（Intl 可识别）。 */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return false
  try {
    formatterFor(timeZone)
    return true
  } catch {
    return false
  }
}

/**
 * 给定时区下的自然日 `YYYY-MM-DD`。
 * @param {string} [timeZone]
 * @param {Date|number|string} [at]
 */
export function localDate(timeZone = DEFAULT_TIME_ZONE, at = new Date()) {
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) throw new TypeError('invalid date for localDate')
  const p = partsOf(timeZone, d)
  return `${p.year}-${p.month}-${p.day}`
}

/** 给定时区下，UTC 时刻所属的自然日（localDate 的别名，语义更清晰）。 */
export function localDateOfIso(timeZone, iso) {
  return localDate(timeZone, new Date(iso))
}

/** 严格校验 ISO UTC 时刻（毫秒精度、Z 结尾）。 */
export function isIsoTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TS_RE.test(value)) return false
  return Number.isFinite(Date.parse(value))
}

/** 校验自然日 `YYYY-MM-DD` 是否是真实存在的日期。 */
export function isLocalDate(value) {
  if (typeof value !== 'string') return false
  const m = LOCAL_DATE_RE.exec(value)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const t = Date.UTC(year, month - 1, day)
  const d = new Date(t)
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
}

/** 解析自然日；非法返回 null。 */
export function parseLocalDate(value) {
  if (!isLocalDate(value)) return null
  const m = LOCAL_DATE_RE.exec(value)
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

/** 由 {year,month,day} 格式化自然日。 */
export function formatLocalDate({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`
}

/** 自然日加减天数，返回新的 `YYYY-MM-DD`。 */
export function addDays(dateString, days) {
  const parsed = parseLocalDate(dateString)
  if (!parsed) throw new TypeError(`invalid local date: ${String(dateString)}`)
  if (!Number.isInteger(days)) throw new TypeError('days must be an integer')
  const d = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days))
  return formatLocalDate({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  })
}

/** 比较两个自然日：a<b 返回 -1，相等 0，a>b 返回 1。 */
export function compareLocalDate(a, b) {
  if (!isLocalDate(a) || !isLocalDate(b)) throw new TypeError('invalid local date in compareLocalDate')
  return a < b ? -1 : a > b ? 1 : 0
}

/** 给定时区在某一 UTC 时刻的偏移（分钟，东八区为 +480）。 */
function timeZoneOffsetMinutes(timeZone, date) {
  const p = partsOf(timeZone, date)
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  )
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000)
}

/**
 * 某自然日在该时区的 00:00 对应的 UTC ISO 时刻。
 * 通过两轮迭代逼近，兼容 DST 偏移变化。
 */
export function localDayStartIso(timeZone, dateString) {
  const parsed = parseLocalDate(dateString)
  if (!parsed) throw new TypeError(`invalid local date: ${String(dateString)}`)
  const naive = Date.UTC(parsed.year, parsed.month - 1, parsed.day)
  let guess = naive
  for (let i = 0; i < 3; i++) {
    const offset = timeZoneOffsetMinutes(timeZone, new Date(guess))
    const next = naive - offset * 60000
    if (next === guess) break
    guess = next
  }
  return new Date(guess).toISOString()
}

/** 某自然日的 [start, end) UTC 区间（end = 次日 00:00）。 */
export function localDayRangeIso(timeZone, dateString) {
  const next = addDays(dateString, 1)
  return { startIso: localDayStartIso(timeZone, dateString), endIso: localDayStartIso(timeZone, next) }
}

/** 判断某 UTC 时刻是否落在给定时区的某个自然日内。 */
export function isIsoOnLocalDate(timeZone, iso, dateString) {
  return localDateOfIso(timeZone, iso) === dateString
}


// =====================================================================
// M1 扩展：本地日/UTC 互转、任务视图口径工具（供 store 索引与日历使用）
// =====================================================================

/** 本地日期 + 本地时分（HH:mm）→ UTC ISO 时刻（M1 只支持整分；DST 当日按日首偏移近似）。 */
export function localDateTimeToIso(timeZone, dateString, timeOfDay = '00:00') {
  const base = Date.parse(localDayStartIso(timeZone, dateString))
  const m = /^(\d{2}):(\d{2})$/.exec(String(timeOfDay))
  if (!m) throw new TypeError(`invalid timeOfDay: ${String(timeOfDay)}`)
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (hours > 23 || minutes > 59) throw new TypeError(`invalid timeOfDay: ${String(timeOfDay)}`)
  return new Date(base + (hours * 60 + minutes) * 60000).toISOString()
}

/** 自然日闭区间 [fromDate, toDate] → [startIso, endExclusiveIso)（end = toDate+1 日 00:00）。 */
export function localDateRangeToIso(timeZone, fromDate, toDate) {
  if (!isLocalDate(fromDate) || !isLocalDate(toDate)) throw new TypeError('invalid local date range')
  if (fromDate > toDate) throw new TypeError('fromDate 不能晚于 toDate')
  return {
    startIso: localDayStartIso(timeZone, fromDate),
    endExclusiveIso: localDayStartIso(timeZone, addDays(toDate, 1)),
  }
}

/** 两个自然日相差天数（b - a）。 */
export function daysBetweenLocalDates(fromDate, toDate) {
  const a = parseLocalDate(fromDate)
  const b = parseLocalDate(toDate)
  if (!a || !b) throw new TypeError('invalid local date in daysBetweenLocalDates')
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000)
}

/** 自然日是否落在 [fromDate, toDate] 闭区间。 */
export function isLocalDateBetween(dateString, fromDate, toDate) {
  return isLocalDate(dateString) && dateString >= fromDate && dateString <= toDate
}

/** 自然日闭区间列表（最多 366 天，防爆炸）。 */
export function listLocalDates(fromDate, toDate) {
  if (!isLocalDate(fromDate) || !isLocalDate(toDate) || fromDate > toDate) return []
  const out = []
  let cursor = fromDate
  while (cursor <= toDate && out.length < 366) {
    out.push(cursor)
    cursor = addDays(cursor, 1)
  }
  return out
}

/** 任务是否全天/日期型（is_all_day=true，或只有 scheduled_date 没有起止时刻）。 */
export function isAllDayTask(task) {
  if (!task || typeof task !== 'object') return false
  if (task.is_all_day === true) return true
  if (task.time_kind === 'all_day' || task.time_kind === 'date') return true
  return Boolean(task.scheduled_date) && !task.scheduled_start_at && !task.scheduled_end_at
}

/** 任务锚定自然日：scheduled_date > scheduled_start_at 归日 > due_date > due_at 归日 > null。 */
export function taskAnchorLocalDate(task, timeZone = DEFAULT_TIME_ZONE) {
  if (!task || typeof task !== 'object') return null
  if (isLocalDate(task.scheduled_date)) return task.scheduled_date
  if (isIsoTimestamp(task.scheduled_start_at)) return localDateOfIso(timeZone, task.scheduled_start_at)
  if (isLocalDate(task.due_date)) return task.due_date
  if (isIsoTimestamp(task.due_at)) return localDateOfIso(timeZone, task.due_at)
  return null
}

/** 任务是否未完成且未取消/未归档（todo/doing）。 */
export function isOpenTask(task) {
  if (!task || typeof task !== 'object') return false
  return (task.status === 'todo' || task.status === 'doing') && !task.archived_at
}

/** today 视图判定：scheduled_date=今天 / scheduled_start_at 归日=今天 / due_date=今天 / due_at 归日=今天。 */
export function isTaskToday(task, { timeZone = DEFAULT_TIME_ZONE, now = new Date() } = {}) {
  if (!task || typeof task !== 'object') return false
  const today = localDate(timeZone, now)
  if (task.scheduled_date === today) return true
  if (isIsoTimestamp(task.scheduled_start_at) && localDateOfIso(timeZone, task.scheduled_start_at) === today) return true
  if (task.due_date === today) return true
  if (isIsoTimestamp(task.due_at) && localDateOfIso(timeZone, task.due_at) === today) return true
  return false
}

/** overdue 视图判定：未完成/未取消/未归档，且 due_date < 今天 或 due_at < now。 */
export function isTaskOverdue(task, { timeZone = DEFAULT_TIME_ZONE, now = new Date() } = {}) {
  if (!isOpenTask(task)) return false
  const today = localDate(timeZone, now)
  if (isLocalDate(task.due_date) && task.due_date < today) return true
  if (isIsoTimestamp(task.due_at) && Date.parse(task.due_at) < now.getTime()) return true
  return false
}

/**
 * next7 视图判定：未完成且 scheduled/due 落在 [今天, 今天+days-1]（含今天），
 * 且不是逾期（04 §7.9：最近 7 天不含逾期）。
 */
export function isTaskWithinNextDays(task, { timeZone = DEFAULT_TIME_ZONE, now = new Date(), days = 7 } = {}) {
  if (!isOpenTask(task) || isTaskOverdue(task, { timeZone, now })) return false
  const today = localDate(timeZone, now)
  const lastDay = addDays(today, Math.max(0, days - 1))
  const candidates = []
  if (isLocalDate(task.scheduled_date)) candidates.push(task.scheduled_date)
  if (isIsoTimestamp(task.scheduled_start_at)) candidates.push(localDateOfIso(timeZone, task.scheduled_start_at))
  if (isLocalDate(task.due_date)) candidates.push(task.due_date)
  if (isIsoTimestamp(task.due_at)) candidates.push(localDateOfIso(timeZone, task.due_at))
  return candidates.some((day) => day >= today && day <= lastDay)
}

/** inbox 视图判定：未完成且无 project、无 scheduled、无 due（"收件箱清单"语义）。 */
export function isTaskInbox(task) {
  if (!isOpenTask(task)) return false
  return (
    !task.project_id &&
    !task.scheduled_date &&
    !task.scheduled_start_at &&
    !task.scheduled_end_at &&
    !task.due_date &&
    !task.due_at
  )
}
