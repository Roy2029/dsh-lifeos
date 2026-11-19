/**
 * LifeOS Agent 工具名单一来源（M2 P0 隔离）。
 *
 * 为什么单独成文件：
 *   - D 线（本文件 + tools.js）用它在注册层做 `when` 门控与诊断；
 *   - B 线（`src/runtime/tool-scope.js`）用同一个常量对非 lifeos 会话做
 *     `agent.ctx.tools.restrict({ deny: LIFEOS_TOOL_NAMES })`（M2-PLAN §1 第 2 层）。
 *   两边必须引用同一份常量，避免"收紧的名字和注册的名字不一致"导致隔离漏洞。
 *
 * 契约：`M2-PLAN.md` §1 / §4。**新增工具必须同时改这里与 tools.js 的注册列表。**
 * 零 `@deepseek-ai/*` import、零第三方依赖。
 */

/** 所有暴露给模型的 LifeOS 工具名；顺序即注册顺序。M4 起 10 个。 */
export const LIFEOS_TOOL_NAMES = [
  'lifeos_today',
  'lifeos_capture',
  'lifeos_task',
  'lifeos_triage',
  'lifeos_correct',
  'lifeos_notes',
  'lifeos_settings',
  'lifeos_habit',
  'lifeos_project',
  'lifeos_goal',
]

/** 只有该 preset 的会话允许看到/调用 LifeOS 工具（P0 隔离的唯一判据）。 */
export const LIFEOS_PRESET_ID = 'lifeos'

/** 工具名前缀，供 B 线做兜底前缀过滤（正常路径用 LIFEOS_TOOL_NAMES）。 */
export const LIFEOS_TOOL_PREFIX = 'lifeos_'

/**
 * 判定 agent 是否属于 lifeos preset 会话；异常/无 header 返回 false（P0 隔离必须 fail-closed）。
 *
 * M2 集成修正（2026-11-13）：**会话允许中途切换 preset**（宿主有 `agent-preset/selected` 事件），
 * 因此判据必须是「当前已提交的 preset」，不能只看创建时的 `session.header.agentPreset`。
 * 优先用宿主 `agentPresets.presetForSession(session)`（读持久化选择），再回退投影字段/header。
 */
export function isLifeosAgent(agent) {
  try {
    if (!agent) return false
    // 1) 当前已提交的 preset（支持会话中途切换）
    try {
      const ctx = agent.ctx
      const presets = ctx && typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
      if (presets && typeof presets.presetForSession === 'function' && agent.session) {
        const current = presets.presetForSession(agent.session)
        if (typeof current === 'string' && current.length > 0) return current === LIFEOS_PRESET_ID
      }
    } catch {
      /* 回退到投影字段 */
    }
    // 2) 宿主对 agent 的投影字段
    if (typeof agent?.agentPreset === 'string') return agent.agentPreset === LIFEOS_PRESET_ID
    if (typeof agent?.preset === 'string') return agent.preset === LIFEOS_PRESET_ID
    // 3) 创建时 header 兜底
    const header = agent?.session?.header
    if (header && typeof header.agentPreset === 'string') return header.agentPreset === LIFEOS_PRESET_ID
    return false
  } catch {
    return false
  }
}

export default LIFEOS_TOOL_NAMES
