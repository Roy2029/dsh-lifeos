/**
 * LifeOS — 本地文件夹笔记服务（M2.5 A 线）
 *
 * 契约：`M2.5-PLAN.md` §2（文件语义/路径安全/冲突/快照）、task-26。
 * - 只用 node:fs / node:path / node:crypto（零第三方、零 `@deepseek-ai/*`）。
 * - 文件真实落在用户配置的 notesDir；仅管理 `.md/.markdown/.txt` 文本文件。
 * - 写：临时文件 + fsync + rename 原子替换；写前快照到
 *   `<notesDir>/.lifeos-history/<sha1(path)>/<紧凑时间戳>.md`，保留最近 20 个。
 * - 删：移到 `<notesDir>/.trash/<时间戳>-<name>`（可恢复）。
 * - 错误：统一 LifeosError（validation_failed/path_forbidden/conflict/path_exists/file_too_large/not_found）。
 *
 * 该服务不启动 fs.watch（外部改动监听由 B 的 runtime/note-watch.js 负责）；
 * 通过 `createNoteService({ getRoot, dataDir, logger })` 创建，`getRoot()` 由 B/Lead 从
 * `app_setting['notes.dir']` 读取后传入（每次操作实时读取，支持设置页改目录）。
 */

import fsSync from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { LifeosError } from './errors.js'
import * as NP from '../domain/note-path.js'

export const NOTE_OPTION_DEFAULTS = Object.freeze({
  sort: 'name', // name | mtime
  autosaveMs: 800,
  historyLimit: 20,
  includeHidden: false,
})

