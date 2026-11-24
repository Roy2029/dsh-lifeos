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

/* ═════════ 任务 Tab 页面状态（#4）：scope / 选中 / 详情 / 筛选排序 / 折叠 / 滚动 ═════════
   单独使用 lifeos.v2.state.task，和 lifeos.v2.taskPanes（三栏宽度）、
   lifeos.v2.settings（全局默认值）互不覆盖；任何读取失败都回退默认值。 */

const V2_TASK_STATE_KEY = 'lifeos.v2.state.task'

const V2_TASK_STATE_SCOPES = ['today', 'next7', 'inbox', 'done', 'trash', 'list', 'tag', 'filter']

const V2_TASK_STATE_SECTIONS = ['lists', 'filters', 'tags', 'archive']

function v2SanitizeTaskScope(scope) {
  if (!scope || typeof scope !== 'object') return null
  const kind = String(scope.kind || '')
  if (V2_TASK_STATE_SCOPES.indexOf(kind) < 0) return null
  const id = typeof scope.id === 'string' ? scope.id : ''
  /* list / tag / filter 依赖 id 定位，缺 id 时回退到默认 scope，避免打开后空列表 */
  if ((kind === 'list' || kind === 'tag' || kind === 'filter') && !id) return null
  const next = { kind: kind }
  if (id) next.id = id
  if (kind === 'filter' && typeof scope.label === 'string' && scope.label) next.label = scope.label
  return next
}

