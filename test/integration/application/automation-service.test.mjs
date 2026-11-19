import test from 'node:test'
import assert from 'node:assert/strict'

import { openLifeosStore } from '../../../src/store/lifeos-store.js'
import { createAutomationService } from '../../../src/application/automation-service.js'
import { createTaskOps } from '../../../src/application/task-service.js'
import { createFakeBackend } from '../../unit/store/fake-backend.mjs'
import { newId } from '../../../src/domain/ids.js'
import { localDate } from '../../../src/domain/time.js'
import {
  AUTOMATION_SETTING_KEY,
  LEGACY_NIGHTLY_KEY,
  REMINDERS_KEY,
  SCHEDULES_KEY,
  normalizeAutomationSettings,
} from '../../../src/domain/automation-rules.js'

const TZ = 'Asia/Shanghai'
const BASE_MS = Date.parse('2026-11-14T05:00:00.000Z') // 北京时间 2026-11-14 13:00

function createFakeSchedule() {
  let seq = 0
  const items = new Map()
  const calls = { create: 0, update: 0, remove: 0, view: 0, list: 0, run: 0 }
  const api = {
    calls,
    items,
    async create(request) {
      calls.create += 1
      // 模拟宿主 schedule.create 的严格字段校验：只接受 ScheduleCreateRequest 的四个字段。
      // （M3 实测：把 `active` 塞进 create 请求会被宿主拒绝，导致 routine 创建失败。）
      const allowed = new Set(['title', 'prompt', 'timing', 'target'])
      for (const key of Object.keys(request || {})) {
        if (!allowed.has(key)) throw new Error(`schedule/input-invalid: unknown field ${key}`)
      }
      seq += 1
      const id = `sch_${seq}`
      const active = request.active !== false
      const record = {
        id,
        title: request.title,
        prompt: request.prompt,
        timing: request.timing,
        target: request.target,
        active,
        status: active ? 'active' : 'paused',
        nextRun: null,
      }
      items.set(id, record)
      return { id, record }
    },
    async list() {
      calls.list += 1
      return [...items.values()]
    },
    async view({ id }) {
      calls.view += 1
      const item = items.get(id)
      // 对齐宿主 schedule.view：不存在的 id 返回非空 miss DTO，而不是 null。
      return item ?? { id, code: 'schedule_not_found' }
    },
    async update({ id, patch }) {
      calls.update += 1
      const item = items.get(id)
      if (!item) throw new Error(`schedule not found: ${id}`)
      Object.assign(item, patch)
      if (patch.active === false) {
        item.active = false
        item.status = 'paused'
      } else if (patch.active === true) {
        item.active = true
        item.status = 'active'
      }
      return { id, record: item }
    },
    async remove({ id }) {
      calls.remove += 1
      return { removed: items.delete(id) }
    },
    async run({ id }) {
      calls.run += 1
      const item = items.get(id)
      if (!item) return { id, code: 'schedule_not_found' }
      const delivery = { at: new Date(BASE_MS).toISOString(), sessionId: `session-${id}`, outcome: 'delivered' }
      item.lastDelivery = delivery
      return { ...item, lastDelivery: delivery }
    },
  }
  return api
}

async function setup(t, options = {}) {
  const { backend } = createFakeBackend()
  const store = await openLifeosStore(null, { backend, testMode: true, timeZone: TZ })
  t.after(async () => {
    await store.close()
  })
  const clock = { ms: options.clock ?? BASE_MS }
  const schedule = options.schedule === false ? null : createFakeSchedule()
  const automation = createAutomationService({
    store,
    schedule,
    now: () => clock.ms,
    timeZone: TZ,
  })
  return { backend, store, clock, schedule, automation }
}

async function putSetting(store, key, valueJson) {
  const at = new Date(BASE_MS).toISOString()
  await store.put('lifeos', 'app_setting', key, {
    key,
    id: key,
    value_json: valueJson,
    updated_at: at,
    schema_version: 1,
  })
}

function reminderSchedules(schedule) {
  return [...schedule.items.values()].filter((item) => String(item.title || '').includes('截止提醒'))
}