export const NOTE_HISTORY_LIMIT_MAX = 100
export const NOTE_SEARCH_MAX_FILES = 200
export const NOTE_SEARCH_MAX_BYTES = 200 * 1024

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toIso(value) {
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function normalizeOptions(input, current = NOTE_OPTION_DEFAULTS) {
  const next = { ...NOTE_OPTION_DEFAULTS, ...current }
  if (!isPlainObject(input)) return next
  if (input.sort !== undefined) {
    if (!['name', 'mtime'].includes(input.sort)) {
      throw new LifeosError('validation_failed', 'options.sort 只支持 name/mtime', { sort: input.sort })
    }
    next.sort = input.sort
  }
  if (input.autosaveMs !== undefined) {
    const value = Number(input.autosaveMs)
    if (!Number.isFinite(value) || value < 100 || value > 5000) {
      throw new LifeosError('validation_failed', 'options.autosaveMs 必须在 100..5000', { autosaveMs: input.autosaveMs })
    }
    next.autosaveMs = Math.trunc(value)
  }
  if (input.historyLimit !== undefined) {
    const value = Number(input.historyLimit)
    if (!Number.isFinite(value) || value < 0 || value > NOTE_HISTORY_LIMIT_MAX) {
      throw new LifeosError('validation_failed', `options.historyLimit 必须在 0..${NOTE_HISTORY_LIMIT_MAX}`, {
        historyLimit: input.historyLimit,
      })
    }
    next.historyLimit = Math.trunc(value)
  }
  if (input.includeHidden !== undefined) {
    if (typeof input.includeHidden !== 'boolean') {
      throw new LifeosError('validation_failed', 'options.includeHidden 必须是布尔值')
    }
    next.includeHidden = input.includeHidden
  }
  return next
}

/**
 * @param {{
 *   getRoot: () => string|null|undefined,
 *   dataDir?: string|null,
 *   logger?: {info?:Function, warn?:Function, error?:Function}|null,
 *   getOptions?: () => object|null,
 *   onConfigChange?: (config: {dir: string, options: object}) => void|Promise<void>,
 *   fs?: object,                 // 测试注入（覆盖单个 fs promise 方法）
 *   now?: () => Date,
 * }} deps
 */
export function createNoteService(deps = {}) {
  const { getRoot, dataDir = null, logger = null, getOptions = null, onConfigChange = null } = deps
  if (typeof getRoot !== 'function' && typeof getRoot !== 'string') {
    throw new LifeosError('validation_failed', 'createNoteService 需要 getRoot() 或 root 字符串')
  }
  const rootSource = typeof getRoot === 'function' ? getRoot : () => getRoot
  const io = { ...fsp, ...(isPlainObject(deps.fs) ? deps.fs : {}) }
  const now = typeof deps.now === 'function' ? deps.now : () => new Date()
  let overrideRoot = null
  let options = normalizeOptions(isPlainObject(getOptions) ? getOptions() : {})

  function wrap(error, fallbackCode, fallbackMessage, details) {
    if (error instanceof LifeosError) return error
    if (error instanceof NP.NotePathError) {
      return new LifeosError(error.code, error.message, error.details ?? details)
    }
    const code = error?.code
    if (code === 'ENOENT') return new LifeosError('not_found', fallbackMessage || '文件或目录不存在', details)
    if (code === 'EACCES' || code === 'EPERM') {
      return new LifeosError('path_forbidden', '没有权限访问该路径', details)
    }
    if (code === 'EISDIR') return new LifeosError('validation_failed', '目标是文件夹', details)
    if (code === 'EINVAL' || code === 'ENAMETOOLONG') {
      return new LifeosError('validation_failed', '路径或参数不合法', details)
    }
    return new LifeosError(fallbackCode || 'internal', `${fallbackMessage || '笔记操作失败'}：${error?.message ?? error}`, details)
  }

  function configuredRoot() {
    const value = overrideRoot ?? rootSource()
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new LifeosError('validation_failed', '笔记目录未配置', { setting: 'notes.dir' })
    }
    return value
  }

  function realRoot() {
    try {
      return NP.resolveRoot(configuredRoot())
    } catch (error) {
      throw wrap(error, 'path_forbidden', '笔记目录不可用')
    }
  }

  function resolve(rel, opts = {}) {
    try {
      return NP.resolveInside(configuredRoot(), rel, opts)
    } catch (error) {
      throw wrap(error, 'path_forbidden', '路径不合法')
    }
  }

  function relOf(abs) {
    return NP.toRel(realRoot(), abs)
  }

  async function statQuiet(abs) {
    try {
      return await io.stat(abs)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
      throw error
    }
  }

  async function lstatQuiet(abs) {
    try {
      return await io.lstat(abs)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
      throw error
    }
  }

  /** 删除用：只校验父链 realpath，允许最终项是符号链接（只删链接本身）。 */
  function resolveForRemoval(rel) {
    try {
      return NP.resolveInside(configuredRoot(), rel, { allowSymlinkLeaf: true })
    } catch (error) {
      throw wrap(error, 'path_forbidden', '路径不合法')
    }
  }

  /** 原子写：同级临时文件 → fsync → rename；失败清理 tmp，不留半文件。 */
  async function atomicWrite(abs, buffer) {
    const dir = path.dirname(abs)
    await io.mkdir(dir, { recursive: true })
    const tmp = path.join(
      dir,
      `${NP.TEMP_PREFIX}${path.basename(abs)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 6)}.tmp`,
    )
    let handle = null
    try {
      handle = await io.open(tmp, 'w')
      await handle.writeFile(buffer)
      await handle.sync()
      await handle.close()
      handle = null
      await io.rename(tmp, abs)
    } catch (error) {
      if (handle) {
        try {
          await handle.close()
        } catch {
          /* ignore */
        }
      }
      try {
        await io.unlink(tmp)
      } catch {
        /* ignore */
      }
      throw error
    }
  }

  function historyDirFor(rel) {
    const root = realRoot()
    const key = NP.historyKey(rel)
    return { abs: path.join(root, NP.HISTORY_DIR, key), rel: `${NP.HISTORY_DIR}/${key}` }
  }

  /** 写前快照（保留最近 historyLimit 个；limit=0 表示关闭）。 */
  async function createSnapshot(rel, rawBuffer) {
    if (options.historyLimit <= 0) return null
    const dir = historyDirFor(rel)
    try {
      await io.mkdir(dir.abs, { recursive: true })
      let stamp = NP.formatTimestamp(now())
      let filename = `${stamp}.md`
      let target = path.join(dir.abs, filename)
      let bump = 0
      while (await statQuiet(target)) {
        bump += 1
        filename = `${stamp}-${bump}.md`
        target = path.join(dir.abs, filename)
      }
      await atomicWrite(target, rawBuffer)
      await pruneHistory(dir.abs)
      const stat = await statQuiet(target)
      return {
        snapshotPath: `${dir.rel}/${filename}`,
        mtime: toIso(stat?.mtime ?? now()),
        size: stat?.size ?? rawBuffer.length,
      }
    } catch (error) {
      // 快照失败不阻断写入（数据安全等级低于主内容），但记录告警
      logger?.warn?.({ event: 'note.snapshot_failed', path: rel, error: String(error?.message ?? error) })
      return null
    }
  }

  async function pruneHistory(dirAbs) {
    if (options.historyLimit <= 0) return
    let names = []
    try {
      const dirents = await io.readdir(dirAbs, { withFileTypes: true })
      names = dirents.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    names.sort()
    const excess = names.length - options.historyLimit
    for (let i = 0; i < excess; i++) {
      try {
        await io.unlink(path.join(dirAbs, names[i]))
      } catch {
        /* 清理失败不阻断 */
      }
    }
  }

  function decodeFile(buffer) {
    const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
    const body = hasBom ? buffer.subarray(3) : buffer
    const text = body.toString('utf8')
    const crlfCount = (text.match(/\r\n/g) || []).length
    const totalLf = (text.match(/\n/g) || []).length
    const newline = crlfCount > 0 && crlfCount >= totalLf - crlfCount ? 'crlf' : 'lf'
    const content = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    return { content, bom: hasBom, newline }
  }

  function encodeContent(content, { newline = 'lf', bom = false } = {}) {
    const stripped = content.startsWith('\uFEFF') ? content.slice(1) : content
    const normalized = stripped.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const withNewline = newline === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized
    const body = bom || content.startsWith('\uFEFF') ? `\uFEFF${withNewline}` : withNewline
    return Buffer.from(body, 'utf8')
  }

  async function readRaw(abs) {
    const stat = await io.stat(abs)
    const buffer = await io.readFile(abs)
    return { stat, buffer }
  }

  async function fileInfo(abs, rel) {
    const stat = await io.stat(abs)
    return {
      name: path.basename(abs),
      path: rel,
      type: 'file',
      size: stat.size,
      mtime: toIso(stat.mtime),
      editable: NP.isEditableName(path.basename(abs)),
    }
  }

  async function dirInfo(abs, rel) {
    const stat = await io.stat(abs)
    return { name: path.basename(abs), path: rel, type: 'dir', size: null, mtime: toIso(stat.mtime), editable: false }
  }

  function sortEntries(entries) {
    return entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      if (options.sort === 'mtime') {
        const am = Date.parse(a.mtime ?? 0)
        const bm = Date.parse(b.mtime ?? 0)
        if (am !== bm) return bm - am
      }
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
  }

  async function walkFiles(dirAbs, relDir, collector, { maxFiles = NOTE_SEARCH_MAX_FILES } = {}) {
    if (collector.length >= maxFiles) return
    let dirents = []
    try {
      dirents = await io.readdir(dirAbs, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of dirents) {
      if (collector.length >= maxFiles) return
      if (NP.isIgnoredName(entry.name, { includeHidden: options.includeHidden })) continue
      const abs = path.join(dirAbs, entry.name)
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      if (entry.isDirectory()) {
        await walkFiles(abs, rel, collector, { maxFiles })
      } else if (entry.isFile()) {
        collector.push({ abs, rel, name: entry.name })
      }
    }
  }

  const service = {
    /** 当前配置（不抛错：未配置时 exists=false）。 */
    getConfig() {
      const raw = overrideRoot ?? rootSource()
      const config = { dir: typeof raw === 'string' ? raw : null, options: { ...options }, exists: false, writable: false }
      if (typeof raw !== 'string' || raw.trim().length === 0) return config
      try {
        const real = NP.resolveRoot(raw)
        config.dir = real
        config.exists = true
        try {
          fsSync.accessSync(real, fsSync.constants.W_OK)
          config.writable = true
        } catch {
          config.writable = false
        }
        return config
      } catch {
        return config
      }
    },

    /** 设置目录/选项：校验（可选创建）后生效；持久化由 B（onConfigChange）负责。 */
    async setConfig(input = {}) {
      if (!isPlainObject(input)) throw new LifeosError('validation_failed', 'config 必须是对象')
      if (input.options !== undefined) options = normalizeOptions(input.options, options)
      if (input.dir === undefined) return this.getConfig()
      if (typeof input.dir !== 'string' || input.dir.trim().length === 0) {
        throw new LifeosError('validation_failed', 'dir 必须是非空绝对路径')
      }
      if (!path.isAbsolute(input.dir) && !path.win32.isAbsolute(input.dir)) {
        throw new LifeosError('validation_failed', 'dir 必须是绝对路径', { dir: input.dir })
      }
      const existing = await statQuiet(input.dir)
      if (!existing) {
        if (input.create !== true) throw new LifeosError('not_found', '笔记目录不存在（如需创建请带 create:true）', { dir: input.dir })
        try {
          await io.mkdir(input.dir, { recursive: true })
        } catch (error) {
          throw wrap(error, 'path_forbidden', '无法创建笔记目录')
        }
      }
      let real
      try {
        real = NP.resolveRoot(input.dir)
      } catch (error) {
        throw wrap(error, 'path_forbidden', '笔记目录不可用')
      }
      try {
        await io.access(real, fsSync.constants.W_OK)
      } catch {
        throw new LifeosError('path_forbidden', '笔记目录不可写', { dir: real })
      }
      overrideRoot = real
      const config = { dir: real, options: { ...options }, exists: true, writable: true }
      if (typeof onConfigChange === 'function') {
        try {
          await onConfigChange({ dir: real, options: { ...options } })
        } catch (error) {
          logger?.warn?.({ event: 'note.config_persist_failed', error: String(error?.message ?? error) })
        }
      }
      return config
    },

    /** 文件树（目录/文件；忽略 .lifeos-history/.trash/临时/隐藏文件）。 */
    async list(input = {}) {
      const { dir = '', depth = 1 } = isPlainObject(input) ? input : {}
      const maxDepth = clampInt(depth, 1, 8, 1)
      let resolved
      try {
        resolved = NP.resolveInside(configuredRoot(), dir ?? '', { allowRoot: true })
      } catch (error) {
        throw wrap(error, 'path_forbidden', '目录不合法')
      }
      const stat = await statQuiet(resolved.abs)
      if (!stat) throw new LifeosError('not_found', '目录不存在', { path: dir })
      if (!stat.isDirectory()) throw new LifeosError('validation_failed', 'path 不是文件夹', { path: dir })
      const entries = []
      const walk = async (absDir, relDir, level) => {
        let dirents = []
        try {
          dirents = await io.readdir(absDir, { withFileTypes: true })
        } catch (error) {
          if (error?.code === 'ENOENT') return
          throw error
        }
        for (const entry of dirents) {
          if (NP.isIgnoredName(entry.name, { includeHidden: options.includeHidden })) continue
          const abs = path.join(absDir, entry.name)
          const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
          // 指向 root 外的符号链接/junction 直接从视图隐藏（Windows junction 在 lstat 下可能不是 symlink）
          try {
            NP.resolveInside(configuredRoot(), rel)
          } catch {
            continue
          }
          const childStat = await statQuiet(abs)
          if (!childStat) continue
          if (childStat.isDirectory()) {
            entries.push(await dirInfo(abs, rel))
            if (level < maxDepth) await walk(abs, rel, level + 1)
          } else if (childStat.isFile()) {
            entries.push(await fileInfo(abs, rel))
          }
        }
      }
      await walk(resolved.abs, resolved.rel, 1)
      return { entries: sortEntries(entries) }
    },

    /** 读取文本文件（UTF-8；BOM/换行识别；>2MB 拒绝）。 */
    async read(input = {}) {
      const { path: rel } = isPlainObject(input) ? input : {}
      if (typeof rel !== 'string' || rel.trim().length === 0) {
        throw new LifeosError('validation_failed', 'path 必须是非空字符串')
      }
      const resolved = resolve(rel)
      const stat = await statQuiet(resolved.abs)
      if (!stat) throw new LifeosError('not_found', '文件不存在', { path: rel })
      if (!stat.isFile()) throw new LifeosError('validation_failed', 'path 不是文件', { path: rel })
      if (stat.size > NP.MAX_READ_BYTES) {
        throw new LifeosError('file_too_large', '文件超过 2MB，请使用外部编辑器', {
          path: rel,
          size: stat.size,
          limit: NP.MAX_READ_BYTES,
        })
      }
      const buffer = await io.readFile(resolved.abs)
      const decoded = decodeFile(buffer)
      return {
        path: resolved.rel,
        content: decoded.content,
        mtime: toIso(stat.mtime),
        size: stat.size,
        hash: NP.sha1Hex(buffer),
        encoding: 'utf-8',
        newline: decoded.newline,
        bom: decoded.bom,
      }
    },

    /** 写入（原子；baseHash 冲突 409；写前快照）。 */
    async write(input = {}) {
      const { path: rel, content, baseHash = null, create = false } = isPlainObject(input) ? input : {}
      if (typeof rel !== 'string' || rel.trim().length === 0) {
        throw new LifeosError('validation_failed', 'path 必须是非空字符串')
      }
      if (typeof content !== 'string') throw new LifeosError('validation_failed', 'content 必须是字符串')
      if (Buffer.byteLength(content, 'utf8') > NP.MAX_READ_BYTES) {
        throw new LifeosError('file_too_large', '写入内容超过 2MB', { limit: NP.MAX_READ_BYTES })
      }
      if (baseHash !== null && baseHash !== undefined && typeof baseHash !== 'string') {
        throw new LifeosError('validation_failed', 'baseHash 必须是字符串或 null')
      }
      if (!NP.isEditableName(rel)) {
        throw new LifeosError('validation_failed', '仅支持写入 .md/.markdown/.txt 文本文件', { path: rel })
      }
      const resolved = resolve(rel)
      const current = await statQuiet(resolved.abs)
      let newline = content.includes('\r\n') ? 'crlf' : 'lf'
      let bom = false
      let beforeBuffer = null
      if (current) {
        if (!current.isFile()) throw new LifeosError('validation_failed', 'path 不是文件', { path: rel })
        beforeBuffer = await io.readFile(resolved.abs)
        const decoded = decodeFile(beforeBuffer)
        newline = decoded.newline
        bom = decoded.bom
        if (typeof baseHash === 'string' && NP.sha1Hex(beforeBuffer) !== baseHash) {
          const currentHash = NP.sha1Hex(beforeBuffer)
          throw new LifeosError('conflict', '文件已被修改，请重新加载后再保存', {
            path: rel,
            currentHash,
            mtime: toIso(current.mtime),
            baseHash,
          })
        }
        await createSnapshot(resolved.rel, beforeBuffer)
      } else if (create !== true) {
        throw new LifeosError('not_found', '文件不存在（新建请使用 create）', { path: rel })
      }
      const buffer = encodeContent(content, { newline, bom })
      if (buffer.length > NP.MAX_READ_BYTES) {
        throw new LifeosError('file_too_large', '写入内容超过 2MB', { limit: NP.MAX_READ_BYTES })
      }
      try {
        await atomicWrite(resolved.abs, buffer)
      } catch (error) {
        throw wrap(error, 'internal', '写入失败（原文件未被修改）')
      }
      const after = await io.stat(resolved.abs)
      return {
        path: resolved.rel,
        mtime: toIso(after.mtime),
        hash: NP.sha1Hex(buffer),
        size: after.size,
        created: !current,
      }
    },

    /** 新建文件（不覆盖：已存在返回 path_exists）。 */
    async create(input = {}) {
      const { path: rel, content = '' } = isPlainObject(input) ? input : {}
      if (typeof rel !== 'string' || rel.trim().length === 0) {
        throw new LifeosError('validation_failed', 'path 必须是非空字符串')
      }
      let normalized
      try {
        normalized = normalizeApiPath(rel)
      } catch (error) {
        throw wrap(error, 'validation_failed', '路径不合法')
      }
      const existing = await statQuiet(resolve(normalized).abs)
      if (existing) {
        throw new LifeosError('path_exists', '文件已存在，新建不会覆盖', { path: normalized })
      }
      const result = await this.write({ path: normalized, content, create: true })
      return { path: result.path, mtime: result.mtime, hash: result.hash, size: result.size }
    },

    /** 新建文件夹（默认只建最后一级；recursive:true 可递归；已存在 409）。 */
    async mkdir(input = {}) {
      const { path: rel, recursive = false } = isPlainObject(input) ? input : {}
      if (typeof rel !== 'string' || rel.trim().length === 0) {
        throw new LifeosError('validation_failed', 'path 必须是非空字符串')
      }
      if (typeof recursive !== 'boolean') {
        throw new LifeosError('validation_failed', 'recursive 必须是布尔值')
      }
      const resolved = resolve(rel)
      const existing = await lstatQuiet(resolved.abs)
      if (existing) {
        throw new LifeosError('path_exists', '文件夹/文件已存在', {
          path: resolved.rel,
          type: existing.isDirectory() ? 'dir' : 'file',
        })
      }
      const parentAbs = path.dirname(resolved.abs)
      const parentStat = await statQuiet(parentAbs)
      if (!parentStat) {
        if (!recursive) {
          throw new LifeosError('parent_not_found', '父文件夹不存在（可传 recursive:true 递归创建）', {
            path: resolved.rel,
            parent: NP.toRel(realRoot(), parentAbs),
          })
        }
        try {
          await io.mkdir(resolved.abs, { recursive: true })
        } catch (error) {
          throw wrap(error, 'internal', '创建文件夹失败')
        }
        return { path: resolved.rel, type: 'dir', created: true }
      }
      if (!parentStat.isDirectory()) {
        throw new LifeosError('validation_failed', '父路径不是文件夹', { path: resolved.rel })
      }
      try {
        await io.mkdir(resolved.abs, { recursive: false })
      } catch (error) {
        if (error?.code === 'EEXIST') {
          throw new LifeosError('path_exists', '文件夹已存在', { path: resolved.rel })
        }
        throw wrap(error, 'internal', '创建文件夹失败')
      }
      return { path: resolved.rel, type: 'dir', created: true }
    },

    /** 重命名/移动文件或文件夹（不覆盖；目录禁止移入自身/子目录）。 */
    async rename(input = {}) {
      const { path: fromRel, toPath } = isPlainObject(input) ? input : {}
      if (typeof fromRel !== 'string' || fromRel.trim().length === 0) {
        throw new LifeosError('validation_failed', 'path 必须是非空字符串')
      }
      if (typeof toPath !== 'string' || toPath.trim().length === 0) {
        throw new LifeosError('validation_failed', 'toPath 必须是非空字符串')
      }
      const from = resolve(fromRel)
      const fromLstat = await lstatQuiet(from.abs)
      if (!fromLstat) throw new LifeosError('not_found', '源文件/文件夹不存在', { path: fromRel })
      const isDir = fromLstat.isDirectory()
      const type = isDir ? 'dir' : 'file'
      let normalizedTo
      try {
        normalizedTo = isDir ? normalizeDirPath(toPath) : normalizeApiPath(toPath)
      } catch (error) {
        throw wrap(error, 'validation_failed', '目标路径不合法')
      }
      const to = resolve(normalizedTo)
      const sameEntry = NP.samePath(from.abs, to.abs)
      if (from.abs === to.abs) return { path: from.rel, type }
      if (isDir && NP.isInside(from.abs, to.abs)) {
        throw new LifeosError('validation_failed', '不能把文件夹移动到自身或其子目录内', {
          path: fromRel,
          toPath,
        })
      }
      const targetStat = await statQuiet(to.abs)
      if (targetStat && !sameEntry) {
        throw new LifeosError('path_exists', '目标已存在，重命名不会覆盖', {
          path: toPath,
          type: targetStat.isDirectory() ? 'dir' : 'file',
        })
      }
      if (!targetStat) {
        const parentAbs = path.dirname(to.abs)
        const parentStat = await statQuiet(parentAbs)
        if (!parentStat) {
          throw new LifeosError('parent_not_found', '目标父文件夹不存在', {
            path: toPath,
            parent: NP.toRel(realRoot(), parentAbs),
          })
        }
        if (!parentStat.isDirectory()) {
          throw new LifeosError('validation_failed', '目标父路径不是文件夹', { path: toPath })
        }
      }
      try {
        await io.rename(from.abs, to.abs)
      } catch (error) {
        if (sameEntry) {
          // Windows 仅大小写改名兜底：两段式 rename
          const tmp = path.join(path.dirname(from.abs), `${NP.TEMP_PREFIX}case-${Date.now().toString(36)}.tmp`)
          try {
            await io.rename(from.abs, tmp)
            await io.rename(tmp, to.abs)
          } catch (error2) {
            try {
              await io.unlink(tmp)
            } catch {
              /* ignore */
            }
            throw wrap(error2, 'internal', '重命名失败（原文件保持不变）')
          }
        } else {
          throw wrap(error, 'internal', '重命名失败（原文件保持不变）')
        }
      }
      return { path: to.rel, type }
    },

    /** 删除（默认移入 .trash，可恢复；文件/文件夹/符号链接）。 */
    async remove(input = {}) {
      const { path: rel, trash = true } = isPlainObject(input) ? input : {}
      if (typeof rel !== 'string' || rel.trim().length === 0) {
        throw new LifeosError('validation_failed', 'path 必须是非空字符串')
      }
      const resolved = resolveForRemoval(rel)
      const lstat = await lstatQuiet(resolved.abs)
      if (!lstat) throw new LifeosError('not_found', '文件/文件夹不存在', { path: rel })
      const isSymlink = lstat.isSymbolicLink()
      const isDir = lstat.isDirectory() && !isSymlink
      const type = isDir ? 'dir' : 'file'
      if (trash === false) {
        if (isDir) {
          throw new LifeosError('validation_failed', '文件夹删除必须移入 .trash（可恢复）', { path: rel })
        }
        try {
          await io.unlink(resolved.abs)
        } catch (error) {
          throw wrap(error, 'internal', '删除失败（原文件保持不变）')
        }
        return { removed: true, type }
      }
      const root = realRoot()
      const trashDir = path.join(root, NP.TRASH_DIR)
      try {
        await io.mkdir(trashDir, { recursive: true })
      } catch (error) {
        throw wrap(error, 'internal', '无法创建回收站目录')
      }
      const stamp = NP.formatTimestamp(now())
      const baseName = path.basename(resolved.abs)
      let filename = `${stamp}-${baseName}`
      let target = path.join(trashDir, filename)
      let bump = 0
      while (await statQuiet(target)) {
        bump += 1
        filename = `${stamp}-${bump}-${baseName}`
        target = path.join(trashDir, filename)
      }
      try {
        await io.rename(resolved.abs, target)
      } catch (error) {
        throw wrap(error, 'internal', '移入回收站失败（原文件/文件夹保持不变）')
      }
      return { removed: true, trashPath: `${NP.TRASH_DIR}/${filename}`, type }
    },

    /** 搜索：文件名 + 内容 includes（限 200 篇 / 每篇 200KB）。 */
    async search(input = {}) {
      const { q, limit = 20 } = isPlainObject(input) ? input : {}
      if (typeof q !== 'string' || q.trim().length === 0) {
        throw new LifeosError('validation_failed', 'q 必须是非空字符串')
      }
      const needle = q.trim()
      const needleLower = needle.toLowerCase()
      const max = clampInt(limit, 1, 50, 20)
      const root = realRoot()
      const files = []
      await walkFiles(root, '', files, { maxFiles: NOTE_SEARCH_MAX_FILES })
      const items = []
      for (const file of files) {
        if (!NP.isEditableName(file.name)) continue
        const stat = await statQuiet(file.abs)
        if (!stat || !stat.isFile()) continue
        let content = ''
        try {
          if (stat.size <= NOTE_SEARCH_MAX_BYTES) {
            content = (await io.readFile(file.abs)).toString('utf8')
          } else {
            const handle = await io.open(file.abs, 'r')
            try {
              const buffer = Buffer.alloc(NOTE_SEARCH_MAX_BYTES)
              const { bytesRead } = await handle.read(buffer, 0, NOTE_SEARCH_MAX_BYTES, 0)
              content = buffer.subarray(0, bytesRead).toString('utf8')
            } finally {
              await handle.close()
            }
          }
        } catch (error) {
          if (error?.code === 'ENOENT') continue
          continue
        }
        const title = file.name.replace(/\.(md|markdown|txt)$/i, '')
        const nameHit = file.name.toLowerCase().includes(needleLower)
        const contentNormalized = content.replace(/\r\n/g, '\n')
        const idx = contentNormalized.toLowerCase().indexOf(needleLower)
        if (!nameHit && idx < 0) continue
        let snippet = ''
        if (idx >= 0) {
          const start = Math.max(0, idx - 40)
          const end = Math.min(contentNormalized.length, idx + needle.length + 60)
          snippet = contentNormalized.slice(start, end).replace(/\s+/g, ' ').trim()
        } else {
          snippet = contentNormalized.slice(0, 100).replace(/\s+/g, ' ').trim()
        }
        items.push({ path: file.rel, title, snippet, mtime: toIso(stat.mtime) })
        if (items.length >= max * 4) break
      }
      items.sort((a, b) => Date.parse(b.mtime ?? 0) - Date.parse(a.mtime ?? 0) || a.path.localeCompare(b.path))
      return { items: items.slice(0, max) }
    },

    /** 手动快照一个文件。 */
    async snapshot(input = {}) {
      const { path: rel } = isPlainObject(input) ? input : {}
      if (typeof rel !== 'string' || rel.trim().length === 0) {
        throw new LifeosError('validation_failed', 'path 必须是非空字符串')
      }
      const resolved = resolve(rel)
      const stat = await statQuiet(resolved.abs)
      if (!stat) throw new LifeosError('not_found', '文件不存在', { path: rel })
      if (!stat.isFile()) throw new LifeosError('validation_failed', 'path 不是文件', { path: rel })
      const raw = await io.readFile(resolved.abs)
      const saved = await createSnapshot(resolved.rel, raw)
      if (!saved) return { snapshotPath: null, mtime: toIso(stat.mtime), enabled: false }
      return saved
    },

    /** 历史快照列表（新→旧）。 */
    async history(input = {}) {
      const { path: rel } = isPlainObject(input) ? input : {}
      if (typeof rel !== 'string' || rel.trim().length === 0) {
        throw new LifeosError('validation_failed', 'path 必须是非空字符串')
      }
      const resolved = resolve(rel)
      const dir = historyDirFor(resolved.rel)
      let dirents = []
      try {
        dirents = await io.readdir(dir.abs, { withFileTypes: true })
      } catch (error) {
        if (error?.code === 'ENOENT') return { items: [] }
        throw wrap(error, 'internal', '读取历史失败')
      }
      const items = []
      for (const entry of dirents) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue
        const abs = path.join(dir.abs, entry.name)
        const stat = await statQuiet(abs)
        if (!stat) continue
        const parsed = NP.parseTimestamp(entry.name)
        items.push({
          id: entry.name,
          at: toIso(parsed ?? stat.mtime),
          size: stat.size,
          snapshotPath: `${dir.rel}/${entry.name}`,
        })
      }
      items.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      return { items }
    },
  }

  return service
}

function normalizeApiPath(rel) {
  const normalized = NP.normalizeRel(rel)
  const segments = normalized.split('/')
  const name = segments.pop()
  const safe = NP.ensureExt(name)
  return [...segments, safe].join('/')
}

function normalizeDirPath(rel) {
  return NP.normalizeRel(rel)
}
