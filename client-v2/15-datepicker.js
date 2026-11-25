/* ═══════════════════════ M16 · 共享日期选择器 ═══════════════════════
 * 统一任务详情、日历顶部跳转等所有日期入口：圆角、可清空、可切换月份。
 * 值统一使用本地日期键（YYYY-MM-DD）；空值表示未设置日期。
 */

const V2DP_WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']
const V2DP_WEEK_LONG = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function v2dpPad(value) {
  return value < 10 ? '0' + value : String(value)
}

function v2dpKeyOf(date) {
  return date.getFullYear() + '-' + v2dpPad(date.getMonth() + 1) + '-' + v2dpPad(date.getDate())
}

function v2dpTodayKey() {
  return v2dpKeyOf(new Date())
}

function v2dpDateOf(key) {
  if (!key) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key))
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

/* value 可能是 dayKey、ISO datetime 或空，统一转换为本地日期键 */
function v2dpDayKeyOf(value) {
  if (!value) return ''
  const text = String(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return ''
  return v2dpKeyOf(parsed)
}

function v2dpAddDays(key, days) {
  const date = v2dpDateOf(key) || new Date()
  date.setDate(date.getDate() + days)
  return v2dpKeyOf(date)
}

function v2dpShiftMonth(key, delta) {
  const date = v2dpDateOf(key) || new Date()
  const day = date.getDate()
  date.setDate(1)
  date.setMonth(date.getMonth() + delta)
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  date.setDate(Math.min(day, daysInMonth))
  return v2dpKeyOf(date)
}

function v2dpStartOfMonth(key) {
  const date = v2dpDateOf(key) || new Date()
  date.setDate(1)
  return v2dpKeyOf(date)
}

function v2dpMondayOf(key) {
  const date = v2dpDateOf(key) || new Date()
  const weekday = date.getDay()
  date.setDate(date.getDate() + (weekday === 0 ? -6 : 1 - weekday))
  return v2dpKeyOf(date)
}

/* 月视图固定 6×7，从周一开始 */
function v2dpMonthMatrix(anchorKey) {
  const start = v2dpMondayOf(v2dpStartOfMonth(anchorKey))
  const days = []
  for (let index = 0; index < 42; index += 1) days.push(v2dpAddDays(start, index))
  return days
}

function v2dpMonthTitle(key) {
  const date = v2dpDateOf(key) || new Date()
  return date.getFullYear() + ' 年 ' + (date.getMonth() + 1) + ' 月'
}

function v2dpRelativeLabel(key) {
  if (!key) return ''
  const today = v2dpTodayKey()
  if (key === today) return '今天'
  if (key === v2dpAddDays(today, 1)) return '明天'
  if (key === v2dpAddDays(today, 2)) return '后天'
  if (key === v2dpAddDays(today, -1)) return '昨天'
  return v2dpDateLabel(key)
}

function v2dpDateLabel(key) {
  const date = v2dpDateOf(key)
  if (!date) return ''
  const year = date.getFullYear()
  const text = (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日 ' + V2DP_WEEK_LONG[(date.getDay() + 6) % 7]
  if (year === new Date().getFullYear()) return text
  return year + ' 年 ' + text
}

/* 共享日期选择器：受控组件，onChange(key) / onClear() 均为可选 */
function V2DatePicker(props) {
  const value = v2dpDayKeyOf(props.value)
  const [open, setOpen] = React.useState(false)
  const [month, setMonth] = React.useState(value || v2dpTodayKey())
  const rootRef = React.useRef(null)
  const disabled = !!props.disabled

  React.useEffect(function syncMonth() {
    if (!open) return
    setMonth(value || v2dpTodayKey())
  }, [open, value])

  React.useEffect(function closeOnOutside() {
    if (!open) return undefined
    function onPointer(event) {
      if (rootRef.current && rootRef.current.contains(event.target)) return
      setOpen(false)
    }
    function onKey(event) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return function cleanup() {
      document.removeEventListener('mousedown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  function emit(nextKey) {
    setOpen(false)
    if (props.onChange) props.onChange(nextKey)
  }

  function pick(key) {
    emit(key)
  }

  function clear(event) {
    if (event) {
      event.preventDefault()
      event.stopPropagation()
    }
    setOpen(false)
    if (props.onClear) props.onClear()
    else if (props.onChange) props.onChange('')
  }

  const compact = props.compact === true
  const width = props.width || (compact ? 'auto' : '150px')
  const label = value ? v2dpRelativeLabel(value) : (props.placeholder || '选择日期')
  const today = v2dpTodayKey()
  const cells = v2dpMonthMatrix(month)

  return h(
    'div',
    { ref: rootRef, style: { position: 'relative', display: 'inline-flex', minWidth: 0 } },
    h(
      'button',
      {
        type: 'button',
        disabled: disabled,
        title: props.title || (value ? '更改日期' : '设置日期'),
        'aria-haspopup': 'dialog',
        'aria-expanded': open ? 'true' : 'false',
        onClick: function toggle() { if (!disabled) setOpen(function flip(prev) { return !prev }) },
        style: v2InputStyle({
          display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px',
          width: width, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
          padding: compact ? '2px 8px' : '4px 10px', height: compact ? '26px' : '30px',
          textAlign: 'left', color: value ? V2_T.text.primary : V2_T.text.tertiary,
          background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle,
          fontSize: v2fs(compact ? 11 : 12),
        }),
      },
      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
      h('span', { style: { color: V2.faint, fontSize: v2fs(10) } }, '▾'),
    ),
    open && h(
      'div',
      {
        role: 'dialog',
        'aria-label': '选择日期',
        style: {
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 100001, width: '252px',
          background: V2_T.surface.panel, border: '1px solid ' + V2_T.border.subtle,
          borderRadius: V2_T.radius.lg + 'px', boxShadow: V2_T.shadow.pop, padding: '8px',
        },
      },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px', marginBottom: '6px' } },
        h('button', {
          type: 'button', title: '上个月', onClick: function prev() { setMonth(function shift(prevKey) { return v2dpShiftMonth(prevKey, -1) }) },
          style: v2BtnStyle('ghost', { width: '26px', height: '26px', padding: '0', fontSize: v2fs(13) }),
        }, '‹'),
        h('span', { style: { fontSize: v2fs(12), fontWeight: '600', color: V2_T.text.primary } }, v2dpMonthTitle(month)),
        h('button', {
          type: 'button', title: '下个月', onClick: function next() { setMonth(function shift(prevKey) { return v2dpShiftMonth(prevKey, 1) }) },
          style: v2BtnStyle('ghost', { width: '26px', height: '26px', padding: '0', fontSize: v2fs(13) }),
        }, '›'),
      ),
      h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', marginBottom: '4px' } },
        V2DP_WEEK_LABELS.map(function renderWeek(label) {
          return h('span', {
            key: 'v2dp-week-' + label,
            style: { fontSize: v2fs(10), color: V2_T.text.tertiary, textAlign: 'center', padding: '2px 0' },
          }, label)
        }),
      ),
      h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' } },
        cells.map(function renderDay(day) {
          const date = v2dpDateOf(day)
          const inMonth = date.getMonth() === (v2dpDateOf(month) || new Date()).getMonth()
          const selected = day === value
          const isToday = day === today
          return h(
            'button',
            {
              key: 'v2dp-day-' + day,
              type: 'button',
              'aria-label': day,
              'aria-pressed': selected ? 'true' : 'false',
              onClick: function pickDay() { pick(day) },
              style: {
                height: '28px', borderRadius: V2_T.radius.sm + 'px', border: '1px solid transparent',
                background: selected ? V2.accentSoft : 'transparent',
                color: selected ? V2_T.text.primary : inMonth ? V2_T.text.secondary : V2.faint,
                fontSize: v2fs(11), cursor: 'pointer',
                outline: isToday ? '1px solid ' + V2_T.accent.line : 'none', outlineOffset: '-1px',
                fontWeight: selected || isToday ? '600' : '400',
              },
            },
            date.getDate(),
          )
        }),
      ),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', marginTop: '8px' } },
        h('button', {
          type: 'button', onClick: function goToday() { pick(today) },
          style: v2BtnStyle('ghost', { height: '24px', padding: '0 8px', fontSize: v2fs(11) }),
        }, '今天'),
        h('button', {
          type: 'button', onClick: clear, disabled: !value,
          style: v2BtnStyle('ghost', { height: '24px', padding: '0 8px', fontSize: v2fs(11), opacity: value ? 1 : 0.4, cursor: value ? 'pointer' : 'not-allowed' }),
        }, '清空'),
      ),
    ),
  )
}
