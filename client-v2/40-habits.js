/* ═══════════════════════ M6 · V2 习惯 Tab ═══════════════════════
 * 入口：HabitTabV2({ runtime, narrow })
 * 数据源：GET /habits、GET /habits/stats、GET /habits/:id/checkins、GET /habits/month
 * 写入：POST /habits/:id/checkin、DELETE /habits/:id/checkins/:date、
 *       POST /habits、PATCH /habits/:id、POST /habits/:id/archive
 * 说明：
 *  - Host 之后端只有 habit 表 + habit_checkin 表，没有独立的习惯日志表；
 *    规格里的“打卡日志”落到 checkin.note 上，删除日志 = note 置空（打卡记录保留）。
 *  - 补打卡窗口：过去日期必须带 retro 且最近 7 天内（RETRO_WINDOW_DAYS）。
 *  - 图标/分组不属于 Host 数据模型，图标按名称推导，列表按“当日计划 / 灵活打卡 / 已暂停”分组。
 */

const HABIT_LIST_WIDTH = 400
const HABIT_PANES_STORAGE_KEY = 'lifeos.v2.habitPanes'
const HABIT_STATE_KEY = 'lifeos.v2.state.habit'
const HABIT_LIST_MIN = 320
const HABIT_LIST_MAX = 560

function habitRestoreState() {
  try {
    const raw = window.localStorage.getItem(HABIT_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date || '')) ? String(parsed.date) : null
    const monthKey = /^\d{4}-\d{2}$/.test(String(parsed.monthKey || '')) ? String(parsed.monthKey) : null
    const collapsed = parsed.collapsed && typeof parsed.collapsed === 'object' ? parsed.collapsed : null
    return {
      date: date,
      monthKey: monthKey,
      selectedId: typeof parsed.selectedId === 'string' ? parsed.selectedId : null,
      collapsed: collapsed,
    }
  } catch (error) {
    return null
  }
}

function habitClampListWidth(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return HABIT_LIST_WIDTH
  return Math.max(HABIT_LIST_MIN, Math.min(HABIT_LIST_MAX, Math.round(num)))
}
const HABIT_NOTE_MAX = 500
const HABIT_RETRO_WINDOW_DAYS = 7
const HABIT_WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const HABIT_WEEKDAY_LABELS = { MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六', SU: '日' }
const HABIT_WEEKDAY_FULL = { MO: '周一', TU: '周二', WE: '周三', TH: '周四', FR: '周五', SA: '周六', SU: '周日' }
const HABIT_FREQUENCY_KINDS = [
  { id: 'daily', label: '每天' },
  { id: 'weekly_days', label: '每周固定' },
  { id: 'weekly_count', label: '每周 N 次' },
  { id: 'interval', label: '间隔 N 天' },
]
const HABIT_ICON_FALLBACKS = ['🌱', '🪴', '🌿', '🍀', '🌳', '🌵', '🍃', '🌾']
const HABIT_ICON_HINTS = [
  { keys: ['晨跑', '跑步', '跑', '慢跑'], icon: '🏃' },
  { keys: ['散步', '走路', '步行'], icon: '🚶' },
  { keys: ['骑行', '单车', '自行车'], icon: '🚴' },
  { keys: ['游泳'], icon: '🏊' },
  { keys: ['健身', '力量', '撸铁', '运动', '锻炼'], icon: '🏋️' },
  { keys: ['瑜伽', '冥想', '正念', '拉伸'], icon: '🧘' },
  { keys: ['阅读', '读书', '看书'], icon: '📖' },
  { keys: ['写作', '日记', '复盘', '记录'], icon: '✍️' },
  { keys: ['喝水', '饮水', '水'], icon: '💧' },
  { keys: ['早睡', '睡眠', '睡觉', '入睡'], icon: '🛌' },
  { keys: ['早起', '起床'], icon: '⏰' },
  { keys: ['早餐', '饮食', '吃饭', '健康饮食', '轻食'], icon: '🥗' },
  { keys: ['学习', '课程', '背单词', '英语', '复习'], icon: '📚' },
  { keys: ['代码', '编程', '开发'], icon: '💻' },
  { keys: ['练琴', '钢琴', '吉他'], icon: '🎹' },
  { keys: ['画画', '绘画'], icon: '🎨' },
  { keys: ['音乐', '听歌'], icon: '🎵' },
  { keys: ['整理', '清理', '家务', '打扫', '收纳'], icon: '🧹' },
  { keys: ['记账', '理财', '存钱'], icon: '💰' },
  { keys: ['家人', '陪伴', '联系', '朋友'], icon: '👨‍👩‍👧' },
  { keys: ['练字'], icon: '🖌️' },
  { keys: ['总结', '计划'], icon: '📝' },
  { keys: ['晒太阳', '户外', '阳光'], icon: '☀️' },
  { keys: ['护肤', '洗头'], icon: '🧴' },
  { keys: ['遛狗', '狗'], icon: '🐕' },
  { keys: ['喂猫', '猫'], icon: '🐈' },
  { keys: ['电影', '观影'], icon: '🎬' },
  { keys: ['药', '维生素'], icon: '💊' },
]
const HABIT_STATUS_META = {
  done: { label: '已完成', tone: 'success' },
  partial: { label: '部分完成', tone: 'warn' },
  skipped: { label: '已跳过', tone: 'faint' },
  not_done: { label: '未完成', tone: 'danger' },
  paused: { label: '已暂停', tone: 'faint' },
  unknown: { label: '未记录', tone: 'faint' },
}

/* ── 日期工具（V2 作用域里没有通用的月份/日期解析函数，这里自包含实现） ── */

function habitPad2(value) {
  const number = Number(value)
  return number < 10 ? '0' + String(number) : String(number)
}

function habitDateFromKey(dateKey) {
  if (!dateKey) return null
  const date = new Date(String(dateKey) + 'T00:00:00')
  return Number.isNaN(date.getTime()) ? null : date
}

function habitDateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  return date.getFullYear() + '-' + habitPad2(date.getMonth() + 1) + '-' + habitPad2(date.getDate())
}

function habitToday() {
  try {
    if (typeof todayIso === 'function') {
      const value = todayIso()
      if (value) return value
    }
  } catch (error) {
    /* ignore */
  }
  return habitDateKey(new Date())
}

function habitAddDays(dateKey, days) {
  try {
    if (typeof addDaysKey === 'function') return addDaysKey(dateKey, Number(days) || 0)
  } catch (error) {
    /* ignore */
  }
  const date = habitDateFromKey(dateKey)
  if (!date) return dateKey
  date.setDate(date.getDate() + (Number(days) || 0))
  return habitDateKey(date)
}

function habitDaysBetween(fromKey, toKey) {
  const from = habitDateFromKey(fromKey)
  const to = habitDateFromKey(toKey)
  if (!from || !to) return 0
  return Math.round((to.getTime() - from.getTime()) / 86400000)
}

/* 0 = 周一 … 6 = 周日，与 Host domain/habit.js 的 WEEKDAYS 顺序一致 */
function habitWeekdayIndex(dateKey) {
  const date = habitDateFromKey(dateKey)
  if (!date) return 0
  return (date.getDay() + 6) % 7
}

function habitWeekdayCodeOf(dateKey) {
  return HABIT_WEEKDAY_CODES[habitWeekdayIndex(dateKey)]
}

function habitMonthKeyOf(dateKey) {
  return String(dateKey || '').slice(0, 7)
}

function habitMonthDates(monthKey) {
  const parts = String(monthKey || '').split('-')
  const year = Number(parts[0])
  const month = Number(parts[1])
  if (!year || !month) return []
  const total = new Date(year, month, 0).getDate()
  const dates = []
  for (let day = 1; day <= total; day += 1) dates.push(year + '-' + habitPad2(month) + '-' + habitPad2(day))
  return dates
}

function habitShiftMonth(monthKey, delta) {
  const parts = String(monthKey || '').split('-')
  const now = new Date()
  const year = Number(parts[0]) || now.getFullYear()
  const month = Number(parts[1]) || now.getMonth() + 1
  const date = new Date(year, month - 1 + Number(delta || 0), 1)
  return date.getFullYear() + '-' + habitPad2(date.getMonth() + 1)
}

function habitMonthLabel(monthKey) {
  const parts = String(monthKey || '').split('-')
  if (parts.length < 2) return String(monthKey || '')
  return parts[0] + '年' + String(Number(parts[1])) + '月'
}

function habitFormatDate(dateKey) {
  if (!dateKey) return ''
  const parts = String(dateKey).split('-')
  if (parts.length < 3) return String(dateKey)
  return Number(parts[1]) + '月' + Number(parts[2]) + '日'
}

function habitFormatDateTime(iso) {
  if (!iso) return ''
  return String(iso).slice(0, 10)
}

function habitWeekStartOf(dateKey, weekStart) {
  const index = habitWeekdayIndex(dateKey)
  if (weekStart === 'sunday') return habitAddDays(dateKey, -((index + 1) % 7))
  return habitAddDays(dateKey, -index)
}

function habitClampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const rounded = Math.round(number)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/* ── 频率 / 计划日 / 目标 ── */

function habitFrequencyRule(habit) {
  const rule = habit && habit.frequency_rule
  return rule && typeof rule === 'object' ? rule : null
}

function habitFrequencyKind(habit) {
  const rule = habitFrequencyRule(habit)
  return rule && rule.kind ? String(rule.kind) : 'daily'
}

function habitSortWeekdays(days) {
  const source = Array.isArray(days) ? days : []
  const seen = {}
  const out = []
  HABIT_WEEKDAY_CODES.forEach(function each(code) {
    if (source.indexOf(code) >= 0 && !seen[code]) {
      seen[code] = true
      out.push(code)
    }
  })
  return out
}

function habitWeekDays(habit) {
  const rule = habitFrequencyRule(habit)
  return habitSortWeekdays(rule && rule.days)
}

function habitFrequencyText(habit) {
  if (habit && typeof habit.frequency_text === 'string' && habit.frequency_text) return habit.frequency_text
  const rule = habitFrequencyRule(habit)
  if (!rule) return '未设置频率'
  if (rule.kind === 'daily') {
    const interval = habitClampInt(rule.interval, 1, 365, 1)
    return interval === 1 ? '每天' : '每 ' + interval + ' 天'
  }
  if (rule.kind === 'weekly_days') {
    const days = habitSortWeekdays(rule.days)
    if (days.length === 7) return '每天'
    if (!days.length) return '每周（未选星期）'
    return '每周 ' + days.map(function label(code) { return HABIT_WEEKDAY_LABELS[code] }).join('、')
  }
  if (rule.kind === 'weekly_count') return '每周 ' + habitClampInt(rule.count, 1, 7, 1) + ' 次'
  if (rule.kind === 'interval') return '每 ' + habitClampInt(rule.days, 1, 365, 1) + ' 天'
  return '未设置频率'
}

/* 与 Host domain/habit.js isPlanDay 同口径：weekly_count 恒为 false（按周期统计） */
function habitPlanDay(habit, dateKey) {
  if (!habit || !dateKey) return false
  const rule = habitFrequencyRule(habit)
  if (!rule) return false
  const start = habit.start_date
  if (!start || dateKey < start) return false
  if (habit.end_date && dateKey > habit.end_date) return false
  if (rule.kind === 'daily') {
    const interval = habitClampInt(rule.interval, 1, 365, 1)
    return habitDaysBetween(start, dateKey) % interval === 0
  }
  if (rule.kind === 'weekly_days') {
    const days = habitSortWeekdays(rule.days)
    return days.indexOf(habitWeekdayCodeOf(dateKey)) >= 0
  }
  if (rule.kind === 'interval') {
    const anchor = rule.anchor_date || start
    const interval = habitClampInt(rule.days, 1, 365, 1)
    return habitDaysBetween(anchor, dateKey) % interval === 0
  }
  return false
}

/* 暂停区间：[paused_at, resumed_at 或 现在]；Host 只有一对字段，按当前区间处理 */
function habitPausedOn(habit, dateKey) {
  if (!habit || !dateKey) return false
  const pausedAt = habit.paused_at ? String(habit.paused_at).slice(0, 10) : ''
  if (!pausedAt) return habit.status === 'paused'
  if (dateKey < pausedAt) return false
  const resumedAt = habit.resumed_at ? String(habit.resumed_at).slice(0, 10) : ''
  if (resumedAt && dateKey >= resumedAt) return false
  return true
}

function habitTargetJson(habit) {
  const target = habit && habit.target_json
  return target && typeof target === 'object' ? target : null
}

function habitTargetValue(habit) {
  const target = habitTargetJson(habit)
  if (!target) return 0
  const raw = target.value !== undefined ? target.value : target.target
  const number = Number(raw)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function habitTargetUnit(habit) {
  const target = habitTargetJson(habit)
  if (target && typeof target.unit === 'string' && target.unit) return target.unit
  return '次'
}

function habitIsQuantified(habit) {
  return habitTargetValue(habit) > 1
}

function habitPeriodTarget(habit) {
  const rule = habit && habit.period_rule
  if (rule && typeof rule === 'object') {
    const count = Number(rule.target_count)
    if (Number.isInteger(count) && count > 0) return count
  }
  const frequency = habitFrequencyRule(habit)
  if (frequency && frequency.kind === 'weekly_count') {
    const count = Number(frequency.count)
    if (Number.isInteger(count) && count > 0) return count
  }
  return 0
}

function habitIconFor(habit) {
  const name = String((habit && habit.name) || '')
  for (let i = 0; i < HABIT_ICON_HINTS.length; i += 1) {
    const entry = HABIT_ICON_HINTS[i]
    for (let j = 0; j < entry.keys.length; j += 1) {
      if (name.indexOf(entry.keys[j]) >= 0) return entry.icon
    }
  }
  const seed = String((habit && (habit.id || habit.name)) || '')
  let sum = 0
  for (let i = 0; i < seed.length; i += 1) sum += seed.charCodeAt(i)
  return HABIT_ICON_FALLBACKS[sum % HABIT_ICON_FALLBACKS.length]
}

/* ── 打卡记录工具 ── */

function habitCheckinMap(checkins) {
  const out = {}
  const list = Array.isArray(checkins) ? checkins : []
  list.forEach(function each(item) {
    if (item && item.local_date) out[item.local_date] = item
  })
  return out
}

function habitCheckinByDate(checkins, dateKey) {
  const list = Array.isArray(checkins) ? checkins : []
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].local_date === dateKey) return list[i]
  }
  return null
}

