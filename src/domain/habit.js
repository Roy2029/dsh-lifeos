/**
 * A：M4 习惯领域纯函数（M4-PLAN §1.1-§1.3 / §3.1）。
 *
 * 纯函数、无 IO、无第三方依赖；只允许依赖 `time.js` 的日期工具。
 * 口径（冻结）：
 *  - 计划日只由 daily / weekly_days / interval 产生；weekly_count / monthly_count 只看周期达标。
 *  - streak：strict = 连续 done，遇 missed/skipped/unknown 立即停止；
 *           grace（默认）= 连续 done，skipped 不打断、unknown 不打断也不延长、missed 立即停止、paused 跳过。
 *  - coverage：unknown 不计失败（只影响 recorded/expected），windowDays 是窗口日历天数。
 *  - 完成率三口径：strict=done/expectedDays；recorded=done/(done+not_done+partial*0.5)；period=达标周期/已结束周期。
 *  - 暂停区间（paused_at→resumed_at）不计入分母；归档后不再产生预期。
 *
 * 约定：
 *  - checkin 记录按冻结 schema 读取：`{local_date, status, value_json, deleted_at}`；软删记录一律忽略。
 *  - `status` 缺失/无记录 = unknown（未知，不写库，不展示为失败）。
 *  - `asOf`（今天）缺失时按 checkins 最大日期兜底；未来日期永不进入分母。
 */

import {
  addDays,
  daysBetweenLocalDates,
  formatLocalDate,
  isLocalDate,
  localDateOfIso,
  parseLocalDate,
} from './time.js'

export const WEEKDAYS = Object.freeze(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])

export const FREQUENCY_KINDS = Object.freeze(['daily', 'weekly_days', 'weekly_count', 'interval'])

export const CHECKIN_STATUSES = Object.freeze(['done', 'partial', 'skipped', 'not_done'])

export const WEEK_STARTS = Object.freeze(['monday', 'sunday'])

