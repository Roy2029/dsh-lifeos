/**
 * LifeOS — 规则抽取引擎（A 线：领域层，纯函数）
 *
 * 契约：`M2-PLAN.md` §2.2 候选结构 / §2.3 规则抽取；`design/04` 字段名。
 * - 输入：原始记录正文 + { localDate: YYYY-MM-DD, timeZone, rawRecordId? }
 * - 输出候选：{ candidateId, rawRecordId, kind, confidence, source:{quote,start,end},
 *   fields, reasons, risks, requiresConfirm }
 * - 硬约束：
 *   1) `rawText.slice(source.start, source.end) === source.quote`（必须回指原文）；
 *   2) 否定句不产出正向事实（event/metric/habit_checkin）；
 *   3) 不编造原文没有的数值/时长/对象；字段采用 design/04 字段名；
 *   4) 同类候选去重（同 raw + kind + 关键字段只保留一条）；
 *   5) 保守优先（宁少勿错）：拿不准的给低 confidence + requiresConfirm + risks。
 *
 * 零第三方依赖：仅使用同目录 ids.js / time.js。
 */

import { newId } from './ids.js'
import {
  addDays,
  isLocalDate,
  localDateOfIso,
  localDateTimeToIso,
  localDayStartIso,
  parseLocalDate,
} from './time.js'

export const CANDIDATE_KINDS = Object.freeze(['task', 'event', 'metric', 'habit_checkin', 'wish'])
export const EXTRACTION_RULE_VERSION = 'm2.rules.v1'

const WEEKDAY_INDEX = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }
const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const PUNCT_RE = /[。；;！!？?\n，,]+/g

// 数字：阿拉伯数字（含小数）或常见中文数字（一~十/两/半）
const NUM = '([0-9]+(?:\\.[0-9]+)?|[一二两三四五六七八九十]+)'
const NUM_DIGITS = '([0-9]+(?:\\.[0-9]+)?)'

const SLEEP_WORDS = /(睡眠|睡了|睡觉|入睡|起床|醒来|没睡好|睡)/
const EXERCISE_WORDS = /(训练|运动|跑步|健身|力量|瑜伽|八段锦|俯卧撑|深蹲|拉伸|打球|游泳)/
const MEAL_WORDS = /(吃|喝|早餐|早饭|午餐|午饭|晚餐|晚饭|正餐|饮食|加餐)/
const WORK_WORDS = /(项目|工作|剪辑|代码|文档|报告|实验|推进)/
const STUDY_WORDS = /(阅读|看书|读了一|论文|学习|课程|背单词|脚本|构思|素材)/
const HABIT_WORDS = /(八段锦|冥想|阅读|早睡|写作|背单词|瑜伽)/
const FACT_MARKERS = /(做了|做过|完成|完成了|坚持|打卡|练了|进行了|去了|跑了|吃了|喝了|睡了)/
const TASK_INTENT = /(要|需要|得|记得|帮我|提醒我|别忘|待办|安排|截止|之前|以前|前)/
const WISH_WORDS = /(想|希望|梦想|愿望|以后|将来)/g
const WISH_COMPOUND = /(冥想|思想|回想|想象|理想|想法|想想|想到|猜想|联想|规划)/g
const NEGATION_RE =
  /(没(?:有)?\s*(?:去|做|运动|训练|吃|喝|完成|看|读|冥想|八段锦|跑步|健身|睡好)|未\s*(?:去|做|完成)|不打算|不想|不需要|不用|没\s*[去做了])/
const PAST_MARKERS = /(了|已经|昨天|昨日|前天|今天已|做了|完成了|去过|吃过|喝过)/
const FUTURE_MARKERS = /(要|需要|得|计划|准备|打算|决定|明天|后天|下周|以后|将来|提醒我)/
const HABIT_INTENT = /(每天|每周|每个?月|坚持|打卡)/
const ACTION_VERBS = /(去|交|买|写|发|完成|做|整理|准备|提交|申请|联系|看|读|预约|参加|开会|出差|搬家|体检|修|洗|换|寄|报名|付款|缴费|锻炼|跑步|学习)/

const CONFIDENCE = {
  event: 0.68,
  task: 0.62,
  metric: 0.8,
  habit: 0.72,
  wish: 0.6,
}

/* ────────────────────────── 基础工具 ────────────────────────── */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function cnNumber(token) {
  if (token === undefined || token === null || token === '') return null
  const text = String(token)
  if (/^[0-9]+(\.[0-9]+)?$/.test(text)) return Number(text)
  if (text === '半') return 0.5
  if (text.length === 1) return CN_DIGITS[text] ?? null
  if (text.length === 2 && text[0] === '十') return 10 + (CN_DIGITS[text[1]] ?? 0)
  if (text.length === 2 && text[1] === '十') return (CN_DIGITS[text[0]] ?? 0) * 10
  if (text.length === 3 && text[1] === '十') return (CN_DIGITS[text[0]] ?? 0) * 10 + (CN_DIGITS[text[2]] ?? 0)
  return null
}