function habitCheckinValue(checkin) {
  if (!checkin) return 0
  const raw = checkin.value_json
  let value = null
  if (raw && typeof raw === 'object') {
    if (raw.value !== undefined) value = raw.value
    else if (raw.target !== undefined) value = raw.target
  } else if (typeof raw === 'number') {
    value = raw
  }
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function habitStatusMeta(status) {
  return HABIT_STATUS_META[status] || HABIT_STATUS_META.unknown
}

function habitStatusLabel(status) {
  return habitStatusMeta(status).label
}

function habitStatusTone(status) {
  return habitStatusMeta(status).tone
}

function habitStreakUnitLabel(unit) {
  if (unit === 'week') return '周'
  if (unit === 'month') return '月'
  return '天'
}

function habitStreakText(statsItem) {
  const streak = statsItem && statsItem.streak
  if (!streak) return ''
  const value = Number(streak.value) || 0
  if (value <= 0) return ''
  return '连续 ' + value + ' ' + habitStreakUnitLabel(streak.unit)
}

function habitErrorHint(error) {
  const text = errorText(error)
  if (text.indexOf('补记窗口') >= 0 || text.indexOf('retro') >= 0) return '过去日期只能补记最近 7 天内的打卡'
  if (text.indexOf('invalid_state') >= 0) return '习惯已暂停或归档，无法打卡'
  if (text.indexOf('not_found') >= 0) return '记录不存在或已被删除'
  if (text.indexOf('conflict') >= 0 || text.indexOf('revision') >= 0) return '数据已被其他操作更新，请刷新后重试'
  return text
}

/* ── API 封装 ── */

function habitApiSend(method, path, body) {
  const init = { method: method, headers: { accept: 'application/json' } }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return apiRequest(path, init)
}

async function habitFetchStatsMap() {
  try {
    const payload = await apiRequest('/habits/stats')
    const map = {}
    const items = payload && Array.isArray(payload.habits) ? payload.habits : []
    items.forEach(function each(item) {
      if (item && item.habitId) map[item.habitId] = item
    })
    return map
  } catch (error) {
    return null
  }
}

async function habitFetchCheckins(habitId) {
  try {
    const payload = await apiRequest('/habits/' + encodeURIComponent(habitId) + '/checkins')
    return payload && Array.isArray(payload.items) ? payload.items : []
  } catch (error) {
    return null
  }
}

async function habitFetchMonth(monthKey) {
  try {
    const payload = await apiRequest('/habits/month?month=' + encodeURIComponent(monthKey))
    return payload && payload.month ? payload : null
  } catch (error) {
    return null
  }
}

/* ── 纯计算：7 天圆环聚合 / 单习惯月度统计 ── */

function habitDateSummary(habits, checkinsById, dateKey) {
  let planned = 0
  let doneUnits = 0
  let recorded = 0
  const list = Array.isArray(habits) ? habits : []
  list.forEach(function each(habit) {
    if (!habit || habit.status === 'archived') return
    if (habitPausedOn(habit, dateKey)) return
    const checkins = checkinsById[habit.id] || []
    const record = habitCheckinByDate(checkins, dateKey)
    const plan = habitPlanDay(habit, dateKey)
    if (plan) planned += 1
    if (!record) return
    recorded += 1
    if (!plan) return
    if (record.status === 'done') doneUnits += 1
    else if (record.status === 'partial') {
      const target = habitTargetValue(habit) || 1
      const value = habitCheckinValue(record)
      doneUnits += Math.max(0, Math.min(1, value / target))
    }
  })
  return {
    planned: planned,
    doneUnits: doneUnits,
    recorded: recorded,
    ratio: planned > 0 ? Math.min(1, doneUnits / planned) : 0,
  }
}

function habitMonthStats(habit, monthKey, checkins, today, weekStart) {
  const result = { monthDone: 0, totalDone: 0, expected: 0, done: 0, ratio: null }
  if (!habit) return result
  const list = Array.isArray(checkins) ? checkins : []
  const dates = habitMonthDates(monthKey)
  const monthStart = dates.length ? dates[0] : monthKey + '-01'
  const monthEnd = dates.length ? dates[dates.length - 1] : monthKey + '-31'
  const upto = today && today < monthEnd ? today : monthEnd
  const checkinMap = habitCheckinMap(list)
  list.forEach(function count(item) {
    if (!item || item.status !== 'done') return
    result.totalDone += 1
    if (habitMonthKeyOf(item.local_date) === monthKey) result.monthDone += 1
  })
  if (habitFrequencyKind(habit) === 'weekly_count') {
    // 与 Host computeCoverage 同口径：只统计「完整落在本月内且已经结束」的周期，
    // 月初/月末被截断的半周期不计入分母，否则完成率会被系统性低估。
    const target = habitPeriodTarget(habit)
    let cursor = habitWeekStartOf(monthStart, weekStart)
    let guard = 0
    while (cursor <= upto && guard < 12) {
      guard += 1
      const periodEnd = habitAddDays(cursor, 6)
      if (cursor >= monthStart && periodEnd <= monthEnd && periodEnd <= upto) {
        result.expected += target
        let periodDone = 0
        list.forEach(function countInPeriod(item) {
          if (!item || item.status !== 'done') return
          if (item.local_date >= cursor && item.local_date <= periodEnd) periodDone += 1
        })
        result.done += Math.min(target, periodDone)
      }
      cursor = habitAddDays(cursor, 7)
    }
  } else {
    dates.forEach(function countDay(dateKey) {
      if (dateKey > upto) return
      if (habitPausedOn(habit, dateKey)) return
      if (!habitPlanDay(habit, dateKey)) return
      result.expected += 1
      const record = checkinMap[dateKey]
      if (record && record.status === 'done') result.done += 1
    })
  }
  result.ratio = result.expected > 0 ? Math.min(1, result.done / result.expected) : null
  return result
}

function habitMonthCellMeta(status, paused, future, plan) {
  if (status === 'done') {
    return { title: '已完成', color: V2_T.status.success, background: V2_T.status.successSoft, border: '1px solid transparent' }
  }
  if (status === 'partial') {
    return { title: '部分完成', color: V2_T.status.warn, background: V2_T.status.warnSoft, border: '1px solid transparent' }
  }
  if (status === 'not_done' || status === 'skipped') {
    return { title: '应完成未完成', color: V2_T.status.danger, background: V2_T.status.dangerSoft, border: '1px solid transparent' }
  }
  if (status === 'paused' || paused) {
    return { title: '暂停日', color: V2_T.text.tertiary, background: 'transparent', border: '1px solid transparent' }
  }
  if (status === 'unknown' || (plan && !future)) {
    return { title: '计划日未记录', color: V2_T.text.tertiary, background: 'transparent', border: '1px dashed ' + V2_T.border.subtle }
  }
  if (future && plan) {
    return { title: '未来计划日', color: V2_T.text.tertiary, background: 'transparent', border: '1px dashed ' + V2_T.border.subtle }
  }
  if (plan) {
    return { title: '计划日', color: V2_T.text.tertiary, background: 'transparent', border: '1px dashed ' + V2_T.border.subtle }
  }
  return { title: '非计划日', color: V2_T.text.tertiary, background: 'transparent', border: '1px solid transparent' }
}

/* ── 样式胶囊 ── */

function habitToneColor(tone) {
  if (tone === 'success') return V2_T.status.success
  if (tone === 'warn') return V2_T.status.warn
  if (tone === 'danger') return V2_T.status.danger
  if (tone === 'accent') return V2_T.accent.base
  return V2_T.text.tertiary
}

function habitTint(color, percent) {
  return 'color-mix(in srgb, ' + color + ' ' + percent + '%, transparent)'
}

function habitChipStyle(tone, active) {
  const color = habitToneColor(tone)
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    padding: '0 6px',
    height: 18,
    borderRadius: V2_T.radius.pill,
    fontSize: v2fs(V2_T.font.caption),
    lineHeight: '18px',
    whiteSpace: 'nowrap',
    color: active === false ? V2_T.text.secondary : color,
    background: active === false ? 'transparent' : habitTint(color, 12),
    border: '1px solid ' + (active === false ? 'transparent' : habitTint(color, 30)),
  }
}

function habitIconButtonStyle(extra) {
  return Object.assign(
    {
      width: 24,
      height: 24,
      minWidth: 24,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: 'none',
      borderRadius: V2_T.radius.sm,
      background: 'transparent',
      color: V2_T.text.secondary,
      cursor: 'pointer',
      padding: 0,
      flex: '0 0 auto',
    },
    extra || {},
  )
}

function habitInputStyle(extra) {
  return v2InputStyle(
    Object.assign(
      {
        height: 32,
        background: V2_T.surface.input,
        border: '1px solid ' + V2_T.border.subtle,
        borderRadius: V2_T.radius.sm,
        padding: '0 10px',
        color: V2_T.text.primary,
        fontSize: v2fs(13),
        boxSizing: 'border-box',
      },
      extra || {},
    ),
  )
}

function habitTextareaStyle() {
  return Object.assign(habitInputStyle(), {
    height: 'auto',
    fontSize: v2fs(13),
    lineHeight: '20px',
    padding: '8px 10px',
    resize: 'vertical',
    minHeight: 90,
    fontFamily: COLORS.fontFamily,
  })
}

function habitSegmentStyle(active) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 30,
    padding: '0 12px',
    borderRadius: V2_T.radius.pill,
    fontSize: v2fs(V2_T.font.meta),
    cursor: 'pointer',
    border: '1px solid ' + (active ? V2_T.accent.line : V2_T.border.subtle),
    background: active ? V2_T.accent.soft : 'transparent',
    color: active ? V2_T.accent.base : V2_T.text.secondary,
    fontFamily: COLORS.fontFamily,
    whiteSpace: 'nowrap',
  }
}

function habitCardStyle(extra) {
  return v2CardStyle(extra)
}

function habitFieldStyle() {
  return { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }
}

function habitLabelStyle() {
  return { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary, fontWeight: 500, lineHeight: '16px', flex: '0 0 auto' }
}

/* ── 小部件 ── */

function HabitIconBadge(props) {
  const size = props.size || 30
  const habit = props.habit
  return h(
    'div',
    {
      style: {
        width: size,
        height: size,
        minWidth: size,
        borderRadius: size >= 40 ? V2_T.radius.lg : V2_T.radius.sm,
        background: props.active ? V2_T.accent.soft : V2_T.surface.panel2,
        border: '1px solid ' + (props.active ? V2_T.accent.line : V2_T.border.subtle),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size >= 40 ? 22 : 15,
        lineHeight: 1,
        flex: '0 0 auto',
      },
      'aria-hidden': 'true',
    },
    habitIconFor(habit),
  )
}

function HabitCheckButton(props) {
  const status = props.status || ''
  const done = status === 'done'
  const partial = status === 'partial'
  const disabled = props.disabled === true || props.busy === true
  const onClick = function onClick(event) {
    event.stopPropagation()
    if (disabled) return
    props.onToggle()
  }
  return h(
    'button',
    {
      type: 'button',
      title: props.title || '',
      'aria-label': props.title || '打卡',
      disabled: disabled,
      onClick: onClick,
      style: {
        width: 26,
        height: 26,
        minWidth: 26,
        borderRadius: '50%',
        border: done ? '1px solid ' + V2_T.status.success : partial ? '1px solid ' + V2_T.status.warn : '1px solid ' + V2_T.border.strong,
        background: done ? V2_T.status.successSoft : partial ? V2_T.status.warnSoft : 'transparent',
        color: done ? V2_T.status.success : partial ? V2_T.status.warn : V2_T.text.tertiary,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'default' : 'pointer',
        padding: 0,
        flex: '0 0 auto',
        opacity: disabled ? 0.45 : 1,
        fontFamily: COLORS.fontFamily,
      },
    },
    done
      ? h(V2Icon, { name: 'check', size: 14, color: V2_T.status.success, strokeWidth: 2.2 })
      : partial
        ? h('span', { style: { fontSize: v2fs(11), fontWeight: 600 } }, String(props.value || 1))
        : null,
  )
}

function HabitStepper(props) {
  const target = Math.max(1, Number(props.target) || 1)
  const value = Math.min(target, Number(props.value) || 0)
  const done = props.status === 'done'
  const busy = props.busy === true
  const disabled = props.disabled === true || busy
  const canMinus = !done && value > 0 && !disabled
  const canPlus = !done && !disabled
  const stop = function stop(event) {
    event.stopPropagation()
  }
  const stepStyle = habitIconButtonStyle({ width: 22, height: 22, minWidth: 22, borderRadius: 6 })
  function hoverStep(event) {
    if (event.currentTarget.disabled) return
    event.currentTarget.style.background = V2_T.surface.panel2
  }
  function leaveStep(event) {
    event.currentTarget.style.background = 'transparent'
  }
  return h(
    'div',
    { style: { display: 'inline-flex', alignItems: 'center', gap: 3, flex: '0 0 auto' }, onClick: stop },
    h(
      'button',
      {
        type: 'button',
        title: '减少一次',
        disabled: !canMinus,
        onClick: function onClick(event) {
          event.stopPropagation()
          if (canMinus) props.onStep(-1)
        },
        onMouseEnter: hoverStep,
        onMouseLeave: leaveStep,
        style: Object.assign({}, stepStyle, { opacity: canMinus ? 1 : 0.3 }),
      },
      h(V2Icon, { name: 'minus', size: 12 }),
    ),
    h(
      'button',
      {
        type: 'button',
        title: done ? '取消打卡' : value > 0 ? '再记一次' : '打卡',
        disabled: disabled,
        onClick: function onClick(event) {
          event.stopPropagation()
          if (disabled) return
          props.onToggle()
        },
        style: {
          minWidth: 48,
          height: 26,
          padding: '0 8px',
          borderRadius: V2_T.radius.sm,
          border: '1px solid ' + (done ? V2_T.status.success : value > 0 ? V2_T.status.warn : V2_T.border.strong),
          background: done ? V2_T.status.successSoft : value > 0 ? V2_T.status.warnSoft : 'transparent',
          color: done ? V2_T.status.success : V2_T.text.tertiary,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          fontSize: v2fs(11),
          fontWeight: 600,
          cursor: disabled ? 'default' : 'pointer',
          fontFamily: COLORS.fontFamily,
        },
      },
      done ? h(V2Icon, { name: 'check', size: 12, color: V2_T.status.success, strokeWidth: 2.2 }) : null,
      h('span', { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary } }, value + '/' + target),
    ),
    h(
      'button',
      {
        type: 'button',
        title: '增加一次',
        disabled: !canPlus,
        onClick: function onClick(event) {
          event.stopPropagation()
          if (canPlus) props.onStep(1)
        },
        onMouseEnter: hoverStep,
        onMouseLeave: leaveStep,
        style: Object.assign({}, stepStyle, { opacity: canPlus ? 1 : 0.3 }),
      },
      h(V2Icon, { name: 'plus', size: 12 }),
    ),
  )
}