function v2ReadTaskState() {
  const fallbackFolded = {}
  V2_TASK_STATE_SECTIONS.forEach(function each(key) { fallbackFolded[key] = false })
  const fallback = {
    scope: null,
    view: null,
    sort: null,
    query: '',
    selectedId: null,
    detailOpen: false,
    collapsed: {},
    leftFolded: fallbackFolded,
    scroll: null,
  }
  try {
    const raw = window.localStorage.getItem(V2_TASK_STATE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallback
    const collapsed = {}
    if (parsed.collapsed && typeof parsed.collapsed === 'object') {
      Object.keys(parsed.collapsed).forEach(function each(key) {
        if (parsed.collapsed[key] === true) collapsed[key] = true
      })
    }
    const leftFolded = {}
    V2_TASK_STATE_SECTIONS.forEach(function each(key) {
      leftFolded[key] = !!(parsed.leftFolded && parsed.leftFolded[key] === true)
    })
    const view = parsed.view === 'board' || parsed.view === 'list' ? parsed.view : null
    const sort = ['custom', 'created', 'date', 'priority'].indexOf(parsed.sort) >= 0 ? parsed.sort : null
    let scroll = null
    if (parsed.scroll && typeof parsed.scroll.key === 'string' && Number.isFinite(Number(parsed.scroll.top))) {
      scroll = { key: parsed.scroll.key, top: Math.max(0, Math.round(Number(parsed.scroll.top))) }
    }
    return {
      scope: v2SanitizeTaskScope(parsed.scope),
      view: view,
      sort: sort,
      query: typeof parsed.query === 'string' ? parsed.query.slice(0, 120) : '',
      selectedId: typeof parsed.selectedId === 'string' && parsed.selectedId ? parsed.selectedId : null,
      detailOpen: parsed.detailOpen === true,
      collapsed: collapsed,
      leftFolded: leftFolded,
      scroll: scroll,
    }
  } catch (error) {
    return fallback
  }
}

function v2WriteTaskState(snapshot) {
  try {
    window.localStorage.setItem(V2_TASK_STATE_KEY, JSON.stringify(snapshot))
  } catch (error) {
    /* localStorage 不可用 / 配额不足时静默忽略，不影响交互 */
  }
}

/* #9：鼠标点击标题进入 inline 编辑时，按点击坐标取字符位置（键盘/按钮入口仍全选）。
   优先使用浏览器 caretPositionFromPoint / caretRangeFromPoint；
   不可用或坐标落在标题外时返回 null，调用方回退到“全选”。 */
function v2CaretIndexFromPoint(element, x, y) {
  if (!element || typeof document === 'undefined' || typeof x !== 'number' || typeof y !== 'number') return null
  let node = null
  let offset = 0
  try {
    if (typeof document.caretPositionFromPoint === 'function') {
      const position = document.caretPositionFromPoint(x, y)
      if (position) {
        node = position.offsetNode
        offset = position.offset
      }
    } else if (typeof document.caretRangeFromPoint === 'function') {
      const range = document.caretRangeFromPoint(x, y)
      if (range) {
        node = range.startContainer
        offset = range.startOffset
      }
    }
  } catch (error) {
    return null
  }
  if (!node || !element.contains(node)) return null
  try {
    const measure = document.createRange()
    measure.selectNodeContents(element)
    measure.setEnd(node, offset)
    return measure.toString().length
  } catch (error) {
    return null
  }
}

/* #17：多选模式的行尾选择框（方形，和圆角完成框明显区分） */
function v2SelectSquareStyle(selected) {
  return {
    width: 18,
    height: 18,
    minWidth: 18,
    borderRadius: 4,
    border: '1.5px solid ' + (selected ? V2_T.accent.base : V2_T.border.strong),
    background: selected ? V2_T.accent.soft : 'transparent',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: 0,
    flex: '0 0 auto',
    color: V2_T.accent.base,
    transition: 'border-color 120ms ease, background 120ms ease',
  }
}

function TaskArowV2(props) {
  const task = props.task
  const selected = props.selected
  const editing = props.editing
  const childCount = props.childCount
  const doneChild = props.doneChild
  /* 视觉变体：看板列中的任务项用浮起卡片；列表内仍是扁平行（仅样式差异，无行为差异） */
  const carded = props.card === true
  /* #17：多选模式隐藏行首完成框，改用行尾方形选择框，避免误点完成 */
  const selectMode = props.selectMode === true
  const repeatRule = v2RepeatRuleOf(task)
  const [draft, setDraft] = useState(task.title)
  /* 拖拽插入位置提示：'' | 'before' | 'after' */
  const [dropSide, setDropSide] = useState('')
  const inputRef = useRef(null)

  useEffect(function syncDraft() {
    setDraft(task.title)
  }, [task.title])

  useEffect(function focusEditor() {
    if (!editing || !inputRef.current) return
    const input = inputRef.current
    input.focus()
    /* #9：鼠标点击标题进入编辑时把光标落在点击处；
       键盘/按钮入口没有 caret，保持原来的全选行为。 */
    const caret = typeof props.editCaret === 'number' ? props.editCaret : -1
    if (caret >= 0) {
      const position = Math.min(caret, String(draft).length)
      try {
        input.setSelectionRange(position, position)
        return
      } catch (error) {
        /* 个别浏览器不支持对当前输入类型 setSelectionRange，回退全选 */
      }
    }
    input.select()
  }, [editing])

  /* 拖拽可能在行外松手（窗口/其它容器/取消），dragend 不一定经过本行；
     统一监听 window 的 dragend/drop 清理插入线，避免蓝条残留。 */
  useEffect(function clearDropHintOnDragEnd() {
    function clear() {
      setDropSide(function current(side) { return side ? '' : side })
    }
    window.addEventListener('dragend', clear, true)
    window.addEventListener('drop', clear, true)
    return function cleanup() {
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('drop', clear, true)
    }
  }, [])

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
      props.selectMode ? null : h('button', { type: 'button', onClick: props.onToggle, style: v2CheckStyle(task) }),
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
        style: v2InputStyle({ flex: '1 1 auto', fontSize: v2fs(13), padding: '4px 8px', borderRadius: V2_T.radius.sm }),
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
        /* 命中测试：用 clientY 与行矩形中线比较（矩形含 padding/border），
           鼠标所在半区即插入位置，不要求拖到行正中央。 */
        const rect = e.currentTarget.getBoundingClientRect()
        const side = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
        if (side !== dropSide) setDropSide(side)
      },
      onDragLeave: function onDragLeave(e) {
        if (e.currentTarget.contains(e.relatedTarget)) return
        if (dropSide) setDropSide('')
      },
      onDrop: function onDrop(e) {
        e.preventDefault()
        e.stopPropagation()
        const rect = e.currentTarget.getBoundingClientRect()
        const side = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
        setDropSide('')
        if (props.onDrop) props.onDrop(e, task, side)
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
          position: 'relative',
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
        if (actions) actions.style.opacity = selectMode ? '1' : '0.75'
      },
      onMouseLeave: function leave(e) {
        e.currentTarget.style.background = selected ? V2_T.surface.panel3 : carded ? V2_T.surface.panel2 : 'transparent'
        const actions = e.currentTarget.querySelector('.v2-row-actions')
        if (actions) actions.style.opacity = selectMode ? '1' : '0.4'
      },
    },
    selectMode
      ? null
      : h('button', {
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
            /* #17：多选模式下点击标题交给整行选择，不进入 inline 编辑 */
            if (selectMode) return
            e.stopPropagation()
            /* 只有鼠标点击标题才计算光标位置；onStartEdit 的第二参为 null 时父层回退全选 */
            props.onStartEdit(task, v2CaretIndexFromPoint(e.currentTarget, e.clientX, e.clientY))
          },
          style: {
            fontSize: v2fs(13.5),
            color: v2TaskCompleted(task) ? V2_T.text.tertiary : V2_T.text.primary,
            textDecoration: v2TaskCompleted(task) ? 'line-through' : 'none',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            lineHeight: '18px',
            /* 标题可原地编辑：悬停显示 I 字光标，提示“点这里改名”，而非打开详情 */
            cursor: 'text',
            userSelect: 'none',
          },
        }, task.title),
        v2TaskPinned(task) ? h(V2Icon, { name: 'pin', size: 11, color: V2.faint }) : null,
        childCount > 0
          ? h('span', { style: { fontSize: v2fs(11), color: V2_T.text.tertiary } }, '· ' + doneChild + '/' + childCount + ' 子任务')
          : null,
      ),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, fontSize: v2fs(12), color: V2_T.text.tertiary, minHeight: 18 } },
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
              fontSize: v2fs(11),
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
                style: { display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: v2fs(11), color: V2_T.text.tertiary, whiteSpace: 'nowrap' },
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
        style: { display: 'flex', alignItems: 'center', gap: 2, opacity: selectMode ? 1 : 0.4, transition: 'opacity 120ms ease' },
      },
      selectMode
        ? h('button', {
            type: 'button',
            title: selected ? '取消选择' : '选择任务',
            'aria-pressed': selected ? 'true' : 'false',
            'aria-label': '选择任务',
            onClick: function onSelectClick(e) {
              e.stopPropagation()
              if (props.onSelectToggle) props.onSelectToggle(task)
            },
            onFocus: function onFocus(e) { Object.assign(e.currentTarget.style, v2FocusRing({})) },
            onBlur: function onBlur(e) { e.currentTarget.style.boxShadow = 'none' },
            style: v2SelectSquareStyle(selected),
          }, selected ? h(V2Icon, { name: 'check', size: 11, color: V2_T.accent.base, strokeWidth: 3 }) : null)
        : null,
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
    dropSide
      ? h('div', {
          key: 'drop-line',
          'aria-hidden': 'true',
          style: {
            position: 'absolute',
            left: 2,
            right: 2,
            top: dropSide === 'before' ? -1 : 'auto',
            bottom: dropSide === 'after' ? -1 : 'auto',
            height: 2,
            borderRadius: 1,
            background: V2_T.accent.base,
            boxShadow: '0 0 0 1px ' + V2_T.accent.line,
            pointerEvents: 'none',
            zIndex: 2,
          },
        })
      : null,
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
    /* #4：先恢复上次的 scope / 折叠 / 搜索词；view/sort 仍以全局默认值为初值，
       mount 后再用 lifeos.v2.state.task 覆盖（避免闪一下默认视图）。 */
    const saved = v2ReadTaskState()
    return {
      loading: true,
      error: null,
      tasks: [],
      done: [],
      trash: [],
      lists: [],
      groups: [],
      scope: saved.scope || { kind: 'today' },
      view: prefs.taskView === 'board' ? 'board' : 'list',
      sort: prefs.taskSort || 'custom',
      selectedId: null,
      detail: null,
      editingId: null,
      collapsed: saved.collapsed,
      leftFolded: saved.leftFolded,
      query: saved.query,
      searchOpen: saved.query.length > 0,
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
  /* 详情标题的“已提交值”：state.detail 会随输入实时变化，
     不能再用 task.title 判断是否有改动，否则永远判定为“未修改”而不落库。 */
  const detailTitleRef = useRef({ id: null, title: '' })
  const detailNotesRef = useRef({ id: null, notes: '' })
  /* #9：进入 inline 编辑时的点击光标位置（-1 表示键盘/按钮入口 → 全选） */
  const editCaretRef = useRef(-1)
  /* #13：搜索输入框与“用户主动打开搜索”的聚焦标记 */
  const searchInputRef = useRef(null)
  const searchFocusRef = useRef(false)
  /* #7：分组内“添加任务”输入框，创建后保持焦点 */
  const groupAddInputRef = useRef(null)
  /* #4：列表滚动容器 + 滚动位置持久化 */
  const listScrollRef = useRef(null)
  const lastScrollRef = useRef(0)
  const restoredScrollRef = useRef('')
  const pendingScrollRef = useRef(null)
  const scrollPersistRef = useRef(null)
  const hydratedRef = useRef(false)
  const restoreDetailRef = useRef(null)
  stateRef.current = state
  panesRef.current = panes

  function update(patch) {
    setState(function merge(prev) { return Object.assign({}, prev, patch) })
  }

  /* #4：把当前页面状态写回 lifeos.v2.state.task（容错在 v2WriteTaskState 内） */
  function persistTaskStateNow() {
    if (!hydratedRef.current) return
    const current = stateRef.current
    v2WriteTaskState({
      scope: current.scope,
      view: current.view,
      sort: current.sort,
      query: current.query,
      selectedId: current.selectionMode ? null : current.selectedId,
      detailOpen: !current.selectionMode && !!current.detail,
      collapsed: current.collapsed,
      leftFolded: current.leftFolded,
      scroll: { key: scopeKey(current.scope), top: Math.max(0, Math.round(lastScrollRef.current || 0)) },
    })
  }

  /* #2：多选开关统一入口——进入时清掉单选高亮/详情/编辑态，退出时清空选中集合；
     行高亮只由 selectedIds 驱动，避免旧的 selectedId 蓝色高亮残留在多选模式里。 */
  function changeSelectionMode(next) {
    if (!next) {
      update({ selectionMode: false, selectedIds: [] })
      return
    }
    update({ selectionMode: true, selectedIds: [], selectedId: null, detail: null, editingId: null })
  }

  /* #4：列表滚动时记录位置（250ms 防抖落盘） */
  function onListScroll(event) {
    lastScrollRef.current = event.currentTarget.scrollTop
    if (scrollPersistRef.current) return
    scrollPersistRef.current = window.setTimeout(function flushScroll() {
      scrollPersistRef.current = null
      persistTaskStateNow()
    }, 250)
  }

  /* #4：左栏四个分区（清单/过滤器/标签/收纳区）折叠状态 */
  function toggleLeftSection(key) {
    const next = Object.assign({}, stateRef.current.leftFolded)
    next[key] = !next[key]
    update({ leftFolded: next })
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
    /* #4：恢复上次的任务页状态（view/sort 覆盖全局默认值，scope 已在 initial 中恢复） */
    const saved = v2ReadTaskState()
    const patch = {}
    if (saved.view) patch.view = saved.view
    if (saved.sort) patch.sort = saved.sort
    if (Object.keys(patch).length) update(patch)
    pendingScrollRef.current = saved.scroll
    restoreDetailRef.current = saved.selectedId && saved.detailOpen ? saved.selectedId : null
    reload(true).then(function afterFirstLoad(payload) {
      if (payload) {
        /* 用 payload 而不是 stateRef.current：此时 reload 的 setState 还没渲染，stateRef 可能是旧值 */
        const scope = stateRef.current.scope || { kind: 'today' }
        const lists = payload.lists || []
        const tags = payload.tags || []
        const scopeAlive = scope.kind === 'list'
          ? lists.some(function hasList(list) { return list.id === scope.id })
          : scope.kind === 'tag'
            ? tags.some(function hasTag(tag) { return tag.id === scope.id })
            : true
        if (!scopeAlive) {
          update({ scope: { kind: 'today' }, detail: null, selectedId: null })
        } else {
          const wantedId = restoreDetailRef.current
          restoreDetailRef.current = null
          if (wantedId) {
            const found = v2FindTaskById(payload.tasks || [], wantedId) || v2FindTaskById(payload.done || [], wantedId) || v2FindTaskById(payload.trash || [], wantedId)
            if (found) {
              detailTitleRef.current = { id: found.id, title: found.title }
              detailNotesRef.current = { id: found.id, notes: found.notes || '' }
              update({ selectedId: found.id, detail: found })
            }
          }
        }
      }
      hydratedRef.current = true
    })
  }, [])

  useEffect(function refreshOnSignal() {
    if (refreshSignal > 0) reload(false)
  }, [refreshSignal])

  useEffect(function focusQuickAdd() {
    if (quickAddSignal > 0 && inputRef.current) inputRef.current.focus()
  }, [quickAddSignal])

  /* #13：搜索框展开后聚焦 */
  useEffect(function focusSearchInput() {
    if (!state.searchOpen || !searchFocusRef.current) return
    searchFocusRef.current = false
    if (searchInputRef.current) {
      searchInputRef.current.focus()
      try {
        searchInputRef.current.select()
      } catch (error) {
        /* 选择失败不影响输入 */
      }
    }
  }, [state.searchOpen])

  /* #4：列表滚动位置恢复（切换 scope / 首次加载后各执行一次） */
  useEffect(function restoreScrollPosition() {
    if (state.loading) return
    const el = listScrollRef.current
    if (!el) return
    const key = scopeKey(state.scope)
    if (restoredScrollRef.current === key) return
    restoredScrollRef.current = key
    const saved = pendingScrollRef.current
    pendingScrollRef.current = null
    el.scrollTop = saved && saved.key === key ? saved.top : 0
    lastScrollRef.current = el.scrollTop
  }, [state.loading, state.scope])

  /* #4：状态变化后落盘（hydrated 之后才写，避免覆盖已保存的选中任务） */
  useEffect(function persistTaskState() {
    persistTaskStateNow()
  }, [state.scope, state.view, state.sort, state.query, state.selectedId, state.detail, state.collapsed, state.leftFolded, state.selectionMode])

  /* #4：卸载时清掉滚动防抖定时器，并把最后一次状态落盘（切 Tab 不丢滚动位置） */
  useEffect(function cleanupScrollTimer() {
    return function cleanup() {
      if (scrollPersistRef.current) {
        window.clearTimeout(scrollPersistRef.current)
        scrollPersistRef.current = null
      }
      persistTaskStateNow()
    }
  }, [])

  /* #13："/" 快捷键展开并聚焦左栏搜索框 */
  useEffect(function searchShortcut() {
    function onKeyDown(event) {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      if (modalRef.current) return
      const target = event.target
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      if (stateRef.current.editingId) return
      event.preventDefault()
      if (!narrow && panesRef.current.listCollapsed) {
        savePanes(Object.assign({}, panesRef.current, { listCollapsed: false }))
      }
      searchFocusRef.current = true
      update({ searchOpen: true })
      /* 搜索框已经展开时 effect 不会重跑，这里直接聚焦 */
      if (searchInputRef.current) searchInputRef.current.focus()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return function cleanup() {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [narrow])

  /* 清单/分组拖拽在窗口外松手时 dragleave 不会触发，统一在 dragend 清空插入线 */
  useEffect(function clearPaneDropHintsOnDragEnd() {
    function clear() {
      if (stateRef.current.dropList) update({ dropList: null })
      if (stateRef.current.dropGroup) update({ dropGroup: null })
    }
    window.addEventListener('dragend', clear, true)
    return function cleanup() {
      window.removeEventListener('dragend', clear, true)
    }
  }, [])

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
        changeSelectionMode(false)
        return
      }
      /* #13：Escape 关闭左栏搜索框（焦点在搜索框内时由输入框自身处理） */
      if (current.searchOpen) {
        event.preventDefault()
        update({ searchOpen: false, query: '' })
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
      /* 失败时回滚乐观更新：拉回服务端真值，避免“前端成功、后端失败”的错位 */
      await reload(false)
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
    /* 垃圾桶批量（恢复/彻底删除）需要取到 trash 里的任务；非 trash scope 时 trash 为空，无副作用 */
    const all = state.tasks.concat(state.done, state.trash)
    return all.filter(function f(task) { return state.selectedIds.indexOf(task.id) >= 0 })
  }

  function batchRun(label, worker) {
    const tasks = selectedTasksNow()
    if (!tasks.length) return
    runMutation(async function doBatch() {
      for (const task of tasks) await worker(task)
      changeSelectionMode(false)
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

  /* #5：垃圾桶批量恢复——Host 无任务 batch 端点，逐条 POST /tasks/:id/restore */
  function batchRestore() {
    const count = selectedTasksNow().length
    batchRun('已恢复 ' + count + ' 个任务', function worker(task) {
      return apiRequest('/tasks/' + encodeURIComponent(task.id) + '/restore', {
        method: 'POST',
        body: JSON.stringify({ expectedRev: task.rev }),
      })
    })
  }

  /* #5：垃圾桶批量彻底删除——逐条 DELETE /tasks/:id?purge=1 */
  function batchPurge() {
    const count = selectedTasksNow().length
    batchRun('已彻底删除 ' + count + ' 个任务', function worker(task) {
      return apiRequest('/tasks/' + encodeURIComponent(task.id) + '?purge=1&expectedRev=' + encodeURIComponent(task.rev), { method: 'DELETE' })
    })
  }

  /* #2：批量移到分组——Host 没有任务 batch 端点，逐条 PATCH listId+groupId。
     Host 会校验分组必须属于目标清单，所以必须同时给 listId（不能只给 groupId）。 */
  function batchMoveToGroup(listId, groupId) {
    const count = selectedTasksNow().length
    const targetList = listId || null
    batchRun('已移动 ' + count + ' 个任务', function worker(task) {
      return apiRequest('/tasks/' + encodeURIComponent(task.id), {
        method: 'PATCH',
        body: JSON.stringify({ expectedRev: task.rev, listId: targetList, groupId: groupId || null }),
      })
    })
  }

  /* #2：批量移出分组——保留任务当前所在清单，只清空 groupId */
  function batchClearGroup() {
    const count = selectedTasksNow().length
    batchRun('已移出分组 ' + count + ' 个任务', function worker(task) {
      return apiRequest('/tasks/' + encodeURIComponent(task.id), {
        method: 'PATCH',
        body: JSON.stringify({ expectedRev: task.rev, groupId: null }),
      })
    })
  }

  function openBatchGroupMenu(event) {
    function groupListId(group) { return (group && (group.listId || group.list_id)) || null }
    const items = [{ label: '移出分组（保留清单）', icon: 'folder', onClick: batchClearGroup }]
    const ordered = []
    state.lists.forEach(function eachList(list) {
      state.groups.forEach(function eachGroup(group) {
        if (groupListId(group) === list.id && ordered.indexOf(group) < 0) ordered.push(group)
      })
    })
    state.groups.forEach(function eachOrphan(group) {
      if (ordered.indexOf(group) < 0 && groupListId(group)) ordered.push(group)
    })
    ordered.forEach(function each(group) {
      const targetList = groupListId(group)
      items.push({
        label: listNameOf(targetList) + ' / ' + group.name,
        icon: 'folder',
        onClick: function onClick() { batchMoveToGroup(targetList, group.id) },
      })
    })
    items.push({ type: 'separator' })
    items.push({ label: '取消多选', icon: 'close', onClick: function onClick() { changeSelectionMode(false) } })
    const rect = event && event.currentTarget ? event.currentTarget.getBoundingClientRect() : null
    openV2PlainMenu(rect ? Math.round(rect.left) : 220, rect ? Math.round(rect.bottom + 4) : 220, items)
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
      changeSelectionMode(false)
    }, '已添加标签')
  }

  function renderSelectionBar() {
    if (!state.selectionMode) return null
    const count = state.selectedIds.length
    const trashMode = state.scope.kind === 'trash'
    const soft = { fontSize: v2fs(11), height: 28, padding: '0 10px', borderRadius: V2_T.radius.sm, background: V2_T.surface.panel3, color: V2_T.text.primary }
    const ghost = { fontSize: v2fs(11), height: 28, padding: '0 10px', borderRadius: V2_T.radius.sm }
    const buttons = []
    if (trashMode) {
      /* #5：垃圾桶里只有“恢复 / 彻底删除”是有意义的批量操作 */
      buttons.push(h('button', { type: 'button', onClick: batchRestore, style: v2BtnStyle('soft', Object.assign({}, soft)) }, '恢复'))
      buttons.push(h('button', { type: 'button', onClick: batchPurge, style: v2BtnStyle('ghost', Object.assign({}, ghost, { color: V2_T.status.danger })) }, '彻底删除'))
    } else {
      buttons.push(h('button', { type: 'button', onClick: openBatchMoveMenu, style: v2BtnStyle('soft', Object.assign({}, soft)) }, '移入清单'))
      buttons.push(h('button', {
        type: 'button',
        onClick: function onClick(event) { openBatchGroupMenu(event) },
        style: v2BtnStyle('soft', Object.assign({}, soft)),
      }, '移到分组'))
      buttons.push(h('button', { type: 'button', onClick: openBatchTagMenu, style: v2BtnStyle('soft', Object.assign({}, soft)) }, '添加标签'))
      buttons.push(h('button', { type: 'button', onClick: batchDelete, style: v2BtnStyle('ghost', Object.assign({}, ghost, { color: V2_T.status.danger })) }, '删除'))
    }
    buttons.push(h('button', {
      type: 'button',
      onClick: function onClick() { changeSelectionMode(false) },
      style: v2BtnStyle('ghost', Object.assign({}, ghost)),
    }, '取消'))
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
      [h('span', { style: { fontSize: v2fs(12), color: V2_T.text.secondary } }, count ? '已选 ' + count + ' 项' : '点击任务以多选'),
        h('div', { style: { flex: '1 1 auto' } })].concat(buttons),
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

  async function createTask(input, extra, options) {
    const text = String(input || '').trim()
    if (!text) return
    const opts = options || {}
    const parsed = v2ParseTarget(text, todayIso())
    const body = Object.assign({
      title: parsed.title || text,
      priority: parsed.priority || 'none',
    }, parsed.dateKey ? { scheduledDate: parsed.dateKey } : {}, extra || {})
    try {
      await apiRequest('/tasks', { method: 'POST', body: JSON.stringify(body) })
      update({ quickAdd: '', quickAddHint: '' })
      await reload(false)
      /* #7：分组内创建由调用方接管焦点，避免抢回主快速添加框 */
      if (opts.focus !== false && inputRef.current) inputRef.current.focus()
      runtime.toast('success', '已添加任务')
      return true
    } catch (error) {
      runtime.toast('error', '创建失败：' + errorText(error))
      return false
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
    detailTitleRef.current = { id: task.id, title: task.title }
    detailNotesRef.current = { id: task.id, notes: task.notes || '' }
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
      btn.style.fontSize = v2fs(12)
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

  /* 清单拖拽排序：把 draggedId 插到 targetId 前/后，乐观更新本地顺序并提交完整顺序 */
  function reorderListTo(draggedId, targetId, after) {
    if (!draggedId || !targetId || draggedId === targetId) return
    const ids = visibleLists().map(function id(list) { return list.id })
    const from = ids.indexOf(draggedId)
    if (from < 0 || ids.indexOf(targetId) < 0) return
    ids.splice(from, 1)
    const targetIndex = ids.indexOf(targetId)
    ids.splice(targetIndex < 0 ? ids.length : targetIndex + (after ? 1 : 0), 0, draggedId)
    /* 乐观更新：先按新顺序重排本地清单数组，界面立即响应；落库期间不阻塞交互 */
    const byId = {}
    state.lists.forEach(function each(list) { byId[list.id] = list })
    const queue = ids.map(function pick(id) { return byId[id] }).filter(Boolean)
    let cursor = 0
    const optimistic = state.lists.map(function each(list) {
      return ids.indexOf(list.id) >= 0 ? queue[cursor++] : list
    })
    update({ lists: optimistic, dropList: null })
    runMutation(async function doReorder() {
      await apiRequest('/lists/reorder', { method: 'POST', body: JSON.stringify({ ids: ids }) })
    }, '已调整清单顺序')
  }

  /* 分组拖拽排序：只在当前清单内重排 */
  function reorderGroupTo(draggedId, targetId, after) {
    const listId = state.scope.kind === 'list' ? state.scope.id : null
    if (!listId || !draggedId || !targetId || draggedId === targetId) return
    const ids = state.groups
      .filter(function f(group) { return (group.listId || group.list_id) === listId })
      .map(function id(group) { return group.id })
    const from = ids.indexOf(draggedId)
    if (from < 0 || ids.indexOf(targetId) < 0) return
    ids.splice(from, 1)
    const targetIndex = ids.indexOf(targetId)
    ids.splice(targetIndex < 0 ? ids.length : targetIndex + (after ? 1 : 0), 0, draggedId)
    const byId = {}
    state.groups.forEach(function each(group) { byId[group.id] = group })
    const queue = ids.map(function pick(id) { return byId[id] }).filter(Boolean)
    let cursor = 0
    const optimistic = state.groups.map(function each(group) {
      return ids.indexOf(group.id) >= 0 ? queue[cursor++] : group
    })
    update({ groups: optimistic, dropGroup: null })
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
    const rect = e.currentTarget.getBoundingClientRect()
    const after = e.clientY > rect.top + rect.height / 2
    reorderListTo(draggedId, list.id, after)
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
    const rect = e.currentTarget.getBoundingClientRect()
    const after = e.clientY > rect.top + rect.height / 2
    reorderGroupTo(draggedId, group.id, after)
  }

  function openGroupAdd(listId, groupId) {
    update({ groupAdd: { listId: listId, groupId: groupId || null }, groupAddText: '' })
  }

  /* 间隙值法：排序值按 1024 递增，拖拽时只改被拖拽项一条记录；间隙耗尽才整组重排。 */
  const TASK_SORT_STEP = 1024
  /* Host 对 sortOrder 的硬约束（routes-m6.js normalizeSortOrder）：0..1e9 的整数 */
  const TASK_SORT_MAX = 1000000000

  function reorderWithinManual(dragged, orderedTasks, groupId, listId) {
    const patches = []
    orderedTasks.forEach(function each(task, index) {
      const sortOrder = index * TASK_SORT_STEP
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

  function reorderTaskRelative(draggedId, targetId, after) {
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
    if (index < 0) return
    const insertAt = Math.max(0, Math.min(ordered.length, index + (after ? 1 : 0)))
    const prev = ordered[insertAt - 1]
    const next = ordered[insertAt]
    const step = TASK_SORT_STEP
    let sortOrder = null
    if (!prev && !next) sortOrder = 0
    else if (!prev) sortOrder = Number(next.sortOrder || next.sort_order || 0) - step
    else if (!next) sortOrder = Number(prev.sortOrder || prev.sort_order || 0) + step
    else {
      const a = Number(prev.sortOrder || prev.sort_order || 0)
      const b = Number(next.sortOrder || next.sort_order || 0)
      if (b - a > 1) sortOrder = Math.floor((a + b) / 2)
    }
    const movedGroup = v2TaskGroupId(dragged) !== groupId || v2TaskListId(dragged) !== listId
    /* 候选值必须落在 Host 允许区间且不与相邻项撞值；
       否则（例如拖到首位时 next-1024 为负、间隙耗尽、极端大值）整组重排 0,1024,2048… */
    const candidateInvalid = sortOrder === null ||
      !Number.isInteger(sortOrder) ||
      sortOrder < 0 ||
      sortOrder > TASK_SORT_MAX ||
      (prev && sortOrder === Number(prev.sortOrder || prev.sort_order || 0)) ||
      (next && sortOrder === Number(next.sortOrder || next.sort_order || 0))
    if (candidateInvalid) {
      /* 越界/撞值时全组重排为 0,1024,2048…；被拖项落在 insertAt 对应位置 */
      const full = ordered.slice()
      full.splice(insertAt, 0, dragged)
      reorderWithinManual(dragged, full, groupId, listId)
      return
    }
    if (opLockRef.current.busy) return
    /* 乐观更新：本地先改顺序，拖拽松手立即看到结果；落库只 PATCH 这一条，异步刷新兜底 */
    const optimistic = state.tasks.map(function patchLocal(nextTask) {
      if (nextTask.id !== draggedId) return nextTask
      return Object.assign({}, nextTask, { sortOrder: sortOrder, groupId: groupId, listId: listId })
    })
    update({ tasks: optimistic })
    runMutation(async function doMove() {
      const body = { sortOrder: sortOrder, expectedRev: dragged.rev }
      if (movedGroup) {
        body.groupId = groupId
        body.listId = listId
      }
      try {
        await apiRequest('/tasks/' + encodeURIComponent(draggedId), { method: 'PATCH', body: JSON.stringify(body) })
      } catch (error) {
        if (!v2IsConflictError(error)) throw error
        /* rev 过期：刷新拿到最新版本后重试一次 */
        const fresh = await reload(false)
        const current = v2FindTaskById((fresh && fresh.tasks) || [], draggedId)
        if (!current) throw error
        body.expectedRev = current.rev
        await apiRequest('/tasks/' + encodeURIComponent(draggedId), { method: 'PATCH', body: JSON.stringify(body) })
      }
    }, null)
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

  /* #7：分组内连续创建——算一个排到该分组末尾的 sortOrder（0..1e9 整数） */
  function nextGroupSortOrder(listId, groupId) {
    const targetList = listId || null
    const targetGroup = groupId || null
    let max = 0
    state.tasks.concat(state.done).forEach(function scan(task) {
      if (v2TaskParentId(task)) return
      if ((v2TaskListId(task) || null) !== targetList) return
      if ((v2TaskGroupId(task) || null) !== targetGroup) return
      const order = Number(task.sortOrder)
      if (Number.isFinite(order) && order > max) max = order
    })
    return Math.min(TASK_SORT_MAX, max + TASK_SORT_STEP)
  }

  function submitGroupAdd() {
    const target = state.groupAdd
    const text = String(state.groupAddText || '').trim()
    if (!target || !text) return
    const listId = target.listId || null
    const groupId = target.groupId || null
    /* 先清空输入框：任务创建（含 reload）期间再按回车不会重复提交同一标题 */
    update({ groupAddText: '' })
    /* sortOrder 让新任务落到该分组末尾；focus:false 避免 createTask 抢焦点回主快速添加框 */
    createTask(text, { listId: listId, groupId: groupId, sortOrder: nextGroupSortOrder(listId, groupId) }, { focus: false }).then(function afterCreate(created) {
      /* 创建失败时把标题放回输入框，避免用户输入丢失 */
      if (created === false) update({ groupAddText: text })
      const el = groupAddInputRef.current
      if (el) el.focus()
      else if (inputRef.current) inputRef.current.focus()
    })
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
            fontSize: v2fs(13),
            lineHeight: '18px',
            cursor: 'pointer',
            textAlign: 'left',
            transition: 'background 120ms ease, color 120ms ease',
          },
        },
        h(V2Icon, { name: icon || 'layers', size: 14 }),
        h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
        typeof count === 'number' && count > 0 ? h('span', { style: { fontSize: v2fs(11), color: V2_T.text.tertiary, flex: '0 0 auto' } }, String(count)) : null,
      )
    }

    /* #27：左栏分区标题——可点击折叠/展开，状态持久化在 lifeos.v2.state.task */
    function sectionHeader(key, title, action) {
      const folded = !!(state.leftFolded && state.leftFolded[key])
      return h(
        'div',
        { style: { marginTop: 12, padding: '0 10px 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        h('button', {
          type: 'button',
          'aria-expanded': folded ? 'false' : 'true',
          'aria-controls': 'v2-left-section-' + key,
          onClick: function onClick() { toggleLeftSection(key) },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            flex: '1 1 auto',
            minWidth: 0,
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: V2_T.text.tertiary,
            fontFamily: COLORS.fontFamily,
            fontSize: v2fs(V2_T.font.caption),
            fontWeight: 600,
            letterSpacing: '0.02em',
            textAlign: 'left',
            cursor: 'pointer',
          },
          onFocus: function onFocus(e) { Object.assign(e.currentTarget.style, v2FocusRing({})) },
          onBlur: function onBlur(e) { e.currentTarget.style.boxShadow = 'none' },
        },
        h(V2Icon, { name: folded ? 'chevR' : 'chevD', size: 12 }),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
        ),
        action || null,
      )
    }

    function sectionBody(key, children) {
      const folded = !!(state.leftFolded && state.leftFolded[key])
      if (folded) return null
      return h('div', { id: 'v2-left-section-' + key }, children)
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
              fontSize: v2fs(11),
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
        h('span', { style: { fontSize: v2fs(12), fontWeight: 600, color: V2_T.text.secondary, letterSpacing: '0.02em' } }, '任务'),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 2 } },
          /* #13：搜索入口放在左栏清单区首行（放大镜展开输入框，"/" 快捷键同样生效） */
          h('button', {
            type: 'button',
            title: '搜索任务（/）',
            'aria-label': '搜索任务',
            'aria-expanded': state.searchOpen ? 'true' : 'false',
            onClick: function onClick() {
              searchFocusRef.current = true
              update({ searchOpen: true })
              /* 搜索框已经展开时，点击放大镜直接聚焦；首次展开由 focusSearchInput effect 负责 */
              if (searchInputRef.current) searchInputRef.current.focus()
            },
            style: v2IconBtnStyle({ width: 18, height: 18 }),
          }, h(V2Icon, { name: 'search', size: 13 })),
          narrow
            ? null
            : h('button', {
                type: 'button',
                title: '收起清单栏',
                onClick: toggleListPane,
                style: v2IconBtnStyle({ width: 18, height: 18 }),
              }, h(V2Icon, { name: 'chevL', size: 12 })),
        ),
      ),
      state.searchOpen
        ? h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px 8px' } },
            h(V2Icon, { name: 'search', size: 13, color: V2_T.text.tertiary }),
            h('input', {
              ref: searchInputRef,
              value: state.query,
              placeholder: '搜索任务标题或备注',
              'aria-label': '搜索任务',
              onChange: function onChange(e) { update({ query: e.target.value }) },
              onKeyDown: function onKeyDown(e) {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  update({ searchOpen: false, query: '' })
                }
              },
              style: v2InputStyle({ fontSize: v2fs(12), padding: '4px 8px', height: 28, flex: '1 1 auto', background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
            }),
            h('button', {
              type: 'button',
              title: '关闭搜索',
              'aria-label': '关闭搜索',
              onClick: function onClick() { update({ searchOpen: false, query: '' }) },
              style: v2IconBtnStyle({ width: 20, height: 20 }),
            }, h(V2Icon, { name: 'close', size: 12 })),
          )
        : null,
      h(
        'div',
        { style: { flex: '1 1 auto', overflowY: 'auto', padding: '2px 8px 16px', minHeight: 0 } },
        shortcuts.map(function mapShortcut(item) {
          return navItem({ kind: item.kind }, item.label, scopeCountOf({ kind: item.kind }), item.icon)
        }),
        sectionHeader('lists', '清单', h('button', {
          type: 'button',
          title: '新建清单',
          onClick: function onClick() { update({ newListOpen: true, newListName: '' }) },
          style: v2IconBtnStyle({ width: 20, height: 20 }),
        }, h(V2Icon, { name: 'plus', size: 12 }))),
        sectionBody('lists', [
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
                  fontSize: v2fs(12),
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
                onFocus: function onFocus(e) { e.currentTarget.select() },
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
                  fontSize: v2fs(12),
                  padding: '4px 8px',
                  height: 30,
                  background: V2_T.surface.input,
                  border: '1px solid ' + V2_T.border.subtle,
                  borderRadius: V2_T.radius.sm,
                }),
              }),
            )
          }
          const listDrop = state.dropList && state.dropList.id === list.id ? state.dropList.side : ''
          return h(
            'div',
            {
              key: list.id,
              draggable: true,
              title: '拖拽调整清单顺序',
              onDragStart: function onDragStart(e) { startListDrag(e, list) },
              onDragEnd: function onDragEnd() {
                window.__lifeosV2DragListId = null
                if (state.dropList) update({ dropList: null })
              },
              onDragOver: function onDragOver(e) {
                if (!window.__lifeosV2DragListId) return
                e.preventDefault()
                e.stopPropagation()
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
                /* 命中测试：与行矩形中线比较，鼠标在上半区插到前面、下半区插到后面 */
                const rect = e.currentTarget.getBoundingClientRect()
                const side = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                const current = state.dropList
                if (!current || current.id !== list.id || current.side !== side) {
                  update({ dropList: { id: list.id, side: side } })
                }
              },
              onDragLeave: function onDragLeave(e) {
                if (e.currentTarget.contains(e.relatedTarget)) return
                if (state.dropList && state.dropList.id === list.id) update({ dropList: null })
              },
              onDrop: function onDrop(e) { dropListReorder(e, list) },
              style: { display: 'flex', alignItems: 'center', position: 'relative' },
            },
            listDrop
              ? h('div', {
                  key: 'list-drop-line',
                  'aria-hidden': 'true',
                  style: {
                    position: 'absolute',
                    left: 8,
                    right: 8,
                    top: listDrop === 'before' ? -1 : 'auto',
                    bottom: listDrop === 'after' ? -1 : 'auto',
                    height: 2,
                    borderRadius: 1,
                    background: V2_T.accent.base,
                    boxShadow: '0 0 0 1px ' + V2_T.accent.line,
                    pointerEvents: 'none',
                    zIndex: 2,
                  },
                })
              : null,
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } }, navItem({ kind: 'list', id: list.id }, list.name, count, 'layers')),
            h('button', {
              type: 'button',
              title: '清单操作',
              onClick: function onClick(e) { e.stopPropagation(); openListMenu(list, e) },
              style: v2IconBtnStyle({ width: 24, height: 24, opacity: 0.55 }),
            }, h(V2Icon, { name: 'more', size: 12 })),
          )
        }),
        ]),
        sectionHeader('filters', '过滤器'),
        sectionBody('filters', [
          navItem({ kind: 'filter', id: 'high', label: '本周高优先级' }, '本周高优先级', scopeCountOf({ kind: 'filter', id: 'high', label: '本周高优先级' }), 'filter'),
          navItem({ kind: 'filter', id: 'meeting', label: '会议相关' }, '会议相关', scopeCountOf({ kind: 'filter', id: 'meeting', label: '会议相关' }), 'filter'),
        ]),
        sectionHeader('tags', '标签', h('button', {
          type: 'button',
          title: '编辑标签',
          onClick: function onClick() { openTagEditor() },
          style: v2IconBtnStyle({ width: 20, height: 20 }),
        }, h(V2Icon, { name: 'settings', size: 12 }))),
        sectionBody('tags', [
          state.tags.length
            ? state.tags.map(function renderTag(tag) {
                const count = scopeCountOf({ kind: 'tag', id: tag.id })
                return navItem({ kind: 'tag', id: tag.id }, tag.name, count, 'tag')
              })
            : h('div', { style: { padding: '2px 10px', fontSize: v2fs(11), color: V2.faint } }, '暂无标签'),
        ]),
        sectionHeader('archive', '收纳区'),
        sectionBody('archive', [
          navItem({ kind: 'done' }, '已完成', state.done.length, 'done'),
          navItem({ kind: 'trash' }, '垃圾桶', state.trash.length, 'trash'),
        ]),
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
    const query = String(state.query || '').trim()
    const visible = tasks
      .filter(function filter(task) { return v2TaskMatchesText(task, query) })
      .filter(function filter(task) {
        if (flatScope) return true
        return !v2TaskParentId(task)
      })
    if (!visible.length) {
      const listScope = state.scope.kind === 'list'
      if (listScope) {
        /* 清单为空也要渲染分组列表与“新建分组”行：
           否则空清单只剩快速添加一个入口，无法在此清单建分组；
           搜索无结果时不渲染分组（避免误以为有匹配任务）。 */
        if (!query) return renderGroupedList([])
      }
      if (query) {
        return h(EmptyState, {
          title: '没有匹配的任务',
          hint: '换个关键词，或清空搜索框',
        })
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
        const groupDrop = state.dropGroup && state.dropGroup.id === bucket.id ? state.dropGroup.side : ''
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
              onDragEnd: function onDragEnd() {
                window.__lifeosV2DragGroupId = null
                if (state.dropGroup) update({ dropGroup: null })
              },
              onDragOver: function onDragOver(e) {
                if (!window.__lifeosV2DragGroupId) return
                e.preventDefault()
                e.stopPropagation()
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
                const rect = e.currentTarget.getBoundingClientRect()
                const side = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                const current = state.dropGroup
                if (!current || current.id !== bucket.id || current.side !== side) {
                  update({ dropGroup: { id: bucket.id, side: side } })
                }
              },
              onDragLeave: function onDragLeave(e) {
                if (e.currentTarget.contains(e.relatedTarget)) return
                if (state.dropGroup && state.dropGroup.id === bucket.id) update({ dropGroup: null })
              },
              onDrop: bucket.id
                ? function onDrop(e) { dropGroupReorder(e, { id: bucket.id }) }
                : null,
              style: {
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: 38,
                padding: '0 12px',
                borderBottom: collapsed ? 'none' : '1px solid ' + V2_T.border.subtle,
              },
            },
            groupDrop
              ? h('div', {
                  key: 'group-drop-line',
                  'aria-hidden': 'true',
                  style: {
                    position: 'absolute',
                    left: 8,
                    right: 8,
                    top: groupDrop === 'before' ? 0 : 'auto',
                    bottom: groupDrop === 'after' ? 0 : 'auto',
                    height: 2,
                    borderRadius: 1,
                    background: V2_T.accent.base,
                    boxShadow: '0 0 0 1px ' + V2_T.accent.line,
                    pointerEvents: 'none',
                    zIndex: 2,
                  },
                })
              : null,
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
                  /* 按钮/菜单入口进入重命名：保持全选（与任务名点击定位光标的语义区分） */
                  onFocus: function onFocus(e) { e.currentTarget.select() },
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
                  style: v2InputStyle({ fontSize: v2fs(12), padding: '3px 8px', width: 150, height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
                })
              : h('span', { style: { fontSize: v2fs(13), fontWeight: 600, color: V2_T.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, bucket.name),
            h('span', { style: { fontSize: v2fs(11), color: V2_T.text.tertiary } }, String(bucket.tasks.length)),
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
                  ref: groupAddInputRef,
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
                  style: v2InputStyle({ fontSize: v2fs(12), padding: '4px 8px', height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
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
                  /* 空分组也要有足够大的放置区（≥56px），否则拖拽几乎无法命中 */
                  style: { minHeight: 56, padding: '4px 6px 6px' },
                },
                bucket.tasks.length
                  ? bucket.tasks.map(function renderTask(task) { return renderTaskRow(task) })
                  : h(
                      'div',
                      { style: { padding: '6px 10px 8px', fontSize: v2fs(11), color: V2_T.text.tertiary } },
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
            h('span', { style: { fontSize: v2fs(13), fontWeight: 600, color: bucket.id === 'overdue' ? V2_T.status.danger : V2_T.text.primary } }, bucket.name),
            h('span', { style: { fontSize: v2fs(11), color: V2_T.text.tertiary } }, String(bucket.tasks.length)),
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
            h('span', { style: { fontSize: v2fs(13), fontWeight: 600, color: V2_T.text.primary } }, bucket.name),
            h('span', { style: { fontSize: v2fs(11), color: V2_T.text.tertiary } }, String(bucket.tasks.length)),
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
      /* #2：多选模式下高亮只由 selectedIds 驱动，单选残留的 selectedId 不再参与 */
      selected: state.selectionMode ? state.selectedIds.indexOf(task.id) >= 0 : state.selectedId === task.id,
      selectMode: state.selectionMode,
      editing: state.editingId === task.id,
      /* #9：鼠标点击标题进入编辑时按点击位置定位光标；键盘/按钮入口为 -1 → 全选 */
      editCaret: state.editingId === task.id ? editCaretRef.current : -1,
      childCount: children.length,
      doneChild: doneChild,
      /* 看板列内用浮起卡片视觉；列表/详情内保持扁平行（仅样式变体） */
      card: carded === true,
      listName: state.scope.kind === 'list' ? null : listNameOf(v2TaskListId(task)),
      onToggle: toggleTask,
      onOpen: state.selectionMode
        ? function onSelect(target) { toggleSelect(target.id) }
        : openDetail,
      onSelectToggle: function onSelectToggle(target) { toggleSelect(target.id) },
      onStartEdit: function onStartEdit(target, caret) {
        editCaretRef.current = typeof caret === 'number' && caret >= 0 ? caret : -1
        update({ editingId: target.id })
      },
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
      onDrop: function onDrop(event, target, side) {
        if (event && event.stopPropagation) event.stopPropagation()
        const draggedId = window.__lifeosV2DragTaskId
        if (!draggedId || draggedId === target.id) return
        if (!acceptDrop('row:' + target.id + ':' + draggedId)) return
        clearDragPayload()
        reorderTaskRelative(draggedId, target.id, side === 'after')
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
          placeholder: '添加任务，回车创建（可写“明天上午 9 点 !高”；按 N 随时聚焦到这里）',
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
          style: v2InputStyle({ flex: '1 1 auto', border: 'none', background: 'transparent', fontSize: v2fs(13), padding: 0, height: 22 }),
        }),
        state.quickAddHint
          ? h('span', { style: { fontSize: v2fs(11), color: V2_T.accent.base, whiteSpace: 'nowrap' } }, state.quickAddHint)
          : null,
      ),
    )
  }

  function renderMain() {
    const tasks = scopeTasks()
    const count = scopeCountOf(state.scope)
    return h(
      'div',
      { style: { flex: '1 1 auto', minWidth: 0, maxWidth: narrow || !state.detail ? 'none' : '50%', display: 'flex', flexDirection: 'column', minHeight: 0, background: V2_T.surface.app } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', height: V2_T.line.header, minHeight: V2_T.line.header, boxSizing: 'border-box', borderBottom: '1px solid ' + V2_T.border.subtle } },
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
            h('h3', { style: { margin: 0, fontSize: v2fs(20), fontWeight: 600, color: V2_T.text.primary, lineHeight: '26px', letterSpacing: '-0.01em' } }, scopeTitleOf(state.scope)),
            h('span', { style: { fontSize: v2fs(12), color: V2_T.text.tertiary, fontWeight: 500 } }, String(count) + ' 项'),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('button', {
            type: 'button',
            title: state.selectionMode ? '退出多选' : '多选任务',
            onClick: function onClick() {
              changeSelectionMode(!state.selectionMode)
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
        {
          ref: listScrollRef,
          onScroll: onListScroll,
          style: { flex: '1 1 auto', overflowY: 'auto', minHeight: 0 },
        },
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
          /* #14：中间列表栏被限制在总宽 50% 以内，详情栏吸收剩余宽度，避免右侧留白 */
          flex: narrow ? '1 1 auto' : '1 1 ' + panes.detail + 'px',
          borderLeft: narrow ? 'none' : '1px solid ' + V2_T.border.subtle,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          minWidth: narrow ? 0 : 280,
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
            const base = detailTitleRef.current.id === task.id ? detailTitleRef.current.title : task.title
            if (!value) {
              update({ detail: Object.assign({}, task, { title: base }) })
              return
            }
            if (value === base) return
            detailTitleRef.current = { id: task.id, title: value }
            patchTask(task.id, task.rev, { title: value }, '任务已重命名').then(function settle(ok) {
              if (!ok) detailTitleRef.current = { id: task.id, title: base }
            })
          },
          onKeyDown: function onKeyDown(e) {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              const base = detailTitleRef.current.id === task.id ? detailTitleRef.current.title : task.title
              e.currentTarget.value = base
              update({ detail: Object.assign({}, task, { title: base }) })
              e.currentTarget.blur()
            }
          },
          style: v2InputStyle({ flex: '1 1 auto', border: 'none', background: 'transparent', fontSize: v2fs(18), fontWeight: 600, color: V2_T.text.primary, padding: '2px 0', lineHeight: '26px', cursor: 'text' }),
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
          { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px 12px', fontSize: v2fs(12), color: V2_T.text.secondary } },
          h(V2Icon, { name: 'calendar', size: 13 }),
          h('span', null, v2TaskDateText(task) || '无日期'),
          h('span', { style: { marginLeft: 'auto' } }, listNameOf(listId)),
        ),
        h(
          'div',
          { style: Object.assign(v2CardStyle({ padding: '6px 12px', marginBottom: 12 }), { display: 'grid', gridTemplateColumns: '76px 1fr', columnGap: 8, rowGap: 0, gridAutoRows: 'minmax(34px, auto)', alignItems: 'center', fontSize: v2fs(12) }) },
          h('span', { style: { color: V2_T.text.tertiary, fontSize: v2fs(12) } }, '日期'),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } },
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
              style: v2InputStyle({ fontSize: v2fs(13), padding: '4px 8px', height: 28, flex: '0 0 auto', width: 132, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
            }),
            /* #19：快捷日期——今天 / 明天 / 下周（今天 +7 天） */
            h('button', {
              type: 'button',
              title: '设为今天',
              onClick: function onClick() {
                patchTask(task.id, task.rev, { scheduledDate: addDaysKey(todayIso(), 0), scheduledStartAt: null, scheduledEndAt: null }, null)
              },
              style: v2BtnStyle('ghost', { fontSize: v2fs(11), height: 24, padding: '0 7px', borderRadius: V2_T.radius.sm, background: V2_T.surface.panel3, color: V2_T.text.secondary }),
              onFocus: function onFocus(e) { Object.assign(e.currentTarget.style, v2FocusRing({})) },
              onBlur: function onBlur(e) { e.currentTarget.style.boxShadow = 'none' },
            }, '今天'),
            h('button', {
              type: 'button',
              title: '设为明天',
              onClick: function onClick() {
                patchTask(task.id, task.rev, { scheduledDate: addDaysKey(todayIso(), 1), scheduledStartAt: null, scheduledEndAt: null }, null)
              },
              style: v2BtnStyle('ghost', { fontSize: v2fs(11), height: 24, padding: '0 7px', borderRadius: V2_T.radius.sm, background: V2_T.surface.panel3, color: V2_T.text.secondary }),
              onFocus: function onFocus(e) { Object.assign(e.currentTarget.style, v2FocusRing({})) },
              onBlur: function onBlur(e) { e.currentTarget.style.boxShadow = 'none' },
            }, '明天'),
            h('button', {
              type: 'button',
              title: '设为下周（今天 +7 天）',
              onClick: function onClick() {
                patchTask(task.id, task.rev, { scheduledDate: addDaysKey(todayIso(), 7), scheduledStartAt: null, scheduledEndAt: null }, null)
              },
              style: v2BtnStyle('ghost', { fontSize: v2fs(11), height: 24, padding: '0 7px', borderRadius: V2_T.radius.sm, background: V2_T.surface.panel3, color: V2_T.text.secondary }),
              onFocus: function onFocus(e) { Object.assign(e.currentTarget.style, v2FocusRing({})) },
              onBlur: function onBlur(e) { e.currentTarget.style.boxShadow = 'none' },
            }, '下周'),
          ),
          h('span', { style: { color: V2_T.text.tertiary, fontSize: v2fs(12) } }, '时间'),
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
              style: v2InputStyle({ fontSize: v2fs(13), padding: '4px 8px', height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
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
              style: v2InputStyle({ fontSize: v2fs(13), padding: '4px 8px', height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
            }),
          ),
          h('span', { style: { color: V2_T.text.tertiary, fontSize: v2fs(12) } }, '优先级'),
          h(
            'select',
            {
              value: task.priority || 'none',
              onChange: function onChange(e) { patchTask(task.id, task.rev, { priority: e.target.value }, null) },
              style: v2InputStyle({ fontSize: v2fs(13), padding: '4px 8px', height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
            },
            V2_PRIORITY_ITEMS.map(function map(item) { return h('option', { key: item.id, value: item.id }, item.label) }),
          ),
          h('span', { style: { color: V2_T.text.tertiary, fontSize: v2fs(12) } }, '重复'),
          (function renderRepeat() {
            const rule = v2RepeatRuleOf(task)
            const kind = rule ? rule.kind : 'none'
            function chipStyle(active) {
              return v2BtnStyle('ghost', {
                fontSize: v2fs(11),
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
                h('span', { style: { fontSize: v2fs(11), color: V2_T.text.tertiary, marginLeft: 2 } }, v2RepeatLabel(rule)),
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
                  { key: 'monthday', style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: v2fs(12), color: V2_T.text.secondary } },
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
                    style: v2InputStyle({ width: 60, fontSize: v2fs(12), padding: '3px 8px', height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
                  }),
                  h('span', null, '日'),
                ),
              )
            }
            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, parts)
          })(),
          h('span', { style: { color: V2_T.text.tertiary, fontSize: v2fs(12) } }, '清单'),
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
              style: v2InputStyle({ fontSize: v2fs(13), padding: '4px 8px', height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
            },
            h('option', { value: '' }, '收集箱'),
            visibleLists().map(function map(list) { return h('option', { key: list.id, value: list.id }, list.name) }),
          ),
          h('span', { style: { color: V2_T.text.tertiary, fontSize: v2fs(12) } }, '标签'),
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
                    fontSize: v2fs(11),
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
                  style: v2InputStyle({ fontSize: v2fs(12), padding: '3px 8px', width: 120, height: 26, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
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
          h('div', { style: { fontSize: v2fs(12), fontWeight: 600, color: V2_T.text.tertiary, letterSpacing: '0.02em', marginBottom: 6 } }, '备注'),
          h('textarea', {
            value: task.notes || '',
            rows: 4,
            placeholder: '添加备注…',
            onChange: function onChange(e) { update({ detail: Object.assign({}, task, { notes: e.target.value }) }) },
            onBlur: function onBlur(e) {
              const value = e.target.value
              /* 与“打开详情时的已提交值”比较（task.notes 已随 onChange 变化，直接比较会恒等） */
              const base = detailNotesRef.current.id === task.id ? detailNotesRef.current.notes : (task.notes || '')
              if (value === base) return
              patchTask(task.id, task.rev, { notes: value || null }, null).then(function onSaved(ok) {
                if (ok) detailNotesRef.current = { id: task.id, notes: value }
              })
            },
            onKeyDown: function onKeyDown(e) {
              if (e.key !== 'Escape') return
              const base = detailNotesRef.current.id === task.id ? detailNotesRef.current.notes : (task.notes || '')
              update({ detail: Object.assign({}, task, { notes: base }) })
              e.preventDefault()
              e.currentTarget.blur()
            },
            style: v2InputStyle({ width: '100%', boxSizing: 'border-box', resize: 'vertical', fontSize: v2fs(13), lineHeight: '20px', minHeight: 88, padding: '8px 10px', background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
          }),
        ),
        h(
          'div',
          { style: v2CardStyle({ marginBottom: 12, overflow: 'hidden' }) },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 38, padding: '0 12px', borderBottom: '1px solid ' + V2_T.border.subtle } },
            h('span', { style: { fontSize: v2fs(12), fontWeight: 600, color: V2_T.text.tertiary, letterSpacing: '0.02em' } }, '子任务'),
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
              : h('div', { style: { fontSize: v2fs(11), color: V2_T.text.tertiary, padding: '6px 10px' } }, '暂无子任务'),
          ),
        ),
      ),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderTop: '1px solid ' + V2_T.border.subtle } },
        h('span', { style: { fontSize: v2fs(11), color: V2_T.text.tertiary, flex: '1 1 auto' } }, v2TaskDateText(task)),
        state.scope.kind === 'trash'
          ? h('button', { type: 'button', onClick: function onClick() { restoreTask(task) }, style: v2BtnStyle('soft', { fontSize: v2fs(11), height: 32, padding: '0 12px', borderRadius: V2_T.radius.md, background: V2_T.surface.panel3, color: V2_T.text.primary }) }, '恢复')
          : h('button', { type: 'button', onClick: function onClick() { deleteTask(task) }, style: v2BtnStyle('ghost', { fontSize: v2fs(11), height: 32, padding: '0 12px', borderRadius: V2_T.radius.md, color: V2_T.status.danger }) }, '删除'),
        state.scope.kind === 'trash'
          ? h('button', { type: 'button', onClick: function onClick() { purgeTask(task) }, style: v2BtnStyle('danger', { fontSize: v2fs(11), height: 32, padding: '0 12px', borderRadius: V2_T.radius.md, border: '1px solid ' + V2_T.status.danger + '55' }) }, '彻底删除')
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
            fontSize: v2fs(11),
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
      style: v2InputStyle({ fontSize: v2fs(13), padding: '4px 8px', height: 28, background: V2_T.surface.input, border: '1px solid ' + V2_T.border.subtle, borderRadius: V2_T.radius.sm }),
    }),
    h('button', { type: 'button', onClick: props.onSubmit, style: v2BtnStyle('primary', { fontSize: v2fs(11), height: 28, padding: '0 12px', borderRadius: V2_T.radius.sm }) }, '创建'),
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