function trimSpan(text, start, end) {
  let s = start
  let e = end
  while (s < e && /\s/.test(text[s])) s += 1
  while (e > s && /\s/.test(text[e - 1])) e -= 1
  return { start: s, end: e, quote: text.slice(s, e) }
}

/** 按标点/换行切子句（保留原文偏移，quote 可回指）。 */
export function splitClauses(rawText) {
  const clauses = []
  let last = 0
  let match
  PUNCT_RE.lastIndex = 0
  while ((match = PUNCT_RE.exec(rawText)) !== null) {
    if (match.index > last) clauses.push(trimSpan(rawText, last, match.index))
    last = PUNCT_RE.lastIndex
  }
  if (last < rawText.length) clauses.push(trimSpan(rawText, last, rawText.length))
  return clauses.filter((clause) => clause.quote.length > 0)
}

function weekdayOfLocalDate(localDate) {
  const parsed = parseLocalDate(localDate)
  const day = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay()
  return (day + 6) % 7 // 0=周一
}

function resolveWeekday(localDate, targetDow, { nextWeek = false } = {}) {
  const current = weekdayOfLocalDate(localDate)
  let delta = (targetDow - current + 7) % 7
  if (nextWeek) delta += 7
  return addDays(localDate, delta)
}

/* ────────────────────────── 日期 / 时间 ────────────────────────── */

/** 解析日期表达；返回按出现位置排序的匹配列表。 */
export function parseDateExpressions(clause, localDate) {
  const text = clause.quote
  const out = []
  const push = (match, resolved, relative) => {
    out.push({
      start: clause.start + match.index,
      end: clause.start + match.index + match[0].length,
      raw: match[0],
      localDate: resolved,
      relative,
    })
  }
  let m
  const abs = /(\d{4})-(\d{1,2})-(\d{1,2})/g
  while ((m = abs.exec(text)) !== null) {
    const candidate = `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`
    if (isLocalDate(candidate)) push(m, candidate, false)
  }
  const parsedLocal = parseLocalDate(localDate)
  const monthDay = /(\d{1,2})月(\d{1,2})[日号]/g
  while ((m = monthDay.exec(text)) !== null) {
    const candidate = `${parsedLocal.year}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`
    if (isLocalDate(candidate)) push(m, candidate, false)
  }
  const relatives = /(大后天|后天|明天|明日|今天|今日|昨天|昨日|前天)/g
  const relativeMap = { 大后天: 3, 后天: 2, 明天: 1, 明日: 1, 今天: 0, 今日: 0, 昨天: -1, 昨日: -1, 前天: -2 }
  while ((m = relatives.exec(text)) !== null) push(m, addDays(localDate, relativeMap[m[1]]), true)
  const weekday = /(下|本|这)?(?:周|星期|礼拜)([一二三四五六日天])/g
  while ((m = weekday.exec(text)) !== null) {
    const targetDow = WEEKDAY_INDEX[m[2]]
    if (targetDow === undefined) continue
    push(m, resolveWeekday(localDate, targetDow, { nextWeek: m[1] === '下' }), true)
  }
  return out.sort((a, b) => a.start - b.start)
}

function adjustPeriodHour(hour, period) {
  if (period === null || period === undefined) return hour
  if (['下午', '傍晚', '晚上', '夜间', '深夜', '半夜'].includes(period) && hour < 12) return hour + 12
  if (period === '中午' && hour < 11) return 12
  if (period === '凌晨' && hour === 12) return 0
  return hour
}

/** 解析时间段（HH:mm-HH:mm / HH点-HH点，含上午/下午修正）。 */
export function parseTimeRange(clause) {
  const text = clause.quote
  let m = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜间|深夜|半夜)?\s*(\d{1,2})[:：](\d{2})\s*[-–—~～至到]\s*(\d{1,2})[:：](\d{2})/.exec(text)
  if (m) {
    const startHour = adjustPeriodHour(Number(m[2]), m[1])
    const endHour = Number(m[4])
    return {
      startHour,
      startMinute: Number(m[3]),
      endHour,
      endMinute: Number(m[5]),
      start: clause.start + m.index,
      end: clause.start + m.index + m[0].length,
      raw: m[0],
      crossesMidnight: endHour * 60 + Number(m[5]) <= startHour * 60 + Number(m[3]),
    }
  }
  m = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜间|深夜|半夜)?\s*(\d{1,2})点(半|[0-9]{1,2}分?)?\s*[-–—~～至到]\s*(\d{1,2})点(半|[0-9]{1,2}分?)?/.exec(text)
  if (m) {
    const startHour = adjustPeriodHour(Number(m[2]), m[1])
    const startMin = m[3] === '半' ? 30 : m[3] ? Number(String(m[3]).replace('分', '')) : 0
    const endHour = adjustPeriodHour(Number(m[4]), m[1])
    const endMin = m[5] === '半' ? 30 : m[5] ? Number(String(m[5]).replace('分', '')) : 0
    return {
      startHour,
      startMinute: startMin,
      endHour,
      endMinute: endMin,
      start: clause.start + m.index,
      end: clause.start + m.index + m[0].length,
      raw: m[0],
      crossesMidnight: endHour * 60 + endMin <= startHour * 60 + startMin,
    }
  }
  return null
}

