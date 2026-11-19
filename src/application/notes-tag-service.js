/**
 * M6：笔记标签（Host 侧）。
 *
 * 契约：M6-PLAN §1-6 —— 笔记标签存在 app_setting['notes.tags'] 的 JSON 里
 * `{ version: 1, tags: { "<note path>": ["tag", ...] } }`，不改笔记文件/路径。
 * 端点：GET/PUT /notes/tags、POST /notes/tags/batch（routes-m6.js）。
 *
 * 原则：写走 store.transaction（journal-first）+ operation_log 审计；CAS 可选
 * （expectedRev = app_setting 记录 rev）；标签只做元数据，不触碰 note-service。
 */

import { LifeosError } from './errors.js';

const CORE = 'lifeos';
const LOG = 'lifeos_log';
const SETTING = 'app_setting';
const KEY = 'notes.tags';
const VALUE_VERSION = 1;
const MAX_PATH_CHARS = 1024;
const MAX_TAG_CHARS = 50;
const MAX_TAGS_PER_NOTE = 32;
const MAX_TOTAL_BYTES = 256 * 1024;

function iso(ms) {
  return new Date(ms).toISOString();
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePath(path) {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new LifeosError('validation_failed', '笔记路径必须是非空字符串', { errors: ['path 必填'] });
  }
  const value = path.trim();
  if (value.length > MAX_PATH_CHARS) {
    throw new LifeosError('validation_failed', '笔记路径过长', { errors: [`path ≤ ${MAX_PATH_CHARS}`] });
  }
  return value;
}

function normalizeTagList(tags) {
  if (!Array.isArray(tags)) {
    throw new LifeosError('validation_failed', 'tags 必须是数组', { errors: ['tags 必须是数组'] });
  }
  const output = [];
  const seen = new Set();
  for (const raw of tags) {
    if (typeof raw !== 'string') {
      throw new LifeosError('validation_failed', '标签必须是字符串', { errors: ['标签必须是字符串'] });
    }
    const tag = raw.trim();
    if (tag.length === 0) continue;
    if (tag.length > MAX_TAG_CHARS) {
      throw new LifeosError('validation_failed', '标签过长', { errors: [`标签 ≤ ${MAX_TAG_CHARS}`] });
    }
    if (seen.has(tag)) continue;
    seen.add(tag);
    output.push(tag);
  }
  if (output.length > MAX_TAGS_PER_NOTE) {
    throw new LifeosError('validation_failed', '单条笔记标签过多', { errors: [`标签数 ≤ ${MAX_TAGS_PER_NOTE}`] });
  }
  return output;
}

function normalizeTagMap(input) {
  if (!isPlainObject(input)) {
    throw new LifeosError('validation_failed', 'tags 必须是 {路径: [标签]} 对象', { errors: ['tags 必须是对象'] });
  }
  const output = {};
  for (const [rawPath, tags] of Object.entries(input)) {
    const path = normalizePath(rawPath);
    const list = normalizeTagList(tags);
    if (list.length > 0) output[path] = list;
  }
  const bytes = Buffer.byteLength(JSON.stringify(output), 'utf8');
  if (bytes > MAX_TOTAL_BYTES) {
    throw new LifeosError('validation_failed', '标签总量过大', { errors: [`总大小 ≤ ${MAX_TOTAL_BYTES} 字节`] });
  }
  return output;
}

/**
 * @param {object} deps
 * @param {object} deps.store LifeosStore
 * @param {()=>number} deps.now
 * @param {(kind:string, ids:string[], extra?:object)=>void} deps.emitChanged
 * @param {(prefix?:string)=>string} deps.newId
 * @param {string} [deps.actorType='user']
 */
