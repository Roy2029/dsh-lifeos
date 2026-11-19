/**
 * M6a 应用层集成测试：清单 / 分组 / 任务补充字段与移动 / 回收站 / 日历区间 / 笔记标签。
 * 使用 fake-backend + 真 store（走 indexes 分支）与 createLifeosService facade。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createFakeBackend } from '../../unit/store/fake-backend.mjs'
import { openLifeosStore } from '../../../src/store/lifeos-store.js'
import { createLifeosService } from '../../../src/application/lifeos-service.js'
import { createEventBus } from '../../../src/runtime/sse.js'

const TZ = 'Asia/Shanghai'
const NOW = Date.parse('2026-11-18T02:00:00.000Z')

async function makeService(t) {
  const { backend } = createFakeBackend()
  const store = await openLifeosStore(null, { backend, timeZone: TZ, testMode: true })
  t.after(async () => {
    await store.close()
  })
  const bus = createEventBus()
  const service = createLifeosService({
    store,
    config: { timeZone: TZ, devMode: false },
    diagnostics: null,
    bus,
    now: () => NOW,
  })
  return { store, service, bus }
}

function inboxOf(items) {
  return items.find((item) => item.kind === 'inbox')
}

/** 兼容同步抛错与异步 reject 的断言辅助。 */
async function expectError(fn, code) {
  try {
    await fn()
  } catch (error) {
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}：${error.message}`)
    return error
  }
  assert.fail(`期望抛出 code=${code} 的错误，但没有抛出`)
}

test('清单 CRUD：默认收集箱 + 创建/重名冲突/更新 CAS/排序/删除并迁移任务', async (t) => {
  const { service } = await makeService(t)

  const initial = service.listLists()
  assert.equal(initial.items.length, 1)
  const inbox = inboxOf(initial.items)
  assert.ok(inbox)
  assert.equal(inbox.isDefault, true)
  assert.equal(inbox.kind, 'inbox')

  const created = await service.createList({ name: '工作', color: '#f00' })
  const list = created.list
  assert.match(list.id, /^lst_/)
  assert.equal(list.name, '工作')
  assert.equal(list.kind, 'normal')
  assert.equal(list.count, 0)
  assert.equal(list.openCount, 0)
  assert.equal(list.doneCount, 0)
  assert.equal(list.rev, 1)

  await expectError(() => service.createList({ name: '工作' }), 'conflict')

  // 建任务挂到该清单，再更新清单名字，计数应保持。
  const task = (await service.createTask({ title: '写周报', listId: list.id })).task
  const updated = await service.updateList(list.id, { name: '工作台' }, 1)
  assert.equal(updated.list.name, '工作台')
  assert.equal(updated.list.rev, 2)
  assert.equal(updated.list.count, 1)
  await expectError(() => service.updateList(list.id, { name: 'x' }, 1), 'conflict')

  // 排序把新清单排到收集箱前面。
  const reordered = await service.reorderLists({ ids: [list.id, inbox.id] })
  assert.equal(reordered.items[0].id, list.id)
  assert.equal(reordered.items[0].sortOrder, 0)

  // 删除清单：任务迁回收集箱（moveTo 缺省为 null），清单消失。
  const listAfterReorder = reordered.items.find((item) => item.id === list.id)
  const deleted = await service.deleteList(list.id, { moveTo: null, expectedRev: listAfterReorder.rev })
  assert.equal(deleted.listId, list.id)
  assert.equal(deleted.moveTo, null)
  assert.equal(deleted.movedTasks, 1)
  assert.equal(service.listLists().items.some((item) => item.id === list.id), false)
  const inboxView = service.listTasks({ listId: inbox.id })
  assert.equal(inboxView.items.some((item) => item.id === task.id), true)
})

test('默认收件箱清单可删除（M8 后语义：收集箱=无清单任务）', async (t) => {
  const { service } = await makeService(t)
  const inbox = inboxOf(service.listLists().items)
  assert.ok(inbox)
  // 收集箱中的任务（无 list_id）不挂在 inbox 清单上，删清单不应影响它们。
  const inboxTask = (await service.createTask({ title: '随手一条' })).task
  assert.equal(inboxTask.listId, null)
  const deleted = await service.deleteList(inbox.id, { expectedRev: inbox.rev })
  assert.equal(deleted.listId, inbox.id)
  assert.equal(deleted.movedTasks, 0)
  assert.equal(service.listLists().items.some((item) => item.id === inbox.id), false)
  const inboxView = service.listTasks({ view: 'inbox' })
  assert.equal(inboxView.items.some((item) => item.id === inboxTask.id), true)
})

test('分组 CRUD：同一清单内创建/重名冲突/折叠更新/排序/删除迁移', async (t) => {
  const { service } = await makeService(t)
  const list = (await service.createList({ name: '项目' })).list

  const first = (await service.createGroup(list.id, { name: '本周' })).group
  const second = (await service.createGroup(list.id, { name: '下周' })).group
  assert.match(first.id, /^grp_/)
  assert.equal(first.listId, list.id)
  assert.equal(first.collapsed, false)
  assert.equal(first.count, 0)
  assert.equal(first.openCount, 0)

  await expectError(() => service.createGroup(list.id, { name: '本周' }), 'conflict')
  await expectError(() => service.createGroup('lst_00000000000000000000000000', { name: 'x' }), 'not_found')

  const collapsed = await service.updateGroup(first.id, { collapsed: true }, 1)
  assert.equal(collapsed.group.collapsed, true)
  assert.equal(collapsed.group.rev, 2)

  const listed = await service.getListGroups(list.id)
  assert.equal(listed.list.id, list.id)
  assert.equal(listed.items.length, 2)

  const reordered = await service.reorderGroups({ ids: [second.id, first.id] })
  assert.equal(reordered.items[0].id, second.id)

  // 挂任务到 first 分组，删除分组后任务移到 second。
  const task = (await service.createTask({ title: '分组任务', listId: list.id, groupId: first.id })).task
  assert.equal(task.groupId, first.id)
  const firstAfterReorder = reordered.items.find((item) => item.id === first.id)
  const deleted = await service.deleteGroup(first.id, { moveTo: second.id, expectedRev: firstAfterReorder.rev })
  assert.equal(deleted.groupId, first.id)
  assert.equal(deleted.moveTo, second.id)
  assert.equal(deleted.movedTasks, 1)
  assert.equal((await service.getListGroups(list.id)).items.length, 1)
  const reloaded = service.listTasks({ groupId: second.id })
  assert.equal(reloaded.items[0].groupId, second.id)
})

test('任务补充字段 + 层级/移动：listId/groupId/pinned/sortOrder、防环、≤3 层、子任务随父', async (t) => {
  const { service } = await makeService(t)
  const listA = (await service.createList({ name: 'A' })).list
  const listB = (await service.createList({ name: 'B' })).list
  const groupA = (await service.createGroup(listA.id, { name: 'GA' })).group
  const groupB = (await service.createGroup(listB.id, { name: 'GB' })).group

  const root = (await service.createTask({
    title: '根任务',
    listId: listA.id,
    groupId: groupA.id,
    pinned: true,
    sortOrder: 7,
  })).task
  assert.equal(root.listId, listA.id)
  assert.equal(root.groupId, groupA.id)
  assert.equal(root.pinned, true)
  assert.equal(root.sortOrder, 7)
  assert.equal(root.parentTaskId, null)

  await expectError(() => service.createTask({ title: '坏清单', listId: 'lst_00000000000000000000000000' }), 'validation_failed')
  await expectError(() => service.createTask({ title: '跨清单分组', listId: listB.id, groupId: groupA.id }), 'validation_failed')

  const child = (await service.createTask({ title: '子任务', parentTaskId: root.id })).task
  assert.equal(child.parentTaskId, root.id)
  assert.equal(child.listId, listA.id)
  assert.equal(child.groupId, groupA.id)

  const detail = service.getTaskDetail(root.id)
  assert.equal(detail.task.id, root.id)
  assert.deepEqual(detail.children.map((item) => item.id), [child.id])
  assert.deepEqual(detail.path.map((item) => item.id), [root.id])
  const childDetail = service.getTaskDetail(child.id)
  assert.deepEqual(childDetail.path.map((item) => item.id), [root.id, child.id])

  // 移动根任务到 listB/groupB：子任务随父。
  const moved = await service.moveTask(root.id, { listId: listB.id, groupId: groupB.id }, root.rev)
  assert.equal(moved.moved, 1)
  assert.equal(moved.task.listId, listB.id)
  assert.equal(moved.task.groupId, groupB.id)
  const childAfter = service.getTask(child.id)
  assert.equal(childAfter.listId, listB.id)
  assert.equal(childAfter.groupId, groupB.id)

  // 防环：把根任务挂到自己的子任务下。
  await expectError(() => service.moveTask(root.id, { parentTaskId: child.id }, moved.task.rev), 'invalid_state')

  // 深度限制：D > B > C 三层后，把 E 挂到 C 下 → 4 层被拒。
  const d = (await service.createTask({ title: 'D' })).task
  const b = (await service.createTask({ title: 'B', parentTaskId: d.id })).task
  const c = (await service.createTask({ title: 'C', parentTaskId: b.id })).task
  const e = (await service.createTask({ title: 'E' })).task
  await expectError(() => service.moveTask(e.id, { parentTaskId: c.id }, e.rev), 'invalid_state')

  // 无差异移动返回 moved=0。
  const same = await service.moveTask(root.id, { listId: listB.id, groupId: groupB.id }, moved.task.rev)
  assert.equal(same.moved, 0)
})

test('duplicate / trash / restore / purge / done 视图', async (t) => {
  const { service } = await makeService(t)
  const list = (await service.createList({ name: '回收' })).list
  const task = (await service.createTask({ title: '会被删除', listId: list.id })).task

  const duplicated = await service.duplicateTask(task.id)
  assert.match(duplicated.task.id, /^tsk_/)
  assert.equal(duplicated.task.title, '会被删除 (副本)')
  assert.equal(duplicated.task.listId, list.id)
  assert.equal(duplicated.sourceTaskId, task.id)

  const completed = (await service.createTask({ title: '会完成' })).task
  await service.completeTask(completed.id, completed.rev)
  const doneView = service.listTasks({ view: 'done' })
  assert.equal(doneView.items.some((item) => item.id === completed.id), true)

  const deleted = await service.deleteTask(task.id, { expectedRev: task.rev })
  assert.equal(deleted.task.deletedAt != null, true)
  const trash = service.listTasks({ view: 'trash' })
  assert.equal(trash.items.some((item) => item.id === task.id), true)
  const normal = service.listTasks({ view: 'all' })
  assert.equal(normal.items.some((item) => item.id === task.id), false)

  const restored = await service.restoreTask(task.id, deleted.task.rev)
  assert.equal(restored.task.deletedAt, null)
  assert.equal(service.listTasks({ view: 'trash' }).items.length, 0)

  const purged = await service.deleteTask(task.id, { purge: true, expectedRev: restored.task.rev })
  assert.equal(purged.purged, true)
  assert.equal(purged.task, null)
  assert.equal(service.getTask(task.id), null)
})

test('GET /tasks 数据面：lists 字段、listId/groupId 过滤、counts、pinned', async (t) => {
  const { service } = await makeService(t)
  const list = (await service.createList({ name: '筛选' })).list
  const group = (await service.createGroup(list.id, { name: 'G' })).group
  await service.createTask({ title: '今日任务', listId: list.id, groupId: group.id, pinned: true, scheduledDate: '2026-11-18' })
  await service.createTask({ title: '无日期任务', listId: list.id })

  const all = service.listTasks({ view: 'all', listId: list.id })
  assert.equal(all.items.length, 2)
  assert.ok(Array.isArray(all.lists))
  const listSummary = all.lists.find((item) => item.id === list.id)
  assert.equal(listSummary.count, 2)
  assert.equal(listSummary.openCount, 2)
  assert.equal(listSummary.doneCount, 0)

  const byGroup = service.listTasks({ groupId: group.id })
  assert.deepEqual(byGroup.items.map((item) => item.title), ['今日任务'])
  assert.equal(byGroup.items[0].pinned, true)

  const today = service.listTasks({ view: 'today', listId: list.id })
  assert.equal(today.items.length, 1)
  assert.equal(today.counts.today, 1)

  const ranged = service.listTasks({ from: '2026-11-18', to: '2026-11-18', listId: list.id })
  assert.equal(ranged.items.length, 1)
})

test('日历区间：day.timed / day.allDay 分组，含空白天', async (t) => {
  const { service } = await makeService(t)
  await service.createTask({ title: '全天任务', scheduledDate: '2026-11-19', isAllDay: true })
  await service.createTask({ title: '定时任务', scheduledStartAt: '2026-11-19T02:00:00.000Z', scheduledEndAt: '2026-11-19T03:00:00.000Z' })

  const calendar = service.getCalendar('2026-11-18', '2026-11-20')
  assert.equal(calendar.days.length, 3)
  assert.equal(calendar.from, '2026-11-18')
  assert.equal(calendar.to, '2026-11-20')
  const day = calendar.days.find((item) => item.date === '2026-11-19')
  assert.equal(day.tasks.length, 2)
  assert.deepEqual(day.timed.map((item) => item.title), ['定时任务'])
  assert.deepEqual(day.allDay.map((item) => item.title), ['全天任务'])
  const empty = calendar.days.find((item) => item.date === '2026-11-18')
  assert.deepEqual(empty.tasks, [])
})

test('跨清单移动：只传 listId 时旧分组自动清空，落到目标清单未分组', async (t) => {
  const { service } = await makeService(t)
  const listA = (await service.createList({ name: 'A' })).list
  const listB = (await service.createList({ name: 'B' })).list
  const groupA = (await service.createGroup(listA.id, { name: 'GA' })).group
  const task = (await service.createTask({ title: '跨清单', listId: listA.id, groupId: groupA.id })).task
  assert.equal(task.groupId, groupA.id)

  /* 客户端可能只发 listId（不带 groupId）：不应报「分组不属于目标清单」 */
  const moved = await service.updateTask(task.id, { listId: listB.id }, task.rev)
  assert.equal(moved.task.listId, listB.id)
  assert.equal(moved.task.groupId, null)

  /* 仍留在原清单时保留原分组 */
  const kept = (await service.createTask({ title: '同清单', listId: listA.id, groupId: groupA.id })).task
  const sameList = await service.updateTask(kept.id, { listId: listA.id }, kept.rev)
  assert.equal(sameList.task.listId, listA.id)
  assert.equal(sameList.task.groupId, groupA.id)
})

test('笔记标签：读取默认值 / 写入 CAS / 批量合并与删除', async (t) => {
  const { service } = await makeService(t)

  const empty = service.getNotesTags()
  assert.deepEqual(empty.tags, {})
  assert.equal(empty.version, 1)
  assert.equal(empty.rev, 0)

  const written = await service.putNotesTags({ tags: { 'a.md': ['x', 'y'], 'b.md': ['z'] } })
  assert.equal(written.rev, 1)
  assert.deepEqual(written.tags['a.md'], ['x', 'y'])

  await expectError(() => service.putNotesTags({ tags: {}, expectedRev: 99 }), 'conflict')

  const batched = await service.batchNotesTags({
    updates: [{ path: 'a.md', tags: ['y', 'new'] }],
    removePaths: ['b.md'],
    expectedRev: 1,
  })
  assert.equal(batched.rev, 2)
  assert.deepEqual(batched.tags['a.md'], ['y', 'new'])
  assert.equal('b.md' in batched.tags, false)

  const reloaded = service.getNotesTags()
  assert.equal(reloaded.rev, 2)
  assert.deepEqual(reloaded.tags['a.md'], ['y', 'new'])
})
