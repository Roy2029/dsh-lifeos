/**
 * LifeOS — 自动化规则（M3 A 线，纯函数）
 *
 * 契约：`M3-PLAN.md` §1（设置真源）、§2（routine）、§3（截止提醒）、§9（门禁）。
 * 本文件不含 I/O：默认设置、校验、合并/差异、dnd 判定、routine 元数据与 prompt、提醒时间计算。
 *
 * 零第三方依赖：仅使用同目录 time.js。
 */

import { addDays, localDate, localDateTimeToIso, localDateOfIso } from './time.js'

export const AUTOMATION_SETTING_KEY = 'automation'
export const LEGACY_NIGHTLY_KEY = 'automation.inbox_nightly'
export const SCHEDULES_KEY = 'automation.schedules'
export const REMINDERS_KEY = 'automation.reminders'
export const BUDGET_KEY_PREFIX = 'automation.budget.'
export const ROUTINE_KEYS = Object.freeze(['morningBrief', 'eveningReview', 'habitNudge', 'nightlyInbox'])
export const ROUTINE_PROMPT_VERSION = 'm3.routine.v1'
export const DND_POLICIES = Object.freeze(['skip', 'defer'])
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** 默认设置（M3-PLAN §1 + 用户偏好：晨报开、晚报/习惯追问关、夜间整理开、dnd 22:45–07:30、预算 2、截止提前 60 分钟）。 */
export const DEFAULT_AUTOMATION_SETTINGS = Object.freeze({
  morningBrief: Object.freeze({ enabled: true, time: '07:35' }),
  eveningReview: Object.freeze({ enabled: false, time: '21:00' }),
  habitNudge: Object.freeze({ enabled: false, time: '20:30' }),
  nightlyInbox: Object.freeze({ enabled: true, time: '21:30' }),
  deadlineReminder: Object.freeze({ enabled: true, leadMinutes: 60, dueDateAt: '09:00' }),
  dnd: Object.freeze({ start: '22:45', end: '07:30' }),
  dailyBudget: 2,
  suggestions: Object.freeze({ enabled: true, maxPerDay: 2 }),
})

export const ROUTINE_META = Object.freeze({
  morningBrief: Object.freeze({
    key: 'morningBrief',
    title: 'LifeOS · 晨间简报',
    targetKind: 'new_once',
    label: '晨间简报',
  }),
  eveningReview: Object.freeze({
    key: 'eveningReview',
    title: 'LifeOS · 晚报',
    targetKind: 'new_once',
    label: '晚报',
  }),
  habitNudge: Object.freeze({
    key: 'habitNudge',
    title: 'LifeOS · 习惯追问',
    targetKind: 'new_once',
    label: '习惯追问',
  }),
  nightlyInbox: Object.freeze({
    key: 'nightlyInbox',
    title: 'LifeOS · 夜间整理',
    targetKind: 'new',
    label: '夜间整理',
  }),
})

export const SCHEDULE_TITLE_PREFIX = 'LifeOS · '

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** 解析 HH:mm；非法返回 null。 */
export function parseHm(value) {
  if (typeof value !== 'string') return null
  const match = TIME_RE.exec(value)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  return { hour, minute, minutes: hour * 60 + minute, value: `${match[1]}:${match[2]}` }
}

/** 校验 HH:mm 字符串。 */
export function isValidHm(value) {
  return parseHm(value) !== null
}

/** 本地 HH:mm（用于 dnd/提醒时间展示与判定）。 */
export function localHm(now, timeZone) {
  const date = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(date.getTime())) throw new TypeError('invalid now')
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const pick = (type) => parts.find((part) => part.type === type)?.value
  return `${pick('hour')}:${pick('minute')}`
}

