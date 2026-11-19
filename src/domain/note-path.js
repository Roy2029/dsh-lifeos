/**
 * LifeOS — 本地笔记路径安全（M2.5 A 线，纯函数 + node 内置模块）
 *
 * 契约：`M2.5-PLAN.md` §2.1/§2.3；task-26。
 * 仅使用 node:fs / node:path / node:crypto（无第三方依赖）。
 *
 * 安全边界（门禁 M2.5-G1）：
 * - 输入只能是相对 notesDir 的路径；绝对路径 / 盘符 / UNC / `..` / 控制字符 / Windows 非法字符 /
 *   结尾点或空格 / 保留设备名 / 空段 全部拒绝（`path_forbidden`）；
 * - root 必须存在且 realpath 后仍是目录；目标路径按最深已存在祖先 realpath 校验，符号链接
 *   指向 root 外（含 junction）一律拒绝；
 * - Windows 下路径比较大小写不敏感；
 * - `.lifeos-history` / `.trash` 是保留目录，API 不可写入。
 *
 * 错误：抛 `NotePathError`（code ∈ path_forbidden/validation_failed），由 service 包装成 LifeosError。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const EDITABLE_EXTS = Object.freeze(['.md', '.markdown', '.txt'])
export const DEFAULT_EXT = '.md'
export const HISTORY_DIR = '.lifeos-history'
export const TRASH_DIR = '.trash'
export const RESERVED_DIRS = Object.freeze([HISTORY_DIR, TRASH_DIR])
export const TEMP_PREFIX = '.~'
export const MAX_READ_BYTES = 2 * 1024 * 1024

const WINDOWS_ILLEGAL = /[<>:"|?*]/
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const WIN = process.platform === 'win32'

export class NotePathError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'NotePathError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function forbidden(message, details) {
  throw new NotePathError('path_forbidden', message, details)
}

function invalid(message, details) {
  throw new NotePathError('validation_failed', message, details)
}

/** 平台相关路径比较键（Windows 大小写不敏感）。 */
export function compareKey(value) {
  const normalized = String(value).replace(/\\/g, '/').replace(/\/+$/, '')
  return WIN ? normalized.toLowerCase() : normalized
}

/** 两个绝对路径是否相同（平台语义）。 */
export function samePath(a, b) {
  return compareKey(a) === compareKey(b)
}

/** target 是否位于 root 内（target === root 视为 false，除非 allowSelf）。 */
export function isInside(rootAbs, targetAbs, { allowSelf = false } = {}) {
  const rootKey = compareKey(rootAbs)
  const targetKey = compareKey(targetAbs)
  if (targetKey === rootKey) return allowSelf
  return targetKey.startsWith(rootKey.endsWith('/') ? rootKey : `${rootKey}/`)
}

/** 校验并返回 root 的真实路径（必须存在且是目录）。 */
export function resolveRoot(root) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    invalid('笔记目录未配置', { root: root ?? null })
  }
  if (CONTROL_CHARS.test(root) || root.includes('\u0000')) {
    forbidden('笔记目录包含非法控制字符', { root })
  }
  const absolute = path.resolve(root)
  if (!isAbsoluteLike(absolute)) forbidden('笔记目录必须是绝对路径', { root })
  let real
  try {
    real = fs.realpathSync.native(absolute)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      invalid('笔记目录不存在', { root: absolute })
    }
    forbidden('无法解析笔记目录', { root: absolute, cause: error?.code ?? String(error) })
  }
  let stat
  try {
    stat = fs.statSync(real)
  } catch (error) {
    forbidden('无法读取笔记目录', { root: real, cause: error?.code ?? String(error) })
  }
  if (!stat.isDirectory()) invalid('笔记目录不是文件夹', { root: real })
  return real
}

function isAbsoluteLike(value) {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
}

/**
 * 路径规范化（仅字符串层面；不碰文件系统）：
 * - 反斜杠 → `/`；去掉开头 `./`；折叠重复斜杠；去掉末尾斜杠（root 除外）。
 * @returns {string} 形如 `a/b/c.md`（root 为空串）
 */
