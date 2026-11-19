/**
 * LifeOS — 自动化服务（M3 A 线）
 *
 * 契约：`M3-PLAN.md` §1（设置真源）/§2（routine 对账）/§3（截止提醒）/§7（B 路由）/§9（门禁）。
 *
 * 职责：
 *  - `app_setting['automation']` 单一设置真源：getSettings/patchSettings（校验 + oplog + diff/impacted；
 *    兼容 M2 `automation.inbox_nightly`）；
 *  - routine 对账：4 条（morningBrief/eveningReview/habitNudge/nightlyInbox），只注册/更新/暂停/删除
 *    宿主 schedule，routine 内容由 Agent 在会话中生成；
 *  - 截止提醒：任务 due → at 提醒（due_at - leadMinutes / due_date 当天 dueDateAt）；dnd 跳过记 outbox；
 *  - 通知/预算/静默：notification_outbox、每日预算、isDnd。
 *
 * 零第三方依赖；不 import `@deepseek-ai/*`。schedule 以 adapter 注入（B 用 ctx.schedule 包装），
 * 测试用内存 fake adapter。
 */

import { newId as defaultNewId } from '../domain/ids.js'
import { addDays, localDate, localDateOfIso, nowIso } from '../domain/time.js'
import { LifeosError } from './errors.js'
import {
  AUTOMATION_SETTING_KEY,
  BUDGET_KEY_PREFIX,
  DND_POLICIES,
  LEGACY_NIGHTLY_KEY,
  REMINDERS_KEY,
  ROUTINE_KEYS,
  ROUTINE_META,
  ROUTINE_PROMPT_VERSION,
  SCHEDULES_KEY,
  SCHEDULE_TITLE_PREFIX,
  budgetKey,
  budgetState,
  buildRoutinePrompt,
  canConsumeBudget,
  dndView,
  diffAutomationSettings,
  isDndAt,
  isReminderInDnd,
  isTimeInDnd,
  deadlineRemindAt,
  localHm,
  migrateAutomationSettings,
  mergeAutomationSettings,
  nextRoutineAt,
  normalizeAutomationSettings,
  routineCron,
  routineSettingsView,
  routineSignature,
  routineTarget,
  validateAutomationPatchShape,
  validateAutomationSettings,
} from '../domain/automation-rules.js'

const CORE = 'lifeos'
const LOG = 'lifeos_log'
const OPEN_TASK_STATUSES = ['todo', 'doing']
const REMINDER_WINDOW_DAYS = 7
const OUTBOX_STATUSES = ['pending', 'delivered', 'dismissed', 'expired']
// 截止提醒 schedule 的标题同样以 SCHEDULE_TITLE_PREFIX 开头，但由 reconcileReminders 管理，
// reconcileSchedules 的“残留清理”必须放过它们（M3-G2 回归：曾被前缀规则误删）。
const REMINDER_TITLE_PREFIX = `${SCHEDULE_TITLE_PREFIX}截止提醒`
const OUTBOX_KINDS = ['morning_brief', 'deadline_reminder', 'organize_report', 'habit_ask', 'coach_nudge', 'system']
const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4']

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toMs(now) {
  if (now instanceof Date) return now.getTime()
  if (typeof now === 'number' && Number.isFinite(now)) return now
  return Date.now()
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('invalid time')
  return date.toISOString()
}

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value
}

function dedupeArray(values) {
  return [...new Set(values.filter(Boolean))]
}

/**
 * @param {{
 *   store: object,
 *   schedule?: object|(()=>object|null)|null,
 *   newId?: (prefix:string)=>string,
 *   now?: ()=>number|Date,
 *   timeZone?: string,
 *   logger?: object|null,
 *   diagnostics?: object|null,
 *   actorSessionId?: string|null,
 *   emitChanged?: (kind:string, ids:string[], extra?:object)=>void,
 * }} deps
 */
