/**
 * B：M2.5 笔记目录文件监听（M2.5-PLAN §2.2 / §3 / §8）。
 *
 *  - `fs.watch(root, {recursive:true})` + 500ms debounce + 去重；
 *  - 忽略 `.lifeos-history` / `.trash` / `.git` / `node_modules` / 临时文件 / 非笔记扩展名；
 *  - 事件归一为 `{path, kind:'add'|'change'|'unlink', at}`（path 为相对 root 的 / 分隔路径）；
 *  - watch 不可用（平台不支持 recursive / root 暂不存在）→ 15s 轮询兜底；
 *  - root 变化 `updateRoot(next)` 自动重建；`stop()` 清理。
 *
 * `known` 是"上次已广播/已建立基线"的 path→meta；enqueue/flush 都基于它判断
 * add/change，避免 Windows 上创建文件先触发两次 rename 导致 add 被覆盖成 change。
 */

import fsDefault from 'node:fs';
import pathDefault from 'node:path';

import { NOTE_EXTENSIONS } from '../client-shared/contract.js';

const IGNORED_DIR_RE = /(^|\/)(\.lifeos-history|\.trash|\.git|node_modules|\.dsh)(\/|$)/i;
const TEMP_FILE_RE = /(^|\/)(~\$|\.#|#.*#$|.*\.(tmp|swp|swx|part|bak)$|\.DS_Store$|Thumbs\.db$)/i;
const MAX_WALK_DEPTH = 8;

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function isManagedPath(relPath) {
  const value = toPosix(relPath);
  if (!value) return false;
  if (IGNORED_DIR_RE.test(`/${value}`)) return false;
  if (TEMP_FILE_RE.test(`/${value}`)) return false;
  const lower = value.toLowerCase();
  return NOTE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * @param {object} options
 * @param {string} options.root
 * @param {(change:{path:string,kind:'add'|'change'|'unlink',at:string})=>void} options.onChange
 * @param {object} [options.logger]
 * @param {number} [options.debounceMs=500]
 * @param {number} [options.pollMs=15000]
 * @param {boolean} [options.forcePolling=false]
 * @param {object} [options.fs]
 * @param {object} [options.path]
 * @param {()=>number} [options.now]
 */
export function startNoteWatch(options = {}) {
  const fs = options.fs || fsDefault;
  const path = options.path || pathDefault;
  const logger = options.logger || { info() {}, warn() {}, error() {} };
  const debounceMs = Number.isFinite(options.debounceMs) && options.debounceMs >= 0 ? options.debounceMs : 500;
  const pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : 15000;
  const forcePolling = options.forcePolling === true;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  let root = typeof options.root === 'string' ? options.root : '';
  let watcher = null;
  let debounceTimer = null;
  let pollTimer = null;
  let stopped = false;
  let mode = 'idle';
  const pending = new Map(); // relPath -> kind（去抖窗口内合并）
  const known = new Map(); // 已广播/基线：relPath -> {mtimeMs,size}
  const errors = [];
  const stats = { emitted: 0, ignored: 0, scans: 0, rebuilds: 0 };

  function emit(relPath, kind) {
    const change = { path: toPosix(relPath), kind, at: new Date(now()).toISOString() };
    try {
      options.onChange?.(change);
      stats.emitted += 1;
    } catch (error) {
      logger.error?.(`[note-watch] onChange 失败：${error?.message || error}`);
    }
    return change;
  }

  function walk(dir, base, depth, out) {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (IGNORED_DIR_RE.test(`/${rel}`) || TEMP_FILE_RE.test(`/${rel}`)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel, depth + 1, out);
      } else if (entry.isFile() && isManagedPath(rel)) {
        try {
          const stat = fs.statSync(full);
          out.set(toPosix(rel), { mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {
          /* 文件在扫描中消失：忽略，留给下轮 unlink */
        }
      }
    }
  }

  function snapshotFiles() {
    const out = new Map();
    if (!root) return out;
    walk(root, '', 1, out);
    return out;
  }

  function statOf(relPath) {
    try {
      return fs.statSync(path.join(root, relPath));
    } catch {
      return null;
    }
  }

  function resolveKind(relPath) {
    const stat = statOf(relPath);
    if (!stat) return 'unlink';
    return known.has(relPath) ? 'change' : 'add';
  }

  /** 轮询：对比 known 与磁盘快照；emit + 更新 known。 */
  function scanOnce({ silent = false } = {}) {
    if (!root) return [];
    stats.scans += 1;
    const current = snapshotFiles();
    const changes = [];
    for (const [relPath, meta] of current) {
      const prev = known.get(relPath);
      if (!prev) changes.push({ path: relPath, kind: 'add' });
      else if (prev.mtimeMs !== meta.mtimeMs || prev.size !== meta.size) changes.push({ path: relPath, kind: 'change' });
    }
    for (const relPath of known.keys()) {
      if (!current.has(relPath)) changes.push({ path: relPath, kind: 'unlink' });
    }
    known.clear();
    for (const [relPath, meta] of current) known.set(relPath, meta);
    if (!silent) for (const change of changes) emit(change.path, change.kind);
    return changes;
  }

  function flush() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    const queued = [...pending.entries()];
    pending.clear();
    const emitted = [];
    for (const [relPath, queuedKind] of queued) {
      const kind = queuedKind === 'unlink' ? 'unlink' : resolveKind(relPath);
      if (kind === 'unlink') known.delete(relPath);
      else {
        const stat = statOf(relPath);
        if (stat) known.set(relPath, { mtimeMs: stat.mtimeMs, size: stat.size });
      }
      emitted.push(emit(relPath, kind));
    }
    return emitted;
  }

  function scheduleFlush() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        flush();
      } catch (error) {
        logger.error?.(`[note-watch] flush 失败：${error?.message || error}`);
      }
    }, debounceMs);
    if (debounceTimer && typeof debounceTimer.unref === 'function') debounceTimer.unref();
  }

  function enqueue(relPath, eventType) {
    const rel = toPosix(relPath);
    if (!rel || !isManagedPath(rel)) {
      stats.ignored += 1;
      return;
    }
    const kind = eventType === 'rename' && !statOf(rel) ? 'unlink' : null;
    if (pending.has(rel)) {
      // 同窗口内 add 优先于 change；unlink 最终态优先
      if (kind === 'unlink') pending.set(rel, 'unlink');
      return;
    }
    pending.set(rel, kind || (known.has(rel) ? 'change' : 'add'));
    scheduleFlush();
  }

  function clearTimers() {
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
      watcher = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    pending.clear();
  }

  function startPolling() {
    mode = 'poll';
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (stopped) return;
      try {
        scanOnce();
      } catch (error) {
        logger.warn?.(`[note-watch] 轮询失败：${error?.message || error}`);
      }
    }, pollMs);
    if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  function start() {
    clearTimers();
    known.clear();
    if (!root) {
      mode = 'idle';
      return;
    }
    try {
      if (!fs.existsSync(root)) throw new Error('笔记目录不存在');
    } catch (error) {
      mode = 'idle';
      errors.push(String(error?.message || error));
      logger.warn?.(`[note-watch] 启动失败（${root}）：${error?.message || error}`);
      return;
    }
    // 基线（不广播已有文件）
    const baseline = snapshotFiles();
    for (const [relPath, meta] of baseline) known.set(relPath, meta);

    if (forcePolling) {
      startPolling();
      return;
    }
    mode = 'watch';
    try {
      watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
        if (stopped || !filename) return;
        try {
          enqueue(typeof filename === 'string' ? filename : String(filename), eventType);
        } catch (error) {
          logger.warn?.(`[note-watch] 事件处理失败：${error?.message || error}`);
        }
      });
      watcher.on?.('error', (error) => {
        errors.push(String(error?.message || error));
        logger.warn?.(`[note-watch] fs.watch 出错，降级轮询：${error?.message || error}`);
        if (watcher) {
          try {
            watcher.close();
          } catch {
            /* ignore */
          }
          watcher = null;
        }
        startPolling();
      });
    } catch (error) {
      errors.push(String(error?.message || error));
      logger.warn?.(`[note-watch] fs.watch 不可用，降级轮询：${error?.message || error}`);
      startPolling();
    }
  }

  function updateRoot(nextRoot) {
    const next = typeof nextRoot === 'string' ? nextRoot : '';
    if (next === root && (mode === 'watch' || mode === 'poll')) return { root, rebuilt: false, mode };
    root = next;
    stats.rebuilds += 1;
    if (stopped) return { root, rebuilt: false, mode: 'stopped' };
    start();
    return { root, rebuilt: true, mode };
  }

  function stop() {
    stopped = true;
    clearTimers();
    mode = 'stopped';
  }

  start();

  return {
    stop,
    flush,
    scanOnce,
    updateRoot,
    getRoot: () => root,
    getMode: () => mode,
    isManagedPath,
    stats: () => ({ ...stats, mode, root, tracked: known.size, pending: pending.size, errors: [...errors] }),
  };
}

export { isManagedPath };
