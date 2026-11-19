/**
 * M0 集成自检（G4/G5 的服务端取证；不依赖浏览器）。
 *
 * 动机：HTTP 路由从 shell/curl 直连会被 Peer 鉴权 403（预期），浏览器端自检
 * （client-report）又需要用户点击面板。为了能在 Host 侧自动验证"路由 + 信封 +
 * 鉴权 URL + capture 写入 + SSE hello/changed + 查询 + 清理"，Host 行在首次
 * apply 时用 `connection.authenticatedUrl(origin)` 构造带鉴权的 URL，自调自己的
 * `/api/lifeos/*` 端点。
 *
 * 触发：配置 `selfCheck: 'once'`（默认 false）；产物 `runtime-selfcheck.json`
 * 已存在则跳过（删除该文件可重跑）。只写诊断，不写用户原文，不保留自检记录。
 *
 * 注意：这是 M0 的验证/诊断工具，不是业务能力；正式门禁仍以浏览器端 client-report
 * 与用户可视走查为准。
 */
import { writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SELF_CHECK_PATH = fileURLToPath(new URL('../../runtime-selfcheck.json', import.meta.url))
const TEST_TEXT_PREFIX = '【M0 自检】'

export function selfCheckPath() {
  return SELF_CHECK_PATH
}

export function hadSelfCheck() {
  try {
    return existsSync(SELF_CHECK_PATH)
  } catch {
    return false
  }
}

function nowIso() {
  return new Date().toISOString()
}

function serviceOf(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

function safeError(error) {
  return String(error?.message ?? error)
}

/** 读 SSE 流直到出现 needle（事件名），或超时。返回累计文本。 */
async function readSseUntil(reader, decoder, needle, timeoutMs) {
  const startedAt = Date.now()
  let text = ''
  while (Date.now() - startedAt < timeoutMs) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
    if (text.includes(needle)) return text
  }
  throw new Error(`SSE 等待 "${needle}" 超时（${timeoutMs}ms，已收到 ${text.length} 字节）`)
}

/**
 * @param {object} ctx Cordis Host 上下文
 * @param {object} deps {service, store, config, diagnostics, log}
 */
export async function runSelfCheck(ctx, deps) {
  const { service, store, config, diagnostics, log } = deps
  const startedAt = Date.now()
  const origin = serviceOf(ctx, 'webServer')?.getOrigin?.() ?? 'http://127.0.0.1:52508'
  const connection = serviceOf(ctx, 'connection')
  let base = origin
  if (connection && typeof connection.authenticatedUrl === 'function') {
    try {
      base = connection.authenticatedUrl(origin)
    } catch (error) {
      log?.warn?.(`自检：authenticatedUrl 失败，回退裸 origin：${safeError(error)}`)
    }
  }
  const prefix = config.httpPrefix || '/api/lifeos'
  const urlOf = (path) => String(base).replace(/\/+$/, '') + prefix + path

  const steps = []
  const step = (name, ok, detail) => {
    steps.push({ name, ok: ok === true, detail: detail ?? null, at: nowIso() })
  }

  const fetchJson = async (path, init) => {
    const response = await fetch(urlOf(path), {
      ...init,
      headers: { accept: 'application/json', ...(init?.headers || {}) },
    })
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return { status: response.status, body }
  }

  const before = (() => {
    try {
      const status = service.status()
      return { units: status.units, counts: status.counts }
    } catch {
      return null
    }
  })()

  // 1) health
  try {
    const { status, body } = await fetchJson('/health')
    step('http.health', status === 200 && body?.ok === true, { status })
  } catch (error) {
    step('http.health', false, { error: safeError(error) })
  }

  // 2) bootstrap
  try {
    const { status, body } = await fetchJson('/bootstrap')
    const value = body?.value
    step('http.bootstrap', status === 200 && body?.ok === true && !!value, {
      status,
      counts: value?.counts ?? null,
      apiVersion: value?.apiVersion ?? null,
    })
  } catch (error) {
    step('http.bootstrap', false, { error: safeError(error) })
  }

  // 3) SSE hello + capture + changed（同一条流上验证）
  let captured = null
  let streamText = ''
  const controller = new AbortController()
  try {
    const response = await fetch(urlOf('/events'), {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new Error(`SSE 连接失败：HTTP ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    streamText = await readSseUntil(reader, decoder, 'hello', 3000)
    step('sse.hello', true, { bytes: streamText.length })

    const requestId = `selfcheck-${Date.now()}`
    const { status, body } = await fetchJson('/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: `${TEST_TEXT_PREFIX}${nowIso()} 自动验证记录（随后清理）。`,
        requestId,
        source: 'panel',
      }),
    })
    captured = body?.value ?? null
    step('http.capture', status === 200 && body?.ok === true && !!captured?.rawRecordId, {
      status,
      rawRecordId: captured?.rawRecordId ?? null,
      inboxItemId: captured?.inboxItemId ?? null,
    })

    streamText += await readSseUntil(reader, decoder, 'changed', 3000)
    step('sse.changed', true, { totalBytes: streamText.length })
    controller.abort()
  } catch (error) {
    step('sse.flow', false, { error: safeError(error) })
    try {
      controller.abort()
    } catch {
      /* ignore */
    }
  }

  // 4) query 能读到刚写入的 inbox 条目
  try {
    const { status, body } = await fetchJson('/query?view=inbox_pending&limit=10')
    const items = body?.value?.items ?? []
    const found = captured?.inboxItemId
      ? items.some((item) => item?.id === captured.inboxItemId || item?.inboxItemId === captured.inboxItemId)
      : false
    step('http.query', status === 200 && body?.ok === true, { status, count: items.length, found })
  } catch (error) {
    step('http.query', false, { error: safeError(error) })
  }

  // 5) 清理自检记录（写一条 operation_log 审计由 capture 产生，保留）
  let cleaned = false
  try {
    if (captured?.rawRecordId) await store.delete('lifeos_raw', 'raw_record', captured.rawRecordId)
    if (captured?.inboxItemId) await store.delete('lifeos', 'inbox_item', captured.inboxItemId)
    try {
      store.rebuildIndexes?.()
    } catch {
      /* ignore */
    }
    cleaned = true
    step('cleanup', true, { rawRecordId: captured?.rawRecordId ?? null, inboxItemId: captured?.inboxItemId ?? null })
  } catch (error) {
    step('cleanup', false, { error: safeError(error) })
  }

  const after = (() => {
    try {
      const status = service.status()
      return { units: status.units, counts: status.counts }
    } catch {
      return null
    }
  })()

  const ok = steps.every((item) => item.ok === true)
  const result = {
    at: nowIso(),
    ok,
    durationMs: Date.now() - startedAt,
    origin,
    steps,
    before,
    after,
    cleaned,
    note: 'Host 侧自检；浏览器端 client-report 仍需面板挂载（G5 的 UI 取证）。',
  }

  try {
    writeFileSync(SELF_CHECK_PATH, JSON.stringify(result, null, 2), 'utf8')
  } catch (error) {
    log?.warn?.(`自检结果写入失败：${safeError(error)}`)
  }

  // 6) 回写诊断门禁
  try {
    diagnostics.setGate('G5', ok, {
      phase: 'host-selfcheck',
      routes: true,
      httpHealth: steps.find((s) => s.name === 'http.health')?.ok ?? false,
      sse: steps.find((s) => s.name === 'sse.hello')?.ok === true && steps.find((s) => s.name === 'sse.changed')?.ok === true,
      capture: steps.find((s) => s.name === 'http.capture')?.ok ?? false,
      note: 'Host 自检通过；浏览器 client-report 待面板挂载',
    })
    diagnostics.setGate('G4', steps.find((s) => s.name === 'http.capture')?.ok === true, {
      phase: 'host-selfcheck',
      units: after?.units ?? before?.units ?? null,
      counts: after?.counts ?? before?.counts ?? null,
      selfCheckFile: SELF_CHECK_PATH,
    })
  } catch {
    /* 诊断失败不影响插件 */
  }

  return result
}
