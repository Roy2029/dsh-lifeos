/**
 * M6a HTTP 路由集成测试：清单 / 分组 / 任务补充 / 日历区间 / 笔记标签。
 * 直调 handler（fake store + fake req/res），覆盖成功 + 422/404/409。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createLifeosService } from '../../../src/application/lifeos-service.js'
import { createEventBus, createSseServer } from '../../../src/runtime/sse.js'
import { createRoutes } from '../../../src/runtime/routes.js'
import { createFakeStore } from '../helpers/fake-store.mjs'
import { call, callWrite } from '../helpers/fake-http.mjs'

const NOW = Date.parse('2026-11-18T02:00:00.000Z')
const BASE = '/api/lifeos'

function makeRoutes() {
  const store = createFakeStore()
  const bus = createEventBus()
  const sse = createSseServer({ bus, heartbeatMs: 60000, setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} })
  const service = createLifeosService({
    store,
    config: { timeZone: 'Asia/Shanghai', devMode: false },
    diagnostics: null,
    bus,
    now: () => NOW,
  })
  const routes = createRoutes({ service, diagnostics: null, sse, config: { devMode: false } })
  return { routes, service }
}

async function createTask(routes, body) {
  const res = await callWrite(routes, { method: 'POST', url: `${BASE}/tasks`, body })
  assert.equal(res.status, 200, JSON.stringify(res.json()))
  return res.json().value
}

async function createList(routes, name) {
  const res = await callWrite(routes, { method: 'POST', url: `${BASE}/lists`, body: { name } })
  assert.equal(res.status, 200, JSON.stringify(res.json()))
  return res.json().value.list
}

test('HTTP 清单：GET/POST 冲突/PATCH CAS/排序/DELETE 迁移任务', async () => {
  const { routes } = makeRoutes()

  const initial = await call(routes, { url: `${BASE}/lists` })
  assert.equal(initial.status, 200)
  assert.deepEqual(initial.json().value.items, [])

  const list = await createList(routes, '工作')
  assert.equal(list.name, '工作')

  const conflict = await callWrite(routes, { method: 'POST', url: `${BASE}/lists`, body: { name: '工作' } })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.json().error.code, 'conflict')

  const patch = await callWrite(routes, { method: 'PATCH', url: `${BASE}/lists/${list.id}`, body: { name: '工作台' }, rev: 1 })
  assert.equal(patch.status, 200)
  assert.equal(patch.json().value.list.name, '工作台')
  assert.equal(patch.json().value.list.rev, 2)

  const noRev = await callWrite(routes, { method: 'PATCH', url: `${BASE}/lists/${list.id}`, body: { name: 'x' } })
  assert.equal(noRev.status, 422)

  const task = await createTask(routes, { title: '清单任务', listId: list.id })
  assert.equal(task.task.listId, list.id)

  const reorder = await callWrite(routes, { method: 'POST', url: `${BASE}/lists/reorder`, body: { ids: [list.id] } })
  assert.equal(reorder.status, 200)
  assert.equal(reorder.json().value.items[0].id, list.id)

  const del = await callWrite(routes, {
    method: 'DELETE',
    url: `${BASE}/lists/${list.id}?moveTo=`,
    rev: 3,
  })
  assert.equal(del.status, 200, JSON.stringify(del.json()))
  assert.equal(del.json().value.listId, list.id)
  assert.equal(del.json().value.movedTasks, 1)
})

test('HTTP 分组：列表/创建/更新折叠/排序/删除迁移', async () => {
  const { routes } = makeRoutes()
  const list = await createList(routes, '项目')

  const created = await callWrite(routes, { method: 'POST', url: `${BASE}/lists/${list.id}/groups`, body: { name: '本周' } })
  assert.equal(created.status, 200)
  const group = created.json().value.group
  assert.match(group.id, /^grp_/)

  const second = await callWrite(routes, { method: 'POST', url: `${BASE}/lists/${list.id}/groups`, body: { name: '下周' } })
  assert.equal(second.status, 200)

  const listed = await call(routes, { url: `${BASE}/lists/${list.id}/groups` })
  assert.equal(listed.status, 200)
  assert.equal(listed.json().value.items.length, 2)
  assert.equal(listed.json().value.list.id, list.id)

  const folded = await callWrite(routes, { method: 'PATCH', url: `${BASE}/groups/${group.id}`, body: { collapsed: true }, rev: 1 })
  assert.equal(folded.status, 200)
  assert.equal(folded.json().value.group.collapsed, true)

  const reorder = await callWrite(routes, { method: 'POST', url: `${BASE}/groups/reorder`, body: { ids: [second.json().value.group.id, group.id] } })
  assert.equal(reorder.status, 200)
  assert.equal(reorder.json().value.items[0].id, second.json().value.group.id)

  const badGroup = await callWrite(routes, { method: 'POST', url: `${BASE}/lists/${list.id}/groups`, body: { name: '本周' } })
  assert.equal(badGroup.status, 409)

  const task = await createTask(routes, { title: '分组任务', listId: list.id, groupId: group.id })
  assert.equal(task.task.groupId, group.id)

  const del = await callWrite(routes, {
    method: 'DELETE',
    url: `${BASE}/groups/${group.id}?moveTo=${second.json().value.group.id}`,
    rev: 3,
  })
  assert.equal(del.status, 200, JSON.stringify(del.json()))
  assert.equal(del.json().value.movedTasks, 1)
})

test('HTTP 任务补充：字段/移动 CAS/防环/duplicate/详情/trash 视图', async () => {
  const { routes } = makeRoutes()
  const listA = await createList(routes, 'A')
  const listB = await createList(routes, 'B')

  const created = await createTask(routes, { title: '根', listId: listA.id, pinned: true, sortOrder: 3 })
  const root = created.task
  assert.equal(root.pinned, true)
  assert.equal(root.sortOrder, 3)
  assert.equal(root.listId, listA.id)

  const invalid = await callWrite(routes, { method: 'POST', url: `${BASE}/tasks`, body: { title: 'x', listId: 'lst_00000000000000000000000000' } })
  assert.equal(invalid.status, 422)
  assert.equal(invalid.json().error.code, 'validation_failed')

  const child = await createTask(routes, { title: '子', parentTaskId: root.id })

  const moveNoRev = await callWrite(routes, { method: 'POST', url: `${BASE}/tasks/${root.id}/move`, body: { listId: listB.id } })
  assert.equal(moveNoRev.status, 422)

  const moved = await callWrite(routes, { method: 'POST', url: `${BASE}/tasks/${root.id}/move`, body: { listId: listB.id }, rev: root.rev })
  assert.equal(moved.status, 200, JSON.stringify(moved.json()))
  assert.equal(moved.json().value.task.listId, listB.id)
  assert.equal(moved.json().value.moved, 1)

  const cycle = await callWrite(routes, { method: 'POST', url: `${BASE}/tasks/${root.id}/move`, body: { parentTaskId: child.task.id }, rev: moved.json().value.task.rev })
  assert.equal(cycle.status, 409)
  assert.equal(cycle.json().error.code, 'invalid_state')

  const detail = await call(routes, { url: `${BASE}/tasks/${root.id}` })
  assert.equal(detail.status, 200)
  assert.equal(detail.json().value.task.id, root.id)
  assert.equal(detail.json().value.children.length, 1)
  assert.equal(detail.json().value.path[0].id, root.id)

  const dup = await callWrite(routes, { method: 'POST', url: `${BASE}/tasks/${root.id}/duplicate`, body: {} })
  assert.equal(dup.status, 200)
  assert.match(dup.json().value.task.id, /^tsk_/)

  const deleted = await callWrite(routes, { method: 'DELETE', url: `${BASE}/tasks/${root.id}`, rev: moved.json().value.task.rev })
  assert.equal(deleted.status, 200)
  const trash = await call(routes, { url: `${BASE}/tasks?view=trash` })
  assert.equal(trash.status, 200)
  assert.equal(trash.json().value.items.some((item) => item.id === root.id), true)
  const doneInvalid = await call(routes, { url: `${BASE}/tasks?view=nope` })
  assert.equal(doneInvalid.status, 422)

  const restored = await callWrite(routes, {
    method: 'POST',
    url: `${BASE}/tasks/${root.id}/restore`,
    body: { expectedRev: deleted.json().value.task.rev },
  })
  assert.equal(restored.status, 200)
  assert.equal(restored.json().value.task.deletedAt, null)

  const purged = await callWrite(routes, {
    method: 'DELETE',
    url: `${BASE}/tasks/${root.id}?purge=1`,
    rev: restored.json().value.task.rev,
  })
  assert.equal(purged.status, 200, JSON.stringify(purged.json()))
  assert.equal(purged.json().value.purged, true)
})

test('HTTP 任务列表 M6 参数：listId/groupId/from-to/lists/done 视图', async () => {
  const { routes } = makeRoutes()
  const list = await createList(routes, '筛选')
  const groupRes = await callWrite(routes, { method: 'POST', url: `${BASE}/lists/${list.id}/groups`, body: { name: 'G' } })
  const group = groupRes.json().value.group

  const day = await createTask(routes, { title: '今天', listId: list.id, groupId: group.id, scheduledDate: '2026-11-18' })
  await createTask(routes, { title: '无日期', listId: list.id })

  const filtered = await call(routes, { url: `${BASE}/tasks?view=all&listId=${list.id}` })
  assert.equal(filtered.status, 200)
  assert.equal(filtered.json().value.items.length, 2)
  assert.ok(Array.isArray(filtered.json().value.lists))
  const summary = filtered.json().value.lists.find((item) => item.id === list.id)
  assert.equal(summary.count, 2)
  assert.equal(summary.openCount, 2)
  assert.equal(summary.doneCount, 0)

  const byGroup = await call(routes, { url: `${BASE}/tasks?groupId=${group.id}` })
  assert.equal(byGroup.json().value.items.length, 1)

  const ranged = await call(routes, { url: `${BASE}/tasks?from=2026-11-18&to=2026-11-18&listId=${list.id}` })
  assert.equal(ranged.json().value.items.length, 1)

  await callWrite(routes, { method: 'POST', url: `${BASE}/tasks/${day.task.id}/complete`, body: {}, rev: day.rev })

  const done = await call(routes, { url: `${BASE}/tasks?view=done&listId=${list.id}` })
  assert.equal(done.status, 200)
  assert.equal(done.json().value.items.some((item) => item.id === day.task.id), true)

  const filteredAfter = await call(routes, { url: `${BASE}/tasks?view=all&listId=${list.id}` })
  const summaryAfter = filteredAfter.json().value.lists.find((item) => item.id === list.id)
  assert.equal(summaryAfter.doneCount, 1)
  assert.equal(summaryAfter.openCount, 1)

  const badDate = await call(routes, { url: `${BASE}/tasks?from=2026-11-19&to=2026-11-18` })
  assert.equal(badDate.status, 422)
})

test('HTTP 日历区间：from/to、timed/allDay、month 兼容、非法 422', async () => {
  const { routes } = makeRoutes()
  await createTask(routes, { title: '全天', scheduledDate: '2026-11-19', isAllDay: true })
  await createTask(routes, { title: '定时', scheduledStartAt: '2026-11-19T02:00:00.000Z', scheduledEndAt: '2026-11-19T03:00:00.000Z' })

  const res = await call(routes, { url: `${BASE}/calendar?from=2026-11-18&to=2026-11-20` })
  assert.equal(res.status, 200)
  assert.equal(res.json().value.days.length, 3)
  const day = res.json().value.days.find((item) => item.date === '2026-11-19')
  assert.equal(day.timed.length, 1)
  assert.equal(day.allDay.length, 1)

  const month = await call(routes, { url: `${BASE}/calendar?month=2026-11` })
  assert.equal(month.status, 200)
  assert.equal(month.json().value.from, '2026-11-01')
  assert.equal(month.json().value.to, '2026-11-30')
  assert.equal(month.json().value.days.length, 30)

  const missing = await call(routes, { url: `${BASE}/calendar` })
  assert.equal(missing.status, 422)
})

test('HTTP 笔记标签：GET/PUT/batch + CAS 409 + 校验 422', async () => {
  const { routes } = makeRoutes()

  const empty = await call(routes, { url: `${BASE}/notes/tags` })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json().value.tags, {})

  const put = await callWrite(routes, { method: 'PUT', url: `${BASE}/notes/tags`, body: { tags: { 'a.md': ['x'] } } })
  assert.equal(put.status, 200)
  assert.equal(put.json().value.rev, 1)
  assert.deepEqual(put.json().value.tags['a.md'], ['x'])

  const stale = await callWrite(routes, { method: 'PUT', url: `${BASE}/notes/tags`, body: { tags: {}, expectedRev: 99 } })
  assert.equal(stale.status, 409)
  assert.equal(stale.json().error.code, 'conflict')

  const batch = await callWrite(routes, {
    method: 'POST',
    url: `${BASE}/notes/tags/batch`,
    body: { updates: [{ path: 'b.md', tags: ['y'] }], removePaths: ['a.md'], expectedRev: 1 },
  })
  assert.equal(batch.status, 200, JSON.stringify(batch.json()))
  assert.deepEqual(batch.json().value.tags['b.md'], ['y'])
  assert.equal('a.md' in batch.json().value.tags, false)

  const invalid = await callWrite(routes, { method: 'PUT', url: `${BASE}/notes/tags`, body: { tags: { '': ['x'] } } })
  assert.equal(invalid.status, 422)

  const unknown = await call(routes, { url: `${BASE}/notes/tags/nope` })
  assert.equal(unknown.status, 404)
})
