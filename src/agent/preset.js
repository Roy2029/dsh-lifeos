/**
 * LifeOS agent preset 定义（M0）。
 *
 * 契约：`M0-PLAN.md` §3.7 —— Host 行 `await import('./src/agent/preset.js')`
 * 后调用 `ctx.agentPresets.register(lifeosPreset)`，并用 `ctx.effect` 持有 disposer。
 *
 * 形状：`PresetDefinition = { id, name?, description?, order?, plugins: [{ id?, name, config?, disabled? }] }`
 * （`01-平台能力-Host.md` §1.3 / §2.4）。
 *
 * 注意：
 *   - 这里**只挂薄行** `dsh-lifeos/agent`（工具 + 将来 prompt/skill）。
 *   - **不要**在此追加 `dsh-lifeos` 主行：preset 内再挂数据 owner 会二次
 *     `storageDomain.open` / `backend.kv.open` 同名 unit，触发单开约束失败
 *     （`06` §1.4、`01` §4-R7）。
 *   - 本文件由 B（`index.js`）动态 import；同时提供 default 与具名导出，方便
 *     `const mod = await import(...); const preset = mod.lifeosPreset ?? mod.default`。
 */

export const PRESET_ID = 'lifeos'
export const AGENT_ROW_ID = 'lifeos-agent'
export const AGENT_ROW_NAME = 'dsh-lifeos/agent'

export const lifeosPreset = {
  id: PRESET_ID,
  name: 'LifeOS 助手',
  description: '个人管理助理：记录、整理、规划与建议。',
  order: 20,
  plugins: [
    {
      id: AGENT_ROW_ID,
      name: AGENT_ROW_NAME,
    },
  ],
}

export default lifeosPreset
