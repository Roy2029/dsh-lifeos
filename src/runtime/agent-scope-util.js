/** B：agent 判定工具（独立文件，避免 tool-scope 与 services 循环依赖）。 */

/**
 * 是否 lifeos preset 会话。
 *
 * M2 集成修正（2026-11-13）：会话允许中途切换 preset（宿主 `agent-preset/selected`），
 * 因此优先读取「当前已提交的 preset」，而非创建时的 header：
 *   1) `agent.ctx.get('agentPresets').presetForSession(agent.session)`
 *   2) 投影字段 `agent.agentPreset` / `agent.preset`
 *   3) 创建时 header 兜底
 * 异常一律返回 false（P0 隔离 fail-closed）。
 * @param {object|undefined} agent
 */
export function isLifeosAgent(agent) {
  try {
    if (!agent) return false;
    try {
      const ctx = agent.ctx;
      const presets = ctx && typeof ctx.get === 'function' ? ctx.get('agentPresets') : null;
      if (presets && typeof presets.presetForSession === 'function' && agent.session) {
        const current = presets.presetForSession(agent.session);
        if (typeof current === 'string' && current.length > 0) return current === 'lifeos';
      }
    } catch {
      /* fall through */
    }
    if (typeof agent?.agentPreset === 'string') return agent.agentPreset === 'lifeos';
    if (typeof agent?.preset === 'string') return agent.preset === 'lifeos';
    const header = agent?.session?.header;
    if (header && typeof header.agentPreset === 'string') return header.agentPreset === 'lifeos';
    return false;
  } catch {
    return false;
  }
}