function HabitStatCard(props) {
  return h(
    'div',
    { style: habitCardStyle({ padding: '10px 12px', minWidth: 0 }) },
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'baseline',
          gap: 3,
          color: props.tone || V2_T.text.primary,
          lineHeight: '24px',
          minWidth: 0,
        },
      },
      h(
        'span',
        {
          style: {
            fontSize: v2fs(20),
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          },
        },
        String(props.value),
      ),
      props.unit ? h('span', { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary } }, props.unit) : null,
    ),
    h('div', { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary, marginTop: 2, whiteSpace: 'nowrap' } }, props.label),
    props.hint
      ? h(
          'div',
          { style: { fontSize: v2fs(10), color: V2_T.text.tertiary, opacity: 0.85, marginTop: 1, whiteSpace: 'nowrap' } },
          props.hint,
        )
      : null,
  )
}

function HabitWeekBar(props) {
  const dates = Array.isArray(props.dates) ? props.dates : []
  const [hover, setHover] = useState(null)
  const summaries = props.summaries || {}
  return h(
    'div',
    { style: { display: 'flex', gap: 6 } },
    dates.map(function renderDay(dateKey) {
      const summary = summaries[dateKey] || { planned: 0, doneUnits: 0 }
      const planned = Number(summary.planned) || 0
      const doneUnits = Number(summary.doneUnits) || 0
      const ratio = planned > 0 ? Math.min(1, doneUnits / planned) : 0
      const isToday = dateKey === props.today
      const selected = dateKey === props.selected
      const hovered = hover === dateKey
      const highlighted = isToday || selected
      const ringColor =
        planned > 0
          ? ratio >= 1
            ? V2_T.status.success
            : ratio > 0
              ? V2_T.status.warn
              : V2_T.border.subtle
          : V2_T.text.tertiary
      return h(
        'button',
        {
          key: dateKey,
          type: 'button',
          title: dateKey + ' · 计划 ' + planned + ' 项 · 完成 ' + doneUnits + ' 项',
          onClick: function onClick() {
            props.onSelect(dateKey)
          },
          onMouseEnter: function onEnter() {
            setHover(dateKey)
          },
          onMouseLeave: function onLeave() {
            setHover(null)
          },
          style: v2CardStyle({
            flex: '1 1 0',
            maxWidth: 96,
            minWidth: 0,
            minHeight: 64,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            padding: '6px 4px',
            textAlign: 'center',
            boxSizing: 'border-box',
            cursor: 'pointer',
            color: 'inherit',
            fontFamily: COLORS.fontFamily,
            border: '1px solid ' + (highlighted ? V2_T.accent.line : hovered ? V2_T.border.strong : V2_T.border.subtle),
            background: highlighted ? V2_T.accent.soft : hovered ? V2_T.surface.panel2 : V2_T.surface.panel,
          }),
        },
        h(
          'span',
          { style: { fontSize: v2fs(V2_T.font.caption), lineHeight: '14px', color: isToday ? V2_T.accent.base : V2_T.text.tertiary } },
          HABIT_WEEKDAY_LABELS[habitWeekdayCodeOf(dateKey)] || '',
        ),
        h(
          'span',
          {
            style: {
              fontSize: v2fs(15),
              fontWeight: 600,
              lineHeight: '18px',
              color: isToday ? V2_T.accent.base : V2_T.text.primary,
            },
          },
          String(Number(String(dateKey).slice(8, 10))),
        ),
        h(
          'span',
          {
            style: {
              width: 18,
              height: 18,
              borderRadius: '50%',
              boxSizing: 'border-box',
              display: 'grid',
              placeItems: 'center',
              background:
                planned > 0
                  ? 'conic-gradient(' + ringColor + ' ' + Math.round(ratio * 100) + '%, ' + V2_T.border.subtle + ' 0)'
                  : 'transparent',
              border: planned > 0 ? 'none' : '1.5px solid ' + V2_T.border.subtle,
              opacity: planned > 0 ? 1 : 0.72,
            },
          },
          h('span', { style: { width: 12, height: 12, borderRadius: '50%', background: V2_T.surface.panel } }),
        ),
      )
    }),
  )
}

function HabitMenuItem(props) {
  const [hover, setHover] = useState(false)
  return h(
    'button',
    {
      type: 'button',
      onClick: function onClick() {
        props.onSelect()
      },
      onMouseEnter: function onEnter() {
        setHover(true)
      },
      onMouseLeave: function onLeave() {
        setHover(false)
      },
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        border: 'none',
        background: hover ? V2_T.surface.panel3 : 'transparent',
        color: props.danger ? V2_T.status.danger : V2_T.text.primary,
        fontFamily: COLORS.fontFamily,
        fontSize: v2fs(V2_T.font.meta),
        padding: '7px 10px',
        borderRadius: V2_T.radius.sm,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
    },
    props.icon ? h(V2Icon, { name: props.icon, size: 13, color: props.danger ? V2_T.status.danger : V2_T.text.secondary }) : null,
    h('span', null, props.label || ''),
  )
}

function HabitMenuLayer(props) {
  const menu = props.menu
  if (!menu) return null
  const width = 184
  const itemCount = Array.isArray(menu.items) ? menu.items.length : 0
  const height = itemCount * 32 + 8
  const left = Math.max(8, Math.min(Number(menu.x) || 0, window.innerWidth - width - 12))
  const top = Math.max(8, Math.min(Number(menu.y) || 0, window.innerHeight - height - 12))
  return h(
    'div',
    {
      onMouseDown: function onBackdrop() {
        props.onClose()
      },
      style: { position: 'fixed', inset: 0, zIndex: 45 },
    },
    h(
      'div',
      {
        onMouseDown: function stop(event) {
          event.stopPropagation()
        },
        style: {
          position: 'absolute',
          left: left,
          top: top,
          width: width,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          background: V2_T.surface.panel2,
          border: '1px solid ' + V2_T.border.subtle,
          borderRadius: V2_T.radius.md,
          padding: 4,
          boxShadow: V2_T.shadow.raised,
        },
      },
      menu.items.map(function renderItem(item, index) {
        return h(HabitMenuItem, {
          key: index,
          label: item.label,
          icon: item.icon,
          danger: item.danger === true,
          onSelect: function onSelect() {
            props.onClose()
            try {
              item.onClick()
            } catch (error) {
              props.onError(error)
            }
          },
        })
      }),
    ),
  )
}

/* ── 弹窗骨架 ── */

function habitModalOverlay(children, ariaLabel, onClose, panelExtra) {
  return h(
    'div',
    {
      role: 'presentation',
      onMouseDown: function onBackdrop(event) {
        if (event.target === event.currentTarget) onClose()
      },
      style: {
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: V2_T.surface.overlay,
        padding: 20,
      },
    },
    h(
      'div',
      {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': ariaLabel,
        style: Object.assign(
          {
            width: 'min(520px, calc(100vw - 40px))',
            maxHeight: 'calc(100vh - 80px)',
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
            background: V2_T.surface.panel,
            border: '1px solid ' + V2_T.border.subtle,
            borderRadius: V2_T.radius.xl,
            boxShadow: V2_T.shadow.pop,
            boxSizing: 'border-box',
            padding: 16,
          },
          panelExtra || {},
        ),
      },
      children,
    ),
  )
}

function habitModalHeader(title, onClose) {
  return h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '2px 0 12px',
        borderBottom: '1px solid ' + V2_T.border.subtle,
        flex: '0 0 auto',
      },
    },
    h('div', { style: { flex: '1 1 auto', fontSize: v2fs(V2_T.font.title), fontWeight: 600, color: V2_T.text.primary, lineHeight: '20px' } }, title),
    h(
      'button',
      {
        type: 'button',
        title: '关闭',
        'aria-label': '关闭',
        onClick: onClose,
        style: habitIconButtonStyle({ width: 28, height: 28, minWidth: 28 }),
      },
      h(V2Icon, { name: 'close', size: 14 }),
    ),
  )
}

function habitModalFooter(children) {
  return h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 0 0',
        borderTop: '1px solid ' + V2_T.border.subtle,
        flex: '0 0 auto',
      },
    },
    children,
  )
}

/* ── 编辑习惯弹窗 ── */

function HabitEditorModal(props) {
  const form = props.form || {}
  const saving = props.saving === true
  const mode = props.mode === 'edit' ? 'edit' : 'create'
  const kind = form.frequencyKind || 'daily'
  const error = props.error || ''
  const focusRing = v2FocusRing()
  function focusField(event) {
    event.currentTarget.style.boxShadow = focusRing.boxShadow
    event.currentTarget.style.borderColor = V2_T.accent.line
  }
  function blurField(event) {
    event.currentTarget.style.boxShadow = 'none'
    event.currentTarget.style.borderColor = V2_T.border.subtle
  }

  function field(label, node, hint) {
    return h(
      'div',
      { style: habitFieldStyle() },
      h('div', { style: habitLabelStyle() }, label),
      node,
      hint
        ? h('div', { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary, lineHeight: '16px' } }, hint)
        : null,
    )
  }

  const weekdayChips = h(
    'div',
    { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
    HABIT_WEEKDAY_CODES.map(function renderChip(code) {
      const active = (form.weekDays || []).indexOf(code) >= 0
      return h(
        'button',
        {
          key: code,
          type: 'button',
          onClick: function onClick() {
            const source = form.weekDays || []
            const next = active
              ? source.filter(function keep(item) {
                  return item !== code
                })
              : source.concat([code])
            props.onChange({ weekDays: next })
          },
          style: Object.assign(habitSegmentStyle(active), { width: 32, padding: 0, fontSize: v2fs(12) }),
        },
        HABIT_WEEKDAY_LABELS[code],
      )
    }),
  )

  const frequencyKinds = h(
    'div',
    { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
    HABIT_FREQUENCY_KINDS.map(function renderKind(item) {
      const active = kind === item.id
      return h(
        'button',
        {
          key: item.id,
          type: 'button',
          onClick: function onClick() {
            props.onChange({ frequencyKind: item.id })
          },
          style: habitSegmentStyle(active),
        },
        item.label,
      )
    }),
  )

  let frequencyDetail = null
  if (kind === 'daily') {
    frequencyDetail = field(
      '间隔：每 N 天一次',
      h('input', {
        type: 'number',
        min: 1,
        max: 365,
        value: form.dailyInterval === undefined ? 1 : form.dailyInterval,
        onChange: function onChange(event) {
          props.onChange({ dailyInterval: event.target.value })
        },
        onFocus: focusField,
        onBlur: blurField,
        style: habitInputStyle(),
      }),
      '填 1 就是每天；填 2 表示隔天一次',
    )
  } else if (kind === 'weekly_days') {
    frequencyDetail = field('选择星期（不选=每天）', weekdayChips)
  } else if (kind === 'weekly_count') {
    frequencyDetail = field(
      '每周目标次数',
      h('input', {
        type: 'number',
        min: 1,
        max: 7,
        value: form.weeklyCount === undefined ? 3 : form.weeklyCount,
        onChange: function onChange(event) {
          props.onChange({ weeklyCount: event.target.value })
        },
        onFocus: focusField,
        onBlur: blurField,
        style: habitInputStyle({ width: 96 }),
      }),
      '按周统计完成率与连续周，不要求固定星期',
    )
  } else {
    frequencyDetail = field(
      '间隔天数',
      h('input', {
        type: 'number',
        min: 1,
        max: 365,
        value: form.intervalDays === undefined ? 2 : form.intervalDays,
        onChange: function onChange(event) {
          props.onChange({ intervalDays: event.target.value })
        },
        onFocus: focusField,
        onBlur: blurField,
        style: habitInputStyle({ width: 96 }),
      }),
      '从开始日期起每 N 天安排一次',
    )
  }

  return habitModalOverlay(
    [
      habitModalHeader(mode === 'create' ? '新建习惯' : '编辑习惯', props.onClose),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 0 0' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
          h(HabitIconBadge, { habit: { id: form.name, name: form.name }, size: 44 }),
          h(
            'div',
            { style: { flex: '1 1 auto', minWidth: 0 } },
            field(
              '名称',
              h('input', {
                autoFocus: true,
                value: form.name || '',
                placeholder: '例如：晨跑 30 分钟',
                onChange: function onChange(event) {
                  props.onChange({ name: event.target.value })
                },
                onFocus: focusField,
                onBlur: blurField,
                style: habitInputStyle(),
              }),
            ),
          ),
        ),
        field(
          '描述（可选）',
          h('textarea', {
            value: form.description || '',
            rows: 2,
            placeholder: '为什么想坚持这个习惯？',
            onChange: function onChange(event) {
              props.onChange({ description: event.target.value })
            },
            onFocus: focusField,
            onBlur: blurField,
            style: habitTextareaStyle(),
          }),
        ),
        field('频率', frequencyKinds),
        frequencyDetail,
        field(
          '量化目标（可选）',
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('input', {
              type: 'number',
              min: 1,
              max: 366,
              value: form.targetValue === undefined ? 1 : form.targetValue,
              onChange: function onChange(event) {
                props.onChange({ targetValue: event.target.value })
              },
              onFocus: focusField,
              onBlur: blurField,
              style: habitInputStyle({ width: 96 }),
            }),
            h('input', {
              value: form.targetUnit || '',
              placeholder: '次',
              onChange: function onChange(event) {
                props.onChange({ targetUnit: event.target.value })
              },
              onFocus: focusField,
              onBlur: blurField,
              style: habitInputStyle({ width: 90 }),
            }),
          ),
          '大于 1 时打卡按次数累计（例如每天 8 杯水）',
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 10, alignItems: 'flex-start' } },
          h(
            'div',
            { style: { flex: '1 1 0', minWidth: 0 } },
            field(
              '开始日期',
              h('input', {
                type: 'date',
                value: form.startDate || '',
                onChange: function onChange(event) {
                  props.onChange({ startDate: event.target.value })
                },
                onFocus: focusField,
                onBlur: blurField,
                style: habitInputStyle(),
              }),
            ),
          ),
          h(
            'div',
            { style: { flex: '1 1 0', minWidth: 0 } },
            field(
              '提醒时间（可选）',
              h('input', {
                type: 'time',
                value: form.timeHint || '',
                onChange: function onChange(event) {
                  props.onChange({ timeHint: event.target.value })
                },
                onFocus: focusField,
                onBlur: blurField,
                style: habitInputStyle(),
              }),
            ),
          ),
        ),
        h(
          'div',
          {
            style: {
              fontSize: v2fs(V2_T.font.caption),
              lineHeight: '17px',
              color: V2_T.text.tertiary,
              background: V2_T.surface.input,
              border: '1px solid ' + V2_T.border.subtle,
              borderRadius: V2_T.radius.sm,
              padding: '8px 10px',
            },
          },
          '修改频率只影响之后的计划，不会删除历史打卡记录。',
        ),
        error
          ? h('div', { style: { fontSize: v2fs(V2_T.font.meta), color: V2_T.status.danger, lineHeight: '18px' } }, error)
          : null,
      ),
      habitModalFooter([
        h('div', { key: 'spacer', style: { flex: '1 1 auto' } }),
        h(
          'button',
          {
            key: 'cancel',
            type: 'button',
            disabled: saving,
            onClick: props.onClose,
            style: v2BtnStyle('ghost', { height: 30, padding: '0 14px', borderRadius: V2_T.radius.sm, fontSize: v2fs(12) }),
          },
          '取消',
        ),
        h(
          'button',
          {
            key: 'save',
            type: 'button',
            disabled: saving,
            onClick: props.onSave,
            style: v2BtnStyle('primary', { height: 30, padding: '0 14px', borderRadius: V2_T.radius.sm, fontSize: v2fs(12) }),
          },
          saving ? '保存中…' : '保存',
        ),
      ]),
    ],
    mode === 'create' ? '新建习惯' : '编辑习惯',
    props.onClose,
    { width: 'min(420px, calc(100vw - 40px))' },
  )
}