/** 时间是否落在 dnd 窗口内（支持跨日；start===end 表示空窗口）。 */
export function isTimeInDnd(time, dnd) {
  const t = parseHm(time)
  const start = parseHm(dnd?.start)
  const end = parseHm(dnd?.end)
  if (!t || !start || !end) return false
  if (start.minutes === end.minutes) return false
  if (start.minutes < end.minutes) return t.minutes >= start.minutes && t.minutes < end.minutes
  return t.minutes >= start.minutes || t.minutes < end.minutes
}

/** 当前是否处于 dnd。 */
export function isDndAt(now, timeZone, dnd) {
  return isTimeInDnd(localHm(now, timeZone), dnd)
}

/** 合并默认值（仅已知字段；用于读取旧数据/缺失字段）。 */
export function normalizeAutomationSettings(raw) {
  const value = isPlainObject(raw) ? raw : {}
  const merged = {}
  for (const key of ROUTINE_KEYS) {
    const base = DEFAULT_AUTOMATION_SETTINGS[key]
    const current = isPlainObject(value[key]) ? value[key] : {}
    merged[key] = {
      enabled: typeof current.enabled === 'boolean' ? current.enabled : base.enabled,
      time: isValidHm(current.time) ? current.time : base.time,
    }
  }
  const deadline = isPlainObject(value.deadlineReminder) ? value.deadlineReminder : {}
  merged.deadlineReminder = {
    enabled: typeof deadline.enabled === 'boolean' ? deadline.enabled : DEFAULT_AUTOMATION_SETTINGS.deadlineReminder.enabled,
    leadMinutes: Number.isInteger(deadline.leadMinutes)
      ? deadline.leadMinutes
      : DEFAULT_AUTOMATION_SETTINGS.deadlineReminder.leadMinutes,
    dueDateAt: isValidHm(deadline.dueDateAt)
      ? deadline.dueDateAt
      : DEFAULT_AUTOMATION_SETTINGS.deadlineReminder.dueDateAt,
  }
  const dnd = isPlainObject(value.dnd) ? value.dnd : {}
  merged.dnd = {
    start: isValidHm(dnd.start) ? dnd.start : DEFAULT_AUTOMATION_SETTINGS.dnd.start,
    end: isValidHm(dnd.end) ? dnd.end : DEFAULT_AUTOMATION_SETTINGS.dnd.end,
  }
  merged.dailyBudget = Number.isInteger(value.dailyBudget)
    ? value.dailyBudget
    : DEFAULT_AUTOMATION_SETTINGS.dailyBudget
  const suggestions = isPlainObject(value.suggestions) ? value.suggestions : {}
  merged.suggestions = {
    enabled: typeof suggestions.enabled === 'boolean' ? suggestions.enabled : DEFAULT_AUTOMATION_SETTINGS.suggestions.enabled,
    maxPerDay: Number.isInteger(suggestions.maxPerDay)
      ? suggestions.maxPerDay
      : DEFAULT_AUTOMATION_SETTINGS.suggestions.maxPerDay,
  }
  if (typeof value.revision === 'number' && Number.isInteger(value.revision)) merged.revision = value.revision
  if (DND_POLICIES.includes(value.dndPolicy)) merged.dndPolicy = value.dndPolicy
  return merged
}

/** M2 `automation.inbox_nightly` → 统一设置的 nightlyInbox 片段。 */
export function legacyNightlyToSettings(legacy) {
  if (!isPlainObject(legacy)) return null
  return {
    enabled: legacy.enabled !== false,
    time: isValidHm(legacy.time) ? legacy.time : DEFAULT_AUTOMATION_SETTINGS.nightlyInbox.time,
  }
}

/**
 * 迁移合并：已有统一设置优先；缺失 nightlyInbox 时用 M2 legacy 补齐。
 * @returns {{settings: object, migrated: boolean}}
 */
export function migrateAutomationSettings(raw, legacy) {
  const settings = normalizeAutomationSettings(raw)
  const legacyNightly = legacyNightlyToSettings(legacy)
  const hasUnified = isPlainObject(raw)
  let migrated = false
  if (!hasUnified && legacyNightly) {
    settings.nightlyInbox = { ...settings.nightlyInbox, ...legacyNightly }
    migrated = true
  }
  return { settings, migrated }
}