export function createNotesTagOps(deps = {}) {
  const { store, now, emitChanged, newId } = deps;
  const actorType = deps.actorType || 'user';

  function readRecord() {
    try {
      const record = store.get(CORE, SETTING, KEY);
      if (record && isPlainObject(record.value_json) && isPlainObject(record.value_json.tags)) {
        return {
          tags: record.value_json.tags,
          version: record.value_json.version ?? VALUE_VERSION,
          rev: record.rev ?? 1,
        };
      }
    } catch {
      /* degraded / missing */
    }
    return { tags: {}, version: VALUE_VERSION, rev: 0 };
  }

  function assertWritable() {
    if (store.degraded === true) throw new LifeosError('store_unavailable', '存储不可用（只读降级）');
  }

  function oplogRecord({ action, paths, before, after, nowIso }) {
    return {
      id: newId('opl'),
      actor_type: actorType,
      actor_ref: null,
      action,
      target_type: SETTING,
      target_id: KEY,
      target_ids_json: paths,
      permission_id: null,
      permission_level: 'L2',
      decision: 'allowed',
      status: 'applied',
      before_json: before ?? null,
      after_json: after ?? null,
      diff_json: null,
      state_change_ids: [],
      evidence_refs: [],
      undo_of_id: null,
      reversible: true,
      undo_patch_json: null,
      reason: null,
      idempotency_key: null,
      occurred_at: nowIso,
      duration_ms: null,
      error: null,
      meta_json: { source: 'm6' },
    };
  }

  function writeTags(tags, { expectedRev, action, before, after, idempotencyKey } = {}) {
    assertWritable();
    const current = readRecord();
    if (expectedRev !== undefined && expectedRev !== null) {
      if (!Number.isInteger(expectedRev) || expectedRev < 1) {
        throw new LifeosError('validation_failed', 'expectedRev 必须是正整数', { errors: ['expectedRev 非法'] });
      }
      if (current.rev !== expectedRev) {
        throw new LifeosError('conflict', '笔记标签已被修改，请刷新后重试', {
          currentRev: current.rev,
          expectedRev,
        });
      }
    }
    const nowIso = iso(now());
    const value = { version: VALUE_VERSION, tags };
    const record = { key: KEY, id: KEY, value_json: value, updated_at: nowIso, rev: current.rev + 1 };
    const oplog = oplogRecord({ action: action ?? 'notes.tags.update', paths: Object.keys(tags), before, after, nowIso });
    if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0) oplog.idempotency_key = idempotencyKey;
    return store
      .transaction([
        { unit: CORE, table: SETTING, key: KEY, value: record },
        { unit: LOG, table: 'operation_log', key: oplog.id, value: oplog },
      ])
      .then(() => {
        emitChanged('notes_tags', Object.keys(tags), { action: action ?? 'notes.tags.update' });
        return { tags, version: VALUE_VERSION, rev: current.rev + 1 };
      });
  }

  function getNotesTags() {
    const current = readRecord();
    return { tags: current.tags, version: current.version, rev: current.rev };
  }

  function putNotesTags(input = {}) {
    const tags = normalizeTagMap(input.tags);
    const expectedRev = input.expectedRev !== undefined ? input.expectedRev : input.rev;
    return writeTags(tags, {
      expectedRev,
      action: 'notes.tags.put',
      before: undefined,
      after: { paths: Object.keys(tags) },
      idempotencyKey: input.idempotencyKey,
    });
  }

  function batchNotesTags(input = {}) {
    const current = readRecord();
    const next = { ...current.tags };
    const updates = input.updates === undefined ? [] : input.updates;
    const removePaths = input.removePaths === undefined ? [] : input.removePaths;
    if (!Array.isArray(updates)) throw new LifeosError('validation_failed', 'updates 必须是数组', { errors: ['updates 必须是数组'] });
    if (!Array.isArray(removePaths)) throw new LifeosError('validation_failed', 'removePaths 必须是数组', { errors: ['removePaths 必须是数组'] });
    const updatedPaths = [];
    for (const item of updates) {
      if (!isPlainObject(item)) throw new LifeosError('validation_failed', 'updates 项必须是 {path, tags}', { errors: ['updates 项非法'] });
      const path = normalizePath(item.path);
      const list = normalizeTagList(item.tags);
      if (list.length > 0) next[path] = list;
      else delete next[path];
      updatedPaths.push(path);
    }
    for (const rawPath of removePaths) {
      const path = normalizePath(rawPath);
      delete next[path];
      updatedPaths.push(path);
    }
    if (updatedPaths.length === 0) {
      return Promise.resolve({ tags: current.tags, version: current.version, rev: current.rev, updatedPaths: [] });
    }
    const totalBytes = Buffer.byteLength(JSON.stringify(next), 'utf8');
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new LifeosError('validation_failed', '标签总量过大', { errors: [`总大小 ≤ ${MAX_TOTAL_BYTES} 字节`] });
    }
    const expectedRev = input.expectedRev !== undefined ? input.expectedRev : input.rev;
    return writeTags(next, {
      expectedRev,
      action: 'notes.tags.batch',
      before: undefined,
      after: { paths: updatedPaths },
      idempotencyKey: input.idempotencyKey,
    }).then((result) => ({ ...result, updatedPaths }));
  }

  return { getNotesTags, putNotesTags, batchNotesTags, _internals: { readRecord } };
}

export default createNotesTagOps;