export function normalizeRel(rel) {
  if (typeof rel !== 'string') invalid('path 必须是字符串', { path: rel ?? null })
  if (CONTROL_CHARS.test(rel)) forbidden('path 包含非法控制字符', { path: rel })
  if (rel.includes('\u0000')) forbidden('path 包含空字节', { path: rel })
  let value = rel.replace(/\\/g, '/')
  if (isAbsoluteLike(value) || value.startsWith('//')) {
    forbidden('path 不允许使用绝对路径', { path: rel })
  }
  value = value.replace(/\/+/g, '/')
  value = value.replace(/^\.\//, '')
  value = value.replace(/\/+$/, '')
  if (value === '.' || value === './') value = ''
  if (value === '') invalid('path 不能为空', { path: rel })
  const segments = value.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      forbidden('path 包含空路径段', { path: rel })
    }
    if (segment === '..') forbidden('path 不允许包含 `..`', { path: rel })
    if (WINDOWS_ILLEGAL.test(segment)) {
      forbidden('path 包含 Windows 非法字符（<>:"|?*）', { path: rel })
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      forbidden('path 不允许以点或空格结尾', { path: rel })
    }
    if (RESERVED_NAMES.test(segment)) {
      forbidden('path 使用了 Windows 保留设备名', { path: rel })
    }
  }
  return segments.join('/')
}

/**
 * 把相对路径解析为 root 内的绝对路径（含符号链接边界校验）。
 * @param {string} root notesDir（可为未 realpath 的绝对路径）
 * @param {string} rel 相对路径（`a/b.md`；root 用空串）
 * @param {{allowRoot?: boolean}} [options]
 * @returns {{abs: string, rel: string, segments: string[], exists: boolean}}
 */
export function resolveInside(root, rel, { allowRoot = false, allowSymlinkLeaf = false } = {}) {
  const realRoot = resolveRoot(root)
  const isRootAlias = allowRoot && (rel === '' || rel === '.' || rel === './')
  const normalized = isRootAlias ? '' : normalizeRel(rel)
  if (normalized === '' && !allowRoot) invalid('path 不能为空', { path: rel })
  const segments = normalized === '' ? [] : normalized.split('/')
  if (segments.length > 0 && RESERVED_DIRS.includes(segments[0])) {
    forbidden('不允许访问保留目录', { path: rel, reserved: segments[0] })
  }
  const abs = segments.length === 0 ? realRoot : path.resolve(realRoot, ...segments)
  // 先做字符串边界判断（Windows 大小写不敏感）
  if (!isInside(realRoot, abs, { allowSelf: true })) {
    forbidden('path 越出笔记目录', { path: rel })
  }
  // 再按最深已存在祖先做 realpath 校验，拦截符号链接/junction 逃逸。
  // allowSymlinkLeaf=true 时只校验父链（删除/移动"链接本身"不跟随目标，但仍禁止经链接祖先逃逸）。
  const checkPath = allowSymlinkLeaf && abs !== realRoot ? path.dirname(abs) : abs
  const deepest = deepestExisting(checkPath)
  if (deepest) {
    let real = null
    try {
      real = fs.realpathSync.native(deepest)
    } catch (error) {
      forbidden('无法解析路径', { path: rel, cause: error?.code ?? String(error) })
    }
    if (!isInside(realRoot, real, { allowSelf: true })) {
      forbidden('path 经符号链接越出笔记目录', { path: rel })
    }
  }
  let exists = false
  try {
    fs.lstatSync(abs)
    exists = true
  } catch {
    exists = false
  }
  return { abs, rel: normalized, segments, exists }
}

/** 找到 abs 自身或最近的已存在祖先；都不存在返回 null。 */
function deepestExisting(abs) {
  let current = abs
  for (let i = 0; i < 256; i++) {
    try {
      fs.lstatSync(current)
      return current
    } catch (error) {
      if (!error || error.code !== 'ENOENT') return null
      const parent = path.dirname(current)
      if (parent === current) return null
      current = parent
    }
  }
  return null
}

