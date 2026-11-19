/**
 * M8 HTTP 路由集成测试：标签 PATCH / DELETE。
 * - PATCH /tags/:id：name/color（可选 expectedRev CAS）→ {tag, revision}
 * - DELETE /tags/:id：删标签并清理 entity_tag 关联 → {deleted:true,id}；任务不受影响
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createLifeosService } from '../../../src/application/lifeos-service.js'
import { createEventBus, createSseServer } from '../../../src/runtime/sse.js'
import { createRoutes } from '../../../src/runtime/routes.js'
import { createFakeStore } from '../helpers/fake-store.mjs'
import { call, callWrite } from '../helpers/fake-http.mjs'
import { newId } from '../../../src/domain/ids.js'

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

async function createTag(routes, body) {
  const res = await callWrite(routes, { method: 'POST', url: `${BASE}/tags`, body })
  assert.equal(res.status, 200, JSON.stringify(res.json()))
  return res.json().value.tag
}

async function createTask(routes, body) {
  const res = await callWrite(routes, { method: 'POST', url: `${BASE}/tasks`, body })
  assert.equal(res.status, 200, JSON.stringify(res.json()))
  return res.json().value.task
}

async function listTags(routes) {
  const res = await call(routes, { url: `${BASE}/tags` })
  assert.equal(res.status, 200)
  return res.json().value.items
}

test('PATCH /tags/:id：改名称/颜色，返回 {tag, revision}，GET /tags 生效', async () => {
  const { routes } = makeRoutes()
  const tag = await createTag(routes, { name: '工作', color: '#123456' })
  assert.equal(tag.rev, 1)

  const patched = await callWrite(routes, {
    method: 'PATCH',
    url: `${BASE}/tags/${tag.id}`,
    body: { name: '工作台', color: '#ABCDEF' },
    rev: 1,
  })
  assert.equal(patched.status, 200, JSON.stringify(patched.json()))
  const value = patched.json().value
  assert.equal(value.revision, 2)
  assert.equal(value.tag.id, tag.id)
  assert.equal(value.tag.name, '工作台')
  assert.equal(value.tag.color, '#ABCDEF')
  assert.equal(value.tag.rev, 2)

  const items = await listTags(routes)
  assert.equal(items.length, 1)
  assert.equal(items[0].name, '工作台')

  // color 可用 null 清除；只传 color 也合法。
  const cleared = await callWrite(routes, {
    method: 'PATCH',
    url: `${BASE}/tags/${tag.id}`,
    body: { color: null },
    rev: 2,
  })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json().value.tag.color, null)
  assert.equal(cleared.json().value.revision, 3)

  // 重名冲突 → 409（大小写不敏感）：other 改名成已存在的「工作台」。
  const other = await createTag(routes, { name: 'Personal' })
  const dup = await callWrite(routes, {
    method: 'PATCH',
    url: `${BASE}/tags/${other.id}`,
    body: { name: '工作台' },
    rev: 1,
  })
  assert.equal(dup.status, 409)
  assert.equal(dup.json().error.code, 'conflict')
})

test('PATCH /tags/:id：CAS 冲突 409、非法 body/颜色/ID 422、不存在 404', async () => {
  const { routes } = makeRoutes()
  const tag = await createTag(routes, { name: '标签A' })
  await callWrite(routes, {
    method: 'PATCH',
    url: `${BASE}/tags/${tag.id}`,
    body: { name: '标签B' },
    rev: 1,
  })

  // 旧 revision → 409 conflict。
  const stale = await callWrite(routes, {
    method: 'PATCH',
    url: `${BASE}/tags/${tag.id}`,
    body: { name: '标签C' },
    rev: 1,
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.json().error.code, 'conflict')

  // 非法颜色 / 空 body / 未知字段 / 空名称 → 422。
  for (const body of [{ color: 'red' }, {}, { foo: 1 }, { name: '' }, { color: '#12345' }]) {
    const res = await callWrite(routes, {
      method: 'PATCH',
      url: `${BASE}/tags/${tag.id}`,
      body,
      rev: 2,
    })
    assert.equal(res.status, 422, JSON.stringify(body))
    assert.equal(res.json().error.code, 'validation_failed')
    assert.ok(String(res.json().error.message).length > 0)
  }

  // 非法 ID → 422；合法但不存在的 tag_ → 404。
  const badId = await callWrite(routes, { method: 'PATCH', url: `${BASE}/tags/tsk_01J00000000000000000000000`, body: { name: 'x' }, rev: 1 })
  assert.equal(badId.status, 422)

  const missingId = newId('tag')
  const missing = await callWrite(routes, { method: 'PATCH', url: `${BASE}/tags/${missingId}`, body: { name: 'x' }, rev: 1 })
  assert.equal(missing.status, 404)
  assert.equal(missing.json().error.code, 'not_found')
})

test('DELETE /tags/:id：删标签 + 清理任务关联，任务仍可读、标签消失、返回 {deleted:true,id}', async () => {
  const { routes } = makeRoutes()
  const tag = await createTag(routes, { name: '项目标签' })
  const tag2 = await createTag(routes, { name: '保留标签' })
  await callWrite(routes, {
    method: 'PATCH',
    url: `${BASE}/tags/${tag.id}`,
    body: { name: '项目标签2' },
    rev: 1,
  })

  const task = await createTask(routes, { title: '带标签任务', tagIds: [tag.id, tag2.id] })
  assert.equal(task.tags.length, 2)

  const del = await callWrite(routes, {
    method: 'DELETE',
    url: `${BASE}/tags/${tag.id}?expectedRev=2`,
    // query 提供 expectedRev，无需 If-Match。
  })
  assert.equal(del.status, 200, JSON.stringify(del.json()))
  assert.deepEqual(del.json().value, { deleted: true, id: tag.id })

  // 标签消失，另一个标签仍在。
  const items = await listTags(routes)
  assert.equal(items.some((item) => item.id === tag.id), false)
  assert.equal(items.some((item) => item.id === tag2.id), true)

  // 任务本身没有被删，且仍可正常读出；被删标签从 task.tags 中消失。
  const detail = await call(routes, { url: `${BASE}/tasks/${task.id}` })
  assert.equal(detail.status, 200)
  assert.equal(detail.json().value.task.title, '带标签任务')
  assert.deepEqual(detail.json().value.task.tags.map((item) => item.id), [tag2.id])

  const list = await call(routes, { url: `${BASE}/tasks` })
  assert.equal(list.status, 200)
  assert.ok(list.json().value.items.some((item) => item.id === task.id))

  // 再删已删除标签 → 404。
  const again = await callWrite(routes, { method: 'DELETE', url: `${BASE}/tags/${tag.id}` })
  assert.equal(again.status, 404)
  assert.equal(again.json().error.code, 'not_found')
})

test('DELETE /tags/:id：CAS 冲突 409，未提供 expectedRev 时可无 CAS 删除', async () => {
  const { routes } = makeRoutes()
  const tag = await createTag(routes, { name: '冲突标签' })
  await callWrite(routes, {
    method: 'PATCH',
    url: `${BASE}/tags/${tag.id}`,
    body: { name: '冲突标签2' },
    rev: 1,
  })

  const stale = await callWrite(routes, { method: 'DELETE', url: `${BASE}/tags/${tag.id}?expectedRev=1` })
  assert.equal(stale.status, 409)
  assert.equal(stale.json().error.code, 'conflict')
  assert.ok((await listTags(routes)).some((item) => item.id === tag.id), '冲突时不得删除')

  const noCas = await callWrite(routes, { method: 'DELETE', url: `${BASE}/tags/${tag.id}` })
  assert.equal(noCas.status, 200)
  assert.deepEqual(noCas.json().value, { deleted: true, id: tag.id })
  assert.equal((await listTags(routes)).length, 0)
})