/** 解析单个时刻（HH:mm / 下午3点半）。 */
export function parseTimeExpression(clause) {
  const text = clause.quote
  let m = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜间|深夜|半夜)?\s*(\d{1,2})[:：](\d{2})/.exec(text)
  if (m) {
    const hour = adjustPeriodHour(Number(m[2]), m[1])
    if (hour > 23 || Number(m[3]) > 59) return null
    return { hours: hour, minutes: Number(m[3]), period: m[1] ?? null, start: clause.start + m.index, end: clause.start + m.index + m[0].length, raw: m[0] }
  }
  m = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜间|深夜|半夜)?\s*(\d{1,2})\s*[点时](半|[0-9]{1,2}分?)?/.exec(text)
  if (m) {
    const hour = adjustPeriodHour(Number(m[2]), m[1])
    const minutes = m[3] === '半' ? 30 : m[3] ? Number(String(m[3]).replace('分', '')) : 0
    if (hour > 23 || minutes > 59) return null
    return { hours: hour, minutes, period: m[1] ?? null, start: clause.start + m.index, end: clause.start + m.index + m[0].length, raw: m[0] }
  }
  return null
}

/** 截止表达：日期 + 紧随其后的 之前/以前/前/截止；或"截止/DDL"。 */
export function parseDeadline(clause, localDate) {
  const dates = parseDateExpressions(clause, localDate)
  const text = clause.quote
  if (dates.length > 0) {
    const nearest = dates[0]
    const after = text.slice(nearest.end - clause.start)
    const marker = /^\s*(之前|以前|前|截止|截至)/.exec(after)
    if (marker) {
      return {
        localDate: nearest.localDate,
        start: nearest.start,
        end: nearest.end + marker[0].length,
        raw: text.slice(nearest.start - clause.start, nearest.end - clause.start + marker[0].length),
        marker: marker[1],
        requiresConfirm: true,
      }
    }
  }
  const standalone = /(截止|截至|ddl|DDL)/.exec(text)
  if (standalone && dates.length > 0) {
    return {
      localDate: dates[0].localDate,
      start: clause.start + standalone.index,
      end: dates[0].end,
      raw: standalone[0],
      marker: standalone[0],
      requiresConfirm: true,
    }
  }
  return null
}

/** 否定子句判定（否定句不产正向事实；"没睡好"是事实特例）。 */
export function isNegatedClause(clause) {
  const text = clause.quote
  if (/没睡好/.test(text)) return false
  return NEGATION_RE.test(text)
}

function hasPastMarker(text) {
  return PAST_MARKERS.test(text)
}

function isFutureOrHabitual(text) {
  return FUTURE_MARKERS.test(text) || HABIT_INTENT.test(text)
}

/** 愿望标记（排除"冥想/思想/回想"等复合词里的"想"）。 */
function hasWishMarker(text) {
  const cleaned = String(text).replace(WISH_COMPOUND, '')
  return /(想|希望|梦想|愿望|以后|将来)/.test(cleaned)
}

/* ────────────────────────── 指标 ────────────────────────── */

const METRIC_RULES = [
  { kind: 'steps_before', re: /(?:步数|步)\s*([0-9]+(?:\.[0-9]+)?)/g, unit: 'count', factor: 1 },
  { kind: 'steps_after', re: new RegExp(`${NUM}\\s*步`, 'g'), unit: 'count', factor: 1 },
  { kind: 'minutes', re: new RegExp(`${NUM}\\s*(?:分钟|min)`, 'g'), unit: 'min', factor: 1 },
  { kind: 'hours', re: new RegExp(`${NUM}\\s*(?:小时|h)`, 'g'), unit: 'min', factor: 60 },
  { kind: 'sets', re: new RegExp(`${NUM}\\s*组`, 'g'), unit: 'set', factor: 1 },
  { kind: 'kg', re: new RegExp(`${NUM_DIGITS}\\s*(?:kg|KG|公斤|千克)`, 'g'), unit: 'kg', factor: 1 },
  { kind: 'mg', re: new RegExp(`${NUM_DIGITS}\\s*(?:mg|毫克)`, 'g'), unit: 'mg', factor: 1 },
  { kind: 'grams', re: new RegExp(`${NUM_DIGITS}\\s*(?:g|G|克)`, 'g'), unit: 'g', factor: 1 },
  { kind: 'pills', re: new RegExp(`${NUM}\\s*(?:颗|粒)`, 'g'), unit: 'count', factor: 1 },
  { kind: 'cups', re: new RegExp(`${NUM}\\s*杯`, 'g'), unit: 'cup', factor: 1 },
  { kind: 'ml', re: new RegExp(`${NUM_DIGITS}\\s*(?:ml|毫升)`, 'g'), unit: 'ml', factor: 1 },
  { kind: 'times', re: new RegExp(`${NUM}\\s*次`, 'g'), unit: 'count', factor: 1 },
  { kind: 'pieces', re: new RegExp(`${NUM}\\s*个`, 'g'), unit: 'count', factor: 1 },
]

