/**
 * M4a 集成测试 · D 线（Agent 工具）
 *
 * 范围：`lifeos_habit` / `lifeos_project` / `lifeos_goal` 三个新工具 + `lifeos_today` 的
 * include=habits 扩展 + 工具注册/可见性（标准会话 0 个、LifeOS 会话 10 个）。
 *
 * 为什么用 fake `ctx.lifeos`：A/B 的 habit-service / planning-service 装配尚未落地，
 * 本文件只验证 D 线工具层契约（参数校验、L3 needsConfirm、服务调用与透传），
 * 不依赖真实 store 与路由。服务方法命名取自 M4-PLAN §3.2/§3.3。
 *
 * 跑法：node --test --test-isolation=none --test-force-exit test/integration/agent/m4-tools.test.mjs
 */
process.env.LIFEOS_DISABLE_AGENT_MARKER = '1'

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TOOL_NAMES,
  goalTool,
  habitTool,
  projectTool,
  registerTools,
  renderGoal,
  renderHabit,
  renderProject,
  renderToday,
  todayTool,
} from '../../../src/agent/tools.js'
import { LIFEOS_TOOL_NAMES } from '../../../src/agent/tool-names.js'

// ── 通用测试基建 ─────────────────────────────────────────────────

const LIFEOS_AGENT = { session: { header: { agentPreset: 'lifeos' } } }
const STANDARD_AGENT = { session: { header: { agentPreset: 'default' } } }
const EXEC = { callId: 'call_m4_1', agent: { id: 'agent_lifeos' } }

function assertTextBlocks(blocks) {
  assert.ok(Array.isArray(blocks), 'render 必须返回 ContentBlock[]')
  assert.ok(blocks.length > 0, 'render 不能返回空数组')
  for (const block of blocks) {
    assert.equal(block.type, 'text')
    assert.equal(typeof block.text, 'string')
  }
  return blocks.map((block) => block.text).join('\n')
}

/** 记录调用的 fake service；overrides 覆盖/追加方法。 */
function makeService(overrides = {}) {
  const calls = []
  const record = (name, args) => {
    calls.push({ name, args })
  }
  const service = {
    calls,
    async today() {
      record('today', [])
      return {
        date: '2026-11-12',
        tasks: [{ id: 'tsk_1', title: '写 M4 报告', status: 'todo' }],
        inboxCount: 2,
      }
    },
    async listHabits(input) {
      record('listHabits', [input])
      return { items: [habitView()], today: '2026-11-12' }
    },
    async getHabit(habitId) {
      record('getHabit', [habitId])
      return {
        habit: habitView(),
        checkins: [{ localDate: '2026-11-11', status: 'done' }],
      }
    },
    async createHabit(payload, meta) {
      record('createHabit', [payload, meta])
      return { habit: habitView({ id: 'hab_new', name: payload.name, rev: 1 }), revision: 1 }
    },
    async updateHabit(habitId, patch, options) {
      record('updateHabit', [habitId, patch, options])
      return { habit: habitView({ ...patch, rev: 4 }), revision: 4, diff: [{ field: 'status' }] }
    },
    async checkin(input, meta) {
      record('checkin', [input, meta])
      return { checkin: { habitId: input.habitId, localDate: input.localDate, status: input.status }, revision: 2, merged: false }
    },
    async uncheck(input, meta) {
      record('uncheck', [input, meta])
      return { ok: true, revision: 3 }
    },
    async getHabitStats(input) {
      record('getHabitStats', [input])
      return {
        range: { from: '2026-11-01', to: '2026-11-12' },
        today: '2026-11-12',
        streakMode: input.streakMode,
        habits: [statsItem()],
      }
    },
    async getHabitMonth(input) {
      record('getHabitMonth', [input])
      return {
        month: input.month,
        habits: [{ habitId: 'hab_1', name: '晨跑', days: [{ date: '2026-11-01', status: 'done' }], done: 1 }],
      }
    },
    async listProjects(input) {
      record('listProjects', [input])
      return { items: [projectView()] }
    },
    async getProject(projectId) {
      record('getProject', [projectId])
      return {
        projectView: projectView(),
        tasks: [
          { id: 'tsk_1', status: 'done' },
          { id: 'tsk_2', status: 'todo' },
        ],
        progress: { mode: 'auto_by_tasks', done: 1, total: 2, pct: 50 },
        recentActivityAt: '2026-11-11T10:00:00Z',
      }
    },
    async createProject(payload, meta) {
      record('createProject', [payload, meta])
      return { project: projectView({ id: 'prj_new', name: payload.name, rev: 1 }), revision: 1 }
    },
    async updateProject(projectId, patch, options) {
      record('updateProject', [projectId, patch, options])
      return { project: projectView({ ...patch, rev: 3 }), revision: 3 }
    },
    async archiveProject(projectId, options) {
      record('archiveProject', [projectId, options])
      return { project: projectView({ status: 'archived', rev: 4 }), revision: 4 }
    },
    async listGoals(input) {
      record('listGoals', [input])
      return { items: [goalView()] }
    },
    async getGoal(goalId) {
      record('getGoal', [goalId])
      return { goalView: goalView(), projects: [{ id: 'prj_1', name: '官网改版' }] }
    },
    async createGoal(payload, meta) {
      record('createGoal', [payload, meta])
      return { goal: goalView({ id: 'gol_new', title: payload.title, rev: 1 }), revision: 1 }
    },
    async updateGoal(goalId, patch, options) {
      record('updateGoal', [goalId, patch, options])
      return { goal: goalView({ ...patch, rev: 2 }), revision: 2 }
    },
    async getWish(wishId) {
      record('getWish', [wishId])
      return { wish: { id: 'wsh_1', title: '去冰岛看极光', status: 'considering', rev: 2 } }
    },
    async convertWish(wishId, options) {
      record('convertWish', [wishId, options])
      return {
        wish: { id: wishId, title: '去冰岛看极光', status: 'committed', converted_to_goal_id: 'gol_new', rev: 3 },
        goal: goalView({ id: 'gol_new', title: options.goal.title }),
        revision: 3,
      }
    },
  }
  return Object.assign(service, overrides)
}

