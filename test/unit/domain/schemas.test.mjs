import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BUSINESS_TABLES,
  JOURNAL_TABLE,
  TABLE_SPECS,
  UNIT,
  UNIT_NAMES,
  UNIT_TABLES,
  isKnownTable,
  normalizeRecord,
  tablesForUnit,
  unitOf,
  validateRecord,
} from '../../../src/domain/schemas.js'
import { newId } from '../../../src/domain/ids.js'
import { nowIso } from '../../../src/domain/time.js'

const EXPECTED_CORE = [
  'inbox_item',
  'extraction_run',
  'task',
  'checklist_item',
  'project',
  'goal',
  'wish',
  'habit',
  'habit_checkin',
  'event',
  'metric',
  'state',
  'tag',
  'entity_tag',
  'entity_link',
  'evidence_link',
  'list',
  'group',
  'habit_group',
  'reminder',
  'attachment',
  'personal_memory',
  'agent_inference',
  'assistant_suggestion',
  'notification_outbox',
  'permission',
  'app_setting',
]

test('TABLE_SPECS：30 业务表 + journal，unit 归属符合 design/08', () => {
  assert.equal(BUSINESS_TABLES.length, 30)
  assert.equal(Object.keys(TABLE_SPECS).length, 31)
  assert.equal(new Set(BUSINESS_TABLES).size, 30)
  assert.ok(!BUSINESS_TABLES.includes(JOURNAL_TABLE))
  assert.equal(UNIT_TABLES[UNIT.RAW].length, 1)
  assert.deepEqual(UNIT_TABLES[UNIT.RAW], ['raw_record'])
  assert.equal(UNIT_TABLES[UNIT.CORE].length, 27)
  assert.deepEqual(UNIT_TABLES[UNIT.LOG], ['state_change', 'operation_log', 'journal'])
  assert.deepEqual([...UNIT_TABLES[UNIT.CORE]].sort(), [...EXPECTED_CORE].sort())
  assert.deepEqual(tablesForUnit(UNIT.CORE).length, 27)
  assert.deepEqual(tablesForUnit('nope'), [])
})

test('unitOf / isKnownTable / 表规格结构完整性', () => {
  assert.equal(unitOf('raw_record'), 'lifeos_raw')
  assert.equal(unitOf('task'), 'lifeos')
  assert.equal(unitOf('operation_log'), 'lifeos_log')
  assert.equal(unitOf('journal'), 'lifeos_log')
  assert.equal(unitOf('nope'), null)
  assert.equal(isKnownTable('task'), true)
  assert.equal(isKnownTable('nope'), false)
  for (const unit of UNIT_NAMES) {
    for (const table of UNIT_TABLES[unit]) {
      const spec = TABLE_SPECS[table]
      assert.equal(spec.name, table)
      assert.equal(spec.unit, unit)
      assert.ok(Array.isArray(spec.required))
      assert.equal(typeof spec.enums, 'object')
      assert.equal(typeof spec.defaults, 'object')
      assert.ok(Array.isArray(spec.timestamps))
      assert.ok(Array.isArray(spec.localDates))
      assert.equal(typeof spec.validate, 'function')
      assert.deepEqual(spec.validate({}), spec.validate({})) // 纯函数，稳定
    }
  }
})

test('ID 前缀唯一且与 design/08 对齐（抽样）', () => {
  const prefixMap = {}
  for (const table of BUSINESS_TABLES) {
    const spec = TABLE_SPECS[table]
    if (table === 'app_setting') continue
    assert.match(spec.prefix, /^[a-z]+$/, `${table} 缺 prefix`)
    assert.equal(prefixMap[spec.prefix], undefined, `prefix 重复：${spec.prefix}`)
    prefixMap[spec.prefix] = table
  }
  assert.equal(prefixMap.rr, 'raw_record')
  assert.equal(prefixMap.inb, 'inbox_item')
  assert.equal(prefixMap.xrun, 'extraction_run')
  assert.equal(prefixMap.tsk, 'task')
  assert.equal(prefixMap.sug, 'assistant_suggestion')
  assert.equal(prefixMap.notif, 'notification_outbox')
  assert.equal(TABLE_SPECS.journal.prefix, 'jrn')
})

