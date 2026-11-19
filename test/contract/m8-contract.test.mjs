/**
 * M8 契约测试：repeatRule 形状校验 + 标签 PATCH 校验 + tag_ ID 校验。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  REPEAT_KINDS,
  validateCreateTask,
  validateRepeatRule,
  validateTagId,
  validateUpdateTag,
  validateUpdateTask,
} from '../../src/client-shared/contract.js'
import { newId } from '../../src/domain/ids.js'

test('validateRepeatRule：null / daily / weekly / monthly 合法形状', () => {
  assert.deepEqual(REPEAT_KINDS, ['daily', 'weekly', 'monthly'])
  assert.deepEqual(validateRepeatRule(null), { ok: true, value: null })
  assert.deepEqual(validateRepeatRule(undefined), { ok: true, value: null })
  assert.deepEqual(validateRepeatRule({ kind: 'daily' }), { ok: true, value: { kind: 'daily' } })
  assert.deepEqual(validateRepeatRule({ kind: 'weekly', days: [3, 1, 3, 5] }), {
    ok: true,
    value: { kind: 'weekly', days: [1, 3, 5] },
  })
  assert.deepEqual(validateRepeatRule({ kind: 'monthly', day: 15 }), { ok: true, value: { kind: 'monthly', day: 15 } })
  // daily 的多余字段被忽略（契约二选一中选择「忽略」）。
  assert.deepEqual(validateRepeatRule({ kind: 'daily', days: [1], day: 2 }), { ok: true, value: { kind: 'daily' } })
})

test('validateRepeatRule：非法输入返回可读错误', () => {
  const cases = [
    ['字符串', 'weekly'],
    ['数组', []],
    ['未知 kind', { kind: 'yearly' }],
    ['weekly 空数组', { kind: 'weekly', days: [] }],
    ['weekly 非数组', { kind: 'weekly', days: 1 }],
    ['weekly day=0', { kind: 'weekly', days: [0] }],
    ['weekly day=8', { kind: 'weekly', days: [8] }],
    ['weekly 非整数', { kind: 'weekly', days: [1.5] }],
    ['monthly 缺 day', { kind: 'monthly' }],
    ['monthly day=0', { kind: 'monthly', day: 0 }],
    ['monthly day=32', { kind: 'monthly', day: 32 }],
    ['monthly 非整数', { kind: 'monthly', day: 1.5 }],
  ]
  for (const [label, value] of cases) {
    const result = validateRepeatRule(value)
    assert.equal(result.ok, false, label)
    assert.ok(result.errors.length > 0, label)
    assert.ok(result.errors[0].includes('repeatRule'), `${label}: ${result.errors[0]}`)
  }
})

test('validateCreateTask / validateUpdateTask 接受 repeatRule', () => {
  const created = validateCreateTask({ title: '重复任务', repeatRule: { kind: 'weekly', days: [2, 2, 6] } })
  assert.equal(created.ok, true)
  assert.deepEqual(created.value.repeatRule, { kind: 'weekly', days: [2, 6] })

  const cleared = validateCreateTask({ title: 'x', repeatRule: null })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.value.repeatRule, null)

  const patched = validateUpdateTask({ repeatRule: { kind: 'monthly', day: 1 } })
  assert.equal(patched.ok, true)
  assert.deepEqual(patched.value.repeatRule, { kind: 'monthly', day: 1 })

  const bad = validateUpdateTask({ repeatRule: { kind: 'weekly', days: [] } })
  assert.equal(bad.ok, false)

  const nullPatch = validateUpdateTask({ repeatRule: null })
  assert.equal(nullPatch.ok, true)
  assert.equal(nullPatch.value.repeatRule, null)
})

test('validateUpdateTag：name/color 合法组合与错误', () => {
  assert.deepEqual(validateUpdateTag({ name: '工作台' }), { ok: true, value: { name: '工作台' } })
  assert.deepEqual(validateUpdateTag({ color: '#A1b2C3' }), { ok: true, value: { color: '#A1b2C3' } })
  assert.deepEqual(validateUpdateTag({ color: null }).value, { color: null })
  assert.deepEqual(validateUpdateTag({ name: 'x', color: '#000000', expectedRev: 3 }).value, {
    name: 'x',
    color: '#000000',
  })

  for (const body of [
    null,
    'name',
    [],
    {},
    { name: '' },
    { name: '   ' },
    { name: 'x'.repeat(51) },
    { color: 'red' },
    { color: '#12345' },
    { color: '#1234567' },
    { color: 123 },
    { foo: 1 },
    { name: 'x', foo: 1 },
  ]) {
    const result = validateUpdateTag(body)
    assert.equal(result.ok, false, JSON.stringify(body))
    assert.ok(result.errors.length > 0)
  }
})

test('validateTagId：tag_ 前缀', () => {
  const id = newId('tag')
  assert.deepEqual(validateTagId(id), { ok: true, value: id })
  assert.equal(validateTagId('tsk_01J00000000000000000000000').ok, false)
  assert.equal(validateTagId('tag_short').ok, false)
  assert.equal(validateTagId(null).ok, false)
})
