/**
 * B：P0 工具可见性隔离（M2-PLAN §1 根行限制层）。
 *
 * 目标：`lifeos_*` 工具只允许 `lifeos` preset 会话使用；其它会话在根行层面
 * 用 `agent.ctx.tools.restrict({ deny: [...] })` 收窄可见集合。
 *
 * 与注册层（D 的 `when: isLifeosAgent`）形成两层防御：
 *  - 注册层决定"工具是否出现在目录"（按会话）；
 *  - 根行限制层在工具服务上对该 agent 做 deny（intersect，不可扩权）。
 *
 * 约束：
 *  - 不 import `@deepseek-ai/*`；只用 ctx 服务；
 *  - 每个 agent 的 restrict 注册挂在 `agent.ctx.effect` 下（会话销毁自动回收），
 *    同时把 disposer 收进本模块，插件卸载时主动释放；
 *  - 监听 `agent/created` + 启动扫描 `ctx.agents.roots()` 补挂已存在会话
 *    （参考 dsh-persistent-character/src/runtime/agent-scope.js）。
 */

import { isLifeosAgent } from './agent-scope-util.js';

export { isLifeosAgent };

const FALLBACK_LIFEOS_TOOLS = Object.freeze([
  'lifeos_today',
  'lifeos_capture',
  'lifeos_task',
  'lifeos_triage',
  'lifeos_correct',
]);

/** 单一来源优先 D 的 `src/agent/tool-names.js`；缺失时用 M2-PLAN 常量并可由 Lead 复核。 */
let toolNamesModule = null;
try {
  const mod = await import('../agent/tool-names.js');
  if (mod) toolNamesModule = mod;
} catch {
  toolNamesModule = null;
}

function resolveToolNames(mod) {
  if (!mod) return [...FALLBACK_LIFEOS_TOOLS];
  const candidate =
    mod.LIFEOS_TOOL_NAMES ||
    mod.TOOL_NAMES ||
    (Array.isArray(mod.default) ? mod.default : null) ||
    (Array.isArray(mod.lifeosTools) ? mod.lifeosTools : null);
  if (Array.isArray(candidate) && candidate.length > 0) return [...new Set(candidate.map(String))];
  if (typeof mod.getLifeosToolNames === 'function') {
    try {
      const list = mod.getLifeosToolNames();
      if (Array.isArray(list) && list.length > 0) return [...new Set(list.map(String))];
    } catch {
      /* fallback */
    }
  }
  return [...FALLBACK_LIFEOS_TOOLS];
}

export const LIFEOS_TOOL_NAMES = Object.freeze(resolveToolNames(toolNamesModule));

/** 判定函数优先用 D 的单一来源；缺失时用本地 agent-scope-util（同口径 fail-closed）。 */
const resolveIsLifeosAgent = () => {
  const external = toolNamesModule && typeof toolNamesModule.isLifeosAgent === 'function' ? toolNamesModule.isLifeosAgent : null;
  if (!external) return isLifeosAgent;
  return (agent) => {
    try {
      return external(agent) === true;
    } catch {
      return false;
    }
  };
};
const isLifeosAgentForScope = resolveIsLifeosAgent();
export const USING_EXTERNAL_TOOL_NAMES = Boolean(toolNamesModule);