test('validateRecord：raw_record 合法/非法', () => {
  const id = newId('rr')
  const base = { id, raw_text: '今天做了 30 分钟力量训练', user_local_date: '2026-11-12', tz: 'Asia/Shanghai' }
  assert.deepEqual(validateRecord('raw_record', base), { ok: true, errors: [] })
  assert.equal(validateRecord('raw_record', { ...base, raw_text: '' }).ok, false)
  assert.equal(validateRecord('raw_record', { ...base, raw_text: undefined }).ok, false)
  assert.equal(validateRecord('raw_record', { ...base, kind: 'diary' }).ok, false)
  assert.equal(validateRecord('raw_record', { ...base, user_local_date: '2026-02-30' }).ok, false)
  assert.equal(validateRecord('raw_record', { ...base, tz: '' }).ok, false)
  assert.equal(validateRecord('raw_record', { ...base, id: newId('inb') }).ok, false, '前缀不匹配应失败')
  assert.equal(validateRecord('raw_record', null).ok, false)
  assert.equal(validateRecord('nope', base).ok, false)
  assert.equal(validateRecord('raw_record', { ...base, processed_at: '2026-11-12T12:00:00Z' }).ok, false)
})

test('validateRecord：task 最小记录与枚举/时间格式', () => {
  const id = newId('tsk')
  const base = { id, title: '发实验结果', status: 'todo' }
  assert.equal(validateRecord('task', base).ok, true)
  assert.equal(validateRecord('task', { ...base, status: 'pending' }).ok, false)
  assert.equal(validateRecord('task', { ...base, priority: 'urgent' }).ok, false)
  assert.equal(validateRecord('task', { ...base, time_kind: 'bad' }).ok, false)
  assert.equal(validateRecord('task', { ...base, due_at: '2026-11-12' }).ok, false)
  assert.equal(validateRecord('task', { ...base, due_date: '2026-13-01' }).ok, false)
  assert.equal(validateRecord('task', { ...base, is_all_day: 'yes' }).ok, false)
  assert.equal(validateRecord('task', { ...base, completed_at: nowIso() }).ok, true)
})

test('validateRecord：app_setting 使用 key 模式（无 ULID 前缀）', () => {
  assert.equal(validateRecord('app_setting', { key: 'timezone', value_json: 'Asia/Shanghai' }).ok, true)
  assert.equal(validateRecord('app_setting', { value_json: 1 }).ok, false)
  assert.equal(validateRecord('app_setting', { key: '', value_json: 1 }).ok, false)
})

test('validateRecord：journal 的 ops 结构（跨 unit/表归属/空 ops/写 journal）', () => {
  const rawId = newId('rr')
  const raw = { id: rawId, raw_text: 'x', user_local_date: '2026-11-12', tz: 'Asia/Shanghai' }
  const mk = (ops) => ({ id: newId('jrn'), status: 'pending', ops, createdAt: nowIso() })
  const goodOp = { unit: 'lifeos_raw', table: 'raw_record', key: rawId, value: raw }
  assert.equal(validateRecord('journal', mk([goodOp])).ok, true)
  assert.equal(validateRecord('journal', mk([])).ok, false, '空事务应失败')
  assert.equal(validateRecord('journal', mk([{ ...goodOp, unit: 'lifeos' }])).ok, false, 'unit 不匹配应失败')
  assert.equal(validateRecord('journal', mk([{ ...goodOp, table: 'nope' }])).ok, false)
  assert.equal(validateRecord('journal', mk([{ ...goodOp, table: 'journal' }])).ok, false)
  assert.equal(validateRecord('journal', mk([{ ...goodOp, key: '' }])).ok, false)
  assert.equal(validateRecord('journal', mk([{ ...goodOp, value: 'x' }])).ok, false)
  const deleteOp = { unit: 'lifeos_raw', table: 'raw_record', key: rawId, value: null }
  assert.equal(validateRecord('journal', mk([deleteOp])).ok, true, 'null=删除应合法')
  assert.equal(validateRecord('journal', { ...mk([goodOp]), status: 'running' }).ok, false)
})