/* ── 打卡日志弹窗（日志 = checkin.note，独立于打卡状态） ── */

function HabitLogModal(props) {
  const log = props.log || {}
  const saving = log.saving === true
  const error = log.error || ''
  const note = String(log.note || '')
  const focusRing = v2FocusRing()
  function focusField(event) {
    event.currentTarget.style.boxShadow = focusRing.boxShadow
    event.currentTarget.style.borderColor = V2_T.accent.line
  }
  function blurField(event) {
    event.currentTarget.style.boxShadow = 'none'
    event.currentTarget.style.borderColor = V2_T.border.subtle
  }
  return habitModalOverlay(
    [
      habitModalHeader('打卡日志', props.onClose),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 0 0' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('div', { style: { fontSize: v2fs(13), fontWeight: 600, color: V2_T.text.primary } }, habitFormatDate(log.date)),
          log.status ? h('span', { style: habitChipStyle(habitStatusTone(log.status)) }, habitStatusLabel(log.status)) : null,
          h('div', { style: { flex: '1 1 auto' } }),
          h(
            'span',
            { style: { fontSize: v2fs(V2_T.font.caption), color: log.hasCheckin ? V2_T.text.tertiary : V2_T.status.danger } },
            log.hasCheckin ? '保存日志不会改变打卡状态' : '该日期还没有打卡记录',
          ),
        ),
        h('textarea', {
          autoFocus: true,
          value: note,
          maxLength: HABIT_NOTE_MAX,
          placeholder: '记录今天的感受、数据或备注…',
          onChange: function onChange(event) {
            props.onChange({ note: event.target.value })
          },
          onFocus: focusField,
          onBlur: blurField,
          style: habitTextareaStyle(),
        }),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary } }, String(note.length) + ' / ' + HABIT_NOTE_MAX),
          log.hasCheckin
            ? null
            : h('span', { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.status.danger } }, '请先在该日期打卡'),
        ),
        error ? h('div', { style: { fontSize: v2fs(V2_T.font.meta), color: V2_T.status.danger, lineHeight: '18px' } }, error) : null,
      ),
      habitModalFooter([
        log.existingNote
          ? h(
              'button',
              {
                key: 'delete',
                type: 'button',
                disabled: saving,
                onClick: props.onDelete,
                style: v2BtnStyle('danger', { height: 30, padding: '0 14px', borderRadius: V2_T.radius.sm, fontSize: v2fs(12) }),
              },
              '删除日志',
            )
          : null,
        h('div', { key: 'spacer', style: { flex: '1 1 auto' } }),
        h(
          'button',
          {
            key: 'cancel',
            type: 'button',
            disabled: saving,
            onClick: props.onClose,
            style: v2BtnStyle('ghost', { height: 30, padding: '0 14px', borderRadius: V2_T.radius.sm, fontSize: v2fs(12) }),
          },
          '取消',
        ),
        h(
          'button',
          {
            key: 'save',
            type: 'button',
            disabled: saving,
            onClick: props.onSave,
            style: v2BtnStyle('primary', { height: 30, padding: '0 14px', borderRadius: V2_T.radius.sm, fontSize: v2fs(12) }),
          },
          saving ? '保存中…' : '保存',
        ),
      ]),
    ],
    '打卡日志',
    props.onClose,
  )
}

/* ── 二次确认弹窗 ── */

function HabitConfirmModal(props) {
  const dialog = props.dialog || {}
  return habitModalOverlay(
    [
      habitModalHeader(dialog.title || '确认操作', props.onClose),
      h(
        'div',
        { style: { padding: '14px 0', fontSize: v2fs(13), lineHeight: '20px', color: V2_T.text.secondary } },
        dialog.body || '',
      ),
      habitModalFooter([
        h('div', { key: 'spacer', style: { flex: '1 1 auto' } }),
        h(
          'button',
          {
            key: 'cancel',
            type: 'button',
            onClick: props.onClose,
            style: v2BtnStyle('ghost', { height: 30, padding: '0 14px', borderRadius: V2_T.radius.sm, fontSize: v2fs(12) }),
          },
          '取消',
        ),
        h(
          'button',
          {
            key: 'ok',
            type: 'button',
            onClick: props.onConfirm,
            style: Object.assign(
              v2BtnStyle('primary', {
                height: 30,
                padding: '0 14px',
                borderRadius: V2_T.radius.sm,
                fontSize: v2fs(12),
                background: dialog.danger ? V2_T.status.dangerSoft : V2_T.accent.base,
                borderColor: dialog.danger ? V2_T.status.danger : V2_T.accent.base,
              }),
              dialog.danger ? { color: V2_T.status.danger } : {},
            ),
          },
          dialog.confirmLabel || '确认',
        ),
      ]),
    ],
    dialog.title || '确认操作',
    props.onClose,
  )
}

/* ── 列表行 ── */

function HabitRowV2(props) {
  const [hover, setHover] = useState(false)
  const habit = props.habit
  if (!habit) return null
  const checkin = props.checkin || null
  const statsItem = props.statsItem || null
  const status = checkin ? checkin.status : ''
  const quantified = habitIsQuantified(habit)
  const target = habitTargetValue(habit)
  const value = habitCheckinValue(checkin)
  const metaParts = [habitFrequencyText(habit)]
  const streakText = habitStreakText(statsItem)
  const streakValue = statsItem && statsItem.streak ? Number(statsItem.streak.value) || 0 : 0
  if (statsItem && statsItem.period && Number(statsItem.period.target) > 0) {
    metaParts.push('本周 ' + (Number(statsItem.period.achieved) || 0) + '/' + Number(statsItem.period.target))
  }
  if (quantified) metaParts.push('目标 ' + target + ' ' + habitTargetUnit(habit))
  const disabled = props.disabled === true
  const busy = props.busy === true
  const title = props.paused ? '习惯已暂停' : disabled ? props.disabledHint || '当前日期不可打卡' : status === 'done' ? '取消打卡' : '打卡'
  return h(
    'div',
    {
      role: 'button',
      tabIndex: 0,
      onClick: function onClick() {
        props.onSelect()
      },
      onKeyDown: function onKeyDown(event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onSelect()
        }
      },
      onMouseEnter: function onEnter() {
        setHover(true)
      },
      onMouseLeave: function onLeave() {
        setHover(false)
      },
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        height: 52,
        padding: '0 12px',
        boxSizing: 'border-box',
        borderRadius: V2_T.radius.md,
        cursor: 'pointer',
        background: props.selected ? V2_T.accent.soft : hover ? V2_T.surface.panel2 : 'transparent',
        boxShadow: props.selected ? 'inset 2px 0 0 ' + V2_T.accent.base : 'none',
      },
    },
    h(HabitIconBadge, { habit: habit, size: 30, active: props.selected === true }),
    h(
      'div',
      { style: { flex: '1 1 auto', minWidth: 0 } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 } },
        h(
          'span',
          {
            style: {
              fontSize: v2fs(13.5),
              fontWeight: 600,
              color: V2_T.text.primary,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              lineHeight: '18px',
            },
          },
          habit.name,
        ),
        props.paused ? h('span', { style: habitChipStyle('faint', false) }, '已暂停') : null,
        status === 'skipped' ? h('span', { style: habitChipStyle('faint') }, '跳过') : null,
        status === 'not_done' ? h('span', { style: habitChipStyle('danger') }, '未完成') : null,
      ),
      h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 2,
            minHeight: 16,
            minWidth: 0,
          },
        },
        h(
          'span',
          {
            style: {
              fontSize: v2fs(V2_T.font.caption),
              color: V2_T.text.tertiary,
              lineHeight: '15px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
            },
          },
          metaParts.join(' · '),
        ),
        streakText
          ? h(
              'span',
              { style: Object.assign(habitChipStyle(streakValue > 0 ? 'success' : 'faint'), { flex: '0 0 auto' }) },
              streakText,
            )
          : null,
      ),
    ),
    h(
      'button',
      {
        type: 'button',
        title: '更多操作',
        onClick: function onClick(event) {
          event.stopPropagation()
          props.onMenu(event)
        },
        style: habitIconButtonStyle({ width: 22, height: 22, minWidth: 22, opacity: hover || props.selected ? 1 : 0.45 }),
      },
      h(V2Icon, { name: 'more', size: 13 }),
    ),
    quantified
      ? h(HabitStepper, {
          target: target,
          value: value,
          status: status,
          disabled: disabled,
          busy: busy,
          onToggle: props.onToggle,
          onStep: props.onStep,
        })
      : h(HabitCheckButton, {
          status: status,
          value: value,
          disabled: disabled,
          busy: busy,
          title: title,
          onToggle: props.onToggle,
        }),
  )
}

/* ── 月历 ── */

function HabitMonthGrid(props) {
  const dates = Array.isArray(props.dates) && props.dates.length ? props.dates : habitMonthDates(props.monthKey)
  if (!dates.length) return null
  const weekStart = props.weekStart === 'sunday' ? 'sunday' : 'monday'
  const offsetRaw = habitWeekdayIndex(dates[0])
  const offset = weekStart === 'sunday' ? (offsetRaw + 1) % 7 : offsetRaw
  const labels = weekStart === 'sunday' ? ['日', '一', '二', '三', '四', '五', '六'] : ['一', '二', '三', '四', '五', '六', '日']
  const cellMap = {}
  const serverCells = Array.isArray(props.cells) ? props.cells : []
  serverCells.forEach(function each(cell) {
    if (cell && cell.date) cellMap[cell.date] = cell
  })
  const checkinMap = habitCheckinMap(props.checkins)
  const habit = props.habit || null
  const today = props.today
  const blanks = []
  for (let index = 0; index < offset; index += 1) blanks.push(h('span', { key: 'blank-' + index }))
  const cells = dates.map(function renderCell(dateKey) {
    const serverCell = cellMap[dateKey]
    const record = checkinMap[dateKey]
    let status = serverCell ? serverCell.status : null
    if (!status && record) status = record.status
    const plan = habit ? habitPlanDay(habit, dateKey) : false
    const paused = habit ? habitPausedOn(habit, dateKey) : false
    const future = dateKey > today
    const meta = habitMonthCellMeta(status, paused, future, plan)
    const isToday = dateKey === today
    const selected = dateKey === props.selectedDate
    return h(
      'button',
      {
        key: dateKey,
        type: 'button',
        title: dateKey + ' · ' + meta.title,
        onClick: function onClick() {
          props.onSelectDate(dateKey)
        },
        style: {
          height: 24,
          minWidth: 0,
          padding: 0,
          borderRadius: 6,
          border: meta.border,
          background: selected ? V2_T.accent.soft : meta.background,
          color: meta.color,
          fontSize: v2fs(V2_T.font.caption),
          fontWeight: isToday ? 600 : 400,
          opacity: future ? 0.55 : 1,
          cursor: 'pointer',
          fontFamily: COLORS.fontFamily,
          boxShadow: isToday ? 'inset 0 0 0 1px ' + V2_T.accent.base : 'none',
        },
      },
      String(Number(String(dateKey).slice(8, 10))),
    )
  })
  return h(
    'div',
    null,
    h(
      'div',
      { style: { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4, marginBottom: 4 } },
      labels.map(function renderLabel(label, index) {
        return h(
          'span',
          { key: index, style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary, textAlign: 'center', lineHeight: '16px' } },
          label,
        )
      }),
    ),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 } }, blanks.concat(cells)),
  )
}

/* ── 习惯 Tab 主体 ── */