export function createAutomationService(deps = {}) {
  const { store } = deps
  if (!store || typeof store.get !== 'function' || typeof store.transaction !== 'function') {
    throw new LifeosError('validation_failed', 'createAutomationService 需要 LifeosStore')
  }
  const newId = typeof deps.newId === 'function' ? deps.newId : (prefix) => defaultNewId(prefix)
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const timeZone = typeof deps.timeZone === 'string' && deps.timeZone.length > 0 ? deps.timeZone : 'Asia/Shanghai'
  const logger = deps.logger || null
  const diagnostics = deps.diagnostics || null
  const actorSessionId = deps.actorSessionId || null
  const emitChanged = typeof deps.emitChanged === 'function' ? deps.emitChanged : null
  const state = {
    lastReconcileAt: null,
    lastReconcile: null,
    lastReminderReconcileAt: null,
    lastReminderReconcile: null,
    lastError: null,
    scheduleUnavailable: false,
  }

  /* ── store helpers ─────────────────────────────────────── */

  function getSetting(key) {
    try {
      const record = store.get(CORE, 'app_setting', key)
      if (!record) return null
      if (isPlainObject(record.value_json)) return record.value_json
      if (isPlainObject(record.value)) return record.value
      return null
    } catch {
      return null
    }
  }

  function appSettingRecord(key, valueJson) {
    const at = iso(now())
    return { key, id: key, value_json: valueJson, updated_at: at, schema_version: 1 }
  }

  async function writeSettingsValue(valueJson, extraOps = []) {
    const ops = [{ unit: CORE, table: 'app_setting', key: AUTOMATION_SETTING_KEY, value: appSettingRecord(AUTOMATION_SETTING_KEY, valueJson) }]
    ops.push(...extraOps)
    await store.transaction(ops)
    return valueJson
  }

  async function writeInternalSetting(key, valueJson) {
    await store.transaction([
      { unit: CORE, table: 'app_setting', key, value: appSettingRecord(key, valueJson) },
    ])
  }

  function readLegacyNightly() {
    return getSetting(LEGACY_NIGHTLY_KEY)
  }

  function readLegacyReminderMapping() {
    return getSetting(REMINDERS_KEY)
  }

  function readScheduleMapping() {
    const value = getSetting(SCHEDULES_KEY)
    if (isPlainObject(value) && isPlainObject(value.routines)) return { routines: { ...value.routines }, raw: value }
    return { routines: {}, raw: null }
  }

  /** 有效设置（含 M2 legacy 迁移合并 + revision）。 */
  function effectiveSettings() {
    const raw = getSetting(AUTOMATION_SETTING_KEY)
    const legacy = readLegacyNightly()
    const { settings, migrated } = migrateAutomationSettings(raw, legacy)
    const revision = isPlainObject(raw) && Number.isInteger(raw.revision) ? raw.revision : 0
    return { settings, raw, legacy, migrated, revision }
  }

  function settingsOrThrow() {
    const { settings } = effectiveSettings()
    const check = validateAutomationSettings(settings)
    if (!check.ok) {
      // 存量数据损坏时回退默认值（不阻断自动化服务），记录诊断
      logger?.warn?.({ event: 'automation.settings_invalid_fallback', errors: check.errors })
      const fallback = normalizeAutomationSettings({})
      return fallback
    }
    return settings
  }

  /* ── schedule adapter（注入；容忍多种宿主形态） ─────────── */

  function adapter() {
    const value = typeof deps.schedule === 'function' ? deps.schedule() : deps.schedule
    return value && typeof value === 'object' ? value : null
  }

  async function scheduleList() {
    const schedule = adapter()
    if (!schedule) return []
    try {
      if (typeof schedule.list === 'function') {
        const listed = await schedule.list({})
        if (Array.isArray(listed)) return listed
        if (Array.isArray(listed?.items)) return listed.items
      }
      if (typeof schedule.catalog === 'function') {
        const catalog = await schedule.catalog()
        if (Array.isArray(catalog)) return catalog
        if (Array.isArray(catalog?.items)) return catalog.items
      }
    } catch (error) {
      state.lastError = `schedule.list 失败：${error?.message ?? error}`
      diagnostics?.recordError?.('automation_schedule_list_failed', state.lastError)
    }
    return []
  }

  function normalizeScheduleId(result) {
    if (!result) return null
    if (typeof result === 'string') return result
    return (
      result.id ||
      result.scheduleId ||
      result.record?.id ||
      result.schedule?.id ||
      result.catalogEntry?.id ||
      null
    )
  }

  async function scheduleCreate(request) {
    const schedule = adapter()
    if (!schedule || typeof schedule.create !== 'function') throw new Error('schedule.create 不可用')
    const created = await schedule.create(request, actorSessionId || undefined)
    const id = normalizeScheduleId(created)
    if (!id) throw new Error('schedule.create 未返回 id')
    return id
  }

  async function scheduleView(id) {
    const schedule = adapter()
    if (!schedule || !id) return null
    try {
      if (typeof schedule.view === 'function') {
        const view = await schedule.view({ id })
        if (!view) return null
        // 宿主 schedule.view 对不存在的 id 返回非空 miss DTO（{ id, code: 'schedule_not_found' }），
        // 不能当有效 view：否则对账会把“已删除的 schedule”误判为 active，永远不重建。
        if (isPlainObject(view) && typeof view.code === 'string' && /not[_-]?found|missing/i.test(view.code)) return null
        return view.record && !view.id ? view.record : view
      }
    } catch {
      return null
    }
    return null
  }

  async function scheduleUpdate(id, patch) {
    const schedule = adapter()
    if (!schedule || !id) return false
    try {
      if (typeof schedule.update === 'function') {
        await schedule.update({ id, patch })
        return true
      }
      if (typeof schedule.edit === 'function') {
        await schedule.edit({ id, action: 'update', patch }, actorSessionId || undefined)
        return true
      }
    } catch (error) {
      state.lastError = `schedule.update 失败：${error?.message ?? error}`
      diagnostics?.recordError?.('automation_schedule_update_failed', state.lastError)
    }
    return false
  }

  async function scheduleRemove(id) {
    const schedule = adapter()
    if (!schedule || !id) return false
    try {
      if (typeof schedule.remove === 'function') {
        await schedule.remove({ id })
        return true
      }
      if (typeof schedule.delete === 'function') {
        await schedule.delete({ id })
        return true
      }
      if (typeof schedule.edit === 'function') {
        await schedule.edit({ id, action: 'delete' }, actorSessionId || undefined)
        return true
      }
    } catch (error) {
      state.lastError = `schedule.remove 失败：${error?.message ?? error}`
      diagnostics?.recordError?.('automation_schedule_remove_failed', state.lastError)
    }
    return false
  }

  function scheduleStatusOf(view) {
    if (!view) return 'missing'
    if (typeof view.code === 'string' && /not[_-]?found|missing/i.test(view.code)) return 'missing'
    const status = String(view.status || view.record?.status || 'active')
    if (status === 'ended' || status === 'deleted') return 'ended'
    if (status === 'paused' || view.active === false) return 'paused'
    return 'active'
  }

  function scheduleNextRun(view) {
    return view?.nextRun || view?.next_at || view?.nextAt || view?.record?.nextRun || view?.record?.scheduledAt || null
  }

  /* ── routine 对账 ─────────────────────────────────────── */

  async function reconcileSchedules() {
    const settings = settingsOrThrow()
    const schedule = adapter()
    const at = iso(now())
    state.lastReconcileAt = at
    if (!schedule) {
      state.scheduleUnavailable = true
      state.lastReconcile = { status: 'unavailable', schedules: [], impacted: [], at, error: '宿主 schedule 服务不可用' }
      diagnostics?.recordError?.('automation_schedule_unavailable', '自动化 routine 对账：宿主 schedule 服务不可用（跳过，不影响设置保存）')
      return state.lastReconcile
    }
    state.scheduleUnavailable = false
    const mapping = readScheduleMapping()
    const catalog = await scheduleList()
    const legacy = readLegacyNightly()
    const impacted = []
    const errors = []
    const usedIds = new Set()
    const expectedTitles = new Set(ROUTINE_KEYS.map((key) => ROUTINE_META[key].title))
    // 已登记的截止提醒 schedule id：routine 清理绝不能碰（包括映射尚未来得及清掉的孤儿子）。
    const reminderMapping = readLegacyReminderMapping()
    const reminderIds = new Set(
      isPlainObject(reminderMapping) && isPlainObject(reminderMapping.items)
        ? Object.values(reminderMapping.items)
            .map((item) => (isPlainObject(item) ? item.scheduleId : null))
            .filter((id) => typeof id === 'string' && id)
        : [],
    )
    const schedules = []
    const nextMapping = { ...mapping.routines }

    for (const key of ROUTINE_KEYS) {
      const routine = settings[key]
      const meta = ROUTINE_META[key]
      const signature = routineSignature(key, settings, timeZone)
      const request = {
        title: meta.title,
        prompt: buildRoutinePrompt(key, { timeZone }),
        timing: { kind: 'cron', cron: routineCron(routine.time, timeZone) },
        target: routineTarget(key),
      }
      const previous = isPlainObject(nextMapping[key]) ? nextMapping[key] : null
      let scheduleId = previous?.scheduleId || null
      // M2 legacy 夜间整理 scheduleId 兼容收养
      if (!scheduleId && key === 'nightlyInbox' && typeof legacy?.scheduleId === 'string') {
        scheduleId = legacy.scheduleId
      }
      // 无映射时按 title 收养已有 schedule（避免重复创建）
      if (!scheduleId) {
        const existing = catalog.find((entry) => entry && String(entry.title || entry.record?.title) === meta.title)
        scheduleId = normalizeScheduleId(existing)
      }
      if (scheduleId) usedIds.add(scheduleId)

      let view = scheduleId ? await scheduleView(scheduleId) : null
      if (scheduleId && !view) {
        // view 不可用时用 catalog 兜底
        const entry = catalog.find((item) => normalizeScheduleId(item) === scheduleId)
        view = entry || null
      }
      let status = 'ok'
      if (!view) {
        try {
          scheduleId = await scheduleCreate(request)
          usedIds.add(scheduleId)
          if (!routine.enabled) await scheduleUpdate(scheduleId, { active: false })
          status = 'created'
          impacted.push(key)
        } catch (error) {
          status = 'error'
          errors.push(`${key}: ${error?.message ?? error}`)
          scheduleId = null
        }
      } else {
        const viewStatus = scheduleStatusOf(view)
        const previousSignature = previous?.signature ?? null
        const activeOk = routine.enabled ? viewStatus === 'active' : viewStatus === 'paused'
        if (previousSignature === signature && activeOk) {
          status = 'ok'
        } else {
          const ok = await scheduleUpdate(scheduleId, {
            title: meta.title,
            prompt: request.prompt,
            timing: request.timing,
            target: request.target,
            active: routine.enabled,
          })
          if (ok) {
            status = routine.enabled
              ? previous && previous.enabled === false
                ? 'resumed'
                : 'updated'
              : 'paused'
            impacted.push(key)
          } else {
            status = 'error'
            errors.push(`${key}: schedule.update 失败`)
          }
        }
      }
      nextMapping[key] = {
        scheduleId,
        signature,
        enabled: routine.enabled,
        time: routine.time,
        targetKind: meta.targetKind,
        updatedAt: at,
        lastStatus: status,
      }
      schedules.push({
        key,
        title: meta.title,
        scheduleId,
        status,
        enabled: routine.enabled,
        time: routine.time,
        nextRun: scheduleNextRun(view),
      })
    }

    // 清理：同 title 重复项 / LifeOS 前缀的残留 routine（截止提醒 schedule 除外）
    for (const entry of catalog) {
      const entryId = normalizeScheduleId(entry)
      const title = String(entry?.title || entry?.record?.title || '')
      if (!entryId || usedIds.has(entryId) || reminderIds.has(entryId)) continue
      if (title.startsWith(REMINDER_TITLE_PREFIX)) continue
      const isDuplicate = expectedTitles.has(title)
      const isResidual = title.startsWith(SCHEDULE_TITLE_PREFIX)
      if (!isDuplicate && !isResidual) continue
      const ok = await scheduleRemove(entryId)
      if (ok) {
        impacted.push(isDuplicate ? 'duplicate' : 'residual')
        errors.push(...[])
      }
    }

    const changed = JSON.stringify(nextMapping) !== JSON.stringify(mapping.routines)
    const mappingValue = {
      routines: nextMapping,
      lastReconciledAt: at,
      timeZone,
      promptVersion: ROUTINE_PROMPT_VERSION,
    }
    if (changed || !mapping.raw) {
      try {
        await writeInternalSetting(SCHEDULES_KEY, mappingValue)
      } catch (error) {
        errors.push(`保存 schedule 映射失败：${error?.message ?? error}`)
      }
    }
    // 兼容 M2 scheduler：始终同步 legacy 设置里的 scheduleId/enabled/time
    {
      const legacyNext = {
        ...(isPlainObject(legacy) ? legacy : {}),
        enabled: settings.nightlyInbox.enabled,
        time: settings.nightlyInbox.time,
        timeZone,
        scheduleId: nextMapping.nightlyInbox?.scheduleId ?? legacy?.scheduleId ?? null,
        lastReconciledAt: at,
      }
      try {
        await writeInternalSetting(LEGACY_NIGHTLY_KEY, legacyNext)
      } catch {
        /* legacy 兼容写失败不影响主流程 */
      }
    }

    const result = {
      status: errors.length > 0 ? 'partial' : 'ok',
      schedules,
      impacted: dedupeArray(impacted),
      errors,
      at,
    }
    state.lastReconcile = result
    if (errors.length > 0) state.lastError = errors[0]
    emitChanged?.('automation', [], { impacted: result.impacted })
    return result
  }

  async function getStatus() {
    const { settings, revision, migrated } = effectiveSettings()
    const mapping = readScheduleMapping()
    const at = toMs(now())
    const date = localDate(timeZone, new Date(at))
    const budget = budgetState(getSetting(budgetKey(date)))
    const routines = routineSettingsView(settings).map((routine) => {
      const saved = mapping.routines[routine.key]
      return {
        ...routine,
        scheduleId: saved?.scheduleId ?? null,
        lastStatus: saved?.lastStatus ?? (state.lastReconcile ? 'unknown' : 'unknown'),
        nextRun:
          saved?.scheduleId && saved?.lastStatus === 'ok'
            ? nextRoutineAt(routine.time, at, timeZone)
            : null,
      }
    })
    return {
      settings,
      revision,
      migrated,
      routines,
      dnd: dndView(settings, at, timeZone),
      budget: {
        date,
        used: budget.date === date ? budget.used : 0,
        limit: settings.dailyBudget,
        byKind: budget.date === date ? budget.byKind : {},
      },
      scheduleUnavailable: state.scheduleUnavailable,
      lastReconcileAt: state.lastReconcileAt,
      lastReconcile: state.lastReconcile,
      lastReminderReconcileAt: state.lastReminderReconcileAt,
      lastReminderReconcile: state.lastReminderReconcile,
      lastError: state.lastError,
    }
  }

  /* ── 设置读写 ─────────────────────────────────────────── */

  function getSettings() {
    const { settings, raw, legacy, migrated, revision } = effectiveSettings()
    const check = validateAutomationSettings(settings)
    return {
      settings,
      revision,
      migrated,
      valid: check.ok,
      errors: check.errors,
      legacy,
      routines: routineSettingsView(settings),
      dnd: dndView(settings, toMs(now()), timeZone),
      scheduleMapping: readScheduleMapping().routines,
      scheduleUnavailable: state.scheduleUnavailable,
      lastReconcileAt: state.lastReconcileAt,
      raw,
    }
  }

  async function patchSettings(patch, options = {}) {
    const source = typeof options.source === 'string' ? options.source : 'user'
    if (!isPlainObject(patch)) {
      throw new LifeosError('validation_failed', '设置 patch 必须是对象', { errors: ['patch 必须是对象'] })
    }
    const shapeErrors = validateAutomationPatchShape(patch)
    const currentState = effectiveSettings()
    const before = currentState.settings
    const after = mergeAutomationSettings(before, patch)
    const check = validateAutomationSettings(after)
    if (shapeErrors.length > 0 || !check.ok) {
      throw new LifeosError('validation_failed', '自动化设置不合法', {
        errors: [...new Set([...shapeErrors, ...check.errors])],
        dnd: after.dnd,
      })
    }
    const diff = diffAutomationSettings(before, after)
    const revision = currentState.revision + 1
    const value = { ...after, revision }
    const at = iso(now())
    const legacyBefore = readLegacyNightly()
    const legacyNext = {
      ...(isPlainObject(legacyBefore) ? legacyBefore : {}),
      enabled: value.nightlyInbox.enabled,
      time: value.nightlyInbox.time,
      timeZone,
      scheduleId: isPlainObject(legacyBefore) ? legacyBefore.scheduleId ?? null : null,
      lastReconciledAt: isPlainObject(legacyBefore) ? legacyBefore.lastReconciledAt ?? null : null,
      lastRunAt: isPlainObject(legacyBefore) ? legacyBefore.lastRunAt ?? null : null,
      updatedAt: at,
    }
    const actorType = source === 'agent' ? 'agent' : 'user'
    const oplog = {
      id: newId('opl'),
      actor_type: actorType,
      actor_ref: actorSessionId,
      action: 'settings.update',
      target_type: 'app_setting',
      target_id: AUTOMATION_SETTING_KEY,
      decision: 'allowed',
      permission_level: source === 'agent' ? 'L3' : 'L2',
      status: 'applied',
      before_json: before,
      after_json: value,
      diff_json: diff,
      reversible: true,
      reason: typeof options.reason === 'string' ? options.reason : null,
      occurred_at: at,
      meta_json: { source, impacted: diff.impacted, revision },
    }
    try {
      await store.transaction([
        { unit: CORE, table: 'app_setting', key: AUTOMATION_SETTING_KEY, value: appSettingRecord(AUTOMATION_SETTING_KEY, value) },
        { unit: CORE, table: 'app_setting', key: LEGACY_NIGHTLY_KEY, value: appSettingRecord(LEGACY_NIGHTLY_KEY, legacyNext) },
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
    } catch (error) {
      if (error instanceof LifeosError) throw error
      throw new LifeosError('internal', `保存自动化设置失败：${error?.message ?? error}`)
    }
    let reconcile = null
    try {
      reconcile = await reconcileSchedules()
    } catch (error) {
      state.lastError = `reconcile 失败：${error?.message ?? error}`
      logger?.warn?.({ event: 'automation.reconcile_failed', error: state.lastError })
    }
    let reminderReconcile = null
    const affected = new Set(diff.impacted)
    if (affected.has('deadlineReminder') || affected.has('dnd')) {
      try {
        reminderReconcile = await reconcileReminders()
      } catch (error) {
        state.lastError = `reminder reconcile 失败：${error?.message ?? error}`
        logger?.warn?.({ event: 'automation.reminder_reconcile_failed', error: state.lastError })
      }
    }
    emitChanged?.('automation', [], { revision, impacted: diff.impacted })
    return {
      settings: value,
      revision,
      diff,
      impacted: diff.impacted,
      reconcile,
      reminderReconcile,
      legacy: legacyNext,
    }
  }

  /* ── 截止提醒 ─────────────────────────────────────────── */

  function buildReminderPrompt(task, remindAt) {
    const title = truncate(task?.title ?? '任务', 80)
    return [
      `[LifeOS 截止提醒] 任务：${title}（id=${task?.id ?? ''}）。`,
      `截止：${task?.due_at || task?.due_date || '未知'}；提醒时间：${remindAt}（时区 ${timeZone}）。`,
      '用一句话提醒用户，给出「完成 / 改期」两个可回复选项；不要修改任务，不要编造。',
    ].join('\n')
  }

  async function persistReminderMapping(taskId, entry) {
    const raw = readLegacyReminderMapping()
    const mapping = isPlainObject(raw?.items) ? { ...raw.items } : {}
    if (entry === null) delete mapping[taskId]
    else mapping[taskId] = entry
    const value = { items: mapping, updatedAt: iso(now()) }
    await writeInternalSetting(REMINDERS_KEY, value)
    return mapping
  }

  function readReminderMapping() {
    const raw = readLegacyReminderMapping()
    if (isPlainObject(raw) && isPlainObject(raw.items)) return { ...raw.items }
    return {}
  }

  async function removeTaskReminder(taskId, mapping) {
    const entry = mapping[taskId]
    if (!entry) return { status: 'unchanged' }
    await scheduleRemove(entry.scheduleId)
    await persistReminderMapping(taskId, null)
    return { status: 'removed', scheduleId: entry.scheduleId }
  }

  /**
   * 同步单个任务的截止提醒（幂等；软失败由调用方决定是否抛出）。
   * @param {object|string} taskOrId 任务记录或 id
   * @returns {Promise<{status:string, scheduleId?:string|null, remindAt?:string|null, reason?:string}>}
   */
  async function syncTaskReminder(taskOrId) {
    const settings = settingsOrThrow()
    let task = null
    if (typeof taskOrId === 'string') {
      try {
        task = store.get(CORE, 'task', taskOrId)
      } catch {
        task = null
      }
    } else if (isPlainObject(taskOrId)) {
      task = taskOrId
    }
    const taskId = task?.id ?? (typeof taskOrId === 'string' ? taskOrId : null)
    const mapping = readReminderMapping()
    if (!taskId) return { status: 'invalid' }
    const adapterMissing = !adapter()
    const desired = deadlineRemindAt(task, settings, { timeZone })
    const existing = mapping[taskId] ?? null
    const disabled = !settings.deadlineReminder.enabled
    if (desired === null || disabled) {
      if (existing) {
        await scheduleRemove(existing.scheduleId)
        await persistReminderMapping(taskId, null)
        return { status: 'removed', scheduleId: existing.scheduleId, reason: disabled ? 'disabled' : 'no_due' }
      }
      return { status: 'none', reason: disabled ? 'disabled' : 'no_due' }
    }
    if (adapterMissing) {
      state.lastError = 'schedule 服务不可用，无法创建截止提醒'
      return { status: 'unavailable', remindAt: desired }
    }
    if (Date.parse(desired) <= toMs(now())) {
      if (existing) {
        await scheduleRemove(existing.scheduleId)
        await persistReminderMapping(taskId, null)
      }
      return { status: 'skipped_past', remindAt: desired }
    }
    if (isReminderInDnd(desired, settings, timeZone)) {
      if (existing) {
        await scheduleRemove(existing.scheduleId)
        await persistReminderMapping(taskId, null)
      }
      let notification = null
      try {
        notification = await recordNotification({
          type: 'deadline_reminder',
          title: '截止提醒已跳过（免打扰）',
          body: truncate(`「${task?.title ?? '任务'}」的提醒落在免打扰时段，未推送。`, 150),
          status: 'expired',
          meta: { status: 'skipped_dnd', taskId, remindAt: desired, dnd: settings.dnd },
          metaStatus: 'skipped_dnd',
        })
      } catch (error) {
        logger?.warn?.({ event: 'automation.skipped_dnd_outbox_failed', error: String(error?.message ?? error) })
      }
      return { status: 'skipped_dnd', remindAt: desired, notification: notification?.notification ?? null }
    }

    const title = truncate(`LifeOS · 截止提醒 · ${task?.title ?? '任务'}`, 80)
    const prompt = buildReminderPrompt(task, desired)
    const request = {
      title,
      prompt,
      // 宿主 ScheduleTiming 对 at 只接受 { kind, at }，多余的 time_zone 会被拒绝（invalid_rule）。
      timing: { kind: 'at', at: desired },
      target: { kind: 'new_once', create: { agentPreset: 'lifeos' } },
    }
    const signature = JSON.stringify({
      version: 'm3.reminder.v1',
      taskId,
      title,
      remindAt: desired,
    })
    if (existing && existing.signature === signature) {
      const view = await scheduleView(existing.scheduleId)
      if (view && scheduleStatusOf(view) !== 'missing') {
        return { status: 'unchanged', scheduleId: existing.scheduleId, remindAt: desired }
      }
    }
    let scheduleId = existing?.scheduleId ?? null
    let status = 'unchanged'
    if (!scheduleId) {
      try {
        scheduleId = await scheduleCreate(request)
        status = 'created'
      } catch (error) {
        state.lastError = `创建截止提醒失败：${error?.message ?? error}`
        return { status: 'error', remindAt: desired, reason: state.lastError }
      }
    } else {
      const view = await scheduleView(scheduleId)
      const ok = view
        ? await scheduleUpdate(scheduleId, {
            title,
            prompt,
            timing: request.timing,
            target: request.target,
            active: true,
          })
        : false
      if (!ok) {
        // 原 schedule 已失效：重建
        scheduleId = null
        try {
          scheduleId = await scheduleCreate(request)
          status = 'created'
        } catch (error) {
          state.lastError = `重建截止提醒失败：${error?.message ?? error}`
          return { status: 'error', remindAt: desired, reason: state.lastError }
        }
      } else {
        status = 'updated'
      }
    }
    await persistReminderMapping(taskId, {
      scheduleId,
      remindAt: desired,
      title,
      signature,
      updatedAt: iso(now()),
    })
    return { status, scheduleId, remindAt: desired }
  }

  /** 批量对账：未来 7 天有 due 的未完成任务 + 清理已关闭/孤儿映射。 */
  async function reconcileReminders() {
    const settings = settingsOrThrow()
    const at = toMs(now())
    const today = localDate(timeZone, new Date(at))
    const lastDay = addDays(today, REMINDER_WINDOW_DAYS)
    const result = { scanned: 0, created: 0, updated: 0, removed: 0, skipped: 0, unchanged: 0, errors: [] }
    let tasks = []
    try {
      tasks = store.entries(CORE, 'task').map(([, task]) => task)
    } catch (error) {
      result.errors.push(`读取任务失败：${error?.message ?? error}`)
      return result
    }
    const taskById = new Map(tasks.map((task) => [task.id, task]))
    const mapping = readReminderMapping()
    for (const task of tasks) {
      if (!task || task.deleted_at) continue
      if (!OPEN_TASK_STATUSES.includes(task.status) || task.archived_at) continue
      const dueInWindow =
        (typeof task.due_at === 'string' &&
          Number.isFinite(Date.parse(task.due_at)) &&
          Date.parse(task.due_at) >= at &&
          Date.parse(task.due_at) <= at + REMINDER_WINDOW_DAYS * 86400000) ||
        (typeof task.due_date === 'string' && task.due_date >= today && task.due_date <= lastDay)
      const hasDue = typeof task.due_at === 'string' || typeof task.due_date === 'string'
      if (!dueInWindow && !mapping[task.id]) continue
      result.scanned += 1
      try {
        const synced = await syncTaskReminder(task)
        if (synced.status === 'created') result.created += 1
        else if (synced.status === 'updated') result.updated += 1
        else if (synced.status === 'removed') result.removed += 1
        else if (synced.status === 'unchanged') result.unchanged += 1
        else if (synced.status === 'skipped_dnd' || synced.status === 'skipped_past' || synced.status === 'none') {
          result.skipped += 1
        } else if (synced.status === 'error' || synced.status === 'unavailable') {
          result.errors.push(`${task.id}: ${synced.reason ?? synced.status}`)
        }
      } catch (error) {
        result.errors.push(`${task.id}: ${error?.message ?? error}`)
      }
      void hasDue
    }
    // 清理已删除/关闭任务的残留映射
    for (const [taskId, entry] of Object.entries(mapping)) {
      const task = taskById.get(taskId)
      if (!task || task.deleted_at || !OPEN_TASK_STATUSES.includes(task.status) || task.archived_at) {
        try {
          await scheduleRemove(entry.scheduleId)
          await persistReminderMapping(taskId, null)
          result.removed += 1
        } catch (error) {
          result.errors.push(`清理 ${taskId}: ${error?.message ?? error}`)
        }
      }
    }
    state.lastReminderReconcileAt = iso(now())
    state.lastReminderReconcile = result
    return result
  }

  /* ── 手动运行（验收/设置页「立即运行」）：立即触发一次 routine ── */

  function summarizeRunResult(result) {
    if (!isPlainObject(result)) return { value: result === undefined ? null : String(result) };
    const lastDelivery =
      isPlainObject(result.lastDelivery)
        ? result.lastDelivery
        : Array.isArray(result.deliveryHistory) && result.deliveryHistory.length > 0
          ? result.deliveryHistory[result.deliveryHistory.length - 1]
          : null;
    return {
      id: result.id ?? null,
      code: typeof result.code === 'string' ? result.code : null,
      status: result.status ?? null,
      kind: result.kind ?? null,
      nextRun: result.nextRun ?? result.next_at ?? result.nextAt ?? null,
      lastDelivery: isPlainObject(lastDelivery)
        ? {
            at: lastDelivery.at ?? lastDelivery.deliveredAt ?? lastDelivery.delivered_at ?? null,
            sessionId: lastDelivery.sessionId ?? lastDelivery.session_id ?? null,
            outcome: lastDelivery.outcome ?? lastDelivery.status ?? null,
          }
        : null,
    };
  }

  function deliverySessionId(result, summary) {
    if (summary && summary.lastDelivery && typeof summary.lastDelivery.sessionId === 'string') {
      return summary.lastDelivery.sessionId;
    }
    if (isPlainObject(result)) {
      if (typeof result.sessionId === 'string') return result.sessionId;
      if (isPlainObject(result.target) && typeof result.target.sessionId === 'string') return result.target.sessionId;
    }
    return null;
  }

  /** 立即运行一次 routine（宿主 schedule.run）；用于验收与「测试运行」。 */
  async function runRoutine(key) {
    if (!ROUTINE_KEYS.includes(key)) return { status: 'invalid', key };
    const mapping = readScheduleMapping();
    const entry = isPlainObject(mapping.routines[key]) ? mapping.routines[key] : null;
    if (!entry || !entry.scheduleId) return { status: 'not_scheduled', key };
    const schedule = adapter();
    if (!schedule || typeof schedule.run !== 'function') return { status: 'unavailable', key };
    const at = iso(now());
    try {
      const result = await schedule.run({ id: entry.scheduleId });
      const summary = summarizeRunResult(result);
      const code = summary.code;
      const nextMapping = {
        ...mapping.routines,
        [key]: { ...entry, lastRunAt: at, lastRunStatus: code || 'delivered' },
      };
      try {
        await writeInternalSetting(SCHEDULES_KEY, {
          routines: nextMapping,
          lastReconciledAt: mapping.raw?.lastReconciledAt ?? at,
          timeZone,
          promptVersion: ROUTINE_PROMPT_VERSION,
        });
      } catch (error) {
        state.lastError = `保存运行记录失败：${error?.message ?? error}`;
      }
      return {
        status: code ? (code === 'schedule_execution_pending' ? 'pending' : code) : 'delivered',
        key,
        scheduleId: entry.scheduleId,
        ranAt: at,
        sessionId: deliverySessionId(result, summary),
        delivery: summary,
      };
    } catch (error) {
      state.lastError = `立即运行 ${key} 失败：${error?.message ?? error}`;
      diagnostics?.recordError?.('automation_run_failed', state.lastError);
      return { status: 'error', key, scheduleId: entry.scheduleId, reason: String(error?.message ?? error) };
    }
  }

  /* ── 通知 / 预算 / dnd ─────────────────────────────────── */

  async function recordNotification(input = {}) {
    const rawKind = typeof input.kind === 'string' ? input.kind : typeof input.type === 'string' ? input.type : 'system'
    const kind = OUTBOX_KINDS.includes(rawKind) ? rawKind : 'system'
    const requestedStatus = typeof input.status === 'string' ? input.status : 'pending'
    const status = OUTBOX_STATUSES.includes(requestedStatus) ? requestedStatus : 'expired'
    const title = truncate(input.title ?? '', 60)
    const body = truncate(input.body ?? '', 150)
    if (!title) throw new LifeosError('validation_failed', 'notification.title 必填')
    if (!body) throw new LifeosError('validation_failed', 'notification.body 必填')
    const at = iso(now())
    const id = newId('notif')
    const priority = PRIORITIES.includes(input.priority) ? input.priority : 'P2'
    const channel = ['in_app', 'desktop_notify', 'badge'].includes(input.channel) ? input.channel : 'in_app'
    const expiresAt =
      typeof input.expiresAt === 'string' && Number.isFinite(Date.parse(input.expiresAt))
        ? input.expiresAt
        : iso(new Date(toMs(now()) + 24 * 3600 * 1000))
    const meta = isPlainObject(input.meta) ? input.meta : {}
    const record = {
      id,
      kind,
      title,
      body,
      action_json: Array.isArray(input.actionJson) ? input.actionJson : [],
      priority,
      dedupe_key: typeof input.dedupeKey === 'string' && input.dedupeKey.length > 0 ? input.dedupeKey : `${kind}:${id}`,
      status,
      channel,
      source_type: typeof input.sourceType === 'string' ? input.sourceType : meta.taskId ? 'task' : null,
      source_id: typeof input.sourceId === 'string' ? input.sourceId : meta.taskId ?? null,
      attempt_count: 0,
      expires_at: expiresAt,
      created_at: at,
      updated_at: at,
      meta_json: {
        ...meta,
        requested_status: requestedStatus,
        ...(input.metaStatus ? { status: input.metaStatus } : {}),
        type: rawKind,
      },
      schema_version: 1,
    }
    try {
      await store.transaction([{ unit: CORE, table: 'notification_outbox', key: id, value: record }])
    } catch (error) {
      throw error instanceof LifeosError ? error : new LifeosError('internal', `写通知失败：${error?.message ?? error}`)
    }
    emitChanged?.('notification', [id])
    return { notification: record }
  }

  function listNotifications(input = {}) {
    const limit = Math.max(1, Math.min(50, Number(input.limit) || 20))
    const statusFilter = typeof input.status === 'string' ? input.status : null
    let rows = []
    try {
      rows = store.entries(CORE, 'notification_outbox').map(([, record]) => record)
    } catch {
      rows = []
    }
    rows = rows.filter((record) => record && !record.deleted_at)
    if (statusFilter) rows = rows.filter((record) => record.status === statusFilter)
    rows.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    return { items: rows.slice(0, limit) }
  }

  async function markNotificationRead(id) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new LifeosError('validation_failed', 'notification id 必填')
    }
    const record = store.get(CORE, 'notification_outbox', id)
    if (!record) throw new LifeosError('not_found', '通知不存在', { id })
    const at = iso(now())
    const next = { ...record, status: 'delivered', delivered_at: record.delivered_at ?? at, read_at: at, updated_at: at }
    await store.transaction([{ unit: CORE, table: 'notification_outbox', key: id, value: next }])
    return { notification: next }
  }

  /** 每日预算：超限返回 {ok:false}；成功累加并返回计数。 */
  async function consumeDailyBudget(kind = 'proactive', count = 1) {
    const settings = settingsOrThrow()
    const amount = Math.max(1, Math.trunc(Number(count) || 1))
    const date = localDate(timeZone, new Date(toMs(now())))
    const key = budgetKey(date)
    const stored = budgetState(getSetting(key))
    const current = stored.date === date ? stored : { date, used: 0, byKind: {} }
    if (!canConsumeBudget(current, settings.dailyBudget, amount)) {
      return { ok: false, date, used: current.used, limit: settings.dailyBudget, kind, byKind: current.byKind }
    }
    const next = {
      date,
      used: current.used + amount,
      byKind: { ...current.byKind, [kind]: (current.byKind[kind] ?? 0) + amount },
    }
    await writeInternalSetting(key, next)
    return { ok: true, date, ...next, limit: settings.dailyBudget, kind }
  }

  function isDnd(nowArg) {
    const settings = settingsOrThrow()
    return isDndAt(nowArg ?? now(), timeZone, settings.dnd)
  }

  /* ── 导出 ─────────────────────────────────────────────── */

  return {
    getSettings,
    patchSettings,
    reconcileSchedules,
    getStatus,
    syncTaskReminder,
    reconcileReminders,
    runRoutine,
    recordNotification,
    listNotifications,
    markNotificationRead,
    consumeDailyBudget,
    isDnd,
    // 供测试/诊断
    _internals: {
      effectiveSettings,
      readScheduleMapping,
      readReminderMapping,
      scheduleList,
      localHm: (value) => localHm(value, timeZone),
    },
  }
}
