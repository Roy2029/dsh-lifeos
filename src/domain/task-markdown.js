/**
 * 任务 ⇄ Markdown（M19 #20）。
 *
 * 纯函数、零依赖、无 I/O：`formatTasksMarkdown` 把任务视图行写成带行尾 `@` 注解的
 * Markdown 列表；`parseTasksMarkdown` 把同样的列表解析回注解对象。
 *
 * 语法（用户 2026-11-26 确认）：
 *   - [ ] 买牛奶 @list(生活) @group(采购) @due(2026-12-01) @time(19:00) @priority(P2) @tag(家务) @repeat(weekly:MO,WE) @id(tsk_...)
 *   - [x] 已完成的事 @list(工作) @done(2026-11-20) @id(tsk_...)
 *
 * 规则：
 * - 只有 `- [ ]` / `- [x]`（以及 `*` / `+`）开头的行才是任务；缩进忽略（不建层级）。
 * - 标题 = 首个合法 `@key(值)` 之前的文本；未知或非法注解原样留在标题里，并进报告。
 * - 已知键：list/group/due/start/done/time/priority/tag/repeat/id；`tag` 可重复。
 */

export const TASK_MARKDOWN_KEYS = Object.freeze([
  'list',
  'group',
  'due',
  'start',
  'done',
  'time',
  'priority',
  'tag',
  'repeat',
  'id',
])

/** Host 优先级 → Markdown 标记（P4 表示 none，导出时可省略）。 */
export const PRIORITY_MARKS = Object.freeze({ high: 'P1', medium: 'P2', low: 'P3', none: 'P4' })

/** Markdown 标记 → Host 优先级。 */
export const MARK_PRIORITIES = Object.freeze({ P1: 'high', P2: 'medium', P3: 'low', P4: 'none' })

const TASK_LINE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const TIME_KEY = /^([01]\d|2[0-3]):[0-5]\d$/
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const REPEAT_WEEKDAY_INDEX = Object.freeze({ MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 })

/** 标题里的换行折成空格（标题本身允许括号，不动它）。 */
function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

/** 注解值里不能出现括号，否则解析会断行；统一成全角括号。 */
function cleanValue(value) {
  return cleanText(value)
    .replace(/\(/g, '（')
    .replace(/\)/g, '）')
}

/** 重复规则 → `daily` / `weekly:MO,WE` / `monthly:15`。 */
export function repeatMarkOf(rule) {
  if (!rule || typeof rule !== 'object') return null
  if (rule.kind === 'daily') return 'daily'
  if (rule.kind === 'weekly' && Array.isArray(rule.days) && rule.days.length) {
    const marks = rule.days
      .map((day) => Number(day))
      .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
      .sort((a, b) => a - b)
      .map((day) => WEEKDAYS[day - 1])
      .filter(Boolean)
    if (marks.length) return 'weekly:' + marks.join(',')
    return null
  }
  if (rule.kind === 'monthly' && Number.isInteger(rule.day)) return 'monthly:' + rule.day
  return null
}

/** `daily` / `weekly:MO,WE` / `monthly:15` → repeat_rule 对象。 */
export function repeatRuleOf(mark) {
  const text = String(mark == null ? '' : mark).trim()
  if (!text) return { ok: false, error: 'repeat 不能为空' }
  const [kind, rest] = text.split(':')
  if (kind === 'daily') {
    if (rest) return { ok: false, error: 'repeat(daily) 不接受额外参数' }
    return { ok: true, value: { kind: 'daily' } }
  }
  if (kind === 'weekly') {
    const days = []
    for (const piece of String(rest || '').split(',')) {
      const key = piece.trim().toUpperCase()
      const day = REPEAT_WEEKDAY_INDEX[key]
      if (!day) return { ok: false, error: `repeat 的星期写法不合法：${piece}（允许 MO..SU）` }
      if (!days.includes(day)) days.push(day)
    }
    if (!days.length) return { ok: false, error: 'repeat(weekly:...) 至少给一个星期' }
    days.sort((a, b) => a - b)
    return { ok: true, value: { kind: 'weekly', days } }
  }
  if (kind === 'monthly') {
    const day = Number(rest)
    if (!Number.isInteger(day) || day < 1 || day > 31) return { ok: false, error: `repeat(monthly:...) 的日期必须是 1..31：${rest}` }
    return { ok: true, value: { kind: 'monthly', day } }
  }
  return { ok: false, error: `repeat 类型只支持 daily/weekly/monthly：${text}` }
}

/**
 * 一行任务 → Markdown 文本。
 *
 * @param {object} row {title, done, priority, listName, groupName, startDate, dueDate,
 *   doneDate, time, tags:[name], repeatMark, id, indent}
 */
export function formatTaskMarkdownLine(row) {
  const source = row || {}
  const parts = []
  const title = cleanText(source.title) || '未命名任务'
  parts.push((source.indent || '') + '- [' + (source.done ? 'x' : ' ') + '] ' + title)
  if (source.listName) parts.push('@list(' + cleanValue(source.listName) + ')')
  if (source.groupName) parts.push('@group(' + cleanValue(source.groupName) + ')')
  if (source.startDate && DATE_KEY.test(source.startDate)) parts.push('@start(' + source.startDate + ')')
  if (source.time && TIME_KEY.test(source.time)) parts.push('@time(' + source.time + ')')
  if (source.dueDate && DATE_KEY.test(source.dueDate)) parts.push('@due(' + source.dueDate + ')')
  const mark = PRIORITY_MARKS[source.priority]
  if (mark && mark !== 'P4') parts.push('@priority(' + mark + ')')
  for (const tag of source.tags || []) {
    const name = cleanValue(tag)
    if (name) parts.push('@tag(' + name + ')')
  }
  if (source.repeatMark) parts.push('@repeat(' + cleanValue(source.repeatMark) + ')')
  if (source.doneDate && DATE_KEY.test(source.doneDate)) parts.push('@done(' + source.doneDate + ')')
  if (source.id) parts.push('@id(' + cleanValue(source.id) + ')')
  return parts.join(' ')
}

