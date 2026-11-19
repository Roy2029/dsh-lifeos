/* ═══════════════════════ M12 · LifeOS 设置页（V2） ═══════════════════════
 * 目标：替换 M0 诊断页，呈现当前四个页签真正可用的偏好设置。
 * 存储：localStorage['lifeos.v2.settings']（本机、无 Host schema 变更）；
 *       修改后立即写入并派发 'lifeos:settings-changed'，供各模块读取/生效。
 */

const V2_SETTINGS_KEY = 'lifeos.v2.settings'
const V2_SETTINGS_CALENDAR_KEY = 'lifeos.v2.calendar'

const V2_SETTINGS_DEFAULTS = {
  restoreLastTab: true,
  uiFontSize: 'medium',
  taskView: 'list',
  taskSort: 'custom',
  calendarView: 'week',
  habitShowPaused: true,
  notesAutosaveMs: 800,
  notesFontSize: 13.5,
}

const V2_SETTINGS_ENUMS = {
  uiFontSize: ['small', 'medium', 'large', 'xlarge'],
  taskView: ['list', 'board'],
  taskSort: ['custom', 'created', 'date', 'priority'],
  calendarView: ['month', 'week', 'day'],
  notesAutosaveMs: [500, 800, 1500],
  notesFontSize: [13, 13.5, 15],
}

const V2_SETTINGS_LABELS = {
  uiFontSize: { small: '小', medium: '中', large: '大', xlarge: '超大' },
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
      h('div', { style: { fontSize: v2fs(V2_T.font.title), fontWeight: 600, color: V2_T.text.primary } }, title),
      hint ? h('div', { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary } }, hint) : null,
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
          h('div', { style: { fontSize: v2fs(V2_T.font.body), color: V2_T.text.primary, lineHeight: '19px' } }, item.title),
          item.desc
            ? h('div', { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary, lineHeight: '16px', marginTop: 2 } }, item.desc)
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
            fontSize: v2fs(V2_T.font.caption),
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
    h('div', { style: { flex: '1 1 auto', fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary } }, label),
    h('div', { style: { flex: '0 0 auto', fontSize: v2fs(V2_T.font.caption), color: V2_T.text.secondary, textAlign: 'right' } }, value),
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
      h('h2', { style: { margin: 0, fontSize: v2fs(18), fontWeight: 600, color: V2_T.text.primary } }, 'LifeOS'),
      h('span', { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary } }, 'v' + PLUGIN_VERSION),
    ),
    h(
      'p',
      { style: { margin: '0 0 14px', fontSize: v2fs(V2_T.font.meta), color: V2_T.text.tertiary, lineHeight: '18px' } },
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
          fontSize: v2fs(V2_T.font.caption),
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
          key: 'uiFontSize',
          title: '界面字号',
          desc: '影响任务、日历、习惯与设置页；笔记字号在笔记编辑器内单独调整。',
          control: v2setSegmented({
            label: '界面字号',
            options: optionsFor('uiFontSize'),
            value: settings.uiFontSize,
            onChange: function onChange(value) { commit({ uiFontSize: value }) },
          }),
        },
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
      '编辑器字号在笔记页签内调整',
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
                fontSize: v2fs(V2_T.font.caption),
                cursor: 'pointer',
              },
            },
            resetArmed ? '确认恢复默认设置' : '恢复默认设置',
          ),
          h(
            'span',
            { style: { fontSize: v2fs(V2_T.font.caption), color: V2_T.text.tertiary } },
            resetArmed ? '再次点击才会执行。' : '仅重置以上偏好，不删除任务、习惯或笔记。',
          ),
        ),
      ],
    ),
  )
}
