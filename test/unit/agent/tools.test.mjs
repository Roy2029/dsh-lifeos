/**
 * D 线（Agent 薄行）单测：M0 3 工具 + M1 lifeos_task + M2 triage/correct/隔离/守则。
 *
 * 不依赖宿主：用 fake service + fake ctx 验证
 *   - agent.js 的薄行契约（name / inject / 无服务时安全退出 / ctx.effect 持有 disposer / prompt 注入）
 *   - preset.js 的 PresetDefinition 形状（只挂薄行，不挂数据 owner）
 *   - P0 隔离：isLifeosAgent / 注册层 when / 工具名单一来源
 *   - 7 个工具的 JSON Schema、execute 归一化、needsConfirm、错误不裸 throw、render 中文文案
 *
 * 运行：`node --test --test-isolation=none test/unit/agent/tools.test.mjs`
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as agentEntry from '../../../agent.js'
import {
  captureTool,
  correctTool,
  formatTaskDate,
  isLifeosAgent,
  lifeosToolOptions,
  notesTool,
  registerTools,
  renderCapture,
  renderCorrect,
  renderNotes,
  renderSettings,
  renderTask,
  renderToday,
  renderTriage,
  settingsTool,
  taskTool,
  todayTool,
  triageTool,
  TOOL_NAMES,
} from '../../../src/agent/tools.js'
import {
  LIFEOS_PRESET_ID,
  LIFEOS_TOOL_NAMES,
  LIFEOS_TOOL_PREFIX,
  default as defaultToolNames,
} from '../../../src/agent/tool-names.js'
import {
  ORGANIZE_RULES,
  ORGANIZE_RULES_ORDER,
  ORGANIZE_RULES_SECTION_NAME,
} from '../../../src/agent/preset-prompt.js'
import lifeosPreset, { AGENT_ROW_NAME, lifeosPreset as namedPreset, PRESET_ID } from '../../../src/agent/preset.js'

// 单测环境禁止 agent.js 覆盖仓库根的 runtime-agent-marker.json（宿主激活诊断证据）。
process.env.LIFEOS_DISABLE_AGENT_MARKER = '1'

/** 收集 console.warn，避免测试输出噪音并用于断言。 */
function captureWarn(fn) {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const result = fn()
    return { result, warnings }
  } finally {
    console.warn = original
  }
}

function fakeCtx(service, { withSystemPrompt = true } = {}) {
  const definitions = []
  const registerOptions = []
  const sections = []
  let disposed = 0
  let effectCount = 0
  const ctx = {
    get(name) {
      return name === 'lifeos' ? service : undefined
    },
    tools: {
      register(definition, options) {
        definitions.push(definition)
        registerOptions.push(options)
        return () => {
          disposed += 1
        }
      },
      get(name) {
        return definitions.find((definition) => definition.name === name) ?? null
      },
      schemas() {
        return definitions.map(({ name, description, parameters }) => ({ name, description, parameters }))
      },
    },
    effect(fn, label) {
      effectCount += 1
      assert.equal(typeof label, 'string')
      return fn()
    },
  }
  if (withSystemPrompt) {
    ctx.systemPrompt = {
      section(section) {
        sections.push(section)
        return () => {
          disposed += 1
        }
      },
    }
  }
  return {
    ctx,
    definitions,
    registerOptions,
    sections,
    getDisposed: () => disposed,
    getEffectCount: () => effectCount,
  }
}

const DAY = {
  date: '2026-11-12',
  tasks: [
    { id: 'tsk_1', title: '写 M0 报告', status: 'todo' },
    { id: 'tsk_2', title: '回邮件', status: 'done' },
  ],
  inboxCount: 3,
}

function assertTextBlocks(blocks) {
  assert.ok(Array.isArray(blocks), 'render 必须返回 ContentBlock 数组')
  assert.ok(blocks.length >= 1)
  for (const block of blocks) {
    assert.equal(block.type, 'text')
    assert.equal(typeof block.text, 'string')
    assert.ok(block.text.length > 0)
  }
  return blocks.map((block) => block.text).join('\n')
}

// ── agent.js 薄行契约 ──────────────────────────────────────────────
test('agent.js: name 与 inject 符合 M0-PLAN §3.7 + M2 追加 systemPrompt', () => {
  assert.equal(agentEntry.name, 'lifeos-agent')
  // 首装实测：Host 在 apply 内 provide 的服务要等 Host fiber 激活才可见；
  // M2 追加 systemPrompt 用于注入整理守则（M2-PLAN §1/§4）。
  assert.deepEqual(agentEntry.inject, ['tools', 'lifeos', 'systemPrompt'])
  assert.equal(typeof agentEntry.apply, 'function')
})

test('agent.js: 取不到 ctx.lifeos 时安全退出（不 throw、不注册、留 warn）', () => {
  const { ctx, definitions } = fakeCtx(undefined)
  const { warnings } = captureWarn(() => agentEntry.apply(ctx))
  assert.equal(definitions.length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /ctx\.lifeos/)
})

test('agent.js: 有服务时在 ctx.effect 内注册 10 个工具 + 整理守则 section', () => {
  const service = { today: () => DAY, capture: async () => ({ rawRecordId: 'rr_1', inboxItemId: 'inb_1' }) }
  const { ctx, definitions, sections, getDisposed, getEffectCount } = fakeCtx(service)
  agentEntry.apply(ctx)
  assert.equal(getEffectCount(), 1)
  assert.deepEqual(definitions.map((d) => d.name), LIFEOS_TOOL_NAMES)
  assert.equal(definitions.length, 10)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, ORGANIZE_RULES_SECTION_NAME)
  assert.equal(sections[0].order, ORGANIZE_RULES_ORDER)
  assert.equal(sections[0].text, ORGANIZE_RULES)
  const dispose = ctx.effect(() => registerTools(ctx, service), 'tmp') // 只为拿 disposer
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.ok(getDisposed() >= 5)
})

test('agent.js: 没有 systemPrompt.section 时降级为只注册工具（不崩）', () => {
  const service = { today: () => DAY, capture: async () => ({}) }
  const { ctx, definitions, getDisposed } = fakeCtx(service, { withSystemPrompt: false })
  captureWarn(() => agentEntry.apply(ctx))
  assert.equal(definitions.length, 10)
  const dispose = ctx.effect(() => registerTools(ctx, service), 'tmp')
  dispose()
  assert.ok(getDisposed() >= 6)
})

test('agent.js: 单测环境不写 runtime-agent-marker.json（不污染宿主诊断证据）', () => {
  assert.equal(agentEntry.markerWritesDisabled(), true)
})

// ── preset.js 形状 ────────────────────────────────────────────────
test('preset.js: PresetDefinition 形状 + 只挂薄行', () => {
  assert.equal(lifeosPreset, namedPreset)
  assert.equal(lifeosPreset.id, PRESET_ID)
  assert.equal(lifeosPreset.name, 'LifeOS 助手')
  assert.equal(lifeosPreset.order, 20)
  assert.equal(typeof lifeosPreset.description, 'string')
  assert.ok(Array.isArray(lifeosPreset.plugins))
  assert.equal(lifeosPreset.plugins.length, 1, 'preset 内只能有薄行，不能挂数据 owner')
  assert.equal(lifeosPreset.plugins[0].name, AGENT_ROW_NAME)
  assert.equal(lifeosPreset.plugins[0].name, 'dsh-lifeos/agent')
})

// ── lifeos_today ─────────────────────────────────────────────────
test('lifeos_today: 无参数、只读、schema 合法', () => {
  const tool = todayTool({ today: () => DAY })
  assert.equal(tool.name, 'lifeos_today')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required ?? [], [])
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(tool.isConcurrencySafe(), true)
})

test('lifeos_today: execute 归一化 canonical 值并带 agentId', async () => {
  const tool = todayTool({ today: () => DAY })
  const value = await tool.execute({}, { callId: 'call_1', agent: { id: 'agent_a' } })
  assert.equal(value.ok, true)
  assert.equal(value.date, '2026-11-12')
  assert.equal(value.tasks.length, 2)
  assert.equal(value.inboxCount, 3)
  assert.equal(value.agentId, 'agent_a')
})

test('lifeos_today: render 中文摘要含日期/完成数/Inbox', () => {
  const text = assertTextBlocks(renderToday({}, { ok: true, ...DAY }))
  assert.match(text, /今天 2026-11-12/)
  assert.match(text, /任务 2 个（已完成 1）/)
  assert.match(text, /Inbox 待整理 3 条/)
  assert.match(text, /✓ 回邮件/)
  assert.match(text, /○ 写 M0 报告/)
})

test('lifeos_today: 空任务与空 Inbox 的 render 不出现噪音', () => {
  const text = assertTextBlocks(renderToday({}, { ok: true, date: '2026-11-12', tasks: [], inboxCount: 0 }))
  assert.match(text, /今天没有排上任务/)
  assert.match(text, /Inbox 待整理 0 条/)
  assert.doesNotMatch(text, /提示：Inbox 还有/, '无待整理时不应追加整理提示')
  assert.doesNotMatch(text, /另有 \d+ 个任务/)
})

test('lifeos_today: service 抛错时转成 ok:false，不裸 throw', async () => {
  const tool = todayTool({
    today() {
      const error = new Error('unit 打不开')
      error.code = 'store_unavailable'
      throw error
    },
  })
  const value = await tool.execute({}, {})
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'store_unavailable')
  const text = assertTextBlocks(renderToday({}, value))
  assert.match(text, /读取今日概况失败（store_unavailable）/)
})

// ── lifeos_capture ───────────────────────────────────────────────
test('lifeos_capture: schema 必填 text、上限 2000、无多余参数', () => {
  const tool = captureTool({ capture: async () => ({}) })
  assert.equal(tool.name, 'lifeos_capture')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['text'])
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(tool.parameters.properties.text.type, 'string')
  assert.equal(tool.parameters.properties.text.maxLength, 2000)
  assert.equal(tool.parameters.properties.text.minLength, 1)
  assert.equal(tool.isConcurrencySafe(), false)
})

test('lifeos_capture: 传原文（trim）、source=chat、requestId=callId', async () => {
  const calls = []
  const tool = captureTool({
    async capture(input) {
      calls.push(input)
      return { rawRecordId: 'rr_1', inboxItemId: 'inb_1' }
    },
  })
  const value = await tool.execute(
    { text: '  明天上午给导师发实验结果  ' },
    { callId: 'call_9', agent: { id: 'agent_a' } },
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].text, '明天上午给导师发实验结果')
  assert.equal(calls[0].source, 'chat')
  assert.equal(calls[0].requestId, 'call_9')
  assert.equal(value.ok, true)
  assert.equal(value.rawRecordId, 'rr_1')
  assert.equal(value.inboxItemId, 'inb_1')
  assert.equal(value.agentId, 'agent_a')
  const text = assertTextBlocks(renderCapture({}, value))
  assert.match(text, /已记入 Inbox：inb_1/)
})

test('lifeos_capture: 空白文本直接 validation_failed，不调服务', async () => {
  let called = 0
  const tool = captureTool({
    async capture() {
      called += 1
      return {}
    },
  })
  const value = await tool.execute({ text: '   ' }, {})
  assert.equal(called, 0)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'validation_failed')
})

test('lifeos_capture: 超长文本直接 validation_failed，不截断、不调服务', async () => {
  let called = 0
  const tool = captureTool({
    async capture() {
      called += 1
      return {}
    },
  })
  const value = await tool.execute({ text: 'x'.repeat(2001) }, {})
  assert.equal(called, 0)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'validation_failed')
  assert.match(renderCapture({}, value)[0].text, /没有记入 Inbox/)
})