async function seedTask(store, overrides = {}) {
  const id = overrides.id ?? newId('tsk')
  const nowIso = new Date(BASE_MS).toISOString()
  const record = {
    id,
    title: '交实验结果',
    status: 'todo',
    created_at: nowIso,
    updated_at: nowIso,
    ...overrides,
  }
  await store.put('lifeos', 'task', id, record)
  return { ...record, id }
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `期望 ${code}，实际 ${error.code}: ${error.message}`)
    return true
  })
}

test('getSettings：默认值 + M2 automation.inbox_nightly 迁移合并', async (t) => {
  const { store, automation } = await setup(t)
  const first = automation.getSettings()
  assert.equal(first.settings.morningBrief.enabled, true)
  assert.equal(first.settings.eveningReview.enabled, false)
  assert.equal(first.settings.habitNudge.enabled, false)
  assert.equal(first.settings.nightlyInbox.enabled, true)
  assert.equal(first.settings.dailyBudget, 2)
  assert.equal(first.settings.deadlineReminder.leadMinutes, 60)
  assert.deepEqual(first.settings.dnd, { start: '22:45', end: '07:30' })
  assert.equal(first.valid, true)
  assert.equal(first.migrated, false)
  assert.equal(first.routines.length, 4)

  await putSetting(store, LEGACY_NIGHTLY_KEY, { enabled: false, time: '22:00', scheduleId: null })
  const second = automation.getSettings()
  assert.equal(second.migrated, true)
  assert.deepEqual(second.settings.nightlyInbox, { enabled: false, time: '22:00' })

  // patch 后统一设置持久化，且 legacy 同步
  await automation.patchSettings({ dailyBudget: 3 })
  const stored = store.get('lifeos', 'app_setting', AUTOMATION_SETTING_KEY)
  assert.equal(stored.value_json.dailyBudget, 3)
  assert.equal(stored.value_json.nightlyInbox.enabled, false)
  assert.equal(stored.value_json.nightlyInbox.time, '22:00')
  assert.equal(stored.value_json.revision, 1)
  const legacy = store.get('lifeos', 'app_setting', LEGACY_NIGHTLY_KEY)
  assert.equal(legacy.value_json.enabled, false)
  assert.equal(legacy.value_json.time, '22:00')
})

test('patchSettings：校验失败（时间/预算/提前量/routine 落在 dnd/未知键）', async (t) => {
  const { automation } = await setup(t)
  for (const patch of [
    { dailyBudget: 9 },
    { dailyBudget: -1 },
    { morningBrief: { time: '25:00' } },
    { deadlineReminder: { leadMinutes: 3 } },
    { eveningReview: { enabled: true, time: '23:30' } },
    { dnd: { start: '24:00', end: '07:00' } },
    { unknownKey: 1 },
  ]) {
    await assert.rejects(automation.patchSettings(patch), (error) => {
      assert.equal(error.code, 'validation_failed')
      assert.ok(Array.isArray(error.details.errors) && error.details.errors.length > 0)
      return true
    })
  }
  const inDnd = await automation.patchSettings({ eveningReview: { enabled: true, time: '23:00' } }).catch((error) => error)
  assert.equal(inDnd.code, 'validation_failed')
  assert.ok(inDnd.details.errors.some((line) => line.includes('免打扰')))
})