function habitView(overrides = {}) {
  return {
    id: 'hab_1',
    name: '晨跑',
    status: 'active',
    frequency_rule: { kind: 'daily', interval: 1 },
    frequency_text: '每天',
    today_status: 'done',
    rev: 3,
    start_date: '2026-11-01',
    time_hint: '07:30',
    ...overrides,
  }
}

function statsItem() {
  return {
    habitId: 'hab_1',
    name: '晨跑',
    frequency_text: '每天',
    streak: { mode: 'grace', unit: 'day', value: 4, longest: 6 },
    coverage: { recorded: 4, expected: 5, ratio: 0.8 },
    period: { key: '2026-W46', target: 3, achieved: 2, met: false },
    today: { status: 'done' },
  }
}

function projectView(overrides = {}) {
  return {
    id: 'prj_1',
    name: '官网改版',
    status: 'active',
    progress_mode: 'auto_by_tasks',
    progress: { mode: 'auto_by_tasks', done: 2, total: 5, pct: 40 },
    rev: 2,
    ...overrides,
  }
}

function goalView(overrides = {}) {
  return {
    id: 'gol_1',
    title: '跑完半马',
    status: 'active',
    horizon: 'mid',
    progress_mode: 'auto_by_tasks',
    progress: { mode: 'auto_by_tasks', done: 1, total: 4, pct: 25 },
    rev: 2,
    ...overrides,
  }
}

function fakeCtx(service) {
  const definitions = []
  const registerOptions = []
  const ctx = {
    tools: {
      register(definition, options) {
        definitions.push(definition)
        registerOptions.push(options)
        return () => {}
      },
    },
  }
  return { ctx, definitions, registerOptions, service }
}

function lastCall(service, name) {
  const matches = service.calls.filter((call) => call.name === name)
  return matches[matches.length - 1] ?? null
}

// ════════════════════════════════════════════════════════════════
// 注册 / 可见性
// ════════════════════════════════════════════════════════════════

test('注册：LifeOS 会话 10 个工具，标准会话 0 个；顺序与单一来源一致', () => {
  const service = makeService()
  const { ctx, definitions, registerOptions } = fakeCtx(service)
  registerTools(ctx, service)

  assert.equal(definitions.length, 10)
  assert.deepEqual(definitions.map((definition) => definition.name), LIFEOS_TOOL_NAMES)
  assert.deepEqual(TOOL_NAMES, LIFEOS_TOOL_NAMES)
  assert.equal(registerOptions.length, 10)

  const lifeosVisible = definitions.filter((_, index) => registerOptions[index].when({ agent: LIFEOS_AGENT }))
  const standardVisible = definitions.filter((_, index) => registerOptions[index].when({ agent: STANDARD_AGENT }))
  assert.equal(lifeosVisible.length, 10)
  assert.equal(standardVisible.length, 0)
  // 无 activation（宿主异常）必须 fail-closed
  assert.equal(definitions.filter((_, index) => registerOptions[index].when(undefined)).length, 0)
})

