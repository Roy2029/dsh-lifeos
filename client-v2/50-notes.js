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
