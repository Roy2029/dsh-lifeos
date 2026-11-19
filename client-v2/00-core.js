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

/* ── 全局界面字号（小/中/大/超大） ──
 * 说明：任务/日历/习惯/设置页共用 --v2-font-scale 根变量缩放文字；笔记编辑器字号单独在笔记内调整。
 * 设置存储仍由 60-settings 负责，这里只读取 uiFontSize 并派发 CSS 变量，避免核心层依赖设置模块。 */
const V2_FONT_SCALE_CHOICES = { small: 0.92, medium: 1, large: 1.08, xlarge: 1.18 }
let v2FontScaleCache = null

function v2FontScale() {
  if (v2FontScaleCache !== null) return v2FontScaleCache
  let scale = 1
  try {
    const raw = window.localStorage.getItem('lifeos.v2.settings')
    const parsed = raw ? JSON.parse(raw) : null
    const chosen = parsed && parsed.uiFontSize
    scale = V2_FONT_SCALE_CHOICES[chosen] || 1
  } catch (error) {
    scale = 1
  }
  v2FontScaleCache = scale
  return scale
}

/* 数字字号 → 跟随根变量的 calc 字符串；非数字原样返回（例如 '12px' 或 token 计算值）。 */
function v2fs(size) {
  const n = Number(size)
  if (!Number.isFinite(n)) return size
  return 'calc(' + n + 'px * var(--v2-font-scale, 1))'
}

function v2ApplyFontScale() {
  try {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.style.setProperty('--v2-font-scale', String(v2FontScale()))
    }
  } catch (error) {
    /* 非浏览器环境忽略 */
  }
}

try {
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('lifeos:settings-changed', function onSettingsChanged() {
      v2FontScaleCache = null
      v2ApplyFontScale()
    })
  }
} catch (error) {
  /* ignore */
}
v2ApplyFontScale()

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