test('lifeos_capture: 服务抛 "code: message" 时解析错误码并给模型提示', async () => {
  const tool = captureTool({
    async capture() {
      throw new Error('store_unavailable: 存储只读')
    },
  })
  const value = await tool.execute({ text: '记一下' }, {})
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'store_unavailable')
  const text = assertTextBlocks(renderCapture({}, value))
  assert.match(text, /没有记入 Inbox（store_unavailable）/)
  assert.match(text, /不要向用户声称已保存/)
})

// ── registerTools 容错 ────────────────────────────────────────────
test('registerTools: 单个工具注册失败不影响另一个，且返回可调用 disposer', () => {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        if (definition.name === 'lifeos_today') throw new Error('boom')
        registered.push(definition.name)
        return () => {}
      },
    },
  }
  const { warnings } = captureWarn(() => {
    const dispose = registerTools(ctx, { today: () => DAY, capture: async () => ({}) })
    assert.equal(typeof dispose, 'function')
    dispose()
  })
  assert.deepEqual(registered, [
    'lifeos_capture',
    'lifeos_task',
    'lifeos_triage',
    'lifeos_correct',
    'lifeos_notes',
    'lifeos_settings',
    'lifeos_habit',
    'lifeos_project',
    'lifeos_goal',
  ])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /lifeos_today/)
})

// ════════════════════════════════════════════════════════════════
// M1 · lifeos_task（第 3 个工具）
// ════════════════════════════════════════════════════════════════

const EXEC = { callId: 'call_task_1', agent: { id: 'agent_lifeos' } }

/** fake LifeOS service v0.2：记录所有调用，实现 §2 冻结签名。 */
function makeTaskService(overrides = {}) {
  const calls = []
  const state = {
    tasks: [
      {
        id: 'tsk_1',
        title: '写 M1 报告',
        status: 'todo',
        priority: 'high',
        projectId: 'prj_1',
        projectName: 'LifeOS',
        tags: [{ id: 'tag_1', name: '深度工作' }],
        scheduledDate: '2026-11-13',
        isAllDay: true,
        rev: 3,
      },
      {
        id: 'tsk_2',
        title: '回邮件',
        status: 'done',
        priority: 'low',
        tags: [],
        rev: 2,
      },
    ],
  }
  const service = {
    calls,
    state,
    listTasks(input) {
      calls.push({ method: 'listTasks', args: [input] })
      return {
        items: state.tasks.slice(0, input.limit ?? 20),
        nextCursor: null,
        counts: { all: state.tasks.length },
      }
    },
    getTask(id) {
      calls.push({ method: 'getTask', args: [id] })
      return state.tasks.find((task) => task.id === id) ?? null
    },
    createTask(...args) {
      calls.push({ method: 'createTask', args })
      const [input] = args
      const task = {
        id: 'tsk_new',
        status: 'todo',
        priority: 'none',
        tags: [],
        rev: 1,
        ...input,
      }
      state.tasks.push(task)
      return { task, rev: 1 }
    },
    updateTask(...args) {
      calls.push({ method: 'updateTask', args })
      const [id, patch, expectedRev] = args
      const task = state.tasks.find((item) => item.id === id)
      Object.assign(task, patch)
      task.rev = expectedRev + 1
      return { task, rev: task.rev }
    },
    completeTask(...args) {
      calls.push({ method: 'completeTask', args })
      const [id] = args
      const task = state.tasks.find((item) => item.id === id)
      task.status = 'done'
      return { task }
    },
    reopenTask(...args) {
      calls.push({ method: 'reopenTask', args })
      const [id] = args
      const task = state.tasks.find((item) => item.id === id)
      task.status = 'todo'
      return { task }
    },
    cancelTask(...args) {
      calls.push({ method: 'cancelTask', args })
      const [id] = args
      const task = state.tasks.find((item) => item.id === id)
      task.status = 'cancelled'
      return { task }
    },
    rescheduleTask(...args) {
      calls.push({ method: 'rescheduleTask', args })
      const [id, input, expectedRev] = args
      const task = state.tasks.find((item) => item.id === id)
      Object.assign(task, input)
      task.rev = expectedRev + 1
      return { task }
    },
  }
  return Object.assign(service, overrides)
}

function lastCall(service, method) {
  return service.calls.filter((call) => call.method === method).at(-1)
}

test('lifeos_task: schema 含 8 个 action、仅 action 必填、多 action 共用参数', () => {
  const tool = taskTool({})
  assert.equal(tool.name, 'lifeos_task')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.deepEqual(tool.parameters.properties.action.enum, [
    'list',
    'get',
    'create',
    'update',
    'complete',
    'reopen',
    'cancel',
    'reschedule',
  ])
  assert.notEqual(tool.parameters.additionalProperties, false, '多 action 共用参数，不锁 additionalProperties')
  for (const key of ['id', 'view', 'projectId', 'tagId', 'limit', 'title', 'priority', 'scheduledDate', 'dueDate', 'expectedRev', 'confirm']) {
    assert.ok(tool.parameters.properties[key], `缺少参数定义：${key}`)
  }
  assert.match(tool.parameters.properties.dueDate.description, /互斥/)
  assert.match(tool.parameters.properties.confirm.description, /needsConfirm/)
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.isConcurrencySafe({ action: 'list' }), true)
  assert.equal(tool.isConcurrencySafe({ action: 'create' }), false)
  assert.equal(typeof tool.output.render, 'function')
})

test('lifeos_task: 非法 action → validation_failed，不调服务', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute({ action: 'delete' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'validation_failed')
  assert.equal(service.calls.length, 0)
  assert.match(renderTask({}, value)[0].text, /任务操作失败（validation_failed）/)
})

test('lifeos_task list: 默认 view=all、limit=20，返回归一化 items', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute({ action: 'list' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.view, 'all')
  assert.equal(value.items.length, 2)
  assert.equal(value.items[0].id, 'tsk_1')
  assert.deepEqual(lastCall(service, 'listTasks').args[0], { view: 'all', limit: 20 })
  assert.match(renderTask({}, value)[0].text, /任务列表（全部）：2 条/)
})

test('lifeos_task list: 透传 view/projectId/tagId/q/limit/cursor', async () => {
  const service = makeTaskService()
  await taskTool(service).execute(
    { action: 'list', view: 'today', projectId: 'prj_1', tagId: 'tag_1', q: '报告', limit: 5, cursor: 'c1' },
    EXEC,
  )
  assert.deepEqual(lastCall(service, 'listTasks').args[0], {
    view: 'today',
    limit: 5,
    projectId: 'prj_1',
    tagId: 'tag_1',
    q: '报告',
    cursor: 'c1',
  })
})

test('lifeos_task list: 长列表 render 只显示 8 条 + 省略提示', async () => {
  const service = makeTaskService()
  service.listTasks = (input) => {
    service.calls.push({ method: 'listTasks', args: [input] })
    const items = Array.from({ length: 12 }, (_, i) => ({ id: `tsk_${i}`, title: `任务 ${i}`, status: 'todo', rev: 1 }))
    return { items, nextCursor: 'next-1' }
  }
  const value = await taskTool(service).execute({ action: 'list', limit: 12 }, EXEC)
  const text = renderTask({}, value)[0].text
  assert.match(text, /任务列表（全部）：12 条/)
  assert.equal(text.split('\n').filter((line) => line.startsWith('- ')).length, 8)
  assert.match(text, /…另有 4 条/)
  assert.match(text, /还有更多/)
})

test('lifeos_task list: 空列表 render 说明没有任务', async () => {
  const service = makeTaskService()
  service.listTasks = () => ({ items: [], nextCursor: null })
  const value = await taskTool(service).execute({ action: 'list', view: 'overdue' }, EXEC)
  assert.match(renderTask({}, value)[0].text, /任务列表（逾期）：0 条[\s\S]*没有符合条件的任务/)
})

test('lifeos_task render: 列表每条都带实体 id，时间按 renderContext 时区显示（不是 UTC）', () => {
  const value = {
    ok: true,
    action: 'list',
    view: 'all',
    items: [
      {
        id: 'tsk_01ABC',
        title: '提交报名信息',
        status: 'todo',
        priority: 'high',
        dueAt: '2026-11-15T14:00:00.000Z',
        projectName: 'LifeOS',
        rev: 1,
      },
    ],
    counts: { all: 1 },
  }
  const text = renderTask({}, value, { timeZone: 'Asia/Shanghai' })[0].text
  assert.match(text, /截止 2026-11-15 22:00/, '14:00Z 在 Asia/Shanghai 应显示 22:00')
  assert.match(text, /id tsk_01ABC/)
})

test('lifeos_task create: dueAt 带 +08:00 偏移时归一为 UTC（领域只接受 ...Z）', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute(
    { action: 'create', title: '提交报名信息', dueAt: '2026-11-15T22:00:00+08:00' },
    EXEC,
  )
  assert.equal(value.ok, true)
  const call = lastCall(service, 'createTask')
  assert.equal(call.args[0].dueAt, '2026-11-15T14:00:00.000Z')
})

test('lifeos_task: 非法 ISO 时间提示可带 Z 或 +08:00 偏移', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute({ action: 'create', title: 'x', dueAt: '明天下午三点' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'validation_failed')
  assert.match(value.error.message, /\+08:00/)
  assert.equal(service.calls.length, 0)
})

test('lifeos_task get: 返回 task 且 render 含标题/状态/日期/项目', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute({ action: 'get', id: 'tsk_1' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.task.id, 'tsk_1')
  const text = renderTask({}, value)[0].text
  assert.match(text, /任务详情：「写 M1 报告」/)
  assert.match(text, /状态 待办/)
  assert.match(text, /日期 2026-11-13/)
  assert.match(text, /LifeOS/)
  assert.match(text, /优先级 高/)
})

test('lifeos_task get: 缺 id → validation_failed', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute({ action: 'get' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'validation_failed')
})

test('lifeos_task get: 任务不存在 → not_found（不猜 id）', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute({ action: 'get', id: 'tsk_missing' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'not_found')
})

test('lifeos_task create: 必填 title、字段透传、返回 task+rev', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute(
    {
      action: 'create',
      title: '  给导师发实验结果  ',
      priority: 'high',
      projectId: 'prj_1',
      tagIds: ['tag_1', '  '],
      scheduledDate: '2026-11-13',
      isAllDay: true,
      dueDate: '2026-11-15',
      notes: '截止前 2 天提醒',
    },
    EXEC,
  )
  assert.equal(value.ok, true)
  assert.equal(value.action, 'create')
  assert.equal(value.task.id, 'tsk_new')
  assert.equal(value.task.title, '给导师发实验结果')
  const [input] = lastCall(service, 'createTask').args
  assert.equal(input.title, '给导师发实验结果')
  assert.equal(input.priority, 'high')
  assert.deepEqual(input.tagIds, ['tag_1'])
  assert.equal(input.scheduledDate, '2026-11-13')
  assert.equal(input.dueDate, '2026-11-15')
  assert.match(renderTask({}, value)[0].text, /已创建任务：「给导师发实验结果」/)
})

test('lifeos_task create: 缺 title → validation_failed，不调服务', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute({ action: 'create' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'validation_failed')
  assert.equal(service.calls.length, 0)
})

test('lifeos_task create: scheduledDate 与 scheduledStartAt 互斥 → validation_failed', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute(
    { action: 'create', title: 'x', scheduledDate: '2026-11-13', scheduledStartAt: '2026-11-13T02:00:00.000Z', scheduledEndAt: '2026-11-13T03:00:00.000Z' },
    EXEC,
  )
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'validation_failed')
  assert.match(value.error.message, /互斥/)
  assert.equal(service.calls.length, 0)
})