test('schema：10 个工具的参数/输出 schema 合法（无 type 联合数组）', () => {
  const service = makeService()
  const { ctx, definitions } = fakeCtx(service)
  registerTools(ctx, service)

  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node.type)) {
      assert.fail(`${path}.type 不能是联合数组（宿主不支持）：${JSON.stringify(node.type)}`)
    }
    if (node.type !== undefined) assert.equal(typeof node.type, 'string', `${path}.type 必须是字符串`)
    for (const [key, child] of Object.entries(node)) {
      if (key === 'properties') {
        for (const [name, schema] of Object.entries(child)) walk(schema, `${path}.properties.${name}`)
      } else if (key === 'items') {
        walk(child, `${path}.items`)
      }
    }
  }

  for (const definition of definitions) {
    assert.equal(typeof definition.name, 'string')
    assert.ok(definition.description.length > 20, `${definition.name} 描述过短`)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.parameters.properties, 'object')
    assert.equal(definition.output.schema.type, 'object')
    assert.equal(definition.output.schema.additionalProperties, true)
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    walk(definition.parameters, definition.name)
  }
})

test('注册：新工具都带 when 门控（preset 中途切换也生效）', () => {
  const tool = habitTool(makeService())
  const options = { when: (activation) => activation?.agent?.session?.header?.agentPreset === 'lifeos' }
  assert.equal(options.when({ agent: LIFEOS_AGENT }), true)
  assert.equal(options.when({ agent: STANDARD_AGENT }), false)
  // 用 agentPresets.presetForSession 覆盖 header（会话中途切 preset）
  const switched = {
    session: { header: { agentPreset: 'default' } },
    ctx: { get: () => ({ presetForSession: () => 'lifeos' }) },
  }
  assert.equal(tool.name, 'lifeos_habit')
  const { ctx, registerOptions } = fakeCtx(makeService())
  registerTools(ctx, makeService())
  assert.equal(registerOptions.at(-1).when({ agent: switched }), true)
})

// ════════════════════════════════════════════════════════════════
// lifeos_habit
// ════════════════════════════════════════════════════════════════

test('lifeos_habit create：L2 直接执行，camelCase 入参 + 幂等键透传', async () => {
  const service = makeService()
  const tool = habitTool(service)
  const value = await tool.execute(
    { action: 'create', name: '晨跑', frequencyRule: { kind: 'daily', interval: 1 }, timeHint: '07:30' },
    EXEC,
  )
  assert.equal(value.ok, true)
  assert.equal(value.needsConfirm, undefined)
  const call = lastCall(service, 'createHabit')
  assert.ok(call, 'create 应该直接调用 createHabit')
  assert.deepEqual(call.args[1], { actor: 'agent', sessionId: 'agent_lifeos', idempotencyKey: 'call_m4_1' })
  assert.equal(call.args[0].name, '晨跑')
  assert.deepEqual(call.args[0].frequencyRule, { kind: 'daily', interval: 1 })
  assert.equal(call.args[0].timeHint, '07:30')
  assert.equal(call.args[0].idempotencyKey, 'call_m4_1')
  const text = assertTextBlocks(renderHabit({}, value))
  assert.match(text, /晨跑/)
})

test('lifeos_habit create：非法频率/缺 periodRule 的 weekly_count 被拒绝且不调服务', async () => {
  const service = makeService()
  const tool = habitTool(service)
  const badKind = await tool.execute({ action: 'create', name: '读书', frequencyRule: { kind: 'monthly_count', count: 4 } }, EXEC)
  assert.equal(badKind.ok, false)
  assert.equal(badKind.error.code, 'validation_failed')
  assert.match(badKind.error.message, /monthly_count/)

  const missingPeriod = await tool.execute({ action: 'create', name: '健身', frequencyRule: { kind: 'weekly_count', count: 3 } }, EXEC)
  assert.equal(missingPeriod.ok, false)
  assert.match(missingPeriod.error.message, /periodRule/)
  assert.equal(service.calls.filter((call) => call.name === 'createHabit').length, 0)
  assert.match(assertTextBlocks(renderHabit({}, badKind)), /习惯操作失败/)
})