/**
 * 任务行 → 带 `## 清单名` 分块的 Markdown 文档。
 *
 * @param {Array<object>} rows
 * @param {{title?: string, generatedAt?: string, includeFooter?: boolean}} [options]
 */
export function formatTasksMarkdown(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : []
  const title = options.title || 'LifeOS 任务导出'
  const lines = ['# ' + title]
  if (options.generatedAt) lines.push('', '> 导出时间：' + options.generatedAt)
  lines.push('')
  const groups = []
  for (const row of list) {
    const name = row && row.listName ? cleanValue(row.listName) : '收集箱'
    let bucket = groups.find((item) => item.name === name)
    if (!bucket) {
      bucket = { name, rows: [] }
      groups.push(bucket)
    }
    bucket.rows.push(row)
  }
  for (const bucket of groups) {
    lines.push('## ' + bucket.name, '')
    for (const row of bucket.rows) lines.push(formatTaskMarkdownLine(row))
    lines.push('')
  }
  if (options.includeFooter !== false) {
    lines.push('---', '', '注解：`@list` 清单、`@group` 分组、`@start` 开始日期、`@time` 时间、`@due` 截止、')
    lines.push('`@priority` P1–P4、`@tag` 标签（可多个）、`@repeat` 重复、`@done` 完成日期、`@id` 任务 id。', '')
  }
  return lines.join('\n')
}

function pushUnknown(report, entry) {
  if (report.length >= 50) return
  report.push(entry)
}

/**
 * Markdown → 任务注解列表。
 *
 * @param {string} text
 * @returns {{items: Array<object>, skipped: Array<{line:number,reason:string}>, unknown: Array<object>}}
 */
export function parseTasksMarkdown(text) {
  const source = String(text == null ? '' : text).replace(/\r\n?/g, '\n')
  const lines = source.split('\n')
  const items = []
  const skipped = []
  const unknown = []
  const tokenPattern = /@([A-Za-z][A-Za-z0-9_]*)\(([^)]*)\)/g
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = TASK_LINE.exec(line)
    if (!match) continue
    const lineNo = index + 1
    const checked = match[1].toLowerCase() === 'x'
    const rest = match[2]
    const first = /@([A-Za-z][A-Za-z0-9_]*)\(/.exec(rest)
    const head = first ? rest.slice(0, first.index) : rest
    const tail = first ? rest.slice(first.index) : ''
    const annotations = { list: null, group: null, due: null, start: null, done: null, time: null, priority: null, tags: [], repeat: null, id: null }
    const kept = []
    tokenPattern.lastIndex = 0
    let token = tokenPattern.exec(tail)
    while (token) {
      const key = token[1]
      const raw = token[2].trim()
      if (!TASK_MARKDOWN_KEYS.includes(key)) {
        kept.push(token[0])
        pushUnknown(unknown, { line: lineNo, key, value: raw, reason: '未知注解，已保留在标题里' })
      } else if (key === 'tag') {
        if (raw) annotations.tags.push(raw)
        else kept.push(token[0])
      } else if (key === 'priority') {
        const priority = MARK_PRIORITIES[raw.toUpperCase()]
        if (priority) annotations.priority = priority
        else {
          kept.push(token[0])
          pushUnknown(unknown, { line: lineNo, key, value: raw, reason: 'priority 只接受 P1–P4' })
        }
      } else if (key === 'due' || key === 'start' || key === 'done') {
        if (DATE_KEY.test(raw)) annotations[key] = raw
        else {
          kept.push(token[0])
          pushUnknown(unknown, { line: lineNo, key, value: raw, reason: `${key} 必须是 YYYY-MM-DD` })
        }
      } else if (key === 'time') {
        if (TIME_KEY.test(raw)) annotations.time = raw
        else {
          kept.push(token[0])
          pushUnknown(unknown, { line: lineNo, key, value: raw, reason: 'time 必须是 HH:MM' })
        }
      } else if (key === 'repeat') {
        const rule = repeatRuleOf(raw)
        if (rule.ok) annotations.repeat = rule.value
        else {
          kept.push(token[0])
          pushUnknown(unknown, { line: lineNo, key, value: raw, reason: rule.error })
        }
      } else if (key === 'id') {
        if (/^tsk_[0-9A-Za-z]+$/.test(raw)) annotations.id = raw
        else {
          kept.push(token[0])
          pushUnknown(unknown, { line: lineNo, key, value: raw, reason: 'id 必须是 tsk_ 开头的任务 ID' })
        }
      } else {
        annotations[key] = raw || null
      }
      token = tokenPattern.exec(tail)
    }
    const title = [head.trim()].concat(kept).join(' ').trim()
    if (!title) {
      skipped.push({ line: lineNo, reason: '任务行没有标题' })
      continue
    }
    items.push({ line: lineNo, title, done: checked, annotations })
  }
  return { items, skipped, unknown }
}
