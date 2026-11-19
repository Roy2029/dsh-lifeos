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