/** 合并 patch（深合并已知 section），返回新对象。 */
export function mergeAutomationSettings(current, patch) {
  const base = normalizeAutomationSettings(current)
  if (!isPlainObject(patch)) return base
  const next = clone(base)
  for (const key of ROUTINE_KEYS) {
    if (!isPlainObject(patch[key])) continue
    if (typeof patch[key].enabled === 'boolean') next[key].enabled = patch[key].enabled
    if (typeof patch[key].time === 'string') next[key].time = patch[key].time
  }
  if (isPlainObject(patch.deadlineReminder)) {
    const d = patch.deadlineReminder
    if (typeof d.enabled === 'boolean') next.deadlineReminder.enabled = d.enabled
    if (d.leadMinutes !== undefined) next.deadlineReminder.leadMinutes = Number(d.leadMinutes)
    if (typeof d.dueDateAt === 'string') next.deadlineReminder.dueDateAt = d.dueDateAt
  }
  if (isPlainObject(patch.dnd)) {
    if (typeof patch.dnd.start === 'string') next.dnd.start = patch.dnd.start
    if (typeof patch.dnd.end === 'string') next.dnd.end = patch.dnd.end
  }
  if (patch.dailyBudget !== undefined) next.dailyBudget = Number(patch.dailyBudget)
  if (isPlainObject(patch.suggestions)) {
    if (typeof patch.suggestions.enabled === 'boolean') next.suggestions.enabled = patch.suggestions.enabled
    if (patch.suggestions.maxPerDay !== undefined) next.suggestions.maxPerDay = Number(patch.suggestions.maxPerDay)
  }
  if (DND_POLICIES.includes(patch.dndPolicy)) next.dndPolicy = patch.dndPolicy
  return next
}

/** 识别 patch 中未知/非法结构（用于 422 提前拒绝）。 */
export function validateAutomationPatchShape(patch) {
  const errors = []
  if (!isPlainObject(patch)) return ['patch 必须是对象']
  const allowedRoot = new Set([...ROUTINE_KEYS, 'deadlineReminder', 'dnd', 'dailyBudget', 'suggestions', 'dndPolicy', 'revision'])
  for (const key of Object.keys(patch)) {
    if (!allowedRoot.has(key)) errors.push(`未知设置项：${key}`)
  }
  for (const key of ROUTINE_KEYS) {
    if (patch[key] === undefined) continue
    if (!isPlainObject(patch[key])) {
      errors.push(`${key} 必须是对象`)
      continue
    }
    for (const field of Object.keys(patch[key])) {
      if (!['enabled', 'time'].includes(field)) errors.push(`${key} 不支持的字段：${field}`)
    }
  }
  if (patch.deadlineReminder !== undefined) {
    if (!isPlainObject(patch.deadlineReminder)) errors.push('deadlineReminder 必须是对象')
    else {
      for (const field of Object.keys(patch.deadlineReminder)) {
        if (!['enabled', 'leadMinutes', 'dueDateAt'].includes(field)) {
          errors.push(`deadlineReminder 不支持的字段：${field}`)
        }
      }
    }
  }
  if (patch.dnd !== undefined) {
    if (!isPlainObject(patch.dnd)) errors.push('dnd 必须是对象')
    else {
      for (const field of Object.keys(patch.dnd)) {
        if (!['start', 'end'].includes(field)) errors.push(`dnd 不支持的字段：${field}`)
      }
    }
  }
  if (patch.suggestions !== undefined) {
    if (!isPlainObject(patch.suggestions)) errors.push('suggestions 必须是对象')
    else {
      for (const field of Object.keys(patch.suggestions)) {
        if (!['enabled', 'maxPerDay'].includes(field)) errors.push(`suggestions 不支持的字段：${field}`)
      }
    }
  }
  return errors
}

