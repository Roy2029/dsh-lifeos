import test from 'node:test'
import assert from 'node:assert/strict'

import { newId, isId, idPrefix, idTime, __resetIdState, ID_ENCODING } from '../../../src/domain/ids.js'

const ID_RE = /^([a-z][a-z0-9]*)_([0-9A-HJKMNP-TV-Z]{26})$/

test('newId：格式为 <prefix>_<26 位 Crockford Base32>', () => {
  const id = newId('tsk')
  const m = ID_RE.exec(id)
  assert.ok(m, `id 格式不合法：${id}`)
  assert.equal(m[1], 'tsk')
  assert.equal(m[2].length, 26)
  // 时间部分前 2 bit 必须为 0（48-bit 时间装进 50-bit 空间）→ 首字符只能是 0-7
  assert.ok('01234567'.includes(m[2][0]), `首字符应 <= 7，实际 ${m[2][0]}`)
})

test('newId：前缀非法时抛 TypeError', () => {
  for (const bad of ['', 'TSK', 'ts-k', '1abc', 'rr_', null, undefined, 42]) {
    assert.throws(() => newId(bad), TypeError)
  }
})

test('newId：批量唯一（2000 个）', () => {
  __resetIdState()
  const seen = new Set()
  for (let i = 0; i < 2000; i++) seen.add(newId('rr'))
  assert.equal(seen.size, 2000)
})

test('newId：同一毫秒/连续生成保持字典序单调', () => {
  __resetIdState()
  let prev = ''
  for (let i = 0; i < 500; i++) {
    const id = newId('jrn')
    if (prev) assert.ok(id > prev, `ID 未单调递增：${prev} >= ${id}`)
    prev = id
  }
})

test('isId / idPrefix / idTime', () => {
  const id = newId('evt')
  assert.equal(isId(id), true)
  assert.equal(isId(id, 'evt'), true)
  assert.equal(isId(id, 'tsk'), false)
  assert.equal(isId('evt_short'), false)
  assert.equal(isId('evt_01ARZ3NDEKTSV4RRFFQ69G5FAV'), true)
  // Crockford 编码不含 I/L/O/U
  assert.equal(isId('evt_01ARZ3NDEKISV4RRFFQ69G5FAV'), false)
  assert.equal(idPrefix(id), 'evt')
  assert.equal(idPrefix('nope'), null)
  const t = idTime(id)
  assert.equal(typeof t, 'number')
  assert.ok(Math.abs(t - Date.now()) < 60_000, `解出时间偏差过大：${t}`)
  assert.equal(idTime('nope'), null)
})

test('ID_ENCODING 为 Crockford Base32（32 位、无 I L O U）', () => {
  assert.equal(ID_ENCODING.length, 32)
  for (const ch of 'ILOU') assert.equal(ID_ENCODING.includes(ch), false)
})
