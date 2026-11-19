/**
 * dsh-lifeos —— Client 半身（M0，单文件手写 lazy-CJS）
 * ============================================================================
 * 约束（M0-PLAN §1/§7、design 02/05）：
 *   · 不 import 任何包；React 从宿主静态模块表取：`const React = require('react')`
 *   · 不写 JSX，统一 `React.createElement`（`h`）
 *   · 不 require 宿主 UI 包；样式只用于内联 style + `--dsw-alias-*` 变量（带 fallback）
 *   · 只能写本文件 / locale / icon；Host 路由由 B 线按 M0-PLAN §3.3 实现
 *
 * 注册点（M0-PLAN §3.6）：
 *   1) sidebar.panellist id=lifeos  order=20  label='LifeOS'  图标组件
 *   2) main            key=lifeos                             主面板
 *   3) shell.overlay   id=lifeos-quick-capture  order=10      快速记录浮层 + toast
 *   4) settings.section id=lifeos                             LifeOS 设置页（只读）
 *
 * 数据面（Host 由 B 线实现，失败时进入 mock 回退并显示「示例数据」）：
 *   GET  /api/lifeos/bootstrap     {today, counts, settings, apiVersion}
 *   GET  /api/lifeos/query         ?view=inbox_pending&limit=20 -> {items,nextCursor}
 *   POST /api/lifeos/capture       {text, requestId, source} -> {rawRecordId, inboxItemId}
 *   GET  /api/lifeos/events        SSE: hello / changed / heartbeat
 *   GET  /api/lifeos/dev/status    诊断（只读设置页用）
 *   POST /api/lifeos/dev/client-report  门禁 G5 自检回传
 *
 * 自检回传：面板挂载后、bootstrap 完成后、SSE 首次 hello / changed 后各回传一次，
 * 供门禁 G5 取证（bootstrapOk / sse / at / counts / apiVersion / mock）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-lifeos',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef
    const useCallback = React.useCallback
    const useMemo = React.useMemo

    /* ═════════════════════════ 常量 ═════════════════════════ */

    const API_PREFIX = '/api/lifeos'
    const PANEL_ID = 'lifeos'
    const OVERLAY_ID = 'lifeos-quick-capture'
    const PLUGIN_VERSION = '0.0.1'
    const TAB_STORAGE_KEY = 'lifeos.panel.tab'
    const DRAFT_STORAGE_KEY = 'lifeos.quick-capture.draft'
    const QUICK_CAPTURE_LABEL = '快速记录（Ctrl+Shift+Space）'

    // 中文字案集中在这一处；M0 不接 locale 服务（locale/*.json 只提供插件元数据）。
    const TEXT = {
      appName: 'LifeOS',
      inbox: '收件箱',
      today: '今日',
      capturePlaceholder: '想到什么就写在这里，分类交给 Agent…',
      captureSubmit: '记录',
      quickCapture: '快速记录',
      quickCaptureHint: 'Enter 保存 · Shift+Enter 换行 · Esc 关闭（草稿保留）',
      quickCaptureAria: '快速记录',
      save: '保存',
      cancel: '关闭',
      refresh: '刷新',
      loading: '加载中…',
      connecting: '连接中…',
      statusOk: '已连接',
      statusWarn: '只读 / 示例数据',
      statusError: '未连接',
      statusIdle: '等待连接',
      inboxEmpty: '想到什么就写在这里，分类交给 Agent。',
      inboxEmptyHint: '例：「明天下午 3 点改实验报告」，回车即存。',
      todayEmpty: '今天还没有安排。要让 Agent 帮你排一下吗？',
      todayEmptyHint: '先记一条，Agent 会帮你整理成任务与日程。',
      mockBanner: 'Host 尚未就绪：当前展示示例数据，连接恢复后会自动刷新。',
      degradedBanner: '存储不可用：LifeOS 处于只读降级模式，记录功能暂不可用。',
      readFailed: '读取失败',
      saveFailed: '保存失败',
      saveOk: '已收进 Inbox',
      retry: '重试',
      noSession: '主面板不绑定会话，数据由 LifeOS Publisher 提供。',
      settingsTitle: 'LifeOS 设置（M0 只读）',
      settingsHint: 'M0 阶段只读展示；时区 / 调试开关由 Host 配置决定。',
      pluginVersion: '插件版本',
      apiVersion: 'API 版本',
      timeZone: '时区',
      devMode: '开发者模式',
      storage: '存储状态',
      counts: '计数',
      sse: 'SSE 连接数',
      lastError: '最近错误',
      unavailable: '暂不可用',
      yes: '是',
      no: '否',
      unknown: '未知',
      pendingInbox: '待整理',
      noTasks: '暂无任务',
      statusPending: '等待整理',
      statusCaptured: '已记录',
      statusNeedsReview: '待确认',
      statusPromoted: '已整理',
      statusDismissed: '已忽略',
      statusDone: '已完成',
      statusTodo: '待办',
      statusInProgress: '进行中',
      crashTitle: 'LifeOS 界面出错了',
      crashHint: '这段界面崩溃没有影响 LifeOS 数据；点「重试」恢复。',
      time: '时间',
    }

    /* ═════════════════════════ 主题 token（只读 + fallback） ═════════════════════════ */

    function token(name, fallback) {
      return 'var(' + name + ', ' + fallback + ')'
    }

    const COLORS = {
      bgBase: token('--dsw-alias-bg-base', '#fafafb'),
      bgLayer1: token('--dsw-alias-bg-layer-1', '#f4f5f7'),
      bgLayer2: token('--dsw-alias-bg-layer-2', '#eceef1'),
      bgOverlay: token('--dsw-alias-bg-overlay', 'rgba(20, 22, 27, 0.5)'),
      mask: token('--dsw-alias-bg-mask-1', 'rgba(12, 14, 18, 0.35)'),
      borderL1: token('--dsw-alias-border-l1', '#eceef1'),
      borderL2: token('--dsw-alias-border-l2', '#dde0e5'),
      labelPrimary: token('--dsw-alias-label-primary', '#1b1c1f'),
      labelSecondary: token('--dsw-alias-label-secondary', '#5b6069'),
      labelTertiary: token('--dsw-alias-label-tertiary', '#8b919b'),
      labelCaption: token('--dsw-alias-label-caption', '#9aa0a8'),
      brand: token('--dsw-alias-brand-primary', '#247bbf'),
      brandText: token('--dsw-alias-brand-text', '#ffffff'),
      // M2 修复（用户反馈 2026-11-13）：宿主主题里 `--dsw-alias-brand-text` 是"品牌色文字"
      // （深色），把它当主按钮前景色会出现"黑底黑字"。主按钮前景固定用白色保证对比度。
      brandOn: '#ffffff',
      success: token('--dsw-alias-state-success-primary', '#1f9d63'),
      warn: token('--dsw-alias-state-warn-primary', '#c98a1b'),
      error: token('--dsw-alias-state-error-primary', '#d64545'),
      business: token('--dsw-alias-state-business-primary', '#3f6bd8'),
      idle: token('--dsw-alias-state-idle-primary', '#9aa0a8'),
      hover: token('--dsw-alias-interactive-bg-hover', 'rgba(120, 130, 145, 0.10)'),
      active: token('--dsw-alias-interactive-bg-active', 'rgba(120, 130, 145, 0.16)'),
      shadow1: token('--dsw-shadow-lv1', '0 1px 2px rgba(0, 0, 0, 0.08)'),
      shadow2: token('--dsw-shadow-lv2', '0 8px 24px rgba(0, 0, 0, 0.18)'),
      radiusSm: token('--dsw-radius-sm', '6px'),
      radiusMd: token('--dsw-radius-md', '8px'),
      radiusLg: token('--dsw-radius-lg', '12px'),
      fontFamily:
        'var(--dsw-font-family, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif)',
    }

    const TOP_CLEARANCE = 'var(--dsh-frame-top-clearance, 0px)'
    const OVERLAY_TOP = 'var(--dsh-frame-overlay-top, 20px)'

    const FONT = {
      title: { fontSize: 18, fontWeight: 600, lineHeight: '24px' },
      tab: { fontSize: 14, fontWeight: 500, lineHeight: '20px' },
      body: { fontSize: 14, fontWeight: 400, lineHeight: '22px' },
      meta: { fontSize: 12, fontWeight: 400, lineHeight: '18px' },
      caption: { fontSize: 11, fontWeight: 400, lineHeight: '16px' },
    }

    /* ═════════════════════════ 基础工具 ═════════════════════════ */

    function nowIso() {
      return new Date().toISOString()
    }

    function todayIso() {
      const d = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    }

    function formatTime(value) {
      if (value === undefined || value === null || value === '') return ''
      try {
        const date = value instanceof Date ? value : new Date(value)
        if (Number.isNaN(date.getTime())) return String(value)
        return new Intl.DateTimeFormat('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }).format(date)
      } catch (error) {
        return String(value)
      }
    }

    function formatTodayLabel(dateText) {
      const text = typeof dateText === 'string' && dateText ? dateText : todayIso()
      try {
        const date = new Date(text + 'T00:00:00')
        if (Number.isNaN(date.getTime())) return text
        return new Intl.DateTimeFormat('zh-CN', {
          month: 'long',
          day: 'numeric',
          weekday: 'short',
        }).format(date)
      } catch (error) {
        return text
      }
    }

    function makeRequestId() {
      return (
        'cap_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10)
      )
    }

    function ApiError(code, message, details) {
      const error = new Error(message || code || 'request-failed')
      error.name = 'ApiError'
      error.code = code || 'internal'
      error.details = details
      return error
    }

    function errorText(error) {
      if (!error) return TEXT.unknown
      if (error.code && error.message) return error.code + ' · ' + error.message
      return String(error.message || error)
    }

    function safeReadStorage(key) {
      try {
        return window.localStorage.getItem(key)
      } catch (error) {
        return null
      }
    }

    function safeWriteStorage(key, value) {
      try {
        if (value === null || value === undefined) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, String(value))
      } catch (error) {
        /* localStorage 不可用时静默忽略：M0 允许草稿仅留在内存 */
      }
    }

    function statusLabel(status) {
      const key = String(status || '').toLowerCase()
      const map = {
        pending: TEXT.statusPending,
        captured: TEXT.statusCaptured,
        needs_review: TEXT.statusNeedsReview,
        promoted: TEXT.statusPromoted,
        dismissed: TEXT.statusDismissed,
        done: TEXT.statusDone,
        todo: TEXT.statusTodo,
        doing: TEXT.statusInProgress,
        in_progress: TEXT.statusInProgress,
      }
      return map[key] || (status ? String(status) : TEXT.statusPending)
    }

    function itemText(item) {
      if (!item || typeof item !== 'object') return typeof item === 'string' ? item : ''
      return (
        item.text ||
        item.rawText ||
        item.raw_text ||
        item.title ||
        item.summary ||
        item.content ||
        ''
      )
    }

    function itemCreatedAt(item) {
      if (!item || typeof item !== 'object') return ''
      return item.createdAt || item.created_at || item.capturedAt || item.at || ''
    }

    function taskTitle(task) {
      if (!task) return ''
      if (typeof task === 'string') return task
      return task.title || task.text || task.name || task.summary || '未命名任务'
    }

    /* ═════════════════════════ 数据层（HTTP 契约：M0-PLAN §3.3） ═════════════════════════ */

    function apiUrl(path) {
      return API_PREFIX + path
    }

    function readEnvelope(payload) {
      if (payload && typeof payload === 'object' && payload.ok === true) return payload.value
      if (payload && typeof payload === 'object' && payload.ok === false) {
        const error = payload.error || {}
        throw ApiError(error.code || 'internal', error.message || TEXT.readFailed, error.details)
      }
      // 兼容非信封响应（M0 探针/简化 Host）：直接当作 value。
      return payload
    }

    async function apiRequest(path, options) {
      const requestOptions = Object.assign(
        {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
        },
        options || {},
      )
      let response
      try {
        response = await fetch(apiUrl(path), requestOptions)
      } catch (error) {
        throw ApiError('network_error', '无法连接 LifeOS Host：' + errorText(error))
      }
      const text = await response.text().catch(() => '')
      let payload = null
      if (text) {
        try {
          payload = JSON.parse(text)
        } catch (error) {
          payload = null
        }
      }
      if (!response.ok) {
        const error = payload && payload.error ? payload.error : {}
        throw ApiError(
          error.code || 'http_' + response.status,
          error.message || 'HTTP ' + response.status,
          error.details,
        )
      }
      try {
        return readEnvelope(payload)
      } catch (error) {
        throw error
      }
    }

    function fetchBootstrap() {
      return apiRequest('/bootstrap')
    }

    function fetchInbox(limit) {
      const size = Number(limit) > 0 ? Number(limit) : 20
      return apiRequest('/query?view=inbox_pending&limit=' + size)
    }

    function postCapture(body) {
      return apiRequest('/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
    }

    function fetchDevStatus() {
      return apiRequest('/dev/status')
    }

    let selfCheckReportLocked = false

    function reportClient(payload) {
      try {
        // M2.5 修复：验收自检报告写完后，面板挂载等诊断回传不得覆盖它
        // （实测出现过 panel/m1-board-init 在自检后回写，导致 m2-selfcheck 证据丢失）。
        if (selfCheckReportLocked && !(payload && payload.phase === 'm2-selfcheck')) {
          return Promise.resolve(undefined)
        }
        if (payload && payload.phase === 'm2-selfcheck') selfCheckReportLocked = true
        return fetch(apiUrl('/dev/client-report'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => undefined)
      } catch (error) {
        return Promise.resolve(undefined)
      }
    }

    /* ── mock 回退（Host 未就绪时保证面板可看、可点） ── */

    function mockBootstrap() {
      return {
        today: {
          date: todayIso(),
          tasks: [],
          inboxCount: 2,
        },
        counts: { inboxPending: 2, today: 0 },
        settings: { timeZone: 'Asia/Shanghai', devMode: false },
        apiVersion: 'mock',
      }
    }

    function mockInboxItems() {
      const now = Date.now()
      return [
        {
          id: 'mock_raw_1',
          status: 'pending',
          text: '示例记录：明天下午 3 点改实验报告，1 小时。',
          createdAt: new Date(now - 12 * 60 * 1000).toISOString(),
        },
        {
          id: 'mock_raw_2',
          status: 'pending',
          text: '示例记录：今天中午走了 8000 步，晚上想做 30 分钟力量训练。',
          createdAt: new Date(now - 48 * 60 * 1000).toISOString(),
        },
      ]
    }

    /* ═════════════════════════ 客户端运行时（单页单例） ═════════════════════════ */

    function createRuntime() {
      const state = {
        panelMountedAt: null,
        bootstrap: { phase: 'idle', ok: false, mock: false, data: null, error: null, at: null },
        inbox: { phase: 'idle', items: [], nextCursor: null, mock: false, error: null, at: null },
        degraded: false,
        sse: { status: 'idle', lastAt: null, helloAt: null, changedCount: 0, error: null },
        overlayOpen: false,
        overlaySource: 'panel',
        toasts: [],
        activeTab: 'inbox',
        capture: { submitting: false, error: null },
        devStatus: { phase: 'idle', data: null, error: null, at: null },
      }

      let snapshot = state
      const listeners = new Set()
      const timers = new Set()
      const reportedReasons = new Set()
      let eventSource = null
      let refreshTimer = null
      let disposed = false
      let externalChangeHandler = null

      function schedule(fn, delay) {
        const id = window.setTimeout(() => {
          timers.delete(id)
          try {
            fn()
          } catch (error) {
            console.error('[lifeos] timer failed', error)
          }
        }, delay)
        timers.add(id)
        return id
      }

      function clearTimers() {
        timers.forEach((id) => {
          try {
            window.clearTimeout(id)
          } catch (error) {
            /* ignore */
          }
        })
        timers.clear()
      }

      function getState() {
        return snapshot
      }

      function setState(patch) {
        if (disposed) return
        const next = typeof patch === 'function' ? patch(snapshot) : patch
        if (!next || next === snapshot) return
        snapshot = next
        Array.from(listeners).forEach((listener) => {
          try {
            listener()
          } catch (error) {
            console.error('[lifeos] subscriber failed', error)
          }
        })
      }

      function update(patch) {
        setState(Object.assign({}, snapshot, typeof patch === 'object' ? patch : {}))
      }

      function subscribe(listener) {
        listeners.add(listener)
        return function unsubscribe() {
          listeners.delete(listener)
        }
      }

      /* ── 自检回传（门禁 G5） ── */

      function buildReport(reason) {
        const bootstrap = snapshot.bootstrap
        const counts = (bootstrap.data && bootstrap.data.counts) || null
        return {
          panel: 'ok',
          reason: reason || 'manual',
          bootstrapOk: bootstrap.ok === true,
          mock: bootstrap.mock === true,
          degraded: snapshot.degraded === true,
          sse: snapshot.sse.status,
          sseStatus: snapshot.sse.status,
          changedCount: snapshot.sse.changedCount,
          apiVersion: (bootstrap.data && bootstrap.data.apiVersion) || null,
          counts: counts,
          pluginVersion: PLUGIN_VERSION,
          at: nowIso(),
        }
      }

      function report(reason) {
        // 同一原因只回传一次，避免刷新循环刷屏诊断文件。
        if (reportedReasons.has(reason)) return Promise.resolve()
        reportedReasons.add(reason)
        return reportClient(buildReport(reason))
      }

      /* ── bootstrap / inbox ── */

      async function refreshBootstrap(reason) {
        if (disposed) return
        const first = snapshot.bootstrap.phase === 'idle'
        update({
          bootstrap: Object.assign({}, snapshot.bootstrap, {
            phase: first ? 'loading' : snapshot.bootstrap.phase,
            error: null,
          }),
        })
        try {
          const value = await fetchBootstrap()
          const data = value && typeof value === 'object' ? value : mockBootstrap()
          update({
            bootstrap: {
              phase: 'ready',
              ok: true,
              mock: false,
              data: data,
              error: null,
              at: nowIso(),
            },
            degraded: false,
          })
          report('bootstrap')
        } catch (error) {
          const code = error && error.code ? error.code : 'network_error'
          const degraded = code === 'store_unavailable' || code === 'internal'
          update({
            bootstrap: {
              phase: 'fallback',
              ok: false,
              mock: true,
              data: mockBootstrap(),
              error: { code: code, message: errorText(error) },
              at: nowIso(),
            },
            degraded: degraded,
          })
          report('bootstrap-fallback')
        }
      }

      async function refreshInbox(reason) {
        if (disposed) return
        update({
          inbox: Object.assign({}, snapshot.inbox, { phase: snapshot.inbox.items.length ? 'ready' : 'loading', error: null }),
        })
        try {
          const value = await fetchInbox(20)
          const items = Array.isArray(value) ? value : value && Array.isArray(value.items) ? value.items : []
          const nextCursor = value && typeof value === 'object' ? value.nextCursor || null : null
          update({
            inbox: {
              phase: 'ready',
              items: items,
              nextCursor: nextCursor,
              mock: false,
              error: null,
              at: nowIso(),
            },
          })
        } catch (error) {
          update({
            inbox: Object.assign({}, snapshot.inbox, {
              phase: snapshot.inbox.items.length ? 'ready' : 'fallback',
              mock: snapshot.inbox.items.length ? snapshot.inbox.mock : true,
              items: snapshot.inbox.items.length ? snapshot.inbox.items : mockInboxItems(),
              error: { code: error && error.code ? error.code : 'network_error', message: errorText(error) },
              at: nowIso(),
            }),
          })
        }
      }

      function refreshAll(reason) {
        return Promise.all([refreshBootstrap(reason), refreshInbox(reason)]).catch(() => undefined)
      }

      /* ── 捕获（面板输入行 / 浮层共用） ── */

      async function capture(text, source) {
        const value = String(text || '').trim()
        if (!value) throw ApiError('validation_failed', '内容不能为空')
        update({ capture: { submitting: true, error: null } })
        try {
          const result = await postCapture({
            text: value,
            requestId: makeRequestId(),
            source: source === 'overlay' ? 'overlay' : 'panel',
          })
          // 乐观更新：先清提交态、插入一条待整理项，随后统一刷新（SSE changed 也会触发）。
          const item = {
            id: (result && (result.inboxItemId || result.rawRecordId)) || 'local_' + Date.now(),
            status: 'pending',
            text: value,
            createdAt: nowIso(),
            local: true,
          }
          const counts =
            snapshot.bootstrap.data && snapshot.bootstrap.data.counts
              ? snapshot.bootstrap.data.counts
              : null
          update({
            capture: { submitting: false, error: null },
            inbox: Object.assign({}, snapshot.inbox, {
              items: [item].concat(snapshot.inbox.items).slice(0, 50),
            }),
            bootstrap: snapshot.bootstrap.data
              ? Object.assign({}, snapshot.bootstrap, {
                  data: Object.assign({}, snapshot.bootstrap.data, {
                    counts: counts
                      ? Object.assign({}, counts, {
                          inboxPending: (Number(counts.inboxPending) || 0) + 1,
                        })
                      : counts,
                  }),
                })
              : snapshot.bootstrap,
          })
          toast('success', TEXT.saveOk)
          refreshAll('capture')
          return result
        } catch (error) {
          update({ capture: { submitting: false, error: errorText(error) } })
          throw error
        }
      }

      /* ── toast ── */

      function toast(kind, text, action) {
        const item = {
          id: 'toast_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
          kind: kind === 'error' ? 'error' : 'success',
          text: String(text || ''),
          action: action && action.label ? action : null,
        }
        update({ toasts: snapshot.toasts.concat([item]).slice(-3) })
        schedule(() => dismissToast(item.id), item.action ? 6000 : 3200)
        return item.id
      }

      function dismissToast(id) {
        update({ toasts: snapshot.toasts.filter((toastItem) => toastItem.id !== id) })
      }

      /* ── 快速记录浮层 ── */

      function openOverlay(source) {
        update({ overlayOpen: true, overlaySource: source || 'panel', capture: { submitting: false, error: null } })
      }

      function closeOverlay() {
        update({ overlayOpen: false })
      }

      function toggleOverlay(source) {
        if (snapshot.overlayOpen) closeOverlay()
        else openOverlay(source)
      }

      /* ── SSE ── */

      function startEvents() {
        if (disposed || eventSource) return
        if (typeof window.EventSource !== 'function') {
          update({ sse: Object.assign({}, snapshot.sse, { status: 'unsupported', error: 'EventSource unavailable' }) })
          return
        }
        try {
          eventSource = new window.EventSource(apiUrl('/events'))
        } catch (error) {
          update({
            sse: Object.assign({}, snapshot.sse, { status: 'error', error: errorText(error) }),
          })
          eventSource = null
          return
        }
        update({ sse: Object.assign({}, snapshot.sse, { status: 'connecting', error: null }) })

        const parseEvent = (event) => {
          const raw = event && typeof event.data === 'string' ? event.data : ''
          if (!raw) return null
          try {
            return JSON.parse(raw)
          } catch (error) {
            return null
          }
        }

        const onHello = (event) => {
          const payload = parseEvent(event) || {}
          update({
            sse: Object.assign({}, snapshot.sse, {
              status: 'hello',
              helloAt: nowIso(),
              lastAt: nowIso(),
              error: null,
              payload: payload,
            }),
          })
          report('sse-hello')
          refreshAll('sse-hello')
          notifyExternal('hello', payload)
        }
        const onChanged = (event) => {
          const payload = parseEvent(event) || {}
          update({
            sse: Object.assign({}, snapshot.sse, {
              status: 'changed',
              lastAt: nowIso(),
              changedCount: (snapshot.sse.changedCount || 0) + 1,
              error: null,
              lastChange: payload,
            }),
          })
          report('sse-changed')
          notifyExternal('changed', payload)
          if (refreshTimer) {
            try {
              window.clearTimeout(refreshTimer)
            } catch (error) {
              /* ignore */
            }
          }
          refreshTimer = schedule(() => {
            refreshTimer = null
            refreshAll('sse-changed')
          }, 200)
        }
        const onNotesChanged = (event) => {
          const payload = parseEvent(event) || {}
          update({
            sse: Object.assign({}, snapshot.sse, {
              status: 'changed',
              lastAt: nowIso(),
              changedCount: (snapshot.sse.changedCount || 0) + 1,
              error: null,
              lastChange: payload,
            }),
          })
          notifyExternal('notes', payload)
        }
        const onNotification = (event) => {
          const payload = parseEvent(event) || {}
          update({
            sse: Object.assign({}, snapshot.sse, {
              status: 'changed',
              lastAt: nowIso(),
              changedCount: (snapshot.sse.changedCount || 0) + 1,
              error: null,
              lastChange: payload,
            }),
          })
          notifyExternal('notification', payload)
        }
        const onSuggestion = (event) => {
          const payload = parseEvent(event) || {}
          update({
            sse: Object.assign({}, snapshot.sse, {
              status: 'changed',
              lastAt: nowIso(),
              changedCount: (snapshot.sse.changedCount || 0) + 1,
              error: null,
              lastChange: payload,
            }),
          })
          notifyExternal('suggestion', payload)
        }
        const onAutomationChanged = (event) => {
          const payload = parseEvent(event) || {}
          update({
            sse: Object.assign({}, snapshot.sse, {
              status: 'changed',
              lastAt: nowIso(),
              changedCount: (snapshot.sse.changedCount || 0) + 1,
              error: null,
              lastChange: payload,
            }),
          })
          notifyExternal('automation/changed', payload)
        }
        const onHeartbeat = () => {
          update({
            sse: Object.assign({}, snapshot.sse, { lastAt: nowIso(), status: snapshot.sse.status === 'connecting' ? 'connecting' : snapshot.sse.status }),
          })
        }

        try {
          eventSource.addEventListener('hello', onHello)
          eventSource.addEventListener('changed', onChanged)
          eventSource.addEventListener('heartbeat', onHeartbeat)
          // 环形缓冲溢出时 Host 先发 resync：按全量基线重拉（§3.3 Last-Event-ID 语义）。
          eventSource.addEventListener('resync', onHello)
          eventSource.addEventListener('notes/changed', onNotesChanged)
          eventSource.addEventListener('notification', onNotification)
          eventSource.addEventListener('suggestion', onSuggestion)
          eventSource.addEventListener('automation/changed', onAutomationChanged)
          eventSource.onerror = function onEventSourceError() {
            update({
              sse: Object.assign({}, snapshot.sse, {
                status: 'error',
                error: 'SSE 连接中断，正在重连…',
              }),
            })
          }
        } catch (error) {
          update({
            sse: Object.assign({}, snapshot.sse, { status: 'error', error: errorText(error) }),
          })
        }
      }

      function stopEvents() {
        if (!eventSource) return
        try {
          eventSource.close()
        } catch (error) {
          /* ignore */
        }
        eventSource = null
        update({ sse: Object.assign({}, snapshot.sse, { status: 'closed' }) })
      }

      /* ── 设置页数据 ── */

      async function refreshDevStatus() {
        update({ devStatus: { phase: 'loading', data: snapshot.devStatus.data, error: null, at: snapshot.devStatus.at } })
        try {
          const value = await fetchDevStatus()
          update({ devStatus: { phase: 'ready', data: value, error: null, at: nowIso() } })
        } catch (error) {
          update({ devStatus: { phase: 'fallback', data: null, error: errorText(error), at: nowIso() } })
        }
      }

      function setChangeHandler(handler) {
        externalChangeHandler = typeof handler === 'function' ? handler : null
      }

      function notifyExternal(reason, payload) {
        if (!externalChangeHandler) return
        try {
          externalChangeHandler(reason, payload)
        } catch (error) {
          console.error('[lifeos] external change handler failed', error)
        }
      }

      function dispose() {
        disposed = true
        externalChangeHandler = null
        stopEvents()
        clearTimers()
        listeners.clear()
      }

      return {
        getState: getState,
        subscribe: subscribe,
        setState: setState,
        setChangeHandler: setChangeHandler,
        refreshBootstrap: refreshBootstrap,
        refreshInbox: refreshInbox,
        refreshAll: refreshAll,
        capture: capture,
        toast: toast,
        dismissToast: dismissToast,
        openOverlay: openOverlay,
        closeOverlay: closeOverlay,
        toggleOverlay: toggleOverlay,
        startEvents: startEvents,
        stopEvents: stopEvents,
        refreshDevStatus: refreshDevStatus,
        report: report,
        dispose: dispose,
      }
    }

    const runtime = createRuntime()

    /* ═════════════════════════ M1：文案 / 常量 / 日期解析 ═════════════════════════ */

    Object.assign(TEXT, {
      tabInbox: '收件箱',
      tabToday: '今日',
      tabTodo: '待办',
      tabCalendar: '日历',
      newTask: '新建任务',
      quickAddPlaceholder: '新建任务：标题（可含 今天 / 明天 / 周五 / 3月8日，以及 !高/!中/!低），回车创建',
      quickAddHint: '回车创建 · N 新建 · Esc 取消',
      filterProject: '项目',
      filterTag: '标签',
      filterPriority: '优先级',
      filterAll: '全部',
      filterSearch: '搜索任务…',
      clearFilters: '清除筛选',
      groupOverdue: '逾期',
      groupToday: '今天',
      groupTomorrow: '明天',
      groupNext7: '最近 7 天',
      groupLater: '以后',
      groupNone: '无日期',
      todayOverdue: '逾期',
      inboxPendingHint: 'Inbox 待整理',
      noTasksView: '这个视图还没有任务。按 N 新建一条。',
      noCalendarTasks: '这一天没有安排。',
      unscheduledPool: '未排期',
      calendarToday: '今天',
      prevMonth: '上一月',
      nextMonth: '下一月',
      calendarHint: '拖动任务到某一天可改期',
      detailTitle: '任务详情',
      detailNotes: '备注',
      detailNotesPlaceholder: '补充说明…',
      detailDate: '时间',
      dateNone: '无日期',
      dateDay: '日期',
      dateSpan: '时间段',
      dateDue: '仅截止',
      detailPriority: '优先级',
      detailProject: '项目',
      detailTags: '标签',
      detailStatus: '状态',
      detailNoProject: '无项目',
      detailNoTags: '无标签',
      save: '保存',
      saving: '保存中…',
      close: '关闭',
      complete: '完成',
      reopen: '重开',
      cancelTask: '取消任务',
      conflictNotice: '这个任务已被其它地方修改：已保留你的输入，可对照最新版本。',
      useLatest: '用最新版本',
      keepMine: '保留我的修改',
      saved: '已保存',
      created: '已创建',
      completed: '已完成',
      reopened: '已重开',
      cancelledTask: '已取消',
      rescheduled: '已改期',
      undo: '撤销',
      loadFailed: '加载失败',
      saveFailed: '保存失败',
      priorityHigh: '高',
      priorityMedium: '中',
      priorityLow: '低',
      priorityNone: '无',
      mockBoard: 'Host 未就绪：看板正在展示示例数据，连接恢复后自动刷新。',
      pendingRefresh: '有新的数据变更，关闭编辑后会刷新。',
      detailNotSaved: '有未保存的修改',
      moveUp: '上移',
      moveDown: '下移',
      boardInitFailed: '看板初始化失败',
      createdInInbox: '已收进 Inbox',
      calendarDayTasks: '当天任务',
      selectedDay: '选中日期',
      emptyOverdue: '没有逾期任务',
      loading: '加载中…',
      // ── M4：习惯 / 项目 / 回顾 ──
      tabHabits: '习惯',
      tabProjects: '项目',
      tabReview: '回顾',
      habitsTitle: '习惯',
      habitsToday: '今天',
      newHabit: '＋ 新习惯',
      createHabit: '创建习惯',
      habitCreateTitle: '新习惯',
      habitEmpty: '还没有习惯。可以从「每天走 6000 步」开始。',
      habitEmptyHint: '先建一个每天能做到的小习惯。',
      habitTodayEmpty: '今天没有需要打卡的习惯。',
      habitMonth: '本月打卡',
      habitName: '名称',
      habitNamePlaceholder: '例如：散步 6000 步',
      habitFrequency: '频率',
      habitStartDate: '开始日期',
      habitTarget: '单次目标（可选）',
      habitTargetValue: '目标值',
      habitUnit: '单位',
      frequencyDaily: '每天',
      frequencyInterval: '每 N 天',
      frequencyWeeklyDays: '每周固定日',
      frequencyWeeklyCount: '每周 N 次',
      frequencyIntervalDays: '间隔天数',
      frequencyWeeklyCountLabel: '每周次数',
      periodTarget: '周期目标（可选）',
      periodWeek: '周',
      periodMonth: '月',
      habitCheckin: '打卡',
      habitCheckedToday: '已打卡',
      habitNotRecorded: '未记录',
      habitRecord: '记录',
      habitUndoCheckin: '撤销今日打卡',
      habitStreakPrefix: '连续 ',
      habitStreakSuffix: ' 天（grace）',
      habitCoveragePrefix: '近 14 天 ',
      habitCoverageSuffix: ' 已记录',
      legendDone: '● 完成',
      legendPartial: '◐ 部分',
      legendSkipped: '○ 未做/跳过',
      legendMissing: '－ 未记录',
      legendPaused: '▨ 暂停',
      retroTitle: '补记确认',
      retroOnlyRecent: '只能补记最近 7 天',
      habitPaused: '已暂停',
      habitArchived: '已归档',
      habitActive: '进行中',
      habitPause: '暂停',
      habitResume: '恢复',
      habitArchive: '归档',
      habitDetailTitle: '习惯详情',
      habitFrequencyLabel: '频率',
      habitPeriodLabel: '周期目标',
      habitRecentCheckins: '最近打卡',
      habitBackfill: '补记',
      projectsTitle: '项目',
      newProject: '＋ 新建项目',
      createProject: '创建项目',
      projectName: '名称',
      projectNamePlaceholder: '例如：LifeOS DSH 插件',
      projectDescription: '描述',
      projectTargetDate: '目标日',
      projectLongTerm: '长期',
      projectEmpty: '项目是可选的。任务可以先独立存在，之后再把它们收进一个项目。',
      projectEmptyHint: '给一组任务一个共同的目标。',
      projectFilterActive: '进行中',
      projectFilterAll: '全部',
      projectFilterPaused: '已暂停',
      projectFilterCompleted: '已完成',
      projectFilterArchived: '已归档',
      projectProgressPrefix: '任务完成 ',
      projectProgressNone: '任务完成 —',
      projectProgressSuffix: '（根据任务计算）',
      projectRecentActivity: '最近活动 ',
      projectOpen: '打开',
      projectTasks: '任务列表',
      projectNewTask: '新建任务',
      projectTaskPlaceholder: '任务标题，回车添加',
      projectAdd: '添加',
      projectEdit: '编辑',
      projectSaveEdit: '保存',
      projectCancelEdit: '取消',
      projectPause: '暂停',
      projectResume: '恢复',
      projectComplete: '完成项目',
      projectArchive: '归档',
      projectNoTasks: '这个项目还没有任务。',
      projectTaskGroupTodo: '待办',
      projectTaskGroupDoing: '进行中',
      projectTaskGroupDone: '已完成',
      projectTaskGroupCancelled: '已取消',
      projectOverview: '概览',
      reviewTitle: '回顾',
      reviewThisWeek: '本周',
      reviewLastWeek: '上周',
      reviewCompleted: '完成',
      reviewOpen: '进行中',
      reviewOverdue: '已逾期',
      reviewInboxPending: '待整理',
      reviewInboxConfirm: '待确认',
      reviewHabits: '习惯覆盖',
      reviewHabitMet: '达标',
      reviewHabitRecorded: '已记录',
      reviewProjects: '项目进度',
      reviewHabitsEmpty: '这周还没有习惯记录。',
      reviewEmpty: '这一周还没有记录。',
      todayHabits: '今日习惯',
      todayHabitsView: '查看习惯',
      todayHabitsChecked: '已打卡',
    })

    const TABS = [
      { id: 'today', label: '今日' },
      { id: 'todo', label: '待办' },
      { id: 'calendar', label: '日历' },
      { id: 'habits', label: '习惯' },
      { id: 'projects', label: '项目' },
      { id: 'notes', label: '笔记' },
      { id: 'review', label: '回顾' },
    ]

    const PRIORITY_ORDER = { high: 3, medium: 2, low: 1, none: 0 }
    const PRIORITY_LABEL = { high: '高', medium: '中', low: '低', none: '无' }
    const PRIORITY_OPTIONS = ['none', 'low', 'medium', 'high']
    const BOARD_PREFS_STORAGE_KEY = 'lifeos.ui-prefs'
    const DEFAULT_FILTERS = { projectId: null, tagId: null, priority: null, q: '' }
    const GROUP_ORDER = ['overdue', 'today', 'tomorrow', 'next7', 'later', 'none']
    const GROUP_LABEL = {
      overdue: '逾期',
      today: '今天',
      tomorrow: '明天',
      next7: '最近 7 天',
      later: '以后',
      none: '无日期',
    }

    function isObject(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value)
    }

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    function dateKeyOf(date) {
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    }

    function parseDateKey(key) {
      if (typeof key !== 'string') return null
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
      if (!match) return null
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      return Number.isNaN(date.getTime()) ? null : date
    }

    function addDaysKey(key, days) {
      const date = parseDateKey(key) || new Date()
      date.setDate(date.getDate() + Number(days || 0))
      return dateKeyOf(date)
    }

    function monthKeyOf(key) {
      const date = parseDateKey(key) || new Date()
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1)
    }

    function shiftMonthKey(monthKey, delta) {
      const match = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ''))
      if (!match) return monthKeyOf(todayIso())
      const date = new Date(Number(match[1]), Number(match[2]) - 1 + Number(delta || 0), 1)
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1)
    }

    function monthLabel(monthKey) {
      const match = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ''))
      if (!match) return String(monthKey || '')
      return Number(match[1]) + ' 年 ' + Number(match[2]) + ' 月'
    }

    /** 周一开始的月历网格：返回 6×7 = 42 个日期键与首尾键。 */
    function monthGrid(monthKey) {
      const match = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ''))
      const base = match ? new Date(Number(match[1]), Number(match[2]) - 1, 1) : new Date()
      const first = new Date(base.getFullYear(), base.getMonth(), 1)
      const weekday = (first.getDay() + 6) % 7 // 周一=0 … 周日=6
      const gridStart = new Date(first)
      gridStart.setDate(first.getDate() - weekday)
      const days = []
      for (let index = 0; index < 42; index += 1) {
        const date = new Date(gridStart)
        date.setDate(gridStart.getDate() + index)
        days.push({
          key: dateKeyOf(date),
          day: date.getDate(),
          inMonth: date.getMonth() === base.getMonth(),
          isToday: dateKeyOf(date) === todayIso(),
        })
      }
      return { month: monthKeyOf(dateKeyOf(first)), days, from: days[0].key, to: days[days.length - 1].key }
    }

    function localDatePart(isoLike) {
      if (!isoLike) return ''
      const text = String(isoLike)
      const direct = /^(\d{4}-\d{2}-\d{2})/.exec(text)
      if (direct) return direct[1]
      try {
        const date = new Date(text)
        if (Number.isNaN(date.getTime())) return ''
        return dateKeyOf(date)
      } catch (error) {
        return ''
      }
    }

    function localTimePart(isoLike) {
      if (!isoLike) return ''
      try {
        const date = new Date(isoLike)
        if (Number.isNaN(date.getTime())) return ''
        return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
      } catch (error) {
        return ''
      }
    }

    function localDateTimeToIso(dateKey, timeText) {
      const date = parseDateKey(dateKey)
      if (!date) return null
      const match = /^(\d{1,2}):(\d{2})$/.exec(String(timeText || '09:00'))
      const hours = match ? Number(match[1]) : 9
      const minutes = match ? Number(match[2]) : 0
      const local = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, 0, 0)
      return local.toISOString()
    }

    function taskAnchorDate(task) {
      if (!task) return ''
      return (
        task.scheduledDate ||
        localDatePart(task.scheduledStartAt) ||
        task.dueDate ||
        localDatePart(task.dueAt) ||
        ''
      )
    }

    function isTaskDone(task) {
      return !!task && (task.status === 'done' || task.status === 'cancelled')
    }

    function compareTaskTime(a, b) {
      const aTime = a && (a.scheduledStartAt || a.dueAt || '')
      const bTime = b && (b.scheduledStartAt || b.dueAt || '')
      if (!!aTime !== !!bTime) return aTime ? -1 : 1
      if (aTime && bTime) return String(aTime).localeCompare(String(bTime))
      return 0
    }

    function formatTaskDateLabel(task) {
      if (!task) return ''
      const anchor = taskAnchorDate(task)
      if (!anchor) return ''
      const today = todayIso()
      let label
      if (anchor === today) label = '今天'
      else if (anchor === addDaysKey(today, 1)) label = '明天'
      else if (anchor === addDaysKey(today, -1)) label = '昨天'
      else {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchor)
        label = match ? Number(match[2]) + '月' + Number(match[3]) + '日' : anchor
      }
      if (task.scheduledStartAt) {
        const start = localTimePart(task.scheduledStartAt)
        const end = task.scheduledEndAt ? localTimePart(task.scheduledEndAt) : ''
        if (start) label += ' ' + start + (end ? '–' + end : '')
      } else if (task.dueAt) {
        label = '截止 ' + (localDatePart(task.dueAt) === today ? '' : label + ' ') + localTimePart(task.dueAt)
      } else if (task.dueDate) {
        label = '截止 ' + label
      }
      return label
    }

    function taskProjectName(task) {
      if (!task) return ''
      return task.projectName || ''
    }

    function normalizedTags(task) {
      return task && Array.isArray(task.tags) ? task.tags.filter((tag) => tag && tag.id) : []
    }

    function taskGroupKey(task) {
      const today = todayIso()
      const anchor = taskAnchorDate(task)
      if (!anchor) return 'none'
      if (anchor < today) return 'overdue'
      if (anchor === today) return 'today'
      if (anchor === addDaysKey(today, 1)) return 'tomorrow'
      if (anchor <= addDaysKey(today, 7)) return 'next7'
      return 'later'
    }

    function groupTasksClientSide(tasks) {
      const groups = GROUP_ORDER.map(function empty(key) {
        return { key: key, label: GROUP_LABEL[key], tasks: [] }
      })
      const byKey = {}
      groups.forEach(function index(group) {
        byKey[group.key] = group
      })
      ;(Array.isArray(tasks) ? tasks : []).forEach(function place(task) {
        const key = taskGroupKey(task)
        ;(byKey[key] || byKey.none).tasks.push(task)
      })
      return groups.filter(function nonEmpty(group) {
        return group.tasks.length > 0
      })
    }

    /** 兼容服务端 groups 的多种形态：数组（带 items/tasks/ids）或对象 map；缺失时客户端分组。 */
    function normalizeTaskGroups(rawGroups, items) {
      const list = Array.isArray(items) ? items : []
      const byId = {}
      list.forEach(function index(task) {
        if (task && task.id) byId[task.id] = task
      })
      const groups = []
      if (Array.isArray(rawGroups)) {
        rawGroups.forEach(function each(group) {
          if (!group) return
          const key = group.key || group.group || group.id || 'none'
          let tasks = []
          if (Array.isArray(group.tasks)) tasks = group.tasks
          else if (Array.isArray(group.items)) {
            tasks = group.items.map(function resolve(entry) {
              if (typeof entry === 'string') return byId[entry] || null
              return entry
            })
          } else if (Array.isArray(group.ids)) {
            tasks = group.ids.map(function resolve(id) {
              return byId[id] || null
            })
          }
          tasks = tasks.filter(Boolean)
          if (tasks.length) {
            groups.push({
              key: key,
              label: group.label || GROUP_LABEL[key] || key,
              tasks: tasks,
              count: Number(group.count) || tasks.length,
            })
          }
        })
      } else if (isObject(rawGroups)) {
        Object.keys(rawGroups).forEach(function each(key) {
          const value = rawGroups[key]
          let tasks = []
          if (Array.isArray(value)) {
            tasks = value
              .map(function resolve(entry) {
                return typeof entry === 'string' ? byId[entry] : entry
              })
              .filter(Boolean)
          }
          if (tasks.length) {
            groups.push({ key: key, label: GROUP_LABEL[key] || key, tasks: tasks, count: tasks.length })
          }
        })
      }
      if (groups.length) {
        return groups.sort(function order(a, b) {
          return GROUP_ORDER.indexOf(a.key) - GROUP_ORDER.indexOf(b.key)
        })
      }
      return groupTasksClientSide(list)
    }

    function matchesFilters(task, filters) {
      if (!task || isTaskDone(task)) return false
      const active = filters || DEFAULT_FILTERS
      if (active.projectId && task.projectId !== active.projectId) return false
      if (active.tagId) {
        const tags = normalizedTags(task)
        if (!tags.some((tag) => tag.id === active.tagId)) return false
      }
      if (active.priority && task.priority !== active.priority) return false
      if (active.q) {
        const needle = String(active.q).toLowerCase()
        const haystack = (String(task.title || '') + ' ' + String(task.notes || '')).toLowerCase()
        if (haystack.indexOf(needle) < 0) return false
      }
      return true
    }

    function sortTasksForList(tasks) {
      const list = Array.isArray(tasks) ? tasks.slice() : []
      list.sort(function compare(a, b) {
        if (a.status !== b.status) {
          if (a.status === 'done') return 1
          if (b.status === 'done') return -1
        }
        const timeCompare = compareTaskTime(a, b)
        if (timeCompare !== 0) return timeCompare
        const priorityCompare = (PRIORITY_ORDER[b.priority] || 0) - (PRIORITY_ORDER[a.priority] || 0)
        if (priorityCompare !== 0) return priorityCompare
        return String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      })
      return list
    }

    function filterTasksClientSide(tasks, filters) {
      const list = Array.isArray(tasks) ? tasks : []
      return sortTasksForList(list.filter(function keep(task) {
        return matchesFilters(task, filters)
      }))
    }

    /* ── 快速添加：中文日期 / 优先级解析 ── */

    function parseQuickAdd(rawText) {
      let text = String(rawText || '').trim()
      const result = { title: '', dateKey: null, priority: null, matchedDate: '', matchedPriority: '' }
      if (!text) return result

      let priority = null
      const priorityMatch = /[!！](高|中|低|高优|中优|低优)/.exec(text)
      if (priorityMatch) {
        const word = priorityMatch[1]
        priority = word.indexOf('高') === 0 ? 'high' : word.indexOf('中') === 0 ? 'medium' : 'low'
        result.matchedPriority = priorityMatch[0]
        text = text.slice(0, priorityMatch.index) + ' ' + text.slice(priorityMatch.index + priorityMatch[0].length)
      }

      const today = todayIso()
      let dateKey = null
      let matchedDate = ''

      const isoMatch = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text)
      if (isoMatch) {
        const candidate = isoMatch[1] + '-' + pad2(isoMatch[2]) + '-' + pad2(isoMatch[3])
        if (parseDateKey(candidate)) {
          dateKey = candidate
          matchedDate = isoMatch[0]
        }
      }
      if (!dateKey) {
        const mdMatch = /(\d{1,2})月(\d{1,2})日?/.exec(text)
        if (mdMatch) {
          const now = new Date()
          let year = now.getFullYear()
          let candidate = year + '-' + pad2(mdMatch[1]) + '-' + pad2(mdMatch[2])
          if (!parseDateKey(candidate)) candidate = ''
          if (candidate) {
            // 没有年份的日期若已过去，顺延到明年更方便日常使用。
            if (candidate < today) candidate = year + 1 + '-' + pad2(mdMatch[1]) + '-' + pad2(mdMatch[2])
            dateKey = candidate
            matchedDate = mdMatch[0]
          }
        }
      }
      if (!dateKey) {
        const relative = /(今天|明天|后天|大后天)/.exec(text)
        if (relative) {
          const offsets = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 }
          dateKey = addDaysKey(today, offsets[relative[1]])
          matchedDate = relative[0]
        }
      }
      if (!dateKey) {
        const nextWeek = /下周([一二三四五六日天])/.exec(text)
        if (nextWeek) {
          const weekdayMap = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }
          const date = parseDateKey(today)
          const currentWeekday = (date.getDay() + 6) % 7
          const target = 7 - currentWeekday + weekdayMap[nextWeek[1]]
          dateKey = addDaysKey(today, target)
          matchedDate = nextWeek[0]
        }
      }
      if (!dateKey) {
        const weekdayMatch = /(周|星期)([一二三四五六日天])/.exec(text)
        if (weekdayMatch) {
          const weekdayMap = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }
          const date = parseDateKey(today)
          const currentWeekday = (date.getDay() + 6) % 7
          let delta = weekdayMap[weekdayMatch[2]] - currentWeekday
          if (delta <= 0) delta += 7
          dateKey = addDaysKey(today, delta)
          matchedDate = weekdayMatch[0]
        }
      }

      if (matchedDate) text = text.split(matchedDate).join(' ')
      if (result.matchedPriority) text = text.split(result.matchedPriority).join(' ')
      result.title = text.replace(/\s+/g, ' ').trim()
      result.dateKey = dateKey
      result.priority = priority
      return result
    }

    function quickAddChipLabel(state) {
      const parts = []
      if (state && state.dateKey) {
        const today = todayIso()
        if (state.dateKey === today) parts.push('今天')
        else if (state.dateKey === addDaysKey(today, 1)) parts.push('明天')
        else parts.push(state.dateKey)
      }
      if (state && state.priority) parts.push('!' + PRIORITY_LABEL[state.priority])
      return parts.join(' · ')
    }

    /* ═════════════════════════ M1：HTTP API ═════════════════════════ */

    function fetchTasks(params) {
      const query = []
      const input = params || {}
      Object.keys(input).forEach(function each(key) {
        const value = input[key]
        if (value === undefined || value === null || value === '') return
        query.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
      })
      return apiRequest('/tasks' + (query.length ? '?' + query.join('&') : ''))
    }

    function fetchTask(id) {
      return apiRequest('/tasks/' + encodeURIComponent(id))
    }

    function postTask(body) {
      return apiRequest('/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }

    function patchTaskApi(id, patch, expectedRev) {
      return apiRequest('/tasks/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'If-Match': String(expectedRev),
        },
        body: JSON.stringify(Object.assign({ expectedRev: expectedRev }, patch || {})),
      })
    }

    function postTaskAction(id, action, expectedRev) {
      return apiRequest('/tasks/' + encodeURIComponent(id) + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ expectedRev: expectedRev }),
      })
    }

    function postTaskReschedule(id, input, expectedRev) {
      return apiRequest('/tasks/' + encodeURIComponent(id) + '/reschedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(Object.assign({ expectedRev: expectedRev }, input || {})),
      })
    }

    function fetchCalendarApi(from, to) {
      return apiRequest('/calendar?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to))
    }

    function fetchProjectsApi() {
      return apiRequest('/projects')
    }

    function fetchTagsApi() {
      return apiRequest('/tags')
    }

    function fetchUiPrefsApi() {
      return apiRequest('/ui-prefs')
    }

    function putUiPrefsApi(prefs) {
      return apiRequest('/ui-prefs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(prefs || {}),
      })
    }

    /* ═════════════════════════ M1：mock 数据（Host 未就绪兜底） ═════════════════════════ */

    function createMockBoardStore() {
      const now = Date.now()
      const today = todayIso()
      function iso(offsetDays, hours, minutes) {
        return localDateTimeToIso(addDaysKey(today, offsetDays), pad2(hours) + ':' + pad2(minutes))
      }
      function task(id, title, extra) {
        return Object.assign(
          {
            id: id,
            title: title,
            notes: '',
            status: 'todo',
            priority: 'none',
            projectId: null,
            projectName: null,
            tags: [],
            scheduledDate: null,
            scheduledStartAt: null,
            scheduledEndAt: null,
            isAllDay: true,
            dueDate: null,
            dueAt: null,
            completedAt: null,
            createdAt: new Date(now - 86400000).toISOString(),
            updatedAt: new Date(now).toISOString(),
            rev: 1,
            timeKind: 'none',
          },
          extra || {},
        )
      }
      const tasks = [
        task('mock_t1', '给导师发实验结果（示例）', {
          dueDate: addDaysKey(today, -1),
          priority: 'high',
          projectId: 'mock_p1',
          projectName: 'LifeOS',
          tags: [{ id: 'mock_tag1', name: '科研', color: '#3f6bd8' }],
        }),
        task('mock_t2', '改实验报告', {
          scheduledStartAt: iso(0, 15, 0),
          scheduledEndAt: iso(0, 16, 0),
          isAllDay: false,
          timeKind: 'span',
          priority: 'high',
          projectId: 'mock_p1',
          projectName: 'LifeOS',
          tags: [{ id: 'mock_tag1', name: '科研', color: '#3f6bd8' }],
        }),
        task('mock_t3', '预约体检', {
          scheduledDate: today,
          isAllDay: true,
          timeKind: 'date',
          priority: 'medium',
        }),
        task('mock_t4', '整理 Obsidian 笔记', {
          scheduledDate: addDaysKey(today, 1),
          isAllDay: true,
          timeKind: 'date',
          priority: 'low',
          projectId: 'mock_p2',
          projectName: '整理',
          tags: [{ id: 'mock_tag2', name: '整理', color: '#c98a1b' }],
        }),
        task('mock_t5', '写周报', {
          dueDate: addDaysKey(today, 3),
          priority: 'medium',
        }),
        task('mock_t6', '突然想到的灵感：做一个每日回顾页', {}),
        task('mock_t7', '下月复盘', { scheduledDate: addDaysKey(today, 20), timeKind: 'date' }),
        task('mock_t8', '昨天已完成的任务', {
          status: 'done',
          completedAt: iso(-1, 20, 0),
          scheduledDate: addDaysKey(today, -1),
        }),
      ]
      return {
        tasks: tasks,
        projects: [
          { id: 'mock_p1', name: 'LifeOS', color: '#2f8fd6', status: 'active', rev: 1 },
          { id: 'mock_p2', name: '整理', color: '#c98a1b', status: 'active', rev: 1 },
        ],
        tags: [
          { id: 'mock_tag1', name: '科研', color: '#3f6bd8' },
          { id: 'mock_tag2', name: '整理', color: '#c98a1b' },
          { id: 'mock_tag3', name: '健康', color: '#1f9d63' },
        ],
        prefs: { tab: 'today', filters: Object.assign({}, DEFAULT_FILTERS) },
        seq: 8,
      }
    }

    const mockBoardStore = createMockBoardStore()

    function mockTasksMatching(params) {
      const input = params || {}
      const view = input.view || 'all'
      const filters = {
        projectId: input.projectId || null,
        tagId: input.tagId || null,
        priority: input.priority || null,
        q: input.q || '',
      }
      const today = todayIso()
      let list = mockBoardStore.tasks.filter(function keep(task) {
        return !isTaskDone(task)
      })
      if (view === 'today') {
        list = list.filter(function filter(task) {
          const anchor = taskAnchorDate(task)
          return anchor === today
        })
      } else if (view === 'overdue') {
        list = list.filter(function filter(task) {
          if (task.dueDate && task.dueDate < today) return true
          if (task.dueAt && new Date(task.dueAt).getTime() < Date.now()) return true
          return false
        })
      } else if (view === 'next7') {
        const limit = addDaysKey(today, 7)
        list = list.filter(function filter(task) {
          const anchor = taskAnchorDate(task)
          return anchor && anchor >= today && anchor <= limit
        })
      }
      list = filterTasksClientSide(list, filters)
      return {
        items: list,
        groups: groupTasksClientSide(list),
        nextCursor: null,
        mock: true,
      }
    }

    function mockTaskById(id) {
      const found = mockBoardStore.tasks.find(function find(task) {
        return task.id === id
      })
      return found ? JSON.parse(JSON.stringify(found)) : null
    }

    function withMockTags(task) {
      const clone = JSON.parse(JSON.stringify(task))
      clone.tags = (clone.tags || []).map(function mapTag(tag) {
        const known = mockBoardStore.tags.find(function find(item) {
          return item.id === tag.id
        })
        return known || tag
      })
      return clone
    }

    function mockCreateTask(body) {
      mockBoardStore.seq += 1
      const now = new Date().toISOString()
      const id = 'mock_t_new_' + mockBoardStore.seq
      const project = (mockBoardStore.projects || []).find(function find(item) {
        return item.id === body.projectId
      })
      const created = {
        id: id,
        title: String(body.title || '').trim() || '未命名任务',
        notes: body.notes || '',
        status: 'todo',
        priority: body.priority || 'none',
        projectId: body.projectId || null,
        projectName: project ? project.name : null,
        tags: (body.tagIds || [])
          .map(function mapTag(tagId) {
            return mockBoardStore.tags.find(function find(item) {
              return item.id === tagId
            })
          })
          .filter(Boolean),
        scheduledDate: body.scheduledDate || null,
        scheduledStartAt: body.scheduledStartAt || null,
        scheduledEndAt: body.scheduledEndAt || null,
        isAllDay: body.isAllDay !== false,
        dueDate: body.dueDate || null,
        dueAt: body.dueAt || null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        rev: 1,
        timeKind: body.scheduledStartAt ? 'span' : body.scheduledDate ? 'date' : body.dueDate || body.dueAt ? 'date' : 'none',
      }
      mockBoardStore.tasks.unshift(created)
      return { task: JSON.parse(JSON.stringify(created)), rev: created.rev }
    }

    function mockPatchTask(id, patch, expectedRev) {
      const found = mockBoardStore.tasks.find(function find(task) {
        return task.id === id
      })
      if (!found) throw ApiError('not_found', '任务不存在')
      if (Number(expectedRev) !== Number(found.rev)) {
        throw ApiError('conflict', '任务已被其它地方修改', { current: JSON.parse(JSON.stringify(found)) })
      }
      const editable = [
        'title',
        'notes',
        'priority',
        'status',
        'projectId',
        'scheduledDate',
        'scheduledStartAt',
        'scheduledEndAt',
        'dueDate',
        'dueAt',
        'isAllDay',
        'timeKind',
      ]
      editable.forEach(function apply(key) {
        if (patch && Object.prototype.hasOwnProperty.call(patch, key)) found[key] = patch[key]
      })
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'tagIds')) {
        found.tags = (patch.tagIds || [])
          .map(function mapTag(tagId) {
            return mockBoardStore.tags.find(function find(item) {
              return item.id === tagId
            })
          })
          .filter(Boolean)
      }
      if (Object.prototype.hasOwnProperty.call(patch || {}, 'projectId')) {
        const project = (mockBoardStore.projects || []).find(function find(item) {
          return item.id === found.projectId
        })
        found.projectName = project ? project.name : null
      }
      found.rev = Number(found.rev) + 1
      found.updatedAt = new Date().toISOString()
      return { task: JSON.parse(JSON.stringify(found)), rev: found.rev }
    }

    function mockTaskAction(id, action, expectedRev) {
      const found = mockBoardStore.tasks.find(function find(task) {
        return task.id === id
      })
      if (!found) throw ApiError('not_found', '任务不存在')
      if (Number(expectedRev) !== Number(found.rev)) {
        throw ApiError('conflict', '任务已被其它地方修改', { current: JSON.parse(JSON.stringify(found)) })
      }
      if (action === 'complete') {
        found.status = 'done'
        found.completedAt = new Date().toISOString()
      } else if (action === 'reopen') {
        found.status = 'todo'
        found.completedAt = null
      } else if (action === 'cancel') {
        found.status = 'cancelled'
      }
      found.rev = Number(found.rev) + 1
      found.updatedAt = new Date().toISOString()
      return { task: JSON.parse(JSON.stringify(found)) }
    }

    function mockRescheduleTask(id, input, expectedRev) {
      const found = mockBoardStore.tasks.find(function find(task) {
        return task.id === id
      })
      if (!found) throw ApiError('not_found', '任务不存在')
      if (Number(expectedRev) !== Number(found.rev)) {
        throw ApiError('conflict', '任务已被其它地方修改', { current: JSON.parse(JSON.stringify(found)) })
      }
      const patch = input || {}
      found.scheduledDate = Object.prototype.hasOwnProperty.call(patch, 'scheduledDate') ? patch.scheduledDate : null
      found.scheduledStartAt = null
      found.scheduledEndAt = null
      found.isAllDay = true
      found.timeKind = found.scheduledDate ? 'date' : 'none'
      found.rev = Number(found.rev) + 1
      found.updatedAt = new Date().toISOString()
      return { task: JSON.parse(JSON.stringify(found)) }
    }

    function mockCalendar(from, to) {
      const days = []
      let cursor = from
      let guard = 0
      while (cursor <= to && guard < 60) {
        const tasks = sortTasksForList(
          mockBoardStore.tasks.filter(function keep(task) {
            return !isTaskDone(task) && taskAnchorDate(task) === cursor
          }),
        )
        days.push({ date: cursor, tasks: tasks })
        cursor = addDaysKey(cursor, 1)
        guard += 1
      }
      const unscheduled = sortTasksForList(
        mockBoardStore.tasks.filter(function keep(task) {
          return !isTaskDone(task) && !taskAnchorDate(task)
        }),
      )
      return {
        days: days.map(function mapDay(day) {
          return { date: day.date, tasks: day.tasks.map(withMockTags) }
        }),
        unscheduled: unscheduled.map(withMockTags),
        mock: true,
      }
    }

    function mockPrefsGet() {
      return { prefs: JSON.parse(JSON.stringify(mockBoardStore.prefs)) }
    }

    function mockPrefsSet(patch) {
      const next = Object.assign({}, mockBoardStore.prefs)
      if (patch && typeof patch === 'object') {
        if (patch.tab) next.tab = patch.tab
        if (patch.filters && typeof patch.filters === 'object') {
          next.filters = Object.assign({}, next.filters, patch.filters)
        }
      }
      mockBoardStore.prefs = next
      return { prefs: JSON.parse(JSON.stringify(next)) }
    }

    /* ═════════════════════════ M1：看板运行时（单页单例，独立于 M0 runtime） ═════════════════════════ */

    function createBoardRuntime(m0) {
      const initialMonth = monthKeyOf(todayIso())
      const initial = {
        phase: 'idle',
        mock: false,
        prefs: { tab: 'today', filters: Object.assign({}, DEFAULT_FILTERS) },
        projects: { phase: 'idle', items: [], error: null },
        tags: { phase: 'idle', items: [], error: null },
        today: { phase: 'idle', tasks: [], overdue: [], inboxCount: null, error: null, at: null },
        tasks: { phase: 'idle', items: [], groups: [], counts: null, error: null, at: null },
        calendar: {
          phase: 'idle',
          month: initialMonth,
          days: [],
          unscheduled: [],
          selectedDate: null,
          error: null,
          at: null,
        },
        detail: {
          open: false,
          id: null,
          task: null,
          draft: null,
          rev: null,
          phase: 'idle',
          dirty: false,
          saving: false,
          error: null,
          conflict: null,
          latest: null,
        },
        quickAdd: { focusSignal: 0, submitting: false, error: null },
        focusIndex: -1,
        pendingRefresh: false,
      }

      let snapshot = initial
      const listeners = new Set()
      const rowRefs = new Map()
      const timers = new Set()
      let prefsSaveTimer = null
      let searchTimer = null
      let refreshTimer = null
      let disposed = false

      function schedule(fn, delay) {
        const id = window.setTimeout(function run() {
          timers.delete(id)
          try {
            fn()
          } catch (error) {
            console.error('[lifeos] board timer failed', error)
          }
        }, delay)
        timers.add(id)
        return id
      }

      function getState() {
        return snapshot
      }

      function setState(next) {
        if (disposed) return
        if (!next || next === snapshot) return
        snapshot = next
        Array.from(listeners).forEach(function notify(listener) {
          try {
            listener()
          } catch (error) {
            console.error('[lifeos] board subscriber failed', error)
          }
        })
      }

      function update(patch) {
        setState(Object.assign({}, snapshot, patch || {}))
      }

      function subscribe(listener) {
        listeners.add(listener)
        return function unsubscribe() {
          listeners.delete(listener)
        }
      }

      function sanitizeTab(tab) {
        const mapped = tab === 'inbox' ? 'today' : tab
        return TABS.some(function find(item) {
          return item.id === mapped
        })
          ? mapped
          : 'today'
      }

      function sanitizeFilters(raw) {
        const filters = Object.assign({}, DEFAULT_FILTERS)
        if (raw && typeof raw === 'object') {
          if (typeof raw.projectId === 'string' && raw.projectId) filters.projectId = raw.projectId
          if (typeof raw.tagId === 'string' && raw.tagId) filters.tagId = raw.tagId
          if (raw.priority === 'low' || raw.priority === 'medium' || raw.priority === 'high') filters.priority = raw.priority
          if (typeof raw.q === 'string') filters.q = raw.q
        }
        return filters
      }

      function readLocalPrefs() {
        try {
          const raw = window.localStorage.getItem(BOARD_PREFS_STORAGE_KEY)
          if (!raw) return null
          const parsed = JSON.parse(raw)
          if (!isObject(parsed)) return null
          return { tab: sanitizeTab(parsed.tab), filters: sanitizeFilters(parsed.filters) }
        } catch (error) {
          return null
        }
      }

      function writeLocalPrefs(prefs) {
        try {
          window.localStorage.setItem(BOARD_PREFS_STORAGE_KEY, JSON.stringify(prefs))
        } catch (error) {
          /* ignore */
        }
      }

      function mergedPrefs(patch) {
        const base = snapshot.prefs || { tab: 'today', filters: Object.assign({}, DEFAULT_FILTERS) }
        const next = {
          tab: sanitizeTab(patch && patch.tab ? patch.tab : base.tab),
          filters: sanitizeFilters(Object.assign({}, base.filters, patch && patch.filters ? patch.filters : {})),
        }
        return next
      }

      function scheduleSavePrefs() {
        if (prefsSaveTimer) {
          try {
            window.clearTimeout(prefsSaveTimer)
          } catch (error) {
            /* ignore */
          }
        }
        prefsSaveTimer = schedule(function savePrefsNow() {
          prefsSaveTimer = null
          const prefs = snapshot.prefs
          writeLocalPrefs(prefs)
          putUiPrefsApi(prefs)
            .then(function onSaved(value) {
              const saved = value && value.prefs ? value.prefs : value
              if (isObject(saved) && saved.tab) {
                update({
                  prefs: {
                    tab: sanitizeTab(saved.tab),
                    filters: sanitizeFilters(saved.filters || snapshot.prefs.filters),
                  },
                })
              }
            })
            .catch(function onError() {
              /* 本地已保存，Host 恢复后 init 会再次同步 */
            })
        }, 300)
      }

      function loadPrefs() {
        return fetchUiPrefsApi()
          .then(function onOk(value) {
            const prefs = value && value.prefs ? value.prefs : value
            update({
              prefs: {
                tab: sanitizeTab(prefs && prefs.tab),
                filters: sanitizeFilters(prefs && prefs.filters),
              },
              mock: false,
            })
          })
          .catch(function onError() {
            const local = readLocalPrefs()
            const mocks = mockPrefsGet().prefs
            const prefs = local || mocks
            update({
              prefs: {
                tab: sanitizeTab(prefs.tab),
                filters: sanitizeFilters(prefs.filters),
              },
            })
          })
      }

      function setTab(tab) {
        const next = sanitizeTab(tab)
        update({ prefs: mergedPrefs({ tab: next }), focusIndex: -1 })
        scheduleSavePrefs()
        return refreshCurrent('tab')
      }

      function setFilters(patch) {
        update({ prefs: mergedPrefs({ filters: patch || {} }), focusIndex: -1 })
        scheduleSavePrefs()
        if (snapshot.prefs.tab !== 'todo') return Promise.resolve()
        if (patch && Object.prototype.hasOwnProperty.call(patch, 'q')) {
          if (searchTimer) {
            try {
              window.clearTimeout(searchTimer)
            } catch (error) {
              /* ignore */
            }
          }
          searchTimer = schedule(function runSearch() {
            searchTimer = null
            loadTasks()
          }, 220)
          return Promise.resolve()
        }
        return loadTasks()
      }

      function clearFilters() {
        update({ prefs: mergedPrefs({ filters: Object.assign({}, DEFAULT_FILTERS) }) })
        scheduleSavePrefs()
        if (snapshot.prefs.tab === 'todo') loadTasks()
      }

      function setQuickAddFocus() {
        update({ quickAdd: Object.assign({}, snapshot.quickAdd, { focusSignal: (snapshot.quickAdd.focusSignal || 0) + 1 }) })
      }

      function isEditing() {
        return snapshot.detail.open && snapshot.detail.dirty === true
      }

      /* ── 加载：项目 / 标签 ── */

      function loadProjects() {
        return fetchProjectsApi()
          .then(function onOk(value) {
            const items = value && Array.isArray(value.items) ? value.items : Array.isArray(value) ? value : []
            update({ projects: { phase: 'ready', items: items, error: null } })
          })
          .catch(function onError(error) {
            update({
              projects: { phase: 'fallback', items: mockBoardStore.projects.slice(), error: errorText(error) },
            })
          })
      }

      function loadTags() {
        return fetchTagsApi()
          .then(function onOk(value) {
            const items = value && Array.isArray(value.items) ? value.items : Array.isArray(value) ? value : []
            update({ tags: { phase: 'ready', items: items, error: null } })
          })
          .catch(function onError(error) {
            update({ tags: { phase: 'fallback', items: mockBoardStore.tags.slice(), error: errorText(error) } })
          })
      }

      /* ── 加载：今日 ── */

      function loadToday() {
        update({ today: Object.assign({}, snapshot.today, { phase: snapshot.today.tasks.length ? 'ready' : 'loading', error: null }) })
        const todayPromise = fetchTasks({ view: 'today', limit: 50 })
        const overduePromise = fetchTasks({ view: 'overdue', limit: 50 })
        return Promise.all([todayPromise, overduePromise])
          .then(function onOk(results) {
            const todayValue = results[0] || {}
            const overdueValue = results[1] || {}
            const tasks = sortTasksForList(
              (Array.isArray(todayValue.items) ? todayValue.items : []).filter(function keep(task) {
                return !isTaskDone(task)
              }),
            )
            const overdue = sortTasksForList(
              (Array.isArray(overdueValue.items) ? overdueValue.items : []).filter(function keep(task) {
                return !isTaskDone(task)
              }),
            )
            update({
              today: {
                phase: 'ready',
                tasks: tasks,
                overdue: overdue,
                inboxCount: null,
                error: null,
                at: nowIso(),
              },
              mock: false,
            })
          })
          .catch(function onError(error) {
            const todayMock = mockTasksMatching({ view: 'today' })
            const overdueMock = mockTasksMatching({ view: 'overdue' })
            update({
              today: {
                phase: 'fallback',
                tasks: todayMock.items,
                overdue: overdueMock.items,
                inboxCount: null,
                error: errorText(error),
                at: nowIso(),
              },
              mock: true,
            })
          })
      }

      /* ── 加载：待办（服务端分组 + 本地优先级/搜索过滤兜底） ── */

      function loadTasks() {
        const filters = snapshot.prefs.filters || DEFAULT_FILTERS
        const params = { view: 'all', limit: 100 }
        if (filters.projectId) params.projectId = filters.projectId
        if (filters.tagId) params.tagId = filters.tagId
        if (filters.q) params.q = filters.q
        update({ tasks: Object.assign({}, snapshot.tasks, { phase: snapshot.tasks.items.length ? 'ready' : 'loading', error: null }) })
        return fetchTasks(params)
          .then(function onOk(value) {
            const rawItems = Array.isArray(value) ? value : Array.isArray(value && value.items) ? value.items : []
            const items = rawItems.filter(function keep(task) {
              return !isTaskDone(task)
            })
            const filtered = filters.priority
              ? items.filter(function byPriority(task) {
                  return task.priority === filters.priority
                })
              : items
            const groups = filters.priority
              ? groupTasksClientSide(filtered)
              : normalizeTaskGroups(value && value.groups, filtered)
            update({
              tasks: {
                phase: 'ready',
                items: sortTasksForList(filtered),
                groups: groups,
                counts: (value && value.counts) || null,
                error: null,
                at: nowIso(),
              },
              mock: false,
            })
          })
          .catch(function onError(error) {
            const mock = mockTasksMatching(params)
            const filtered = filters.priority
              ? mock.items.filter(function byPriority(task) {
                  return task.priority === filters.priority
                })
              : mock.items
            update({
              tasks: {
                phase: 'fallback',
                items: sortTasksForList(filtered),
                groups: groupTasksClientSide(filtered),
                counts: null,
                error: errorText(error),
                at: nowIso(),
              },
              mock: true,
            })
          })
      }

      /* ── 加载：日历 ── */

      function loadCalendar(monthKey) {
        const grid = monthGrid(monthKey || snapshot.calendar.month)
        update({
          calendar: Object.assign({}, snapshot.calendar, {
            month: grid.month,
            phase: snapshot.calendar.days.length ? 'ready' : 'loading',
            error: null,
          }),
        })
        return fetchCalendarApi(grid.from, grid.to)
          .then(function onOk(value) {
            const days = value && Array.isArray(value.days) ? value.days : []
            const unscheduled = value && Array.isArray(value.unscheduled) ? value.unscheduled : []
            update({
              calendar: {
                phase: 'ready',
                month: grid.month,
                days: days,
                unscheduled: unscheduled,
                selectedDate: snapshot.calendar.selectedDate,
                error: null,
                at: nowIso(),
              },
              mock: false,
            })
          })
          .catch(function onError(error) {
            const mocks = mockCalendar(grid.from, grid.to)
            update({
              calendar: {
                phase: 'fallback',
                month: grid.month,
                days: mocks.days,
                unscheduled: mocks.unscheduled,
                selectedDate: snapshot.calendar.selectedDate,
                error: errorText(error),
                at: nowIso(),
              },
              mock: true,
            })
          })
      }

      function setCalendarMonth(monthKey) {
        return loadCalendar(monthKey)
      }

      function shiftCalendarMonth(delta) {
        const next = shiftMonthKey(snapshot.calendar.month, delta)
        update({ calendar: Object.assign({}, snapshot.calendar, { selectedDate: null }) })
        return loadCalendar(next)
      }

      function selectCalendarDate(dateKey) {
        update({ calendar: Object.assign({}, snapshot.calendar, { selectedDate: dateKey || null }) })
      }

      function calendarTasksByDate(dateKey) {
        const day = (snapshot.calendar.days || []).find(function find(item) {
          return item.date === dateKey
        })
        return day && Array.isArray(day.tasks) ? day.tasks : []
      }

      /* ── 详情抽屉 ── */

      function draftFromTask(task) {
        const base = task || {}
        let mode = 'none'
        if (base.scheduledStartAt || base.scheduledEndAt) mode = 'span'
        else if (base.scheduledDate) mode = 'date'
        else if (base.dueAt || base.dueDate) mode = 'due'
        return {
          title: String(base.title || ''),
          notes: String(base.notes || ''),
          priority: base.priority || 'none',
          projectId: base.projectId || null,
          tagIds: normalizedTags(base).map(function mapTag(tag) {
            return tag.id
          }),
          mode: mode,
          dateText: base.scheduledDate || localDatePart(base.scheduledStartAt) || base.dueDate || localDatePart(base.dueAt) || todayIso(),
          startTime: localTimePart(base.scheduledStartAt) || '09:00',
          endTime: localTimePart(base.scheduledEndAt) || '10:00',
        }
      }

      function openTask(taskOrId) {
        const taskObj = typeof taskOrId === 'string' ? findCachedTask(taskOrId) : taskOrId
        if (!taskObj) return Promise.resolve()
        update({
          detail: {
            open: true,
            id: taskObj.id,
            task: taskObj,
            draft: draftFromTask(taskObj),
            rev: Number(taskObj.rev) || 1,
            phase: 'loading',
            dirty: false,
            saving: false,
            error: null,
            conflict: null,
            latest: null,
          },
        })
        fetchTask(taskObj.id)
          .then(function onOk(value) {
            const task = value && value.task ? value.task : value
            if (!task || !task.id) return
            if (snapshot.detail.id !== task.id) return
            update({
              detail: Object.assign({}, snapshot.detail, {
                task: task,
                rev: Number(task.rev) || 1,
                phase: 'ready',
                draft: snapshot.detail.dirty ? snapshot.detail.draft : draftFromTask(task),
              }),
            })
          })
          .catch(function onError(error) {
            if (snapshot.detail.id !== taskObj.id) return
            update({ detail: Object.assign({}, snapshot.detail, { phase: 'ready', error: errorText(error) }) })
          })
        return Promise.resolve()
      }

      function findCachedTask(id) {
        const pools = [
          snapshot.today.tasks,
          snapshot.today.overdue,
          snapshot.tasks.items,
          snapshot.calendar.unscheduled,
        ]
        for (let index = 0; index < pools.length; index += 1) {
          const found = (pools[index] || []).find(function match(task) {
            return task && task.id === id
          })
          if (found) return found
        }
        const days = snapshot.calendar.days || []
        for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
          const found = (days[dayIndex].tasks || []).find(function match(task) {
            return task && task.id === id
          })
          if (found) return found
        }
        return null
      }

      function updateDraft(patch) {
        if (!snapshot.detail.open) return
        update({
          detail: Object.assign({}, snapshot.detail, {
            draft: Object.assign({}, snapshot.detail.draft, patch || {}),
            dirty: true,
            conflict: null,
          }),
        })
      }

      function buildPatchFromDraft(draft) {
        const patch = {
          title: String(draft.title || '').trim(),
          notes: String(draft.notes || ''),
          priority: PRIORITY_OPTIONS.indexOf(draft.priority) >= 0 ? draft.priority : 'none',
          projectId: draft.projectId || null,
          tagIds: Array.isArray(draft.tagIds) ? draft.tagIds : [],
        }
        if (draft.mode === 'date') {
          patch.scheduledDate = draft.dateText || todayIso()
          patch.scheduledStartAt = null
          patch.scheduledEndAt = null
          patch.dueDate = null
          patch.dueAt = null
          patch.isAllDay = true
        } else if (draft.mode === 'span') {
          const startIso = localDateTimeToIso(draft.dateText, draft.startTime)
          const endIso = localDateTimeToIso(draft.dateText, draft.endTime)
          patch.scheduledDate = null
          patch.scheduledStartAt = startIso
          patch.scheduledEndAt = endIso
          patch.dueDate = null
          patch.dueAt = null
          patch.isAllDay = false
        } else if (draft.mode === 'due') {
          patch.scheduledDate = null
          patch.scheduledStartAt = null
          patch.scheduledEndAt = null
          patch.dueDate = draft.dateText || todayIso()
          patch.dueAt = null
          patch.isAllDay = true
        } else {
          patch.scheduledDate = null
          patch.scheduledStartAt = null
          patch.scheduledEndAt = null
          patch.dueDate = null
          patch.dueAt = null
          patch.isAllDay = true
        }
        return patch
      }

      function applyTaskToCaches(task) {
        if (!task || !task.id) return
        function replace(list) {
          return (Array.isArray(list) ? list : []).map(function map(item) {
            return item && item.id === task.id ? task : item
          })
        }
        const days = (snapshot.calendar.days || []).map(function mapDay(day) {
          return Object.assign({}, day, { tasks: replace(day.tasks) })
        })
        update({
          today: Object.assign({}, snapshot.today, { tasks: replace(snapshot.today.tasks), overdue: replace(snapshot.today.overdue) }),
          tasks: Object.assign({}, snapshot.tasks, {
            items: replace(snapshot.tasks.items),
            groups: normalizeTaskGroups(snapshot.tasks.groups, replace(snapshot.tasks.items)),
          }),
          calendar: Object.assign({}, snapshot.calendar, { days: days, unscheduled: replace(snapshot.calendar.unscheduled) }),
        })
      }

      function saveDetail() {
        const detail = snapshot.detail
        if (!detail.open || !detail.draft) return Promise.resolve()
        if (detail.saving) return Promise.resolve()
        const patch = buildPatchFromDraft(detail.draft)
        if (!patch.title) {
          update({ detail: Object.assign({}, detail, { error: '标题不能为空' }) })
          return Promise.resolve()
        }
        update({ detail: Object.assign({}, detail, { saving: true, error: null, conflict: null }) })
        return patchTaskApi(detail.id, patch, detail.rev)
          .then(function onOk(value) {
            const task = value && value.task ? value.task : value
            const rev = value && value.rev !== undefined ? value.rev : task && task.rev
            update({
              detail: Object.assign({}, snapshot.detail, {
                task: task || snapshot.detail.task,
                rev: Number(rev) || readyRev(task, snapshot.detail.rev),
                draft: draftFromTask(task || snapshot.detail.task),
                saving: false,
                dirty: false,
                phase: 'ready',
                error: null,
                conflict: null,
              }),
            })
            applyTaskToCaches(task)
            m0.toast('success', TEXT.saved)
            refreshCurrent('detail-saved')
          })
          .catch(function onError(error) {
            if (error && error.code === 'conflict') {
              const current = error.details && error.details.current ? error.details.current : null
              update({
                detail: Object.assign({}, snapshot.detail, {
                  saving: false,
                  dirty: true,
                  conflict: TEXT.conflictNotice,
                  latest: current,
                  error: null,
                }),
              })
              if (current) applyTaskToCaches(current)
              refreshCurrent('detail-conflict')
              return
            }
            update({
              detail: Object.assign({}, snapshot.detail, { saving: false, error: errorText(error) }),
            })
            m0.toast('error', TEXT.saveFailed + '：' + errorText(error))
          })
      }

      function readyRev(task, fallback) {
        return task && task.rev !== undefined ? task.rev : fallback
      }

      function useLatestVersion() {
        const detail = snapshot.detail
        const latest = detail.latest || detail.task
        if (!latest) return
        update({
          detail: Object.assign({}, detail, {
            task: latest,
            rev: Number(latest.rev) || detail.rev,
            draft: draftFromTask(latest),
            dirty: false,
            conflict: null,
            latest: null,
            error: null,
          }),
        })
        applyTaskToCaches(latest)
      }

      function keepMine() {
        const detail = snapshot.detail
        const latest = detail.latest || detail.task
        if (!latest) return
        update({
          detail: Object.assign({}, detail, {
            rev: Number(latest.rev) || detail.rev,
            conflict: null,
            latest: null,
          }),
        })
      }

      function closeDetail() {
        const wasEditing = isEditing()
        update({
          detail: {
            open: false,
            id: null,
            task: null,
            draft: null,
            rev: null,
            phase: 'idle',
            dirty: false,
            saving: false,
            error: null,
            conflict: null,
            latest: null,
          },
          focusIndex: -1,
        })
        if (snapshot.pendingRefresh || wasEditing) {
          update({ pendingRefresh: false })
          refreshCurrent('detail-closed')
        }
      }

      function detailAction(action) {
        const detail = snapshot.detail
        if (!detail.open || !detail.id) return Promise.resolve()
        const rev = detail.rev
        return postTaskAction(detail.id, action, rev)
          .then(function onOk(value) {
            const task = value && value.task ? value.task : value
            update({
              detail: Object.assign({}, snapshot.detail, {
                task: task || snapshot.detail.task,
                rev: Number(task && task.rev) || Number(detail.rev) + 1,
                draft: snapshot.detail.dirty ? snapshot.detail.draft : draftFromTask(task || snapshot.detail.task),
                error: null,
                conflict: null,
              }),
            })
            applyTaskToCaches(task)
            const label = action === 'complete' ? TEXT.completed : action === 'reopen' ? TEXT.reopened : TEXT.cancelledTask
            m0.toast('success', label)
            refreshCurrent(action)
          })
          .catch(function onError(error) {
            if (error && error.code === 'conflict') {
              const current = error.details && error.details.current ? error.details.current : null
              update({
                detail: Object.assign({}, snapshot.detail, {
                  conflict: TEXT.conflictNotice,
                  latest: current,
                  error: null,
                }),
              })
              if (current) applyTaskToCaches(current)
              refreshCurrent('detail-conflict')
              return
            }
            update({ detail: Object.assign({}, snapshot.detail, { error: errorText(error) }) })
            m0.toast('error', errorText(error))
          })
      }

      /* ── 行操作：完成 / 重开 / 撤消 ── */

      function optimisticTaskStatus(task, status) {
        if (!task) return
        const clone = Object.assign({}, task, {
          status: status,
          completedAt: status === 'done' ? nowIso() : null,
        })
        applyTaskToCaches(clone)
        return clone
      }

      function completeTask(task) {
        if (!task || isTaskDone(task)) return Promise.resolve()
        const previous = Object.assign({}, task)
        optimisticTaskStatus(task, 'done')
        return postTaskAction(task.id, 'complete', Number(task.rev) || 1)
          .then(function onOk(value) {
            const updated = value && value.task ? value.task : value
            if (updated) applyTaskToCaches(updated)
            m0.toast('success', TEXT.completed, {
              label: TEXT.undo,
              run: function undoComplete() {
                reopenTask(updated || task)
              },
            })
            refreshCurrent('complete')
          })
          .catch(function onError(error) {
            optimisticTaskStatus(previous, previous.status)
            if (error && error.code === 'conflict') {
              m0.toast('error', '任务已被其它地方修改，已刷新')
              refreshCurrent('complete-conflict')
              return
            }
            m0.toast('error', errorText(error))
          })
      }

      function reopenTask(task) {
        if (!task || !task.id) return Promise.resolve()
        const rev = Number(task.rev) || 1
        return postTaskAction(task.id, 'reopen', rev)
          .then(function onOk(value) {
            const updated = value && value.task ? value.task : value
            if (updated) applyTaskToCaches(updated)
            m0.toast('success', TEXT.reopened)
            refreshCurrent('reopen')
          })
          .catch(function onError(error) {
            m0.toast('error', errorText(error))
            refreshCurrent('reopen-error')
          })
      }

      function cancelTask(task) {
        if (!task || !task.id) return Promise.resolve()
        return postTaskAction(task.id, 'cancel', Number(task.rev) || 1)
          .then(function onOk(value) {
            const updated = value && value.task ? value.task : value
            if (updated) applyTaskToCaches(updated)
            m0.toast('success', TEXT.cancelledTask)
            refreshCurrent('cancel')
          })
          .catch(function onError(error) {
            m0.toast('error', errorText(error))
          })
      }

      /* ── 快速添加 / 创建 ── */

      function createTaskFromQuickAdd(parsed) {
        const input = parsed || {}
        if (!input.title) return Promise.resolve(null)
        const body = { title: input.title }
        if (input.dateKey) body.scheduledDate = input.dateKey
        if (input.priority) body.priority = input.priority
        update({ quickAdd: Object.assign({}, snapshot.quickAdd, { submitting: true, error: null }) })
        return postTask({ title: input.title, scheduledDate: body.scheduledDate, priority: body.priority })
          .then(function onOk(value) {
            const task = value && value.task ? value.task : value
            update({ quickAdd: { focusSignal: snapshot.quickAdd.focusSignal, submitting: false, error: null } })
            m0.toast('success', TEXT.created + (task && task.title ? '：' + task.title : ''))
            refreshCurrent('create')
            return task || null
          })
          .catch(function onError(error) {
            update({ quickAdd: Object.assign({}, snapshot.quickAdd, { submitting: false, error: errorText(error) }) })
            m0.toast('error', TEXT.saveFailed + '：' + errorText(error))
            return null
          })
      }

      /* ── 日历拖拽改期 ── */

      function rescheduleTask(task, dateKey) {
        if (!task || !task.id || !dateKey) return Promise.resolve()
        const previous = Object.assign({}, task)
        const optimistic = Object.assign({}, task, {
          scheduledDate: dateKey,
          scheduledStartAt: null,
          scheduledEndAt: null,
          isAllDay: true,
          timeKind: 'date',
        })
        applyTaskToCaches(optimistic)
        return postTaskReschedule(task.id, { scheduledDate: dateKey, scheduledStartAt: null, scheduledEndAt: null }, Number(task.rev) || 1)
          .then(function onOk(value) {
            const updated = value && value.task ? value.task : value
            if (updated) applyTaskToCaches(updated)
            m0.toast('success', TEXT.rescheduled + '：' + dateKey)
            refreshCurrent('reschedule')
          })
          .catch(function onError(error) {
            applyTaskToCaches(previous)
            if (error && error.code === 'conflict') {
              m0.toast('error', '任务已被其它地方修改，已刷新')
              refreshCurrent('reschedule-conflict')
              return
            }
            m0.toast('error', errorText(error))
          })
      }

      /* ── 刷新调度 ── */

      function refreshCurrent(reason) {
        if (disposed) return Promise.resolve()
        const tab = snapshot.prefs.tab
        if (tab === 'inbox') {
          return m0.refreshInbox(reason || 'board')
        }
        if (tab === 'today') return loadToday()
        if (tab === 'todo') return loadTasks()
        if (tab === 'calendar') return loadCalendar(snapshot.calendar.month)
        return Promise.resolve()
      }

      function onExternalChange(reason) {
        if (isEditing()) {
          update({ pendingRefresh: true })
          return
        }
        if (refreshTimer) {
          try {
            window.clearTimeout(refreshTimer)
          } catch (error) {
            /* ignore */
          }
        }
        refreshTimer = schedule(function refreshNow() {
          refreshTimer = null
          refreshCurrent(reason || 'sse')
        }, 220)
      }

      function init() {
        update({ phase: 'loading' })
        return loadPrefs()
          .then(function afterPrefs() {
            return Promise.all([loadProjects(), loadTags()])
          })
          .then(function afterMeta() {
            update({ phase: 'ready' })
            reportClient({
              phase: 'm1-board-init',
              at: nowIso(),
              prefs: snapshot.prefs,
              tab: snapshot.prefs.tab,
              mock: snapshot.mock,
            })
            return refreshCurrent('board-init')
          })
          .catch(function onError(error) {
            update({ phase: 'fallback', mock: true })
            reportClient({ phase: 'm1-board-init-error', at: nowIso(), error: errorText(error) })
            return refreshCurrent('board-init-error')
          })
      }

      /* ── 键盘行导航 ── */

      function visibleTasksForFocus() {
        const tab = snapshot.prefs.tab
        if (tab === 'today') {
          return snapshot.today.overdue.concat(snapshot.today.tasks)
        }
        if (tab === 'todo') {
          const list = []
          ;(snapshot.tasks.groups || []).forEach(function each(group) {
            ;(group.tasks || []).forEach(function push(task) {
              list.push(task)
            })
          })
          return list.length ? list : snapshot.tasks.items
        }
        return []
      }

      function registerRowRef(taskId, element) {
        if (!taskId) return
        if (element) rowRefs.set(taskId, element)
        else rowRefs.delete(taskId)
      }

      function focusTaskAt(index) {
        const tasks = visibleTasksForFocus()
        if (!tasks.length) return
        const clamped = Math.max(0, Math.min(tasks.length - 1, Number(index)))
        update({ focusIndex: clamped })
        const task = tasks[clamped]
        schedule(function focusDom() {
          const element = task ? rowRefs.get(task.id) : null
          if (element && typeof element.focus === 'function') {
            try {
              element.focus()
            } catch (error) {
              /* ignore */
            }
          }
        }, 0)
      }

      function moveFocus(delta) {
        const tasks = visibleTasksForFocus()
        if (!tasks.length) return
        let index = snapshot.focusIndex
        if (index < 0) index = delta > 0 ? 0 : tasks.length - 1
        else index += delta
        focusTaskAt(index)
      }

      function focusedTask() {
        const tasks = visibleTasksForFocus()
        const index = snapshot.focusIndex
        return index >= 0 && index < tasks.length ? tasks[index] : null
      }

      function dispose() {
        disposed = true
        timers.forEach(function clear(id) {
          try {
            window.clearTimeout(id)
          } catch (error) {
            /* ignore */
          }
        })
        timers.clear()
        listeners.clear()
        rowRefs.clear()
      }

      return {
        getState: getState,
        subscribe: subscribe,
        setTab: setTab,
        setFilters: setFilters,
        clearFilters: clearFilters,
        setQuickAddFocus: setQuickAddFocus,
        init: init,
        loadProjects: loadProjects,
        loadTags: loadTags,
        loadToday: loadToday,
        loadTasks: loadTasks,
        loadCalendar: loadCalendar,
        setCalendarMonth: setCalendarMonth,
        shiftCalendarMonth: shiftCalendarMonth,
        selectCalendarDate: selectCalendarDate,
        calendarTasksByDate: calendarTasksByDate,
        openTask: openTask,
        closeDetail: closeDetail,
        updateDraft: updateDraft,
        saveDetail: saveDetail,
        detailAction: detailAction,
        useLatestVersion: useLatestVersion,
        keepMine: keepMine,
        completeTask: completeTask,
        reopenTask: reopenTask,
        cancelTask: cancelTask,
        createTaskFromQuickAdd: createTaskFromQuickAdd,
        rescheduleTask: rescheduleTask,
        refreshCurrent: refreshCurrent,
        onExternalChange: onExternalChange,
        moveFocus: moveFocus,
        focusedTask: focusedTask,
        registerRowRef: registerRowRef,
        isEditing: isEditing,
        dispose: dispose,
      }
    }

    const board = createBoardRuntime(runtime)

    /* ═════════════════════════ M2：Inbox 整理（文案 / HTTP / mock / runtime） ═════════════════════════ */

    Object.assign(TEXT, {
      triageTitle: '整理工作台',
      triagePending: '待整理',
      triageCandidates: '候选',
      triageLastRun: '上次整理',
      triageNever: '从未整理',
      triageRun: '整理',
      triageRunning: '整理中…',
      triageDeep: '让 Agent 深整理',
      triageDeepBusy: '准备中…',
      triageRefresh: '刷新',
      triageLowRiskSelect: '全选低风险',
      triageLowRiskSelected: '已选',
      triageAcceptSelected: '接受选中',
      triageClearSelection: '清除选择',
      triageHighRisk: '需要你确认',
      triageHighRiskHint: '承诺 / 歧义候选不参与批量接受，请逐条确认。',
      triageNoPending: '没有待整理的记录。记一条，稍后整理。',
      triageNoCandidates: '这条原文还没有候选，点「整理」生成。',
      triageRunDone: '整理完成',
      triageRunNoCandidates: '这次没有新的候选',
      triageRunNeedsAgent: '规则未覆盖，可让 Agent 深整理',
      triageApplyDone: '已创建',
      triageApplyIgnored: '忽略',
      triageApplyUndo: '撤销本次整理',
      triageApplyUndoDone: '已撤销本次整理',
      triageApplyUndoUnsupported: '撤销接口不可用，已记录待办',
      triageAccept: '接受',
      triageEditAccept: '编辑后接受',
      triageIgnore: '忽略',
      triageSaveAccept: '保存并接受',
      triageCancelEdit: '取消编辑',
      triageConfidence: '置信度',
      triageReasons: '依据',
      triageRisks: '风险',
      triageSourceQuote: '来源',
      triageReprocess: '重新整理',
      triageReprocessDone: '已重新发起整理',
      triageViewSource: '查看来源原文',
      triageHideSource: '收起来源',
      triageLastApplied: '最近整理结果',
      triageCreatedItems: '已创建',
      triageCreatedNone: '没有创建对象',
      triageUndoOne: '撤销',
      triageKindTask: '任务',
      triageKindEvent: '事件',
      triageKindMetric: '指标',
      triageKindHabit: '打卡',
      triageKindWish: '愿望',
      triageKindIgnore: '忽略',
      triageKindUnknown: '未知',
      triageFieldTitle: '标题',
      triageFieldDate: '日期',
      triageFieldPriority: '优先级',
      triageFieldEventType: '事件类型',
      triageFieldMetricType: '指标类型',
      triageFieldValue: '数值',
      triageFieldUnit: '单位',
      triageFieldHabit: '习惯',
      triageFieldContent: '内容',
      triageFieldTime: '时间',
      triageRiskPromise: '承诺升级',
      triageRiskAmbiguousDate: '日期歧义',
      triageAutomation: '夜间自动整理',
      triageAutomationHint: '每天固定时间把当天新记录整理成候选，确认后才落库；空内容不运行。',
      triageAutomationOn: '已开启',
      triageAutomationOff: '已关闭',
      triageAutomationTime: '整理时间',
      triageAutomationNext: '下次运行',
      triageAutomationSaveFailed: '自动整理设置保存失败',
      triageDeepCopied: '已复制待整理摘要',
      triageDeepCopiedHint: '已切换到对话；把摘要发给 LifeOS 助手即可深整理（V1.5 将支持草稿注入）。',
      triageDeepCopyFailed: '复制失败，请手动复制面板内容',
      triageSummaryPrefix: '【LifeOS 待整理摘要】',
      triageCandidatesCount: '候选',
      triageSourceLabel: '原文',
      triageEmptyHint: '按「整理」或等待夜间自动整理',
      triageMockBanner: 'Host 未就绪：整理工作台展示示例数据。',
      triageLoading: '加载中…',
      triageLoadFailed: '整理数据加载失败',
      triageRunFailed: '整理失败',
      triageApplyFailed: '接受失败',
      triageGroupRaw: '原文',
      triageSelectedCount: '已选',
      triageRiskNeedsConfirm: '需确认',
      triageProcessed: '已整理',
      triageViewSourceHint: '来源：原文片段',
      triageAllLowRisk: '低风险',
      triageKindLabel: '类型',
    })

    Object.assign(TEXT, {
      triageBackHint: 'Esc 也可返回',
      triageHistoryCollapse: '收起',
      triageHistoryEmpty: '还没有整理记录',
      triageHistoryExpand: '展开',
      triageHistoryReprocess: '重新整理',
      triageHistoryTitle: '最近整理',
      triageListEnterReview: '进入审查',
      triageListLastRun: '上次整理',
      triageListNever: '从未整理',
      triageListNoCandidates: '这条原文暂无候选，可重新整理',
      triageListReviewGroup: '审查候选',
      triageResultCreated: '已创建',
      triageResultFinish: '完成（返回待整理）',
      triageResultIgnored: '已忽略',
      triageResultNothing: '没有创建新对象',
      triageResultTitle: '整理完成',
      triageResultUndoAll: '撤销本次整理',
      triageResultUndoOne: '撤销',
      triageResultViewSource: '查看来源',
      triageReview: '整理审查',
      triageReviewAccept: '接受选中',
      triageReviewApplyingHint: '正在保存，请稍候；也可以先返回收件箱（后台继续）',
      triageReviewBack: '← 返回待整理',
      triageReviewCancelEdit: '取消',
      triageReviewClose: '关闭审查',
      triageReviewCollapseQuote: '收起原文',
      triageReviewConfidence: '置信度',
      triageReviewCountPrefix: '候选',
      triageReviewCountSuffix: ' 条候选',
      triageReviewEdit: '编辑',
      triageReviewExpandQuote: '展开原文',
      triageReviewIgnoreAll: '全部忽略',
      triageDrawerClose: '关闭待整理',
      triageDrawerHint: '右侧抽屉 · 记录 → 整理 → 确认 → 落库',
      triageResultDuplicates: '已跳过',
      triageResultDuplicatesSuffix: ' 条重复项（已存在）',
      triageDuplicateBadge: '已存在',
      triageReviewPartial: '已保存部分候选',
      triageReviewRetry: '重试',
      triageReviewSaveAccept: '保存并接受',
      triageReviewSelectAllLow: '全选低风险',
      triageReviewSelectNone: '全不选',
      triageResultAlreadyHandled: '这些候选此前已处理完成（幂等，未重复创建）',
      triageResultHandledEarlier: '此前已完成',
      triageRunAgain: '重新整理',
    })

    const CANDIDATE_KIND_LABEL = {
      task: '任务',
      event: '事件',
      metric: '指标',
      habit_checkin: '打卡',
      wish: '愿望',
      ignore: '忽略',
    }

    const CANDIDATE_KIND_COLOR = {
      task: 'brand',
      event: 'business',
      metric: 'success',
      habit_checkin: 'warn',
      wish: 'business',
      ignore: 'idle',
    }

    const TRIAGE_LOW_RISK_CONFIDENCE = 0.85
    const TRIAGE_CORRECTABLE_TYPES = ['task', 'event', 'metric', 'habit_checkin']

    const METRIC_CODE_LABEL = {
      steps_before: '步数',
      steps_after: '步数',
      minutes: '时长',
      hours: '时长',
      sets: '训练组数',
      kg: '体重',
      mg: '摄入',
      grams: '摄入',
      pills: '服用',
      cups: '饮水',
      ml: '饮水',
      times: '次数',
      pieces: '个数',
    }

    const UNIT_LABEL = {
      count: '次',
      min: '分钟',
      set: '组',
      kg: '公斤',
      mg: '毫克',
      g: '克',
      cup: '杯',
      ml: '毫升',
    }

    const EVENT_TYPE_LABEL = {
      sleep: '睡眠',
      meal: '饮食',
      meeting: '会议',
      exercise: '运动',
      study: '学习',
      work: '工作',
      other: '其他',
    }

    function metricCodeLabel(code) {
      if (!code) return '指标'
      const text = String(code)
      return METRIC_CODE_LABEL[text] || (text.indexOf('other_') === 0 ? '其他指标' : text)
    }

    function unitLabel(unit) {
      if (!unit) return ''
      const text = String(unit)
      return UNIT_LABEL[text] || text
    }

    function eventTypeLabel(type) {
      if (!type) return '事件'
      return EVENT_TYPE_LABEL[String(type)] || String(type)
    }

    function candidateKindLabel(kind) {
      return CANDIDATE_KIND_LABEL[kind] || kind || TEXT.triageKindUnknown
    }

    function candidateConfidence(candidate) {
      const value = Number(candidate && candidate.confidence)
      return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
    }

    function candidateRisks(candidate) {
      return candidate && Array.isArray(candidate.risks) ? candidate.risks.filter(Boolean) : []
    }

    function candidateReasons(candidate) {
      return candidate && Array.isArray(candidate.reasons) ? candidate.reasons.filter(Boolean) : []
    }

    function isLowRiskCandidate(candidate) {
      if (!candidate) return false
      if (candidate.requiresConfirm === true) return false
      if (candidateRisks(candidate).length > 0) return false
      return candidateConfidence(candidate) >= TRIAGE_LOW_RISK_CONFIDENCE
    }

    function isHighRiskCandidate(candidate) {
      return candidateRisks(candidate).length > 0 || candidate && candidate.requiresConfirm === true
    }

    function candidateFields(candidate) {
      return candidate && candidate.fields && typeof candidate.fields === 'object' ? candidate.fields : {}
    }

    function candidateField(candidate, names, fallback) {
      const fields = candidateFields(candidate)
      for (let index = 0; index < names.length; index += 1) {
        const value = fields[names[index]]
        if (value !== undefined && value !== null && value !== '') return value
      }
      return fallback
    }

    function candidateDateText(candidate) {
      const direct = candidateField(
        candidate,
        ['local_date', 'occurred_date', 'scheduled_date', 'due_date', 'date', 'localDate', 'scheduledDate', 'dueDate', 'dateText'],
        '',
      )
      if (direct) return String(direct)
      const startAt = candidateField(candidate, ['occurred_start_at', 'scheduled_start_at', 'measured_at', 'happenedAt'], '')
      if (startAt) return localDatePart(startAt)
      return ''
    }

    function candidateSummary(candidate) {
      if (!candidate) return ''
      const kind = candidate.kind
      if (kind === 'task') {
        const title = candidateField(candidate, ['title', 'text', 'name'], '（未命名任务）')
        const date = candidateDateText(candidate)
        const priority = candidateField(candidate, ['priority'], '')
        return '新建任务：' + title + (date ? ' · ' + date : '') + (priority ? ' · !' + priority : '')
      }
      if (kind === 'event') {
        const type = eventTypeLabel(candidateField(candidate, ['event_type', 'type', 'eventType', 'name'], 'other'))
        const date = candidateDateText(candidate)
        const duration = candidateField(candidate, ['duration_minutes'], '')
        const startAt = candidateField(candidate, ['occurred_start_at'], '')
        const time = startAt ? localTimePart(startAt) : duration ? duration + ' 分钟' : ''
        return '记录事件：' + type + (date ? ' · ' + date : '') + (time ? ' ' + time : '')
      }
      if (kind === 'metric') {
        const type = metricCodeLabel(candidateField(candidate, ['metric_code', 'metricType', 'metric_type', 'type', 'name'], ''))
        const value = candidateField(candidate, ['value_num', 'value', 'amount'], '')
        const rawUnit = String(candidateField(candidate, ['unit'], '') || '')
        const unit = rawUnit === 'count' ? (String(candidateField(candidate, ['metric_code'], '')).indexOf('steps') === 0 ? '步' : '') : unitLabel(rawUnit)
        return '记录指标：' + type + (value !== '' ? ' ' + value : '') + (unit ? ' ' + unit : '')
      }
      if (kind === 'habit_checkin') {
        const habit = candidateField(candidate, ['habit_label', 'habit_key', 'habitName', 'habit_name', 'habit', 'name'], '习惯')
        const date = candidateDateText(candidate) || '今天'
        return '习惯打卡：' + habit + ' ✓ · ' + date
      }
      if (kind === 'wish') {
        return '记录愿望：' + candidateField(candidate, ['text', 'title', 'content'], '（未命名愿望）')
      }
      return '忽略这条识别结果（保留原文）'
    }

    function candidateDraft(candidate) {
      const kind = candidate && candidate.kind
      const base = {}
      if (kind === 'task') {
        base.title = String(candidateField(candidate, ['title', 'text'], ''))
        base.date = candidateDateText(candidate)
        base.priority = String(candidateField(candidate, ['priority'], 'none'))
      } else if (kind === 'event') {
        base.type = String(candidateField(candidate, ['event_type', 'type', 'eventType', 'name'], 'other'))
        base.date = candidateDateText(candidate)
        base.time = String(candidateField(candidate, ['duration_minutes'], '') || '')
      } else if (kind === 'metric') {
        base.type = String(candidateField(candidate, ['metric_code', 'metricType', 'metric_type', 'type', 'name'], ''))
        base.value = String(candidateField(candidate, ['value_num', 'value', 'amount'], ''))
        base.unit = String(candidateField(candidate, ['unit'], ''))
      } else if (kind === 'habit_checkin') {
        base.habit = String(candidateField(candidate, ['habit_label', 'habit_key', 'habitName', 'habit_name', 'habit', 'name'], ''))
        base.date = candidateDateText(candidate)
      } else if (kind === 'wish') {
        base.text = String(candidateField(candidate, ['title', 'text', 'content'], ''))
      }
      return base
    }

    function candidatePatchFromDraft(candidate, draft) {
      const kind = candidate && candidate.kind
      const fields = candidateFields(candidate)
      if (kind === 'task') {
        const patch = {
          title: String(draft.title || '').trim(),
          priority: draft.priority || 'none',
        }
        // buildTarget 会 merge 到 candidate.fields，按原字段选择日期槽位，避免同时写入互斥字段。
        if (fields.due_date && !fields.scheduled_date && !fields.scheduled_start_at) patch.due_date = draft.date || null
        else patch.scheduled_date = draft.date || null
        return patch
      }
      if (kind === 'event') {
        const patch = {
          event_type: String(draft.type || 'other').trim() || 'other',
          local_date: draft.date || null,
        }
        if (!patch.local_date && fields.local_date) patch.local_date = fields.local_date
        const duration = Number(draft.time)
        if (Number.isFinite(duration) && duration > 0) patch.duration_minutes = duration
        return patch
      }
      if (kind === 'metric') {
        const value = Number(draft.value)
        return {
          metric_code: String(draft.type || '').trim() || 'other_manual',
          value_num: Number.isFinite(value) ? value : draft.value,
          unit: String(draft.unit || '').trim() || 'count',
        }
      }
      if (kind === 'habit_checkin') {
        const habit = String(draft.habit || '').trim()
        return { habit_label: habit, habit_key: fields.habit_key || habit, local_date: draft.date || null }
      }
      if (kind === 'wish') {
        return { title: String(draft.text || '').trim() }
      }
      return {}
    }

    /* ── M2 HTTP（契约：M2-PLAN §3.2，Host 由 B 实现） ── */

    function triageStatusApi() {
      return apiRequest('/triage/status')
    }

    function triagePendingApi() {
      return apiRequest('/triage/pending')
    }

    function triageRunApi(body) {
      return apiRequest('/triage/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(Object.assign({ mode: 'rules' }, body || {})),
      })
    }

    function triageApplyApi(runId, decisions, requestId) {
      return apiRequest('/triage/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          runId: runId,
          decisions: decisions,
          requestId: requestId || 'triage-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        }),
      })
    }

    function triageReprocessApi(rawRecordId) {
      return apiRequest('/triage/reprocess', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ rawRecordId: rawRecordId }),
      })
    }

    function triageCorrectApi(input) {
      return apiRequest('/triage/correct', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input || {}),
      })
    }

    function triageAutomationGetApi() {
      return apiRequest('/triage/automation')
    }

    function triageAutomationPutApi(patch) {
      return apiRequest('/triage/automation', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(patch || {}),
      })
    }

    /* ── M2 mock（Host 未就绪 / 演示兜底；支持 apply/undo 本地状态） ── */

    function createMockTriageStore() {
      const now = Date.now()
      const today = todayIso()
      function candidate(id, rawRecordId, kind, confidence, fields, sourceQuote, extra) {
        return Object.assign(
          {
            candidateId: 'cand_mock_' + id,
            rawRecordId: rawRecordId,
            kind: kind,
            confidence: confidence,
            source: { quote: sourceQuote, start: null, end: null },
            fields: fields,
            reasons: [],
            risks: [],
            requiresConfirm: false,
          },
          extra || {},
        )
      }
      const groups = [
        {
          rawRecord: {
            id: 'raw_mock_1',
            text: '今天睡得很晚，中午走了 8000 步。周五前要把实验报告发给导师。',
            status: 'pending',
            createdAt: new Date(now - 2 * 3600000).toISOString(),
          },
          runId: 'run_mock_1',
          candidates: [
            candidate('1', 'raw_mock_1', 'metric', 0.92, { metric_code: 'steps_after', value_num: 8000, unit: 'count' }, '走了 8000 步', {
              reasons: ['命中数字+单位「8000 步」'],
            }),
            candidate('2', 'raw_mock_1', 'task', 0.9, { title: '给导师发实验报告', due_date: addDaysKey(today, 2), priority: 'high' }, '周五前要把实验报告发给导师', {
              risks: ['承诺升级'],
              requiresConfirm: true,
              reasons: ['命中「周五前」', '命中「发给导师」'],
            }),
          ],
        },
        {
          rawRecord: {
            id: 'raw_mock_2',
            text: '明天下午 3 点改实验报告，1 小时。晚上做 30 分钟力量训练。',
            status: 'pending',
            createdAt: new Date(now - 26 * 3600000).toISOString(),
          },
          runId: 'run_mock_1',
          candidates: [
            candidate('3', 'raw_mock_2', 'task', 0.88, { title: '改实验报告', scheduled_date: addDaysKey(today, 1), priority: 'medium' }, '明天下午 3 点改实验报告', {
              reasons: ['命中「明天」', '命中「3 点」'],
            }),
            candidate('4', 'raw_mock_2', 'event', 0.74, { event_type: 'exercise', local_date: addDaysKey(today, 0), duration_minutes: 30 }, '晚上做 30 分钟力量训练', {
              risks: ['日期歧义'],
              reasons: ['命中时长「30 分钟」'],
            }),
          ],
        },
        {
          rawRecord: {
            id: 'raw_mock_3',
            text: '希望以后每天都能读 20 页书。',
            status: 'pending',
            createdAt: new Date(now - 30 * 3600000).toISOString(),
          },
          runId: 'run_mock_1',
          candidates: [
            candidate('5', 'raw_mock_3', 'wish', 0.62, { title: '每天读 20 页书' }, '希望以后每天都能读 20 页书', {
              requiresConfirm: true,
              reasons: ['命中「希望以后」'],
            }),
          ],
        },
      ]
      return {
        groups: groups,
        lastRun: { id: 'run_mock_1', at: new Date(now - 32 * 3600000).toISOString(), counts: { candidates: 5 } },
        automation: { enabled: true, time: '21:30', nextRun: new Date(now + 9 * 3600000).toISOString() },
        created: [],
        seq: 5,
      }
    }

    const mockTriageStore = createMockTriageStore()

    function mockTriageCandidateCount() {
      return mockTriageStore.groups.reduce(function sum(total, group) {
        return total + (group.candidates ? group.candidates.length : 0)
      }, 0)
    }

    function mockTriageStatus() {
      return {
        pendingRaw: mockTriageStore.groups.length,
        pendingCandidates: mockTriageCandidateCount(),
        lastRun: mockTriageStore.lastRun,
        automation: mockTriageStore.automation,
        mock: true,
      }
    }

    function mockTriagePending() {
      return { groups: JSON.parse(JSON.stringify(mockTriageStore.groups)), mock: true }
    }

    function mockTriageRun() {
      const now = new Date().toISOString()
      mockTriageStore.lastRun = { id: 'run_mock_' + Date.now().toString(36), at: now, counts: { candidates: mockTriageCandidateCount() } }
      return { run: mockTriageStore.lastRun, counts: { raw: mockTriageStore.groups.length, candidates: mockTriageCandidateCount() }, mock: true }
    }

    function mockTriageApply(runId, decisions) {
      let applied = 0
      let ignored = 0
      const created = []
      const decisionById = {}
      ;(decisions || []).forEach(function index(decision) {
        decisionById[decision.candidateId] = decision
      })
      mockTriageStore.groups = mockTriageStore.groups
        .map(function mapGroup(group) {
          if (group.runId !== runId) return group
          const remaining = []
          ;(group.candidates || []).forEach(function each(cand) {
            const decision = decisionById[cand.candidateId]
            if (!decision) {
              remaining.push(cand)
              return
            }
            if (decision.action === 'ignore') {
              ignored += 1
              return
            }
            applied += 1
            mockTriageStore.seq += 1
            const id = 'mock_created_' + mockTriageStore.seq
            const type = cand.kind === 'habit_checkin' ? 'habit_checkin' : cand.kind === 'ignore' ? 'ignore' : cand.kind
            created.push({ type: type, id: id, title: candidateSummary(cand) })
            mockTriageStore.created.push({ type: type, id: id })
          })
          if (remaining.length === 0) return null
          return Object.assign({}, group, { candidates: remaining })
        })
        .filter(Boolean)
      mockTriageStore.lastRun = { id: runId, at: new Date().toISOString(), counts: { applied, ignored } }
      return { applied: applied, ignored: ignored, created: created, run: mockTriageStore.lastRun, mock: true }
    }

    function mockTriageCorrect(input) {
      if (input && input.action === 'revoke' && input.id) {
        mockTriageStore.created = mockTriageStore.created.filter(function keep(item) {
          return item.id !== input.id
        })
      }
      return { affected: [{ type: input && input.type, id: input && input.id, action: input && input.action }], mock: true }
    }

    function mockTriageAutomationGet() {
      return { automation: JSON.parse(JSON.stringify(mockTriageStore.automation)), mock: true }
    }

    function mockTriageAutomationPut(patch) {
      const next = Object.assign({}, mockTriageStore.automation, patch || {})
      if (!next.time) next.time = '21:30'
      mockTriageStore.automation = next
      return { automation: JSON.parse(JSON.stringify(next)), mock: true }
    }

    /* ═════════════════════════ M2：整理运行时（单页单例） ═════════════════════════ */

    function createTriageRuntime(m0, navigation) {
      const initial = {
        phase: 'idle',
        mock: false,
        status: { phase: 'idle', data: null, error: null, at: null },
        pending: { phase: 'idle', groups: [], error: null, at: null, pendingRefresh: false },
        automation: { phase: 'idle', data: { enabled: true, time: '21:30', nextRun: null }, error: null, saving: false },
        running: false,
        applying: false,
        selection: {},
        lastApply: null,
        expandedSource: null,
        deepBusy: false,
        page: { open: false },
        review: {
          open: false,
          runId: null,
          phase: 'idle',
          groups: [],
          candidates: [],
          selection: {},
          expanded: {},
          result: null,
          error: null,
          pendingAction: null,
          startedAt: null,
        },
      }

      let snapshot = initial
      const listeners = new Set()
      const timers = new Set()
      let refreshTimer = null
      let disposed = false

      function schedule(fn, delay) {
        const id = window.setTimeout(function run() {
          timers.delete(id)
          try {
            fn()
          } catch (error) {
            console.error('[lifeos] triage timer failed', error)
          }
        }, delay)
        timers.add(id)
        return id
      }

      function getState() {
        return snapshot
      }

      function setState(next) {
        if (disposed || !next || next === snapshot) return
        snapshot = next
        Array.from(listeners).forEach(function notify(listener) {
          try {
            listener()
          } catch (error) {
            console.error('[lifeos] triage subscriber failed', error)
          }
        })
      }

      function update(patch) {
        setState(Object.assign({}, snapshot, patch || {}))
      }

      function subscribe(listener) {
        listeners.add(listener)
        return function unsubscribe() {
          listeners.delete(listener)
        }
      }

      function loadStatus() {
        return triageStatusApi()
          .then(function onOk(value) {
            const data = value && value.status ? value.status : value
            update({ status: { phase: 'ready', data: data, error: null, at: nowIso() }, mock: false })
            if (data && data.automation) {
              update({ automation: Object.assign({}, snapshot.automation, { data: data.automation, phase: 'ready' }) })
            }
          })
          .catch(function onError(error) {
            const data = mockTriageStatus()
            update({
              status: { phase: 'fallback', data: data, error: errorText(error), at: nowIso() },
              mock: true,
              automation: Object.assign({}, snapshot.automation, { data: data.automation, phase: 'fallback' }),
            })
          })
      }

      function loadPending() {
        update({ pending: Object.assign({}, snapshot.pending, { phase: snapshot.pending.groups.length ? 'ready' : 'loading', error: null }) })
        return triagePendingApi()
          .then(function onOk(value) {
            const groups = value && Array.isArray(value.groups) ? value.groups : Array.isArray(value) ? value : []
            update({ pending: { phase: 'ready', groups: groups, error: null, at: nowIso(), pendingRefresh: false }, mock: false })
          })
          .catch(function onError(error) {
            const mocks = mockTriagePending()
            update({
              pending: { phase: 'fallback', groups: mocks.groups, error: errorText(error), at: nowIso(), pendingRefresh: false },
              mock: true,
            })
          })
      }

      function loadAutomation() {
        update({ automation: Object.assign({}, snapshot.automation, { phase: snapshot.automation.data ? 'ready' : 'loading' }) })
        return triageAutomationGetApi()
          .then(function onOk(value) {
            const data = value && value.automation ? value.automation : value
            const automation = Object.assign({ enabled: true, time: '21:30', nextRun: null }, data || {})
            update({ automation: { phase: 'ready', data: automation, error: null, saving: false } })
          })
          .catch(function onError(error) {
            const data = mockTriageAutomationGet().automation
            update({ automation: { phase: 'fallback', data: data, error: errorText(error), saving: false } })
          })
      }

      function refreshAll() {
        return Promise.all([loadStatus(), loadPending(), loadAutomation()]).catch(function ignore() {
          return undefined
        })
      }

      function isEditing() {
        return snapshot.applying === true || (snapshot.review.open && snapshot.review.phase === 'applying')
      }

      function onExternalChange(reason) {
        if (snapshot.review && snapshot.review.open) {
          loadStatus()
          return
        }
        if (snapshot.applying || snapshot.running) {
          update({ pending: Object.assign({}, snapshot.pending, { pendingRefresh: true }) })
          return
        }
        if (refreshTimer) {
          try {
            window.clearTimeout(refreshTimer)
          } catch (error) {
            /* ignore */
          }
        }
        refreshTimer = schedule(function refreshNow() {
          refreshTimer = null
          loadStatus()
          loadPending()
        }, 260)
      }

      function init() {
        update({ phase: 'loading' })
        return refreshAll().then(function after() {
          update({ phase: 'ready' })
          reportClient({
            phase: 'm2-triage-init',
            at: nowIso(),
            pendingRaw: snapshot.status.data ? snapshot.status.data.pendingRaw : null,
            pendingCandidates: snapshot.status.data ? snapshot.status.data.pendingCandidates : null,
            mock: snapshot.mock,
          })
        })
      }

      function collectCandidates() {
        const list = []
        ;(snapshot.pending.groups || []).forEach(function eachGroup(group) {
          ;(group.candidates || []).forEach(function eachCandidate(candidate) {
            list.push({ group: group, candidate: candidate })
          })
        })
        return list
      }

      function selectCandidate(candidateId, value) {
        const selection = Object.assign({}, snapshot.selection)
        if (value === true) selection[candidateId] = true
        else delete selection[candidateId]
        update({ selection: selection })
      }

      function selectAllLowRisk() {
        const selection = {}
        collectCandidates().forEach(function each(entry) {
          if (isLowRiskCandidate(entry.candidate)) selection[entry.candidate.candidateId] = true
        })
        update({ selection: selection })
        return Object.keys(selection).length
      }

      function clearSelection() {
        update({ selection: {} })
      }

      function selectedCount() {
        return Object.keys(snapshot.selection || {}).length
      }

      function applyRun(runId, decisions, meta) {
        if (!runId || !Array.isArray(decisions) || decisions.length === 0) return Promise.resolve(null)
        const contextById = {}
        collectCandidates().forEach(function each(entry) {
          const raw = entry.group.rawRecord || {}
          contextById[entry.candidate.candidateId] = { rawRecordId: raw.id || null, rawText: String(raw.text || '') }
        })
        const acceptedOrder = decisions.filter(function keep(decision) {
          return decision.action !== 'ignore'
        })
        update({ applying: true })
        return triageApplyApi(runId, decisions)
          .then(function onOk(value) {
            const result = value || {}
            const rawCreated = Array.isArray(result.created) ? result.created : []
            const created = rawCreated.map(function enrich(item, index) {
              const decision = item.candidateId ? null : acceptedOrder[index]
              const candidateId = item.candidateId || (decision ? decision.candidateId : null)
              const context = candidateId ? contextById[candidateId] : null
              if (!context) return item
              return Object.assign({}, item, { rawRecordId: item.rawRecordId || context.rawRecordId, rawText: context.rawText })
            })
            const applied = Number(result.applied) || decisions.filter(function count(decision) {
              return decision.action !== 'ignore'
            }).length
            const ignored = Number(result.ignored) || decisions.filter(function count(decision) {
              return decision.action === 'ignore'
            }).length
            const lastApply = {
              runId: runId,
              applied: applied,
              ignored: ignored,
              created: created,
              at: nowIso(),
              label: meta && meta.label ? meta.label : '',
            }
            update({ applying: false, lastApply: lastApply, selection: {}, expandedSource: null })
            const typeCounts = {}
            created.forEach(function countType(item) {
              const label = candidateKindLabel(item.type)
              typeCounts[label] = (typeCounts[label] || 0) + 1
            })
            const typeText = Object.keys(typeCounts)
              .map(function mapType(label) {
                return label + ' ' + typeCounts[label]
              })
              .join('、')
            const summary = TEXT.triageApplyDone + ' ' + applied + ' 项' + (typeText ? '（' + typeText + '）' : '') + (ignored ? '，' + TEXT.triageApplyIgnored + ' ' + ignored + ' 项' : '')
            m0.toast('success', summary, {
              label: TEXT.triageApplyUndo,
              run: function runUndo() {
                undoLastApply()
              },
            })
            loadStatus()
            loadPending()
            return result
          })
          .catch(function onError(error) {
            update({ applying: false })
            m0.toast('error', TEXT.triageApplyFailed + '：' + errorText(error))
            return null
          })
      }

      function acceptCandidate(candidate, runId) {
        return applyRun(runId, [{ candidateId: candidate.candidateId, action: 'accept' }], { label: 'accept' })
      }

      function ignoreCandidate(candidate, runId) {
        return applyRun(runId, [{ candidateId: candidate.candidateId, action: 'ignore' }], { label: 'ignore' })
      }

      function editAcceptCandidate(candidate, runId, patch) {
        return applyRun(runId, [{ candidateId: candidate.candidateId, action: 'edit', patch: patch || {} }], { label: 'edit' })
      }

      function batchAcceptSelected() {
        const selection = snapshot.selection || {}
        const byRun = {}
        collectCandidates().forEach(function each(entry) {
          const candidate = entry.candidate
          if (selection[candidate.candidateId] !== true) return
          if (!isLowRiskCandidate(candidate)) return
          const runId = entry.group.runId
          if (!runId) return
          if (!byRun[runId]) byRun[runId] = []
          byRun[runId].push({ candidateId: candidate.candidateId, action: 'accept' })
        })
        const runIds = Object.keys(byRun)
        if (!runIds.length) return Promise.resolve(null)
        let chain = Promise.resolve(null)
        runIds.forEach(function eachRun(runId) {
          chain = chain.then(function next() {
            return applyRun(runId, byRun[runId], { label: 'batch' })
          })
        })
        return chain
      }

      function undoLastApply() {
        const lastApply = snapshot.lastApply
        if (!lastApply || !Array.isArray(lastApply.created) || lastApply.created.length === 0) {
          m0.toast('error', TEXT.triageApplyUndoUnsupported)
          return Promise.resolve(null)
        }
        const created = lastApply.created
        const unsupported = created.filter(function check(item) {
          return !item || !item.id || !item.type || TRIAGE_CORRECTABLE_TYPES.indexOf(item.type) < 0
        })
        const supported = created.filter(function check(item) {
          return item && item.id && item.type && TRIAGE_CORRECTABLE_TYPES.indexOf(item.type) >= 0
        })
        let chain = Promise.resolve(null)
        let failed = 0
        supported.forEach(function each(item) {
          chain = chain.then(function next() {
            return triageCorrectApi({ type: item.type, id: item.id, action: 'revoke', reason: '撤销本次整理' }).catch(function ignore() {
              failed += 1
              return null
            })
          })
        })
        return chain.then(function done() {
          const remaining = unsupported.concat(failed > 0 ? supported.slice(0, failed) : [])
          if (remaining.length > 0) {
            update({ lastApply: Object.assign({}, lastApply, { created: remaining }) })
            m0.toast('warn', TEXT.triageApplyUndoDone + '（' + supported.length + ' 项）；' + remaining.length + ' 项需手动处理（已记录待办）')
          } else {
            update({ lastApply: null })
            m0.toast('success', TEXT.triageApplyUndoDone)
          }
          loadStatus()
          loadPending()
        })
      }

      function runTriage() {
        if (snapshot.running) return Promise.resolve(null)
        update({ running: true })
        return triageRunApi({ mode: 'rules' })
          .then(function onOk(value) {
            const counts = value && value.counts ? value.counts : {}
            const run = value && value.run ? value.run : null
            const candidateCount = Number(counts.candidates)
            update({ running: false })
            return loadStatus()
              .then(function afterStatus() {
                return loadPending()
              })
              .then(function afterPending() {
                const groups = snapshot.pending.groups || []
                const entered = enterReview(null, groups)
                if (entered) {
                  m0.toast('success', TEXT.triageRunDone + '：' + TEXT.triageCandidates + ' ' + snapshot.review.candidates.length + ' 项')
                  return value
                }
                // 旧服务端/竞态兜底：用 run 返回的 candidates 组成审查数据
                const fallbackCandidates = value && Array.isArray(value.candidates) ? value.candidates : []
                if (fallbackCandidates.length) {
                  const byRaw = {}
                  fallbackCandidates.forEach(function each(candidate) {
                    const rawId = candidate.rawRecordId || 'unknown'
                    if (!byRaw[rawId]) {
                      byRaw[rawId] = {
                        rawRecord: { id: rawId, text: String((candidate.source && candidate.source.quote) || '') },
                        runId: run ? run.id : null,
                        candidates: [],
                      }
                    }
                    byRaw[rawId].candidates.push(candidate)
                  })
                  const groups2 = Object.keys(byRaw).map(function map(key) {
                    return byRaw[key]
                  })
                  if (enterReview(run ? run.id : null, groups2)) {
                    m0.toast('success', TEXT.triageRunDone + '：' + TEXT.triageCandidates + ' ' + snapshot.review.candidates.length + ' 项')
                    return value
                  }
                }
                if (value && value.needsAgent === true) m0.toast('warn', TEXT.triageRunNeedsAgent)
                else m0.toast('success', TEXT.triageRunNoCandidates)
                return value
              })
          })
          .catch(function onError(error) {
            update({ running: false })
            m0.toast('error', TEXT.triageRunFailed + '：' + errorText(error))
            return null
          })
      }

      function revokeCreated(item) {
        if (!item || !item.id || !item.type) {
          m0.toast('error', TEXT.triageApplyUndoUnsupported)
          return Promise.resolve(null)
        }
        if (TRIAGE_CORRECTABLE_TYPES.indexOf(item.type) < 0) {
          m0.toast('warn', '该类型暂不支持撤销（' + candidateKindLabel(item.type) + '），已记录待办')
          return Promise.resolve(null)
        }
        return triageCorrectApi({ type: item.type, id: item.id, action: 'revoke', reason: '单条撤销整理结果' })
          .then(function onOk() {
            const lastApply = snapshot.lastApply
            if (lastApply && Array.isArray(lastApply.created)) {
              update({
                lastApply: Object.assign({}, lastApply, {
                  created: lastApply.created.filter(function keep(createdItem) {
                    return createdItem !== item && createdItem.id !== item.id
                  }),
                }),
              })
            }
            m0.toast('success', TEXT.triageApplyUndoDone)
            loadStatus()
            loadPending()
          })
          .catch(function onError(error) {
            m0.toast('error', errorText(error))
          })
      }

      function reprocess(rawRecordId) {
        if (!rawRecordId) return Promise.resolve(null)
        return triageReprocessApi(rawRecordId)
          .then(function onOk() {
            m0.toast('success', TEXT.triageReprocessDone)
            loadStatus()
            loadPending()
          })
          .catch(function onError(error) {
            m0.toast('error', errorText(error))
          })
      }

      function toggleExpandedSource(rawRecordId) {
        update({ expandedSource: snapshot.expandedSource === rawRecordId ? null : rawRecordId })
      }

      function buildDeepSummary() {
        const lines = [TEXT.triageSummaryPrefix + ' ' + todayIso()]
        ;(snapshot.pending.groups || []).forEach(function eachGroup(group, groupIndex) {
          const raw = group.rawRecord || {}
          lines.push('')
          lines.push('#' + (groupIndex + 1) + ' 原文：' + String(raw.text || '').slice(0, 300))
          ;(group.candidates || []).forEach(function eachCandidate(candidate) {
            lines.push(
              '  - [' + candidateKindLabel(candidate.kind) + '] ' + candidateSummary(candidate) + '（置信度 ' + candidateConfidence(candidate).toFixed(2) + '）',
            )
          })
        })
        lines.push('')
        lines.push('请对以上原文做深度整理，输出候选（kind / 字段 / 来源 quote），不要直接落库。')
        return lines.join('\n')
      }

      function copyText(text) {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            return navigator.clipboard.writeText(text)
          }
        } catch (error) {
          /* fallback below */
        }
        try {
          if (typeof document !== 'undefined' && document.createElement) {
            const area = document.createElement('textarea')
            area.value = text
            area.style.position = 'fixed'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            if (document.execCommand) document.execCommand('copy')
            document.body.removeChild(area)
            return Promise.resolve()
          }
        } catch (error) {
          /* ignore */
        }
        return Promise.reject(new Error('clipboard unavailable'))
      }

      function deepTriage() {
        if (snapshot.deepBusy) return Promise.resolve(null)
        update({ deepBusy: true })
        const summary = buildDeepSummary()
        return copyText(summary)
          .then(function onCopied() {
            update({ deepBusy: false })
            m0.toast('success', TEXT.triageDeepCopied + ' · ' + TEXT.triageDeepCopiedHint)
            if (navigation && typeof navigation.selectConversation === 'function') {
              try {
                navigation.selectConversation()
              } catch (error) {
                /* ignore */
              }
            }
            return summary
          })
          .catch(function onError() {
            update({ deepBusy: false })
            m0.toast('error', TEXT.triageDeepCopyFailed)
            return summary
          })
      }

      function setAutomationEnabled(enabled) {
        const next = Object.assign({}, snapshot.automation.data, { enabled: enabled === true })
        update({ automation: Object.assign({}, snapshot.automation, { data: next, saving: true }) })
        return triageAutomationPutApi({ enabled: next.enabled, time: next.time })
          .then(function onOk(value) {
            const data = value && value.automation ? value.automation : value
            const merged = Object.assign({}, next, data && typeof data === 'object' ? data : {})
            if (!merged.nextRun && data && data.schedule) {
              merged.nextRun = data.schedule.nextRun || data.schedule.next_at || (data.schedule.record && data.schedule.record.scheduledAt) || null
            }
            update({
              automation: {
                phase: 'ready',
                data: merged,
                error: null,
                saving: false,
              },
            })
            m0.toast('success', TEXT.triageAutomation + '：' + (next.enabled ? TEXT.triageAutomationOn : TEXT.triageAutomationOff))
          })
          .catch(function onError(error) {
            update({ automation: Object.assign({}, snapshot.automation, { data: Object.assign({}, snapshot.automation.data, { enabled: !next.enabled }), saving: false }) })
            m0.toast('error', TEXT.triageAutomationSaveFailed + '：' + errorText(error))
          })
      }

      /* ── 审查态（M2-C2）：显式状态机，任何路径都能推进或退出 ── */

      function emptyReview() {
        return {
          open: false,
          runId: null,
          phase: 'idle',
          groups: [],
          candidates: [],
          selection: {},
          expanded: {},
          result: null,
          error: null,
          pendingAction: null,
          startedAt: null,
        }
      }

      function openPage() {
        update({ page: { open: true } })
        try {
          reportClient({ phase: 'm26-triage-drawer', action: 'open', at: nowIso() })
        } catch (error) {
          /* ignore */
        }
        // 打开后把焦点交给抽屉（组件挂载后自己 focus；这里兜底）。
        try {
          window.setTimeout(function focusDrawer() {
            try {
              const element = document.getElementById('lifeos-triage-drawer')
              if (element && element.focus) element.focus()
            } catch (error) {
              /* ignore */
            }
          }, 40)
        } catch (error) {
          /* ignore */
        }
      }

      function closePage() {
        const wasOpen = snapshot.page && snapshot.page.open
        if (snapshot.review.open) exitReview('page-close')
        update({ page: { open: false } })
        if (wasOpen) {
          try {
            reportClient({ phase: 'm26-triage-drawer', action: 'close', at: nowIso() })
          } catch (error) {
            /* ignore */
          }
        }
        // R1：关闭后焦点回到「待整理」徽标
        try {
          window.setTimeout(function focusBadge() {
            try {
              const badge = document.getElementById('lifeos-triage-badge')
              if (badge && badge.focus) badge.focus()
            } catch (error) {
              /* ignore */
            }
          }, 0)
        } catch (error) {
          /* ignore */
        }
      }

      function flattenGroups(groups) {
        const list = []
        ;(groups || []).forEach(function eachGroup(group) {
          ;(group.candidates || []).forEach(function eachCandidate(candidate) {
            list.push({ group: group, candidate: candidate })
          })
        })
        return list
      }

      function reviewCandidateIds() {
        return (snapshot.review.candidates || []).map(function map(entry) {
          return entry.candidate.candidateId
        })
      }

      function reviewSelectionCount() {
        return Object.keys(snapshot.review.selection || {}).length
      }

      function reviewLowRiskCount() {
        return (snapshot.review.candidates || []).filter(function filter(entry) {
          return isLowRiskCandidate(entry.candidate)
        }).length
      }

      function enterReview(runId, groupsOverride) {
        const allGroups = Array.isArray(groupsOverride) ? groupsOverride : snapshot.pending.groups || []
        const primary = allGroups.find(function find(group) {
          return Array.isArray(group.candidates) && group.candidates.length > 0
        })
        const primaryRunId = runId || (primary ? primary.runId : null)
        // 一次审查只处理同一轮 run（服务端一次 run 覆盖本轮全部待整理）；其它 run 的候选留在列表。
        const filtered = (primaryRunId
          ? allGroups.filter(function keep(group) {
              return group.runId === primaryRunId
            })
          : allGroups
        ).map(function mapGroup(group) {
          return Object.assign({}, group, {
            candidates: (group.candidates || []).filter(function keepCandidate(candidate) {
              return candidate.handled !== 'accepted' && candidate.handled !== 'ignored'
            }),
          })
        })
        const groups = filtered.filter(function keepGroup(group) {
          return group.candidates.length > 0
        })
        const candidates = flattenGroups(groups)
        if (!candidates.length) return false
        const selection = {}
        candidates.forEach(function each(entry) {
          if (isLowRiskCandidate(entry.candidate)) selection[entry.candidate.candidateId] = true
        })
        update({
          review: {
            open: true,
            runId: runId || (groups[0] && groups[0].runId) || null,
            phase: 'idle',
            groups: groups,
            candidates: candidates,
            selection: selection,
            expanded: {},
            result: null,
            error: null,
            pendingAction: null,
            startedAt: nowIso(),
          },
        })
        return true
      }

      function exitReview(reason) {
        const review = snapshot.review
        const wasApplying = review.phase === 'applying'
        update({ review: emptyReview() })
        // 退出从不依赖 pending 刷新；后台刷新只用于列表态数据，不阻塞退出。
        loadStatus()
        loadPending()
        if (wasApplying) {
          m0.toast('warn', '已返回收件箱，后台仍在处理刚才的确认')
        }
        return true
      }

      function reviewToggle(candidateId, checked) {
        if (snapshot.review.phase !== 'idle') return
        const selection = Object.assign({}, snapshot.review.selection)
        if (checked === true) selection[candidateId] = true
        else delete selection[candidateId]
        update({ review: Object.assign({}, snapshot.review, { selection: selection }) })
      }

      function reviewSelectAllLowRisk() {
        if (snapshot.review.phase !== 'idle') return
        const selection = {}
        snapshot.review.candidates.forEach(function each(entry) {
          if (isLowRiskCandidate(entry.candidate)) selection[entry.candidate.candidateId] = true
        })
        update({ review: Object.assign({}, snapshot.review, { selection: selection }) })
      }

      function reviewSelectNone() {
        if (snapshot.review.phase !== 'idle') return
        update({ review: Object.assign({}, snapshot.review, { selection: {} }) })
      }

      function reviewToggleExpanded(candidateId) {
        const expanded = Object.assign({}, snapshot.review.expanded)
        if (expanded[candidateId]) delete expanded[candidateId]
        else expanded[candidateId] = true
        update({ review: Object.assign({}, snapshot.review, { expanded: expanded }) })
      }

      function removeCandidatesFromReview(candidateIds) {
        const drop = {}
        ;(candidateIds || []).forEach(function each(id) {
          drop[id] = true
        })
        const groups = []
        ;(snapshot.review.groups || []).forEach(function eachGroup(group) {
          const remaining = (group.candidates || []).filter(function keep(candidate) {
            return !drop[candidate.candidateId]
          })
          if (remaining.length) groups.push(Object.assign({}, group, { candidates: remaining }))
        })
        const candidates = flattenGroups(groups)
        const selection = {}
        Object.keys(snapshot.review.selection || {}).forEach(function keep(id) {
          if (!drop[id]) selection[id] = true
        })
        return { groups: groups, candidates: candidates, selection: selection }
      }

      function buildResult(value, decisions, contextById) {
        const result = value || {}
        const accepted = decisions.filter(function keep(decision) {
          return decision.action !== 'ignore'
        })
        const rawCreated = Array.isArray(result.created) ? result.created : []
        const created = rawCreated.map(function enrich(item, index) {
          const fallbackDecision = item.candidateId ? null : accepted[index]
          const candidateId = item.candidateId || (fallbackDecision ? fallbackDecision.candidateId : null)
          const context = candidateId ? contextById[candidateId] : null
          if (!context) return item
          return Object.assign({}, item, {
            rawRecordId: item.rawRecordId || context.rawRecordId,
            rawText: context.rawText,
          })
        })
        const applied = Number(result.applied) || accepted.length
        const ignored = Number(result.ignored) || decisions.filter(function count(decision) {
          return decision.action === 'ignore'
        }).length
        const typeCounts = {}
        created.forEach(function countType(item) {
          const label = candidateKindLabel(item.type)
          typeCounts[label] = (typeCounts[label] || 0) + 1
        })
        const handledEarlier = Array.isArray(result.handledEarlier) ? result.handledEarlier : []
        const duplicates = Array.isArray(result.duplicates) ? result.duplicates : []
        const duplicateCount = duplicates.length || Number(result.duplicateCount) || 0
        return {
          applied: applied,
          ignored: ignored,
          created: created,
          typeCounts: typeCounts,
          at: nowIso(),
          alreadyApplied: result.alreadyApplied === true,
          handledEarlierCount: handledEarlier.length,
          duplicates: duplicates,
          duplicateCount: duplicateCount,
          applyComplete: result.applyComplete !== false,
        }
      }

      function reviewApply(decisions, kind) {
        const review = snapshot.review
        if (!review.open || review.phase === 'applying') return Promise.resolve(null)
        if (!Array.isArray(decisions) || decisions.length === 0) return Promise.resolve(null)
        const runId = review.runId
        if (!runId) {
          update({ review: Object.assign({}, review, { phase: 'error', error: '缺少整理批次信息，请返回收件箱重新整理', pendingAction: null }) })
          return Promise.resolve(null)
        }
        const contextById = {}
        review.candidates.forEach(function each(entry) {
          const raw = entry.group.rawRecord || {}
          contextById[entry.candidate.candidateId] = { rawRecordId: raw.id || null, rawText: String(raw.text || '') }
        })
        const pendingAction = { kind: kind, decisions: decisions, requestId: makeRequestId() }
        update({ review: Object.assign({}, review, { phase: 'applying', error: null, pendingAction: pendingAction }) })
        return triageApplyApi(runId, decisions, pendingAction.requestId)
          .then(function onOk(value) {
            const result = buildResult(value, decisions, contextById)
            const decidedIds = decisions.map(function map(decision) {
              return decision.candidateId
            })
            const left = removeCandidatesFromReview(decidedIds)
            const lastApply = {
              runId: runId,
              applied: result.applied,
              ignored: result.ignored,
              created: result.created,
              duplicates: result.duplicates || [],
              at: result.at,
              label: kind,
            }
            // 任何接受/忽略成功都进入结果页；未处理候选保留，可在结果页继续审查或返回列表稍后处理。
            update({
              lastApply: lastApply,
              review: Object.assign({}, snapshot.review, {
                phase: 'done',
                groups: left.groups,
                candidates: left.candidates,
                selection: left.selection,
                result: result,
                error: null,
                pendingAction: null,
              }),
            })
            m0.toast('success', TEXT.triageApplyDone + ' ' + result.applied + ' 项' + (result.ignored ? '，' + TEXT.triageApplyIgnored + ' ' + result.ignored + ' 项' : ''))
            loadStatus()
            loadPending()
            return result
          })
          .catch(function onError(error) {
            update({
              review: Object.assign({}, snapshot.review, {
                phase: 'error',
                error: errorText(error),
                pendingAction: pendingAction,
              }),
            })
            m0.toast('error', TEXT.triageApplyFailed + '：' + errorText(error))
            return null
          })
      }

      function reviewAcceptSelected() {
        const review = snapshot.review
        if (!review.open || review.phase !== 'idle') return Promise.resolve(null)
        const decisions = Object.keys(review.selection || {}).map(function map(id) {
          return { candidateId: id, action: 'accept' }
        })
        if (!decisions.length) return Promise.resolve(null)
        return reviewApply(decisions, 'accept')
      }

      function reviewIgnoreAll() {
        const review = snapshot.review
        if (!review.open || review.phase !== 'idle') return Promise.resolve(null)
        const decisions = (review.candidates || []).map(function map(entry) {
          return { candidateId: entry.candidate.candidateId, action: 'ignore' }
        })
        if (!decisions.length) return Promise.resolve(null)
        return reviewApply(decisions, 'ignore')
      }

      function reviewEditAccept(candidateId, patch) {
        const review = snapshot.review
        if (!review.open || review.phase !== 'idle') return Promise.resolve(null)
        return reviewApply([{ candidateId: candidateId, action: 'edit', patch: patch || {} }], 'edit')
      }

      function reviewRetry() {
        const action = snapshot.review.pendingAction
        if (!action) return Promise.resolve(null)
        if (action.kind === 'rerun') {
          exitReview('retry-rerun')
          return runTriage()
        }
        if (action.kind === 'ignore') return reviewApply(action.decisions, 'ignore')
        if (action.kind === 'accept') return reviewApply(action.decisions, 'accept')
        if (action.kind === 'edit') return reviewApply(action.decisions, 'edit')
        return Promise.resolve(null)
      }

      function reviewContinue() {
        const review = snapshot.review
        if (!review.open || !review.candidates.length) {
          return exitReview('review-continue-empty')
        }
        const selection = {}
        review.candidates.forEach(function each(entry) {
          if (isLowRiskCandidate(entry.candidate)) selection[entry.candidate.candidateId] = true
        })
        update({ review: Object.assign({}, review, { phase: 'idle', result: null, selection: selection, error: null }) })
        return true
      }

      function reviewFinish() {
        return exitReview('review-finish')
      }

      function reviewRevokeCreated(item) {
        if (!item || !item.id || !item.type || TRIAGE_CORRECTABLE_TYPES.indexOf(item.type) < 0) {
          m0.toast('warn', '该类型暂不支持撤销，已记录待办')
          return Promise.resolve(null)
        }
        return triageCorrectApi({ type: item.type, id: item.id, action: 'revoke', reason: '撤销本次整理' })
          .then(function onOk() {
            const review = snapshot.review
            if (review.result && Array.isArray(review.result.created)) {
              update({
                review: Object.assign({}, review, {
                  result: Object.assign({}, review.result, {
                    created: review.result.created.filter(function keep(createdItem) {
                      return createdItem !== item && createdItem.id !== item.id
                    }),
                  }),
                }),
              })
            }
            const lastApply = snapshot.lastApply
            if (lastApply && Array.isArray(lastApply.created)) {
              update({
                lastApply: Object.assign({}, lastApply, {
                  created: lastApply.created.filter(function keep(createdItem) {
                    return createdItem !== item && createdItem.id !== item.id
                  }),
                }),
              })
            }
            m0.toast('success', TEXT.triageApplyUndoDone)
          })
          .catch(function onError(error) {
            m0.toast('error', errorText(error))
          })
      }

      function reviewUndoAll() {
        const review = snapshot.review
        const created = review.result && Array.isArray(review.result.created) ? review.result.created : []
        const correctable = created.filter(function filter(item) {
          return item && item.id && item.type && TRIAGE_CORRECTABLE_TYPES.indexOf(item.type) >= 0
        })
        if (!correctable.length) {
          m0.toast('warn', TEXT.triageApplyUndoUnsupported)
          return Promise.resolve(null)
        }
        let chain = Promise.resolve(null)
        let failed = 0
        correctable.forEach(function each(item) {
          chain = chain.then(function next() {
            return triageCorrectApi({ type: item.type, id: item.id, action: 'revoke', reason: '撤销本次整理' }).catch(function ignore() {
              failed += 1
              return null
            })
          })
        })
        return chain.then(function done() {
          const revokedIds = {}
          correctable.forEach(function mark(item) {
            revokedIds[item.id] = true
          })
          const latest = snapshot.review
          if (latest.result) {
            update({
              review: Object.assign({}, latest, {
                result: Object.assign({}, latest.result, {
                  created: (latest.result.created || []).filter(function keep(item) {
                    return !revokedIds[item.id]
                  }),
                }),
              }),
            })
          }
          if (failed > 0) m0.toast('warn', TEXT.triageApplyUndoDone + '（' + (correctable.length - failed) + ' 项），' + failed + ' 项失败可重试')
          else m0.toast('success', TEXT.triageApplyUndoDone)
        })
      }

      function dispose() {
        disposed = true
        timers.forEach(function clear(id) {
          try {
            window.clearTimeout(id)
          } catch (error) {
            /* ignore */
          }
        })
        timers.clear()
        listeners.clear()
      }

      return {
        getState: getState,
        subscribe: subscribe,
        init: init,
        refreshAll: refreshAll,
        loadStatus: loadStatus,
        loadPending: loadPending,
        loadAutomation: loadAutomation,
        onExternalChange: onExternalChange,
        selectCandidate: selectCandidate,
        selectAllLowRisk: selectAllLowRisk,
        clearSelection: clearSelection,
        selectedCount: selectedCount,
        acceptCandidate: acceptCandidate,
        ignoreCandidate: ignoreCandidate,
        editAcceptCandidate: editAcceptCandidate,
        batchAcceptSelected: batchAcceptSelected,
        undoLastApply: undoLastApply,
        revokeCreated: revokeCreated,
        runTriage: runTriage,
        enterReview: enterReview,
        exitReview: exitReview,
        openPage: openPage,
        closePage: closePage,
        reviewToggle: reviewToggle,
        reviewSelectAllLowRisk: reviewSelectAllLowRisk,
        reviewSelectNone: reviewSelectNone,
        reviewToggleExpanded: reviewToggleExpanded,
        reviewAcceptSelected: reviewAcceptSelected,
        reviewIgnoreAll: reviewIgnoreAll,
        reviewEditAccept: reviewEditAccept,
        reviewRetry: reviewRetry,
        reviewFinish: reviewFinish,
        reviewContinue: reviewContinue,
        reviewRevokeCreated: reviewRevokeCreated,
        reviewUndoAll: reviewUndoAll,
        reviewSelectionCount: reviewSelectionCount,
        reviewLowRiskCount: reviewLowRiskCount,
        reprocess: reprocess,
        toggleExpandedSource: toggleExpandedSource,
        deepTriage: deepTriage,
        setAutomationEnabled: setAutomationEnabled,
        isEditing: isEditing,
        dispose: dispose,
      }
    }

    const navigation = { selectConversation: null }
    const triage = createTriageRuntime(runtime, navigation)

    /* ═════════════════════════ M2.5：笔记（HTTP / mock / 运行时） ═════════════════════════ */

    function notesConfigApi() {
      return apiRequest('/notes/config')
    }

    function notesSetConfigApi(patch) {
      return apiRequest('/notes/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(patch || {}),
      })
    }

    function notesTreeApi(dir) {
      const suffix = dir ? '?dir=' + encodeURIComponent(dir) : ''
      return apiRequest('/notes/tree' + suffix)
    }

    function notesReadApi(path) {
      return apiRequest('/notes/file?path=' + encodeURIComponent(path))
    }

    function notesWriteApi(path, content, baseHash) {
      return apiRequest('/notes/file', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          path: path,
          content: content,
          baseHash: baseHash === undefined ? null : baseHash,
          requestId: 'note-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        }),
      })
    }

    function notesCreateApi(path, content) {
      return apiRequest('/notes/file', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          path: path,
          content: content || '',
          requestId: 'note-new-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        }),
      })
    }

    function notesFolderApi(path, recursive) {
      return apiRequest('/notes/folder', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ path: path, recursive: recursive === true }),
      })
    }

    function notesRenameApi(path, toPath) {
      return apiRequest('/notes/rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ path: path, toPath: toPath }),
      })
    }

    function notesRemoveApi(path) {
      return apiRequest('/notes/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ path: path, trash: true }),
      })
    }

    function notesSearchApi(q) {
      return apiRequest('/notes/search?q=' + encodeURIComponent(q))
    }

    function notesSnapshotApi(path) {
      return apiRequest('/notes/snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ path: path }),
      })
    }

    function notesHistoryApi(path) {
      return apiRequest('/notes/history?path=' + encodeURIComponent(path))
    }

    function createMockNotesStore() {
      const now = Date.now()
      const files = {
        '欢迎.md': '# 欢迎使用 LifeOS 笔记\n\n这里是你的本地 Markdown 笔记目录。\n\n- 左侧管理文件与目录\n- 右侧直接用 Markdown 源码写作\n- 自动保存（800ms 防抖），Ctrl/Cmd+S 立即保存\n',
        '日记/2026-11-13.md': '# 2026-11-13\n\n今天开始用 LifeOS 记笔记。\n',
        '日记/2026-11-12.md': '# 2026-11-12\n\n随手记一些想法。\n',
        '灵感.md': '# 灵感\n\n- 做一个每日回顾页面\n',
      }
      const entries = [
        { name: '日记', path: '日记', type: 'dir', size: 0, mtime: now, editable: false },
        { name: '2026-11-13.md', path: '日记/2026-11-13.md', type: 'file', size: 48, mtime: now, editable: true },
        { name: '2026-11-12.md', path: '日记/2026-11-12.md', type: 'file', size: 36, mtime: now - 86400000, editable: true },
        { name: '欢迎.md', path: '欢迎.md', type: 'file', size: 90, mtime: now, editable: true },
        { name: '灵感.md', path: '灵感.md', type: 'file', size: 32, mtime: now - 3600000, editable: true },
      ]
      return {
        config: {
          dir: 'C:\\Users\\Roy\\Documents\\LifeOS\\Notes',
          options: { autosaveMs: 800, historyLimit: 20 },
          exists: true,
          writable: true,
        },
        files: files,
        entries: entries,
        history: {},
        seq: 1,
      }
    }

    const mockNotesStore = createMockNotesStore()

    function mockNotesTree() {
      return { entries: JSON.parse(JSON.stringify(mockNotesStore.entries)) }
    }

    function mockNotesRead(path) {
      const content = mockNotesStore.files[path]
      if (content === undefined) throw ApiError('not_found', '笔记不存在：' + path)
      const entry = mockNotesStore.entries.find(function find(item) {
        return item.path === path
      })
      const text = String(content)
      return {
        path: path,
        content: text,
        mtime: entry ? entry.mtime : Date.now(),
        hash: 'mock_hash_' + text.length + '_' + String(path.length),
        size: text.length,
        encoding: 'utf-8',
      }
    }

    function mockNotesWrite(path, content, baseHash) {
      const current = mockNotesStore.files[path]
      if (current === undefined) throw ApiError('not_found', '笔记不存在：' + path)
      const text = String(content)
      if (baseHash && baseHash !== 'mock_hash_' + String(current).length + '_' + String(path.length)) {
        throw ApiError('conflict', '文件已在外部修改', { currentHash: 'mock_hash_' + String(current).length + '_' + String(path.length), mtime: Date.now() })
      }
      mockNotesStore.files[path] = text
      const entry = mockNotesStore.entries.find(function find(item) {
        return item.path === path
      })
      if (entry) {
        entry.size = text.length
        entry.mtime = Date.now()
      }
      return { path: path, mtime: Date.now(), hash: 'mock_hash_' + text.length + '_' + String(path.length), size: text.length, created: false }
    }

    function mockNotesCreate(path, content) {
      if (mockNotesStore.files[path] !== undefined) throw ApiError('path_exists', '文件已存在：' + path)
      const text = String(content || '')
      mockNotesStore.files[path] = text
      mockNotesStore.entries.push({
        name: path.split('/').pop(),
        path: path,
        type: 'file',
        size: text.length,
        mtime: Date.now(),
        editable: true,
      })
      return { path: path, mtime: Date.now(), hash: 'mock_hash_' + text.length + '_' + String(path.length), size: text.length }
    }

    function mockNotesFolder(path) {
      mockNotesStore.entries.push({ name: path.split('/').pop(), path: path, type: 'dir', size: 0, mtime: Date.now(), editable: false })
      return { path: path }
    }

    function mockNotesRename(path, toPath) {
      const index = mockNotesStore.entries.findIndex(function find(item) {
        return item.path === path
      })
      if (index < 0) throw ApiError('not_found', '文件不存在：' + path)
      const entry = mockNotesStore.entries[index]
      entry.path = toPath
      entry.name = toPath.split('/').pop()
      if (mockNotesStore.files[path] !== undefined) {
        mockNotesStore.files[toPath] = mockNotesStore.files[path]
        delete mockNotesStore.files[path]
      }
      return { path: toPath }
    }

    function mockNotesRemove(path) {
      mockNotesStore.entries = mockNotesStore.entries.filter(function keep(item) {
        return item.path !== path && item.path.indexOf(path + '/') !== 0
      })
      Object.keys(mockNotesStore.files).forEach(function each(key) {
        if (key === path || key.indexOf(path + '/') === 0) delete mockNotesStore.files[key]
      })
      return { removed: true }
    }

    function mockNotesRenameDirectory(from, to) {
      let touched = false
      mockNotesStore.entries.forEach(function each(entry) {
        if (entry.path === from || entry.path.indexOf(from + '/') === 0) {
          entry.path = to + entry.path.slice(from.length)
          entry.name = entry.path.split('/').pop()
          touched = true
        }
      })
      Object.keys(mockNotesStore.files).forEach(function each(key) {
        if (key === from || key.indexOf(from + '/') === 0) {
          mockNotesStore.files[to + key.slice(from.length)] = mockNotesStore.files[key]
          delete mockNotesStore.files[key]
          touched = true
        }
      })
      if (!touched) throw ApiError('not_found', '文件夹不存在：' + from)
      return { path: to }
    }

    function mockNotesRemoveDirectory(path) {
      mockNotesStore.entries = mockNotesStore.entries.filter(function keep(entry) {
        return entry.path !== path && entry.path.indexOf(path + '/') !== 0
      })
      Object.keys(mockNotesStore.files).forEach(function each(key) {
        if (key === path || key.indexOf(path + '/') === 0) delete mockNotesStore.files[key]
      })
      return { removed: true, trashPath: '.trash/mock/' + path }
    }

    function mockNotesSearch(q) {
      const needle = String(q || '').toLowerCase()
      const items = []
      Object.keys(mockNotesStore.files).forEach(function each(path) {
        const content = String(mockNotesStore.files[path] || '')
        if (path.toLowerCase().indexOf(needle) < 0 && content.toLowerCase().indexOf(needle) < 0) return
        const index = content.toLowerCase().indexOf(needle)
        const snippet = index >= 0 ? content.slice(Math.max(0, index - 20), index + 60) : content.slice(0, 60)
        items.push({ path: path, title: path.split('/').pop(), snippet: snippet, mtime: Date.now() })
      })
      return { items: items.slice(0, 50) }
    }

    function mockNotesHistory(path) {
      const current = mockNotesStore.history[path] || []
      return { items: current }
    }

    function mockNotesSnapshot(path) {
      const content = String(mockNotesStore.files[path] || '')
      mockNotesStore.history[path] = [{ id: 'snap_' + Date.now(), at: new Date().toISOString(), size: content.length }].concat(mockNotesStore.history[path] || [])
      return { snapshotPath: 'notes-history/' + path + '.snap', mtime: Date.now() }
    }

    /* ═════════════════════════ M2.5：笔记运行时 ═════════════════════════ */

    function createNotesRuntime(m0, nav) {
      const initial = {
        phase: 'idle',
        mock: false,
        config: { phase: 'idle', data: null, error: null, saving: false },
        tree: { phase: 'idle', entries: [], expanded: {}, error: null, selected: null },
        search: { q: '', phase: 'idle', items: [], error: null },
        doc: {
          phase: 'empty',
          path: null,
          name: '',
          content: '',
          baseContent: '',
          hash: null,
          mtime: null,
          size: 0,
          dirty: false,
          saving: false,
          saveState: 'idle',
          lastSavedAt: null,
          lastWriteAt: null,
          error: null,
          conflict: null,
          external: null,
        },
        preview: false,
        history: { phase: 'idle', path: null, items: [], error: null },
        busy: { create: false, rename: false, remove: false, snapshot: false },
      }

      let snapshot = initial
      const listeners = new Set()
      const timers = new Set()
      let saveTimer = null
      let treeTimer = null
      let disposed = false

      function schedule(fn, delay) {
        const id = window.setTimeout(function run() {
          timers.delete(id)
          try {
            fn()
          } catch (error) {
            console.error('[lifeos] notes timer failed', error)
          }
        }, delay)
        timers.add(id)
        return id
      }

      function getState() {
        return snapshot
      }

      function setState(next) {
        if (disposed || !next || next === snapshot) return
        snapshot = next
        Array.from(listeners).forEach(function notify(listener) {
          try {
            listener()
          } catch (error) {
            console.error('[lifeos] notes subscriber failed', error)
          }
        })
      }

      function update(patch) {
        setState(Object.assign({}, snapshot, patch || {}))
      }

      function updateDoc(patch) {
        update({ doc: Object.assign({}, snapshot.doc, patch || {}) })
      }

      function subscribe(listener) {
        listeners.add(listener)
        return function unsubscribe() {
          listeners.delete(listener)
        }
      }

      function autosaveDelay() {
        const options = (snapshot.config.data && snapshot.config.data.options) || {}
        const value = Number(options.autosaveMs)
        return Number.isFinite(value) && value >= 200 ? Math.min(5000, value) : 800
      }

      function currentDir() {
        const path = snapshot.doc.path
        if (path && path.indexOf('/') >= 0) return path.slice(0, path.lastIndexOf('/'))
        const selected = snapshot.tree.selected
        if (selected && snapshot.tree.entries.some(function find(entry) { return entry.path === selected && entry.type === 'dir' })) return selected
        return ''
      }

      function isDirPath(path) {
        return (snapshot.tree.entries || []).some(function find(entry) {
          return entry && entry.path === path && entry.type === 'dir'
        })
      }

      function noteNameExists(dir, name) {
        const full = dir ? dir + '/' + name : name
        const lower = String(full).toLowerCase()
        return (snapshot.tree.entries || []).some(function find(entry) {
          return String(entry && entry.path ? entry.path : '').toLowerCase() === lower
        })
      }

      function nextDatedCandidate(dir, attempt, dateKey) {
        const base = dateKey || todayIso()
        const name = attempt <= 1 ? base + '.md' : base + ' (' + attempt + ').md'
        return dir ? dir + '/' + name : name
      }

      // R2：日期命名 + 本地同名探测 + 服务端 409 path_exists 序号递增重试（≤10）
      function createDatedFile(dir, content) {
        const dateKey = todayIso()
        const dirValue = dir || ''
        let attempt = 1
        while (attempt < 10) {
          const name = attempt <= 1 ? dateKey + '.md' : dateKey + ' (' + attempt + ').md'
          if (!noteNameExists(dirValue, name)) break
          attempt += 1
        }
        function tryCreate() {
          const path = nextDatedCandidate(dirValue, attempt, dateKey)
          return notesCreateApi(path, content).then(function onOk(value) {
            return (value && value.path) || path
          }).catch(function onError(error) {
            if (error && error.code === 'path_exists' && attempt < 10) {
              attempt += 1
              return tryCreate()
            }
            throw error
          })
        }
        return tryCreate()
      }

      function isUnavailableError(error) {
        const code = error && error.code
        if (!code) return true
        if (['notes_unavailable', 'not_found', 'method_not_allowed', 'validation_failed'].indexOf(code) >= 0) {
          // 端点未就绪（unknown route）时回退；真实校验错误保留
          const message = String((error && error.message) || '')
          return code === 'notes_unavailable' || /unknown|not found|未就绪|未装配/i.test(message) || code === 'not_found'
        }
        return false
      }

      function refreshMockTree(extra) {
        update(Object.assign({
          tree: Object.assign({}, snapshot.tree, { phase: 'fallback', entries: mockNotesTree().entries, error: null }),
          mock: true,
        }, extra || {}))
      }

      function loadConfig() {
        update({ config: Object.assign({}, snapshot.config, { phase: snapshot.config.data ? 'ready' : 'loading', error: null }) })
        return notesConfigApi()
          .then(function onOk(value) {
            const data = value && value.config ? value.config : value
            const config = Object.assign({ dir: '', exists: false, writable: false, options: { autosaveMs: 800, historyLimit: 20 } }, data || {})
            update({ config: { phase: 'ready', data: config, error: null, saving: false }, mock: false })
            if (config.exists) return loadTree()
            return undefined
          })
          .catch(function onError(error) {
            const data = JSON.parse(JSON.stringify(mockNotesStore.config))
            update({
              config: { phase: 'fallback', data: data, error: errorText(error), saving: false },
              mock: true,
            })
            return loadTree()
          })
      }

      function setConfig(dir, create) {
        const value = String(dir || '').trim()
        if (!value) return Promise.resolve(null)
        update({ config: Object.assign({}, snapshot.config, { saving: true, error: null }) })
        return notesSetConfigApi({ dir: value, create: create === true })
          .then(function onOk(result) {
            const data = result && result.config ? result.config : result
            const config = Object.assign({ dir: value, exists: true, writable: true, options: { autosaveMs: 800, historyLimit: 20 } }, data || {})
            update({ config: { phase: 'ready', data: config, error: null, saving: false }, mock: false })
            return loadTree()
          })
          .catch(function onError(error) {
            update({ config: Object.assign({}, snapshot.config, { saving: false, error: errorText(error) }) })
            m0.toast('error', '笔记目录设置失败：' + errorText(error))
            return null
          })
      }

      function loadTree() {
        update({ tree: Object.assign({}, snapshot.tree, { phase: snapshot.tree.entries.length ? 'ready' : 'loading', error: null }) })
        return notesTreeApi()
          .then(function onOk(value) {
            const entries = value && Array.isArray(value.entries) ? value.entries : []
            update({ tree: { phase: 'ready', entries: entries, expanded: snapshot.tree.expanded, error: null, selected: snapshot.tree.selected }, mock: false })
          })
          .catch(function onError(error) {
            update({
              tree: { phase: 'fallback', entries: mockNotesTree().entries, expanded: snapshot.tree.expanded, error: errorText(error), selected: snapshot.tree.selected },
              mock: true,
            })
          })
      }

      function scheduleTreeReload() {
        if (treeTimer) {
          try {
            window.clearTimeout(treeTimer)
          } catch (error) {
            /* ignore */
          }
        }
        treeTimer = schedule(function reload() {
          treeTimer = null
          loadTree()
        }, 400)
      }

      function toggleDir(path) {
        const expanded = Object.assign({}, snapshot.tree.expanded)
        if (expanded[path]) delete expanded[path]
        else expanded[path] = true
        update({ tree: Object.assign({}, snapshot.tree, { expanded: expanded, selected: path }) })
      }

      function setSearch(q) {
        const value = String(q || '')
        update({ search: { q: value, phase: value ? 'loading' : 'idle', items: value ? snapshot.search.items : [], error: null } })
        if (!value) return Promise.resolve(null)
        return notesSearchApi(value)
          .then(function onOk(result) {
            const items = result && Array.isArray(result.items) ? result.items : []
            update({ search: { q: value, phase: 'ready', items: items, error: null } })
          })
          .catch(function onError(error) {
            const items = mockNotesSearch(value).items
            update({ search: { q: value, phase: 'fallback', items: items, error: errorText(error) } })
          })
      }

      function clearEditorError() {
        updateDoc({ error: null })
      }

      function openFile(path) {
        if (!path) return Promise.resolve(null)
        update({
          doc: Object.assign({}, snapshot.doc, { phase: 'loading', path: path, name: String(path).split('/').pop(), error: null, conflict: null, external: null }),
          tree: Object.assign({}, snapshot.tree, { selected: path }),
          preview: snapshot.preview,
        })
        return notesReadApi(path)
          .then(function onOk(value) {
            const file = value && value.file ? value.file : value
            updateDoc({
              phase: 'ready',
              path: file.path || path,
              name: String(file.path || path).split('/').pop(),
              content: String(file.content === undefined ? '' : file.content),
              baseContent: String(file.content === undefined ? '' : file.content),
              hash: file.hash || null,
              mtime: file.mtime || null,
              size: Number(file.size) || 0,
              dirty: false,
              saving: false,
              saveState: 'saved',
              lastSavedAt: file.mtime ? new Date(file.mtime).toISOString() : nowIso(),
              lastWriteAt: null,
              error: null,
              conflict: null,
              external: null,
            })
            loadHistory(file.path || path)
          })
          .catch(function onError(error) {
            // Host 不可达时用 mock 内容展示（down 模式可看界面，不可写）
            try {
              const file = mockNotesRead(path)
              updateDoc({
                phase: 'ready',
                path: file.path,
                name: String(file.path).split('/').pop(),
                content: file.content,
                baseContent: file.content,
                hash: file.hash,
                mtime: file.mtime,
                size: file.size,
                dirty: false,
                saving: false,
                saveState: 'saved',
                lastSavedAt: nowIso(),
                error: null,
                conflict: null,
                external: null,
              })
              update({ mock: true })
              loadHistory(path)
              return
            } catch (mockError) {
              updateDoc({ phase: 'error', error: errorText(error), dirty: false })
            }
          })
      }

      function editContent(content) {
        if (!snapshot.doc.path) return
        updateDoc({ content: String(content === undefined ? '' : content), dirty: true, saveState: 'pending', error: null })
        if (saveTimer) {
          try {
            window.clearTimeout(saveTimer)
          } catch (error) {
            /* ignore */
          }
        }
        saveTimer = schedule(function autoSave() {
          saveTimer = null
          saveNow(false)
        }, autosaveDelay())
      }

      function saveNow(force) {
        const doc = snapshot.doc
        if (!doc.path) return Promise.resolve(null)
        if (!doc.dirty && force !== true) return Promise.resolve(null)
        if (saveTimer) {
          try {
            window.clearTimeout(saveTimer)
          } catch (error) {
            /* ignore */
          }
          saveTimer = null
        }
        updateDoc({ saving: true, saveState: 'saving', error: null })
        return notesWriteApi(doc.path, doc.content, doc.hash)
          .then(function onOk(value) {
            const file = value && value.file ? value.file : value
            updateDoc({
              saving: false,
              dirty: false,
              saveState: 'saved',
              baseContent: snapshot.doc.content,
              hash: (file && file.hash) || snapshot.doc.hash,
              mtime: (file && file.mtime) || Date.now(),
              size: Number((file && file.size) || snapshot.doc.content.length),
              lastSavedAt: nowIso(),
              lastWriteAt: Date.now(),
              error: null,
              conflict: null,
            })
            scheduleTreeReload()
          })
          .catch(function onError(error) {
            if (error && error.code === 'conflict') {
              const details = error.details || {}
              updateDoc({
                saving: false,
                saveState: 'conflict',
                dirty: true,
                conflict: {
                  message: '文件已在外部修改（写入冲突）',
                  currentHash: details.currentHash || null,
                  mtime: details.mtime || null,
                },
              })
              return null
            }
            updateDoc({ saving: false, saveState: 'error', error: errorText(error) })
            m0.toast('error', '保存失败：' + errorText(error))
            return null
          })
      }

      function reloadCurrent() {
        const doc = snapshot.doc
        if (!doc.path) return Promise.resolve(null)
        updateDoc({ conflict: null, external: null })
        return openFile(doc.path)
      }

      function overwriteCurrent() {
        const doc = snapshot.doc
        if (!doc.path) return Promise.resolve(null)
        // 覆盖：不带 baseHash 强制写（服务端 baseHash=null 视为覆盖）
        updateDoc({ saving: true, saveState: 'saving', conflict: null, external: null })
        return notesWriteApi(doc.path, doc.content, null)
          .then(function onOk(value) {
            const file = value && value.file ? value.file : value
            updateDoc({
              saving: false,
              dirty: false,
              saveState: 'saved',
              baseContent: snapshot.doc.content,
              hash: (file && file.hash) || snapshot.doc.hash,
              mtime: (file && file.mtime) || Date.now(),
              error: null,
              conflict: null,
              external: null,
              lastSavedAt: nowIso(),
              lastWriteAt: Date.now(),
            })
            scheduleTreeReload()
          })
          .catch(function onError(error) {
            updateDoc({ saving: false, saveState: 'error', error: errorText(error) })
          })
      }

      function saveCopy() {
        const doc = snapshot.doc
        if (!doc.path) return Promise.resolve(null)
        const base = doc.path.replace(/\.(md|markdown|txt)$/i, '')
        const stamp = nowIso().replace(/[-:T]/g, '').slice(0, 14)
        const copyPath = base + '-副本-' + stamp + '.md'
        return notesCreateApi(copyPath, doc.content)
          .then(function onOk() {
            m0.toast('success', '已另存副本：' + copyPath)
            scheduleTreeReload()
            return openFile(copyPath)
          })
          .catch(function onError(error) {
            m0.toast('error', '另存副本失败：' + errorText(error))
            return null
          })
      }

      function createNote(parentDir, name) {
        const dir = parentDir === undefined ? currentDir() : parentDir
        const custom = String(name || '').trim()
        update({ busy: Object.assign({}, snapshot.busy, { create: true }) })
        const pending = custom
          ? (function customName() {
              const safeName = /\.(md|markdown|txt)$/i.test(custom) ? custom : custom + '.md'
              const path = dir ? dir + '/' + safeName : safeName
              return notesCreateApi(path, '').then(function onOk() {
                return path
              })
            })()
          : createDatedFile(dir, '# ' + todayIso() + '\n\n')
        return pending
          .then(function onOk(path) {
            update({ busy: Object.assign({}, snapshot.busy, { create: false }) })
            m0.toast('success', '已新建笔记：' + String(path).split('/').pop())
            scheduleTreeReload()
            return openFile(path)
          })
          .catch(function onError(error) {
            update({ busy: Object.assign({}, snapshot.busy, { create: false }) })
            m0.toast('error', '新建笔记失败：' + errorText(error))
            return null
          })
      }

      function createFolder(parentDir, name) {
        const dir = parentDir === undefined ? currentDir() : parentDir
        const folderName = String(name || '').trim()
        if (!folderName) return Promise.resolve(null)
        const path = dir ? dir + '/' + folderName : folderName
        update({ busy: Object.assign({}, snapshot.busy, { create: true }) })
        function fallback(error) {
          // 端点未就绪：mock 模式本地创建；真实 Host 用旧占位文件兼容（后端就绪后自动走主路径）
          if (snapshot.mock) {
            mockNotesFolder(path)
            refreshMockTree()
            update({ busy: Object.assign({}, snapshot.busy, { create: false }), tree: Object.assign({}, snapshot.tree, { expanded: Object.assign({}, snapshot.tree.expanded, { [path]: true }) }) })
            m0.toast('warn', '本地模拟新建文件夹：' + path)
            return null
          }
          const keepPath = path + '/.lifeos-folder.md'
          return notesCreateApi(keepPath, '')
            .then(function () {
              return notesRemoveApi(keepPath).catch(function ignore() {
                return null
              })
            })
            .then(function onFallbackOk() {
              update({ busy: Object.assign({}, snapshot.busy, { create: false }), tree: Object.assign({}, snapshot.tree, { expanded: Object.assign({}, snapshot.tree.expanded, { [path]: true }) }) })
              m0.toast('warn', 'Host 文件夹端点未就绪，已用兼容方式创建文件夹：' + path)
              scheduleTreeReload()
              return null
            })
            .catch(function onFallbackError(fallbackError) {
              update({ busy: Object.assign({}, snapshot.busy, { create: false }) })
              m0.toast('error', '新建文件夹失败：' + errorText(fallbackError))
              return null
            })
        }
        return notesFolderApi(path, true)
          .then(function onOk() {
            update({ busy: Object.assign({}, snapshot.busy, { create: false }), tree: Object.assign({}, snapshot.tree, { expanded: Object.assign({}, snapshot.tree.expanded, { [path]: true }) }) })
            m0.toast('success', '已新建文件夹：' + path)
            scheduleTreeReload()
            return null
          })
          .catch(function onError(error) {
            if (isUnavailableError(error)) return fallback(error)
            update({ busy: Object.assign({}, snapshot.busy, { create: false }) })
            m0.toast('error', '新建文件夹失败：' + errorText(error))
            return null
          })
      }

      function renamePath(path, toPath) {
        const target = String(toPath || '').trim()
        if (!path || !target) return Promise.resolve(null)
        const dir = path.indexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/') + 1) : ''
        const finalPath = target.indexOf('/') >= 0 ? target : dir + target
        const wasDir = isDirPath(path)
        update({ busy: Object.assign({}, snapshot.busy, { rename: true }) })
        return notesRenameApi(path, finalPath)
          .then(function onOk(value) {
            const resultPath = (value && value.path) || finalPath
            const expanded = {}
            Object.keys(snapshot.tree.expanded || {}).forEach(function each(key) {
              if (wasDir && (key === path || key.indexOf(path + '/') === 0)) expanded[resultPath + key.slice(path.length)] = true
              else expanded[key] = true
            })
            const nextSelected = snapshot.tree.selected === path || (wasDir && String(snapshot.tree.selected || '').indexOf(path + '/') === 0)
              ? resultPath + String(snapshot.tree.selected || '').slice(path.length)
              : snapshot.tree.selected
            update({
              busy: Object.assign({}, snapshot.busy, { rename: false }),
              tree: Object.assign({}, snapshot.tree, { expanded: expanded, selected: nextSelected }),
            })
            m0.toast('success', wasDir ? '已重命名文件夹' : '已重命名')
            const docPath = snapshot.doc.path
            if (docPath === path) updateDoc({ path: resultPath, name: resultPath.split('/').pop() })
            else if (wasDir && docPath && docPath.indexOf(path + '/') === 0) {
              const moved = resultPath + docPath.slice(path.length)
              updateDoc({ path: moved, name: moved.split('/').pop() })
            }
            scheduleTreeReload()
          })
          .catch(function onError(error) {
            update({ busy: Object.assign({}, snapshot.busy, { rename: false }) })
            if (wasDir && snapshot.mock) {
              try {
                mockNotesRenameDirectory(path, finalPath)
                refreshMockTree()
                m0.toast('warn', '本地模拟重命名文件夹')
                return
              } catch (mockError) {
                /* fall through */
              }
            }
            if (wasDir && isUnavailableError(error)) m0.toast('warn', 'Host 暂未支持文件夹重命名（M2.6 后端就绪后可用）')
            else m0.toast('error', '重命名失败：' + errorText(error))
          })
      }

      function removePath(path) {
        if (!path) return Promise.resolve(null)
        const wasDir = isDirPath(path)
        update({ busy: Object.assign({}, snapshot.busy, { remove: true }) })
        function afterRemoved() {
          const expanded = {}
          Object.keys(snapshot.tree.expanded || {}).forEach(function each(key) {
            if (key !== path && key.indexOf(path + '/') !== 0) expanded[key] = true
          })
          const selected = snapshot.tree.selected
          const docPath = snapshot.doc.path
          const nextSelected = selected === path || String(selected || '').indexOf(path + '/') === 0 ? null : selected
          update({
            busy: Object.assign({}, snapshot.busy, { remove: false }),
            tree: Object.assign({}, snapshot.tree, { expanded: expanded, selected: nextSelected }),
          })
          if (docPath === path || (wasDir && docPath && docPath.indexOf(path + '/') === 0)) {
            updateDoc({ phase: 'empty', path: null, name: '', content: '', baseContent: '', hash: null, dirty: false, saveState: 'idle', conflict: null, external: null, error: null })
          }
          m0.toast('success', wasDir ? '文件夹已移入 .trash（可恢复）' : '已删除（可在 .trash 恢复）')
          scheduleTreeReload()
        }
        return notesRemoveApi(path)
          .then(afterRemoved)
          .catch(function onError(error) {
            if (wasDir && snapshot.mock) {
              try {
                mockNotesRemoveDirectory(path)
                refreshMockTree()
                afterRemoved()
                return
              } catch (mockError) {
                /* fall through */
              }
            }
            if (wasDir && isUnavailableError(error)) {
              update({ busy: Object.assign({}, snapshot.busy, { remove: false }) })
              m0.toast('warn', 'Host 暂未支持删除文件夹（M2.6 后端就绪后可用）')
              return
            }
            update({ busy: Object.assign({}, snapshot.busy, { remove: false }) })
            m0.toast('error', '删除失败：' + errorText(error))
          })
      }

      function togglePreview() {
        update({ preview: !snapshot.preview })
      }

      function loadHistory(path) {
        if (!path) return Promise.resolve(null)
        update({ history: { phase: 'loading', path: path, items: snapshot.history.path === path ? snapshot.history.items : [], error: null } })
        return notesHistoryApi(path)
          .then(function onOk(value) {
            const items = value && Array.isArray(value.items) ? value.items : []
            update({ history: { phase: 'ready', path: path, items: items, error: null } })
          })
          .catch(function onError(error) {
            const items = mockNotesHistory(path).items
            update({ history: { phase: 'fallback', path: path, items: items, error: errorText(error) } })
          })
      }

      function snapshotNow() {
        const doc = snapshot.doc
        if (!doc.path) return Promise.resolve(null)
        update({ busy: Object.assign({}, snapshot.busy, { snapshot: true }) })
        return notesSnapshotApi(doc.path)
          .then(function onOk() {
            update({ busy: Object.assign({}, snapshot.busy, { snapshot: false }) })
            m0.toast('success', '已创建手动快照')
            loadHistory(doc.path)
          })
          .catch(function onError(error) {
            update({ busy: Object.assign({}, snapshot.busy, { snapshot: false }) })
            m0.toast('error', '快照失败：' + errorText(error))
          })
      }

      function quickNote(text) {
        const value = String(text || '').trim()
        if (!value) return Promise.resolve(null)
        const dir = currentDir()
        return createDatedFile(dir, '# ' + todayIso() + '\n\n' + value + '\n')
          .then(function onOk(path) {
            m0.toast('success', '已存为笔记：' + String(path).split('/').pop())
            scheduleTreeReload()
            return path
          })
          .catch(function onError(error) {
            throw error
          })
      }

      function onExternalChange(reason, payload) {
        if (reason !== 'notes') {
          if (snapshot.config.data && snapshot.config.data.exists) scheduleTreeReload()
          return
        }
        const info = payload || {}
        const path = info.path || info.file || ''
        if (snapshot.doc.path && path && snapshot.doc.path === path) {
          const lastWrite = Number(snapshot.doc.lastWriteAt) || 0
          const selfRecent = snapshot.doc.saving === true || (lastWrite > 0 && Date.now() - lastWrite < 2000)
          if (selfRecent) {
            // 自己刚保存触发的 fs.watch 回声：只刷新树，不提示外部修改、不打断编辑。
            scheduleTreeReload()
            return
          }
          if (saveTimer) {
            try {
              window.clearTimeout(saveTimer)
            } catch (error) {
              /* ignore */
            }
            saveTimer = null
          }
          updateDoc({ external: { path: path, kind: info.kind || 'change', at: nowIso() } })
        }
        scheduleTreeReload()
      }

      function dismissExternal() {
        updateDoc({ external: null })
      }

      function init() {
        update({ phase: 'loading' })
        return loadConfig().then(function done() {
          update({ phase: 'ready' })
          reportClient({ phase: 'm25-notes-init', at: nowIso(), configured: !!(snapshot.config.data && snapshot.config.data.exists), mock: snapshot.mock })
        })
      }

      function dispose() {
        disposed = true
        timers.forEach(function clear(id) {
          try {
            window.clearTimeout(id)
          } catch (error) {
            /* ignore */
          }
        })
        timers.clear()
        listeners.clear()
      }

      return {
        getState: getState,
        subscribe: subscribe,
        init: init,
        loadConfig: loadConfig,
        setConfig: setConfig,
        loadTree: loadTree,
        toggleDir: toggleDir,
        setSearch: setSearch,
        openFile: openFile,
        editContent: editContent,
        saveNow: saveNow,
        reloadCurrent: reloadCurrent,
        overwriteCurrent: overwriteCurrent,
        saveCopy: saveCopy,
        createNote: createNote,
        createFolder: createFolder,
        renamePath: renamePath,
        removePath: removePath,
        togglePreview: togglePreview,
        loadHistory: loadHistory,
        snapshotNow: snapshotNow,
        quickNote: quickNote,
        onExternalChange: onExternalChange,
        dismissExternal: dismissExternal,
        clearEditorError: clearEditorError,
        dispose: dispose,
      }
    }

    const notes = createNotesRuntime(runtime, navigation)

    /* ═════════════════════════ M3：建议 / 通知 / 自动化（HTTP / mock / 运行时） ═════════════════════════ */

    function m3SuggestionsApi() {
      return apiRequest('/suggestions')
    }

    function m3SuggestionActApi(id, action, snoozeMinutes) {
      return apiRequest('/suggestions/' + encodeURIComponent(id) + '/act', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action: action, snoozeMinutes: snoozeMinutes === undefined ? undefined : snoozeMinutes }),
      })
    }

    function m3NotificationsApi() {
      return apiRequest('/notifications')
    }

    function m3NotificationReadApi(id) {
      return apiRequest('/notifications/' + encodeURIComponent(id) + '/read', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({}),
      })
    }

    function m3AutomationApi() {
      return apiRequest('/automation')
    }

    function m3AutomationPutApi(config) {
      return apiRequest('/automation', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(config),
      })
    }

    function m3AutomationStatusApi() {
      return apiRequest('/automation/status')
    }

    function defaultAutomationConfig() {
      return {
        morningBrief: { enabled: true, time: '07:35' },
        eveningReview: { enabled: false, time: '21:00' },
        habitNudge: { enabled: false, time: '20:30' },
        nightlyInbox: { enabled: true, time: '21:30' },
        deadlineReminder: { enabled: true, leadMinutes: 60, dueDateAt: '09:00' },
        dnd: { start: '22:45', end: '07:30' },
        dailyBudget: 2,
        suggestions: { enabled: true, maxPerDay: 2 },
      }
    }

    function normalizeTimeText(value, fallback) {
      const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''))
      if (!match) return fallback
      const hour = Math.min(23, Math.max(0, Number(match[1])))
      const minute = Math.min(59, Math.max(0, Number(match[2])))
      return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0')
    }

    function normalizeAutomationConfig(value) {
      const base = defaultAutomationConfig()
      let source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      // Host 的 getSettings()/patchSettings() 可能把设置包在 {settings:{...}} 里（最多两层）；
      // 逐层解到含 morningBrief 的设置本体，避免设置页回退成默认值。
      for (let depth = 0; depth < 3; depth += 1) {
        if (
          source && typeof source === 'object' && !Array.isArray(source) &&
          source.morningBrief === undefined &&
          source.settings && typeof source.settings === 'object' && !Array.isArray(source.settings)
        ) {
          source = source.settings
        } else {
          break
        }
      }
      if (source && typeof source === 'object' && !Array.isArray(source)) {
        source = source.automation || source.config || source
      } else {
        source = {}
      }
      const legacyNightly = source.inbox_nightly || source.inboxNightly
      function routine(key, label) {
        let raw = source[key] && typeof source[key] === 'object' ? source[key] : {}
        if (legacyNightly && key === 'nightlyInbox') {
          raw = Object.assign({}, legacyNightly, raw)
        }
        return {
          enabled: raw.enabled === undefined ? base[key].enabled : raw.enabled === true,
          time: normalizeTimeText(raw.time, base[key].time),
        }
      }
      const deadline = source.deadlineReminder && typeof source.deadlineReminder === 'object' ? source.deadlineReminder : {}
      const dnd = source.dnd && typeof source.dnd === 'object' ? source.dnd : {}
      const suggestions = source.suggestions && typeof source.suggestions === 'object' ? source.suggestions : {}
      return {
        morningBrief: routine('morningBrief'),
        eveningReview: routine('eveningReview'),
        habitNudge: routine('habitNudge'),
        nightlyInbox: routine('nightlyInbox'),
        deadlineReminder: {
          enabled: deadline.enabled === undefined ? base.deadlineReminder.enabled : deadline.enabled === true,
          leadMinutes: Math.min(1440, Math.max(5, Number(deadline.leadMinutes) || base.deadlineReminder.leadMinutes)),
          dueDateAt: normalizeTimeText(deadline.dueDateAt, base.deadlineReminder.dueDateAt),
        },
        dnd: {
          start: normalizeTimeText(dnd.start, base.dnd.start),
          end: normalizeTimeText(dnd.end, base.dnd.end),
        },
        dailyBudget: source.dailyBudget === undefined
          ? base.dailyBudget
          : Math.min(5, Math.max(0, Number(source.dailyBudget) || 0)),
        suggestions: {
          enabled: suggestions.enabled === undefined ? base.suggestions.enabled : suggestions.enabled === true,
          maxPerDay: Math.min(5, Math.max(0, Number(suggestions.maxPerDay) || base.suggestions.maxPerDay)),
        },
      }
    }

    function normalizeM3Status(value) {
      const source = value && typeof value === 'object' ? (value.status || value) : {}
      const rawRoutines = source.routines || source.items || source.schedules
      const byId = {}
      const items = []
      function normalizeOne(entry, fallbackId) {
        if (!entry || typeof entry !== 'object') return null
        const id = entry.id || entry.routine || entry.key || entry.name || fallbackId
        if (!id) return null
        const normalized = {
          id: id,
          enabled: entry.enabled === undefined ? entry.active !== false : entry.enabled === true,
          nextRun: entry.nextRun || entry.next_run || entry.nextAt || entry.next_at || null,
          lastRun: entry.lastRun || entry.last_run || entry.lastAt || entry.last_at || null,
          healthy: entry.healthy === undefined ? null : entry.healthy === true,
          raw: entry,
        }
        byId[id] = normalized
        items.push(normalized)
        return normalized
      }
      if (Array.isArray(rawRoutines)) rawRoutines.forEach(function each(entry) { normalizeOne(entry) })
      else if (rawRoutines && typeof rawRoutines === 'object') {
        Object.keys(rawRoutines).forEach(function each(key) { normalizeOne(rawRoutines[key], key) })
      }
      const dndInfo = (source.dnd && typeof source.dnd === 'object' ? source.dnd : {}) || {}
      return {
        items: items,
        byId: byId,
        dndActive: source.dndActive === true || dndInfo.active === true || dndInfo.dndActive === true,
        dnd: dndInfo,
        budget: source.budget || (source.budgetState && typeof source.budgetState === 'object' ? source.budgetState : null),
        raw: source,
      }
    }

    function m3LocalMinutes() {
      const now = new Date()
      return now.getHours() * 60 + now.getMinutes()
    }

    function m3IsDndActive(config) {
      const dnd = (config && config.dnd) || defaultAutomationConfig().dnd
      const start = String(dnd.start || '22:45')
      const end = String(dnd.end || '07:30')
      const startMatch = /^(\d{2}):(\d{2})$/.exec(start)
      const endMatch = /^(\d{2}):(\d{2})$/.exec(end)
      if (!startMatch || !endMatch) return false
      const startMinutes = Number(startMatch[1]) * 60 + Number(startMatch[2])
      const endMinutes = Number(endMatch[1]) * 60 + Number(endMatch[2])
      const current = m3LocalMinutes()
      if (startMinutes === endMinutes) return false
      if (startMinutes < endMinutes) return current >= startMinutes && current < endMinutes
      return current >= startMinutes || current < endMinutes
    }

    function createMockM3Store() {
      const now = Date.now()
      return {
        suggestions: [
          { id: 'sug_overdue', type: 'overdue_cleanup', title: '有 3 个任务已逾期', body: '要不要今天先处理掉最急的几件？', origin: 'rule:overdue', createdAt: new Date(now - 3600000).toISOString(), status: 'pending' },
          { id: 'sug_inbox', type: 'inbox_backlog', title: '待整理 5 条记录', body: '我可以在晚上帮你整理这批记录。', origin: 'rule:inbox', createdAt: new Date(now - 7200000).toISOString(), status: 'pending' },
          { id: 'sug_journal', type: 'journal_morning', title: '今天还没写晨记', body: '要不要让 Agent 起个晨记草稿？', origin: 'rule:journal', createdAt: new Date(now - 1800000).toISOString(), status: 'pending' },
        ],
        notifications: [
          { id: 'noti_1', type: 'morning_brief', title: '晨间简报已生成', body: '今天有 3 项重点：…', createdAt: new Date(now - 600000).toISOString(), readAt: null },
          { id: 'noti_2', type: 'deadline', title: '任务「提交周报」1 小时后截止', body: '截止提醒', createdAt: new Date(now - 900000).toISOString(), readAt: null },
          { id: 'noti_3', type: 'suggestion', title: '有新的建议', body: '待整理 5 条记录', createdAt: new Date(now - 1800000).toISOString(), readAt: new Date(now - 1700000).toISOString() },
        ],
        automation: defaultAutomationConfig(),
        status: {
          routines: [
            { id: 'morningBrief', enabled: true, nextRun: new Date(now + 3600000).toISOString(), lastRun: null },
            { id: 'nightlyInbox', enabled: true, nextRun: new Date(now + 7200000).toISOString(), lastRun: new Date(now - 86400000).toISOString() },
          ],
          dndActive: false,
        },
      }
    }

    const mockM3Store = createMockM3Store()

    function createM3Runtime(m0, nav) {
      const initial = {
        phase: 'idle',
        mock: false,
        suggestions: { phase: 'idle', items: [], error: null, busyId: null },
        notifications: { phase: 'idle', items: [], unread: 0, error: null, drawer: false, busyId: null },
        automation: {
          phase: 'idle',
          config: defaultAutomationConfig(),
          status: normalizeM3Status(null),
          error: null,
          saving: false,
          impacted: [],
          lastSavedAt: null,
        },
      }
      let snapshot = initial
      const listeners = new Set()
      let disposed = false

      function getState() {
        return snapshot
      }

      function setState(next) {
        if (disposed || !next || next === snapshot) return
        snapshot = next
        Array.from(listeners).forEach(function notify(listener) {
          try {
            listener()
          } catch (error) {
            console.error('[lifeos] m3 subscriber failed', error)
          }
        })
      }

      function update(patch) {
        setState(Object.assign({}, snapshot, patch || {}))
      }

      function subscribe(listener) {
        listeners.add(listener)
        return function unsubscribe() {
          listeners.delete(listener)
        }
      }

      function normalizeSuggestions(value) {
        const list = value && (value.suggestions || value.items)
        if (!Array.isArray(list)) return []
        return list.filter(function keep(item) {
          return item && item.id && item.status !== 'dismissed' && item.status !== 'accepted'
        }).map(function map(item) {
          return {
            id: item.id,
            type: item.ruleType || item.type || item.goalType || item.kind || 'suggestion',
            title: item.title || '',
            body: item.body || item.summary || '',
            origin: item.origin || item.source || item.ruleType || '',
            createdAt: item.createdAt || item.created_at || item.at || null,
            snoozeUntil: item.snoozeUntil || item.snooze_until || null,
            raw: item,
          }
        })
      }

      function normalizeNotifications(value) {
        const list = value && (value.notifications || value.items)
        const items = Array.isArray(list) ? list.map(function map(item) {
          return {
            id: item.id,
            type: item.type || item.kind || '',
            title: item.title || item.subject || '',
            body: item.body || item.summary || '',
            createdAt: item.createdAt || item.created_at || item.deliveredAt || item.delivered_at || null,
            readAt: item.readAt || item.read_at || null,
            raw: item,
          }
        }) : []
        const unread = value && (value.unreadCount !== undefined ? value.unreadCount : value.unread) !== undefined
          ? Number(value.unreadCount !== undefined ? value.unreadCount : value.unread) || 0
          : items.filter(function count(item) { return !item.readAt }).length
        return { items: items.slice(0, 50), unread: unread }
      }

      function loadSuggestions() {
        update({ suggestions: Object.assign({}, snapshot.suggestions, { phase: snapshot.suggestions.items.length ? 'ready' : 'loading', error: null }) })
        return m3SuggestionsApi()
          .then(function onOk(value) {
            update({ suggestions: { phase: 'ready', items: normalizeSuggestions(value), error: null, busyId: null } })
            return true
          })
          .catch(function onError(error) {
            update({
              suggestions: { phase: 'fallback', items: snapshot.suggestions.items.length ? snapshot.suggestions.items : normalizeSuggestions({ items: mockM3Store.suggestions }), error: errorText(error), busyId: null },
              mock: true,
            })
            return false
          })
      }

      function actSuggestion(id, action, snoozeMinutes) {
        if (snapshot.suggestions.busyId) return Promise.resolve(null)
        update({ suggestions: Object.assign({}, snapshot.suggestions, { busyId: id }) })
        const item = snapshot.suggestions.items.find(function find(entry) { return entry.id === id }) || null
        return m3SuggestionActApi(id, action, snoozeMinutes)
          .then(function onOk() {
            const items = snapshot.suggestions.items.filter(function keep(entry) { return entry.id !== id })
            update({ suggestions: Object.assign({}, snapshot.suggestions, { items: items, busyId: null }) })
            if (action === 'accept') m0.toast('success', '已接受建议')
            else if (action === 'dismiss') m0.toast('success', '已忽略该建议')
            else m0.toast('success', '1 小时后再提醒')
            return { item: item, action: action }
          })
          .catch(function onError(error) {
            update({ suggestions: Object.assign({}, snapshot.suggestions, { busyId: null }) })
            m0.toast('error', '操作建议失败：' + errorText(error))
            return null
          })
      }

      function loadNotifications() {
        update({ notifications: Object.assign({}, snapshot.notifications, { phase: snapshot.notifications.items.length ? 'ready' : 'loading', error: null }) })
        return m3NotificationsApi()
          .then(function onOk(value) {
            const normalized = normalizeNotifications(value)
            update({ notifications: Object.assign({}, snapshot.notifications, { phase: 'ready', items: normalized.items, unread: normalized.unread, error: null }) })
            return normalized
          })
          .catch(function onError(error) {
            const normalized = normalizeNotifications({ items: mockM3Store.notifications })
            update({
              notifications: Object.assign({}, snapshot.notifications, {
                phase: 'fallback',
                items: snapshot.notifications.items.length ? snapshot.notifications.items : normalized.items,
                unread: snapshot.notifications.items.length ? snapshot.notifications.unread : normalized.unread,
                error: errorText(error),
              }),
              mock: true,
            })
            return normalized
          })
      }

      function readNotification(id) {
        const current = snapshot.notifications.items.find(function find(item) { return item.id === id }) || null
        if (!current || current.readAt) {
          update({ notifications: Object.assign({}, snapshot.notifications, { busyId: id }) })
          m3NotificationReadApi(id)
            .then(function done() {
              update({ notifications: Object.assign({}, snapshot.notifications, { busyId: null }) })
            })
            .catch(function onError(error) {
              update({ notifications: Object.assign({}, snapshot.notifications, { busyId: null }) })
              m0.toast('error', '标记已读失败：' + errorText(error))
            })
          return Promise.resolve(current)
        }
        const items = snapshot.notifications.items.map(function map(item) {
          return item.id === id ? Object.assign({}, item, { readAt: nowIso() }) : item
        })
        update({ notifications: Object.assign({}, snapshot.notifications, { items: items, unread: Math.max(0, snapshot.notifications.unread - 1), busyId: id }) })
        return m3NotificationReadApi(id)
          .then(function done() {
            update({ notifications: Object.assign({}, snapshot.notifications, { busyId: null }) })
            return current
          })
          .catch(function onError(error) {
            m0.toast('error', '标记已读失败：' + errorText(error))
            update({ notifications: Object.assign({}, snapshot.notifications, { busyId: null }) })
            return loadNotifications().then(function () { return current })
          })
      }

      function openNotifications() {
        update({ notifications: Object.assign({}, snapshot.notifications, { drawer: true }) })
        loadNotifications()
      }

      function closeNotifications() {
        update({ notifications: Object.assign({}, snapshot.notifications, { drawer: false }) })
      }

      function toggleNotifications() {
        if (snapshot.notifications.drawer) closeNotifications()
        else openNotifications()
      }

      function loadAutomationStatus() {
        return m3AutomationStatusApi()
          .then(function onOk(value) {
            update({ automation: Object.assign({}, snapshot.automation, { status: normalizeM3Status(value) }) })
            return normalizeM3Status(value)
          })
          .catch(function onError() {
            update({ automation: Object.assign({}, snapshot.automation, { status: normalizeM3Status({ routines: mockM3Store.status.routines, dndActive: false }) }) })
            return snapshot.automation.status
          })
      }

      function loadAutomation() {
        update({ automation: Object.assign({}, snapshot.automation, { phase: snapshot.automation.phase === 'idle' ? 'loading' : snapshot.automation.phase, error: null }) })
        return Promise.all([
          m3AutomationApi()
            .then(function onOk(value) {
              const config = normalizeAutomationConfig(value)
              update({ automation: Object.assign({}, snapshot.automation, { phase: 'ready', config: config, error: null }) })
              return true
            })
            .catch(function onError(error) {
              update({
                automation: Object.assign({}, snapshot.automation, { phase: 'fallback', config: snapshot.automation.phase === 'idle' ? normalizeAutomationConfig(mockM3Store.automation) : snapshot.automation.config, error: errorText(error) }),
                mock: true,
              })
              return false
            }),
          loadAutomationStatus(),
        ]).then(function done() {
          return snapshot.automation
        })
      }

      function saveAutomation(config) {
        const normalized = normalizeAutomationConfig(config)
        update({ automation: Object.assign({}, snapshot.automation, { saving: true, error: null }) })
        return m3AutomationPutApi(normalized)
          .then(function onOk(value) {
            const merged = normalizeAutomationConfig(
              value && (value.settings || value.automation || value.config)
                ? (value.settings || value.automation || value.config)
                : normalized,
            )
            const impacted = (value && (value.impacted || value.impactedSchedules)) || []
            update({ automation: Object.assign({}, snapshot.automation, { saving: false, config: merged, impacted: Array.isArray(impacted) ? impacted : [], lastSavedAt: nowIso(), error: null }) })
            m0.toast('success', '自动化设置已保存' + (impacted && impacted.length ? ' · 影响 ' + impacted.length + ' 项' : ''))
            return loadAutomationStatus().then(function () {
              return { config: merged, impacted: impacted }
            })
          })
          .catch(function onError(error) {
            update({ automation: Object.assign({}, snapshot.automation, { saving: false, error: errorText(error) }) })
            m0.toast('error', '自动化设置保存失败：' + errorText(error))
            return null
          })
      }

      function dndActive() {
        const state = snapshot.automation.status
        if (state && state.dndActive === true) return true
        return m3IsDndActive(snapshot.automation.config)
      }

      function refreshAll() {
        return Promise.all([loadSuggestions(), loadNotifications(), loadAutomation()])
      }

      function onExternalChange(reason, payload) {
        if (reason === 'changed' && payload && typeof payload.kind === 'string') {
          if (payload.kind === 'suggestion' || payload.kind === 'notification') reason = payload.kind
          else if (payload.kind === 'automation' || payload.kind === 'automation/changed') reason = 'automation/changed'
        }
        if (reason === 'automation/changed') {
          loadAutomation()
          return
        }
        if (reason === 'suggestion') {
          loadSuggestions()
          const item = payload && (payload.suggestion || payload)
          if (item && item.title && !dndActive()) m0.toast('success', '新建议：' + item.title)
          return
        }
        if (reason === 'notification') {
          const before = snapshot.notifications.unread
          loadNotifications().then(function after(loaded) {
            const current = loaded || snapshot.notifications
            if (current.unread > before && !dndActive()) {
              const latest = current.items.find(function find(item) { return !item.readAt }) || null
              if (latest && latest.title) m0.toast('success', '新通知：' + latest.title)
            }
          })
        }
      }

      function init() {
        update({ phase: 'loading' })
        return Promise.all([loadSuggestions(), loadNotifications(), loadAutomation()]).then(function done() {
          update({ phase: 'ready' })
          try {
            reportClient({ phase: 'm3-client-init', at: nowIso(), suggestions: snapshot.suggestions.items.length, unread: snapshot.notifications.unread, mock: snapshot.mock })
          } catch (error) {
            /* ignore */
          }
        })
      }

      function dispose() {
        disposed = true
        listeners.clear()
      }

      return {
        getState: getState,
        subscribe: subscribe,
        init: init,
        refreshAll: refreshAll,
        loadSuggestions: loadSuggestions,
        actSuggestion: actSuggestion,
        loadNotifications: loadNotifications,
        readNotification: readNotification,
        openNotifications: openNotifications,
        closeNotifications: closeNotifications,
        toggleNotifications: toggleNotifications,
        loadAutomation: loadAutomation,
        saveAutomation: saveAutomation,
        loadAutomationStatus: loadAutomationStatus,
        dndActive: dndActive,
        onExternalChange: onExternalChange,
        dispose: dispose,
      }
    }

    const m3 = createM3Runtime(runtime, navigation)

    /* ═════════════════════════ M4：习惯 / 项目 / 目标 / 愿望 数据层 + 运行时 ═════════════════════════ */

    const M4_DAY_LABEL = { MO: '周一', TU: '周二', WE: '周三', TH: '周四', FR: '周五', SA: '周六', SU: '周日' }
    const M4_DAY_ORDER = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
    const M4_WEEKDAY_CODE = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
    const M4_HABIT_STATUS = { active: '进行中', paused: '已暂停', archived: '已归档' }
    const M4_PROJECT_STATUS = { active: '进行中', paused: '已暂停', completed: '已完成', cancelled: '已取消', archived: '已归档' }
    const M4_PROJECT_FILTERS = [
      { id: 'active', label: '进行中' },
      { id: 'all', label: '全部' },
      { id: 'paused', label: '已暂停' },
      { id: 'completed', label: '已完成' },
      { id: 'archived', label: '已归档' },
    ]
    const M4_UNITS = ['次', '分钟', '页', '步', '公里', '小时']
    const M4_UNIT_METRIC = { 次: 'count', 分钟: 'minutes', 页: 'pages', 步: 'steps', 公里: 'km', 小时: 'hours' }
    const M4_METRIC_LABEL = { count: '次', minutes: '分钟', pages: '页', steps: '步', km: '公里', hours: '小时' }

    function m4Field(source, camel, snake) {
      if (!source || typeof source !== 'object') return undefined
      if (source[camel] !== undefined && source[camel] !== null) return source[camel]
      if (snake && source[snake] !== undefined && source[snake] !== null) return source[snake]
      return undefined
    }

    function m4QueryString(query) {
      const parts = []
      Object.keys(query || {}).forEach(function each(key) {
        const value = query[key]
        if (value === undefined || value === null || value === '') return
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
      })
      return parts.length ? '?' + parts.join('&') : ''
    }

    function m4Get(path, query) {
      return apiRequest(path + m4QueryString(query))
    }

    function m4Send(method, path, body) {
      const init = { method: method, headers: { accept: 'application/json' } }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      return apiRequest(path, init)
    }

    function m4ListHabits(query) {
      return m4Get('/habits', query || {})
    }

    const M4_BODY_KEY_MAP = {
      frequencyRule: 'frequency_rule',
      periodRule: 'period_rule',
      targetJson: 'target_json',
      checkinMode: 'checkin_mode',
      startDate: 'start_date',
      endDate: 'end_date',
      timeHint: 'time_hint',
      sortOrder: 'sort_order',
      targetDate: 'target_date',
      progressMode: 'progress_mode',
      progressPct: 'progress_pct',
      successCriteria: 'success_criteria',
      reviewAt: 'review_at',
      abandonedReason: 'abandoned_reason',
    }

    function m4Body(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return input
      const out = {}
      Object.keys(input).forEach(function each(key) {
        const value = input[key]
        if (value === undefined) return
        out[M4_BODY_KEY_MAP[key] || key] = value
      })
      return out
    }

    function m4CreateHabit(body) {
      return m4Send('POST', '/habits', m4Body(body))
    }

    function m4GetHabit(habitId) {
      return m4Get('/habits/' + encodeURIComponent(habitId))
    }

    function m4PatchHabit(habitId, patch, expectedRev) {
      return m4Send('PATCH', '/habits/' + encodeURIComponent(habitId), { patch: m4Body(patch), expectedRev: expectedRev })
    }

    function m4ArchiveHabit(habitId, expectedRev) {
      return m4Send('POST', '/habits/' + encodeURIComponent(habitId) + '/archive', { expectedRev: expectedRev })
    }

    function m4CheckinHabit(habitId, body) {
      return m4Send('POST', '/habits/' + encodeURIComponent(habitId) + '/checkin', body)
    }

    function m4DeleteCheckin(habitId, dateKey, expectedRev) {
      const query = expectedRev !== undefined && expectedRev !== null
        ? '?expectedRev=' + encodeURIComponent(String(expectedRev))
        : ''
      return apiRequest('/habits/' + encodeURIComponent(habitId) + '/checkins/' + encodeURIComponent(dateKey) + query, {
        method: 'DELETE',
        headers: { accept: 'application/json' },
      })
    }

    function m4HabitCheckins(habitId, query) {
      return m4Get('/habits/' + encodeURIComponent(habitId) + '/checkins', query || {})
    }

    function m4HabitStats(query) {
      return m4Get('/habits/stats', query || {})
    }

    function m4HabitMonth(month) {
      return m4Get('/habits/month', { month: month })
    }

    function m4ListProjects(query) {
      return m4Get('/projects', query || {})
    }

    function m4CreateProject(body) {
      return m4Send('POST', '/projects', m4Body(body))
    }

    function m4GetProject(projectId) {
      return m4Get('/projects/' + encodeURIComponent(projectId))
    }

    function m4PatchProject(projectId, patch, expectedRev) {
      return m4Send('PATCH', '/projects/' + encodeURIComponent(projectId), { patch: m4Body(patch), expectedRev: expectedRev })
    }

    function m4ArchiveProject(projectId, expectedRev) {
      return m4Send('POST', '/projects/' + encodeURIComponent(projectId) + '/archive', { expectedRev: expectedRev })
    }

    function m4ListGoals(query) {
      return m4Get('/goals', query || {})
    }

    function m4CreateGoal(body) {
      return m4Send('POST', '/goals', m4Body(body))
    }

    function m4GetGoal(goalId) {
      return m4Get('/goals/' + encodeURIComponent(goalId))
    }

    function m4PatchGoal(goalId, patch, expectedRev) {
      return m4Send('PATCH', '/goals/' + encodeURIComponent(goalId), { patch: m4Body(patch), expectedRev: expectedRev })
    }

    function m4ListWishes(query) {
      return m4Get('/wishes', query || {})
    }

    function m4CreateWish(body) {
      return m4Send('POST', '/wishes', m4Body(body))
    }

    function m4PatchWish(wishId, patch, expectedRev) {
      return m4Send('PATCH', '/wishes/' + encodeURIComponent(wishId), { patch: m4Body(patch), expectedRev: expectedRev })
    }

    function m4ConvertWish(wishId, body) {
      return m4Send('POST', '/wishes/' + encodeURIComponent(wishId) + '/convert', body)
    }

    function m4ReviewSummary(period, anchor) {
      return m4Get('/review/summary', { period: period, anchor: anchor })
    }

    function m4ArrayValue(value) {
      if (Array.isArray(value)) return value
      if (value && typeof value === 'object' && Array.isArray(value.items)) return value.items
      return []
    }

    function m4NormalizeHabitFrequencyText(rule, periodRule) {
      const safeRule = rule && typeof rule === 'object' ? rule : {}
      let text = ''
      if (safeRule.kind === 'daily') {
        const interval = Number(safeRule.interval) || 1
        text = interval > 1 ? '每 ' + interval + ' 天' : '每天'
      } else if (safeRule.kind === 'weekly_days') {
        const days = Array.isArray(safeRule.days) ? safeRule.days : []
        text = days.length
          ? '每周' + days.map(function dayText(code) {
              return (M4_DAY_LABEL[code] || code).replace('周', '')
            }).join('、')
          : '每周固定日'
      } else if (safeRule.kind === 'weekly_count') {
        text = '每周 ' + (Number(safeRule.count) || 1) + ' 次'
      } else if (safeRule.kind === 'interval') {
        text = '每 ' + (Number(safeRule.days) || 1) + ' 天'
      } else if (safeRule.kind) {
        text = String(safeRule.kind)
      } else {
        text = ''
      }
      const period = periodRule && typeof periodRule === 'object' ? periodRule : null
      const targetCount = period ? Number(m4Field(period, 'targetCount', 'target_count')) || 0 : 0
      if (targetCount > 0) {
        text += ' · 周期目标 ' + targetCount + ' 次/' + (period.period === 'month' ? '月' : '周')
      } else if (safeRule.kind === 'weekly_count') {
        text += ' · 周期目标 ' + (Number(safeRule.count) || 1) + ' 次/周'
      }
      return text
    }

    function m4NormalizeHabitTargetText(targetJson) {
      if (!targetJson || typeof targetJson !== 'object') return ''
      const metric = String(targetJson.metric || targetJson.kind || '')
      const value = Number(targetJson.value !== undefined ? targetJson.value : targetJson.target)
      if (!Number.isFinite(value) || value <= 0) return ''
      const unit = targetJson.unit || M4_METRIC_LABEL[metric] || ''
      return String(value) + (unit ? ' ' + unit : '')
    }

    function m4NormalizeHabit(raw) {
      const habit = raw && typeof raw === 'object' ? raw : {}
      const frequencyRule = m4Field(habit, 'frequencyRule', 'frequency_rule') || {}
      const periodRule = m4Field(habit, 'periodRule', 'period_rule') || null
      const targetJson = m4Field(habit, 'targetJson', 'target_json') || null
      const status = String(habit.status || 'active')
      const todayStatus = m4Field(habit, 'todayStatus', 'today_status')
      return {
        id: String(habit.id || ''),
        name: String(habit.name || habit.title || ''),
        description: String(habit.description || ''),
        status: status,
        frequencyRule: frequencyRule,
        periodRule: periodRule,
        targetJson: targetJson,
        checkinMode: m4Field(habit, 'checkinMode', 'checkin_mode') || 'either',
        startDate: m4Field(habit, 'startDate', 'start_date') || '',
        endDate: m4Field(habit, 'endDate', 'end_date') || '',
        rev: Number(habit.rev) || 1,
        pausedAt: m4Field(habit, 'pausedAt', 'paused_at') || null,
        archivedAt: m4Field(habit, 'archivedAt', 'archived_at') || null,
        frequencyText: m4Field(habit, 'frequencyText', 'frequency_text') || m4NormalizeHabitFrequencyText(frequencyRule, periodRule),
        targetText: m4NormalizeHabitTargetText(targetJson),
        todayStatus: todayStatus === undefined || todayStatus === null ? null : String(todayStatus),
        todayCheckinId: m4Field(habit, 'todayCheckinId', 'today_checkin_id') || null,
      }
    }

    function m4NormalizeHabitList(value) {
      return m4ArrayValue(value).map(m4NormalizeHabit)
    }

    function m4NormalizeTodayList(rawToday, items) {
      const list = []
      const byId = {}
      items.forEach(function index(habit) {
        if (habit.id) byId[habit.id] = habit
      })
      if (Array.isArray(rawToday)) {
        rawToday.forEach(function each(entry) {
          if (entry === null || entry === undefined) return
          if (typeof entry === 'string') {
            if (byId[entry]) list.push(byId[entry])
            return
          }
          if (typeof entry === 'object') {
            const habitRaw = entry.habit && typeof entry.habit === 'object' ? entry.habit : entry
            const habit = m4NormalizeHabit(habitRaw)
            if (!habit.id && entry.habitId) habit.id = String(entry.habitId)
            if (!habit.id && entry.habit_id) habit.id = String(entry.habit_id)
            if (habit.id) list.push(habit)
          }
        })
      } else if (rawToday && typeof rawToday === 'object') {
        Object.keys(rawToday).forEach(function each(key) {
          if (byId[key]) list.push(byId[key])
        })
      }
      if (!list.length) {
        items.forEach(function derive(habit) {
          if (!habit || habit.status !== 'active') return
          const status = habit.todayStatus
          if (status === 'pending' || status === 'done' || status === 'partial' || status === 'skipped' || status === 'not_done') {
            list.push(habit)
          }
        })
      }
      return list
    }

    function m4HabitPlanDay(habit, dateKey) {
      if (!habit || habit.status !== 'active') return false
      const rule = habit.frequencyRule && typeof habit.frequencyRule === 'object' ? habit.frequencyRule : {}
      const start = habit.startDate || dateKey
      if (dateKey < start) return false
      if (rule.kind === 'daily') {
        const interval = Math.max(1, Number(rule.interval) || 1)
        if (interval <= 1) return true
        const startDate = parseDateKey(start)
        const target = parseDateKey(dateKey)
        if (!startDate || !target) return true
        const diff = Math.round((target.getTime() - startDate.getTime()) / 86400000)
        return diff >= 0 && diff % interval === 0
      }
      if (rule.kind === 'weekly_days') {
        const target = parseDateKey(dateKey)
        if (!target) return true
        const code = M4_WEEKDAY_CODE[target.getDay()]
        return (Array.isArray(rule.days) ? rule.days : []).indexOf(code) >= 0
      }
      if (rule.kind === 'interval') {
        const days = Math.max(1, Number(rule.days) || 1)
        const anchor = rule.anchor_date || rule.anchorDate || start
        const anchorDate = parseDateKey(anchor)
        const target = parseDateKey(dateKey)
        if (!anchorDate || !target) return true
        const diff = Math.round((target.getTime() - anchorDate.getTime()) / 86400000)
        return diff >= 0 && diff % days === 0
      }
      return false
    }

    function m4CheckinState(status) {
      const text = String(status || '')
      if (text === 'done' || text === 'completed') return 'done'
      if (text === 'partial') return 'partial'
      if (text === 'skipped' || text === 'not_done' || text === 'missed') return 'skipped'
      if (text === 'paused') return 'paused'
      return 'missing'
    }

    function m4CellState(cell) {
      if (cell === null || cell === undefined) return 'missing'
      if (typeof cell === 'string') return m4CheckinState(cell)
      if (cell === true) return 'done'
      if (cell === false) return 'skipped'
      if (typeof cell === 'object') {
        if (cell.paused === true) return 'paused'
        const status = cell.status || cell.state || cell.kind
        if (status) return m4CheckinState(status)
        if (cell.value !== undefined && cell.value !== null) return 'done'
      }
      return 'missing'
    }

    function m4CheckinStateText(cellState) {
      if (cellState === 'done') return '●'
      if (cellState === 'partial') return '◐'
      if (cellState === 'skipped') return '○'
      if (cellState === 'paused') return '▨'
      return ''
    }

    function m4CheckinStateColor(cellState) {
      if (cellState === 'done') return COLORS.success
      if (cellState === 'partial') return COLORS.warn
      if (cellState === 'skipped') return COLORS.labelTertiary
      if (cellState === 'paused') return COLORS.labelTertiary
      return COLORS.labelTertiary
    }

    function m4MonthDayKeys(month) {
      const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''))
      const base = match ? new Date(Number(match[1]), Number(match[2]) - 1, 1) : new Date()
      const days = []
      const total = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate()
      for (let day = 1; day <= total; day += 1) {
        days.push(dateKeyOf(new Date(base.getFullYear(), base.getMonth(), day)))
      }
      return days
    }

    function m4NormalizeMonth(raw, month) {
      const matrix = raw && typeof raw === 'object' ? raw : {}
      const months = String(matrix.month || month || '')
      const days = Array.isArray(matrix.days) && matrix.days.length
        ? matrix.days.map(function dayKey(day) {
            if (typeof day === 'string') return day
            if (day && typeof day === 'object') return day.date || day.localDate || day.local_date || day.key || ''
            return ''
          }).filter(Boolean)
        : m4MonthDayKeys(months)
      const rowsRaw = Array.isArray(matrix.rows)
        ? matrix.rows
        : Array.isArray(matrix.habits)
          ? matrix.habits
          : Array.isArray(matrix.items)
            ? matrix.items
            : []
      const rows = rowsRaw.map(function rowMap(rowRaw, index) {
        const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {}
        const habitRaw = row.habit && typeof row.habit === 'object' ? row.habit : row
        const habit = m4NormalizeHabit(habitRaw)
        const cells = {}
        const source = row.cells || row.days || row.values || row.matrix || row.checkins
        if (Array.isArray(source)) {
          source.forEach(function cellEach(cell, cellIndex) {
            if (cell && typeof cell === 'object') {
              const key = cell.date || cell.localDate || cell.local_date || cell.key || days[cellIndex] || ''
              if (key) cells[key] = m4CellState(cell)
            } else if (typeof cell === 'string') {
              const key = days[cellIndex]
              if (key) cells[key] = m4CellState(cell)
            }
          })
        } else if (source && typeof source === 'object') {
          Object.keys(source).forEach(function cellKey(key) {
            cells[key] = m4CellState(source[key])
          })
        }
        return {
          key: String(habit.id || row.id || index),
          habitId: habit.id,
          name: habit.name || String(row.name || ''),
          status: habit.status,
          targetJson: habit.targetJson,
          cells: cells,
        }
      })
      return { month: months, days: days, rows: rows }
    }

    function m4NormalizeCheckin(raw) {
      const checkin = raw && typeof raw === 'object' ? raw : {}
      const kind = m4Field(checkin, 'checkinKind', 'checkin_kind') || ''
      return {
        id: String(checkin.id || ''),
        localDate: m4Field(checkin, 'localDate', 'local_date') || '',
        status: String(checkin.status || 'done'),
        value: checkin.value !== undefined ? checkin.value : checkin.value_json,
        note: String(checkin.note || ''),
        retro: checkin.retro === true || kind === 'retro',
        rev: Number(checkin.rev) || 1,
      }
    }

    function m4CheckinValueText(value) {
      if (value === undefined || value === null || value === '') return ''
      if (typeof value === 'number') return String(value)
      if (typeof value === 'string') return value
      if (typeof value === 'object') {
        const parts = []
        Object.keys(value).forEach(function each(key) {
          const item = value[key]
          if (item === undefined || item === null || item === '') return
          parts.push(String(item) + (M4_METRIC_LABEL[key] ? ' ' + M4_METRIC_LABEL[key] : ''))
        })
        return parts.join(' · ')
      }
      return String(value)
    }

    function m4NormalizeStatsItem(raw) {
      const item = raw && typeof raw === 'object' ? raw : {}
      const streakRaw = item.streak && typeof item.streak === 'object' ? item.streak : {}
      const coverageRaw = item.coverage && typeof item.coverage === 'object' ? item.coverage : {}
      const periodRaw = item.period && typeof item.period === 'object' ? item.period : {}
      let todayStatus = null
      if (item.today && typeof item.today === 'object' && !Array.isArray(item.today)) {
        if (item.today.status) todayStatus = String(item.today.status)
        else if (item.today.checkin && item.today.checkin.status) todayStatus = String(item.today.checkin.status)
      } else if (typeof item.today === 'string' && ['done', 'partial', 'skipped', 'not_done'].indexOf(item.today) >= 0) {
        todayStatus = item.today
      }
      if (!todayStatus) {
        const fallback = m4Field(item, 'todayStatus', 'today_status')
        if (fallback !== undefined && fallback !== null) todayStatus = String(fallback)
      }
      return {
        habitId: String(m4Field(item, 'habitId', 'habit_id') || item.id || ''),
        name: String(item.name || ''),
        frequencyText: m4Field(item, 'frequencyText', 'frequency_text') || '',
        streak: {
          mode: String(streakRaw.mode || 'strict'),
          unit: String(streakRaw.unit || 'day'),
          value: Number(streakRaw.value) || 0,
          longest: Number(streakRaw.longest) || 0,
        },
        coverage: {
          recorded: Number(coverageRaw.recorded) || 0,
          expected: Number(coverageRaw.expected) || 0,
          ratio: Number(coverageRaw.ratio) || 0,
          windowDays: Number(m4Field(coverageRaw, 'windowDays', 'window_days')) || 14,
        },
        period: {
          key: String(periodRaw.key || ''),
          target: Number(periodRaw.target) || 0,
          achieved: Number(periodRaw.achieved) || 0,
          met: periodRaw.met === true,
        },
        todayStatus: todayStatus,
        todayCheckinId: m4Field(item, 'todayCheckinId', 'today_checkin_id') || null,
      }
    }

    function m4NormalizeProgress(raw, fallbackMode) {
      if (!raw || typeof raw !== 'object') return null
      const mode = String(raw.mode || fallbackMode || 'auto_by_tasks')
      const done = Number(raw.done) || 0
      const total = Number(raw.total) || 0
      const pctRaw = raw.pct !== undefined ? raw.pct : raw.progressPct
      return {
        mode: mode,
        done: done,
        total: total,
        pct: Number(pctRaw) || 0,
        label: String(raw.label || '根据任务计算'),
      }
    }

    function m4NormalizeProject(raw) {
      const project = raw && typeof raw === 'object' ? raw : {}
      const mode = m4Field(project, 'progressMode', 'progress_mode') || 'auto_by_tasks'
      const progressRaw = m4Field(project, 'progress')
      return {
        id: String(project.id || ''),
        name: String(project.name || ''),
        description: String(project.description || ''),
        color: String(project.color || ''),
        status: String(project.status || 'active'),
        startDate: m4Field(project, 'startDate', 'start_date') || '',
        targetDate: m4Field(project, 'targetDate', 'target_date') || '',
        progressMode: mode,
        progressPct: Number(m4Field(project, 'progressPct', 'progress_pct')) || 0,
        progress: m4NormalizeProgress(progressRaw, mode),
        hasTasks: project.has_tasks !== undefined ? project.has_tasks === true : project.hasTasks === true,
        rev: Number(project.rev) || 1,
        createdAt: m4Field(project, 'createdAt', 'created_at') || '',
        updatedAt: m4Field(project, 'updatedAt', 'updated_at') || '',
        archivedAt: m4Field(project, 'archivedAt', 'archived_at') || null,
        recentActivityAt: m4Field(project, 'recentActivityAt', 'recent_activity_at') || null,
      }
    }

    function m4NormalizeProjectList(value) {
      return m4ArrayValue(value).map(m4NormalizeProject)
    }

    function m4NormalizeGoal(raw) {
      const goal = raw && typeof raw === 'object' ? raw : {}
      const mode = m4Field(goal, 'progressMode', 'progress_mode') || 'manual'
      return {
        id: String(goal.id || ''),
        title: String(goal.title || ''),
        description: String(goal.description || ''),
        status: String(goal.status || 'active'),
        horizon: String(goal.horizon || 'mid'),
        progressMode: mode,
        progressPct: Number(m4Field(goal, 'progressPct', 'progress_pct')) || 0,
        progress: m4NormalizeProgress(m4Field(goal, 'progress'), mode),
        rev: Number(goal.rev) || 1,
      }
    }

    function m4NormalizeWish(raw) {
      const wish = raw && typeof raw === 'object' ? raw : {}
      return {
        id: String(wish.id || ''),
        title: String(wish.title || ''),
        description: String(wish.description || ''),
        status: String(wish.status || 'captured'),
        convertedToGoalId: m4Field(wish, 'convertedToGoalId', 'converted_to_goal_id') || null,
        convertedAt: m4Field(wish, 'convertedAt', 'converted_at') || null,
        reviewAt: m4Field(wish, 'reviewAt', 'review_at') || null,
        rev: Number(wish.rev) || 1,
      }
    }

    function m4NormalizeReview(raw) {
      const summary = raw && typeof raw === 'object' ? raw : {}
      const cardsRaw = summary.cards && typeof summary.cards === 'object' ? summary.cards : {}
      const rangeRaw = summary.range && typeof summary.range === 'object' ? summary.range : {}
      const habitsRaw = Array.isArray(summary.habits) ? summary.habits : []
      const projectsRaw = Array.isArray(summary.projects) ? summary.projects : []
      return {
        period: String(summary.period || 'week'),
        anchor: String(summary.anchor || ''),
        range: {
          start: String(rangeRaw.start || ''),
          end: String(rangeRaw.end || ''),
          label: String(rangeRaw.label || ''),
        },
        cards: {
          completed: Number(cardsRaw.completed) || 0,
          created: Number(cardsRaw.created) || 0,
          open: Number(cardsRaw.open) || 0,
          overdue: Number(cardsRaw.overdue) || 0,
          habitsMet: Number(m4Field(cardsRaw, 'habitsMet', 'habits_met')) || 0,
          habitsTracked: Number(m4Field(cardsRaw, 'habitsTracked', 'habits_tracked')) || 0,
          inboxPending: Number(m4Field(cardsRaw, 'inboxPending', 'inbox_pending')) || 0,
          inboxToConfirm: Number(m4Field(cardsRaw, 'inboxToConfirm', 'inbox_to_confirm')) || 0,
        },
        habits: habitsRaw.map(function habitMap(item) {
          const row = item && typeof item === 'object' ? item : {}
          const coverage = row.coverage && typeof row.coverage === 'object' ? row.coverage : {}
          return {
            habitId: String(m4Field(row, 'habitId', 'habit_id') || row.id || ''),
            name: String(row.name || ''),
            target: Number(row.target) || 0,
            achieved: Number(row.achieved) || 0,
            met: row.met === true,
            coverage: { recorded: Number(coverage.recorded) || 0, expected: Number(coverage.expected) || 0 },
          }
        }),
        projects: projectsRaw.map(function projectMap(item) {
          const row = item && typeof item === 'object' ? item : {}
          return {
            id: String(row.id || ''),
            name: String(row.name || ''),
            done: Number(row.done) || 0,
            total: Number(row.total) || 0,
          }
        }),
      }
    }

    function m4FormatDateShort(dateKey) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''))
      return match ? Number(match[2]) + '月' + Number(match[3]) + '日' : String(dateKey || '')
    }

    function m4RelativeTime(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const diff = Date.now() - date.getTime()
      if (diff < 60 * 1000) return '刚刚'
      if (diff < 60 * 60 * 1000) return Math.max(1, Math.floor(diff / 60000)) + ' 分钟前'
      if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前'
      if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前'
      return localDatePart(value)
    }

    function m4ProjectProgressText(project) {
      const progress = project && project.progress ? project.progress : null
      const total = progress ? Number(progress.total) || 0 : 0
      if (!progress || total <= 0) return TEXT.projectProgressNone
      return TEXT.projectProgressPrefix + (Number(progress.done) || 0) + '/' + total + TEXT.projectProgressSuffix
    }

    function m4StatsIndex(m4State) {
      const map = {}
      const data = m4State && m4State.stats ? m4State.stats.data : null
      if (data && Array.isArray(data.habits)) {
        data.habits.forEach(function each(item) {
          if (item && item.habitId) map[item.habitId] = item
        })
      }
      return map
    }

    function m4HabitStreakText(stats, habit) {
      const value = stats && stats.streak ? Number(stats.streak.value) || 0 : 0
      if (value > 0) return TEXT.habitStreakPrefix + value + TEXT.habitStreakSuffix
      const status = (stats && stats.todayStatus) || (habit && habit.todayStatus) || null
      if (status === 'done' || status === 'partial') return TEXT.habitCheckedToday
      return TEXT.habitNotRecorded
    }

    function m4HabitCoverageText(stats) {
      if (!stats || !stats.coverage) return ''
      const expected = Number(stats.coverage.expected) || 0
      if (!expected) return ''
      return TEXT.habitCoveragePrefix + (Number(stats.coverage.recorded) || 0) + '/' + expected + TEXT.habitCoverageSuffix
    }

    function m4TodayPendingCount(m4State) {
      if (!m4State || !m4State.habits || m4State.habits.phase === 'idle') return null
      const today = Array.isArray(m4State.habits.today) ? m4State.habits.today : []
      let pending = 0
      today.forEach(function each(habit) {
        const status = habit ? habit.todayStatus : null
        if (status === 'pending') pending += 1
      })
      return pending
    }

    function m4ActiveProjectCount(m4State) {
      if (!m4State || !m4State.projects || m4State.projects.phase === 'idle') return null
      const items = Array.isArray(m4State.projects.items) ? m4State.projects.items : []
      let count = 0
      items.forEach(function each(project) {
        if (project && project.status === 'active') count += 1
      })
      return count
    }

    function createM4Runtime(m0, boardRef) {
      const initial = {
        habits: { phase: 'idle', items: [], today: [], error: null, at: null },
        stats: { phase: 'idle', data: null, error: null, at: null },
        month: { phase: 'idle', month: monthKeyOf(todayIso()), data: null, error: null },
        detail: { open: false, id: null, phase: 'idle', data: null, error: null, rev: null },
        createHabit: { open: false, busy: false, error: null },
        busyId: null,
        projects: { phase: 'idle', items: [], filter: 'active', error: null, at: null },
        projectDetail: { open: false, id: null, phase: 'idle', data: null, error: null, rev: null, creating: false },
        goals: { phase: 'idle', items: [], error: null },
        wishes: { phase: 'idle', items: [], error: null },
        review: { phase: 'idle', period: 'week', anchor: todayIso(), data: null, error: null },
      }
      let snapshot = initial
      let disposed = false
      const timers = new Set()
      const listeners = new Set()

      function schedule(fn, delay) {
        const id = setTimeout(function run() {
          timers.delete(id)
          if (!disposed) fn()
        }, delay)
        timers.add(id)
        return id
      }

      function getState() {
        return snapshot
      }

      function setState(patch) {
        snapshot = Object.assign({}, snapshot, patch)
        listeners.forEach(function notify(listener) {
          try {
            listener()
          } catch (error) {
            /* ignore */
          }
        })
      }

      function subscribe(listener) {
        listeners.add(listener)
        return function unsubscribe() {
          listeners.delete(listener)
        }
      }

      function projectQueryFor(filter) {
        if (filter === 'active') return { status: 'active' }
        if (filter === 'paused') return { status: 'paused' }
        if (filter === 'completed') return { status: 'completed' }
        if (filter === 'archived') return { status: 'archived', includeArchived: true }
        return { includeArchived: true }
      }

      function loadHabits() {
        setState({ habits: Object.assign({}, snapshot.habits, { phase: 'loading', error: null }) })
        return m4ListHabits({}).then(function done(value) {
          if (disposed) return null
          const items = m4NormalizeHabitList(value)
          const today = m4NormalizeTodayList(value && typeof value === 'object' ? value.today : null, items)
          setState({ habits: { phase: 'ready', items: items, today: today, error: null, at: new Date().toISOString() } })
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          setState({ habits: Object.assign({}, snapshot.habits, { phase: 'fallback', error: errorText(error), at: new Date().toISOString() }) })
          return null
        })
      }

      function loadStats() {
        setState({ stats: Object.assign({}, snapshot.stats, { phase: 'loading', error: null }) })
        const to = todayIso()
        const from = addDaysKey(to, -13)
        return m4HabitStats({ from: from, to: to }).then(function done(value) {
          if (disposed) return null
          const raw = value && typeof value === 'object' ? value : {}
          const habitsRaw = Array.isArray(raw.habits) ? raw.habits : Array.isArray(raw.items) ? raw.items : []
          const data = {
            range: raw.range && typeof raw.range === 'object' ? raw.range : { from: from, to: to },
            today: raw.today || null,
            habits: habitsRaw.map(m4NormalizeStatsItem),
          }
          setState({ stats: { phase: 'ready', data: data, error: null, at: new Date().toISOString() } })
          return data
        }).catch(function failed(error) {
          if (disposed) return null
          setState({ stats: Object.assign({}, snapshot.stats, { phase: 'fallback', error: errorText(error) }) })
          return null
        })
      }

      function loadMonth(month) {
        const target = month || snapshot.month.month || monthKeyOf(todayIso())
        setState({ month: Object.assign({}, snapshot.month, { month: target, phase: 'loading', error: null }) })
        return m4HabitMonth(target).then(function done(value) {
          if (disposed) return null
          setState({ month: { phase: 'ready', month: target, data: m4NormalizeMonth(value, target), error: null } })
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          setState({ month: Object.assign({}, snapshot.month, { phase: 'fallback', error: errorText(error) }) })
          return null
        })
      }

      function shiftHabitMonth(delta) {
        return loadMonth(shiftMonthKey(snapshot.month.month, delta))
      }

      function refreshAfterHabitWrite(localDate) {
        const jobs = []
        if (!localDate || localDate === todayIso()) {
          jobs.push(loadHabits())
          jobs.push(loadStats())
        }
        jobs.push(loadMonth(snapshot.month.month))
        if (snapshot.detail.open && snapshot.detail.id) jobs.push(openHabit(snapshot.detail.id))
        return Promise.all(jobs)
      }

      function checkinHabit(habit, options) {
        const opts = options || {}
        const habitId = habit && (habit.id || habit.habitId)
        if (!habitId) return Promise.resolve(null)
        const localDate = opts.localDate || todayIso()
        const body = { localDate: localDate, status: opts.status || 'done' }
        if (opts.value !== undefined && opts.value !== null && opts.value !== '') body.value = opts.value
        if (opts.note) body.note = opts.note
        if (opts.retro === true) body.retro = true
        setState({ busyId: habitId })
        return m4CheckinHabit(habitId, body).then(function done(value) {
          if (disposed) return null
          setState({ busyId: null })
          const label = opts.retro === true ? '已补记' : '已打卡'
          m0.toast('success', label + (habit && habit.name ? '：' + habit.name : ''))
          refreshAfterHabitWrite(localDate)
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          setState({ busyId: null })
          m0.toast('error', TEXT.saveFailed + '：' + errorText(error))
          return null
        })
      }

      function uncheckHabit(habit, dateKey, expectedRev) {
        const habitId = habit && (habit.id || habit.habitId)
        if (!habitId || !dateKey) return Promise.resolve(null)
        const rev = expectedRev !== undefined && expectedRev !== null ? expectedRev : habit.rev
        return m4DeleteCheckin(habitId, dateKey, rev).then(function done(value) {
          if (disposed) return null
          m0.toast('success', '已撤销打卡' + (habit && habit.name ? '：' + habit.name : ''))
          refreshAfterHabitWrite(dateKey)
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          m0.toast('error', TEXT.saveFailed + '：' + errorText(error))
          return null
        })
      }

      function openHabit(habitId) {
        const keep = snapshot.detail.id === habitId ? snapshot.detail.data : null
        setState({
          detail: {
            open: true,
            id: habitId,
            phase: 'loading',
            data: keep,
            error: null,
            rev: snapshot.detail.id === habitId ? snapshot.detail.rev : null,
          },
        })
        return m4GetHabit(habitId).then(function done(value) {
          if (disposed || !snapshot.detail.open || snapshot.detail.id !== habitId) return null
          const raw = value && typeof value === 'object' ? value : {}
          const habit = m4NormalizeHabit(raw.habit && typeof raw.habit === 'object' ? raw.habit : raw)
          const checkinsRaw = Array.isArray(raw.checkins) ? raw.checkins : []
          const data = { habit: habit, checkins: checkinsRaw.map(m4NormalizeCheckin) }
          setState({ detail: { open: true, id: habitId, phase: 'ready', data: data, error: null, rev: habit.rev } })
          return data
        }).catch(function failed(error) {
          if (disposed || snapshot.detail.id !== habitId) return null
          setState({ detail: Object.assign({}, snapshot.detail, { phase: 'fallback', error: errorText(error) }) })
          return null
        })
      }

      function closeHabitDetail() {
        setState({ detail: Object.assign({}, snapshot.detail, { open: false }) })
      }

      function patchHabit(habitId, patch, expectedRev) {
        setState({ busyId: habitId })
        return m4PatchHabit(habitId, patch, expectedRev).then(function done(value) {
          if (disposed) return null
          setState({ busyId: null })
          m0.toast('success', TEXT.saved)
          refreshAfterHabitWrite(todayIso())
          if (snapshot.projects.phase !== 'idle') loadProjectsList(snapshot.projects.filter)
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          setState({ busyId: null })
          m0.toast('error', TEXT.saveFailed + '：' + errorText(error))
          return null
        })
      }

      function pauseHabit(habit) {
        return patchHabit(habit.id, { status: 'paused' }, habit.rev)
      }

      function resumeHabit(habit) {
        return patchHabit(habit.id, { status: 'active' }, habit.rev)
      }

      function archiveHabit(habit) {
        setState({ busyId: habit.id })
        return m4ArchiveHabit(habit.id, habit.rev).then(function done(value) {
          if (disposed) return null
          setState({ busyId: null })
          m0.toast('success', '已归档：' + (habit.name || ''))
          closeHabitDetail()
          return refreshAfterHabitWrite(todayIso())
        }).catch(function failed(error) {
          if (disposed) return null
          setState({ busyId: null })
          m0.toast('error', TEXT.saveFailed + '：' + errorText(error))
          return null
        })
      }

      function openCreateHabit() {
        setState({ createHabit: { open: true, busy: false, error: null } })
      }

      function closeCreateHabit() {
        setState({ createHabit: { open: false, busy: false, error: null } })
      }

      function createHabit(input) {
        setState({ createHabit: Object.assign({}, snapshot.createHabit, { busy: true, error: null }) })
        return m4CreateHabit(input).then(function done(value) {
          if (disposed) return null
          setState({ createHabit: { open: false, busy: false, error: null } })
          m0.toast('success', TEXT.created + (input && input.name ? '：' + input.name : ''))
          loadHabits()
          loadStats()
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          setState({ createHabit: Object.assign({}, snapshot.createHabit, { busy: false, error: errorText(error) }) })
          return null
        })
      }

      function loadProjectsList(filter) {
        const target = filter || snapshot.projects.filter || 'active'
        setState({ projects: Object.assign({}, snapshot.projects, { filter: target, phase: 'loading', error: null }) })
        return m4ListProjects(projectQueryFor(target)).then(function done(value) {
          if (disposed) return null
          setState({ projects: { phase: 'ready', items: m4NormalizeProjectList(value), filter: target, error: null, at: new Date().toISOString() } })
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          setState({ projects: Object.assign({}, snapshot.projects, { filter: target, phase: 'fallback', error: errorText(error) }) })
          return null
        })
      }

      function setProjectFilter(filter) {
        return loadProjectsList(filter)
      }

      function openProject(projectId) {
        setState({
          projectDetail: {
            open: true,
            id: projectId,
            phase: 'loading',
            data: snapshot.projectDetail.id === projectId ? snapshot.projectDetail.data : null,
            error: null,
            rev: snapshot.projectDetail.id === projectId ? snapshot.projectDetail.rev : null,
            creating: false,
          },
        })
        return m4GetProject(projectId).then(function done(value) {
          if (disposed || !snapshot.projectDetail.open || snapshot.projectDetail.id !== projectId) return null
          const raw = value && typeof value === 'object' ? value : {}
          const project = m4NormalizeProject(raw.project && typeof raw.project === 'object' ? raw.project : raw)
          const detailProgress = m4NormalizeProgress(raw.progress, project.progressMode)
          if (detailProgress) project.progress = detailProgress
          const tasksRaw = Array.isArray(raw.tasks) ? raw.tasks : []
          const data = {
            project: project,
            tasks: tasksRaw,
            progress: project.progress,
            recentActivityAt: m4Field(raw, 'recentActivityAt', 'recent_activity_at') || project.recentActivityAt || '',
          }
          setState({
            projectDetail: { open: true, id: projectId, phase: 'ready', data: data, error: null, rev: project.rev, creating: false },
          })
          return data
        }).catch(function failed(error) {
          if (disposed || snapshot.projectDetail.id !== projectId) return null
          setState({ projectDetail: Object.assign({}, snapshot.projectDetail, { phase: 'fallback', error: errorText(error) }) })
          return null
        })
      }

      function closeProjectDetail() {
        setState({ projectDetail: Object.assign({}, snapshot.projectDetail, { open: false }) })
      }

      function createProject(input) {
        setState({ projectDetail: Object.assign({}, snapshot.projectDetail, { creating: true }) })
        return m4CreateProject(input).then(function done(value) {
          if (disposed) return null
          setState({ projectDetail: Object.assign({}, snapshot.projectDetail, { creating: false }) })
          m0.toast('success', TEXT.created + (input && input.name ? '：' + input.name : ''))
          loadProjectsList(snapshot.projects.filter)
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          setState({ projectDetail: Object.assign({}, snapshot.projectDetail, { creating: false }) })
          m0.toast('error', TEXT.saveFailed + '：' + errorText(error))
          return null
        })
      }

      function patchProject(projectId, patch, expectedRev) {
        setState({ busyId: projectId })
        return m4PatchProject(projectId, patch, expectedRev).then(function done(value) {
          if (disposed) return null
          setState({ busyId: null })
          m0.toast('success', TEXT.saved)
          loadProjectsList(snapshot.projects.filter)
          openProject(projectId)
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          setState({ busyId: null })
          m0.toast('error', TEXT.saveFailed + '：' + errorText(error))
          return null
        })
      }

      function archiveProject(project) {
        const projectId = project && project.id
        if (!projectId) return Promise.resolve(null)
        setState({ busyId: projectId })
        return m4ArchiveProject(projectId, project.rev).then(function done(value) {
          if (disposed) return null
          setState({ busyId: null })
          m0.toast('success', '已归档：' + (project.name || ''))
          loadProjectsList(snapshot.projects.filter)
          if (snapshot.projectDetail.open && snapshot.projectDetail.id === projectId) openProject(projectId)
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          setState({ busyId: null })
          m0.toast('error', TEXT.saveFailed + '：' + errorText(error))
          return null
        })
      }

      function createProjectTask(projectId, title) {
        const text = String(title || '').trim()
        if (!projectId || !text) return Promise.resolve(null)
        setState({ projectDetail: Object.assign({}, snapshot.projectDetail, { creating: true }) })
        return postTask({ title: text, projectId: projectId }).then(function done(value) {
          if (disposed) return null
          setState({ projectDetail: Object.assign({}, snapshot.projectDetail, { creating: false }) })
          m0.toast('success', TEXT.created + '：' + text)
          openProject(projectId)
          if (boardRef && typeof boardRef.refreshCurrent === 'function') boardRef.refreshCurrent('m4-project-task')
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          setState({ projectDetail: Object.assign({}, snapshot.projectDetail, { creating: false }) })
          m0.toast('error', TEXT.saveFailed + '：' + errorText(error))
          return null
        })
      }

      function loadGoals() {
        setState({ goals: Object.assign({}, snapshot.goals, { phase: 'loading', error: null }) })
        return m4ListGoals({}).then(function done(value) {
          if (disposed) return null
          setState({ goals: { phase: 'ready', items: m4ArrayValue(value).map(m4NormalizeGoal), error: null } })
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          setState({ goals: Object.assign({}, snapshot.goals, { phase: 'fallback', error: errorText(error) }) })
          return null
        })
      }

      function createGoal(input) {
        return m4CreateGoal(input).then(function done(value) {
          if (disposed) return null
          m0.toast('success', TEXT.created + (input && input.title ? '：' + input.title : ''))
          loadGoals()
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          m0.toast('error', TEXT.saveFailed + '：' + errorText(error))
          return null
        })
      }

      function patchGoal(goalId, patch, expectedRev) {
        return m4PatchGoal(goalId, patch, expectedRev).then(function done(value) {
          if (disposed) return null
          loadGoals()
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          m0.toast('error', TEXT.saveFailed + '：' + errorText(error))
          return null
        })
      }

      function loadWishes() {
        setState({ wishes: Object.assign({}, snapshot.wishes, { phase: 'loading', error: null }) })
        return m4ListWishes({}).then(function done(value) {
          if (disposed) return null
          setState({ wishes: { phase: 'ready', items: m4ArrayValue(value).map(m4NormalizeWish), error: null } })
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          setState({ wishes: Object.assign({}, snapshot.wishes, { phase: 'fallback', error: errorText(error) }) })
          return null
        })
      }

      function createWish(input) {
        return m4CreateWish(input).then(function done(value) {
          if (disposed) return null
          m0.toast('success', TEXT.created + (input && input.title ? '：' + input.title : ''))
          loadWishes()
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          m0.toast('error', TEXT.saveFailed + '：' + errorText(error))
          return null
        })
      }

      function convertWish(wishId, goalInput, expectedRev) {
        const body = { goal: m4Body(goalInput) }
        if (expectedRev !== undefined && expectedRev !== null) body.expectedRev = expectedRev
        return m4ConvertWish(wishId, body).then(function done(value) {
          if (disposed) return null
          m0.toast('success', '已转化为目标')
          loadWishes()
          loadGoals()
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          m0.toast('error', TEXT.saveFailed + '：' + errorText(error))
          return null
        })
      }

      function loadReview(period, anchor) {
        const targetPeriod = period || snapshot.review.period || 'week'
        const targetAnchor = anchor || snapshot.review.anchor || todayIso()
        const apiPeriod = targetPeriod === 'month' ? 'month' : 'week'
        const apiAnchor = targetPeriod === 'last' ? addDaysKey(todayIso(), -7) : targetAnchor
        setState({ review: Object.assign({}, snapshot.review, { period: targetPeriod, anchor: targetAnchor, phase: 'loading', error: null }) })
        return m4ReviewSummary(apiPeriod, apiAnchor).then(function done(value) {
          if (disposed) return null
          setState({
            review: {
              period: targetPeriod,
              anchor: targetAnchor,
              phase: 'ready',
              data: m4NormalizeReview(value),
              error: null,
              at: new Date().toISOString(),
            },
          })
          return value
        }).catch(function failed(error) {
          if (disposed) return null
          setState({ review: Object.assign({}, snapshot.review, { phase: 'fallback', error: errorText(error) }) })
          return null
        })
      }

      function setReviewPeriod(period) {
        const anchor = period === 'week' ? todayIso() : addDaysKey(todayIso(), -7)
        return loadReview(period, anchor)
      }

      function ensureHabitsTab() {
        const jobs = []
        if (snapshot.habits.phase === 'idle') jobs.push(loadHabits())
        if (!snapshot.stats.data) jobs.push(loadStats())
        if (!snapshot.month.data) jobs.push(loadMonth(snapshot.month.month))
        return Promise.all(jobs)
      }

      function ensureProjectsTab() {
        if (snapshot.projects.phase === 'idle') return loadProjectsList(snapshot.projects.filter)
        return Promise.resolve(null)
      }

      function ensureReviewTab() {
        if (snapshot.review.phase === 'idle') return loadReview(snapshot.review.period, snapshot.review.anchor)
        return Promise.resolve(null)
      }

      function ensureTodayHabits() {
        if (!snapshot.stats.data) return loadStats()
        return Promise.resolve(null)
      }

      function refreshLoaded() {
        const jobs = []
        if (snapshot.habits.phase !== 'idle') jobs.push(loadHabits())
        if (snapshot.stats.data) jobs.push(loadStats())
        if (snapshot.month.data) jobs.push(loadMonth(snapshot.month.month))
        if (snapshot.projects.phase !== 'idle') jobs.push(loadProjectsList(snapshot.projects.filter))
        if (snapshot.projectDetail.open) jobs.push(openProject(snapshot.projectDetail.id))
        if (snapshot.detail.open) jobs.push(openHabit(snapshot.detail.id))
        if (snapshot.review.phase !== 'idle') jobs.push(loadReview(snapshot.review.period, snapshot.review.anchor))
        return Promise.all(jobs)
      }

      function onExternalChange(reason, payload) {
        const kind = payload && typeof payload === 'object'
          ? String(payload.kind || payload.type || payload.entity || '')
          : ''
        schedule(function applyChange() {
          if (kind === 'habit' || kind === 'habit_checkin' || kind === 'habits') {
            loadHabits()
            if (snapshot.stats.data) loadStats()
            if (snapshot.month.data) loadMonth(snapshot.month.month)
            return
          }
          if (kind === 'project' || kind === 'projects') {
            if (snapshot.projects.phase !== 'idle') loadProjectsList(snapshot.projects.filter)
            if (snapshot.projectDetail.open) openProject(snapshot.projectDetail.id)
            return
          }
          if (kind === 'goal' || kind === 'goals') {
            if (snapshot.goals.phase !== 'idle') loadGoals()
            return
          }
          if (kind === 'wish' || kind === 'wishes') {
            if (snapshot.wishes.phase !== 'idle') loadWishes()
            return
          }
          if (reason === 'hello' || reason === 'resync') {
            if (snapshot.habits.phase !== 'idle') loadHabits()
            if (snapshot.projects.phase !== 'idle') loadProjectsList(snapshot.projects.filter)
          }
        }, 160)
      }

      function init() {
        if (snapshot.habits.phase !== 'idle') return Promise.resolve()
        return Promise.all([loadHabits(), loadProjectsList(snapshot.projects.filter), loadStats()])
      }

      function dispose() {
        disposed = true
        timers.forEach(function clear(id) {
          clearTimeout(id)
        })
        timers.clear()
        listeners.clear()
      }

      return {
        getState: getState,
        subscribe: subscribe,
        init: init,
        loadHabits: loadHabits,
        loadStats: loadStats,
        loadMonth: loadMonth,
        shiftHabitMonth: shiftHabitMonth,
        ensureHabitsTab: ensureHabitsTab,
        ensureProjectsTab: ensureProjectsTab,
        ensureReviewTab: ensureReviewTab,
        ensureTodayHabits: ensureTodayHabits,
        checkinHabit: checkinHabit,
        uncheckHabit: uncheckHabit,
        openHabit: openHabit,
        closeHabitDetail: closeHabitDetail,
        pauseHabit: pauseHabit,
        resumeHabit: resumeHabit,
        archiveHabit: archiveHabit,
        openCreateHabit: openCreateHabit,
        closeCreateHabit: closeCreateHabit,
        createHabit: createHabit,
        setProjectFilter: setProjectFilter,
        openProject: openProject,
        closeProjectDetail: closeProjectDetail,
        createProject: createProject,
        patchProject: patchProject,
        archiveProject: archiveProject,
        createProjectTask: createProjectTask,
        loadGoals: loadGoals,
        createGoal: createGoal,
        patchGoal: patchGoal,
        loadWishes: loadWishes,
        createWish: createWish,
        convertWish: convertWish,
        loadReview: loadReview,
        setReviewPeriod: setReviewPeriod,
        refreshLoaded: refreshLoaded,
        onExternalChange: onExternalChange,
        dispose: dispose,
      }
    }

    const m4 = createM4Runtime(runtime, board)

    function copyTextToClipboard(text) {
      const value = String(text || '')
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          return navigator.clipboard.writeText(value).then(function done() { return true }).catch(function fallback() { return copyTextFallback(value) })
        }
      } catch (error) {
        /* fall through */
      }
      return copyTextFallback(value)
    }

    function copyTextFallback(value) {
      try {
        const textarea = document.createElement('textarea')
        textarea.value = value
        textarea.setAttribute('readonly', 'readonly')
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
        document.body.removeChild(textarea)
        return copied ? Promise.resolve(true) : Promise.reject(new Error('clipboard unavailable'))
      } catch (error) {
        return Promise.reject(error)
      }
    }

    function journalDraftPrompt(kind) {
      if (kind === 'evening') {
        return '读今天的笔记（notesDir 里的 YYYY-MM-DD.md）、今日任务/日程/习惯/指标，生成「晚记草稿」：实际完成、与晨记计划的偏差、2 个反思问题、一句勉励。先在对话里给我看，我确认后再 append 到今天的笔记，不要覆盖原文。'
      }
      return '读今天和昨天的笔记（notesDir 里的 YYYY-MM-DD.md）、今日任务/日程/习惯/指标，生成「晨记草稿」：昨天回顾一句、今日 3 件重点、时间地点提醒、习惯提醒、一句鼓励。先在对话里给我看，我确认后再 append 到今天的笔记，不要覆盖原文。'
    }

/* __M3_COMPONENTS__ */





    /* ═════════════════════════ React hooks 小工具 ═════════════════════════ */

    function useRuntime(runtimeInstance) {
      const [screen, setScreen] = useState(0)
      useEffect(() => {
        return runtimeInstance.subscribe(() => setScreen((value) => value + 1))
      }, [runtimeInstance])
      return [runtimeInstance.getState(), screen]
    }

    function useIsNarrow() {
      const [narrow, setNarrow] = useState(function initial() {
        try {
          return window.innerWidth < 1024
        } catch (error) {
          return false
        }
      })
      useEffect(() => {
        function onResize() {
          try {
            setNarrow(window.innerWidth < 1024)
          } catch (error) {
            /* ignore */
          }
        }
        window.addEventListener('resize', onResize)
        return function cleanup() {
          window.removeEventListener('resize', onResize)
        }
      }, [])
      return narrow
    }

    /* ═════════════════════════ 基础组件 ═════════════════════════ */

    function StatusDot(props) {
      const tone = props && props.tone ? props.tone : 'idle'
      const color =
        tone === 'ok'
          ? COLORS.success
          : tone === 'warn'
            ? COLORS.warn
            : tone === 'error'
              ? COLORS.error
              : COLORS.idle
      return h('span', {
        'aria-hidden': true,
        style: {
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          display: 'inline-block',
          flex: 'none',
          boxShadow: '0 0 0 3px ' + token('--dsw-alias-bg-mask-2', 'rgba(0,0,0,0.04)'),
        },
      })
    }

    function Banner(props) {
      const tone = props && props.tone ? props.tone : 'warn'
      const border = tone === 'error' ? COLORS.error : tone === 'warn' ? COLORS.warn : COLORS.business
      return h(
        'div',
        {
          role: tone === 'error' ? 'alert' : 'status',
          style: {
            margin: '8px 16px 0',
            padding: '8px 12px',
            borderRadius: COLORS.radiusMd,
            border: '1px solid ' + COLORS.borderL1,
            borderLeft: '3px solid ' + border,
            background: COLORS.bgLayer1,
            color: COLORS.labelSecondary,
            fontSize: 12,
            lineHeight: '18px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          },
        },
        h('span', { style: { flex: '1 1 auto' } }, props && props.children ? props.children : ''),
        props && props.onRetry
          ? h(
              'button',
              {
                type: 'button',
                onClick: props.onRetry,
                style: buttonStyle('ghost'),
              },
              TEXT.retry,
            )
          : null,
      )
    }

    function buttonStyle(variant) {
      const primary = variant === 'primary'
      return {
        fontFamily: COLORS.fontFamily,
        fontSize: 13,
        fontWeight: primary ? 600 : 400,
        lineHeight: '18px',
        padding: '5px 12px',
        borderRadius: COLORS.radiusSm,
        border: primary ? '1px solid transparent' : '1px solid ' + COLORS.borderL1,
        background: primary ? COLORS.brand : 'transparent',
        // 主按钮用固定白色（brandText 是深色品牌文字 token，不适合当按钮前景）。
        color: primary ? COLORS.brandOn : COLORS.labelSecondary,
        cursor: 'pointer',
        flex: 'none',
      }
    }

    function fieldInputStyle() {
      return {
        fontFamily: COLORS.fontFamily,
        fontSize: 13,
        lineHeight: '18px',
        padding: '6px 8px',
        borderRadius: COLORS.radiusSm,
        border: '1px solid ' + COLORS.borderL1,
        background: COLORS.bgBase,
        color: COLORS.labelPrimary,
        outline: 'none',
        boxSizing: 'border-box',
      }
    }

    function SkeletonRows(props) {
      const count = Number(props && props.count) > 0 ? Number(props.count) : 3
      const rows = []
      for (let index = 0; index < count; index += 1) {
        rows.push(
          h('div', {
            key: 'skeleton_' + index,
            style: {
              height: 14,
              margin: '10px 16px',
              width: index % 2 === 0 ? '72%' : '54%',
              borderRadius: 4,
              background: COLORS.bgLayer2,
              opacity: 0.7,
            },
          }),
        )
      }
      return h('div', { role: 'status', 'aria-label': TEXT.loading }, rows)
    }

    function EmptyState(props) {
      return h(
        'div',
        {
          style: {
            padding: '32px 20px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            color: COLORS.labelSecondary,
            textAlign: 'center',
          },
        },
        h('div', { style: Object.assign({}, FONT.body, { color: COLORS.labelPrimary }) }, props && props.title ? props.title : ''),
        props && props.hint
          ? h('div', { style: Object.assign({}, FONT.meta, { color: COLORS.labelTertiary }) }, props.hint)
          : null,
        props && props.onAction
          ? h('button', { type: 'button', onClick: props.onAction, style: Object.assign({}, buttonStyle('primary'), { marginTop: 4 }) }, props.actionLabel || TEXT.quickCapture)
          : null,
      )
    }

    function InlineError(props) {
      return h(
        'div',
        {
          role: 'alert',
          style: {
            margin: '12px 16px',
            padding: '8px 12px',
            border: '1px solid ' + COLORS.borderL1,
            borderLeft: '3px solid ' + COLORS.error,
            borderRadius: COLORS.radiusMd,
            color: COLORS.error,
            fontSize: 12,
            lineHeight: '18px',
          },
        },
        props && props.children ? props.children : '',
      )
    }

    /* ═════════════════════════ 图标 / 错误边界 ═════════════════════════ */

    function LifeosIcon(props) {
      const [m3IconState] = useRuntime(m3)
      const rawSize = props && Number(props.size) > 0 ? Number(props.size) : 16
      const active = !!(props && props.active)
      const ringColor = active ? COLORS.brand : 'currentColor'
      const size = Math.max(12, Math.round(rawSize))
      const unreadCount = v2UiEnabled()
        ? 0
        : Number(m3IconState && m3IconState.notifications && m3IconState.notifications.unread) || 0
      const svgNode = h(
        'svg',
        {
          xmlns: 'http://www.w3.org/2000/svg',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block', flex: 'none' },
        },
        h('circle', {
          cx: 12,
          cy: 12,
          r: 9,
          fill: 'none',
          stroke: ringColor,
          strokeWidth: active ? 2 : 1.7,
          opacity: active ? 1 : 0.8,
        }),
        h('path', {
          d: 'M12 7.2v5.2l3.1 2.1',
          fill: 'none',
          stroke: ringColor,
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          opacity: active ? 1 : 0.85,
        }),
        h('circle', {
          cx: 18.1,
          cy: 5.9,
          r: 2.2,
          fill: active ? COLORS.brand : 'currentColor',
          opacity: active ? 1 : 0.72,
        }),
      )
      return h(
        'span',
        { style: { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } },
        svgNode,
        unreadCount > 0
          ? h(
              'span',
              {
                'aria-label': '未读通知 ' + unreadCount,
                style: {
                  position: 'absolute',
                  top: -5,
                  right: -6,
                  minWidth: 14,
                  height: 14,
                  padding: '0 3px',
                  borderRadius: 999,
                  background: COLORS.error,
                  color: COLORS.brandText,
                  fontSize: 9,
                  lineHeight: '14px',
                  textAlign: 'center',
                  fontWeight: 600,
                  boxSizing: 'border-box',
                },
              },
              unreadCount > 9 ? '9+' : String(unreadCount),
            )
          : null,
      )
    }

    class LifeosErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
        this.handleRetry = this.handleRetry.bind(this)
      }

      static getDerivedStateFromError(error) {
        return { error: error }
      }

      componentDidCatch(error) {
        try {
          console.error('[lifeos] slot crashed (' + String(this.props.label || 'unknown') + ')', error)
        } catch (inner) {
          /* ignore */
        }
      }

      handleRetry() {
        this.setState({ error: null })
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            {
              role: 'alert',
              style: {
                padding: 20,
                fontFamily: COLORS.fontFamily,
                color: COLORS.labelPrimary,
                background: COLORS.bgBase,
                minHeight: 120,
              },
            },
            h('div', { style: Object.assign({}, FONT.body, { fontWeight: 600, marginBottom: 6 }) }, TEXT.crashTitle),
            h('div', { style: Object.assign({}, FONT.meta, { color: COLORS.labelSecondary, marginBottom: 10 }) }, TEXT.crashHint),
            h('code', { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary, display: 'block', marginBottom: 10, wordBreak: 'break-all' }) }, String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)),
            h('button', { type: 'button', onClick: this.handleRetry, style: buttonStyle('primary') }, TEXT.retry),
          )
        }
        return this.props.children
      }
    }

    function withBoundary(Component, label) {
      return function LifeosBoundary(props) {
        return h(LifeosErrorBoundary, { label: label }, h(Component, props))
      }
    }

    /* ═════════════════════════ M2-C2：整理审查（列表态 / 审查态 / 结果态） ═════════════════════════ */














    function AutomationSettingRow(props) {
      const triage = props.triage
      const state = props.state
      const automation = (state.automation && state.automation.data) || {}
      const enabled = automation.enabled !== false
      const saving = state.automation.saving === true
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid ' + COLORS.borderL1, flexWrap: 'wrap' } },
        h('div', { style: { width: 120, flex: 'none', color: COLORS.labelSecondary, fontSize: 13 } }, TEXT.triageAutomation),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': enabled,
            'aria-label': TEXT.triageAutomation,
            onClick: function toggle() {
              triage.setAutomationEnabled(!enabled)
            },
            disabled: saving,
            style: { width: 38, height: 20, borderRadius: 999, border: '1px solid ' + (enabled ? COLORS.brand : COLORS.borderL2), background: enabled ? COLORS.brand : COLORS.bgLayer2, padding: 0, cursor: saving ? 'default' : 'pointer', flex: 'none', position: 'relative' },
          },
          h('span', { 'aria-hidden': true, style: { display: 'block', width: 14, height: 14, borderRadius: '50%', background: enabled ? COLORS.brandText : COLORS.labelTertiary, transform: 'translateX(' + (enabled ? 20 : 3) + 'px)', transition: 'transform 120ms ease' } }),
        ),
        h('span', { style: Object.assign({}, FONT.meta, { color: enabled ? COLORS.success : COLORS.labelTertiary }) }, enabled ? TEXT.triageAutomationOn : TEXT.triageAutomationOff),
        h('span', { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary }) }, '· ' + TEXT.triageAutomationTime + ' ' + String(automation.time || '21:30')),
        automation.nextRun ? h('span', { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary }) }, '· ' + TEXT.triageAutomationNext + ' ' + formatTime(automation.nextRun)) : null,
        h('div', { style: { flex: '1 1 auto' } }),
        h('span', { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary, maxWidth: 320, textAlign: 'right' }) }, TEXT.triageAutomationHint),
      )
    }

    function AutomationSettingSection(props) {
      return h(
        'div',
        { style: { marginTop: 16 } },
        h('h3', { style: Object.assign({}, FONT.body, { fontWeight: 600, margin: '0 0 4px' }) }, TEXT.triageTitle),
        h(AutomationSettingRow, { triage: props.triage, state: props.state }),
      )
    }

    /* ═════════════════════════ M2.5：笔记工作台 / 整理次级页 组件 ═════════════════════════ */



    function renderMarkdownPreview(content) {
      const text = String(content || '')
      const blocks = []
      const lines = text.split('\n')
      let listItems = []
      let codeLines = []
      let inCode = false
      function flushList() {
        if (!listItems.length) return
        blocks.push(
          h(
            'ul',
            { key: 'ul_' + blocks.length, style: { margin: '4px 0', paddingLeft: 20 } },
            listItems.map(function item(line, index) {
              return h('li', { key: 'li_' + index, style: { margin: '2px 0' } }, line)
            }),
          ),
        )
        listItems = []
      }
      function flushCode() {
        if (!codeLines.length) return
        blocks.push(
          h(
            'pre',
            {
              key: 'code_' + blocks.length,
              style: {
                margin: '8px 0',
                padding: '8px 10px',
                background: COLORS.bgLayer2,
                border: '1px solid ' + COLORS.borderL1,
                borderRadius: COLORS.radiusSm,
                overflowX: 'auto',
                fontSize: 12,
                lineHeight: '18px',
                whiteSpace: 'pre-wrap',
              },
            },
            codeLines.join('\n'),
          ),
        )
        codeLines = []
      }
      lines.forEach(function (line, index) {
        if (/^```/.test(line)) {
          flushList()
          if (inCode) {
            inCode = false
            flushCode()
          } else {
            inCode = true
          }
          return
        }
        if (inCode) {
          codeLines.push(line)
          return
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          flushList()
          const level = heading[1].length
          blocks.push(
            h(
              'div',
              {
                key: 'h_' + index,
                style: {
                  fontSize: level <= 2 ? 18 : level === 3 ? 16 : 14,
                  fontWeight: 600,
                  margin: '10px 0 4px',
                  color: COLORS.labelPrimary,
                },
              },
              heading[2],
            ),
          )
          return
        }
        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
        if (bullet) {
          listItems.push(bullet[1])
          return
        }
        if (!line.trim()) {
          flushList()
          return
        }
        flushList()
        blocks.push(
          h(
            'p',
            { key: 'p_' + index, style: Object.assign({}, FONT.body, { margin: '4px 0', color: COLORS.labelPrimary, wordBreak: 'break-word' }) },
            line,
          ),
        )
      })
      flushList()
      flushCode()
      if (!blocks.length) {
        return h('div', { style: Object.assign({}, FONT.meta, { color: COLORS.labelTertiary, padding: 12 }) }, '（空白笔记）')
      }
      return h('div', { style: { padding: '10px 4px', maxWidth: 760 } }, blocks)
    }




    function NotesSettingSection(props) {
      const notes = props.notes
      const state = props.state
      const config = state.config.data || {}
      const [dir, setDir] = useState(config.dir || '')
      const [autosaveMs, setAutosaveMs] = useState(String((config.options && config.options.autosaveMs) || 800))
      const [historyLimit, setHistoryLimit] = useState(String((config.options && config.options.historyLimit) || 20))
      const [saving, setSaving] = useState(false)
      useEffect(
        function sync() {
          if (config.dir) setDir(config.dir)
          if (config.options && config.options.autosaveMs) setAutosaveMs(String(config.options.autosaveMs))
          if (config.options && config.options.historyLimit) setHistoryLimit(String(config.options.historyLimit))
        },
        [config.dir, config.options && config.options.autosaveMs, config.options && config.options.historyLimit],
      )
      function saveConfig() {
        setSaving(true)
        notes
          .setConfig(dir, true)
          .then(function after() {
            return notesSetConfigApi({
              options: {
                autosaveMs: Math.max(200, Math.min(5000, Number(autosaveMs) || 800)),
                historyLimit: Math.max(1, Math.min(100, Number(historyLimit) || 20)),
              },
            })
          })
          .then(function reload() {
            notes.loadConfig()
            setSaving(false)
          })
          .catch(function onError(error) {
            setSaving(false)
            runtime.toast('error', '笔记设置保存失败：' + errorText(error))
          })
      }
      return h(
        'div',
        { style: { marginTop: 16 } },
        h('h3', { style: Object.assign({}, FONT.body, { fontWeight: 600, margin: '0 0 4px' }) }, '笔记'),
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid ' + COLORS.borderL1 } },
          h('span', { style: { width: 120, flex: 'none', color: COLORS.labelSecondary, fontSize: 13 } }, '笔记目录'),
          h('input', {
            type: 'text',
            value: dir,
            'aria-label': '笔记目录',
            placeholder: 'C:\\Users\\你\\Documents\\LifeOS\\Notes',
            onChange: function onChange(event) {
              setDir(event.target.value)
            },
            style: Object.assign({}, fieldInputStyle(), { flex: '1 1 260px', fontSize: 12 }),
          }),
          h(
            'span',
            { style: Object.assign({}, FONT.caption, { color: config.exists ? COLORS.success : COLORS.warn }) },
            config.exists ? '已配置' : '未配置',
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid ' + COLORS.borderL1 } },
          h('span', { style: { width: 120, flex: 'none', color: COLORS.labelSecondary, fontSize: 13 } }, '自动保存间隔'),
          h('input', {
            type: 'number',
            min: 200,
            max: 5000,
            value: autosaveMs,
            'aria-label': '自动保存间隔',
            onChange: function onChange(event) {
              setAutosaveMs(event.target.value)
            },
            style: Object.assign({}, fieldInputStyle(), { width: 100 }),
          }),
          h('span', { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary }) }, '毫秒（200–5000，默认 800）'),
          h('span', { style: { width: 24, flex: 'none' } }),
          h('span', { style: { color: COLORS.labelSecondary, fontSize: 13 } }, '历史保留'),
          h('input', {
            type: 'number',
            min: 1,
            max: 100,
            value: historyLimit,
            'aria-label': '历史保留数',
            onChange: function onChange(event) {
              setHistoryLimit(event.target.value)
            },
            style: Object.assign({}, fieldInputStyle(), { width: 80 }),
          }),
          h('span', { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary }) }, '个快照'),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h(
            'button',
            {
              type: 'button',
              onClick: saveConfig,
              disabled: saving || !String(dir).trim(),
              style: Object.assign({}, buttonStyle('primary'), { opacity: saving || !String(dir).trim() ? 0.55 : 1 }),
            },
            saving ? '保存中…' : '保存并校验目录',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: function reload() {
                notes.loadConfig()
              },
              style: buttonStyle('ghost'),
            },
            '重新读取',
          ),
          state.config.error
            ? h('span', { style: Object.assign({}, FONT.caption, { color: COLORS.error }) }, state.config.error)
            : null,
        ),
      )
    }



    /* ═════════════════════════ M3：建议卡 / 通知 / 自动化设置 组件 ═════════════════════════ */






    function M3Switch(props) {
      const checked = props.checked === true
      const disabled = props.disabled === true
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': props.label || '开关',
          disabled: disabled,
          onClick: function onClick() {
            if (!disabled) props.onChange(!checked)
          },
          style: {
            width: 36,
            height: 20,
            borderRadius: 999,
            border: '1px solid ' + (checked ? COLORS.brand : COLORS.borderL2),
            background: checked ? COLORS.brand : COLORS.bgLayer2,
            padding: 0,
            cursor: disabled ? 'default' : 'pointer',
            position: 'relative',
            flex: 'none',
            opacity: disabled ? 0.6 : 1,
          },
        },
        h('span', {
          'aria-hidden': true,
          style: {
            display: 'block',
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: checked ? COLORS.brandText : COLORS.labelTertiary,
            transform: 'translateX(' + (checked ? 18 : 3) + 'px)',
            transition: 'transform 120ms ease',
          },
        }),
      )
    }

    const M3_ROUTINE_ROWS = [
      { key: 'morningBrief', label: '晨间简报', hint: '默认开 · 07:35' },
      { key: 'eveningReview', label: '晚报', hint: '默认关' },
      { key: 'habitNudge', label: '习惯追问', hint: '默认关' },
      { key: 'nightlyInbox', label: '夜间整理', hint: '默认开 · 21:30' },
    ]

    /** 免打扰窗口的自然语言说明（跨天、空窗口、时长）。 */
    function dndWindowLabel(dnd) {
      if (!dnd || typeof dnd.start !== 'string' || typeof dnd.end !== 'string') return '未设置'
      if (dnd.start === dnd.end) return '开始=结束，视为不启用'
      const toMinutes = function toMinutes(value) {
        const parts = value.split(':')
        return Number(parts[0]) * 60 + Number(parts[1])
      }
      const total = (toMinutes(dnd.end) - toMinutes(dnd.start) + 1440) % 1440
      const hours = Math.floor(total / 60)
      const minutes = total % 60
      return '跨天生效 · 共 ' + (hours ? hours + ' 小时' : '') + (minutes ? ' ' + minutes + ' 分钟' : '')
    }

    function AutomationSettingsSection(props) {
      const m3 = props.m3
      const state = props.state
      const automation = state.automation || {}
      const config = automation.config || defaultAutomationConfig()
      const status = automation.status || { byId: {}, items: [] }
      const saving = automation.saving === true
      const [form, setForm] = useState(config)
      const [dirty, setDirty] = useState(false)
      useEffect(function sync() {
        if (!dirty) setForm(config)
      }, [config, dirty])
      function setRoutine(key, patch) {
        setDirty(true)
        setForm(function update(current) {
          return Object.assign({}, current, { [key]: Object.assign({}, current[key], patch) })
        })
      }
      function setField(key, patch) {
        setDirty(true)
        setForm(function update(current) {
          const base = current && typeof current === 'object' ? current : {}
          if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
            return Object.assign({}, base, { [key]: Object.assign({}, base[key], patch) })
          }
          return Object.assign({}, base, { [key]: patch })
        })
      }
      function statusText(key) {
        const entry = status.byId ? status.byId[key] : null
        if (!entry) return form[key] && form[key].enabled ? '待调度' : '已关闭'
        if (entry.enabled === false) return '已关闭'
        if (entry.nextRun) return '下次 ' + formatTime(entry.nextRun)
        return '待调度'
      }
      function save() {
        m3.saveAutomation(form).then(function after(result) {
          if (result) setDirty(false)
        })
      }
      const impacted = automation.impacted || []
      return h(
        'div',
        { style: { marginTop: 16 } },
        h('h3', { style: Object.assign({}, FONT.body, { fontWeight: 600, margin: '0 0 4px' }) }, '自动化'),
        h(
          'p',
          { style: Object.assign({}, FONT.caption, { margin: '0 0 8px', color: dirty ? COLORS.warn : COLORS.labelTertiary }) },
          (dirty ? '● 有未保存修改 · ' : '') + '每日主动消息 ≤ ' + String(form.dailyBudget) + ' 条；免打扰 ' + form.dnd.start + '–' + form.dnd.end + '；保存后立即对账 schedule。',
        ),
        M3_ROUTINE_ROWS.map(function mapRow(row) {
          const value = form[row.key] || { enabled: false, time: '07:00' }
          return h(
            'div',
            { key: row.key, style: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid ' + COLORS.borderL1, flexWrap: 'wrap' } },
            h('span', { style: { width: 96, flex: 'none', color: COLORS.labelSecondary, fontSize: 13 } }, row.label),
            h(M3Switch, { checked: value.enabled, label: row.label + '开关', onChange: function onChange(next) { setRoutine(row.key, { enabled: next }) } }),
            h('input', {
              type: 'time',
              value: value.time,
              'aria-label': row.label + '时间',
              onChange: function onChange(event) { setRoutine(row.key, { time: event.target.value }) },
              style: Object.assign({}, fieldInputStyle(), { width: 96 }),
            }),
            h('span', { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary }) }, row.hint),
            h('div', { style: { flex: '1 1 auto' } }),
            h('span', { style: Object.assign({}, FONT.caption, { color: statusText(row.key).indexOf('下次') === 0 ? COLORS.success : COLORS.labelTertiary }) }, statusText(row.key)),
          )
        }),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid ' + COLORS.borderL1, flexWrap: 'wrap' } },
          h('span', { style: { width: 96, flex: 'none', color: COLORS.labelSecondary, fontSize: 13 } }, '截止提醒'),
          h(M3Switch, { checked: form.deadlineReminder.enabled, label: '截止提醒开关', onChange: function onChange(next) { setField('deadlineReminder', { enabled: next }) } }),
          h('span', { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary }) }, '提前'),
          h('input', {
            type: 'number',
            min: 5,
            max: 1440,
            value: form.deadlineReminder.leadMinutes,
            'aria-label': '截止提醒提前分钟',
            onChange: function onChange(event) { setField('deadlineReminder', { leadMinutes: Number(event.target.value) || 60 }) },
            style: Object.assign({}, fieldInputStyle(), { width: 80 }),
          }),
          h('span', { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary }) }, '分钟；当天'),
          h('input', {
            type: 'time',
            value: form.deadlineReminder.dueDateAt,
            'aria-label': '截止提醒当天时间',
            onChange: function onChange(event) { setField('deadlineReminder', { dueDateAt: event.target.value }) },
            style: Object.assign({}, fieldInputStyle(), { width: 96 }),
          }),
          h('span', { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary }) }, '提醒'),
          h('span', { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary }) }, '（提醒时刻落在免打扰内会自动跳过）'),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid ' + COLORS.borderL1, flexWrap: 'wrap' } },
          h('span', { style: { width: 96, flex: 'none', color: COLORS.labelSecondary, fontSize: 13 } }, '免打扰'),
          h('input', {
            type: 'time',
            value: form.dnd.start,
            'aria-label': '免打扰开始',
            onChange: function onChange(event) { setField('dnd', { start: event.target.value }) },
            style: Object.assign({}, fieldInputStyle(), { width: 96 }),
          }),
          h('span', { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary }) }, '–'),
          h('input', {
            type: 'time',
            value: form.dnd.end,
            'aria-label': '免打扰结束',
            onChange: function onChange(event) { setField('dnd', { end: event.target.value }) },
            style: Object.assign({}, fieldInputStyle(), { width: 96 }),
          }),
          h('div', { style: { flex: '1 1 auto' } }),
          h('span', { style: Object.assign({}, FONT.caption, { color: m3.dndActive() ? COLORS.warn : COLORS.labelTertiary }) }, m3.dndActive() ? '当前处于免打扰' : '当前可打扰'),
          h(
            'span',
            { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary, flex: '1 1 100%' }) },
            dndWindowLabel(form.dnd) + '；免打扰内：截止提醒自动跳过，routine 时间不能落在其中（保存时会校验）',
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid ' + COLORS.borderL1, flexWrap: 'wrap' } },
          h('span', { style: { width: 96, flex: 'none', color: COLORS.labelSecondary, fontSize: 13 } }, '每日预算'),
          h('input', {
            type: 'number',
            min: 0,
            max: 5,
            value: form.dailyBudget,
            'aria-label': '每日主动消息预算',
            onChange: function onChange(event) { setField('dailyBudget', Number(event.target.value) || 0) },
            style: Object.assign({}, fieldInputStyle(), { width: 72 }),
          }),
          h('span', { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary }) }, '条主动消息 / 天'),
          h('span', { style: { width: 24, flex: 'none' } }),
          h('span', { style: { color: COLORS.labelSecondary, fontSize: 13 } }, '建议'),
          h(M3Switch, { checked: form.suggestions.enabled, label: '建议开关', onChange: function onChange(next) { setField('suggestions', { enabled: next }) } }),
          h('span', { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary }) }, '每天最多'),
          h('input', {
            type: 'number',
            min: 0,
            max: 5,
            value: form.suggestions.maxPerDay,
            'aria-label': '建议每日上限',
            onChange: function onChange(event) { setField('suggestions', { maxPerDay: Number(event.target.value) || 0 }) },
            style: Object.assign({}, fieldInputStyle(), { width: 72 }),
          }),
          h('span', { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary }) }, '条'),
        ),
        automation.error
          ? h('div', { role: 'alert', style: Object.assign({}, FONT.caption, { color: COLORS.error, marginTop: 6 }) }, '自动化接口暂不可用（已用本地回退）：' + automation.error)
          : null,
        impacted.length
          ? h(
              'div',
              { style: { marginTop: 8, padding: '6px 10px', border: '1px solid ' + COLORS.borderL1, borderRadius: COLORS.radiusMd, background: COLORS.bgLayer1 } },
              h('div', { style: Object.assign({}, FONT.caption, { fontWeight: 600, color: COLORS.labelSecondary, marginBottom: 4 }) }, '保存影响面（' + impacted.length + '）'),
              impacted.map(function mapItem(item, index) {
                const text = typeof item === 'string'
                  ? item
                  : String((item && (item.label || item.id || item.routine || item.description)) || JSON.stringify(item))
                return h('div', { key: 'impacted_' + index, style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary }) }, '· ' + text)
              }),
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h('button', { type: 'button', onClick: save, disabled: saving, style: Object.assign({}, buttonStyle('primary'), { opacity: saving ? 0.55 : 1 }) }, saving ? '保存中…' : '保存自动化设置'),
          h('button', { type: 'button', onClick: function refresh() { m3.loadAutomation() }, style: buttonStyle('ghost') }, '重新读取'),
          automation.lastSavedAt
            ? h('span', { style: Object.assign({}, FONT.caption, { color: COLORS.success }) }, '已保存 ' + formatTime(automation.lastSavedAt) + (impacted.length ? ' · 影响 ' + impacted.length + ' 项' : ''))
            : null,
        ),
      )
    }

    /* ═════════════════════════ 主面板：顶栏 / tabs / 记录行 ═════════════════════════ */




    /* ═════════════════════════ 主面板：收件箱 / 今日 ═════════════════════════ */



    /* ═════════════════════════ M1：任务行 / 列表 / 筛选组件 ═════════════════════════ */








    /* ═════════════════════════ M1：今日 / 待办 视图 ═════════════════════════ */





    /* ═════════════════════════ M1：月历视图 ═════════════════════════ */



    /* ═════════════════════════ M1：任务详情抽屉 ═════════════════════════ */




    /* ═════════════════════════ M4：习惯 / 项目 / 回顾 视图组件 ═════════════════════════ */






















    /* ═════════════════════════ M1：4 tab 视图容器 ═════════════════════════ */


    /* ═════════════════════════ 主面板 ═════════════════════════ */


    /* ═════════════════════════ 快速记录浮层 + toast（shell.overlay） ═════════════════════════ */

    const OVERLAY_TITLE_ID = 'lifeos-quick-capture-title'

    function QuickCaptureDialog(props) {
      const state = props.state
      const [text, setText] = useState(function initial() {
        return safeReadStorage(DRAFT_STORAGE_KEY) || ''
      })
      const [error, setError] = useState(null)
      const [noteSaving, setNoteSaving] = useState(false)
      const textareaRef = useRef(null)
      const dialogRef = useRef(null)
      const composingRef = useRef(false)
      const submitting = state.capture.submitting === true

      useEffect(function onOpen() {
        safeWriteStorage(DRAFT_STORAGE_KEY, null)
        const timer = window.setTimeout(function focusLater() {
          try {
            if (textareaRef.current) {
              textareaRef.current.focus()
              const length = textareaRef.current.value.length
              textareaRef.current.setSelectionRange(length, length)
            }
          } catch (inner) {
            /* ignore */
          }
        }, 30)
        return function cleanup() {
          try {
            window.clearTimeout(timer)
          } catch (inner) {
            /* ignore */
          }
        }
      }, [])

      useEffect(function saveDraft() {
        safeWriteStorage(DRAFT_STORAGE_KEY, text)
      }, [text])

      const close = useCallback(function close() {
        runtime.closeOverlay()
      }, [])

      useEffect(function onDocumentEscape() {
        function onDocumentKey(event) {
          if (event.key !== 'Escape') return
          if (event.nativeEvent && event.nativeEvent.isComposing) return
          try {
            event.preventDefault()
            event.stopPropagation()
          } catch (error) {
            /* ignore */
          }
          close()
        }
        document.addEventListener('keydown', onDocumentKey, true)
        return function cleanup() {
          document.removeEventListener('keydown', onDocumentKey, true)
        }
      }, [close])

      const submit = useCallback(function submit() {
        const value = text.trim()
        if (!value || submitting || noteSaving) return
        setError(null)
        runtime
          .capture(value, 'overlay')
          .then(function onOk() {
            try {
              safeWriteStorage(DRAFT_STORAGE_KEY, null)
            } catch (inner) {
              /* ignore */
            }
            triage.refreshAll()
            close()
          })
          .catch(function onError(captureError) {
            setError(errorText(captureError))
            runtime.toast('error', TEXT.saveFailed + '：' + errorText(captureError))
          })
      }, [text, submitting, noteSaving, close])

      const submitNote = useCallback(function submitNote() {
        const value = text.trim()
        if (!value || submitting || noteSaving) return
        const configData = (notes.getState().config && notes.getState().config.data) || null
        if (!configData || configData.exists !== true) {
          setError('还没有配置笔记目录，请先到「设置 → LifeOS → 笔记」里选择目录')
          return
        }
        setError(null)
        setNoteSaving(true)
        notes
          .quickNote(value)
          .then(function onOk() {
            setNoteSaving(false)
            try {
              safeWriteStorage(DRAFT_STORAGE_KEY, null)
            } catch (inner) {
              /* ignore */
            }
            close()
          })
          .catch(function onError(noteError) {
            setNoteSaving(false)
            setError(errorText(noteError))
            runtime.toast('error', '存为笔记失败：' + errorText(noteError))
          })
      }, [text, submitting, noteSaving, close])

      function onKeyDown(event) {
        if (event.key === 'Escape') {
          event.preventDefault()
          close()
          return
        }
        if (event.key === 'Tab') {
          const root = dialogRef.current
          if (!root) return
          const focusables = root.querySelectorAll('textarea, button, input, [tabindex="0"]')
          if (!focusables.length) return
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
      }

      function onKeyDownTextarea(event) {
        if (event.key !== 'Enter') return
        if (event.shiftKey) return
        if (event.nativeEvent && event.nativeEvent.isComposing) return
        if (composingRef.current) return
        event.preventDefault()
        submit()
      }

      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 2147483000,
            background: COLORS.mask,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            paddingTop: 'max(18vh, ' + OVERLAY_TOP + ')',
            pointerEvents: 'auto',
          },
          onMouseDown: function onMaskMouseDown(event) {
            if (event.target === event.currentTarget) close()
          },
        },
        h(
          'div',
          {
            ref: dialogRef,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': OVERLAY_TITLE_ID,
            onKeyDown: onKeyDown,
            style: {
              width: 'min(560px, calc(100vw - 32px))',
              maxHeight: '70vh',
              display: 'flex',
              flexDirection: 'column',
              background: COLORS.bgLayer2,
              color: COLORS.labelPrimary,
              border: '1px solid ' + COLORS.borderL1,
              borderRadius: COLORS.radiusLg,
              boxShadow: COLORS.shadow2,
              fontFamily: COLORS.fontFamily,
              overflow: 'hidden',
            },
          },
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '12px 14px',
                borderBottom: '1px solid ' + COLORS.borderL1,
              },
            },
            h('div', { id: OVERLAY_TITLE_ID, style: Object.assign({}, FONT.tab, { fontWeight: 600 }) }, TEXT.quickCapture),
            h('div', { style: { flex: '1 1 auto' } }),
            h(
              'button',
              {
                type: 'button',
                onClick: close,
                'aria-label': TEXT.cancel,
                style: Object.assign({}, buttonStyle('ghost'), { padding: '2px 10px' }),
              },
              '×',
            ),
          ),
          h('textarea', {
            ref: textareaRef,
            value: text,
            rows: 5,
            placeholder: TEXT.capturePlaceholder,
            'aria-label': TEXT.capturePlaceholder,
            onCompositionStart: function onCompositionStart() {
              composingRef.current = true
            },
            onCompositionEnd: function onCompositionEnd() {
              composingRef.current = false
            },
            onChange: function onChange(event) {
              setText(event.target.value)
            },
            onKeyDown: onKeyDownTextarea,
            style: {
              resize: 'none',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: COLORS.labelPrimary,
              fontFamily: COLORS.fontFamily,
              fontSize: FONT.body.fontSize,
              lineHeight: '22px',
              padding: '12px 14px',
              minHeight: 120,
              boxSizing: 'border-box',
            },
          }),
          error
            ? h(
                'div',
                { role: 'alert', style: Object.assign({}, FONT.caption, { color: COLORS.error, padding: '0 14px 8px' }) },
                error,
              )
            : null,
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 14px',
                borderTop: '1px solid ' + COLORS.borderL1,
              },
            },
            h('div', { style: Object.assign({}, FONT.caption, { color: COLORS.labelTertiary, flex: '1 1 auto' }) }, 'Esc 关闭 · 存为笔记写入当前笔记目录 · 待整理进入整理队列'),
            h(
              'button',
              {
                type: 'button',
                onClick: submitNote,
                disabled: submitting || noteSaving || text.trim() === '',
                style: Object.assign({}, buttonStyle('ghost'), { opacity: submitting || noteSaving || text.trim() === '' ? 0.55 : 1 }),
              },
              noteSaving ? '保存中…' : '存为笔记',
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: submit,
                disabled: submitting || noteSaving || text.trim() === '',
                style: Object.assign({}, buttonStyle('primary'), {
                  opacity: submitting || noteSaving || text.trim() === '' ? 0.55 : 1,
                  cursor: submitting || noteSaving || text.trim() === '' ? 'default' : 'pointer',
                }),
              },
              submitting ? TEXT.loading : '待整理',
            ),
          ),
        ),
      )
    }

    function ToastStack(props) {
      const toasts = Array.isArray(props.toasts) ? props.toasts : []
      if (!toasts.length) return null
      return h(
        'div',
        {
          'aria-live': 'polite',
          style: {
            position: 'fixed',
            right: 24,
            bottom: 24,
            zIndex: 2147483001,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            pointerEvents: 'auto',
            fontFamily: COLORS.fontFamily,
          },
        },
        toasts.map(function mapToast(item) {
          return h(
            'div',
            {
              key: item.id,
              role: 'status',
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                minWidth: 220,
                maxWidth: 360,
                padding: '8px 12px',
                borderRadius: COLORS.radiusMd,
                border: '1px solid ' + COLORS.borderL1,
                borderLeft: '3px solid ' + (item.kind === 'error' ? COLORS.error : COLORS.success),
                background: COLORS.bgLayer2,
                color: COLORS.labelPrimary,
                boxShadow: COLORS.shadow1,
                fontSize: 13,
                lineHeight: '18px',
              },
            },
            h('span', { style: { flex: '1 1 auto' } }, item.text),
            item.action && item.action.label
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: function onAction() {
                      try {
                        if (typeof item.action.run === 'function') item.action.run()
                      } catch (error) {
                        console.error('[lifeos] toast action failed', error)
                      }
                      runtime.dismissToast(item.id)
                    },
                    style: Object.assign({}, buttonStyle('ghost'), { padding: '2px 8px' }),
                  },
                  String(item.action.label),
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                'aria-label': '关闭提示',
                onClick: function onDismiss() {
                  runtime.dismissToast(item.id)
                },
                style: Object.assign({}, buttonStyle('ghost'), { border: 'none', padding: '0 4px' }),
              },
              '×',
            ),
          )
        }),
      )
    }

    /* 全局快速记录（DSH 对话页与 LifeOS 面板共用同一套提交语义）：
       任务 -> POST /tasks（无 listId 即收集箱）；随记 -> 随记/前12字.md 去重保存。 */
    async function lifeosQuickCaptureSubmit(text, target) {
      const value = String(text || '').trim()
      if (!value) throw new Error('内容为空')
      if (target === 'task') {
        await apiRequest('/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ title: value }),
        })
        return { kind: 'task', label: '已加入收集箱' }
      }
      let config = null
      try {
        const current = notes.getState()
        config = current && current.config && current.config.data
      } catch (error) {
        config = null
      }
      if (!config || config.exists !== true) {
        try {
          await notes.loadConfig()
          const current = notes.getState()
          config = current && current.config && current.config.data
        } catch (error) {
          config = null
        }
      }
      if (!config || config.exists !== true) {
        throw new Error('还没有配置笔记目录，请先到「设置 → LifeOS → 笔记」里选择目录')
      }
      try {
        await notes.createFolder('', '随记')
      } catch (error) {
        /* 目录已存在时忽略 */
      }
      const compact = value.replace(/\s+/g, ' ').trim()
      const base = (compact.slice(0, 12).replace(/[\\/:*?"<>|]/g, '').replace(/[. ]+$/g, '').trim()) || '未命名笔记'
      let saved = ''
      let lastError = null
      for (let index = 0; index < 9; index += 1) {
        const name = base + (index === 0 ? '' : '(' + (index + 1) + ')') + '.md'
        try {
          await notesCreateApi('随记/' + name, value + '\n')
          saved = name
          lastError = null
          break
        } catch (error) {
          lastError = error
          const message = String((error && error.message) || '')
          if (!/存在|exist|conflict/i.test(message)) throw error
        }
      }
      if (lastError) throw lastError
      try {
        await notes.loadTree()
      } catch (error) {
        /* ignore */
      }
      return { kind: 'note', label: '已存为随记：' + saved }
    }

    function LifeosOverlay() {
      const [state] = useRuntime(runtime)
      const [previousFocus, setPreviousFocus] = useState(null)

      useEffect(function onOpenChange() {
        if (state.overlayOpen) {
          try {
            setPreviousFocus(document.activeElement)
          } catch (error) {
            setPreviousFocus(null)
          }
        } else {
          try {
            if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus()
          } catch (error) {
            /* ignore */
          }
        }
        return function cleanup() {
          /* 不在这里归还焦点：下一次 open 时更新 */
        }
      }, [state.overlayOpen])

      return h(
        React.Fragment,
        null,
        state.overlayOpen
          ? h(typeof V2HostCaptureDialog === 'function' ? V2HostCaptureDialog : QuickCaptureDialog, { state: state })
          : null,
        h(ToastStack, { toasts: state.toasts }),
      )
    }

    /* ═════════════════════════ 设置页（只读） ═════════════════════════ */

    function InfoRow(props) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            gap: 12,
            padding: '8px 0',
            borderBottom: '1px solid ' + COLORS.borderL1,
            fontSize: 13,
            lineHeight: '20px',
          },
        },
        h('div', { style: { width: 120, flex: 'none', color: COLORS.labelSecondary } }, props.label),
        h('div', { style: { flex: '1 1 auto', minWidth: 0, color: COLORS.labelPrimary, wordBreak: 'break-word' } }, props.value),
      )
    }

    function storageSummary(status) {
      if (!status || typeof status !== 'object') return TEXT.unavailable
      const units = status.units || {}
      const names = Object.keys(units)
      if (!names.length) return status.degraded ? '降级（无 unit）' : TEXT.unknown
      return names
        .map(function mapUnit(name) {
          const unit = units[name] || {}
          return name + '：' + (unit.open ? '已打开' : '未打开') + ' / ' + String(Number(unit.records) || 0) + ' 条'
        })
        .join('；')
    }

    function LifeosSettings() {
      const [state] = useRuntime(runtime)
      const [triageState] = useRuntime(triage)
      const [notesState] = useRuntime(notes)
      const [m3State] = useRuntime(m3)
      const devStatus = state.devStatus
      const [refreshing, setRefreshing] = useState(false)

      const refresh = useCallback(function refresh() {
        setRefreshing(true)
        Promise.all([runtime.refreshDevStatus(), runtime.refreshBootstrap('settings'), triage.refreshAll(), notes.loadConfig(), m3.refreshAll()]).finally(function done() {
          setRefreshing(false)
        })
      }, [])

      useEffect(function onMount() {
        runtime.refreshDevStatus()
        if (!runtime.getState().bootstrap.data) runtime.refreshBootstrap('settings-mount')
        triage.loadAutomation()
        notes.loadConfig()
        m3.loadAutomation()
      }, [])

      const bootstrap = state.bootstrap.data || {}
      const settings = bootstrap.settings || {}
      const diag = devStatus.data || null
      const status = diag && diag.status ? diag.status : diag
      const lastErrors =
        (diag && diag.recentErrors) ||
        (diag && diag.lastErrors) ||
        (status && status.lastErrors) ||
        []
      const sseConnections =
        diag && diag.sseClients !== undefined
          ? diag.sseClients
          : diag && diag.sseConnections !== undefined
            ? diag.sseConnections
            : status && status.sseConnections
      const devModeValue =
        settings.devMode !== undefined
          ? settings.devMode
          : diag && diag.devMode !== undefined
            ? diag.devMode
            : status && status.devMode

      return h(
        'section',
        {
          'aria-label': TEXT.appName,
          style: {
            padding: '20px 24px',
            maxWidth: 760,
            fontFamily: COLORS.fontFamily,
            color: COLORS.labelPrimary,
            background: COLORS.bgBase,
          },
        },
        h('h2', { style: Object.assign({}, FONT.title, { margin: '0 0 4px' }) }, TEXT.settingsTitle),
        h('p', { style: Object.assign({}, FONT.meta, { margin: '0 0 16px', color: COLORS.labelSecondary }) }, TEXT.settingsHint),
        h('div', { style: { marginBottom: 12 } }, h('button', { type: 'button', onClick: refresh, style: buttonStyle('ghost') }, refreshing ? TEXT.loading : TEXT.refresh)),
        devStatus.error && !/forbidden|403|仅开发|devMode|clientSelfCheck/i.test(String(devStatus.error))
          ? h(Banner, { tone: 'warn' }, '诊断接口暂不可用（Host 未就绪）：' + devStatus.error)
          : null,
        h(InfoRow, { label: TEXT.pluginVersion, value: PLUGIN_VERSION }),
        h(InfoRow, { label: TEXT.apiVersion, value: String(bootstrap.apiVersion || TEXT.unknown) }),
        h(InfoRow, { label: TEXT.timeZone, value: String(settings.timeZone || settings.timezone || TEXT.unknown) }),
        h(InfoRow, { label: TEXT.devMode, value: devModeValue ? TEXT.yes : TEXT.no }),
        h(InfoRow, { label: TEXT.storage, value: storageSummary(status) }),
        h(InfoRow, { label: TEXT.counts, value: bootstrap.counts ? JSON.stringify(bootstrap.counts) : TEXT.unknown }),
        h(InfoRow, { label: TEXT.sse, value: sseConnections === undefined || sseConnections === null ? TEXT.unknown : String(sseConnections) }),
        h(InfoRow, {
          label: TEXT.lastError,
          value: Array.isArray(lastErrors) && lastErrors.length ? lastErrors.map(errorText).join('；') : TEXT.no,
        }),
        h(NotesSettingSection, { notes: notes, state: notesState }),
        h(AutomationSettingsSection, { m3: m3, state: m3State }),
        h(
          'p',
          { style: Object.assign({}, FONT.caption, { marginTop: 16, color: COLORS.labelTertiary }) },
          'M2 · 整理工作台：/triage/run、/triage/apply、/triage/correction 与夜间自动整理；Client 自检回传 /dev/client-report。',
        ),
      )
    }

    /* ═════════════════════════ 快捷键 ═════════════════════════ */

    function isQuickCaptureCombo(event) {
      if (!event || event.repeat) return false
      const primary = event.ctrlKey || event.metaKey
      return primary && event.shiftKey && (event.code === 'Space' || event.key === ' ')
    }

    function openQuickCapture() {
      if (typeof window !== 'undefined' && typeof window.__lifeosV2OpenCapture === 'function') {
        try {
          window.__lifeosV2OpenCapture()
          return
        } catch (error) {
          console.warn('[lifeos] V2 快速捕获失败，回退旧浮层：', errorText(error))
        }
      }
      runtime.openOverlay('shortcut')
    }

    function registerShortcut(ctx) {
      let hostShortcut = false
      try {
        const shortcuts = typeof ctx.get === 'function' ? ctx.get('shortcuts') : undefined
        if (shortcuts && typeof shortcuts.register === 'function') {
          ctx.effect(function installShortcut() {
            const defaults = {
              'desktop:windows': { code: 'Space', modifiers: ['primary', 'shift'] },
              'desktop:macos': { code: 'Space', modifiers: ['primary', 'shift'] },
              'desktop:linux': { code: 'Space', modifiers: ['primary', 'shift'] },
              'web:windows': { code: 'Space', modifiers: ['primary', 'shift'] },
              'web:macos': { code: 'Space', modifiers: ['primary', 'shift'] },
              'web:linux': { code: 'Space', modifiers: ['primary', 'shift'] },
            }
            const spec = {
              id: 'lifeos.quick-capture',
              label: function label() {
                return TEXT.quickCapture
              },
              aliases: ['quick capture', 'lifeos', '收件箱'],
              defaults: defaults,
              regions: ['page', 'editable'],
              resolve: function resolve() {
                return {
                  status: 'handled',
                  run: function run() {
                    openQuickCapture()
                  },
                }
              },
            }
            try {
              const disposer = shortcuts.register(spec)
              hostShortcut = true
              return function removeShortcut() {
                try {
                  if (typeof disposer === 'function') disposer()
                } catch (error) {
                  /* ignore */
                }
              }
            } catch (error) {
              console.warn('[lifeos] shortcuts.register 失败，回退 keydown：', errorText(error))
              return undefined
            }
          }, 'lifeos: quick-capture shortcut')
        }
      } catch (error) {
        console.warn('[lifeos] shortcuts 服务不可用，回退 keydown：', errorText(error))
      }

      ctx.effect(function installKeydownFallback() {
        function onKeyDown(event) {
          if (hostShortcut) return
          if (!isQuickCaptureCombo(event)) return
          try {
            event.preventDefault()
            event.stopPropagation()
          } catch (error) {
            /* ignore */
          }
          openQuickCapture()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return function removeKeydown() {
          window.removeEventListener('keydown', onKeyDown, true)
        }
      }, 'lifeos: quick-capture keydown fallback')
    }

    /*
     * M1 验收自检：在浏览器里把 M1 的 HTTP 契约跑一遍（task CRUD/状态机/CAS/视图/日历/项目/ui-prefs），
     * 结果随 client-report 回传，最后用 dev cleanup 清掉自检数据。
     * 仅 clientSelfCheck=true 时执行；这是验证期能力，不是产品行为。
     */

    /*
     * M2 验收自检：在浏览器里跑一遍整理管道（capture→triage.run→pending→apply→correct→reprocess→automation），
     * 结果随 client-report 回传，最后 dev cleanup 清掉自检数据（含派生对象/证据链/run）。
     * 仅 clientSelfCheck=true 时执行；验证期能力，不是产品行为。
     */

    /*
     * M0 门禁自检（G4/G5 的浏览器端取证）：
     * Client 半身激活即做一次 bootstrap → SSE(hello/changed) → capture → cleanup → 回传，
     * 不需要用户打开面板。仅当 Host 的 bootstrap.flags.clientSelfCheck 为 true 时执行；
     * 这是验证期能力（Host 配置关闭后不再运行），不是产品行为。
     */
    let activationProbeStarted = false




    /** 激活时上报一次 bootstrap 结果（供诊断/验收取证）；不再运行旧版 M1–M4 自检。 */
    function runActivationSelfCheck() {
      const w = typeof window !== 'undefined' ? window : null
      if (!w || activationProbeStarted) return
      activationProbeStarted = true
      const sleep = function (ms) {
        return new Promise(function (resolve) {
          setTimeout(resolve, ms)
        })
      }
      sleep(1500)
        .then(function () {
          return fetch(apiUrl('/bootstrap'), { headers: { accept: 'application/json' } })
        })
        .then(function (response) {
          return response.json()
        })
        .then(function (body) {
          const value = body && body.value ? body.value : null
          reportClient({
            phase: 'activation-bootstrap',
            at: new Date().toISOString(),
            bootstrapOk: !!(body && body.ok === true),
            counts: value ? value.counts : null,
            flags: (value && value.flags) || {},
            degraded: !!(value && value.degraded === true),
            backend: value && value.backend ? value.backend : null,
          })
        })
        .catch(function (error) {
          reportClient({
            phase: 'activation-error',
            at: new Date().toISOString(),
            error: String(error && error.message ? error.message : error),
          })
        })
    }

    /* ==== V2-MODULES-START ==== */
/* ---- 00-core.js (191 lines) ---- */
/* ═══════════════════════ M6 · V2 客户端公共层 ═══════════════════════ */
/* 说明：本文件由 scripts/build-v2.mjs 内联到 client.js 的 V2-MODULES 区段；
   与旧 UI 共用同一 factory 作用域（h/React/apiRequest/COLORS/FONT/runtime 等可直接用）。 */

const V2_TABS = [
  { id: 'task', label: '任务' },
  { id: 'calendar', label: '日历' },
  { id: 'habit', label: '习惯' },
  { id: 'notes', label: '笔记' },
]

function v2UiEnabled() {
  try {
    return window.localStorage.getItem('lifeos.uiVersion') !== 'legacy'
  } catch (error) {
    return true
  }
}

/* ── 图标（线性 SVG，24×24 stroke） ── */
const V2_ICON_PATHS = {
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  chevronDown: ['M6 9l6 6 6-6'],
  chevronRight: ['M9 6l6 6-6 6'],
  chevronLeft: ['M15 6l-6 6 6 6'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  calendar: ['M7 3v4', 'M17 3v4', 'M4 8h16', 'M5 5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'],
  inbox: ['M4 5h16v14H4z', 'M4 13h5l2 3h2l2-3h5'],
  layers: ['M12 3l9 5-9 5-9-5 9-5z', 'M3 13l9 5 9-5'],
  flag: ['M5 21V4', 'M5 4h12l-2 4 2 4H5'],
  filter: ['M3 5h18', 'M7 12h10', 'M10 19h4'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 14h10l1-14', 'M10 11v6', 'M14 11v6'],
  done: ['M4 6h10', 'M4 12h7', 'M4 18h10', 'M14 16l3 3 5-5'],
  tag: ['M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9z', 'M8 8h.01'],
  drag: ['M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01'],
  text: ['M5 6h14', 'M12 6v13', 'M8 19h8'],
  bell: ['M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6', 'M10 20a2 2 0 0 0 4 0'],
  repeat: ['M4 12V9a4 4 0 0 1 4-4h9', 'M14 2l3 3-3 3', 'M20 12v3a4 4 0 0 1-4 4H7', 'M10 22l-3-3 3-3'],
  leaf: ['M20 4c-9 1-14 6-14 12 0 2 1 4 2 4 6 0 11-5 12-16z', 'M5 19c2-5 5-8 10-10'],
  back: ['M9 14l-4-4 4-4', 'M5 10h11a4 4 0 0 1 0 8h-1'],
  edit: ['M4 20h4L20 8l-4-4L4 16v4z', 'M14 6l4 4'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  board: ['M4 4h7v16H4z', 'M13 4h7v10h-7z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M16 16l5 5'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v5h5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-4l-.4 2.5a7 7 0 0 0-1.7 1l-2.3-1-2 3.4L6 11a7 7 0 0 0 0 2l-2 1.6 2 3.4 2.3-1a7 7 0 0 0 1.7 1L10.5 21h4l.4-2.5a7 7 0 0 0 1.7-1l2.3 1 2-3.4L19 13a7 7 0 0 0 .1-1z'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
  pin: ['M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6z', 'M12 15v6'],
  chev: ['M9 6l6 6-6 6'],
  chevD: ['M6 9l6 6 6-6'],
  chevL: ['M15 6l-6 6 6 6'],
  chevR: ['M9 6l6 6-6 6'],
  arrowLeft: ['M19 12H5', 'M11 6l-6 6 6 6'],
  arrowRight: ['M5 12h14', 'M13 6l6 6-6 6'],
  move: ['M12 3v18', 'M8 7l4-4 4 4', 'M8 17l4 4 4-4', 'M3 12h18', 'M7 8l-4 4 4 4', 'M17 8l4 4-4 4'],
  subtask: ['M6 6h6', 'M6 12h10', 'M12 18h8', 'M4 4v14a2 2 0 0 0 2 2'],
  copy: ['M8 8h12v12H8z', 'M4 16V4h12'],
  sun: ['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M12 1v3', 'M12 20v3', 'M4.2 4.2l2 2', 'M17.8 17.8l2 2', 'M1 12h3', 'M20 12h3', 'M4.2 19.8l2-2', 'M17.8 6.2l2-2'],
}

function V2Icon(props) {
  const name = props && props.name
  const size = (props && props.size) || 16
  const color = (props && props.color) || 'currentColor'
  const strokeWidth = (props && props.strokeWidth) || 1.7
  const paths = V2_ICON_PATHS[name] || V2_ICON_PATHS.text
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: color,
      strokeWidth,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style: { flex: '0 0 auto', display: 'block', pointerEvents: 'none' },
      'aria-hidden': 'true',
    },
    paths.map(function renderPath(d, index) {
      return h('path', { key: index, d })
    }),
  )
}

/* ── 基础样式 ── */
const V2 = {
  text: COLORS.labelPrimary,
  sub: COLORS.labelSecondary,
  faint: COLORS.labelTertiary,
  line: COLORS.borderL1,
  hover: COLORS.hover,
  active: COLORS.active,
  accent: COLORS.brand,
  success: COLORS.success,
  warn: COLORS.warn,
  danger: COLORS.error,
  bg: COLORS.bgBase,
  panel: COLORS.bgLayer1,
  panel2: COLORS.bgLayer2,
  bgElevated: COLORS.bgLayer2,
}

function v2InputStyle(extra) {
  return Object.assign(
    {
      width: '100%',
      boxSizing: 'border-box',
      background: 'transparent',
      border: 'none',
      outline: 'none',
      color: V2.text,
      fontFamily: COLORS.fontFamily,
      fontSize: 13,
      padding: '6px 8px',
      borderRadius: 6,
    },
    extra || {},
  )
}

function v2BtnStyle(kind, extra) {
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: '1px solid transparent',
    background: 'transparent',
    color: V2.sub,
    fontFamily: COLORS.fontFamily,
    fontSize: 12,
    lineHeight: '18px',
    padding: '5px 8px',
    borderRadius: 7,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }
  if (kind === 'primary') {
    return Object.assign(base, { background: V2.accent, borderColor: V2.accent, color: '#fff' }, extra || {})
  }
  if (kind === 'soft') {
    return Object.assign(base, { background: V2.hover, color: V2.text }, extra || {})
  }
  if (kind === 'danger') {
    return Object.assign(base, { color: V2.danger }, extra || {})
  }
  return Object.assign(base, extra || {})
}

function v2DividerStyle(extra) {
  return Object.assign({ height: 1, background: V2.line, flex: '0 0 auto', opacity: 0.7 }, extra || {})
}

function v2DateLabel(dateKey) {
  if (!dateKey) return ''
  const today = todayIso()
  if (dateKey === today) return '今天'
  if (dateKey === addDaysKey(today, 1)) return '明天'
  if (dateKey === addDaysKey(today, -1)) return '昨天'
  return String(dateKey).slice(5).replace('-', '/')
}

function v2TaskDateText(task) {
  if (!task) return ''
  if (task.dueDate) return '截止 ' + v2DateLabel(task.dueDate)
  if (task.scheduledStartAt) {
    try {
      const date = new Date(task.scheduledStartAt)
      const month = date.getMonth() + 1
      const day = date.getDate()
      const hour = String(date.getHours()).padStart(2, '0')
      const minute = String(date.getMinutes()).padStart(2, '0')
      return month + '/' + day + ' ' + hour + ':' + minute
    } catch (error) {
      return ''
    }
  }
  if (task.scheduledDate) return v2DateLabel(task.scheduledDate)
  return ''
}

function v2PriorityClass(priority) {
  return 'v2-pri-' + (priority || 'none')
}

/* ---- 05-tokens.js (149 lines) ---- */
/* ═══════════════════════ UI/UX · A2 轻量卡片设计 token ═══════════════════════
 * 方向：A2 轻量卡片（2026-11-19 用户选定）
 * 原则：深色底 + 明度分层圆角卡片 + 品牌蓝强调；0 新依赖；仅使用内联样式对象。
 * 本文件在 build-v2 中排在 00-core 之后、10-shell 之前，可直接引用 V2 / COLORS。
 */

const V2_T = {
  space: { x1: 4, x2: 8, x3: 12, x4: 16, x5: 20, x6: 24, x7: 32 },
  radius: { sm: 8, md: 10, lg: 12, xl: 16, pill: 999 },
  font: { caption: 11, meta: 12, body: 13, title: 15, hero: 18 },
  line: { hair: 1, row: 40, header: 52, input: 34 },
  surface: {
    app: '#0e131c',
    shell: '#101722',
    side: '#121a26',
    panel: '#172030',
    panel2: '#1c2739',
    panel3: '#233047',
    input: '#121a27',
    overlay: 'rgba(4,8,14,0.62)',
  },
  border: { subtle: '#2a374c', strong: '#35455f' },
  accent: { base: '#6ea8fe', soft: 'rgba(110,168,254,0.16)', line: 'rgba(110,168,254,0.5)' },
  text: { primary: '#eaf0fb', secondary: '#b3c0d6', tertiary: '#8190a8' },
  status: {
    success: '#62dfae',
    successSoft: 'rgba(98,223,174,0.12)',
    warn: '#f5cd79',
    warnSoft: 'rgba(245,205,121,0.12)',
    danger: '#ff8a8a',
    dangerSoft: 'rgba(255,138,138,0.12)',
    violet: '#c09bff',
    violetSoft: 'rgba(192,155,255,0.12)',
  },
  shadow: {
    card: '0 2px 6px rgba(2,6,14,0.28)',
    raised: '0 10px 30px rgba(2,6,14,0.35)',
    pop: '0 18px 48px rgba(0,0,0,0.55)',
  },
  motion: { fast: 120, base: 180, slow: 240 },
}

/* 把 A2 token 写回 V2，旧组件里引用 V2.* 的地方整体跟随 A2。 */
Object.assign(V2, {
  text: V2_T.text.primary,
  sub: V2_T.text.secondary,
  faint: V2_T.text.tertiary,
  line: V2_T.border.subtle,
  hover: 'rgba(255,255,255,0.06)',
  active: V2_T.accent.soft,
  accent: V2_T.accent.base,
  success: V2_T.status.success,
  warn: V2_T.status.warn,
  danger: V2_T.status.danger,
  bg: V2_T.surface.app,
  panel: V2_T.surface.shell,
  panel2: V2_T.surface.panel,
  bgElevated: V2_T.surface.panel2,
  card: V2_T.surface.panel,
  cardHover: V2_T.surface.panel2,
  cardActive: V2_T.surface.panel3,
  borderStrong: V2_T.border.strong,
  accentSoft: V2_T.accent.soft,
  accentLine: V2_T.accent.line,
  successSoft: V2_T.status.successSoft,
  warnSoft: V2_T.status.warnSoft,
  dangerSoft: V2_T.status.dangerSoft,
  shadowCard: V2_T.shadow.card,
  shadowRaised: V2_T.shadow.raised,
  shadowPop: V2_T.shadow.pop,
  radiusSm: V2_T.radius.sm,
  radiusMd: V2_T.radius.md,
  radiusLg: V2_T.radius.lg,
  rowH: V2_T.line.row,
})

/* 卡片：任务分组、详情区块、统计卡、日历面板等统一使用。 */
function v2CardStyle(extra) {
  return Object.assign(
    {
      background: V2_T.surface.panel,
      border: '1px solid ' + V2_T.border.subtle,
      borderRadius: V2_T.radius.lg,
      boxShadow: V2_T.shadow.card,
    },
    extra || {},
  )
}

/* 浮起卡片：hover / 选中态 / 详情行。 */
function v2RaisedStyle(extra) {
  return Object.assign(
    {
      background: V2_T.surface.panel2,
      border: '1px solid ' + V2_T.border.strong,
      borderRadius: V2_T.radius.md,
      boxShadow: V2_T.shadow.card,
    },
    extra || {},
  )
}

/* 强调色浅底胶囊 / 选中导航项。 */
function v2AccentPillStyle(extra) {
  return Object.assign(
    {
      background: V2_T.accent.soft,
      color: V2_T.accent.base,
      border: '1px solid ' + V2_T.accent.line,
      borderRadius: V2_T.radius.sm,
    },
    extra || {},
  )
}

/* 可见 focus 环（键盘可达性；满足“焦点必须可见”）。 */
function v2FocusRing(extra) {
  return Object.assign(
    {
      outline: 'none',
      boxShadow: '0 0 0 2px ' + V2_T.accent.soft + ', 0 0 0 1px ' + V2_T.accent.base,
    },
    extra || {},
  )
}

/* 段落级排版 token。 */
function v2TextStyle(kind) {
  const map = {
    caption: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary, lineHeight: '16px' },
    meta: { fontSize: V2_T.font.meta, color: V2_T.text.tertiary, lineHeight: '18px' },
    body: { fontSize: V2_T.font.body, color: V2_T.text.primary, lineHeight: '20px' },
    sub: { fontSize: V2_T.font.body, color: V2_T.text.secondary, lineHeight: '20px' },
    title: { fontSize: V2_T.font.title, color: V2_T.text.primary, fontWeight: 600, lineHeight: '22px' },
    hero: { fontSize: V2_T.font.hero, color: V2_T.text.primary, fontWeight: 600, lineHeight: '26px' },
  }
  return map[kind] || map.body
}

function v2PageBgStyle(extra) {
  return Object.assign(
    {
      background: V2_T.surface.app,
      color: V2_T.text.primary,
    },
    extra || {},
  )
}

/* ---- 10-shell.js (1046 lines) ---- */
/* ═══════════════════════ M6 · V2 外壳 ═══════════════════════ */

const V2_TAB_STORAGE_KEY = 'lifeos.v2.tab'
let v2M6ProbeStarted = false

function readV2Tab() {
  try {
    if (v2ReadSettings().restoreLastTab === false) return 'task'
    const raw = window.localStorage.getItem(V2_TAB_STORAGE_KEY)
    if (raw && V2_TABS.some(function find(tab) { return tab.id === raw })) return raw
  } catch (error) {
    /* ignore */
  }
  return 'task'
}

function writeV2Tab(tab) {
  try {
    window.localStorage.setItem(V2_TAB_STORAGE_KEY, tab)
  } catch (error) {
    /* ignore */
  }
}

function V2TabIcon(props) {
  const id = props.id
  const map = { task: 'done', calendar: 'calendar', habit: 'leaf', notes: 'text' }
  return h(V2Icon, { name: map[id] || 'text', size: 15 })
}

function V2MissingTab(props) {
  return h(
    'div',
    {
      style: {
        flex: '1 1 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: V2.sub,
        fontSize: 13,
      },
    },
    (props && props.label ? props.label : '') + ' 模块未加载，请刷新页面或重启 DSH。',
  )
}

/** V2 模块整体不可用时的兜底面板（旧版面板已移除，不再静默回退）。 */
function V2UnavailablePanel() {
  return h(
    'div',
    {
      'data-lifeos-v2': '1',
      style: {
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: COLORS.bgBase,
        color: COLORS.labelPrimary,
        fontFamily: COLORS.fontFamily,
        padding: 24,
        boxSizing: 'border-box',
      },
    },
    h('div', { style: { maxWidth: 520, fontSize: 13, lineHeight: 1.7 } }, 'LifeOS 界面未能加载。请完全退出 DSH 后重新打开；若问题持续，请反馈该提示与 DSH 版本。'),
  )
}

function LifeosPanelV2() {
  const [runtimeState] = useRuntime(runtime)
  const [boardState] = useRuntime(board)
  const [triageState] = useRuntime(triage)
  const [notesState] = useRuntime(notes)
  const [m3State] = useRuntime(m3)
  const [m4State] = useRuntime(m4)
  const narrow = useIsNarrow()
  const [tab, setTab] = useState(readV2Tab)
  const [quickAddSignal, setQuickAddSignal] = useState(0)
  const [moreOpen, setMoreOpen] = useState(false)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [captureTarget, setCaptureTarget] = useState('task')
  const [captureText, setCaptureText] = useState('')
  const [captureSaving, setCaptureSaving] = useState(false)
  const [captureBump, setCaptureBump] = useState(0)

  useEffect(function onMount() {
    runtime.report('panel-mount-v2')
    runtime.refreshBootstrap('panel-mount')
    runtime.refreshInbox('panel-mount')
    runtime.startEvents()
    runtime.setChangeHandler(function onHostChange(reason, payload) {
      board.onExternalChange(reason)
      triage.onExternalChange(reason)
      notes.onExternalChange(reason, payload)
      m3.onExternalChange(reason, payload)
      m4.onExternalChange(reason, payload)
      if (reason === 'hello') m3.refreshAll()
    })
    board.init()
    triage.init()
    notes.init()
    m3.init()
    m4.init()
    return function onUnmount() {
      try {
        runtime.setChangeHandler(null)
      } catch (error) {
        /* ignore */
      }
      runtime.stopEvents()
    }
  }, [])

  useEffect(function persistTab() {
    writeV2Tab(tab)
  }, [tab])

  const tabRef = useRef(tab)
  tabRef.current = tab

  useEffect(function exposeDebugHandle() {
    if (typeof window === 'undefined') return undefined
    window.__lifeosV2Debug = {
      version: 2,
      setTab: function setTabFromDebug(id) {
        if (V2_TABS.some(function find(item) { return item.id === id })) setTab(id)
      },
      getTab: function getTabFromDebug() {
        return tabRef.current
      },
    }
    return function cleanup() {
      try {
        delete window.__lifeosV2Debug
      } catch (error) {
        window.__lifeosV2Debug = null
      }
    }
  }, [])

  useEffect(function exposeCaptureBridge() {
    if (typeof window === 'undefined') return undefined
    window.__lifeosV2OpenCapture = function openCaptureFromHost() {
      setCaptureOpen(true)
    }
    return function cleanup() {
      try {
        delete window.__lifeosV2OpenCapture
      } catch (error) {
        window.__lifeosV2OpenCapture = null
      }
    }
  }, [])

  useEffect(function globalKeys() {
    function isEditable(target) {
      if (!target) return false
      const tagName = String(target.tagName || '').toUpperCase()
      return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || target.isContentEditable === true
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        if (captureOpen) {
          setCaptureOpen(false)
          event.preventDefault()
          return
        }
        if (moreOpen) {
          setMoreOpen(false)
          event.preventDefault()
          return
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.altKey && (event.key === 'n' || event.key === 'N')) {
        event.preventDefault()
        setCaptureOpen(true)
        return
      }
      if (isEditable(event.target)) return
      if (event.nativeEvent && event.nativeEvent.isComposing) return
      if (event.key === 'n' || event.key === 'N') {
        event.preventDefault()
        if (tab !== 'task') setTab('task')
        setQuickAddSignal(function bump(value) { return value + 1 })
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return function cleanup() {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [tab, moreOpen, captureOpen])

  function openMoreMenu(event) {
    setMoreOpen(false)
    const rect = event && event.currentTarget ? event.currentTarget.getBoundingClientRect() : null
    const items = [
      { label: '刷新数据', icon: 'refresh', onClick: function refresh() { runtime.refreshAll('v2-menu'); board.init() } },
      { label: '搜索任务', icon: 'search', onClick: function focusSearch() { setTab('task'); setQuickAddSignal(function bump(v) { return v + 1 }) } },
      {
        label: '运行界面自检',
        icon: 'check',
        onClick: function runSelfCheck() {
          try {
            Promise.resolve(runM6SelfCheck(true)).then(function done(result) {
              const ok = result && result.ok === true
              const skipped = result && result.skipped === true
              if (typeof runtime.toast === 'function') {
                const message = skipped ? '界面自检已跳过' : ok ? '界面自检通过，结果已回传' : '界面自检未通过，详情见 runtime-client-report.json'
                runtime.toast(ok ? 'success' : 'error', message)
              }
            }).catch(function failed() {
              if (typeof runtime.toast === 'function') runtime.toast('error', '界面自检执行失败')
            })
          } catch (error) {
            if (typeof runtime.toast === 'function') runtime.toast('error', '界面自检执行失败')
          }
        },
      },
    ]
    openV2Menu(document.body, rect ? rect.right - 160 : 20, rect ? rect.bottom + 6 : 60, items)
  }

  function openV2Menu(root, x, y, items) {
    const wrapper = document.createElement('div')
    wrapper.style.position = 'fixed'
    wrapper.style.left = Math.max(8, Math.min(x, window.innerWidth - 200)) + 'px'
    wrapper.style.top = Math.max(8, y) + 'px'
    wrapper.style.zIndex = '99999'
    wrapper.style.background = COLORS.bgElevated || COLORS.bgBase
    wrapper.style.border = '1px solid ' + V2.line
    wrapper.style.borderRadius = '10px'
    wrapper.style.padding = '4px'
    wrapper.style.boxShadow = '0 12px 32px rgba(0,0,0,0.35)'
    wrapper.style.minWidth = '170px'
    let closed = false
    function close() {
      if (closed) return
      closed = true
      if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper)
      document.removeEventListener('mousedown', onOutside, true)
      document.removeEventListener('keydown', onEsc, true)
    }
    function onOutside(e) {
      if (!wrapper.contains(e.target)) close()
    }
    function onEsc(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    items.forEach(function render(item) {
      if (!item) return
      if (item.type === 'separator') {
        const sep = document.createElement('div')
        sep.style.height = '1px'
        sep.style.background = V2.line
        sep.style.margin = '4px 6px'
        wrapper.appendChild(sep)
        return
      }
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.style.display = 'flex'
      btn.style.alignItems = 'center'
      btn.style.gap = '8px'
      btn.style.width = '100%'
      btn.style.background = 'transparent'
      btn.style.border = 'none'
      btn.style.color = item.danger ? V2.danger : V2.text
      btn.style.fontFamily = COLORS.fontFamily
      btn.style.fontSize = '12px'
      btn.style.padding = '7px 10px'
      btn.style.borderRadius = '7px'
      btn.style.cursor = 'pointer'
      btn.style.textAlign = 'left'
      btn.textContent = item.label
      btn.addEventListener('mouseenter', function enter() { btn.style.background = V2.hover })
      btn.addEventListener('mouseleave', function leave() { btn.style.background = 'transparent' })
      btn.addEventListener('click', function click() {
        close()
        try {
          item.onClick()
        } catch (error) {
          runtime.toast('error', '操作失败：' + errorText(error))
        }
      })
      wrapper.appendChild(btn)
    })
    document.body.appendChild(wrapper)
    setTimeout(function bind() {
      document.addEventListener('mousedown', onOutside, true)
      document.addEventListener('keydown', onEsc, true)
    }, 0)
  }

  useEffect(function m6SelfCheckProbe() {
    if (v2M6ProbeStarted) return undefined
    v2M6ProbeStarted = true
    let disposed = false
    let attempts = 0
    let timer = null
    function panelVisible() {
      try {
        if (typeof document === 'undefined' || document.visibilityState !== 'visible') return false
        const root = document.querySelector('[data-lifeos-v2="1"]')
        if (!root) return false
        const rect = root.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      } catch (error) {
        return false
      }
    }
    function attempt() {
      if (disposed) return
      attempts += 1
      if (!panelVisible() && attempts < 30) {
        timer = setTimeout(attempt, 1000)
        return
      }
      timer = setTimeout(function run() {
        if (!disposed) runM6SelfCheck()
      }, attempts === 1 ? 2200 : 600)
    }
    timer = setTimeout(attempt, 2200)
    return function cleanup() {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  function closeCapture() {
    setCaptureOpen(false)
    setCaptureText('')
    setCaptureSaving(false)
  }

  function captureNoteName(text) {
    const compact = String(text || '').replace(/\s+/g, ' ').trim()
    const first = compact.slice(0, 12)
    const cleaned = first.replace(/[\\/:*?"<>|]/g, '').replace(/[. ]+$/g, '').trim()
    return cleaned || '未命名笔记'
  }

  async function submitCapture() {
    const text = String(captureText || '').trim()
    if (!text || captureSaving) return
    setCaptureSaving(true)
    try {
      if (captureTarget === 'task') {
        await apiRequest('/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ title: text }),
        })
        setCaptureBump(function bump(value) { return value + 1 })
        setCaptureText('')
        runtime.toast('success', '已加入收集箱')
      } else {
        try {
          await notes.createFolder('', '随记')
        } catch (error) {
          /* 目录已存在时忽略 */
        }
        const base = captureNoteName(text)
        let saved = ''
        let lastError = null
        for (let index = 0; index < 9; index += 1) {
          const name = base + (index === 0 ? '' : '(' + (index + 1) + ')') + '.md'
          try {
            await notesCreateApi('随记/' + name, text + '\n')
            saved = name
            lastError = null
            break
          } catch (error) {
            lastError = error
            const message = String((error && error.message) || '')
            if (!/存在|exist|conflict/i.test(message)) break
          }
        }
        if (lastError) throw lastError
        try {
          await notes.loadTree()
        } catch (error) {
          /* ignore */
        }
        setCaptureText('')
        runtime.toast('success', '已存为随记：' + saved)
      }
    } catch (error) {
      runtime.toast('error', (captureTarget === 'task' ? '创建失败：' : '保存失败：') + errorText(error))
    } finally {
      setCaptureSaving(false)
    }
  }

  // S2：Host 存储降级时给出常驻提示，避免用户以为“修改成功”。
  const hostBootstrap = (runtimeState.bootstrap && runtimeState.bootstrap.data) || null
  const degraded = !!(hostBootstrap && hostBootstrap.degraded === true)
  const storeBackend = hostBootstrap && hostBootstrap.backend ? String(hostBootstrap.backend) : 'unknown'

  const tabDefs = V2_TABS
  const content =
    tab === 'task'
      ? h(TaskTabV2, {
          runtime: runtime,
          refreshSignal: ((runtimeState.sse && runtimeState.sse.changedCount) || 0) + captureBump,
          quickAddSignal: quickAddSignal,
          narrow: narrow,
        })
      : tab === 'calendar'
        ? h(
            'div',
            { style: { flex: '1 1 auto', minHeight: 0, overflow: 'hidden', display: 'flex' } },
            typeof CalendarTabV2 === 'function'
              ? h(CalendarTabV2, { runtime: runtime, narrow: narrow })
              : h(V2MissingTab, { label: '日历' }),
          )
        : tab === 'habit'
          ? h(
              'div',
              { style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' } },
              typeof HabitTabV2 === 'function'
                ? h(HabitTabV2, { runtime: runtime, narrow: narrow })
                : h(V2MissingTab, { label: '习惯' }),
            )
          : h(
              'div',
              { style: { flex: '1 1 auto', minHeight: 0, minWidth: 0, overflow: 'hidden', display: 'flex', position: 'relative' } },
              typeof NotesTabV2 === 'function'
                ? h(NotesTabV2, { runtime: runtime, notes: notes, notesState: notesState, narrow: narrow })
                : h(V2MissingTab, { label: '笔记' }),
            )

  return h(
    'section',
    {
      'aria-label': 'LifeOS',
      'data-lifeos-v2': '1',
      style: {
        height: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        background: V2_T.surface.app,
        color: V2_T.text.primary,
        fontFamily: COLORS.fontFamily,
        paddingTop: TOP_CLEARANCE,
        minHeight: 0,
      },
    },
    h(
      'header',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 16px',
          borderBottom: '1px solid ' + V2_T.border.subtle,
          background: V2_T.surface.shell,
          flex: '0 0 auto',
          minHeight: V2_T.line.header,
        },
      },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 auto', minWidth: 0 } },
        tabDefs.map(function renderTab(def) {
          const active = tab === def.id
          return h(
            'button',
            {
              key: def.id,
              type: 'button',
              'data-v2-tab': def.id,
              'data-v2-active': active ? '1' : '0',
              onClick: function onClick() { setTab(def.id) },
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '8px 15px',
                border: active ? '1px solid ' + V2_T.accent.line : '1px solid transparent',
                background: active ? V2_T.accent.soft : 'transparent',
                color: active ? V2_T.accent.base : V2_T.text.secondary,
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                fontFamily: COLORS.fontFamily,
                borderRadius: V2_T.radius.md,
                cursor: 'pointer',
                position: 'relative',
                transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
              },
            },
            h(V2TabIcon, { id: def.id }),
            def.label,
          )
        }),
      ),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto' } },
        h(
          'button',
          {
            type: 'button',
            onClick: function quickCapture() { setCaptureOpen(true) },
            style: v2BtnStyle('soft', {
              gap: 7,
              height: 32,
              padding: '0 12px',
              borderRadius: V2_T.radius.md,
              background: V2_T.surface.panel2,
              border: '1px solid ' + V2_T.border.subtle,
              color: V2_T.text.primary,
            }),
            title: '快速记录',
          },
          h(V2Icon, { name: 'plus', size: 14 }),
          '快速记录',
          h('span', { style: { color: V2.faint, fontSize: 10, marginLeft: 2 } }, '⌘⇧Space'),
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: openMoreMenu,
            style: v2BtnStyle('ghost'),
            title: '更多',
          },
          h(V2Icon, { name: 'more', size: 16 }),
        ),
      ),
    ),
    degraded
      ? h(
          'div',
          {
            role: 'status',
            style: {
              flex: '0 0 auto',
              padding: '7px 12px',
              background: '#3a2c12',
              borderBottom: '1px solid #6b5423',
              color: '#f6c453',
              fontSize: 12,
              lineHeight: 1.5,
            },
          },
          '存储降级为只读模式（' + storeBackend + '）：当前修改不会保存。请检查数据目录/备份后完整重启 DSH。',
        )
      : null,
    h(
      'div',
      {
        'data-v2-content': '1',
        style: {
          flex: '1 1 auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          overflow: 'hidden',
        },
      },
      content,
    ),
    captureOpen ? h(V2HostCaptureDialog, { onClose: closeCapture, onSaved: function onCaptured() { setCaptureBump(function bump(v) { return v + 1 }) } }) : null,
  )
}

/* V2 渲染失败时自动回退旧版面板，避免整个主面板白屏 */
class V2PanelBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error: error }
  }

  componentDidCatch(error) {
    try {
      window.__lifeosV2Crashed = String((error && error.message) || error || 'unknown')
    } catch (inner) {
      /* ignore */
    }
    try {
      console.error('[lifeos] V2 panel crashed', error)
    } catch (inner) {
      /* ignore */
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    // S3：V2 崩溃必须给出可见提示，不允许静默回退/白屏。
    const message = String((this.state.error && this.state.error.message) || this.state.error || '未知错误')
    return h(
      'div',
      {
        style: {
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: COLORS.bgBase,
          color: COLORS.labelPrimary,
          fontFamily: COLORS.fontFamily,
          padding: 24,
          boxSizing: 'border-box',
        },
      },
      h(
        'div',
        {
          style: {
            maxWidth: 560,
            width: '100%',
            padding: 20,
            borderRadius: 12,
            border: '1px solid ' + V2.line,
            background: COLORS.bgLayer1 || COLORS.bgBase,
          },
        },
        h('div', { style: { fontSize: 16, fontWeight: 600, marginBottom: 8 } }, 'LifeOS 界面加载失败'),
        h(
          'div',
          { style: { fontSize: 13, color: V2.sub, lineHeight: 1.6, wordBreak: 'break-word' } },
          message,
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' } },
          h(
            'button',
            {
              type: 'button',
              onClick: function reloadPage() {
                try {
                  window.location.reload()
                } catch (error) {
                  /* ignore */
                }
              },
              style: v2BtnStyle('primary'),
            },
            '刷新页面',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: function copyError() {
                try {
                  if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText('[LifeOS] ' + message)
                  }
                } catch (error) {
                  /* ignore */
                }
              },
              style: v2BtnStyle('ghost'),
            },
            '复制错误信息',
          ),
        ),
      ),
    )
  }
}

function LifeosMainV2() {
  return h(V2PanelBoundary, null, h(LifeosPanelV2))
}

/*
 * M6 浏览器自检：仅 clientSelfCheck=true 时由 V2 面板挂载后触发。
 * 验证 V2 外壳已挂载、四个 Tab 按钮齐全、逐个切换不崩溃、主内容存在；
 * 结果直接回传 /dev/client-report（phase=m6-selfcheck），供 M6f 门禁取证。
 */
async function runM6SelfCheck(force) {
  const steps = []
  const push = function (name, ok, detail) {
    steps.push({ name: name, ok: ok === true, detail: detail === undefined ? null : detail })
  }
  const wait = function (ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms)
    })
  }
  let flags = {}
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(apiUrl('/bootstrap'), { headers: { accept: 'application/json' } })
      const payload = await response.json()
      flags = (payload && payload.value && payload.value.flags) || {}
      if (flags && flags.clientSelfCheck === true) break
    } catch (error) {
      flags = {}
    }
    await wait(700)
  }
  if ((!flags || flags.clientSelfCheck !== true) && force !== true) return { skipped: true, reason: 'clientSelfCheck=false' }
  let root = null
  let buttons = []
  for (let attempt = 0; attempt < 10; attempt += 1) {
    root = document.querySelector('[data-lifeos-v2="1"]')
    buttons = Array.prototype.slice.call(document.querySelectorAll('[data-v2-tab]'))
    if (root && buttons.length === 4) break
    await wait(400)
  }
  try {
    push('v2.root', !!root, { mounted: !!root })
    push('v2.tabs', buttons.length === 4, {
      count: buttons.length,
      ids: buttons.map(function (item) { return item.getAttribute('data-v2-tab') }),
    })
    const saved = buttons.filter(function (item) { return item.getAttribute('data-v2-active') === '1' })[0]
    const savedId = saved ? saved.getAttribute('data-v2-tab') : ((window.__lifeosV2Debug && window.__lifeosV2Debug.getTab && window.__lifeosV2Debug.getTab()) || 'task')
    const setTabExternal = function (id) {
      const debug = window && window.__lifeosV2Debug
      if (debug && typeof debug.setTab === 'function') {
        try {
          debug.setTab(id)
          return 'debug'
        } catch (error) {
          /* fall through */
        }
      }
      const target = document.querySelector('[data-v2-tab="' + id + '"]')
      if (target) {
        try {
          target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
          return 'event'
        } catch (error) {
          /* fall through */
        }
        try {
          target.click()
          return 'click'
        } catch (error) {
          /* fall through */
        }
      }
      return 'missing'
    }
    const keywordsById = {
      task: ['任务', '收件箱', '今天'],
      calendar: ['日历', '周', '月', '今天'],
      habit: ['习惯'],
      notes: ['笔记', '日记'],
    }
    for (const id of ['task', 'calendar', 'habit', 'notes']) {
      if (!document.querySelector('[data-v2-tab="' + id + '"]')) {
        push('v2.tab.' + id, false, { reason: 'button missing' })
        continue
      }
      const via = setTabExternal(id)
      let active = null
      for (let probe = 0; probe < 12 && !active; probe += 1) {
        await wait(250)
        active = document.querySelector('[data-v2-tab="' + id + '"][data-v2-active="1"]')
      }
      const rootAlive = !!document.querySelector('[data-lifeos-v2="1"]')
      const buttonsAfter = document.querySelectorAll('[data-v2-tab]').length
      const persistedTab = (function () {
        try {
          return window.localStorage.getItem(V2_TAB_STORAGE_KEY)
        } catch (error) {
          return null
        }
      })()
      const crashed = !!(window && window.__lifeosV2Crashed)
      const contentEl = document.querySelector('[data-v2-content="1"]')
      const contentBlocks = contentEl ? contentEl.querySelectorAll('*').length : 0
      const keywords = keywordsById[id] || []
      let contentText = ''
      let keywordOk = false
      let errorVisible = false
      for (let probe = 0; probe < 8; probe += 1) {
        contentText = (document.querySelector('[data-v2-content="1"]') || {}).textContent || ''
        keywordOk = keywords.some(function match(word) { return contentText.indexOf(word) >= 0 })
        errorVisible = /加载失败|validation_failed|请求失败/.test(contentText)
        if (keywordOk && !errorVisible) break
        await wait(250)
      }
      push('v2.tab.' + id, !!active && rootAlive && !crashed && contentBlocks > 0 && keywordOk && !errorVisible, {
        via: via,
        active: !!active,
        rootAlive: rootAlive,
        buttonsAfter: buttonsAfter,
        persistedTab: persistedTab,
        crashed: crashed,
        contentBlocks: contentBlocks,
        keywordOk: keywordOk,
        errorVisible: errorVisible,
        textLength: contentText.length,
      })
    }
    setTabExternal(savedId)
    push('v2.noCrash', !(window && window.__lifeosV2Crashed), {
      crashed: (window && window.__lifeosV2Crashed) || null,
    })
    const ok = steps.every(function (step) { return step.ok })
    const report = {
      phase: 'm6-selfcheck',
      at: new Date().toISOString(),
      final: true,
      uiVersion: 'v2',
      manual: force === true,
      m6: { ok: ok, steps: steps },
    }
    try {
      await fetch(apiUrl('/dev/client-report'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
      })
    } catch (error) {
      /* ignore report failure */
    }
    return { ok: ok, steps: steps }
  } catch (error) {
    const failure = { phase: 'm6-selfcheck', at: new Date().toISOString(), final: true, m6: { ok: false, error: String(error && error.message ? error.message : error) } }
    try {
      await fetch(apiUrl('/dev/client-report'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(failure),
      })
    } catch (inner) {
      /* ignore */
    }
    return { ok: false, error: failure.m6.error }
  }
}


/* ── 全局快速记录浮层（DSH 对话页也使用 V2 样式与提交语义） ── */
function V2HostCaptureDialog(props) {
  const closeCallback = props && typeof props.onClose === 'function' ? props.onClose : null
  const savedCallback = props && typeof props.onSaved === 'function' ? props.onSaved : null
  const [target, setTarget] = useState('task')
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const textareaRef = useRef(null)

  useEffect(function focusOnOpen() {
    const timer = setTimeout(function focusLater() {
      try {
        if (textareaRef.current) textareaRef.current.focus()
      } catch (inner) {
        /* ignore */
      }
    }, 30)
    return function cleanup() {
      try {
        clearTimeout(timer)
      } catch (inner) {
        /* ignore */
      }
    }
  }, [])

  function close() {
    try {
      if (closeCallback) closeCallback()
      else runtime.closeOverlay()
    } catch (error) {
      /* ignore */
    }
  }

  async function submit() {
    const value = String(text || '').trim()
    if (!value || saving) return
    setSaving(true)
    setError('')
    try {
      const result = await lifeosQuickCaptureSubmit(value, target)
      if (result && result.label) runtime.toast('success', result.label)
      if (savedCallback) {
        try {
          savedCallback(result)
        } catch (inner) {
          /* ignore */
        }
      }
      close()
    } catch (error) {
      setError(errorText(error))
      runtime.toast('error', '保存失败：' + errorText(error))
    } finally {
      setSaving(false)
    }
  }

  function onKeyDown(event) {
    if (event.nativeEvent && event.nativeEvent.isComposing) return
    if (event.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Enter') return
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      submit()
      return
    }
    if (event.shiftKey) return
    if (String(text || '').length > 30) return
    event.preventDefault()
    submit()
  }

  return h(
    'div',
    {
      style: {
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: (typeof TOP_CLEARANCE === 'number' ? TOP_CLEARANCE : 0) + 60,
        paddingLeft: 16,
        paddingRight: 16,
        background: 'rgba(2,6,14,0.55)',
      },
      onMouseDown: function onMouseDown(event) {
        if (event.target === event.currentTarget) close()
      },
    },
    h(
      'div',
      {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '快速记录',
        style: {
          width: 'min(560px,92vw)',
          background: COLORS.bgLayer2 || COLORS.bgBase,
          border: '1px solid ' + V2.line,
          borderRadius: 12,
          boxShadow: '0 18px 60px rgba(0,0,0,0.5)',
          padding: '14px 16px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        },
      },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('div', { style: { fontSize: 13, fontWeight: 600, color: V2.text, flex: '1 1 auto' } }, '快速记录'),
        h(
          'button',
          {
            type: 'button',
            title: '关闭',
            onClick: close,
            style: { width: 24, height: 24, border: 'none', background: 'transparent', color: V2.faint, cursor: 'pointer', fontSize: 16 },
          },
          '×',
        ),
      ),
      h(
        'div',
        { style: { display: 'flex', gap: 2, border: '1px solid ' + V2.line, borderRadius: 8, padding: 2, alignSelf: 'flex-start' } },
        [
          { id: 'task', label: '收集箱任务', icon: 'inbox' },
          { id: 'note', label: '随记', icon: 'text' },
        ].map(function renderTarget(item) {
          const active = target === item.id
          return h(
            'button',
            {
              key: item.id,
              type: 'button',
              onClick: function onClick() {
                setTarget(item.id)
              },
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 10px',
                borderRadius: 7,
                border: 'none',
                cursor: 'pointer',
                background: active ? V2.hover : 'transparent',
                color: active ? V2.text : V2.sub,
                fontFamily: COLORS.fontFamily,
                fontSize: 12,
              },
            },
            h(V2Icon, { name: item.icon, size: 13 }),
            item.label,
          )
        }),
      ),
      h('textarea', {
        ref: textareaRef,
        autoFocus: true,
        value: text,
        rows: 4,
        placeholder: target === 'task' ? '记一条任务，Enter 保存' : '随手记点什么，Enter 保存（长文换行）',
        onChange: function onChange(event) {
          setText(event.target.value)
        },
        onKeyDown: onKeyDown,
        style: v2InputStyle({
          minHeight: 96,
          marginTop: 2,
          padding: '9px 11px',
          border: '1px solid ' + V2.line,
          borderRadius: 8,
          background: 'rgba(255,255,255,0.02)',
          resize: 'vertical',
          fontFamily: COLORS.fontFamily,
          lineHeight: 1.6,
        }),
      }),
      error ? h('div', { style: { fontSize: 11, color: V2.danger, lineHeight: '17px' } }, error) : null,
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: V2.faint } },
        h('span', null, target === 'task' ? 'Enter 保存 · Shift+Enter 换行' : 'Enter 保存（长文换行）· Ctrl+Enter 保存'),
        h('span', { style: { flex: '1 1 auto' } }),
        h('button', { type: 'button', onClick: close, style: v2BtnStyle('ghost') }, '取消'),
        h('button', { type: 'button', disabled: saving, onClick: submit, style: v2BtnStyle('primary') }, saving ? '保存中…' : '保存'),
      ),
    ),
  )
}

/* ---- 20-tasks.js (3223 lines) ---- */
/* ═══════════════════════ M6 · V2 任务 Tab ═══════════════════════ */

const V2_PRIORITY_ITEMS = [
  { id: 'high', label: '高优先级' },
  { id: 'medium', label: '中优先级' },
  { id: 'low', label: '低优先级' },
  { id: 'none', label: '无优先级' },
]

/* 任务 Tab 三栏布局（左清单栏 / 中列表 / 右详情栏） */
const V2_PANE_STORAGE_KEY = 'lifeos.v2.taskPanes'
const V2_PANE_LIST_MIN = 180
const V2_PANE_LIST_MAX = 380
const V2_PANE_LIST_DEFAULT = 244
const V2_PANE_LIST_COLLAPSED = 22
const V2_PANE_DETAIL_MIN = 320
const V2_PANE_DETAIL_MAX = 640
const V2_PANE_DETAIL_DEFAULT = 420

/* 重复规则（repeatRule）展示与推算 */
const V2_WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

function v2LocalTime(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return hh + ':' + mm
}

function v2IsoFromLocal(dateKey, timeText) {
  if (!dateKey || !timeText) return null
  const parts = String(timeText).split(':')
  if (parts.length < 2) return null
  const date = new Date(dateKey + 'T00:00:00')
  if (Number.isNaN(date.getTime())) return null
  date.setHours(Number(parts[0]), Number(parts[1]), 0, 0)
  return date.toISOString()
}

function v2IsoAddMinutes(iso, minutes) {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return new Date(date.getTime() + minutes * 60000).toISOString()
}

function v2TimeFromIso(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
}

function v2TaskListId(task) {
  return task.listId || task.list_id || null
}

function v2TaskGroupId(task) {
  return task.groupId || task.group_id || null
}

function v2TaskParentId(task) {
  return task.parentTaskId || task.parent_task_id || null
}

function v2TaskPinned(task) {
  return task.pinned === true || task.pinned === 1
}

function v2TaskOpen(task) {
  return task.status !== 'done' && task.status !== 'cancelled'
}

function v2TaskCompleted(task) {
  return task.status === 'done'
}

function v2TaskDateKey(task) {
  return task.scheduledDate || task.scheduled_date || null
}

function v2TaskOverdue(task, today) {
  if (!v2TaskOpen(task)) return false
  const dateKey = v2TaskDateKey(task)
  if (dateKey && dateKey < today) return true
  const due = task.dueDate || task.due_date
  if (due && due < today) return true
  return false
}

function v2TaskMatchesText(task, query) {
  if (!query) return true
  const text = String(query).toLowerCase()
  const haystack = [task.title, task.notes].filter(Boolean).join(' ').toLowerCase()
  return haystack.indexOf(text) >= 0
}

function v2ParseTarget(text, today) {
  const parsed = parseQuickAdd(text, today)
  return parsed
}

function TaskArowV2(props) {
  const task = props.task
  const selected = props.selected
  const editing = props.editing
  const childCount = props.childCount
  const doneChild = props.doneChild
  /* 视觉变体：看板列中的任务项用浮起卡片；列表内仍是扁平行（仅样式差异，无行为差异） */
  const carded = props.card === true
  const repeatRule = v2RepeatRuleOf(task)
  const [draft, setDraft] = useState(task.title)
  const inputRef = useRef(null)

  useEffect(function syncDraft() {
    setDraft(task.title)
  }, [task.title])

  useEffect(function focusEditor() {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  if (editing) {
    return h(
      'div',
      {
        style: v2RaisedStyle({
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 10px',
          margin: '2px 4px',
        }),
      },
      h('button', { type: 'button', onClick: props.onToggle, style: v2CheckStyle(task) }),
      h('input', {
        ref: inputRef,
        value: draft,
        onChange: function onChange(e) { setDraft(e.target.value) },
        onBlur: function onBlur() { props.onCommitTitle(draft) },
        onKeyDown: function onKeyDown(e) {
          if (e.key === 'Enter') {
            e.preventDefault()
            props.onCommitTitle(draft)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft(task.title)
            props.onCancelEdit()
          }
        },
        style: v2InputStyle({ flex: '1 1 auto', fontSize: 13, padding: '4px 8px', borderRadius: V2_T.radius.sm }),
      }),
    )
  }

  return h(
    'div',
    {
      draggable: true,
      onDragStart: function onDragStart(e) {
        if (props.onDragStart) props.onDragStart(e, task)
      },
      onDragEnd: function onDragEnd() {
        /* drop 完成后统一清空拖拽负载，避免残留 id 触发重复排序 */
        try {
          window.__lifeosV2DragTaskId = null
        } catch (error) {
          /* ignore */
        }
      },
      onDragOver: function onDragOver(e) {
        e.preventDefault()
        /* 行内 drop 优先，阻止冒泡到分组体/看板列，避免一次拖拽触发两次 mutation */
        e.stopPropagation()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      },
      onDrop: function onDrop(e) {
        e.preventDefault()
        e.stopPropagation()
        if (props.onDrop) props.onDrop(e, task)
      },
      onClick: function onOpen() { props.onOpen(task) },
      style: Object.assign(
        carded
          ? v2RaisedStyle({ padding: '8px 10px', marginBottom: 8 })
          : {
              padding: '0 12px',
              minHeight: V2_T.line.row,
              borderRadius: V2_T.radius.sm,
            },
        {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          background: selected ? V2_T.surface.panel3 : carded ? V2_T.surface.panel2 : 'transparent',
          /* 选中态：浮起底色 + 2px 品牌蓝左边条（用 inset 阴影，避免布局位移） */
          boxShadow: selected ? 'inset 2px 0 0 ' + V2_T.accent.base : carded ? V2_T.shadow.card : 'none',
          transition: 'background 120ms ease',
        },
      ),
      onMouseEnter: function enter(e) {
        e.currentTarget.style.background = selected || carded ? V2_T.surface.panel3 : V2_T.surface.panel2
        const actions = e.currentTarget.querySelector('.v2-row-actions')
        if (actions) actions.style.opacity = '0.75'
      },
      onMouseLeave: function leave(e) {
        e.currentTarget.style.background = selected ? V2_T.surface.panel3 : carded ? V2_T.surface.panel2 : 'transparent'
        const actions = e.currentTarget.querySelector('.v2-row-actions')
        if (actions) actions.style.opacity = '0.4'
      },
    },
    h('button', {
      type: 'button',
      title: v2TaskCompleted(task) ? '取消完成' : '标记完成',
      onClick: function onClick(e) {
        e.stopPropagation()
        props.onToggle(task)
      },
      style: v2CheckStyle(task),
    }, v2TaskCompleted(task) ? h(V2Icon, { name: 'check', size: 11, color: '#0b0e14', strokeWidth: 3 }) : null),
    h(
      'div',
      { style: { flex: '1 1 auto', minWidth: 0 } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('span', {
          onClick: function onTitleClick(e) {
            e.stopPropagation()
            props.onStartEdit(task)
          },
          style: {
            fontSize: 13.5,
            color: v2TaskCompleted(task) ? V2_T.text.tertiary : V2_T.text.primary,
            textDecoration: v2TaskCompleted(task) ? 'line-through' : 'none',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            lineHeight: '18px',
          },
        }, task.title),
        v2TaskPinned(task) ? h(V2Icon, { name: 'pin', size: 11, color: V2.faint }) : null,
        childCount > 0
          ? h('span', { style: { fontSize: 11, color: V2_T.text.tertiary } }, '· ' + doneChild + '/' + childCount + ' 子任务')
          : null,
      ),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, fontSize: 12, color: V2_T.text.tertiary, minHeight: 18 } },
        task.priority && task.priority !== 'none'
          ? h('span', {
              style: {
                width: 6,
                height: 6,
                borderRadius: 3,
                background: task.priority === 'high' ? V2_T.status.danger : task.priority === 'medium' ? V2_T.status.warn : task.priority === 'low' ? V2_T.accent.base : V2_T.text.tertiary,
              },
            })
          : null,
        h('span', { style: { color: v2TaskOverdue(task, todayIso()) ? V2_T.status.danger : V2_T.text.secondary } }, v2TaskDateText(task)),
        (task.tags || []).slice(0, 3).map(function renderTag(tag) {
          return h('span', {
            key: tag.id,
            style: {
              fontSize: 11,
              padding: '0 7px',
              borderRadius: V2_T.radius.pill,
              background: V2_T.surface.panel2,
              border: '1px solid ' + V2_T.border.subtle,
              color: V2_T.text.secondary,
              lineHeight: '16px',
              whiteSpace: 'nowrap',
            },
          }, tag.name)
        }),
        repeatRule
          ? h(
              'span',
              {
                style: { display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 11, color: V2_T.text.tertiary, whiteSpace: 'nowrap' },
                title: '重复：' + v2RepeatLabel(repeatRule),
              },
              h(V2Icon, { name: 'repeat', size: 10 }),
              v2RepeatLabel(repeatRule),
            )
          : null,
        props.listName ? h('span', { style: { color: V2_T.text.tertiary } }, '· ' + props.listName) : null,
      ),
    ),
    h(
      'div',
      {
        className: 'v2-row-actions',
        style: { display: 'flex', alignItems: 'center', gap: 2, opacity: 0.4, transition: 'opacity 120ms ease' },
      },
      h('button', {
        type: 'button',
        title: '更多',
        onClick: function onClick(e) {
          e.stopPropagation()
          props.onMore(task, e)
        },
        style: v2IconBtnStyle(),
      }, h(V2Icon, { name: 'more', size: 14 })),
    ),
  )
}

function v2CheckStyle(task) {
  const done = v2TaskCompleted(task)
  /* 仅颜色映射切到 A2：高 #ff8a8a / 中 #f5cd79 / 低 #6ea8fe / 无 #8190a8（判定逻辑不变） */
  const color = !done && task.priority === 'high'
    ? V2_T.status.danger
    : !done && task.priority === 'medium'
      ? V2_T.status.warn
      : !done && task.priority === 'low'
        ? V2_T.accent.base
        : V2_T.border.strong
  return {
    width: 18,
    height: 18,
    minWidth: 18,
    marginTop: 0,
    borderRadius: 6,
    border: '1.5px solid ' + (done ? 'transparent' : color),
    background: done ? V2_T.status.success : 'transparent',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: 0,
    flex: '0 0 auto',
    transition: 'border-color 120ms ease, background 120ms ease',
  }
}

function v2IconBtnStyle(extra) {
  return Object.assign({
    width: 24,
    height: 24,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: V2_T.radius.sm,
    background: 'transparent',
    color: V2_T.text.secondary,
    cursor: 'pointer',
    padding: 0,
    flex: '0 0 auto',
    transition: 'background 120ms ease, color 120ms ease',
  }, extra || {})
}

/* 工具栏图标按钮：32px 胶囊（A2）；hover / focus 反馈均为纯视觉 */
function v2ToolbarBtnStyle(active) {
  return v2IconBtnStyle({
    width: 32,
    height: 32,
    borderRadius: V2_T.radius.md,
    background: active ? V2_T.accent.soft : 'transparent',
    color: active ? V2_T.accent.base : V2_T.text.secondary,
  })
}

function TaskTabV2(props) {
  const runtime = props.runtime
  const board = props.board
  const refreshSignal = props.refreshSignal || 0
  const quickAddSignal = props.quickAddSignal || 0
  const narrow = props.narrow === true

  const [state, setState] = useState(function initial() {
    const prefs = v2ReadSettings()
    return {
      loading: true,
      error: null,
      tasks: [],
      done: [],
      trash: [],
      lists: [],
      groups: [],
      scope: { kind: 'today' },
      view: prefs.taskView === 'board' ? 'board' : 'list',
      sort: prefs.taskSort || 'custom',
      selectedId: null,
      detail: null,
      editingId: null,
      collapsed: {},
      quickAdd: '',
      quickAddHint: '',
      busy: false,
      newListOpen: false,
      newListName: '',
      newGroupListId: null,
      newGroupName: '',
      groupAdd: null,
      groupAddText: '',
      renamingListId: null,
      renameListText: '',
      tags: [],
      detailTagOpen: false,
      detailTagText: '',
      renamingGroupId: null,
      renameGroupText: '',
      selectionMode: false,
      selectedIds: [],
    }
  })
  const [panes, setPanes] = useState(v2ReadTaskPanes)
  const inputRef = useRef(null)
  const detailRef = useRef(null)
  const stateRef = useRef(state)
  const panesRef = useRef(panes)
  /* 同步 mutation 锁：state.busy 是异步的，跨事件/跨 await 不可靠 */
  const opLockRef = useRef({ busy: false, seq: 0 })
  /* 同一 task 的重复 drop 去抖 */
  const dropGuardRef = useRef({ key: '', at: 0 })
  /* 自绘弹窗打开时接管 Esc，避免同时关闭详情面板 */
  const modalRef = useRef(false)
  stateRef.current = state
  panesRef.current = panes

  function update(patch) {
    setState(function merge(prev) { return Object.assign({}, prev, patch) })
  }

  async function safeRequest(path, options) {
    try {
      return await apiRequest(path, options)
    } catch (error) {
      const code = String((error && error.code) || '')
      if (/not[_-]?found/i.test(code) || code === 'unknown_route' || (error && error.status === 404)) return null
      throw error
    }
  }

  async function safeOptional(path, fallback) {
    try {
      const value = await apiRequest(path)
      return value === null || value === undefined ? fallback : value
    } catch (error) {
      return fallback
    }
  }

  async function reload(showLoading) {
    if (showLoading !== false) update({ loading: true, error: null })
    try {
      const tasksValue = await apiRequest('/tasks?view=all&limit=100')
      const tasks = (tasksValue && tasksValue.items) || []
      const doneValue = await safeOptional('/tasks?view=done&limit=100', { items: [] })
      const trashValue = await safeOptional('/tasks?view=trash&limit=100', { items: [] })
      const listsValue = await safeOptional('/lists', { items: [] })
      const tagsValue = await safeOptional('/tags', { items: [] })
      const tags = (tagsValue && tagsValue.items) || []
      const done = (doneValue && doneValue.items) || []
      const trash = (trashValue && trashValue.items) || []
      let lists = (listsValue && listsValue.items) || []
      if (!Array.isArray(lists)) lists = []
      /* 清理 M1 seed 的空默认清单「收件箱」：收集箱=无清单任务，默认清单只是历史遗留。
         只删除完全没有任务的 inbox 清单；若其中有任务则保留并在左栏显示，避免任务丢失。 */
      const knownTasks = tasks.concat(done, trash)
      for (const inboxList of lists.filter(function isInbox(list) { return (list.kind || 'normal') === 'inbox' })) {
        const used = knownTasks.some(function uses(task) { return v2TaskListId(task) === inboxList.id })
        if (used) continue
        try {
          await apiRequest('/lists/' + encodeURIComponent(inboxList.id) + (inboxList.rev ? '?expectedRev=' + encodeURIComponent(inboxList.rev) : ''), { method: 'DELETE' })
          lists = lists.filter(function keep(list) { return list.id !== inboxList.id })
          runtime.toast('success', '已移除重复的默认清单「收件箱」')
        } catch (error) {
          /* 删除失败不影响主流程；下次 reload 再试 */
        }
      }
      const groupMap = {}
      await Promise.all(lists.map(async function loadGroups(list) {
        const value = await safeOptional('/lists/' + encodeURIComponent(list.id) + '/groups', { items: [] })
        groupMap[list.id] = (value && (value.items || value.groups)) || []
      }))
      const groups = []
      Object.keys(groupMap).forEach(function flatten(listId) {
        groupMap[listId].forEach(function add(group) {
          groups.push(Object.assign({}, group, { listId: group.listId || listId }))
        })
      })
      const payload = {
        tasks: tasks,
        done: done,
        trash: trash,
        lists: lists,
        tags: tags,
        groups: groups,
      }
      update(
        Object.assign(
          {
            loading: false,
            error: null,
            detail: stateRef.current.detail
              ? tasks.concat(done, trash).filter(function findDetail(task) { return task.id === stateRef.current.detail.id })[0] || null
              : null,
          },
          payload,
        ),
      )
      return payload
    } catch (error) {
      update({ loading: false, error: errorText(error) })
      return null
    }
  }

  useEffect(function mount() {
    reload(true)
  }, [])

  useEffect(function refreshOnSignal() {
    if (refreshSignal > 0) reload(false)
  }, [refreshSignal])

  useEffect(function focusQuickAdd() {
    if (quickAddSignal > 0 && inputRef.current) inputRef.current.focus()
  }, [quickAddSignal])

  useEffect(function closeOnEscape() {
    function onKeyDown(event) {
      if (event.key !== 'Escape') return
      if (modalRef.current) return
      const current = stateRef.current
      if (current.editingId) {
        event.preventDefault()
        update({ editingId: null })
        return
      }
      if (current.detail) {
        event.preventDefault()
        update({ detail: null, selectedId: null })
        return
      }
      if (current.selectionMode) {
        event.preventDefault()
        update({ selectionMode: false, selectedIds: [] })
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return function cleanup() {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  const shortcuts = [
    { kind: 'today', label: '今天', icon: 'sun' },
    { kind: 'next7', label: '最近 7 天', icon: 'calendar' },
    { kind: 'inbox', label: '收集箱', icon: 'inbox' },
  ]

  function scopeKey(scope) {
    if (!scope) return 'all'
    return scope.kind + ':' + (scope.id || '')
  }

  function scopeTasksOf(scope) {
    if (!scope) return []
    if (scope.kind === 'done') return state.done
    if (scope.kind === 'trash') return state.trash
    if (scope.kind === 'tag') {
      return state.tasks.filter(function byTag(task) {
        return (task.tags || []).some(function has(tag) { return tag.id === scope.id })
      })
    }
    return state.tasks.filter(function filter(task) { return v2ScopeMatch(task, scope, state.lists, state.groups) })
  }

  function scopeTitleOf(scope) {
    if (!scope) return '任务'
    if (scope.kind === 'done') return '已完成'
    if (scope.kind === 'trash') return '垃圾桶'
    if (scope.kind === 'today') return '今天'
    if (scope.kind === 'next7') return '最近 7 天'
    if (scope.kind === 'inbox') return '收集箱'
    if (scope.kind === 'list') {
      const list = state.lists.filter(function find(l) { return l.id === scope.id })[0]
      return list ? list.name : '清单'
    }
    if (scope.kind === 'filter') return scope.label || '过滤器'
    if (scope.kind === 'tag') {
      const tag = state.tags.filter(function find(t) { return t.id === scope.id })[0]
      return '标签：' + (tag ? tag.name : '')
    }
    return '任务'
  }

  function tagNameOf(tagId) {
    const tag = state.tags.filter(function find(t) { return t.id === tagId })[0]
    return tag ? tag.name : ''
  }

  function scopeTasks() {
    return scopeTasksOf(state.scope)
  }

  function selectScope(scope) {
    update({ scope: scope, selectedId: null, detail: null, editingId: null })
  }

  function listNameOf(listId) {
    if (!listId) return '收集箱'
    const list = state.lists.filter(function find(l) { return l.id === listId })[0]
    return list ? list.name : '清单'
  }

  function groupNameOf(groupId) {
    const group = state.groups.filter(function find(g) { return g.id === groupId })[0]
    return group ? group.name : '未分组'
  }

  async function runMutation(action, label, undo) {
    const lock = opLockRef.current
    if (lock.busy) return false
    lock.busy = true
    const seq = (lock.seq || 0) + 1
    lock.seq = seq
    update({ busy: true })
    try {
      await action()
      await reload(false)
      if (label) {
        runtime.toast('success', label, undo ? { label: '撤销', onClick: undo } : null)
      }
      return true
    } catch (error) {
      runtime.toast('error', '操作失败：' + errorText(error))
      return false
    } finally {
      lock.busy = false
      if (lock.seq === seq) update({ busy: false })
    }
  }

  function completeTask(task) {
    const snapshot = { task: task }
    runMutation(async function doComplete() {
      await apiRequest('/tasks/' + encodeURIComponent(task.id) + '/complete', {
        method: 'POST',
        body: JSON.stringify({ expectedRev: task.rev }),
      })
      /* 仅完成成功后，才按 repeatRule 生成下一次任务；失败不影响完成结果 */
      try {
        await createNextRepeatTask(task)
      } catch (error) {
        runtime.toast('error', '生成下一次任务失败：' + errorText(error))
      }
    }, '已完成「' + task.title + '」', function undo() {
      reopenTask(snapshot.task)
    })
  }

  function reopenTask(task) {
    runMutation(async function doReopen() {
      await apiRequest('/tasks/' + encodeURIComponent(task.id) + '/reopen', {
        method: 'POST',
        body: JSON.stringify({ expectedRev: task.rev }),
      })
    }, '已恢复「' + task.title + '」')
  }

  function toggleTask(task) {
    if (v2TaskCompleted(task)) reopenTask(task)
    else completeTask(task)
  }

  function commitTitle(taskId, title, revOverride) {
    const trimmed = String(title || '').trim()
    update({ editingId: null })
    if (!trimmed) return
    runMutation(async function doPatch() {
      await apiRequest('/tasks/' + encodeURIComponent(taskId), {
        method: 'PATCH',
        body: JSON.stringify({ expectedRev: revOverride, title: trimmed }),
      })
    }, null)
  }

  function patchTask(taskId, rev, patch, label) {
    return runMutation(async function doPatch() {
      async function send(expectedRev) {
        await apiRequest('/tasks/' + encodeURIComponent(taskId), {
          method: 'PATCH',
          body: JSON.stringify(Object.assign({}, patch, { expectedRev: expectedRev })),
        })
      }
      try {
        await send(rev)
      } catch (error) {
        if (!v2IsConflictError(error)) throw error
        /* 版本冲突：静默刷新拿到最新 rev 后重试一次 */
        const fresh = await reload(false)
        const current = v2FindTaskById((fresh && fresh.tasks) || [], taskId) || v2FindTaskById((fresh && fresh.done) || [], taskId)
        if (!current) throw error
        await send(current.rev)
      }
    }, label || null)
  }

  function taskTagIds(task) {
    return (task.tags || []).map(function map(tag) { return tag.id })
  }

  function toggleSelect(taskId) {
    const next = state.selectedIds.slice()
    const index = next.indexOf(taskId)
    if (index >= 0) next.splice(index, 1)
    else next.push(taskId)
    update({ selectedIds: next })
  }

  function selectedTasksNow() {
    const all = state.tasks.concat(state.done)
    return all.filter(function f(task) { return state.selectedIds.indexOf(task.id) >= 0 })
  }

  function batchRun(label, worker) {
    const tasks = selectedTasksNow()
    if (!tasks.length) return
    runMutation(async function doBatch() {
      for (const task of tasks) await worker(task)
      update({ selectionMode: false, selectedIds: [] })
    }, label)
  }

  function batchDelete() {
    const count = selectedTasksNow().length
    batchRun('已删除 ' + count + ' 个任务', function worker(task) {
      return apiRequest('/tasks/' + encodeURIComponent(task.id) + '?expectedRev=' + encodeURIComponent(task.rev), { method: 'DELETE' })
    })
  }

  function openBatchMoveMenu() {
    const items = [{ label: '收集箱', icon: 'inbox', onClick: function onClick() { batchMoveToList(null) } }]
    state.lists.forEach(function each(list) {
      items.push({ label: list.name, icon: 'layers', onClick: function onClick() { batchMoveToList(list.id) } })
    })
    openV2PlainMenu(220, 220, items)
  }

  function batchMoveToList(listId) {
    const count = selectedTasksNow().length
    const target = listId || null
    batchRun('已移动 ' + count + ' 个任务', function worker(task) {
      /* 跨清单移动必须同时清空 groupId：Host 会校验分组属于目标清单，
         不清空会报 validation_failed「分组不属于目标清单」；任务落到目标清单未分组。 */
      const patch = { listId: target }
      if ((v2TaskListId(task) || null) !== target) patch.groupId = null
      return apiRequest('/tasks/' + encodeURIComponent(task.id), {
        method: 'PATCH',
        body: JSON.stringify(Object.assign({ expectedRev: task.rev }, patch)),
      })
    })
  }

  function openBatchTagMenu() {
    const items = state.tags.map(function map(tag) {
      return { label: tag.name, icon: 'tag', onClick: function onClick() { batchAddTag(tag.id, tag.name) } }
    })
    items.push({ type: 'separator' })
    items.push({
      label: '新建标签…',
      icon: 'plus',
      onClick: function onClick() {
        const name = window.prompt('新标签名称')
        if (name && String(name).trim()) batchAddTag(null, String(name).trim())
      },
    })
    openV2PlainMenu(220, 260, items)
  }

  function batchAddTag(tagId, tagName) {
    const tasks = selectedTasksNow()
    if (!tasks.length) return
    runMutation(async function doBatchTags() {
      let id = tagId
      if (!id) {
        const created = await apiRequest('/tags', { method: 'POST', body: JSON.stringify({ name: tagName }) })
        id = created && (created.tag ? created.tag.id : created.id)
      }
      if (!id) throw new Error('创建标签失败')
      for (const task of tasks) {
        const ids = taskTagIds(task)
        if (ids.indexOf(id) < 0) ids.push(id)
        await apiRequest('/tasks/' + encodeURIComponent(task.id), {
          method: 'PATCH',
          body: JSON.stringify({ expectedRev: task.rev, tagIds: ids }),
        })
      }
      update({ selectionMode: false, selectedIds: [] })
    }, '已添加标签')
  }

  function renderSelectionBar() {
    if (!state.selectionMode) return null
    const count = state.selectedIds.length
    return h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 16px',
          borderBottom: '1px solid ' + V2_T.border.subtle,
          background: V2_T.surface.shell,
        },
      },
      h('span', { style: { fontSize: 12, color: V2_T.text.secondary } }, count ? '已选 ' + count + ' 项' : '点击任务以多选'),
      h('div', { style: { flex: '1 1 auto' } }),
      h('button', { type: 'button', onClick: openBatchMoveMenu, style: v2BtnStyle('soft', { fontSize: 11, height: 28, padding: '0 10px', borderRadius: V2_T.radius.sm, background: V2_T.surface.panel3, color: V2_T.text.primary }) }, '移入清单'),
      h('button', { type: 'button', onClick: openBatchTagMenu, style: v2BtnStyle('soft', { fontSize: 11, height: 28, padding: '0 10px', borderRadius: V2_T.radius.sm, background: V2_T.surface.panel3, color: V2_T.text.primary }) }, '添加标签'),
      h('button', { type: 'button', onClick: batchDelete, style: v2BtnStyle('ghost', { fontSize: 11, height: 28, padding: '0 10px', borderRadius: V2_T.radius.sm, color: V2_T.status.danger }) }, '删除'),
      h('button', {
        type: 'button',
        onClick: function onClick() { update({ selectionMode: false, selectedIds: [] }) },
        style: v2BtnStyle('ghost', { fontSize: 11, height: 28, padding: '0 10px', borderRadius: V2_T.radius.sm }),
      }, '取消'),
    )
  }

  function toggleDetailTag(task, tagId) {
    const next = taskTagIds(task)
    const index = next.indexOf(tagId)
    if (index >= 0) next.splice(index, 1)
    else next.push(tagId)
    patchTask(task.id, task.rev, { tagIds: next }, null)
  }

  async function createDetailTag(task) {
    const name = String(state.detailTagText || '').trim()
    if (!name) return
    try {
      const created = await apiRequest('/tags', { method: 'POST', body: JSON.stringify({ name: name }) })
      const tag = created && (created.tag || created)
      if (tag && tag.id) {
        await apiRequest('/tasks/' + encodeURIComponent(task.id), {
          method: 'PATCH',
          body: JSON.stringify({ expectedRev: task.rev, tagIds: taskTagIds(task).concat([tag.id]) }),
        })
      }
      update({ detailTagOpen: false, detailTagText: '' })
      await reload(false)
    } catch (error) {
      runtime.toast('error', '创建标签失败：' + errorText(error))
    }
  }

  function openDetailTagMenu(task) {
    const assigned = taskTagIds(task)
    const items = state.tags.map(function map(tag) {
      return {
        label: tag.name,
        icon: assigned.indexOf(tag.id) >= 0 ? 'check' : 'tag',
        onClick: function onClick() { toggleDetailTag(task, tag.id) },
      }
    })
    items.push({ type: 'separator' })
    items.push({
      label: '新建标签…',
      icon: 'plus',
      onClick: function onClick() { update({ detailTagOpen: true, detailTagText: '' }) },
    })
    openV2PlainMenu(200, 240, items)
  }

  function deleteTask(task) {
    runMutation(async function doDelete() {
      await apiRequest('/tasks/' + encodeURIComponent(task.id) + '?expectedRev=' + encodeURIComponent(task.rev), {
        method: 'DELETE',
      })
    }, '已移入垃圾桶', function undo() {
      restoreTask(task)
    })
  }

  function restoreTask(task) {
    runMutation(async function doRestore() {
      await apiRequest('/tasks/' + encodeURIComponent(task.id) + '/restore', {
        method: 'POST',
        body: JSON.stringify({ expectedRev: task.rev }),
      })
    }, '已恢复「' + task.title + '」')
  }

  function purgeTask(task) {
    runMutation(async function doPurge() {
      await apiRequest('/tasks/' + encodeURIComponent(task.id) + '?purge=1&expectedRev=' + encodeURIComponent(task.rev), {
        method: 'DELETE',
      })
    }, '已彻底删除')
  }

  async function createTask(input, extra) {
    const text = String(input || '').trim()
    if (!text) return
    const parsed = v2ParseTarget(text, todayIso())
    const body = Object.assign({
      title: parsed.title || text,
      priority: parsed.priority || 'none',
    }, parsed.dateKey ? { scheduledDate: parsed.dateKey } : {}, extra || {})
    try {
      await apiRequest('/tasks', { method: 'POST', body: JSON.stringify(body) })
      update({ quickAdd: '', quickAddHint: '' })
      await reload(false)
      if (inputRef.current) inputRef.current.focus()
      runtime.toast('success', '已添加任务')
    } catch (error) {
      runtime.toast('error', '创建失败：' + errorText(error))
    }
  }

  /* 完成重复任务后，按 repeatRule 在客户端克隆出下一次任务（不改动原任务、不克隆子任务） */
  async function createNextRepeatTask(task) {
    const rule = v2RepeatRuleOf(task)
    if (!rule) return
    const scheduled = v2TaskDateKey(task)
    const dueRaw = task.dueDate || task.due_date || null
    const due = dueRaw ? String(dueRaw).slice(0, 10) : null
    const baseDate = scheduled || due || todayIso()
    const nextDate = v2NextRepeatDate(baseDate, rule)
    const deltaDays = v2DaysBetween(baseDate, nextDate)
    const body = {
      title: task.title,
      priority: task.priority || 'none',
      repeatRule: rule,
      listId: v2TaskListId(task) || null,
      groupId: v2TaskGroupId(task) || null,
    }
    if (task.notes) body.notes = task.notes
    const tagIds = taskTagIds(task)
    if (tagIds.length) body.tagIds = tagIds
    const startAt = task.scheduledStartAt || task.scheduled_start_at || null
    const endAt = task.scheduledEndAt || task.scheduled_end_at || null
    if (scheduled) {
      if (startAt) {
        const nextStart = v2IsoFromLocal(nextDate, v2LocalTime(startAt))
        body.scheduledDate = null
        body.scheduledStartAt = nextStart
        body.scheduledEndAt = null
        if (endAt && nextStart) {
          const startMs = new Date(startAt).getTime()
          const endMs = new Date(endAt).getTime()
          const minutes = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? Math.round((endMs - startMs) / 60000) : 0
          if (minutes > 0) body.scheduledEndAt = v2IsoAddMinutes(nextStart, minutes)
        }
      } else {
        body.scheduledDate = nextDate
        body.scheduledStartAt = null
        body.scheduledEndAt = null
      }
    } else if (due) {
      body.dueDate = nextDate
    } else {
      body.scheduledDate = nextDate
    }
    if (scheduled && due) body.dueDate = addDaysKey(due, deltaDays > 0 ? deltaDays : 0)
    const created = await apiRequest('/tasks', { method: 'POST', body: JSON.stringify(body) })
    if (created && (created.task || created.id)) runtime.toast('success', '已生成下一次任务')
  }

  function openDetail(task) {
    update({ selectedId: task.id, detail: task })
  }

  function closeDetail() {
    update({ selectedId: null, detail: null })
  }

  function openTaskMenu(task, event) {
    const rect = event && event.currentTarget ? event.currentTarget.getBoundingClientRect() : null
    const items = [
      { label: '设置日期', icon: 'calendar', onClick: function onDate() { runtime.toast('success', '请在详情面板设置日期'); openDetail(task) } },
      { label: '设置优先级', icon: 'flag', onClick: function onPriority() { openPriorityMenu(task) } },
      { label: '添加子任务', icon: 'subtask', onClick: function onSubtask() { addSubtask(task) } },
      { type: 'separator' },
      { label: '移动到清单', icon: 'move', onClick: function onMove() { openMoveMenu(task) } },
      { label: '创建副本', icon: 'copy', onClick: function onCopy() { duplicateTask(task) } },
      { type: 'separator' },
      { label: '删除任务', icon: 'trash', danger: true, onClick: function onDelete() { deleteTask(task) } },
    ]
    openV2PlainMenu(rect ? rect.left : 100, rect ? rect.bottom + 4 : 100, items)
  }

  function openPriorityMenu(task) {
    const items = V2_PRIORITY_ITEMS.map(function map(item) {
      return {
        label: item.label,
        icon: task.priority === item.id ? 'check' : 'flag',
        onClick: function onClick() { patchTask(task.id, task.rev, { priority: item.id }, '优先级已更新') },
      }
    })
    openV2PlainMenu(120, 120, items)
  }

  function openMoveMenu(task) {
    function moveTo(listId, label) {
      const target = listId || null
      const patch = { listId: target }
      if ((v2TaskListId(task) || null) !== target) patch.groupId = null
      patchTask(task.id, task.rev, patch, label)
    }
    const items = [{ label: '收集箱', icon: 'inbox', onClick: function onClick() { moveTo(null, '已移入收集箱') } }]
    state.lists.forEach(function each(list) {
      items.push({
        label: list.name,
        icon: 'layers',
        onClick: function onClick() { moveTo(list.id, '已移入「' + list.name + '」') },
      })
    })
    openV2PlainMenu(120, 140, items)
  }

  function duplicateTask(task) {
    runMutation(async function doCopy() {
      await apiRequest('/tasks/' + encodeURIComponent(task.id) + '/duplicate', {
        method: 'POST',
        body: JSON.stringify({ expectedRev: task.rev, title: task.title + '（副本）' }),
      })
    }, '已创建副本')
  }

  function addSubtask(parent) {
    const title = '新子任务'
    runMutation(async function doAdd() {
      await apiRequest('/tasks', {
        method: 'POST',
        body: JSON.stringify({ title: title, parentTaskId: parent.id, listId: v2TaskListId(parent) }),
      })
    }, '已添加子任务')
  }

  function openV2PlainMenu(x, y, items) {
    const wrapper = document.createElement('div')
    wrapper.style.position = 'fixed'
    wrapper.style.left = Math.max(8, Math.min(x, window.innerWidth - 210)) + 'px'
    wrapper.style.top = Math.max(8, Math.min(y, window.innerHeight - 260)) + 'px'
    wrapper.style.zIndex = '99999'
    wrapper.style.background = V2_T.surface.panel2
    wrapper.style.border = '1px solid ' + V2_T.border.subtle
    wrapper.style.borderRadius = V2_T.radius.md + 'px'
    wrapper.style.padding = '4px'
    wrapper.style.minWidth = '180px'
    wrapper.style.boxShadow = V2_T.shadow.pop
    let closed = false
    function close() {
      if (closed) return
      closed = true
      if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper)
      document.removeEventListener('mousedown', onOutside, true)
      document.removeEventListener('keydown', onEsc, true)
    }
    function onOutside(e) {
      if (!wrapper.contains(e.target)) close()
    }
    function onEsc(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    items.forEach(function render(item) {
      if (!item) return
      if (item.type === 'separator') {
        const sep = document.createElement('div')
        sep.style.height = '1px'
        sep.style.background = V2.line
        sep.style.margin = '4px 6px'
        wrapper.appendChild(sep)
        return
      }
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.style.display = 'flex'
      btn.style.alignItems = 'center'
      btn.style.gap = '8px'
      btn.style.width = '100%'
      btn.style.background = 'transparent'
      btn.style.border = 'none'
      btn.style.color = item.danger ? V2.danger : V2.text
      btn.style.fontFamily = COLORS.fontFamily
      btn.style.fontSize = '12px'
      btn.style.padding = '7px 10px'
      btn.style.borderRadius = V2_T.radius.sm + 'px'
      btn.style.cursor = 'pointer'
      btn.style.textAlign = 'left'
      btn.textContent = item.label
      btn.addEventListener('mouseenter', function enter() { btn.style.background = V2_T.surface.panel3 })
      btn.addEventListener('mouseleave', function leave() { btn.style.background = 'transparent' })
      btn.addEventListener('click', function click() {
        close()
        try {
          item.onClick()
        } catch (error) {
          runtime.toast('error', '操作失败：' + errorText(error))
        }
      })
      wrapper.appendChild(btn)
    })
    document.body.appendChild(wrapper)
    setTimeout(function bind() {
      document.addEventListener('mousedown', onOutside, true)
      document.addEventListener('keydown', onEsc, true)
    }, 0)
  }

  function renameList(list) {
    const name = String(state.renameListText || '').trim()
    if (!name || name === list.name) {
      update({ renamingListId: null })
      return
    }
    runMutation(async function doRename() {
      await apiRequest('/lists/' + encodeURIComponent(list.id), {
        method: 'PATCH',
        body: JSON.stringify({ expectedRev: list.rev, name: name }),
      })
      update({ renamingListId: null })
    }, '清单已重命名')
  }

  function deleteList(list) {
    openV2PlainMenu(140, 200, [
      {
        label: '删除清单「' + list.name + '」',
        icon: 'trash',
        danger: true,
        onClick: function onClick() {
          runMutation(async function doDelete() {
            await apiRequest('/lists/' + encodeURIComponent(list.id) + '?expectedRev=' + encodeURIComponent(list.rev), {
              method: 'DELETE',
            })
            if (state.scope.kind === 'list' && state.scope.id === list.id) {
              selectScope({ kind: 'inbox' })
            }
          }, '清单已删除，任务已移到收集箱')
        },
      },
    ])
  }

  function openListMenu(list, event) {
    const rect = event.currentTarget.getBoundingClientRect()
    openV2PlainMenu(rect.right - 160, rect.bottom + 4, [
      { label: '重命名清单', icon: 'edit', onClick: function onClick() { update({ renamingListId: list.id, renameListText: list.name }) } },
      { label: '删除清单', icon: 'trash', danger: true, onClick: function onClick() { deleteList(list) } },
    ])
  }

  function createList() {
    const name = String(state.newListName || '').trim()
    if (!name) return
    runMutation(async function doCreate() {
      await apiRequest('/lists', { method: 'POST', body: JSON.stringify({ name: name }) })
      update({ newListOpen: false, newListName: '' })
    }, '已新建清单「' + name + '」')
  }

  function createGroup(listId) {
    const name = String(state.newGroupName || '').trim()
    if (!name || !listId) return
    runMutation(async function doCreate() {
      await apiRequest('/lists/' + encodeURIComponent(listId) + '/groups', {
        method: 'POST',
        body: JSON.stringify({ name: name }),
      })
      update({ newGroupListId: null, newGroupName: '' })
    }, '已新建分组「' + name + '」')
  }

  /* 清单拖拽排序：把 draggedId 插到 targetId 之前，提交完整顺序 */
  function reorderListTo(draggedId, targetId) {
    if (!draggedId || !targetId || draggedId === targetId) return
    const ids = visibleLists().map(function id(list) { return list.id })
    const from = ids.indexOf(draggedId)
    if (from < 0 || ids.indexOf(targetId) < 0) return
    ids.splice(from, 1)
    const insertAt = ids.indexOf(targetId)
    ids.splice(insertAt < 0 ? ids.length : insertAt, 0, draggedId)
    runMutation(async function doReorder() {
      await apiRequest('/lists/reorder', { method: 'POST', body: JSON.stringify({ ids: ids }) })
    }, '已调整清单顺序')
  }

  /* 分组拖拽排序：只在当前清单内重排 */
  function reorderGroupTo(draggedId, targetId) {
    const listId = state.scope.kind === 'list' ? state.scope.id : null
    if (!listId || !draggedId || !targetId || draggedId === targetId) return
    const ids = state.groups
      .filter(function f(group) { return (group.listId || group.list_id) === listId })
      .map(function id(group) { return group.id })
    const from = ids.indexOf(draggedId)
    if (from < 0 || ids.indexOf(targetId) < 0) return
    ids.splice(from, 1)
    const insertAt = ids.indexOf(targetId)
    ids.splice(insertAt < 0 ? ids.length : insertAt, 0, draggedId)
    runMutation(async function doReorder() {
      await apiRequest('/groups/reorder', { method: 'POST', body: JSON.stringify({ ids: ids }) })
    }, '已调整分组顺序')
  }

  function startListDrag(e, list) {
    window.__lifeosV2DragListId = list.id
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      try { e.dataTransfer.setData('text/plain', list.id) } catch (error) { /* ignore */ }
    }
  }

  function dropListReorder(e, list) {
    e.preventDefault()
    e.stopPropagation()
    const draggedId = window.__lifeosV2DragListId
    window.__lifeosV2DragListId = null
    reorderListTo(draggedId, list.id)
  }

  function startGroupDrag(e, group) {
    window.__lifeosV2DragGroupId = group.id
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      try { e.dataTransfer.setData('text/plain', group.id) } catch (error) { /* ignore */ }
    }
  }

  function dropGroupReorder(e, group) {
    e.preventDefault()
    e.stopPropagation()
    const draggedId = window.__lifeosV2DragGroupId
    window.__lifeosV2DragGroupId = null
    reorderGroupTo(draggedId, group.id)
  }

  function openGroupAdd(listId, groupId) {
    update({ groupAdd: { listId: listId, groupId: groupId || null }, groupAddText: '' })
  }

  function reorderWithinManual(dragged, orderedTasks, groupId, listId) {
    const patches = []
    orderedTasks.forEach(function each(task, index) {
      const sortOrder = index * 10
      const movedGroup = task.id === dragged.id && (v2TaskGroupId(dragged) !== groupId || v2TaskListId(dragged) !== listId)
      if (movedGroup || Number(task.sortOrder) !== sortOrder) {
        patches.push({ task: task, sortOrder: sortOrder, move: movedGroup })
      }
    })
    if (!patches.length) return
    /* 同步 in-flight 锁：并发 drop 直接丢弃，避免用旧 rev 触发 409 */
    if (opLockRef.current.busy) return
    runMutation(async function doReorder() {
      await applyReorderPatches(patches, groupId, listId)
    }, '已调整排序')
  }

  function reorderTaskRelative(draggedId, targetId) {
    if (!draggedId || !targetId || draggedId === targetId) return
    const dragged = state.tasks.filter(function f(t) { return t.id === draggedId })[0]
    const target = state.tasks.filter(function f(t) { return t.id === targetId })[0]
    if (!dragged || !target) return
    const groupId = v2TaskGroupId(target)
    const listId = v2TaskListId(target)
    const bucket = state.tasks.filter(function f(t) {
      return v2TaskGroupId(t) === groupId && v2TaskListId(t) === listId && !v2TaskParentId(t)
    })
    const ordered = v2SortTasks(bucket.slice(), 'custom').filter(function f(t) { return t.id !== dragged.id })
    const index = ordered.findIndex(function f(t) { return t.id === target.id })
    if (index < 0) ordered.push(dragged)
    else ordered.splice(index, 0, dragged)
    reorderWithinManual(dragged, ordered, groupId, listId)
  }

  function appendTaskToGroup(draggedId, groupId, listId) {
    if (!draggedId) return
    const dragged = state.tasks.filter(function f(t) { return t.id === draggedId })[0]
    if (!dragged) return
    const bucket = state.tasks.filter(function f(t) {
      return v2TaskGroupId(t) === groupId && v2TaskListId(t) === listId && !v2TaskParentId(t)
    })
    const ordered = v2SortTasks(bucket.slice(), 'custom').filter(function f(t) { return t.id !== dragged.id })
    ordered.push(dragged)
    reorderWithinManual(dragged, ordered, groupId, listId)
  }

  function startRenameGroup(group) {
    update({ renamingGroupId: group.id, renameGroupText: group.name || '' })
  }

  function renameGroup(group) {
    const name = String(state.renameGroupText || '').trim()
    if (!name || name === group.name) {
      update({ renamingGroupId: null })
      return
    }
    runMutation(async function doRename() {
      await apiRequest('/groups/' + encodeURIComponent(group.id), {
        method: 'PATCH',
        body: JSON.stringify({ expectedRev: group.rev, name: name }),
      })
      update({ renamingGroupId: null })
    }, '分组已重命名')
  }

  function openGroupMenu(group, listId) {
    openV2PlainMenu(160, 160, [
      { label: '重命名分组', icon: 'edit', onClick: function onClick() { startRenameGroup(group) } },
      { label: '移动到其他清单', icon: 'move', onClick: function onClick() { moveGroupToList(group, listId) } },
      { type: 'separator' },
      {
        label: '删除分组（任务移入未分组）',
        icon: 'trash',
        danger: true,
        onClick: function onClick() {
          runMutation(async function doDelete() {
            await apiRequest('/groups/' + encodeURIComponent(group.id) + '?expectedRev=' + encodeURIComponent(group.rev), { method: 'DELETE' })
          }, '分组已删除，任务移入未分组')
        },
      },
    ])
  }

  function moveGroupToList(group, fromListId) {
    const others = state.lists.filter(function f(list) { return list.id !== fromListId })
    if (!others.length) {
      runtime.toast('error', '没有其他清单可移动')
      return
    }
    openV2PlainMenu(180, 200, others.map(function map(list) {
      return {
        label: list.name,
        icon: 'layers',
        onClick: function onClick() {
          runMutation(async function doMove() {
            /* 先拿最新任务列表，避免用旧 rev 迁移触发 409 */
            const snapshot = await reload(false)
            if (!snapshot) throw new Error('刷新任务列表失败')
            const tasks = (snapshot.tasks || []).filter(function f(task) { return v2TaskGroupId(task) === group.id })
            const created = await apiRequest('/lists/' + encodeURIComponent(list.id) + '/groups', {
              method: 'POST',
              body: JSON.stringify({ name: group.name }),
            })
            const newGroupId = created && created.group && created.group.id
            if (!newGroupId) throw new Error('创建目标分组失败')
            for (const task of tasks) {
              try {
                await apiRequest('/tasks/' + encodeURIComponent(task.id), {
                  method: 'PATCH',
                  body: JSON.stringify({ expectedRev: task.rev, listId: list.id, groupId: newGroupId }),
                })
              } catch (error) {
                if (!v2IsConflictError(error)) throw error
                const latest = await reload(false)
                const current = v2FindTaskById((latest && latest.tasks) || [], task.id)
                if (!current) continue
                await apiRequest('/tasks/' + encodeURIComponent(current.id), {
                  method: 'PATCH',
                  body: JSON.stringify({ expectedRev: current.rev, listId: list.id, groupId: newGroupId }),
                })
              }
            }
            /* 任务全部迁走后，原清单中的旧分组必须删除（rev 过期则刷新后重删） */
            try {
              await apiRequest('/groups/' + encodeURIComponent(group.id) + '?expectedRev=' + encodeURIComponent(group.rev), { method: 'DELETE' })
            } catch (error) {
              const code = String((error && error.code) || '')
              if (v2IsConflictError(error)) {
                const latest = await reload(false)
                const found = ((latest && latest.groups) || []).filter(function f(item) { return item.id === group.id })[0]
                if (found) {
                  await apiRequest('/groups/' + encodeURIComponent(found.id) + '?expectedRev=' + encodeURIComponent(found.rev), { method: 'DELETE' })
                }
              } else if (!/not[_-]?found/i.test(code) && !(error && error.status === 404)) {
                throw error
              }
            }
          }, '分组已移动到「' + list.name + '」')
        },
      }
    }))
  }

  function submitGroupAdd() {
    const target = state.groupAdd
    const text = String(state.groupAddText || '').trim()
    if (!target || !text) return
    createTask(text, { listId: target.listId, groupId: target.groupId || null })
    update({ groupAddText: '' })
  }

  /* ═════════ 计数（与列表同谓词：顶层 + 未取消） ═════════ */

  function scopeCountOf(scope) {
    const kind = scope && scope.kind
    if (kind === 'done') return state.done.length
    if (kind === 'trash') return state.trash.length
    return scopeTasksOf(scope).filter(function count(task) {
      return v2TaskOpen(task) && !v2TaskParentId(task)
    }).length
  }

  function listTaskCount(list) {
    const inList = function inList(task) { return v2TaskListId(task) === list.id }
    return state.tasks.filter(inList).length + state.done.filter(inList).length
  }

  function visibleLists() {
    return state.lists.filter(function filter(list) {
      if ((list.kind || 'normal') !== 'inbox') return true
      /* 默认 inbox 清单若仍有任务，保留显示（否则任务不可达）；空清单由 reload 自动清理 */
      return listTaskCount(list) > 0
    })
  }

  /* ═════════ 三栏布局：收起 / 拖拽调宽（localStorage 记忆） ═════════ */

  function savePanes(next) {
    setPanes(next)
    v2WriteTaskPanes(next)
  }

  function toggleListPane() {
    savePanes(Object.assign({}, panesRef.current, { listCollapsed: !panesRef.current.listCollapsed }))
  }

  function beginPaneDrag(kind, event) {
    if (!event) return
    if (event.preventDefault) event.preventDefault()
    if (event.stopPropagation) event.stopPropagation()
    const startX = Number(event.clientX) || 0
    const current = panesRef.current
    const startWidth = kind === 'list' ? current.list : current.detail
    const min = kind === 'list' ? V2_PANE_LIST_MIN : V2_PANE_DETAIL_MIN
    const max = kind === 'list' ? V2_PANE_LIST_MAX : V2_PANE_DETAIL_MAX
    let next = Object.assign({}, current)
    function onMove(moveEvent) {
      const delta = kind === 'list' ? moveEvent.clientX - startX : startX - moveEvent.clientX
      const width = Math.max(min, Math.min(max, Math.round(startWidth + delta)))
      next = Object.assign({}, next, kind === 'list' ? { list: width } : { detail: width })
      setPanes(next)
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      v2WriteTaskPanes(next)
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  /* ═════════ 拖拽去抖：同一 task 的重复 drop 直接忽略 ═════════ */

  function acceptDrop(key) {
    const now = Date.now()
    const last = dropGuardRef.current
    if (last.key && last.key === key && now - last.at < 600) return false
    dropGuardRef.current = { key: key, at: now }
    return true
  }

  function clearDragPayload() {
    try {
      window.__lifeosV2DragTaskId = null
    } catch (error) {
      /* ignore */
    }
  }

  /* ═════════ 排序提交：串行 PATCH + conflict 静默 reload 重试一次 ═════════ */

  async function sendReorderPatches(list, groupId, listId) {
    for (const item of list) {
      const latest = v2FindTaskById(stateRef.current.tasks, item.task.id)
      const body = { expectedRev: latest ? latest.rev : item.task.rev, sortOrder: item.sortOrder }
      if (item.move) {
        body.groupId = groupId || null
        body.listId = listId || null
      }
      await apiRequest('/tasks/' + encodeURIComponent(item.task.id), {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
    }
  }

  async function applyReorderPatches(patches, groupId, listId) {
    try {
      await sendReorderPatches(patches, groupId, listId)
    } catch (error) {
      if (!v2IsConflictError(error)) throw error
      const fresh = await reload(false)
      const tasks = (fresh && fresh.tasks) || []
      const retry = patches
        .map(function remap(item) {
          const current = v2FindTaskById(tasks, item.task.id)
          return current ? { task: current, sortOrder: item.sortOrder, move: item.move } : null
        })
        .filter(Boolean)
      if (!retry.length) return
      await sendReorderPatches(retry, groupId, listId)
    }
  }

  /* ═════════ 重复属性（repeatRule）编辑 ═════════ */

  function repeatPatch(task, rule) {
    patchTask(task.id, task.rev, { repeatRule: rule }, null)
  }

  function setRepeatKind(task, current, kind) {
    if (kind === 'none') return repeatPatch(task, null)
    if (kind === 'daily') return repeatPatch(task, { kind: 'daily' })
    if (kind === 'weekly') {
      const days = current && current.kind === 'weekly' && current.days && current.days.length ? current.days : [v2IsoWeekday(todayIso())]
      return repeatPatch(task, { kind: 'weekly', days: days })
    }
    if (kind === 'monthly') {
      const day = current && current.kind === 'monthly' ? current.day : Number(String(todayIso()).slice(8, 10)) || 1
      return repeatPatch(task, { kind: 'monthly', day: day })
    }
  }

  function toggleRepeatWeekday(task, current, weekday) {
    const days = current && current.kind === 'weekly' && current.days ? current.days.slice() : [v2IsoWeekday(todayIso())]
    const index = days.indexOf(weekday)
    if (index >= 0) days.splice(index, 1)
    else days.push(weekday)
    if (!days.length) return
    days.sort(function asc(a, b) { return a - b })
    repeatPatch(task, { kind: 'weekly', days: days })
  }

  function setRepeatMonthDay(task, value) {
    const day = Math.max(1, Math.min(31, Math.round(Number(value) || 1)))
    repeatPatch(task, { kind: 'monthly', day: day })
  }

  /* ═════════ 标签编辑弹窗（自绘 DOM：遮罩点击 / Esc 关闭） ═════════ */

  function tagUsageCount(fresh, tagId) {
    const tasks = (fresh ? fresh.tasks : stateRef.current.tasks) || []
    const done = (fresh ? fresh.done : stateRef.current.done) || []
    return tasks.concat(done).filter(function count(task) {
      return (task.tags || []).some(function has(tag) { return tag.id === tagId })
    }).length
  }

  function openTagEditor() {
    if (modalRef.current) return
    modalRef.current = true
    const mask = document.createElement('div')
    Object.assign(mask.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      bottom: '0',
      background: 'rgba(0,0,0,0.45)',
      zIndex: '99998',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    })
    const panel = document.createElement('div')
    Object.assign(panel.style, {
      width: '400px',
      maxWidth: '92vw',
      maxHeight: '76vh',
      display: 'flex',
      flexDirection: 'column',
      background: V2_T.surface.panel,
      border: '1px solid ' + V2_T.border.subtle,
      borderRadius: V2_T.radius.lg + 'px',
      boxShadow: V2_T.shadow.pop,
      overflow: 'hidden',
    })
    let closed = false
    function close() {
      if (closed) return
      closed = true
      modalRef.current = false
      if (mask.parentNode) mask.parentNode.removeChild(mask)
      document.removeEventListener('keydown', onModalKey, true)
    }
    function onModalKey(event) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    function makeButton(label, kind, extra) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      Object.assign(button.style, v2BtnStyle(kind || 'ghost', Object.assign({ fontSize: '11px', padding: '2px 7px' }, extra || {})))
      return button
    }
    function makeInput(value, placeholder) {
      const input = document.createElement('input')
      input.value = value || ''
      input.placeholder = placeholder || ''
      Object.assign(input.style, v2InputStyle({ flex: '1 1 auto', fontSize: '12px', padding: '4px 8px', border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm + 'px' }))
      return input
    }
    /* 头部 */
    const header = document.createElement('div')
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '10px 12px',
      borderBottom: '1px solid ' + V2.line,
    })
    const heading = document.createElement('span')
    heading.textContent = '编辑标签'
    Object.assign(heading.style, { fontSize: '13px', fontWeight: '600', color: V2_T.text.primary })
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.textContent = '×'
    closeBtn.title = '关闭'
    Object.assign(closeBtn.style, v2IconBtnStyle({ width: '22px', height: '22px', fontSize: '15px', lineHeight: '18px' }))
    closeBtn.onclick = close
    header.appendChild(heading)
    header.appendChild(closeBtn)
    /* 新建行 */
    const createRow = document.createElement('div')
    Object.assign(createRow.style, {
      display: 'flex',
      gap: '6px',
      padding: '8px 12px',
      borderBottom: '1px solid ' + V2.line,
      alignItems: 'center',
    })
    const nameInput = makeInput('', '新标签名称')
    const addBtn = makeButton('新建', 'primary', { fontSize: '11px', padding: '4px 10px' })
    createRow.appendChild(nameInput)
    createRow.appendChild(addBtn)
    /* 列表容器 */
    const listBox = document.createElement('div')
    Object.assign(listBox.style, { flex: '1 1 auto', overflowY: 'auto', padding: '4px 8px 10px', minHeight: '60px' })
    /* 底部提示 */
    const footer = document.createElement('div')
    Object.assign(footer.style, {
      padding: '6px 12px 8px',
      fontSize: '11px',
      color: V2_T.text.tertiary,
      borderTop: '1px solid ' + V2_T.border.subtle,
    })
    footer.textContent = '标签改名/删除会同步到所有任务；Host 暂不支持时请稍后再试'
    panel.appendChild(header)
    panel.appendChild(createRow)
    panel.appendChild(listBox)
    panel.appendChild(footer)
    mask.appendChild(panel)
    mask.addEventListener('mousedown', function onMask(event) {
      if (event.target === mask) close()
    })
    document.body.appendChild(mask)
    document.addEventListener('keydown', onModalKey, true)

    let renamingId = null
    let renamingValue = ''
    let deletingId = null

    function renderRows(fresh) {
      if (closed) return
      const tags = ((fresh ? fresh.tags : stateRef.current.tags) || []).slice()
      while (listBox.firstChild) listBox.removeChild(listBox.firstChild)
      if (!tags.length) {
        const empty = document.createElement('div')
        empty.textContent = '暂无标签'
        Object.assign(empty.style, { padding: '8px 6px', fontSize: '11px', color: V2.faint })
        listBox.appendChild(empty)
        return
      }
      tags.forEach(function renderRow(tag) {
        const row = document.createElement('div')
        Object.assign(row.style, {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 4px',
          borderBottom: '1px solid ' + V2.line,
          minHeight: '30px',
        })
        const dot = document.createElement('span')
        Object.assign(dot.style, {
          width: '9px',
          height: '9px',
          borderRadius: '50%',
          background: tag.color || V2.accent,
          flex: '0 0 auto',
        })
        row.appendChild(dot)
        if (renamingId === tag.id) {
          const input = makeInput(renamingValue, '标签名称')
          input.oninput = function onInput() { renamingValue = input.value }
          input.onkeydown = function onKeyDown(event) {
            if (event.key === 'Enter') {
              event.preventDefault()
              submitRename(tag, input.value)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              renamingId = null
              renderRows()
            }
          }
          const saveBtn = makeButton('保存', 'primary')
          saveBtn.onclick = function onClick() { submitRename(tag, input.value) }
          const cancelBtn = makeButton('取消')
          cancelBtn.onclick = function onClick() {
            renamingId = null
            renderRows()
          }
          row.appendChild(input)
          row.appendChild(saveBtn)
          row.appendChild(cancelBtn)
          listBox.appendChild(row)
          setTimeout(function focusInput() { input.focus() }, 0)
          return
        }
        const name = document.createElement('span')
        name.textContent = tag.name
        Object.assign(name.style, { flex: '1 1 auto', fontSize: '12px', color: V2.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
        const usage = document.createElement('span')
        usage.textContent = String(tagUsageCount(fresh, tag.id)) + ' 项'
        Object.assign(usage.style, { fontSize: '11px', color: V2_T.text.tertiary, flex: '0 0 auto' })
        row.appendChild(name)
        row.appendChild(usage)
        if (deletingId === tag.id) {
          const warn = document.createElement('span')
          warn.textContent = '确认删除？'
          Object.assign(warn.style, { fontSize: '10px', color: V2.danger })
          const yes = makeButton('删除', 'danger', { border: '1px solid ' + V2.danger })
          yes.onclick = function onClick() { submitDelete(tag) }
          const no = makeButton('取消')
          no.onclick = function onClick() {
            deletingId = null
            renderRows()
          }
          row.appendChild(warn)
          row.appendChild(yes)
          row.appendChild(no)
          listBox.appendChild(row)
          return
        }
        const renameBtn = makeButton('重命名')
        renameBtn.onclick = function onClick() {
          renamingId = tag.id
          renamingValue = tag.name
          deletingId = null
          renderRows()
        }
        const deleteBtn = makeButton('删除', 'danger')
        deleteBtn.onclick = function onClick() {
          deletingId = tag.id
          renamingId = null
          renderRows()
        }
        row.appendChild(renameBtn)
        row.appendChild(deleteBtn)
        listBox.appendChild(row)
      })
    }

    async function refresh(successLabel) {
      try {
        const fresh = await reload(false)
        renderRows(fresh)
        if (successLabel) runtime.toast('success', successLabel)
      } catch (error) {
        runtime.toast('error', '操作失败：' + errorText(error))
      }
    }

    function createTag() {
      const name = String(nameInput.value || '').trim()
      if (!name) {
        runtime.toast('error', '标签名称不能为空')
        return
      }
      apiRequest('/tags', { method: 'POST', body: JSON.stringify({ name: name }) })
        .then(function then() {
          nameInput.value = ''
          return refresh('已新建标签「' + name + '」')
        })
        .catch(function onError(error) {
          runtime.toast('error', '新建标签失败：' + errorText(error))
        })
    }

    function submitRename(tag, value) {
      const name = String(value || '').trim()
      if (!name || name === tag.name) {
        renamingId = null
        renderRows()
        return
      }
      apiRequest('/tags/' + encodeURIComponent(tag.id), {
        method: 'PATCH',
        body: JSON.stringify({ name: name, expectedRev: tag.rev }),
      })
        .then(function then() {
          renamingId = null
          return refresh('标签已重命名')
        })
        .catch(function onError(error) {
          runtime.toast('error', '重命名失败：' + errorText(error))
        })
    }

    function submitDelete(tag) {
      apiRequest('/tags/' + encodeURIComponent(tag.id) + '?expectedRev=' + encodeURIComponent(tag.rev), { method: 'DELETE' })
        .then(function then() {
          deletingId = null
          if (stateRef.current.scope.kind === 'tag' && stateRef.current.scope.id === tag.id) {
            selectScope({ kind: 'inbox' })
          }
          return refresh('标签已删除')
        })
        .catch(function onError(error) {
          runtime.toast('error', '删除标签失败：' + errorText(error))
        })
    }

    addBtn.onclick = createTag
    nameInput.onkeydown = function onKeyDown(event) {
      if (event.key === 'Enter') {
        event.preventDefault()
        createTag()
      }
    }
    renderRows(null)
    setTimeout(function focusCreate() { nameInput.focus() }, 0)
  }

  function renderLeft() {
    function navItem(scope, label, count, icon) {
      const active = state.scope.kind === scope.kind && (!scope.id || state.scope.id === scope.id)
      return h(
        'button',
        {
          key: scopeKey(scope),
          type: 'button',
          onClick: function onClick() { selectScope(scope) },
          onMouseEnter: function enter(e) { e.currentTarget.style.background = active ? V2_T.accent.soft : V2_T.surface.panel2 },
          onMouseLeave: function leave(e) { e.currentTarget.style.background = active ? V2_T.accent.soft : 'transparent' },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '6px 10px',
            marginBottom: 1,
            border: 'none',
            borderRadius: V2_T.radius.sm,
            background: active ? V2_T.accent.soft : 'transparent',
            color: active ? V2_T.accent.base : V2_T.text.secondary,
            fontFamily: COLORS.fontFamily,
            fontSize: 13,
            lineHeight: '18px',
            cursor: 'pointer',
            textAlign: 'left',
            transition: 'background 120ms ease, color 120ms ease',
          },
        },
        h(V2Icon, { name: icon || 'layers', size: 14 }),
        h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
        typeof count === 'number' && count > 0 ? h('span', { style: { fontSize: 11, color: V2_T.text.tertiary, flex: '0 0 auto' } }, String(count)) : null,
      )
    }

    if (!narrow && panes.listCollapsed) {
      return h(
        'div',
        {
          style: {
            width: V2_PANE_LIST_COLLAPSED,
            flex: '0 0 ' + V2_PANE_LIST_COLLAPSED + 'px',
            background: V2_T.surface.side,
            borderRight: '1px solid ' + V2_T.border.subtle,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingTop: 8,
            gap: 6,
            minHeight: 0,
          },
        },
        h('button', {
          type: 'button',
          title: '展开清单栏',
          onClick: toggleListPane,
          style: v2IconBtnStyle({ width: 18, height: 18 }),
        }, h(V2Icon, { name: 'chevR', size: 12 })),
        h(
          'div',
          { style: { flex: '1 1 auto', display: 'flex', alignItems: 'flex-start', justifyContent: 'center' } },
          h('button', {
            type: 'button',
            title: '展开清单栏',
            onClick: toggleListPane,
            style: {
              background: 'transparent',
              border: 'none',
              color: V2.faint,
              cursor: 'pointer',
              writingMode: 'vertical-rl',
              fontSize: 11,
              padding: '6px 2px',
              fontFamily: COLORS.fontFamily,
            },
          }, '清单'),
        ),
      )
    }

    return h(
      'div',
      {
        style: {
          width: narrow ? 'auto' : panes.list,
          flex: narrow ? '1 1 auto' : '0 0 ' + panes.list + 'px',
          minWidth: narrow ? 0 : V2_PANE_LIST_MIN,
          background: V2_T.surface.side,
          borderRight: narrow ? 'none' : '1px solid ' + V2_T.border.subtle,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        },
      },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 12px 8px' } },
        h('span', { style: { fontSize: 12, fontWeight: 600, color: V2_T.text.secondary, letterSpacing: '0.02em' } }, '任务'),
        narrow
          ? null
          : h('button', {
              type: 'button',
              title: '收起清单栏',
              onClick: toggleListPane,
              style: v2IconBtnStyle({ width: 18, height: 18 }),
            }, h(V2Icon, { name: 'chevL', size: 12 })),
      ),
      h(
        'div',
        { style: { flex: '1 1 auto', overflowY: 'auto', padding: '2px 8px 16px', minHeight: 0 } },
        shortcuts.map(function mapShortcut(item) {
          return navItem({ kind: item.kind }, item.label, scopeCountOf({ kind: item.kind }), item.icon)
        }),
        h(
          'div',
          { style: { marginTop: 12, padding: '0 10px 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
          h('span', { style: { fontSize: V2_T.font.caption, fontWeight: 600, color: V2_T.text.tertiary, letterSpacing: '0.02em' } }, '清单'),
          h('button', {
            type: 'button',
            onClick: function onClick() { update({ newListOpen: true, newListName: '' }) },
            style: v2IconBtnStyle({ width: 20, height: 20 }),
          }, h(V2Icon, { name: 'plus', size: 12 })),
        ),
        state.newListOpen
          ? h(
              'div',
              { style: { display: 'flex', gap: 4, padding: '2px 6px 6px' } },
              h('input', {
                autoFocus: true,
                value: state.newListName,
                placeholder: '清单名称',
                onChange: function onChange(e) { update({ newListName: e.target.value }) },
                onKeyDown: function onKeyDown(e) {
                  if (e.key === 'Enter') createList()
                  if (e.key === 'Escape') update({ newListOpen: false })
                },
                style: v2InputStyle({
                  fontSize: 12,
                  padding: '4px 8px',
                  height: 30,
                  background: V2_T.surface.input,
                  border: '1px solid ' + V2_T.border.subtle,
                  borderRadius: V2_T.radius.sm,
                }),
              }),
            )
          : null,
        visibleLists().map(function renderList(list) {
          const count = scopeCountOf({ kind: 'list', id: list.id })
          if (state.renamingListId === list.id) {
            return h(
              'div',
              { key: list.id, style: { display: 'flex', gap: 4, padding: '2px 6px' } },
              h('input', {
                autoFocus: true,
                value: state.renameListText,
                onChange: function onChange(e) { update({ renameListText: e.target.value }) },
                onKeyDown: function onKeyDown(e) {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    renameList(list)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    update({ renamingListId: null })
                  }
                },
                style: v2InputStyle({
                  fontSize: 12,
                  padding: '4px 8px',
                  height: 30,
                  background: V2_T.surface.input,
                  border: '1px solid ' + V2_T.border.subtle,
                  borderRadius: V2_T.radius.sm,
                }),
              }),
            )
          }
          return h(
            'div',
            {
              key: list.id,
              draggable: true,
              title: '拖拽调整清单顺序',
              onDragStart: function onDragStart(e) { startListDrag(e, list) },
              onDragEnd: function onDragEnd() { window.__lifeosV2DragListId = null },
              onDragOver: function onDragOver(e) {
                if (!window.__lifeosV2DragListId) return
                e.preventDefault()
                e.stopPropagation()
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
              },
              onDrop: function onDrop(e) { dropListReorder(e, list) },
              style: { display: 'flex', alignItems: 'center' },
            },
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, navItem({ kind: 'list', id: list.id }, list.name, count, 'layers')),
            h('button', {
              type: 'button',
              title: '清单操作',
              onClick: function onClick(e) { e.stopPropagation(); openListMenu(list, e) },
              style: v2IconBtnStyle({ width: 24, height: 24, opacity: 0.55 }),
            }, h(V2Icon, { name: 'more', size: 12 })),
          )
        }),
        h(
          'div',
          { style: { marginTop: 12, padding: '0 10px 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
          h('span', { style: { fontSize: V2_T.font.caption, fontWeight: 600, color: V2_T.text.tertiary, letterSpacing: '0.02em' } }, '过滤器'),
        ),
        navItem({ kind: 'filter', id: 'high', label: '本周高优先级' }, '本周高优先级', scopeCountOf({ kind: 'filter', id: 'high', label: '本周高优先级' }), 'filter'),
        navItem({ kind: 'filter', id: 'meeting', label: '会议相关' }, '会议相关', scopeCountOf({ kind: 'filter', id: 'meeting', label: '会议相关' }), 'filter'),
        h(
          'div',
          { style: { marginTop: 12, padding: '0 10px 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
          h('span', { style: { fontSize: V2_T.font.caption, fontWeight: 600, color: V2_T.text.tertiary, letterSpacing: '0.02em' } }, '标签'),
          h('button', {
            type: 'button',
            title: '编辑标签',
            onClick: function onClick() { openTagEditor() },
            style: v2IconBtnStyle({ width: 20, height: 20 }),
          }, h(V2Icon, { name: 'settings', size: 12 })),
        ),
        state.tags.length
          ? state.tags.map(function renderTag(tag) {
              const count = scopeCountOf({ kind: 'tag', id: tag.id })
              return navItem({ kind: 'tag', id: tag.id }, tag.name, count, 'tag')
            })
          : h('div', { style: { padding: '2px 10px', fontSize: 11, color: V2.faint } }, '暂无标签'),
        h(
          'div',
          { style: { marginTop: 12, padding: '0 10px 4px' } },
          h('span', { style: { fontSize: V2_T.font.caption, fontWeight: 600, color: V2_T.text.tertiary, letterSpacing: '0.02em' } }, '收纳区'),
        ),
        navItem({ kind: 'done' }, '已完成', state.done.length, 'done'),
        navItem({ kind: 'trash' }, '垃圾桶', state.trash.length, 'trash'),
      ),
    )
  }

  function renderTasksForScope(tasks) {
    if (state.loading) {
      return h(
        'div',
        { style: { padding: 20 } },
        h(SkeletonRows, { count: 6 }),
      )
    }
    if (state.error) {
      return h(Banner, { tone: 'error' }, '加载失败：' + state.error)
    }
    const flatScope = state.scope.kind === 'done' || state.scope.kind === 'trash'
    const visible = tasks
      .filter(function filter(task) { return v2TaskMatchesText(task, '') })
      .filter(function filter(task) {
        if (flatScope) return true
        return !v2TaskParentId(task)
      })
    if (!visible.length) {
      const listScope = state.scope.kind === 'list'
      if (listScope) {
        /* 清单为空也要渲染分组列表与“新建分组”行：
           否则空清单只剩快速添加一个入口，无法在此清单建分组 */
        return renderGroupedList([])
      }
      return h(EmptyState, {
        title: state.scope.kind === 'trash' ? '垃圾桶是空的' : '这里还没有任务',
        hint: state.scope.kind === 'trash' ? '删除的任务会出现在这里' : '试试在下方输入一条任务',
      })
    }
    const sorted = v2SortTasks(visible, state.sort)
    if (state.view === 'board') {
      return renderBoard(sorted)
    }
    if (state.scope.kind === 'list') {
      return renderGroupedList(sorted)
    }
    return renderDateList(sorted)
  }

  function renderGroupedList(tasks) {
    const listId = state.scope.id
    const groups = state.groups.filter(function filter(group) { return (group.listId || group.list_id) === listId })
    const buckets = []
    groups.forEach(function each(group) {
      buckets.push({ id: group.id, name: group.name, tasks: tasks.filter(function f(t) { return v2TaskGroupId(t) === group.id }) })
    })
    const ungrouped = tasks.filter(function f(t) {
      const groupId = v2TaskGroupId(t)
      return !groupId || !groups.some(function some(group) { return group.id === groupId })
    })
    /* 未分组桶始终命名为“未分组”（空清单也渲染），不能因还没有分组就叫“任务” */
    if (ungrouped.length || !groups.length) buckets.push({ id: '', name: '未分组', tasks: ungrouped })
    return h(
      'div',
      { style: { padding: '12px 16px 20px' } },
      buckets.map(function renderBucket(bucket) {
        const key = scopeKey(state.scope) + ':' + bucket.id
        const collapsed = state.collapsed[key] === true
        return h(
          'div',
          { key: bucket.id || 'ungrouped', style: v2CardStyle({ marginBottom: 12, overflow: 'hidden' }) },
          h(
            'div',
            {
              draggable: !!bucket.id,
              title: bucket.id ? '拖拽调整分组顺序' : null,
              onDragStart: bucket.id
                ? function onDragStart(e) {
                    /* 只响应分组标题自身的拖拽，避免任务行拖动冒泡上来被误判为分组拖拽 */
                    if (e.target !== e.currentTarget) return
                    startGroupDrag(e, { id: bucket.id })
                  }
                : null,
              onDragEnd: function onDragEnd() { window.__lifeosV2DragGroupId = null },
              onDragOver: function onDragOver(e) {
                if (!window.__lifeosV2DragGroupId) return
                e.preventDefault()
                e.stopPropagation()
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
              },
              onDrop: bucket.id
                ? function onDrop(e) { dropGroupReorder(e, { id: bucket.id }) }
                : null,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: 38,
                padding: '0 12px',
                borderBottom: collapsed ? 'none' : '1px solid ' + V2_T.border.subtle,
              },
            },
            h('button', {
              type: 'button',
              onClick: function onClick() {
                update({ collapsed: Object.assign({}, state.collapsed, { [key]: !collapsed }) })
              },
              style: v2IconBtnStyle({ width: 18, height: 18 }),
            }, h(V2Icon, { name: collapsed ? 'chev' : 'chevD', size: 12 })),
            state.renamingGroupId === bucket.id
              ? h('input', {
                  autoFocus: true,
                  value: state.renameGroupText,
                  onChange: function onChange(e) { update({ renameGroupText: e.target.value }) },
                  onKeyDown: function onKeyDown(e) {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      const group = state.groups.filter(function f(g) { return g.id === bucket.id })[0]
                      if (group) renameGroup(group)
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      update({ renamingGroupId: null })
                    }
                  },
                  style: v2InputStyle({ fontSize: 12, padding: '3px 8px', width: 150, height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
                })
              : h('span', { style: { fontSize: 13, fontWeight: 600, color: V2_T.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, bucket.name),
            h('span', { style: { fontSize: 11, color: V2_T.text.tertiary } }, String(bucket.tasks.length)),
            h('div', { style: { flex: '1 1 auto' } }),
            bucket.id
              ? h('button', {
                  type: 'button',
                  title: '分组操作',
                  onClick: function onClick() {
                    const group = state.groups.filter(function f(g) { return g.id === bucket.id })[0]
                    if (group) openGroupMenu(group, listId)
                  },
                  style: v2IconBtnStyle({ width: 24, height: 24 }),
                }, h(V2Icon, { name: 'more', size: 13 }))
              : null,
            h('button', {
              type: 'button',
              title: '在此分组添加任务',
              onClick: function onClick() {
                openGroupAdd(listId, bucket.id)
              },
              style: v2IconBtnStyle({ width: 24, height: 24 }),
            }, h(V2Icon, { name: 'plus', size: 13 })),
          ),
          state.groupAdd && state.groupAdd.listId === listId && (state.groupAdd.groupId || '') === bucket.id
            ? h(
                'div',
                { style: { display: 'flex', gap: 4, padding: '4px 12px 6px' } },
                h('input', {
                  autoFocus: true,
                  value: state.groupAddText,
                  placeholder: '任务标题，回车创建',
                  onChange: function onChange(e) { update({ groupAddText: e.target.value }) },
                  onKeyDown: function onKeyDown(e) {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      submitGroupAdd()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      update({ groupAdd: null })
                    }
                  },
                  style: v2InputStyle({ fontSize: 12, padding: '4px 8px', height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
                }),
              )
            : null,
          collapsed
            ? null
            : h(
                'div',
                {
                  onDragOver: function onDragOver(e) { e.preventDefault() },
                  onDrop: function onDrop(e) {
                    e.preventDefault()
                    e.stopPropagation()
                    const dragged = v2DragPayload()
                    if (!dragged || !dragged.taskId) return
                    if (!acceptDrop('group:' + String(bucket.id || 'ungrouped') + ':' + dragged.taskId)) return
                    clearDragPayload()
                    appendTaskToGroup(dragged.taskId, bucket.id || null, listId)
                  },
                  style: { minHeight: 6, padding: '4px 6px 6px' },
                },
                bucket.tasks.length
                  ? bucket.tasks.map(function renderTask(task) { return renderTaskRow(task) })
                  : h(
                      'div',
                      { style: { padding: '6px 10px 8px', fontSize: 11, color: V2_T.text.tertiary } },
                      '暂无任务',
                    ),
              ),
        )
      }),
      h(NewGroupRow, {
        active: state.newGroupListId === listId,
        value: state.newGroupName,
        onOpen: function onOpen() { update({ newGroupListId: listId, newGroupName: '' }) },
        onChange: function onChange(value) { update({ newGroupName: value }) },
        onSubmit: function onSubmit() { createGroup(listId) },
        onCancel: function onCancel() { update({ newGroupListId: null }) },
      }),
    )
  }

  function renderDateList(tasks) {
    if (state.scope.kind === 'done' || state.scope.kind === 'trash') {
      return h('div', { style: { padding: '12px 16px 20px' } }, tasks.map(function renderTask(task) { return renderTaskRow(task) }))
    }
    const today = todayIso()
    const buckets = [
      { id: 'overdue', name: '已逾期', tasks: [] },
      { id: 'today', name: '今天', tasks: [] },
      { id: 'tomorrow', name: '明天', tasks: [] },
      { id: 'next7', name: '最近 7 天', tasks: [] },
      { id: 'later', name: '更远', tasks: [] },
      { id: 'none', name: '无日期', tasks: [] },
    ]
    tasks.forEach(function classify(task) {
      const dateKey = v2TaskDateKey(task)
      if (!dateKey) return buckets[5].tasks.push(task)
      if (dateKey < today) return buckets[0].tasks.push(task)
      if (dateKey === today) return buckets[1].tasks.push(task)
      if (dateKey === addDaysKey(today, 1)) return buckets[2].tasks.push(task)
      if (dateKey <= addDaysKey(today, 7)) return buckets[3].tasks.push(task)
      return buckets[4].tasks.push(task)
    })
    return h(
      'div',
      { style: { padding: '12px 16px 20px' } },
      buckets.map(function renderBucket(bucket) {
        if (!bucket.tasks.length) return null
        const key = scopeKey(state.scope) + ':' + bucket.id
        const collapsed = state.collapsed[key] === true
        return h(
          'div',
          { key: bucket.id, style: v2CardStyle({ marginBottom: 12, overflow: 'hidden' }) },
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: 38,
                padding: '0 12px',
                borderBottom: collapsed ? 'none' : '1px solid ' + V2_T.border.subtle,
              },
            },
            h('button', {
              type: 'button',
              onClick: function onClick() {
                update({ collapsed: Object.assign({}, state.collapsed, { [key]: !collapsed }) })
              },
              style: v2IconBtnStyle({ width: 20, height: 20 }),
            }, h(V2Icon, { name: collapsed ? 'chev' : 'chevD', size: 12 })),
            h('span', { style: { fontSize: 13, fontWeight: 600, color: bucket.id === 'overdue' ? V2_T.status.danger : V2_T.text.primary } }, bucket.name),
            h('span', { style: { fontSize: 11, color: V2_T.text.tertiary } }, String(bucket.tasks.length)),
          ),
          collapsed ? null : h(
            'div',
            { style: { padding: '4px 6px 6px' } },
            bucket.tasks.map(function renderTask(task) { return renderTaskRow(task) }),
          ),
        )
      }),
    )
  }

  function renderBoard(tasks) {
    const buckets = []
    const seen = {}
    tasks.forEach(function each(task) {
      const groupId = v2TaskGroupId(task) || ''
      if (!seen[groupId]) {
        seen[groupId] = true
        buckets.push({ id: groupId, name: groupId ? groupNameOf(groupId) : '未分组', tasks: [] })
      }
      buckets.filter(function f(b) { return b.id === groupId })[0].tasks.push(task)
    })
    if (!buckets.length) buckets.push({ id: '', name: '未分组', tasks: [] })
    return h(
      'div',
      { style: { display: 'flex', gap: 12, padding: '12px 16px 20px', overflowX: 'auto', alignItems: 'flex-start' } },
      buckets.map(function renderColumn(bucket) {
        return h(
          'div',
          {
            key: bucket.id || 'none',
            onDragOver: function onDragOver(e) { e.preventDefault() },
            onDrop: function onDrop(e) {
              e.preventDefault()
              e.stopPropagation()
              const payload = v2DragPayload()
              if (!payload || !payload.taskId) return
              if (!acceptDrop('board:' + String(bucket.id || 'ungrouped') + ':' + payload.taskId)) return
              clearDragPayload()
              const task = state.tasks.filter(function f(t) { return t.id === payload.taskId })[0]
              if (!task) return
              if ((v2TaskGroupId(task) || '') === (bucket.id || '')) return
              patchTask(task.id, task.rev, { groupId: bucket.id || null }, '已移动')
            },
            style: v2CardStyle({
              flex: '0 0 260px',
              padding: 8,
              minHeight: 120,
              boxSizing: 'border-box',
            }),
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px 10px' } },
            h('span', { style: { fontSize: 13, fontWeight: 600, color: V2_T.text.primary } }, bucket.name),
            h('span', { style: { fontSize: 11, color: V2_T.text.tertiary } }, String(bucket.tasks.length)),
          ),
          bucket.tasks.map(function renderTask(task) { return renderTaskRow(task, 0, true) }),
        )
      }),
    )
  }

  function subtasksOf(taskId) {
    const seen = {}
    const all = state.tasks.concat(state.done)
    const out = []
    all.forEach(function each(task) {
      if (v2TaskParentId(task) !== taskId) return
      if (seen[task.id]) return
      seen[task.id] = true
      out.push(task)
    })
    return v2SortTasks(out, state.sort)
  }

  function renderTaskRow(task, depth, carded) {
    const level = depth || 0
    const children = subtasksOf(task.id)
    const doneChild = children.filter(function f(t) { return v2TaskCompleted(t) }).length
    const row = h(TaskArowV2, {
      key: task.id,
      task: task,
      selected: state.selectedId === task.id || state.selectedIds.indexOf(task.id) >= 0,
      editing: state.editingId === task.id,
      childCount: children.length,
      doneChild: doneChild,
      /* 看板列内用浮起卡片视觉；列表/详情内保持扁平行（仅样式变体） */
      card: carded === true,
      listName: state.scope.kind === 'list' ? null : listNameOf(v2TaskListId(task)),
      onToggle: toggleTask,
      onOpen: state.selectionMode
        ? function onSelect(target) { toggleSelect(target.id) }
        : openDetail,
      onStartEdit: function onStartEdit(target) { update({ editingId: target.id }) },
      onCancelEdit: function onCancelEdit() { update({ editingId: null }) },
      onCommitTitle: function onCommitTitle(title) { commitTitle(task.id, title, task.rev) },
      onMore: openTaskMenu,
      onDragStart: function onDragStart(event, target) {
        try {
          event.dataTransfer.setData('text/plain', target.id)
          event.dataTransfer.effectAllowed = 'move'
          window.__lifeosV2DragTaskId = target.id
        } catch (error) {
          /* ignore */
        }
      },
      onDrop: function onDrop(event, target) {
        if (event && event.stopPropagation) event.stopPropagation()
        const draggedId = window.__lifeosV2DragTaskId
        if (!draggedId || draggedId === target.id) return
        if (!acceptDrop('row:' + target.id + ':' + draggedId)) return
        clearDragPayload()
        reorderTaskRelative(draggedId, target.id)
      },
    })
    if (!children.length || level >= 2) return row
    return h(
      'div',
      { key: task.id + ':node' },
      row,
      h(
        'div',
        {
          style: {
            marginLeft: 20,
            paddingLeft: 10,
            borderLeft: '1px solid ' + V2_T.border.subtle,
            marginBottom: 4,
          },
        },
        children.map(function map(child) { return renderTaskRow(child, level + 1) }),
      ),
    )
  }

  function renderQuickAdd() {
    return h(
      'div',
      { style: { padding: '10px 16px 6px' } },
      h(
        'div',
        {
          style: v2CardStyle({
            padding: '10px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            transition: 'border-color 120ms ease, box-shadow 120ms ease',
          }),
        },
        h(V2Icon, { name: 'plus', size: 15, color: V2_T.text.tertiary }),
        h('input', {
          ref: inputRef,
          value: state.quickAdd,
          placeholder: '添加任务，回车创建（可写“明天上午 9 点 !高”）',
          onChange: function onChange(e) {
            const value = e.target.value
            const parsed = value.trim() ? v2ParseTarget(value, todayIso()) : null
            update({
              quickAdd: value,
              quickAddHint: parsed && (parsed.matchedDate || parsed.matchedPriority)
                ? [parsed.dateKey ? '日期 ' + parsed.dateKey : '', parsed.priority && parsed.priority !== 'none' ? '优先级 ' + parsed.priority : ''].filter(Boolean).join(' · ')
                : '',
            })
          },
          onKeyDown: function onKeyDown(e) {
            if (e.key === 'Enter') {
              e.preventDefault()
              const extra = state.scope.kind === 'list'
                ? { listId: state.scope.id || null, groupId: null }
                : null
              createTask(state.quickAdd, extra)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              update({ quickAdd: '', quickAddHint: '' })
            }
          },
          style: v2InputStyle({ flex: '1 1 auto', border: 'none', background: 'transparent', fontSize: 13, padding: 0, height: 22 }),
        }),
        state.quickAddHint
          ? h('span', { style: { fontSize: 11, color: V2_T.accent.base, whiteSpace: 'nowrap' } }, state.quickAddHint)
          : h('span', { style: { fontSize: 11, color: V2_T.text.tertiary, whiteSpace: 'nowrap' } }, 'N 聚焦'),
      ),
    )
  }

  function renderMain() {
    const tasks = scopeTasks()
    const count = scopeCountOf(state.scope)
    return h(
      'div',
      { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: V2_T.surface.app } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', height: V2_T.line.header, minHeight: V2_T.line.header, boxSizing: 'border-box', borderBottom: '1px solid ' + V2_T.border.subtle } },
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
            h('h3', { style: { margin: 0, fontSize: 20, fontWeight: 600, color: V2_T.text.primary, lineHeight: '26px', letterSpacing: '-0.01em' } }, scopeTitleOf(state.scope)),
            h('span', { style: { fontSize: 12, color: V2_T.text.tertiary, fontWeight: 500 } }, String(count) + ' 项'),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('button', {
            type: 'button',
            title: state.selectionMode ? '退出多选' : '多选任务',
            onClick: function onClick() {
              update({ selectionMode: !state.selectionMode, selectedIds: [] })
            },
            style: v2ToolbarBtnStyle(state.selectionMode),
            onMouseEnter: function onEnter(e) { e.currentTarget.style.background = V2_T.surface.panel2 },
            onMouseLeave: function onLeave(e) { e.currentTarget.style.background = state.selectionMode ? V2_T.accent.soft : 'transparent' },
            onFocus: function onFocus(e) { Object.assign(e.currentTarget.style, v2FocusRing({})) },
            onBlur: function onBlur(e) { e.currentTarget.style.boxShadow = 'none' },
          }, h(V2Icon, { name: 'done', size: 15 })),
          h('button', {
            type: 'button',
            title: '列表视图',
            onClick: function onClick() { update({ view: 'list' }) },
            style: v2ToolbarBtnStyle(state.view === 'list'),
            onMouseEnter: function onEnter(e) { e.currentTarget.style.background = V2_T.surface.panel2 },
            onMouseLeave: function onLeave(e) { e.currentTarget.style.background = state.view === 'list' ? V2_T.accent.soft : 'transparent' },
            onFocus: function onFocus(e) { Object.assign(e.currentTarget.style, v2FocusRing({})) },
            onBlur: function onBlur(e) { e.currentTarget.style.boxShadow = 'none' },
          }, h(V2Icon, { name: 'list', size: 16 })),
          h('button', {
            type: 'button',
            title: '看板视图',
            onClick: function onClick() { update({ view: 'board' }) },
            style: v2ToolbarBtnStyle(state.view === 'board'),
            onMouseEnter: function onEnter(e) { e.currentTarget.style.background = V2_T.surface.panel2 },
            onMouseLeave: function onLeave(e) { e.currentTarget.style.background = state.view === 'board' ? V2_T.accent.soft : 'transparent' },
            onFocus: function onFocus(e) { Object.assign(e.currentTarget.style, v2FocusRing({})) },
            onBlur: function onBlur(e) { e.currentTarget.style.boxShadow = 'none' },
          }, h(V2Icon, { name: 'board', size: 16 })),
          h('button', {
            type: 'button',
            title: '排序',
            onClick: function onClick(e) {
              const rect = e.currentTarget.getBoundingClientRect()
              openV2PlainMenu(rect.right - 180, rect.bottom + 6, [
                { label: '自定义排序', icon: state.sort === 'custom' ? 'check' : 'drag', onClick: function onClick() { update({ sort: 'custom' }) } },
                { label: '按创建时间', icon: state.sort === 'created' ? 'check' : 'clock', onClick: function onClick() { update({ sort: 'created' }) } },
                { label: '按日期', icon: state.sort === 'date' ? 'check' : 'calendar', onClick: function onClick() { update({ sort: 'date' }) } },
                { label: '按优先级', icon: state.sort === 'priority' ? 'check' : 'flag', onClick: function onClick() { update({ sort: 'priority' }) } },
              ])
            },
            style: v2ToolbarBtnStyle(false),
            onMouseEnter: function onEnter(e) { e.currentTarget.style.background = V2_T.surface.panel2 },
            onMouseLeave: function onLeave(e) { e.currentTarget.style.background = 'transparent' },
            onFocus: function onFocus(e) { Object.assign(e.currentTarget.style, v2FocusRing({})) },
            onBlur: function onBlur(e) { e.currentTarget.style.boxShadow = 'none' },
          }, h(V2Icon, { name: 'filter', size: 15 })),
        ),
      ),
      renderSelectionBar(),
      renderQuickAdd(),
      h(
        'div',
        { style: { flex: '1 1 auto', overflowY: 'auto', minHeight: 0 } },
        renderTasksForScope(tasks),
      ),
    )
  }

  function renderDetail() {
    const task = state.detail
    if (!task) return null
    const children = state.tasks.filter(function f(t) { return v2TaskParentId(t) === task.id }).concat(
      state.done.filter(function f(t) { return v2TaskParentId(t) === task.id }),
    )
    const listId = v2TaskListId(task)
    return h(
      'div',
      {
        ref: detailRef,
        style: {
          width: narrow ? 'auto' : panes.detail,
          flex: narrow ? '1 1 auto' : '0 0 ' + panes.detail + 'px',
          borderLeft: narrow ? 'none' : '1px solid ' + V2_T.border.subtle,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          background: V2_T.surface.shell,
        },
      },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid ' + V2_T.border.subtle } },
        h('button', {
          type: 'button',
          onClick: function onClick() { toggleTask(task) },
          style: v2CheckStyle(task),
        }, v2TaskCompleted(task) ? h(V2Icon, { name: 'check', size: 11, color: '#0b0e14', strokeWidth: 3 }) : null),
        h('input', {
          value: task.title,
          onChange: function onChange(e) { update({ detail: Object.assign({}, task, { title: e.target.value }) }) },
          onBlur: function onBlur(e) {
            const value = String(e.target.value || '').trim()
            if (value && value !== task.title) patchTask(task.id, task.rev, { title: value }, null)
          },
          style: v2InputStyle({ flex: '1 1 auto', border: 'none', background: 'transparent', fontSize: 18, fontWeight: 600, color: V2_T.text.primary, padding: '2px 0', lineHeight: '26px' }),
        }),
        h('button', {
          type: 'button',
          onClick: closeDetail,
          style: v2IconBtnStyle({ width: 28, height: 28 }),
        }, h(V2Icon, { name: 'close', size: 15 })),
      ),
      h(
        'div',
        { style: { flex: '1 1 auto', overflowY: 'auto', padding: '16px', minHeight: 0 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px 12px', fontSize: 12, color: V2_T.text.secondary } },
          h(V2Icon, { name: 'calendar', size: 13 }),
          h('span', null, v2TaskDateText(task) || '无日期'),
          h('span', { style: { marginLeft: 'auto' } }, listNameOf(listId)),
        ),
        h(
          'div',
          { style: Object.assign(v2CardStyle({ padding: '6px 12px', marginBottom: 12 }), { display: 'grid', gridTemplateColumns: '76px 1fr', columnGap: 8, rowGap: 0, gridAutoRows: 'minmax(34px, auto)', alignItems: 'center', fontSize: 12 }) },
          h('span', { style: { color: V2_T.text.tertiary, fontSize: 12 } }, '日期'),
          h('input', {
            type: 'date',
            value: v2TaskDateKey(task) || '',
            onChange: function onChange(e) {
              const value = e.target.value || null
              patchTask(task.id, task.rev, {
                scheduledDate: value,
                scheduledStartAt: null,
                scheduledEndAt: null,
              }, null)
            },
            style: v2InputStyle({ fontSize: 13, padding: '4px 8px', height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
          }),
          h('span', { style: { color: V2_T.text.tertiary, fontSize: 12 } }, '时间'),
          h(
            'div',
            { style: { display: 'flex', gap: 4 } },
            h('input', {
              type: 'time',
              value: v2LocalTime(task.scheduledStartAt || task.scheduled_start_at),
              onChange: function onChange(e) {
                const dateKey = v2TaskDateKey(task) || todayIso()
                const start = v2IsoFromLocal(dateKey, e.target.value)
                if (!start) {
                  patchTask(task.id, task.rev, {
                    scheduledDate: dateKey,
                    scheduledStartAt: null,
                    scheduledEndAt: null,
                  }, null)
                  return
                }
                let end = task.scheduledEndAt || task.scheduled_end_at || null
                if (!end || Date.parse(end) <= Date.parse(start)) end = v2IsoAddMinutes(start, 60)
                patchTask(task.id, task.rev, {
                  scheduledDate: null,
                  scheduledStartAt: start,
                  scheduledEndAt: end,
                }, null)
              },
              style: v2InputStyle({ fontSize: 13, padding: '4px 8px', height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
            }),
            h('input', {
              type: 'time',
              value: v2LocalTime(task.scheduledEndAt || task.scheduled_end_at),
              onChange: function onChange(e) {
                const dateKey = v2TaskDateKey(task) || todayIso()
                const end = v2IsoFromLocal(dateKey, e.target.value)
                const currentStart = task.scheduledStartAt || task.scheduled_start_at || null
                if (!end) {
                  patchTask(task.id, task.rev, {
                    scheduledDate: dateKey,
                    scheduledStartAt: null,
                    scheduledEndAt: null,
                  }, null)
                  return
                }
                let start = currentStart
                if (!start) start = v2IsoFromLocal(dateKey, '09:00')
                if (Date.parse(end) <= Date.parse(start)) end = v2IsoAddMinutes(start, 30)
                patchTask(task.id, task.rev, {
                  scheduledDate: null,
                  scheduledStartAt: start,
                  scheduledEndAt: end,
                }, null)
              },
              style: v2InputStyle({ fontSize: 13, padding: '4px 8px', height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
            }),
          ),
          h('span', { style: { color: V2_T.text.tertiary, fontSize: 12 } }, '优先级'),
          h(
            'select',
            {
              value: task.priority || 'none',
              onChange: function onChange(e) { patchTask(task.id, task.rev, { priority: e.target.value }, null) },
              style: v2InputStyle({ fontSize: 13, padding: '4px 8px', height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
            },
            V2_PRIORITY_ITEMS.map(function map(item) { return h('option', { key: item.id, value: item.id }, item.label) }),
          ),
          h('span', { style: { color: V2_T.text.tertiary, fontSize: 12 } }, '重复'),
          (function renderRepeat() {
            const rule = v2RepeatRuleOf(task)
            const kind = rule ? rule.kind : 'none'
            function chipStyle(active) {
              return v2BtnStyle('ghost', {
                fontSize: 11,
                lineHeight: '16px',
                padding: '3px 10px',
                borderRadius: V2_T.radius.pill,
                border: '1px solid ' + (active ? V2_T.accent.line : V2_T.border.subtle),
                background: active ? V2_T.accent.soft : V2_T.surface.panel2,
                color: active ? V2_T.accent.base : V2_T.text.secondary,
              })
            }
            const parts = [
              h(
                'div',
                { key: 'kinds', style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } },
                h(V2Icon, { name: 'repeat', size: 12, color: V2_T.text.tertiary }),
                [
                  { id: 'none', label: '不重复' },
                  { id: 'daily', label: '每天' },
                  { id: 'weekly', label: '每周' },
                  { id: 'monthly', label: '每月' },
                ].map(function map(item) {
                  return h('button', {
                    key: item.id,
                    type: 'button',
                    onClick: function onClick() { setRepeatKind(task, rule, item.id) },
                    style: chipStyle(kind === item.id),
                  }, item.label)
                }),
                h('span', { style: { fontSize: 11, color: V2_T.text.tertiary, marginLeft: 2 } }, v2RepeatLabel(rule)),
              ),
            ]
            if (kind === 'weekly') {
              parts.push(
                h(
                  'div',
                  { key: 'weekdays', style: { display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' } },
                  V2_WEEKDAY_LABELS.map(function mapWeekday(label, index) {
                    const weekday = index + 1
                    const active = !!rule && rule.kind === 'weekly' && rule.days.indexOf(weekday) >= 0
                    return h('button', {
                      key: 'weekday-' + weekday,
                      type: 'button',
                      title: '周' + label,
                      onClick: function onClick() { toggleRepeatWeekday(task, rule, weekday) },
                      style: chipStyle(active),
                    }, label)
                  }),
                ),
              )
            }
            if (kind === 'monthly') {
              parts.push(
                h(
                  'div',
                  { key: 'monthday', style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: V2_T.text.secondary } },
                  h('span', null, '每月'),
                  h('input', {
                    key: 'monthly-' + task.id + '-' + (rule && rule.kind === 'monthly' ? rule.day : 'none'),
                    type: 'number',
                    min: 1,
                    max: 31,
                    defaultValue: rule && rule.kind === 'monthly' ? String(rule.day) : '1',
                    onBlur: function onBlur(e) { setRepeatMonthDay(task, e.target.value) },
                    onKeyDown: function onKeyDown(e) {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        setRepeatMonthDay(task, e.target.value)
                      }
                    },
                    style: v2InputStyle({ width: 60, fontSize: 12, padding: '3px 8px', height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
                  }),
                  h('span', null, '日'),
                ),
              )
            }
            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, parts)
          })(),
          h('span', { style: { color: V2_T.text.tertiary, fontSize: 12 } }, '清单'),
          h(
            'select',
            {
              value: listId || '',
              onChange: function onChange(e) {
                const target = e.target.value || null
                const patch = { listId: target }
                /* 跨清单时清空分组，避免 Host 报「分组不属于目标清单」 */
                if ((v2TaskListId(task) || null) !== target) patch.groupId = null
                patchTask(task.id, task.rev, patch, null)
              },
              style: v2InputStyle({ fontSize: 13, padding: '4px 8px', height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
            },
            h('option', { value: '' }, '收集箱'),
            visibleLists().map(function map(list) { return h('option', { key: list.id, value: list.id }, list.name) }),
          ),
          h('span', { style: { color: V2_T.text.tertiary, fontSize: 12 } }, '标签'),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
            (task.tags || []).map(function renderTag(tag) {
              return h(
                'span',
                {
                  key: tag.id,
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: V2_T.radius.pill,
                    background: V2_T.surface.panel2,
                    border: '1px solid ' + V2_T.border.subtle,
                    color: V2_T.text.secondary,
                    lineHeight: '16px',
                  },
                },
                tag.name,
                h('button', {
                  type: 'button',
                  title: '移除标签',
                  onClick: function onClick() { toggleDetailTag(task, tag.id) },
                  style: v2IconBtnStyle({ width: 16, height: 16, color: V2_T.text.tertiary }),
                }, h(V2Icon, { name: 'close', size: 9 })),
              )
            }),
            state.detailTagOpen
              ? h('input', {
                  autoFocus: true,
                  value: state.detailTagText,
                  placeholder: '标签名，回车创建',
                  onChange: function onChange(e) { update({ detailTagText: e.target.value }) },
                  onKeyDown: function onKeyDown(e) {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      createDetailTag(task)
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      update({ detailTagOpen: false })
                    }
                  },
                  style: v2InputStyle({ fontSize: 12, padding: '3px 8px', width: 120, height: 26, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
                })
              : h('button', {
                  type: 'button',
                  title: '添加标签',
                  onClick: function onClick() { openDetailTagMenu(task) },
                  style: v2IconBtnStyle({ width: 22, height: 22 }),
                }, h(V2Icon, { name: 'plus', size: 11 })),
          ),
        ),
        h(
          'div',
          { style: v2CardStyle({ marginBottom: 12, padding: '10px 12px' }) },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: V2_T.text.tertiary, letterSpacing: '0.02em', marginBottom: 6 } }, '备注'),
          h('textarea', {
            value: task.notes || '',
            rows: 4,
            placeholder: '添加备注…',
            onChange: function onChange(e) { update({ detail: Object.assign({}, task, { notes: e.target.value }) }) },
            onBlur: function onBlur(e) {
              const value = e.target.value
              if (value !== (task.notes || '')) patchTask(task.id, task.rev, { notes: value || null }, null)
            },
            style: v2InputStyle({ width: '100%', boxSizing: 'border-box', resize: 'vertical', fontSize: 13, lineHeight: '20px', minHeight: 88, padding: '8px 10px', background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
          }),
        ),
        h(
          'div',
          { style: v2CardStyle({ marginBottom: 12, overflow: 'hidden' }) },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 38, padding: '0 12px', borderBottom: '1px solid ' + V2_T.border.subtle } },
            h('span', { style: { fontSize: 12, fontWeight: 600, color: V2_T.text.tertiary, letterSpacing: '0.02em' } }, '子任务'),
            h('button', {
              type: 'button',
              onClick: function onClick() { addSubtask(task) },
              style: v2IconBtnStyle({ width: 24, height: 24 }),
            }, h(V2Icon, { name: 'plus', size: 13 })),
          ),
          h(
            'div',
            { style: { padding: '4px 6px 6px' } },
            children.length
              ? children.map(function map(child) { return renderTaskRow(child) })
              : h('div', { style: { fontSize: 11, color: V2_T.text.tertiary, padding: '6px 10px' } }, '暂无子任务'),
          ),
        ),
      ),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderTop: '1px solid ' + V2_T.border.subtle } },
        h('span', { style: { fontSize: 11, color: V2_T.text.tertiary, flex: '1 1 auto' } }, v2TaskDateText(task)),
        state.scope.kind === 'trash'
          ? h('button', { type: 'button', onClick: function onClick() { restoreTask(task) }, style: v2BtnStyle('soft', { fontSize: 11, height: 32, padding: '0 12px', borderRadius: V2_T.radius.md, background: V2_T.surface.panel3, color: V2_T.text.primary }) }, '恢复')
          : h('button', { type: 'button', onClick: function onClick() { deleteTask(task) }, style: v2BtnStyle('ghost', { fontSize: 11, height: 32, padding: '0 12px', borderRadius: V2_T.radius.md, color: V2_T.status.danger }) }, '删除'),
        state.scope.kind === 'trash'
          ? h('button', { type: 'button', onClick: function onClick() { purgeTask(task) }, style: v2BtnStyle('danger', { fontSize: 11, height: 32, padding: '0 12px', borderRadius: V2_T.radius.md, border: '1px solid ' + V2_T.status.danger + '55' }) }, '彻底删除')
          : null,
      ),
    )
  }

  /* 可拖拽分隔条：左侧调清单栏宽度（drag 方向向右变宽），右侧调详情栏宽度（drag 方向向左变宽） */
  function renderSplitter(kind) {
    return h('div', {
      key: 'splitter-' + kind,
      title: kind === 'list' ? '拖动调整清单栏宽度' : '拖动调整详情栏宽度',
      onMouseDown: function onMouseDown(event) { beginPaneDrag(kind, event) },
      onMouseEnter: function onMouseEnter(e) { e.currentTarget.style.boxShadow = 'inset 2px 0 0 ' + V2_T.accent.base },
      onMouseLeave: function onMouseLeave(e) { e.currentTarget.style.boxShadow = 'inset 1px 0 0 ' + V2_T.border.subtle },
      style: {
        width: 6,
        flex: '0 0 6px',
        cursor: 'col-resize',
        background: 'transparent',
        alignSelf: 'stretch',
        boxShadow: 'inset 1px 0 0 ' + V2_T.border.subtle,
        transition: 'box-shadow 120ms ease',
      },
    })
  }

  return h(
    'div',
    { style: { flex: '1 1 auto', display: 'flex', minHeight: 0, minWidth: 0, overflow: 'hidden' } },
    renderLeft(),
    narrow || panes.listCollapsed ? null : renderSplitter('list'),
    renderMain(),
    state.detail && !narrow ? renderSplitter('detail') : null,
    state.detail ? renderDetail() : null,
  )
}

function NewGroupRow(props) {
  if (!props.active) {
    return h(
      'button',
      {
        type: 'button',
        onClick: props.onOpen,
        style: Object.assign(
          v2BtnStyle('ghost', {
            fontSize: 11,
            marginTop: 8,
            justifyContent: 'flex-start',
            color: V2_T.text.tertiary,
            border: '1px dashed ' + V2_T.border.subtle,
            borderRadius: V2_T.radius.sm,
            padding: '7px 10px',
          }),
          { width: '100%' },
        ),
      },
      h(V2Icon, { name: 'plus', size: 12 }),
      '添加分组',
    )
  }
  return h(
    'div',
    { style: { display: 'flex', gap: 4, marginTop: 6 } },
    h('input', {
      autoFocus: true,
      value: props.value,
      placeholder: '分组名称',
      onChange: function onChange(e) { props.onChange(e.target.value) },
      onKeyDown: function onKeyDown(e) {
        if (e.key === 'Enter') props.onSubmit()
        if (e.key === 'Escape') props.onCancel()
      },
      style: v2InputStyle({ fontSize: 13, padding: '4px 8px', height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
    }),
    h('button', { type: 'button', onClick: props.onSubmit, style: v2BtnStyle('primary', { fontSize: 11, height: 28, padding: '0 12px', borderRadius: V2_T.radius.sm }) }, '创建'),
  )
}

function v2ScopeMatch(task, scope, lists, groups) {
  const today = todayIso()
  if (!v2TaskOpen(task)) return false
  if (scope.kind === 'today') {
    return v2TaskDateKey(task) === today || v2TaskOverdue(task, today)
  }
  if (scope.kind === 'next7') {
    const dateKey = v2TaskDateKey(task)
    return !!dateKey && dateKey >= today && dateKey <= addDaysKey(today, 7)
  }
  if (scope.kind === 'inbox') {
    return !v2TaskListId(task)
  }
  if (scope.kind === 'list') {
    return v2TaskListId(task) === scope.id
  }
  if (scope.kind === 'filter') {
    if (scope.id === 'high') return task.priority === 'high'
    if (scope.id === 'meeting') return String(task.title || '').indexOf('会') >= 0
    return true
  }
  return true
}

function v2SortTasks(tasks, sort) {
  const copy = tasks.slice()
  if (sort === 'priority') {
    const rank = { high: 0, medium: 1, low: 2, none: 3 }
    copy.sort(function compare(a, b) {
      return (rank[a.priority] === undefined ? 3 : rank[a.priority]) - (rank[b.priority] === undefined ? 3 : rank[b.priority])
    })
  } else if (sort === 'date') {
    copy.sort(function compare(a, b) {
      const left = v2TaskDateKey(a) || '9999-99-99'
      const right = v2TaskDateKey(b) || '9999-99-99'
      return left < right ? -1 : left > right ? 1 : 0
    })
  } else if (sort === 'created') {
    copy.sort(function compare(a, b) {
      const left = a.createdAt || ''
      const right = b.createdAt || ''
      return left < right ? -1 : left > right ? 1 : 0
    })
  } else {
    copy.sort(function compare(a, b) {
      if (v2TaskPinned(a) !== v2TaskPinned(b)) return v2TaskPinned(a) ? -1 : 1
      const left = Number(a.sortOrder || 0)
      const right = Number(b.sortOrder || 0)
      if (left !== right) return left - right
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    })
  }
  return copy
}

function v2DragPayload() {
  const taskId = window.__lifeosV2DragTaskId
  return taskId ? { taskId: taskId } : null
}

function v2FindTaskById(tasks, taskId) {
  if (!tasks || !taskId) return null
  return tasks.filter(function find(task) { return task.id === taskId })[0] || null
}

function v2IsConflictError(error) {
  const code = String((error && error.code) || '')
  if (/conflict/i.test(code)) return true
  const message = String((error && error.message) || '')
  return /conflict|版本冲突|已被修改/i.test(message)
}

/* ═════════ repeatRule：解析 / 文案 / 下一次日期 ═════════ */

function v2RepeatRuleOf(task) {
  if (!task) return null
  const raw = task.repeatRule || task.repeat_rule || null
  if (!raw || typeof raw !== 'object') return null
  const kind = String(raw.kind || '')
  if (kind === 'daily') return { kind: 'daily' }
  if (kind === 'weekly') {
    const source = Array.isArray(raw.days) ? raw.days : []
    const days = []
    source.forEach(function push(value) {
      const day = Number(value)
      if (Number.isInteger(day) && day >= 1 && day <= 7 && days.indexOf(day) < 0) days.push(day)
    })
    days.sort(function asc(a, b) { return a - b })
    if (!days.length) days.push(v2IsoWeekday(todayIso()))
    return { kind: 'weekly', days: days }
  }
  if (kind === 'monthly') {
    const day = Number(raw.day)
    const safe = Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1
    return { kind: 'monthly', day: safe }
  }
  return null
}

function v2RepeatLabel(rule) {
  if (!rule) return '不重复'
  if (rule.kind === 'daily') return '每天'
  if (rule.kind === 'weekly') {
    const days = rule.days || []
    if (!days.length) return '每周'
    return '每周' + days.map(function map(day) { return V2_WEEKDAY_LABELS[day - 1] || '' }).join('、')
  }
  if (rule.kind === 'monthly') return '每月 ' + rule.day + ' 日'
  return '不重复'
}

function v2IsoWeekday(dateKey) {
  const parts = String(dateKey || '').split('-')
  const year = Number(parts[0])
  const month = Number(parts[1])
  const day = Number(parts[2])
  if (!year || !month || !day) return 1
  const weekday = new Date(year, month - 1, day).getDay()
  return weekday === 0 ? 7 : weekday
}

function v2DaysBetween(fromKey, toKey) {
  const from = new Date(String(fromKey || '') + 'T00:00:00')
  const to = new Date(String(toKey || '') + 'T00:00:00')
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0
  return Math.round((to.getTime() - from.getTime()) / 86400000)
}

function v2NextRepeatDate(baseDateKey, rule) {
  const base = baseDateKey || todayIso()
  if (!rule) return base
  if (rule.kind === 'daily') return addDaysKey(base, 1)
  if (rule.kind === 'weekly') {
    const days = (rule.days || []).slice().sort(function asc(a, b) { return a - b })
    if (!days.length) return addDaysKey(base, 7)
    for (let step = 1; step <= 7; step += 1) {
      const candidate = addDaysKey(base, step)
      if (days.indexOf(v2IsoWeekday(candidate)) >= 0) return candidate
    }
    return addDaysKey(base, 7)
  }
  if (rule.kind === 'monthly') {
    const parts = base.split('-')
    const year = Number(parts[0])
    const month = Number(parts[1])
    const day = Number(rule.day) || 1
    const nextMonth = month === 12 ? 1 : month + 1
    const nextYear = month === 12 ? year + 1 : year
    const lastDay = new Date(nextYear, nextMonth, 0).getDate()
    const safeDay = Math.min(Math.max(1, day), lastDay)
    return String(nextYear) + '-' + String(nextMonth).padStart(2, '0') + '-' + String(safeDay).padStart(2, '0')
  }
  return addDaysKey(base, 1)
}

/* ═════════ 三栏布局宽度持久化 ═════════ */

function v2ClampPane(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}

function v2ReadTaskPanes() {
  const fallback = { list: V2_PANE_LIST_DEFAULT, detail: V2_PANE_DETAIL_DEFAULT, listCollapsed: false }
  try {
    const raw = window.localStorage.getItem(V2_PANE_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) || {}
    return {
      list: v2ClampPane(parsed.list, V2_PANE_LIST_MIN, V2_PANE_LIST_MAX, V2_PANE_LIST_DEFAULT),
      detail: v2ClampPane(parsed.detail, V2_PANE_DETAIL_MIN, V2_PANE_DETAIL_MAX, V2_PANE_DETAIL_DEFAULT),
      listCollapsed: parsed.listCollapsed === true,
    }
  } catch (error) {
    return fallback
  }
}

function v2WriteTaskPanes(panes) {
  try {
    window.localStorage.setItem(
      V2_PANE_STORAGE_KEY,
      JSON.stringify({
        list: v2ClampPane(panes && panes.list, V2_PANE_LIST_MIN, V2_PANE_LIST_MAX, V2_PANE_LIST_DEFAULT),
        detail: v2ClampPane(panes && panes.detail, V2_PANE_DETAIL_MIN, V2_PANE_DETAIL_MAX, V2_PANE_DETAIL_DEFAULT),
        listCollapsed: !!(panes && panes.listCollapsed),
      }),
    )
  } catch (error) {
    /* localStorage 不可用时静默忽略 */
  }
}

/* ---- 30-calendar.js (3213 lines) ---- */
/* ═══════════════════════ M6 · 日历 Tab（V2） ═══════════════════════ */
/* 说明：本文件由 scripts/build-v2.mjs 内联到 client.js 的 V2-MODULES 区段，
   与 00-core.js / 10-shell.js / 20-tasks.js 共用同一 factory 作用域。
   对外导出：function CalendarTabV2(props) —— 日历 Tab（月 / 周 / 日视图 + 右侧可收起任务栏）。
   约定：无 import / export、无 JSX，只用 h() 创建元素；顶层标识符统一 cal2 / Cal2 前缀以免与其它模块冲突。 */

/* ── 常量 ── */
const CAL2_HOUR_PX = 44
const CAL2_HOUR_PX_DAY = 60
const CAL2_WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六']
const CAL2_WEEKDAY_LONG = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const CAL2_MONTH_HEADERS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const CAL2_VIEW_DEFS = [
  { id: 'month', label: '月' },
  { id: 'week', label: '周' },
  { id: 'day', label: '日' },
]
const CAL2_PRIORITY_OPTIONS = [
  { value: 'high', label: '高优先级' },
  { value: 'medium', label: '中优先级' },
  { value: 'low', label: '低优先级' },
  { value: 'none', label: '无优先级' },
]
const CAL2_PRIORITY_COLORS = {
  high: '#ff8a8a',
  medium: '#f5cd79',
  low: '#6ea8fe',
  none: '#7d8494',
}
const CAL2_SIDEBAR_WIDTH = 296
const CAL2_SIDEBAR_MIN = 236
const CAL2_SIDEBAR_MAX = 440
const CAL2_PANES_STORAGE_KEY = 'lifeos.v2.calendarPanes'

function cal2ReadPanePrefs() {
  try {
    const raw = window.localStorage.getItem(CAL2_PANES_STORAGE_KEY)
    const value = raw ? JSON.parse(raw) : null
    return value && typeof value === 'object' ? value : {}
  } catch (error) {
    return {}
  }
}

function cal2SavePanePrefs(patch) {
  try {
    const next = Object.assign({}, cal2ReadPanePrefs(), patch)
    window.localStorage.setItem(CAL2_PANES_STORAGE_KEY, JSON.stringify(next))
  } catch (error) {
    /* ignore */
  }
}

function cal2ClampBarWidth(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return CAL2_SIDEBAR_WIDTH
  return Math.max(CAL2_SIDEBAR_MIN, Math.min(CAL2_SIDEBAR_MAX, Math.round(num)))
}
const CAL2_SIDEBAR_COLLAPSED_WIDTH = 34
const CAL2_STATE_KEY = 'lifeos.v2.calendar'
const CAL2_MIN_DURATION = 15
const CAL2_DEFAULT_DURATION = 60
const CAL2_ERR_COLOR = '#ff8a8a'
const CAL2_ACCENT = '#6ea8fe'

/* ── 基础工具 ── */
function cal2Pad(value) {
  return value < 10 ? '0' + value : String(value)
}

function cal2Clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function cal2IsDateKey(text) {
  return typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text)
}

function cal2Date(dayKey) {
  if (!cal2IsDateKey(dayKey)) return new Date()
  const parts = dayKey.split('-')
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
}

function cal2KeyOf(date) {
  return date.getFullYear() + '-' + cal2Pad(date.getMonth() + 1) + '-' + cal2Pad(date.getDate())
}

function cal2AddDays(dayKey, days) {
  const date = cal2Date(dayKey)
  date.setDate(date.getDate() + days)
  return cal2KeyOf(date)
}

function cal2MondayOf(dayKey) {
  const date = cal2Date(dayKey)
  const weekday = date.getDay()
  const diff = weekday === 0 ? -6 : 1 - weekday
  date.setDate(date.getDate() + diff)
  return cal2KeyOf(date)
}

function cal2StartOfMonth(dayKey) {
  const date = cal2Date(dayKey)
  return cal2KeyOf(new Date(date.getFullYear(), date.getMonth(), 1))
}

function cal2ShiftMonth(dayKey, delta) {
  const date = cal2Date(dayKey)
  return cal2KeyOf(new Date(date.getFullYear(), date.getMonth() + delta, 1))
}

function cal2ViewDays(view, anchor) {
  if (view === 'day') return [anchor]
  if (view === 'week') {
    const monday = cal2MondayOf(anchor)
    return Array.from({ length: 7 }, function make(_, index) {
      return cal2AddDays(monday, index)
    })
  }
  const first = cal2MondayOf(cal2StartOfMonth(anchor))
  return Array.from({ length: 42 }, function make(_, index) {
    return cal2AddDays(first, index)
  })
}

function cal2HeaderTitle(view, anchor) {
  if (view === 'day') {
    const date = cal2Date(anchor)
    return date.getMonth() + 1 + '月' + date.getDate() + '日 ' + CAL2_WEEKDAY_LONG[date.getDay()]
  }
  if (view === 'week') {
    const days = cal2ViewDays('week', anchor)
    const first = cal2Date(days[0])
    const last = cal2Date(days[6])
    const firstText = first.getMonth() + 1 + '月' + first.getDate() + '日'
    const lastText =
      first.getMonth() === last.getMonth()
        ? last.getDate() + '日'
        : last.getMonth() + 1 + '月' + last.getDate() + '日'
    return firstText + ' – ' + lastText
  }
  const date = cal2Date(anchor)
  return date.getFullYear() + '年' + (date.getMonth() + 1) + '月'
}

function cal2SnapMins(minutes, step) {
  const size = step || 15
  return Math.round(minutes / size) * size
}

function cal2HmToMin(text) {
  if (typeof text !== 'string' || text.indexOf(':') < 0) return 0
  const parts = text.split(':')
  const hour = Number(parts[0])
  const minute = Number(parts[1])
  if (!isFinite(hour) || !isFinite(minute)) return 0
  return cal2Clamp(hour * 60 + minute, 0, 24 * 60)
}

function cal2MinToHm(minutes) {
  const value = cal2Clamp(Math.round(minutes), 0, 24 * 60)
  return cal2Pad(Math.floor(value / 60)) + ':' + cal2Pad(value % 60)
}

function cal2MinToHmInput(minutes) {
  const value = cal2Clamp(Math.round(minutes), 0, 24 * 60 - 1)
  return cal2Pad(Math.floor(value / 60)) + ':' + cal2Pad(value % 60)
}

function cal2LocalIso(dayKey, minutes) {
  const date = cal2Date(dayKey)
  date.setHours(0, 0, 0, 0)
  date.setMinutes(Math.round(minutes))
  return date.toISOString()
}

function cal2IsoToParts(iso) {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return { dateKey: cal2KeyOf(date), minutes: date.getHours() * 60 + date.getMinutes() }
}

function cal2DurationMinutes(startIso, endIso) {
  if (!startIso || !endIso) return 0
  const start = new Date(startIso).getTime()
  const end = new Date(endIso).getTime()
  if (!isFinite(start) || !isFinite(end) || end <= start) return 0
  return Math.round((end - start) / 60000)
}

/* ── 任务字段兼容读取（Host 返回 camelCase；M1 旧接口可能是 snake_case） ── */
function cal2TaskStartIso(task) {
  if (!task) return ''
  return task.scheduledStartAt || task.scheduled_start_at || ''
}

function cal2TaskEndIso(task) {
  if (!task) return ''
  return task.scheduledEndAt || task.scheduled_end_at || ''
}

function cal2TaskScheduledDate(task) {
  if (!task) return ''
  return task.scheduledDate || task.scheduled_date || ''
}

function cal2TaskDueDate(task) {
  if (!task) return ''
  return task.dueDate || task.due_date || ''
}

/* 清单字段兼容读取（Host 返回 camelCase listId；M1 旧接口可能是 snake_case list_id） */
function cal2TaskListId(task) {
  if (!task) return ''
  return task.listId || task.list_id || ''
}

function cal2TaskDayKey(task) {
  const startParts = cal2IsoToParts(cal2TaskStartIso(task))
  if (startParts) return startParts.dateKey
  return cal2TaskScheduledDate(task) || cal2TaskDueDate(task) || ''
}

function cal2TaskColor(task) {
  const priority = task && task.priority ? String(task.priority) : 'none'
  return CAL2_PRIORITY_COLORS[priority] || CAL2_PRIORITY_COLORS.none
}

function cal2MergeTasks(primary, secondary) {
  const out = []
  const seen = {}
  function push(task) {
    if (!task || !task.id || seen[task.id]) return
    seen[task.id] = true
    out.push(task)
  }
  ;(primary || []).forEach(push)
  ;(secondary || []).forEach(push)
  return out
}

function cal2Settle(promise) {
  return promise.then(
    function onOk(value) {
      return { ok: true, value: value }
    },
    function onError(error) {
      return { ok: false, error: error }
    },
  )
}

function cal2ReadPrefs() {
  const prefs = { view: 'week', anchor: '' }
  try {
    const settingsView = v2ReadSettings().calendarView
    if (settingsView === 'month' || settingsView === 'week' || settingsView === 'day') prefs.view = settingsView
  } catch (error) {
    /* 设置不可用时使用默认值 */
  }
  try {
    const raw = window.localStorage.getItem(CAL2_STATE_KEY)
    if (!raw) return prefs
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return prefs
    if (parsed.view === 'month' || parsed.view === 'week' || parsed.view === 'day') prefs.view = parsed.view
    if (cal2IsDateKey(parsed.anchor)) prefs.anchor = parsed.anchor
  } catch (error) {
    /* localStorage 不可用时使用默认值 */
  }
  return prefs
}

function cal2WritePrefs(view, anchor) {
  try {
    window.localStorage.setItem(CAL2_STATE_KEY, JSON.stringify({ view: view, anchor: anchor }))
  } catch (error) {
    /* 忽略 */
  }
}

/* ── 重叠事件布局：同簇内分列，最多 3 列，>3 记溢出 ── */
function cal2LayoutLanes(entries) {
  const out = []
  let cluster = []
  let clusterEnd = -1
  function flush() {
    if (!cluster.length) return
    const lanes = []
    cluster.forEach(function assign(item) {
      let lane = -1
      for (let index = 0; index < lanes.length; index += 1) {
        if (lanes[index] <= item.startMin) {
          lane = index
          break
        }
      }
      if (lane < 0) {
        lane = lanes.length
        lanes.push(item.endMin)
      } else {
        lanes[lane] = item.endMin
      }
      item.lane = lane
    })
    const laneTotal = Math.max(1, lanes.length)
    const hidden = laneTotal > 3 ? cluster.filter(function pick(item) { return item.lane >= 3 }) : []
    cluster.forEach(function mark(item) {
      item.laneTotal = laneTotal
      item.hiddenSiblings = item.lane === 2 && hidden.length ? hidden : []
      out.push(item)
    })
    cluster = []
    clusterEnd = -1
  }
  entries.forEach(function scan(item) {
    if (cluster.length && item.startMin >= clusterEnd) flush()
    cluster.push(item)
    clusterEnd = Math.max(clusterEnd, item.endMin)
  })
  flush()
  return out
}

/* ── 原生悬浮菜单（不参与 React 树，避免层级/事件干扰） ── */
function cal2OpenMenu(x, y, items) {
  const wrapper = document.createElement('div')
  wrapper.style.position = 'fixed'
  wrapper.style.left = Math.max(8, Math.min(x, window.innerWidth - 216)) + 'px'
  wrapper.style.top = Math.max(8, Math.min(y, window.innerHeight - 80)) + 'px'
  wrapper.style.zIndex = '150000'
  wrapper.style.background = V2_T.surface.panel
  wrapper.style.border = '1px solid ' + V2_T.border.subtle
  wrapper.style.borderRadius = V2_T.radius.md + 'px'
  wrapper.style.padding = '4px'
  wrapper.style.boxShadow = V2_T.shadow.raised
  wrapper.style.minWidth = '180px'
  let closed = false
  function close() {
    if (closed) return
    closed = true
    if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper)
    document.removeEventListener('mousedown', onOutside, true)
    document.removeEventListener('keydown', onEscape, true)
  }
  function onOutside(event) {
    if (!wrapper.contains(event.target)) close()
  }
  function onEscape(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }
  ;(items || []).forEach(function render(item) {
    if (!item) return
    if (item.type === 'separator') {
      const separator = document.createElement('div')
      separator.style.height = '1px'
      separator.style.background = V2_T.border.subtle
      separator.style.margin = '4px 6px'
      wrapper.appendChild(separator)
      return
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.style.display = 'flex'
    button.style.alignItems = 'center'
    button.style.width = '100%'
    button.style.background = 'transparent'
    button.style.border = 'none'
    button.style.color = item.danger ? V2_T.status.danger : V2_T.text.primary
    button.style.fontFamily = COLORS.fontFamily
    button.style.fontSize = '12px'
    button.style.padding = '6px 10px'
    button.style.borderRadius = V2_T.radius.sm + 'px'
    button.style.cursor = 'pointer'
    button.style.textAlign = 'left'
    button.style.whiteSpace = 'nowrap'
    button.textContent = item.label
    button.addEventListener('mouseenter', function enter() {
      button.style.background = V2_T.surface.panel2
    })
    button.addEventListener('mouseleave', function leave() {
      button.style.background = 'transparent'
    })
    button.addEventListener('click', function click() {
      close()
      try {
        if (typeof item.onClick === 'function') item.onClick()
      } catch (error) {
        if (typeof runtime !== 'undefined' && runtime.toast) {
          runtime.toast('error', '操作失败：' + errorText(error))
        }
      }
    })
    wrapper.appendChild(button)
  })
  document.body.appendChild(wrapper)
  setTimeout(function bind() {
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown', onEscape, true)
  }, 0)
}

function cal2HoverIn(background) {
  return function onEnter(event) {
    event.currentTarget.style.background = background
  }
}

function cal2HoverOut(background) {
  return function onLeave(event) {
    event.currentTarget.style.background = background
  }
}

function cal2FieldLabel(text) {
  return h(
    'div',
    {
      style: {
        fontSize: V2_T.font.caption,
        fontWeight: 500,
        color: V2_T.text.tertiary,
        lineHeight: '16px',
        marginBottom: 5,
      },
    },
    text,
  )
}

function cal2FieldStyle(extra) {
  return Object.assign(
    {
      width: '100%',
      boxSizing: 'border-box',
      background: V2_T.surface.input,
      border: '1px solid ' + V2_T.border.subtle,
      outline: 'none',
      color: V2_T.text.primary,
      fontFamily: COLORS.fontFamily,
      fontSize: V2_T.font.body,
      padding: '0 9px',
      borderRadius: V2_T.radius.sm,
      height: 32,
    },
    extra || {},
  )
}

/* ── 轻量任务编辑弹窗（标题 / 日期 / 全天 / 开始 / 结束 / 优先级 / 清单） ── */
function Cal2TaskModal(props) {
  const task = props.task || null
  const isNew = props.isNew === true
  const lists = Array.isArray(props.lists) ? props.lists : []

  const [form, setForm] = useState(function initialForm() {
    const source = task || {}
    const startParts = cal2IsoToParts(cal2TaskStartIso(source))
    const endParts = cal2IsoToParts(cal2TaskEndIso(source))
    const timed = !!startParts && source.isAllDay !== true
    const day =
      (startParts && startParts.dateKey) ||
      cal2TaskScheduledDate(source) ||
      cal2TaskDueDate(source) ||
      props.defaultDate ||
      todayIso()
    return {
      title: source.title || '',
      day: day,
      timed: timed,
      startHm: startParts ? cal2MinToHmInput(startParts.minutes) : '09:00',
      endHm: endParts ? cal2MinToHmInput(endParts.minutes) : '10:00',
      priority: source.priority || 'none',
      listId: cal2TaskListId(source),
      /* projectId 不在弹窗中展示，保留原值以便 PATCH 时不被清空（新建为 null） */
      projectId: source.projectId || '',
    }
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(function closeOnEscape() {
    function onKeyDown(event) {
      if (event.key !== 'Escape') return
      if (event.nativeEvent && event.nativeEvent.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      props.onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return function cleanup() {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  function update(patch) {
    setForm(function merge(prev) {
      return Object.assign({}, prev, patch)
    })
  }

  function submit() {
    if (saving) return
    const title = String(form.title || '').trim()
    if (!title) {
      setError('标题不能为空')
      return
    }
    if (!cal2IsDateKey(form.day)) {
      setError('请选择日期')
      return
    }
    const payload = {
      title: title,
      priority: form.priority || 'none',
      listId: form.listId || null,
      /* projectId 沿用原任务值（弹窗不展示该字段，保持原样） */
      projectId: form.projectId || null,
    }
    if (form.timed) {
      const startMin = cal2HmToMin(form.startHm || '09:00')
      let endMin = form.endHm ? cal2HmToMin(form.endHm) : startMin + CAL2_DEFAULT_DURATION
      if (endMin <= startMin) endMin = Math.min(24 * 60 - 1, startMin + CAL2_DEFAULT_DURATION)
      payload.scheduledDate = null
      payload.scheduledStartAt = cal2LocalIso(form.day, startMin)
      payload.scheduledEndAt = cal2LocalIso(form.day, endMin)
      payload.isAllDay = false
    } else {
      payload.scheduledDate = form.day
      payload.scheduledStartAt = null
      payload.scheduledEndAt = null
      payload.isAllDay = true
    }
    setSaving(true)
    setError('')
    Promise.resolve(
      props.onSave(payload, { isNew: isNew, taskId: task ? task.id : null, rev: task ? task.rev : null }),
    ).then(
      function done(ok) {
        if (!ok) setSaving(false)
      },
      function failed() {
        setSaving(false)
      },
    )
  }

  const listOptions = [h('option', { key: 'none', value: '' }, '收集箱')].concat(
    lists.map(function renderList(list) {
      return h('option', { key: list.id, value: list.id }, list.name || '未命名清单')
    }),
  )
  const priorityOptions = CAL2_PRIORITY_OPTIONS.map(function renderPriority(option) {
    return h('option', { key: option.value, value: option.value }, option.label)
  })
  const maskStyle = {
    position: 'fixed',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    zIndex: 300000,
    background: V2_T.surface.overlay,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    boxSizing: 'border-box',
  }
  const dialogStyle = v2CardStyle({
    width: 360,
    maxWidth: 'calc(100vw - 32px)',
    maxHeight: 'calc(100vh - 48px)',
    overflow: 'auto',
    background: V2_T.surface.panel,
    boxShadow: V2_T.shadow.pop,
    padding: 16,
    boxSizing: 'border-box',
    color: V2_T.text.primary,
    fontFamily: COLORS.fontFamily,
    scrollbarColor: V2_T.border.subtle + ' transparent',
  })
  return h(
    'div',
    {
      style: maskStyle,
      onClick: function onMask() {
        props.onClose()
      },
    },
    h(
      'div',
      {
        style: dialogStyle,
        onClick: function stop(event) {
          event.stopPropagation()
        },
      },
      [
        h(
          'div',
          {
            key: 'head',
            style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 },
          },
          [
            h(
              'div',
              {
                key: 't',
                style: { flex: '1 1 auto', fontSize: V2_T.font.title, fontWeight: 600, color: V2_T.text.primary },
              },
              isNew ? '新建任务' : '编辑日程',
            ),
            h(
              'button',
              {
                key: 'close',
                type: 'button',
                title: '关闭',
                onClick: function close() {
                  props.onClose()
                },
                style: {
                  width: 28,
                  height: 28,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '1px solid transparent',
                  background: 'transparent',
                  borderRadius: V2_T.radius.sm,
                  color: V2_T.text.tertiary,
                  cursor: 'pointer',
                  padding: 0,
                },
                onMouseEnter: cal2HoverIn(V2_T.surface.panel2),
                onMouseLeave: cal2HoverOut('transparent'),
              },
              h(V2Icon, { name: 'close', size: 15 }),
            ),
          ],
        ),
        h('div', { key: 'fields', style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
          h('div', { key: 'title' }, [
            cal2FieldLabel('标题'),
            h('input', {
              autoFocus: true,
              value: form.title,
              placeholder: '任务标题',
              onChange: function onTitle(event) {
                update({ title: event.currentTarget.value })
              },
              onKeyDown: function onTitleKey(event) {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submit()
                }
              },
              style: cal2FieldStyle(),
            }),
          ]),
          h('div', { key: 'dateRow', style: { display: 'flex', gap: 10, alignItems: 'flex-end' } }, [
            h('div', { key: 'date', style: { flex: '1 1 auto' } }, [
              cal2FieldLabel('日期'),
              h('input', {
                type: 'date',
                value: form.day,
                onChange: function onDay(event) {
                  update({ day: event.currentTarget.value })
                },
                style: cal2FieldStyle(),
              }),
            ]),
            h(
              'label',
              {
                key: 'allDay',
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 32,
                  padding: '0 2px',
                  fontSize: V2_T.font.meta,
                  color: V2_T.text.secondary,
                  cursor: 'pointer',
                  flex: '0 0 auto',
                },
              },
              [
                h('input', {
                  key: 'box',
                  type: 'checkbox',
                  checked: !form.timed,
                  onChange: function onAllDay(event) {
                    update({ timed: !event.currentTarget.checked })
                  },
                  style: { width: 14, height: 14, accentColor: V2_T.accent.base, cursor: 'pointer' },
                }),
                h('span', { key: 'label' }, '全天'),
              ],
            ),
          ]),
          form.timed
            ? h('div', { key: 'timeRow', style: { display: 'flex', gap: 10 } }, [
                h('div', { key: 'start', style: { flex: '1 1 auto' } }, [
                  cal2FieldLabel('开始'),
                  h('input', {
                    type: 'time',
                    value: form.startHm,
                    onChange: function onStart(event) {
                      update({ startHm: event.currentTarget.value })
                    },
                    style: cal2FieldStyle(),
                  }),
                ]),
                h('div', { key: 'end', style: { flex: '1 1 auto' } }, [
                  cal2FieldLabel('结束'),
                  h('input', {
                    type: 'time',
                    value: form.endHm,
                    onChange: function onEnd(event) {
                      update({ endHm: event.currentTarget.value })
                    },
                    style: cal2FieldStyle(),
                  }),
                ]),
              ])
            : null,
          h('div', { key: 'metaRow', style: { display: 'flex', gap: 10 } }, [
            h('div', { key: 'priority', style: { flex: '1 1 auto' } }, [
              cal2FieldLabel('优先级'),
              h(
                'select',
                {
                  value: form.priority,
                  onChange: function onPriority(event) {
                    update({ priority: event.currentTarget.value })
                  },
                  style: cal2FieldStyle({ cursor: 'pointer' }),
                },
                priorityOptions,
              ),
            ]),
            h('div', { key: 'list', style: { flex: '1 1 auto' } }, [
              cal2FieldLabel('清单'),
              h(
                'select',
                {
                  value: form.listId || '',
                  onChange: function onList(event) {
                    update({ listId: event.currentTarget.value })
                  },
                  style: cal2FieldStyle({ cursor: 'pointer' }),
                },
                listOptions,
              ),
            ]),
          ]),
          error ? h('div', { key: 'error', style: { fontSize: V2_T.font.meta, color: V2_T.status.danger } }, error) : null,
        ]),
        h(
          'div',
          {
            key: 'foot',
            style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
          },
          [
            h(
              'button',
              {
                key: 'cancel',
                type: 'button',
                onClick: function cancel() {
                  props.onClose()
                },
                style: {
                  height: 30,
                  padding: '0 14px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  border: '1px solid ' + V2_T.border.subtle,
                  background: V2_T.surface.panel2,
                  borderRadius: V2_T.radius.sm,
                  color: V2_T.text.secondary,
                  fontFamily: COLORS.fontFamily,
                  fontSize: V2_T.font.body,
                  cursor: 'pointer',
                },
              },
              '取消',
            ),
            h(
              'button',
              {
                key: 'save',
                type: 'button',
                onClick: submit,
                style: {
                  height: 30,
                  padding: '0 16px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  border: '1px solid ' + V2_T.accent.base,
                  background: V2_T.accent.base,
                  borderRadius: V2_T.radius.sm,
                  color: '#fff',
                  fontFamily: COLORS.fontFamily,
                  fontSize: V2_T.font.body,
                  fontWeight: 500,
                  cursor: 'pointer',
                  opacity: saving ? 0.6 : 1,
                },
              },
              saving ? '保存中…' : '保存',
            ),
          ],
        ),
      ],
    ),
  )
}

/* ── 日历 Tab 主体 ── */
function CalendarTabV2(props) {
  const runtime = props.runtime
  const narrow = props.narrow === true
  const prefs = cal2ReadPrefs()

  const [view, setView] = useState(prefs.view)
  const [anchor, setAnchor] = useState(prefs.anchor || todayIso())
  const [barCollapsed, setBarCollapsed] = useState(narrow)
  const [barWidth, setBarWidth] = useState(function initialBarWidth() {
    const prefsValue = cal2ReadPanePrefs()
    return cal2ClampBarWidth(prefsValue.barWidth)
  })
  const [expandEarly, setExpandEarly] = useState(false)
  const [calendarTasks, setCalendarTasks] = useState([])
  const [sidebarTasks, setSidebarTasks] = useState([])
  const [lists, setLists] = useState([])
  const [listFilter, setListFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reloadTick, setReloadTick] = useState(0)
  const [expandedDays, setExpandedDays] = useState({})
  const [inline, setInline] = useState(null)
  const [editing, setEditing] = useState(null)
  const [dragPreview, setDragPreview] = useState(null)
  const [dropPreview, setDropPreview] = useState(null)
  const [dragOverDate, setDragOverDate] = useState(null)
  const [dragOverAllDay, setDragOverAllDay] = useState(null)
  const [draggingTaskId, setDraggingTaskId] = useState(null)
  const [draft, setDraft] = useState(null)
  const [nowMinutes, setNowMinutes] = useState(function initialNow() {
    const date = new Date()
    return date.getHours() * 60 + date.getMinutes()
  })

  const loadSeqRef = useRef(0)
  const dragTaskRef = useRef({ id: null, task: null })
  const activeDragCleanupRef = useRef(null)
  const draftCleanupRef = useRef(null)
  const inlineLockRef = useRef(false)
  const gridScrollRef = useRef(null)
  const barDragRef = useRef(null)

  useEffect(
    function persistBarWidth() {
      cal2SavePanePrefs({ barWidth: barWidth })
    },
    [barWidth],
  )

  function startBarResize(event) {
    if (event.button !== 0) return
    event.preventDefault()
    barDragRef.current = { startX: event.clientX, startWidth: barWidth }
    function onMove(moveEvent) {
      const drag = barDragRef.current
      if (!drag) return
      /* 左边缘拖动：向左移动增大宽度 */
      const next = cal2ClampBarWidth(drag.startWidth - (moveEvent.clientX - drag.startX))
      setBarWidth(next)
    }
    function onUp() {
      barDragRef.current = null
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }

  /* ── 派生数据 ── */
  const todayKey = todayIso()
  const viewDays = cal2ViewDays(view, anchor)
  const rangeSet = {}
  viewDays.forEach(function mark(day) {
    rangeSet[day] = true
  })
  const allTasks = cal2MergeTasks(calendarTasks, sidebarTasks)
  const inboxListId =
    (lists.filter(function findInbox(list) {
      return list && list.kind === 'inbox'
    })[0] || {}).id || ''
  const filteredTasks =
    listFilter === 'all'
      ? allTasks
      : allTasks.filter(function matchList(task) {
          const taskListId = cal2TaskListId(task)
          if (taskListId === listFilter) return true
          /* Host 约定：无 listId 的任务属于收件箱，选中收件箱清单时也要显示 */
          return !taskListId && listFilter === inboxListId
        })

  const entriesByDay = {}
  function pushEntry(dayKey, entry) {
    if (!rangeSet[dayKey]) return
    if (!entriesByDay[dayKey]) entriesByDay[dayKey] = []
    entriesByDay[dayKey].push(entry)
  }
  filteredTasks.forEach(function buildEntry(task) {
    const startIso = cal2TaskStartIso(task)
    if (startIso && task.isAllDay !== true) {
      const startParts = cal2IsoToParts(startIso)
      if (!startParts) return
      const endParts = cal2IsoToParts(cal2TaskEndIso(task))
      let endMin = endParts && endParts.dateKey === startParts.dateKey ? endParts.minutes : 24 * 60
      if (endMin <= startParts.minutes) endMin = Math.min(24 * 60, startParts.minutes + CAL2_DEFAULT_DURATION)
      pushEntry(startParts.dateKey, {
        task: task,
        timed: true,
        allDay: false,
        dueOnly: false,
        startMin: startParts.minutes,
        endMin: endMin,
      })
      return
    }
    const scheduledDate = cal2TaskScheduledDate(task)
    if (scheduledDate) {
      pushEntry(scheduledDate, { task: task, timed: false, allDay: true, dueOnly: false, startMin: 0, endMin: 0 })
      return
    }
    const dueDate = cal2TaskDueDate(task)
    if (dueDate) {
      pushEntry(dueDate, { task: task, timed: false, allDay: false, dueOnly: true, startMin: 0, endMin: 0 })
    }
  })
  Object.keys(entriesByDay).forEach(function sortDay(day) {
    entriesByDay[day].sort(function compare(a, b) {
      if (a.timed !== b.timed) return a.timed ? -1 : 1
      if (a.timed) return a.startMin - b.startMin || b.endMin - a.endMin
      if (a.dueOnly !== b.dueOnly) return a.dueOnly ? 1 : -1
      return String(a.task.title || '').localeCompare(String(b.task.title || ''), 'zh-CN')
    })
  })

  let hasEarlyTimed = false
  Object.keys(entriesByDay).forEach(function scanDay(day) {
    if (hasEarlyTimed) return
    entriesByDay[day].forEach(function scanEntry(entry) {
      if (entry.timed && entry.startMin < 360) hasEarlyTimed = true
    })
  })
  const offsetMinutes = hasEarlyTimed || expandEarly ? 0 : 360
  const hourPx = view === 'day' ? CAL2_HOUR_PX_DAY : CAL2_HOUR_PX
  const headerTitle = cal2HeaderTitle(view, anchor)

  /* ── 数据加载 ── */
  async function loadData(showLoading) {
    loadSeqRef.current += 1
    const seq = loadSeqRef.current
    if (showLoading) setLoading(true)
    const days = cal2ViewDays(view, anchor)
    const from = days[0]
    const to = days[days.length - 1]
    const results = await Promise.all([
      cal2Settle(apiRequest('/calendar?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to))),
      cal2Settle(apiRequest('/tasks?view=all&limit=100')),
      cal2Settle(apiRequest('/lists')),
    ])
    if (seq !== loadSeqRef.current) return
    const calendarResult = results[0]
    const tasksResult = results[1]
    const listsResult = results[2]
    const calendarNext = []
    const unscheduledNext = []
    const seen = {}
    if (calendarResult.ok && calendarResult.value && Array.isArray(calendarResult.value.days)) {
      calendarResult.value.days.forEach(function readDay(day) {
        const list = day && Array.isArray(day.tasks) ? day.tasks : []
        list.forEach(function addTask(task) {
          if (!task || !task.id || seen[task.id]) return
          seen[task.id] = true
          calendarNext.push(task)
        })
      })
      if (Array.isArray(calendarResult.value.unscheduled)) {
        calendarResult.value.unscheduled.forEach(function addTask(task) {
          if (task && task.id) unscheduledNext.push(task)
        })
      }
    }
    let sidebarNext = null
    if (tasksResult.ok && tasksResult.value && Array.isArray(tasksResult.value.items)) {
      sidebarNext = tasksResult.value.items
    }
    if (!sidebarNext) sidebarNext = cal2MergeTasks(calendarNext, unscheduledNext)
    const listsNext =
      listsResult.ok && listsResult.value && Array.isArray(listsResult.value.items)
        ? listsResult.value.items
        : []
    setCalendarTasks(calendarNext)
    setSidebarTasks(sidebarNext)
    setLists(listsNext)
    setLoading(false)
    if (!calendarResult.ok && !tasksResult.ok) {
      setLoadError(calendarResult.error ? errorText(calendarResult.error) : '无法连接 LifeOS Host')
    } else {
      setLoadError('')
    }
    if (
      listFilter !== 'all' &&
      !listsNext.some(function findList(list) {
        return list.id === listFilter
      })
    ) {
      setListFilter('all')
    }
  }

  function cal2Toast(kind, text) {
    if (runtime && typeof runtime.toast === 'function') {
      try {
        runtime.toast(kind, text)
      } catch (error) {
        /* ignore */
      }
    }
  }

  async function runMutation(action, successLabel) {
    try {
      await action()
      await loadData(false)
      if (successLabel) cal2Toast('success', successLabel)
      return true
    } catch (error) {
      cal2Toast('error', '操作失败：' + errorText(error))
      await loadData(false)
      return false
    }
  }

  /* ── effect ── */
  useEffect(function loadOnChange() {
    loadData(true)
  }, [view, anchor, reloadTick])

  useEffect(function persistPrefs() {
    cal2WritePrefs(view, anchor)
  }, [view, anchor])

  useEffect(function resetTransient() {
    setInline(null)
    setDraft(null)
    setDragPreview(null)
    setDropPreview(null)
    setDragOverDate(null)
    setDragOverAllDay(null)
  }, [view, anchor])

  useEffect(function tickNow() {
    const timer = window.setInterval(function refreshNow() {
      const date = new Date()
      setNowMinutes(date.getHours() * 60 + date.getMinutes())
    }, 60000)
    return function cleanup() {
      window.clearInterval(timer)
    }
  }, [])

  useEffect(function scrollToMorning() {
    if (view === 'month') return
    const node = gridScrollRef.current
    if (!node) return
    node.scrollTop = Math.max(0, ((8 * 60 - offsetMinutes) * hourPx) / 60 - 12)
  }, [view, anchor, loading])

  useEffect(function cleanupDrag() {
    return function cleanup() {
      if (activeDragCleanupRef.current) {
        try {
          activeDragCleanupRef.current()
        } catch (error) {
          /* ignore */
        }
        activeDragCleanupRef.current = null
      }
      if (draftCleanupRef.current) {
        try {
          draftCleanupRef.current()
        } catch (error) {
          /* ignore */
        }
        draftCleanupRef.current = null
      }
    }
  }, [])

  /* ── 通用查询 / 跳转 ── */
  function findTask(taskId) {
    for (let index = 0; index < allTasks.length; index += 1) {
      if (allTasks[index].id === taskId) return allTasks[index]
    }
    return null
  }

  function shiftAnchor(delta) {
    if (view === 'day') {
      setAnchor(cal2AddDays(anchor, delta))
      return
    }
    if (view === 'week') {
      setAnchor(cal2AddDays(anchor, delta * 7))
      return
    }
    setAnchor(cal2ShiftMonth(anchor, delta))
  }

  function openEdit(task) {
    if (!task) return
    setEditing({ isNew: false, task: task, defaultDate: '' })
  }

  function openNewTask(dateKey) {
    setEditing({ isNew: true, task: null, defaultDate: dateKey || todayKey })
  }

  function toggleBar() {
    setBarCollapsed(function flip(value) {
      return !value
    })
  }

  function openHeaderMenu(event) {
    const rect = event.currentTarget.getBoundingClientRect()
    cal2OpenMenu(rect.right - 190, rect.bottom + 6, [
      {
        label: '回到今天',
        onClick: function goToday() {
          setAnchor(todayIso())
        },
      },
      {
        label: '新建全天任务（今天）',
        onClick: function createToday() {
          openNewTask(todayIso())
        },
      },
      {
        label: '刷新数据',
        onClick: function refresh() {
          setReloadTick(function bump(value) {
            return value + 1
          })
        },
      },
      { type: 'separator' },
      {
        label: barCollapsed ? '显示任务栏' : '收起任务栏',
        onClick: toggleBar,
      },
    ])
  }

  function openBarMenu(event) {
    const rect = event.currentTarget.getBoundingClientRect()
    cal2OpenMenu(rect.right - 190, rect.bottom + 6, [
      {
        label: '新建全天任务（今天）',
        onClick: function createToday() {
          openNewTask(todayIso())
        },
      },
      {
        label: '刷新数据',
        onClick: function refresh() {
          setReloadTick(function bump(value) {
            return value + 1
          })
        },
      },
      { type: 'separator' },
      { label: '收起任务栏', onClick: toggleBar },
    ])
  }

  /* ── 编辑弹窗保存 ── */
  async function handleModalSave(payload, meta) {
    try {
      if (meta.isNew) {
        await apiRequest('/tasks', { method: 'POST', body: JSON.stringify(payload) })
      } else {
        const body = Object.assign({ expectedRev: meta.rev }, payload)
        await apiRequest('/tasks/' + encodeURIComponent(meta.taskId), {
          method: 'PATCH',
          body: JSON.stringify(body),
        })
      }
      setEditing(null)
      await loadData(false)
      cal2Toast('success', meta.isNew ? '已创建任务' : '已保存')
      return true
    } catch (error) {
      cal2Toast('error', '保存失败：' + errorText(error))
      await loadData(false)
      return false
    }
  }

  /* ── 时间改动（整体移动 / 边缘缩放 / 拖入时间槽） ── */
  function applyTimePatch(task, dayKey, startMin, endMin, label) {
    const safeEnd = Math.max(startMin + CAL2_MIN_DURATION, Math.min(24 * 60, endMin))
    const safeStart = Math.min(startMin, safeEnd - CAL2_MIN_DURATION)
    const finalLabel =
      label ||
      '已更新：' + v2DateLabel(dayKey) + ' ' + cal2MinToHm(safeStart) + '–' + cal2MinToHm(safeEnd)
    return runMutation(function doPatch() {
      return apiRequest('/tasks/' + encodeURIComponent(task.id), {
        method: 'PATCH',
        body: JSON.stringify({
          expectedRev: task.rev,
          scheduledDate: null,
          scheduledStartAt: cal2LocalIso(dayKey, safeStart),
          scheduledEndAt: cal2LocalIso(dayKey, safeEnd),
          isAllDay: false,
        }),
      })
    }, finalLabel)
  }

  function patchDateOnly(task, dayKey, isAllDay, label) {
    return runMutation(function doPatch() {
      return apiRequest('/tasks/' + encodeURIComponent(task.id), {
        method: 'PATCH',
        body: JSON.stringify({
          expectedRev: task.rev,
          scheduledDate: dayKey,
          scheduledStartAt: null,
          scheduledEndAt: null,
          isAllDay: isAllDay === true,
        }),
      })
    }, label || '已设日期：' + v2DateLabel(dayKey))
  }

  function moveTaskToDate(task, dayKey, allDay) {
    const startIso = cal2TaskStartIso(task)
    if (allDay === true) {
      patchDateOnly(task, dayKey, true, '已移到 ' + v2DateLabel(dayKey))
      return
    }
    if (startIso) {
      const startParts = cal2IsoToParts(startIso)
      if (!startParts) {
        patchDateOnly(task, dayKey, true, '已移到 ' + v2DateLabel(dayKey))
        return
      }
      const duration = Math.max(CAL2_MIN_DURATION, cal2DurationMinutes(startIso, cal2TaskEndIso(task)) || CAL2_DEFAULT_DURATION)
      const startMin = cal2Clamp(startParts.minutes, 0, 24 * 60 - CAL2_MIN_DURATION)
      applyTimePatch(task, dayKey, startMin, Math.min(24 * 60, startMin + duration), '已移到 ' + v2DateLabel(dayKey))
      return
    }
    if (task.isAllDay === true) {
      patchDateOnly(task, dayKey, true, '已移到 ' + v2DateLabel(dayKey))
      return
    }
    /* 无开始时刻的任务落到日期格：必须按全天日期写回（isAllDay=true），
       否则 Host 领域层报 "日期型任务必须 is_all_day=true"（时间字段不合法） */
    patchDateOnly(task, dayKey, true, '已设日期：' + v2DateLabel(dayKey))
  }

  function moveTaskToTime(task, dayKey, startMin) {
    const duration = Math.max(
      CAL2_MIN_DURATION,
      cal2DurationMinutes(cal2TaskStartIso(task), cal2TaskEndIso(task)) || CAL2_DEFAULT_DURATION,
    )
    const safeStart = cal2Clamp(cal2SnapMins(startMin, 30), 0, 24 * 60 - CAL2_MIN_DURATION)
    const safeDuration = Math.min(duration, 24 * 60 - safeStart)
    applyTimePatch(
      task,
      dayKey,
      safeStart,
      safeStart + safeDuration,
      '已排期：' + v2DateLabel(dayKey) + ' ' + cal2MinToHm(safeStart),
    )
  }

  function dragTaskDuration(taskId) {
    const task = findTask(taskId)
    if (!task) return CAL2_DEFAULT_DURATION
    return Math.max(
      CAL2_MIN_DURATION,
      cal2DurationMinutes(cal2TaskStartIso(task), cal2TaskEndIso(task)) || CAL2_DEFAULT_DURATION,
    )
  }

  /* ── HTML5 拖拽（任务栏 / 月视图 chips / 全天 chips） ── */
  function startHtmlDrag(event, task) {
    dragTaskRef.current = { id: task.id, task: task }
    setDraggingTaskId(task.id)
    try {
      if (event.dataTransfer) {
        event.dataTransfer.setData('text/plain', task.id)
        event.dataTransfer.effectAllowed = 'move'
      }
    } catch (error) {
      /* ignore */
    }
  }

  function endHtmlDrag() {
    dragTaskRef.current = { id: null, task: null }
    setDraggingTaskId(null)
    setDropPreview(null)
    setDragOverDate(null)
    setDragOverAllDay(null)
  }

  function handleCalendarDrop(event, target) {
    event.preventDefault()
    event.stopPropagation()
    let task = null
    const drag = dragTaskRef.current
    if (drag && drag.id) task = findTask(drag.id)
    if (!task && event.dataTransfer) {
      const raw = event.dataTransfer.getData('text/plain')
      if (raw) task = findTask(raw)
    }
    endHtmlDrag()
    if (!task) return
    /* 日期格：无时刻的任务按全天日期放置；原本有开始时刻的任务保留时刻、
       仅改日期（moveTaskToDate 会走 span payload，避免 date+isAllDay:false 的非法组合）。 */
    if (target.kind === 'date') moveTaskToDate(task, target.day, false)
    else if (target.kind === 'allday') moveTaskToDate(task, target.day, true)
    else if (target.kind === 'time') moveTaskToTime(task, target.day, target.startMin)
  }

  function onTimeColumnDragOver(event, dayKey) {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const drag = dragTaskRef.current
    if (!drag || !drag.id) return
    const rect = event.currentTarget.getBoundingClientRect()
    const raw = ((event.clientY - rect.top) / hourPx) * 60 + offsetMinutes
    const startMin = cal2Clamp(cal2SnapMins(raw, 30), 0, 24 * 60 - CAL2_MIN_DURATION)
    const duration = dragTaskDuration(drag.id)
    const endMin = Math.min(24 * 60, startMin + duration)
    const next = {
      day: dayKey,
      startMin: startMin,
      endMin: endMin,
      title: (drag.task && drag.task.title) || '任务',
    }
    const prev = dropPreview
    if (!prev || prev.day !== next.day || prev.startMin !== next.startMin || prev.endMin !== next.endMin) {
      setDropPreview(next)
    }
  }

  function onTimeColumnDragLeave(event, dayKey) {
    if (event.currentTarget.contains(event.relatedTarget)) return
    if (dropPreview && dropPreview.day === dayKey) setDropPreview(null)
    if (dragOverAllDay === dayKey) setDragOverAllDay(null)
  }

  function onTimeColumnDrop(event, dayKey) {
    event.preventDefault()
    let startMin = null
    if (dropPreview && dropPreview.day === dayKey) startMin = dropPreview.startMin
    if (startMin === null) {
      const rect = event.currentTarget.getBoundingClientRect()
      const raw = ((event.clientY - rect.top) / hourPx) * 60 + offsetMinutes
      startMin = cal2Clamp(cal2SnapMins(raw, 30), 0, 24 * 60 - CAL2_MIN_DURATION)
    }
    dropPreview && setDropPreview(null)
    handleCalendarDrop(event, { kind: 'time', day: dayKey, startMin: startMin })
  }

  /* ── 空白处拖选创建 / 点击创建 ── */
  function beginGridDraft(event, dayKey) {
    if (event.button !== undefined && event.button !== 0) return
    const target = event.target
    if (target && target.closest) {
      if (target.closest('[data-cal2-event]') || target.closest('input') || target.closest('[data-cal2-inline]')) return
    }
    event.preventDefault()
    const column = event.currentTarget
    const rect = column.getBoundingClientRect()
    const startY = event.clientY
    const anchorMin = cal2Clamp(cal2SnapMins(((startY - rect.top) / hourPx) * 60 + offsetMinutes, 15), 0, 24 * 60 - 15)
    let moved = false
    let range = { startMin: anchorMin, endMin: Math.min(24 * 60, anchorMin + 30) }
    setDraft({ day: dayKey, startMin: range.startMin, endMin: range.endMin })
    function finish() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      draftCleanupRef.current = null
    }
    function toMins(clientY) {
      return cal2Clamp(cal2SnapMins(((clientY - rect.top) / hourPx) * 60 + offsetMinutes, 15), 0, 24 * 60)
    }
    function onMove(moveEvent) {
      if (!moved && Math.abs(moveEvent.clientY - startY) > 3) moved = true
      if (!moved) return
      const current = toMins(moveEvent.clientY)
      const low = Math.min(anchorMin, current)
      const high = Math.max(anchorMin, current)
      range = { startMin: low, endMin: Math.max(low + 15, high) }
      setDraft({ day: dayKey, startMin: range.startMin, endMin: range.endMin })
    }
    function onUp(upEvent) {
      finish()
      setDraft(null)
      if (upEvent && upEvent.type === 'pointercancel') return
      let startMin
      let endMin
      if (moved && range.endMin - range.startMin >= 30) {
        startMin = cal2Clamp(cal2SnapMins(range.startMin, 30), 0, 24 * 60 - 30)
        endMin = cal2Clamp(cal2SnapMins(range.endMin, 30), startMin + 30, 24 * 60)
      } else {
        startMin = cal2Clamp(cal2SnapMins(anchorMin, 30), 0, 24 * 60 - CAL2_DEFAULT_DURATION)
        endMin = Math.min(24 * 60, startMin + CAL2_DEFAULT_DURATION)
      }
      beginInline({ kind: 'time', day: dayKey, startMin: startMin, endMin: endMin, value: '' })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    draftCleanupRef.current = finish
  }

  function beginEventDrag(event, item, mode) {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const origin = {
      task: item.task,
      mode: mode,
      day: item.langDay || cal2TaskDayKey(item.task),
      startMin: item.startMin,
      endMin: item.endMin,
      moved: false,
    }
    const startX = event.clientX
    const startY = event.clientY
    function finish() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      activeDragCleanupRef.current = null
    }
    function computeTarget(clientX, clientY) {
      const duration = Math.max(CAL2_MIN_DURATION, origin.endMin - origin.startMin)
      const deltaMin = Math.round((((clientY - startY) / hourPx) * 60) / 15) * 15
      if (mode === 'move') {
        const under = document.elementFromPoint(clientX, clientY)
        const column = under && under.closest ? under.closest('[data-cal2-day]') : null
        const overDay = column && column.getAttribute ? column.getAttribute('data-cal2-day') : ''
        const targetDay = overDay && rangeSet[overDay] ? overDay : origin.day
        const nextStart = cal2Clamp(origin.startMin + deltaMin, 0, 24 * 60 - duration)
        return { day: targetDay, startMin: nextStart, endMin: nextStart + duration }
      }
      if (mode === 'start') {
        const nextStart = cal2Clamp(cal2SnapMins(origin.startMin + deltaMin, 15), 0, origin.endMin - CAL2_MIN_DURATION)
        return { day: origin.day, startMin: nextStart, endMin: origin.endMin }
      }
      const nextEnd = cal2Clamp(cal2SnapMins(origin.endMin + deltaMin, 15), origin.startMin + CAL2_MIN_DURATION, 24 * 60)
      return { day: origin.day, startMin: origin.startMin, endMin: nextEnd }
    }
    function onMove(moveEvent) {
      if (!origin.moved) {
        if (Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) <= 4) return
        origin.moved = true
      }
      const target = computeTarget(moveEvent.clientX, moveEvent.clientY)
      setDragPreview({
        taskId: origin.task.id,
        mode: mode,
        day: target.day,
        startMin: target.startMin,
        endMin: target.endMin,
      })
    }
    function onUp(upEvent) {
      finish()
      if (!origin.moved) {
        setDragPreview(null)
        if (upEvent && upEvent.type === 'pointercancel') return
        openEdit(origin.task)
        return
      }
      if (upEvent && upEvent.type === 'pointercancel') {
        setDragPreview(null)
        return
      }
      const target = computeTarget(upEvent.clientX, upEvent.clientY)
      setDragPreview(null)
      if (target.day === origin.day && target.startMin === origin.startMin && target.endMin === origin.endMin) {
        return
      }
      const label =
        '已更新：' +
        v2DateLabel(target.day) +
        ' ' +
        cal2MinToHm(target.startMin) +
        '–' +
        cal2MinToHm(target.endMin)
      applyTimePatch(origin.task, target.day, target.startMin, target.endMin, label)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    activeDragCleanupRef.current = finish
  }

  /* ── 内联创建 ── */
  function beginInline(payload) {
    inlineLockRef.current = false
    setInline(payload)
  }

  function cancelInline() {
    if (inlineLockRef.current) return
    inlineLockRef.current = true
    setInline(null)
  }

  function commitInline() {
    if (inlineLockRef.current) return
    const current = inline
    if (!current) return
    inlineLockRef.current = true
    const title = String(current.value || '').trim()
    setInline(null)
    if (!title) return
    if (current.kind === 'date') {
      runMutation(function createDateTask() {
        return apiRequest('/tasks', {
          method: 'POST',
          body: JSON.stringify({ title: title, scheduledDate: current.day, isAllDay: true }),
        })
      }, '已创建：' + title)
      return
    }
    runMutation(function createTimedTask() {
      return apiRequest('/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: title,
          scheduledStartAt: cal2LocalIso(current.day, current.startMin),
          scheduledEndAt: cal2LocalIso(current.day, current.endMin),
          isAllDay: false,
        }),
      })
    }, '已创建：' + title)
  }

  /* ── 渲染：工具栏 ── */
  const iconBtnStyle = {
    width: 30,
    height: 30,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid transparent',
    background: 'transparent',
    borderRadius: V2_T.radius.sm,
    color: V2_T.text.secondary,
    cursor: 'pointer',
    padding: 0,
    flex: '0 0 auto',
  }

  const barIconBtnStyle = Object.assign({}, iconBtnStyle, { width: 28, height: 28 })

  function renderToolbar() {
    return h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '0 16px',
          height: V2_T.line.header,
          minHeight: V2_T.line.header,
          borderBottom: '1px solid ' + V2_T.border.subtle,
          flex: '0 0 auto',
          background: V2_T.surface.app,
          boxSizing: 'border-box',
        },
      },
      [
        h(
          'button',
          {
            key: 'prev',
            type: 'button',
            title: '上一个',
            onClick: function prev() {
              shiftAnchor(-1)
            },
            style: iconBtnStyle,
            onMouseEnter: cal2HoverIn(V2_T.surface.panel2),
            onMouseLeave: cal2HoverOut('transparent'),
          },
          h(V2Icon, { name: 'chevronLeft', size: 16 }),
        ),
        h(
          'button',
          {
            key: 'today',
            type: 'button',
            onClick: function goToday() {
              setAnchor(todayIso())
            },
            style: {
              height: 30,
              padding: '0 12px',
              display: 'inline-flex',
              alignItems: 'center',
              border: '1px solid ' + V2_T.border.subtle,
              background: 'transparent',
              borderRadius: V2_T.radius.sm,
              color: V2_T.text.secondary,
              fontFamily: COLORS.fontFamily,
              fontSize: V2_T.font.body,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            },
            onMouseEnter: cal2HoverIn(V2_T.surface.panel2),
            onMouseLeave: cal2HoverOut('transparent'),
          },
          '今天',
        ),
        h(
          'button',
          {
            key: 'next',
            type: 'button',
            title: '下一个',
            onClick: function next() {
              shiftAnchor(1)
            },
            style: iconBtnStyle,
            onMouseEnter: cal2HoverIn(V2_T.surface.panel2),
            onMouseLeave: cal2HoverOut('transparent'),
          },
          h(V2Icon, { name: 'chevronRight', size: 16 }),
        ),
        h(
          'span',
          {
            key: 'title',
            title: headerTitle,
            style: {
              fontSize: 20,
              fontWeight: 600,
              color: V2_T.text.primary,
              marginLeft: 10,
              letterSpacing: '-0.2px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
            },
          },
          headerTitle,
        ),
        loading
          ? h(
              'span',
              {
                key: 'loading',
                style: {
                  fontSize: V2_T.font.meta,
                  color: V2_T.text.tertiary,
                  marginLeft: 8,
                  whiteSpace: 'nowrap',
                },
              },
              '同步中…',
            )
          : null,
        h('div', { key: 'grow', style: { flex: '1 1 auto', minWidth: 4 } }),
        h(
          'div',
          {
            key: 'seg',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              height: 30,
              boxSizing: 'border-box',
              background: V2_T.surface.panel2,
              border: '1px solid ' + V2_T.border.subtle,
              borderRadius: V2_T.radius.sm,
              padding: 2,
              gap: 2,
              flex: '0 0 auto',
            },
          },
          CAL2_VIEW_DEFS.map(function renderView(def) {
            const active = view === def.id
            return h(
              'button',
              {
                key: def.id,
                type: 'button',
                onClick: function pick() {
                  setView(def.id)
                },
                style: {
                  height: 24,
                  padding: '0 12px',
                  border: 'none',
                  borderRadius: 6,
                  background: active ? V2_T.accent.soft : 'transparent',
                  color: active ? V2_T.accent.base : V2_T.text.tertiary,
                  fontSize: V2_T.font.meta,
                  fontWeight: active ? 600 : 400,
                  fontFamily: COLORS.fontFamily,
                  cursor: 'pointer',
                  boxShadow: 'none',
                },
              },
              def.label,
            )
          }),
        ),
        h(
          'button',
          {
            key: 'refresh',
            type: 'button',
            title: '刷新',
            onClick: function refresh() {
              setReloadTick(function bump(value) {
                return value + 1
              })
            },
            style: iconBtnStyle,
            onMouseEnter: cal2HoverIn(V2_T.surface.panel2),
            onMouseLeave: cal2HoverOut('transparent'),
          },
          h(V2Icon, { name: 'refresh', size: 15 }),
        ),
        h(
          'button',
          {
            key: 'more',
            type: 'button',
            title: '更多',
            onClick: openHeaderMenu,
            style: iconBtnStyle,
            onMouseEnter: cal2HoverIn(V2_T.surface.panel2),
            onMouseLeave: cal2HoverOut('transparent'),
          },
          h(V2Icon, { name: 'more', size: 16 }),
        ),
      ],
    )
  }

  /* ── 渲染：月视图 ── */
  function renderMonthChip(entry) {
    const task = entry.task
    const color = cal2TaskColor(task)
    const hasPriority = !!(task.priority && task.priority !== 'none')
    const timeText = entry.timed
      ? cal2MinToHm(entry.startMin)
      : entry.dueOnly
        ? '截止'
        : ''
    return h(
      'div',
      {
        key: task.id,
        draggable: true,
        onDragStart: function onDragStart(event) {
          startHtmlDrag(event, task)
        },
        onDragEnd: endHtmlDrag,
        onClick: function openCard(event) {
          event.stopPropagation()
          openEdit(task)
        },
        onMouseEnter: cal2HoverIn(V2_T.surface.panel3),
        onMouseLeave: cal2HoverOut(V2_T.surface.panel2),
        title: task.title + (entry.timed ? ' ' + cal2MinToHm(entry.startMin) + '–' + cal2MinToHm(entry.endMin) : ''),
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          height: 20,
          padding: '0 6px',
          marginBottom: 2,
          borderRadius: 6,
          border: '1px solid ' + V2_T.border.subtle,
          borderLeft: '2px solid ' + (hasPriority ? color : 'transparent'),
          background: V2_T.surface.panel2,
          fontSize: V2_T.font.caption,
          color: V2_T.text.primary,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          cursor: 'grab',
          boxSizing: 'border-box',
          opacity: draggingTaskId === task.id ? 0.4 : 1,
        },
      },
      [
        timeText
          ? h(
              'span',
              {
                key: 'time',
                style: {
                  fontSize: 10,
                  color: entry.dueOnly ? V2_T.status.warn : V2_T.text.tertiary,
                  flex: '0 0 auto',
                },
              },
              timeText,
            )
          : null,
        h('span', { key: 'title', style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, task.title),
      ],
    )
  }

  function renderInlineInput() {
    return h('input', {
      key: 'inline-create',
      autoFocus: true,
      value: inline.value,
      placeholder: '任务标题，回车创建',
      onChange: function onChange(event) {
        const value = event.currentTarget.value
        setInline(function merge(prev) {
          return prev ? Object.assign({}, prev, { value: value }) : prev
        })
      },
      onClick: function stopClick(event) {
        event.stopPropagation()
      },
      onPointerDown: function stopPointer(event) {
        event.stopPropagation()
      },
      onKeyDown: function onKeyDown(event) {
        if (event.key === 'Enter') {
          event.preventDefault()
          commitInline()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          cancelInline()
        }
      },
      onBlur: function onBlur() {
        commitInline()
      },
      style: {
        width: '100%',
        boxSizing: 'border-box',
        height: 24,
        marginTop: 2,
        background: V2_T.surface.input,
        border: '1px dashed ' + V2_T.accent.line,
        borderRadius: 6,
        color: V2_T.text.primary,
        fontSize: V2_T.font.caption,
        padding: '0 6px',
        outline: 'none',
        fontFamily: COLORS.fontFamily,
      },
    })
  }

  function renderMonthCell(day, index) {
    const date = cal2Date(day)
    const otherMonth = day.slice(0, 7) !== anchor.slice(0, 7)
    const isToday = day === todayKey
    const isDragOver = dragOverDate === day
    const lastCol = index % 7 === 6
    const lastRow = index >= 35
    const entries = entriesByDay[day] || []
    const expanded = expandedDays[day] === true
    const visible = expanded ? entries : entries.slice(0, 3)
    const hidden = Math.max(0, entries.length - 3)
    const hasInline = !!inline && inline.kind === 'date' && inline.day === day
    return h(
      'div',
      {
        key: day,
        onClick: function blankClick() {
          beginInline({ kind: 'date', day: day, value: '' })
        },
        onDragOver: function onDragOver(event) {
          event.preventDefault()
          if (dragOverDate !== day) setDragOverDate(day)
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
        },
        onDragLeave: function onDragLeave(event) {
          if (event.currentTarget.contains(event.relatedTarget)) return
          if (dragOverDate === day) setDragOverDate(null)
        },
        onDrop: function onDrop(event) {
          handleCalendarDrop(event, { kind: 'date', day: day })
        },
        style: {
          position: 'relative',
          minHeight: 0,
          minWidth: 0,
          overflow: 'auto',
          padding: '5px 6px',
          borderRight: lastCol ? 'none' : '1px solid ' + V2_T.border.subtle,
          borderBottom: lastRow ? 'none' : '1px solid ' + V2_T.border.subtle,
          background: isDragOver
            ? V2_T.accent.soft
            : otherMonth
              ? 'rgba(129, 144, 168, 0.045)'
              : isToday
                ? 'rgba(110, 168, 254, 0.05)'
                : 'transparent',
          boxShadow: isDragOver ? 'inset 0 0 0 1px ' + V2_T.accent.line : 'none',
          cursor: 'pointer',
          boxSizing: 'border-box',
          scrollbarWidth: 'thin',
          scrollbarColor: V2_T.border.subtle + ' transparent',
        },
      },
      [
        h(
          'div',
          {
            key: 'dnum',
            title: '查看日视图',
            onClick: function openDay(event) {
              event.stopPropagation()
              setAnchor(day)
              setView('day')
            },
            style: { display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3, cursor: 'pointer' },
          },
          [
            h(
              'span',
              {
                key: 'num',
                style: isToday
                  ? {
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minWidth: 20,
                      height: 20,
                      padding: '0 5px',
                      boxSizing: 'border-box',
                      borderRadius: 6,
                      background: V2_T.accent.base,
                      color: '#fff',
                      fontSize: V2_T.font.meta,
                      fontWeight: 600,
                    }
                  : {
                      display: 'inline-flex',
                      alignItems: 'center',
                      height: 20,
                      fontSize: V2_T.font.meta,
                      color: otherMonth ? 'rgba(129, 144, 168, 0.55)' : V2_T.text.tertiary,
                      fontWeight: 500,
                    },
              },
              String(date.getDate()),
            ),
            isToday ? h('span', { key: 'tag', style: { fontSize: 10, color: V2_T.accent.base } }, '今天') : null,
          ],
        ),
        visible.map(renderMonthChip),
        hidden > 0
          ? h(
              'button',
              {
                key: 'more',
                type: 'button',
                onClick: function toggleMore(event) {
                  event.stopPropagation()
                  setExpandedDays(function toggle(prev) {
                    const next = Object.assign({}, prev)
                    if (next[day]) delete next[day]
                    else next[day] = true
                    return next
                  })
                },
                style: {
                  padding: '1px 4px',
                  marginBottom: 2,
                  border: 'none',
                  background: 'transparent',
                  color: V2_T.text.tertiary,
                  fontSize: V2_T.font.caption,
                  textAlign: 'left',
                  cursor: 'pointer',
                  borderRadius: 4,
                },
              },
              expanded ? '收起' : '还有 ' + hidden + ' 项',
            )
          : null,
        hasInline ? renderInlineInput() : null,
      ],
    )
  }

  function renderMonth() {
    const head = h(
      'div',
      {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
          flex: '0 0 auto',
          background: V2_T.surface.panel,
          borderBottom: '1px solid ' + V2_T.border.subtle,
        },
      },
      CAL2_MONTH_HEADERS.map(function renderHead(label, index) {
        return h(
          'div',
          {
            key: label,
            style: {
              height: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: V2_T.font.caption,
              fontWeight: 600,
              color: V2_T.text.tertiary,
              borderRight: index === CAL2_MONTH_HEADERS.length - 1 ? 'none' : '1px solid ' + V2_T.border.subtle,
            },
          },
          label,
        )
      }),
    )
    const cells = viewDays.map(renderMonthCell)
    return h(
      'div',
      {
        style: v2CardStyle({
          flex: '1 1 auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          minWidth: 0,
          margin: '12px 16px 16px',
        }),
      },
      [
        head,
        h(
          'div',
          {
            key: 'scroller',
            style: {
              flex: '1 1 auto',
              minHeight: 0,
              overflow: 'auto',
              scrollbarColor: V2_T.border.subtle + ' transparent',
            },
          },
          h(
            'div',
            {
              style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
                gridTemplateRows: 'repeat(6, minmax(96px, 1fr))',
                minWidth: 660,
                minHeight: '100%',
              },
            },
            cells,
          ),
        ),
      ],
    )
  }

  /* ── 渲染：周 / 日时间网格 ── */
  function renderGhost(preview, key, day) {
    const top = Math.max(0, ((preview.startMin - offsetMinutes) * hourPx) / 60)
    const height = Math.max(18, ((preview.endMin - preview.startMin) * hourPx) / 60)
    return h(
      'div',
      {
        key: key,
        style: {
          position: 'absolute',
          left: 2,
          right: 2,
          top: top,
          height: height,
          borderRadius: V2_T.radius.sm,
          background: 'rgba(110, 168, 254, 0.14)',
          border: '1px dashed ' + V2_T.accent.line,
          zIndex: 5,
          pointerEvents: 'none',
          padding: '4px 8px',
          fontSize: V2_T.font.caption,
          color: V2_T.text.primary,
          overflow: 'hidden',
          boxSizing: 'border-box',
        },
      },
      [
        h('div', { key: 'title', style: { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, preview.title || '任务'),
        h('div', { key: 'time', style: { fontSize: 10, color: V2_T.text.tertiary } }, cal2MinToHm(preview.startMin) + ' – ' + cal2MinToHm(preview.endMin)),
      ],
    )
  }

  function renderDraft() {
    const top = Math.max(0, ((draft.startMin - offsetMinutes) * hourPx) / 60)
    const height = Math.max(10, ((draft.endMin - draft.startMin) * hourPx) / 60)
    return h('div', {
      key: 'draft',
      style: {
        position: 'absolute',
        left: 2,
        right: 2,
        top: top,
        height: height,
        borderRadius: V2_T.radius.sm,
        background: V2_T.status.successSoft,
        border: '1px dashed rgba(98, 223, 174, 0.6)',
        zIndex: 4,
        pointerEvents: 'none',
        padding: '3px 6px',
        fontSize: 10,
        color: V2_T.status.success,
        boxSizing: 'border-box',
        overflow: 'hidden',
      },
    }, cal2MinToHm(draft.startMin) + ' – ' + cal2MinToHm(draft.endMin))
  }

  function renderInlineTimeInput() {
    const top = Math.max(0, ((inline.startMin - offsetMinutes) * hourPx) / 60)
    return h(
      'div',
      { key: 'inline-time', style: { position: 'absolute', left: 2, right: 2, top: top, zIndex: 9 } },
      h('input', {
        autoFocus: true,
        value: inline.value,
        placeholder: '任务标题，回车创建',
        onChange: function onChange(event) {
          const value = event.currentTarget.value
          setInline(function merge(prev) {
            return prev ? Object.assign({}, prev, { value: value }) : prev
          })
        },
        onClick: function stop(event) {
          event.stopPropagation()
        },
        onPointerDown: function stop(event) {
          event.stopPropagation()
        },
        onKeyDown: function onKeyDown(event) {
          if (event.key === 'Enter') {
            event.preventDefault()
            commitInline()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            cancelInline()
          }
        },
        onBlur: function onBlur() {
          commitInline()
        },
        style: {
          width: '100%',
          boxSizing: 'border-box',
          height: 28,
          background: V2_T.surface.input,
          border: '1px solid ' + V2_T.accent.line,
          borderRadius: V2_T.radius.sm,
          color: V2_T.text.primary,
          fontSize: V2_T.font.meta,
          padding: '0 8px',
          outline: 'none',
          fontFamily: COLORS.fontFamily,
          boxShadow: V2_T.shadow.card,
        },
      }),
    )
  }

  function renderDayColumn(day, index) {
    const gridHeight = ((24 * 60 - offsetMinutes) * hourPx) / 60
    const entries = entriesByDay[day] || []
    const timed = entries
      .filter(function onlyTimed(entry) {
        return entry.timed
      })
      .slice()
      .sort(function compare(a, b) {
        return a.startMin - b.startMin || b.endMin - a.endMin
      })
    const laid = cal2LayoutLanes(timed)
    const isToday = day === todayKey
    const isDropOver = dropPreview && dropPreview.day === day
    const children = []
    if (isToday && nowMinutes >= offsetMinutes) {
      children.push(
        h(
          'div',
          {
            key: 'now',
            style: {
              position: 'absolute',
              left: 0,
              right: 0,
              top: ((nowMinutes - offsetMinutes) * hourPx) / 60,
              height: 2,
              background: V2_T.accent.base,
              zIndex: 6,
              pointerEvents: 'none',
            },
          },
          h('span', {
            style: {
              position: 'absolute',
              left: -3,
              top: -3,
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: V2_T.accent.base,
            },
          }),
        ),
      )
    }
    laid.forEach(function renderEvent(item) {
      if (item.laneTotal > 3 && item.lane > 2) return
      const visibleLanes = Math.min(3, item.laneTotal)
      const leftPct = (item.lane / visibleLanes) * 100
      const widthPct = 100 / visibleLanes
      const top = Math.max(0, ((item.startMin - offsetMinutes) * hourPx) / 60)
      const height = Math.max(16, ((item.endMin - item.startMin) * hourPx) / 60)
      const color = cal2TaskColor(item.task)
      const timeText = cal2MinToHm(item.startMin) + ' – ' + cal2MinToHm(item.endMin)
      const previewing = dragPreview && dragPreview.taskId === item.task.id
      const hiddenSiblings = item.hiddenSiblings || []
      children.push(
        h(
          'div',
          {
            key: 'ev-' + item.task.id,
            'data-cal2-event': '1',
            title: item.task.title + ' ' + timeText,
            onPointerDown: function startMove(event) {
              beginEventDrag(event, Object.assign({ langDay: day }, item), 'move')
            },
            onMouseEnter: function hoverIn(event) {
              event.currentTarget.style.background = color + '2e'
              event.currentTarget.style.boxShadow = V2_T.shadow.card
            },
            onMouseLeave: function hoverOut(event) {
              event.currentTarget.style.background = color + '1f'
              event.currentTarget.style.boxShadow = 'none'
            },
            style: {
              position: 'absolute',
              top: top,
              height: height,
              left: 'calc(' + leftPct + '% + 2px)',
              width: 'calc(' + widthPct + '% - 4px)',
              borderRadius: V2_T.radius.sm,
              border: 'none',
              borderLeft: '3px solid ' + color,
              background: color + '1f',
              color: V2_T.text.primary,
              padding: '4px 8px',
              fontSize: view === 'day' ? 12.5 : 11.5,
              lineHeight: '1.35',
              overflow: 'hidden',
              cursor: 'grab',
              zIndex: 2,
              boxSizing: 'border-box',
              userSelect: 'none',
              opacity: previewing ? 0.4 : 1,
              boxShadow: 'none',
              transition: 'background ' + V2_T.motion.fast + 'ms ease, box-shadow ' + V2_T.motion.fast + 'ms ease',
            },
          },
          [
            h(
              'div',
              {
                key: 'title',
                style: {
                  fontWeight: 600,
                  color: V2_T.text.primary,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  paddingRight: hiddenSiblings.length ? 16 : 0,
                },
              },
              item.task.title,
            ),
            h(
              'div',
              {
                key: 'time',
                style: {
                  fontSize: view === 'day' ? 11 : 10,
                  color: V2_T.text.tertiary,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                },
              },
              timeText,
            ),
            hiddenSiblings.length
              ? h(
                  'button',
                  {
                    key: 'badge',
                    type: 'button',
                    title: '查看更多重叠任务',
                    onPointerDown: function stop(event) {
                      event.stopPropagation()
                    },
                    onClick: function showMore(event) {
                      event.stopPropagation()
                      const rect = event.currentTarget.getBoundingClientRect()
                      cal2OpenMenu(
                        rect.left,
                        rect.bottom + 2,
                        hiddenSiblings.map(function makeItem(sibling) {
                          return {
                            label: cal2MinToHm(sibling.startMin) + ' ' + sibling.task.title,
                            onClick: function openSibling() {
                              openEdit(sibling.task)
                            },
                          }
                        }),
                      )
                    },
                    style: {
                      position: 'absolute',
                      right: 3,
                      top: 3,
                      border: 'none',
                      background: 'rgba(4, 8, 14, 0.55)',
                      color: V2_T.status.warn,
                      fontSize: 9.5,
                      borderRadius: 4,
                      padding: '0 4px',
                      cursor: 'pointer',
                      lineHeight: '14px',
                      zIndex: 4,
                    },
                  },
                  '＋' + hiddenSiblings.length,
                )
              : null,
            h('div', {
              key: 'resize-start',
              onPointerDown: function startResize(event) {
                beginEventDrag(event, Object.assign({ langDay: day }, item), 'start')
              },
              style: { position: 'absolute', left: 0, right: 0, top: 0, height: 6, cursor: 'ns-resize', zIndex: 3 },
            }),
            h('div', {
              key: 'resize-end',
              onPointerDown: function endResize(event) {
                beginEventDrag(event, Object.assign({ langDay: day }, item), 'end')
              },
              style: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 6, cursor: 'ns-resize', zIndex: 3 },
            }),
          ],
        ),
      )
    })
    if (draft && draft.day === day) children.push(renderDraft())
    if (isDropOver) children.push(renderGhost(dropPreview, 'drop-ghost', day))
    if (dragPreview && dragPreview.day === day) {
      children.push(
        renderGhost(
          { startMin: dragPreview.startMin, endMin: dragPreview.endMin, title: (findTask(dragPreview.taskId) || {}).title || '任务' },
          'drag-ghost',
          day,
        ),
      )
    }
    if (inline && inline.kind === 'time' && inline.day === day) children.push(renderInlineTimeInput())
    return h(
      'div',
      {
        key: 'day-' + day,
        'data-cal2-day': day,
        onPointerDown: function pointerDown(event) {
          beginGridDraft(event, day)
        },
        onDragOver: function dragOver(event) {
          onTimeColumnDragOver(event, day)
          if (dragOverAllDay === day) setDragOverAllDay(null)
        },
        onDragLeave: function dragLeave(event) {
          onTimeColumnDragLeave(event, day)
        },
        onDrop: function drop(event) {
          onTimeColumnDrop(event, day)
        },
        style: {
          position: 'relative',
          height: gridHeight,
          borderRight: index === viewDays.length - 1 ? 'none' : '1px solid ' + V2_T.border.subtle,
          boxSizing: 'border-box',
          background: isDropOver ? V2_T.accent.soft : isToday ? 'rgba(110, 168, 254, 0.04)' : 'transparent',
          backgroundImage:
            'linear-gradient(to bottom, ' + V2_T.border.subtle + ' 1px, transparent 1px), linear-gradient(to bottom, rgba(42, 55, 76, 0.55) 1px, transparent 1px)',
          backgroundSize: '100% ' + hourPx + 'px, 100% ' + hourPx / 2 + 'px',
          cursor: 'crosshair',
          userSelect: 'none',
          overflow: 'hidden',
          minWidth: 0,
        },
      },
      children,
    )
  }

  function renderAllDayChip(day, entry) {
    const task = entry.task
    const color = cal2TaskColor(task)
    const hasPriority = !!(task.priority && task.priority !== 'none')
    return h(
      'div',
      {
        key: 'ad-chip-' + day + '-' + task.id,
        draggable: true,
        onDragStart: function onDragStart(event) {
          startHtmlDrag(event, task)
        },
        onDragEnd: endHtmlDrag,
        onClick: function openCard(event) {
          event.stopPropagation()
          openEdit(task)
        },
        onMouseEnter: cal2HoverIn(V2_T.surface.panel3),
        onMouseLeave: cal2HoverOut(V2_T.surface.panel2),
        title: task.title,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          height: 20,
          padding: '0 6px',
          borderRadius: 6,
          border: '1px solid ' + V2_T.border.subtle,
          borderLeft: '2px solid ' + (hasPriority ? color : 'transparent'),
          background: V2_T.surface.panel2,
          fontSize: V2_T.font.caption,
          color: V2_T.text.primary,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          cursor: 'grab',
          boxSizing: 'border-box',
          opacity: draggingTaskId === task.id ? 0.4 : 1,
        },
      },
      [
        entry.dueOnly
          ? h('span', { key: 'tag', style: { fontSize: 10, color: V2_T.status.warn, flex: '0 0 auto' } }, '截止')
          : null,
        h('span', { key: 'title', style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, task.title),
      ],
    )
  }

  function renderAllDayRow() {
    const label = h(
      'div',
      {
        key: 'lab',
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: V2_T.font.caption,
          color: V2_T.text.tertiary,
          borderRight: '1px solid ' + V2_T.border.subtle,
        },
      },
      '全天',
    )
    const cells = viewDays.map(function renderCell(day, index) {
      const entries = (entriesByDay[day] || []).filter(function onlyAllDay(entry) {
        return !entry.timed
      })
      const isOver = dragOverAllDay === day
      return h(
        'div',
        {
          key: 'ad-' + day,
          onDragOver: function dragOver(event) {
            event.preventDefault()
            if (dragOverAllDay !== day) setDragOverAllDay(day)
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
          },
          onDragLeave: function dragLeave(event) {
            if (event.currentTarget.contains(event.relatedTarget)) return
            if (dragOverAllDay === day) setDragOverAllDay(null)
          },
          onDrop: function drop(event) {
            handleCalendarDrop(event, { kind: 'allday', day: day })
          },
          style: {
            minHeight: 28,
            padding: '3px 4px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            borderRight: index === viewDays.length - 1 ? 'none' : '1px solid ' + V2_T.border.subtle,
            background: isOver ? V2_T.accent.soft : 'transparent',
            boxSizing: 'border-box',
          },
        },
        entries.map(function chip(entry) {
          return renderAllDayChip(day, entry)
        }),
      )
    })
    return h(
      'div',
      {
        style: {
          display: 'grid',
          gridTemplateColumns: '52px repeat(' + viewDays.length + ', minmax(0, 1fr))',
          flex: '0 0 auto',
          borderBottom: '1px solid ' + V2_T.border.subtle,
          background: V2_T.surface.panel,
        },
      },
      [label].concat(cells),
    )
  }

  function renderEarlyBand() {
    if (hasEarlyTimed) return null
    return h(
      'div',
      {
        key: 'early-band',
        onClick: function toggle() {
          setExpandEarly(function flip(value) {
            return !value
          })
        },
        onMouseEnter: cal2HoverIn(V2_T.surface.panel3),
        onMouseLeave: cal2HoverOut(V2_T.surface.panel2),
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 26,
          padding: '0 10px',
          background: V2_T.surface.panel2,
          borderBottom: '1px solid ' + V2_T.border.subtle,
          color: V2_T.text.tertiary,
          fontSize: V2_T.font.caption,
          cursor: 'pointer',
          flex: '0 0 auto',
        },
      },
      [
        h(V2Icon, { key: 'icon', name: expandEarly ? 'chevronDown' : 'chevronRight', size: 12 }),
        expandEarly ? '00:00 – 06:00 已展开，点击折叠' : '00:00 – 06:00 已折叠（无日程），点击展开',
      ],
    )
  }

  function renderTimeGrid() {
    const gridHeight = ((24 * 60 - offsetMinutes) * hourPx) / 60
    const headCells = viewDays.map(function renderHead(day, index) {
      const date = cal2Date(day)
      const isToday = day === todayKey
      return h(
        'div',
        {
          key: 'head-' + day,
          title: '查看日视图',
          onClick: function openDay() {
            setAnchor(day)
            setView('day')
          },
          style: {
            height: 34,
            borderRight: index === viewDays.length - 1 ? 'none' : '1px solid ' + V2_T.border.subtle,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            cursor: 'pointer',
            background: isToday ? 'rgba(110, 168, 254, 0.08)' : 'transparent',
            minWidth: 0,
          },
        },
        [
          h(
            'b',
            { key: 'wd', style: { fontSize: 12, fontWeight: 600, color: isToday ? V2_T.accent.base : V2_T.text.secondary } },
            CAL2_WEEKDAY_SHORT[date.getDay()],
          ),
          h('span', { key: 'md', style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary } }, date.getMonth() + 1 + '/' + date.getDate()),
        ],
      )
    })
    const head = h(
      'div',
      {
        style: {
          display: 'grid',
          gridTemplateColumns: '52px repeat(' + viewDays.length + ', minmax(0, 1fr))',
          position: 'sticky',
          top: 0,
          zIndex: 8,
          background: V2_T.surface.panel,
          borderBottom: '1px solid ' + V2_T.border.subtle,
          flex: '0 0 auto',
        },
      },
      [h('div', { key: 'rail', style: { height: 34, borderRight: '1px solid ' + V2_T.border.subtle } })].concat(headCells),
    )
    const hourLabels = []
    for (let hour = offsetMinutes / 60; hour < 24; hour += 1) {
      const top = ((hour * 60 - offsetMinutes) * hourPx) / 60
      hourLabels.push(
        h(
          'div',
          {
            key: 'hour-' + hour,
            style: {
              position: 'absolute',
              top: Math.max(1, top - 6),
              right: 6,
              fontSize: V2_T.font.caption,
              color: V2_T.text.tertiary,
              lineHeight: '13px',
              pointerEvents: 'none',
            },
          },
          cal2Pad(hour) + ':00',
        ),
      )
    }
    const rail = h(
      'div',
      {
        style: {
          position: 'relative',
          borderRight: '1px solid ' + V2_T.border.subtle,
          background: V2_T.surface.panel,
          height: gridHeight,
        },
      },
      hourLabels,
    )
    const columns = viewDays.map(renderDayColumn)
    const body = h(
      'div',
      {
        style: {
          display: 'grid',
          gridTemplateColumns: '52px repeat(' + viewDays.length + ', minmax(0, 1fr))',
          flex: '0 0 auto',
          minHeight: gridHeight,
        },
      },
      [rail].concat(columns),
    )
    const inner = h(
      'div',
      {
        style: {
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          minWidth: view === 'day' ? 0 : 640,
          maxWidth: view === 'day' ? 900 : undefined,
          width: view === 'day' ? '100%' : undefined,
          margin: view === 'day' ? '0 auto' : 0,
          boxSizing: 'border-box',
        },
      },
      [head, renderEarlyBand(), renderAllDayRow(), body],
    )
    return h(
      'div',
      {
        ref: gridScrollRef,
        style: v2CardStyle({
          flex: '1 1 auto',
          minHeight: 0,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          margin: '12px 16px 16px',
          scrollbarColor: V2_T.border.subtle + ' transparent',
        }),
      },
      inner,
    )
  }

  /* ── 渲染：右侧任务栏 ── */
  function barDateText(task) {
    const startParts = cal2IsoToParts(cal2TaskStartIso(task))
    if (startParts) return cal2MinToHm(startParts.minutes)
    const scheduledDate = cal2TaskScheduledDate(task)
    if (scheduledDate) return v2DateLabel(scheduledDate)
    const dueDate = cal2TaskDueDate(task)
    if (dueDate) return '截止 ' + v2DateLabel(dueDate)
    return '无日期'
  }

  function buildBarGroups() {
    const groups = { today: [], week: [], later: [], none: [] }
    const weekEnd = cal2AddDays(todayKey, 7)
    filteredTasks.forEach(function classify(task) {
      const day = cal2TaskDayKey(task)
      if (!day) groups.none.push(task)
      else if (day === todayKey) groups.today.push(task)
      else if (day > todayKey && day <= weekEnd) groups.week.push(task)
      else groups.later.push(task)
    })
    function sortGroup(a, b) {
      const dayA = cal2TaskDayKey(a) || '9999-99-99'
      const dayB = cal2TaskDayKey(b) || '9999-99-99'
      if (dayA !== dayB) return dayA < dayB ? -1 : 1
      const startA = cal2IsoToParts(cal2TaskStartIso(a))
      const startB = cal2IsoToParts(cal2TaskStartIso(b))
      const minA = startA ? startA.minutes : 9999
      const minB = startB ? startB.minutes : 9999
      if (minA !== minB) return minA - minB
      return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN')
    }
    return [
      { key: 'today', label: '今天', items: groups.today.slice().sort(sortGroup) },
      { key: 'week', label: '最近 7 天', items: groups.week.slice().sort(sortGroup) },
      { key: 'later', label: '更远', items: groups.later.slice().sort(sortGroup) },
      { key: 'none', label: '无日期', items: groups.none.slice().sort(sortGroup) },
    ]
  }

  function renderSidebar() {
    if (barCollapsed) {
      return h(
        'aside',
        {
          key: 'bar-collapsed',
          style: {
            width: CAL2_SIDEBAR_COLLAPSED_WIDTH,
            flex: '0 0 ' + CAL2_SIDEBAR_COLLAPSED_WIDTH + 'px',
            borderLeft: '1px solid ' + V2_T.border.subtle,
            background: V2_T.surface.side,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingTop: 8,
            gap: 6,
            minHeight: 0,
            boxSizing: 'border-box',
          },
        },
        [
          h(
            'button',
            {
              key: 'expand',
              type: 'button',
              title: '展开任务栏',
              onClick: toggleBar,
              style: barIconBtnStyle,
              onMouseEnter: cal2HoverIn(V2_T.surface.panel2),
              onMouseLeave: cal2HoverOut('transparent'),
            },
            h(V2Icon, { name: 'chevronLeft', size: 16 }),
          ),
          h(
            'div',
            {
              key: 'label',
              onClick: toggleBar,
              title: '展开任务栏',
              style: {
                writingMode: 'vertical-rl',
                fontSize: V2_T.font.caption,
                color: V2_T.text.tertiary,
                letterSpacing: 2,
                cursor: 'pointer',
                userSelect: 'none',
              },
            },
            '任务 ' + filteredTasks.length,
          ),
        ],
      )
    }
    const listOptions = [h('option', { key: 'all', value: 'all' }, '全部清单')].concat(
      lists.map(function renderList(list) {
        return h('option', { key: list.id, value: list.id }, list.name || '未命名清单')
      }),
    )
    const groups = buildBarGroups()
    const total = groups.reduce(function sum(value, group) {
      return value + group.items.length
    }, 0)
    const listChildren = []
    groups.forEach(function renderGroup(group) {
      if (!group.items.length) return
      listChildren.push(
        h(
          'div',
          { key: 'group-' + group.key, style: { marginTop: 8 } },
          [
            h(
              'div',
              {
                key: 'head',
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 6px 4px',
                  fontSize: V2_T.font.caption,
                  fontWeight: 600,
                  color: V2_T.text.tertiary,
                  letterSpacing: 0.2,
                },
              },
              [
                h('span', { key: 'label' }, group.label),
                h(
                  'span',
                  { key: 'count', style: { fontSize: V2_T.font.caption, fontWeight: 500, color: V2_T.text.tertiary } },
                  String(group.items.length),
                ),
              ],
            ),
          ].concat(
            group.items.map(function renderTask(task) {
              return h(
                'div',
                {
                  key: task.id,
                  draggable: true,
                  onDragStart: function onDragStart(event) {
                    startHtmlDrag(event, task)
                  },
                  onDragEnd: endHtmlDrag,
                  onClick: function openCard() {
                    openEdit(task)
                  },
                  title: task.title + ' · 拖到日历可排期',
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    height: 32,
                    padding: '0 10px',
                    borderRadius: 6,
                    fontSize: V2_T.font.body,
                    color: V2_T.text.primary,
                    cursor: 'grab',
                    opacity: draggingTaskId === task.id ? 0.4 : 1,
                    boxSizing: 'border-box',
                  },
                  onMouseEnter: cal2HoverIn(V2_T.surface.panel2),
                  onMouseLeave: cal2HoverOut('transparent'),
                },
                [
                  h('span', {
                    key: 'dot',
                    style: {
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: cal2TaskColor(task),
                      marginTop: 0,
                      flex: '0 0 auto',
                    },
                  }),
                  h(
                    'span',
                    {
                      key: 'title',
                      style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    },
                    task.title,
                  ),
                  h(
                    'span',
                    {
                      key: 'date',
                      style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary, flex: '0 0 auto' },
                    },
                    barDateText(task),
                  ),
                ],
              )
            }),
          ),
        )
      )
    })
    if (!listChildren.length) {
      listChildren.push(
        h(
          'div',
          {
            key: 'empty',
            style: {
              padding: '24px 8px',
              fontSize: V2_T.font.meta,
              color: V2_T.text.tertiary,
              textAlign: 'center',
              lineHeight: 1.7,
            },
          },
          ['暂无任务', h('br', { key: 'br' }), '把任务拖进日历即可排期'],
        ),
      )
    }
    return h(
      'aside',
      {
        key: 'bar',
        style: {
          width: barWidth,
          flex: '0 0 ' + barWidth + 'px',
          borderLeft: '1px solid ' + V2_T.border.subtle,
          background: V2_T.surface.side,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          minWidth: 0,
          boxSizing: 'border-box',
        },
      },
      [
        h(
          'div',
          {
            key: 'head',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 36,
              padding: '0 8px',
              borderBottom: '1px solid ' + V2_T.border.subtle,
              flex: '0 0 auto',
              boxSizing: 'border-box',
            },
          },
          [
            h(
              'select',
              {
                key: 'filter',
                value: listFilter,
                title: '按清单筛选',
                onChange: function onChange(event) {
                  setListFilter(event.currentTarget.value)
                },
                style: Object.assign(cal2FieldStyle({ height: 30, fontSize: 12, cursor: 'pointer' }), {
                  flex: '1 1 auto',
                  width: 'auto',
                  minWidth: 0,
                }),
              },
              listOptions,
            ),
            h(
              'button',
              {
                key: 'refresh',
                type: 'button',
                title: '刷新',
                onClick: function refresh() {
                  setReloadTick(function bump(value) {
                    return value + 1
                  })
                },
                style: barIconBtnStyle,
                onMouseEnter: cal2HoverIn(V2_T.surface.panel2),
                onMouseLeave: cal2HoverOut('transparent'),
              },
              h(V2Icon, { name: 'refresh', size: 14 }),
            ),
            h(
              'button',
              {
                key: 'more',
                type: 'button',
                title: '更多',
                onClick: openBarMenu,
                style: barIconBtnStyle,
                onMouseEnter: cal2HoverIn(V2_T.surface.panel2),
                onMouseLeave: cal2HoverOut('transparent'),
              },
              h(V2Icon, { name: 'more', size: 15 }),
            ),
            h(
              'button',
              {
                key: 'collapse',
                type: 'button',
                title: '收起任务栏',
                onClick: toggleBar,
                style: barIconBtnStyle,
                onMouseEnter: cal2HoverIn(V2_T.surface.panel2),
                onMouseLeave: cal2HoverOut('transparent'),
              },
              h(V2Icon, { name: 'chevronRight', size: 16 }),
            ),
          ],
        ),
        h(
          'div',
          {
            key: 'list',
            style: {
              flex: '1 1 auto',
              minHeight: 0,
              overflow: 'auto',
              padding: '4px 8px 16px',
              scrollbarColor: V2_T.border.subtle + ' transparent',
            },
          },
          listChildren,
        ),
        h(
          'div',
          {
            key: 'foot',
            style: {
              flex: '0 0 auto',
              borderTop: '1px solid ' + V2_T.border.subtle,
              padding: '6px 12px',
              fontSize: V2_T.font.caption,
              color: V2_T.text.tertiary,
            },
          },
          '共 ' + total + ' 项 · 拖入日历可排期',
        ),
      ],
    )
  }

  /* ── 渲染：错误条 ── */
  function renderErrorBar() {
    return h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 16px',
          background: V2_T.status.dangerSoft,
          borderBottom: '1px solid rgba(255, 138, 138, 0.25)',
          color: V2_T.status.danger,
          fontSize: V2_T.font.meta,
          flex: '0 0 auto',
        },
      },
      [
        h(
          'span',
          {
            key: 'text',
            style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          },
          '日历数据读取失败：' + loadError,
        ),
        h(
          'button',
          {
            key: 'retry',
            type: 'button',
            onClick: function retry() {
              setReloadTick(function bump(value) {
                return value + 1
              })
            },
            style: {
              height: 24,
              padding: '0 10px',
              display: 'inline-flex',
              alignItems: 'center',
              border: '1px solid rgba(255, 138, 138, 0.35)',
              background: 'transparent',
              borderRadius: 6,
              color: V2_T.status.danger,
              fontFamily: COLORS.fontFamily,
              fontSize: V2_T.font.caption,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            },
          },
          '重试',
        ),
      ],
    )
  }

  return h(
    'div',
    {
      style: {
        flex: '1 1 auto',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        background: V2_T.surface.app,
        color: V2_T.text.primary,
        fontFamily: COLORS.fontFamily,
        position: 'relative',
      },
    },
    [
      h(
        'div',
        {
          key: 'main',
          style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' },
        },
        [renderToolbar(), loadError ? renderErrorBar() : null, view === 'month' ? renderMonth() : renderTimeGrid()],
      ),
      barCollapsed || narrow
        ? null
        : h('div', {
            key: 'bar-splitter',
            title: '拖动调整任务栏宽度',
            onMouseDown: startBarResize,
            style: {
              flex: '0 0 6px',
              width: 6,
              cursor: 'col-resize',
              background: 'transparent',
              marginLeft: -3,
              marginRight: -3,
              zIndex: 2,
            },
            onMouseEnter: function onEnter(event) {
              event.currentTarget.style.background = V2_T.border.subtle
            },
            onMouseLeave: function onLeave(event) {
              event.currentTarget.style.background = 'transparent'
            },
          }),
      renderSidebar(),
      editing
        ? h(Cal2TaskModal, {
            key: 'task-modal',
            task: editing.task || null,
            isNew: editing.isNew === true,
            defaultDate: editing.defaultDate || '',
            lists: lists,
            onClose: function closeModal() {
              setEditing(null)
            },
            onSave: handleModalSave,
          })
        : null,
    ],
  )
}

/* ---- 40-habits.js (3781 lines) ---- */
/* ═══════════════════════ M6 · V2 习惯 Tab ═══════════════════════
 * 入口：HabitTabV2({ runtime, narrow })
 * 数据源：GET /habits、GET /habits/stats、GET /habits/:id/checkins、GET /habits/month
 * 写入：POST /habits/:id/checkin、DELETE /habits/:id/checkins/:date、
 *       POST /habits、PATCH /habits/:id、POST /habits/:id/archive
 * 说明：
 *  - Host 之后端只有 habit 表 + habit_checkin 表，没有独立的习惯日志表；
 *    规格里的“打卡日志”落到 checkin.note 上，删除日志 = note 置空（打卡记录保留）。
 *  - 补打卡窗口：过去日期必须带 retro 且最近 7 天内（RETRO_WINDOW_DAYS）。
 *  - 图标/分组不属于 Host 数据模型，图标按名称推导，列表按“当日计划 / 灵活打卡 / 已暂停”分组。
 */

const HABIT_LIST_WIDTH = 400
const HABIT_PANES_STORAGE_KEY = 'lifeos.v2.habitPanes'
const HABIT_LIST_MIN = 320
const HABIT_LIST_MAX = 560

function habitClampListWidth(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return HABIT_LIST_WIDTH
  return Math.max(HABIT_LIST_MIN, Math.min(HABIT_LIST_MAX, Math.round(num)))
}
const HABIT_NOTE_MAX = 500
const HABIT_RETRO_WINDOW_DAYS = 7
const HABIT_WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const HABIT_WEEKDAY_LABELS = { MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六', SU: '日' }
const HABIT_WEEKDAY_FULL = { MO: '周一', TU: '周二', WE: '周三', TH: '周四', FR: '周五', SA: '周六', SU: '周日' }
const HABIT_FREQUENCY_KINDS = [
  { id: 'daily', label: '每天' },
  { id: 'weekly_days', label: '每周固定' },
  { id: 'weekly_count', label: '每周 N 次' },
  { id: 'interval', label: '间隔 N 天' },
]
const HABIT_ICON_FALLBACKS = ['🌱', '🪴', '🌿', '🍀', '🌳', '🌵', '🍃', '🌾']
const HABIT_ICON_HINTS = [
  { keys: ['晨跑', '跑步', '跑', '慢跑'], icon: '🏃' },
  { keys: ['散步', '走路', '步行'], icon: '🚶' },
  { keys: ['骑行', '单车', '自行车'], icon: '🚴' },
  { keys: ['游泳'], icon: '🏊' },
  { keys: ['健身', '力量', '撸铁', '运动', '锻炼'], icon: '🏋️' },
  { keys: ['瑜伽', '冥想', '正念', '拉伸'], icon: '🧘' },
  { keys: ['阅读', '读书', '看书'], icon: '📖' },
  { keys: ['写作', '日记', '复盘', '记录'], icon: '✍️' },
  { keys: ['喝水', '饮水', '水'], icon: '💧' },
  { keys: ['早睡', '睡眠', '睡觉', '入睡'], icon: '🛌' },
  { keys: ['早起', '起床'], icon: '⏰' },
  { keys: ['早餐', '饮食', '吃饭', '健康饮食', '轻食'], icon: '🥗' },
  { keys: ['学习', '课程', '背单词', '英语', '复习'], icon: '📚' },
  { keys: ['代码', '编程', '开发'], icon: '💻' },
  { keys: ['练琴', '钢琴', '吉他'], icon: '🎹' },
  { keys: ['画画', '绘画'], icon: '🎨' },
  { keys: ['音乐', '听歌'], icon: '🎵' },
  { keys: ['整理', '清理', '家务', '打扫', '收纳'], icon: '🧹' },
  { keys: ['记账', '理财', '存钱'], icon: '💰' },
  { keys: ['家人', '陪伴', '联系', '朋友'], icon: '👨‍👩‍👧' },
  { keys: ['练字'], icon: '🖌️' },
  { keys: ['总结', '计划'], icon: '📝' },
  { keys: ['晒太阳', '户外', '阳光'], icon: '☀️' },
  { keys: ['护肤', '洗头'], icon: '🧴' },
  { keys: ['遛狗', '狗'], icon: '🐕' },
  { keys: ['喂猫', '猫'], icon: '🐈' },
  { keys: ['电影', '观影'], icon: '🎬' },
  { keys: ['药', '维生素'], icon: '💊' },
]
const HABIT_STATUS_META = {
  done: { label: '已完成', tone: 'success' },
  partial: { label: '部分完成', tone: 'warn' },
  skipped: { label: '已跳过', tone: 'faint' },
  not_done: { label: '未完成', tone: 'danger' },
  paused: { label: '已暂停', tone: 'faint' },
  unknown: { label: '未记录', tone: 'faint' },
}

/* ── 日期工具（V2 作用域里没有通用的月份/日期解析函数，这里自包含实现） ── */

function habitPad2(value) {
  const number = Number(value)
  return number < 10 ? '0' + String(number) : String(number)
}

function habitDateFromKey(dateKey) {
  if (!dateKey) return null
  const date = new Date(String(dateKey) + 'T00:00:00')
  return Number.isNaN(date.getTime()) ? null : date
}

function habitDateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  return date.getFullYear() + '-' + habitPad2(date.getMonth() + 1) + '-' + habitPad2(date.getDate())
}

function habitToday() {
  try {
    if (typeof todayIso === 'function') {
      const value = todayIso()
      if (value) return value
    }
  } catch (error) {
    /* ignore */
  }
  return habitDateKey(new Date())
}

function habitAddDays(dateKey, days) {
  try {
    if (typeof addDaysKey === 'function') return addDaysKey(dateKey, Number(days) || 0)
  } catch (error) {
    /* ignore */
  }
  const date = habitDateFromKey(dateKey)
  if (!date) return dateKey
  date.setDate(date.getDate() + (Number(days) || 0))
  return habitDateKey(date)
}

function habitDaysBetween(fromKey, toKey) {
  const from = habitDateFromKey(fromKey)
  const to = habitDateFromKey(toKey)
  if (!from || !to) return 0
  return Math.round((to.getTime() - from.getTime()) / 86400000)
}

/* 0 = 周一 … 6 = 周日，与 Host domain/habit.js 的 WEEKDAYS 顺序一致 */
function habitWeekdayIndex(dateKey) {
  const date = habitDateFromKey(dateKey)
  if (!date) return 0
  return (date.getDay() + 6) % 7
}

function habitWeekdayCodeOf(dateKey) {
  return HABIT_WEEKDAY_CODES[habitWeekdayIndex(dateKey)]
}

function habitMonthKeyOf(dateKey) {
  return String(dateKey || '').slice(0, 7)
}

function habitMonthDates(monthKey) {
  const parts = String(monthKey || '').split('-')
  const year = Number(parts[0])
  const month = Number(parts[1])
  if (!year || !month) return []
  const total = new Date(year, month, 0).getDate()
  const dates = []
  for (let day = 1; day <= total; day += 1) dates.push(year + '-' + habitPad2(month) + '-' + habitPad2(day))
  return dates
}

function habitShiftMonth(monthKey, delta) {
  const parts = String(monthKey || '').split('-')
  const now = new Date()
  const year = Number(parts[0]) || now.getFullYear()
  const month = Number(parts[1]) || now.getMonth() + 1
  const date = new Date(year, month - 1 + Number(delta || 0), 1)
  return date.getFullYear() + '-' + habitPad2(date.getMonth() + 1)
}

function habitMonthLabel(monthKey) {
  const parts = String(monthKey || '').split('-')
  if (parts.length < 2) return String(monthKey || '')
  return parts[0] + '年' + String(Number(parts[1])) + '月'
}

function habitFormatDate(dateKey) {
  if (!dateKey) return ''
  const parts = String(dateKey).split('-')
  if (parts.length < 3) return String(dateKey)
  return Number(parts[1]) + '月' + Number(parts[2]) + '日'
}

function habitFormatDateTime(iso) {
  if (!iso) return ''
  return String(iso).slice(0, 10)
}

function habitWeekStartOf(dateKey, weekStart) {
  const index = habitWeekdayIndex(dateKey)
  if (weekStart === 'sunday') return habitAddDays(dateKey, -((index + 1) % 7))
  return habitAddDays(dateKey, -index)
}

function habitClampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const rounded = Math.round(number)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/* ── 频率 / 计划日 / 目标 ── */

function habitFrequencyRule(habit) {
  const rule = habit && habit.frequency_rule
  return rule && typeof rule === 'object' ? rule : null
}

function habitFrequencyKind(habit) {
  const rule = habitFrequencyRule(habit)
  return rule && rule.kind ? String(rule.kind) : 'daily'
}

function habitSortWeekdays(days) {
  const source = Array.isArray(days) ? days : []
  const seen = {}
  const out = []
  HABIT_WEEKDAY_CODES.forEach(function each(code) {
    if (source.indexOf(code) >= 0 && !seen[code]) {
      seen[code] = true
      out.push(code)
    }
  })
  return out
}

function habitWeekDays(habit) {
  const rule = habitFrequencyRule(habit)
  return habitSortWeekdays(rule && rule.days)
}

function habitFrequencyText(habit) {
  if (habit && typeof habit.frequency_text === 'string' && habit.frequency_text) return habit.frequency_text
  const rule = habitFrequencyRule(habit)
  if (!rule) return '未设置频率'
  if (rule.kind === 'daily') {
    const interval = habitClampInt(rule.interval, 1, 365, 1)
    return interval === 1 ? '每天' : '每 ' + interval + ' 天'
  }
  if (rule.kind === 'weekly_days') {
    const days = habitSortWeekdays(rule.days)
    if (days.length === 7) return '每天'
    if (!days.length) return '每周（未选星期）'
    return '每周 ' + days.map(function label(code) { return HABIT_WEEKDAY_LABELS[code] }).join('、')
  }
  if (rule.kind === 'weekly_count') return '每周 ' + habitClampInt(rule.count, 1, 7, 1) + ' 次'
  if (rule.kind === 'interval') return '每 ' + habitClampInt(rule.days, 1, 365, 1) + ' 天'
  return '未设置频率'
}

/* 与 Host domain/habit.js isPlanDay 同口径：weekly_count 恒为 false（按周期统计） */
function habitPlanDay(habit, dateKey) {
  if (!habit || !dateKey) return false
  const rule = habitFrequencyRule(habit)
  if (!rule) return false
  const start = habit.start_date
  if (!start || dateKey < start) return false
  if (habit.end_date && dateKey > habit.end_date) return false
  if (rule.kind === 'daily') {
    const interval = habitClampInt(rule.interval, 1, 365, 1)
    return habitDaysBetween(start, dateKey) % interval === 0
  }
  if (rule.kind === 'weekly_days') {
    const days = habitSortWeekdays(rule.days)
    return days.indexOf(habitWeekdayCodeOf(dateKey)) >= 0
  }
  if (rule.kind === 'interval') {
    const anchor = rule.anchor_date || start
    const interval = habitClampInt(rule.days, 1, 365, 1)
    return habitDaysBetween(anchor, dateKey) % interval === 0
  }
  return false
}

/* 暂停区间：[paused_at, resumed_at 或 现在]；Host 只有一对字段，按当前区间处理 */
function habitPausedOn(habit, dateKey) {
  if (!habit || !dateKey) return false
  const pausedAt = habit.paused_at ? String(habit.paused_at).slice(0, 10) : ''
  if (!pausedAt) return habit.status === 'paused'
  if (dateKey < pausedAt) return false
  const resumedAt = habit.resumed_at ? String(habit.resumed_at).slice(0, 10) : ''
  if (resumedAt && dateKey >= resumedAt) return false
  return true
}

function habitTargetJson(habit) {
  const target = habit && habit.target_json
  return target && typeof target === 'object' ? target : null
}

function habitTargetValue(habit) {
  const target = habitTargetJson(habit)
  if (!target) return 0
  const raw = target.value !== undefined ? target.value : target.target
  const number = Number(raw)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function habitTargetUnit(habit) {
  const target = habitTargetJson(habit)
  if (target && typeof target.unit === 'string' && target.unit) return target.unit
  return '次'
}

function habitIsQuantified(habit) {
  return habitTargetValue(habit) > 1
}

function habitPeriodTarget(habit) {
  const rule = habit && habit.period_rule
  if (rule && typeof rule === 'object') {
    const count = Number(rule.target_count)
    if (Number.isInteger(count) && count > 0) return count
  }
  const frequency = habitFrequencyRule(habit)
  if (frequency && frequency.kind === 'weekly_count') {
    const count = Number(frequency.count)
    if (Number.isInteger(count) && count > 0) return count
  }
  return 0
}

function habitIconFor(habit) {
  const name = String((habit && habit.name) || '')
  for (let i = 0; i < HABIT_ICON_HINTS.length; i += 1) {
    const entry = HABIT_ICON_HINTS[i]
    for (let j = 0; j < entry.keys.length; j += 1) {
      if (name.indexOf(entry.keys[j]) >= 0) return entry.icon
    }
  }
  const seed = String((habit && (habit.id || habit.name)) || '')
  let sum = 0
  for (let i = 0; i < seed.length; i += 1) sum += seed.charCodeAt(i)
  return HABIT_ICON_FALLBACKS[sum % HABIT_ICON_FALLBACKS.length]
}

/* ── 打卡记录工具 ── */

function habitCheckinMap(checkins) {
  const out = {}
  const list = Array.isArray(checkins) ? checkins : []
  list.forEach(function each(item) {
    if (item && item.local_date) out[item.local_date] = item
  })
  return out
}

function habitCheckinByDate(checkins, dateKey) {
  const list = Array.isArray(checkins) ? checkins : []
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].local_date === dateKey) return list[i]
  }
  return null
}

function habitCheckinValue(checkin) {
  if (!checkin) return 0
  const raw = checkin.value_json
  let value = null
  if (raw && typeof raw === 'object') {
    if (raw.value !== undefined) value = raw.value
    else if (raw.target !== undefined) value = raw.target
  } else if (typeof raw === 'number') {
    value = raw
  }
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function habitStatusMeta(status) {
  return HABIT_STATUS_META[status] || HABIT_STATUS_META.unknown
}

function habitStatusLabel(status) {
  return habitStatusMeta(status).label
}

function habitStatusTone(status) {
  return habitStatusMeta(status).tone
}

function habitStreakUnitLabel(unit) {
  if (unit === 'week') return '周'
  if (unit === 'month') return '月'
  return '天'
}

function habitStreakText(statsItem) {
  const streak = statsItem && statsItem.streak
  if (!streak) return ''
  const value = Number(streak.value) || 0
  if (value <= 0) return ''
  return '连续 ' + value + ' ' + habitStreakUnitLabel(streak.unit)
}

function habitErrorHint(error) {
  const text = errorText(error)
  if (text.indexOf('补记窗口') >= 0 || text.indexOf('retro') >= 0) return '过去日期只能补记最近 7 天内的打卡'
  if (text.indexOf('invalid_state') >= 0) return '习惯已暂停或归档，无法打卡'
  if (text.indexOf('not_found') >= 0) return '记录不存在或已被删除'
  if (text.indexOf('conflict') >= 0 || text.indexOf('revision') >= 0) return '数据已被其他操作更新，请刷新后重试'
  return text
}

/* ── API 封装 ── */

function habitApiSend(method, path, body) {
  const init = { method: method, headers: { accept: 'application/json' } }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return apiRequest(path, init)
}

async function habitFetchStatsMap() {
  try {
    const payload = await apiRequest('/habits/stats')
    const map = {}
    const items = payload && Array.isArray(payload.habits) ? payload.habits : []
    items.forEach(function each(item) {
      if (item && item.habitId) map[item.habitId] = item
    })
    return map
  } catch (error) {
    return null
  }
}

async function habitFetchCheckins(habitId) {
  try {
    const payload = await apiRequest('/habits/' + encodeURIComponent(habitId) + '/checkins')
    return payload && Array.isArray(payload.items) ? payload.items : []
  } catch (error) {
    return null
  }
}

async function habitFetchMonth(monthKey) {
  try {
    const payload = await apiRequest('/habits/month?month=' + encodeURIComponent(monthKey))
    return payload && payload.month ? payload : null
  } catch (error) {
    return null
  }
}

/* ── 纯计算：7 天圆环聚合 / 单习惯月度统计 ── */

function habitDateSummary(habits, checkinsById, dateKey) {
  let planned = 0
  let doneUnits = 0
  let recorded = 0
  const list = Array.isArray(habits) ? habits : []
  list.forEach(function each(habit) {
    if (!habit || habit.status === 'archived') return
    if (habitPausedOn(habit, dateKey)) return
    const checkins = checkinsById[habit.id] || []
    const record = habitCheckinByDate(checkins, dateKey)
    const plan = habitPlanDay(habit, dateKey)
    if (plan) planned += 1
    if (!record) return
    recorded += 1
    if (!plan) return
    if (record.status === 'done') doneUnits += 1
    else if (record.status === 'partial') {
      const target = habitTargetValue(habit) || 1
      const value = habitCheckinValue(record)
      doneUnits += Math.max(0, Math.min(1, value / target))
    }
  })
  return {
    planned: planned,
    doneUnits: doneUnits,
    recorded: recorded,
    ratio: planned > 0 ? Math.min(1, doneUnits / planned) : 0,
  }
}

function habitMonthStats(habit, monthKey, checkins, today, weekStart) {
  const result = { monthDone: 0, totalDone: 0, expected: 0, done: 0, ratio: null }
  if (!habit) return result
  const list = Array.isArray(checkins) ? checkins : []
  const dates = habitMonthDates(monthKey)
  const monthStart = dates.length ? dates[0] : monthKey + '-01'
  const monthEnd = dates.length ? dates[dates.length - 1] : monthKey + '-31'
  const upto = today && today < monthEnd ? today : monthEnd
  const checkinMap = habitCheckinMap(list)
  list.forEach(function count(item) {
    if (!item || item.status !== 'done') return
    result.totalDone += 1
    if (habitMonthKeyOf(item.local_date) === monthKey) result.monthDone += 1
  })
  if (habitFrequencyKind(habit) === 'weekly_count') {
    // 与 Host computeCoverage 同口径：只统计「完整落在本月内且已经结束」的周期，
    // 月初/月末被截断的半周期不计入分母，否则完成率会被系统性低估。
    const target = habitPeriodTarget(habit)
    let cursor = habitWeekStartOf(monthStart, weekStart)
    let guard = 0
    while (cursor <= upto && guard < 12) {
      guard += 1
      const periodEnd = habitAddDays(cursor, 6)
      if (cursor >= monthStart && periodEnd <= monthEnd && periodEnd <= upto) {
        result.expected += target
        let periodDone = 0
        list.forEach(function countInPeriod(item) {
          if (!item || item.status !== 'done') return
          if (item.local_date >= cursor && item.local_date <= periodEnd) periodDone += 1
        })
        result.done += Math.min(target, periodDone)
      }
      cursor = habitAddDays(cursor, 7)
    }
  } else {
    dates.forEach(function countDay(dateKey) {
      if (dateKey > upto) return
      if (habitPausedOn(habit, dateKey)) return
      if (!habitPlanDay(habit, dateKey)) return
      result.expected += 1
      const record = checkinMap[dateKey]
      if (record && record.status === 'done') result.done += 1
    })
  }
  result.ratio = result.expected > 0 ? Math.min(1, result.done / result.expected) : null
  return result
}

function habitMonthCellMeta(status, paused, future, plan) {
  if (status === 'done') {
    return { title: '已完成', color: V2_T.status.success, background: V2_T.status.successSoft, border: '1px solid transparent' }
  }
  if (status === 'partial') {
    return { title: '部分完成', color: V2_T.status.warn, background: V2_T.status.warnSoft, border: '1px solid transparent' }
  }
  if (status === 'not_done' || status === 'skipped') {
    return { title: '应完成未完成', color: V2_T.status.danger, background: V2_T.status.dangerSoft, border: '1px solid transparent' }
  }
  if (status === 'paused' || paused) {
    return { title: '暂停日', color: V2_T.text.tertiary, background: 'transparent', border: '1px solid transparent' }
  }
  if (status === 'unknown' || (plan && !future)) {
    return { title: '计划日未记录', color: V2_T.text.tertiary, background: 'transparent', border: '1px dashed ' + V2_T.border.subtle }
  }
  if (future && plan) {
    return { title: '未来计划日', color: V2_T.text.tertiary, background: 'transparent', border: '1px dashed ' + V2_T.border.subtle }
  }
  if (plan) {
    return { title: '计划日', color: V2_T.text.tertiary, background: 'transparent', border: '1px dashed ' + V2_T.border.subtle }
  }
  return { title: '非计划日', color: V2_T.text.tertiary, background: 'transparent', border: '1px solid transparent' }
}

/* ── 样式胶囊 ── */

function habitToneColor(tone) {
  if (tone === 'success') return V2_T.status.success
  if (tone === 'warn') return V2_T.status.warn
  if (tone === 'danger') return V2_T.status.danger
  if (tone === 'accent') return V2_T.accent.base
  return V2_T.text.tertiary
}

function habitTint(color, percent) {
  return 'color-mix(in srgb, ' + color + ' ' + percent + '%, transparent)'
}

function habitChipStyle(tone, active) {
  const color = habitToneColor(tone)
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    padding: '0 6px',
    height: 18,
    borderRadius: V2_T.radius.pill,
    fontSize: V2_T.font.caption,
    lineHeight: '18px',
    whiteSpace: 'nowrap',
    color: active === false ? V2_T.text.secondary : color,
    background: active === false ? 'transparent' : habitTint(color, 12),
    border: '1px solid ' + (active === false ? 'transparent' : habitTint(color, 30)),
  }
}

function habitIconButtonStyle(extra) {
  return Object.assign(
    {
      width: 24,
      height: 24,
      minWidth: 24,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: 'none',
      borderRadius: V2_T.radius.sm,
      background: 'transparent',
      color: V2_T.text.secondary,
      cursor: 'pointer',
      padding: 0,
      flex: '0 0 auto',
    },
    extra || {},
  )
}

function habitInputStyle(extra) {
  return v2InputStyle(
    Object.assign(
      {
        height: 32,
        background: V2_T.surface.input,
        border: '1px solid ' + V2_T.border.subtle,
        borderRadius: V2_T.radius.sm,
        padding: '0 10px',
        color: V2_T.text.primary,
        fontSize: 13,
        boxSizing: 'border-box',
      },
      extra || {},
    ),
  )
}

function habitTextareaStyle() {
  return Object.assign(habitInputStyle(), {
    height: 'auto',
    fontSize: 13,
    lineHeight: '20px',
    padding: '8px 10px',
    resize: 'vertical',
    minHeight: 90,
    fontFamily: COLORS.fontFamily,
  })
}

function habitSegmentStyle(active) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 30,
    padding: '0 12px',
    borderRadius: V2_T.radius.pill,
    fontSize: V2_T.font.meta,
    cursor: 'pointer',
    border: '1px solid ' + (active ? V2_T.accent.line : V2_T.border.subtle),
    background: active ? V2_T.accent.soft : 'transparent',
    color: active ? V2_T.accent.base : V2_T.text.secondary,
    fontFamily: COLORS.fontFamily,
    whiteSpace: 'nowrap',
  }
}

function habitCardStyle(extra) {
  return v2CardStyle(extra)
}

function habitFieldStyle() {
  return { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }
}

function habitLabelStyle() {
  return { fontSize: V2_T.font.caption, color: V2_T.text.tertiary, fontWeight: 500, lineHeight: '16px', flex: '0 0 auto' }
}

/* ── 小部件 ── */

function HabitIconBadge(props) {
  const size = props.size || 30
  const habit = props.habit
  return h(
    'div',
    {
      style: {
        width: size,
        height: size,
        minWidth: size,
        borderRadius: size >= 40 ? V2_T.radius.lg : V2_T.radius.sm,
        background: props.active ? V2_T.accent.soft : V2_T.surface.panel2,
        border: '1px solid ' + (props.active ? V2_T.accent.line : V2_T.border.subtle),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size >= 40 ? 22 : 15,
        lineHeight: 1,
        flex: '0 0 auto',
      },
      'aria-hidden': 'true',
    },
    habitIconFor(habit),
  )
}

function HabitCheckButton(props) {
  const status = props.status || ''
  const done = status === 'done'
  const partial = status === 'partial'
  const disabled = props.disabled === true || props.busy === true
  const onClick = function onClick(event) {
    event.stopPropagation()
    if (disabled) return
    props.onToggle()
  }
  return h(
    'button',
    {
      type: 'button',
      title: props.title || '',
      'aria-label': props.title || '打卡',
      disabled: disabled,
      onClick: onClick,
      style: {
        width: 26,
        height: 26,
        minWidth: 26,
        borderRadius: '50%',
        border: done ? '1px solid ' + V2_T.status.success : partial ? '1px solid ' + V2_T.status.warn : '1px solid ' + V2_T.border.strong,
        background: done ? V2_T.status.successSoft : partial ? V2_T.status.warnSoft : 'transparent',
        color: done ? V2_T.status.success : partial ? V2_T.status.warn : V2_T.text.tertiary,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'default' : 'pointer',
        padding: 0,
        flex: '0 0 auto',
        opacity: disabled ? 0.45 : 1,
        fontFamily: COLORS.fontFamily,
      },
    },
    done
      ? h(V2Icon, { name: 'check', size: 14, color: V2_T.status.success, strokeWidth: 2.2 })
      : partial
        ? h('span', { style: { fontSize: 11, fontWeight: 600 } }, String(props.value || 1))
        : null,
  )
}

function HabitStepper(props) {
  const target = Math.max(1, Number(props.target) || 1)
  const value = Math.min(target, Number(props.value) || 0)
  const done = props.status === 'done'
  const busy = props.busy === true
  const disabled = props.disabled === true || busy
  const canMinus = !done && value > 0 && !disabled
  const canPlus = !done && !disabled
  const stop = function stop(event) {
    event.stopPropagation()
  }
  const stepStyle = habitIconButtonStyle({ width: 22, height: 22, minWidth: 22, borderRadius: 6 })
  function hoverStep(event) {
    if (event.currentTarget.disabled) return
    event.currentTarget.style.background = V2_T.surface.panel2
  }
  function leaveStep(event) {
    event.currentTarget.style.background = 'transparent'
  }
  return h(
    'div',
    { style: { display: 'inline-flex', alignItems: 'center', gap: 3, flex: '0 0 auto' }, onClick: stop },
    h(
      'button',
      {
        type: 'button',
        title: '减少一次',
        disabled: !canMinus,
        onClick: function onClick(event) {
          event.stopPropagation()
          if (canMinus) props.onStep(-1)
        },
        onMouseEnter: hoverStep,
        onMouseLeave: leaveStep,
        style: Object.assign({}, stepStyle, { opacity: canMinus ? 1 : 0.3 }),
      },
      h(V2Icon, { name: 'minus', size: 12 }),
    ),
    h(
      'button',
      {
        type: 'button',
        title: done ? '取消打卡' : value > 0 ? '再记一次' : '打卡',
        disabled: disabled,
        onClick: function onClick(event) {
          event.stopPropagation()
          if (disabled) return
          props.onToggle()
        },
        style: {
          minWidth: 48,
          height: 26,
          padding: '0 8px',
          borderRadius: V2_T.radius.sm,
          border: '1px solid ' + (done ? V2_T.status.success : value > 0 ? V2_T.status.warn : V2_T.border.strong),
          background: done ? V2_T.status.successSoft : value > 0 ? V2_T.status.warnSoft : 'transparent',
          color: done ? V2_T.status.success : V2_T.text.tertiary,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          fontSize: 11,
          fontWeight: 600,
          cursor: disabled ? 'default' : 'pointer',
          fontFamily: COLORS.fontFamily,
        },
      },
      done ? h(V2Icon, { name: 'check', size: 12, color: V2_T.status.success, strokeWidth: 2.2 }) : null,
      h('span', { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary } }, value + '/' + target),
    ),
    h(
      'button',
      {
        type: 'button',
        title: '增加一次',
        disabled: !canPlus,
        onClick: function onClick(event) {
          event.stopPropagation()
          if (canPlus) props.onStep(1)
        },
        onMouseEnter: hoverStep,
        onMouseLeave: leaveStep,
        style: Object.assign({}, stepStyle, { opacity: canPlus ? 1 : 0.3 }),
      },
      h(V2Icon, { name: 'plus', size: 12 }),
    ),
  )
}

function HabitStatCard(props) {
  return h(
    'div',
    { style: habitCardStyle({ padding: '10px 12px', minWidth: 0 }) },
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'baseline',
          gap: 3,
          color: props.tone || V2_T.text.primary,
          lineHeight: '24px',
          minWidth: 0,
        },
      },
      h(
        'span',
        {
          style: {
            fontSize: 20,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          },
        },
        String(props.value),
      ),
      props.unit ? h('span', { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary } }, props.unit) : null,
    ),
    h('div', { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary, marginTop: 2, whiteSpace: 'nowrap' } }, props.label),
    props.hint
      ? h(
          'div',
          { style: { fontSize: 10, color: V2_T.text.tertiary, opacity: 0.85, marginTop: 1, whiteSpace: 'nowrap' } },
          props.hint,
        )
      : null,
  )
}

function HabitWeekBar(props) {
  const dates = Array.isArray(props.dates) ? props.dates : []
  const [hover, setHover] = useState(null)
  const summaries = props.summaries || {}
  return h(
    'div',
    { style: { display: 'flex', gap: 6 } },
    dates.map(function renderDay(dateKey) {
      const summary = summaries[dateKey] || { planned: 0, doneUnits: 0 }
      const planned = Number(summary.planned) || 0
      const doneUnits = Number(summary.doneUnits) || 0
      const ratio = planned > 0 ? Math.min(1, doneUnits / planned) : 0
      const isToday = dateKey === props.today
      const selected = dateKey === props.selected
      const hovered = hover === dateKey
      const highlighted = isToday || selected
      const ringColor =
        planned > 0
          ? ratio >= 1
            ? V2_T.status.success
            : ratio > 0
              ? V2_T.status.warn
              : V2_T.border.subtle
          : V2_T.text.tertiary
      return h(
        'button',
        {
          key: dateKey,
          type: 'button',
          title: dateKey + ' · 计划 ' + planned + ' 项 · 完成 ' + doneUnits + ' 项',
          onClick: function onClick() {
            props.onSelect(dateKey)
          },
          onMouseEnter: function onEnter() {
            setHover(dateKey)
          },
          onMouseLeave: function onLeave() {
            setHover(null)
          },
          style: v2CardStyle({
            flex: '1 1 0',
            maxWidth: 96,
            minWidth: 0,
            minHeight: 64,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            padding: '6px 4px',
            textAlign: 'center',
            boxSizing: 'border-box',
            cursor: 'pointer',
            color: 'inherit',
            fontFamily: COLORS.fontFamily,
            border: '1px solid ' + (highlighted ? V2_T.accent.line : hovered ? V2_T.border.strong : V2_T.border.subtle),
            background: highlighted ? V2_T.accent.soft : hovered ? V2_T.surface.panel2 : V2_T.surface.panel,
          }),
        },
        h(
          'span',
          { style: { fontSize: V2_T.font.caption, lineHeight: '14px', color: isToday ? V2_T.accent.base : V2_T.text.tertiary } },
          HABIT_WEEKDAY_LABELS[habitWeekdayCodeOf(dateKey)] || '',
        ),
        h(
          'span',
          {
            style: {
              fontSize: 15,
              fontWeight: 600,
              lineHeight: '18px',
              color: isToday ? V2_T.accent.base : V2_T.text.primary,
            },
          },
          String(Number(String(dateKey).slice(8, 10))),
        ),
        h(
          'span',
          {
            style: {
              width: 18,
              height: 18,
              borderRadius: '50%',
              boxSizing: 'border-box',
              display: 'grid',
              placeItems: 'center',
              background:
                planned > 0
                  ? 'conic-gradient(' + ringColor + ' ' + Math.round(ratio * 100) + '%, ' + V2_T.border.subtle + ' 0)'
                  : 'transparent',
              border: planned > 0 ? 'none' : '1.5px solid ' + V2_T.border.subtle,
              opacity: planned > 0 ? 1 : 0.72,
            },
          },
          h('span', { style: { width: 12, height: 12, borderRadius: '50%', background: V2_T.surface.panel } }),
        ),
      )
    }),
  )
}

function HabitMenuItem(props) {
  const [hover, setHover] = useState(false)
  return h(
    'button',
    {
      type: 'button',
      onClick: function onClick() {
        props.onSelect()
      },
      onMouseEnter: function onEnter() {
        setHover(true)
      },
      onMouseLeave: function onLeave() {
        setHover(false)
      },
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        border: 'none',
        background: hover ? V2_T.surface.panel3 : 'transparent',
        color: props.danger ? V2_T.status.danger : V2_T.text.primary,
        fontFamily: COLORS.fontFamily,
        fontSize: V2_T.font.meta,
        padding: '7px 10px',
        borderRadius: V2_T.radius.sm,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
    },
    props.icon ? h(V2Icon, { name: props.icon, size: 13, color: props.danger ? V2_T.status.danger : V2_T.text.secondary }) : null,
    h('span', null, props.label || ''),
  )
}

function HabitMenuLayer(props) {
  const menu = props.menu
  if (!menu) return null
  const width = 184
  const itemCount = Array.isArray(menu.items) ? menu.items.length : 0
  const height = itemCount * 32 + 8
  const left = Math.max(8, Math.min(Number(menu.x) || 0, window.innerWidth - width - 12))
  const top = Math.max(8, Math.min(Number(menu.y) || 0, window.innerHeight - height - 12))
  return h(
    'div',
    {
      onMouseDown: function onBackdrop() {
        props.onClose()
      },
      style: { position: 'fixed', inset: 0, zIndex: 45 },
    },
    h(
      'div',
      {
        onMouseDown: function stop(event) {
          event.stopPropagation()
        },
        style: {
          position: 'absolute',
          left: left,
          top: top,
          width: width,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          background: V2_T.surface.panel2,
          border: '1px solid ' + V2_T.border.subtle,
          borderRadius: V2_T.radius.md,
          padding: 4,
          boxShadow: V2_T.shadow.raised,
        },
      },
      menu.items.map(function renderItem(item, index) {
        return h(HabitMenuItem, {
          key: index,
          label: item.label,
          icon: item.icon,
          danger: item.danger === true,
          onSelect: function onSelect() {
            props.onClose()
            try {
              item.onClick()
            } catch (error) {
              props.onError(error)
            }
          },
        })
      }),
    ),
  )
}

/* ── 弹窗骨架 ── */

function habitModalOverlay(children, ariaLabel, onClose, panelExtra) {
  return h(
    'div',
    {
      role: 'presentation',
      onMouseDown: function onBackdrop(event) {
        if (event.target === event.currentTarget) onClose()
      },
      style: {
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: V2_T.surface.overlay,
        padding: 20,
      },
    },
    h(
      'div',
      {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': ariaLabel,
        style: Object.assign(
          {
            width: 'min(520px, calc(100vw - 40px))',
            maxHeight: 'calc(100vh - 80px)',
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
            background: V2_T.surface.panel,
            border: '1px solid ' + V2_T.border.subtle,
            borderRadius: V2_T.radius.xl,
            boxShadow: V2_T.shadow.pop,
            boxSizing: 'border-box',
            padding: 16,
          },
          panelExtra || {},
        ),
      },
      children,
    ),
  )
}

function habitModalHeader(title, onClose) {
  return h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '2px 0 12px',
        borderBottom: '1px solid ' + V2_T.border.subtle,
        flex: '0 0 auto',
      },
    },
    h('div', { style: { flex: '1 1 auto', fontSize: V2_T.font.title, fontWeight: 600, color: V2_T.text.primary, lineHeight: '20px' } }, title),
    h(
      'button',
      {
        type: 'button',
        title: '关闭',
        'aria-label': '关闭',
        onClick: onClose,
        style: habitIconButtonStyle({ width: 28, height: 28, minWidth: 28 }),
      },
      h(V2Icon, { name: 'close', size: 14 }),
    ),
  )
}

function habitModalFooter(children) {
  return h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 0 0',
        borderTop: '1px solid ' + V2_T.border.subtle,
        flex: '0 0 auto',
      },
    },
    children,
  )
}

/* ── 编辑习惯弹窗 ── */

function HabitEditorModal(props) {
  const form = props.form || {}
  const saving = props.saving === true
  const mode = props.mode === 'edit' ? 'edit' : 'create'
  const kind = form.frequencyKind || 'daily'
  const error = props.error || ''
  const focusRing = v2FocusRing()
  function focusField(event) {
    event.currentTarget.style.boxShadow = focusRing.boxShadow
    event.currentTarget.style.borderColor = V2_T.accent.line
  }
  function blurField(event) {
    event.currentTarget.style.boxShadow = 'none'
    event.currentTarget.style.borderColor = V2_T.border.subtle
  }

  function field(label, node, hint) {
    return h(
      'div',
      { style: habitFieldStyle() },
      h('div', { style: habitLabelStyle() }, label),
      node,
      hint
        ? h('div', { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary, lineHeight: '16px' } }, hint)
        : null,
    )
  }

  const weekdayChips = h(
    'div',
    { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
    HABIT_WEEKDAY_CODES.map(function renderChip(code) {
      const active = (form.weekDays || []).indexOf(code) >= 0
      return h(
        'button',
        {
          key: code,
          type: 'button',
          onClick: function onClick() {
            const source = form.weekDays || []
            const next = active
              ? source.filter(function keep(item) {
                  return item !== code
                })
              : source.concat([code])
            props.onChange({ weekDays: next })
          },
          style: Object.assign(habitSegmentStyle(active), { width: 32, padding: 0, fontSize: 12 }),
        },
        HABIT_WEEKDAY_LABELS[code],
      )
    }),
  )

  const frequencyKinds = h(
    'div',
    { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
    HABIT_FREQUENCY_KINDS.map(function renderKind(item) {
      const active = kind === item.id
      return h(
        'button',
        {
          key: item.id,
          type: 'button',
          onClick: function onClick() {
            props.onChange({ frequencyKind: item.id })
          },
          style: habitSegmentStyle(active),
        },
        item.label,
      )
    }),
  )

  let frequencyDetail = null
  if (kind === 'daily') {
    frequencyDetail = field(
      '间隔：每 N 天一次',
      h('input', {
        type: 'number',
        min: 1,
        max: 365,
        value: form.dailyInterval === undefined ? 1 : form.dailyInterval,
        onChange: function onChange(event) {
          props.onChange({ dailyInterval: event.target.value })
        },
        onFocus: focusField,
        onBlur: blurField,
        style: habitInputStyle(),
      }),
      '填 1 就是每天；填 2 表示隔天一次',
    )
  } else if (kind === 'weekly_days') {
    frequencyDetail = field('选择星期（不选=每天）', weekdayChips)
  } else if (kind === 'weekly_count') {
    frequencyDetail = field(
      '每周目标次数',
      h('input', {
        type: 'number',
        min: 1,
        max: 7,
        value: form.weeklyCount === undefined ? 3 : form.weeklyCount,
        onChange: function onChange(event) {
          props.onChange({ weeklyCount: event.target.value })
        },
        onFocus: focusField,
        onBlur: blurField,
        style: habitInputStyle({ width: 96 }),
      }),
      '按周统计完成率与连续周，不要求固定星期',
    )
  } else {
    frequencyDetail = field(
      '间隔天数',
      h('input', {
        type: 'number',
        min: 1,
        max: 365,
        value: form.intervalDays === undefined ? 2 : form.intervalDays,
        onChange: function onChange(event) {
          props.onChange({ intervalDays: event.target.value })
        },
        onFocus: focusField,
        onBlur: blurField,
        style: habitInputStyle({ width: 96 }),
      }),
      '从开始日期起每 N 天安排一次',
    )
  }

  return habitModalOverlay(
    [
      habitModalHeader(mode === 'create' ? '新建习惯' : '编辑习惯', props.onClose),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 0 0' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
          h(HabitIconBadge, { habit: { id: form.name, name: form.name }, size: 44 }),
          h(
            'div',
            { style: { flex: '1 1 auto', minWidth: 0 } },
            field(
              '名称',
              h('input', {
                autoFocus: true,
                value: form.name || '',
                placeholder: '例如：晨跑 30 分钟',
                onChange: function onChange(event) {
                  props.onChange({ name: event.target.value })
                },
                onFocus: focusField,
                onBlur: blurField,
                style: habitInputStyle(),
              }),
            ),
          ),
        ),
        field(
          '描述（可选）',
          h('textarea', {
            value: form.description || '',
            rows: 2,
            placeholder: '为什么想坚持这个习惯？',
            onChange: function onChange(event) {
              props.onChange({ description: event.target.value })
            },
            onFocus: focusField,
            onBlur: blurField,
            style: habitTextareaStyle(),
          }),
        ),
        field('频率', frequencyKinds),
        frequencyDetail,
        field(
          '量化目标（可选）',
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('input', {
              type: 'number',
              min: 1,
              max: 366,
              value: form.targetValue === undefined ? 1 : form.targetValue,
              onChange: function onChange(event) {
                props.onChange({ targetValue: event.target.value })
              },
              onFocus: focusField,
              onBlur: blurField,
              style: habitInputStyle({ width: 96 }),
            }),
            h('input', {
              value: form.targetUnit || '',
              placeholder: '次',
              onChange: function onChange(event) {
                props.onChange({ targetUnit: event.target.value })
              },
              onFocus: focusField,
              onBlur: blurField,
              style: habitInputStyle({ width: 90 }),
            }),
          ),
          '大于 1 时打卡按次数累计（例如每天 8 杯水）',
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 10, alignItems: 'flex-start' } },
          h(
            'div',
            { style: { flex: '1 1 0', minWidth: 0 } },
            field(
              '开始日期',
              h('input', {
                type: 'date',
                value: form.startDate || '',
                onChange: function onChange(event) {
                  props.onChange({ startDate: event.target.value })
                },
                onFocus: focusField,
                onBlur: blurField,
                style: habitInputStyle(),
              }),
            ),
          ),
          h(
            'div',
            { style: { flex: '1 1 0', minWidth: 0 } },
            field(
              '提醒时间（可选）',
              h('input', {
                type: 'time',
                value: form.timeHint || '',
                onChange: function onChange(event) {
                  props.onChange({ timeHint: event.target.value })
                },
                onFocus: focusField,
                onBlur: blurField,
                style: habitInputStyle(),
              }),
            ),
          ),
        ),
        h(
          'div',
          {
            style: {
              fontSize: V2_T.font.caption,
              lineHeight: '17px',
              color: V2_T.text.tertiary,
              background: V2_T.surface.input,
              border: '1px solid ' + V2_T.border.subtle,
              borderRadius: V2_T.radius.sm,
              padding: '8px 10px',
            },
          },
          '修改频率只影响之后的计划，不会删除历史打卡记录。',
        ),
        error
          ? h('div', { style: { fontSize: V2_T.font.meta, color: V2_T.status.danger, lineHeight: '18px' } }, error)
          : null,
      ),
      habitModalFooter([
        h('div', { key: 'spacer', style: { flex: '1 1 auto' } }),
        h(
          'button',
          {
            key: 'cancel',
            type: 'button',
            disabled: saving,
            onClick: props.onClose,
            style: v2BtnStyle('ghost', { height: 30, padding: '0 14px', borderRadius: V2_T.radius.sm, fontSize: 12 }),
          },
          '取消',
        ),
        h(
          'button',
          {
            key: 'save',
            type: 'button',
            disabled: saving,
            onClick: props.onSave,
            style: v2BtnStyle('primary', { height: 30, padding: '0 14px', borderRadius: V2_T.radius.sm, fontSize: 12 }),
          },
          saving ? '保存中…' : '保存',
        ),
      ]),
    ],
    mode === 'create' ? '新建习惯' : '编辑习惯',
    props.onClose,
    { width: 'min(420px, calc(100vw - 40px))' },
  )
}

/* ── 打卡日志弹窗（日志 = checkin.note，独立于打卡状态） ── */

function HabitLogModal(props) {
  const log = props.log || {}
  const saving = log.saving === true
  const error = log.error || ''
  const note = String(log.note || '')
  const focusRing = v2FocusRing()
  function focusField(event) {
    event.currentTarget.style.boxShadow = focusRing.boxShadow
    event.currentTarget.style.borderColor = V2_T.accent.line
  }
  function blurField(event) {
    event.currentTarget.style.boxShadow = 'none'
    event.currentTarget.style.borderColor = V2_T.border.subtle
  }
  return habitModalOverlay(
    [
      habitModalHeader('打卡日志', props.onClose),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 0 0' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('div', { style: { fontSize: 13, fontWeight: 600, color: V2_T.text.primary } }, habitFormatDate(log.date)),
          log.status ? h('span', { style: habitChipStyle(habitStatusTone(log.status)) }, habitStatusLabel(log.status)) : null,
          h('div', { style: { flex: '1 1 auto' } }),
          h(
            'span',
            { style: { fontSize: V2_T.font.caption, color: log.hasCheckin ? V2_T.text.tertiary : V2_T.status.danger } },
            log.hasCheckin ? '保存日志不会改变打卡状态' : '该日期还没有打卡记录',
          ),
        ),
        h('textarea', {
          autoFocus: true,
          value: note,
          maxLength: HABIT_NOTE_MAX,
          placeholder: '记录今天的感受、数据或备注…',
          onChange: function onChange(event) {
            props.onChange({ note: event.target.value })
          },
          onFocus: focusField,
          onBlur: blurField,
          style: habitTextareaStyle(),
        }),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary } }, String(note.length) + ' / ' + HABIT_NOTE_MAX),
          log.hasCheckin
            ? null
            : h('span', { style: { fontSize: V2_T.font.caption, color: V2_T.status.danger } }, '请先在该日期打卡'),
        ),
        error ? h('div', { style: { fontSize: V2_T.font.meta, color: V2_T.status.danger, lineHeight: '18px' } }, error) : null,
      ),
      habitModalFooter([
        log.existingNote
          ? h(
              'button',
              {
                key: 'delete',
                type: 'button',
                disabled: saving,
                onClick: props.onDelete,
                style: v2BtnStyle('danger', { height: 30, padding: '0 14px', borderRadius: V2_T.radius.sm, fontSize: 12 }),
              },
              '删除日志',
            )
          : null,
        h('div', { key: 'spacer', style: { flex: '1 1 auto' } }),
        h(
          'button',
          {
            key: 'cancel',
            type: 'button',
            disabled: saving,
            onClick: props.onClose,
            style: v2BtnStyle('ghost', { height: 30, padding: '0 14px', borderRadius: V2_T.radius.sm, fontSize: 12 }),
          },
          '取消',
        ),
        h(
          'button',
          {
            key: 'save',
            type: 'button',
            disabled: saving,
            onClick: props.onSave,
            style: v2BtnStyle('primary', { height: 30, padding: '0 14px', borderRadius: V2_T.radius.sm, fontSize: 12 }),
          },
          saving ? '保存中…' : '保存',
        ),
      ]),
    ],
    '打卡日志',
    props.onClose,
  )
}

/* ── 二次确认弹窗 ── */

function HabitConfirmModal(props) {
  const dialog = props.dialog || {}
  return habitModalOverlay(
    [
      habitModalHeader(dialog.title || '确认操作', props.onClose),
      h(
        'div',
        { style: { padding: '14px 0', fontSize: 13, lineHeight: '20px', color: V2_T.text.secondary } },
        dialog.body || '',
      ),
      habitModalFooter([
        h('div', { key: 'spacer', style: { flex: '1 1 auto' } }),
        h(
          'button',
          {
            key: 'cancel',
            type: 'button',
            onClick: props.onClose,
            style: v2BtnStyle('ghost', { height: 30, padding: '0 14px', borderRadius: V2_T.radius.sm, fontSize: 12 }),
          },
          '取消',
        ),
        h(
          'button',
          {
            key: 'ok',
            type: 'button',
            onClick: props.onConfirm,
            style: Object.assign(
              v2BtnStyle('primary', {
                height: 30,
                padding: '0 14px',
                borderRadius: V2_T.radius.sm,
                fontSize: 12,
                background: dialog.danger ? V2_T.status.dangerSoft : V2_T.accent.base,
                borderColor: dialog.danger ? V2_T.status.danger : V2_T.accent.base,
              }),
              dialog.danger ? { color: V2_T.status.danger } : {},
            ),
          },
          dialog.confirmLabel || '确认',
        ),
      ]),
    ],
    dialog.title || '确认操作',
    props.onClose,
  )
}

/* ── 列表行 ── */

function HabitRowV2(props) {
  const [hover, setHover] = useState(false)
  const habit = props.habit
  if (!habit) return null
  const checkin = props.checkin || null
  const statsItem = props.statsItem || null
  const status = checkin ? checkin.status : ''
  const quantified = habitIsQuantified(habit)
  const target = habitTargetValue(habit)
  const value = habitCheckinValue(checkin)
  const metaParts = [habitFrequencyText(habit)]
  const streakText = habitStreakText(statsItem)
  const streakValue = statsItem && statsItem.streak ? Number(statsItem.streak.value) || 0 : 0
  if (statsItem && statsItem.period && Number(statsItem.period.target) > 0) {
    metaParts.push('本周 ' + (Number(statsItem.period.achieved) || 0) + '/' + Number(statsItem.period.target))
  }
  if (quantified) metaParts.push('目标 ' + target + ' ' + habitTargetUnit(habit))
  const disabled = props.disabled === true
  const busy = props.busy === true
  const title = props.paused ? '习惯已暂停' : disabled ? props.disabledHint || '当前日期不可打卡' : status === 'done' ? '取消打卡' : '打卡'
  return h(
    'div',
    {
      role: 'button',
      tabIndex: 0,
      onClick: function onClick() {
        props.onSelect()
      },
      onKeyDown: function onKeyDown(event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onSelect()
        }
      },
      onMouseEnter: function onEnter() {
        setHover(true)
      },
      onMouseLeave: function onLeave() {
        setHover(false)
      },
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        height: 52,
        padding: '0 12px',
        boxSizing: 'border-box',
        borderRadius: V2_T.radius.md,
        cursor: 'pointer',
        background: props.selected ? V2_T.accent.soft : hover ? V2_T.surface.panel2 : 'transparent',
        boxShadow: props.selected ? 'inset 2px 0 0 ' + V2_T.accent.base : 'none',
      },
    },
    h(HabitIconBadge, { habit: habit, size: 30, active: props.selected === true }),
    h(
      'div',
      { style: { flex: '1 1 auto', minWidth: 0 } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 } },
        h(
          'span',
          {
            style: {
              fontSize: 13.5,
              fontWeight: 600,
              color: V2_T.text.primary,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              lineHeight: '18px',
            },
          },
          habit.name,
        ),
        props.paused ? h('span', { style: habitChipStyle('faint', false) }, '已暂停') : null,
        status === 'skipped' ? h('span', { style: habitChipStyle('faint') }, '跳过') : null,
        status === 'not_done' ? h('span', { style: habitChipStyle('danger') }, '未完成') : null,
      ),
      h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 2,
            minHeight: 16,
            minWidth: 0,
          },
        },
        h(
          'span',
          {
            style: {
              fontSize: V2_T.font.caption,
              color: V2_T.text.tertiary,
              lineHeight: '15px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
            },
          },
          metaParts.join(' · '),
        ),
        streakText
          ? h(
              'span',
              { style: Object.assign(habitChipStyle(streakValue > 0 ? 'success' : 'faint'), { flex: '0 0 auto' }) },
              streakText,
            )
          : null,
      ),
    ),
    h(
      'button',
      {
        type: 'button',
        title: '更多操作',
        onClick: function onClick(event) {
          event.stopPropagation()
          props.onMenu(event)
        },
        style: habitIconButtonStyle({ width: 22, height: 22, minWidth: 22, opacity: hover || props.selected ? 1 : 0.45 }),
      },
      h(V2Icon, { name: 'more', size: 13 }),
    ),
    quantified
      ? h(HabitStepper, {
          target: target,
          value: value,
          status: status,
          disabled: disabled,
          busy: busy,
          onToggle: props.onToggle,
          onStep: props.onStep,
        })
      : h(HabitCheckButton, {
          status: status,
          value: value,
          disabled: disabled,
          busy: busy,
          title: title,
          onToggle: props.onToggle,
        }),
  )
}

/* ── 月历 ── */

function HabitMonthGrid(props) {
  const dates = Array.isArray(props.dates) && props.dates.length ? props.dates : habitMonthDates(props.monthKey)
  if (!dates.length) return null
  const weekStart = props.weekStart === 'sunday' ? 'sunday' : 'monday'
  const offsetRaw = habitWeekdayIndex(dates[0])
  const offset = weekStart === 'sunday' ? (offsetRaw + 1) % 7 : offsetRaw
  const labels = weekStart === 'sunday' ? ['日', '一', '二', '三', '四', '五', '六'] : ['一', '二', '三', '四', '五', '六', '日']
  const cellMap = {}
  const serverCells = Array.isArray(props.cells) ? props.cells : []
  serverCells.forEach(function each(cell) {
    if (cell && cell.date) cellMap[cell.date] = cell
  })
  const checkinMap = habitCheckinMap(props.checkins)
  const habit = props.habit || null
  const today = props.today
  const blanks = []
  for (let index = 0; index < offset; index += 1) blanks.push(h('span', { key: 'blank-' + index }))
  const cells = dates.map(function renderCell(dateKey) {
    const serverCell = cellMap[dateKey]
    const record = checkinMap[dateKey]
    let status = serverCell ? serverCell.status : null
    if (!status && record) status = record.status
    const plan = habit ? habitPlanDay(habit, dateKey) : false
    const paused = habit ? habitPausedOn(habit, dateKey) : false
    const future = dateKey > today
    const meta = habitMonthCellMeta(status, paused, future, plan)
    const isToday = dateKey === today
    const selected = dateKey === props.selectedDate
    return h(
      'button',
      {
        key: dateKey,
        type: 'button',
        title: dateKey + ' · ' + meta.title,
        onClick: function onClick() {
          props.onSelectDate(dateKey)
        },
        style: {
          height: 24,
          minWidth: 0,
          padding: 0,
          borderRadius: 6,
          border: meta.border,
          background: selected ? V2_T.accent.soft : meta.background,
          color: meta.color,
          fontSize: V2_T.font.caption,
          fontWeight: isToday ? 600 : 400,
          opacity: future ? 0.55 : 1,
          cursor: 'pointer',
          fontFamily: COLORS.fontFamily,
          boxShadow: isToday ? 'inset 0 0 0 1px ' + V2_T.accent.base : 'none',
        },
      },
      String(Number(String(dateKey).slice(8, 10))),
    )
  })
  return h(
    'div',
    null,
    h(
      'div',
      { style: { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4, marginBottom: 4 } },
      labels.map(function renderLabel(label, index) {
        return h(
          'span',
          { key: index, style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary, textAlign: 'center', lineHeight: '16px' } },
          label,
        )
      }),
    ),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 } }, blanks.concat(cells)),
  )
}

/* ── 习惯 Tab 主体 ── */

function HabitTabV2(props) {
  const runtime = props.runtime
  const narrow = props.narrow === true
  const [listWidth, setListWidth] = useState(function initialListWidth() {
    try {
      const raw = window.localStorage.getItem(HABIT_PANES_STORAGE_KEY)
      const value = raw ? JSON.parse(raw) : null
      return habitClampListWidth(value && value.listWidth)
    } catch (error) {
      return HABIT_LIST_WIDTH
    }
  })
  const listWidthRef = useRef(listWidth)
  listWidthRef.current = listWidth
  const listDragRef = useRef(null)

  useEffect(
    function persistListWidth() {
      try {
        window.localStorage.setItem(HABIT_PANES_STORAGE_KEY, JSON.stringify({ listWidth: listWidth }))
      } catch (error) {
        /* ignore */
      }
    },
    [listWidth],
  )

  function startListResize(event) {
    if (event.button !== 0) return
    event.preventDefault()
    listDragRef.current = { startX: event.clientX, startWidth: listWidthRef.current }
    function onMove(moveEvent) {
      const drag = listDragRef.current
      if (!drag) return
      setListWidth(habitClampListWidth(drag.startWidth + (moveEvent.clientX - drag.startX)))
    }
    function onUp() {
      listDragRef.current = null
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }

  const [state, setState] = useState(function initial() {
    const today = habitToday()
    return {
      loading: true,
      error: null,
      today: today,
      date: today,
      monthKey: habitMonthKeyOf(today),
      habits: [],
      stats: {},
      checkins: {},
      months: {},
      selectedId: null,
      collapsed: { plan: false, flex: false, paused: true },
      busyKey: null,
      menu: null,
      confirmDialog: null,
      editor: null,
      logEditor: null,
    }
  })
  const stateRef = useRef(state)
  stateRef.current = state
  const pendingRef = useRef({})

  function update(patch) {
    setState(function merge(prev) {
      return Object.assign({}, prev, patch)
    })
  }

  function toast(kind, text, action) {
    try {
      if (runtime && typeof runtime.toast === 'function') runtime.toast(kind, text, action)
    } catch (error) {
      /* ignore */
    }
  }

  function findHabit(habitId) {
    const list = stateRef.current.habits
    for (let index = 0; index < list.length; index += 1) {
      if (list[index] && list[index].id === habitId) return list[index]
    }
    return null
  }

  /* ── 数据加载 ── */

  async function loadAll(options) {
    const silent = options && options.silent === true
    if (!silent) update({ loading: true, error: null })
    try {
      const listPayload = await apiRequest('/habits')
      const habits = listPayload && Array.isArray(listPayload.items) ? listPayload.items : []
      const today = (listPayload && listPayload.today) || habitToday()
      const statsMap = (await habitFetchStatsMap()) || stateRef.current.stats || {}
      const checkins = {}
      const visible = habits.filter(function keep(habit) {
        return habit && habit.status !== 'archived'
      })
      await Promise.all(
        visible.map(function fetchOne(habit) {
          return habitFetchCheckins(habit.id).then(function apply(items) {
            checkins[habit.id] = items || []
          })
        }),
      )
      let selectedId = stateRef.current.selectedId
      if (selectedId && !visible.some(function has(item) { return item.id === selectedId })) selectedId = null
      if (!selectedId && !narrow && visible.length > 0) selectedId = visible[0].id
      let date = stateRef.current.date || today
      if (date > today) date = today
      const monthKey = habitMonthKeyOf(date)
      const months = Object.assign({}, stateRef.current.months)
      if (!months[monthKey]) {
        const payload = await habitFetchMonth(monthKey)
        if (payload) months[monthKey] = payload
      }
      update({
        loading: false,
        error: null,
        today: today,
        date: date,
        monthKey: stateRef.current.monthKey || monthKey,
        habits: habits,
        stats: statsMap,
        checkins: checkins,
        months: months,
        selectedId: selectedId,
      })
    } catch (error) {
      update({ loading: false, error: errorText(error) })
    }
  }

  async function refreshAfterMutation(habitId, monthKeys) {
    try {
      const listPayload = await apiRequest('/habits')
      const habits = listPayload && Array.isArray(listPayload.items) ? listPayload.items : stateRef.current.habits
      const today = (listPayload && listPayload.today) || stateRef.current.today
      const statsMap = (await habitFetchStatsMap()) || stateRef.current.stats
      const checkins = Object.assign({}, stateRef.current.checkins)
      if (habitId) {
        const items = await habitFetchCheckins(habitId)
        if (items) checkins[habitId] = items
      }
      const months = Object.assign({}, stateRef.current.months)
      const dropKeys = Array.isArray(monthKeys) ? monthKeys : []
      dropKeys.forEach(function drop(key) {
        if (months[key]) delete months[key]
      })
      const needed = stateRef.current.monthKey
      if (needed && !months[needed]) {
        const payload = await habitFetchMonth(needed)
        if (payload) months[needed] = payload
      }
      update({ today: today, habits: habits, stats: statsMap, checkins: checkins, months: months })
    } catch (error) {
      toast('error', '刷新失败：' + habitErrorHint(error))
    }
  }

  useEffect(function onMount() {
    loadAll({ silent: false })
  }, [])

  useEffect(
    function ensureMonth() {
      const monthKey = state.monthKey
      if (!monthKey || state.months[monthKey]) return undefined
      let cancelled = false
      habitFetchMonth(monthKey)
        .then(function apply(payload) {
          if (cancelled || !payload) return
          const months = Object.assign({}, stateRef.current.months)
          months[monthKey] = payload
          update({ months: months })
        })
        .catch(function ignore() {
          /* ignore */
        })
      return function cleanup() {
        cancelled = true
      }
    },
    [state.monthKey, state.months],
  )

  useEffect(function bindEscape() {
    function onKeyDown(event) {
      if (event.key !== 'Escape') return
      const snapshot = stateRef.current
      if (snapshot.menu) {
        update({ menu: null })
        return
      }
      if (snapshot.confirmDialog) {
        update({ confirmDialog: null })
        return
      }
      if (snapshot.logEditor) {
        update({ logEditor: null })
        return
      }
      if (snapshot.editor) update({ editor: null })
    }
    window.addEventListener('keydown', onKeyDown)
    return function cleanup() {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  /* ── 通用派生 ── */

  function visibleHabits() {
    return state.habits.filter(function keep(habit) {
      return habit && habit.status !== 'archived'
    })
  }

  function currentHabit() {
    if (!state.selectedId) return null
    const visible = visibleHabits()
    for (let index = 0; index < visible.length; index += 1) {
      if (visible[index].id === state.selectedId) return visible[index]
    }
    return null
  }

  function dateWindowHint(dateKey) {
    const today = stateRef.current.today
    if (!dateKey) return '请选择日期'
    if (dateKey > today) return '不能为未来日期打卡'
    if (dateKey < habitAddDays(today, -HABIT_RETRO_WINDOW_DAYS)) return '超过 7 天的记录只能查看'
    return ''
  }

  function dateCheckable(dateKey) {
    return dateWindowHint(dateKey) === ''
  }

  function selectDate(dateKey) {
    if (!dateKey) return
    update({ date: dateKey, monthKey: habitMonthKeyOf(dateKey) })
  }

  function selectHabit(habitId) {
    update({ selectedId: habitId })
  }

  /* ── 打卡写入 ── */

  async function runWithBusy(key, action) {
    if (pendingRef.current[key]) return
    pendingRef.current[key] = true
    update({ busyKey: key })
    try {
      await action()
    } catch (error) {
      toast('error', '操作失败：' + habitErrorHint(error))
    } finally {
      pendingRef.current[key] = false
      update({ busyKey: null })
    }
  }

  async function submitCheckin(habit, dateKey, body) {
    const payload = Object.assign({ localDate: dateKey }, body)
    if (dateKey < stateRef.current.today) payload.retro = true
    await habitApiSend('POST', '/habits/' + encodeURIComponent(habit.id) + '/checkin', payload)
  }

  function handleToggle(habit, dateKey) {
    if (!habit || !dateKey) return
    if (habit.status === 'paused') {
      toast('error', '习惯已暂停，恢复后才能打卡')
      return
    }
    const windowHint = dateWindowHint(dateKey)
    if (windowHint) {
      toast('error', windowHint)
      return
    }
    const key = 'check|' + habit.id + '|' + dateKey
    runWithBusy(key, async function toggle() {
      const checkins = stateRef.current.checkins[habit.id] || []
      const existing = habitCheckinByDate(checkins, dateKey)
      const target = habitTargetValue(habit)
      if (existing && existing.status === 'done') {
        await habitApiSend('DELETE', '/habits/' + encodeURIComponent(habit.id) + '/checkins/' + encodeURIComponent(dateKey))
        await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
        const snapshot = {
          status: existing.status,
          value: habitCheckinValue(existing),
          note: existing.note || null,
        }
        toast('success', '已取消打卡', {
          label: '撤销',
          onClick: function undoUncheck() {
            restoreCheckin(habit.id, dateKey, snapshot)
          },
        })
        return
      }
      if (existing && existing.status === 'partial') {
        const current = habitCheckinValue(existing)
        const nextValue = current + 1
        const nextStatus = nextValue >= target ? 'done' : 'partial'
        await submitCheckin(habit, dateKey, { status: nextStatus, value: Math.min(nextValue, Math.max(target, 1)) })
        await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
        toast('success', nextStatus === 'done' ? '已达标：' + nextValue + ' / ' + target : '已记录 ' + nextValue + ' / ' + target)
        return
      }
      if (target > 1) {
        const status = 1 >= target ? 'done' : 'partial'
        await submitCheckin(habit, dateKey, { status: status, value: 1 })
        await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
        toast('success', status === 'done' ? '已打卡' : '已记录 1 / ' + target + ' ' + habitTargetUnit(habit))
        return
      }
      await submitCheckin(habit, dateKey, { status: 'done' })
      await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
      toast('success', '已打卡：' + habit.name)
    })
  }

  function handleStep(habit, dateKey, delta) {
    if (!habit || !dateKey) return
    if (habit.status === 'paused') {
      toast('error', '习惯已暂停，恢复后才能打卡')
      return
    }
    const windowHint = dateWindowHint(dateKey)
    if (windowHint) {
      toast('error', windowHint)
      return
    }
    const key = 'check|' + habit.id + '|' + dateKey
    runWithBusy(key, async function step() {
      const checkins = stateRef.current.checkins[habit.id] || []
      const existing = habitCheckinByDate(checkins, dateKey)
      const target = Math.max(1, habitTargetValue(habit))
      if (!existing) {
        if (delta < 0) return
        await submitCheckin(habit, dateKey, { status: 1 >= target ? 'done' : 'partial', value: 1 })
        await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
        toast('success', '已记录 1 / ' + target)
        return
      }
      const current = habitCheckinValue(existing)
      const nextValue = current + delta
      if (nextValue <= 0) {
        await habitApiSend('DELETE', '/habits/' + encodeURIComponent(habit.id) + '/checkins/' + encodeURIComponent(dateKey))
        await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
        toast('success', '已清空当日记录')
        return
      }
      const nextStatus = nextValue >= target ? 'done' : 'partial'
      await submitCheckin(habit, dateKey, { status: nextStatus, value: Math.min(nextValue, target) })
      await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
      toast('success', nextStatus === 'done' ? '已达标：' + target + ' / ' + target : '已记录 ' + nextValue + ' / ' + target)
    })
  }

  function restoreCheckin(habitId, dateKey, snapshot) {
    const habit = findHabit(habitId)
    if (!habit) return
    const payload = { localDate: dateKey, status: snapshot.status || 'done' }
    if (snapshot.value > 0) payload.value = snapshot.value
    if (snapshot.note) payload.note = snapshot.note
    if (dateKey < stateRef.current.today) payload.retro = true
    runWithBusy('undo|' + habitId + '|' + dateKey, async function restore() {
      await habitApiSend('POST', '/habits/' + encodeURIComponent(habitId) + '/checkin', payload)
      await refreshAfterMutation(habitId, [habitMonthKeyOf(dateKey)])
      toast('success', '已恢复打卡')
    })
  }

  function handleClearRecord(habit, dateKey) {
    const hint = dateWindowHint(dateKey)
    if (hint) {
      toast('error', hint)
      return
    }
    const checkins = stateRef.current.checkins[habit.id] || []
    const existing = habitCheckinByDate(checkins, dateKey)
    if (!existing) {
      toast('error', '该日期没有打卡记录')
      return
    }
    runWithBusy('clear|' + habit.id + '|' + dateKey, async function clearRecord() {
      await habitApiSend('DELETE', '/habits/' + encodeURIComponent(habit.id) + '/checkins/' + encodeURIComponent(dateKey))
      await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
      toast('success', '已清除当日记录', {
        label: '撤销',
        onClick: function undoClear() {
          restoreCheckin(habit.id, dateKey, {
            status: existing.status,
            value: habitCheckinValue(existing),
            note: existing.note || null,
          })
        },
      })
    })
  }

  function handleMarkStatus(habit, dateKey, status) {
    const hint = dateWindowHint(dateKey)
    if (hint) {
      toast('error', hint)
      return
    }
    if (habit.status === 'paused') {
      toast('error', '习惯已暂停，恢复后才能操作')
      return
    }
    const label = status === 'skipped' ? '已跳过本次' : '已标记未完成'
    runWithBusy('mark|' + habit.id + '|' + dateKey, async function mark() {
      await submitCheckin(habit, dateKey, { status: status })
      await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
      toast('success', label)
    })
  }

  /* ── 习惯属性写入 ── */

  function handleTogglePause(habit) {
    if (!habit) return
    const nextStatus = habit.status === 'paused' ? 'active' : 'paused'
    const label = nextStatus === 'paused' ? '已暂停：' : '已恢复：'
    runWithBusy('pause|' + habit.id, async function togglePause() {
      await habitApiSend('PATCH', '/habits/' + encodeURIComponent(habit.id), {
        patch: { status: nextStatus },
        expectedRev: habit.rev,
      })
      await loadAll({ silent: true })
      toast('success', label + habit.name)
    })
  }

  function askArchive(habit) {
    if (!habit) return
    update({
      confirmDialog: {
        title: '归档习惯',
        body: '「' + habit.name + '」归档后将不再出现在习惯列表，历史打卡记录会保留。',
        confirmLabel: '归档',
        danger: true,
        onConfirm: function onConfirm() {
          return archiveHabit(habit)
        },
      },
    })
  }

  async function archiveHabit(habit) {
    await habitApiSend('POST', '/habits/' + encodeURIComponent(habit.id) + '/archive', { expectedRev: habit.rev })
    update({ selectedId: null })
    await loadAll({ silent: true })
    toast('success', '已归档：' + habit.name)
  }

  function handleConfirm() {
    const dialog = stateRef.current.confirmDialog
    if (!dialog) return
    update({ confirmDialog: null })
    if (typeof dialog.onConfirm !== 'function') return
    Promise.resolve()
      .then(dialog.onConfirm)
      .catch(function onError(error) {
        toast('error', '操作失败：' + habitErrorHint(error))
      })
  }

  /* ── 编辑弹窗 ── */

  function createFormDefaults() {
    return {
      name: '',
      description: '',
      frequencyKind: 'daily',
      dailyInterval: 1,
      weekDays: ['MO', 'TU', 'WE', 'TH', 'FR'],
      weeklyCount: 3,
      intervalDays: 2,
      targetValue: 1,
      targetUnit: '次',
      startDate: stateRef.current.today,
      timeHint: '',
    }
  }

  function formFromHabit(habit) {
    const rule = habitFrequencyRule(habit) || {}
    const kind = rule.kind || 'daily'
    const target = habitTargetValue(habit)
    return {
      name: habit.name || '',
      description: habit.description || '',
      frequencyKind: kind,
      dailyInterval: habitClampInt(rule.interval, 1, 365, 1),
      weekDays: habitSortWeekdays(rule.days).length ? habitSortWeekdays(rule.days) : ['MO', 'TU', 'WE', 'TH', 'FR'],
      weeklyCount: habitClampInt(rule.count, 1, 7, 3),
      intervalDays: habitClampInt(rule.days, 1, 365, 2),
      targetValue: target > 1 ? target : 1,
      targetUnit: habitTargetUnit(habit),
      startDate: habit.start_date || stateRef.current.today,
      timeHint: habit.time_hint || '',
    }
  }

  function openCreateEditor() {
    update({ editor: { mode: 'create', form: createFormDefaults() } })
  }

  function openEditEditor(habit) {
    update({ editor: { mode: 'edit', habitId: habit.id, rev: habit.rev, form: formFromHabit(habit) } })
  }

  function buildHabitBody(form) {
    const kind = form.frequencyKind || 'daily'
    const frequency = { kind: kind }
    if (kind === 'daily') frequency.interval = habitClampInt(form.dailyInterval, 1, 365, 1)
    else if (kind === 'weekly_days') frequency.days = habitSortWeekdays(form.weekDays)
    else if (kind === 'weekly_count') frequency.count = habitClampInt(form.weeklyCount, 1, 7, 3)
    else frequency.days = habitClampInt(form.intervalDays, 1, 365, 2)
    const targetValue = habitClampInt(form.targetValue, 1, 366, 1)
    const targetUnit = String(form.targetUnit || '').trim() || '次'
    const description = String(form.description || '').trim()
    return {
      name: String(form.name || '').trim(),
      description: description || null,
      frequency_rule: frequency,
      period_rule: kind === 'weekly_count' ? { period: 'week', target_count: frequency.count } : null,
      target_json: targetValue > 1 ? { metric: 'count', value: targetValue, unit: targetUnit } : null,
      start_date: form.startDate || stateRef.current.today,
      time_hint: String(form.timeHint || '').trim() || null,
    }
  }

  async function saveHabitEditor() {
    const editor = stateRef.current.editor
    if (!editor) return
    const form = editor.form || {}
    if (!String(form.name || '').trim()) {
      update({ editor: Object.assign({}, editor, { error: '请填写习惯名称' }) })
      return
    }
    if (form.frequencyKind === 'weekly_days' && habitSortWeekdays(form.weekDays).length === 0) {
      update({ editor: Object.assign({}, editor, { error: '「每周固定」至少选择一天' }) })
      return
    }
    const body = buildHabitBody(form)
    update({ editor: Object.assign({}, editor, { saving: true, error: null }) })
    try {
      if (editor.mode === 'create') {
        const createBody = {}
        Object.keys(body).forEach(function keep(key) {
          if (body[key] !== null && body[key] !== undefined) createBody[key] = body[key]
        })
        await habitApiSend('POST', '/habits', createBody)
        toast('success', '已创建习惯')
      } else {
        const habit = findHabit(editor.habitId)
        await habitApiSend('PATCH', '/habits/' + encodeURIComponent(editor.habitId), {
          patch: body,
          expectedRev: editor.rev || (habit && habit.rev),
        })
        toast('success', '已保存习惯')
      }
      update({ editor: null })
      await loadAll({ silent: true })
    } catch (error) {
      update({
        editor: Object.assign({}, stateRef.current.editor || editor, {
          saving: false,
          error: habitErrorHint(error),
        }),
      })
    }
  }

  /* ── 打卡日志（checkin.note） ── */

  function openLogEditor(habit) {
    if (!habit) return
    const checkins = stateRef.current.checkins[habit.id] || []
    const candidates = [stateRef.current.date, stateRef.current.today]
    let existing = null
    let targetDate = null
    for (let index = 0; index < candidates.length; index += 1) {
      const record = habitCheckinByDate(checkins, candidates[index])
      if (record) {
        existing = record
        targetDate = candidates[index]
        break
      }
    }
    if (!existing || !targetDate) {
      toast('error', '日志依附于打卡记录：请先在当天打卡，再写日志')
      return
    }
    if (dateWindowHint(targetDate)) {
      toast('error', '超过 7 天的日志只能查看')
      return
    }
    update({
      logEditor: {
        habitId: habit.id,
        date: targetDate,
        note: existing.note || '',
        status: existing.status,
        checkinId: existing.id,
        error: null,
        saving: false,
      },
    })
  }

  function openLogEditorForDate(habit, dateKey) {
    if (!habit || !dateKey) return
    if (dateWindowHint(dateKey)) {
      toast('error', '超过 7 天的日志只能查看')
      return
    }
    const checkins = stateRef.current.checkins[habit.id] || []
    const existing = habitCheckinByDate(checkins, dateKey)
    if (!existing) {
      toast('error', '该日期没有打卡记录，无法写日志')
      return
    }
    update({
      logEditor: {
        habitId: habit.id,
        date: dateKey,
        note: existing.note || '',
        status: existing.status,
        checkinId: existing.id,
        error: null,
        saving: false,
      },
    })
  }

  async function saveLogEditor() {
    const editor = stateRef.current.logEditor
    if (!editor) return
    const habit = findHabit(editor.habitId)
    if (!habit) return
    const note = String(editor.note || '').trim()
    if (!note) {
      update({ logEditor: Object.assign({}, editor, { error: '请输入日志内容（清空请用「删除日志」）' }) })
      return
    }
    const checkins = stateRef.current.checkins[habit.id] || []
    const existing = habitCheckinByDate(checkins, editor.date)
    if (!existing) {
      update({ logEditor: Object.assign({}, editor, { error: '该日期没有打卡记录，无法保存日志' }) })
      return
    }
    update({ logEditor: Object.assign({}, editor, { saving: true, error: null }) })
    try {
      await submitCheckin(habit, editor.date, { status: existing.status, note: note.slice(0, HABIT_NOTE_MAX) })
      await refreshAfterMutation(habit.id, [habitMonthKeyOf(editor.date)])
      update({ logEditor: null })
      toast('success', '日志已保存')
    } catch (error) {
      update({
        logEditor: Object.assign({}, stateRef.current.logEditor || editor, {
          saving: false,
          error: habitErrorHint(error),
        }),
      })
    }
  }

  function deleteLog(habit, checkin) {
    if (!habit || !checkin || !checkin.note) return
    const dateKey = checkin.local_date
    if (dateWindowHint(dateKey)) {
      toast('error', '超过 7 天的日志只能查看')
      return
    }
    const snapshot = { status: checkin.status, value: habitCheckinValue(checkin), note: checkin.note }
    update({ logEditor: null })
    runWithBusy('dellog|' + habit.id + '|' + dateKey, async function deleteLogAction() {
      await habitApiSend('POST', '/habits/' + encodeURIComponent(habit.id) + '/checkin', {
        localDate: dateKey,
        status: checkin.status,
        note: '',
      })
      await refreshAfterMutation(habit.id, [habitMonthKeyOf(dateKey)])
      toast('success', '日志已删除（打卡保留）', {
        label: '撤销',
        onClick: function undoDeleteLog() {
          restoreCheckin(habit.id, dateKey, snapshot)
        },
      })
    })
  }

  /* ── 菜单 ── */

  function openMenuAt(event, items) {
    if (!event || !event.currentTarget) return
    const rect = event.currentTarget.getBoundingClientRect()
    update({ menu: { x: rect.right - 184, y: rect.bottom + 4, items: items } })
  }

  function commonMenuItems(habit) {
    return [
      { label: '编辑习惯', icon: 'edit', onClick: function editItem() { openEditEditor(habit) } },
      {
        label: habit.status === 'paused' ? '恢复习惯' : '暂停习惯',
        icon: 'clock',
        onClick: function pauseItem() { handleTogglePause(habit) },
      },
      { label: '归档习惯', icon: 'trash', danger: true, onClick: function archiveItem() { askArchive(habit) } },
    ]
  }

  function rowMenuItems(habit) {
    const dateKey = stateRef.current.date
    const checkins = stateRef.current.checkins[habit.id] || []
    const existing = habitCheckinByDate(checkins, dateKey)
    const items = []
    items.push({ label: '编辑习惯', icon: 'edit', onClick: function editItem() { openEditEditor(habit) } })
    if (habit.status !== 'paused' && dateCheckable(dateKey)) {
      items.push({ label: '标记未完成', icon: 'close', onClick: function notDoneItem() { handleMarkStatus(habit, dateKey, 'not_done') } })
      items.push({ label: '跳过本次', icon: 'done', onClick: function skipItem() { handleMarkStatus(habit, dateKey, 'skipped') } })
    }
    if (existing) {
      items.push({ label: '清除当日记录', icon: 'trash', onClick: function clearItem() { handleClearRecord(habit, dateKey) } })
    }
    items.push({
      label: habit.status === 'paused' ? '恢复习惯' : '暂停习惯',
      icon: 'clock',
      onClick: function pauseItem() { handleTogglePause(habit) },
    })
    items.push({ label: '归档习惯', icon: 'trash', danger: true, onClick: function archiveItem() { askArchive(habit) } })
    return items
  }

  function detailMenuItems(habit) {
    return [
      { label: '编辑习惯', icon: 'edit', onClick: function editItem() { openEditEditor(habit) } },
      { label: '写今日日志', icon: 'text', onClick: function logItem() { openLogEditor(habit) } },
      {
        label: habit.status === 'paused' ? '恢复习惯' : '暂停习惯',
        icon: 'clock',
        onClick: function pauseItem() { handleTogglePause(habit) },
      },
      { label: '归档习惯', icon: 'trash', danger: true, onClick: function archiveItem() { askArchive(habit) } },
    ]
  }

  /* ── 渲染：左栏 ── */

  function renderLeftHeader() {
    const visible = visibleHabits()
    const planCount = visible.filter(function isPlanned(habit) {
      return !habitPausedOn(habit, state.date) && habitPausedOn(habit, state.date) === false && habitPlanDay(habit, state.date)
    }).length
    return h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 52,
          minHeight: 52,
          padding: '0 14px',
          boxSizing: 'border-box',
          flex: '0 0 auto',
        },
      },
      h(
        'div',
        { style: { flex: '1 1 auto', minWidth: 0 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h(
            'span',
            { style: { fontSize: 20, fontWeight: 600, color: V2_T.text.primary, lineHeight: '26px', letterSpacing: '-0.01em' } },
            '习惯',
          ),
          h(
            'span',
            {
              style: {
                fontSize: V2_T.font.caption,
                color: V2_T.text.secondary,
                background: V2_T.surface.panel2,
                borderRadius: V2_T.radius.pill,
                padding: '0 6px',
                height: 18,
                lineHeight: '18px',
                boxSizing: 'border-box',
                flex: '0 0 auto',
              },
            },
            String(visible.length),
          ),
        ),
        h(
          'div',
          {
            style: {
              fontSize: V2_T.font.meta,
              color: V2_T.text.tertiary,
              marginTop: 1,
              lineHeight: '16px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
          },
          state.date === state.today
            ? '今天 · ' + planCount + ' 项计划'
            : '查看 ' + habitFormatDate(state.date) + ' · ' + planCount + ' 项计划',
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          title: '刷新数据',
          onClick: function onRefresh() {
            loadAll({ silent: true })
          },
          onMouseEnter: function onRefreshEnter(event) {
            event.currentTarget.style.background = V2_T.surface.panel2
          },
          onMouseLeave: function onRefreshLeave(event) {
            event.currentTarget.style.background = 'transparent'
          },
          style: habitIconButtonStyle({ width: 28, height: 28, minWidth: 28, borderRadius: V2_T.radius.sm }),
        },
        h(V2Icon, { name: 'refresh', size: 14 }),
      ),
      h(
        'button',
        {
          type: 'button',
          title: '新建习惯',
          onClick: openCreateEditor,
          onMouseEnter: function onNewEnter(event) {
            event.currentTarget.style.filter = 'brightness(1.08)'
          },
          onMouseLeave: function onNewLeave(event) {
            event.currentTarget.style.filter = 'none'
          },
          style: v2BtnStyle('primary', {
            height: 32,
            padding: '0 12px',
            borderRadius: V2_T.radius.pill,
            fontSize: V2_T.font.meta,
            fontWeight: 600,
            gap: 4,
            flex: '0 0 auto',
          }),
        },
        h(V2Icon, { name: 'plus', size: 13 }),
        '新建',
      ),
    )
  }

  function renderWeekBar() {
    const dates = []
    for (let offset = 6; offset >= 0; offset -= 1) dates.push(habitAddDays(state.today, -offset))
    const visible = visibleHabits()
    const summaries = {}
    dates.forEach(function each(dateKey) {
      summaries[dateKey] = habitDateSummary(visible, state.checkins, dateKey)
    })
    return h(HabitWeekBar, {
      dates: dates,
      today: state.today,
      selected: state.date,
      summaries: summaries,
      onSelect: selectDate,
    })
  }

  function renderDateJump() {
    const dates = []
    for (let offset = 6; offset >= 0; offset -= 1) dates.push(habitAddDays(state.today, -offset))
    if (dates.indexOf(state.date) >= 0) return null
    return h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px 8px' } },
      h(
        'span',
        { style: { fontSize: V2_T.font.meta, color: V2_T.text.tertiary, flex: '1 1 auto', minWidth: 0, lineHeight: '18px' } },
        '正在查看 ' + habitFormatDate(state.date),
      ),
      h(
        'button',
        {
          type: 'button',
          onClick: function onToday() {
            selectDate(state.today)
          },
          style: v2BtnStyle('soft', {
            fontSize: V2_T.font.caption,
            height: 26,
            padding: '0 10px',
            borderRadius: V2_T.radius.sm,
            background: V2_T.surface.panel2,
            color: V2_T.text.primary,
          }),
        },
        '回到今天',
      ),
    )
  }

  function renderHabitRow(habit) {
    const checkins = state.checkins[habit.id] || []
    const checkin = habitCheckinByDate(checkins, state.date)
    const paused = habitPausedOn(habit, state.date) || habit.status === 'paused'
    const hint = dateWindowHint(state.date)
    const key = 'check|' + habit.id + '|' + state.date
    return h(HabitRowV2, {
      key: habit.id,
      habit: habit,
      checkin: checkin,
      statsItem: state.stats[habit.id] || null,
      selected: state.selectedId === habit.id,
      paused: paused,
      disabled: paused || hint !== '',
      disabledHint: paused ? '习惯已暂停' : hint,
      busy: state.busyKey === key,
      onSelect: function onSelect() {
        selectHabit(habit.id)
      },
      onToggle: function onToggle() {
        handleToggle(habit, stateRef.current.date)
      },
      onStep: function onStep(delta) {
        handleStep(habit, stateRef.current.date, delta)
      },
      onMenu: function onMenu(event) {
        openMenuAt(event, rowMenuItems(habit))
      },
    })
  }

  function renderHabitSection(title, key, list, emptyHint) {
    const collapsed = state.collapsed[key] === true
    if (!list.length && !emptyHint) return null
    return h(
      'div',
      { style: { marginTop: 12 } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 4, padding: '4px 12px 4px 6px' } },
        h(
          'button',
          {
            type: 'button',
            onClick: function onToggle() {
              const next = Object.assign({}, state.collapsed)
              next[key] = !collapsed
              update({ collapsed: next })
            },
            style: habitIconButtonStyle({ width: 20, height: 20, minWidth: 20 }),
          },
          h(V2Icon, { name: collapsed ? 'chev' : 'chevD', size: 12 }),
        ),
        h(
          'span',
          {
            style: {
              fontSize: V2_T.font.caption,
              fontWeight: 600,
              color: V2_T.text.tertiary,
              letterSpacing: '0.02em',
              lineHeight: '16px',
            },
          },
          title,
        ),
        h(
          'span',
          { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary, marginLeft: 'auto', lineHeight: '16px' } },
          String(list.length),
        ),
      ),
      collapsed
        ? null
        : list.length
          ? list.map(function renderRow(habit) {
              return renderHabitRow(habit)
            })
          : h('div', { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary, padding: '2px 12px 8px' } }, emptyHint),
    )
  }

  function renderList() {
    const visible = visibleHabits()
    if (state.loading && visible.length === 0) {
      return h(
        'div',
        { style: { display: 'flex', justifyContent: 'center', padding: '40px 16px' } },
        h(
          'div',
          { style: v2CardStyle({ padding: 24, maxWidth: 420, width: '100%', textAlign: 'center' }) },
          h('div', { style: { fontSize: V2_T.font.meta, color: V2_T.text.tertiary, lineHeight: '18px' } }, '加载习惯数据…'),
        ),
      )
    }
    if (state.error && visible.length === 0) {
      return h(
        'div',
        { style: { display: 'flex', justifyContent: 'center', padding: '40px 16px' } },
        h(
          'div',
          {
            style: v2CardStyle({
              padding: 24,
              maxWidth: 420,
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
              textAlign: 'center',
            }),
          },
          h('div', { style: { fontSize: V2_T.font.meta, color: V2_T.status.danger, lineHeight: '18px' } }, state.error),
          h(
            'button',
            {
              type: 'button',
              onClick: function onRetry() {
                loadAll({ silent: false })
              },
              style: v2BtnStyle('soft', {
                height: 32,
                padding: '0 14px',
                borderRadius: V2_T.radius.sm,
                background: V2_T.surface.panel3,
                color: V2_T.text.primary,
                fontSize: V2_T.font.meta,
              }),
            },
            '重试',
          ),
        ),
      )
    }
    if (visible.length === 0) {
      return h(
        'div',
        { style: { display: 'flex', justifyContent: 'center', padding: '40px 16px' } },
        h(
          'div',
          {
            style: v2CardStyle({
              padding: 24,
              maxWidth: 420,
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              textAlign: 'center',
            }),
          },
          h('div', { style: { fontSize: 32, lineHeight: '38px' } }, '🌱'),
          h('div', { style: { fontSize: V2_T.font.title, fontWeight: 600, color: V2_T.text.primary, lineHeight: '22px' } }, '还没有习惯。'),
          h(
            'div',
            { style: { fontSize: V2_T.font.meta, color: V2_T.text.tertiary, lineHeight: '18px' } },
            '从一个每天都能做到的小习惯开始吧。',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: openCreateEditor,
              style: v2BtnStyle('primary', {
                marginTop: 2,
                height: 32,
                padding: '0 14px',
                borderRadius: V2_T.radius.sm,
                fontSize: V2_T.font.meta,
                fontWeight: 600,
              }),
            },
            h(V2Icon, { name: 'plus', size: 13 }),
            '新建习惯',
          ),
        ),
      )
    }
    const planList = []
    const flexList = []
    const pausedList = []
    visible.forEach(function split(habit) {
      if (habitPausedOn(habit, state.date) || habit.status === 'paused') {
        pausedList.push(habit)
        return
      }
      if (habitPlanDay(habit, state.date)) planList.push(habit)
      else flexList.push(habit)
    })
    const sortByName = function sortByName(left, right) {
      const leftOrder = Number(left.sort_order || 0)
      const rightOrder = Number(right.sort_order || 0)
      if (leftOrder !== rightOrder) return leftOrder - rightOrder
      return String(left.name || '').localeCompare(String(right.name || ''))
    }
    planList.sort(sortByName)
    flexList.sort(sortByName)
    pausedList.sort(sortByName)
    const showPaused = v2ReadSettings().habitShowPaused !== false
    return h(
      'div',
      { style: { padding: '0 8px 24px' } },
      state.error
        ? h('div', { style: { fontSize: V2_T.font.caption, color: V2_T.status.danger, padding: '4px 12px', lineHeight: '16px' } }, state.error)
        : null,
      renderHabitSection('当日计划', 'plan', planList, state.date === state.today ? '今天没有计划中的习惯' : '这一天没有计划中的习惯'),
      renderHabitSection('灵活打卡', 'flex', flexList, ''),
      showPaused ? renderHabitSection('已暂停', 'paused', pausedList, '') : null,
    )
  }

  function renderLeftPane() {
    const hasDetail = !!currentHabit()
    const fullWidth = !narrow && !hasDetail
    const style = narrow || fullWidth
      ? {
          flex: '1 1 auto',
          width: 'auto',
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          background: V2_T.surface.app,
        }
      : {
          flex: '0 0 ' + listWidth + 'px',
          width: listWidth,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          background: V2_T.surface.app,
          borderRight: '1px solid ' + V2_T.border.subtle,
        }
    return h(
      'div',
      { style: style },
      renderLeftHeader(),
      h('div', { style: { padding: '2px 14px 0', flex: '0 0 auto' } }, renderWeekBar()),
      h('div', { style: { flex: '1 1 auto', overflowY: 'auto', minHeight: 0, paddingTop: 2 } }, renderDateJump(), renderList()),
    )
  }

  /* ── 渲染：右栏 ── */

  function renderPlaceholder() {
    return h(
      'div',
      {
        style: {
          flex: '1 1 auto',
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: V2_T.surface.shell,
          color: V2_T.text.tertiary,
          fontSize: V2_T.font.meta,
          lineHeight: '20px',
          textAlign: 'center',
          padding: 24,
        },
      },
      h('div', null, '从左侧选择一个习惯', h('br'), '查看本月统计、打卡日历与日志'),
    )
  }

  function renderLegend() {
    const items = [
      { key: 'done', label: '已完成', meta: habitMonthCellMeta('done', false, false, false) },
      { key: 'partial', label: '部分', meta: habitMonthCellMeta('partial', false, false, false) },
      { key: 'missed', label: '未完成', meta: habitMonthCellMeta('not_done', false, false, false) },
      { key: 'unknown', label: '计划未记录', meta: habitMonthCellMeta('unknown', false, false, true) },
      { key: 'future', label: '未来计划', meta: habitMonthCellMeta(null, false, true, true) },
    ]
    return h(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } },
      items.map(function renderItem(item) {
        return h(
          'span',
          {
            key: item.key,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: V2_T.font.caption,
              color: V2_T.text.tertiary,
              lineHeight: '16px',
            },
          },
          h('span', {
            style: {
              width: 10,
              height: 10,
              borderRadius: 3,
              border: item.meta.border,
              background: item.meta.background,
              boxSizing: 'border-box',
              flex: '0 0 auto',
            },
          }),
          item.label,
        )
      }),
    )
  }

  function renderInfoRow(label, value) {
    return h(
      'div',
      { key: label, style: { display: 'flex', gap: 8, fontSize: V2_T.font.meta, lineHeight: '18px', minWidth: 0 } },
      h('span', { style: { flex: '0 0 64px', color: V2_T.text.tertiary } }, label),
      h('span', { style: { flex: '1 1 auto', minWidth: 0, color: V2_T.text.secondary, wordBreak: 'break-word' } }, value),
    )
  }

  function renderDetailPane() {
    const habit = currentHabit()
    if (!habit) return null
    const today = state.today
    const checkins = state.checkins[habit.id] || []
    const statsItem = state.stats[habit.id] || null
    const currentMonthKey = habitMonthKeyOf(today)
    const currentMonthData = state.months[currentMonthKey] || null
    const serverWeekStart = currentMonthData && currentMonthData.week_start === 'sunday' ? 'sunday' : 'monday'
    const monthStats = habitMonthStats(habit, currentMonthKey, checkins, today, serverWeekStart)
    const streak = statsItem && statsItem.streak ? statsItem.streak : null
    const streakValue = streak ? Number(streak.value) || 0 : 0
    const streakUnitLabel = habitStreakUnitLabel(streak && streak.unit)
    const longest = streak ? Number(streak.longest) || 0 : 0
    const detailMonthData = state.months[state.monthKey] || null
    const detailWeekStart = detailMonthData && detailMonthData.week_start === 'sunday' ? 'sunday' : 'monday'
    const detailMonthRow =
      detailMonthData && Array.isArray(detailMonthData.rows)
        ? detailMonthData.rows.filter(function findRow(row) {
            return row && row.habitId === habit.id
          })[0] || null
        : null
    const logs = checkins
      .filter(function withNote(item) {
        return item && item.note
      })
      .sort(function desc(left, right) {
        return left.local_date < right.local_date ? 1 : left.local_date > right.local_date ? -1 : 0
      })
    const selectedRecord = habitCheckinByDate(checkins, state.date)
    const windowHint = dateWindowHint(state.date)
    const pausedOnDate = habitPausedOn(habit, state.date)
    const disabled = habit.status === 'paused' || pausedOnDate || windowHint !== ''
    const busy = state.busyKey === 'check|' + habit.id + '|' + state.date
    const ratioText = monthStats.ratio === null ? '—' : Math.round(monthStats.ratio * 100) + '%'
    const ratioTone =
      monthStats.ratio === null
        ? V2_T.text.tertiary
        : monthStats.ratio >= 0.8
          ? V2_T.status.success
          : monthStats.ratio > 0
            ? V2_T.status.warn
            : V2_T.status.danger
    const subtitleParts = [habitFrequencyText(habit)]
    if (habit.start_date) subtitleParts.push('开始于 ' + habitFormatDate(habit.start_date))
    if (habit.time_hint) subtitleParts.push('提醒 ' + habit.time_hint)
    if (habit.status === 'paused') subtitleParts.push('已暂停')
    const dayLabel = (state.date === today ? '今天 · ' : '') + habitFormatDate(state.date) + ' · ' + (HABIT_WEEKDAY_FULL[habitWeekdayCodeOf(state.date)] || '')
    const dayPlan = habitPlanDay(habit, state.date) && !pausedOnDate
    const daySummary = selectedRecord
      ? habitStatusLabel(selectedRecord.status) +
        (habitIsQuantified(habit) ? ' · ' + habitCheckinValue(selectedRecord) + '/' + habitTargetValue(habit) : '') +
        (selectedRecord.note ? ' · 有日志' : '')
      : dayPlan
        ? '计划日 · 尚未打卡'
        : '非计划日 · 可补记一次'
    const detailMonthDates = detailMonthData && Array.isArray(detailMonthData.days) ? detailMonthData.days : habitMonthDates(state.monthKey)
    const monthCells = detailMonthRow && Array.isArray(detailMonthRow.cells) ? detailMonthRow.cells : []

    return h(
      'div',
      {
        style: {
          flex: '1 1 auto',
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          background: V2_T.surface.shell,
          borderLeft: narrow ? 'none' : '1px solid ' + V2_T.border.subtle,
        },
      },
      h(
        'div',
        { style: { flex: '1 1 auto', overflowY: 'auto', minHeight: 0, padding: 16 } },
        h(
          'div',
          { style: { maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
            narrow
              ? h(
                  'button',
                  {
                    type: 'button',
                    title: '返回列表',
                    onClick: function onBack() {
                      update({ selectedId: null })
                    },
                    style: habitIconButtonStyle({ marginTop: 4 }),
                  },
                  h(V2Icon, { name: 'back', size: 16 }),
                )
              : null,
            h(HabitIconBadge, { habit: habit, size: 44, active: false }),
            h(
              'div',
              { style: { flex: '1 1 auto', minWidth: 0 } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                h(
                  'div',
                  {
                    style: {
                      fontSize: V2_T.font.hero,
                      fontWeight: 600,
                      lineHeight: '24px',
                      color: V2_T.text.primary,
                      letterSpacing: '-0.01em',
                    },
                  },
                  habit.name,
                ),
                habit.status === 'paused' ? h('span', { style: habitChipStyle('faint') }, '已暂停') : null,
                habitIsQuantified(habit)
                  ? h(
                      'span',
                      { style: habitChipStyle('accent', false) },
                      '目标 ' + habitTargetValue(habit) + ' ' + habitTargetUnit(habit),
                    )
                  : null,
              ),
              h(
                'div',
                {
                  style: {
                    fontSize: V2_T.font.meta,
                    color: V2_T.text.tertiary,
                    marginTop: 2,
                    lineHeight: '17px',
                  },
                },
                subtitleParts.join(' · '),
              ),
              habit.description
                ? h(
                    'div',
                    { style: { fontSize: V2_T.font.body, color: V2_T.text.secondary, marginTop: 6, lineHeight: '19px' } },
                    habit.description,
                  )
                : null,
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: function onEdit() {
                  openEditEditor(habit)
                },
                style: v2BtnStyle('soft', {
                  height: 28,
                  padding: '0 10px',
                  borderRadius: V2_T.radius.sm,
                  background: V2_T.surface.panel2,
                  color: V2_T.text.primary,
                  fontSize: V2_T.font.meta,
                  flex: '0 0 auto',
                }),
              },
              h(V2Icon, { name: 'edit', size: 13 }),
              '编辑',
            ),
            h(
              'button',
              {
                type: 'button',
                title: '更多操作',
                onClick: function onMore(event) {
                  openMenuAt(event, detailMenuItems(habit))
                },
                style: habitIconButtonStyle({ width: 28, height: 28, minWidth: 28, marginTop: 1 }),
              },
              h(V2Icon, { name: 'more', size: 15 }),
            ),
          ),
          h(
            'div',
            {
              style: habitCardStyle({
                padding: '10px 12px',
                marginTop: 14,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }),
            },
            h(
              'div',
              { style: { flex: '1 1 200px', minWidth: 0 } },
              h(
                'div',
                { style: { fontSize: V2_T.font.meta, fontWeight: 600, color: V2_T.text.primary, lineHeight: '18px' } },
                dayLabel,
              ),
              h(
                'div',
                {
                  style: {
                    fontSize: V2_T.font.caption,
                    color: selectedRecord ? habitToneColor(habitStatusTone(selectedRecord.status)) : V2_T.text.tertiary,
                    marginTop: 2,
                    lineHeight: '16px',
                  },
                },
                daySummary,
              ),
            ),
            habitIsQuantified(habit)
              ? h(HabitStepper, {
                  target: habitTargetValue(habit),
                  value: habitCheckinValue(selectedRecord),
                  status: selectedRecord ? selectedRecord.status : '',
                  disabled: disabled,
                  busy: busy,
                  onToggle: function onToggle() {
                    handleToggle(habit, stateRef.current.date)
                  },
                  onStep: function onStep(delta) {
                    handleStep(habit, stateRef.current.date, delta)
                  },
                })
              : h(HabitCheckButton, {
                  status: selectedRecord ? selectedRecord.status : '',
                  value: habitCheckinValue(selectedRecord),
                  disabled: disabled,
                  busy: busy,
                  title:
                    windowHint ||
                    (habit.status === 'paused' || pausedOnDate
                      ? '习惯已暂停'
                      : selectedRecord && selectedRecord.status === 'done'
                        ? '取消打卡'
                        : selectedRecord && selectedRecord.status === 'partial'
                          ? '再记一次'
                          : '打卡'),
                  onToggle: function onToggle() {
                    handleToggle(habit, stateRef.current.date)
                  },
                }),
            h(
              'button',
              {
                type: 'button',
                onClick: function onWriteLog() {
                  openLogEditor(habit)
                },
                style: v2BtnStyle('soft', {
                  height: 26,
                  padding: '0 10px',
                  borderRadius: V2_T.radius.sm,
                  background: V2_T.surface.panel2,
                  color: V2_T.text.primary,
                  fontSize: V2_T.font.caption,
                  gap: 4,
                }),
              },
              h(V2Icon, { name: 'text', size: 12 }),
              '写日志',
            ),
          ),
          h(
            'div',
            {
              style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: 10,
                marginTop: 12,
              },
            },
            h(HabitStatCard, {
              key: 'month',
              value: String(monthStats.monthDone),
              unit: '天',
              label: '本月打卡',
              hint: habitFrequencyKind(habit) === 'weekly_count' ? '按日累计' : '',
            }),
            h(HabitStatCard, {
              key: 'total',
              value: String(monthStats.totalDone),
              unit: '天',
              label: '总打卡',
              hint: '创建以来',
            }),
            h(HabitStatCard, {
              key: 'ratio',
              value: ratioText,
              tone: ratioTone,
              label: '本月完成率',
              hint:
                monthStats.expected > 0
                  ? String(monthStats.done) + ' / ' + String(monthStats.expected) + (habitFrequencyKind(habit) === 'weekly_count' ? ' 次' : ' 天')
                  : '暂无到期计划',
            }),
            h(HabitStatCard, {
              key: 'streak',
              value: String(streakValue),
              unit: streakUnitLabel,
              tone: streakValue > 0 ? V2_T.accent.base : V2_T.text.tertiary,
              label: '当前连续',
              hint: longest > 0 ? '最长 ' + longest + ' ' + streakUnitLabel : '',
            }),
          ),
          h(
            'div',
            { style: habitCardStyle({ padding: '10px 12px', marginTop: 14 }) },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 2 } },
              h(
                'div',
                { style: { flex: '1 1 auto', fontSize: V2_T.font.meta, fontWeight: 600, color: V2_T.text.primary, lineHeight: '18px' } },
                '打卡日历',
              ),
              h(
                'button',
                {
                  type: 'button',
                  title: '上个月',
                  onClick: function onPrev() {
                    update({ monthKey: habitShiftMonth(stateRef.current.monthKey, -1) })
                  },
                  style: habitIconButtonStyle({ width: 24, height: 24, minWidth: 24 }),
                },
                h(V2Icon, { name: 'chevL', size: 14 }),
              ),
              h(
                'div',
                {
                  style: {
                    fontSize: V2_T.font.meta,
                    color: V2_T.text.secondary,
                    minWidth: 78,
                    textAlign: 'center',
                    lineHeight: '18px',
                  },
                },
                habitMonthLabel(state.monthKey),
              ),
              h(
                'button',
                {
                  type: 'button',
                  title: '下个月',
                  onClick: function onNext() {
                    update({ monthKey: habitShiftMonth(stateRef.current.monthKey, 1) })
                  },
                  style: habitIconButtonStyle({ width: 24, height: 24, minWidth: 24 }),
                },
                h(V2Icon, { name: 'chevR', size: 14 }),
              ),
              state.monthKey === currentMonthKey
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      onClick: function onCurrentMonth() {
                        update({ monthKey: currentMonthKey, date: today })
                      },
                      style: v2BtnStyle('soft', {
                        fontSize: V2_T.font.caption,
                        height: 24,
                        padding: '0 8px',
                        borderRadius: V2_T.radius.sm,
                        background: V2_T.surface.panel2,
                        color: V2_T.text.primary,
                      }),
                    },
                    '本月',
                  ),
            ),
            h('div', { style: { marginTop: 8 } },
              h(HabitMonthGrid, {
                monthKey: state.monthKey,
                dates: detailMonthDates,
                weekStart: detailWeekStart,
                cells: monthCells,
                checkins: checkins,
                habit: habit,
                today: today,
                selectedDate: state.date,
                onSelectDate: selectDate,
              }),
            ),
            renderLegend(),
          ),
          h(
            'div',
            { style: v2CardStyle({ padding: '10px 12px', marginTop: 14 }) },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              h(
                'div',
                { style: { flex: '1 1 auto', fontSize: V2_T.font.meta, fontWeight: 600, color: V2_T.text.primary, lineHeight: '18px' } },
                '打卡日志',
              ),
              h(
                'span',
                { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary, lineHeight: '16px' } },
                String(logs.length) + ' 条',
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: function onWriteLog() {
                    openLogEditor(habit)
                  },
                  style: v2BtnStyle('soft', {
                    height: 24,
                    padding: '0 8px',
                    borderRadius: V2_T.radius.sm,
                    background: V2_T.surface.panel2,
                    color: V2_T.text.primary,
                    fontSize: V2_T.font.caption,
                    gap: 3,
                  }),
                },
                h(V2Icon, { name: 'plus', size: 12 }),
                '写日志',
              ),
            ),
            h(
              'div',
              { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary, marginTop: 4, lineHeight: '16px' } },
              '日志依附于打卡记录：保存或删除日志不会改变打卡状态，删除日志只清空备注。',
            ),
            logs.length
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 } },
                  logs.slice(0, 30).map(function renderLog(item) {
                    const editable = dateWindowHint(item.local_date) === ''
                    return h(
                      'div',
                      {
                        key: item.id || item.local_date,
                        onMouseEnter: function onEnter(event) {
                          event.currentTarget.style.background = V2_T.surface.panel2
                          const buttons = event.currentTarget.querySelectorAll('button')
                          Array.prototype.forEach.call(buttons, function each(btn) {
                            btn.style.opacity = '1'
                          })
                        },
                        onMouseLeave: function onLeave(event) {
                          event.currentTarget.style.background = 'transparent'
                          const buttons = event.currentTarget.querySelectorAll('button')
                          Array.prototype.forEach.call(buttons, function each(btn) {
                            btn.style.opacity = '0.55'
                          })
                        },
                        style: {
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                          minHeight: 34,
                          boxSizing: 'border-box',
                          padding: '6px 8px',
                          borderRadius: V2_T.radius.sm,
                          background: 'transparent',
                        },
                      },
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                        h(
                          'span',
                          { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary, lineHeight: '16px' } },
                          habitFormatDate(item.local_date) + (item.checkin_kind === 'retro' ? ' · 补记' : ''),
                        ),
                        h('span', { style: habitChipStyle(habitStatusTone(item.status)) }, habitStatusLabel(item.status)),
                        h('div', { style: { flex: '1 1 auto' } }),
                        editable
                          ? h(
                              'button',
                              {
                                type: 'button',
                                title: '编辑日志',
                                onClick: function onEditLog() {
                                  openLogEditorForDate(habit, item.local_date)
                                },
                                style: habitIconButtonStyle({ width: 22, height: 22, minWidth: 22, opacity: 0.55 }),
                              },
                              h(V2Icon, { name: 'edit', size: 12 }),
                            )
                          : h('span', { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary } }, '仅查看'),
                        editable
                          ? h(
                              'button',
                              {
                                type: 'button',
                                title: '删除日志（保留打卡）',
                                onClick: function onDeleteLog() {
                                  deleteLog(habit, item)
                                },
                                style: habitIconButtonStyle({ width: 22, height: 22, minWidth: 22, opacity: 0.55 }),
                              },
                              h(V2Icon, { name: 'trash', size: 12 }),
                            )
                          : null,
                      ),
                      h(
                        'div',
                        {
                          style: {
                            fontSize: V2_T.font.meta,
                            color: V2_T.text.primary,
                            lineHeight: '18px',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                          },
                        },
                        item.note,
                      ),
                    )
                  }),
                )
              : h(
                  'div',
                  {
                    style: {
                      fontSize: V2_T.font.caption,
                      color: V2_T.text.tertiary,
                      marginTop: 8,
                      padding: 12,
                      textAlign: 'center',
                      border: '1px dashed ' + V2_T.border.subtle,
                      borderRadius: V2_T.radius.sm,
                      lineHeight: '16px',
                    },
                  },
                  '还没有打卡日志。打卡后可以给当天写一条记录。',
                ),
          ),
          h(
            'div',
            { style: { marginTop: 18, paddingBottom: 8 } },
            h(
              'div',
              {
                style: {
                  fontSize: V2_T.font.meta,
                  fontWeight: 600,
                  color: V2_T.text.primary,
                  marginBottom: 6,
                  lineHeight: '18px',
                },
              },
              '习惯信息',
            ),
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))', gap: '2px 18px' } },
              renderInfoRow('状态', habit.status === 'paused' ? '已暂停' : habit.status === 'archived' ? '已归档' : '进行中'),
              renderInfoRow('频率', habitFrequencyText(habit)),
              renderInfoRow('目标', habitIsQuantified(habit) ? habitTargetValue(habit) + ' ' + habitTargetUnit(habit) : '未设置量化目标'),
              renderInfoRow('开始日期', habit.start_date || '—'),
              renderInfoRow('结束日期', habit.end_date || '—'),
              renderInfoRow('提醒', habit.time_hint || '—'),
              renderInfoRow('创建时间', habitFormatDateTime(habit.created_at) || '—'),
              renderInfoRow('更新时间', habitFormatDateTime(habit.updated_at) || '—'),
              renderInfoRow('图标', '按名称自动推导'),
              renderInfoRow('分组', 'Host 无分组字段'),
              renderInfoRow('编号', habit.id),
            ),
            h(
              'div',
              { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary, marginTop: 8, lineHeight: '16px' } },
              'Host 目前不提供 icon / group 字段：图标按名称推导，列表按「当日计划 / 灵活打卡 / 已暂停」自动分组。',
            ),
          ),
        ),
      ),
    )
  }

  /* ── 渲染：浮层 ── */

  function renderMenuLayer() {
    if (!state.menu) return null
    return h(HabitMenuLayer, {
      menu: state.menu,
      onClose: function onClose() {
        update({ menu: null })
      },
      onError: function onError(error) {
        toast('error', '操作失败：' + habitErrorHint(error))
      },
    })
  }

  function renderConfirmLayer() {
    if (!state.confirmDialog) return null
    return h(HabitConfirmModal, {
      dialog: state.confirmDialog,
      onConfirm: handleConfirm,
      onClose: function onClose() {
        update({ confirmDialog: null })
      },
    })
  }

  function renderEditorLayer() {
    const editor = state.editor
    if (!editor) return null
    return h(HabitEditorModal, {
      mode: editor.mode,
      form: editor.form || {},
      saving: editor.saving === true,
      error: editor.error || '',
      onChange: function onChange(patch) {
        const current = stateRef.current.editor
        if (!current) return
        update({
          editor: Object.assign({}, current, {
            form: Object.assign({}, current.form, patch),
            error: null,
          }),
        })
      },
      onSave: saveHabitEditor,
      onClose: function onClose() {
        update({ editor: null })
      },
    })
  }

  function renderLogLayer() {
    const log = state.logEditor
    if (!log) return null
    const habit = findHabit(log.habitId)
    if (!habit) return null
    const checkins = state.checkins[habit.id] || []
    const existing = habitCheckinByDate(checkins, log.date)
    const derived = Object.assign({}, log, {
      hasCheckin: !!existing,
      existingNote: !!(existing && existing.note),
      status: existing ? existing.status : log.status,
    })
    return h(HabitLogModal, {
      log: derived,
      onChange: function onChange(patch) {
        const current = stateRef.current.logEditor
        if (!current) return
        update({ logEditor: Object.assign({}, current, patch, { error: null }) })
      },
      onSave: saveLogEditor,
      onDelete: function onDelete() {
        if (existing) deleteLog(habit, existing)
      },
      onClose: function onClose() {
        update({ logEditor: null })
      },
    })
  }

  const habitForDetail = currentHabit()
  return h(
    'div',
    {
      style: {
        height: '100%',
        display: 'flex',
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        background: V2_T.surface.app,
        color: V2_T.text.primary,
        fontFamily: COLORS.fontFamily,
        position: 'relative',
      },
    },
    renderLeftPane(),
    narrow || !habitForDetail
      ? null
      : h('div', {
          key: 'habit-list-splitter',
          title: '拖动调整习惯列表宽度',
          onMouseDown: startListResize,
          style: {
            flex: '0 0 6px',
            width: 6,
            cursor: 'col-resize',
            background: 'transparent',
            marginLeft: -3,
            marginRight: -3,
            zIndex: 2,
          },
          onMouseEnter: function onEnter(event) {
            event.currentTarget.style.background = V2_T.surface.panel3
          },
          onMouseLeave: function onLeave(event) {
            event.currentTarget.style.background = 'transparent'
          },
        }),
    narrow ? (habitForDetail ? renderDetailPane() : null) : habitForDetail ? renderDetailPane() : null,
    renderMenuLayer(),
    renderConfirmLayer(),
    renderEditorLayer(),
    renderLogLayer(),
  )
}

/* ---- 50-notes.js (3355 lines) ---- */
/* ═══════════════════════ M6 · V2 笔记 Tab ═══════════════════════ */
/* NotesTabV2：左侧文件树（日记/随记快捷分组 + 最近 5 条 + 完整工作区目录树 +
   搜索 / 新建 / 多选 / 拖拽移动）+ 右侧 Markdown 编辑器（自动保存、预览、标签、冲突提示）。
   复用旧 notes runtime（client.js:createNotesRuntime），全部内联样式 + h()。 */

const V2_NOTES_SIDEBAR_WIDTH = 264
const V2_NOTES_TAG_STORAGE_KEY = 'lifeos.notes.tags.v1'
const V2_NOTES_DIARY_DIR = '日记'
const V2_NOTES_SCRATCH_DIR = '随记'
const V2_NOTES_RECENT_LIMIT = 5
const V2_NOTES_MOCK_HINT = '本地模拟模式：Host 未连接，修改不会写入磁盘'
const V2_NOTES_MONO_FONT = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace"
const V2_NOTES_PANES_STORAGE_KEY = 'lifeos.v2.notesPanes'
const V2_NOTES_TREE_MIN = 180
const V2_NOTES_TREE_MAX = 420
const V2_NOTES_EDITOR_MIN = 420
const V2_NOTES_EDITOR_MAX = 980

function v2NotesClamp(value, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return min
  return Math.max(min, Math.min(max, Math.round(num)))
}

function v2NotesReadPanes() {
  const fallback = { treeWidth: V2_NOTES_SIDEBAR_WIDTH, treeCollapsed: false, editorWidth: null }
  try {
    const raw = window.localStorage.getItem(V2_NOTES_PANES_STORAGE_KEY)
    const value = raw ? JSON.parse(raw) : null
    if (!value || typeof value !== 'object') return fallback
    return {
      treeWidth: v2NotesClamp(value.treeWidth, V2_NOTES_TREE_MIN, V2_NOTES_TREE_MAX),
      treeCollapsed: value.treeCollapsed === true,
      editorWidth:
        value.editorWidth === null || value.editorWidth === undefined
          ? null
          : v2NotesClamp(value.editorWidth, V2_NOTES_EDITOR_MIN, V2_NOTES_EDITOR_MAX),
    }
  } catch (error) {
    return fallback
  }
}

function v2NotesSavePanes(panes) {
  try {
    window.localStorage.setItem(V2_NOTES_PANES_STORAGE_KEY, JSON.stringify(panes))
  } catch (error) {
    /* ignore */
  }
}

/* ---------------- 纯工具 ---------------- */

function v2NotesBaseName(path) {
  const segments = String(path || '').split('/')
  return segments.length ? segments[segments.length - 1] : ''
}

function v2NotesDirName(path) {
  const segments = String(path || '').split('/')
  segments.pop()
  return segments.join('/')
}

function v2NotesJoin(dir, name) {
  const folder = String(dir || '')
  const file = String(name || '')
  if (!folder) return file
  return folder + '/' + file
}

function v2NotesExt(name) {
  const match = /\.(md|markdown|txt)$/i.exec(String(name || ''))
  return match ? match[0].toLowerCase() : '.md'
}

function v2NotesStripExt(name) {
  return String(name || '').replace(/\.(md|markdown|txt)$/i, '')
}

function v2NotesSanitizeName(name, fallback) {
  let text = String(name || '').replace(/[\\/:*?"<>|]/g, ' ')
  text = text.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  text = text.replace(/^\.+/, '').trim()
  if (!text) text = String(fallback || '')
  if (text.length > 60) text = text.slice(0, 60).trim()
  return text
}

function v2NotesUniqueName(name, exists, fallback) {
  const base = String(name || '')
  if (!exists || !exists(base)) return base
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let index = 2; index <= 99; index += 1) {
    const candidate = stem + ' (' + index + ')' + ext
    if (!exists(candidate)) return candidate
  }
  return stem + '-' + Date.now() + ext
}

function v2NotesCleanTag(value) {
  return String(value || '').replace(/^[#\s]+/, '').replace(/[,，;；\s]+/g, '').slice(0, 20)
}

function v2NotesLoadTags() {
  try {
    const raw = window.localStorage.getItem(V2_NOTES_TAG_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    const map = {}
    Object.keys(parsed || {}).forEach(function each(path) {
      const list = parsed[path]
      if (Array.isArray(list)) map[path] = list.map(v2NotesCleanTag).filter(Boolean)
    })
    return map
  } catch (error) {
    return {}
  }
}

function v2NotesPersistTags(map) {
  try {
    window.localStorage.setItem(V2_NOTES_TAG_STORAGE_KEY, JSON.stringify(map || {}))
  } catch (error) {
    /* ignore */
  }
}

function v2NotesNormalizeTagMap(value) {
  const map = {}
  if (!value || typeof value !== 'object') return map
  if (Array.isArray(value.items)) {
    value.items.forEach(function each(item) {
      if (item && item.path && Array.isArray(item.tags)) map[item.path] = item.tags.map(v2NotesCleanTag).filter(Boolean)
    })
    return map
  }
  const raw = value.tags && typeof value.tags === 'object' ? value.tags : value
  Object.keys(raw || {}).forEach(function each(path) {
    if (Array.isArray(raw[path])) map[path] = raw[path].map(v2NotesCleanTag).filter(Boolean)
  })
  return map
}

function v2NotesFetchTags() {
  return apiRequest('/notes/tags')
    .then(function onOk(value) {
      return { remote: true, map: v2NotesNormalizeTagMap(value) }
    })
    .catch(function onFail() {
      return { remote: false, map: null }
    })
}

function v2NotesFormatMtime(value) {
  if (!value) return ''
  try {
    if (typeof formatTime === 'function') return formatTime(value)
    const date = new Date(value)
    if (isNaN(date.getTime())) return ''
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return date.getMonth() + 1 + '/' + date.getDate() + ' ' + hours + ':' + minutes
  } catch (error) {
    return ''
  }
}

function v2NotesMtimeValue(entry) {
  const value = entry ? entry.mtime : 0
  if (typeof value === 'number' && isFinite(value)) return value
  const parsed = Date.parse(String(value || ''))
  return isNaN(parsed) ? 0 : parsed
}

function v2NotesScratchTitle(content) {
  const lines = String(content || '').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    let text = String(lines[index] || '').trim()
    if (!text) continue
    if (/^[-*_]{3,}$/.test(text)) continue
    text = text.replace(/^#+\s*/, '').replace(/^[-*+]\s+/, '').replace(/^>\s*/, '').trim()
    if (!text) continue
    /* 跳过 runtime 自动写入的日期标题行（如 “# 2026-11-18”），取后面真正的正文 */
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) continue
    return text.slice(0, 12)
  }
  return ''
}

function v2NotesMoveTarget(targetDir, name) {
  const dir = String(targetDir || '')
  const file = String(name || '')
  if (!dir) return './' + file
  return dir + '/' + file
}

/* 把扁平 entries 构建成稳定树（显式目录条目与隐式父目录去重） */
function v2NotesBuildTree(entries) {
  const list = Array.isArray(entries) ? entries : []
  const nodes = {}
  const roots = []
  function ensureDir(path) {
    if (!path) return null
    if (nodes[path]) return nodes[path]
    const segments = String(path).split('/')
    const parent = ensureDir(segments.slice(0, -1).join('/'))
    const node = { name: segments[segments.length - 1], path: path, type: 'dir', entry: null, children: [] }
    nodes[path] = node
    if (parent) parent.children.push(node)
    else roots.push(node)
    return node
  }
  list.forEach(function each(entry) {
    if (!entry || !entry.path) return
    const path = String(entry.path)
    if (entry.type === 'dir') {
      const node = ensureDir(path)
      if (node) node.entry = entry
      return
    }
    const parentPath = path.indexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : ''
    const parent = ensureDir(parentPath)
    if (nodes[path]) {
      nodes[path].entry = entry
      nodes[path].type = 'file'
      return
    }
    const node = { name: path.split('/').pop(), path: path, type: 'file', entry: entry, children: [] }
    nodes[path] = node
    if (parent) parent.children.push(node)
    else roots.push(node)
  })
  function sortNodes(items) {
    items.sort(function sort(a, b) {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return String(a.name).localeCompare(String(b.name), 'zh-CN')
    })
    items.forEach(function each(item) {
      if (item.children && item.children.length) sortNodes(item.children)
    })
  }
  sortNodes(roots)
  return roots
}

/* ---------------- 按钮 / 菜单 ---------------- */

function v2NotesBtnStyle(kind, extra) {
  const base = {
    height: 30,
    padding: '0 12px',
    borderRadius: V2_T.radius.sm,
    fontSize: V2_T.font.meta,
    fontWeight: 500,
    transition: 'background ' + V2_T.motion.fast + 'ms ease, border-color ' + V2_T.motion.fast + 'ms ease',
  }
  if (kind === 'primary') {
    return Object.assign(
      v2BtnStyle('primary', Object.assign(base, { background: V2_T.accent.base, borderColor: V2_T.accent.base, color: '#ffffff' })),
      extra || {},
    )
  }
  if (kind === 'soft') {
    return Object.assign(
      v2BtnStyle('soft', Object.assign(base, { background: V2_T.surface.panel2, borderColor: V2_T.border.subtle, color: V2_T.text.primary })),
      extra || {},
    )
  }
  if (kind === 'danger') {
    return Object.assign(
      v2BtnStyle('danger', Object.assign(base, { background: V2_T.status.dangerSoft, borderColor: 'rgba(255,138,138,0.36)', color: V2_T.status.danger })),
      extra || {},
    )
  }
  return Object.assign(v2BtnStyle('ghost', Object.assign(base, { color: V2_T.text.secondary })), extra || {})
}

function v2NotesIconBtnStyle(extra) {
  return Object.assign({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    padding: 0,
    border: 'none',
    background: 'transparent',
    borderRadius: V2_T.radius.sm,
    color: V2_T.text.secondary,
    cursor: 'pointer',
    flex: '0 0 auto',
    fontFamily: COLORS.fontFamily,
    transition: 'background ' + V2_T.motion.fast + 'ms ease, color ' + V2_T.motion.fast + 'ms ease',
  }, extra || {})
}

function v2NotesOpenMenu(x, y, items) {
  const wrapper = document.createElement('div')
  wrapper.style.position = 'fixed'
  wrapper.style.left = Math.max(8, Math.min(x, window.innerWidth - 210)) + 'px'
  wrapper.style.top = Math.max(8, y) + 'px'
  wrapper.style.zIndex = '99999'
  wrapper.style.background = V2_T.surface.panel2
  wrapper.style.border = '1px solid ' + V2_T.border.subtle
  wrapper.style.borderRadius = V2_T.radius.md
  wrapper.style.padding = '4px'
  wrapper.style.boxShadow = V2_T.shadow.pop
  wrapper.style.minWidth = '178px'
  let closed = false
  function close() {
    if (closed) return
    closed = true
    if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper)
    document.removeEventListener('mousedown', onOutside, true)
    document.removeEventListener('keydown', onEsc, true)
  }
  function onOutside(event) {
    if (!wrapper.contains(event.target)) close()
  }
  function onEsc(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }
  ;(items || []).forEach(function render(item) {
    if (!item) return
    if (item.type === 'separator') {
      const separator = document.createElement('div')
      separator.style.height = '1px'
      separator.style.background = V2_T.border.subtle
      separator.style.margin = '4px 6px'
      wrapper.appendChild(separator)
      return
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.style.display = 'flex'
    button.style.alignItems = 'center'
    button.style.gap = '8px'
    button.style.width = '100%'
    button.style.background = 'transparent'
    button.style.border = 'none'
    button.style.color = item.danger ? V2_T.status.danger : V2_T.text.primary
    button.style.fontFamily = COLORS.fontFamily
    button.style.fontSize = V2_T.font.meta + 'px'
    button.style.padding = '7px 10px'
    button.style.borderRadius = '6px'
    button.style.cursor = 'pointer'
    button.style.textAlign = 'left'
    try {
      const icon = document.createElement('span')
      icon.style.display = 'inline-flex'
      icon.style.width = '14px'
      icon.style.height = '14px'
      const paths = (typeof V2_ICON_PATHS === 'object' && V2_ICON_PATHS && V2_ICON_PATHS[item.icon]) || []
      if (paths.length) {
        const svgNs = 'http://www.w3.org/2000/svg'
        const svg = document.createElementNS(svgNs, 'svg')
        svg.setAttribute('viewBox', '0 0 24 24')
        svg.setAttribute('width', '13')
        svg.setAttribute('height', '13')
        svg.setAttribute('fill', 'none')
        svg.setAttribute('stroke', 'currentColor')
        svg.setAttribute('stroke-width', '1.7')
        svg.setAttribute('stroke-linecap', 'round')
        svg.setAttribute('stroke-linejoin', 'round')
        paths.forEach(function eachPath(d) {
          const pathNode = document.createElementNS(svgNs, 'path')
          pathNode.setAttribute('d', d)
          svg.appendChild(pathNode)
        })
        icon.appendChild(svg)
      }
      button.appendChild(icon)
    } catch (error) {
      /* icon 失败不影响菜单 */
    }
    const label = document.createElement('span')
    label.textContent = item.label
    label.style.flex = '1 1 auto'
    button.appendChild(label)
    button.addEventListener('mouseenter', function enter() { button.style.background = V2_T.surface.panel3 })
    button.addEventListener('mouseleave', function leave() { button.style.background = 'transparent' })
    button.addEventListener('click', function click() {
      close()
      try {
        item.onClick()
      } catch (error) {
        try { console.warn('[notes] menu action failed', error) } catch (ignore) {}
      }
    })
    wrapper.appendChild(button)
  })
  document.body.appendChild(wrapper)
  setTimeout(function bind() {
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown', onEsc, true)
  }, 0)
}

/* ---------------- 弹窗组件 ---------------- */

function V2NotesModal(props) {
  useEffect(function bindEscape() {
    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (props.onCancel) props.onCancel()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return function cleanup() {
      document.removeEventListener('keydown', onKey, true)
    }
  }, [])
  return h(
    'div',
    {
      onMouseDown: function onMouseDown(event) {
        if (event.target === event.currentTarget && props.onCancel) props.onCancel()
      },
      style: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        background: V2_T.surface.overlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
        padding: 16,
      },
    },
    h(
      'div',
      {
        style: {
          width: '100%',
          maxWidth: props.width || 430,
          background: V2_T.surface.panel,
          border: '1px solid ' + V2_T.border.subtle,
          borderRadius: V2_T.radius.lg,
          boxShadow: V2_T.shadow.pop,
          padding: '16px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          color: V2_T.text.primary,
          fontFamily: COLORS.fontFamily,
        },
      },
      h('div', { style: { fontSize: V2_T.font.title, fontWeight: 600, color: V2_T.text.primary } }, props.title || ''),
      props.children,
      props.footer ? h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 } }, props.footer) : null,
    ),
  )
}

function V2NotesPrompt(props) {
  const [value, setValue] = useState(props.initial === undefined ? '' : String(props.initial))
  const inputRef = useRef(null)
  useEffect(function focusInput() {
    const node = inputRef.current
    if (!node) return
    try {
      node.focus()
      node.select()
    } catch (error) {
      /* ignore */
    }
  }, [])
  function submit() {
    const text = String(value || '').trim()
    if (props.required !== false && !text) return
    if (props.onSubmit) props.onSubmit(text)
  }
  const footer = h(
    'div',
    { style: { display: 'flex', gap: 8 } },
    h('button', { key: 'cancel', type: 'button', onClick: props.onCancel, style: v2NotesBtnStyle('ghost', { fontSize: 11 }) }, '取消'),
    h('button', { key: 'ok', type: 'button', onClick: submit, style: v2NotesBtnStyle('primary', { fontSize: 11 }) }, props.submitLabel || '确定'),
  )
  return h(
    V2NotesModal,
    { title: props.title, onCancel: props.onCancel, footer: footer },
    props.label ? h('div', { style: { fontSize: 11, color: V2.sub } }, props.label) : null,
    h('input', {
      ref: inputRef,
      value: value,
      placeholder: props.placeholder || '',
      onChange: function onChange(event) { setValue(event.target.value) },
      onKeyDown: function onKeyDown(event) {
        if (event.key === 'Enter') {
          event.preventDefault()
          submit()
        }
      },
      style: Object.assign(v2InputStyle({ fontSize: V2_T.font.body }), {
        height: V2_T.line.input,
        background: V2_T.surface.input,
        border: '1px solid ' + V2_T.border.subtle,
        borderRadius: V2_T.radius.md,
        padding: '0 10px',
        color: V2_T.text.primary,
      }),
    }),
    props.hint ? h('div', { style: { fontSize: 10, color: V2.faint, lineHeight: '16px' } }, props.hint) : null,
  )
}

function V2NotesConfirm(props) {
  const footer = h(
    'div',
    { style: { display: 'flex', gap: 8 } },
    h('button', { key: 'cancel', type: 'button', onClick: props.onCancel, style: v2NotesBtnStyle('ghost', { fontSize: 11 }) }, props.cancelLabel || '取消'),
    h(
      'button',
      {
        key: 'ok',
        type: 'button',
        onClick: props.onSubmit,
        disabled: props.busy === true,
        style: v2NotesBtnStyle(props.danger ? 'danger' : 'primary', { fontSize: 11, opacity: props.busy ? 0.6 : 1 }),
      },
      props.submitLabel || '确定',
    ),
  )
  return h(
    V2NotesModal,
    { title: props.title, onCancel: props.onCancel, footer: footer },
    h('div', { style: { fontSize: 12, color: V2.sub, lineHeight: '19px' } }, props.message || ''),
    props.items && props.items.length
      ? h(
          'div',
          { style: { maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2 } },
          props.items.map(function each(item, index) {
            return h(
              'div',
              {
                key: 'item_' + index,
                style: {
                  fontSize: V2_T.font.caption + 1,
                  color: V2_T.text.secondary,
                  padding: '4px 8px',
                  borderRadius: V2_T.radius.sm,
                  background: V2_T.surface.panel2,
                  border: '1px solid ' + V2_T.border.subtle,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              item,
            )
          }),
        )
      : null,
  )
}

function V2NotesDirPicker(props) {
  const [value, setValue] = useState(props.initial === undefined ? '' : String(props.initial))
  const options = [{ path: '', label: '工作区根目录' }].concat(
    (props.dirs || []).map(function map(path) { return { path: path, label: path } }),
  )
  const footer = h(
    'div',
    { style: { display: 'flex', gap: 8 } },
    h('button', { key: 'cancel', type: 'button', onClick: props.onCancel, style: v2NotesBtnStyle('ghost', { fontSize: 11 }) }, '取消'),
    h(
      'button',
      { key: 'ok', type: 'button', onClick: function onClick() { if (props.onSubmit) props.onSubmit(value) }, style: v2NotesBtnStyle('primary', { fontSize: 11 }) },
      props.submitLabel || '移动到这里',
    ),
  )
  return h(
    V2NotesModal,
    { title: props.title || '移动到文件夹', onCancel: props.onCancel, footer: footer },
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 280, overflowY: 'auto' } },
      options.map(function each(option) {
        const active = value === option.path
        return h(
          'button',
          {
            key: 'opt_' + option.path,
            type: 'button',
            onClick: function onClick() { setValue(option.path) },
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              height: 32,
              padding: '0 10px',
              border: '1px solid ' + (active ? V2_T.accent.line : 'transparent'),
              borderRadius: V2_T.radius.sm,
              background: active ? V2_T.accent.soft : 'transparent',
              color: active ? V2_T.accent.base : V2_T.text.secondary,
              fontSize: V2_T.font.body,
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: COLORS.fontFamily,
            },
          },
          h(V2Icon, { name: 'folder', size: 13 }),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, option.label),
        )
      }),
    ),
  )
}

function V2NotesQuickNote(props) {
  const [text, setText] = useState('')
  const areaRef = useRef(null)
  useEffect(function focusArea() {
    if (areaRef.current) {
      try { areaRef.current.focus() } catch (error) { /* ignore */ }
    }
  }, [])
  function submit() {
    const value = String(text || '').trim()
    if (!value) return
    if (props.onSubmit) props.onSubmit(value)
  }
  const footer = h(
    'div',
    { style: { display: 'flex', gap: 8 } },
    h('button', { key: 'cancel', type: 'button', onClick: props.onCancel, style: v2NotesBtnStyle('ghost', { fontSize: 11 }) }, '取消'),
    h('button', { key: 'ok', type: 'button', onClick: submit, style: v2NotesBtnStyle('primary', { fontSize: 11 }) }, '记录'),
  )
  return h(
    V2NotesModal,
    { title: '快速记录', onCancel: props.onCancel, footer: footer },
    h('div', { style: { fontSize: 11, color: V2.faint, lineHeight: '17px' } }, '内容会写入当前目录的今日日期笔记。'),
    h('textarea', {
      ref: areaRef,
      value: text,
      rows: 5,
      onChange: function onChange(event) { setText(event.target.value) },
      onKeyDown: function onKeyDown(event) {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault()
          submit()
        }
      },
      placeholder: '记点什么…',
      style: {
        width: '100%',
        boxSizing: 'border-box',
        resize: 'vertical',
        background: V2_T.surface.input,
        border: '1px solid ' + V2_T.border.subtle,
        borderRadius: V2_T.radius.md,
        color: V2_T.text.primary,
        fontFamily: COLORS.fontFamily,
        fontSize: V2_T.font.body,
        lineHeight: '20px',
        padding: '10px 12px',
        outline: 'none',
      },
    }),
  )
}

function V2NotesSetupGuide(props) {
  const notes = props.notes
  const state = props.state || {}
  const config = state.config || {}
  const data = config.data || {}
  const [dir, setDir] = useState(String(data.dir || ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)
  useEffect(function focusInput() {
    if (inputRef.current) {
      try { inputRef.current.focus() } catch (ignore) { /* ignore */ }
    }
  }, [])
  const displayError = error || config.error || ''
  function submit() {
    if (busy) return
    const value = String(dir || '').trim()
    if (!value) {
      setError('请填写笔记文件夹的完整路径')
      return
    }
    setBusy(true)
    setError('')
    let promise = null
    try {
      promise = notes.setConfig(value, true)
    } catch (err) {
      setBusy(false)
      setError(errorText(err) || '目录设置失败')
      return
    }
    if (promise && typeof promise.finally === 'function') {
      promise.finally(function done() { setBusy(false) })
    } else {
      setBusy(false)
    }
  }
  return h(
    'div',
    {
      style: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 24px',
        scrollbarColor: V2_T.border.subtle + ' transparent',
      },
    },
    h(
      'div',
      {
        style: v2CardStyle({
          width: '100%',
          maxWidth: 420,
          padding: V2_T.space.x6,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }),
      },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h(V2Icon, { name: 'folder', size: 18, color: V2_T.accent.base }),
        h('div', { style: v2TextStyle('title') }, '配置笔记目录'),
      ),
      h(
        'div',
        { style: { fontSize: V2_T.font.meta, color: V2_T.text.secondary, lineHeight: '19px' } },
        'LifeOS 使用本地文件夹存放 Markdown 笔记。请指定一个文件夹（不存在时会自动创建），所有内容只保存在你的磁盘上。',
      ),
      h(
        'div',
        { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary, lineHeight: '18px' } },
        '推荐结构：日记/YYYY-MM-DD.md、随记/*.md，其余目录可以当作笔记本使用。',
      ),
      h('input', {
        ref: inputRef,
        value: dir,
        placeholder: '例如 C:\\Users\\你\\Documents\\LifeOS\\Notes',
        onChange: function onChange(event) { setDir(event.target.value) },
        onKeyDown: function onKeyDown(event) {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        },
        style: Object.assign(v2InputStyle({ fontSize: V2_T.font.body }), {
          height: V2_T.line.input,
          background: V2_T.surface.input,
          border: '1px solid ' + V2_T.border.subtle,
          borderRadius: V2_T.radius.md,
          padding: '0 10px',
          color: V2_T.text.primary,
        }),
      }),
      displayError ? h('div', { style: { fontSize: V2_T.font.caption, color: V2_T.status.danger, lineHeight: '17px' } }, displayError) : null,
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 } },
        h('button', { type: 'button', onClick: submit, disabled: busy, style: v2NotesBtnStyle('primary', { height: 32, fontSize: V2_T.font.meta + 1, opacity: busy ? 0.6 : 1 }) }, busy ? '正在校验…' : '校验并创建'),
        h(
          'button',
          {
            type: 'button',
            onClick: function onClick() {
              try { notes.loadConfig() } catch (err) { /* ignore */ }
            },
            style: v2NotesBtnStyle('soft', { height: 32, fontSize: V2_T.font.meta + 1 }),
          },
          '重新检测',
        ),
        h('span', { style: { flex: '1 1 auto' } }),
        h('span', { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary } }, '路径保存在本机 Host 设置中'),
      ),
    ),
  )
}

/* ---------------- 主组件 ---------------- */

function NotesTabV2(props) {
  const runtime = props.runtime
  const notes = props.notes
  const narrow = props.narrow === true
  const fallbackState = { phase: 'idle', mock: false, config: {}, tree: {}, search: {}, doc: {}, preview: false }
  const notesState = props.notesState || (notes && typeof notes.getState === 'function' ? notes.getState() : null) || fallbackState

  const config = notesState.config || {}
  const configData = config.data || {}
  const treeState = notesState.tree || {}
  const entries = Array.isArray(treeState.entries) ? treeState.entries : []
  const expandedMap = treeState.expanded || {}
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [dialog, setDialog] = useState(null)
  const [selMode, setSelMode] = useState(false)
  const [selected, setSelected] = useState({})
  const [groups, setGroups] = useState({ diary: true, scratch: true })
  const [showAll, setShowAll] = useState({ diary: false, scratch: false })
  const [expandedLocal, setExpandedLocal] = useState({})
  const [tagMap, setTagMap] = useState(v2NotesLoadTags)
  const [tagRemote, setTagRemote] = useState(true)
  const [tagEditing, setTagEditing] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  const [mobileView, setMobileView] = useState('tree')
  const [titleDraft, setTitleDraft] = useState('')
  const [batchBusy, setBatchBusy] = useState(false)
  const [dragOver, setDragOver] = useState('')
  const [panes, setPanes] = useState(v2NotesReadPanes)
  const [paneWidth, setPaneWidth] = useState(0)
  const dragPathRef = useRef('')
  const editorRef = useRef(null)
  const searchRef = useRef(null)
  const tagInputRef = useRef(null)
  const scratchRef = useRef({})
  const mountedRef = useRef(true)
  const panesContainerRef = useRef(null)
  const panesRef = useRef(panes)
  panesRef.current = panes
  const paneWidthRef = useRef(paneWidth)
  paneWidthRef.current = paneWidth

  function updatePanes(patch) {
    setPanes(function merge(prev) {
      const next = Object.assign({}, prev, patch)
      v2NotesSavePanes(next)
      return next
    })
  }

  function beginPaneResize(kind, event) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startTree = panesRef.current.treeWidth
    const startEditor = panesRef.current.editorWidth
    function onMove(moveEvent) {
      const delta = moveEvent.clientX - startX
      if (kind === 'tree') {
        updatePanes({ treeWidth: v2NotesClamp(startTree + delta, V2_NOTES_TREE_MIN, V2_NOTES_TREE_MAX) })
        return
      }
      const base = startEditor === null ? v2NotesAutoEditorWidth() : startEditor
      updatePanes({ editorWidth: v2NotesClamp(base + delta, V2_NOTES_EDITOR_MIN, V2_NOTES_EDITOR_MAX) })
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }

  function v2NotesAutoEditorWidth() {
    const containerWidth = paneWidthRef.current || 0
    const treeWidth = panesRef.current.treeWidth
    const available = Math.max(0, containerWidth - treeWidth - 6)
    if (!available) return V2_NOTES_EDITOR_MIN
    return v2NotesClamp(Math.round(available / 2), V2_NOTES_EDITOR_MIN, Math.min(V2_NOTES_EDITOR_MAX, Math.max(V2_NOTES_EDITOR_MIN, available)))
  }
  /* 多选锚点：最近一次普通/Ctrl 单击的条目路径，Shift 范围选择的起点（跨重渲染保持） */
  const selectAnchorRef = useRef('')

  const configPhase = config.phase || 'idle'
  const mock = notesState.mock === true
  const setupRequired = !mock && configPhase === 'ready' && configData.exists !== true
  const configLoading = !mock && !setupRequired && (configPhase === 'idle' || configPhase === 'loading')
  const configReady = mock || configData.exists === true
  const doc = notesState.doc || {}
  const search = notesState.search || {}
  const preview = notesState.preview === true
  const treeLoading = treeState.phase === 'loading' || (treeState.phase !== 'ready' && treeState.phase !== 'error')
  const notesPrefs = useMemo(function readNotesPrefs() {
    return v2ReadSettings()
  }, [])
  const notesFontSize = notesPrefs.notesFontSize || 13.5
  const saveDelay = notesPrefs.notesAutosaveMs || (configData.options && configData.options.autosaveMs) || 800
  const workNodes = useMemo(function buildTree() { return v2NotesBuildTree(entries) }, [entries])
  const allDirs = useMemo(function buildDirs() {
    const seen = {}
    const list = []
    entries.forEach(function each(entry) {
      if (!entry || entry.type !== 'dir') return
      const segments = String(entry.path).split('/')
      for (let index = 0; index < segments.length; index += 1) {
        const path = segments.slice(0, index + 1).join('/')
        if (!seen[path]) {
          seen[path] = true
          list.push(path)
        }
      }
    })
    list.sort(function sort(a, b) { return String(a).localeCompare(String(b), 'zh-CN') })
    return list
  }, [entries])
  const selectedPaths = Object.keys(selected)
  const totalNotes = entries.filter(function filter(entry) { return entry && entry.type !== 'dir' }).length
  const docTags = doc.path && Array.isArray(tagMap[doc.path]) ? tagMap[doc.path] : []

  function readState() {
    try {
      return notes.getState()
    } catch (error) {
      return notesState
    }
  }

  function notify(kind, message) {
    try {
      runtime.toast(kind, message)
    } catch (error) {
      try { console.warn('[notes] ' + message) } catch (ignore) { /* ignore */ }
    }
  }

  function currentPath() {
    const state = readState()
    return (state.doc && state.doc.path) || ''
  }

  function currentDir() {
    const path = currentPath()
    return path ? v2NotesDirName(path) : ''
  }

  function treeEntries() {
    const state = readState()
    return (state.tree && Array.isArray(state.tree.entries)) ? state.tree.entries : []
  }

  function pathExists(fullPath) {
    return treeEntries().some(function some(entry) { return entry && entry.path === fullPath })
  }

  function fileExistsIn(dirPath, name) {
    return pathExists(v2NotesJoin(dirPath, name))
  }

  function isDirPath(path) {
    return treeEntries().some(function some(entry) { return entry && entry.type === 'dir' && entry.path === path })
  }

  function isExpanded(path) {
    if (expandedLocal[path] !== undefined) return expandedLocal[path] === true
    return expandedMap[path] === true
  }

  function toggleDirNode(path) {
    setExpandedLocal(function toggle(prev) {
      const current = prev[path] !== undefined ? prev[path] === true : expandedMap[path] === true
      const next = Object.assign({}, prev)
      next[path] = !current
      return next
    })
  }

  function expandAncestors(path) {
    const segments = String(path || '').split('/')
    if (segments.length < 2) return
    segments.pop()
    setExpandedLocal(function merge(prev) {
      let changed = false
      const next = Object.assign({}, prev)
      let current = ''
      segments.forEach(function each(segment) {
        current = current ? current + '/' + segment : segment
        if (next[current] !== true) {
          next[current] = true
          changed = true
        }
      })
      return changed ? next : prev
    })
  }

  function toggleSelect(path) {
    setSelected(function toggle(prev) {
      const next = Object.assign({}, prev)
      if (next[path]) delete next[path]
      else next[path] = true
      return next
    })
  }

  function enterSelMode() {
    setSelMode(true)
    setSelected({})
    selectAnchorRef.current = ''
  }

  function exitSelMode() {
    setSelMode(false)
    setSelected({})
    selectAnchorRef.current = ''
  }

  /* 当前可见条目的扁平行顺序：快捷分组可见行（最近 5 条 / 展开全部）+ 工作区树展开行。
     同一路径可能同时出现在快捷分组和工作区树里，这里只保留首次出现。 */
  function visibleNotesOrder() {
    const order = []
    const seen = {}
    function push(path) {
      if (!path || seen[path]) return
      seen[path] = true
      order.push(path)
    }
    function pushQuickGroup(kind) {
      if (!(kind === 'diary' ? groups.diary : groups.scratch)) return
      const dir = kind === 'diary' ? V2_NOTES_DIARY_DIR : V2_NOTES_SCRATCH_DIR
      const files = entries
        .filter(function filter(entry) { return entry && entry.type !== 'dir' && v2NotesDirName(entry.path) === dir })
        .sort(function sort(a, b) { return v2NotesMtimeValue(b) - v2NotesMtimeValue(a) })
      const showAllFlag = kind === 'diary' ? showAll.diary : showAll.scratch
      const visible = showAllFlag ? files : files.slice(0, V2_NOTES_RECENT_LIMIT)
      visible.forEach(function each(entry) { push(entry.path) })
    }
    function walk(nodes) {
      ;(nodes || []).forEach(function each(node) {
        if (!node || !node.path) return
        push(node.path)
        if (node.type === 'dir' && node.children && node.children.length && isExpanded(node.path)) {
          walk(node.children)
        }
      })
    }
    pushQuickGroup('diary')
    pushQuickGroup('scratch')
    walk(workNodes)
    return order
  }

  /* 按可见顺序把 anchor→target 之间的全部条目选中；additive 为 true 时并入已有选择 */
  function selectRange(anchor, target, additive) {
    const order = visibleNotesOrder()
    const from = order.indexOf(anchor)
    const to = order.indexOf(target)
    if (from < 0 || to < 0) return false
    const start = Math.min(from, to)
    const end = Math.max(from, to)
    if (additive) {
      setSelected(function merge(prev) {
        const next = Object.assign({}, prev)
        for (let index = start; index <= end; index += 1) next[order[index]] = true
        return next
      })
      return true
    }
    const next = {}
    for (let index = start; index <= end; index += 1) next[order[index]] = true
    setSelected(next)
    return true
  }

  /* 目录树行点击：
     - 普通单击维持原行为（文件打开；文件夹展开/折叠；多选模式下文件切换选中）
     - Ctrl/Cmd+单击：切换该文件/文件夹选中，不打开文件
     - Shift+单击：以上次点击为锚点，按当前可见顺序选中首尾之间全部条目 */
  function handleTreeRowClick(event, path, kind) {
    const additive = !!(event && (event.ctrlKey || event.metaKey))
    const ranged = !!(event && event.shiftKey)
    if (ranged) {
      if (event) {
        event.preventDefault()
        event.stopPropagation()
      }
      if (!selMode) setSelMode(true)
      const anchor = selectAnchorRef.current
      if (anchor && anchor !== path && selectRange(anchor, path, additive)) return
      if (anchor === path) return
      /* 无有效锚点（首次 Shift 或锚点行已被折叠隐藏）：Shift 只选中当前行，不做反选 */
      setSelected(function selectTarget(prev) {
        if (additive) {
          const merged = Object.assign({}, prev)
          merged[path] = true
          return merged
        }
        const next = {}
        next[path] = true
        return next
      })
      selectAnchorRef.current = path
      return
    }
    if (additive) {
      if (event) {
        event.preventDefault()
        event.stopPropagation()
      }
      if (!selMode) setSelMode(true)
      toggleSelect(path)
      selectAnchorRef.current = path
      return
    }
    selectAnchorRef.current = path
    if (kind === 'dir') {
      toggleDirNode(path)
      return
    }
    if (selMode) {
      toggleSelect(path)
      return
    }
    openNote(path)
  }

  function closeDialog() {
    setDialog(null)
  }

  /* ---------- 数据读写 ---------- */

  async function refreshTree() {
    try {
      await notes.loadTree()
    } catch (error) {
      notify('error', '刷新文件树失败：' + errorText(error))
    }
  }

  async function ensureFolder(name) {
    const exists = treeEntries().some(function some(entry) { return entry && entry.type === 'dir' && entry.path === name })
    if (exists) return true
    try {
      await notes.createFolder('', name)
    } catch (error) {
      notify('error', '创建文件夹失败：' + errorText(error))
      return false
    }
    await refreshTree()
    return true
  }

  async function openNote(path, options) {
    if (!path) return
    const state = readState()
    const docState = state.doc || {}
    if (docState.path === path && docState.phase === 'ready') {
      if (narrow) setMobileView('editor')
      return
    }
    if (docState.dirty && !(options && options.discard)) {
      try { await notes.saveNow(false) } catch (error) { /* runtime 已处理 */ }
      const after = readState()
      if (after.doc && after.doc.dirty) {
        setDialog({ kind: 'switch-dirty', path: path })
        return
      }
    }
    expandAncestors(path)
    try {
      await notes.openFile(path)
    } catch (error) {
      notify('error', '打开笔记失败：' + errorText(error))
      return
    }
    if (narrow) setMobileView('editor')
  }

  async function forceOpen(path) {
    setDialog(null)
    expandAncestors(path)
    try { await notes.openFile(path) } catch (error) { notify('error', '打开笔记失败：' + errorText(error)) }
    if (narrow) setMobileView('editor')
  }

  async function submitNewNote(dirPath, rawName) {
    setDialog(null)
    const targetDir = String(dirPath || '')
    const cleaned = v2NotesSanitizeName(v2NotesStripExt(rawName), '')
    try {
      if (!cleaned) {
        await notes.createNote(targetDir)
      } else {
        const name = v2NotesUniqueName(cleaned + '.md', function exists(candidate) { return fileExistsIn(targetDir, candidate) })
        await notes.createNote(targetDir, name)
      }
      const after = readState()
      const path = after.doc && after.doc.path
      if (path) {
        expandAncestors(path)
        if (narrow) setMobileView('editor')
      }
    } catch (error) {
      const message = errorText(error) || ''
      if (/exist|已存在/i.test(message)) {
        const target = v2NotesJoin(targetDir, cleaned + '.md')
        await openNote(target)
        return
      }
      notify('error', '新建笔记失败：' + message)
    }
  }

  async function submitNewFolder(parentDir, rawName) {
    setDialog(null)
    const name = v2NotesSanitizeName(rawName, '')
    if (!name) {
      notify('error', '文件夹名称不能为空')
      return
    }
    const dirPath = String(parentDir || '')
    const target = v2NotesJoin(dirPath, name)
    if (pathExists(target)) {
      notify('error', '已存在同名文件夹或笔记')
      return
    }
    try {
      await notes.createFolder(dirPath, name)
      setExpandedLocal(function expand(prev) { return Object.assign({}, prev, { [target]: true }) })
      await refreshTree()
    } catch (error) {
      notify('error', '新建文件夹失败：' + errorText(error))
    }
  }

  async function createDiary() {
    const ok = await ensureFolder(V2_NOTES_DIARY_DIR)
    if (!ok) return
    const target = V2_NOTES_DIARY_DIR + '/' + todayIso() + '.md'
    if (pathExists(target)) {
      await openNote(target)
      notify('success', '已打开今日日记')
      return
    }
    try {
      await notes.createNote(V2_NOTES_DIARY_DIR, todayIso() + '.md')
      const after = readState()
      const path = after.doc && after.doc.path
      if (path) expandAncestors(path)
      if (narrow) setMobileView('editor')
    } catch (error) {
      const message = errorText(error) || ''
      if (/exist|已存在/i.test(message)) {
        await openNote(target)
        return
      }
      notify('error', '新建日记失败：' + message)
    }
  }

  async function createScratch() {
    const ok = await ensureFolder(V2_NOTES_SCRATCH_DIR)
    if (!ok) return
    try {
      const name = v2NotesUniqueName('未命名笔记.md', function exists(candidate) { return fileExistsIn(V2_NOTES_SCRATCH_DIR, candidate) })
      await notes.createNote(V2_NOTES_SCRATCH_DIR, name)
      const after = readState()
      const path = after.doc && after.doc.path
      if (path) {
        scratchRef.current[path] = true
        expandAncestors(path)
        if (narrow) setMobileView('editor')
        notify('success', '已新建随记，输入正文后会自动命名')
      }
    } catch (error) {
      notify('error', '新建随记失败：' + errorText(error))
    }
  }

  async function submitRenameNote(rawName) {
    const state = readState()
    const docState = state.doc || {}
    setDialog(null)
    if (!docState.path) return
    const cleaned = v2NotesSanitizeName(v2NotesStripExt(rawName), '')
    if (!cleaned) {
      notify('error', '名称不能为空')
      return
    }
    if (v2NotesStripExt(docState.name) === cleaned) return
    const dir = v2NotesDirName(docState.path)
    const ext = v2NotesExt(docState.name)
    const target = v2NotesUniqueName(cleaned + ext, function exists(candidate) {
      const full = v2NotesJoin(dir, candidate)
      return full !== docState.path && pathExists(full)
    })
    try {
      await notes.renamePath(docState.path, target)
    } catch (error) {
      notify('error', '重命名失败：' + errorText(error))
    }
  }

  async function submitRenameDir(path, rawName) {
    setDialog(null)
    const cleaned = v2NotesSanitizeName(rawName, '')
    if (!cleaned) {
      notify('error', '名称不能为空')
      return
    }
    const parent = v2NotesDirName(path)
    const base = v2NotesBaseName(path)
    if (cleaned === base) return
    const target = v2NotesUniqueName(cleaned, function exists(candidate) {
      const full = v2NotesJoin(parent, candidate)
      return full !== path && pathExists(full)
    })
    try {
      await notes.renamePath(path, target)
    } catch (error) {
      notify('error', '重命名文件夹失败：' + errorText(error))
    }
  }

  async function deletePaths(paths) {
    setDialog(null)
    if (!paths || !paths.length) return
    setBatchBusy(true)
    let failed = 0
    for (let index = 0; index < paths.length; index += 1) {
      try {
        await notes.removePath(paths[index])
      } catch (error) {
        failed += 1
      }
    }
    setBatchBusy(false)
    exitSelMode()
    if (failed) notify('error', '有 ' + failed + ' 项删除失败')
    else notify('success', paths.length > 1 ? '已删除 ' + paths.length + ' 项（可在 .trash 恢复）' : '已删除（可在 .trash 恢复）')
    refreshTree()
  }

  async function movePaths(paths, targetDir) {
    setDialog(null)
    if (!paths || !paths.length) return
    setBatchBusy(true)
    let moved = 0
    let failed = 0
    for (let index = 0; index < paths.length; index += 1) {
      const source = paths[index]
      const base = v2NotesBaseName(source)
      if (!base) continue
      const sourceIsDir = isDirPath(source)
      const dirTarget = String(targetDir || '')
      if (dirTarget === source || (sourceIsDir && dirTarget.indexOf(source + '/') === 0)) {
        failed += 1
        continue
      }
      const name = v2NotesUniqueName(base, function exists(candidate) {
        const full = v2NotesJoin(dirTarget, candidate)
        return full !== source && pathExists(full)
      })
      const dest = v2NotesJoin(dirTarget, name)
      if (dest === source) {
        moved += 1
        continue
      }
      try {
        await notes.renamePath(source, v2NotesMoveTarget(dirTarget, name))
        moved += 1
      } catch (error) {
        failed += 1
      }
    }
    setBatchBusy(false)
    exitSelMode()
    if (moved) notify('success', '已移动 ' + moved + ' 项到 ' + (targetDir || '工作区根目录'))
    if (failed) notify('error', '有 ' + failed + ' 项移动失败')
    refreshTree()
    const state = readState()
    const docPath = (state.doc && state.doc.path) || ''
    if (docPath.indexOf('./') === 0) {
      try { await notes.openFile(docPath.slice(2)) } catch (error) { /* ignore */ }
    }
  }

  function applyTagsTo(paths, transform) {
    const next = Object.assign({}, tagMap)
    paths.forEach(function each(path) {
      if (isDirPath(path)) return
      const list = Array.isArray(next[path]) ? next[path].slice() : []
      const result = transform(list)
      if (result && result.length) next[path] = result
      else delete next[path]
    })
    setTagMap(next)
    v2NotesPersistTags(next)
    if (tagRemote) {
      try {
        const promise = apiRequest('/notes/tags', { method: 'PUT', body: JSON.stringify({ tags: next }) })
        if (promise && typeof promise.catch === 'function') promise.catch(function ignore() { setTagRemote(false) })
      } catch (error) {
        setTagRemote(false)
      }
    }
  }

  function addTagToCurrent(rawTag) {
    const tag = v2NotesCleanTag(rawTag)
    const path = currentPath()
    if (!tag || !path) {
      setTagEditing(false)
      setTagDraft('')
      return
    }
    applyTagsTo([path], function push(list) {
      if (list.indexOf(tag) === -1) list.push(tag)
      return list
    })
    setTagEditing(false)
    setTagDraft('')
  }

  function removeTagFromCurrent(tag) {
    const path = currentPath()
    if (!path) return
    applyTagsTo([path], function remove(list) {
      return list.filter(function filter(item) { return item !== tag })
    })
  }

  /* ---------- 编辑器操作 ---------- */

  function saveNow(force) {
    try {
      notes.saveNow(force === undefined ? true : force === true)
    } catch (error) {
      notify('error', '保存失败：' + errorText(error))
    }
  }

  function runNotesAction(action, label) {
    try {
      const result = action()
      if (result && typeof result.catch === 'function') {
        result.catch(function onError(error) { notify('error', (label || '操作失败') + '：' + errorText(error)) })
      }
      return result
    } catch (error) {
      notify('error', (label || '操作失败') + '：' + errorText(error))
      return null
    }
  }

  function togglePreview() {
    try { notes.togglePreview() } catch (error) { notify('error', '切换预览失败：' + errorText(error)) }
  }

  function reloadCurrent() { runNotesAction(function reload() { return notes.reloadCurrent() }, '重新加载失败') }
  function overwriteCurrent() { runNotesAction(function overwrite() { return notes.overwriteCurrent() }, '覆盖保存失败') }
  function saveCopy() { runNotesAction(function copy() { return notes.saveCopy() }, '另存副本失败') }
  function snapshotNow() { runNotesAction(function snapshot() { return notes.snapshotNow() }, '创建快照失败') }
  function dismissExternal() { runNotesAction(function dismiss() { return notes.dismissExternal() }, '忽略外部修改失败') }

  function insertEditorText(text) {
    const node = editorRef.current
    if (!node) return
    const start = typeof node.selectionStart === 'number' ? node.selectionStart : String(node.value || '').length
    const end = typeof node.selectionEnd === 'number' ? node.selectionEnd : start
    const value = String(node.value || '')
    const next = value.slice(0, start) + text + value.slice(end)
    try {
      notes.editContent(next)
    } catch (error) {
      notify('error', '编辑失败：' + errorText(error))
    }
    const position = start + text.length
    setTimeout(function restore() {
      try {
        node.selectionStart = position
        node.selectionEnd = position
      } catch (error) { /* ignore */ }
    }, 0)
  }

  function onEditorKeyDown(event) {
    if ((event.metaKey || event.ctrlKey) && String(event.key || '').toLowerCase() === 's') {
      event.preventDefault()
      saveNow(true)
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      insertEditorText('  ')
    }
  }

  /* ---------- 拖拽 ---------- */

  function isDroppable(targetDir) {
    const source = dragPathRef.current
    if (!source) return false
    if (source === targetDir) return false
    if (v2NotesDirName(source) === targetDir) return false
    const sourceIsDir = isDirPath(source)
    if (sourceIsDir && (targetDir === source || targetDir.indexOf(source + '/') === 0)) return false
    return true
  }

  function handleDragStart(event, path) {
    dragPathRef.current = path
    setDragOver('')
    try {
      event.dataTransfer.setData('text/plain', path)
      event.dataTransfer.effectAllowed = 'move'
    } catch (error) { /* ignore */ }
  }

  function handleDrop(event, targetDir) {
    event.preventDefault()
    event.stopPropagation()
    const source = dragPathRef.current || (event.dataTransfer ? event.dataTransfer.getData('text/plain') : '')
    const droppable = isDroppable(String(targetDir || ''))
    setDragOver('')
    dragPathRef.current = ''
    if (!source) return
    if (!droppable) {
      if (source !== targetDir && v2NotesDirName(source) !== String(targetDir || '')) notify('error', '不能把文件夹移动到自身或其子目录内')
      return
    }
    movePaths([source], targetDir)
  }

  /* ---------- 菜单 ---------- */

  function openSidebarMenu(event) {
    const rect = event.currentTarget.getBoundingClientRect()
    v2NotesOpenMenu(Math.max(8, rect.right - 180), rect.bottom + 6, [
      { label: '新建今日日记', icon: 'calendar', onClick: createDiary },
      { label: '新建随记', icon: 'leaf', onClick: createScratch },
      { type: 'separator' },
      { label: '新建文件夹', icon: 'folder', onClick: function onClick() { setDialog({ kind: 'new-folder', dir: '' }) } },
      {
        label: selMode ? '退出多选' : '多选笔记',
        icon: 'check',
        onClick: function onClick() {
          if (selMode) exitSelMode()
          else enterSelMode()
        },
      },
      { type: 'separator' },
      { label: '刷新文件树', icon: 'refresh', onClick: function onClick() { refreshTree() } },
      { label: '设置笔记目录', icon: 'settings', onClick: function onClick() { setDialog({ kind: 'config-dir' }) } },
    ])
  }

  function openDocMenu(event) {
    const rect = event.currentTarget.getBoundingClientRect()
    const path = currentPath()
    if (!path) return
    v2NotesOpenMenu(Math.max(8, rect.right - 190), rect.bottom + 6, [
      { label: '重命名', icon: 'edit', onClick: function onClick() { setDialog({ kind: 'rename-note', initial: v2NotesStripExt(doc.name) }) } },
      { label: '移动到文件夹', icon: 'move', onClick: function onClick() { setDialog({ kind: 'move-paths', paths: [path], initialDir: v2NotesDirName(path) }) } },
      { label: '添加标签', icon: 'tag', onClick: function onClick() { setTagEditing(true) } },
      { type: 'separator' },
      { label: '立即保存', icon: 'check', onClick: function onClick() { saveNow(true) } },
      { label: '创建快照', icon: 'clock', onClick: snapshotNow },
      { label: '另存为副本', icon: 'copy', onClick: saveCopy },
      { type: 'separator' },
      { label: '删除笔记', icon: 'trash', danger: true, onClick: function onClick() { setDialog({ kind: 'delete-paths', paths: [path] }) } },
    ])
  }

  function openDirMenu(event, node) {
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    v2NotesOpenMenu(Math.max(8, rect.right - 180), rect.bottom + 4, [
      { label: '在此新建笔记', icon: 'plus', onClick: function onClick() { setDialog({ kind: 'new-note', dir: node.path }) } },
      { label: '新建子文件夹', icon: 'folder', onClick: function onClick() { setDialog({ kind: 'new-folder', dir: node.path }) } },
      { type: 'separator' },
      { label: '重命名文件夹', icon: 'edit', onClick: function onClick() { setDialog({ kind: 'rename-dir', path: node.path, initial: node.name }) } },
      { label: '删除文件夹', icon: 'trash', danger: true, onClick: function onClick() { setDialog({ kind: 'delete-paths', paths: [node.path] }) } },
    ])
  }

  /* ---------- 渲染：文件树 ---------- */

  function renderCheckbox(checked) {
    return h(
      'span',
      {
        style: {
          width: 14,
          height: 14,
          borderRadius: 4,
          border: '1px solid ' + (checked ? V2_T.accent.base : V2_T.border.strong),
          background: checked ? V2_T.accent.base : V2_T.surface.input,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: '0 0 auto',
        },
      },
      checked ? h(V2Icon, { name: 'check', size: 10, color: '#ffffff' }) : null,
    )
  }

  function renderFileRow(entry, depth, keyPrefix) {
    const active = doc.path === entry.path
    const dirty = active && doc.dirty === true
    const checked = selected[entry.path] === true
    const dropActive = dragOver === entry.path
    const rowBackground = dropActive ? V2_T.surface.panel3 : active ? V2_T.accent.soft : checked ? V2_T.surface.panel2 : 'transparent'
    return h(
      'div',
      {
        key: (keyPrefix || 'file') + ':' + entry.path,
        draggable: true,
        title: entry.path,
        onDragStart: function onDragStart(event) { handleDragStart(event, entry.path) },
        onDragEnd: function onDragEnd() { setDragOver('') },
        onDragOver: function onDragOver(event) {
          event.preventDefault()
          if (dragOver !== entry.path && isDroppable(v2NotesDirName(entry.path))) setDragOver(entry.path)
        },
        onDrop: function onDrop(event) { handleDrop(event, v2NotesDirName(entry.path)) },
        onClick: function onClick(event) { handleTreeRowClick(event, entry.path, 'file') },
        onMouseEnter: function onMouseEnter(event) {
          if (!active && !dropActive) event.currentTarget.style.background = V2_T.surface.panel2
        },
        onMouseLeave: function onMouseLeave(event) {
          event.currentTarget.style.background = rowBackground
        },
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 30,
          padding: '0 8px 0 ' + (8 + depth * 13) + 'px',
          borderRadius: V2_T.radius.sm,
          cursor: 'pointer',
          background: rowBackground,
          outline: dropActive ? '1px dashed ' + V2_T.accent.base : 'none',
          color: active ? V2_T.accent.base : V2_T.text.secondary,
          fontSize: V2_T.font.body,
          lineHeight: '20px',
          userSelect: 'none',
          transition: 'background ' + V2_T.motion.fast + 'ms ease',
        },
      },
      selMode ? renderCheckbox(checked) : null,
      h(V2Icon, { name: 'file', size: 13, color: active ? V2_T.accent.base : V2_T.text.tertiary }),
      h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, v2NotesStripExt(entry.name)),
      dirty
        ? h('span', {
            title: '有未保存修改',
            style: { width: 6, height: 6, borderRadius: '50%', background: V2_T.status.warn, flex: '0 0 auto' },
          })
        : null,
    )
  }

  function renderDirNode(node, depth) {
    const expanded = isExpanded(node.path)
    const dropActive = dragOver === node.path
    const checked = selected[node.path] === true
    const rowBackground = dropActive ? V2_T.surface.panel3 : checked ? V2_T.accent.soft : 'transparent'
    const rows = [
      h(
        'div',
        {
          key: 'dir:' + node.path,
          draggable: true,
          title: node.path,
          onDragStart: function onDragStart(event) { handleDragStart(event, node.path) },
          onDragEnd: function onDragEnd() { setDragOver('') },
          onDragOver: function onDragOver(event) {
            event.preventDefault()
            event.stopPropagation()
            if (isDroppable(node.path) && dragOver !== node.path) setDragOver(node.path)
          },
          onDragLeave: function onDragLeave() {
            if (dragOver === node.path) setDragOver('')
          },
          onDrop: function onDrop(event) { handleDrop(event, node.path) },
          onClick: function onClick(event) { handleTreeRowClick(event, node.path, 'dir') },
          onMouseEnter: function onMouseEnter(event) {
            if (!dropActive && !checked) event.currentTarget.style.background = V2_T.surface.panel2
          },
          onMouseLeave: function onMouseLeave(event) {
            event.currentTarget.style.background = rowBackground
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 30,
            padding: '0 6px 0 ' + (6 + depth * 13) + 'px',
            borderRadius: V2_T.radius.sm,
            cursor: 'pointer',
            background: rowBackground,
            outline: dropActive ? '1px dashed ' + V2_T.accent.base : 'none',
            color: checked ? V2_T.accent.base : V2_T.text.primary,
            fontSize: V2_T.font.body,
            lineHeight: '20px',
            userSelect: 'none',
            transition: 'background ' + V2_T.motion.fast + 'ms ease',
          },
        },
        selMode ? renderCheckbox(checked) : null,
        h(
          'span',
          { style: { width: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: V2_T.text.tertiary, flex: '0 0 auto' } },
          h(V2Icon, { name: expanded ? 'chevronDown' : 'chevronRight', size: 12 }),
        ),
        h(V2Icon, { name: 'folder', size: 13, color: V2_T.text.tertiary }),
        h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 } }, node.name),
        h(
          'button',
          {
            type: 'button',
            title: '文件夹操作',
            onMouseDown: function onMouseDown(event) { event.stopPropagation() },
            onClick: function onClick(event) { openDirMenu(event, node) },
            style: v2NotesIconBtnStyle({ width: 22, height: 22 }),
          },
          h(V2Icon, { name: 'more', size: 12 }),
        ),
      ),
    ]
    if (expanded && node.children && node.children.length) {
      rows.push(
        h(
          'div',
          { key: 'children:' + node.path },
          node.children.map(function map(child) { return renderNode(child, depth + 1) }),
        ),
      )
    }
    return h('div', { key: 'node:' + node.path }, rows)
  }

  function renderNode(node, depth) {
    if (!node) return null
    if (node.type === 'dir') return renderDirNode(node, depth)
    return renderFileRow(node.entry || { name: node.name, path: node.path, type: 'file' }, depth, 'work')
  }

  function renderQuickGroup(kind) {
    const isDiary = kind === 'diary'
    const meta = isDiary
      ? { label: '日记', dir: V2_NOTES_DIARY_DIR, icon: 'calendar', createLabel: '新建今日日记' }
      : { label: '随记', dir: V2_NOTES_SCRATCH_DIR, icon: 'leaf', createLabel: '新建随记' }
    const dirExists = entries.some(function some(entry) { return entry.type === 'dir' && entry.path === meta.dir })
    const files = entries
      .filter(function filter(entry) { return entry.type !== 'dir' && v2NotesDirName(entry.path) === meta.dir })
      .sort(function sort(a, b) { return v2NotesMtimeValue(b) - v2NotesMtimeValue(a) })
    const expanded = isDiary ? groups.diary : groups.scratch
    const showAllFlag = isDiary ? showAll.diary : showAll.scratch
    const visible = showAllFlag ? files : files.slice(0, V2_NOTES_RECENT_LIMIT)
    const dropActive = dragOver === 'group:' + kind
    function toggleGroup() {
      setGroups(function toggle(prev) {
        const next = Object.assign({}, prev)
        next[kind] = !(isDiary ? prev.diary : prev.scratch)
        return next
      })
    }
    const header = h(
      'div',
      {
        key: 'group:' + kind,
        onDragOver: function onDragOver(event) {
          if (!dirExists) return
          event.preventDefault()
          if (isDroppable(meta.dir) && dragOver !== 'group:' + kind) setDragOver('group:' + kind)
        },
        onDragLeave: function onDragLeave() {
          if (dragOver === 'group:' + kind) setDragOver('')
        },
        onDrop: function onDrop(event) { handleDrop(event, meta.dir) },
        onClick: toggleGroup,
        onMouseEnter: function onMouseEnter(event) {
          if (!dropActive) event.currentTarget.style.background = V2_T.surface.panel2
        },
        onMouseLeave: function onMouseLeave(event) {
          event.currentTarget.style.background = dropActive ? V2_T.surface.panel3 : 'transparent'
        },
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 30,
          marginTop: 10,
          padding: '0 8px',
          borderRadius: V2_T.radius.sm,
          cursor: 'pointer',
          background: dropActive ? V2_T.surface.panel3 : 'transparent',
          outline: dropActive ? '1px dashed ' + V2_T.accent.base : 'none',
          color: V2_T.text.tertiary,
          fontSize: V2_T.font.caption,
          fontWeight: 600,
          letterSpacing: '0.02em',
          lineHeight: '20px',
          userSelect: 'none',
          transition: 'background ' + V2_T.motion.fast + 'ms ease',
        },
      },
      h(V2Icon, { name: expanded ? 'chevronDown' : 'chevronRight', size: 12, color: V2_T.text.tertiary }),
      h(V2Icon, { name: meta.icon, size: 13, color: V2_T.text.tertiary }),
      h('span', { style: { flex: '1 1 auto', fontWeight: 600 } }, meta.label),
      h('span', { style: { fontSize: V2_T.font.caption, fontWeight: 400, color: V2_T.text.tertiary } }, String(files.length)),
      h(
        'button',
        {
          type: 'button',
          title: meta.createLabel,
          onMouseDown: function onMouseDown(event) { event.stopPropagation() },
          onClick: function onClick(event) {
            event.stopPropagation()
            if (isDiary) createDiary()
            else createScratch()
          },
          style: v2NotesIconBtnStyle({ width: 22, height: 22 }),
        },
        h(V2Icon, { name: 'plus', size: 12 }),
      ),
    )
    const body = []
    if (expanded) {
      body.push(h('div', { key: 'group-body:' + kind }, visible.map(function map(entry) { return renderFileRow(entry, 1, 'quick_' + kind) })))
      if (files.length > V2_NOTES_RECENT_LIMIT) {
        body.push(
          h(
            'button',
            {
              key: 'group-more:' + kind,
              type: 'button',
              onClick: function onClick(event) {
                event.stopPropagation()
                setShowAll(function toggle(prev) {
                  const next = Object.assign({}, prev)
                  next[kind] = !(isDiary ? prev.diary : prev.scratch)
                  return next
                })
              },
              style: {
                border: 'none',
                background: 'transparent',
                color: V2_T.accent.base,
                fontSize: V2_T.font.caption,
                cursor: 'pointer',
                padding: '3px 8px 6px ' + (8 + 1 * 13) + 'px',
                textAlign: 'left',
                fontFamily: COLORS.fontFamily,
              },
            },
            showAllFlag ? '收起' : '查看更多（共 ' + files.length + ' 篇）',
          ),
        )
      }
      if (!dirExists) {
        body.push(
          h(
            'div',
            { key: 'group-empty:' + kind, style: { padding: '4px 10px 6px 21px', fontSize: V2_T.font.caption, color: V2_T.text.tertiary, lineHeight: '16px' } },
            '还没有「' + meta.label + '」文件夹，点击右侧 ＋ 自动创建并新建。',
          ),
        )
      } else if (!files.length) {
        body.push(
          h('div', { key: 'group-none:' + kind, style: { padding: '4px 10px 6px 21px', fontSize: V2_T.font.caption, color: V2_T.text.tertiary } }, '暂无笔记'),
        )
      }
    }
    return h('div', { key: 'group-wrap:' + kind }, header, body)
  }

  function renderSearchResults() {
    const items = Array.isArray(search.items) ? search.items : []
    const loading = search.phase === 'loading' || (search.phase !== 'ready' && search.phase !== 'error')
    const message = loading ? '搜索中…' : items.length ? '找到 ' + items.length + ' 篇' : '未找到匹配笔记'
    return h(
      'div',
      { style: { padding: '2px 2px 10px' } },
      h('div', { style: { padding: '2px 8px 6px', fontSize: V2_T.font.caption, color: V2_T.text.tertiary } }, search.error ? '搜索失败：' + search.error : message),
      items.map(function map(item) {
        const path = item.path || item.file || ''
        if (!path) return null
        const name = item.name || v2NotesBaseName(path)
        const snippet = item.snippet || item.excerpt || item.preview || item.match || ''
        return h(
          'button',
          {
            key: 'search:' + path,
            type: 'button',
            title: path,
            onClick: function onClick() { openNote(path) },
            style: {
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              width: '100%',
              minHeight: 34,
              padding: '4px 8px',
              border: 'none',
              background: 'transparent',
              color: V2_T.text.primary,
              borderRadius: V2_T.radius.sm,
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: COLORS.fontFamily,
            },
            onMouseEnter: function onMouseEnter(event) { event.currentTarget.style.background = V2_T.surface.panel2 },
            onMouseLeave: function onMouseLeave(event) { event.currentTarget.style.background = 'transparent' },
          },
          h(V2Icon, { name: 'file', size: 13, color: V2_T.text.tertiary }),
          h(
            'span',
            { style: { display: 'flex', flexDirection: 'column', minWidth: 0, gap: 1 } },
            h('span', { style: { fontSize: V2_T.font.body, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, v2NotesStripExt(name)),
            h('span', { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, path),
            snippet
              ? h('span', { style: { fontSize: V2_T.font.caption, color: V2_T.text.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(snippet).slice(0, 90))
              : null,
          ),
        )
      }),
    )
  }

  function renderWorkspace() {
    const nodes = workNodes
    const dropActive = dragOver === '__root__'
    return h(
      'div',
      {},
      h(
        'div',
        {
          onDragOver: function onDragOver(event) {
            event.preventDefault()
            if (isDroppable('') && dragOver !== '__root__') setDragOver('__root__')
          },
          onDragLeave: function onDragLeave() {
            if (dragOver === '__root__') setDragOver('')
          },
          onDrop: function onDrop(event) { handleDrop(event, '') },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 30,
            marginTop: 10,
            padding: '0 8px',
            fontSize: V2_T.font.caption,
            fontWeight: 600,
            letterSpacing: '0.02em',
            color: V2_T.text.tertiary,
            borderRadius: V2_T.radius.sm,
            background: dropActive ? V2_T.surface.panel3 : 'transparent',
            outline: dropActive ? '1px dashed ' + V2_T.accent.base : 'none',
            userSelect: 'none',
          },
          onMouseEnter: function onMouseEnter(event) {
            if (!dropActive) event.currentTarget.style.background = V2_T.surface.panel2
          },
          onMouseLeave: function onMouseLeave(event) {
            event.currentTarget.style.background = dropActive ? V2_T.surface.panel3 : 'transparent'
          },
        },
        h('span', { style: { flex: '1 1 auto', fontWeight: 600 } }, '工作区'),
        h('span', { style: { fontWeight: 400 } }, totalNotes + ' 篇'),
        /* 首行除搜索外的操作入口统一收在工作区行右端 */
        h(
          'button',
          {
            type: 'button',
            title: '新建笔记',
            'aria-label': '新建笔记',
            onClick: function onClick(event) {
              event.stopPropagation()
              setDialog({ kind: 'new-note', dir: currentDir() })
            },
            style: v2NotesIconBtnStyle({ width: 22, height: 22 }),
          },
          h(V2Icon, { name: 'plus', size: 13 }),
        ),
        h(
          'button',
          {
            type: 'button',
            title: '新建文件夹',
            'aria-label': '新建文件夹',
            onClick: function onClick(event) {
              event.stopPropagation()
              setDialog({ kind: 'new-folder', dir: currentDir() })
            },
            style: v2NotesIconBtnStyle({ width: 22, height: 22 }),
          },
          h(V2Icon, { name: 'folder', size: 13 }),
        ),
        h(
          'button',
          {
            type: 'button',
            title: '更多',
            'aria-label': '更多',
            onClick: function onClick(event) {
              event.stopPropagation()
              openSidebarMenu(event)
            },
            style: v2NotesIconBtnStyle({ width: 22, height: 22 }),
          },
          h(V2Icon, { name: 'more', size: 13 }),
        ),
      ),
      nodes.length
        ? nodes.map(function map(node) { return renderNode(node, 0) })
        : treeLoading
          ? null
          : h('div', { style: { padding: '6px 10px', fontSize: V2_T.font.caption, color: V2_T.text.tertiary, lineHeight: '17px' } }, '目录为空，点击上方 ＋ 新建第一篇笔记。'),
    )
  }

  function renderSidebar() {
    const treeError = treeState.error
    const searchActive = searchOpen && String(searchQuery || '').trim().length > 0
    const header = h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 36,
          minHeight: 36,
          padding: '0 10px',
          flex: '0 0 auto',
        },
      },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 auto', minWidth: 0 } },
        h('span', { style: { fontSize: V2_T.font.body, fontWeight: 600, color: V2_T.text.primary } }, '笔记'),
        mock
          ? h(
              'span',
              {
                title: V2_NOTES_MOCK_HINT,
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: 18,
                  fontSize: V2_T.font.caption - 1,
                  padding: '0 6px',
                  borderRadius: V2_T.radius.pill,
                  border: '1px solid ' + V2_T.border.subtle,
                  color: V2_T.status.warn,
                  background: V2_T.status.warnSoft,
                },
              },
              '模拟',
            )
          : null,
      ),
      h('button', { type: 'button', title: '搜索笔记', onClick: function onClick() { if (searchOpen) { setSearchOpen(false); setSearchQuery('') } else setSearchOpen(true) }, style: v2NotesIconBtnStyle({ width: 28, height: 28 }) }, h(V2Icon, { name: 'search', size: 15 })),
    )
    const searchBlock = searchOpen
      ? h(
          'div',
          { style: { padding: '0 10px 10px', flex: '0 0 auto' } },
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: V2_T.line.input,
                boxSizing: 'border-box',
                background: V2_T.surface.input,
                border: '1px solid ' + V2_T.border.subtle,
                borderRadius: V2_T.radius.md,
                padding: '0 8px',
                transition: 'box-shadow ' + V2_T.motion.fast + 'ms ease, border-color ' + V2_T.motion.fast + 'ms ease',
              },
            },
            h(V2Icon, { name: 'search', size: 13, color: V2_T.text.tertiary }),
            h('input', {
              ref: searchRef,
              value: searchQuery,
              placeholder: '搜索标题或正文…',
              onChange: function onChange(event) { setSearchQuery(event.target.value) },
              onKeyDown: function onKeyDown(event) {
                if (event.key === 'Escape') {
                  setSearchOpen(false)
                  setSearchQuery('')
                }
              },
              onFocus: function onFocus(event) {
                const box = event.currentTarget.parentElement
                if (!box) return
                box.style.borderColor = V2_T.accent.line
                box.style.boxShadow = '0 0 0 2px ' + V2_T.accent.soft + ', 0 0 0 1px ' + V2_T.accent.base
              },
              onBlur: function onBlur(event) {
                const box = event.currentTarget.parentElement
                if (!box) return
                box.style.borderColor = V2_T.border.subtle
                box.style.boxShadow = 'none'
              },
              style: Object.assign(v2InputStyle({ fontSize: V2_T.font.body }), {
                flex: '1 1 auto',
                minWidth: 0,
                height: '100%',
                padding: 0,
                background: 'transparent',
                color: V2_T.text.primary,
              }),
            }),
            searchQuery
              ? h(
                  'button',
                  {
                    type: 'button',
                    title: '清空',
                    onClick: function onClick() { setSearchQuery('') },
                    style: v2NotesIconBtnStyle({ width: 20, height: 20 }),
                  },
                  h(V2Icon, { name: 'close', size: 11 }),
                )
              : null,
          ),
        )
      : null
    const scrollBody = searchActive
      ? renderSearchResults()
      : h(
          'div',
          {},
          treeError
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    margin: '2px 4px 8px',
                    padding: '8px 10px',
                    borderRadius: V2_T.radius.sm,
                    background: V2_T.status.dangerSoft,
                    border: '1px solid rgba(255,138,138,0.28)',
                    fontSize: V2_T.font.caption,
                    color: V2_T.status.danger,
                    lineHeight: '16px',
                  },
                },
                h('span', { style: { flex: '1 1 auto' } }, '加载失败：' + treeError),
                h('button', { type: 'button', onClick: function onClick() { refreshTree() }, style: v2NotesBtnStyle('soft', { height: 24, padding: '0 8px', fontSize: V2_T.font.caption }) }, '重试'),
              )
            : null,
          setupRequired
            ? h(
                'div',
                {
                  style: {
                    margin: '2px 4px 8px',
                    padding: '8px 10px',
                    borderRadius: V2_T.radius.sm,
                    background: V2_T.surface.panel2,
                    border: '1px solid ' + V2_T.border.subtle,
                    fontSize: V2_T.font.caption,
                    color: V2_T.text.secondary,
                    lineHeight: '16px',
                  },
                },
                '尚未配置笔记目录，请在右侧完成设置。',
              )
            : null,
          mock
            ? h(
                'div',
                {
                  style: {
                    margin: '2px 4px 8px',
                    padding: '8px 10px',
                    borderRadius: V2_T.radius.sm,
                    background: V2_T.status.warnSoft,
                    border: '1px solid rgba(245,205,121,0.28)',
                    fontSize: V2_T.font.caption,
                    color: V2_T.status.warn,
                    lineHeight: '16px',
                  },
                },
                V2_NOTES_MOCK_HINT,
              )
            : null,
          renderQuickGroup('diary'),
          renderQuickGroup('scratch'),
          h('div', { style: v2DividerStyle({ margin: '6px 4px' }) }),
          renderWorkspace(),
        )
    const batchBar = selMode
      ? h(
          'div',
          {
            style: {
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '6px 8px',
              borderTop: '1px solid ' + V2_T.border.subtle,
              background: V2_T.surface.shell,
            },
          },
          h('span', { style: { fontSize: V2_T.font.caption, color: V2_T.text.secondary, marginRight: 2 } }, '已选 ' + selectedPaths.length + ' 项'),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', { type: 'button', disabled: !selectedPaths.length || batchBusy, onClick: function onClick() { setDialog({ kind: 'move-paths', paths: selectedPaths.slice() }) }, style: v2NotesBtnStyle('soft', { height: 24, padding: '0 8px', fontSize: V2_T.font.caption, opacity: selectedPaths.length ? 1 : 0.5 }) }, '移动'),
          h('button', { type: 'button', disabled: !selectedPaths.length || batchBusy, onClick: function onClick() { setDialog({ kind: 'batch-tag', paths: selectedPaths.slice() }) }, style: v2NotesBtnStyle('soft', { height: 24, padding: '0 8px', fontSize: V2_T.font.caption, opacity: selectedPaths.length ? 1 : 0.5 }) }, '标签'),
          h('button', { type: 'button', disabled: !selectedPaths.length || batchBusy, onClick: function onClick() { setDialog({ kind: 'delete-paths', paths: selectedPaths.slice() }) }, style: v2NotesBtnStyle('danger', { height: 24, padding: '0 8px', fontSize: V2_T.font.caption, opacity: selectedPaths.length ? 1 : 0.5 }) }, '删除'),
          h('button', { type: 'button', onClick: exitSelMode, style: v2NotesBtnStyle('ghost', { height: 24, padding: '0 8px', fontSize: V2_T.font.caption }) }, '取消'),
        )
      : null
    const footer = h(
      'div',
      {
        style: {
          flex: '0 0 auto',
          height: 30,
          borderTop: '1px solid ' + V2_T.border.subtle,
          background: V2_T.surface.shell,
          padding: '0 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: V2_T.font.caption,
          color: V2_T.text.tertiary,
          minWidth: 0,
        },
      },
      h(V2Icon, { name: 'folder', size: 11 }),
      h(
        'span',
        {
          title: configData.dir || '',
          style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto', minWidth: 0 },
        },
        configData.dir || '未配置目录',
      ),
      h('span', { style: { color: mock ? V2_T.status.warn : V2_T.status.success, fontSize: V2_T.font.caption, flex: '0 0 auto' } }, mock ? '模拟' : configData.writable === false ? '只读' : '已连接'),
    )
    return h(
      'aside',
      {
        key: 'tree',
        style: {
          width: narrow ? 'auto' : panes.treeWidth,
          flex: narrow ? '1 1 auto' : '0 0 ' + panes.treeWidth + 'px',
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          background: V2_T.surface.side,
          borderRight: narrow ? 'none' : '1px solid ' + V2_T.border.subtle,
          overflow: 'hidden',
        },
      },
      header,
      searchBlock,
      h(
        'div',
        {
          style: {
            flex: '1 1 auto',
            overflowY: 'auto',
            minHeight: 0,
            padding: '2px 8px 14px',
            scrollbarColor: V2_T.border.subtle + ' transparent',
          },
        },
        scrollBody,
      ),
      batchBar,
      footer,
    )
  }

  /* ---------- 渲染：编辑器 ---------- */

  function renderEmptyEditor() {
    return h(
      'div',
      {
        style: {
          flex: '1 1 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: V2_T.space.x6,
          minHeight: 0,
        },
      },
      h(
        'div',
        {
          style: v2CardStyle({
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
            maxWidth: 420,
            padding: V2_T.space.x6,
            textAlign: 'center',
          }),
        },
        h(V2Icon, { name: 'text', size: 30, color: V2_T.text.tertiary }),
        h('div', { style: v2TextStyle('title') }, '选择一篇笔记，或新建一篇'),
        h('div', { style: { fontSize: V2_T.font.meta, color: V2_T.text.tertiary, lineHeight: '19px' } }, '笔记以 Markdown 文件保存在本地目录中，自动保存到你停止输入之后。'),
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 } },
          h('button', { type: 'button', onClick: function onClick() { setDialog({ kind: 'new-note', dir: currentDir() }) }, style: v2NotesBtnStyle('primary', { height: 32, fontSize: V2_T.font.meta }) }, '新建笔记'),
          h('button', { type: 'button', onClick: createDiary, style: v2NotesBtnStyle('soft', { height: 32, fontSize: V2_T.font.meta }) }, '新建今日日记'),
          h('button', { type: 'button', onClick: createScratch, style: v2NotesBtnStyle('soft', { height: 32, fontSize: V2_T.font.meta }) }, '新建随记'),
          h('button', { type: 'button', onClick: function onClick() { setDialog({ kind: 'quick-note' }) }, style: v2NotesBtnStyle('ghost', { height: 32, fontSize: V2_T.font.meta }) }, '快速记录'),
        ),
      ),
    )
  }

  function renderSaveState(docState) {
    const saveState = docState.saveState || 'saved'
    let color = V2_T.text.tertiary
    let label = '已保存'
    if (docState.saving || saveState === 'saving') {
      color = V2_T.accent.base
      label = '保存中…'
    } else if (saveState === 'conflict') {
      color = V2_T.status.warn
      label = '保存冲突'
    } else if (saveState === 'error') {
      color = V2_T.status.danger
      label = '保存失败'
    } else if (docState.dirty || saveState === 'pending') {
      color = V2_T.status.warn
      label = '未保存'
    } else if (docState.lastSavedAt) {
      label = '已保存 · ' + v2NotesFormatMtime(docState.lastSavedAt)
    }
    return h(
      'span',
      { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: V2_T.font.caption, color: color, flex: '0 0 auto', whiteSpace: 'nowrap' } },
      h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block' } }),
      label,
    )
  }

  function renderEditorHeader(docState) {
    const previewMode = preview === true
    return h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 44,
          minHeight: 44,
          padding: '0 12px',
          borderBottom: '1px solid ' + V2_T.border.subtle,
          flex: '0 0 auto',
          background: V2_T.surface.app,
        },
      },
      narrow
        ? h(
            'button',
            { type: 'button', title: '返回文件树', onClick: function onClick() { setMobileView('tree') }, style: v2NotesIconBtnStyle({ width: 28, height: 28 }) },
            h(V2Icon, { name: 'chevronLeft', size: 16 }),
          )
        : null,
      h('input', {
        value: titleDraft,
        placeholder: '未命名笔记',
        title: '修改标题会重命名文件',
        onChange: function onChange(event) { setTitleDraft(event.target.value) },
        onBlur: function onBlur() { commitTitle() },
        onKeyDown: function onKeyDown(event) {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            setTitleDraft(v2NotesStripExt(docState.name))
            event.currentTarget.blur()
          }
        },
        style: Object.assign(v2InputStyle({ fontSize: V2_T.font.title }), {
          flex: '1 1 auto',
          minWidth: 0,
          height: 30,
          fontWeight: 600,
          color: V2_T.text.primary,
          padding: '0 6px',
        }),
      }),
      renderSaveState(docState),
      h(
        'div',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            height: 28,
            boxSizing: 'border-box',
            background: V2_T.surface.panel,
            borderRadius: V2_T.radius.sm,
            padding: 2,
            gap: 2,
            flex: '0 0 auto',
            border: '1px solid ' + V2_T.border.subtle,
          },
        },
        [{ id: false, label: '编辑', icon: 'edit' }, { id: true, label: '预览', icon: 'text' }].map(function map(option) {
          const active = previewMode === option.id
          return h(
            'button',
            {
              key: String(option.id),
              type: 'button',
              title: option.label,
              onClick: function onClick() {
                if (previewMode !== option.id) togglePreview()
              },
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                height: 24,
                padding: '0 8px',
                border: 'none',
                borderRadius: 6,
                background: active ? V2_T.accent.soft : 'transparent',
                color: active ? V2_T.accent.base : V2_T.text.secondary,
                fontSize: V2_T.font.caption,
                cursor: 'pointer',
                fontFamily: COLORS.fontFamily,
                transition: 'background ' + V2_T.motion.fast + 'ms ease, color ' + V2_T.motion.fast + 'ms ease',
              },
            },
            h(V2Icon, { name: option.icon, size: 12 }),
            option.label,
          )
        }),
      ),
      h('button', { type: 'button', title: '更多操作', onClick: openDocMenu, style: v2NotesIconBtnStyle({ width: 28, height: 28 }) }, h(V2Icon, { name: 'more', size: 15 })),
    )
  }

  function renderMetaBar(docState) {
    return h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minHeight: 30,
          padding: '0 12px',
          borderBottom: '1px solid ' + V2_T.border.subtle,
          flexWrap: 'wrap',
          fontSize: V2_T.font.meta,
          color: V2_T.text.tertiary,
          flex: '0 0 auto',
          background: V2_T.surface.app,
        },
      },
      h(
        'span',
        {
          title: docState.path || '',
          style: { maxWidth: narrow ? 160 : 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: V2_T.font.meta, color: V2_T.text.tertiary },
        },
        docState.path || '',
      ),
      h('span', { style: { flex: '1 1 auto' } }),
      docTags.map(function map(tag) {
        return h(
          'span',
          {
            key: 'tag:' + tag,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              height: 22,
              padding: '0 8px',
              borderRadius: V2_T.radius.pill,
              background: V2_T.surface.panel2,
              border: '1px solid ' + V2_T.border.subtle,
              fontSize: V2_T.font.caption,
              color: V2_T.text.secondary,
            },
          },
          '#' + tag,
          h(
            'button',
            {
              type: 'button',
              title: '移除标签',
              onClick: function onClick() { removeTagFromCurrent(tag) },
              style: {
                border: 'none',
                background: 'transparent',
                color: V2_T.text.tertiary,
                cursor: 'pointer',
                padding: 0,
                fontSize: V2_T.font.caption,
                lineHeight: '12px',
                fontFamily: COLORS.fontFamily,
              },
            },
            '×',
          ),
        )
      }),
      tagEditing
        ? h(
            'input',
            {
              ref: tagInputRef,
              value: tagDraft,
              placeholder: '标签名，回车添加',
              onChange: function onChange(event) { setTagDraft(event.target.value) },
              onKeyDown: function onKeyDown(event) {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addTagToCurrent(tagDraft)
                } else if (event.key === 'Escape') {
                  setTagEditing(false)
                  setTagDraft('')
                }
              },
              onBlur: function onBlur() {
                if (tagDraft.trim()) addTagToCurrent(tagDraft)
                else {
                  setTagEditing(false)
                  setTagDraft('')
                }
              },
              style: Object.assign(v2InputStyle({ fontSize: V2_T.font.caption }), {
                width: 130,
                height: 22,
                background: V2_T.surface.input,
                border: '1px solid ' + V2_T.border.subtle,
                borderRadius: V2_T.radius.pill,
                padding: '0 8px',
                color: V2_T.text.primary,
              }),
            },
          )
        : h(
            'button',
            {
              type: 'button',
              title: '添加标签',
              onClick: function onClick() { setTagEditing(true) },
              style: {
                border: '1px dashed ' + V2_T.border.subtle,
                background: 'transparent',
                color: V2_T.text.tertiary,
                cursor: 'pointer',
                borderRadius: V2_T.radius.pill,
                height: 22,
                padding: '0 8px',
                fontSize: V2_T.font.caption,
                fontFamily: COLORS.fontFamily,
              },
            },
            '＋标签',
          ),
      tagRemote === false && docTags.length
        ? h('span', { title: 'Host 暂未提供标签接口，标签保存在本机 localStorage', style: { fontSize: V2_T.font.caption - 1, color: V2_T.text.tertiary } }, '本机标签')
        : null,
      docState.mtime ? h('span', { style: { flex: '0 0 auto', fontSize: V2_T.font.meta, color: V2_T.text.tertiary } }, '更新于 ' + v2NotesFormatMtime(docState.mtime)) : null,
    )
  }

  function renderBanner(key, tone, title, message, actions) {
    const danger = tone === 'danger'
    return h(
      'div',
      {
        key: key,
        style: v2CardStyle({
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          margin: '8px 12px 0',
          background: danger ? V2_T.status.dangerSoft : V2_T.status.warnSoft,
          borderColor: danger ? 'rgba(255,138,138,0.33)' : 'rgba(245,205,121,0.33)',
          flex: '0 0 auto',
          flexWrap: 'wrap',
        }),
      },
      h(V2Icon, { name: danger ? 'flag' : 'bell', size: 14, color: danger ? V2_T.status.danger : V2_T.status.warn }),
      h(
        'div',
        { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
        h('span', { style: { fontSize: V2_T.font.meta, fontWeight: 600, color: V2_T.text.primary } }, title),
        message ? h('span', { style: { fontSize: V2_T.font.caption, color: V2_T.text.secondary, lineHeight: '16px' } }, message) : null,
      ),
      h(
        'div',
        { style: { display: 'flex', gap: 6, flex: '0 0 auto' } },
        (actions || []).map(function map(action, index) {
          return h(
            'button',
            {
              key: 'act_' + index,
              type: 'button',
              onClick: action.onClick,
              style: v2NotesBtnStyle(action.kind || 'soft', {
                height: 26,
                padding: '0 10px',
                borderRadius: V2_T.radius.pill,
                fontSize: V2_T.font.caption,
              }),
            },
            action.label,
          )
        }),
      ),
    )
  }

  function renderFeedback(docState) {
    const rows = []
    if (docState.conflict) {
      rows.push(
        renderBanner(
          'conflict',
          'warn',
          '保存冲突：文件已在外部被修改',
          (docState.conflict && docState.conflict.message) || '磁盘上的内容与编辑器不同，请选择保留哪一份。',
          [
            { label: '保留我的', kind: 'primary', onClick: overwriteCurrent },
            { label: '重新加载', kind: 'soft', onClick: reloadCurrent },
            { label: '另存副本', kind: 'soft', onClick: saveCopy },
          ],
        ),
      )
    } else if (docState.external) {
      rows.push(
        renderBanner('external', 'warn', '文件已在外部被修改', '重新加载可获取磁盘上的最新内容；忽略后不会自动刷新。', [
          { label: '重新加载', kind: 'soft', onClick: reloadCurrent },
          { label: '另存副本', kind: 'soft', onClick: saveCopy },
          { label: '忽略', kind: 'ghost', onClick: dismissExternal },
        ]),
      )
    }
    if (docState.error) {
      rows.push(
        renderBanner('save-error', 'danger', '保存失败', String(docState.error), [
          { label: '重试保存', kind: 'danger', onClick: function onClick() { saveNow(true) } },
        ]),
      )
    }
    return rows.length ? h('div', {}, rows) : null
  }

  function renderEditorBody(docState) {
    const content = String(docState.content || '')
    if (preview) {
      return h(
        'div',
        { style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '18px 20px', scrollbarColor: V2_T.border.subtle + ' transparent' } },
        h(
          'div',
          { style: { maxWidth: 820, margin: '0 auto', fontSize: notesFontSize, lineHeight: '1.7', color: V2_T.text.primary } },
          renderMarkdownPreview(content),
        ),
      )
    }
    return h('textarea', {
      ref: editorRef,
      value: content,
      spellCheck: false,
      placeholder: '开始书写，支持 Markdown。Ctrl/⌘ + S 立即保存。',
      onChange: function onChange(event) {
        try {
          notes.editContent(event.target.value)
        } catch (error) {
          notify('error', '编辑失败：' + errorText(error))
        }
      },
      onKeyDown: onEditorKeyDown,
      style: {
        flex: '1 1 auto',
        minHeight: 0,
        width: '100%',
        boxSizing: 'border-box',
        border: 'none',
        outline: 'none',
        resize: 'none',
        background: 'transparent',
        color: V2_T.text.primary,
        caretColor: V2_T.accent.base,
        fontFamily: V2_NOTES_MONO_FONT,
        fontSize: notesFontSize,
        lineHeight: '1.7',
        padding: narrow ? '14px 16px' : '18px 20px',
        overflowY: 'auto',
        scrollbarColor: V2_T.border.subtle + ' transparent',
      },
    })
  }

  function renderEditorFooter(docState) {
    const content = String(docState.content || '')
    const chars = content.replace(/\s+/g, '').length
    const lines = content ? content.split('\n').length : 0
    const saveState = docState.saveState || 'saved'
    let autoColor = V2_T.text.tertiary
    if (docState.saving || saveState === 'saving') autoColor = V2_T.accent.base
    else if (saveState === 'conflict') autoColor = V2_T.status.warn
    else if (saveState === 'error') autoColor = V2_T.status.danger
    else if (docState.dirty || saveState === 'pending') autoColor = V2_T.status.warn
    return h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 36,
          minHeight: 36,
          padding: '0 12px',
          borderTop: '1px solid ' + V2_T.border.subtle,
          background: V2_T.surface.shell,
          fontSize: V2_T.font.caption,
          color: V2_T.text.tertiary,
          flex: '0 0 auto',
        },
      },
      h('span', {}, chars + ' 字'),
      h('span', {}, lines + ' 行'),
      h('span', { style: { flex: '1 1 auto' } }),
      h('span', { title: '自动保存防抖 ' + saveDelay + 'ms', style: { color: autoColor } }, '自动保存 · ' + Math.round(saveDelay / 100) / 10 + 's'),
      h('span', { style: { flex: '1 1 auto' } }),
      h(
        'button',
        {
          type: 'button',
          onClick: function onClick() { saveNow(true) },
          onMouseEnter: function onMouseEnter(event) {
            event.currentTarget.style.background = '#86b8ff'
            event.currentTarget.style.borderColor = '#86b8ff'
          },
          onMouseLeave: function onMouseLeave(event) {
            event.currentTarget.style.background = V2_T.accent.base
            event.currentTarget.style.borderColor = V2_T.accent.base
          },
          onFocus: function onFocus(event) {
            event.currentTarget.style.boxShadow = '0 0 0 2px ' + V2_T.accent.soft + ', 0 0 0 1px ' + V2_T.accent.base
          },
          onBlur: function onBlur(event) {
            event.currentTarget.style.boxShadow = 'none'
          },
          style: v2NotesBtnStyle('primary', {
            height: 28,
            padding: '0 12px',
            fontSize: V2_T.font.meta,
            fontWeight: 600,
            borderRadius: V2_T.radius.sm,
          }),
        },
        '保存',
      ),
    )
  }

  function commitTitle() {
    const state = readState()
    const docState = state.doc || {}
    if (!docState.path) {
      setTitleDraft('')
      return
    }
    const cleaned = v2NotesSanitizeName(v2NotesStripExt(titleDraft), '')
    const base = v2NotesStripExt(docState.name)
    if (!cleaned || cleaned === base) {
      setTitleDraft(base)
      return
    }
    setTitleDraft(cleaned + v2NotesExt(docState.name))
    submitRenameNote(cleaned)
  }

  function renderEditor() {
    const wrapperStyle = {
      flex: '1 1 auto',
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
      minHeight: 0,
      overflow: 'hidden',
      background: V2_T.surface.app,
      borderLeft: narrow ? 'none' : '1px solid ' + V2_T.border.subtle,
    }
    if (setupRequired) return h('div', { style: wrapperStyle, key: 'editor' }, h(V2NotesSetupGuide, { notes: notes, state: notesState }))
    if (configLoading) {
      return h(
        'div',
        { style: wrapperStyle, key: 'editor' },
        h(
          'div',
          { style: { flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: V2_T.space.x6 } },
          h(
            'div',
            {
              style: v2CardStyle({
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                width: '100%',
                maxWidth: 420,
                boxSizing: 'border-box',
                padding: V2_T.space.x6,
                fontSize: V2_T.font.meta,
                color: V2_T.text.tertiary,
              }),
            },
            h(V2Icon, { name: 'folder', size: 16, color: V2_T.text.tertiary }),
            '正在加载笔记目录…',
          ),
        ),
      )
    }
    const docState = readState().doc || {}
    if (!docState.path) return h('div', { style: wrapperStyle, key: 'editor' }, renderEmptyEditor())
    if (docState.phase === 'loading') {
      return h(
        'div',
        { style: wrapperStyle, key: 'editor' },
        h(
          'div',
          { style: { flex: '1 1 auto', padding: '18px 20px', overflow: 'hidden' } },
          typeof SkeletonRows === 'function' ? h(SkeletonRows, { count: 8 }) : h('div', { style: { fontSize: V2_T.font.meta, color: V2_T.text.tertiary } }, '加载中…'),
        ),
      )
    }
    if (docState.phase === 'error') {
      return h(
        'div',
        { style: wrapperStyle, key: 'editor' },
        h(
          'div',
          { style: { flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: V2_T.space.x6 } },
          h(
            'div',
            {
              style: v2CardStyle({
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 10,
                width: '100%',
                maxWidth: 420,
                boxSizing: 'border-box',
                padding: V2_T.space.x6,
              }),
            },
            h('div', { style: { fontSize: V2_T.font.title, fontWeight: 600, color: V2_T.status.danger } }, '读取笔记失败'),
            h('div', { style: { fontSize: V2_T.font.meta, color: V2_T.text.secondary, lineHeight: '18px' } }, String(docState.error || '未知错误')),
            h(
              'div',
              { style: { display: 'flex', gap: 8 } },
              h('button', { type: 'button', onClick: function onClick() { openNote(docState.path) }, style: v2NotesBtnStyle('primary', { height: 32, fontSize: V2_T.font.meta }) }, '重试'),
              h('button', { type: 'button', onClick: function onClick() { notes.clearEditorError() }, style: v2NotesBtnStyle('ghost', { height: 32, fontSize: V2_T.font.meta }) }, '关闭'),
            ),
          ),
        ),
      )
    }
    return h(
      'div',
      { style: wrapperStyle, key: 'editor' },
      renderEditorHeader(docState),
      renderMetaBar(docState),
      renderFeedback(docState),
      renderEditorBody(docState),
      renderEditorFooter(docState),
    )
  }

  /* ---------- 渲染：弹窗 ---------- */

  function renderDialog() {
    if (!dialog) return null
    if (dialog.kind === 'new-note') {
      return h(V2NotesPrompt, {
        key: 'dlg-new-note',
        title: '新建笔记',
        label: '文件名（自动补 .md）',
        placeholder: '留空则使用今日日期',
        submitLabel: '创建',
        required: false,
        hint: '同名笔记已存在时会自动打开，不会覆盖。',
        onSubmit: function onSubmit(value) { submitNewNote(dialog.dir, value) },
        onCancel: closeDialog,
      })
    }
    if (dialog.kind === 'new-folder') {
      return h(V2NotesPrompt, {
        key: 'dlg-new-folder',
        title: '新建文件夹',
        label: '文件夹名称',
        placeholder: '例如 项目笔记',
        submitLabel: '创建',
        onSubmit: function onSubmit(value) { submitNewFolder(dialog.dir, value) },
        onCancel: closeDialog,
      })
    }
    if (dialog.kind === 'rename-note') {
      return h(V2NotesPrompt, {
        key: 'dlg-rename-note',
        title: '重命名笔记',
        label: '新文件名',
        initial: dialog.initial || v2NotesStripExt(doc.name),
        submitLabel: '重命名',
        onSubmit: submitRenameNote,
        onCancel: closeDialog,
      })
    }
    if (dialog.kind === 'rename-dir') {
      return h(V2NotesPrompt, {
        key: 'dlg-rename-dir',
        title: '重命名文件夹',
        label: '新名称',
        initial: dialog.initial || '',
        submitLabel: '重命名',
        onSubmit: function onSubmit(value) { submitRenameDir(dialog.path, value) },
        onCancel: closeDialog,
      })
    }
    if (dialog.kind === 'move-paths') {
      return h(V2NotesDirPicker, {
        key: 'dlg-move',
        title: dialog.paths && dialog.paths.length > 1 ? '移动 ' + dialog.paths.length + ' 项' : '移动到文件夹',
        dirs: allDirs,
        initial: dialog.initialDir !== undefined ? dialog.initialDir : currentDir(),
        onSubmit: function onSubmit(targetDir) { movePaths(dialog.paths || [], targetDir) },
        onCancel: closeDialog,
      })
    }
    if (dialog.kind === 'delete-paths') {
      const paths = dialog.paths || []
      return h(V2NotesConfirm, {
        key: 'dlg-delete',
        title: paths.length > 1 ? '删除 ' + paths.length + ' 项' : '删除笔记',
        message: '删除后可在笔记目录的 .trash 中恢复。确定要删除吗？',
        items: paths.length > 1 ? paths : null,
        submitLabel: '删除',
        danger: true,
        busy: batchBusy,
        onSubmit: function onSubmit() { deletePaths(paths) },
        onCancel: closeDialog,
      })
    }
    if (dialog.kind === 'batch-tag') {
      return h(V2NotesPrompt, {
        key: 'dlg-batch-tag',
        title: '添加标签',
        label: '为选中的 ' + (dialog.paths ? dialog.paths.length : 0) + ' 项添加标签',
        placeholder: '例如 灵感',
        submitLabel: '添加',
        onSubmit: function onSubmit(value) {
          setDialog(null)
          applyTagsTo(dialog.paths || [], function push(list) {
            const tag = v2NotesCleanTag(value)
            if (tag && list.indexOf(tag) === -1) list.push(tag)
            return list
          })
        },
        onCancel: closeDialog,
      })
    }
    if (dialog.kind === 'quick-note') {
      return h(V2NotesQuickNote, {
        key: 'dlg-quick-note',
        onSubmit: function onSubmit(value) {
          setDialog(null)
          runNotesAction(function quick() { return notes.quickNote(value) }, '快速记录失败')
          setTimeout(function after() { refreshTree() }, 500)
        },
        onCancel: closeDialog,
      })
    }
    if (dialog.kind === 'switch-dirty') {
      return h(V2NotesConfirm, {
        key: 'dlg-switch-dirty',
        title: '有未保存的内容',
        message: '当前笔记的修改尚未成功保存。放弃修改并打开另一篇吗？',
        submitLabel: '放弃修改并切换',
        danger: true,
        onSubmit: function onSubmit() { forceOpen(dialog.path) },
        onCancel: closeDialog,
      })
    }
    if (dialog.kind === 'config-dir') {
      return h(V2NotesPrompt, {
        key: 'dlg-config-dir',
        title: '设置笔记目录',
        label: '本地文件夹路径',
        initial: configData.dir || '',
        placeholder: 'C:\\Users\\你\\Documents\\LifeOS\\Notes',
        submitLabel: '保存并创建',
        onSubmit: function onSubmit(value) {
          setDialog(null)
          if (!value) return
          try {
            const promise = notes.setConfig(value, true)
            if (promise && typeof promise.catch === 'function') promise.catch(function onError(error) { notify('error', '目录设置失败：' + errorText(error)) })
          } catch (error) {
            notify('error', '目录设置失败：' + errorText(error))
          }
        },
        onCancel: closeDialog,
      })
    }
    return null
  }

  /* ---------- 副作用 ---------- */

  useEffect(function onMount() {
    mountedRef.current = true
    return function onUnmount() {
      mountedRef.current = false
    }
  }, [])

  useEffect(function loadTags() {
    let alive = true
    v2NotesFetchTags().then(function onFetched(result) {
      if (!alive) return
      if (result.remote) {
        setTagRemote(true)
        setTagMap(function merge(prev) {
          const next = Object.assign({}, prev)
          const remoteMap = result.map || {}
          Object.keys(remoteMap).forEach(function each(path) { next[path] = remoteMap[path] })
          return next
        })
      } else {
        setTagRemote(false)
      }
    })
    return function cleanup() {
      alive = false
    }
  }, [])

  useEffect(function syncTitle() {
    setTitleDraft(v2NotesStripExt((readState().doc || {}).name || ''))
  }, [notesState.doc && notesState.doc.path, notesState.doc && notesState.doc.name])

  useEffect(function debounceSearch() {
    const query = String(searchQuery || '').trim()
    const timer = setTimeout(function run() {
      try { notes.setSearch(query) } catch (error) { /* ignore */ }
    }, 260)
    return function cleanup() {
      clearTimeout(timer)
    }
  }, [searchQuery])

  useEffect(function focusSearchInput() {
    if (searchOpen && searchRef.current) {
      try { searchRef.current.focus() } catch (error) { /* ignore */ }
    }
  }, [searchOpen])

  useEffect(function focusTagInput() {
    if (tagEditing && tagInputRef.current) {
      try { tagInputRef.current.focus() } catch (error) { /* ignore */ }
    }
  }, [tagEditing])

  /* 多选模式下按 Esc 退出多选；弹窗 / 输入框内不拦截 */
  useEffect(function escapeSelection() {
    if (!selMode) return undefined
    function onKey(event) {
      if (event.key !== 'Escape') return
      if (event.defaultPrevented) return
      if (dialog) return
      const target = event.target
      const tag = target && target.tagName ? String(target.tagName).toUpperCase() : ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (target && target.isContentEditable) return
      exitSelMode()
    }
    document.addEventListener('keydown', onKey)
    return function cleanup() {
      document.removeEventListener('keydown', onKey)
    }
  }, [selMode, dialog])

  useEffect(function expandSelectedDoc() {
    const path = (notesState.doc || {}).path
    if (!path) return
    expandAncestors(path)
  }, [notesState.doc && notesState.doc.path])

  useEffect(function maybeRenameScratch() {
    const state = readState()
    const docState = state.doc || {}
    if (!docState.path || !scratchRef.current[docState.path]) return
    if (docState.phase !== 'ready') return
    if (docState.dirty === true) return
    if (docState.saveState !== 'saved') return
    const title = v2NotesScratchTitle(docState.content)
    if (!title || title === todayIso()) return
    delete scratchRef.current[docState.path]
    const dir = v2NotesDirName(docState.path)
    const desired = v2NotesSanitizeName(title, '随记') + v2NotesExt(docState.name)
    const list = state.tree && Array.isArray(state.tree.entries) ? state.tree.entries : []
    const name = v2NotesUniqueName(desired, function exists(candidate) {
      const full = v2NotesJoin(dir, candidate)
      return full !== docState.path && list.some(function some(entry) { return entry.path === full })
    })
    const target = v2NotesJoin(dir, name)
    if (target === docState.path) return
    try {
      notes.renamePath(docState.path, name)
    } catch (error) {
      /* ignore */
    }
  }, [notesState.doc && notesState.doc.path, notesState.doc && notesState.doc.saveState, notesState.doc && notesState.doc.dirty, notesState.doc && notesState.doc.content])

  useEffect(function ensureTreeLoaded() {
    if (!configReady || mock) return undefined
    if (treeState.phase === 'ready' || treeState.phase === 'loading') return undefined
    const timer = setTimeout(function kick() {
      try { notes.loadTree() } catch (error) { /* ignore */ }
    }, 600)
    return function cleanup() {
      clearTimeout(timer)
    }
  }, [configReady, mock, treeState.phase])

  useEffect(function ensureConfigLoaded() {
    if (configPhase !== 'idle') return undefined
    const timer = setTimeout(function kick() {
      try { notes.loadConfig() } catch (error) { /* ignore */ }
    }, 800)
    return function cleanup() {
      clearTimeout(timer)
    }
  }, [configPhase])

  /* ---------- 布局 ---------- */

  useEffect(function measurePaneWidth() {
    const el = panesContainerRef.current
    if (!el) return undefined
    function measure() {
      setPaneWidth(el.clientWidth || 0)
    }
    measure()
    let observer = null
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(measure)
      observer.observe(el)
    } else {
      window.addEventListener('resize', measure)
    }
    return function cleanup() {
      if (observer) observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  if (!notes || typeof notes.getState !== 'function') {
    return h('div', { style: { padding: 20, fontSize: V2_T.font.meta, color: V2_T.status.danger } }, '笔记运行时不可用')
  }

  function renderCollapseStrip() {
    return h(
      'aside',
      {
        key: 'tree-collapsed',
        title: '展开文件树',
        onClick: function onClick() {
          updatePanes({ treeCollapsed: false })
        },
        style: {
          flex: '0 0 22px',
          width: 22,
          borderRight: '1px solid ' + V2_T.border.subtle,
          background: V2_T.surface.side,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: 8,
          gap: 6,
          cursor: 'pointer',
          userSelect: 'none',
        },
      },
      h(V2Icon, { name: 'chevronRight', size: 14, color: V2_T.text.tertiary }),
      h(
        'div',
        {
          style: {
            writingMode: 'vertical-rl',
            fontSize: V2_T.font.caption,
            color: V2_T.text.tertiary,
            letterSpacing: 2,
            marginTop: 2,
          },
        },
        '文件',
      ),
    )
  }

  function renderSplitter(kind, key) {
    return h('div', {
      key: key,
      title: kind === 'tree' ? '拖动调整文件树宽度，双击恢复默认' : '拖动调整编辑区宽度，双击恢复默认',
      onMouseDown: function onMouseDown(event) {
        beginPaneResize(kind, event)
      },
      onDoubleClick: function onDoubleClick() {
        if (kind === 'tree') updatePanes({ treeWidth: V2_NOTES_SIDEBAR_WIDTH })
        else updatePanes({ editorWidth: null })
      },
      style: {
        flex: '0 0 6px',
        width: 6,
        cursor: 'col-resize',
        background: 'transparent',
        marginLeft: -3,
        marginRight: -3,
        zIndex: 2,
        transition: 'background ' + V2_T.motion.fast + 'ms ease',
      },
      onMouseEnter: function onMouseEnter(event) {
        event.currentTarget.style.background = V2_T.border.subtle
      },
      onMouseLeave: function onMouseLeave(event) {
        event.currentTarget.style.background = 'transparent'
      },
    })
  }

  function renderRoot() {
    const treePane = renderSidebar()
    const editorPane = renderEditor()
    const autoWidth = v2NotesAutoEditorWidth()
    const editorWidth = panes.editorWidth === null ? autoWidth : v2NotesClamp(panes.editorWidth, V2_NOTES_EDITOR_MIN, V2_NOTES_EDITOR_MAX)
    let panesList
    if (narrow) {
      if (setupRequired) panesList = [editorPane]
      else if (mobileView === 'editor' && (notesState.doc || {}).path) panesList = [editorPane]
      else panesList = [treePane]
    } else {
      const leftSide = panes.treeCollapsed ? [renderCollapseStrip()] : [treePane, renderSplitter('tree', 'tree-splitter')]
      const editorArea = h(
        'div',
        {
          key: 'editor-area',
          style: {
            flex: '0 0 ' + editorWidth + 'px',
            width: editorWidth,
            minWidth: 0,
            minHeight: 0,
            height: '100%',
            display: 'flex',
            position: 'relative',
          },
        },
        [
          editorPane,
          renderSplitter('editor', 'editor-splitter'),
          h(
            'button',
            {
              key: 'tree-collapse-btn',
              type: 'button',
              title: panes.treeCollapsed ? '展开文件树' : '收起文件树',
              onClick: function onClick() {
                updatePanes({ treeCollapsed: !panes.treeCollapsed })
              },
              style: {
                position: 'absolute',
                left: 4,
                top: 6,
                width: 20,
                height: 20,
                border: '1px solid ' + V2_T.border.subtle,
                borderRadius: 6,
                background: V2_T.surface.panel2,
                color: V2_T.text.tertiary,
                cursor: 'pointer',
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 4,
              },
            },
            h(V2Icon, { name: panes.treeCollapsed ? 'chevronRight' : 'chevronLeft', size: 11 }),
          ),
        ],
      )
      panesList = leftSide.concat([editorArea, h('div', { key: 'editor-fill', style: { flex: '1 1 auto', minWidth: 0 } })])
    }
    return h(
      'div',
      {
        ref: panesContainerRef,
        style: {
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          display: 'flex',
          minHeight: 0,
          minWidth: 0,
          overflow: 'hidden',
          background: V2_T.surface.app,
          color: V2_T.text.primary,
          fontFamily: COLORS.fontFamily,
        },
      },
      panesList,
      renderDialog(),
    )
  }

  return renderRoot()
}

/* ---- 60-settings.js (500 lines) ---- */
/* ═══════════════════════ M12 · LifeOS 设置页（V2） ═══════════════════════
 * 目标：替换 M0 诊断页，呈现当前四个页签真正可用的偏好设置。
 * 存储：localStorage['lifeos.v2.settings']（本机、无 Host schema 变更）；
 *       修改后立即写入并派发 'lifeos:settings-changed'，供各模块读取/生效。
 */

const V2_SETTINGS_KEY = 'lifeos.v2.settings'
const V2_SETTINGS_CALENDAR_KEY = 'lifeos.v2.calendar'

const V2_SETTINGS_DEFAULTS = {
  restoreLastTab: true,
  taskView: 'list',
  taskSort: 'custom',
  calendarView: 'week',
  habitShowPaused: true,
  notesAutosaveMs: 800,
  notesFontSize: 13.5,
}

const V2_SETTINGS_ENUMS = {
  taskView: ['list', 'board'],
  taskSort: ['custom', 'created', 'date', 'priority'],
  calendarView: ['month', 'week', 'day'],
  notesAutosaveMs: [500, 800, 1500],
  notesFontSize: [13, 13.5, 15],
}

const V2_SETTINGS_LABELS = {
  taskView: { list: '列表', board: '看板' },
  taskSort: { custom: '自定义', created: '创建时间', date: '日期', priority: '优先级' },
  calendarView: { month: '月', week: '周', day: '日' },
  notesAutosaveMs: { 500: '0.5 秒', 800: '0.8 秒', 1500: '1.5 秒' },
  notesFontSize: { 13: '小', 13.5: '标准', 15: '大' },
}

function v2SettingsPick(source, key, fallback) {
  if (!source || typeof source !== 'object') return fallback
  const value = source[key]
  if (V2_SETTINGS_ENUMS[key]) {
    const allowed = V2_SETTINGS_ENUMS[key]
    return allowed.some(function same(item) { return item === value }) ? value : fallback
  }
  if (typeof fallback === 'boolean') return typeof value === 'boolean' ? value : fallback
  return value === undefined ? fallback : value
}

function v2ReadSettings() {
  const next = Object.assign({}, V2_SETTINGS_DEFAULTS)
  try {
    const raw = window.localStorage.getItem(V2_SETTINGS_KEY)
    if (!raw) return next
    const parsed = JSON.parse(raw)
    Object.keys(V2_SETTINGS_DEFAULTS).forEach(function readKey(key) {
      next[key] = v2SettingsPick(parsed, key, V2_SETTINGS_DEFAULTS[key])
    })
  } catch (error) {
    /* localStorage 不可用或内容损坏时使用默认值 */
  }
  return next
}

function v2UpdateSettings(patch) {
  const next = Object.assign({}, v2ReadSettings(), patch || {})
  try {
    window.localStorage.setItem(V2_SETTINGS_KEY, JSON.stringify(next))
  } catch (error) {
    /* 写入失败时保持内存值，下次读取回退默认值 */
  }
  try {
    window.dispatchEvent(new CustomEvent('lifeos:settings-changed', { detail: next }))
  } catch (error) {
    /* 非浏览器环境忽略 */
  }
  return next
}

/* 日历默认视图：同步写入日历页签自己的状态键，确保下次打开即生效。 */
function v2SettingsApplyCalendarView(view) {
  try {
    let anchor = ''
    const raw = window.localStorage.getItem(V2_SETTINGS_CALENDAR_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.anchor === 'string') anchor = parsed.anchor
    }
    window.localStorage.setItem(V2_SETTINGS_CALENDAR_KEY, JSON.stringify({ view: view, anchor: anchor }))
  } catch (error) {
    /* 忽略 */
  }
}

/* ── 设置页 UI 小部件（仅本模块使用，v2set 前缀避免命名冲突） ── */

function v2setCard(title, hint, rows) {
  return h(
    'div',
    {
      key: 'card-' + title,
      style: Object.assign(v2CardStyle(), { padding: '14px 16px 4px', marginBottom: 12 }),
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 } },
      h('div', { style: { fontSize: V2_T.font.title, fontWeight: 600, color: V2_T.text.primary } }, title),
      hint ? h('div', { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary } }, hint) : null,
    ),
    rows,
  )
}

function v2setRows(items) {
  return h(
    'div',
    {},
    items.map(function renderRow(item, index) {
      return h(
        'div',
        {
          key: item.key || String(index),
          style: {
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 10,
            padding: '11px 0',
            borderTop: index === 0 ? 'none' : '1px solid ' + V2_T.border.subtle,
          },
        },
        h(
          'div',
          { style: { minWidth: 0, flex: '1 1 auto' } },
          h('div', { style: { fontSize: V2_T.font.body, color: V2_T.text.primary, lineHeight: '19px' } }, item.title),
          item.desc
            ? h('div', { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary, lineHeight: '16px', marginTop: 2 } }, item.desc)
            : null,
        ),
        h('div', { style: { flex: '0 0 auto' } }, item.control),
      )
    }),
  )
}

function v2setSegmented(props) {
  return h(
    'div',
    {
      role: 'group',
      'aria-label': props.label || '',
      style: {
        display: 'inline-flex',
        gap: 2,
        padding: 2,
        background: V2_T.surface.input,
        border: '1px solid ' + V2_T.border.subtle,
        borderRadius: V2_T.radius.sm,
      },
    },
    (props.options || []).map(function renderOption(option) {
      const active = option.value === props.value
      return h(
        'button',
        {
          key: String(option.value),
          type: 'button',
          'aria-pressed': active ? 'true' : 'false',
          onClick: function onClick() {
            props.onChange(option.value)
          },
          onFocus: function onFocus(event) {
            Object.assign(event.currentTarget.style, v2FocusRing({}))
          },
          onBlur: function onBlur(event) {
            event.currentTarget.style.boxShadow = 'none'
          },
          style: {
            height: 26,
            padding: '0 10px',
            border: '1px solid ' + (active ? V2_T.accent.line : 'transparent'),
            borderRadius: 6,
            background: active ? V2_T.accent.soft : 'transparent',
            color: active ? V2_T.accent.base : V2_T.text.secondary,
            fontSize: V2_T.font.caption,
            fontWeight: active ? 600 : 400,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          },
        },
        option.label,
      )
    }),
  )
}

function v2setToggle(props) {
  const checked = props.checked === true
  return h(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': checked ? 'true' : 'false',
      'aria-label': props.label || '',
      onClick: function onClick() {
        props.onChange(!checked)
      },
      onFocus: function onFocus(event) {
        Object.assign(event.currentTarget.style, v2FocusRing({}))
      },
      onBlur: function onBlur(event) {
        event.currentTarget.style.boxShadow = 'none'
      },
      style: {
        position: 'relative',
        width: 38,
        height: 22,
        padding: 0,
        border: '1px solid ' + (checked ? V2_T.accent.line : V2_T.border.strong),
        borderRadius: V2_T.radius.pill,
        background: checked ? V2_T.accent.soft : V2_T.surface.input,
        cursor: 'pointer',
        transition: 'background ' + V2_T.motion.fast + 'ms ease',
      },
    },
    h('span', {
      style: {
        position: 'absolute',
        top: 2,
        left: checked ? 18 : 2,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: checked ? V2_T.accent.base : V2_T.text.tertiary,
        transition: 'left ' + V2_T.motion.fast + 'ms ease, background ' + V2_T.motion.fast + 'ms ease',
      },
    }),
  )
}

function v2setAboutRow(label, value, key) {
  return h(
    'div',
    {
      key: key || label,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '9px 0',
        borderTop: '1px solid ' + V2_T.border.subtle,
      },
    },
    h('div', { style: { flex: '1 1 auto', fontSize: V2_T.font.caption, color: V2_T.text.tertiary } }, label),
    h('div', { style: { flex: '0 0 auto', fontSize: V2_T.font.caption, color: V2_T.text.secondary, textAlign: 'right' } }, value),
  )
}

function LifeosSettingsV2() {
  const [settings, setSettings] = useState(v2ReadSettings)
  const [savedAt, setSavedAt] = useState(0)
  const [resetArmed, setResetArmed] = useState(false)
  const timerRef = useRef(0)

  useEffect(function clearSavedHint() {
    return function cleanup() {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  function commit(patch) {
    const next = v2UpdateSettings(patch)
    setSettings(next)
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'calendarView')) {
      v2SettingsApplyCalendarView(next.calendarView)
    }
    setSavedAt(Date.now())
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(function hideHint() {
      setSavedAt(0)
    }, 1800)
  }

  function resetAll() {
    if (!resetArmed) {
      setResetArmed(true)
      return
    }
    const next = v2UpdateSettings(V2_SETTINGS_DEFAULTS)
    setSettings(next)
    v2SettingsApplyCalendarView(next.calendarView)
    setResetArmed(false)
    setSavedAt(Date.now())
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(function hideHint() {
      setSavedAt(0)
    }, 1800)
  }

  function optionsFor(key) {
    return (V2_SETTINGS_ENUMS[key] || []).map(function label(value) {
      return { value: value, label: V2_SETTINGS_LABELS[key][value] || String(value) }
    })
  }

  return h(
    'section',
    {
      'aria-label': 'LifeOS 设置',
      style: {
        padding: '20px 24px',
        maxWidth: 820,
        boxSizing: 'border-box',
        fontFamily: COLORS.fontFamily,
        color: V2_T.text.primary,
      },
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: 10, margin: '0 0 4px' } },
      h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600, color: V2_T.text.primary } }, 'LifeOS'),
      h('span', { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary } }, 'v' + PLUGIN_VERSION),
    ),
    h(
      'p',
      { style: { margin: '0 0 14px', fontSize: V2_T.font.meta, color: V2_T.text.tertiary, lineHeight: '18px' } },
      '四个页签的默认行为与编辑器偏好。修改立即生效并保存在本机。',
    ),
    h(
      'div',
      {
        'aria-live': 'polite',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minHeight: 18,
          marginBottom: 12,
          fontSize: V2_T.font.caption,
          color: savedAt ? V2_T.status.success : V2_T.text.tertiary,
        },
      },
      savedAt ? h(V2Icon, { name: 'check', size: 13, color: V2_T.status.success }) : null,
      savedAt ? '已自动保存' : '保存在本机 localStorage；不随导出迁移。',
    ),

    v2setCard(
      '通用',
      '',
      v2setRows([
        {
          key: 'restoreLastTab',
          title: '记住上次打开的页签',
          desc: '关闭则每次打开 LifeOS 都从「任务」开始。',
          control: v2setToggle({
            label: '记住上次打开的页签',
            checked: settings.restoreLastTab,
            onChange: function onChange(value) { commit({ restoreLastTab: value }) },
          }),
        },
      ]),
    ),

    v2setCard(
      '任务',
      '仅影响新打开的任务页签',
      v2setRows([
        {
          key: 'taskView',
          title: '默认视图',
          desc: '打开任务页签时优先使用列表或看板。',
          control: v2setSegmented({
            label: '任务默认视图',
            options: optionsFor('taskView'),
            value: settings.taskView,
            onChange: function onChange(value) { commit({ taskView: value }) },
          }),
        },
        {
          key: 'taskSort',
          title: '默认排序',
          desc: '仍可在任务页签内临时切换。',
          control: v2setSegmented({
            label: '任务默认排序',
            options: optionsFor('taskSort'),
            value: settings.taskSort,
            onChange: function onChange(value) { commit({ taskSort: value }) },
          }),
        },
      ]),
    ),

    v2setCard(
      '日历',
      '',
      v2setRows([
        {
          key: 'calendarView',
          title: '默认视图',
          desc: '下次打开日历页签时使用该视图；手动切换后以手动选择为准。',
          control: v2setSegmented({
            label: '日历默认视图',
            options: optionsFor('calendarView'),
            value: settings.calendarView,
            onChange: function onChange(value) { commit({ calendarView: value }) },
          }),
        },
      ]),
    ),

    v2setCard(
      '习惯',
      '',
      v2setRows([
        {
          key: 'habitShowPaused',
          title: '显示已暂停的习惯',
          desc: '关闭后，习惯页签的「已暂停」分组不再出现。',
          control: v2setToggle({
            label: '显示已暂停的习惯',
            checked: settings.habitShowPaused,
            onChange: function onChange(value) { commit({ habitShowPaused: value }) },
          }),
        },
      ]),
    ),

    v2setCard(
      '笔记',
      '',
      v2setRows([
        {
          key: 'notesAutosaveMs',
          title: '自动保存延迟',
          desc: '停止输入后等待多久写入磁盘。',
          control: v2setSegmented({
            label: '笔记自动保存延迟',
            options: optionsFor('notesAutosaveMs'),
            value: settings.notesAutosaveMs,
            onChange: function onChange(value) { commit({ notesAutosaveMs: value }) },
          }),
        },
        {
          key: 'notesFontSize',
          title: '编辑器字号',
          desc: '同时作用于编辑与预览。',
          control: v2setSegmented({
            label: '笔记编辑器字号',
            options: optionsFor('notesFontSize'),
            value: settings.notesFontSize,
            onChange: function onChange(value) { commit({ notesFontSize: value }) },
          }),
        },
      ]),
    ),

    v2setCard(
      '关于与数据',
      '',
      [
        v2setAboutRow('插件版本', PLUGIN_VERSION),
        v2setAboutRow('设置存放', '本机 localStorage（lifeos.v2.settings）'),
        v2setAboutRow('快捷键', 'Ctrl/⌘+Shift+Space 快速记录 · N 新建任务'),
        v2setAboutRow('页签范围', '任务 · 日历 · 习惯 · 笔记'),
        h(
          'div',
          { key: 'reset', style: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0 12px' } },
          h(
            'button',
            {
              type: 'button',
              onClick: resetAll,
              onFocus: function onFocus(event) {
                Object.assign(event.currentTarget.style, v2FocusRing({}))
              },
              onBlur: function onBlur(event) {
                event.currentTarget.style.boxShadow = 'none'
              },
              style: {
                height: 28,
                padding: '0 12px',
                border: '1px solid ' + (resetArmed ? V2_T.status.danger : V2_T.border.strong),
                borderRadius: V2_T.radius.sm,
                background: resetArmed ? V2_T.status.dangerSoft : 'transparent',
                color: resetArmed ? V2_T.status.danger : V2_T.text.secondary,
                fontSize: V2_T.font.caption,
                cursor: 'pointer',
              },
            },
            resetArmed ? '确认恢复默认设置' : '恢复默认设置',
          ),
          h(
            'span',
            { style: { fontSize: V2_T.font.caption, color: V2_T.text.tertiary } },
            resetArmed ? '再次点击才会执行。' : '仅重置以上偏好，不删除任务、习惯或笔记。',
          ),
        ),
      ],
    ),
  )
}

/* ==== V2-MODULES-END ==== */

    /* ═════════════════════════ 插件体 ═════════════════════════ */

    function selectMainPanel() {
      try {
        if (typeof LifeosMainV2 === 'function') return LifeosMainV2
        if (typeof LifeosPanelV2 === 'function') return LifeosPanelV2
      } catch (error) {
        /* 落到兜底面板 */
      }
      return typeof V2UnavailablePanel === 'function' ? V2UnavailablePanel : null
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined
          if (layout && typeof layout.selectPanel === 'function') {
            navigation.selectConversation = function selectConversation() {
              layout.selectPanel(null)
            }
          }
        } catch (error) {
          /* layout 不可用时深整理只复制摘要 */
        }
        ctx.slots.inject('sidebar.panellist', function registerPanelIcon() {
          return ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: 'LifeOS' },
            withBoundary(LifeosIcon, '侧栏图标'),
          )
        })

        ctx.slots.inject('main', function registerMainPanel() {
          return ctx.slots.register(
            { name: 'main', key: PANEL_ID },
            withBoundary(selectMainPanel(), '主面板'),
          )
        })

        ctx.slots.inject('shell.overlay', function registerOverlay() {
          return ctx.slots.register(
            { name: 'shell.overlay', id: OVERLAY_ID, order: 10 },
            withBoundary(LifeosOverlay, '快速记录'),
          )
        })

        ctx.slots.inject('settings.section', function registerSettings() {
          return ctx.slots.register(
            { name: 'settings.section', id: PANEL_ID, order: 50, label: 'LifeOS' },
            withBoundary(typeof LifeosSettingsV2 === 'function' ? LifeosSettingsV2 : LifeosSettings, '设置页'),
          )
        })

        registerShortcut(ctx)

        // 侧栏未读通知徽标：即使面板未打开也预取一次未读数。
        try {
          m3.loadNotifications()
        } catch (error) {
          /* ignore */
        }

        /* M0 验收：激活即自检一次（Host 配置 clientSelfCheck 控制；产品期关闭） */
        try {
          runActivationSelfCheck()
        } catch (error) {
          /* 自检失败不影响面板 */
        }

        ctx.effect(function runtimeCleanup() {
          return function disposeRuntime() {
            try {
              runtime.dispose()
            } catch (error) {
              /* ignore */
            }
            try {
              board.dispose()
            } catch (error) {
              /* ignore */
            }
            try {
              triage.dispose()
            } catch (error) {
              /* ignore */
            }
            try {
              notes.dispose()
            } catch (error) {
              /* ignore */
            }
            try {
              m3.dispose()
            } catch (error) {
              /* ignore */
            }
            try {
              m4.dispose()
            } catch (error) {
              /* ignore */
            }
          }
        }, 'lifeos: runtime cleanup')
      },
    }
  },
})