function metricCodeFor(unit, contextText, fullText) {
  const text = unit === 'min' ? `${fullText ?? ''} ${contextText ?? ''}` : contextText ?? ''
  if (unit === 'count') {
    if (/(步数|步)/.test(text)) return 'steps'
    if (/(维生素|维D|VD)/i.test(text)) return /D3/i.test(text) ? 'vitamin_d3_count' : 'vitamin_count'
    if (/(颗|粒)/.test(text)) return 'supplement_count'
    if (/(次)/.test(text)) return 'activity_count'
    return 'other_count'
  }
  if (unit === 'set') return 'exercise_sets'
  if (unit === 'min') {
    if (SLEEP_WORDS.test(text)) return 'sleep_duration_min'
    if (/冥想/.test(text)) return 'meditation_duration_min'
    if (EXERCISE_WORDS.test(text)) return 'workout_duration_min'
    if (/(阅读|看书|学习|背单词)/.test(text)) return 'reading_duration_min'
    return 'other_duration_min'
  }
  if (unit === 'g') {
    if (/蛋白粉/.test(text)) return 'protein_powder_g'
    if (/肌酸/.test(text)) return 'creatine_g'
    if (/(肉|蛋白|食物|菜)/.test(text)) return 'food_quantity_g'
    return 'other_quantity_g'
  }
  if (unit === 'kg') return 'body_weight_kg'
  if (unit === 'mg') return /镁/.test(text) ? 'magnesium_mg' : 'other_quantity_mg'
  if (unit === 'ml') return /水/.test(text) ? 'water_ml' : 'other_volume_ml'
  if (unit === 'cup') return /水/.test(text) ? 'water_cup' : 'other_cup'
  return 'other_quantity'
}

function matchContext(clauseText, index, length, lookBehind = 0) {
  // g/mg/count 用后文（"5g肌酸"不能被前面的"蛋白粉"抢走编码）；ml/cup/kg 用前后文（"喝水500ml"）
  const from = Math.max(0, index - lookBehind)
  const to = Math.min(clauseText.length, index + length + 10)
  return clauseText.slice(from, to)
}

