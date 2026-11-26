import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatTaskMarkdownLine,
  formatTasksMarkdown,
  parseTasksMarkdown,
  repeatMarkOf,
  repeatRuleOf,
  MARK_PRIORITIES,
  PRIORITY_MARKS,
  TASK_MARKDOWN_KEYS,
} from '../../../src/domain/task-markdown.js'

test('task-markdown：一行任务带完整注解', () => {
  const line = formatTaskMarkdownLine({
    title: '买牛奶',
    done: false,
    listName: '生活',
    groupName: '采购',
    startDate: '2026-12-01',
    time: '19:00',
    dueDate: '2026-12-02',
    priority: 'medium',
    tags: ['家务', '外出'],
    repeatMark: 'weekly:MO,WE',
    id: 'tsk_01HX0000000000000000000001',
  })
  assert.equal(
    line,
    '- [ ] 买牛奶 @list(生活) @group(采购) @start(2026-12-01) @time(19:00) @due(2026-12-02) @priority(P2) @tag(家务) @tag(外出) @repeat(weekly:MO,WE) @id(tsk_01HX0000000000000000000001)',
  )
})

test('task-markdown：已完成行带 [x] 与 @done，none 优先级不写注解', () => {
  const line = formatTaskMarkdownLine({ title: '交报告', done: true, doneDate: '2026-11-20', priority: 'none', listName: '工作' })
  assert.equal(line, '- [x] 交报告 @list(工作) @done(2026-11-20)')
})

test('task-markdown：注解值里的右括号被替换成全角，避免解析断行', () => {
  const line = formatTaskMarkdownLine({ title: '写 (a)', listName: '工作(临时)' })
  assert.match(line, /@list\(工作（临时）\)/)
  const parsed = parseTasksMarkdown('- [ ] 标题 @list(工作（临时）)')
  assert.equal(parsed.items[0].annotations.list, '工作（临时）')
})

test('task-markdown：解析注解、忽略缩进、接受 * 与 + 与 [X]', () => {
  const text = [
    '## 生活',
    '  - [ ] 买牛奶 @list(生活) @group(采购) @due(2026-12-02) @priority(P2) @tag(家务) @tag(外出)',
    '* [X] 交报告 @list(工作) @done(2026-11-20)',
    '+ [ ] 浇花 @repeat(daily)',
    '普通段落不算任务',
    '- [ ]    ',
  ].join('\n')
  const parsed = parseTasksMarkdown(text)
  assert.equal(parsed.items.length, 3)
  assert.equal(parsed.items[0].title, '买牛奶')
  assert.deepEqual(parsed.items[0].annotations.tags, ['家务', '外出'])
  assert.equal(parsed.items[0].annotations.list, '生活')
  assert.equal(parsed.items[0].annotations.due, '2026-12-02')
  assert.equal(parsed.items[0].annotations.priority, 'medium')
  assert.equal(parsed.items[1].done, true)
  assert.equal(parsed.items[1].annotations.done, '2026-11-20')
  assert.deepEqual(parsed.items[2].annotations.repeat, { kind: 'daily' })
  assert.equal(parsed.skipped.length, 1)
  assert.match(parsed.skipped[0].reason, /没有标题/)
})

test('task-markdown：未知注解留在标题里并进报告', () => {
  const parsed = parseTasksMarkdown('- [ ] 买牛奶 @color(红) @list(生活) @when(晚)')
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].annotations.list, '生活')
  assert.match(parsed.items[0].title, /@color\(红\)/)
  assert.match(parsed.items[0].title, /@when\(晚\)/)
  assert.equal(parsed.unknown.length, 2)
  assert.deepEqual(parsed.unknown.map((entry) => entry.key), ['color', 'when'])
})