test('patchSettings：成功写 operation_log（before/after/diff）+ 返回 diff/impacted + 自动对账', async (t) => {
  const { store, automation, schedule } = await setup(t)
  const result = await automation.patchSettings({
    morningBrief: { enabled: false },
    eveningReview: { enabled: true, time: '20:00' },
    dailyBudget: 3,
    deadlineReminder: { leadMinutes: 30 },
  })
  assert.equal(result.revision, 1)
  assert.ok(result.impacted.includes('morningBrief'))
  assert.ok(result.impacted.includes('eveningReview'))
  assert.ok(result.impacted.includes('dailyBudget'))
  assert.ok(result.impacted.includes('deadlineReminder'))
  assert.ok(result.diff.changed.some((item) => item.path === 'morningBrief.enabled'))
  assert.equal(result.reconcile.status, 'ok')
  assert.equal(result.reconcile.schedules.length, 4)
  assert.equal(schedule.items.size, 4)

  const oplogs = store
    .entries('lifeos_log', 'operation_log')
    .map(([, record]) => record)
    .filter((record) => record.action === 'settings.update')
  assert.equal(oplogs.length, 1)
  assert.equal(oplogs[0].actor_type, 'user')
  assert.equal(oplogs[0].target_type, 'app_setting')
  assert.equal(oplogs[0].before_json.dailyBudget, 2)
  assert.equal(oplogs[0].after_json.dailyBudget, 3)
  assert.ok(oplogs[0].diff_json.impacted.includes('dailyBudget'))
  assert.equal(oplogs[0].reversible, true)

  const mapping = store.get('lifeos', 'app_setting', SCHEDULES_KEY)
  assert.ok(mapping)
  assert.equal(Object.keys(mapping.value_json.routines).length, 4)
})

test('reconcileSchedules：4 条 routine、target/prompt、幂等、暂停/恢复、重建、残留清理、不可用降级', async (t) => {
  const { store, automation, schedule } = await setup(t)
  const first = await automation.reconcileSchedules()
  assert.equal(first.status, 'ok')
  assert.equal(first.schedules.length, 4)
  assert.equal(schedule.items.size, 4)
  const titles = [...schedule.items.values()].map((item) => item.title)
  assert.deepEqual(new Set(titles), new Set(['LifeOS · 晨间简报', 'LifeOS · 晚报', 'LifeOS · 习惯追问', 'LifeOS · 夜间整理']))
  const nightly = [...schedule.items.values()].find((item) => item.title === 'LifeOS · 夜间整理')
  const morning = [...schedule.items.values()].find((item) => item.title === 'LifeOS · 晨间简报')
  assert.deepEqual(nightly.target, { kind: 'new', create: { agentPreset: 'lifeos' } })
  assert.deepEqual(morning.target, { kind: 'new_once', create: { agentPreset: 'lifeos' } })
  assert.equal(nightly.timing.kind, 'cron')
  assert.equal(nightly.timing.cron.expression, '30 21 * * *')
  assert.ok(morning.prompt.includes('LifeOS'))
  // 默认关闭的两条 → active:false
  assert.equal([...schedule.items.values()].find((item) => item.title === 'LifeOS · 晚报').status, 'paused')

  // 幂等：第二次不新建/不更新
  const createCalls = schedule.calls.create
  const updateCalls = schedule.calls.update
  const second = await automation.reconcileSchedules()
  assert.equal(second.status, 'ok')
  assert.equal(schedule.calls.create, createCalls)
  assert.equal(schedule.calls.update, updateCalls)

  // 关闭晨间 → active:false（不删除）
  await automation.patchSettings({ morningBrief: { enabled: false } })
  const morning2 = [...schedule.items.values()].find((item) => item.title === 'LifeOS · 晨间简报')
  assert.equal(morning2.status, 'paused')
  assert.equal(schedule.calls.remove, 0)

  // 重新开启 → active:true
  await automation.patchSettings({ morningBrief: { enabled: true, time: '08:00' } })
  const morning3 = [...schedule.items.values()].find((item) => item.title === 'LifeOS · 晨间简报')
  assert.equal(morning3.status, 'active')
  assert.equal(morning3.timing.cron.expression, '0 8 * * *')

  // 外部删除 → 对账重建
  const beforeRecreate = schedule.calls.create
  schedule.items.delete(morning3.id)
  await automation.reconcileSchedules()
  assert.equal(schedule.calls.create, beforeRecreate + 1)
  assert.equal(schedule.items.size, 4)

  // 残留 LifeOS routine 清理；非 LifeOS schedule 不动
  await schedule.create({ title: 'LifeOS · 旧任务', prompt: 'x', timing: { kind: 'cron', cron: {} }, target: {} })
  await schedule.create({ title: '用户的其它定时任务', prompt: 'x', timing: { kind: 'cron', cron: {} }, target: {} })
  const beforeCleanup = schedule.calls.remove
  await automation.reconcileSchedules()
  assert.ok(schedule.calls.remove >= beforeCleanup + 1)
  assert.equal([...schedule.items.values()].some((item) => item.title === 'LifeOS · 旧任务'), false)
  assert.equal([...schedule.items.values()].some((item) => item.title === '用户的其它定时任务'), true)

  // 截止提醒 schedule 不能被残留清理误删（M3-G2 回归：标题同样以 LifeOS · 开头）
  const remindTask = await seedTask(store, { title: '提醒保留', due_date: '2026-11-16' })
  const reminder = await automation.syncTaskReminder(remindTask)
  assert.equal(reminder.status, 'created')
  const reminderId = reminder.scheduleId
  assert.ok([...schedule.items.values()].some((item) => item.id === reminderId))
  const beforeReminderReconcile = schedule.calls.remove
  await automation.reconcileSchedules()
  assert.equal([...schedule.items.values()].some((item) => item.id === reminderId), true)
  assert.equal(schedule.calls.remove, beforeReminderReconcile)
  // 映射丢失但标题仍是提醒 → 也不能当残留删除（防御）
  await putSetting(store, REMINDERS_KEY, { items: {} })
  await automation.reconcileSchedules()
  assert.equal([...schedule.items.values()].some((item) => item.id === reminderId), true)

  // 不可用降级：设置仍可保存，状态 unavailable
  const unavailable = await setup(t, { schedule: false })
  const patchResult = await unavailable.automation.patchSettings({ dailyBudget: 1 })
  assert.equal(patchResult.reconcile.status, 'unavailable')
  assert.equal((await unavailable.automation.getStatus()).scheduleUnavailable, true)
  const syncResult = await unavailable.automation.syncTaskReminder({ id: 'tsk_x', status: 'todo', due_at: '2026-11-15T06:00:00.000Z' })
  assert.equal(syncResult.status, 'unavailable')
})