test('lifeos_task create: dueDate 与 dueAt 互斥 → validation_failed', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute(
    { action: 'create', title: 'x', dueDate: '2026-11-15', dueAt: '2026-11-15T10:00:00.000Z' },
    EXEC,
  )
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'validation_failed')
})

test('lifeos_task create: 日期格式非法/时间段倒挂 → validation_failed', async () => {
  const service = makeTaskService()
  const badDate = await taskTool(service).execute({ action: 'create', title: 'x', scheduledDate: '2026/11/13' }, EXEC)
  assert.equal(badDate.error.code, 'validation_failed')
  const badSpan = await taskTool(service).execute(
    { action: 'create', title: 'x', scheduledStartAt: '2026-11-13T03:00:00.000Z', scheduledEndAt: '2026-11-13T02:00:00.000Z' },
    EXEC,
  )
  assert.equal(badSpan.error.code, 'validation_failed')
  assert.match(badSpan.error.message, /晚于/)
  assert.equal(service.calls.length, 0)
})

test('lifeos_task update: L2 普通字段直接执行（含计划时间），changes 回显', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute(
    { action: 'update', id: 'tsk_1', title: '写 M1 终稿', priority: 'medium', scheduledDate: '2026-11-14', expectedRev: 3 },
    EXEC,
  )
  assert.equal(value.ok, true)
  assert.equal(value.action, 'update')
  assert.deepEqual(value.changedFields.sort(), ['priority', 'scheduledDate', 'title'])
  const call = lastCall(service, 'updateTask')
  assert.equal(call.args[1].title, '写 M1 终稿')
  assert.equal(call.args[1].idempotencyKey, 'call_task_1', 'B 的 updateTask 从 patch.idempotencyKey 取幂等键')
  assert.equal(call.args[2], 3)
  assert.match(renderTask({}, value)[0].text, /已更新任务/)
})

test('lifeos_task update: 未传 expectedRev 时自动 getTask 取 rev', async () => {
  const service = makeTaskService()
  await taskTool(service).execute({ action: 'update', id: 'tsk_1', notes: '补充' }, EXEC)
  assert.equal(lastCall(service, 'getTask').args[0], 'tsk_1')
  assert.equal(lastCall(service, 'updateTask').args[2], 3)
})

test('lifeos_task update: 改 dueDate 属 L3 → needsConfirm 且不执行', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute({ action: 'update', id: 'tsk_1', dueDate: '2026-11-20' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.needsConfirm, true)
  assert.equal(value.action, 'update')
  assert.deepEqual(value.preview.changes.dueDate, { before: null, after: '2026-11-20' })
  assert.equal(service.calls.filter((call) => call.method === 'updateTask').length, 0)
  const text = renderTask({}, value)[0].text
  assert.match(text, /需要你确认（更新）/)
  assert.match(text, /dueDate：（空） → 2026-11-20/)
})

test('lifeos_task update: dueDate + confirm:true 才执行（同一 patch）', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute(
    { action: 'update', id: 'tsk_1', dueDate: '2026-11-20', priority: 'low', confirm: true },
    EXEC,
  )
  assert.equal(value.ok, true)
  assert.equal(value.needsConfirm, undefined)
  const call = lastCall(service, 'updateTask')
  assert.deepEqual(call.args[1], { priority: 'low', dueDate: '2026-11-20', idempotencyKey: 'call_task_1' })
  assert.match(renderTask({}, value)[0].text, /已更新任务/)
})

test('lifeos_task complete: L2 直接执行并带 CAS rev', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute({ action: 'complete', id: 'tsk_1' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.action, 'complete')
  assert.equal(lastCall(service, 'completeTask').args[1], 3)
  assert.match(renderTask({}, value)[0].text, /已完成任务：「写 M1 报告」/)
})

test('lifeos_task reopen: L2 直接执行', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute({ action: 'reopen', id: 'tsk_2' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.action, 'reopen')
  assert.equal(lastCall(service, 'reopenTask').args[0], 'tsk_2')
  assert.match(renderTask({}, value)[0].text, /已重开任务/)
})

test('lifeos_task cancel: L3 → needsConfirm；confirm:true 才执行', async () => {
  const service = makeTaskService()
  const preview = await taskTool(service).execute({ action: 'cancel', id: 'tsk_1' }, EXEC)
  assert.equal(preview.ok, true)
  assert.equal(preview.needsConfirm, true)
  assert.deepEqual(preview.preview, {
    action: 'cancel',
    id: 'tsk_1',
    changes: { status: { before: 'todo', after: 'cancelled' } },
  })
  assert.equal(service.calls.filter((call) => call.method === 'cancelTask').length, 0)
  assert.match(renderTask({}, preview)[0].text, /需要你确认（取消）/)
  assert.match(renderTask({}, preview)[0].text, /status：todo → cancelled/)

  const executed = await taskTool(service).execute({ action: 'cancel', id: 'tsk_1', confirm: true }, EXEC)
  assert.equal(executed.ok, true)
  assert.equal(executed.needsConfirm, undefined)
  assert.equal(lastCall(service, 'cancelTask').args[0], 'tsk_1')
})

test('lifeos_task reschedule: L3 → needsConfirm；confirm:true 执行并传 before/after', async () => {
  const service = makeTaskService()
  const preview = await taskTool(service).execute({ action: 'reschedule', id: 'tsk_1', scheduledDate: '2026-11-20' }, EXEC)
  assert.equal(preview.needsConfirm, true)
  assert.deepEqual(preview.preview.changes.scheduledDate, { before: '2026-11-13', after: '2026-11-20' })
  assert.equal(service.calls.filter((call) => call.method === 'rescheduleTask').length, 0)

  const executed = await taskTool(service).execute(
    { action: 'reschedule', id: 'tsk_1', scheduledDate: '2026-11-20', expectedRev: 3, confirm: true },
    EXEC,
  )
  assert.equal(executed.ok, true)
  const call = lastCall(service, 'rescheduleTask')
  assert.deepEqual(call.args[1], { scheduledDate: '2026-11-20' })
  assert.equal(call.args[2], 3)
  assert.match(renderTask({}, executed)[0].text, /已改期：「写 M1 报告」/)
})

