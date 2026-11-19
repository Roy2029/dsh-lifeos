/**
 * LifeOS preset 薄行入口（M0 → M2）。
 *
 * 契约：`M0-PLAN.md` §3.7、`M2-PLAN.md` §1（P0 工具隔离）/§4（整理守则）。
 *
 * 实测修正（`design/11-M0技术验证报告.md` §G3 + M0 集成首装日志）：
 *   1) 薄行必须 `export const inject = ['tools']`，否则 `ctx.tools` 不可用；
 *   2) **薄行还必须 inject `lifeos` 服务**：Host 行在 `apply()` 内 `ctx.provide('lifeos', svc)`，
 *      该服务只有在 Host fiber 激活（apply 返回）后才对依赖者可见；若薄行不声明 inject，
 *      Cordis 会立即激活薄行 → `ctx.get('lifeos')` 为空 → 工具不注册。
 *   3) **M2 追加 inject `systemPrompt`**：薄行要在 preset 平面注入"整理守则"；
 *      不声明 inject 时 `ctx.systemPrompt` 不可用。
 *
 * P0 工具隔离（M2-PLAN §1 第 1 层）：工具注册全部带
 *   `{ when: (activation) => isLifeosAgent(activation?.agent) }`（见 src/agent/tools.js），
 * 非 `lifeos` preset 会话看不到/调不到 `lifeos_*`。
 * 第 2 层（根行 restrict）由 B 的 `src/runtime/tool-scope.js` 用同一份
 * `src/agent/tool-names.js` 常量实现。
 *
 * 边界（`06-Agent系统设计.md` §1.4 / §4-R7）：
 *   - 薄行只注册"面向模型"的工具与 prompt，**不打开 storage unit**、不提供 Host 服务；
 *     数据面只有 `ctx.lifeos`（Host 行 provide）。
 *   - prompt 只注册在 preset 平面的 `ctx.systemPrompt.section`，**不碰插件根 ctx**。
 *   - 零 `@deepseek-ai/*` import、零第三方依赖。
 */
import { writeFileSync, mkdirSync } from 'node:fs'

import { registerTools } from './src/agent/tools.js'
import { LIFEOS_TOOL_NAMES } from './src/agent/tool-names.js'
import { ORGANIZE_RULES, ORGANIZE_RULES_ORDER, ORGANIZE_RULES_SECTION_NAME } from './src/agent/preset-prompt.js'

export const name = 'lifeos-agent'

/** 等 Host 的 `lifeos` 服务与宿主 prompt 能力可用后再激活。 */
export const inject = ['tools', 'lifeos', 'systemPrompt']

const MARKER_PATH = process.env.LIFEOS_AGENT_MARKER_PATH || 'D:\\个人\\dsh-lifeos\\runtime-agent-marker.json'

/**
 * 单测/自检不应覆盖真实运行诊断（M2 发现：跑 unit test 会把宿主激活证据冲掉）。
 * 可用 LIFEOS_DISABLE_AGENT_MARKER=1 强制关闭。
 */
export function markerWritesDisabled() {
  try {
    if (process.env?.LIFEOS_DISABLE_AGENT_MARKER === '1') return true
    if (process.env?.NODE_TEST_CONTEXT) return true
    if (Array.isArray(process.argv) && process.argv.includes('--test')) return true
    return false
  } catch {
    return false
  }
}

function writeMarker(marker) {
  if (markerWritesDisabled()) return
  try {
    mkdirSync('D:\\个人\\dsh-lifeos', { recursive: true })
    writeFileSync(MARKER_PATH, JSON.stringify(marker, null, 2), 'utf8')
  } catch {
    /* 诊断写不出去不影响工具注册 */
  }
}

/**
 * 组合 preset 平面的注册：整理守则 section + 全部工具。
 * 返回 disposer；任一步失败只降级该步，不影响另一部分（诊断见 marker）。
 */
function installPresetPlane(ctx, service, marker) {
  const disposers = []

  if (typeof ctx.systemPrompt?.section === 'function') {
    try {
      const disposeSection = ctx.systemPrompt.section({
        name: ORGANIZE_RULES_SECTION_NAME,
        order: ORGANIZE_RULES_ORDER,
        text: ORGANIZE_RULES,
      })
      if (typeof disposeSection === 'function') disposers.push(disposeSection)
      marker.promptRegistered = true
      marker.promptSection = {
        name: ORGANIZE_RULES_SECTION_NAME,
        order: ORGANIZE_RULES_ORDER,
        chars: ORGANIZE_RULES.length,
      }
    } catch (error) {
      marker.promptError = String(error?.message ?? error)
      console.warn(`[lifeos-agent] 注入整理守则失败：${error?.message ?? error}`)
    }
  } else {
    marker.promptError = 'ctx.systemPrompt.section 不可用（inject 未生效？）'
  }

  disposers.push(registerTools(ctx, service))
  marker.toolRegistration = true

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* 卸载期忽略单个 disposer 异常 */
      }
    }
  }
}

export function apply(ctx) {
  const marker = {
    at: new Date().toISOString(),
    pid: process.pid,
    plane: 'preset-thin-row',
    inject: ['tools', 'lifeos', 'systemPrompt'],
    service: false,
    promptRegistered: false,
    toolRegistration: false,
    tools: [],
    isolation: 'when:agentPreset==="lifeos"',
    error: null,
  }

  let service
  try {
    service = ctx.get('lifeos')
    marker.service = !!service
  } catch (error) {
    marker.error = String(error?.message ?? error)
  }
  if (!service) {
    marker.error = marker.error ?? 'ctx.lifeos 仍不可用（inject 未生效？）'
    writeMarker(marker)
    console.warn('[lifeos-agent] 未取到 ctx.lifeos（Host 行未提供），本会话不注册 LifeOS 工具')
    return
  }

  try {
    const disposer = ctx.effect(() => installPresetPlane(ctx, service, marker), 'lifeos-agent.plane')
    if (typeof disposer !== 'function') marker.disposer = true

    // 诊断：确认工具在当前 preset 作用域内可见（不依赖具体 agent 会话）。
    try {
      const found = {}
      for (const toolName of LIFEOS_TOOL_NAMES) {
        try {
          found[toolName] = !!ctx.tools?.get?.(toolName)
        } catch {
          found[toolName] = 'error'
        }
      }
      marker.tools = LIFEOS_TOOL_NAMES
      marker.lookup = found
      marker.toolsVisible = LIFEOS_TOOL_NAMES.filter((toolName) => found[toolName] === true)
    } catch {
      /* get 不可用时忽略 */
    }
    try {
      marker.schemas = (ctx.tools?.schemas?.() ?? [])
        .map((schema) => schema?.name)
        .filter((toolName) => typeof toolName === 'string' && toolName.startsWith('lifeos_'))
    } catch {
      /* schemas 不可用时忽略 */
    }
  } catch (error) {
    marker.error = String(error?.message ?? error)
  }
  writeMarker(marker)
}