test('lifeos_habit update：普通字段 L2 直接执行', async () => {
  const service = makeService()
  const tool = habitTool(service)
  const value = await tool.execute({ action: 'update', habitId: 'hab_1', name: '晨跑 5km', timeHint: '06:50' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.needsConfirm, undefined)
  const call = lastCall(service, 'updateHabit')
  assert.ok(call)
  assert.equal(call.args[0], 'hab_1')
  assert.deepEqual(call.args[1], { name: '晨跑 5km', timeHint: '06:50' })
  // 未显式给 expectedRev → 先 getHabit 读当前 rev
  assert.equal(call.args[2].expectedRev, 3)
})

test('lifeos_habit update：改 status/frequencyRule 是 L3 — 先 needsConfirm 且不写，confirm 后执行', async () => {
  const service = makeService()
  const tool = habitTool(service)

  const preview = await tool.execute({ action: 'update', habitId: 'hab_1', status: 'paused' }, EXEC)
  assert.equal(preview.ok, true)
  assert.equal(preview.needsConfirm, true)
  assert.equal(preview.kind, 'habit')
  assert.equal(preview.action, 'update')
  assert.equal(preview.id, 'hab_1')
  assert.equal(preview.currentStatus, 'active')
  assert.equal(preview.currentRev, 3)
  assert.deepEqual(preview.preview.changes.status, { before: 'active', after: 'paused' })
  assert.deepEqual(preview.preview.proposal, { status: 'paused' })
  assert.equal(service.calls.filter((call) => call.name === 'updateHabit').length, 0, 'L3 预演不得直接写')
  const previewText = assertTextBlocks(renderHabit({}, preview))
  assert.match(previewText, /需要你确认/)
  assert.match(previewText, /status：active → paused/)

  const done = await tool.execute({ action: 'update', habitId: 'hab_1', status: 'paused', confirm: true, expectedRev: 3 }, EXEC)
  assert.equal(done.ok, true)
  assert.equal(done.needsConfirm, undefined)
  const call = lastCall(service, 'updateHabit')
  assert.equal(call.args[0], 'hab_1')
  assert.deepEqual(call.args[1], { status: 'paused' })
  assert.equal(call.args[2].expectedRev, 3)
  assert.match(assertTextBlocks(renderHabit({}, done)), /已更新习惯/)
})

test('lifeos_habit checkin：未给 localDate 默认今天（service.today().date），status 默认 done', async () => {
  const service = makeService()
  const tool = habitTool(service)
  const value = await tool.execute({ action: 'checkin', habitId: 'hab_1' }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.localDate, '2026-11-12')
  assert.equal(value.status, 'done')
  assert.equal(value.merged, false)
  const call = lastCall(service, 'checkin')
  assert.ok(call)
  assert.equal(call.args[0].habitId, 'hab_1')
  assert.equal(call.args[0].localDate, '2026-11-12')
  assert.equal(call.args[0].status, 'done')
})

test('lifeos_habit checkin：retro 必须显式 localDate；显式日期原样透传', async () => {
  const service = makeService()
  const tool = habitTool(service)
  const retroWithoutDate = await tool.execute({ action: 'checkin', habitId: 'hab_1', retro: true }, EXEC)
  assert.equal(retroWithoutDate.ok, false)
  assert.equal(retroWithoutDate.error.code, 'validation_failed')
  assert.equal(service.calls.filter((call) => call.name === 'checkin').length, 0)

  const retro = await tool.execute({ action: 'checkin', habitId: 'hab_1', localDate: '2026-11-10', status: 'skipped', retro: true, note: '出差' }, EXEC)
  assert.equal(retro.ok, true)
  const call = lastCall(service, 'checkin')
  assert.equal(call.args[0].localDate, '2026-11-10')
  assert.equal(call.args[0].status, 'skipped')
  assert.equal(call.args[0].retro, true)
  assert.equal(call.args[0].note, '出差')
})

test('lifeos_habit stats/month：只读透传（streakMode/range），不写', async () => {
  const service = makeService()
  const tool = habitTool(service)
  const stats = await tool.execute({ action: 'stats', from: '2026-11-01', to: '2026-11-12', mode: 'strict' }, EXEC)
  assert.equal(stats.ok, true)
  assert.equal(stats.streakMode, 'strict')
  assert.deepEqual(stats.range, { from: '2026-11-01', to: '2026-11-12' })
  assert.equal(stats.habits[0].habitId, 'hab_1')
  assert.deepEqual(stats.habits[0].streak, { mode: 'grace', unit: 'day', value: 4, longest: 6 })
  assert.deepEqual(stats.habits[0].coverage, { recorded: 4, expected: 5, ratio: 0.8 })
  const statsCall = lastCall(service, 'getHabitStats')
  assert.deepEqual(statsCall.args[0], { streakMode: 'strict', from: '2026-11-01', to: '2026-11-12' })

  const month = await tool.execute({ action: 'month', month: '2026-11' }, EXEC)
  assert.equal(month.ok, true)
  assert.equal(month.month, '2026-11')
  assert.equal(month.habits[0].name, '晨跑')
  assert.deepEqual(lastCall(service, 'getHabitMonth').args[0], { month: '2026-11' })
  assert.equal(service.calls.filter((call) => ['createHabit', 'updateHabit', 'checkin', 'uncheck'].includes(call.name)).length, 0)
})

test('lifeos_habit：服务方法缺失 → internal 可读失败，不编造', async () => {
  const tool = habitTool({})
  const value = await tool.execute({ action: 'list' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'internal')
  assert.match(value.error.message, /listHabits/)
  assert.match(assertTextBlocks(renderHabit({}, value)), /习惯操作失败（internal）/)
})

test('lifeos_habit uncheck：L2 直接执行，撤销指定日期', async () => {
  const service = makeService()
  const tool = habitTool(service)
  const value = await tool.execute({ action: 'uncheck', habitId: 'hab_1', localDate: '2026-11-11' }, EXEC)
  assert.equal(value.ok, true)
  const call = lastCall(service, 'uncheck')
  assert.ok(call)
  assert.deepEqual(call.args[0], { habitId: 'hab_1', localDate: '2026-11-11' })
  assert.equal(call.args[1].idempotencyKey, 'call_m4_1')
})

// ════════════════════════════════════════════════════════════════
// lifeos_project
// ════════════════════════════════════════════════════════════════

test('lifeos_project list/get/progress：只读，进度只转述服务计算值', async () => {
  const service = makeService()
  const tool = projectTool(service)

  const list = await tool.execute({ action: 'list' }, EXEC)
  assert.equal(list.ok, true)
  assert.equal(list.items[0].name, '官网改版')
  assert.match(
    assertTextBlocks(renderProject({}, list)),
    /^项目列表：1 个\n- 官网改版｜进行中｜进度 2\/5（40%）（根据任务计算）｜id prj_1$/,
  )

  const get = await tool.execute({ action: 'get', projectId: 'prj_1' }, EXEC)
  assert.equal(get.ok, true)
  assert.equal(get.taskCount, 2)
  assert.equal(get.tasksDone, 1)
  assert.deepEqual(get.progress, { mode: 'auto_by_tasks', done: 1, total: 2, pct: 50, label: null })
  const getText = assertTextBlocks(renderProject({}, get))
  assert.match(getText, /进度：1\/2（50%）（根据任务计算）/)
  assert.match(getText, /任务：2 个（已完成 1）/)

  const progress = await tool.execute({ action: 'progress', projectId: 'prj_1' }, EXEC)
  assert.equal(progress.ok, true)
  assert.equal(progress.progress.mode, 'auto_by_tasks')
})

test('lifeos_project update/archive：L3 先 needsConfirm；confirm 后按 expectedRev 执行', async () => {
  const service = makeService()
  const tool = projectTool(service)

  const preview = await tool.execute({ action: 'update', projectId: 'prj_1', status: 'paused' }, EXEC)
  assert.equal(preview.ok, true)
  assert.equal(preview.needsConfirm, true)
  assert.equal(preview.kind, 'project')
  assert.deepEqual(preview.preview.changes.status, { before: 'active', after: 'paused' })
  assert.equal(service.calls.filter((call) => call.name === 'updateProject').length, 0)
  assert.match(assertTextBlocks(renderProject({}, preview)), /需要你确认（项目变更，L3）/)

  const done = await tool.execute({ action: 'update', projectId: 'prj_1', status: 'paused', confirm: true, expectedRev: 2 }, EXEC)
  assert.equal(done.ok, true)
  const updateCall = lastCall(service, 'updateProject')
  assert.equal(updateCall.args[0], 'prj_1')
  assert.deepEqual(updateCall.args[1], { status: 'paused' })
  assert.equal(updateCall.args[2].expectedRev, 2)

  const archivePreview = await tool.execute({ action: 'archive', projectId: 'prj_1' }, EXEC)
  assert.equal(archivePreview.needsConfirm, true)
  assert.deepEqual(archivePreview.preview.changes.status, { before: 'active', after: 'archived' })
  assert.equal(service.calls.filter((call) => call.name === 'archiveProject').length, 0)

  const archived = await tool.execute({ action: 'archive', projectId: 'prj_1', confirm: true }, EXEC)
  assert.equal(archived.ok, true)
  assert.equal(archived.rev, 4)
  assert.equal(lastCall(service, 'archiveProject').args[1].expectedRev, 2)
})

test('lifeos_project create：L2 直接创建', async () => {
  const service = makeService()
  const tool = projectTool(service)
  const value = await tool.execute({ action: 'create', name: '读书计划', color: '#4F8EF7', progressMode: 'auto_by_tasks' }, EXEC)
  assert.equal(value.ok, true)
  const call = lastCall(service, 'createProject')
  assert.equal(call.args[0].name, '读书计划')
  assert.equal(call.args[0].color, '#4F8EF7')
  assert.equal(call.args[0].progressMode, 'auto_by_tasks')
  assert.match(assertTextBlocks(renderProject({}, value)), /已创建项目/)
})

test('lifeos_project create：同名冲突提示项目专用文案并带已有项目 id', async () => {
  const service = makeService()
  service.createProject = async () => {
    const error = new Error('项目已存在：LifeOS')
    error.code = 'conflict'
    error.details = { current: { id: 'prj_existing', name: 'lifeOS' } }
    throw error
  }
  const tool = projectTool(service)
  const value = await tool.execute({ action: 'create', name: 'LifeOS' }, EXEC)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'conflict')
  assert.match(value.error.message, /prj_existing/)
  assert.match(value.error.hint, /lifeos_project.*list/)
  assert.match(assertTextBlocks(renderProject({}, value)), /prj_existing/)
})

// ════════════════════════════════════════════════════════════════
// lifeos_goal
// ════════════════════════════════════════════════════════════════

test('lifeos_goal list/get：只读', async () => {
  const service = makeService()
  const tool = goalTool(service)
  const list = await tool.execute({ action: 'list' }, EXEC)
  assert.equal(list.ok, true)
  assert.equal(list.items[0].title, '跑完半马')
  assert.match(assertTextBlocks(renderGoal({}, list)), /目标列表：1 个/)

  const get = await tool.execute({ action: 'get', goalId: 'gol_1' }, EXEC)
  assert.equal(get.ok, true)
  assert.equal(get.projectCount, 1)
  assert.match(assertTextBlocks(renderGoal({}, get)), /目标详情：跑完半马/)
})

test('lifeos_goal create/update：L3 先 needsConfirm，confirm 后才写', async () => {
  const service = makeService()
  const tool = goalTool(service)

  const createPreview = await tool.execute({ action: 'create', title: '跑半马', horizon: 'mid', successCriteria: '21km 完赛' }, EXEC)
  assert.equal(createPreview.ok, true)
  assert.equal(createPreview.needsConfirm, true)
  assert.equal(createPreview.kind, 'goal')
  assert.equal(createPreview.preview.proposal.title, '跑半马')
  assert.equal(service.calls.filter((call) => call.name === 'createGoal').length, 0)
  assert.match(assertTextBlocks(renderGoal({}, createPreview)), /需要你确认（目标变更，L3）/)

  const created = await tool.execute({ action: 'create', title: '跑半马', horizon: 'mid', successCriteria: '21km 完赛', confirm: true }, EXEC)
  assert.equal(created.ok, true)
  const createCall = lastCall(service, 'createGoal')
  assert.equal(createCall.args[0].title, '跑半马')
  assert.equal(createCall.args[1].idempotencyKey, 'call_m4_1')

  const updatePreview = await tool.execute({ action: 'update', goalId: 'gol_1', status: 'achieved', progressPct: 100 }, EXEC)
  assert.equal(updatePreview.needsConfirm, true)
  assert.deepEqual(updatePreview.preview.changes.status, { before: 'active', after: 'achieved' })
  assert.deepEqual(updatePreview.preview.changes.progressPct, { before: null, after: 100 })
  assert.equal(service.calls.filter((call) => call.name === 'updateGoal').length, 0)

  const updated = await tool.execute({ action: 'update', goalId: 'gol_1', status: 'achieved', progressPct: 100, confirm: true }, EXEC)
  assert.equal(updated.ok, true)
  const updateCall = lastCall(service, 'updateGoal')
  assert.deepEqual(updateCall.args[1], { status: 'achieved', progressPct: 100 })
  assert.equal(updateCall.args[2].expectedRev, 2)
})

test('lifeos_goal convert_wish：L3 — 预览含愿望状态变更与目标创建提案；confirm 后调 convertWish', async () => {
  const service = makeService()
  const tool = goalTool(service)

  const preview = await tool.execute(
    { action: 'convert_wish', wishId: 'wsh_1', title: '去冰岛看极光', horizon: 'mid', targetDate: '2027-02-01' },
    EXEC,
  )
  assert.equal(preview.ok, true)
  assert.equal(preview.needsConfirm, true)
  assert.equal(preview.kind, 'wish')
  assert.deepEqual(preview.preview.changes.status, { before: 'considering', after: 'committed' })
  assert.equal(preview.preview.proposal.title, '去冰岛看极光')
  assert.equal(service.calls.filter((call) => call.name === 'convertWish').length, 0)
  const previewText = assertTextBlocks(renderGoal({}, preview))
  assert.match(previewText, /需要你确认（目标变更，L3）/)
  assert.match(previewText, /将提交：/)

  const done = await tool.execute(
    { action: 'convert_wish', wishId: 'wsh_1', title: '去冰岛看极光', horizon: 'mid', targetDate: '2027-02-01', confirm: true },
    EXEC,
  )
  assert.equal(done.ok, true)
  const call = lastCall(service, 'convertWish')
  assert.equal(call.args[0], 'wsh_1')
  assert.equal(call.args[1].goal.title, '去冰岛看极光')
  assert.equal(call.args[1].goal.horizon, 'mid')
  assert.equal(call.args[1].expectedRev, 2, '愿望 rev 应作为 CAS expectedRev')
  assert.match(assertTextBlocks(renderGoal({}, done)), /已把愿望「去冰岛看极光」转化为目标/)
})

// ════════════════════════════════════════════════════════════════
// lifeos_today · include=habits
// ════════════════════════════════════════════════════════════════

function manyHabits(n) {
  return Array.from({ length: n }, (_, index) => ({
    habitId: `hab_${index + 1}`,
    name: `习惯${index + 1}`,
    frequency_text: '每天',
    today_status: index === 0 ? 'done' : null,
    streak: { mode: 'grace', unit: 'day', value: index, longest: index + 1 },
  }))
}

test('lifeos_today：不传 include 时既有字段不变、不读习惯', async () => {
  const service = makeService()
  const tool = todayTool(service)
  const value = await tool.execute({}, EXEC)
  assert.deepEqual(Object.keys(value).sort(), ['agentId', 'date', 'inboxCount', 'ok', 'tasks'].sort())
  assert.equal(value.date, '2026-11-12')
  assert.equal(value.inboxCount, 2)
  assert.equal(service.calls.filter((call) => call.name !== 'today').length, 0)
  const text = assertTextBlocks(renderToday({}, value))
  assert.match(text, /今天 2026-11-12｜任务 1 个（已完成 0）｜Inbox 待整理 2 条/)
  assert.doesNotMatch(text, /今日习惯/)
})

test('lifeos_today include=habits：返回 habits（≤10 条、含 today_status/streak）且不破坏既有字段', async () => {
  const service = makeService({
    async todayHabits() {
      service.calls.push({ name: 'todayHabits', args: [] })
      return manyHabits(12)
    },
  })
  const tool = todayTool(service)
  const value = await tool.execute({ include: ['habits'] }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.includeHabits, true)
  assert.equal(value.habitServiceReady, true)
  assert.equal(value.habits.length, 10)
  assert.deepEqual(Object.keys(value.habits[0]).sort(), ['frequency_text', 'habitId', 'name', 'streak', 'today_status'].sort())
  assert.equal(value.habits[0].today_status, 'done')
  assert.deepEqual(value.habits[0].streak, { mode: 'grace', unit: 'day', value: 0, longest: 1 })
  assert.equal(value.date, '2026-11-12')
  assert.equal(value.tasks.length, 1)
  assert.equal(value.inboxCount, 2)

  const text = assertTextBlocks(renderToday({}, value))
  assert.match(text, /今日习惯：10 个/)
  assert.match(text, /…另有 5 个习惯/)
})

test('lifeos_today include=habits：服务缺失时 habitServiceReady=false，提示不编造', async () => {
  const service = makeService()
  delete service.todayHabits
  delete service.getHabitStats
  delete service.getStats
  const tool = todayTool(service)
  const value = await tool.execute({ include: ['habits'] }, EXEC)
  assert.equal(value.ok, true)
  assert.equal(value.includeHabits, true)
  assert.equal(value.habitServiceReady, false)
  assert.deepEqual(value.habits, [])
  const text = assertTextBlocks(renderToday({}, value))
  assert.match(text, /今日习惯：习惯服务尚未就绪/)
  assert.match(text, /不要编造打卡状态或连续天数/)
})

test('lifeos_today include：非法值被拒绝，不调服务', async () => {
  const service = makeService()
  const tool = todayTool(service)
  const bad = await tool.execute({ include: ['projects'] }, EXEC)
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'validation_failed')
  assert.equal(service.calls.length, 0)
})