test('normalizeRecord：补默认值/注入通用列/不修改入参', () => {
  const id = newId('inb')
  const input = { id, title: '调研 Agent Memory' }
  const frozen = JSON.stringify(input)
  const out = normalizeRecord('inbox_item', input, { key: id, now: '2026-11-12T12:00:00.000Z' })
  assert.equal(JSON.stringify(input), frozen, '不得修改入参')
  assert.equal(out.status, 'captured')
  assert.equal(out.suggested_kind, 'none')
  assert.equal(out.priority, 'none')
  assert.equal(out.created_at, '2026-11-12T12:00:00.000Z')
  assert.equal(out.updated_at, '2026-11-12T12:00:00.000Z')
  assert.equal(out.rev, 1)
  assert.equal(out.schema_version, 1)
  assert.equal(validateRecord('inbox_item', out).ok, true)

  const raw = normalizeRecord(
    'raw_record',
    { raw_text: 'x', user_local_date: '2026-11-12', tz: 'Asia/Shanghai' },
    { key: newId('rr') },
  )
  assert.equal(raw.kind, 'note')
  assert.equal(raw.processing_status, 'pending')
  assert.ok(raw.created_at)
  assert.equal(validateRecord('raw_record', raw).ok, true)
})

test('normalizeRecord：app_setting key 模式与未知表抛错', () => {
  const out = normalizeRecord('app_setting', { value_json: 'Asia/Shanghai' }, { key: 'timezone' })
  assert.equal(out.key, 'timezone')
  assert.ok(out.updated_at)
  assert.equal(validateRecord('app_setting', out).ok, true)
  assert.throws(() => normalizeRecord('nope', {}), TypeError)
})


// ---------------------------------------------------------------------------
// M2：evidence_link 类型白名单扩展（Lead 2026-11-13 拍板）
// 支持"原始记录 → 派生对象"证据链：from/to 双向可写，relation 支持 derived_from/evidence_of
// ---------------------------------------------------------------------------

function evidenceLink(overrides = {}) {
  return {
    id: newId('evl'),
    from_type: 'event',
    from_id: newId('evt'),
    to_type: 'raw_record',
    to_id: newId('rr'),
    relation: 'derived_from',
    ...overrides,
  }
}

test('evidence_link：派生对象 → raw_record（M2 applyTriage 主链路，含全部 5 类派生对象）', () => {
  for (const fromType of ['task', 'event', 'metric', 'habit_checkin', 'wish']) {
    const record = evidenceLink({ from_type: fromType })
    assert.equal(validateRecord('evidence_link', record).ok, true, `${fromType} → raw_record 应可写入`)
  }
  // 现有关系（推断/记忆/建议/状态/操作日志）保持可用
  for (const fromType of ['agent_inference', 'personal_memory', 'assistant_suggestion', 'state', 'operation_log']) {
    assert.equal(validateRecord('evidence_link', evidenceLink({ from_type: fromType })).ok, true)
  }
})

test('evidence_link：raw_record 作为来源（raw → 派生对象）也可写', () => {
  assert.equal(
    validateRecord('evidence_link', evidenceLink({ from_type: 'raw_record', to_type: 'event', relation: 'evidence_of' })).ok,
    true,
  )
  assert.equal(
    validateRecord('evidence_link', evidenceLink({ from_type: 'raw_record', to_type: 'metric', relation: 'supports' })).ok,
    true,
  )
  // to_type 扩展后 wish/state_change 均可作为证据目标
  for (const toType of ['raw_record', 'event', 'metric', 'habit_checkin', 'task', 'wish', 'state_change']) {
    assert.equal(validateRecord('evidence_link', evidenceLink({ to_type: toType })).ok, true, `to_type=${toType}`)
  }
})