/**
 * 严格校验完整设置（合并后调用）。
 * @returns {{ok: boolean, errors: string[], value?: object}}
 */
export function validateAutomationSettings(settings) {
  const errors = validateAutomationPatchShape(settings)
  if (!isPlainObject(settings)) return { ok: false, errors: ['设置必须是对象'] }
  const dnd = isPlainObject(settings.dnd) ? settings.dnd : {}
  if (!isValidHm(dnd.start)) errors.push(`dnd.start 必须是 HH:mm：${String(dnd.start)}`)
  if (!isValidHm(dnd.end)) errors.push(`dnd.end 必须是 HH:mm：${String(dnd.end)}`)
  const dndValid = isValidHm(dnd.start) && isValidHm(dnd.end)

  for (const key of ROUTINE_KEYS) {
    const routine = settings[key]
    if (!isPlainObject(routine)) {
      errors.push(`${key} 必须是对象`)
      continue
    }
    if (typeof routine.enabled !== 'boolean') errors.push(`${key}.enabled 必须是布尔值`)
    if (!isValidHm(routine.time)) {
      errors.push(`${key}.time 必须是 HH:mm：${String(routine.time)}`)
    } else if (dndValid && isTimeInDnd(routine.time, dnd)) {
      errors.push(`${key}.time（${routine.time}）落在免打扰时段 ${dnd.start}–${dnd.end} 内`)
    }
  }

  const deadline = settings.deadlineReminder
  if (!isPlainObject(deadline)) {
    errors.push('deadlineReminder 必须是对象')
  } else {
    if (typeof deadline.enabled !== 'boolean') errors.push('deadlineReminder.enabled 必须是布尔值')
    if (!Number.isInteger(deadline.leadMinutes) || deadline.leadMinutes < 5 || deadline.leadMinutes > 1440) {
      errors.push('deadlineReminder.leadMinutes 必须是 5–1440 的整数')
    }
    if (!isValidHm(deadline.dueDateAt)) errors.push('deadlineReminder.dueDateAt 必须是 HH:mm')
  }

  if (!Number.isInteger(settings.dailyBudget) || settings.dailyBudget < 0 || settings.dailyBudget > 5) {
    errors.push('dailyBudget 必须是 0–5 的整数')
  }
  const suggestions = settings.suggestions
  if (!isPlainObject(suggestions)) {
    errors.push('suggestions 必须是对象')
  } else {
    if (typeof suggestions.enabled !== 'boolean') errors.push('suggestions.enabled 必须是布尔值')
    if (!Number.isInteger(suggestions.maxPerDay) || suggestions.maxPerDay < 0 || suggestions.maxPerDay > 5) {
      errors.push('suggestions.maxPerDay 必须是 0–5 的整数')
    }
  }
  if (settings.dndPolicy !== undefined && !DND_POLICIES.includes(settings.dndPolicy)) {
    errors.push(`dndPolicy 只能是 ${DND_POLICIES.join('|')}`)
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [], value: settings }
}