// ════════════════════════════════════════════════════════════════
// 服务命名兼容（B 装配可能用 getStats/getMonth）
// ════════════════════════════════════════════════════════════════

test('生活服务别名：getStats/getMonth 也可用（不强制要求 getHabitStats 命名）', async () => {
  const service = makeService()
  delete service.getHabitStats
  delete service.getHabitMonth
  service.getStats = async (input) => {
    service.calls.push({ name: 'getStats', args: [input] })
    return { habits: [statsItem()], today: '2026-11-12' }
  }
  service.getMonth = async (input) => {
    service.calls.push({ name: 'getMonth', args: [input] })
    return { habits: [{ habitId: 'hab_1', name: '晨跑', days: [] }] }
  }
  const tool = habitTool(service)
  const stats = await tool.execute({ action: 'stats' }, EXEC)
  assert.equal(stats.ok, true)
  assert.deepEqual(lastCall(service, 'getStats').args[0], { streakMode: 'grace' })
  const month = await tool.execute({ action: 'month', month: '2026-11' }, EXEC)
  assert.equal(month.ok, true)
  assert.equal(lastCall(service, 'getMonth').args[0].month, '2026-11')
})

// ── M18 习惯分组（schema v4）────────────────────────────────────

function habitGroupView(overrides = {}) {
  return { id: 'hgrp_1', name: '清晨', sort_order: 0, collapsed: false, rev: 1, ...overrides }
}