/** 绝对路径 → 相对 root 的 API 路径（正斜杠）。 */
export function toRel(rootAbs, targetAbs) {
  const rel = path.relative(rootAbs, targetAbs)
  if (rel === '') return ''
  if (rel.startsWith('..') || isAbsoluteLike(rel)) forbidden('路径越出笔记目录', { path: targetAbs })
  return rel.split(path.sep).join('/')
}

/** 是否可编辑文本扩展名（.md/.markdown/.txt）。 */
export function isEditableName(name) {
  if (typeof name !== 'string') return false
  return EDITABLE_EXTS.includes(extOf(name).toLowerCase())
}

/** 取小写扩展名（含点）；无扩展返回 ''。 */
export function extOf(name) {
  const base = path.basename(String(name))
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot)
}

/**
 * 补齐可编辑扩展名：无扩展 → 追加 defaultExt；已可编辑 → 原样；
 * 其它扩展（如 .png）→ 拒绝（422），避免误写非文本文件。
 */
export function ensureExt(name, defaultExt = DEFAULT_EXT) {
  if (typeof name !== 'string' || name.trim().length === 0) invalid('文件名不能为空', { name: name ?? null })
  const ext = extOf(name)
  if (ext === '') return `${name}${defaultExt}`
  if (isEditableName(name)) return name
  invalid('仅支持 .md/.markdown/.txt 文本文件', { name, ext })
}

/** 保留目录 / 临时文件 / 隐藏文件判定。 */
export function isTempName(name) {
  if (typeof name !== 'string') return false
  return (
    name.startsWith(TEMP_PREFIX) ||
    name.endsWith('.tmp') ||
    name.endsWith('.swp') ||
    name.endsWith('~') ||
    name === '.DS_Store' ||
    name === 'Thumbs.db'
  )
}

/**
 * 是否在文件树/搜索中忽略该条目。
 * @param {string} name
 * @param {{includeHidden?: boolean}} [options]
 */
export function isIgnoredName(name, { includeHidden = false } = {}) {
  if (typeof name !== 'string' || name.length === 0) return true
  if (RESERVED_DIRS.includes(name)) return true
  if (isTempName(name)) return true
  if (!includeHidden && name.startsWith('.')) return true
  return false
}

/** 文件名净化：用于"新建笔记"标题 → 安全文件名（不改路径语义，只处理单段名称）。 */
export function sanitizeName(name, { defaultExt = DEFAULT_EXT } = {}) {
  if (typeof name !== 'string') invalid('文件名必须是字符串', { name: name ?? null })
  if (CONTROL_CHARS.test(name)) forbidden('文件名包含控制字符', { name })
  if (/[\\/]/.test(name)) forbidden('文件名不能包含路径分隔符', { name })
  if (isAbsoluteLike(name)) forbidden('文件名不能是绝对路径', { name })
  let value = name
    .replace(/[<>:"|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if (value.length === 0) value = '未命名'
  if (RESERVED_NAMES.test(value)) value = `_${value}`
  value = ensureExt(value, defaultExt)
  if (value.length > 120) {
    const ext = extOf(value)
    value = `${value.slice(0, 120 - ext.length)}${ext}`
  }
  return value
}

/** sha1（hex）——用于内容 hash 与历史目录键。 */
export function sha1Hex(input) {
  return crypto.createHash('sha1').update(input).digest('hex')
}

/** 历史快照目录键：基于规范化相对路径（Windows 大小写不敏感）。 */
export function historyKey(rel) {
  return sha1Hex(compareKey(normalizeRel(rel)))
}

/** 紧凑时间戳（Windows 文件名安全，字典序 = 时间序）：YYYYMMDDTHHmmssSSS。 */
export function formatTimestamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) invalid('无效时间戳')
  const p = (n, len = 2) => String(n).padStart(len, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
  )
}

/** 解析快照 id → Date（失败返回 null）。 */
export function parseTimestamp(id) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})$/.exec(String(id).replace(/\.md$/, ''))
  if (!match) return null
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  )
  return Number.isFinite(date.getTime()) ? date : null
}
