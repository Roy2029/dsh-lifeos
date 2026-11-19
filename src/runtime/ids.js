/**
 * B 侧 ID 兜底生成器（零依赖）。
 *
 * 契约：`<prefix>_<26 位 base32（时间有序随机）>`，前缀见 design/08 §2.1。
 * 若 A 的 `src/domain/ids.js` 可用，index.js 会优先注入 A 的实现；本文件只在
 * A 尚未就绪 / 单测中作为兜底，保证 Host 能独立启动。
 *
 * 26 位 = 10 位时间（毫秒，base32 天然有序）+ 16 位随机（crypto）。
 */

import { randomBytes, createHash } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

function encodeTime(ms, length) {
  let out = '';
  let value = Math.max(0, Math.floor(ms));
  for (let i = 0; i < length; i += 1) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(length) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % 32];
  return out;
}

export function newId(prefix, nowMs) {
  const at = Number.isFinite(nowMs) ? nowMs : Date.now();
  const name = typeof prefix === 'string' && prefix.length > 0 ? prefix.replace(/_$/, '') : 'id';
  return `${name}_${encodeTime(at, 10)}${encodeRandom(16)}`;
}

/** 内容 hash（raw_record.raw_text_sha256；不暴露原文） */
export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 是否形如 `<prefix>_<26 位 base32>` */
export function isId(value, prefix) {
  if (typeof value !== 'string') return false;
  const re = prefix ? new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`) : /^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/;
  return re.test(value);
}
