/**
 * LifeOS — ID 生成（A 线：领域层）
 *
 * ULID 风格：`<prefix>_<26 位 Crockford Base32>`，时间有序（前 10 位为 48-bit 毫秒时间），
 * 后 16 位为 80-bit 随机数。零第三方依赖，使用 node:crypto 的 randomBytes。
 * 同一毫秒内单调递增（随机位 +1），保证按 ID 字典序 ≈ 创建顺序，可用于游标分页。
 */

import { randomBytes } from 'node:crypto'

/** Crockford Base32（去掉 I L O U） */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ENCODING_LEN = 32
const TIME_LEN = 10
const RANDOM_LEN = 16
const MAX_RANDOM = (1n << 80n) - 1n

/** 允许的 ID 前缀：由调用方传入（见 schemas.js 的各表 prefix） */
const PREFIX_RE = /^[a-z][a-z0-9]*$/
const ID_RE = /^([a-z][a-z0-9]*)_([0-9A-HJKMNP-TV-Z]{26})$/

let lastTimeMs = -1
let lastRandom = 0n

function encodeTime(ms) {
  let n = BigInt(ms)
  let out = ''
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[Number(n % 32n)] + out
    n /= 32n
  }
  return out
}

function encodeRandom(value) {
  let n = value
  let out = ''
  for (let i = 0; i < RANDOM_LEN; i++) {
    out = ENCODING[Number(n & 31n)] + out
    n >>= 5n
  }
  return out
}

function random80() {
  const bytes = randomBytes(10)
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  return n
}

/**
 * 生成新 ID。
 * @param {string} prefix 小写前缀（如 `rr`/`tsk`/`jrn`）
 * @returns {string} 例：`rr_01JB8Z4Q2M7K9V3X1N6T5R0A8C`
 */
export function newId(prefix) {
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) {
    throw new TypeError(`invalid id prefix: ${String(prefix)}`)
  }
  const now = Date.now()
  if (now <= lastTimeMs && lastRandom !== null) {
    // 时钟回拨或同毫秒：保持时间单调，随机位 +1
    lastRandom = (lastRandom + 1n) & MAX_RANDOM
  } else {
    lastTimeMs = now
    lastRandom = random80()
  }
  return `${prefix}_${encodeTime(lastTimeMs)}${encodeRandom(lastRandom)}`
}

/**
 * 判断是否为合法 ID（可限定前缀）。
 * @param {unknown} value
 * @param {string|null} [prefix]
 */
export function isId(value, prefix = null) {
  if (typeof value !== 'string') return false
  const m = ID_RE.exec(value)
  if (!m) return false
  return prefix === null || m[1] === prefix
}

/** 取 ID 前缀；非法返回 null。 */
export function idPrefix(value) {
  if (typeof value !== 'string') return null
  const m = ID_RE.exec(value)
  return m ? m[1] : null
}

/** 从 ID 中解出毫秒时间戳（用于排序/调试）；非法返回 null。 */
export function idTime(value) {
  if (typeof value !== 'string') return null
  const m = ID_RE.exec(value)
  if (!m) return null
  let n = 0n
  for (const ch of m[2].slice(0, TIME_LEN)) {
    const idx = ENCODING.indexOf(ch)
    if (idx < 0) return null
    n = n * 32n + BigInt(idx)
  }
  return Number(n)
}

/** 供测试使用：重置模块级单调状态。 */
export function __resetIdState() {
  lastTimeMs = -1
  lastRandom = 0n
}

export const ID_ENCODING = ENCODING
