import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_AUTOMATION_SETTINGS,
  LEGACY_NIGHTLY_KEY,
  ROUTINE_KEYS,
  ROUTINE_META,
  budgetKey,
  budgetState,
  buildRoutinePrompt,
  canConsumeBudget,
  deadlineRemindAt,
  diffAutomationSettings,
  isDndAt,
  isReminderInDnd,
  isTimeInDnd,
  localHm,
  migrateAutomationSettings,
  mergeAutomationSettings,
  nextRoutineAt,
  normalizeAutomationSettings,
  parseHm,
  routineCron,
  routineSignature,
  routineTarget,
  validateAutomationPatchShape,
  validateAutomationSettings,
} from '../../../src/domain/automation-rules.js'

const TZ = 'Asia/Shanghai'
const NOW = Date.parse('2026-11-14T05:00:00.000Z') // 北京时间 13:00

test('默认设置：通过校验、用户默认值正确', () => {
  const check = validateAutomationSettings(normalizeAutomationSettings({}))
  assert.equal(check.ok, true, JSON.stringify(check.errors))
  const settings = normalizeAutomationSettings({})
  assert.deepEqual(settings.morningBrief, { enabled: true, time: '07:35' })
  assert.deepEqual(settings.eveningReview, { enabled: false, time: '21:00' })
  assert.deepEqual(settings.habitNudge, { enabled: false, time: '20:30' })
  assert.deepEqual(settings.nightlyInbox, { enabled: true, time: '21:30' })
  assert.deepEqual(settings.deadlineReminder, { enabled: true, leadMinutes: 60, dueDateAt: '09:00' })
  assert.deepEqual(settings.dnd, { start: '22:45', end: '07:30' })
  assert.equal(settings.dailyBudget, 2)
  assert.equal(settings.suggestions.maxPerDay, 2)
  assert.deepEqual([...ROUTINE_KEYS], ['morningBrief', 'eveningReview', 'habitNudge', 'nightlyInbox'])
  assert.equal(LEGACY_NIGHTLY_KEY, 'automation.inbox_nightly')
})

test('parseHm / localHm / dnd 跨日边界', () => {
  assert.deepEqual(parseHm('07:35'), { hour: 7, minute: 35, minutes: 455, value: '07:35' })
  assert.equal(parseHm('24:00'), null)
  assert.equal(parseHm('7:5'), null)
  assert.equal(localHm(new Date('2026-11-13T15:30:00.000Z'), TZ), '23:30')
  const dnd = { start: '22:45', end: '07:30' }
  assert.equal(isTimeInDnd('22:44', dnd), false)
  assert.equal(isTimeInDnd('22:45', dnd), true)
  assert.equal(isTimeInDnd('23:59', dnd), true)
  assert.equal(isTimeInDnd('00:00', dnd), true)
  assert.equal(isTimeInDnd('07:29', dnd), true)
  assert.equal(isTimeInDnd('07:30', dnd), false)
  assert.equal(isTimeInDnd('12:00', dnd), false)
  // 空窗口（start===end）= 不启用 dnd
  assert.equal(isTimeInDnd('12:00', { start: '12:00', end: '12:00' }), false)
  // 非跨日窗口
  assert.equal(isTimeInDnd('12:00', { start: '09:00', end: '18:00' }), true)
  assert.equal(isTimeInDnd('08:00', { start: '09:00', end: '18:00' }), false)
  assert.equal(isDndAt(new Date('2026-11-13T15:00:00.000Z'), TZ, dnd), true) // 23:00
  assert.equal(isDndAt(new Date('2026-11-13T23:30:00.000Z'), TZ, dnd), false) // 07:30
})

test('校验：非法时间/预算/提前量/dnd/routine 落在 dnd 内', () => {
  const bad = normalizeAutomationSettings({})
  bad.morningBrief.time = '25:00'
  assert.equal(validateAutomationSettings(bad).ok, false)

  const base = normalizeAutomationSettings({})
  assert.equal(validateAutomationSettings({ ...base, dailyBudget: 9 }).ok, false)
  assert.equal(validateAutomationSettings({ ...base, dailyBudget: -1 }).ok, false)
  const leadBad = mergeAutomationSettings(base, { deadlineReminder: { leadMinutes: 3 } })
  assert.equal(validateAutomationSettings(leadBad).ok, false)
  const leadOk = mergeAutomationSettings(base, { deadlineReminder: { leadMinutes: 1440 } })
  assert.equal(validateAutomationSettings(leadOk).ok, true)

  const dndBad = mergeAutomationSettings(base, { dnd: { start: '24:00' } })
  assert.equal(validateAutomationSettings(dndBad).ok, false)

  // routine 时间落在 dnd 内 → 422 错误
  const inDnd = mergeAutomationSettings(base, { eveningReview: { enabled: true, time: '23:30' } })
  const check = validateAutomationSettings(inDnd)
  assert.equal(check.ok, false)
  assert.ok(check.errors.some((error) => error.includes('免打扰')))

  // patch 未知键/未知字段
  const patchErrors = validateAutomationPatchShape({ unknownKey: 1, morningBrief: { nope: 1 } })
  assert.ok(patchErrors.some((error) => error.includes('未知设置项')))
  assert.ok(patchErrors.some((error) => error.includes('不支持的字段')))
  assert.deepEqual(validateAutomationPatchShape({ morningBrief: { enabled: false } }), [])
})