function getService(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(name);
    return ctx ? ctx[name] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 安装根行工具隔离。
 * @param {object} ctx Cordis 插件上下文
 * @param {{toolNames?: string[], logger?: object, agentService?: object}} [options]
 * @returns {{dispose: Function, stats: Function, lifeosToolNames: string[], restrictedAgentIds: string[]}}
 */
export function installToolScope(ctx, options = {}) {
  const toolNames = [...(options.toolNames || LIFEOS_TOOL_NAMES)];
  const logger = options.logger || { warn() {}, info() {} };
  const agentService = options.agentService || getService(ctx, 'agents');
  /** agentId -> disposer（restrict） */
  const restricted = new Map();
  /** agentId -> 'lifeos'（跳过） */
  const allowedLifeos = new Set();
  /** agentId -> agent；sessionId -> agentId（用于 preset 切换后重算） */
  const agentsById = new Map();
  const agentIdBySession = new Map();
  /** 记录 preset 切换事件，便于诊断 */
  const presetEvents = [];
  const errors = [];

  function detach(agentId) {
    const disposer = restricted.get(agentId);
    if (typeof disposer === 'function') {
      try {
        disposer();
      } catch {
        /* ignore */
      }
    }
    restricted.delete(agentId);
  }

  /**
   * 按 agent「当前已提交的 preset」决定是否收窄工具。
   * 会话允许中途切换 preset（宿主 `agent-preset/selected` 事件）：切到 lifeos 时
   * 必须撤销之前的 restrict，切走时再重新施加。
   */
  function evaluate(agent) {
    const agentId = agent && typeof agent.id === 'string' ? agent.id : null;
    if (!agentId || !agent.ctx) return { applied: false, reason: 'no-agent-ctx' };
    if (isLifeosAgentForScope(agent)) {
      detach(agentId);
      allowedLifeos.add(agentId);
      return { applied: false, reason: 'lifeos-agent' };
    }
    allowedLifeos.delete(agentId);
    if (restricted.has(agentId)) return { applied: false, reason: 'already-restricted' };
    const tools = getService(agent.ctx, 'tools');
    if (!tools || typeof tools.restrict !== 'function') {
      return { applied: false, reason: 'no-tools-service' };
    }
    try {
      const register = () => tools.restrict({ deny: toolNames });
      let disposer;
      if (typeof agent.ctx.effect === 'function') {
        disposer = agent.ctx.effect(() => register(), 'lifeos.tool-scope');
      } else {
        disposer = register();
      }
      restricted.set(agentId, typeof disposer === 'function' ? disposer : null);
      return { applied: true };
    } catch (error) {
      errors.push({ agentId, message: String(error?.message || error) });
      return { applied: false, reason: 'restrict-failed', error };
    }
  }

  function attach(agent) {
    const agentId = agent && typeof agent.id === 'string' ? agent.id : null;
    if (!agentId || !agent.ctx) return { applied: false, reason: 'no-agent-ctx' };
    agentsById.set(agentId, agent);
    const sessionId = agent?.session?.id;
    if (typeof sessionId === 'string') agentIdBySession.set(sessionId, agentId);
    return evaluate(agent);
  }

  // 启动扫描：插件加载前已存在的根会话不会再触发 agent/created
  const scanned = [];
  try {
    const roots = typeof agentService?.roots === 'function' ? agentService.roots() : [];
    for (const agent of Array.isArray(roots) ? roots : []) {
      const result = attach(agent);
      scanned.push({
        agentId: agent?.id ?? null,
        applied: result.applied,
        reason: result.reason,
      });
    }
  } catch (error) {
    errors.push({ agentId: null, message: `startup-scan-failed: ${String(error?.message || error)}` });
  }

  // 新会话
  let offCreated = null;
  if (ctx && typeof ctx.on === 'function') {
    try {
      offCreated = ctx.on('agent/created', (payload) => {
        try {
          attach(payload?.agent);
        } catch (error) {
          errors.push({ agentId: payload?.agent?.id ?? null, message: String(error?.message || error) });
        }
      });
    } catch (error) {
      errors.push({ agentId: null, message: `listen-failed: ${String(error?.message || error)}` });
    }
  }
  // preset 切换：会话可从 standard 切到 lifeos（用户实测路径），必须动态撤销/重新施加 restrict
  let offPreset = null;
  if (ctx && typeof ctx.on === 'function') {
    try {
      offPreset = ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
        try {
          presetEvents.push({ sessionId: String(sessionId), agentPreset: String(agentPreset), at: Date.now() });
          const agentId = agentIdBySession.get(String(sessionId));
          const agent = agentId ? agentsById.get(agentId) : null;
          if (agent) evaluate(agent);
        } catch (error) {
          errors.push({ agentId: null, message: `preset-listener-failed: ${String(error?.message || error)}` });
        }
      });
    } catch (error) {
      errors.push({ agentId: null, message: `preset-listen-failed: ${String(error?.message || error)}` });
    }
  }

  // 会话销毁时清理记录（restrict 由 agent.ctx.effect 自动回收）
  let offDisposed = null;
  if (ctx && typeof ctx.on === 'function') {
    try {
      offDisposed = ctx.on('agent/disposed', (payload) => {
        const agentId = payload?.agent?.id;
        if (agentId) {
          restricted.delete(agentId);
          allowedLifeos.delete(agentId);
          agentsById.delete(agentId);
          for (const [sessionId, mapped] of agentIdBySession) {
            if (mapped === agentId) agentIdBySession.delete(sessionId);
          }
        }
      });
    } catch {
      /* agent/disposed 可能不可用：不影响主流程 */
    }
  }

  let disposed = false;
  return {
    lifeosToolNames: [...toolNames],
    restrictedAgentIds: () => [...restricted.keys()],
    allowedLifeosAgents: () => [...allowedLifeos],
    scanned,
    errors: () => [...errors],
    stats: () => ({
      toolNames: [...toolNames],
      restrictedCount: restricted.size,
      allowedLifeosCount: allowedLifeos.size,
      scanned,
      presetEvents: [...presetEvents],
      errors: [...errors],
      source: USING_EXTERNAL_TOOL_NAMES ? 'tool-names.js' : 'm2-plan-fallback',
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        if (typeof offCreated === 'function') offCreated();
      } catch {
        /* ignore */
      }
      try {
        if (typeof offPreset === 'function') offPreset();
      } catch {
        /* ignore */
      }
      try {
        if (typeof offDisposed === 'function') offDisposed();
      } catch {
        /* ignore */
      }
      for (const agentId of [...restricted.keys()]) detach(agentId);
      allowedLifeos.clear();
      agentsById.clear();
      agentIdBySession.clear();
      logger.info?.(`[lifeos] tool-scope disposed（restricted=${restricted.size}）`);
    },
  };
}