test('lifeos_habit 分组：list/create/update/delete/reorder 透传与文案', async () => {
  const calls = []
  const service = makeService({
    async listHabitGroups() {
      calls.push(['listHabitGroups'])
      return { items: [habitGroupView(), habitGroupView({ id: 'hgrp_2', name: '睡前', sort_order: 1, rev: 2 })] }
    },
    async createHabitGroup(input) {
      calls.push(['createHabitGroup', input])
      return { group: habitGroupView({ id: 'hgrp_new', name: input.name }), revision: 1 }
    },
    async updateHabitGroup(id, patch, options) {
      calls.push(['updateHabitGroup', id, patch, options])
      return { group: habitGroupView({ id, ...patch, rev: 2 }), revision: 2, diff: [] }
    },
    async deleteHabitGroup(id, options) {
      calls.push(['deleteHabitGroup', id, options])
      return { deleted: true, id, movedToUngrouped: ['hab_1', 'hab_2'], revision: 3 }
    },
    async reorderHabitGroups(input) {
      calls.push(['reorderHabitGroups', input])
      const names = { hgrp_1: '清晨', hgrp_2: '睡前' }
      return { items: input.ids.map((id, index) => habitGroupView({ id, name: names[id] ?? id, sort_order: index })) }
    },
  })
  const tool = habitTool(service)
  const run = (args) => tool.execute({ action: 'list_groups', ...args }, EXEC)

  const listed = await run({})
  assert.deepEqual(calls[0], ['listHabitGroups'])
  assert.equal(listed.items.length, 2)
  const listedText = assertTextBlocks(tool.output.render({}, listed))
  assert.match(listedText, /清晨/)
  assert.match(listedText, /睡前/)

  const created = await run({ action: 'create_group', name: '晨间' })
  assert.deepEqual(calls[1], ['createHabitGroup', { name: '晨间' }])
  assert.match(assertTextBlocks(tool.output.render({}, created)), /已创建习惯分组「晨间」/)

  // 分组名必填、超长被拒绝且不调服务
  const missing = await run({ action: 'create_group' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'validation_failed')
  const tooLong = await run({ action: 'create_group', name: 'x'.repeat(41) })
  assert.equal(tooLong.ok, false)

  // update 未给 expectedRev 时先读列表取 rev
  const updated = await run({ action: 'update_group', habitGroupId: 'hgrp_2', name: '深夜' })
  const updateCall = calls.find(([name]) => name === 'updateHabitGroup')
  assert.deepEqual(updateCall[2], { name: '深夜' })
  assert.equal(updateCall[3].expectedRev, 2)
  assert.equal(updated.group.name, '深夜')

  const noField = await run({ action: 'update_group', habitGroupId: 'hgrp_2' })
  assert.equal(noField.ok, false)

  const removed = await run({ action: 'delete_group', habitGroupId: 'hgrp_2', expectedRev: 2 })
  assert.equal(removed.movedCount, 2)
  assert.match(assertTextBlocks(tool.output.render({}, removed)), /已移回「未分组」/)

  const reordered = await run({ action: 'reorder_groups', groupIds: ['hgrp_2', 'hgrp_1'] })
  assert.deepEqual(calls.at(-1), ['reorderHabitGroups', { ids: ['hgrp_2', 'hgrp_1'] }])
  assert.match(assertTextBlocks(tool.output.render({}, reordered)), /睡前/)

  // 非法 id / 重复 id
  const badId = await run({ action: 'delete_group', habitGroupId: 'hab_1', expectedRev: 1 })
  assert.equal(badId.ok, false)
  const dup = await run({ action: 'reorder_groups', groupIds: ['hgrp_1', 'hgrp_1'] })
  assert.equal(dup.ok, false)
})

test('lifeos_habit create/update：icon 与 groupId 透传（空字符串=清空）', async () => {
  const service = makeService({
    async updateHabit(habitId, patch, options) {
      service.calls.push({ name: 'updateHabit', args: [habitId, patch, options] })
      return { habit: habitView({ ...patch, rev: 4 }), revision: 4, diff: [] }
    },
  })
  const tool = habitTool(service)
  const calls = service.calls

  const created = await tool.execute(
    {
      action: 'create',
      name: '晨跑',
      frequencyRule: { kind: 'daily', interval: 1 },
      icon: '🏃',
      groupId: 'hgrp_1',
    },
    EXEC,
  )
  assert.equal(created.ok, true)
  const createCall = calls.find((call) => call.name === 'createHabit')
  assert.equal(createCall.args[0].icon, '🏃')
  assert.equal(createCall.args[0].groupId, 'hgrp_1')

  const updated = await tool.execute({ action: 'update', habitId: 'hab_1', groupId: '', icon: '' }, EXEC)
  assert.equal(updated.ok, true)
  const updateCall = calls.find((call) => call.name === 'updateHabit')
  assert.equal(updateCall.args[1].groupId, null)
  assert.equal(updateCall.args[1].icon, null)

  const badIcon = await tool.execute({ action: 'update', habitId: 'hab_1', icon: '123456789' }, EXEC)
  assert.equal(badIcon.ok, false)
  const badGroup = await tool.execute({ action: 'update', habitId: 'hab_1', groupId: 'hab_1' }, EXEC)
  assert.equal(badGroup.ok, false)
})