const WEEKDAY_LABELS = Object.freeze({ MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六', SU: '日' })

// 1970-01-05 是周一，用纯自然日差算星期，避免宿主时区影响。
const MONDAY_EPOCH = '1970-01-05'

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function toPositiveInt(value) {
  return Number.isInteger(value) && value >= 1 ? value : null
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}

function ratioOrNull(numerator, denominator) {
  if (!(denominator > 0)) return null
  return round3(numerator / denominator)
}

/** 自然日的星期序号：0=周一 … 6=周日。 */
export function weekdayIndex(dateString) {
  if (!isLocalDate(dateString)) throw new TypeError(`invalid local date: ${String(dateString)}`)
  const diff = daysBetweenLocalDates(MONDAY_EPOCH, dateString)
  return ((diff % 7) + 7) % 7
}

function normalizeWeekStart(value) {
  return value === 'sunday' ? 'sunday' : 'monday'
}

function monthStartOf(dateString) {
  return `${dateString.slice(0, 8)}01`
}

function monthEndOf(dateString) {
  const parsed = parseLocalDate(dateString)
  const last = new Date(Date.UTC(parsed.year, parsed.month, 0))
  return formatLocalDate({ year: last.getUTCFullYear(), month: last.getUTCMonth() + 1, day: last.getUTCDate() })
}

/** 某自然日所在周的第一天（weekStart 决定周一/周日）。 */
export function weekStartOf(dateString, weekStart = 'monday') {
  const index = weekdayIndex(dateString)
  const offset = normalizeWeekStart(weekStart) === 'sunday' ? (index + 1) % 7 : index
  return addDays(dateString, -offset)
}

/** 周键 `YYYY-Www`（周一制用 ISO 周；周日制取该周内周一的 ISO 周，键仍唯一）。 */
export function weekKeyOf(dateString, weekStart = 'monday') {
  const mode = normalizeWeekStart(weekStart)
  let reference = dateString
  if (mode === 'sunday') reference = addDays(weekStartOf(dateString, 'sunday'), 1)
  const refIndex = weekdayIndex(reference)
  const thursday = addDays(reference, 3 - refIndex)
  const year = parseLocalDate(thursday).year
  const jan4 = `${year}-01-04`
  const week1Monday = addDays(jan4, -weekdayIndex(jan4))
  const week = Math.floor(daysBetweenLocalDates(week1Monday, thursday) / 7) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

/**
 * periodKey(weekStart, date)（M4-PLAN §3.1 冻结签名）。
 * 兼容调用方式：
 *  - `periodKey('monday'|'sunday', date)` → 周键 `YYYY-Www`
 *  - `periodKey('week', date)` / `{period:'week', week_start}` → 周键
 *  - `periodKey('month', date)` / `{period:'month'}` / 省略 weekStart → 月键 `YYYY-MM`
 */
export function periodKey(weekStart, date) {
  if (!isLocalDate(date)) throw new TypeError(`invalid local date: ${String(date)}`)
  if (isPlainObject(weekStart)) {
    const period = weekStart.period
    if (period === 'month') return date.slice(0, 7)
    const mode = weekStart.week_start ?? weekStart.weekStart ?? 'monday'
    return weekKeyOf(date, mode)
  }
  if (typeof weekStart === 'string') {
    const value = weekStart.toLowerCase()
    if (value === 'month') return date.slice(0, 7)
    if (value === 'week' || value === 'monday' || value === 'sunday') return weekKeyOf(date, value)
  }
  return date.slice(0, 7)
}

/** 周期类型（week/month）；习惯用于 streak/覆盖率的周期粒度；日计划型返回 null。 */
export function habitPeriodOf(habit) {
  const rule = habit && isPlainObject(habit.frequency_rule) ? habit.frequency_rule : null
  if (rule && rule.kind === 'weekly_count') return 'week'
  if (rule && rule.kind === 'monthly_count') return 'month'
  return null
}

function coverKey(dateString, period, weekStart) {
  return period === 'week' ? weekKeyOf(dateString, weekStart) : dateString.slice(0, 7)
}

function periodRangeOfDate(period, dateString, weekStart) {
  if (period === 'week') {
    const start = weekStartOf(dateString, weekStart)
    return { period, key: weekKeyOf(dateString, weekStart), start, end: addDays(start, 6) }
  }
  const start = monthStartOf(dateString)
  return { period, key: dateString.slice(0, 7), start, end: monthEndOf(dateString) }
}

function shiftPeriod(period, range, weekStart, count) {
  if (period === 'week') {
    const start = addDays(range.start, 7 * count)
    return { period, key: weekKeyOf(start, weekStart), start, end: addDays(start, 6) }
  }
  const parsed = parseLocalDate(range.start)
  const total = parsed.year * 12 + (parsed.month - 1) + count
  const year = Math.floor(total / 12)
  const month = (((total % 12) + 12) % 12) + 1
  const start = `${year}-${String(month).padStart(2, '0')}-01`
  return { period, key: start.slice(0, 7), start, end: monthEndOf(start) }
}

/** 按周期键还原区间；非法键返回 null。 */
export function periodRangeOfKey(key, weekStart = 'monday') {
  if (typeof key !== 'string') return null
  const weekMatch = /^(\d{4})-W(\d{2})$/.exec(key)
  if (weekMatch) {
    const year = Number(weekMatch[1])
    const week = Number(weekMatch[2])
    if (!(week >= 1 && week <= 53)) return null
    const jan4 = `${year}-01-04`
    const week1Monday = addDays(jan4, -weekdayIndex(jan4))
    const monday = addDays(week1Monday, (week - 1) * 7)
    // 校验该周确实属于该 ISO 年（避免第 53 周越界键被当成有效）。
    if (weekKeyOf(monday, 'monday') !== key) return null
    const start = normalizeWeekStart(weekStart) === 'sunday' ? addDays(monday, -1) : monday
    return { period: 'week', key, start, end: addDays(start, 6) }
  }
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(key)
  if (!monthMatch) return null
  const year = Number(monthMatch[1])
  const month = Number(monthMatch[2])
  if (month < 1 || month > 12) return null
  const start = `${year}-${String(month).padStart(2, '0')}-01`
  return { period: 'month', key, start, end: monthEndOf(start) }
}

// =====================================================================
// 频率规则
// =====================================================================

function validatePeriodRule(periodRule, errors) {
  if (periodRule === undefined || periodRule === null) return
  if (!isPlainObject(periodRule)) {
    errors.push('period_rule: 必须是对象')
    return
  }
  if (periodRule.period !== 'week' && periodRule.period !== 'month') {
    errors.push('period_rule.period: 必须是 week 或 month')
  }
  if (!toPositiveInt(periodRule.target_count)) {
    errors.push('period_rule.target_count: 必须是 >=1 的整数')
  }
  if (periodRule.week_start !== undefined && periodRule.week_start !== null) {
    if (periodRule.week_start !== 'monday' && periodRule.week_start !== 'sunday') {
      errors.push('period_rule.week_start: 必须是 monday 或 sunday')
    }
  }
}

function normalizeWeekdays(rule, errors) {
  const days = Array.isArray(rule.days) ? rule.days : null
  if (!days || days.length === 0) {
    errors.push('frequency_rule.days: 必须是非空数组（MO..SU）')
    return []
  }
  const unique = []
  for (const day of days) {
    if (typeof day !== 'string' || !WEEKDAYS.includes(day)) {
      errors.push(`frequency_rule.days: 非法星期 ${String(day)}（MO..SU）`)
      continue
    }
    if (!unique.includes(day)) unique.push(day)
  }
  if (unique.length !== days.length) errors.push('frequency_rule.days: 不允许重复')
  return unique
}

/**
 * 校验频率规则（含可选 period_rule）。
 * @param {object} rule
 * @param {{periodRule?: object|null}} [options]
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateFrequencyRule(rule, options = {}) {
  const errors = []
  if (!isPlainObject(rule)) {
    return { ok: false, errors: ['frequency_rule: 必须是对象'] }
  }
  const kind = rule.kind
  if (!FREQUENCY_KINDS.includes(kind)) {
    if (kind === 'monthly_count') {
      return { ok: false, errors: ['frequency_rule.kind: monthly_count 属 V1.5，M4a 不支持'] }
    }
    return { ok: false, errors: [`frequency_rule.kind: 不支持 ${String(kind)}`] }
  }
  if (kind === 'daily') {
    if (rule.interval !== undefined && rule.interval !== null && !toPositiveInt(rule.interval)) {
      errors.push('frequency_rule.interval: 必须是 >=1 的整数')
    }
  } else if (kind === 'weekly_days') {
    normalizeWeekdays(rule, errors)
  } else if (kind === 'weekly_count') {
    if (!toPositiveInt(rule.count)) errors.push('frequency_rule.count: 必须是 >=1 的整数')
  } else if (kind === 'interval') {
    if (!toPositiveInt(rule.days)) errors.push('frequency_rule.days: 必须是 >=1 的整数')
    if (rule.anchor_date !== undefined && rule.anchor_date !== null && !isLocalDate(rule.anchor_date)) {
      errors.push('frequency_rule.anchor_date: 必须是 YYYY-MM-DD 自然日')
    }
  }
  const periodRule = options && options.periodRule !== undefined ? options.periodRule : null
  if (kind === 'weekly_count') {
    if (!isPlainObject(periodRule)) {
      errors.push('period_rule: weekly_count 必须提供 period_rule（period=week，target_count=count）')
    } else {
      if (periodRule.period !== 'week') errors.push('period_rule.period: weekly_count 必须为 week')
      if (toPositiveInt(periodRule.target_count) !== toPositiveInt(rule.count)) {
        errors.push('period_rule.target_count: weekly_count 时必须与 count 相等')
      }
    }
  }
  validatePeriodRule(periodRule, errors)
  return { ok: errors.length === 0, errors }
}

/** 人类可读频率文案：每天 / 每周三、五 / 每周 3 次 / 每 2 天。 */
export function describeFrequency(rule, periodRule) {
  if (!isPlainObject(rule)) return ''
  const kind = rule.kind
  if (kind === 'daily') {
    const interval = toPositiveInt(rule.interval) ?? 1
    return interval === 1 ? '每天' : `每 ${interval} 天`
  }
  if (kind === 'weekly_days') {
    const days = Array.isArray(rule.days) ? rule.days.filter((day) => WEEKDAYS.includes(day)) : []
    if (days.length === 0) return ''
    const ordered = WEEKDAYS.filter((day) => days.includes(day))
    if (ordered.length === 7) return '每天'
    return `每周${ordered.map((day) => WEEKDAY_LABELS[day]).join('、')}`
  }
  if (kind === 'weekly_count') {
    const count = toPositiveInt(rule.count) ?? (isPlainObject(periodRule) ? toPositiveInt(periodRule.target_count) : null)
    return count ? `每周 ${count} 次` : '每周'
  }
  if (kind === 'interval') {
    const days = toPositiveInt(rule.days)
    return days ? `每 ${days} 天` : ''
  }
  return ''
}

// =====================================================================
// 计划日
// =====================================================================

/**
 * 某自然日是否是该习惯的计划日（拟做日）。
 * 只由 daily / weekly_days / interval 产生；weekly_count / monthly_count 恒为 false。
 * 计划日忽略暂停/归档状态（分母裁剪由覆盖率/完成率负责）。
 */
export function isPlanDay(habit, dateString) {
  if (!isPlainObject(habit) || !isLocalDate(dateString)) return false
  const rule = isPlainObject(habit.frequency_rule) ? habit.frequency_rule : null
  if (!rule) return false
  const startDate = isLocalDate(habit.start_date) ? habit.start_date : null
  if (!startDate || dateString < startDate) return false
  const endDate = isLocalDate(habit.end_date) ? habit.end_date : null
  if (endDate && dateString > endDate) return false
  if (rule.kind === 'daily') {
    const interval = toPositiveInt(rule.interval) ?? 1
    const diff = daysBetweenLocalDates(startDate, dateString)
    return diff >= 0 && diff % interval === 0
  }
  if (rule.kind === 'weekly_days') {
    const days = Array.isArray(rule.days) ? rule.days : []
    return days.includes(WEEKDAYS[weekdayIndex(dateString)])
  }
  if (rule.kind === 'interval') {
    const days = toPositiveInt(rule.days)
    if (!days) return false
    const anchor = isLocalDate(rule.anchor_date) ? rule.anchor_date : startDate
    if (dateString < anchor) return false
    return daysBetweenLocalDates(anchor, dateString) % days === 0
  }
  return false
}

/** [fromDate, toDate] 内的计划日列表（升序）；非法区间返回空数组。 */
export function planDaysBetween(habit, fromDate, toDate) {
  if (!isLocalDate(fromDate) || !isLocalDate(toDate) || fromDate > toDate) return []
  const endDate = isPlainObject(habit) && isLocalDate(habit.end_date) ? habit.end_date : toDate
  const last = endDate < toDate ? endDate : toDate
  const days = []
  let cursor = fromDate
  let guard = 0
  while (cursor <= last && guard < 10000) {
    if (isPlanDay(habit, cursor)) days.push(cursor)
    cursor = addDays(cursor, 1)
    guard += 1
  }
  return days
}

// =====================================================================
// 暂停区间 / 归档边界
// =====================================================================

function isoToLocalDate(value, timeZone) {
  if (isLocalDate(value)) return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    const iso = new Date(value).toISOString()
    return timeZone ? localDateOfIso(timeZone, iso) : iso.slice(0, 10)
  }
  if (typeof value === 'string' && value.length >= 10) {
    if (timeZone) {
      const parsed = new Date(value)
      if (!Number.isNaN(parsed.getTime())) return localDateOfIso(timeZone, parsed.toISOString())
    }
    return value.slice(0, 10)
  }
  return null
}

function normalizeRange(range) {
  if (!isPlainObject(range)) return null
  const from = isoToLocalDate(range.from ?? range.start ?? null, null)
  const to = isoToLocalDate(range.to ?? range.end ?? null, null)
  if (!isLocalDate(from) || !isLocalDate(to) || to <= from) return null
  return { from, to }
}

/**
 * 习惯的暂停区间列表（半开区间 [from, to)）。
 * 优先读取显式 `habit.paused_ranges`（测试/批量场景），否则由 paused_at/resumed_at 推导。
 * `asOf` 缺省时按当前暂停到今天处理。
 */
export function pausedRangesOf(habit, options = {}) {
  if (!isPlainObject(habit)) return []
  if (Array.isArray(habit.paused_ranges)) {
    return habit.paused_ranges.map(normalizeRange).filter(Boolean)
  }
  const timeZone = options.timeZone
  const pauseDate = isoToLocalDate(habit.paused_at ?? null, timeZone)
  if (!pauseDate) return []
  const resumeDate = isoToLocalDate(habit.resumed_at ?? null, timeZone)
  if (resumeDate && resumeDate > pauseDate) return [{ from: pauseDate, to: resumeDate }]
  if (resumeDate && resumeDate <= pauseDate) {
    // 暂停与恢复在同一天：按当天暂停处理。
    return [{ from: pauseDate, to: addDays(pauseDate, 1) }]
  }
  const asOf = isLocalDate(options.asOf) ? options.asOf : pauseDate
  return [{ from: pauseDate, to: addDays(asOf, 1) }]
}

function isPausedOn(ranges, dateString) {
  for (const range of ranges) {
    if (dateString >= range.from && dateString < range.to) return true
  }
  return false
}

function archivedBoundary(habit, timeZone) {
  const date = isoToLocalDate(habit.archived_at ?? null, timeZone)
  return date ? addDays(date, -1) : null
}

function clampWindow(habit, from, to, options = {}) {
  let effectiveFrom = from
  let effectiveTo = to
  if (isLocalDate(habit.start_date) && habit.start_date > effectiveFrom) effectiveFrom = habit.start_date
  if (isLocalDate(habit.end_date) && habit.end_date < effectiveTo) effectiveTo = habit.end_date
  const boundary = archivedBoundary(habit, options.timeZone)
  if (boundary && boundary < effectiveTo) effectiveTo = boundary
  const asOf = isLocalDate(options.asOf) ? options.asOf : null
  if (asOf && asOf < effectiveTo) effectiveTo = asOf
  if (habit.status === 'archived' && !boundary) {
    return { from: effectiveFrom, to: addDays(effectiveFrom, -1) }
  }
  return { from: effectiveFrom, to: effectiveTo }
}

// =====================================================================
// checkin 索引
// =====================================================================

function liveCheckins(checkins) {
  if (!Array.isArray(checkins)) return []
  return checkins.filter((record) => isPlainObject(record) && !record.deleted_at && isLocalDate(record.local_date))
}

function checkinMapOf(checkins) {
  const map = new Map()
  for (const record of liveCheckins(checkins)) map.set(record.local_date, record)
  return map
}

// =====================================================================
// streak
// =====================================================================

function emptyStreak(mode, unit) {
  return { mode, unit, value: 0, longest: 0, lastCountedUnit: null }
}

function statusOfDay(map, dateString, asOf) {
  const record = map.get(dateString)
  if (record) return record.status
  // 今天（asOf）尚未记录 = 待办中，不算 unknown，不打断也不延长 streak。
  if (asOf && dateString === asOf) return 'pending'
  return 'unknown'
}

function applyStreakUnit(state, status, unitKey) {
  if (status === 'done') {
    state.run += 1
    if (state.run > state.longest) state.longest = state.run
    state.lastCountedUnit = unitKey
    return
  }
  if (status === 'pending') return
  if (status === 'skipped') {
    if (state.mode === 'strict') state.run = 0
    return
  }
  if (status === 'unknown') {
    if (state.mode === 'strict') state.run = 0
    return
  }
  // missed / not_done / partial：显式未达成，立即停止。
  state.run = 0
}

function computeDayStreak(habit, checkins, asOf, mode, weekStart, timeZone) {
  const unit = 'day'
  const state = { mode, run: 0, longest: 0, lastCountedUnit: null }
  const start = isLocalDate(habit.start_date) ? habit.start_date : null
  if (!start) return emptyStreak(mode, unit)
  const map = checkinMapOf(checkins)
  const pausedRanges = pausedRangesOf(habit, { timeZone, asOf })
  const boundary = archivedBoundary(habit, timeZone)
  let stop = asOf
  if (boundary && boundary < stop) stop = boundary
  if (habit.status === 'archived' && !boundary) return emptyStreak(mode, unit)
  if (!isLocalDate(stop) || stop < start) return emptyStreak(mode, unit)
  let cursor = start
  let guard = 0
  while (cursor <= stop && guard < 40000) {
    guard += 1
    if (isPausedOn(pausedRanges, cursor)) {
      cursor = addDays(cursor, 1)
      continue
    }
    if (!isPlanDay(habit, cursor)) {
      cursor = addDays(cursor, 1)
      continue
    }
    applyStreakUnit(state, statusOfDay(map, cursor, stop), cursor)
    cursor = addDays(cursor, 1)
  }
  return { mode, unit, value: state.run, longest: state.longest, lastCountedUnit: state.lastCountedUnit }
}

function periodTargetOf(habit) {
  const rule = isPlainObject(habit.frequency_rule) ? habit.frequency_rule : {}
  const periodRule = isPlainObject(habit.period_rule) ? habit.period_rule : null
  const count = toPositiveInt(rule.count)
  if (count) return count
  if (periodRule && toPositiveInt(periodRule.target_count)) return toPositiveInt(periodRule.target_count)
  return null
}

function periodBucketsOf(checkins, period, weekStart) {
  const buckets = new Map()
  for (const record of liveCheckins(checkins)) {
    const key = coverKey(record.local_date, period, weekStart)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { done: 0, notDone: 0, skipped: 0, partial: 0, total: 0 }
      buckets.set(key, bucket)
    }
    bucket.total += 1
    if (record.status === 'done') bucket.done += 1
    else if (record.status === 'skipped') bucket.skipped += 1
    else if (record.status === 'partial') bucket.partial += 1
    else bucket.notDone += 1
  }
  return buckets
}

function periodUnitStatus(bucket, target) {
  if (!bucket || bucket.total === 0) return 'unknown'
  if (bucket.done >= target) return 'done'
  if (bucket.notDone > 0) return 'missed'
  if (bucket.skipped === bucket.total) return 'skipped'
  return 'missed'
}

function computePeriodStreak(habit, checkins, asOf, mode, weekStart, timeZone) {
  const period = habitPeriodOf(habit)
  const unit = period === 'month' ? 'month' : 'week'
  const target = periodTargetOf(habit)
  const state = { mode, run: 0, longest: 0, lastCountedUnit: null }
  const startDate = isLocalDate(habit.start_date) ? habit.start_date : null
  if (!period || !target || !startDate) return emptyStreak(mode, unit)
  const boundary = archivedBoundary(habit, timeZone)
  let stop = asOf
  if (boundary && boundary < stop) stop = boundary
  if (habit.status === 'archived' && !boundary) return emptyStreak(mode, unit)
  if (!isLocalDate(stop)) return emptyStreak(mode, unit)
  const buckets = periodBucketsOf(checkins, period, weekStart)
  const pausedRanges = pausedRangesOf(habit, { timeZone, asOf })
  let range = periodRangeOfDate(period, startDate, weekStart)
  // 首周期不满：习惯在周期中途开始，不把该周期算作达标失败。
  if (range.start < startDate) range = shiftPeriod(period, range, weekStart, 1)
  let guard = 0
  while (range.end < stop && guard < 2000) {
    guard += 1
    if (isPausedOn(pausedRanges, range.start)) {
      range = shiftPeriod(period, range, weekStart, 1)
      continue
    }
    applyStreakUnit(state, periodUnitStatus(buckets.get(range.key), target), range.key)
    range = shiftPeriod(period, range, weekStart, 1)
  }
  return { mode, unit, value: state.run, longest: state.longest, lastCountedUnit: state.lastCountedUnit }
}

/**
 * 计算 streak。
 * @param {{habit: object, checkins: object[], asOf: string, mode?: 'grace'|'strict', weekStart?: string, timeZone?: string}} input
 * @returns {{mode: string, unit: 'day'|'week'|'month', value: number, longest: number, lastCountedUnit: string|null}}
 */
export function computeStreak(input = {}) {
  const habit = isPlainObject(input.habit) ? input.habit : null
  const mode = input.mode === 'strict' ? 'strict' : 'grace'
  const weekStart = normalizeWeekStart(input.weekStart)
  const timeZone = input.timeZone
  if (!habit) return emptyStreak(mode, 'day')
  let asOf = isLocalDate(input.asOf) ? input.asOf : null
  if (!asOf) {
    const dates = liveCheckins(input.checkins).map((record) => record.local_date)
    asOf = dates.length > 0 ? dates.sort()[dates.length - 1] : isLocalDate(habit.start_date) ? habit.start_date : null
  }
  if (!asOf) return emptyStreak(mode, 'day')
  return habitPeriodOf(habit)
    ? computePeriodStreak(habit, input.checkins, asOf, mode, weekStart, timeZone)
    : computeDayStreak(habit, input.checkins, asOf, mode, weekStart, timeZone)
}

// =====================================================================
// coverage / 完成率 / 周期达标
// =====================================================================

/**
 * 覆盖率：expected 只统计「应做且窗口内」的计划日（暂停/归档/未来/超出习惯区间不计）。
 * unknown 不计失败：recorded 是实际有记录的计划日；unknownDays = expected - recorded。
 * @returns {{recorded: number, expected: number, ratio: number|null, unknownDays: number, windowDays: number}}
 */
export function computeCoverage(input = {}) {
  const habit = isPlainObject(input.habit) ? input.habit : null
  const from = isLocalDate(input.from) ? input.from : null
  const to = isLocalDate(input.to) ? input.to : null
  if (!habit || !from || !to || from > to) {
    return { recorded: 0, expected: 0, ratio: null, unknownDays: 0, windowDays: 0 }
  }
  const asOf = isLocalDate(input.asOf) ? input.asOf : null
  const weekStart = normalizeWeekStart(input.weekStart)
  const timeZone = input.timeZone
  const windowDays = daysBetweenLocalDates(from, to) + 1
  const providedRanges = Array.isArray(input.pausedRanges) ? input.pausedRanges : null
  const pausedRanges = providedRanges
    ? providedRanges.map(normalizeRange).filter(Boolean)
    : pausedRangesOf(habit, { timeZone, asOf })
  const window = clampWindow(habit, from, to, { asOf, timeZone })
  const map = checkinMapOf(input.checkins)
  let expected = 0
  let recorded = 0
  if (habitPeriodOf(habit)) {
    const period = habitPeriodOf(habit)
    const buckets = periodBucketsOf(input.checkins, period, weekStart)
    let range = periodRangeOfDate(period, window.from, weekStart)
    let guard = 0
    while (range.start <= window.to && guard < 2000) {
      guard += 1
      const endsBeforeAsOf = asOf ? range.end < asOf : true
      const inWindow = range.start >= window.from
      if (inWindow && endsBeforeAsOf && !isPausedOn(pausedRanges, range.start)) {
        expected += 1
        const bucket = buckets.get(range.key)
        if (bucket && bucket.total > 0) recorded += 1
      }
      range = shiftPeriod(period, range, weekStart, 1)
    }
  } else {
    let cursor = window.from
    let guard = 0
    while (cursor <= window.to && guard < 10000) {
      guard += 1
      if (isPlanDay(habit, cursor) && !isPausedOn(pausedRanges, cursor)) {
        expected += 1
        if (map.has(cursor)) recorded += 1
      }
      cursor = addDays(cursor, 1)
    }
  }
  return {
    recorded,
    expected,
    ratio: ratioOrNull(recorded, expected),
    unknownDays: Math.max(0, expected - recorded),
    windowDays,
  }
}

/**
 * 完成率三口径（null = 该窗口无分母，UI 显示“—”）。
 * @returns {{strict: number|null, recorded: number|null, period: number|null}}
 */
export function computeCompletionRates(input = {}) {
  const habit = isPlainObject(input.habit) ? input.habit : null
  const from = isLocalDate(input.from) ? input.from : null
  const to = isLocalDate(input.to) ? input.to : null
  if (!habit || !from || !to || from > to) return { strict: null, recorded: null, period: null }
  const asOf = isLocalDate(input.asOf) ? input.asOf : null
  const weekStart = normalizeWeekStart(input.weekStart)
  const timeZone = input.timeZone
  const window = clampWindow(habit, from, to, { asOf, timeZone })
  const pausedRanges = pausedRangesOf(habit, { timeZone, asOf })
  const inRange = liveCheckins(input.checkins).filter(
    (record) => record.local_date >= window.from && record.local_date <= window.to && record.local_date >= from,
  )
  // strict：done / 计划日数
  let strict = null
  if (!habitPeriodOf(habit)) {
    const map = new Map()
    for (const record of inRange) map.set(record.local_date, record)
    let expectedDays = 0
    let doneDays = 0
    let cursor = window.from
    let guard = 0
    while (cursor <= window.to && guard < 10000) {
      guard += 1
      if (isPlanDay(habit, cursor) && !isPausedOn(pausedRanges, cursor)) {
        expectedDays += 1
        if (map.get(cursor)?.status === 'done') doneDays += 1
      }
      cursor = addDays(cursor, 1)
    }
    strict = ratioOrNull(doneDays, expectedDays)
  }
  // recorded：done / (done + not_done + partial*0.5)
  let done = 0
  let notDone = 0
  let partial = 0
  for (const record of inRange) {
    if (record.status === 'done') done += 1
    else if (record.status === 'partial') partial += 1
    else if (record.status === 'not_done') notDone += 1
  }
  const recorded = ratioOrNull(done, done + notDone + partial * 0.5)
  // period：达标周期 / 已结束周期
  let period = null
  const periodRule = isPlainObject(habit.period_rule) ? habit.period_rule : null
  const periodType = periodRule && (periodRule.period === 'month' ? 'month' : periodRule.period === 'week' ? 'week' : null)
  const streakPeriod = habitPeriodOf(habit)
  const usePeriod = streakPeriod || periodType
  if (usePeriod) {
    const target = periodTargetOf(habit)
    const buckets = periodBucketsOf(input.checkins, usePeriod, weekStart)
    let expectedPeriods = 0
    let metPeriods = 0
    let range = periodRangeOfDate(usePeriod, window.from, weekStart)
    let guard = 0
    while (range.start <= window.to && guard < 2000) {
      guard += 1
      const ended = asOf ? range.end < asOf : true
      if (ended && range.start >= window.from && !isPausedOn(pausedRanges, range.start)) {
        expectedPeriods += 1
        if (target && (buckets.get(range.key)?.done ?? 0) >= target) metPeriods += 1
      }
      range = shiftPeriod(usePeriod, range, weekStart, 1)
    }
    period = ratioOrNull(metPeriods, expectedPeriods)
  }
  return { strict, recorded, period }
}

/**
 * 周期达标：periodKey 形如 `YYYY-Www`（周）或 `YYYY-MM`（月）。
 * target 优先取 period_rule.target_count / weekly_count.count；否则取该周期内的计划日数。
 * @returns {{period: string, key: string, start: string, end: string, target: number, achieved: number, met: boolean}}
 */
export function computePeriodAchievement(input = {}) {
  const habit = isPlainObject(input.habit) ? input.habit : null
  const key = typeof input.periodKey === 'string' ? input.periodKey : null
  const weekStart = normalizeWeekStart(input.weekStart)
  const range = key ? periodRangeOfKey(key, weekStart) : null
  if (!habit || !range) {
    return { period: 'week', key: key ?? '', start: '', end: '', target: 0, achieved: 0, met: false }
  }
  const periodRule = isPlainObject(habit.period_rule) ? habit.period_rule : null
  let target = null
  if (periodRule && periodRule.period === range.period && toPositiveInt(periodRule.target_count)) {
    target = toPositiveInt(periodRule.target_count)
  } else if (habitPeriodOf(habit) === range.period) {
    target = periodTargetOf(habit)
  }
  let planDays = null
  if (!target) {
    planDays = planDaysBetween(habit, range.start, range.end)
    target = planDays.length
  }
  let achieved = 0
  for (const record of liveCheckins(input.checkins)) {
    if (record.local_date < range.start || record.local_date > range.end) continue
    if (record.status === 'done') achieved += 1
  }
  return {
    period: range.period,
    key: range.key,
    start: range.start,
    end: range.end,
    target,
    achieved,
    met: target > 0 && achieved >= target,
  }
}

// =====================================================================
// 月矩阵
// =====================================================================

/**
 * 月矩阵：行=习惯，列=自然日。
 * cell.status ∈ 'done'|'partial'|'skipped'|'not_done'|'unknown'|'paused'|null
 * （null = 不在计划期/未来，不展示；unknown = 过去计划日未记录，图例“－未记录”）。
 * @returns {{month: string, days: string[], rows: object[], today: string|null}}
 */
export function buildMonthMatrix(input = {}) {
  const month = typeof input.month === 'string' ? input.month : null
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return { month: month ?? '', days: [], rows: [], today: null }
  }
  const monthStart = `${month}-01`
  if (!isLocalDate(monthStart)) {
    return { month, days: [], rows: [], today: null }
  }
  const monthEnd = monthEndOf(monthStart)
  if (!isLocalDate(monthEnd)) {
    return { month, days: [], rows: [], today: null }
  }
  const todayLocal = isLocalDate(input.todayLocal) ? input.todayLocal : null
  const weekStart = normalizeWeekStart(input.weekStart)
  const timeZone = input.timeZone
  const days = []
  for (let cursor = monthStart; cursor <= monthEnd; cursor = addDays(cursor, 1)) days.push(cursor)
  const habits = Array.isArray(input.habits) ? input.habits.filter((habit) => isPlainObject(habit) && !habit.deleted_at) : []
  const allCheckins = liveCheckins(input.checkins)
  const providedRanges = isPlainObject(input.pausedRanges) ? input.pausedRanges : null
  const rows = habits.map((habit) => {
    const map = new Map()
    for (const record of allCheckins) {
      if (record.habit_id === habit.id) map.set(record.local_date, record)
    }
    const pausedRanges = providedRanges && Array.isArray(providedRanges[habit.id])
      ? providedRanges[habit.id].map(normalizeRange).filter(Boolean)
      : pausedRangesOf(habit, { timeZone, asOf: todayLocal })
    const archived = archivedBoundary(habit, timeZone)
    const cells = days.map((dateString) => {
      const base = { date: dateString, status: null, checkin_id: null, is_today: todayLocal === dateString }
      const startDate = isLocalDate(habit.start_date) ? habit.start_date : null
      const endDate = isLocalDate(habit.end_date) ? habit.end_date : null
      if (!startDate || dateString < startDate) return base
      if (endDate && dateString > endDate) return base
      if (archived && dateString > archived) return base
      const record = map.get(dateString)
      if (record) {
        return { ...base, status: record.status, checkin_id: record.id ?? null }
      }
      if (isPausedOn(pausedRanges, dateString)) return { ...base, status: 'paused' }
      if (todayLocal && dateString > todayLocal) return base
      if (isPlanDay(habit, dateString)) return { ...base, status: 'unknown' }
      return base
    })
    return {
      habitId: habit.id,
      name: habit.name,
      status: habit.status,
      frequency_text: describeFrequency(habit.frequency_rule, habit.period_rule),
      time_hint: habit.time_hint ?? null,
      cells,
    }
  })
  return { month, days, rows, today: todayLocal, week_start: normalizeWeekStart(weekStart) }
}

// =====================================================================
// 兼容导出：checkin 记录常用判断（服务层复用，避免重复实现口径）
// =====================================================================

/** 记录是否有效（未软删）。 */
export function isLiveCheckin(record) {
  return isPlainObject(record) && !record.deleted_at
}

/** 由 checkins 建 `local_date -> record` 索引。 */
export function indexCheckinsByDate(checkins) {
  return checkinMapOf(checkins)
}

export { WEEKDAY_LABELS }
