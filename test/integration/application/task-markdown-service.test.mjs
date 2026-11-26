/**
 * M19 #20：任务 ⇄ Markdown 服务层集成测试（fake store，不起 HTTP）。
 * 覆盖：导出格式、导入 dryRun/真实写入、清单/分组/标签解析与自动创建、
 * 截止+时间归一、重复规则、去重跳过、@id 更新、未知注解与空内容报错。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createLifeosService } from '../../../src/application/lifeos-service.js'
import { createEventBus } from '../../../src/runtime/sse.js'
import { createFakeStore } from '../helpers/fake-store.mjs'

const NOW = Date.parse('2026-11-13T02:00:00.000Z')

function makeService() {
  const store = createFakeStore()
  const events = []
  const bus = createEventBus()
  bus.subscribe((event) => events.push(event))
  const service = createLifeosService({
    store,
    config: { timeZone: 'Asia/Shanghai', devMode: false },
    diagnostics: null,
    bus,
    now: () => NOW,
  })
  return { service, store, events }
}

async function seed(service) {
  const life = await service.createList({ name: '生活' })
  const shop = await service.createGroup(life.list.id, { name: '采购' })
  const tag = await service.createTag({ name: '家务' })
  return { life: life.list, shop: shop.group, tag: tag.tag }
}

function countTasks(store) {
  return store.entries('lifeos', 'task').filter(([, record]) => !record.deleted_at).length
}

test('exportTasksMarkdown：按清单分块并写全注解', async () => {
  const { service } = makeService()
  const { life, shop, tag } = await seed(service)
  const created = await service.createTask({
    title: '买牛奶',
    listId: life.id,
    groupId: shop.id,
    tagIds: [tag.id],
    priority: 'medium',
    dueDate: '2026-12-02',
    repeatRule: { kind: 'weekly', days: [1, 3] },
  })
  const done = await service.createTask({ title: '交报告', listId: life.id })
  await service.completeTask(done.task.id, done.task.rev)

  const result = service.exportTasksMarkdown({})
  assert.equal(result.count, 2)
  assert.match(result.markdown, /^# LifeOS 任务导出/m)
  assert.match(result.markdown, /^## 生活$/m)
  assert.match(
    result.markdown,
    new RegExp(`- \\[ \\] 买牛奶 @list\\(生活\\) @group\\(采购\\) @due\\(2026-12-02\\) @priority\\(P2\\) @tag\\(家务\\) @repeat\\(weekly:MO,WE\\) @id\\(${created.task.id}\\)`),
  )
  assert.match(result.markdown, new RegExp(`- \\[x\\] 交报告 @list\\(生活\\) @done\\(2026-11-13\\) @id\\(${done.task.id}\\)`))
})

test('exportTasksMarkdown：includeDone=false 时不含已完成任务', async () => {
  const { service } = makeService()
  const open = await service.createTask({ title: '未完成' })
  const done = await service.createTask({ title: '已完成' })
  await service.completeTask(done.task.id, done.task.rev)
  const result = service.exportTasksMarkdown({ includeDone: false })
  assert.equal(result.count, 1)
  assert.match(result.markdown, new RegExp(open.task.id))
  assert.doesNotMatch(result.markdown, /已完成/)
})

test('importTasksMarkdown dryRun：只报告不写库', async () => {
  const { service, store } = makeService()
  const before = countTasks(store)
  const result = await service.importTasksMarkdown({
    dryRun: true,
    text: ['- [ ] 买牛奶 @list(生活) @group(采购) @due(2026-12-02) @priority(P1)', '- [ ] 写周报 @list(工作)'].join('\n'),
  })
  assert.equal(result.dryRun, true)
  assert.equal(result.total, 2)
  assert.equal(result.created, 2)
  assert.equal(result.updated, 0)
  assert.deepEqual([...result.createdLists].sort(), ['生活', '工作'].sort())
  assert.equal(result.createdGroups.length, 1)
  assert.equal(countTasks(store), before)
})

test('importTasksMarkdown：自动建清单/分组/标签并写对字段', async () => {
  const { service, store } = makeService()
  const result = await service.importTasksMarkdown({
    text: [
      '- [ ] 买牛奶 @list(生活) @group(采购) @due(2026-12-02) @time(19:00) @priority(P1) @tag(家务) @tag(外出)',
      '- [x] 交报告 @list(工作) @done(2026-11-20)',
    ].join('\n'),
  })
  assert.equal(result.created, 2)
  assert.equal(result.errors.length, 0)
  assert.deepEqual([...result.createdLists].sort(), ['工作', '生活'].sort())
  assert.deepEqual(result.createdGroups, ['采购'])
  assert.deepEqual([...result.createdTags].sort(), ['外出', '家务'].sort())

  const records = store.entries('lifeos', 'task').map(([, record]) => record)
  assert.equal(records.length, 2)
  const milk = records.find((task) => task.title === '买牛奶')
  assert.equal(milk.priority, 'high')
  assert.equal(milk.due_date, null)
  assert.equal(milk.due_at, '2026-12-02T11:00:00.000Z')
  assert.equal(milk.group_id !== null, true)
  assert.equal(store.entries('lifeos', 'entity_tag').filter(([, link]) => link.entity_id === milk.id).length, 2)
  const report = records.find((task) => task.title === '交报告')
  assert.equal(report.status, 'done')
  assert.equal(countTasks(store), 2)
})

test('importTasksMarkdown：同「清单+标题+截止」重复导入被跳过', async () => {
  const { service } = makeService()
  const text = '- [ ] 买牛奶 @list(生活) @due(2026-12-02)'
  const first = await service.importTasksMarkdown({ text })
  assert.equal(first.created, 1)
  const second = await service.importTasksMarkdown({ text })
  assert.equal(second.created, 0)
  assert.equal(second.skipped, 1)
  assert.equal(second.skippedLines.length, 1)
  assert.match(second.skippedLines[0].reason, /已存在同名任务/)
})

test('importTasksMarkdown：带 @id 时更新既有任务', async () => {
  const { service } = makeService()
  const created = await service.createTask({ title: '旧标题' })
  const result = await service.importTasksMarkdown({
    text: `- [ ] 新标题 @priority(P1) @id(${created.task.id})`,
  })
  assert.equal(result.updated, 1)
  assert.equal(result.created, 0)
  const task = service.getTask(created.task.id)
  assert.equal(task.title, '新标题')
  assert.equal(task.priority, 'high')
})

test('importTasksMarkdown：未知注解进报告、标题保留、空内容报错', async () => {
  const { service } = makeService()
  const result = await service.importTasksMarkdown({ text: '- [ ] 任务A @color(红) @due(2026/12/01)' })
  assert.equal(result.created, 1)
  assert.equal(result.unknown.length, 2)
  assert.equal(result.unknown[0].key, 'color')
  const task = service.listTasks({ view: 'all' }).items[0]
  assert.match(task.title, /@color\(红\)/)

  await assert.rejects(
    () => service.importTasksMarkdown({ text: '   ' }),
    (error) => error.code === 'validation_failed' && /Markdown 内容为空/.test(error.message),
  )
})

test('导出 → 导入往返：写一封 Markdown 再导入得到同样字段', async () => {
  const { service, store } = makeService()
  const { life, shop, tag } = await seed(service)
  await service.createTask({
    title: '买牛奶',
    listId: life.id,
    groupId: shop.id,
    tagIds: [tag.id],
    priority: 'low',
    dueDate: '2026-12-03',
    repeatRule: { kind: 'monthly', day: 15 },
  })
  const exported = service.exportTasksMarkdown({})
  // 删掉原任务后再导入，模拟「导出-编辑-导回」的独立路径
  const original = service.listTasks({ view: 'all' }).items[0]
  await service.deleteTask(original.id, { expectedRev: original.rev })
  const imported = await service.importTasksMarkdown({ text: exported.markdown })
  assert.equal(imported.created, 1)
  const task = store.entries('lifeos', 'task').map(([, record]) => record).find((record) => record.title === '买牛奶')
  assert.equal(task.title, '买牛奶')
  assert.equal(task.list_id, life.id)
  assert.equal(task.group_id, shop.id)
  assert.equal(task.priority, 'low')
  assert.equal(task.due_date, '2026-12-03')
  assert.deepEqual(task.repeat_rule, { kind: 'monthly', day: 15 })
  assert.equal(store.entries('lifeos', 'entity_tag').filter(([, link]) => link.entity_id === task.id).length, 1)
})