test('syncTaskReminder：due_at 提前 60 / due_date 当天 09:00 / 幂等 / 改期 / 完成清理 / 无 due', async (t) => {
  const { store, automation, schedule } = await setup(t)
  const task = await seedTask(store, { due_at: '2026-11-14T08:00:00.000Z' }) // 本地 16:00
  const created = await automation.syncTaskReminder(task)
  assert.equal(created.status, 'created')
  assert.equal(created.remindAt, '2026-11-14T07:00:00.000Z') // 15:00 本地
  assert.equal(reminderSchedules(schedule).length, 1)
  const entry = reminderSchedules(schedule)[0]
  assert.ok(entry.title.includes('截止提醒'))
  assert.equal(entry.timing.kind, 'at')
  assert.equal(entry.timing.at, '2026-11-14T07:00:00.000Z')
  // 宿主 ScheduleTiming 对 at 只接受 { kind, at }；多余字段会被 invalid_rule 拒绝。
  assert.deepEqual(Object.keys(entry.timing).sort(), ['at', 'kind'])
  assert.deepEqual(entry.target, { kind: 'new_once', create: { agentPreset: 'lifeos' } })
  const mapping = store.get('lifeos', 'app_setting', REMINDERS_KEY)
  assert.equal(mapping.value_json.items[task.id].scheduleId, created.scheduleId)

  // 幂等：同任务同时间 → unchanged，不新增
  const again = await automation.syncTaskReminder(task)
  assert.equal(again.status, 'unchanged')
  assert.equal(again.scheduleId, created.scheduleId)
  assert.equal(reminderSchedules(schedule).length, 1)

  // 改期 → 更新同一条 schedule
  const later = await seedTask(store, { id: task.id, due_at: '2026-11-14T10:00:00.000Z', rev: 2 })
  const updated = await automation.syncTaskReminder(later)
  assert.equal(updated.status, 'updated')
  assert.equal(updated.scheduleId, created.scheduleId)
  assert.equal(reminderSchedules(schedule)[0].timing.at, '2026-11-14T09:00:00.000Z')

  // 外部删除 schedule（signature 相同也要重建）
  schedule.items.delete(updated.scheduleId)
  const rebuilt = await automation.syncTaskReminder(later)
  assert.equal(rebuilt.status, 'created')
  assert.notEqual(rebuilt.scheduleId, updated.scheduleId)
  assert.equal(reminderSchedules(schedule).length, 1)
  assert.equal(store.get('lifeos', 'app_setting', REMINDERS_KEY).value_json.items[task.id].scheduleId, rebuilt.scheduleId)

  // 完成 → 删除 schedule + 清理映射
  const done = { ...later, status: 'done', completed_at: '2026-11-14T06:00:00.000Z' }
  const removed = await automation.syncTaskReminder(done)
  assert.equal(removed.status, 'removed')
  assert.equal(reminderSchedules(schedule).length, 0)
  assert.equal(store.get('lifeos', 'app_setting', REMINDERS_KEY).value_json.items[task.id], undefined)

  // 只有 due_date → 当天 dueDateAt(09:00)
  const dateTask = await seedTask(store, { title: '日期截止', due_date: '2026-11-15' })
  const byDate = await automation.syncTaskReminder(dateTask)
  assert.equal(byDate.status, 'created')
  assert.equal(byDate.remindAt, '2026-11-15T01:00:00.000Z')

  // 无 due → none
  const noDue = await seedTask(store, { title: '无截止' })
  assert.equal((await automation.syncTaskReminder(noDue)).status, 'none')
})