function metricCandidatesForClause(clause, ctx) {
  const out = []
  const text = clause.quote
  if (isNegatedClause(clause)) return out
  // 计划/未来/习惯意图里的数字不是已发生指标（计划≠事实）
  if (isFutureOrHabitual(text) && !hasPastMarker(text)) return out
  const seen = new Set()
  for (const rule of METRIC_RULES) {
    rule.re.lastIndex = 0
    let m
    while ((m = rule.re.exec(text)) !== null) {
      const value = cnNumber(m[1])
      if (value === null || value === undefined || Number.isNaN(value)) continue
      const lookBehind = rule.unit === 'ml' || rule.unit === 'cup' || rule.unit === 'kg' ? 6 : 0
      const code = metricCodeFor(rule.unit, matchContext(text, m.index, m[0].length, lookBehind), text)
      const dedupeKey = `${code}:${rule.unit}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      const timeExpr = parseTimeExpression(clause)
      let measuredAt
      let timePrecision
      if (timeExpr) {
        measuredAt = localDateTimeToIso(ctx.timeZone, ctx.localDate, `${String(timeExpr.hours).padStart(2, '0')}:${String(timeExpr.minutes).padStart(2, '0')}`)
        timePrecision = 'minute'
      } else {
        measuredAt = localDayStartIso(ctx.timeZone, ctx.localDate)
        timePrecision = 'day'
      }
      const knownCode = !/^other_/.test(code)
      out.push({
        kind: 'metric',
        confidence: round2(clamp(CONFIDENCE.metric + (knownCode ? 0.05 : -0.15) - (timePrecision === 'day' ? 0.05 : 0), 0.35, 0.95)),
        source: { quote: m[0], start: clause.start + m.index, end: clause.start + m.index + m[0].length },
        fields: {
          metric_code: code,
          value_num: round2(value * rule.factor),
          unit: rule.unit,
          measured_at: measuredAt,
          measured_tz: ctx.timeZone,
        },
        reasons: [`命中数值+单位「${m[0].trim()}」`, `指标编码 ${code}`],
        risks: [
          ...(knownCode ? [] : ['指标编码未确定，需确认']),
          ...(timePrecision === 'day' ? ['原文未给具体时刻，时间精度为日'] : []),
        ],
        requiresConfirm: !knownCode,
        _dedupe: dedupeKey,
      })
    }
  }
  return out
}

/* ────────────────────────── 事件事实 ────────────────────────── */

function eventTypeOf(text) {
  if (SLEEP_WORDS.test(text)) return 'sleep'
  if (EXERCISE_WORDS.test(text)) return 'exercise'
  if (MEAL_WORDS.test(text)) return 'meal'
  if (/(开会|会议)/.test(text)) return 'meeting'
  if (STUDY_WORDS.test(text)) return 'study'
  if (WORK_WORDS.test(text)) return 'work'
  return null
}

function mealTypeOf(text) {
  if (/(早餐|早饭|早晨吃)/.test(text)) return 'breakfast'
  if (/(午餐|午饭)/.test(text)) return 'lunch'
  if (/(晚餐|晚饭)/.test(text)) return 'dinner'
  if (/正餐/.test(text)) return 'main_meal'
  if (/(加餐|零食)/.test(text)) return 'snack'
  return 'meal'
}

function extractMealItems(text) {
  const cleaned = text
    .replace(/^.*?(吃|喝)(了|过|的)?/, '')
    .replace(/(早餐|早饭|午餐|午饭|晚餐|晚饭|正餐|加餐)/g, '')
    .replace(/(还有|以及|和|与|、|有)/g, ' ')
    .replace(/(一份|两份|两大份|大份|小份|一碗|一盘|一些|一点)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned
    .split(/\s+/)
    .map((item) => item.replace(/[，,。；;！!？?]/g, '').trim())
    .filter((item) => item.length >= 1 && item.length <= 12)
    .slice(0, 8)
}

/** 去掉日期/时间/意图/口头词后的标题（只做原文删除，不新增内容）。 */
function cleanTitle(clause, localDate, { dropWords = [] } = {}) {
  const dateMatches = parseDateExpressions(clause, localDate).map((item) => item.raw)
  const timeRange = parseTimeRange(clause)
  const timeExpr = parseTimeExpression(clause)
  const deadline = parseDeadline(clause, localDate)
  const removals = [...dateMatches, timeRange?.raw, timeExpr?.raw, deadline?.marker, ...dropWords].filter(Boolean)
  let out = clause.quote
  for (const token of [...removals].sort((a, b) => b.length - a.length)) {
    if (token) out = out.split(token).join(' ')
  }
  out = out
    .replace(/[，,。；;！!？?、\s:：]+/g, ' ')
    .replace(/(还要|需要|得|记得|帮我|提醒我|别忘了|别忘|麻烦|然后|就|再|把|要|我|今天|已)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return out || clause.quote.trim()
}

function occurredRange(clause, ctx, day) {
  const range = parseTimeRange(clause)
  if (!range) return null
  const start = localDateTimeToIso(ctx.timeZone, day, `${String(range.startHour).padStart(2, '0')}:${String(range.startMinute).padStart(2, '0')}`)
  const endDay = range.crossesMidnight ? addDays(day, 1) : day
  const end = localDateTimeToIso(ctx.timeZone, endDay, `${String(range.endHour).padStart(2, '0')}:${String(range.endMinute).padStart(2, '0')}`)
  return {
    start,
    end,
    durationMinutes: Math.round((Date.parse(end) - Date.parse(start)) / 60000),
    raw: range.raw,
  }
}

function factCandidateForClause(clause, ctx) {
  const text = clause.quote
  if (isNegatedClause(clause)) return null
  if (isFutureOrHabitual(text) && !hasPastMarker(text)) return null
  const eventType = eventTypeOf(text)
  if (!eventType) return null
  if (['work', 'study', 'meeting'].includes(eventType) && !hasPastMarker(text) && !FACT_MARKERS.test(text)) {
    return null
  }
  // 喝水/只摄入补剂不当作 meal 事件（由 metric 承载）
  if (eventType === 'meal' && /(喝水|喝了水|水\d)/.test(text) && !/(饭|菜|肉|鸡蛋|酸奶|牛奶|水果|零食|早餐|午餐|晚餐)/.test(text)) {
    return null
  }
  if (
    eventType === 'meal' &&
    /(蛋白粉|肌酸|维生素|补剂|钙片|鱼油|镁|锌)/.test(text) &&
    !/(早餐|早饭|午餐|午饭|晚餐|晚饭|正餐|饭|菜|肉|鸡蛋|酸奶|牛奶|水果|零食|加餐)/.test(text)
  ) {
    return null
  }
  const dateExprs = parseDateExpressions(clause, ctx.localDate)
  const day = dateExprs.length > 0 ? dateExprs[0].localDate : ctx.localDate
  const timeExpr = parseTimeExpression(clause)
  const range = occurredRange(clause, ctx, day)
  const startInfo = timeExpr
    ? {
        iso: localDateTimeToIso(ctx.timeZone, day, `${String(timeExpr.hours).padStart(2, '0')}:${String(timeExpr.minutes).padStart(2, '0')}`),
        timePrecision: 'minute',
        hasTime: true,
      }
    : range
      ? { iso: range.start, timePrecision: 'minute', hasTime: true }
      : { iso: localDayStartIso(ctx.timeZone, day), timePrecision: 'day', hasTime: false }
  const source = { quote: text, start: clause.start, end: clause.end }

  if (eventType === 'sleep') {
    const poor = /没睡好/.test(text)
    const asleep = /(睡眠|睡了|睡觉|入睡)/.test(text)
    const woke = /(起床|醒来)/.test(text)
    let occurredStartAt = startInfo.iso
    let occurredEndAt = null
    let durationMinutes = null
    let timePrecision = startInfo.timePrecision
    let isAllDay = !startInfo.hasTime
    if (range) {
      occurredStartAt = range.start
      occurredEndAt = range.end
      durationMinutes = range.durationMinutes
      timePrecision = 'minute'
      isAllDay = false
    } else if (woke && !asleep) {
      occurredStartAt = startInfo.iso
    }
    return [
      {
        kind: 'event',
        confidence: round2(clamp(CONFIDENCE.event + (range ? 0.12 : 0) - (isAllDay ? 0.06 : 0), 0.4, 0.94)),
        source,
        fields: {
          event_type: 'sleep',
          title: poor ? '睡眠质量差' : '睡眠',
          occurred_start_at: occurredStartAt,
          occurred_end_at: occurredEndAt,
          occurred_tz: ctx.timeZone,
          is_all_day: isAllDay,
          time_precision: timePrecision,
          duration_minutes: durationMinutes,
          ...(poor ? { payload_json: { quality: 'poor' } } : {}),
        },
        reasons: [
          range ? `识别到睡眠区间「${range.raw}」` : '识别到睡眠事实',
          poor ? '原文明确提到睡眠质量差' : '原文提到睡眠',
        ],
        risks: [...(isAllDay && !range ? ['缺少起止时间，仅到日精度'] : []), ...(poor ? ['主观感受，非客观指标'] : [])],
        requiresConfirm: !range || poor,
      },
    ]
  }

  if (eventType === 'meal') {
    const mealType = mealTypeOf(text)
    const items = extractMealItems(text)
    const title = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', main_meal: '正餐', snack: '加餐', meal: '饮食' }[mealType]
    return [
      {
        kind: 'event',
        confidence: round2(clamp(CONFIDENCE.event + (items.length ? 0.04 : 0) - (startInfo.hasTime ? 0 : 0.06), 0.4, 0.9)),
        source,
        fields: {
          event_type: 'meal',
          title,
          occurred_start_at: startInfo.iso,
          occurred_end_at: range?.end ?? null,
          occurred_tz: ctx.timeZone,
          is_all_day: !startInfo.hasTime,
          time_precision: startInfo.timePrecision,
          payload_json: { meal_type: mealType, ...(items.length > 0 ? { items } : {}) },
        },
        reasons: [`识别到饮食事实（${title}）`, ...(items.length > 0 ? ['原文食物条目写入 payload（不改写）'] : [])],
        risks: startInfo.hasTime ? [] : ['缺少具体用餐时刻，仅到日精度'],
        requiresConfirm: !startInfo.hasTime,
      },
    ]
  }

  if (eventType === 'meeting') {
    return [
      {
        kind: 'event',
        confidence: round2(clamp(CONFIDENCE.event, 0.4, 0.9)),
        source,
        fields: {
          event_type: 'meeting',
          title: cleanTitle(clause, ctx.localDate) || '会议',
          occurred_start_at: startInfo.iso,
          occurred_end_at: range?.end ?? null,
          occurred_tz: ctx.timeZone,
          is_all_day: !startInfo.hasTime,
          time_precision: startInfo.timePrecision,
          ...(range ? { duration_minutes: range.durationMinutes } : {}),
        },
        reasons: ['识别到已发生的会议事实'],
        risks: startInfo.hasTime ? [] : ['缺少具体时刻，仅到日精度'],
        requiresConfirm: !startInfo.hasTime,
      },
    ]
  }

  // exercise / work / study
  const vague = eventType !== 'exercise'
  const title = cleanTitle(clause, ctx.localDate) || text
  return [
    {
      kind: 'event',
      confidence: round2(clamp(CONFIDENCE.event + (startInfo.hasTime ? 0.04 : 0) - (vague ? 0.14 : 0), 0.35, 0.92)),
      source,
      fields: {
        event_type: eventType,
        title,
        occurred_start_at: startInfo.iso,
        occurred_end_at: range?.end ?? null,
        occurred_tz: ctx.timeZone,
        is_all_day: !startInfo.hasTime && !range,
        time_precision: range ? 'minute' : startInfo.timePrecision,
        ...(range ? { duration_minutes: range.durationMinutes } : {}),
      },
      reasons: [`识别到${eventType === 'exercise' ? '运动' : eventType === 'study' ? '学习' : '工作'}事实`, '动作动词 + 对象'],
      risks: [
        ...(vague ? ['语义模糊：描述的是进度而非明确完成标准'] : []),
        ...(startInfo.hasTime ? [] : ['缺少具体时刻，仅到日精度']),
      ],
      requiresConfirm: vague || (!startInfo.hasTime && eventType !== 'exercise'),
    },
  ]
}

/* ────────────────────────── 任务 / 愿望 / 习惯打卡 ────────────────────────── */

function taskCandidateForClause(clause, ctx) {
  const text = clause.quote
  if (isNegatedClause(clause)) return null
  const deadline = parseDeadline(clause, ctx.localDate)
  const dateExprs = parseDateExpressions(clause, ctx.localDate)
  const timeRange = parseTimeRange(clause)
  const timeExpr = parseTimeExpression(clause)
  const past = hasPastMarker(text) && !/(要|需要|得|记得|帮我|提醒|之前|截止)/.test(text)
  if (past) return null
  const hasIntent = TASK_INTENT.test(text)
  // 纯习惯意图（每天/每周…）不建单次任务
  if (HABIT_INTENT.test(text) && !deadline && !/(明天|后天|下)[^，]*\d/.test(text)) return null
  if (/没睡好|没运动/.test(text)) return null
  if (!hasIntent && !deadline && !(dateExprs.length > 0 && (timeExpr || timeRange || ACTION_VERBS.test(text)))) return null
  if (hasWishMarker(text) && !deadline && !/(要|需要|得|记得|帮我|提醒我)/.test(text)) return null
  const title = cleanTitle(clause, ctx.localDate, { dropWords: [deadline?.marker] }) || text
  const fields = { title, status: 'todo', priority: 'none' }
  const day = dateExprs.length > 0 ? dateExprs[0].localDate : null
  if (deadline) {
    fields.due_date = deadline.localDate
  } else if (day && timeRange) {
    fields.scheduled_start_at = localDateTimeToIso(ctx.timeZone, day, `${String(timeRange.startHour).padStart(2, '0')}:${String(timeRange.startMinute).padStart(2, '0')}`)
    fields.scheduled_end_at = localDateTimeToIso(ctx.timeZone, timeRange.crossesMidnight ? addDays(day, 1) : day, `${String(timeRange.endHour).padStart(2, '0')}:${String(timeRange.endMinute).padStart(2, '0')}`)
    fields.time_kind = 'span'
    fields.is_all_day = false
    fields.scheduled_tz = ctx.timeZone
  } else if (day && timeExpr) {
    fields.scheduled_start_at = localDateTimeToIso(ctx.timeZone, day, `${String(timeExpr.hours).padStart(2, '0')}:${String(timeExpr.minutes).padStart(2, '0')}`)
    fields.scheduled_end_at = null
    fields.time_kind = 'datetime'
    fields.is_all_day = false
    fields.scheduled_tz = ctx.timeZone
  } else if (day) {
    fields.scheduled_date = day
    fields.time_kind = 'all_day'
    fields.is_all_day = true
  }
  const commitment = /(之前|以前|截止|截至|提醒|要|需要|得|记得|帮我|别忘)/.test(text)
  const risks = []
  if (commitment) risks.push('承诺升级，需确认')
  if (deadline) risks.push('日期作为截止时间，需确认')
  if (/(\d{1,2})月(\d{1,2})[日号]/.test(text)) risks.push('未写年份，按当前年推断')
  if (!dateExprs.length && !deadline) risks.push('无明确日期')
  return {
    kind: 'task',
    confidence: round2(clamp(CONFIDENCE.task + (deadline ? 0.08 : 0) + (dateExprs.length ? 0.05 : -0.08), 0.35, 0.92)),
    source: { quote: text, start: clause.start, end: clause.end },
    fields,
    reasons: [
      '识别到任务意图（要/需要/截止/提醒等）',
      ...(deadline ? [`识别到截止表达「${deadline.raw}」`] : []),
      ...(dateExprs.length && !deadline ? [`识别到日期「${dateExprs[0].raw}」`] : []),
    ],
    risks,
    requiresConfirm: commitment || Boolean(deadline) || (dateExprs.length > 0 && !timeExpr && !timeRange && !deadline),
  }
}

function wishCandidateForClause(clause) {
  const text = clause.quote
  if (isNegatedClause(clause)) return null
  if (!hasWishMarker(text)) return null
  if (FACT_MARKERS.test(text) && /(了|完成)/.test(text)) return null
  const object = text.replace(/^.*?(一直想|一直|想|希望|梦想|愿望|以后|将来)\s*/, '').trim()
  if (!object || object.length < 2) return null
  if (/^(了|想|一下|要)/.test(object)) return null
  const title = object.replace(/[，,。；;！!？?\s]+$/g, '').trim()
  return {
    kind: 'wish',
    confidence: round2(clamp(CONFIDENCE.wish + (title.length >= 6 ? 0.05 : 0), 0.35, 0.9)),
    source: { quote: text, start: clause.start, end: clause.end },
    fields: { title, status: 'captured' },
    reasons: ['识别到愿望线索（想/希望/以后）'],
    risks: ['愿望不等于承诺，需确认'],
    requiresConfirm: true,
  }
}

function habitCheckinCandidateForClause(clause, ctx) {
  const text = clause.quote
  if (isNegatedClause(clause)) return null
  const habitMatch = HABIT_WORDS.exec(text)
  if (!habitMatch) return null
  if (!FACT_MARKERS.test(text)) return null
  if (HABIT_INTENT.test(text) && !/(做了|完成了|打卡|练了|进行了)/.test(text)) return null
  const habitKey = habitMatch[0]
  const dateExprs = parseDateExpressions(clause, ctx.localDate)
  const localDate = dateExprs.length > 0 ? dateExprs[0].localDate : ctx.localDate
  const valueMatch = new RegExp(`([0-9]+(?:\\.[0-9]+)?|[一二两三四五六七八九十]+)\\s*(套|组|次|分钟)`).exec(text)
  const amount = valueMatch ? cnNumber(valueMatch[1]) : null
  return {
    kind: 'habit_checkin',
    confidence: round2(clamp(CONFIDENCE.habit + (valueMatch ? 0.04 : 0), 0.4, 0.92)),
    source: { quote: text, start: clause.start, end: clause.end },
    fields: {
      habit_key: habitKey,
      habit_label: habitKey,
      local_date: localDate,
      status: 'done',
      checkin_kind: 'from_event',
      ...(amount !== null && amount !== undefined ? { value_json: { amount, unit: valueMatch[2] === '分钟' ? 'min' : valueMatch[2] } } : {}),
    },
    reasons: [`识别到习惯「${habitKey}」+ 完成动作`, '作为习惯打卡候选（需匹配已有习惯）'],
    risks: ['需要匹配已有习惯对象；未匹配时需用户指定'],
    requiresConfirm: false,
  }
}

/* ────────────────────────── 主入口与输出 ────────────────────────── */

/**
 * 规则抽取主入口（纯函数；仅 candidateId 使用 ULID 生成器）。
 * @param {string} rawText
 * @param {{localDate: string, timeZone?: string, rawRecordId?: string|null}} options
 * @returns {Array<object>}
 */
export function extractCandidates(rawText, options = {}) {
  if (typeof rawText !== 'string') throw new TypeError('rawText must be a string')
  const localDate = options.localDate
  if (!isLocalDate(localDate)) throw new TypeError('options.localDate must be YYYY-MM-DD')
  const timeZone = typeof options.timeZone === 'string' && options.timeZone.length > 0 ? options.timeZone : 'Asia/Shanghai'
  const rawRecordId = typeof options.rawRecordId === 'string' ? options.rawRecordId : null
  const ctx = { localDate, timeZone, rawRecordId }

  const collected = []
  const seenMetric = new Set()
  for (const clause of splitClauses(rawText)) {
    for (const metric of metricCandidatesForClause(clause, ctx)) {
      if (seenMetric.has(metric._dedupe)) continue
      seenMetric.add(metric._dedupe)
      collected.push(metric)
    }
    const wish = wishCandidateForClause(clause)
    if (wish) {
      collected.push(wish)
      continue
    }
    const task = taskCandidateForClause(clause, ctx)
    if (task) {
      collected.push(task)
      continue
    }
    const habit = habitCheckinCandidateForClause(clause, ctx)
    if (habit) {
      collected.push(habit)
      continue
    }
    const facts = factCandidateForClause(clause, ctx)
    if (facts && facts.length > 0) collected.push(...facts)
  }
  return finalizeCandidates(collected, rawRecordId)
}

function normalizeTitleKey(title) {
  return String(title ?? '')
    .replace(/[\s，,。；;！!？?、]/g, '')
    .toLowerCase()
}

function candidateDedupeKey(candidate) {
  const f = candidate.fields ?? {}
  if (candidate.kind === 'task') return `task:${normalizeTitleKey(f.title)}`
  if (candidate.kind === 'event') {
    return `event:${f.event_type}:${String(f.occurred_start_at ?? '').slice(0, 10)}:${normalizeTitleKey(f.title)}`
  }
  if (candidate.kind === 'metric') return `metric:${f.metric_code}:${String(f.measured_at ?? '').slice(0, 10)}`
  if (candidate.kind === 'habit_checkin') return `habit:${f.habit_key}:${f.local_date}`
  if (candidate.kind === 'wish') return `wish:${normalizeTitleKey(f.title)}`
  return `${candidate.kind}:${normalizeTitleKey(candidate.source?.quote)}`
}

function finalizeCandidates(candidates, rawRecordId) {
  const out = []
  const seen = new Set()
  for (const candidate of candidates) {
    const key = candidateDedupeKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    const { _dedupe, ...rest } = candidate
    out.push({
      candidateId: newId('cand'),
      rawRecordId,
      kind: rest.kind,
      confidence: rest.confidence,
      source: rest.source,
      fields: rest.fields,
      reasons: rest.reasons,
      risks: rest.risks,
      requiresConfirm: Boolean(rest.requiresConfirm),
    })
  }
  return out
}

/**
 * 候选 → design/04 §8.4 evidence_refs（含 span 回指；供 B 落库）。
 * @param {{rawRecordId?: string|null, source?: {start:number,end:number,quote:string}, evidence_refs?: object[]}} candidate
 * @returns {Array<object>}
 */
export function buildEvidenceRefs(candidate) {
  if (!candidate || typeof candidate !== 'object' || !candidate.source) return []
  const refs = []
  if (typeof candidate.rawRecordId === 'string' && candidate.rawRecordId.length > 0) {
    const { start, end, quote } = candidate.source
    if (Number.isInteger(start) && Number.isInteger(end) && typeof quote === 'string') {
      refs.push({
        type: 'raw_record',
        id: candidate.rawRecordId,
        locator: { span: [start, end] },
        excerpt: quote,
      })
    }
  }
  if (Array.isArray(candidate.evidence_refs)) refs.push(...candidate.evidence_refs)
  return refs
}
