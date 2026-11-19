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
    caption: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary, lineHeight: '16px' },
    meta: { fontSize: v2fs(V2_T.font.meta), color: V2_T.text.tertiary, lineHeight: '18px' },
    body: { fontSize: v2fs(V2_T.font.body), color: V2_T.text.primary, lineHeight: '20px' },
    sub: { fontSize: v2fs(V2_T.font.body), color: V2_T.text.secondary, lineHeight: '20px' },
    title: { fontSize: v2fs(V2_T.font.title), color: V2_T.text.primary, fontWeight: 600, lineHeight: '22px' },
    hero: { fontSize: v2fs(V2_T.font.hero), color: V2_T.text.primary, fontWeight: 600, lineHeight: '26px' },
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