test('syncTaskReminder：dnd 跳过记 outbox、已过期跳过、设置关闭清理', async (t) => {
  const { store, automation, schedule, clock } = await setup(t)
  // 23:30 本地的提醒：due_at 次日 00:30 本地 = 16:30Z
  const dndTask = await seedTask(store, { title: '睡前任务', due_at: '2026-11-14T16:30:00.000Z' })
  const skipped = await automation.syncTaskReminder(dndTask)
  assert.equal(skipped.status, 'skipped_dnd')
  assert.equal(skipped.remindAt, '2026-11-14T15:30:00.000Z')
  assert.equal(reminderSchedules(schedule).length, 0)
  const outbox = automation.listNotifications({ limit: 10 })
  const outboxRecord = outbox.items.find((item) => item.source_id === dndTask.id || item.meta_json?.taskId === dndTask.id)
  assert.ok(outboxRecord, 'dnd 跳过必须记 notification_outbox')
  assert.equal(outboxRecord.status, 'expired')
  assert.equal(outboxRecord.meta_json.status, 'skipped_dnd')

  // 提醒时间已过 → skipped_past，不建 schedule
  const pastTask = await seedTask(store, { title: '已过期', due_at: '2026-11-14T05:30:00.000Z' })
  assert.equal((await automation.syncTaskReminder(pastTask)).status, 'skipped_past')
  assert.equal(reminderSchedules(schedule).length, 0)

  // 关闭截止提醒 → 清理已有
  clock.ms = BASE_MS
  const normal = await seedTask(store, { title: '正常任务', due_at: '2026-11-14T08:00:00.000Z' })
  assert.equal((await automation.syncTaskReminder(normal)).status, 'created')
  await automation.patchSettings({ deadlineReminder: { enabled: false } })
  // patch 触发 reconcileReminders 清理（routines 不计入提醒数量）
  assert.equal(reminderSchedules(schedule).length, 0)
})