test('task-markdown：非法注解值留在标题里并说明原因', () => {
  const parsed = parseTasksMarkdown('- [ ] 任务 @due(2026/12/01) @priority(P9) @time(25:00) @repeat(hourly) @id(abc)')
  assert.equal(parsed.items.length, 1)
  const reasons = parsed.unknown.map((entry) => entry.reason).join(' | ')
  assert.match(reasons, /due 必须是 YYYY-MM-DD/)
  assert.match(reasons, /priority 只接受 P1–P4/)
  assert.match(reasons, /time 必须是 HH:MM/)
  assert.match(reasons, /repeat 类型只支持/)
  assert.match(reasons, /id 必须是 tsk_/)
  assert.equal(parsed.items[0].annotations.due, null)
  assert.deepEqual(parsed.items[0].title.split(' ').slice(1), [
    '@due(2026/12/01)',
    '@priority(P9)',
    '@time(25:00)',
    '@repeat(hourly)',
    '@id(abc)',
  ])
})

test('task-markdown：导出 → 解析往返一致（含分组、标签、重复、优先级）', () => {
  const rows = [
    { title: '买牛奶', listName: '生活', groupName: '采购', dueDate: '2026-12-02', priority: 'high', tags: ['家务'], id: 'tsk_01' },
    { title: '交报告', listName: '工作', done: true, doneDate: '2026-11-20', priority: 'low', repeatMark: 'monthly:15', id: 'tsk_02' },
    { title: '无清单任务', id: 'tsk_03' },
  ]
  const markdown = formatTasksMarkdown(rows, { generatedAt: '2026-11-26 21:00' })
  assert.match(markdown, /^# LifeOS 任务导出/m)
  assert.match(markdown, /^## 生活$/m)
  assert.match(markdown, /^## 收集箱$/m)
  const parsed = parseTasksMarkdown(markdown)
  assert.equal(parsed.items.length, 3)
  assert.equal(parsed.skipped.length, 0)
  assert.equal(parsed.unknown.length, 0)
  const milk = parsed.items[0]
  assert.equal(milk.title, '买牛奶')
  assert.equal(milk.annotations.list, '生活')
  assert.equal(milk.annotations.group, '采购')
  assert.equal(milk.annotations.due, '2026-12-02')
  assert.equal(milk.annotations.priority, 'high')
  assert.deepEqual(milk.annotations.tags, ['家务'])
  assert.equal(milk.annotations.id, 'tsk_01')
  const report = parsed.items[1]
  assert.equal(report.done, true)
  assert.equal(report.annotations.done, '2026-11-20')
  assert.deepEqual(report.annotations.repeat, { kind: 'monthly', day: 15 })
  assert.equal(parsed.items[2].annotations.list, null)
})

test('task-markdown：重复规则双向映射', () => {
  assert.equal(repeatMarkOf({ kind: 'daily' }), 'daily')
  assert.equal(repeatMarkOf({ kind: 'weekly', days: [3, 1] }), 'weekly:MO,WE')
  assert.equal(repeatMarkOf({ kind: 'monthly', day: 15 }), 'monthly:15')
  assert.equal(repeatMarkOf(null), null)
  assert.deepEqual(repeatRuleOf('weekly:we,mo'), { ok: true, value: { kind: 'weekly', days: [1, 3] } })
  assert.equal(repeatRuleOf('daily').ok, true)
  assert.equal(repeatRuleOf('weekly:XX').ok, false)
  assert.equal(repeatRuleOf('monthly:32').ok, false)
  assert.equal(repeatRuleOf('hourly').ok, false)
})

test('task-markdown：优先级与键表常量保持稳定', () => {
  assert.deepEqual(TASK_MARKDOWN_KEYS, ['list', 'group', 'due', 'start', 'done', 'time', 'priority', 'tag', 'repeat', 'id'])
  assert.deepEqual(PRIORITY_MARKS, { high: 'P1', medium: 'P2', low: 'P3', none: 'P4' })
  assert.deepEqual(MARK_PRIORITIES, { P1: 'high', P2: 'medium', P3: 'low', P4: 'none' })
})