/** 设置差异：changed 明细 + impacted（需要 reconcile 的键）。 */
export function diffAutomationSettings(before, after) {
  const a = normalizeAutomationSettings(before)
  const b = normalizeAutomationSettings(after)
  const changed = []
  const impacted = new Set()
  const record = (path, from, to) => {
    if (JSON.stringify(from) !== JSON.stringify(to)) changed.push({ path, from, to })
  }
  for (const key of ROUTINE_KEYS) {
    record(`${key}.enabled`, a[key].enabled, b[key].enabled)
    record(`${key}.time`, a[key].time, b[key].time)
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) impacted.add(key)
  }
  record('deadlineReminder.enabled', a.deadlineReminder.enabled, b.deadlineReminder.enabled)
  record('deadlineReminder.leadMinutes', a.deadlineReminder.leadMinutes, b.deadlineReminder.leadMinutes)
  record('deadlineReminder.dueDateAt', a.deadlineReminder.dueDateAt, b.deadlineReminder.dueDateAt)
  if (JSON.stringify(a.deadlineReminder) !== JSON.stringify(b.deadlineReminder)) impacted.add('deadlineReminder')
  record('dnd.start', a.dnd.start, b.dnd.start)
  record('dnd.end', a.dnd.end, b.dnd.end)
  if (JSON.stringify(a.dnd) !== JSON.stringify(b.dnd)) impacted.add('dnd')
  record('dailyBudget', a.dailyBudget, b.dailyBudget)
  if (a.dailyBudget !== b.dailyBudget) impacted.add('dailyBudget')
  record('suggestions.enabled', a.suggestions.enabled, b.suggestions.enabled)
  record('suggestions.maxPerDay', a.suggestions.maxPerDay, b.suggestions.maxPerDay)
  if (JSON.stringify(a.suggestions) !== JSON.stringify(b.suggestions)) impacted.add('suggestions')
  if ((a.dndPolicy ?? 'skip') !== (b.dndPolicy ?? 'skip')) {
    record('dndPolicy', a.dndPolicy ?? 'skip', b.dndPolicy ?? 'skip')
    impacted.add('dndPolicy')
  }
  return { changed, impacted: [...impacted] }
}

/** routine 对应的 schedule target（Agent 生成内容；target=lifeos preset 会话）。 */
export function routineTarget(key) {
  const meta = ROUTINE_META[key]
  if (!meta) throw new TypeError(`unknown routine: ${key}`)
  return { kind: meta.targetKind, create: { agentPreset: 'lifeos' } }
}

/** routine 的 cron timing（Asia/Shanghai，与 M2 nightly 一致形态）。 */
export function routineCron(time, timeZone = 'Asia/Shanghai') {
  const parsed = parseHm(time)
  const value = parsed || parseHm(DEFAULT_AUTOMATION_SETTINGS.morningBrief.time)
  return { expression: `${value.minute} ${value.hour} * * *`, time_zone: timeZone }
}

/** routine prompt（由 Agent 生成内容；prompt 只给纪律与数据读取要求，不含具体数据）。 */
export function buildRoutinePrompt(key, { timeZone = 'Asia/Shanghai' } = {}) {
  const base = `[LifeOS 自动化 · ${ROUTINE_META[key]?.label ?? key}] 时区 ${timeZone}。请以运行时当地日期为准，先读取真实数据再输出；只依据数据、不编造；空内容就一句话说明；不要修改任何业务数据。`
  if (key === 'morningBrief') {
    return `${base}\n读昨日笔记（若有）与昨日完成/今日任务+日程+习惯+指标；输出 ≤300 字：昨天一句回顾、今日 3 件重点、时间地点提醒、习惯提醒、一句鼓励。无安排时只回一句中文。`
  }
  if (key === 'eveningReview') {
    return `${base}\n对照晨间计划与今日实际（任务/指标/习惯），输出晚报：完成与偏差各一两句、2 个反思问题、一句勉励。`
  }
  if (key === 'habitNudge') {
    return `${base}\n只询问今天尚未打卡的习惯（最多 3 个），给出简短快捷回复选项；不重复追问，不编造未记录的事实。`
  }
  if (key === 'nightlyInbox') {
    return `${base}\n执行夜间整理：调用 lifeos_triage begin（scope=pending）→ 依原文提交候选 → 一句中文摘要；无待整理则直接结束。不修改原始记录。`
  }
  return base
}

/** routine 幂等签名（不含日期，避免每日重建；prompt 版本参与签名）。 */
export function routineSignature(key, settings, timeZone = 'Asia/Shanghai') {
  const routine = normalizeAutomationSettings(settings)[key]
  return JSON.stringify({
    version: ROUTINE_PROMPT_VERSION,
    key,
    enabled: routine.enabled,
    time: routine.time,
    target: routineTarget(key),
    cron: routineCron(routine.time, timeZone),
    prompt: buildRoutinePrompt(key, { timeZone }),
  })
}