test('evidence_link：relation 支持 derived_from / evidence_of / supports / contradicts', () => {
  for (const relation of ['derived_from', 'evidence_of', 'supports', 'contradicts']) {
    assert.equal(validateRecord('evidence_link', evidenceLink({ relation })).ok, true, `relation=${relation}`)
  }
})

test('evidence_link：非法 from_type / to_type / relation 仍被拒', () => {
  const badFrom = validateRecord('evidence_link', evidenceLink({ from_type: 'project' }))
  assert.equal(badFrom.ok, false)
  assert.ok(badFrom.errors.some((line) => line.includes('from_type')))

  const badTo = validateRecord('evidence_link', evidenceLink({ to_type: 'project' }))
  assert.equal(badTo.ok, false)
  assert.ok(badTo.errors.some((line) => line.includes('to_type')))

  const badRelation = validateRecord('evidence_link', evidenceLink({ relation: 'mentions' }))
  assert.equal(badRelation.ok, false)
  assert.ok(badRelation.errors.some((line) => line.includes('relation')))

  const missing = validateRecord('evidence_link', { id: newId('evl'), to_type: 'raw_record' })
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.some((line) => line.includes('from_type')))
})

test('evidence_link：白名单枚举已包含 M2 扩展值（防回退）', () => {
  const spec = TABLE_SPECS.evidence_link
  for (const value of ['task', 'event', 'metric', 'habit_checkin', 'wish', 'raw_record']) {
    assert.ok(spec.enums.from_type.includes(value), `from_type 应包含 ${value}`)
  }
  for (const value of ['raw_record', 'event', 'metric', 'habit_checkin', 'task', 'wish']) {
    assert.ok(spec.enums.to_type.includes(value), `to_type 应包含 ${value}`)
  }
  assert.ok(spec.enums.relation.includes('derived_from'))
  assert.ok(spec.enums.relation.includes('evidence_of'))
})

// ---------------------------------------------------------------------------
// M8：task.repeat_rule 对象字段（可空，旧记录缺字段仍合法）
// ---------------------------------------------------------------------------

test('validateRecord：task.repeat_rule 只接受对象或 null', () => {
  const id = newId('tsk')
  const base = { id, title: '重复任务', status: 'todo' }
  assert.equal(validateRecord('task', { ...base, repeat_rule: { kind: 'weekly', days: [1, 3] } }).ok, true)
  assert.equal(validateRecord('task', { ...base, repeat_rule: null }).ok, true)
  assert.equal(validateRecord('task', base).ok, true, '旧记录缺该字段仍合法')
  for (const bad of ['daily', 1, []]) {
    const result = validateRecord('task', { ...base, repeat_rule: bad })
    assert.equal(result.ok, false, JSON.stringify(bad))
    assert.ok(result.errors.some((line) => line.includes('repeat_rule')))
  }
  // 具体形状（kind/days/day）由 contract/task.js 归一校验，schema 只保证 object|null。
  assert.equal(validateRecord('task', { ...base, repeat_rule: { kind: 'daily' } }).ok, true)
})

test('normalizeRecord：task 默认 repeat_rule=null，显式对象保留', () => {
  const record = normalizeRecord('task', { title: '重复任务' }, { key: newId('tsk') })
  assert.equal(record.repeat_rule, null)
  assert.equal(validateRecord('task', record).ok, true)

  const withRule = normalizeRecord(
    'task',
    { title: '重复任务', repeat_rule: { kind: 'monthly', day: 1 } },
    { key: newId('tsk') },
  )
  assert.deepEqual(withRule.repeat_rule, { kind: 'monthly', day: 1 })
})