function HabitTabV2(props) {
  const runtime = props.runtime
  const narrow = props.narrow === true
  const [listWidth, setListWidth] = useState(function initialListWidth() {
    try {
      const raw = window.localStorage.getItem(HABIT_PANES_STORAGE_KEY)
      const value = raw ? JSON.parse(raw) : null
      return habitClampListWidth(value && value.listWidth)
    } catch (error) {
      return HABIT_LIST_WIDTH
    }
  })
  const listWidthRef = useRef(listWidth)
  listWidthRef.current = listWidth
  const listDragRef = useRef(null)

  useEffect(
    function persistListWidth() {
      try {
        window.localStorage.setItem(HABIT_PANES_STORAGE_KEY, JSON.stringify({ listWidth: listWidth }))
      } catch (error) {
        /* ignore */
      }
    },
    [listWidth],
  )

  function startListResize(event) {
    if (event.button !== 0) return
    event.preventDefault()
    listDragRef.current = { startX: event.clientX, startWidth: listWidthRef.current }
    function onMove(moveEvent) {
      const drag = listDragRef.current
      if (!drag) return
      setListWidth(habitClampListWidth(drag.startWidth + (moveEvent.clientX - drag.startX)))
    }
    function onUp() {
      listDragRef.current = null
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }

  const [state, setState] = useState(function initial() {
    const today = habitToday()
    const saved = habitRestoreState()
    return {
      loading: true,
      error: null,
      today: today,
      date: (saved && saved.date) || today,
      monthKey: (saved && saved.monthKey) || habitMonthKeyOf((saved && saved.date) || today),
      habits: [],
      stats: {},
      checkins: {},
      months: {},
      selectedId: (saved && saved.selectedId) || null,
      collapsed: (saved && saved.collapsed) || { plan: false, flex: false, paused: true },
      busyKey: null,
      menu: null,
      confirmDialog: null,
      editor: null,
      logEditor: null,
    }
  })
  const stateRef = useRef(state)
  stateRef.current = state
  const pendingRef = useRef({})

  useEffect(function persistHabitState() {
    try {
      window.localStorage.setItem(
        HABIT_STATE_KEY,
        JSON.stringify({
          date: state.date,
          monthKey: state.monthKey,
          selectedId: state.selectedId,
          collapsed: state.collapsed,
        }),
      )
    } catch (error) {
      /* 忽略写入失败 */
    }
  }, [state.date, state.monthKey, state.selectedId, state.collapsed])

  function update(patch) {
    setState(function merge(prev) {
      return Object.assign({}, prev, patch)
    })
  }

  function toast(kind, text, action) {
    try {
      if (runtime && typeof runtime.toast === 'function') runtime.toast(kind, text, action)
    } catch (error) {
      /* ignore */
    }
  }

  function findHabit(habitId) {
    const list = stateRef.current.habits
    for (let index = 0; index < list.length; index += 1) {
      if (list[index] && list[index].id === habitId) return list[index]
    }
    return null
  }

  /* ── 数据加载 ── */

  async function loadAll(options) {
    const silent = options && options.silent === true
    if (!silent) update({ loading: true, error: null })
    try {
      const listPayload = await apiRequest('/habits')
      const habits = listPayload && Array.isArray(listPayload.items) ? listPayload.items : []
      const today = (listPayload && listPayload.today) || habitToday()
      const statsMap = (await habitFetchStatsMap()) || stateRef.current.stats || {}
      const checkins = {}
      const visible = habits.filter(function keep(habit) {
        return habit && habit.status !== 'archived'
      })
      await Promise.all(
        visible.map(function fetchOne(habit) {
          return habitFetchCheckins(habit.id).then(function apply(items) {
            checkins[habit.id] = items || []
          })
        }),
      )
      let selectedId = stateRef.current.selectedId
      if (selectedId && !visible.some(function has(item) { return item.id === selectedId })) selectedId = null
      if (!selectedId && !narrow && visible.length > 0) selectedId = visible[0].id
      let date = stateRef.current.date || today
      if (date > today) date = today
      const monthKey = habitMonthKeyOf(date)
      const months = Object.assign({}, stateRef.current.months)
      if (!months[monthKey]) {
        const payload = await habitFetchMonth(monthKey)
        if (payload) months[monthKey] = payload
      }
      update({
        loading: false,
        error: null,
        today: today,
        date: date,
        monthKey: stateRef.current.monthKey || monthKey,
        habits: habits,
        stats: statsMap,
        checkins: checkins,
        months: months,
        selectedId: selectedId,
      })
    } catch (error) {
      update({ loading: false, error: errorText(error) })
    }
  }

  async function refreshAfterMutation(habitId, monthKeys) {
    try {
      const listPayload = await apiRequest('/habits')
      const habits = listPayload && Array.isArray(listPayload.items) ? listPayload.items : stateRef.current.habits
      const today = (listPayload && listPayload.today) || stateRef.current.today
      const statsMap = (await habitFetchStatsMap()) || stateRef.current.stats
      const checkins = Object.assign({}, stateRef.current.checkins)
      if (habitId) {
        const items = await habitFetchCheckins(habitId)
        if (items) checkins[habitId] = items
      }
      const months = Object.assign({}, stateRef.current.months)
      const dropKeys = Array.isArray(monthKeys) ? monthKeys : []
      dropKeys.forEach(function drop(key) {
        if (months[key]) delete months[key]
      })
      const needed = stateRef.current.monthKey
      if (needed && !months[needed]) {
        const payload = await habitFetchMonth(needed)
        if (payload) months[needed] = payload
      }
      update({ today: today, habits: habits, stats: statsMap, checkins: checkins, months: months })
    } catch (error) {
      toast('error', '刷新失败：' + habitErrorHint(error))
    }
  }

  useEffect(function onMount() {
    loadAll({ silent: false })
  }, [])

  useEffect(
    function ensureMonth() {
      const monthKey = state.monthKey
      if (!monthKey || state.months[monthKey]) return undefined
      let cancelled = false
      habitFetchMonth(monthKey)
        .then(function apply(payload) {
          if (cancelled || !payload) return
          const months = Object.assign({}, stateRef.current.months)
          months[monthKey] = payload
          update({ months: months })
        })
        .catch(function ignore() {
          /* ignore */
        })
      return function cleanup() {
        cancelled = true
      }
    },
    [state.monthKey, state.months],
  )

  useEffect(function bindEscape() {
    function onKeyDown(event) {
      if (event.key !== 'Escape') return
      const snapshot = stateRef.current
      if (snapshot.menu) {
        update({ menu: null })
        return
      }
      if (snapshot.confirmDialog) {
        update({ confirmDialog: null })
        return
      }
      if (snapshot.logEditor) {
        update({ logEditor: null })
        return
      }
      if (snapshot.editor) update({ editor: null })
    }
    window.addEventListener('keydown', onKeyDown)
    return function cleanup() {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  /* ── 通用派生 ── */

  function visibleHabits() {
    return state.habits.filter(function keep(habit) {
      return habit && habit.status !== 'archived'
    })
  }

  function currentHabit() {
    if (!state.selectedId) return null
    const visible = visibleHabits()
    for (let index = 0; index < visible.length; index += 1) {
      if (visible[index].id === state.selectedId) return visible[index]
    }
    return null
  }

  function dateWindowHint(dateKey) {
    const today = stateRef.current.today
    if (!dateKey) return '请选择日期'
    if (dateKey > today) return '不能为未来日期打卡'
    if (dateKey < habitAddDays(today, -HABIT_RETRO_WINDOW_DAYS)) return '超过 7 天的记录只能查看'
    return ''
  }

  function dateCheckable(dateKey) {
    return dateWindowHint(dateKey) === ''
  }

  function selectDate(dateKey) {
    if (!dateKey) return
    update({ date: dateKey, monthKey: habitMonthKeyOf(dateKey) })
  }

  function selectHabit(habitId) {
    update({ selectedId: habitId })
  }

  /* ── 打卡写入 ── */

  async function runWithBusy(key, action) {
    if (pendingRef.current[key]) return
    pendingRef.current[key] = true
    update({ busyKey: key })
    try {
      await action()
    } catch (error) {
      toast('error', '操作失败：' + habitErrorHint(error))
    } finally {
      pendingRef.current[key] = false
      update({ busyKey: null })
    }
  }

  async function submitCheckin(habit, dateKey, body) {
    const payload = Object.assign({ localDate: dateKey }, body)
    if (dateKey < stateRef.current.today) payload.retro = true
    await habitApiSend('POST', '/habits/' + encodeURIComponent(habit.id) + '/checkin', payload)
  }

  function handleToggle(habit, dateKey) {
    if (!habit || !dateKey) return
    if (habit.status === 'paused') {
      toast('error', '习惯已暂停，恢复后才能打卡')
      return
    }
    const windowHint = dateWindowHint(dateKey)
    if (windowHint) {
      toast('error', windowHint)
      return
    }
    const key = 'check|' + habit.id + '|' + dateKey
    runWithBusy(key, async function toggle() {
      const checkins = stateRef.current.checkins[habit.id] || []
      const existing = habitCheckinByDate(checkins, dateKey)
      const target = habitTargetValue(habit)
      if (existing && existing.status === 'done') {
        await habitApiSend('DELETE', '/habits/' + encodeURIComponent(habit.id) + '/checkins/' + encodeURIComponent(dateKey))
        await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
        const snapshot = {
          status: existing.status,
          value: habitCheckinValue(existing),
          note: existing.note || null,
        }
        toast('success', '已取消打卡', {
          label: '撤销',
          onClick: function undoUncheck() {
            restoreCheckin(habit.id, dateKey, snapshot)
          },
        })
        return
      }
      if (existing && existing.status === 'partial') {
        const current = habitCheckinValue(existing)
        const nextValue = current + 1
        const nextStatus = nextValue >= target ? 'done' : 'partial'
        await submitCheckin(habit, dateKey, { status: nextStatus, value: Math.min(nextValue, Math.max(target, 1)) })
        await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
        toast('success', nextStatus === 'done' ? '已达标：' + nextValue + ' / ' + target : '已记录 ' + nextValue + ' / ' + target)
        return
      }
      if (target > 1) {
        const status = 1 >= target ? 'done' : 'partial'
        await submitCheckin(habit, dateKey, { status: status, value: 1 })
        await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
        toast('success', status === 'done' ? '已打卡' : '已记录 1 / ' + target + ' ' + habitTargetUnit(habit))
        return
      }
      await submitCheckin(habit, dateKey, { status: 'done' })
      await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
      toast('success', '已打卡：' + habit.name)
    })
  }

  function handleStep(habit, dateKey, delta) {
    if (!habit || !dateKey) return
    if (habit.status === 'paused') {
      toast('error', '习惯已暂停，恢复后才能打卡')
      return
    }
    const windowHint = dateWindowHint(dateKey)
    if (windowHint) {
      toast('error', windowHint)
      return
    }
    const key = 'check|' + habit.id + '|' + dateKey
    runWithBusy(key, async function step() {
      const checkins = stateRef.current.checkins[habit.id] || []
      const existing = habitCheckinByDate(checkins, dateKey)
      const target = Math.max(1, habitTargetValue(habit))
      if (!existing) {
        if (delta < 0) return
        await submitCheckin(habit, dateKey, { status: 1 >= target ? 'done' : 'partial', value: 1 })
        await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
        toast('success', '已记录 1 / ' + target)
        return
      }
      const current = habitCheckinValue(existing)
      const nextValue = current + delta
      if (nextValue <= 0) {
        await habitApiSend('DELETE', '/habits/' + encodeURIComponent(habit.id) + '/checkins/' + encodeURIComponent(dateKey))
        await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
        toast('success', '已清空当日记录')
        return
      }
      const nextStatus = nextValue >= target ? 'done' : 'partial'
      await submitCheckin(habit, dateKey, { status: nextStatus, value: Math.min(nextValue, target) })
      await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
      toast('success', nextStatus === 'done' ? '已达标：' + target + ' / ' + target : '已记录 ' + nextValue + ' / ' + target)
    })
  }

  function restoreCheckin(habitId, dateKey, snapshot) {
    const habit = findHabit(habitId)
    if (!habit) return
    const payload = { localDate: dateKey, status: snapshot.status || 'done' }
    if (snapshot.value > 0) payload.value = snapshot.value
    if (snapshot.note) payload.note = snapshot.note
    if (dateKey < stateRef.current.today) payload.retro = true
    runWithBusy('undo|' + habitId + '|' + dateKey, async function restore() {
      await habitApiSend('POST', '/habits/' + encodeURIComponent(habitId) + '/checkin', payload)
      await refreshAfterMutation(habitId, [habitMonthKeyOf(dateKey)])
      toast('success', '已恢复打卡')
    })
  }

  function handleClearRecord(habit, dateKey) {
    const hint = dateWindowHint(dateKey)
    if (hint) {
      toast('error', hint)
      return
    }
    const checkins = stateRef.current.checkins[habit.id] || []
    const existing = habitCheckinByDate(checkins, dateKey)
    if (!existing) {
      toast('error', '该日期没有打卡记录')
      return
    }
    runWithBusy('clear|' + habit.id + '|' + dateKey, async function clearRecord() {
      await habitApiSend('DELETE', '/habits/' + encodeURIComponent(habit.id) + '/checkins/' + encodeURIComponent(dateKey))
      await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
      toast('success', '已清除当日记录', {
        label: '撤销',
        onClick: function undoClear() {
          restoreCheckin(habit.id, dateKey, {
            status: existing.status,
            value: habitCheckinValue(existing),
            note: existing.note || null,
          })
        },
      })
    })
  }

  function handleMarkStatus(habit, dateKey, status) {
    const hint = dateWindowHint(dateKey)
    if (hint) {
      toast('error', hint)
      return
    }
    if (habit.status === 'paused') {
      toast('error', '习惯已暂停，恢复后才能操作')
      return
    }
    const label = status === 'skipped' ? '已跳过本次' : '已标记未完成'
    runWithBusy('mark|' + habit.id + '|' + dateKey, async function mark() {
      await submitCheckin(habit, dateKey, { status: status })
      await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
      toast('success', label)
    })
  }

  /* ── 习惯属性写入 ── */

  function handleTogglePause(habit) {
    if (!habit) return
    const nextStatus = habit.status === 'paused' ? 'active' : 'paused'
    const label = nextStatus === 'paused' ? '已暂停：' : '已恢复：'
    runWithBusy('pause|' + habit.id, async function togglePause() {
      await habitApiSend('PATCH', '/habits/' + encodeURIComponent(habit.id), {
        patch: { status: nextStatus },
        expectedRev: habit.rev,
      })
      await loadAll({ silent: true })
      toast('success', label + habit.name)
    })
  }

  function askArchive(habit) {
    if (!habit) return
    update({
      confirmDialog: {
        title: '归档习惯',
        body: '「' + habit.name + '」归档后将不再出现在习惯列表，历史打卡记录会保留。',
        confirmLabel: '归档',
        danger: true,
        onConfirm: function onConfirm() {
          return archiveHabit(habit)
        },
      },
    })
  }

  async function archiveHabit(habit) {
    await habitApiSend('POST', '/habits/' + encodeURIComponent(habit.id) + '/archive', { expectedRev: habit.rev })
    update({ selectedId: null })
    await loadAll({ silent: true })
    toast('success', '已归档：' + habit.name)
  }

  function handleConfirm() {
    const dialog = stateRef.current.confirmDialog
    if (!dialog) return
    update({ confirmDialog: null })
    if (typeof dialog.onConfirm !== 'function') return
    Promise.resolve()
      .then(dialog.onConfirm)
      .catch(function onError(error) {
        toast('error', '操作失败：' + habitErrorHint(error))
      })
  }

  /* ── 编辑弹窗 ── */

  function createFormDefaults() {
    return {
      name: '',
      description: '',
      frequencyKind: 'daily',
      dailyInterval: 1,
      weekDays: ['MO', 'TU', 'WE', 'TH', 'FR'],
      weeklyCount: 3,
      intervalDays: 2,
      targetValue: 1,
      targetUnit: '次',
      startDate: stateRef.current.today,
      timeHint: '',
    }
  }

  function formFromHabit(habit) {
    const rule = habitFrequencyRule(habit) || {}
    const kind = rule.kind || 'daily'
    const target = habitTargetValue(habit)
    return {
      name: habit.name || '',
      description: habit.description || '',
      frequencyKind: kind,
      dailyInterval: habitClampInt(rule.interval, 1, 365, 1),
      weekDays: habitSortWeekdays(rule.days).length ? habitSortWeekdays(rule.days) : ['MO', 'TU', 'WE', 'TH', 'FR'],
      weeklyCount: habitClampInt(rule.count, 1, 7, 3),
      intervalDays: habitClampInt(rule.days, 1, 365, 2),
      targetValue: target > 1 ? target : 1,
      targetUnit: habitTargetUnit(habit),
      startDate: habit.start_date || stateRef.current.today,
      timeHint: habit.time_hint || '',
    }
  }

  function openCreateEditor() {
    update({ editor: { mode: 'create', form: createFormDefaults() } })
  }

  function openEditEditor(habit) {
    update({ editor: { mode: 'edit', habitId: habit.id, rev: habit.rev, form: formFromHabit(habit) } })
  }

  function buildHabitBody(form) {
    const kind = form.frequencyKind || 'daily'
    const frequency = { kind: kind }
    if (kind === 'daily') frequency.interval = habitClampInt(form.dailyInterval, 1, 365, 1)
    else if (kind === 'weekly_days') frequency.days = habitSortWeekdays(form.weekDays)
    else if (kind === 'weekly_count') frequency.count = habitClampInt(form.weeklyCount, 1, 7, 3)
    else frequency.days = habitClampInt(form.intervalDays, 1, 365, 2)
    const targetValue = habitClampInt(form.targetValue, 1, 366, 1)
    const targetUnit = String(form.targetUnit || '').trim() || '次'
    const description = String(form.description || '').trim()
    return {
      name: String(form.name || '').trim(),
      description: description || null,
      frequency_rule: frequency,
      period_rule: kind === 'weekly_count' ? { period: 'week', target_count: frequency.count } : null,
      target_json: targetValue > 1 ? { metric: 'count', value: targetValue, unit: targetUnit } : null,
      start_date: form.startDate || stateRef.current.today,
      time_hint: String(form.timeHint || '').trim() || null,
    }
  }

  async function saveHabitEditor() {
    const editor = stateRef.current.editor
    if (!editor) return
    const form = editor.form || {}
    if (!String(form.name || '').trim()) {
      update({ editor: Object.assign({}, editor, { error: '请填写习惯名称' }) })
      return
    }
    if (form.frequencyKind === 'weekly_days' && habitSortWeekdays(form.weekDays).length === 0) {
      update({ editor: Object.assign({}, editor, { error: '「每周固定」至少选择一天' }) })
      return
    }
    const body = buildHabitBody(form)
    update({ editor: Object.assign({}, editor, { saving: true, error: null }) })
    try {
      if (editor.mode === 'create') {
        const createBody = {}
        Object.keys(body).forEach(function keep(key) {
          if (body[key] !== null && body[key] !== undefined) createBody[key] = body[key]
        })
        await habitApiSend('POST', '/habits', createBody)
        toast('success', '已创建习惯')
      } else {
        const habit = findHabit(editor.habitId)
        await habitApiSend('PATCH', '/habits/' + encodeURIComponent(editor.habitId), {
          patch: body,
          expectedRev: editor.rev || (habit && habit.rev),
        })
        toast('success', '已保存习惯')
      }
      update({ editor: null })
      await loadAll({ silent: true })
    } catch (error) {
      update({
        editor: Object.assign({}, stateRef.current.editor || editor, {
          saving: false,
          error: habitErrorHint(error),
        }),
      })
    }
  }

  /* ── 打卡日志（checkin.note） ── */

  function openLogEditor(habit) {
    if (!habit) return
    const checkins = stateRef.current.checkins[habit.id] || []
    const candidates = [stateRef.current.date, stateRef.current.today]
    let existing = null
    let targetDate = null
    for (let index = 0; index < candidates.length; index += 1) {
      const record = habitCheckinByDate(checkins, candidates[index])
      if (record) {
        existing = record
        targetDate = candidates[index]
        break
      }
    }
    if (!existing || !targetDate) {
      toast('error', '日志依附于打卡记录：请先在当天打卡，再写日志')
      return
    }
    if (dateWindowHint(targetDate)) {
      toast('error', '超过 7 天的日志只能查看')
      return
    }
    update({
      logEditor: {
        habitId: habit.id,
        date: targetDate,
        note: existing.note || '',
        status: existing.status,
        checkinId: existing.id,
        error: null,
        saving: false,
      },
    })
  }

  function openLogEditorForDate(habit, dateKey) {
    if (!habit || !dateKey) return
    if (dateWindowHint(dateKey)) {
      toast('error', '超过 7 天的日志只能查看')
      return
    }
    const checkins = stateRef.current.checkins[habit.id] || []
    const existing = habitCheckinByDate(checkins, dateKey)
    if (!existing) {
      toast('error', '该日期没有打卡记录，无法写日志')
      return
    }
    update({
      logEditor: {
        habitId: habit.id,
        date: dateKey,
        note: existing.note || '',
        status: existing.status,
        checkinId: existing.id,
        error: null,
        saving: false,
      },
    })
  }

  async function saveLogEditor() {
    const editor = stateRef.current.logEditor
    if (!editor) return
    const habit = findHabit(editor.habitId)
    if (!habit) return
    const note = String(editor.note || '').trim()
    if (!note) {
      update({ logEditor: Object.assign({}, editor, { error: '请输入日志内容（清空请用「删除日志」）' }) })
      return
    }
    const checkins = stateRef.current.checkins[habit.id] || []
    const existing = habitCheckinByDate(checkins, editor.date)
    if (!existing) {
      update({ logEditor: Object.assign({}, editor, { error: '该日期没有打卡记录，无法保存日志' }) })
      return
    }
    update({ logEditor: Object.assign({}, editor, { saving: true, error: null }) })
    try {
      await submitCheckin(habit, editor.date, { status: existing.status, note: note.slice(0, HABIT_NOTE_MAX) })
      await refreshAfterMutation(habit.id, [habitMonthKeyOf(editor.date)])
      update({ logEditor: null })
      toast('success', '日志已保存')
    } catch (error) {
      update({
        logEditor: Object.assign({}, stateRef.current.logEditor || editor, {
          saving: false,
          error: habitErrorHint(error),
        }),
      })
    }
  }

  function deleteLog(habit, checkin) {
    if (!habit || !checkin || !checkin.note) return
    const dateKey = checkin.local_date
    if (dateWindowHint(dateKey)) {
      toast('error', '超过 7 天的日志只能查看')
      return
    }
    const snapshot = { status: checkin.status, value: habitCheckinValue(checkin), note: checkin.note }
    update({ logEditor: null })
    runWithBusy('dellog|' + habit.id + '|' + dateKey, async function deleteLogAction() {
      await habitApiSend('POST', '/habits/' + encodeURIComponent(habit.id) + '/checkin', {
        localDate: dateKey,
        status: checkin.status,
        note: '',
      })
      await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
      toast('success', '日志已删除（打卡保留）', {
        label: '撤销',
        onClick: function undoDeleteLog() {
          restoreCheckin(habit.id, dateKey, snapshot)
        },
      })
    })
  }

  /* ── 菜单 ── */

  function openMenuAt(event, items) {
    if (!event || !event.currentTarget) return
    const rect = event.currentTarget.getBoundingClientRect()
    update({ menu: { x: rect.right - 184, y: rect.bottom + 4, items: items } })
  }

  function commonMenuItems(habit) {
    return [
      { label: '编辑习惯', icon: 'edit', onClick: function editItem() { openEditEditor(habit) } },
      {
        label: habit.status === 'paused' ? '恢复习惯' : '暂停习惯',
        icon: 'clock',
        onClick: function pauseItem() { handleTogglePause(habit) },
      },
      { label: '归档习惯', icon: 'trash', danger: true, onClick: function archiveItem() { askArchive(habit) } },
    ]
  }

  function rowMenuItems(habit) {
    const dateKey = stateRef.current.date
    const checkins = stateRef.current.checkins[habit.id] || []
    const existing = habitCheckinByDate(checkins, dateKey)
    const items = []
    items.push({ label: '编辑习惯', icon: 'edit', onClick: function editItem() { openEditEditor(habit) } })
    if (habit.status !== 'paused' && dateCheckable(dateKey)) {
      items.push({ label: '标记未完成', icon: 'close', onClick: function notDoneItem() { handleMarkStatus(habit, dateKey, 'not_done') } })
      items.push({ label: '跳过本次', icon: 'done', onClick: function skipItem() { handleMarkStatus(habit, dateKey, 'skipped') } })
    }
    if (existing) {
      items.push({ label: '清除当日记录', icon: 'trash', onClick: function clearItem() { handleClearRecord(habit, dateKey) } })
    }
    items.push({
      label: habit.status === 'paused' ? '恢复习惯' : '暂停习惯',
      icon: 'clock',
      onClick: function pauseItem() { handleTogglePause(habit) },
    })
    items.push({ label: '归档习惯', icon: 'trash', danger: true, onClick: function archiveItem() { askArchive(habit) } })
    return items
  }

  function detailMenuItems(habit) {
    return [
      { label: '编辑习惯', icon: 'edit', onClick: function editItem() { openEditEditor(habit) } },
      { label: '写今日日志', icon: 'text', onClick: function logItem() { openLogEditor(habit) } },
      {
        label: habit.status === 'paused' ? '恢复习惯' : '暂停习惯',
        icon: 'clock',
        onClick: function pauseItem() { handleTogglePause(habit) },
      },
      { label: '归档习惯', icon: 'trash', danger: true, onClick: function archiveItem() { askArchive(habit) } },
    ]
  }

  /* ── 渲染：左栏 ── */

  function renderLeftHeader() {
    const visible = visibleHabits()
    const planCount = visible.filter(function isPlanned(habit) {
      return !habitPausedOn(habit, state.date) && habitPausedOn(habit, state.date) === false && habitPlanDay(habit, state.date)
    }).length
    return h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 52,
          minHeight: 52,
          padding: '0 14px',
          boxSizing: 'border-box',
          flex: '0 0 auto',
        },
      },
      h(
        'div',
        { style: { flex: '1 1 auto', minWidth: 0 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h(
            'span',
            { style: { fontSize: v2fs(20), fontWeight: 600, color: V2_T.text.primary, lineHeight: '26px', letterSpacing: '-0.01em' } },
            '习惯',
          ),
          h(
            'span',
            {
              style: {
                fontSize: v2fs(V2_T.font.caption),
                color: V2_T.text.secondary,
                background: V2_T.surface.panel2,
                borderRadius: V2_T.radius.pill,
                padding: '0 6px',
                height: 18,
                lineHeight: '18px',
                boxSizing: 'border-box',
                flex: '0 0 auto',
              },
            },
            String(visible.length),
          ),
        ),
        h(
          'div',
          {
            style: {
              fontSize: v2fs(V2_T.font.meta),
              color: V2_T.text.tertiary,
              marginTop: 1,
              lineHeight: '16px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
          },
          state.date === state.today
            ? '今天 · ' + planCount + ' 项计划'
            : '查看 ' + habitFormatDate(state.date) + ' · ' + planCount + ' 项计划',
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          title: '刷新数据',
          onClick: function onRefresh() {
            loadAll({ silent: true })
          },
          onMouseEnter: function onRefreshEnter(event) {
            event.currentTarget.style.background = V2_T.surface.panel2
          },
          onMouseLeave: function onRefreshLeave(event) {
            event.currentTarget.style.background = 'transparent'
          },
          style: habitIconButtonStyle({ width: 28, height: 28, minWidth: 28, borderRadius: V2_T.radius.sm }),
        },
        h(V2Icon, { name: 'refresh', size: 14 }),
      ),
      h(
        'button',
        {
          type: 'button',
          title: '新建习惯',
          onClick: openCreateEditor,
          onMouseEnter: function onNewEnter(event) {
            event.currentTarget.style.filter = 'brightness(1.08)'
          },
          onMouseLeave: function onNewLeave(event) {
            event.currentTarget.style.filter = 'none'
          },
          style: v2BtnStyle('primary', {
            height: 32,
            padding: '0 12px',
            borderRadius: V2_T.radius.pill,
            fontSize: v2fs(V2_T.font.meta),
            fontWeight: 600,
            gap: 4,
            flex: '0 0 auto',
          }),
        },
        h(V2Icon, { name: 'plus', size: 13 }),
        '新建',
      ),
    )
  }

  function renderWeekBar() {
    const dates = []
    for (let offset = 6; offset >= 0; offset -= 1) dates.push(habitAddDays(state.today, -offset))
    const visible = visibleHabits()
    const summaries = {}
    dates.forEach(function each(dateKey) {
      summaries[dateKey] = habitDateSummary(visible, state.checkins, dateKey)
    })
    return h(HabitWeekBar, {
      dates: dates,
      today: state.today,
      selected: state.date,
      summaries: summaries,
      onSelect: selectDate,
    })
  }

  function renderDateJump() {
    const dates = []
    for (let offset = 6; offset >= 0; offset -= 1) dates.push(habitAddDays(state.today, -offset))
    if (dates.indexOf(state.date) >= 0) return null
    return h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px 8px' } },
      h(
        'span',
        { style: { fontSize: v2fs(V2_T.font.meta), color: V2_T.text.tertiary, flex: '1 1 auto', minWidth: 0, lineHeight: '18px' } },
        '正在查看 ' + habitFormatDate(state.date),
      ),
      h(
        'button',
        {
          type: 'button',
          onClick: function onToday() {
            selectDate(state.today)
          },
          style: v2BtnStyle('soft', {
            fontSize: v2fs(V2_T.font.caption),
            height: 26,
            padding: '0 10px',
            borderRadius: V2_T.radius.sm,
            background: V2_T.surface.panel2,
            color: V2_T.text.primary,
          }),
        },
        '回到今天',
      ),
    )
  }

  function renderHabitRow(habit) {
    const checkins = state.checkins[habit.id] || []
    const checkin = habitCheckinByDate(checkins, state.date)
    const paused = habitPausedOn(habit, state.date) || habit.status === 'paused'
    const hint = dateWindowHint(state.date)
    const key = 'check|' + habit.id + '|' + state.date
    return h(HabitRowV2, {
      key: habit.id,
      habit: habit,
      checkin: checkin,
      statsItem: state.stats[habit.id] || null,
      selected: state.selectedId === habit.id,
      paused: paused,
      disabled: paused || hint !== '',
      disabledHint: paused ? '习惯已暂停' : hint,
      busy: state.busyKey === key,
      onSelect: function onSelect() {
        selectHabit(habit.id)
      },
      onToggle: function onToggle() {
        handleToggle(habit, stateRef.current.date)
      },
      onStep: function onStep(delta) {
        handleStep(habit, stateRef.current.date, delta)
      },
      onMenu: function onMenu(event) {
        openMenuAt(event, rowMenuItems(habit))
      },
    })
  }

  function renderHabitSection(title, key, list, emptyHint) {
    const collapsed = state.collapsed[key] === true
    if (!list.length && !emptyHint) return null
    return h(
      'div',
      { style: { marginTop: 12 } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 4, padding: '4px 12px 4px 6px' } },
        h(
          'button',
          {
            type: 'button',
            onClick: function onToggle() {
              const next = Object.assign({}, state.collapsed)
              next[key] = !collapsed
              update({ collapsed: next })
            },
            style: habitIconButtonStyle({ width: 20, height: 20, minWidth: 20 }),
          },
          h(V2Icon, { name: collapsed ? 'chev' : 'chevD', size: 12 }),
        ),
        h(
          'span',
          {
            style: {
              fontSize: v2fs(V2_T.font.caption),
              fontWeight: 600,
              color: V2_T.text.tertiary,
              letterSpacing: '0.02em',
              lineHeight: '16px',
            },
          },
          title,
        ),
        h(
          'span',
          { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary, marginLeft: 'auto', lineHeight: '16px' } },
          String(list.length),
        ),
      ),
      collapsed
        ? null
        : list.length
          ? list.map(function renderRow(habit) {
              return renderHabitRow(habit)
            })
          : h('div', { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary, padding: '2px 12px 8px' } }, emptyHint),
    )
  }

  function renderList() {
    const visible = visibleHabits()
    if (state.loading && visible.length === 0) {
      return h(
        'div',
        { style: { display: 'flex', justifyContent: 'center', padding: '40px 16px' } },
        h(
          'div',
          { style: v2CardStyle({ padding: 24, maxWidth: 420, width: '100%', textAlign: 'center' }) },
          h('div', { style: { fontSize: v2fs(V2_T.font.meta), color: V2_T.text.tertiary, lineHeight: '18px' } }, '加载习惯数据…'),
        ),
      )
    }
    if (state.error && visible.length === 0) {
      return h(
        'div',
        { style: { display: 'flex', justifyContent: 'center', padding: '40px 16px' } },
        h(
          'div',
          {
            style: v2CardStyle({
              padding: 24,
              maxWidth: 420,
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
              textAlign: 'center',
            }),
          },
          h('div', { style: { fontSize: v2fs(V2_T.font.meta), color: V2_T.status.danger, lineHeight: '18px' } }, state.error),
          h(
            'button',
            {
              type: 'button',
              onClick: function onRetry() {
                loadAll({ silent: false })
              },
              style: v2BtnStyle('soft', {
                height: 32,
                padding: '0 14px',
                borderRadius: V2_T.radius.sm,
                background: V2_T.surface.panel3,
                color: V2_T.text.primary,
                fontSize: v2fs(V2_T.font.meta),
              }),
            },
            '重试',
          ),
        ),
      )
    }
    if (visible.length === 0) {
      return h(
        'div',
        { style: { display: 'flex', justifyContent: 'center', padding: '40px 16px' } },
        h(
          'div',
          {
            style: v2CardStyle({
              padding: 24,
              maxWidth: 420,
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              textAlign: 'center',
            }),
          },
          h('div', { style: { fontSize: v2fs(32), lineHeight: '38px' } }, '🌱'),
          h('div', { style: { fontSize: v2fs(V2_T.font.title), fontWeight: 600, color: V2_T.text.primary, lineHeight: '22px' } }, '还没有习惯。'),
          h(
            'div',
            { style: { fontSize: v2fs(V2_T.font.meta), color: V2_T.text.tertiary, lineHeight: '18px' } },
            '从一个每天都能做到的小习惯开始吧。',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: openCreateEditor,
              style: v2BtnStyle('primary', {
                marginTop: 2,
                height: 32,
                padding: '0 14px',
                borderRadius: V2_T.radius.sm,
                fontSize: v2fs(V2_T.font.meta),
                fontWeight: 600,
              }),
            },
            h(V2Icon, { name: 'plus', size: 13 }),
            '新建习惯',
          ),
        ),
      )
    }
    const planList = []
    const flexList = []
    const pausedList = []
    visible.forEach(function split(habit) {
      if (habitPausedOn(habit, state.date) || habit.status === 'paused') {
        pausedList.push(habit)
        return
      }
      if (habitPlanDay(habit, state.date)) planList.push(habit)
      else flexList.push(habit)
    })
    const sortByName = function sortByName(left, right) {
      const leftOrder = Number(left.sort_order || 0)
      const rightOrder = Number(right.sort_order || 0)
      if (leftOrder !== rightOrder) return leftOrder - rightOrder
      return String(left.name || '').localeCompare(String(right.name || ''))
    }
    planList.sort(sortByName)
    flexList.sort(sortByName)
    pausedList.sort(sortByName)
    const showPaused = v2ReadSettings().habitShowPaused !== false
    return h(
      'div',
      { style: { padding: '0 8px 24px' } },
      state.error
        ? h('div', { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.status.danger, padding: '4px 12px', lineHeight: '16px' } }, state.error)
        : null,
      renderHabitSection('当日计划', 'plan', planList, state.date === state.today ? '今天没有计划中的习惯' : '这一天没有计划中的习惯'),
      renderHabitSection('灵活打卡', 'flex', flexList, ''),
      showPaused ? renderHabitSection('已暂停', 'paused', pausedList, '') : null,
    )
  }

  function renderLeftPane() {
    const hasDetail = !!currentHabit()
    const fullWidth = !narrow && !hasDetail
    const style = narrow || fullWidth
      ? {
          flex: '1 1 auto',
          width: 'auto',
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          background: V2_T.surface.app,
        }
      : {
          flex: '0 0 ' + listWidth + 'px',
          width: listWidth,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          background: V2_T.surface.app,
          borderRight: '1px solid ' + V2_T.border.subtle,
        }
    return h(
      'div',
      { style: style },
      renderLeftHeader(),
      h('div', { style: { padding: '2px 14px 0', flex: '0 0 auto' } }, renderWeekBar()),
      h('div', { style: { flex: '1 1 auto', overflowY: 'auto', minHeight: 0, paddingTop: 2 } }, renderDateJump(), renderList()),
    )
  }

  /* ── 渲染：右栏 ── */

  function renderPlaceholder() {
    return h(
      'div',
      {
        style: {
          flex: '1 1 auto',
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: V2_T.surface.shell,
          color: V2_T.text.tertiary,
          fontSize: v2fs(V2_T.font.meta),
          lineHeight: '20px',
          textAlign: 'center',
          padding: 24,
        },
      },
      h('div', null, '从左侧选择一个习惯', h('br'), '查看本月统计、打卡日历与日志'),
    )
  }

  function renderLegend() {
    const items = [
      { key: 'done', label: '已完成', meta: habitMonthCellMeta('done', false, false, false) },
      { key: 'partial', label: '部分', meta: habitMonthCellMeta('partial', false, false, false) },
      { key: 'missed', label: '未完成', meta: habitMonthCellMeta('not_done', false, false, false) },
      { key: 'unknown', label: '计划未记录', meta: habitMonthCellMeta('unknown', false, false, true) },
      { key: 'future', label: '未来计划', meta: habitMonthCellMeta(null, false, true, true) },
    ]
    return h(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } },
      items.map(function renderItem(item) {
        return h(
          'span',
          {
            key: item.key,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: v2fs(V2_T.font.caption),
              color: V2_T.text.tertiary,
              lineHeight: '16px',
            },
          },
          h('span', {
            style: {
              width: 10,
              height: 10,
              borderRadius: 3,
              border: item.meta.border,
              background: item.meta.background,
              boxSizing: 'border-box',
              flex: '0 0 auto',
            },
          }),
          item.label,
        )
      }),
    )
  }

  function renderInfoRow(label, value) {
    return h(
      'div',
      { key: label, style: { display: 'flex', gap: 8, fontSize: v2fs(V2_T.font.meta), lineHeight: '18px', minWidth: 0 } },
      h('span', { style: { flex: '0 0 64px', color: V2_T.text.tertiary } }, label),
      h('span', { style: { flex: '1 1 auto', minWidth: 0, color: V2_T.text.secondary, wordBreak: 'break-word' } }, value),
    )
  }

  function renderDetailPane() {
    const habit = currentHabit()
    if (!habit) return null
    const today = state.today
    const checkins = state.checkins[habit.id] || []
    const statsItem = state.stats[habit.id] || null
    const currentMonthKey = habitMonthKeyOf(today)
    const currentMonthData = state.months[currentMonthKey] || null
    const serverWeekStart = currentMonthData && currentMonthData.week_start === 'sunday' ? 'sunday' : 'monday'
    const monthStats = habitMonthStats(habit, currentMonthKey, checkins, today, serverWeekStart)
    const streak = statsItem && statsItem.streak ? statsItem.streak : null
    const streakValue = streak ? Number(streak.value) || 0 : 0
    const streakUnitLabel = habitStreakUnitLabel(streak && streak.unit)
    const longest = streak ? Number(streak.longest) || 0 : 0
    const detailMonthData = state.months[state.monthKey] || null
    const detailWeekStart = detailMonthData && detailMonthData.week_start === 'sunday' ? 'sunday' : 'monday'
    const detailMonthRow =
      detailMonthData && Array.isArray(detailMonthData.rows)
        ? detailMonthData.rows.filter(function findRow(row) {
            return row && row.habitId === habit.id
          })[0] || null
        : null
    const logs = checkins
      .filter(function withNote(item) {
        return item && item.note
      })
      .sort(function desc(left, right) {
        return left.local_date < right.local_date ? 1 : left.local_date > right.local_date ? -1 : 0
      })
    const selectedRecord = habitCheckinByDate(checkins, state.date)
    const windowHint = dateWindowHint(state.date)
    const pausedOnDate = habitPausedOn(habit, state.date)
    const disabled = habit.status === 'paused' || pausedOnDate || windowHint !== ''
    const busy = state.busyKey === 'check|' + habit.id + '|' + state.date
    const ratioText = monthStats.ratio === null ? '—' : Math.round(monthStats.ratio * 100) + '%'
    const ratioTone =
      monthStats.ratio === null
        ? V2_T.text.tertiary
        : monthStats.ratio >= 0.8
          ? V2_T.status.success
          : monthStats.ratio > 0
            ? V2_T.status.warn
            : V2_T.status.danger
    const subtitleParts = [habitFrequencyText(habit)]
    if (habit.start_date) subtitleParts.push('开始于 ' + habitFormatDate(habit.start_date))
    if (habit.time_hint) subtitleParts.push('提醒 ' + habit.time_hint)
    if (habit.status === 'paused') subtitleParts.push('已暂停')
    const dayLabel = (state.date === today ? '今天 · ' : '') + habitFormatDate(state.date) + ' · ' + (HABIT_WEEKDAY_FULL[habitWeekdayCodeOf(state.date)] || '')
    const dayPlan = habitPlanDay(habit, state.date) && !pausedOnDate
    const daySummary = selectedRecord
      ? habitStatusLabel(selectedRecord.status) +
        (habitIsQuantified(habit) ? ' · ' + habitCheckinValue(selectedRecord) + '/' + habitTargetValue(habit) : '') +
        (selectedRecord.note ? ' · 有日志' : '')
      : dayPlan
        ? '计划日 · 尚未打卡'
        : '非计划日 · 可补记一次'
    const detailMonthDates = detailMonthData && Array.isArray(detailMonthData.days) ? detailMonthData.days : habitMonthDates(state.monthKey)
    const monthCells = detailMonthRow && Array.isArray(detailMonthRow.cells) ? detailMonthRow.cells : []

    return h(
      'div',
      {
        style: {
          flex: '1 1 auto',
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          background: V2_T.surface.shell,
          borderLeft: narrow ? 'none' : '1px solid ' + V2_T.border.subtle,
        },
      },
      h(
        'div',
        { style: { flex: '1 1 auto', overflowY: 'auto', minHeight: 0, padding: 16 } },
        h(
          'div',
          { style: { maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
            narrow
              ? h(
                  'button',
                  {
                    type: 'button',
                    title: '返回列表',
                    onClick: function onBack() {
                      update({ selectedId: null })
                    },
                    style: habitIconButtonStyle({ marginTop: 4 }),
                  },
                  h(V2Icon, { name: 'back', size: 16 }),
                )
              : null,
            h(HabitIconBadge, { habit: habit, size: 44, active: false }),
            h(
              'div',
              { style: { flex: '1 1 auto', minWidth: 0 } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                h(
                  'div',
                  {
                    style: {
                      fontSize: v2fs(V2_T.font.hero),
                      fontWeight: 600,
                      lineHeight: '24px',
                      color: V2_T.text.primary,
                      letterSpacing: '-0.01em',
                    },
                  },
                  habit.name,
                ),
                habit.status === 'paused' ? h('span', { style: habitChipStyle('faint') }, '已暂停') : null,
                habitIsQuantified(habit)
                  ? h(
                      'span',
                      { style: habitChipStyle('accent', false) },
                      '目标 ' + habitTargetValue(habit) + ' ' + habitTargetUnit(habit),
                    )
                  : null,
              ),
              h(
                'div',
                {
                  style: {
                    fontSize: v2fs(V2_T.font.meta),
                    color: V2_T.text.tertiary,
                    marginTop: 2,
                    lineHeight: '17px',
                  },
                },
                subtitleParts.join(' · '),
              ),
              habit.description
                ? h(
                    'div',
                    { style: { fontSize: v2fs(V2_T.font.body), color: V2_T.text.secondary, marginTop: 6, lineHeight: '19px' } },
                    habit.description,
                  )
                : null,
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: function onEdit() {
                  openEditEditor(habit)
                },
                style: v2BtnStyle('soft', {
                  height: 28,
                  padding: '0 10px',
                  borderRadius: V2_T.radius.sm,
                  background: V2_T.surface.panel2,
                  color: V2_T.text.primary,
                  fontSize: v2fs(V2_T.font.meta),
                  flex: '0 0 auto',
                }),
              },
              h(V2Icon, { name: 'edit', size: 13 }),
              '编辑',
            ),
            h(
              'button',
              {
                type: 'button',
                title: '更多操作',
                onClick: function onMore(event) {
                  openMenuAt(event, detailMenuItems(habit))
                },
                style: habitIconButtonStyle({ width: 28, height: 28, minWidth: 28, marginTop: 1 }),
              },
              h(V2Icon, { name: 'more', size: 15 }),
            ),
          ),
          h(
            'div',
            {
              style: habitCardStyle({
                padding: '10px 12px',
                marginTop: 14,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }),
            },
            h(
              'div',
              { style: { flex: '1 1 200px', minWidth: 0 } },
              h(
                'div',
                { style: { fontSize: v2fs(V2_T.font.meta), fontWeight: 600, color: V2_T.text.primary, lineHeight: '18px' } },
                dayLabel,
              ),
              h(
                'div',
                {
                  style: {
                    fontSize: v2fs(V2_T.font.caption),
                    color: selectedRecord ? habitToneColor(habitStatusTone(selectedRecord.status)) : V2_T.text.tertiary,
                    marginTop: 2,
                    lineHeight: '16px',
                  },
                },
                daySummary,
              ),
            ),
            habitIsQuantified(habit)
              ? h(HabitStepper, {
                  target: habitTargetValue(habit),
                  value: habitCheckinValue(selectedRecord),
                  status: selectedRecord ? selectedRecord.status : '',
                  disabled: disabled,
                  busy: busy,
                  onToggle: function onToggle() {
                    handleToggle(habit, stateRef.current.date)
                  },
                  onStep: function onStep(delta) {
                    handleStep(habit, stateRef.current.date, delta)
                  },
                })
              : h(HabitCheckButton, {
                  status: selectedRecord ? selectedRecord.status : '',
                  value: habitCheckinValue(selectedRecord),
                  disabled: disabled,
                  busy: busy,
                  title:
                    windowHint ||
                    (habit.status === 'paused' || pausedOnDate
                      ? '习惯已暂停'
                      : selectedRecord && selectedRecord.status === 'done'
                        ? '取消打卡'
                        : selectedRecord && selectedRecord.status === 'partial'
                          ? '再记一次'
                          : '打卡'),
                  onToggle: function onToggle() {
                    handleToggle(habit, stateRef.current.date)
                  },
                }),
            h(
              'button',
              {
                type: 'button',
                onClick: function onWriteLog() {
                  openLogEditor(habit)
                },
                style: v2BtnStyle('soft', {
                  height: 26,
                  padding: '0 10px',
                  borderRadius: V2_T.radius.sm,
                  background: V2_T.surface.panel2,
                  color: V2_T.text.primary,
                  fontSize: v2fs(V2_T.font.caption),
                  gap: 4,
                }),
              },
              h(V2Icon, { name: 'text', size: 12 }),
              '写日志',
            ),
          ),
          h(
            'div',
            {
              style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: 10,
                marginTop: 12,
              },
            },
            h(HabitStatCard, {
              key: 'month',
              value: String(monthStats.monthDone),
              unit: '天',
              label: '本月打卡',
              hint: habitFrequencyKind(habit) === 'weekly_count' ? '按日累计' : '',
            }),
            h(HabitStatCard, {
              key: 'total',
              value: String(monthStats.totalDone),
              unit: '天',
              label: '总打卡',
              hint: '创建以来',
            }),
            h(HabitStatCard, {
              key: 'ratio',
              value: ratioText,
              tone: ratioTone,
              label: '本月完成率',
              hint:
                monthStats.expected > 0
                  ? String(monthStats.done) + ' / ' + String(monthStats.expected) + (habitFrequencyKind(habit) === 'weekly_count' ? ' 次' : ' 天')
                  : '暂无到期计划',
            }),
            h(HabitStatCard, {
              key: 'streak',
              value: String(streakValue),
              unit: streakUnitLabel,
              tone: streakValue > 0 ? V2_T.accent.base : V2_T.text.tertiary,
              label: '当前连续',
              hint: longest > 0 ? '最长 ' + longest + ' ' + streakUnitLabel : '',
            }),
          ),
          h(
            'div',
            { style: habitCardStyle({ padding: '10px 12px', marginTop: 14 }) },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 2 } },
              h(
                'div',
                { style: { flex: '1 1 auto', fontSize: v2fs(V2_T.font.meta), fontWeight: 600, color: V2_T.text.primary, lineHeight: '18px' } },
                '打卡日历',
              ),
              h(
                'button',
                {
                  type: 'button',
                  title: '上个月',
                  onClick: function onPrev() {
                    update({ monthKey: habitShiftMonth(stateRef.current.monthKey, -1) })
                  },
                  style: habitIconButtonStyle({ width: 24, height: 24, minWidth: 24 }),
                },
                h(V2Icon, { name: 'chevL', size: 14 }),
              ),
              h(
                'div',
                {
                  style: {
                    fontSize: v2fs(V2_T.font.meta),
                    color: V2_T.text.secondary,
                    minWidth: 78,
                    textAlign: 'center',
                    lineHeight: '18px',
                  },
                },
                habitMonthLabel(state.monthKey),
              ),
              h(
                'button',
                {
                  type: 'button',
                  title: '下个月',
                  onClick: function onNext() {
                    update({ monthKey: habitShiftMonth(stateRef.current.monthKey, 1) })
                  },
                  style: habitIconButtonStyle({ width: 24, height: 24, minWidth: 24 }),
                },
                h(V2Icon, { name: 'chevR', size: 14 }),
              ),
              state.monthKey === currentMonthKey
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      onClick: function onCurrentMonth() {
                        update({ monthKey: currentMonthKey, date: today })
                      },
                      style: v2BtnStyle('soft', {
                        fontSize: v2fs(V2_T.font.caption),
                        height: 24,
                        padding: '0 8px',
                        borderRadius: V2_T.radius.sm,
                        background: V2_T.surface.panel2,
                        color: V2_T.text.primary,
                      }),
                    },
                    '本月',
                  ),
            ),
            h('div', { style: { marginTop: 8 } },
              h(HabitMonthGrid, {
                monthKey: state.monthKey,
                dates: detailMonthDates,
                weekStart: detailWeekStart,
                cells: monthCells,
                checkins: checkins,
                habit: habit,
                today: today,
                selectedDate: state.date,
                onSelectDate: selectDate,
              }),
            ),
            renderLegend(),
          ),
          h(
            'div',
            { style: v2CardStyle({ padding: '10px 12px', marginTop: 14 }) },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              h(
                'div',
                { style: { flex: '1 1 auto', fontSize: v2fs(V2_T.font.meta), fontWeight: 600, color: V2_T.text.primary, lineHeight: '18px' } },
                '打卡日志',
              ),
              h(
                'span',
                { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary, lineHeight: '16px' } },
                String(logs.length) + ' 条',
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: function onWriteLog() {
                    openLogEditor(habit)
                  },
                  style: v2BtnStyle('soft', {
                    height: 24,
                    padding: '0 8px',
                    borderRadius: V2_T.radius.sm,
                    background: V2_T.surface.panel2,
                    color: V2_T.text.primary,
                    fontSize: v2fs(V2_T.font.caption),
                    gap: 3,
                  }),
                },
                h(V2Icon, { name: 'plus', size: 12 }),
                '写日志',
              ),
            ),
            h(
              'div',
              { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary, marginTop: 4, lineHeight: '16px' } },
              '日志依附于打卡记录：保存或删除日志不会改变打卡状态，删除日志只清空备注。',
            ),
            logs.length
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 } },
                  logs.slice(0, 30).map(function renderLog(item) {
                    const editable = dateWindowHint(item.local_date) === ''
                    return h(
                      'div',
                      {
                        key: item.id || item.local_date,
                        onMouseEnter: function onEnter(event) {
                          event.currentTarget.style.background = V2_T.surface.panel2
                          const buttons = event.currentTarget.querySelectorAll('button')
                          Array.prototype.forEach.call(buttons, function each(btn) {
                            btn.style.opacity = '1'
                          })
                        },
                        onMouseLeave: function onLeave(event) {
                          event.currentTarget.style.background = 'transparent'
                          const buttons = event.currentTarget.querySelectorAll('button')
                          Array.prototype.forEach.call(buttons, function each(btn) {
                            btn.style.opacity = '0.55'
                          })
                        },
                        style: {
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                          minHeight: 34,
                          boxSizing: 'border-box',
                          padding: '6px 8px',
                          borderRadius: V2_T.radius.sm,
                          background: 'transparent',
                        },
                      },
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                        h(
                          'span',
                          { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary, lineHeight: '16px' } },
                          habitFormatDate(item.local_date) + (item.checkin_kind === 'retro' ? ' · 补记' : ''),
                        ),
                        h('span', { style: habitChipStyle(habitStatusTone(item.status)) }, habitStatusLabel(item.status)),
                        h('div', { style: { flex: '1 1 auto' } }),
                        editable
                          ? h(
                              'button',
                              {
                                type: 'button',
                                title: '编辑日志',
                                onClick: function onEditLog() {
                                  openLogEditorForDate(habit, item.local_date)
                                },
                                style: habitIconButtonStyle({ width: 22, height: 22, minWidth: 22, opacity: 0.55 }),
                              },
                              h(V2Icon, { name: 'edit', size: 12 }),
                            )
                          : h('span', { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary } }, '仅查看'),
                        editable
                          ? h(
                              'button',
                              {
                                type: 'button',
                                title: '删除日志（保留打卡）',
                                onClick: function onDeleteLog() {
                                  deleteLog(habit, item)
                                },
                                style: habitIconButtonStyle({ width: 22, height: 22, minWidth: 22, opacity: 0.55 }),
                              },
                              h(V2Icon, { name: 'trash', size: 12 }),
                            )
                          : null,
                      ),
                      h(
                        'div',
                        {
                          style: {
                            fontSize: v2fs(V2_T.font.meta),
                            color: V2_T.text.primary,
                            lineHeight: '18px',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                          },
                        },
                        item.note,
                      ),
                    )
                  }),
                )
              : h(
                  'div',
                  {
                    style: {
                      fontSize: v2fs(V2_T.font.caption),
                      color: V2_T.text.tertiary,
                      marginTop: 8,
                      padding: 12,
                      textAlign: 'center',
                      border: '1px dashed ' + V2_T.border.subtle,
                      borderRadius: V2_T.radius.sm,
                      lineHeight: '16px',
                    },
                  },
                  '还没有打卡日志。打卡后可以给当天写一条记录。',
                ),
          ),
          h(
            'div',
            { style: { marginTop: 18, paddingBottom: 8 } },
            h(
              'div',
              {
                style: {
                  fontSize: v2fs(V2_T.font.meta),
                  fontWeight: 600,
                  color: V2_T.text.primary,
                  marginBottom: 6,
                  lineHeight: '18px',
                },
              },
              '习惯信息',
            ),
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))', gap: '2px 18px' } },
              renderInfoRow('状态', habit.status === 'paused' ? '已暂停' : habit.status === 'archived' ? '已归档' : '进行中'),
              renderInfoRow('频率', habitFrequencyText(habit)),
              renderInfoRow('目标', habitIsQuantified(habit) ? habitTargetValue(habit) + ' ' + habitTargetUnit(habit) : '未设置量化目标'),
              renderInfoRow('开始日期', habit.start_date || '—'),
              renderInfoRow('结束日期', habit.end_date || '—'),
              renderInfoRow('提醒', habit.time_hint || '—'),
              renderInfoRow('创建时间', habitFormatDateTime(habit.created_at) || '—'),
              renderInfoRow('更新时间', habitFormatDateTime(habit.updated_at) || '—'),
              renderInfoRow('图标', '按名称自动推导'),
              renderInfoRow('分组', 'Host 无分组字段'),
              renderInfoRow('编号', habit.id),
            ),
            h(
              'div',
              { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary, marginTop: 8, lineHeight: '16px' } },
              'Host 目前不提供 icon / group 字段：图标按名称推导，列表按「当日计划 / 灵活打卡 / 已暂停」自动分组。',
            ),
          ),
        ),
      ),
    )
  }

  /* ── 渲染：浮层 ── */

  function renderMenuLayer() {
    if (!state.menu) return null
    return h(HabitMenuLayer, {
      menu: state.menu,
      onClose: function onClose() {
        update({ menu: null })
      },
      onError: function onError(error) {
        toast('error', '操作失败：' + habitErrorHint(error))
      },
    })
  }

  function renderConfirmLayer() {
    if (!state.confirmDialog) return null
    return h(HabitConfirmModal, {
      dialog: state.confirmDialog,
      onConfirm: handleConfirm,
      onClose: function onClose() {
        update({ confirmDialog: null })
      },
    })
  }

  function renderEditorLayer() {
    const editor = state.editor
    if (!editor) return null
    return h(HabitEditorModal, {
      mode: editor.mode,
      form: editor.form || {},
      saving: editor.saving === true,
      error: editor.error || '',
      onChange: function onChange(patch) {
        const current = stateRef.current.editor
        if (!current) return
        update({
          editor: Object.assign({}, current, {
            form: Object.assign({}, current.form, patch),
            error: null,
          }),
        })
      },
      onSave: saveHabitEditor,
      onClose: function onClose() {
        update({ editor: null })
      },
    })
  }

  function renderLogLayer() {
    const log = state.logEditor
    if (!log) return null
    const habit = findHabit(log.habitId)
    if (!habit) return null
    const checkins = state.checkins[habit.id] || []
    const existing = habitCheckinByDate(checkins, log.date)
    const derived = Object.assign({}, log, {
      hasCheckin: !!existing,
      existingNote: !!(existing && existing.note),
      status: existing ? existing.status : log.status,
    })
    return h(HabitLogModal, {
      log: derived,
      onChange: function onChange(patch) {
        const current = stateRef.current.logEditor
        if (!current) return
        update({ logEditor: Object.assign({}, current, patch, { error: null }) })
      },
      onSave: saveLogEditor,
      onDelete: function onDelete() {
        if (existing) deleteLog(habit, existing)
      },
      onClose: function onClose() {
        update({ logEditor: null })
      },
    })
  }

  const habitForDetail = currentHabit()
  return h(
    'div',
    {
      style: {
        height: '100%',
        display: 'flex',
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        background: V2_T.surface.app,
        color: V2_T.text.primary,
        fontFamily: COLORS.fontFamily,
        position: 'relative',
      },
    },
    renderLeftPane(),
    narrow || !habitForDetail
      ? null
      : h('div', {
          key: 'habit-list-splitter',
          title: '拖动调整习惯列表宽度',
          onMouseDown: startListResize,
          style: {
            flex: '0 0 6px',
            width: 6,
            cursor: 'col-resize',
            background: 'transparent',
            marginLeft: -3,
            marginRight: -3,
            zIndex: 2,
          },
          onMouseEnter: function onEnter(event) {
            event.currentTarget.style.background = V2_T.surface.panel3
          },
          onMouseLeave: function onLeave(event) {
            event.currentTarget.style.background = 'transparent'
          },
        }),
    narrow ? (habitForDetail ? renderDetailPane() : null) : habitForDetail ? renderDetailPane() : null,
    renderMenuLayer(),
    renderConfirmLayer(),
    renderEditorLayer(),
    renderLogLayer(),
  )
}