test('lifeos_task reschedule: 没有任何时间字段 → validation_failed', async () => {
  const service = makeTaskService()
  const value = await taskTool(service).execute({ action: 'reschedule', id: 'tsk_1' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'validation_failed')
  assert.equal(service.calls.length, 0)
})

test('lifeos_task 写操作: 传 actor=agent/sessionId/idempotencyKey(callId)', async () => {
  const service = makeTaskService()
  await taskTool(service).execute({ action: 'create', title: '元信息测试' }, EXEC)
  const [input, meta] = lastCall(service, 'createTask').args
  assert.equal(input.idempotencyKey, 'call_task_1', 'B 的 createTask 从 input.idempotencyKey 取幂等键')
  assert.deepEqual(meta, { actor: 'agent', sessionId: 'agent_lifeos', idempotencyKey: 'call_task_1' })
})

test('lifeos_task 错误映射: service conflict → ok:false + 重读 rev 提示', async () => {
  const service = makeTaskService({
    updateTask() {
      const error = new Error('版本冲突')
      error.code = 'conflict'
      throw error
    },
  })
  const value = await taskTool(service).execute({ action: 'update', id: 'tsk_1', title: 'x', expectedRev: 2 }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'conflict')
  assert.match(value.error.hint, /rev/)
  assert.match(renderTask({}, value)[0].text, /任务操作失败（conflict）/)
})

test('lifeos_task 服务未就绪: 缺 listTasks → internal failure（不崩）', async () => {
  const value = await taskTool({}).execute({ action: 'list' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'internal')
  assert.match(value.error.message, /listTasks/)
})

test('TOOL_NAMES: 与 tool-names 单一来源一致（10 个工具，顺序即注册顺序）', () => {
  assert.deepEqual(TOOL_NAMES, [
    'lifeos_today',
    'lifeos_capture',
    'lifeos_task',
    'lifeos_triage',
    'lifeos_correct',
    'lifeos_notes',
    'lifeos_settings',
    'lifeos_habit',
    'lifeos_project',
    'lifeos_goal',
  ])
  assert.deepEqual(TOOL_NAMES, LIFEOS_TOOL_NAMES)
})

// ════════════════════════════════════════════════════════════════
// M2 · P0 工具隔离（注册层 when + 名单单一来源）
// ════════════════════════════════════════════════════════════════

const LIFEOS_AGENT = { session: { header: { agentPreset: 'lifeos' } } }
const STANDARD_AGENT = { session: { header: { agentPreset: 'default' } } }

test('isLifeosAgent: 仅在 agentPreset==="lifeos" 时为 true', () => {
  assert.equal(isLifeosAgent(LIFEOS_AGENT), true)
  assert.equal(isLifeosAgent({ session: { header: { agentPreset: 'lifeos-brief' } } }), false)
  assert.equal(isLifeosAgent(STANDARD_AGENT), false)
})

test('isLifeosAgent: 无 session/header 或 null 时 fail-closed 返回 false', () => {
  assert.equal(isLifeosAgent(null), false)
  assert.equal(isLifeosAgent(undefined), false)
  assert.equal(isLifeosAgent({}), false)
  assert.equal(isLifeosAgent({ session: {} }), false)
  assert.equal(isLifeosAgent({ session: { header: {} } }), false)
  assert.equal(isLifeosAgent({ session: { header: { agentPreset: '' } } }), false)
})

test('isLifeosAgent: 优先用当前已提交 preset（会话可中途切换），header 仅兜底', () => {
  const makeAgent = (headerPreset, current, extra) => ({
    session: { id: 's_' + headerPreset + '_' + current, header: { agentPreset: headerPreset } },
    ctx: {
      get: (name) =>
        name === 'agentPresets' && current !== null ? { presetForSession: () => current } : undefined,
    },
    ...(extra || {}),
  })
  // 会话创建时 standard、中途切到 lifeos → 当前 preset 优先
  assert.equal(isLifeosAgent(makeAgent('standard', 'lifeos')), true)
  // 创建时 lifeos、中途切回 standard → 不再可见
  assert.equal(isLifeosAgent(makeAgent('lifeos', 'standard')), false)
  // 服务不可用时回退 header
  assert.equal(isLifeosAgent(makeAgent('lifeos', null)), true)
  assert.equal(isLifeosAgent(makeAgent('standard', null)), false)
})

test('isLifeosAgent: 兼容宿主其它投影（agent.agentPreset / agent.preset），与 B 口径一致', () => {
  assert.equal(isLifeosAgent({ agentPreset: 'lifeos' }), true)
  assert.equal(isLifeosAgent({ preset: 'lifeos' }), true)
  assert.equal(isLifeosAgent({ preset: 'default' }), false)
})

test('isLifeosAgent: 读取属性抛异常时返回 false（不把插件炸掉）', () => {
  const hostile = {
    get session() {
      throw new Error('boom')
    },
  }
  assert.equal(isLifeosAgent(hostile), false)
})

test('lifeosToolOptions: when 用 activation.agent 判定，异常输入 fail-closed', () => {
  const options = lifeosToolOptions()
  assert.equal(typeof options.when, 'function')
  assert.equal(options.when({ agent: LIFEOS_AGENT }), true)
  assert.equal(options.when({ agent: STANDARD_AGENT }), false)
  assert.equal(options.when({}), false)
  assert.equal(options.when(undefined), false)
})

test('registerTools: 每个工具都带 { when } 注册选项（P0 第 1 层）', () => {
  const { ctx, definitions, registerOptions } = fakeCtx({})
  const dispose = registerTools(ctx, {})
  assert.equal(definitions.length, 10)
  assert.equal(registerOptions.length, 10)
  for (const options of registerOptions) {
    assert.equal(typeof options?.when, 'function')
    assert.equal(options.when({ agent: LIFEOS_AGENT }), true)
    assert.equal(options.when({ agent: STANDARD_AGENT }), false)
  }
  assert.deepEqual(definitions.map((definition) => definition.name), LIFEOS_TOOL_NAMES)
  dispose()
})

test('tool-names: 名单唯一且是 LifeOS 前缀；preset id 固定', () => {
  assert.equal(LIFEOS_TOOL_NAMES.length, 10)
  assert.equal(new Set(LIFEOS_TOOL_NAMES).size, 10)
  for (const toolName of LIFEOS_TOOL_NAMES) assert.ok(toolName.startsWith(LIFEOS_TOOL_PREFIX), toolName)
  assert.equal(LIFEOS_PRESET_ID, 'lifeos')
  assert.equal(defaultToolNames, LIFEOS_TOOL_NAMES)
})

test('tool-names: 名单覆盖 10 个工具定义（含 M4 habit/project/goal）', () => {
  assert.ok(LIFEOS_TOOL_NAMES.includes('lifeos_triage'))
  assert.ok(LIFEOS_TOOL_NAMES.includes('lifeos_correct'))
  assert.ok(LIFEOS_TOOL_NAMES.includes('lifeos_notes'))
  assert.ok(LIFEOS_TOOL_NAMES.includes('lifeos_settings'))
  assert.ok(LIFEOS_TOOL_NAMES.includes('lifeos_habit'))
  assert.ok(LIFEOS_TOOL_NAMES.includes('lifeos_project'))
  assert.ok(LIFEOS_TOOL_NAMES.includes('lifeos_goal'))
  assert.equal(triageTool({}).name, 'lifeos_triage')
  assert.equal(correctTool({}).name, 'lifeos_correct')
})

// ════════════════════════════════════════════════════════════════
// M2 · lifeos_triage
// ════════════════════════════════════════════════════════════════

function makeCandidate(overrides = {}) {
  return {
    candidateId: 'cand_1',
    rawRecordId: 'rr_1',
    kind: 'metric',
    confidence: 0.9,
    source: { quote: '8000 步', start: 4, end: 10 },
    fields: { metric_code: 'steps', value_num: 8000 },
    reasons: ['命中数字+单位'],
    risks: [],
    requiresConfirm: false,
    ...overrides,
  }
}

/** fake LifeOS service v0.3（triage/correct 部分）：记录调用、可覆盖。 */
function makeTriageService(overrides = {}) {
  const calls = []
  const state = {
    pending: [
      { rawRecord: { id: 'rr_1', text: '今天走了 8000 步', user_local_date: '2026-11-13' }, runId: 'run_1' },
      { rawRecord: { id: 'rr_2', text: '周五前把实验结果发给导师', user_local_date: '2026-11-13' }, runId: 'run_1' },
    ],
  }
  const service = {
    calls,
    state,
    runTriage(input) {
      calls.push({ method: 'runTriage', args: [input] })
      return {
        runId: 'run_1',
        alreadyDone: false,
        needsAgent: true,
        batches: state.pending.map((group) => ({ rawRecord: group.rawRecord, runId: group.runId })),
      }
    },
    listTriagePending() {
      calls.push({ method: 'listTriagePending' })
      return { groups: state.pending }
    },
    saveTriageCandidates(input) {
      calls.push({ method: 'saveTriageCandidates', args: [input] })
      return {
        saved: input.candidates.length,
        needsConfirm: input.candidates.filter((candidate) => candidate.requiresConfirm).length,
        run: { id: input.runId, status: 'draft' },
      }
    },
    abortTriage(input) {
      calls.push({ method: 'abortTriage', args: [input] })
      return { run: { id: input.runId, status: 'aborted' } }
    },
    correctDerived(...args) {
      calls.push({ method: 'correctDerived', args })
      return { affected: [{ type: 'metric_stat', id: 'stat_1' }, { type: 'habit_streak', id: 'hab_1' }] }
    },
    getTask(id) {
      calls.push({ method: 'getTask', args: [id] })
      return id === 'tsk_1' ? { id: 'tsk_1', title: '写报告', status: 'todo', dueDate: '2026-11-15', rev: 2 } : null
    },
  }
  return Object.assign(service, overrides)
}

test('lifeos_triage: schema（3 action / scope / limit 上限 / candidates）', () => {
  const tool = triageTool({})
  assert.equal(tool.name, 'lifeos_triage')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.deepEqual(tool.parameters.properties.action.enum, ['begin', 'commit', 'abort'])
  assert.deepEqual(tool.parameters.properties.scope.enum, ['pending', 'ids'])
  assert.equal(tool.parameters.properties.limit.maximum, 20)
  assert.equal(tool.parameters.properties.candidates.type, 'array')
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.isConcurrencySafe(), false)
  assert.match(tool.description, /不写业务事实/)
})

test('lifeos_triage: 非法 action → validation_failed，不调 service', async () => {
  const service = makeTriageService()
  const value = await triageTool(service).execute({ action: 'apply' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'validation_failed')
  assert.equal(service.calls.length, 0)
})

test('lifeos_triage begin: 默认 scope=pending/limit=10，归一化原文批次', async () => {
  const service = makeTriageService()
  const value = await triageTool(service).execute({ action: 'begin' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.action, 'begin')
  assert.equal(value.runId, 'run_1')
  assert.equal(value.scope, 'pending')
  assert.equal(value.count, 2)
  assert.deepEqual(lastCall(service, 'runTriage').args[0], { mode: 'agent', limit: 10 })
  assert.equal(value.batches[0].rawRecordId, 'rr_1')
  assert.equal(value.batches[0].text, '今天走了 8000 步')
  assert.equal(value.batches[0].localDate, '2026-11-13')
  assert.equal(value.needsAgent, true)
})

test('lifeos_triage begin: scope=ids 传 rawRecordIds；空 ids → validation_failed', async () => {
  const service = makeTriageService()
  await triageTool(service).execute({ action: 'begin', scope: 'ids', ids: ['rr_2'], limit: 3 }, EXEC)
  assert.deepEqual(lastCall(service, 'runTriage').args[0], { mode: 'agent', limit: 3, rawRecordIds: ['rr_2'] })

  const before = service.calls.length
  const bad = await triageTool(service).execute({ action: 'begin', scope: 'ids', ids: [] }, EXEC)
  assert.equal(bad.error.code, 'validation_failed')
  assert.equal(service.calls.length, before)
})

test('lifeos_triage begin: alreadyDone 透传（同 runKey 复用）', async () => {
  const service = makeTriageService({
    runTriage: () => ({ runId: 'run_1', alreadyDone: true, batches: [{ rawRecord: { id: 'rr_1', text: 'x' } }] }),
  })
  const value = await triageTool(service).execute({ action: 'begin' }, EXEC)
  assert.equal(value.alreadyDone, true)
  assert.match(renderTriage({}, value)[0].text, /该 run 已存在，复用/)
})

test('lifeos_triage begin: 服务只回 needsAgent 时用 listTriagePending 补批次', async () => {
  const service = makeTriageService({
    runTriage: () => ({ runId: 'run_9', needsAgent: true }),
  })
  const value = await triageTool(service).execute({ action: 'begin', limit: 1 }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.runId, 'run_9')
  assert.equal(value.count, 1)
  assert.equal(value.batches[0].rawRecordId, 'rr_1')
})

test('lifeos_triage begin: runTriage 不返回 runId → internal 失败', async () => {
  const service = makeTriageService({ runTriage: () => ({ needsAgent: true }), listTriagePending: () => ({ groups: [] }) })
  const value = await triageTool(service).execute({ action: 'begin' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'internal')
  assert.match(value.error.message, /runId/)
})

test('lifeos_triage begin: 超长原文截断并标记 textTruncated', async () => {
  const longText = '长'.repeat(2500)
  const service = makeTriageService({
    runTriage: () => ({ runId: 'run_1', batches: [{ rawRecord: { id: 'rr_long', text: longText } }] }),
  })
  const value = await triageTool(service).execute({ action: 'begin' }, EXEC)
  assert.equal(value.batches[0].text.length, 2000)
  assert.equal(value.batches[0].textTruncated, true)
})

test('lifeos_triage commit: 调 draft 方法保存候选，且绝不调 applyTriage', async () => {
  const calls = []
  const service = makeTriageService({
    applyTriage(input) {
      calls.push(input)
      return { applied: 99 }
    },
  })
  const candidate = makeCandidate({ risks: ['日期歧义'], requiresConfirm: false })
  const value = await triageTool(service).execute(
    { action: 'commit', runId: 'run_1', candidates: [candidate] },
    EXEC,
  )
  assert.equal(value.ok, true)
  assert.equal(value.runId, 'run_1')
  assert.equal(value.saved, 1)
  assert.equal(value.needsConfirm, 1, 'risks 存在时自动视为需确认')
  assert.equal(value.alreadyDone, false)
  const draft = lastCall(service, 'saveTriageCandidates').args[0]
  assert.equal(draft.runId, 'run_1')
  assert.equal(draft.candidates[0].kind, 'metric')
  assert.equal(draft.candidates[0].source.quote, '8000 步')
  assert.deepEqual(draft.candidates[0].risks, ['日期歧义'])
  assert.equal(draft.candidates[0].requiresConfirm, true)
  assert.equal(calls.length, 0, 'commit 只保存候选，不能调用 applyTriage 落业务表')
})

test('lifeos_triage commit: 候选校验（空数组/缺 quote/非法 kind/缺 rawRecordId/非法 span）', async () => {
  const service = makeTriageService()
  const tool = triageTool(service)

  const empty = await tool.execute({ action: 'commit', runId: 'run_1', candidates: [] }, EXEC)
  assert.equal(empty.error.code, 'validation_failed')

  const noQuote = await tool.execute(
    { action: 'commit', runId: 'run_1', candidates: [makeCandidate({ source: { start: 0, end: 2 } })] },
    EXEC,
  )
  assert.equal(noQuote.error.code, 'validation_failed')

  const badKind = await tool.execute(
    { action: 'commit', runId: 'run_1', candidates: [makeCandidate({ kind: 'note' })] },
    EXEC,
  )
  assert.equal(badKind.error.code, 'validation_failed')

  const noRaw = await tool.execute(
    { action: 'commit', runId: 'run_1', candidates: [makeCandidate({ rawRecordId: '' })] },
    EXEC,
  )
  assert.equal(noRaw.error.code, 'validation_failed')

  const badSpan = await tool.execute(
    { action: 'commit', runId: 'run_1', candidates: [makeCandidate({ source: { quote: 'x', start: -1, end: 2 } })] },
    EXEC,
  )
  assert.equal(badSpan.error.code, 'validation_failed')
  assert.equal(service.calls.length, 0, '校验失败不应触达 service')
})

test('lifeos_triage commit: 归一化置信度/默认 candidateId/requiresConfirm', async () => {
  const service = makeTriageService()
  const value = await triageTool(service).execute(
    {
      action: 'commit',
      runId: 'run_1',
      candidates: [
        { rawRecordId: 'rr_1', kind: 'task', confidence: 1.7, source: { quote: '周五前发给导师', start: 0, end: 7 }, fields: { title: '发实验结果' } },
      ],
    },
    EXEC,
  )
  assert.equal(value.ok, true)
  const saved = lastCall(service, 'saveTriageCandidates').args[0].candidates[0]
  assert.equal(saved.candidateId, 'cand_1')
  assert.equal(saved.confidence, 1, '置信度夹到 0–1')
  assert.equal(saved.requiresConfirm, false)
})

test('lifeos_triage commit: 缺 runId → validation_failed', async () => {
  const service = makeTriageService()
  const value = await triageTool(service).execute({ action: 'commit', candidates: [makeCandidate()] }, EXEC)
  assert.equal(value.error.code, 'validation_failed')
  assert.equal(service.calls.length, 0)
})

test('lifeos_triage commit: 服务没有 draft 接口 → internal（提示需 B 增补），不落业务表', async () => {
  const calls = []
  const service = makeTriageService({
    applyTriage(input) {
      calls.push(input)
      return {}
    },
  })
  delete service.saveTriageCandidates
  const value = await triageTool(service).execute({ action: 'commit', runId: 'run_1', candidates: [makeCandidate()] }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'internal')
  assert.match(value.error.message, /saveTriageCandidates/)
  assert.equal(calls.length, 0)
})

test('lifeos_triage commit: 支持别名 commitTriageCandidates', async () => {
  const service = makeTriageService()
  delete service.saveTriageCandidates
  service.commitTriageCandidates = (input) => ({ saved: input.candidates.length, needsConfirm: 0, run: { id: input.runId } })
  const value = await triageTool(service).execute({ action: 'commit', runId: 'run_1', candidates: [makeCandidate()] }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.saved, 1)
})

test('lifeos_triage abort: 服务支持时持久化；不支持时 ok=true + persisted=false + warning', async () => {
  const service = makeTriageService()
  const supported = await triageTool(service).execute({ action: 'abort', runId: 'run_1', reason: '用户取消' }, EXEC)
  assert.equal(supported.ok, true)
  assert.equal(supported.persisted, true)
  assert.deepEqual(lastCall(service, 'abortTriage').args[0], { runId: 'run_1', reason: '用户取消' })
  assert.match(renderTriage({}, supported)[0].text, /已放弃整理批次：run_1/)

  const bare = makeTriageService()
  delete bare.abortTriage
  const unsupported = await triageTool(bare).execute({ action: 'abort', runId: 'run_1' }, EXEC)
  assert.equal(unsupported.ok, true)
  assert.equal(unsupported.persisted, false)
  assert.match(unsupported.warning, /abortTriage/)
  assert.match(renderTriage({}, unsupported)[0].text, /服务未持久化/)
})

test('lifeos_triage render: begin 含批次与指令；commit 强调未落业务表；failure 可读', () => {
  const begin = renderTriage({}, {
    ok: true, action: 'begin', runId: 'run_1', count: 2, alreadyDone: false,
    batches: [
      { rawRecordId: 'rr_1', text: '今天走了 8000 步', localDate: '2026-11-13' },
      { rawRecordId: 'rr_2', text: '周五前把实验结果发给导师' },
    ],
  })[0].text
  assert.match(begin, /整理批次：run_1/)
  assert.match(begin, /待抽取原文 2 条/)
  assert.match(begin, /lifeos_triage\(commit/)
  assert.match(begin, /不要声称已创建/)

  const commit = renderTriage({}, { ok: true, action: 'commit', runId: 'run_1', saved: 3, needsConfirm: 1 })[0].text
  assert.match(commit, /已保存整理候选：3 条（需用户确认 1 条）/)
  assert.match(commit, /候选尚未写入业务表/)

  const failure = renderTriage({}, { ok: false, error: { code: 'validation_failed', message: 'bad', hint: 'hint' } })[0].text
  assert.match(failure, /整理操作失败（validation_failed）/)
})

// ════════════════════════════════════════════════════════════════
// M2 · lifeos_correct（L3 预演 → confirm 执行）
// ════════════════════════════════════════════════════════════════

test('lifeos_correct: schema（type/action 枚举、必填、confirm）', () => {
  const tool = correctTool({})
  assert.equal(tool.name, 'lifeos_correct')
  assert.deepEqual(tool.parameters.required, ['type', 'id', 'action'])
  assert.deepEqual(tool.parameters.properties.type.enum, ['task', 'event', 'metric', 'habit_checkin'])
  assert.deepEqual(tool.parameters.properties.action.enum, ['update', 'revoke'])
  assert.equal(tool.parameters.properties.confirm.type, 'boolean')
  assert.equal(tool.isConcurrencySafe(), false)
  assert.match(tool.description, /L3/)
})

test('lifeos_correct update: 不带 confirm 只预演（含 task 当前值 before）', async () => {
  const service = makeTriageService()
  const value = await correctTool(service).execute(
    { type: 'task', id: 'tsk_1', action: 'update', patch: { dueDate: '2026-11-20' }, reason: '用户说日期不对' },
    EXEC,
  )
  assert.equal(value.ok, true)
  assert.equal(value.needsConfirm, true)
  assert.equal(value.action, 'correct')
  assert.equal(value.correctAction, 'update')
  assert.deepEqual(value.preview.changes.dueDate, { before: '2026-11-15', after: '2026-11-20' })
  assert.equal(value.preview.reason, '用户说日期不对')
  assert.equal(service.calls.filter((call) => call.method === 'correctDerived').length, 0)
  const text = renderCorrect({}, value)[0].text
  assert.match(text, /需要你确认（纠错：修改）task tsk_1：「写报告」/)
  assert.match(text, /dueDate：2026-11-15 → 2026-11-20/)
})

test('lifeos_correct revoke: 不带 confirm 只预演状态变更；不要求 patch', async () => {
  const service = makeTriageService()
  const value = await correctTool(service).execute(
    { type: 'metric', id: 'mtr_1', action: 'revoke', reason: '用户撤回' },
    EXEC,
  )
  assert.equal(value.needsConfirm, true)
  assert.deepEqual(value.preview.changes.status, { before: null, after: 'revoked' })
  assert.equal(service.calls.length, 0)
})

test('lifeos_correct update: 缺 patch → validation_failed', async () => {
  const service = makeTriageService()
  const value = await correctTool(service).execute({ type: 'event', id: 'evt_1', action: 'update' }, EXEC)
  assert.equal(value.error.code, 'validation_failed')
  assert.equal(service.calls.length, 0)
})

test('lifeos_correct: 非法 type / action → validation_failed', async () => {
  const service = makeTriageService()
  const badType = await correctTool(service).execute({ type: 'wish', id: 'x', action: 'revoke' }, EXEC)
  assert.equal(badType.error.code, 'validation_failed')
  const badAction = await correctTool(service).execute({ type: 'task', id: 'x', action: 'delete' }, EXEC)
  assert.equal(badAction.error.code, 'validation_failed')
})

test('lifeos_correct update + confirm:true 调 correctDerived 并回影响面', async () => {
  const service = makeTriageService()
  const value = await correctTool(service).execute(
    { type: 'metric', id: 'mtr_1', action: 'update', patch: { value_num: 8000 }, reason: '步数记错', confirm: true },
    EXEC,
  )
  assert.equal(value.ok, true)
  assert.equal(value.needsConfirm, undefined)
  assert.equal(value.affected.length, 2)
  const call = lastCall(service, 'correctDerived')
  assert.deepEqual(call.args[0], { type: 'metric', id: 'mtr_1', action: 'update', patch: { value_num: 8000 }, reason: '步数记错' })
  assert.deepEqual(call.args[1], { actor: 'agent', sessionId: 'agent_lifeos', idempotencyKey: 'call_task_1' })
  const text = renderCorrect({}, value)[0].text
  assert.match(text, /已更正 metric mtr_1（L3 已确认）/)
  assert.match(text, /影响 2 项派生/)
})

test('lifeos_correct revoke + confirm:true：不传 patch', async () => {
  const service = makeTriageService()
  const value = await correctTool(service).execute(
    { type: 'habit_checkin', id: 'hci_1', action: 'revoke', confirm: true },
    EXEC,
  )
  assert.equal(value.ok, true)
  assert.deepEqual(lastCall(service, 'correctDerived').args[0], { type: 'habit_checkin', id: 'hci_1', action: 'revoke' })
  assert.match(renderCorrect({}, value)[0].text, /已撤回 habit_checkin hci_1/)
})

test('lifeos_correct: service 报 conflict → ok:false + 可读 render', async () => {
  const service = makeTriageService({
    correctDerived() {
      const error = new Error('版本冲突')
      error.code = 'conflict'
      throw error
    },
  })
  const value = await correctTool(service).execute(
    { type: 'task', id: 'tsk_1', action: 'update', patch: { title: 'x' }, confirm: true },
    EXEC,
  )
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'conflict')
  assert.match(renderCorrect({}, value)[0].text, /纠错失败（conflict）/)
})

test('lifeos_correct: 服务未提供 correctDerived → internal（不崩）', async () => {
  const value = await correctTool({}).execute(
    { type: 'task', id: 'tsk_1', action: 'revoke', confirm: true },
    EXEC,
  )
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'internal')
  assert.match(value.error.message, /correctDerived/)
})

// ════════════════════════════════════════════════════════════════
// M2/M3 · preset 守则 prompt（≤1200 字符）
// ════════════════════════════════════════════════════════════════

test('preset-prompt: 守则合计 ≤1200 字符且包含关键约束', () => {
  assert.ok(ORGANIZE_RULES.length <= 1200, `守则 ${ORGANIZE_RULES.length} 字符超过 1200`)
  assert.match(ORGANIZE_RULES, /只抽取原文明确/)
  assert.match(ORGANIZE_RULES, /不编造|不补全/)
  assert.match(ORGANIZE_RULES, /否定/)
  assert.match(ORGANIZE_RULES, /候选/)
  assert.match(ORGANIZE_RULES, /source\.quote|原文子串/)
  assert.match(ORGANIZE_RULES, /requiresConfirm/)
})

test('preset-prompt: section name/order 固定（preset 平面，不污染标准会话）', () => {
  assert.equal(ORGANIZE_RULES_SECTION_NAME, 'lifeos:organize-rules')
  assert.equal(ORGANIZE_RULES_ORDER, 60)
})

test('preset-prompt: M2.5 追加笔记守则（目录内/不覆盖/回显路径/截断提示）', () => {
  assert.match(ORGANIZE_RULES, /笔记守则/)
  assert.match(ORGANIZE_RULES, /笔记目录内/)
  assert.match(ORGANIZE_RULES, /不覆盖|append/)
  assert.match(ORGANIZE_RULES, /回显.*路径|路径.*回显/)
  assert.match(ORGANIZE_RULES, /截断/)
  assert.ok(ORGANIZE_RULES.length <= 1200, `追加笔记/日记守则后 ${ORGANIZE_RULES.length} 字超过 1200`)
})

// ════════════════════════════════════════════════════════════════
// M2.5 · lifeos_notes（本地 Markdown 笔记）
// ════════════════════════════════════════════════════════════════

/** fake note-service（M2.5-PLAN §2.2 API）+ 挂到 ctx.lifeos.notes。 */
function makeNotesService(overrides = {}) {
  const calls = []
  const state = {
    config: { dir: 'D:\\Notes', options: {}, exists: true, writable: true },
    files: new Map([
      ['日记/2026-11-13.md', { content: '# 今天\n走了 8000 步', mtime: '2026-11-13T10:00:00.000Z', hash: 'hash_1' }],
      ['项目/lifeos.md', { content: '- 完成 M2.5 工具', mtime: '2026-11-13T09:00:00.000Z', hash: 'hash_2' }],
    ]),
    entries: [
      { name: '日记', path: '日记', type: 'dir', mtime: '2026-11-13T10:00:00.000Z' },
      { name: '2026-11-13.md', path: '日记/2026-11-13.md', type: 'file', size: 2048, mtime: '2026-11-13T10:00:00.000Z', editable: true },
      { name: 'x.pdf', path: 'x.pdf', type: 'file', size: 10240, mtime: '2026-11-13T08:00:00.000Z', editable: false },
    ],
    searchItems: [
      { path: '日记/2026-11-13.md', title: '2026-11-13', snippet: '走了 8000 步', mtime: '2026-11-13T10:00:00.000Z' },
      { path: '项目/lifeos.md', title: 'lifeos', snippet: '完成 M2.5 工具', mtime: '2026-11-13T09:00:00.000Z' },
    ],
  }
  const notes = {
    calls,
    state,
    getConfig() {
      calls.push({ method: 'getConfig' })
      return state.config
    },
    list(input) {
      calls.push({ method: 'list', args: [input] })
      return { entries: state.entries }
    },
    read(input) {
      calls.push({ method: 'read', args: [input] })
      const file = state.files.get(input.path)
      if (!file) {
        const error = new Error(`笔记不存在：${input.path}`)
        error.code = 'not_found'
        throw error
      }
      return { path: input.path, content: file.content, mtime: file.mtime, hash: file.hash, size: file.content.length, encoding: 'utf-8' }
    },
    search(input) {
      calls.push({ method: 'search', args: [input] })
      return { items: state.searchItems.slice(0, input.limit) }
    },
    create(input) {
      calls.push({ method: 'create', args: [input] })
      state.files.set(input.path, { content: input.content, hash: 'hash_new', mtime: '2026-11-13T11:00:00.000Z' })
      return { path: input.path, mtime: '2026-11-13T11:00:00.000Z', hash: 'hash_new', size: input.content.length }
    },
    write(input) {
      calls.push({ method: 'write', args: [input] })
      const existing = state.files.get(input.path)
      if (input.baseHash && (!existing || existing.hash !== input.baseHash)) {
        const error = new Error('文件已被外部修改')
        error.code = 'conflict'
        throw error
      }
      state.files.set(input.path, { content: input.content, hash: 'hash_written', mtime: '2026-11-13T12:00:00.000Z' })
      return { path: input.path, mtime: '2026-11-13T12:00:00.000Z', hash: 'hash_written', size: input.content.length }
    },
  }
  return Object.assign(notes, overrides)
}

function lifeosWithNotes(notes) {
  return { notes }
}

function noteCallCount(notes, method) {
  return notes.calls.filter((call) => call.method === method).length
}

test('lifeos_notes: schema（5 action / path/dir/depth/q/limit/content / 单 type output）', () => {
  const tool = notesTool({})
  assert.equal(tool.name, 'lifeos_notes')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.deepEqual(tool.parameters.properties.action.enum, ['list', 'read', 'search', 'create', 'append'])
  assert.equal(tool.parameters.properties.depth.maximum, 10)
  assert.equal(tool.parameters.properties.limit.maximum, 50)
  assert.equal(tool.parameters.properties.content.type, 'string')
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.isConcurrencySafe({ action: 'read' }), true)
  assert.equal(tool.isConcurrencySafe({ action: 'create' }), false)
  assert.match(tool.description, /不覆盖用户原文/)
  assert.match(tool.description, /笔记目录内/)
})

test('lifeos_notes: 非法 action → validation_failed，不触达 notes', async () => {
  const notes = makeNotesService()
  const value = await notesTool(lifeosWithNotes(notes)).execute({ action: 'delete', path: 'x.md' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'validation_failed')
  assert.equal(notes.calls.length, 0)
})

test('lifeos_notes: ctx.lifeos.notes 未挂接 → notes_unavailable（不崩）', async () => {
  const value = await notesTool({}).execute({ action: 'list' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'notes_unavailable')
  const text = renderNotes({}, value)[0].text
  assert.match(text, /笔记操作失败（notes_unavailable）/)
  assert.match(text, /笔记服务尚未就绪/)
})

test('lifeos_notes: 未配置笔记目录 → notes_dir_unconfigured + 设置引导文案', async () => {
  const notes = makeNotesService({ getConfig: () => ({ dir: '', exists: false, writable: false }) })
  const value = await notesTool(lifeosWithNotes(notes)).execute({ action: 'list' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'notes_dir_unconfigured')
  const text = renderNotes({}, value)[0].text
  assert.match(text, /请先在设置里选择笔记目录/)
  assert.equal(noteCallCount(notes, 'list'), 0)
})

test('lifeos_notes: 目录不可写 → notes_dir_readonly', async () => {
  const notes = makeNotesService({ getConfig: () => ({ dir: 'D:\\Notes', exists: true, writable: false }) })
  const value = await notesTool(lifeosWithNotes(notes)).execute({ action: 'list' }, EXEC)
  assert.equal(value.error.code, 'notes_dir_readonly')
  assert.match(renderNotes({}, value)[0].text, /笔记目录当前不可写/)
})

test('lifeos_notes list: 默认根目录、归一化目录/文件、render 含 📁 与文件大小', async () => {
  const notes = makeNotesService()
  const value = await notesTool(lifeosWithNotes(notes)).execute({ action: 'list' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.count, 3)
  assert.equal(value.dir, 'D:\\Notes')
  assert.deepEqual(lastCall(notes, 'list').args[0], {})
  assert.equal(value.entries[0].type, 'dir')
  assert.equal(value.entries[1].type, 'file')
  assert.equal(value.entries[2].editable, false)
  const text = renderNotes({}, value)[0].text
  assert.match(text, /笔记（D:\\Notes）：3 项/)
  assert.match(text, /📁 日记\//)
  assert.match(text, /2026-11-13\.md｜2\.0KB/)
  assert.match(text, /（不可编辑）/)
})

test('lifeos_notes list: dir 传 "." 或 "./" 视为根目录（不带 dir 透传）', async () => {
  const notes = makeNotesService()
  const value = await notesTool(lifeosWithNotes(notes)).execute({ action: 'list', dir: '.' }, EXEC)
  assert.equal(value.ok, true)
  assert.deepEqual(lastCall(notes, 'list').args[0], {})
  const value2 = await notesTool(lifeosWithNotes(notes)).execute({ action: 'list', dir: './' }, EXEC)
  assert.equal(value2.ok, true)
  assert.deepEqual(lastCall(notes, 'list').args[0], {})
})

test('lifeos_notes list: dir/depth 透传；空列表 render 提示可 create', async () => {
  const notes = makeNotesService()
  notes.list = (input) => {
    notes.calls.push({ method: 'list', args: [input] })
    return { entries: [] }
  }
  await notesTool(lifeosWithNotes(notes)).execute({ action: 'list', dir: '项目', depth: 2 }, EXEC)
  assert.deepEqual(lastCall(notes, 'list').args[0], { dir: '项目', depth: 2 })
  const value = await notesTool(lifeosWithNotes(notes)).execute({ action: 'list' }, EXEC)
  const text = renderNotes({}, value)[0].text
  assert.match(text, /暂无笔记/)
})

test('lifeos_notes read: 返回原文与元信息，render 含路径/字数/内容', async () => {
  const notes = makeNotesService()
  const value = await notesTool(lifeosWithNotes(notes)).execute({ action: 'read', path: '日记/2026-11-13.md' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.truncated, false)
  assert.equal(value.totalChars, 14)
  assert.equal(value.path, '日记/2026-11-13.md')
  assert.equal(value.hash, 'hash_1')
  assert.deepEqual(lastCall(notes, 'read').args[0], { path: '日记/2026-11-13.md' })
  const text = renderNotes({}, value)[0].text
  assert.match(text, /笔记：日记\/2026-11-13\.md｜14 字/)
  assert.match(text, /走了 8000 步/)
})

test('lifeos_notes read: 超 8000 字截断并提示分段/在面板查看', async () => {
  const longContent = '字'.repeat(9000)
  const notes = makeNotesService({
    read: () => ({ path: '长文.md', content: longContent, mtime: '2026-11-13T10:00:00.000Z', hash: 'h', size: 27000, encoding: 'utf-8' }),
  })
  const value = await notesTool(lifeosWithNotes(notes)).execute({ action: 'read', path: '长文.md' }, EXEC)
  assert.equal(value.truncated, true)
  assert.equal(value.content.length, 8000)
  assert.equal(value.totalChars, 9000)
  const text = renderNotes({}, value)[0].text
  assert.match(text, /（已截断）/)
  assert.match(text, /只显示前 8000 字/)
  assert.match(text, /笔记 tab 打开/)
})

test('lifeos_notes read: 缺 path → validation_failed', async () => {
  const notes = makeNotesService()
  const value = await notesTool(lifeosWithNotes(notes)).execute({ action: 'read' }, EXEC)
  assert.equal(value.error.code, 'validation_failed')
  assert.equal(noteCallCount(notes, 'read'), 0)
})

test('lifeos_notes read: 超大文件错误映射 file_too_large（提示用外部编辑器）', async () => {
  const notes = makeNotesService({
    read: () => {
      const error = new Error('文件超过 2MB')
      error.code = 'file_too_large'
      throw error
    },
  })
  const value = await notesTool(lifeosWithNotes(notes)).execute({ action: 'read', path: 'big.md' }, EXEC)
  assert.equal(value.error.code, 'file_too_large')
  assert.match(value.error.hint, /2MB/)
  assert.match(renderNotes({}, value)[0].text, /笔记操作失败（file_too_large）/)
})

test('lifeos_notes search: q 必填、默认 limit 20、items 归一化', async () => {
  const notes = makeNotesService()
  const value = await notesTool(lifeosWithNotes(notes)).execute({ action: 'search', q: '8000' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.q, '8000')
  assert.equal(value.count, 2)
  assert.equal(value.items[0].path, '日记/2026-11-13.md')
  assert.deepEqual(lastCall(notes, 'search').args[0], { q: '8000', limit: 20 })
  assert.match(renderNotes({}, value)[0].text, /搜索「8000」：2 条/)

  const missing = await notesTool(lifeosWithNotes(notes)).execute({ action: 'search' }, EXEC)
  assert.equal(missing.error.code, 'validation_failed')
})

test('lifeos_notes search: limit 透传并夹到最大 50；空结果 render 说明', async () => {
  const notes = makeNotesService()
  notes.search = (input) => {
    notes.calls.push({ method: 'search', args: [input] })
    return { items: [] }
  }
  const value = await notesTool(lifeosWithNotes(notes)).execute({ action: 'search', q: 'x', limit: 999 }, EXEC)
  assert.deepEqual(lastCall(notes, 'search').args[0], { q: 'x', limit: 50 })
  assert.match(renderNotes({}, value)[0].text, /没有匹配的笔记/)
})

test('lifeos_notes create: L2 直接调 notes.create 并回显路径/字数（无需确认）', async () => {
  const notes = makeNotesService()
  const value = await notesTool(lifeosWithNotes(notes)).execute(
    { action: 'create', path: '日记/2026-11-14.md', content: '# 明天\n写周报' },
    EXEC,
  )
  assert.equal(value.ok, true)
  assert.equal(value.action, 'create')
  assert.equal(value.path, '日记/2026-11-14.md')
  assert.equal(value.chars, 8)
  assert.deepEqual(lastCall(notes, 'create').args[0], { path: '日记/2026-11-14.md', content: '# 明天\n写周报' })
  assert.match(renderNotes({}, value)[0].text, /已创建笔记：日记\/2026-11-14\.md（8 字）/)
})

test('lifeos_notes create: 无 create() 时回退 write(create:true)；content 可省略', async () => {
  const notes = makeNotesService()
  delete notes.create
  const value = await notesTool(lifeosWithNotes(notes)).execute({ action: 'create', path: '空笔记.md' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.chars, 0)
  assert.deepEqual(lastCall(notes, 'write').args[0], { path: '空笔记.md', content: '', create: true })
})

test('lifeos_notes create: 缺 path / content 超长 → validation_failed', async () => {
  const notes = makeNotesService()
  const noPath = await notesTool(lifeosWithNotes(notes)).execute({ action: 'create', content: 'x' }, EXEC)
  assert.equal(noPath.error.code, 'validation_failed')
  const tooLong = await notesTool(lifeosWithNotes(notes)).execute(
    { action: 'create', path: 'x.md', content: 'x'.repeat(200001) },
    EXEC,
  )
  assert.equal(tooLong.error.code, 'validation_failed')
  assert.equal(notes.calls.length, 0)
})

test('lifeos_notes append: read + write(baseHash) 实现"追加不覆盖"，缺换行自动补', async () => {
  const notes = makeNotesService()
  const value = await notesTool(lifeosWithNotes(notes)).execute(
    { action: 'append', path: '项目/lifeos.md', content: '- 新增：笔记工具' },
    EXEC,
  )
  assert.equal(value.ok, true)
  assert.equal(value.action, 'append')
  assert.equal(value.appendedChars, 9)
  const writeCall = lastCall(notes, 'write').args[0]
  assert.equal(writeCall.path, '项目/lifeos.md')
  assert.equal(writeCall.content, '- 完成 M2.5 工具\n- 新增：笔记工具', '原文未以换行结尾时自动补一个换行')
  assert.equal(writeCall.baseHash, 'hash_2', '写入带 baseHash 做冲突检测')
  assert.match(renderNotes({}, value)[0].text, /已追加到笔记：项目\/lifeos\.md（\+9 字/)

  const notes2 = makeNotesService()
  await notesTool(lifeosWithNotes(notes2)).execute({ action: 'append', path: '日记/2026-11-13.md', content: '- 晚饭' }, EXEC)
  assert.equal(lastCall(notes2, 'write').args[0].content, '# 今天\n走了 8000 步\n- 晚饭')
})

test('lifeos_notes append: 服务原生 append() 优先使用', async () => {
  const notes = makeNotesService({
    append: (input) => {
      notes.calls.push({ method: 'append', args: [input] })
      return { path: input.path, totalChars: 42, mtime: '2026-11-13T12:00:00.000Z', hash: 'h' }
    },
  })
  const value = await notesTool(lifeosWithNotes(notes)).execute({ action: 'append', path: 'x.md', content: 'hello' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.appendedChars, 5)
  assert.equal(value.totalChars, 42)
  assert.deepEqual(lastCall(notes, 'append').args[0], { path: 'x.md', content: 'hello' })
  assert.equal(noteCallCount(notes, 'write'), 0)
  assert.match(renderNotes({}, value)[0].text, /已追加到笔记：x\.md（\+5 字，共 42 字）/)
})

test('lifeos_notes append: 空 content/缺 path → validation_failed', async () => {
  const notes = makeNotesService()
  const empty = await notesTool(lifeosWithNotes(notes)).execute({ action: 'append', path: 'x.md', content: '' }, EXEC)
  assert.equal(empty.error.code, 'validation_failed')
  const noPath = await notesTool(lifeosWithNotes(notes)).execute({ action: 'append', content: 'x' }, EXEC)
  assert.equal(noPath.error.code, 'validation_failed')
  assert.equal(notes.calls.length, 0)
})

test('lifeos_notes append: 文件不存在 → not_found（提示用 create）', async () => {
  const notes = makeNotesService()
  const value = await notesTool(lifeosWithNotes(notes)).execute({ action: 'append', path: '不存在.md', content: 'x' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'not_found')
  assert.match(value.error.hint, /不要猜测 ID|create/)
})

test('lifeos_notes append: 外部修改冲突 → conflict + 笔记专用提示', async () => {
  const notes = makeNotesService()
  notes.read = () => ({ path: 'x.md', content: 'old', mtime: 'm', hash: 'stale', size: 3, encoding: 'utf-8' })
  const value = await notesTool(lifeosWithNotes(notes)).execute({ action: 'append', path: 'x.md', content: 'new' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'conflict')
  assert.match(value.error.hint, /外部修改/)
  assert.match(renderNotes({}, value)[0].text, /笔记操作失败（conflict）/)
})

test('lifeos_notes: 兼容 getNotes() 挂接；list 过滤无效条目', async () => {
  const notes = makeNotesService({ list: () => ({ entries: [null, { path: '' }, ...notes.state.entries] }) })
  const service = { getNotes: () => notes }
  const value = await notesTool(service).execute({ action: 'list' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.count, 3)
})

test('lifeos_notes: 注册时必须走 when 门控（notes 仅在 lifeos preset 可见）', () => {
  const { ctx, definitions, registerOptions } = fakeCtx({})
  registerTools(ctx, {})
  const index = definitions.findIndex((definition) => definition.name === 'lifeos_notes')
  assert.ok(index >= 0)
  assert.equal(typeof registerOptions[index]?.when, 'function')
  assert.equal(registerOptions[index].when({ agent: LIFEOS_AGENT }), true)
  assert.equal(registerOptions[index].when({ agent: STANDARD_AGENT }), false)
})

// ════════════════════════════════════════════════════════════════
// M3 · lifeos_settings（自动化设置元能力，L3 预演 → confirm 执行）
// ════════════════════════════════════════════════════════════════

const SETTINGS_FIXTURE = {
  morningBrief: { enabled: true, time: '07:35' },
  eveningReview: { enabled: false, time: '21:00' },
  habitNudge: { enabled: false, time: '20:30' },
  nightlyInbox: { enabled: true, time: '21:30' },
  deadlineReminder: { enabled: true, leadMinutes: 60, dueDateAt: '09:00' },
  dnd: { start: '22:45', end: '07:30' },
  dailyBudget: 2,
  suggestions: { enabled: true, maxPerDay: 2 },
  dndPolicy: 'skip',
}

function mergeTestSettings(current, patch) {
  const next = {}
  for (const [key, value] of Object.entries(current ?? {})) {
    next[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : value
  }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) next[key] = { ...(next[key] ?? {}), ...value }
    else next[key] = value
  }
  return next
}

/** fake automation 服务（M3-PLAN §1/§5）：getSettings / patchSettings。 */
function makeAutomationService(overrides = {}) {
  const calls = []
  const state = { settings: JSON.parse(JSON.stringify(SETTINGS_FIXTURE)), revision: 5 }
  const automation = {
    calls,
    state,
    getSettings() {
      calls.push({ method: 'getSettings' })
      return { settings: JSON.parse(JSON.stringify(state.settings)), revision: state.revision }
    },
    patchSettings(patch, options) {
      calls.push({ method: 'patchSettings', args: [patch, options] })
      state.settings = mergeTestSettings(state.settings, patch)
      state.revision += 1
      return {
        settings: JSON.parse(JSON.stringify(state.settings)),
        revision: state.revision,
        impacted: [{ kind: 'schedule', id: 'sch_morning', action: 'update' }],
      }
    },
  }
  return { automation: Object.assign(automation, overrides) }
}

function settingsService(automation) {
  return { automation }
}

test('lifeos_settings: schema（get/set、patch 对象、confirm；output 单 type）', () => {
  const tool = settingsTool({})
  assert.equal(tool.name, 'lifeos_settings')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.deepEqual(tool.parameters.properties.action.enum, ['get', 'set'])
  assert.equal(tool.parameters.properties.patch.type, 'object')
  assert.equal(tool.parameters.properties.confirm.type, 'boolean')
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.isConcurrencySafe({ action: 'get' }), true)
  assert.equal(tool.isConcurrencySafe({ action: 'set' }), false)
  assert.match(tool.description, /L3/)
  assert.match(tool.description, /预演|diff/)
})

test('lifeos_settings: 非法 action → validation_failed，不调服务', async () => {
  const service = settingsService(makeAutomationService().automation)
  const value = await settingsTool(service).execute({ action: 'delete' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'validation_failed')
  assert.equal(service.automation.calls.length, 0)
})

test('lifeos_settings get: 无 automation 也无旧接口 → automation_unavailable（不崩）', async () => {
  const value = await settingsTool({}).execute({ action: 'get' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'automation_unavailable')
  assert.match(renderSettings({}, value)[0].text, /设置操作失败（automation_unavailable）/)
})

test('lifeos_settings get: 只有 M2 旧 getAutomation → 降级只读 + 中文提示', async () => {
  const legacy = async () => ({ enabled: true, time: '21:30', timeZone: 'Asia/Shanghai', schedulerAvailable: false, healthy: false })
  const value = await settingsTool({ getAutomation: legacy }).execute({ action: 'get' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.degraded, true)
  assert.equal(value.legacy, true)
  assert.equal(value.settings.nightlyInbox.enabled, true)
  assert.equal(value.settings.nightlyInbox.time, '21:30')
  const text = renderSettings({}, value)[0].text
  assert.match(text, /当前自动化设置/)
  assert.match(text, /⚠️ M3 自动化服务未就绪/)
})

test('lifeos_settings get: 完整设置 → 中文摘要含各 routine/免打扰/预算/建议', async () => {
  const service = settingsService(makeAutomationService().automation)
  const value = await settingsTool(service).execute({ action: 'get' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.revision, 5)
  assert.equal(value.settings.dailyBudget, 2)
  const text = renderSettings({}, value)[0].text
  assert.match(text, /晨间简报：开 07:35/)
  assert.match(text, /晚报：关 21:00/)
  assert.match(text, /习惯追问：关 20:30/)
  assert.match(text, /夜间整理：开 21:30/)
  assert.match(text, /截止提醒：开（提前 60 分钟；仅日期任务 09:00）/)
  assert.match(text, /免打扰：22:45–07:30（静默期跳过）/)
  assert.match(text, /每日主动消息上限：2 条/)
  assert.match(text, /建议卡：开，每天最多 2 条/)
})

test('lifeos_settings get: 缺字段用默认值补齐；直接返回 settings 对象也兼容', async () => {
  const automation = {
    getSettings: () => ({ dnd: { start: '23:00' } }),
    patchSettings: () => ({}),
  }
  const value = await settingsTool({ automation }).execute({ action: 'get' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.settings.dnd.start, '23:00')
  assert.equal(value.settings.dnd.end, '07:30')
  assert.equal(value.settings.morningBrief.enabled, true)
  assert.equal(value.settings.dailyBudget, 2)
})

test('lifeos_settings set: 未 confirm 只预演（diff + impacts），不调 patchSettings', async () => {
  const automation = makeAutomationService()
  const service = settingsService(automation.automation)
  const value = await settingsTool(service).execute({ action: 'set', patch: { dailyBudget: 1 } }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.needsConfirm, true)
  assert.deepEqual(value.diff, [{ path: 'dailyBudget', before: 2, after: 1 }])
  assert.match(value.impacts.join('；'), /每日主动消息上限改为 1 条/)
  assert.equal(noteCallCount(automation.automation, 'patchSettings'), 0)
  const text = renderSettings({}, value)[0].text
  assert.match(text, /需要你确认（设置变更，L3）/)
  assert.match(text, /dailyBudget：2 → 1/)
  assert.match(text, /- 每日主动消息上限改为 1 条/)
})

test('lifeos_settings set 预演: 免打扰变更 → 影响面含新窗口', async () => {
  const automation = makeAutomationService()
  const value = await settingsTool(settingsService(automation.automation)).execute(
    { action: 'set', patch: { dnd: { start: '23:00' } } },
    EXEC,
  )
  assert.equal(value.needsConfirm, true)
  assert.match(value.impacts.join('；'), /将把免打扰改为 23:00–07:30/)
})

test('lifeos_settings set 预演: 关闭晨报 → 影响面说明关闭定时任务', async () => {
  const automation = makeAutomationService()
  const value = await settingsTool(settingsService(automation.automation)).execute(
    { action: 'set', patch: { morningBrief: { enabled: false } } },
    EXEC,
  )
  assert.equal(value.needsConfirm, true)
  assert.match(value.impacts.join('；'), /将关闭晨间简报定时任务/)
})

test('lifeos_settings set 预演: 开启晚报/改晨报时间 → 影响面含时间', async () => {
  const automation = makeAutomationService()
  const service = settingsService(automation.automation)
  const evening = await settingsTool(service).execute({ action: 'set', patch: { eveningReview: { enabled: true } } }, EXEC)
  assert.match(evening.impacts.join('；'), /将开启晚报定时任务（每天 21:00 一次主动消息）/)
  const time = await settingsTool(service).execute({ action: 'set', patch: { morningBrief: { time: '08:00' } } }, EXEC)
  assert.match(time.impacts.join('；'), /将把晨间简报时间改为 08:00/)
})

test('lifeos_settings set: 预算低于已开 routine 数 → impacts 给出静默跳过提醒', async () => {
  const automation = makeAutomationService()
  const value = await settingsTool(settingsService(automation.automation)).execute(
    { action: 'set', patch: { eveningReview: { enabled: true } } },
    EXEC,
  )
  assert.equal(value.needsConfirm, true)
  assert.match(value.impacts.join('；'), /已开启 3 个定时 routine.*预算只有 2 条/)
})

test('lifeos_settings set + confirm:true: 调 patchSettings 并回显受影响定时任务', async () => {
  const automation = makeAutomationService()
  const service = settingsService(automation.automation)
  const value = await settingsTool(service).execute({ action: 'set', patch: { dailyBudget: 1 }, confirm: true }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.applied, true)
  assert.equal(value.needsConfirm, undefined)
  assert.deepEqual(noteCallCount(automation.automation, 'patchSettings'), 1)
  assert.deepEqual(lastCall(automation.automation, 'patchSettings').args[0], { dailyBudget: 1 })
  assert.equal(value.impacted.length, 1)
  assert.equal(value.settings.dailyBudget, 1)
  const text = renderSettings({}, value)[0].text
  assert.match(text, /已更新自动化设置（1 项变更）/)
  assert.match(text, /受影响定时任务：1 项/)
  assert.match(text, /可在设置页查看或回滚/)
})

test('lifeos_settings set: confirm:true 时把 audit 元信息传给 patchSettings（A 的 options）', async () => {
  const automation = makeAutomationService()
  const value = await settingsTool(settingsService(automation.automation)).execute(
    { action: 'set', patch: { dailyBudget: 1 }, confirm: true },
    EXEC,
  )
  assert.equal(value.ok, true)
  const [, options] = lastCall(automation.automation, 'patchSettings').args
  assert.equal(options.source, 'agent')
  assert.equal(options.actorSessionId, 'agent_lifeos')
  assert.equal(typeof options.reason, 'string')
})

test('lifeos_settings set: 无变化 → noChange，不弹确认、不调服务', async () => {
  const automation = makeAutomationService()
  const value = await settingsTool(settingsService(automation.automation)).execute(
    { action: 'set', patch: { dailyBudget: 2 } },
    EXEC,
  )
  assert.equal(value.ok, true)
  assert.equal(value.noChange, true)
  assert.equal(noteCallCount(automation.automation, 'patchSettings'), 0)
  assert.match(renderSettings({}, value)[0].text, /设置没有变化/)
})

test('lifeos_settings set: 缺 patch / 空 patch → validation_failed', async () => {
  const automation = makeAutomationService()
  const service = settingsService(automation.automation)
  const missing = await settingsTool(service).execute({ action: 'set' }, EXEC)
  assert.equal(missing.error.code, 'validation_failed')
  const empty = await settingsTool(service).execute({ action: 'set', patch: {} }, EXEC)
  assert.equal(empty.error.code, 'validation_failed')
  assert.equal(automation.automation.calls.length, 0)
})

test('lifeos_settings set: 不认识的设置项 → unknown_field + 中文提示', async () => {
  const automation = makeAutomationService()
  const value = await settingsTool(settingsService(automation.automation)).execute(
    { action: 'set', patch: { teleport: true } },
    EXEC,
  )
  assert.equal(value.error.code, 'unknown_field')
  assert.match(value.error.hint, /不认识的设置项/)
  assert.equal(automation.automation.calls.length, 0)
})

test('lifeos_settings set: 时间非法 → invalid_time（HH:mm 提示）', async () => {
  const automation = makeAutomationService()
  const service = settingsService(automation.automation)
  for (const bad of ['25:00', '8:00', '0800', '']) {
    const value = await settingsTool(service).execute({ action: 'set', patch: { morningBrief: { time: bad } } }, EXEC)
    assert.equal(value.error.code, 'invalid_time', `bad=${bad}`)
    assert.match(value.error.hint, /HH:mm/)
  }
  assert.equal(automation.automation.calls.length, 0)
})

test('lifeos_settings set: 预算越界 → budget_out_of_range', async () => {
  const automation = makeAutomationService()
  const service = settingsService(automation.automation)
  for (const bad of [6, -1, 1.5, '2']) {
    const value = await settingsTool(service).execute({ action: 'set', patch: { dailyBudget: bad } }, EXEC)
    assert.equal(value.error.code, 'budget_out_of_range', `bad=${JSON.stringify(bad)}`)
  }
  assert.equal(automation.automation.calls.length, 0)
})

test('lifeos_settings set: 免打扰开始=结束（全天）→ dnd_invalid', async () => {
  const automation = makeAutomationService()
  const value = await settingsTool(settingsService(automation.automation)).execute(
    { action: 'set', patch: { dnd: { start: '22:00', end: '22:00' } } },
    EXEC,
  )
  assert.equal(value.error.code, 'dnd_invalid')
  assert.match(value.error.message, /覆盖全天/)
  assert.equal(automation.automation.calls.length, 0)
})

test('lifeos_settings set: 免打扰盖住已开 routine 时间 → dnd_conflict', async () => {
  const automation = makeAutomationService()
  const service = settingsService(automation.automation)
  // 晨报 07:35 已开；把免打扰延到 08:00 会盖住它
  const value = await settingsTool(service).execute({ action: 'set', patch: { dnd: { end: '08:00' } } }, EXEC)
  assert.equal(value.error.code, 'dnd_conflict')
  assert.match(value.error.message, /晨间简报时间 07:35 落在免打扰/)

  // 把习惯追问（20:30）挪进免打扰窗口
  const value2 = await settingsTool(service).execute(
    { action: 'set', patch: { habitNudge: { enabled: true, time: '23:00' } } },
    EXEC,
  )
  assert.equal(value2.error.code, 'dnd_conflict')
  assert.equal(noteCallCount(automation.automation, 'patchSettings'), 0, '冲突只预演，不能执行 patchSettings')
})

test('lifeos_settings set: 子字段法非法/枚举非法 → validation_failed', async () => {
  const automation = makeAutomationService()
  const service = settingsService(automation.automation)
  const unknownSub = await settingsTool(service).execute(
    { action: 'set', patch: { morningBrief: { volume: 3 } } },
    EXEC,
  )
  assert.equal(unknownSub.error.code, 'validation_failed')
  const badPolicy = await settingsTool(service).execute({ action: 'set', patch: { dndPolicy: 'later' } }, EXEC)
  assert.equal(badPolicy.error.code, 'validation_failed')
  const badLead = await settingsTool(service).execute(
    { action: 'set', patch: { deadlineReminder: { leadMinutes: 4 } } },
    EXEC,
  )
  assert.equal(badLead.error.code, 'validation_failed')
  const badMax = await settingsTool(service).execute(
    { action: 'set', patch: { suggestions: { maxPerDay: 11 } } },
    EXEC,
  )
  assert.equal(badMax.error.code, 'validation_failed')
})

test('lifeos_settings set: 服务抛 invalid_time → 错误码/提示透传映射', async () => {
  const automation = makeAutomationService({
    patchSettings() {
      const error = new Error('时间不合法')
      error.code = 'invalid_time'
      throw error
    },
  })
  const value = await settingsTool(settingsService(automation.automation)).execute(
    { action: 'set', patch: { morningBrief: { time: '08:00' } }, confirm: true },
    EXEC,
  )
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'invalid_time')
  assert.match(value.error.hint, /HH:mm/)
})

test('lifeos_settings set: 服务抛 validation_failed 含"预算" → 映射 budget_out_of_range', async () => {
  const automation = makeAutomationService({
    patchSettings() {
      const error = new Error('每日预算超过上限')
      error.code = 'validation_failed'
      throw error
    },
  })
  const value = await settingsTool(settingsService(automation.automation)).execute(
    { action: 'set', patch: { dailyBudget: 1 }, confirm: true },
    EXEC,
  )
  assert.equal(value.error.code, 'budget_out_of_range')
  assert.match(value.error.hint, /0–5/)
})

test('lifeos_settings set: 旧接口（无 automation）→ automation_unavailable，不允许降级写', async () => {
  const value = await settingsTool({ getAutomation: () => ({ enabled: true, time: '21:30' }) }).execute(
    { action: 'set', patch: { dailyBudget: 1 }, confirm: true },
    EXEC,
  )
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'automation_unavailable')
  assert.match(value.error.message, /patchSettings/)
})

test('lifeos_settings set: 服务返回 ok:false → 转成可读失败（不当作成功）', async () => {
  const automation = makeAutomationService({
    patchSettings: () => ({ ok: false, error: { code: 'budget_out_of_range', message: '预算超范围' } }),
  })
  const value = await settingsTool(settingsService(automation.automation)).execute(
    { action: 'set', patch: { dailyBudget: 1 }, confirm: true },
    EXEC,
  )
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'budget_out_of_range')
})

test('lifeos_settings: 注册时必须走 when 门控（仅在 lifeos preset 可见）', () => {
  const { ctx, definitions, registerOptions } = fakeCtx({})
  registerTools(ctx, {})
  const index = definitions.findIndex((definition) => definition.name === 'lifeos_settings')
  assert.ok(index >= 0)
  assert.equal(typeof registerOptions[index]?.when, 'function')
  assert.equal(registerOptions[index].when({ agent: LIFEOS_AGENT }), true)
  assert.equal(registerOptions[index].when({ agent: STANDARD_AGENT }), false)
  assert.ok(LIFEOS_TOOL_NAMES.includes('lifeos_settings'))
})

test('lifeos_settings: render 失败路径可读', () => {
  const text = renderSettings({}, { ok: false, error: { code: 'invalid_time', message: 'bad', hint: 'HH:mm' } })[0].text
  assert.match(text, /设置操作失败（invalid_time）/)
  assert.match(text, /HH:mm/)
})

// ════════════════════════════════════════════════════════════════
// M3 · 日记伙伴守则（preset prompt 第三段）
// ════════════════════════════════════════════════════════════════

test('preset-prompt: 日记伙伴段包含晨记/晚记流程与守住不覆盖的约束', () => {
  assert.match(ORGANIZE_RULES, /日记伙伴/)
  assert.match(ORGANIZE_RULES, /晨记/)
  assert.match(ORGANIZE_RULES, /晚记/)
  assert.match(ORGANIZE_RULES, /lifeos_notes append/)
  assert.match(ORGANIZE_RULES, /未确认前不写|未确认不写/)
  assert.match(ORGANIZE_RULES, /晨记（Agent 草稿，HH:mm）/)
  assert.match(ORGANIZE_RULES, /晚记（Agent 草稿，HH:mm）/)
})

test('preset-prompt: 三段顺序为 整理守则 → 笔记守则 → 日记伙伴', () => {
  const organize = ORGANIZE_RULES.indexOf('【LifeOS 整理守则】')
  const notes = ORGANIZE_RULES.indexOf('【笔记守则】')
  const diary = ORGANIZE_RULES.indexOf('【日记伙伴】')
  assert.ok(organize >= 0)
  assert.ok(notes > organize)
  assert.ok(diary > notes)
  assert.ok(ORGANIZE_RULES.length <= 1200)
})