/** 某任务应设置提醒的 UTC 时刻；无可提醒返回 null。 */
export function deadlineRemindAt(task, settings, { timeZone = 'Asia/Shanghai' } = {}) {
  const normalized = normalizeAutomationSettings(settings)
  const reminder = normalized.deadlineReminder
  if (!reminder.enabled || !task || typeof task !== 'object') return null
  if (task.deleted_at || task.status === 'done' || task.status === 'cancelled') return null
  const leadMs = reminder.leadMinutes * 60 * 1000
  if (typeof task.due_at === 'string' && Number.isFinite(Date.parse(task.due_at))) {
    const remindMs = Date.parse(task.due_at) - leadMs
    return Number.isFinite(remindMs) ? new Date(remindMs).toISOString() : null
  }
  if (typeof task.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(task.due_date)) {
    const hm = parseHm(reminder.dueDateAt)
    if (!hm) return null
    return localDateTimeToIso(timeZone, task.due_date, reminder.dueDateAt)
  }
  return null
}

/** 提醒是否落在 dnd（按本地时刻）。 */
export function isReminderInDnd(remindAt, settings, timeZone = 'Asia/Shanghai') {
  if (typeof remindAt !== 'string' || !Number.isFinite(Date.parse(remindAt))) return false
  const hm = localHm(new Date(remindAt), timeZone)
  return isTimeInDnd(hm, normalizeAutomationSettings(settings).dnd)
}

/** 下一次本地 HH:mm 对应的 UTC ISO（用于状态展示兜底）。 */
export function nextRoutineAt(time, now, timeZone = 'Asia/Shanghai') {
  const parsed = parseHm(time)
  if (!parsed) return null
  const today = localDate(timeZone, new Date(now))
  let candidate = localDateTimeToIso(timeZone, today, parsed.value)
  if (Date.parse(candidate) <= Number(now)) {
    candidate = localDateTimeToIso(timeZone, addDays(today, 1), parsed.value)
  }
  return candidate
}

/** routine 的展示状态（由 service 的 schedule 状态映射调用）。 */
export function routineSettingsView(settings) {
  const normalized = normalizeAutomationSettings(settings)
  return ROUTINE_KEYS.map((key) => ({
    key,
    title: ROUTINE_META[key].title,
    label: ROUTINE_META[key].label,
    enabled: normalized[key].enabled,
    time: normalized[key].time,
    targetKind: ROUTINE_META[key].targetKind,
  }))
}

/** 预算存储键（本地自然日）。 */
export function budgetKey(localDateString) {
  return `${BUDGET_KEY_PREFIX}${localDateString}`
}

/** 读取/累加预算结构：{date, used, byKind:{}}。 */
export function budgetState(raw) {
  if (!isPlainObject(raw)) return { date: null, used: 0, byKind: {} }
  return {
    date: typeof raw.date === 'string' ? raw.date : null,
    used: Number.isInteger(raw.used) && raw.used >= 0 ? raw.used : 0,
    byKind: isPlainObject(raw.byKind) ? { ...raw.byKind } : {},
  }
}

export function canConsumeBudget(state, limit, count = 1) {
  const used = budgetState(state).used
  return used + Math.max(1, Number(count) || 1) <= limit
}

/** 本地日期（给 service 用，避免各模块重复实现）。 */
export function localDateOf(now, timeZone = 'Asia/Shanghai') {
  return localDate(timeZone, new Date(now))
}

/** 供测试/状态：dnd 描述。 */
export function dndView(settings, now, timeZone = 'Asia/Shanghai') {
  const normalized = normalizeAutomationSettings(settings)
  return {
    start: normalized.dnd.start,
    end: normalized.dnd.end,
    active: isDndAt(now, timeZone, normalized.dnd),
    policy: normalized.dndPolicy ?? 'skip',
  }
}

export { addDays, localDateOfIso }