test('迁移：M2 automation.inbox_nightly → nightlyInbox', () => {
  const { settings, migrated } = migrateAutomationSettings(null, { enabled: false, time: '22:00' })
  assert.equal(migrated, true)
  assert.deepEqual(settings.nightlyInbox, { enabled: false, time: '22:00' })
  // 已有统一设置时不被 legacy 覆盖
  const unified = { nightlyInbox: { enabled: true, time: '21:40' }, dailyBudget: 3 }
  const result = migrateAutomationSettings(unified, { enabled: false, time: '22:00' })
  assert.equal(result.migrated, false)
  assert.deepEqual(result.settings.nightlyInbox, { enabled: true, time: '21:40' })
  assert.equal(result.settings.dailyBudget, 3)
})

test('merge / diff / impacted', () => {
  const before = normalizeAutomationSettings({})
  const after = mergeAutomationSettings(before, {
    morningBrief: { enabled: false },
    eveningReview: { enabled: true, time: '20:00' },
    dailyBudget: 3,
    dnd: { start: '23:00', end: '07:00' },
    deadlineReminder: { leadMinutes: 30 },
  })
  const diff = diffAutomationSettings(before, after)
  assert.ok(diff.impacted.includes('morningBrief'))
  assert.ok(diff.impacted.includes('eveningReview'))
  assert.ok(diff.impacted.includes('dailyBudget'))
  assert.ok(diff.impacted.includes('dnd'))
  assert.ok(diff.impacted.includes('deadlineReminder'))
  assert.ok(diff.changed.some((item) => item.path === 'morningBrief.enabled'))
  assert.ok(diff.changed.some((item) => item.path === 'deadlineReminder.leadMinutes' && item.to === 30))
  assert.deepEqual(diffAutomationSettings(after, after).changed, [])
  assert.deepEqual(diffAutomationSettings(after, after).impacted, [])
})

test('deadlineRemindAt：due_at - leadMinutes / due_date 当天 dueDateAt', () => {
  const settings = normalizeAutomationSettings({})
  assert.equal(
    deadlineRemindAt({ status: 'todo', due_at: '2026-11-14T06:00:00.000Z' }, settings, { timeZone: TZ }),
    '2026-11-14T05:00:00.000Z',
  )
  assert.equal(
    deadlineRemindAt({ status: 'todo', due_date: '2026-11-15' }, settings, { timeZone: TZ }),
    '2026-11-15T01:00:00.000Z',
  )
  assert.equal(deadlineRemindAt({ status: 'done', due_at: '2026-11-14T06:00:00.000Z' }, settings, { timeZone: TZ }), null)
  assert.equal(deadlineRemindAt({ status: 'cancelled', due_date: '2026-11-15' }, settings, { timeZone: TZ }), null)
  assert.equal(deadlineRemindAt({ status: 'todo' }, settings, { timeZone: TZ }), null)
  const disabled = mergeAutomationSettings(settings, { deadlineReminder: { enabled: false } })
  assert.equal(deadlineRemindAt({ status: 'todo', due_at: '2026-11-14T06:00:00.000Z' }, disabled), null)
})

test('isReminderInDnd / nextRoutineAt / routine 元数据与 prompt', () => {
  const settings = normalizeAutomationSettings({})
  assert.equal(isReminderInDnd('2026-11-13T15:30:00.000Z', settings, TZ), true) // 23:30
  assert.equal(isReminderInDnd('2026-11-14T02:00:00.000Z', settings, TZ), false) // 10:00
  // 22:45 边界
  assert.equal(isReminderInDnd('2026-11-13T14:45:00.000Z', settings, TZ), true)

  assert.equal(nextRoutineAt('07:35', NOW, TZ), '2026-11-14T23:35:00.000Z') // 11-14 07:35 已过 → 次日（本地 11-15 07:35）
  assert.equal(nextRoutineAt('23:00', NOW, TZ), '2026-11-14T15:00:00.000Z')

  assert.deepEqual(routineTarget('nightlyInbox'), { kind: 'new', create: { agentPreset: 'lifeos' } })
  assert.deepEqual(routineTarget('morningBrief'), { kind: 'new_once', create: { agentPreset: 'lifeos' } })
  assert.deepEqual(routineCron('07:35', TZ), { expression: '35 7 * * *', time_zone: TZ })
  for (const key of ROUTINE_KEYS) {
    const prompt = buildRoutinePrompt(key, { timeZone: TZ })
    assert.ok(prompt.includes('LifeOS'))
    assert.ok(prompt.includes(TZ))
    assert.ok(prompt.length > 40)
    assert.ok(ROUTINE_META[key].title.startsWith('LifeOS · '))
  }
  // 签名稳定：同设置相同签名；时间变化签名变化
  const a = routineSignature('morningBrief', settings, TZ)
  assert.equal(a, routineSignature('morningBrief', normalizeAutomationSettings({}), TZ))
  const changed = mergeAutomationSettings(settings, { morningBrief: { time: '08:00' } })
  assert.notEqual(a, routineSignature('morningBrief', changed, TZ))
})

test('预算辅助：budgetKey / budgetState / canConsumeBudget', () => {
  assert.equal(budgetKey('2026-11-14'), 'automation.budget.2026-11-14')
  assert.deepEqual(budgetState(null), { date: null, used: 0, byKind: {} })
  assert.deepEqual(budgetState({ date: '2026-11-14', used: 2, byKind: { brief: 2 } }), {
    date: '2026-11-14',
    used: 2,
    byKind: { brief: 2 },
  })
  assert.equal(canConsumeBudget({ used: 1 }, 2, 1), true)
  assert.equal(canConsumeBudget({ used: 2 }, 2, 1), false)
  assert.equal(canConsumeBudget({ used: 0 }, 0, 1), false)
})