test('reconcileReminders：未来 7 天批量对账 + 清理关闭/孤儿映射', async (t) => {
  const { store, automation, schedule } = await setup(t)
  const dueSoon = await seedTask(store, { title: '未来 3 天', due_date: '2026-11-16' })
  const dueFar = await seedTask(store, { title: '10 天后', due_at: '2026-11-24T05:00:00.000Z' })
  const doneTask = await seedTask(store, { title: '已完成', due_at: '2026-11-14T08:00:00.000Z' })
  // 先给 doneTask 建提醒，再标记完成 → 批量对账应清理
  await automation.syncTaskReminder(doneTask)
  await store.put('lifeos', 'task', doneTask.id, { ...doneTask, status: 'done', completed_at: '2026-11-14T05:30:00.000Z' })
  // 孤儿映射：任务已不存在
  const orphanScheduleId = (await schedule.create({ title: 'LifeOS · 截止提醒 · 孤儿', prompt: 'x', timing: { kind: 'at', at: '2026-11-15T05:00:00.000Z' }, target: {} }, undefined)).id
  const currentMapping = store.get('lifeos', 'app_setting', REMINDERS_KEY)
  await putSetting(store, REMINDERS_KEY, {
    ...(currentMapping.value_json ?? {}),
    items: {
      ...(currentMapping.value_json?.items ?? {}),
      tsk_orphan: { scheduleId: orphanScheduleId, remindAt: '2026-11-15T05:00:00.000Z', title: 'x', signature: 's', updatedAt: '2026-11-14T05:00:00.000Z' },
    },
  })
  const result = await automation.reconcileReminders()
  assert.ok(result.scanned >= 1)
  assert.ok(result.created >= 1, '未来 3 天任务应创建提醒')
  assert.ok(result.removed >= 2, '已完成任务 + 孤儿映射应被清理')
  const mapping = store.get('lifeos', 'app_setting', REMINDERS_KEY).value_json.items
  assert.equal(mapping[doneTask.id], undefined)
  assert.equal(mapping.tsk_orphan, undefined)
  assert.ok(mapping[dueSoon.id], '未来任务应有提醒映射')
  assert.equal(mapping[dueFar.id], undefined, '7 天外任务不在批量范围')
})

test('通知 outbox / 预算 / isDnd', async (t) => {
  const { store, automation, clock } = await setup(t)
  const recorded = await automation.recordNotification({
    type: 'morning_brief',
    title: '晨间简报',
    body: '今天 3 件事',
    meta: { localDate: '2026-11-14' },
  })
  assert.match(recorded.notification.id, /^notif_/)
  assert.equal(recorded.notification.kind, 'morning_brief')
  assert.equal(recorded.notification.status, 'pending')
  assert.ok(store.get('lifeos', 'notification_outbox', recorded.notification.id))
  const list = automation.listNotifications({ limit: 5 })
  assert.equal(list.items.length, 1)
  const read = await automation.markNotificationRead(recorded.notification.id)
  assert.equal(read.notification.status, 'delivered')
  assert.ok(read.notification.read_at)

  // 非白名单状态 → 落库为 expired + meta 标记
  const skipped = await automation.recordNotification({
    type: 'deadline_reminder',
    title: '跳过',
    body: 'dnd 跳过',
    status: 'skipped_dnd',
    meta: { taskId: 'tsk_1' },
    metaStatus: 'skipped_dnd',
  })
  assert.equal(skipped.notification.status, 'expired')
  assert.equal(skipped.notification.meta_json.status, 'skipped_dnd')

  // 预算：默认 2 → 第 3 次 false；跨日重置
  assert.equal((await automation.consumeDailyBudget('brief')).ok, true)
  assert.equal((await automation.consumeDailyBudget('brief')).ok, true)
  const over = await automation.consumeDailyBudget('brief')
  assert.equal(over.ok, false)
  assert.equal(over.used, 2)
  clock.ms = BASE_MS + 24 * 3600 * 1000
  assert.equal((await automation.consumeDailyBudget('brief')).ok, true)
  await automation.patchSettings({ dailyBudget: 0 })
  assert.equal((await automation.consumeDailyBudget('brief')).ok, false)
  clock.ms = BASE_MS

  // isDnd 边界
  assert.equal(automation.isDnd(new Date('2026-11-13T15:00:00.000Z')), true) // 23:00
  assert.equal(automation.isDnd(new Date('2026-11-13T23:29:00.000Z')), true) // 07:29
  assert.equal(automation.isDnd(new Date('2026-11-13T23:30:00.000Z')), false) // 07:30
  assert.equal(automation.isDnd(new Date('2026-11-14T04:00:00.000Z')), false) // 12:00
})

