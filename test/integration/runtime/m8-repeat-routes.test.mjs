/**
 * M8 HTTP 路由集成测试：task.repeatRule（daily/weekly/monthly、PATCH 清空、422 校验）。
 * 直调 handler（fake store + fake req/res）。
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

test('POST /tasks：三种 repeatRule 合法形状 + weekly 去重升序 + GET 输出 camelCase', async () => {
  const { routes } = makeRoutes()

  const daily = await createTask(routes, { title: '每日', repeatRule: { kind: 'daily' } })
  assert.deepEqual(daily.task.repeatRule, { kind: 'daily' })

  // weekly 乱序 + 重复 → 去重升序；1=周一。
  const weekly = await createTask(routes, { title: '每周', repeatRule: { kind: 'weekly', days: [5, 1, 3, 3] } })
  assert.deepEqual(weekly.task.repeatRule, { kind: 'weekly', days: [1, 3, 5] })

  const monthly = await createTask(routes, { title: '每月', repeatRule: { kind: 'monthly', day: 15 } })
  assert.deepEqual(monthly.task.repeatRule, { kind: 'monthly', day: 15 })

  const plain = await createTask(routes, { title: '无重复' })
  assert.equal(plain.task.repeatRule, null)

  // 详情 + 列表都输出 repeatRule。
  const detail = await call(routes, { url: `${BASE}/tasks/${weekly.task.id}` })
  assert.equal(detail.status, 200)
  assert.deepEqual(detail.json().value.task.repeatRule, { kind: 'weekly', days: [1, 3, 5] })

  const list = await call(routes, { url: `${BASE}/tasks` })
  assert.equal(list.status, 200)
  const byId = new Map(list.json().value.items.map((task) => [task.id, task]))
  assert.deepEqual(byId.get(daily.task.id).repeatRule, { kind: 'daily' })
  assert.equal(byId.get(plain.task.id).repeatRule, null)
})

test('POST /tasks：daily 的多余字段被忽略（契约锁定）', async () => {
  const { routes } = makeRoutes()
  const created = await createTask(routes, {
    title: '日重复多余字段',
    repeatRule: { kind: 'daily', days: [1], day: 2, extra: true },
  })
  assert.deepEqual(created.task.repeatRule, { kind: 'daily' })
})

test('PATCH /tasks/:id：设置 / 覆盖 / 清空 repeatRule，null 表示清除', async () => {
  const { routes } = makeRoutes()
  const created = await createTask(routes, { title: '待重复' })
  assert.equal(created.task.repeatRule, null)

  const set = await callWrite(routes, {
    method: 'PATCH',
    url: `${BASE}/tasks/${created.task.id}`,
    body: { repeatRule: { kind: 'weekly', days: [2, 6] } },
    rev: 1,
  })
  assert.equal(set.status, 200, JSON.stringify(set.json()))
  assert.deepEqual(set.json().value.task.repeatRule, { kind: 'weekly', days: [2, 6] })
  assert.equal(set.json().value.task.rev, 2)

  const overwrite = await callWrite(routes, {
    method: 'PATCH',
    url: `${BASE}/tasks/${created.task.id}`,
    body: { repeatRule: { kind: 'monthly', day: 31 } },
    rev: 2,
  })
  assert.equal(overwrite.status, 200)
  assert.deepEqual(overwrite.json().value.task.repeatRule, { kind: 'monthly', day: 31 })

  const cleared = await callWrite(routes, {
    method: 'PATCH',
    url: `${BASE}/tasks/${created.task.id}`,
    body: { repeatRule: null },
    rev: 3,
  })
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json()))
  assert.equal(cleared.json().value.task.repeatRule, null)

  const detail = await call(routes, { url: `${BASE}/tasks/${created.task.id}` })
  assert.equal(detail.json().value.task.repeatRule, null)
  // 存储形态是 snake_case repeat_rule。
  const raw = routes && (await call(routes, { url: `${BASE}/tasks/${created.task.id}` }))
  assert.equal(raw.json().value.task.repeatRule, null)
})

test('POST /tasks：非法 repeatRule 一律 422 validation_failed 且有可读 message', async () => {
  const { routes } = makeRoutes()
  const cases = [
    { kind: 'yearly' },
    { kind: 'weekly', days: [] },
    { kind: 'weekly', days: [0] },
    { kind: 'weekly', days: [8] },
    { kind: 'weekly', days: [1.5] },
    { kind: 'monthly', day: 0 },
    { kind: 'monthly', day: 32 },
    'weekly',
  ]
  for (const repeatRule of cases) {
    const res = await callWrite(routes, { method: 'POST', url: `${BASE}/tasks`, body: { title: 'x', repeatRule } })
    assert.equal(res.status, 422, JSON.stringify(repeatRule))
    const json = res.json()
    assert.equal(json.ok, false)
    assert.equal(json.error.code, 'validation_failed')
    assert.match(String(json.error.message), /不合法|repeatRule/)
  }
})

test('PATCH /tasks/:id：非法 repeatRule 422，且不清空已有值', async () => {
  const { routes } = makeRoutes()
  const created = await createTask(routes, { title: '保持', repeatRule: { kind: 'daily' } })

  const bad = await callWrite(routes, {
    method: 'PATCH',
    url: `${BASE}/tasks/${created.task.id}`,
    body: { repeatRule: { kind: 'weekly', days: [9] } },
    rev: 1,
  })
  assert.equal(bad.status, 422)
  assert.equal(bad.json().error.code, 'validation_failed')

  const detail = await call(routes, { url: `${BASE}/tasks/${created.task.id}` })
  assert.deepEqual(detail.json().value.task.repeatRule, { kind: 'daily' })
})
