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
