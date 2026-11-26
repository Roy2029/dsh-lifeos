/**
 * M19 #20 HTTP 路由集成测试：任务 ⇄ Markdown（导出 / 导入 / 校验）。
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
  return { routes, store, service }
}

test('GET /markdown/tasks：导出信封含 markdown/count，includeDone=0 过滤已完成', async () => {
  const { routes } = makeRoutes()
  const created = await callWrite(routes, {
    method: 'POST',
    url: `${BASE}/tasks`,
    body: { title: '买牛奶', dueDate: '2026-12-02', priority: 'medium' },
  })
  assert.equal(created.status, 200, JSON.stringify(created.json()))
  const open = created.json().value.task

  const first = await call(routes, { url: `${BASE}/markdown/tasks` })
  assert.equal(first.status, 200, JSON.stringify(first.json()))
  const value = first.json().value
  assert.equal(value.count, 1)
  assert.match(value.markdown, /^# LifeOS 任务导出/m)
  assert.match(value.markdown, /- \[ \] 买牛奶 @due\(2026-12-02\) @priority\(P2\)/)

  const done = await callWrite(routes, {
    method: 'POST',
    url: `${BASE}/tasks/${open.id}/complete`,
    body: { expectedRev: open.rev },
  })
  assert.equal(done.status, 200, JSON.stringify(done.json()))

  const filtered = await call(routes, { url: `${BASE}/markdown/tasks?includeDone=0` })
  assert.equal(filtered.json().value.count, 0)
  const all = await call(routes, { url: `${BASE}/markdown/tasks` })
  assert.equal(all.json().value.count, 1)
  assert.match(all.json().value.markdown, /- \[x\] 买牛奶/)
})

test('POST /markdown/tasks/import：dryRun 报告不写库，真实导入落任务', async () => {
  const { routes, store } = makeRoutes()
  const text = '- [ ] 买牛奶 @list(生活) @due(2026-12-02) @priority(P1)\n- [ ] 写周报 @list(工作)'
  const dry = await callWrite(routes, { method: 'POST', url: `${BASE}/markdown/tasks/import`, body: { text, dryRun: true } })
  assert.equal(dry.status, 200, JSON.stringify(dry.json()))
  const dryValue = dry.json().value
  assert.equal(dryValue.dryRun, true)
  assert.equal(dryValue.total, 2)
  assert.equal(dryValue.created, 2)
  assert.deepEqual([...dryValue.createdLists].sort(), ['工作', '生活'].sort())
  assert.equal(store.entries('lifeos', 'task').length, 0)

  const real = await callWrite(routes, { method: 'POST', url: `${BASE}/markdown/tasks/import`, body: { text } })
  assert.equal(real.status, 200, JSON.stringify(real.json()))
  const realValue = real.json().value
  assert.equal(realValue.created, 2)
  assert.equal(realValue.errors.length, 0)
  assert.equal(store.entries('lifeos', 'task').filter(([, record]) => !record.deleted_at).length, 2)

  const again = await callWrite(routes, { method: 'POST', url: `${BASE}/markdown/tasks/import`, body: { text } })
  assert.equal(again.status, 200, JSON.stringify(again.json()))
  assert.equal(again.json().value.created, 0)
  assert.equal(again.json().value.skipped, 2)
})

test('POST /markdown/tasks/import：空内容与非法 dryRun 返回 422', async () => {
  const { routes } = makeRoutes()
  const empty = await callWrite(routes, { method: 'POST', url: `${BASE}/markdown/tasks/import`, body: { text: '  ' } })
  assert.equal(empty.status, 422)
  const error = empty.json().error
  assert.equal(error.code, 'validation_failed')
  assert.match(JSON.stringify(error.details.errors), /text 必填/)

  const bad = await callWrite(routes, { method: 'POST', url: `${BASE}/markdown/tasks/import`, body: { text: '- [ ] A', dryRun: 'yes' } })
  assert.equal(bad.status, 422)
  assert.match(JSON.stringify(bad.json().error.details.errors), /dryRun 必须是布尔值/)
})
