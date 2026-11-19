/**
 * B：A 线实现的动态装载器（集成者职责）。
 *
 * M0-PLAN §3.4 只冻结 `LifeosStore` 接口；`openLifeosStore` 的模块路径由 A 决定。
 * 为了避免 B 与 A 互相阻塞，这里按候选路径动态 import：
 *   1) src/store/lifeos-store.js
 *   2) src/store/index.js
 *   3) src/store/kv.js
 * 找到先导出的 `openLifeosStore`（或 default.openLifeosStore）即调用；全部失败
 * 则返回降级内存 store，并记录到诊断（G2 fail），插件保持激活（G6）。
 *
 * 约定调用形态：`openLifeosStore(ctx, { config, diagnostics, units, logger })`
 * （A 若用 `(ctx, config)` 也兼容，第二个参数是同一对象）。
 */

import { createMemoryStore } from './memory-store.js';

export const STORE_CANDIDATES = [
  '../store/lifeos-store.js',
  '../store/index.js',
  '../store/kv.js',
];

export const IDS_CANDIDATES = ['../domain/ids.js'];

const DEFAULT_UNITS = Object.freeze({
  core: 'lifeos',
  raw: 'lifeos_raw',
  log: 'lifeos_log',
});

function pickOpenFn(mod) {
  if (!mod) return null;
  if (typeof mod.openLifeosStore === 'function') return mod.openLifeosStore;
  if (mod.default && typeof mod.default.openLifeosStore === 'function') return mod.default.openLifeosStore;
  if (typeof mod.default === 'function' && mod.default.name === 'openLifeosStore') return mod.default;
  return null;
}

/** store.backend 可能是对象（A 的实现），统一成后端名用于诊断。 */
function backendNameOf(store) {
  if (store && typeof store.backendName === 'string' && store.backendName.length > 0) return store.backendName;
  if (store && typeof store.backend === 'string' && store.backend.length > 0) return store.backend;
  if (store && store.backend && typeof store.backend.name === 'string') return store.backend.name;
  return 'kv';
}

/**
 * @param {object} ctx Cordis 插件上下文（只读取 storage；不 open 别的 unit）
 * @param {object} options {config, diagnostics, logger}
 * @returns {Promise<{store:object, backend:string, source:string, error:Error|null, ids:{newId?:Function}|null}>}
 */
export async function loadLifeosStore(ctx, options = {}) {
  const diagnostics = options.diagnostics;
  const config = options.config || {};
  const units = { ...DEFAULT_UNITS, ...(config.units || {}) };
  const logger = options.logger || (() => {});
  let lastError = null;

  for (const spec of STORE_CANDIDATES) {
    let mod;
    try {
      mod = await import(spec);
    } catch (error) {
      lastError = error;
      continue;
    }
    const openFn = pickOpenFn(mod);
    if (!openFn) continue;
    try {
      // A 的 openLifeosStore(ctx, options) 读取 options.timeZone / backend / testMode 等；
      // 这里把 config 的顶层字段摊平，同时保留完整 config 供未来扩展。
      const store = await openFn(ctx, {
        timeZone: config.timeZone,
        ...config,
        config,
        diagnostics,
        units,
        logger,
      });
      if (!store || typeof store.get !== 'function' || typeof store.transaction !== 'function') {
        throw new Error('openLifeosStore 返回的对象不符合 LifeosStore 契约');
      }
      return {
        store,
        backend: backendNameOf(store),
        source: spec,
        error: null,
        ids: await loadIds(),
      };
    } catch (error) {
      lastError = error;
      diagnostics?.recordError?.('store_open_failed', `store 打开失败（${spec}）：${error.message}`, {
        spec,
        source: error.code || null,
      });
    }
  }

  const reason = lastError ? `${lastError.code || ''} ${lastError.message}`.trim() : 'A 线 store 模块尚未提供';
  diagnostics?.recordError?.('store_unavailable', `存储降级为内存只读：${reason}`, {
    candidates: STORE_CANDIDATES,
  });
  return {
    store: createMemoryStore({ reason, backend: 'memory', unitNames: Object.values(units) }),
    backend: 'memory',
    source: null,
    error: lastError || new Error(reason),
    ids: await loadIds(),
  };
}

async function loadIds() {
  for (const spec of IDS_CANDIDATES) {
    try {
      const mod = await import(spec);
      if (typeof mod.newId === 'function') {
        return { newId: mod.newId, source: spec, sha256Hex: typeof mod.sha256Hex === 'function' ? mod.sha256Hex : null };
      }
    } catch {
      /* 继续尝试下一个候选 */
    }
  }
  return null;
}

export async function loadAgentPreset() {
  for (const spec of ['../agent/preset.js', '../agent/preset.mjs']) {
    try {
      const mod = await import(spec);
      const preset = mod.preset || mod.lifeosPreset || mod.definition || mod.default;
      if (preset && typeof preset === 'object' && typeof preset.id === 'string') {
        return { preset, source: spec, error: null };
      }
      return { preset: null, source: spec, error: new Error('preset 模块未导出合法 PresetDefinition') };
    } catch (error) {
      if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) continue;
      return { preset: null, source: spec, error };
    }
  }
  return { preset: null, source: null, error: new Error('D 线 preset 模块尚未提供') };
}