test('task-service 钩子：创建/完成任务自动同步提醒（软失败不影响主流程）', async (t) => {
  const { store, automation, schedule } = await setup(t)
  const todayLocal = () => localDate(TZ, new Date(BASE_MS))
  const ops = createTaskOps({
    store,
    newId,
    now: () => BASE_MS,
    timeZone: TZ,
    todayLocal,
    emitChanged: () => {},
    onTaskWrite: (task) => automation.syncTaskReminder(task),
  })
  const created = await ops.createTask({ title: '交实验结果', dueAt: '2026-11-14T08:00:00.000Z' })
  assert.equal(created.task.status, 'todo')
  assert.equal(schedule.items.size, 1, '创建任务后应生成截止提醒')
  const mapping = store.get('lifeos', 'app_setting', REMINDERS_KEY)
  assert.ok(mapping.value_json.items[created.task.id])

  const done = await ops.completeTask(created.task.id, created.rev)
  assert.equal(done.task.status, 'done')
  assert.equal(schedule.items.size, 0, '完成任务后应清理提醒')

  // 钩子软失败：createTask 仍成功
  const failing = createTaskOps({
    store,
    newId,
    now: () => BASE_MS,
    timeZone: TZ,
    todayLocal: () => localDate(TZ, new Date(BASE_MS)),
    emitChanged: () => {},
    onTaskWrite: () => {
      throw new Error('hook boom')
    },
  })
  const stillCreated = await failing.createTask({ title: '钩子失败任务' })
  assert.equal(stillCreated.task.status, 'todo')
})

test('runRoutine：立即运行 routine 并回写 lastRunAt/lastRunStatus', async (t) => {
  const { store, automation, schedule } = await setup(t)
  // 未对账（无 routine 映射）→ not_scheduled
  assert.deepEqual(await automation.runRoutine('morningBrief'), { status: 'not_scheduled', key: 'morningBrief' })
  // 未知 key → invalid
  assert.deepEqual(await automation.runRoutine('notARoutine'), { status: 'invalid', key: 'notARoutine' })

  await automation.reconcileSchedules()
  const morning = store.get('lifeos', 'app_setting', SCHEDULES_KEY).value_json.routines.morningBrief
  assert.ok(morning && morning.scheduleId, '对账后应有 morningBrief 映射')

  const result = await automation.runRoutine('morningBrief')
  assert.equal(result.status, 'delivered')
  assert.equal(result.key, 'morningBrief')
  assert.equal(result.scheduleId, morning.scheduleId)
  assert.ok(result.sessionId, '应立即运行返回投递会话 id')
  assert.equal(result.sessionId, `session-${morning.scheduleId}`)
  assert.equal(schedule.calls.run, 1)
  const updated = store.get('lifeos', 'app_setting', SCHEDULES_KEY).value_json.routines.morningBrief
  assert.ok(updated.lastRunAt, '运行后应回写 lastRunAt')
  assert.equal(updated.lastRunStatus, 'delivered')
})

test('runRoutine：adapter 不可用 / 运行抛错 的降级行为', async (t) => {
  // 无 schedule adapter → unavailable
  {
    const { backend } = createFakeBackend()
    const store = await openLifeosStore(null, { backend, testMode: true, timeZone: TZ })
    t.after(async () => {
      await store.close()
    })
    const automation = createAutomationService({ store, schedule: null, now: () => BASE_MS, timeZone: TZ })
    await putSetting(store, SCHEDULES_KEY, { routines: { morningBrief: { scheduleId: 'sch_x' } }, lastReconciledAt: null, timeZone: TZ })
    assert.deepEqual(await automation.runRoutine('morningBrief'), { status: 'unavailable', key: 'morningBrief' })
  }
  // 宿主 run 抛错 → error，不把异常抛给路由
  {
    const { store, automation, schedule } = await setup(t)
    await automation.reconcileSchedules()
    schedule.run = async () => {
      throw new Error('schedule/boom')
    }
    const failed = await automation.runRoutine('morningBrief')
    assert.equal(failed.status, 'error')
    assert.match(failed.reason, /schedule\/boom/)
  }
})
