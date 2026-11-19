import test from 'node:test'
import assert from 'node:assert/strict'

import { openLifeosStore } from '../../../src/store/lifeos-store.js'
import { createPlanningOps } from '../../../src/application/planning-service.js'
import { createFakeBackend } from '../../unit/store/fake-backend.mjs'
import { newId } from '../../../src/domain/ids.js'
import { validateRecord } from '../../../src/domain/schemas.js'

const TZ = 'Asia/Shanghai'
const BASE_MS = Date.parse('2026-11-14T05:00:00.000Z') // 北京时间 2026-11-14 13:00
const NOW_ISO = '2026-11-14T05:00:00.000Z'

async function setup(t) {
  const { backend } = createFakeBackend()
  const store = await openLifeosStore(null, {
    backend,
    testMode: true,
    seed: true,
    timeZone: TZ,
    now: () => NOW_ISO,
  })
  t.after(async () => {
    await store.close()
  })
  const events = []
  const ops = createPlanningOps({
    store,
    now: () => BASE_MS,
    timeZone: TZ,
    emitChanged: (kind, ids, extra) => events.push({ kind, ids, extra }),
  })
  return { store, ops, events }
}

async function expectCode(fn, code) {
  await assert.rejects(
    async () => fn(),
    (error) => {
      assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}: ${error.message}`)
      return true
    },
  )
}

function logRows(store, table) {
  return store.entries('lifeos_log', table).map(([, record]) => record)
}

function recordRows(store, table) {
  return store.entries('lifeos', table).map(([, record]) => record)
}

/** 真实 normalizeRecord + validateRecord 口径校验（store.transaction 已校验，这里显式再断言一遍）。 */
function assertAllWritesValid(store) {
  for (const table of ['project', 'goal', 'wish', 'entity_link']) {
    for (const record of recordRows(store, table)) {
      const result = validateRecord(table, record)
      assert.equal(result.ok, true, `${table} 记录非法：${result.errors.join('; ')}`)
    }
  }
  for (const table of ['operation_log', 'state_change']) {
    for (const record of logRows(store, table)) {
      const result = validateRecord(table, record)
      assert.equal(result.ok, true, `${table} 记录非法：${result.errors.join('; ')}`)
    }
  }
}

/** 直接写 task 表造进度数据（required 仅 title/status，defaults 由 store 补）。 */
function putTask(store, fields) {
  const id = newId('tsk')
  return store.put('lifeos', 'task', id, {
    id,
    title: fields.title ?? `任务 ${id.slice(-4)}`,
    status: fields.status ?? 'todo',
    ...fields,
  })
}

// =====================================================================
// 项目 CRUD / 视图
// =====================================================================

test('createProject 返回 snake_case view 并写入合法记录 + oplog', async (t) => {
  const { store, ops, events } = await setup(t)
  const created = await ops.createProject({
    name: '产品发布',
    description: 'M4 上线',
    color: '#4f8',
    start_date: '2026-11-01',
    target_date: '2026-12-31',
  })

  assert.equal(created.revision, 1)
  const project = created.project
  assert.match(project.id, /^prj_/)
  assert.equal(project.name, '产品发布')
  assert.equal(project.description, 'M4 上线')
  assert.equal(project.color, '#4f8')
  assert.equal(project.status, 'active')
  assert.equal(project.progress_mode, 'auto_by_tasks')
  assert.equal(project.progress, null) // 无任务 → 进度未知
  assert.equal(project.has_tasks, false)
  assert.equal(project.rev, 1)
  assert.match(project.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

  const list = ops.listProjects({})
  assert.equal(list.items.length, 1)
  assert.equal(list.items[0].id, project.id)

  const detail = ops.getProject(project.id)
  assert.equal(detail.project.id, project.id)
  assert.deepEqual(detail.tasks, [])
  assert.equal(detail.progress, null)
  assert.match(detail.recentActivityAt, /Z$/)

  const oplogs = logRows(store, 'operation_log')
  assert.equal(oplogs.length, 1)
  assert.equal(oplogs[0].action, 'project.create')
  assert.equal(oplogs[0].permission_level, 'L2')
  assert.match(oplogs[0].occurred_at, /Z$/)
  assert.deepEqual(events.map((event) => event.kind), ['project'])
  assertAllWritesValid(store)
})

test('M1 回归：同名 conflict / CAS conflict / not_found / 缺 expectedRev', async (t) => {
  const { ops } = await setup(t)
  const first = await ops.createProject({ name: 'Alpha' })

  await assert.rejects(
    async () => ops.createProject({ name: '  alpha  ' }),
    (error) => {
      assert.equal(error.code, 'conflict')
      assert.equal(error.details.current.id, first.project.id) // details.current 必须是 projectView
      assert.equal(error.details.current.rev, 1)
      return true
    },
  )

  // M1 时期数字 expectedRev 仍需兼容
  const updated = await ops.updateProject(first.project.id, { description: '第一版' }, 1)
  assert.equal(updated.revision, 2)
  assert.equal(updated.project.rev, 2)
  assert.equal(updated.project.description, '第一版')
  assert.ok(Array.isArray(updated.diff))
  assert.ok(updated.diff.some((entry) => entry.field === 'description' && entry.newValue === '第一版'))

  await assert.rejects(
    async () => ops.updateProject(first.project.id, { name: 'Beta' }, { expectedRev: 1 }),
    (error) => {
      assert.equal(error.code, 'conflict')
      assert.equal(error.details.expectedRev, 1)
      assert.equal(error.details.currentRev, 2)
      assert.equal(error.details.current.name, 'Alpha')
      assert.equal(error.details.current.description, '第一版')
      return true
    },
  )
  await expectCode(() => ops.updateProject('prj_missing', { name: 'X' }, 1), 'not_found')
  await expectCode(() => ops.updateProject(first.project.id, { name: 'Gamma' }), 'validation_failed')
  await expectCode(
    () => ops.updateProject(first.project.id, { status: 'archived' }, { expectedRev: 2 }),
    'invalid_state',
  )

  const second = await ops.createProject({ name: 'Beta' })
  await assert.rejects(
    async () => ops.updateProject(first.project.id, { name: 'beta' }, { expectedRev: 2 }),
    (error) => {
      assert.equal(error.code, 'conflict')
      assert.equal(error.details.current.id, second.project.id)
      return true
    },
  )
})

test('archiveProject 只改 status/archived_at，列表默认过滤归档', async (t) => {
  const { ops } = await setup(t)
  const { project } = await ops.createProject({ name: '归档项目' })

  const archived = await ops.archiveProject(project.id, { expectedRev: 1 })
  assert.equal(archived.revision, 2)
  assert.equal(archived.project.status, 'archived')
  assert.notEqual(archived.project.archived_at, null)
  assert.equal(archived.project.rev, 2)

  assert.equal(ops.listProjects({}).items.length, 0)
  assert.equal(ops.listProjects({ includeArchived: true }).items.length, 1)
  assert.equal(ops.getProject(project.id).project.status, 'archived')

  await expectCode(() => ops.archiveProject(project.id, { expectedRev: 1 }), 'conflict')
  await expectCode(() => ops.archiveProject('prj_missing', { expectedRev: 1 }), 'not_found')
})

test('project 进度：auto_by_tasks 与 manual', async (t) => {
  const { store, ops } = await setup(t)
  const { project } = await ops.createProject({ name: '进度项目' })
  await putTask(store, { title: '待办', status: 'todo', project_id: project.id })
  await putTask(store, { title: '完成', status: 'done', project_id: project.id, completed_at: NOW_ISO })
  await putTask(store, { title: '取消', status: 'cancelled', project_id: project.id })
  await putTask(store, { title: '删除', status: 'todo', project_id: project.id, deleted_at: NOW_ISO })

  const detail = await ops.getProject(project.id)
  assert.equal(detail.tasks.length, 3) // deleted 不出现，cancelled 保留在任务列表
  assert.deepEqual(detail.progress, {
    mode: 'auto_by_tasks',
    done: 1,
    total: 2, // cancelled/deleted 不计入分母
    pct: 50,
    label: '任务完成 1/2（根据任务计算）',
  })
  assert.equal(detail.project.has_tasks, true)

  const manual = await ops.updateProject(
    project.id,
    { progress_mode: 'manual', progress_pct: 40 },
    { expectedRev: 1 },
  )
  assert.deepEqual(manual.project.progress, {
    mode: 'manual',
    done: null,
    total: null,
    pct: 40,
    label: '手动进度 40%',
  })
})

// =====================================================================
// 目标 CRUD / 生命周期 / 进度
// =====================================================================

test('goal CRUD、进度与 getGoal 形状', async (t) => {
  const { store, ops, events } = await setup(t)
  const created = await ops.createGoal({
    title: '跑完半马',
    description: '21km',
    success_criteria: '完赛',
    horizon: 'mid',
    progress_mode: 'auto_by_tasks',
  })
  assert.equal(created.revision, 1)
  assert.deepEqual(created.warnings, [])
  const goal = created.goal
  assert.match(goal.id, /^gol_/)
  assert.equal(goal.title, '跑完半马')
  assert.equal(goal.success_criteria, '完赛')
  assert.equal(goal.horizon, 'mid')
  assert.equal(goal.progress_mode, 'auto_by_tasks')
  assert.deepEqual(goal.progress, { mode: 'auto_by_tasks', done: 0, total: 0, pct: null })

  await putTask(store, { title: '报名', status: 'done', goal_id: goal.id, completed_at: NOW_ISO })
  await putTask(store, { title: '训练', status: 'doing', goal_id: goal.id })
  await putTask(store, { title: '取消', status: 'cancelled', goal_id: goal.id })

  const detail = ops.getGoal(goal.id)
  assert.equal(detail.goal.id, goal.id)
  assert.equal(detail.tasks.length, 3)
  assert.deepEqual(detail.progress, { mode: 'auto_by_tasks', done: 1, total: 2, pct: 50 })

  const list = ops.listGoals({})
  assert.equal(list.items.length, 1)

  const manual = await ops.updateGoal(
    goal.id,
    { progress_mode: 'manual', progress_pct: 60, description: '更新描述' },
    { expectedRev: 1 },
  )
  assert.equal(manual.revision, 2)
  assert.equal(manual.goal.description, '更新描述')
  assert.deepEqual(manual.goal.progress, { mode: 'manual', done: null, total: null, pct: 60 })
  assert.ok(manual.diff.some((entry) => entry.field === 'progress_pct'))

  await expectCode(() => ops.createGoal({ title: 'x', status: 'abandoned' }), 'validation_failed')
  await expectCode(() => ops.updateGoal('gol_missing', { title: 'y' }, { expectedRev: 1 }), 'not_found')
  assert.equal(events.filter((event) => event.kind === 'goal').length, 2)
  assertAllWritesValid(store)
})

test('goal 生命周期：achieved_at / abandoned_reason，auto_by_projects 降级', async (t) => {
  const { ops } = await setup(t)

  const downgraded = await ops.createGoal({ title: '目标 A', progress_mode: 'auto_by_projects' })
  assert.equal(downgraded.goal.progress_mode, 'manual')
  assert.equal(downgraded.warnings.length, 1)
  assert.match(downgraded.warnings[0], /auto_by_projects/)

  const updated = await ops.updateGoal(
    goalIdOf(downgraded),
    { progress_mode: 'auto_by_projects' },
    { expectedRev: 1 },
  )
  assert.equal(updated.goal.progress_mode, 'manual')
  assert.equal(updated.warnings.length, 1)

  const achieved = await ops.updateGoal(goalIdOf(downgraded), { status: 'achieved' }, { expectedRev: 2 })
  assert.equal(achieved.goal.status, 'achieved')
  assert.notEqual(achieved.goal.achieved_at, null)

  await expectCode(
    () => ops.updateGoal(goalIdOf(downgraded), { status: 'abandoned' }, { expectedRev: 3 }),
    'validation_failed',
  )

  const abandoned = await ops.updateGoal(
    goalIdOf(downgraded),
    { status: 'abandoned', abandoned_reason: '计划调整' },
    { expectedRev: 3 },
  )
  assert.equal(abandoned.goal.status, 'abandoned')
  assert.equal(abandoned.goal.abandoned_reason, '计划调整')
  assert.equal(abandoned.goal.achieved_at, null)

  const reactivated = await ops.updateGoal(goalIdOf(downgraded), { status: 'active' }, { expectedRev: 4 })
  assert.equal(reactivated.goal.status, 'active')
  assert.equal(reactivated.goal.achieved_at, null)
})

function goalIdOf(result) {
  return result.goal.id
}

test('archiveGoal 只写 archived_at，列表默认过滤', async (t) => {
  const { ops } = await setup(t)
  const { goal } = await ops.createGoal({ title: '待归档目标' })

  const archived = await ops.archiveGoal(goal.id, { expectedRev: 1 })
  assert.equal(archived.revision, 2)
  assert.notEqual(archived.goal.archived_at, null)
  assert.equal(archived.goal.status, 'active') // goal 枚举无 archived，状态不动

  assert.equal(ops.listGoals({}).items.length, 0)
  assert.equal(ops.listGoals({ includeArchived: true }).items.length, 1)
  await expectCode(() => ops.archiveGoal(goal.id, { expectedRev: 1 }), 'conflict')
  await expectCode(() => ops.archiveGoal('gol_missing', { expectedRev: 1 }), 'not_found')
})

// =====================================================================
// 愿望 / 转化
// =====================================================================

test('wish CRUD：committed 只能由转化产生', async (t) => {
  const { ops } = await setup(t)
  const created = await ops.createWish({
    title: '去冰岛',
    description: '看极光',
    review_at: '2026-12-01',
  })
  assert.equal(created.revision, 1)
  const wish = created.wish
  assert.match(wish.id, /^wsh_/)
  assert.equal(wish.status, 'captured')
  assert.equal(wish.converted_to_goal_id, null)
  assert.equal(wish.review_at, '2026-12-01')

  await expectCode(() => ops.createWish({ title: 'x', status: 'committed' }), 'validation_failed')

  const updated = await ops.updateWish(wish.id, { status: 'considering', description: '再想想' }, { expectedRev: 1 })
  assert.equal(updated.revision, 2)
  assert.equal(updated.wish.status, 'considering')
  assert.ok(updated.diff.some((entry) => entry.field === 'status'))

  await expectCode(
    () => ops.updateWish(wish.id, { status: 'committed' }, { expectedRev: 2 }),
    'validation_failed',
  )
  assert.equal(ops.listWishes({}).items.length, 1)
  assert.equal(ops.listWishes({ status: 'captured' }).items.length, 0)
  assert.equal(ops.listWishes({ status: 'considering' }).items.length, 1)
  assert.equal(ops.getWish(wish.id).link, null)
})

test('convertWish 单事务：goal + wish committed + entity_link', async (t) => {
  const { store, ops, events } = await setup(t)
  const { wish } = await ops.createWish({ title: '去冰岛', description: '看极光' })
  const oplogBefore = logRows(store, 'operation_log').length
  const stcBefore = logRows(store, 'state_change').length

  const converted = await ops.convertWish(wish.id, {
    goal: { success_criteria: '踏上冰岛土地', horizon: 'long' },
    expectedRev: 1,
  })

  assert.equal(converted.revision, 2)
  assert.equal(converted.wish.id, wish.id)
  assert.equal(converted.wish.status, 'committed')
  assert.equal(converted.wish.converted_to_goal_id, converted.goal.id)
  assert.notEqual(converted.wish.converted_at, null)
  // goal 缺省继承 wish 的 title/description
  assert.equal(converted.goal.title, '去冰岛')
  assert.equal(converted.goal.description, '看极光')
  assert.equal(converted.goal.success_criteria, '踏上冰岛土地')
  assert.equal(converted.goal.horizon, 'long')
  assert.equal(converted.goal.progress_mode, 'manual')

  const link = converted.link
  assert.match(link.id, /^lnk_/)
  assert.equal(link.from_type, 'wish')
  assert.equal(link.from_id, wish.id)
  assert.equal(link.to_type, 'goal')
  assert.equal(link.to_id, converted.goal.id)
  assert.equal(link.link_type, 'converted_to')

  // 单事务：1 goal + 1 wish + 1 link + 2 state_change + 1 operation_log
  assert.equal(recordRows(store, 'goal').length, 1)
  assert.equal(recordRows(store, 'entity_link').length, 1)
  assert.equal(logRows(store, 'operation_log').length, oplogBefore + 1)
  const convertLog = logRows(store, 'operation_log').at(-1)
  assert.equal(convertLog.action, 'wish.convert')
  assert.deepEqual(convertLog.target_ids_json.sort(), [wish.id, converted.goal.id].sort())
  assert.equal(logRows(store, 'state_change').length, stcBefore + 2)
  const changes = logRows(store, 'state_change')
  assert.ok(changes.some((record) => record.entity_type === 'wish' && record.field === 'status'))
  assert.ok(changes.some((record) => record.entity_type === 'wish' && record.field === 'converted_to_goal_id'))

  // 愿望保留，getWish 能读回 link
  const detail = ops.getWish(wish.id)
  assert.equal(detail.wish.status, 'committed')
  assert.equal(detail.link.id, link.id)
  assert.equal(ops.listWishes({ status: 'committed' }).items.length, 1)

  // 二次转化 conflict
  await assert.rejects(
    async () => ops.convertWish(wish.id, { goal: { title: '重复' } }),
    (error) => {
      assert.equal(error.code, 'conflict')
      assert.equal(error.details.current.id, wish.id)
      return true
    },
  )
  await expectCode(() => ops.convertWish(wish.id, { goal: { title: 'x' } }), 'conflict')

  // 另一个愿望：expectedRev 不符 / 缺 goal
  const { wish: other } = await ops.createWish({ title: '换城市' })
  await assert.rejects(
    async () => ops.convertWish(other.id, { goal: { title: 'y' }, expectedRev: 5 }),
    (error) => {
      assert.equal(error.code, 'conflict')
      assert.equal(error.details.expectedRev, 5)
      assert.equal(error.details.currentRev, 1)
      return true
    },
  )
  await expectCode(() => ops.convertWish(other.id, {}), 'validation_failed')
  await expectCode(() => ops.convertWish('wsh_missing', { goal: { title: 'z' } }), 'not_found')

  assert.equal(
    events.filter((event) => event.kind === 'goal' && event.extra && event.extra.fromWish === wish.id).length,
    1,
  )
  assert.equal(
    events.filter((event) => event.kind === 'wish' && event.extra && event.extra.action === 'convert').length,
    1,
  )
  assertAllWritesValid(store)
})

test('oplog/state_change 记录贯穿 project/goal/wish 写路径', async (t) => {
  const { store, ops } = await setup(t)
  const project = await ops.createProject({ name: 'P' })
  await ops.updateProject(project.project.id, { description: 'd' }, { expectedRev: 1 })
  await ops.archiveProject(project.project.id, { expectedRev: 2 })
  const goal = await ops.createGoal({ title: 'G' })
  await ops.updateGoal(goal.goal.id, { status: 'achieved' }, { expectedRev: 1 })
  await ops.archiveGoal(goal.goal.id, { expectedRev: 2 })
  const wish = await ops.createWish({ title: 'W' })
  await ops.updateWish(wish.wish.id, { description: 'x' }, { expectedRev: 1 })

  const actions = logRows(store, 'operation_log').map((record) => record.action)
  assert.deepEqual(actions, [
    'project.create',
    'project.update',
    'project.archive',
    'goal.create',
    'goal.update',
    'goal.archive',
    'wish.create',
    'wish.update',
  ])
  for (const record of logRows(store, 'operation_log')) {
    assert.equal(record.permission_level, 'L2')
    assert.match(record.occurred_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  }
  for (const record of logRows(store, 'state_change')) {
    assert.match(record.changed_at, /Z$/)
  }
  assert.equal(logRows(store, 'state_change').length, 5) // project.update 1 + project.archive 2 + goal.update 1 + wish.update 1
  assertAllWritesValid(store)
})
