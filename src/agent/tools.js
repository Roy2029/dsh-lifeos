/**
 * LifeOS Agent 工具（M0 两个 + M1 `lifeos_task` + M2 `lifeos_triage` / `lifeos_correct`
 * + M2.5 `lifeos_notes` + M3 `lifeos_settings`）。
 *
 * 契约：`M0-PLAN.md` §3.7、`M1-PLAN.md` §5、`M2-PLAN.md` §1（P0 隔离）/§4（工具）。
 * 工具名单一来源：`src/agent/tool-names.js`（D 维护，B 的 tool-scope 引用）。
 *
 * 为什么直接构造 ToolDefinition 而不是 `defineTool()`：
 *   本机以 junction/link 安装插件，裸 import `@deepseek-ai/*` 会
 *   ERR_MODULE_NOT_FOUND 并让整条插件不激活（M0-PLAN §1、§7）。
 *   因此这里用标准 JSON Schema + output.schema/render 的裸对象写法。
 *
 * 实测约束（已沿用，勿回退）：
 *   1) 薄行必须 `inject = ['tools','lifeos','systemPrompt']`（见 agent.js）；
 *   2) **canonical/output schema 不支持 `type: ['string','null']` 联合数组** →
 *      所有工具统一用宽松 `OUTPUT_SCHEMA`，null 字段由 render 兜底；
 *   3) 单个工具注册失败不得拖垮其它工具（registerTools 逐个 try/catch）；
 *   4) **P0 隔离（M2）**：所有工具注册带 `{ when: (activation) => isLifeosAgent(activation?.agent) }`，
 *      非 `lifeos` preset 会话看不到/调不到 `lifeos_*`。
 *
 * 设计约束：
 *   - 只依赖注入进来的 `service`（`ctx.lifeos`），不 import 本仓其它模块（tool-names 除外）。
 *   - 业务错误一律转成 `{ok:false, error}` 由 render 变成模型可读文本，不裸 throw。
 *   - 写工具用 `exec.callId` 做幂等线索、`exec.agent.id` 做来源线索。
 *   - L3 动作（cancel/reschedule/改 due/correct）只返回 `needsConfirm + preview`，不执行；
 *     用户确认后由模型再次调用并显式传 `confirm: true` 才执行。
 */
import { isLifeosAgent, LIFEOS_TOOL_NAMES } from './tool-names.js'

export { isLifeosAgent } from './tool-names.js'

/** canonical 值形状：宽松对象（注册表不支持 type 联合数组，null 由 render 兜底）。 */
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

const MAX_CAPTURE_CHARS = 2000
const TODAY_TASK_LIMIT = 20
const TODAY_RENDER_LIMIT = 6

const TASK_ACTIONS = ['list', 'get', 'create', 'update', 'complete', 'reopen', 'cancel', 'reschedule']
/** L3：只返回 needsConfirm，不执行（用户确认后带 confirm:true 再调）。 */
const TASK_L3_ACTIONS = ['cancel', 'reschedule']
/** update 里出现这些字段即视为 L3（改截止时间）。 */
const TASK_L3_UPDATE_FIELDS = ['dueDate', 'dueAt']

const TASK_LIST_DEFAULT_LIMIT = 20
const TASK_LIST_MAX_LIMIT = 50
const TASK_RENDER_LIMIT = 8

const TASK_VIEWS = ['today', 'overdue', 'next7', 'inbox', 'all']
const TASK_PRIORITIES = ['none', 'low', 'medium', 'high']
const TASK_VIEW_LABELS = { today: '今天', overdue: '逾期', next7: '最近 7 天', inbox: '收件箱', all: '全部' }
const TASK_STATUS_LABELS = { todo: '待办', doing: '进行中', done: '已完成', cancelled: '已取消' }
const TASK_PRIORITY_LABELS = { none: '无', low: '低', medium: '中', high: '高' }
const TASK_ACTION_LABELS = {
  list: '查询',
  get: '读取',
  create: '创建',
  update: '更新',
  complete: '完成',
  reopen: '重开',
  cancel: '取消',
  reschedule: '改期',
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 错误码 → 给模型的下一步提示（不暴露内部实现）。 */
const ERROR_HINTS = {
  store_unavailable: '存储当前不可用（可能处于只读降级）。可以稍后重试一次，但不要编造结果。',
  invalid_state: '当前状态不允许该操作（如习惯已暂停/归档后不能打卡、目标已归档不能修改）。先用 action=get 看最新状态，再让用户决定是否恢复或换日期。',
  habits_unavailable: '习惯服务尚未就绪（ctx.lifeos 未挂接习惯方法）。不要编造习惯/打卡/streak；可以让用户稍后在 LifeOS 面板操作或重试。',
  planning_unavailable: '项目/目标服务尚未就绪（ctx.lifeos 未挂接项目或目标方法）。不要编造进度；可以让用户稍后在 LifeOS 面板查看或重试。',
  validation_failed: '参数不合法。检查必填字段、枚举值、日期格式与互斥规则（scheduledDate 与 scheduledStartAt 互斥；dueDate 与 dueAt 互斥）。',
  conflict: '对象已被修改（版本冲突）：先 action=get 读取最新对象与 rev，再重试一次；不要重复提交同一修改。',
  not_found: '目标不存在或 id 不对。不要猜测 ID，先用 action=list 找到正确的 id。',
  internal: '内部错误。向用户说明暂时失败，不要声称操作成功。',
  permission_denied: '当前没有权限执行该操作。向用户说明能力边界。',
  notes_unavailable: '笔记服务尚未就绪（Host 未挂接 notes 服务）。不要编造文件内容；可以让用户稍后重试或改用笔记 tab 操作。',
  notes_dir_unconfigured: '还没有配置笔记目录：请先在设置里选择笔记目录（设置 → 笔记 → 笔记目录），再让 Agent 读写笔记。',
  notes_dir_readonly: '笔记目录当前不可写。请让用户检查目录权限或在设置里换一个目录。',
  path_forbidden: '路径必须在用户配置的笔记目录内；不要让用户把笔记写到目录外。',
  path_exists: '同名笔记已存在。可以改用 append 追加，或让用户换一个文件名。',
  file_too_large: '笔记文件过大（超过 2MB），工具不能整篇读写。请让用户在笔记 tab 或外部编辑器里处理。',
  automation_unavailable: '自动化设置服务尚未就绪（M3 未挂接 ctx.lifeos.automation）。不要编造设置值；可以告诉用户稍后在设置页查看或重试。',
  invalid_time: '时间必须是 HH:mm（00:00–23:59），例如 07:35。',
  budget_out_of_range: '每日主动消息预算必须是 0–5 之间的整数。',
  dnd_conflict: '免打扰时段会盖住已开启的 routine 时间，消息会被静默跳过；请先改 routine 时间或调整免打扰。',
  dnd_invalid: '免打扰时间不合法：开始/结束都要是 HH:mm，且不能覆盖全天。',
  unknown_field: '这是不认识的设置项；只能改 get 返回的设置（morningBrief/eveningReview/habitNudge/nightlyInbox/deadlineReminder/dnd/dailyBudget/suggestions/dndPolicy）。',
}

/** 每个工具自己的错误提示（覆盖共用 ERROR_HINTS，避免“task id”串到项目/笔记提示里）。 */
const TASK_ERROR_HINTS = {
  not_found: '任务不存在或 id 不对。先用 lifeos_task(action=list) 找到正确的任务 id。',
  conflict: '任务已被修改。先用 lifeos_task(action=get) 读取最新 rev 再重试一次；不要重复提交同一修改。',
}
const HABIT_ERROR_HINTS = {
  not_found: '习惯不存在或 id 不对。先用 lifeos_habit(action=list) 找到正确的习惯 id。',
  conflict: '习惯已被修改。先用 lifeos_habit(action=get) 读取最新 rev 再重试一次。',
}
const PROJECT_ERROR_HINTS = {
  not_found: '项目不存在或 id 不对。先用 lifeos_project(action=list) 找到正确的项目 id。',
  conflict: '项目名已存在（大小写不同也算同名）。先用 lifeos_project(action=list) 找到已有项目 id 复用它；不要重复创建同名项目。',
}
const GOAL_ERROR_HINTS = {
  not_found: '目标不存在或 id 不对。先用 lifeos_goal(action=list) 找到正确的目标 id。',
  conflict: '目标已被修改。先用 lifeos_goal(action=get) 读取最新 rev 再重试一次。',
}
const NOTES_ERROR_HINTS = {
  not_found: '文件或目录不存在。先用 action=list 查看；read/create/append 的 path 要相对笔记目录且带文件名（如 2026-11-15.md 或 日记/2026-11-15.md）。',
}

/** 内部输入错误：只在 execute 内部 throw，由外层统一转成 `{ok:false}`（不冒泡到注册表）。 */
class ToolInputError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ToolInputError'
    this.code = code
  }
}

function inputError(code, message) {
  return new ToolInputError(code, message)
}

/**
 * 把任意异常归一成模型可读的失败值。
 * 兼容 `error.code`、`error.name`，以及 `"code: message"` 形式的 message。
 * `hintOverrides` 让各工具覆盖共用提示（如项目/笔记的 not_found 文案）。
 * 冲突错误若带 `details.current.id`，把已有对象 id 追加进 message，避免模型只能猜名字。
 */
function toFailure(error, fallbackCode = 'internal', hintOverrides) {
  const rawMessage = typeof error?.message === 'string' ? error.message : ''
  let code = typeof error?.code === 'string' ? error.code : ''
  if (!code) {
    const match = /^([a-z][a-z0-9_]*):\s/.exec(rawMessage)
    if (match) code = match[1]
  }
  if (!code) code = fallbackCode
  const hint = hintOverrides?.[code] ?? ERROR_HINTS[code] ?? ERROR_HINTS.internal
  let message = rawMessage && rawMessage !== code ? rawMessage : hint
  const currentId = typeof error?.details?.current?.id === 'string' ? error.details.current.id : ''
  if (code === 'conflict' && currentId && !message.includes(currentId)) {
    message = `${message}（已有对象 id：${currentId}）`
  }
  return { ok: false, error: { code, message, hint } }
}

function failValue(code, message, hintOverrides) {
  return { ok: false, error: { code, message, hint: hintOverrides?.[code] ?? ERROR_HINTS[code] ?? ERROR_HINTS.internal } }
}

/** ContentBlock：注册表要求的 render 返回形状。 */
function textBlocks(text) {
  return [{ type: 'text', text: String(text) }]
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function taskTitle(task) {
  if (!task || typeof task !== 'object') return '(无标题)'
  const title = task.title ?? task.name ?? task.text
  return typeof title === 'string' && title.trim() ? title.trim() : '(无标题)'
}

function isDone(task) {
  if (!task || typeof task !== 'object') return false
  return task.status === 'done' || task.status === 'completed' || task.done === true
}

// ── today ────────────────────────────────────────────────────────
/** `lifeos_today` 的 render：中文摘要（今天 N 个任务，Inbox 待整理 M 条）。 */
export function renderToday(_args, value) {
  if (!value || value.ok !== true) {    const code = value?.error?.code ?? 'internal'
    const hint = value?.error?.hint ?? ERROR_HINTS.internal
    return textBlocks(`读取今日概况失败（${code}）。${hint}`)
  }

  const tasks = asArray(value.tasks)
  const doneCount = tasks.filter(isDone).length
  const inboxCount = Number.isFinite(value.inboxCount) ? value.inboxCount : 0
  const lines = [
    `今天 ${value.date ?? '（日期未知）'}｜任务 ${tasks.length} 个（已完成 ${doneCount}）｜Inbox 待整理 ${inboxCount} 条`,
  ]

  if (tasks.length === 0) {
    lines.push('今天没有排上任务。')
  } else {
    for (const task of tasks.slice(0, TODAY_RENDER_LIMIT)) {
      lines.push(`- ${isDone(task) ? '✓' : '○'} ${taskTitle(task)}${idLabel(task.id)}`)
    }
    if (tasks.length > TODAY_RENDER_LIMIT) {
      lines.push(`…另有 ${tasks.length - TODAY_RENDER_LIMIT} 个任务，可在 LifeOS 面板查看。`)
    }
  }
  if (inboxCount > 0) {
    lines.push(
      `提示：Inbox 还有 ${inboxCount} 条未整理；可在 LifeOS 面板点“待整理 ${inboxCount}”打开整理抽屉，或按用户要求用 lifeos_triage 生成候选。`,
    )
  }
  if (value.includeHabits === true) {
    const habits = asArray(value.habits)
    if (value.habitServiceReady === false) {
      lines.push('今日习惯：习惯服务尚未就绪，暂时无法读取（不要编造打卡状态或连续天数）。')
    } else if (habits.length === 0) {
      lines.push('今日习惯：没有进行中的习惯。')
    } else {
      lines.push(`今日习惯：${habits.length} 个`)
      for (const habit of habits.slice(0, 5)) {
        lines.push(
          `- ${habit.name ?? habit.habitId ?? '习惯'}｜${habit.frequency_text ?? '频率未设'}｜${habitStatusLabel(habit.today_status)}${habit.streak ? `｜${formatStreak(habit.streak)}` : ''}${idLabel(habit.id ?? habit.habitId)}`,
        )
      }
      if (habits.length > 5) lines.push(`…另有 ${habits.length - 5} 个习惯，可在 LifeOS 面板查看。`)
    }
  }
  return textBlocks(lines.join('\n'))
}

// ── capture ──────────────────────────────────────────────────────
/** `lifeos_capture` 的 render：成功/失败都给一句可直接转述的中文。 */
export function renderCapture(_args, value) {
  if (!value || value.ok !== true) {
    const code = value?.error?.code ?? 'internal'
    const message = value?.error?.message ?? ERROR_HINTS.internal
    return textBlocks(`没有记入 Inbox（${code}）：${message} 不要向用户声称已保存；可以说明失败原因并询问是否重试。`)
  }
  const inboxItemId = value.inboxItemId ?? '(未返回)'
  const rawRecordId = value.rawRecordId ?? '(未返回)'
  return textBlocks(
    `已记入 Inbox：${inboxItemId}｜原始记录：${rawRecordId}（来源：对话；内容按原文保存，未分类）`,
  )
}

// ── task helpers ─────────────────────────────────────────────────

/** 只保留 TaskLite 的稳定字段，避免把内部结构漏给模型。 */
export function normalizeTask(task) {
  if (!task || typeof task !== 'object') return null
  const tags = asArray(task.tags)
    .map((tag) => (typeof tag === 'string' ? { name: tag } : tag))
    .filter((tag) => tag && typeof tag === 'object')
    .map((tag) => ({
      id: typeof tag.id === 'string' ? tag.id : null,
      name: typeof tag.name === 'string' ? tag.name : null,
      color: typeof tag.color === 'string' ? tag.color : null,
    }))
  return {
    id: typeof task.id === 'string' ? task.id : null,
    title: taskTitle(task),
    notes: typeof task.notes === 'string' ? task.notes : null,
    status: typeof task.status === 'string' ? task.status : 'todo',
    priority: typeof task.priority === 'string' ? task.priority : 'none',
    projectId: typeof task.projectId === 'string' ? task.projectId : null,
    projectName: typeof task.projectName === 'string' ? task.projectName : null,
    tags,
    scheduledDate: typeof task.scheduledDate === 'string' ? task.scheduledDate : null,
    scheduledStartAt: typeof task.scheduledStartAt === 'string' ? task.scheduledStartAt : null,
    scheduledEndAt: typeof task.scheduledEndAt === 'string' ? task.scheduledEndAt : null,
    isAllDay: task.isAllDay === true,
    dueDate: typeof task.dueDate === 'string' ? task.dueDate : null,
    dueAt: typeof task.dueAt === 'string' ? task.dueAt : null,
    completedAt: typeof task.completedAt === 'string' ? task.completedAt : null,
    rev: isFiniteNumber(task.rev) ? task.rev : null,
    timeKind: typeof task.timeKind === 'string' ? task.timeKind : null,
  }
}

/** 工具渲染用的时区：优先取 LifeOS service 的 status()/bootstrap()，缺省 Asia/Shanghai。 */
function toolTimeZone(service) {
  try {
    const status = typeof service?.status === 'function' ? service.status() : null
    if (status && typeof status.timeZone === 'string' && status.timeZone) return status.timeZone
    const boot = typeof service?.bootstrap === 'function' ? service.bootstrap() : null
    const tz = boot?.settings?.timeZone
    if (typeof tz === 'string' && tz) return tz
  } catch {
    /* 取不到就用默认时区 */
  }
  return 'Asia/Shanghai'
}

/** UTC ISO → 本地 `YYYY-MM-DD HH:mm`（按用户时区；无法解析时原样返回）。 */
function formatDateTime(iso, timeZone) {
  if (typeof iso !== 'string') return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms))
    const pick = (type) => parts.find((part) => part.type === type)?.value
    const [year, month, day, hour, minute] = [pick('year'), pick('month'), pick('day'), pick('hour'), pick('minute')]
    if (year && month && day && hour && minute) return `${year}-${month}-${day} ${hour}:${minute}`
  } catch {
    /* 非法时区等异常时退回字符串截取 */
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso)
  return match ? `${match[1]} ${match[2]}` : iso
}

/** 任务日期展示：计划日期 → 计划时间段 → 截止 → 无日期（时间按用户时区显示）。 */
export function formatTaskDate(task, timeZone) {
  if (!task || typeof task !== 'object') return '无日期'
  if (typeof task.scheduledDate === 'string' && task.scheduledDate) return task.scheduledDate
  if (typeof task.scheduledStartAt === 'string' && task.scheduledStartAt) {
    const start = formatDateTime(task.scheduledStartAt, timeZone)
    const end =
      typeof task.scheduledEndAt === 'string' && task.scheduledEndAt
        ? formatDateTime(task.scheduledEndAt, timeZone)
        : ''
    return end ? `${start}–${end}` : start
  }
  if (typeof task.dueDate === 'string' && task.dueDate) return `截止 ${task.dueDate}`
  if (typeof task.dueAt === 'string' && task.dueAt) return `截止 ${formatDateTime(task.dueAt, timeZone)}`
  return '无日期'
}

function statusLabel(status) {
  return TASK_STATUS_LABELS[status] ?? status ?? '待办'
}

function priorityLabel(priority) {
  return TASK_PRIORITY_LABELS[priority] ?? priority ?? '无'
}

function projectLabel(task) {
  if (task?.projectName) return task.projectName
  if (task?.projectId) return `项目 ${task.projectId}`
  return '无项目'
}

function tagsLabel(task) {
  const names = asArray(task?.tags)
    .map((tag) => (typeof tag === 'string' ? tag : tag?.name))
    .filter((name) => typeof name === 'string' && name.trim())
  return names.length ? names.map((name) => `#${name}`).join(' ') : ''
}

function idLabel(id) {
  return typeof id === 'string' && id ? `｜id ${id}` : ''
}

/** 单任务一行卡片：标题 / 日期 / 项目 / 状态（+ 优先级、标签、id）。 */
export function taskCard(task, timeZone) {
  const parts = [
    `「${taskTitle(task)}」`,
    `状态 ${statusLabel(task?.status)}`,
    `日期 ${formatTaskDate(task, timeZone)}`,
    projectLabel(task),
    `优先级 ${priorityLabel(task?.priority)}`,
  ]
  const tags = tagsLabel(task)
  if (tags) parts.push(tags)
  return parts.join('｜') + idLabel(task?.id)
}

function taskBullet(task, timeZone) {
  const mark = task?.status === 'done' ? '✓' : task?.status === 'cancelled' ? '✕' : '○'
  const parts = [formatTaskDate(task, timeZone), projectLabel(task), `优先级 ${priorityLabel(task?.priority)}`]
  const tags = tagsLabel(task)
  if (tags) parts.push(tags)
  return `- ${mark} ${taskTitle(task)}｜${parts.join('｜')}${idLabel(task?.id)}`
}

function formatChangeValue(value) {
  if (value === null || value === undefined) return '（空）'
  if (typeof value === 'string') return value || '（空）'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '（空）'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function renderChanges(changes) {
  const lines = []
  for (const [key, change] of Object.entries(changes ?? {})) {
    if (change && typeof change === 'object' && 'before' in change && 'after' in change) {
      lines.push(`- ${key}：${formatChangeValue(change.before)} → ${formatChangeValue(change.after)}`)
    } else {
      lines.push(`- ${key}：${formatChangeValue(change)}`)
    }
  }
  return lines
}

function needsConfirmValue({ action, id, title, changes, current }) {
  return {
    ok: true,
    needsConfirm: true,
    action,
    id,
    title: title ?? null,
    preview: { action, id, changes },
    currentStatus: current?.status ?? null,
    currentRev: isFiniteNumber(current?.rev) ? current.rev : null,
    message: `这是 L3 操作（需要用户确认）：${TASK_ACTION_LABELS[action] ?? action}任务 ${id}。请先把上面的变更和影响告诉用户；用户明确同意后，再次调用本工具并传 confirm:true 才会执行；用户也可以直接在 LifeOS 面板操作。`,
  }
}

/** `lifeos_task` 的 render：列表 ≤8 条；单任务显示标题/日期/项目/状态/id。 */
export function renderTask(_args, value, renderContext = {}) {
  const timeZone = renderContext?.timeZone
  if (!value || value.ok !== true) {
    const code = value?.error?.code ?? 'internal'
    const message = value?.error?.message ?? ERROR_HINTS.internal
    const hint = value?.error?.hint ?? ERROR_HINTS.internal
    return textBlocks(`任务操作失败（${code}）：${message} ${hint}`)
  }

  if (value.needsConfirm === true) {
    const preview = value.preview ?? {}
    const lines = [`需要你确认（${TASK_ACTION_LABELS[preview.action] ?? preview.action}）${value.title ? `：「${value.title}」` : ''}`]
    const changes = renderChanges(preview.changes)
    if (changes.length) lines.push('将要变更：', ...changes)
    lines.push('确认后我再执行；你也可以直接在 LifeOS 面板里操作。')
    return textBlocks(lines.join('\n'))
  }

  const action = value.action ?? 'get'
  if (action === 'list') {
    const items = asArray(value.items)
    const viewLabel = TASK_VIEW_LABELS[value.view] ?? value.view ?? '全部'
    const lines = [`任务列表（${viewLabel}）：${items.length} 条`]
    if (items.length === 0) {
      lines.push('没有符合条件的任务。')
    } else {
      for (const task of items.slice(0, TASK_RENDER_LIMIT)) lines.push(taskBullet(task, timeZone))
      if (items.length > TASK_RENDER_LIMIT) lines.push(`…另有 ${items.length - TASK_RENDER_LIMIT} 条，可在 LifeOS 面板查看。`)
    }
    if (value.nextCursor) lines.push('还有更多：需要时可以带 cursor 继续查询。')
    return textBlocks(lines.join('\n'))
  }

  const task = value.task
  const prefix = {
    get: '任务详情',
    create: '已创建任务',
    update: '已更新任务',
    complete: '已完成任务',
    reopen: '已重开任务',
    cancel: '已取消任务',
    reschedule: '已改期',
  }[action] ?? '任务'
  const lines = [`${prefix}：${taskCard(task, timeZone)}`]
  if (action === 'update' && asArray(value.changedFields).length) {
    lines.push(`改动字段：${value.changedFields.join('、')}`)
  }
  return textBlocks(lines.join('\n'))
}

// ── task input helpers ───────────────────────────────────────────

function readString(args, key) {
  const value = args?.[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function readPositiveInt(args, key, max) {
  const value = args?.[key]
  if (!isFiniteNumber(value)) return undefined
  const integer = Math.trunc(value)
  if (integer < 1) return undefined
  return max ? Math.min(integer, max) : integer
}

function readBoolean(args, key) {
  const value = args?.[key]
  return typeof value === 'boolean' ? value : undefined
}

function assertPriority(priority) {
  if (priority !== undefined && !TASK_PRIORITIES.includes(priority)) {
    throw inputError('validation_failed', `priority 必须是 ${TASK_PRIORITIES.join(' / ')}`)
  }
}

function assertDateOnly(value, key) {
  if (value !== undefined && !DATE_ONLY_RE.test(value)) {
    throw inputError('validation_failed', `${key} 必须是 YYYY-MM-DD 格式`)
  }
}

function assertIsoDateTime(value, key) {
  if (value === undefined) return
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    throw inputError(
      'validation_failed',
      `${key} 必须是可解析的 ISO 时间（可带 Z 或 +08:00 偏移，如 2026-11-15T22:00:00+08:00 或 2026-11-15T14:00:00.000Z）`,
    )
  }
}

/** 把带偏移的 ISO 时间统一归一到 UTC `...Z`（领域校验只接受严格 UTC）。 */
function toUtcIso(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

/** 读取计划/截止字段（只收 undefined 之外的显式值），并做互斥与格式校验。 */
function readTaskTimeFields(args) {
  const fields = {
    scheduledDate: readString(args, 'scheduledDate'),
    scheduledStartAt: readString(args, 'scheduledStartAt'),
    scheduledEndAt: readString(args, 'scheduledEndAt'),
    isAllDay: readBoolean(args, 'isAllDay'),
    dueDate: readString(args, 'dueDate'),
    dueAt: readString(args, 'dueAt'),
  }
  const provided = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))

  assertDateOnly(provided.scheduledDate, 'scheduledDate')
  assertDateOnly(provided.dueDate, 'dueDate')
  assertIsoDateTime(provided.scheduledStartAt, 'scheduledStartAt')
  assertIsoDateTime(provided.scheduledEndAt, 'scheduledEndAt')
  assertIsoDateTime(provided.dueAt, 'dueAt')
  for (const key of ['scheduledStartAt', 'scheduledEndAt', 'dueAt']) {
    if (provided[key] !== undefined) provided[key] = toUtcIso(provided[key])
  }

  if (provided.scheduledDate !== undefined && provided.scheduledStartAt !== undefined) {
    throw inputError(
      'validation_failed',
      'scheduledDate 与 scheduledStartAt 互斥：整天/浮动日期用 scheduledDate，具体时间段用 scheduledStartAt + scheduledEndAt',
    )
  }
  if ((provided.scheduledStartAt === undefined) !== (provided.scheduledEndAt === undefined)) {
    throw inputError('validation_failed', '时间段必须同时给 scheduledStartAt 与 scheduledEndAt')
  }
  if (provided.scheduledStartAt !== undefined && provided.scheduledEndAt !== undefined) {
    if (Date.parse(provided.scheduledEndAt) <= Date.parse(provided.scheduledStartAt)) {
      throw inputError('validation_failed', 'scheduledEndAt 必须晚于 scheduledStartAt')
    }
  }
  if (provided.dueDate !== undefined && provided.dueAt !== undefined) {
    throw inputError('validation_failed', 'dueDate 与 dueAt 互斥：日期型截止用 dueDate，时刻型截止用 dueAt')
  }
  if (provided.isAllDay === true && provided.scheduledStartAt !== undefined) {
    throw inputError('validation_failed', 'isAllDay=true 只能配合 scheduledDate 使用，不能与 scheduledStartAt 同时出现')
  }
  return provided
}

function readTags(args) {
  if (args?.tagIds === undefined) return undefined
  if (!Array.isArray(args.tagIds)) {
    throw inputError('validation_failed', 'tagIds 必须是字符串数组')
  }
  const ids = args.tagIds
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter((id) => id.length > 0)
  return ids
}

function readPatch(args) {
  const patch = {}
  const title = readString(args, 'title')
  if (title !== undefined) patch.title = title
  if (typeof args?.notes === 'string') patch.notes = args.notes
  const priority = readString(args, 'priority')
  if (priority !== undefined) {
    assertPriority(priority)
    patch.priority = priority
  }
  const projectId = readString(args, 'projectId')
  if (projectId !== undefined) patch.projectId = projectId
  const tagIds = readTags(args)
  if (tagIds !== undefined) patch.tagIds = tagIds
  Object.assign(patch, readTaskTimeFields(args))
  return patch
}

/** 写操作元信息：actor/sessionId 放进服务调用的可选尾参（B 未支持时被忽略）。 */
function buildWriteMeta(exec) {
  const callId = typeof exec?.callId === 'string' && exec.callId ? exec.callId : null
  return {
    actor: 'agent',
    sessionId: typeof exec?.agent?.id === 'string' ? exec.agent.id : null,
    idempotencyKey: callId,
  }
}

async function readCurrentTask(service, id) {
  if (typeof service?.getTask !== 'function') return null
  const task = await service.getTask(id)
  return task && typeof task === 'object' ? task : null
}

/** 解析 CAS 版本：显式 expectedRev 优先，否则读当前任务取 rev。 */
async function resolveExpectedRev(service, id, args) {
  const explicit = readPositiveInt(args, 'expectedRev', Number.MAX_SAFE_INTEGER)
  if (explicit !== undefined) return explicit
  const current = await readCurrentTask(service, id)
  if (current && isFiniteNumber(current.rev)) return current.rev
  throw inputError(
    'validation_failed',
    '缺少 expectedRev 且无法读取当前任务版本；请先 action=get 读取任务再用返回的 rev',
  )
}

function requireMethod(service, method) {
  if (typeof service?.[method] !== 'function') {
    throw inputError('internal', `服务未提供 ${method}()，宿主版本可能不匹配（需要 M1 service v0.2）`)
  }
}

function requireId(args) {
  const id = readString(args, 'id')
  if (!id) throw inputError('validation_failed', '该 action 需要 id')
  return id
}

function expectTaskResult(result, action) {
  const task = result?.task ?? result ?? null
  const normalized = normalizeTask(task)
  if (!normalized) throw inputError('internal', `${action} 未返回任务对象`)
  return { task: normalized, rev: isFiniteNumber(result?.rev) ? result.rev : normalized.rev }
}

// ── task action runners ──────────────────────────────────────────
async function runList(service, args) {
  requireMethod(service, 'listTasks')
  const view = readString(args, 'view')
  if (view !== undefined && !TASK_VIEWS.includes(view)) {
    throw inputError('validation_failed', `view 必须是 ${TASK_VIEWS.join(' / ')}`)
  }
  const limit = readPositiveInt(args, 'limit', TASK_LIST_MAX_LIMIT) ?? TASK_LIST_DEFAULT_LIMIT
  const input = {
    view: view ?? 'all',
    limit,
  }
  const projectId = readString(args, 'projectId')
  if (projectId !== undefined) input.projectId = projectId
  const tagId = readString(args, 'tagId')
  if (tagId !== undefined) input.tagId = tagId
  const q = readString(args, 'q')
  if (q !== undefined) input.q = q
  const cursor = readString(args, 'cursor')
  if (cursor !== undefined) input.cursor = cursor

  const result = await service.listTasks(input)
  const items = asArray(result?.items).map(normalizeTask).filter(Boolean)
  const value = {
    ok: true,
    action: 'list',
    view: input.view,
    items,
    nextCursor: typeof result?.nextCursor === 'string' ? result.nextCursor : null,
  }
  if (result?.counts && typeof result.counts === 'object') value.counts = result.counts
  if (Array.isArray(result?.groups)) {
    value.groups = result.groups.map((group) => ({
      key: typeof group?.key === 'string' ? group.key : null,
      label: typeof group?.label === 'string' ? group.label : null,
      count: isFiniteNumber(group?.count) ? group.count : null,
    }))
  }
  return value
}

async function runGet(service, args) {
  requireMethod(service, 'getTask')
  const id = requireId(args)
  const task = await service.getTask(id)
  if (!task) throw inputError('not_found', `任务 ${id} 不存在（可能已删除或 id 不对）`)
  const normalized = normalizeTask(task)
  if (!normalized) throw inputError('internal', 'getTask 返回了无法解析的任务')
  return { ok: true, action: 'get', task: normalized }
}

async function runCreate(service, args, exec) {
  requireMethod(service, 'createTask')
  const title = readString(args, 'title')
  if (!title) throw inputError('validation_failed', 'create 需要 title')
  if (title.length > 500) throw inputError('validation_failed', 'title 最长 500 字')

  const input = { title }
  const notes = readString(args, 'notes')
  if (notes !== undefined) input.notes = notes
  const priority = readString(args, 'priority')
  if (priority !== undefined) {
    assertPriority(priority)
    input.priority = priority
  }
  const projectId = readString(args, 'projectId')
  if (projectId !== undefined) input.projectId = projectId
  const tagIds = readTags(args)
  if (tagIds !== undefined) input.tagIds = tagIds
  Object.assign(input, readTaskTimeFields(args))

  const result = await service.createTask(
    {
      ...input,
      // B 的 `createTask` 从 input.idempotencyKey 取幂等键写入 oplog（M1 service v0.2 实测）；
      // 同时保留第二参 meta，便于后续服务支持时直接读取。
      ...(buildWriteMeta(exec).idempotencyKey ? { idempotencyKey: buildWriteMeta(exec).idempotencyKey } : {}),
    },
    buildWriteMeta(exec),
  )
  const { task, rev } = expectTaskResult(result, 'create')
  return { ok: true, action: 'create', task, rev, changedFields: Object.keys(input) }
}

async function runUpdate(service, args, exec) {
  requireMethod(service, 'updateTask')
  const id = requireId(args)
  const patch = readPatch(args)
  const changedFields = Object.keys(patch)
  if (changedFields.length === 0) {
    throw inputError('validation_failed', 'update 没有可更新字段（可更新 title/notes/priority/projectId/tagIds/scheduled*/due*/isAllDay）')
  }

  const l3Fields = changedFields.filter((field) => TASK_L3_UPDATE_FIELDS.includes(field))
  const confirm = readBoolean(args, 'confirm') === true
  let current = null

  if (l3Fields.length > 0 && !confirm) {
    current = await readCurrentTask(service, id)
    if (!current) throw inputError('not_found', `任务 ${id} 不存在`)
    const changes = {}
    for (const field of l3Fields) changes[field] = { before: current[field] ?? null, after: patch[field] }
    return needsConfirmValue({
      action: 'update',
      id,
      title: taskTitle(current),
      changes,
      current,
    })
  }

  const expectedRev = await resolveExpectedRev(service, id, args)
  const meta = buildWriteMeta(exec)
  const patchWithIdem = meta.idempotencyKey ? { ...patch, idempotencyKey: meta.idempotencyKey } : patch
  const result = await service.updateTask(id, patchWithIdem, expectedRev, meta)
  const { task, rev } = expectTaskResult(result, 'update')
  return { ok: true, action: 'update', task, rev, changedFields }
}

async function runComplete(service, args, exec) {
  requireMethod(service, 'completeTask')
  const id = requireId(args)
  const expectedRev = await resolveExpectedRev(service, id, args)
  const result = await service.completeTask(id, expectedRev, buildWriteMeta(exec))
  const { task } = expectTaskResult(result, 'complete')
  return { ok: true, action: 'complete', task }
}

async function runReopen(service, args, exec) {
  requireMethod(service, 'reopenTask')
  const id = requireId(args)
  const expectedRev = await resolveExpectedRev(service, id, args)
  const result = await service.reopenTask(id, expectedRev, buildWriteMeta(exec))
  const { task } = expectTaskResult(result, 'reopen')
  return { ok: true, action: 'reopen', task }
}

async function runCancel(service, args, exec) {
  requireMethod(service, 'cancelTask')
  const id = requireId(args)
  const current = await readCurrentTask(service, id)
  if (!current) throw inputError('not_found', `任务 ${id} 不存在`)
  const confirm = readBoolean(args, 'confirm') === true
  if (!confirm) {
    return needsConfirmValue({
      action: 'cancel',
      id,
      title: taskTitle(current),
      changes: { status: { before: current.status ?? 'todo', after: 'cancelled' } },
      current,
    })
  }
  const expectedRev = await resolveExpectedRev(service, id, args)
  const result = await service.cancelTask(id, expectedRev, buildWriteMeta(exec))
  const { task } = expectTaskResult(result, 'cancel')
  return { ok: true, action: 'cancel', task }
}

async function runReschedule(service, args, exec) {
  requireMethod(service, 'rescheduleTask')
  const id = requireId(args)
  const input = readTaskTimeFields(args)
  const fields = Object.keys(input)
  if (fields.length === 0) {
    throw inputError('validation_failed', 'reschedule 需要至少一个时间字段（scheduledDate/scheduledStartAt+scheduledEndAt/dueDate/dueAt）')
  }
  const current = await readCurrentTask(service, id)
  if (!current) throw inputError('not_found', `任务 ${id} 不存在`)
  const confirm = readBoolean(args, 'confirm') === true
  if (!confirm) {
    const changes = {}
    for (const field of fields) changes[field] = { before: current[field] ?? null, after: input[field] }
    return needsConfirmValue({ action: 'reschedule', id, title: taskTitle(current), changes, current })
  }
  const expectedRev = await resolveExpectedRev(service, id, args)
  const result = await service.rescheduleTask(id, input, expectedRev, buildWriteMeta(exec))
  const { task } = expectTaskResult(result, 'reschedule')
  return { ok: true, action: 'reschedule', task, changedFields: fields }
}

// ── tool definitions ─────────────────────────────────────────────

/**
 * `lifeos_today`：只读。可 include=habits 读取今日习惯（M4）。
 * 返回 service.today() 的 canonical 值 + 失败归一。
 */
export function todayTool(service) {
  return {
    name: 'lifeos_today',
    description: [
      '读取 LifeOS 今天的概况：本地日期、今日任务列表（标题与完成状态）、Inbox 待整理条数；可选 include:["habits"] 额外读取今日习惯（打卡状态与连续天数，最多 10 条）。只读，不修改任何数据。',
      '何时用：用户问“今天有什么安排 / 今天怎么样 / 我现在该做什么 / 今天习惯打卡了吗”，或你需要知道今天是哪天、有哪些待办/习惯才能回答时。',
      '何时不用：用户只是闲聊、或问的是历史数据与统计（用 lifeos_habit action=stats/month）；不要用它推断用户没记录的事，也不要据计划推断已打卡。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        include: {
          type: 'array',
          items: { type: 'string', enum: ['habits'] },
          description: '可选：额外包含的模块。habits=今日习惯（最多 10 条，含 today_status 与 streak）',
        },
      },
      additionalProperties: false,
    },
    output: {
      // 注册表的 canonical schema 只支持单值 `type`，不支持 `type: ['string','null']` 联合数组
      // （M0 首装实测报 unsupported JSON schema）→ 统一宽松对象 schema，null 由 render 兜底。
      schema: OUTPUT_SCHEMA,
      render: (args, value) => renderToday(args, value, { timeZone: toolTimeZone(service) }),
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        if (typeof service?.today !== 'function') {
          return failValue('internal', '服务未提供 today()，宿主可能未就绪')
        }
        const include = readTodayInclude(args)
        const today = await service.today()
        if (!today || typeof today !== 'object') {
          return failValue('internal', 'today() 返回空值')
        }
        const value = {
          ok: true,
          date: typeof today.date === 'string' ? today.date : null,
          tasks: asArray(today.tasks).slice(0, TODAY_TASK_LIMIT),
          inboxCount: Number.isFinite(today.inboxCount) ? today.inboxCount : 0,
          agentId: typeof exec?.agent?.id === 'string' ? exec.agent.id : null,
        }
        if (include.includes('habits')) {
          const habits = await readTodayHabits(service)
          value.includeHabits = true
          value.habits = habits ?? []
          value.habitServiceReady = habits !== null
        }
        return value
      } catch (error) {
        return toFailure(error)
      }
    },
  }
}

/**
 * `lifeos_capture`：把用户原话写进 Inbox。
 * `exec.callId` → service.capture 的 requestId（重试幂等）。
 */
export function captureTool(service) {
  return {
    name: 'lifeos_capture',
    description: [
      '把用户给出的一段内容**按原文**收进 LifeOS 的 Inbox（原始记录，不分类、不建任务、不排期）。',
      '何时用：用户说“记一下 / 帮我记住 / 随手记 / 别忘了……”并给出内容；或用户明确要求保存一段想法、待办、日记片段。',
      '何时不用：用户在向你提问（先回答）；用户要求你完成/修改/删除任务或整理分类（该用 lifeos_task 或说明能力边界）；内容为空、只是“嗯/好”之类的回应。',
      '重要：text 必须是用户原话，不要改写、概括、补全或加日期；原始记录优先，后续由整理流程处理。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_CAPTURE_CHARS,
          description: `要保存的原始内容（用户原话，不要改写/概括）。1–${MAX_CAPTURE_CHARS} 字；超过时请让用户拆成多条。`,
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderCapture,
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const raw = typeof args?.text === 'string' ? args.text : ''
      const text = raw.trim()
      if (!text) {
        return failValue('validation_failed', 'text 不能为空')
      }
      if (text.length > MAX_CAPTURE_CHARS) {
        return failValue(
          'validation_failed',
          `text 长度 ${text.length} 超过上限 ${MAX_CAPTURE_CHARS}，请让用户拆成多条再记`,
        )
      }
      if (typeof service?.capture !== 'function') {
        return failValue('internal', '服务未提供 capture()，宿主可能未就绪')
      }

      const callId = typeof exec?.callId === 'string' && exec.callId ? exec.callId : null
      const agentId = typeof exec?.agent?.id === 'string' ? exec.agent.id : null
      try {
        const captured = await service.capture({
          text,
          source: 'chat',
          ...(callId ? { requestId: callId } : {}),
        })
        return {
          ok: true,
          rawRecordId: typeof captured?.rawRecordId === 'string' ? captured.rawRecordId : null,
          inboxItemId: typeof captured?.inboxItemId === 'string' ? captured.inboxItemId : null,
          callId,
          agentId,
        }
      } catch (error) {
        return toFailure(error)
      }
    },
  }
}

/**
 * `lifeos_task`：任务读/写（M1 唯一新增工具）。
 *
 * 权限分支（写死在 execute 里，模型无法用参数绕过）：
 *   L2 直接执行：list / get / create / update（title/notes/priority/projectId/tagIds/scheduled…/isAllDay）/ complete / reopen
 *   L3 只预演：cancel / reschedule / update 里含 dueDate/dueAt → `{ok:true,needsConfirm:true,preview}`，不执行；
 *              用户确认后再次调用并带 `confirm:true` 才执行。
 */
export function taskTool(service) {
  return {
    name: 'lifeos_task',
    description: [
      '管理 LifeOS 任务：查询（list/get）、创建、更新、完成、重开、取消、改期。',
      '权限：create/update 普通字段（标题、备注、优先级、项目、标签、计划时间）/complete/reopen 会直接执行（L2）；**cancel、reschedule、以及 update 里改截止时间（dueDate/dueAt）是 L3**——本工具不会执行，只返回 needsConfirm + preview，你必须把变更和影响告诉用户；用户明确同意后再调用一次并传 confirm:true。',
      '何时用：用户让你“记成一个任务/建个任务/把 X 标完成/重新打开/挪到明天/这周有什么任务/任务详情”。',
      '何时不用：用户只是随口记录（用 lifeos_capture 收进 Inbox，不要擅自建任务）；用户要删除任务（不提供删除，让用户在面板取消/归档）；用户问习惯/项目/目标（用 lifeos_habit/lifeos_project/lifeos_goal）。',
      '重要：list 返回的每一项都带 id（形如 tsk_…），后续 get/update 等必须用返回的 id，不要用标题猜 id；update 需要最新 rev（可先 action=get 读取，工具也会自动补），冲突时重读后再试；日期格式 YYYY-MM-DD，时间段用 ISO（可带 Z 或 +08:00 偏移，工具会归一为 UTC，如 2026-11-15T22:00:00+08:00）；scheduledDate 与 scheduledStartAt 互斥，dueDate 与 dueAt 互斥。',
      '日程时间只能来自用户明确表达：不要从笔记里的“约束/禁令/习惯/注意事项”推断出具体时间并擅自排成日程块；用户没给时间就先问。',
    ].join('\n'),
    parameters: {
      type: 'object',
      // 多 action 共用参数：不用 additionalProperties:false，具体校验在 execute 里做（M1-PLAN §5）。
      properties: {
        action: {
          type: 'string',
          enum: TASK_ACTIONS,
          description: '要执行的动作；list/get 只读，其余为写操作',
        },
        id: { type: 'string', description: '任务 id（get/update/complete/reopen/cancel/reschedule 必填，来自 list/get 返回）' },
        view: {
          type: 'string',
          enum: TASK_VIEWS,
          description: 'list 的视图：today/overdue/next7/inbox/all，默认 all',
        },
        projectId: { type: 'string', description: 'list 时按项目筛选；create/update 时设置项目归属' },
        tagId: { type: 'string', description: 'list 时按标签筛选' },
        q: { type: 'string', description: 'list 时的标题/备注关键词' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: TASK_LIST_MAX_LIMIT,
          description: `list 返回条数，默认 ${TASK_LIST_DEFAULT_LIMIT}，最大 ${TASK_LIST_MAX_LIMIT}`,
        },
        cursor: { type: 'string', description: 'list 下一页游标（上一页返回的 nextCursor）' },
        title: { type: 'string', minLength: 1, maxLength: 500, description: 'create 必填；update 可改标题' },
        notes: { type: 'string', description: '备注' },
        priority: { type: 'string', enum: TASK_PRIORITIES, description: '优先级 none/low/medium/high' },
        tagIds: { type: 'array', items: { type: 'string' }, description: '标签 id 数组（create/update 覆盖式设置）' },
        scheduledDate: { type: 'string', description: '计划日期 YYYY-MM-DD（整天/浮动日；与 scheduledStartAt 互斥）' },
        scheduledStartAt: { type: 'string', description: '计划开始时间 ISO（与 scheduledEndAt 成对；与 scheduledDate 互斥）' },
        scheduledEndAt: { type: 'string', description: '计划结束时间 ISO，必须晚于 scheduledStartAt' },
        isAllDay: { type: 'boolean', description: '是否整天（配合 scheduledDate）' },
        dueDate: { type: 'string', description: '截止日期 YYYY-MM-DD（与 dueAt 互斥；update 里改它属于 L3）' },
        dueAt: { type: 'string', description: '截止时间 ISO（与 dueDate 互斥；update 里改它属于 L3）' },
        expectedRev: {
          type: 'integer',
          minimum: 1,
          description: 'CAS 版本（写操作推荐显式传；不传时工具会先 get 当前任务取 rev）',
        },
        confirm: {
          type: 'boolean',
          description: '仅用于 L3 动作：上一轮返回 needsConfirm 且用户明确同意后传 true 才会执行；不要自行传 true',
        },
      },
      required: ['action'],
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => renderTask(args, value, { timeZone: toolTimeZone(service) }),
    },
    timeoutMs: 15_000,
    isConcurrencySafe: (args) => args?.action === 'list' || args?.action === 'get',
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action.trim() : ''
      if (!TASK_ACTIONS.includes(action)) {
        return failValue('validation_failed', `action 必须是 ${TASK_ACTIONS.join(' / ')} 之一`)
      }
      try {
        switch (action) {
          case 'list':
            return await runList(service, args)
          case 'get':
            return await runGet(service, args)
          case 'create':
            return await runCreate(service, args, exec)
          case 'update':
            return await runUpdate(service, args, exec)
          case 'complete':
            return await runComplete(service, args, exec)
          case 'reopen':
            return await runReopen(service, args, exec)
          case 'cancel':
            return await runCancel(service, args, exec)
          case 'reschedule':
            return await runReschedule(service, args, exec)
          default:
            return failValue('validation_failed', `未实现的动作：${action}`)
        }
      } catch (error) {
        return toFailure(error, 'internal', TASK_ERROR_HINTS)
      }
    },
  }
}

// ════════════════════════════════════════════════════════════════
// M2 · 整理（triage）与纠错（correct）
// ════════════════════════════════════════════════════════════════

const TRIAGE_ACTIONS = ['begin', 'commit', 'abort']
const TRIAGE_SCOPES = ['pending', 'ids']
const TRIAGE_KINDS = ['task', 'event', 'metric', 'habit_checkin', 'wish', 'ignore']
const TRIAGE_DEFAULT_LIMIT = 10
const TRIAGE_MAX_LIMIT = 20
const TRIAGE_MAX_CANDIDATES = 60
const TRIAGE_TEXT_MAX = 2000
const TRIAGE_RENDER_LIMIT = 6

const CORRECT_TYPES = ['task', 'event', 'metric', 'habit_checkin']
const CORRECT_ACTIONS = ['update', 'revoke']
const CORRECT_RENDER_LIMIT = 6

const TRIAGE_KIND_LABELS = {
  task: '任务',
  event: '事件',
  metric: '指标',
  habit_checkin: '习惯打卡',
  wish: '愿望',
  ignore: '忽略',
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function pickNumber(...values) {
  for (const value of values) {
    if (isFiniteNumber(value)) return value
  }
  return null
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function pickMethodName(service, names) {
  for (const name of names) {
    if (typeof service?.[name] === 'function') return name
  }
  return null
}

function normalizeIdList(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw inputError('validation_failed', 'ids 必须是字符串数组')
  const ids = value.map((id) => (typeof id === 'string' ? id.trim() : '')).filter((id) => id.length > 0)
  if (ids.length === 0) throw inputError('validation_failed', 'ids 不能为空数组')
  return ids
}

function normalizeRun(run) {
  if (!run || typeof run !== 'object') return null
  const runId = firstString(run.runId, run.run_id, run.id)
  return {
    runId,
    status: firstString(run.status) ?? null,
    candidateCount: pickNumber(run.candidateCount, run.candidate_count, run.candidates?.length),
    appliedCount: pickNumber(run.appliedCount, run.applied_count, run.applied),
  }
}

function normalizeTriageBatch(entry) {
  if (!entry || typeof entry !== 'object') return null
  const raw = entry.rawRecord && typeof entry.rawRecord === 'object' ? entry.rawRecord : entry
  const rawRecordId = firstString(raw.id, raw.rawRecordId, raw.raw_record_id, entry.rawRecordId)
  const text = firstString(raw.text, raw.rawText, raw.raw_text, entry.text)
  if (!rawRecordId || !text) return null
  const truncated = text.length > TRIAGE_TEXT_MAX
  return {
    rawRecordId,
    text: truncated ? text.slice(0, TRIAGE_TEXT_MAX) : text,
    textTruncated: truncated,
    localDate: firstString(raw.localDate, raw.user_local_date) ?? null,
    createdAt: firstString(raw.createdAt, raw.created_at) ?? null,
    inboxItemId: firstString(entry.inboxItem?.id, raw.inboxItemId) ?? null,
    runId: firstString(entry.runId, entry.run_id) ?? null,
  }
}

function normalizeTriageBatches(run) {
  const candidatesArrays = [
    run?.batches,
    run?.records,
    run?.rawRecords,
    run?.items,
    run?.run?.batches,
    run?.run?.records,
    run?.result?.batches,
    run?.result?.records,
  ]
  for (const array of candidatesArrays) {
    if (!Array.isArray(array) || array.length === 0) continue
    const batches = array.map(normalizeTriageBatch).filter(Boolean)
    if (batches.length > 0) return batches
  }
  return []
}

function normalizeCandidateBrief(candidate) {
  if (!candidate || typeof candidate !== 'object') return null
  return {
    candidateId: firstString(candidate.candidateId, candidate.candidate_id, candidate.id) ?? null,
    rawRecordId: firstString(candidate.rawRecordId, candidate.raw_record_id) ?? null,
    kind: firstString(candidate.kind) ?? null,
    confidence: isFiniteNumber(candidate.confidence) ? candidate.confidence : null,
    requiresConfirm: candidate.requiresConfirm === true,
    risks: asArray(candidate.risks).filter((risk) => typeof risk === 'string'),
  }
}

async function collectPendingBatches(service, ids, limit) {
  if (typeof service?.listTriagePending !== 'function') return []
  let pending
  try {
    pending = await service.listTriagePending()
  } catch {
    return []
  }
  const groups = asArray(pending?.groups)
  const wanted = ids ? new Set(ids) : null
  const batches = []
  for (const group of groups) {
    const batch = normalizeTriageBatch(group)
    if (!batch) continue
    if (wanted && !wanted.has(batch.rawRecordId)) continue
    if (!batch.runId) batch.runId = firstString(group?.runId, group?.run_id) ?? null
    batches.push(batch)
    if (batches.length >= limit) break
  }
  return batches
}

async function runTriageBegin(service, args) {
  requireMethod(service, 'runTriage')
  const scope = readString(args, 'scope') ?? 'pending'
  if (!TRIAGE_SCOPES.includes(scope)) {
    throw inputError('validation_failed', `scope 必须是 ${TRIAGE_SCOPES.join(' / ')} 之一`)
  }
  const limit = readPositiveInt(args, 'limit', TRIAGE_MAX_LIMIT) ?? TRIAGE_DEFAULT_LIMIT
  const ids = scope === 'ids' ? normalizeIdList(args.ids) : undefined
  if (scope === 'ids' && (!ids || ids.length === 0)) {
    throw inputError('validation_failed', 'scope=ids 时必须给非空 ids')
  }
  const input = { mode: 'agent', limit }
  if (ids) input.rawRecordIds = ids
  const runKey = readString(args, 'runKey')
  if (runKey) input.runKey = runKey

  const run = await service.runTriage(input)
  let runId = firstString(run?.runId, run?.run_id, run?.id, run?.run?.id, run?.run?.runId)
  let batches = normalizeTriageBatches(run)
  if (batches.length === 0) {
    // 服务把"agent 深抽取"委托给会话时可能只返回 needsAgent + runId；
    // 用待整理队列补上原文批次，避免模型拿不到可抽取的文本。
    const pendingBatches = await collectPendingBatches(service, ids, limit)
    if (pendingBatches.length > 0) {
      batches = pendingBatches
      runId = runId ?? firstString(pendingBatches[0]?.runId)
    }
  }
  if (!runId) throw inputError('internal', 'runTriage 未返回 runId（M2-PLAN §3.1 契约）')

  const candidates = asArray(run?.candidates).map(normalizeCandidateBrief).filter(Boolean)
  return {
    ok: true,
    action: 'begin',
    runId,
    alreadyDone: run?.alreadyDone === true || run?.already_done === true || run?.reused === true,
    scope,
    limit,
    count: batches.length,
    batches,
    needsAgent: run?.needsAgent === true,
    candidates,
    pendingCount: pickNumber(run?.pendingCount, run?.pendingRaw, run?.pending),
  }
}

function validateTriageCandidates(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw inputError('validation_failed', 'commit 需要非空 candidates 数组')
  }
  if (value.length > TRIAGE_MAX_CANDIDATES) {
    throw inputError('validation_failed', `候选最多 ${TRIAGE_MAX_CANDIDATES} 条，请分批提交`)
  }
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw inputError('validation_failed', `candidates[${index}] 必须是对象`)
    }
    const kind = readString(candidate, 'kind')
    if (!kind || !TRIAGE_KINDS.includes(kind)) {
      throw inputError('validation_failed', `candidates[${index}].kind 必须是 ${TRIAGE_KINDS.join(' / ')}`)
    }
    const rawRecordId = readString(candidate, 'rawRecordId')
    if (!rawRecordId) throw inputError('validation_failed', `candidates[${index}].rawRecordId 必填`)
    const source = candidate.source
    if (!source || typeof source !== 'object' || typeof source.quote !== 'string' || !source.quote.trim()) {
      throw inputError('validation_failed', `candidates[${index}].source.quote 必须是原文子串（必填）`)
    }
    const quote = source.quote.trim()
    if (!Number.isInteger(source.start) || source.start < 0) {
      throw inputError('validation_failed', `candidates[${index}].source.start 必须是非负整数`)
    }
    if (!Number.isInteger(source.end) || source.end < source.start) {
      throw inputError('validation_failed', `candidates[${index}].source.end 必须是 ≥ start 的整数`)
    }
    const fields = candidate.fields && typeof candidate.fields === 'object' && !Array.isArray(candidate.fields)
      ? candidate.fields
      : {}
    const risks = asArray(candidate.risks).filter((risk) => typeof risk === 'string')
    const reasons = asArray(candidate.reasons).filter((reason) => typeof reason === 'string')
    return {
      candidateId: firstString(candidate.candidateId, candidate.candidate_id, candidate.id) ?? `cand_${index + 1}`,
      rawRecordId,
      kind,
      confidence: isFiniteNumber(candidate.confidence) ? clampNumber(candidate.confidence, 0, 1) : 0.5,
      source: { quote, start: source.start, end: source.end },
      fields,
      reasons,
      risks,
      requiresConfirm: candidate.requiresConfirm === true || risks.length > 0,
    }
  })
}

async function runTriageCommit(service, args) {
  const runId = readString(args, 'runId')
  if (!runId) throw inputError('validation_failed', 'commit 需要 runId（begin 返回的 runId）')
  const candidates = validateTriageCandidates(args.candidates)

  // 契约缺口（已在交付报告里通知 B）：M2-PLAN §3.1 冻结 API 没有"只写候选草稿"的方法，
  // 只有 runTriage / applyTriage。这里按 priority 找 B 应提供的 draft 方法名；
  // **绝不调用 applyTriage**——它会把候选落进业务表，而工具语义是"只提交候选、等用户确认"。
  const method = pickMethodName(service, ['saveTriageCandidates', 'commitTriageCandidates', 'applyTriageDraft'])
  if (!method) {
    throw inputError(
      'internal',
      'service 未提供候选草稿接口（需要 M2 §3.1 增补 saveTriageCandidates({runId, candidates})，只写 extraction_run 候选）',
    )
  }
  const result = await service[method]({ runId, candidates })
  const saved = pickNumber(result?.saved, result?.savedCount, result?.candidates?.length, candidates.length)
  const needsConfirm = pickNumber(
    result?.needsConfirm,
    result?.needsConfirmCount,
    candidates.filter((candidate) => candidate.requiresConfirm).length,
  )
  return {
    ok: true,
    action: 'commit',
    runId,
    saved: saved ?? candidates.length,
    needsConfirm: needsConfirm ?? 0,
    alreadyDone: result?.alreadyDone === true,
    run: normalizeRun(result?.run ?? result),
  }
}

async function runTriageAbort(service, args) {
  const runId = readString(args, 'runId')
  if (!runId) throw inputError('validation_failed', 'abort 需要 runId')
  const reason = readString(args, 'reason')
  const method = pickMethodName(service, ['abortTriage', 'cancelTriage'])
  if (!method) {
    return {
      ok: true,
      action: 'abort',
      runId,
      persisted: false,
      warning: '服务未提供 abortTriage()；本次放弃只影响当前会话，run 可能悬挂在服务端，请告知用户并让服务补接口',
    }
  }
  const result = await service[method](reason ? { runId, reason } : { runId })
  return { ok: true, action: 'abort', runId, persisted: true, run: normalizeRun(result?.run ?? result) }
}

function normalizeAffected(result) {
  const list = asArray(result?.affected ?? result?.items ?? (Array.isArray(result) ? result : []))
  return list
    .map((item) => {
      if (typeof item === 'string') return { type: null, id: item, field: null }
      if (!item || typeof item !== 'object') return null
      return {
        type: firstString(item.type, item.entityType, item.entity_type) ?? null,
        id: firstString(item.id, item.entityId, item.entity_id) ?? null,
        field: firstString(item.field) ?? null,
      }
    })
    .filter((item) => item && (item.id || item.type))
}

async function runCorrect(service, args, exec) {
  const type = readString(args, 'type')
  if (!type || !CORRECT_TYPES.includes(type)) {
    throw inputError('validation_failed', `type 必须是 ${CORRECT_TYPES.join(' / ')} 之一`)
  }
  const id = readString(args, 'id')
  if (!id) throw inputError('validation_failed', 'correct 需要 id')
  const action = readString(args, 'action')
  if (!action || !CORRECT_ACTIONS.includes(action)) {
    throw inputError('validation_failed', `action 必须是 ${CORRECT_ACTIONS.join(' / ')} 之一`)
  }
  const patch = args?.patch && typeof args.patch === 'object' && !Array.isArray(args.patch) ? args.patch : undefined
  if (action === 'update' && (!patch || Object.keys(patch).length === 0)) {
    throw inputError('validation_failed', 'action=update 需要非空 patch')
  }
  const reason = readString(args, 'reason')
  const confirm = readBoolean(args, 'confirm') === true

  if (!confirm) {
    let current = null
    if (type === 'task' && typeof service?.getTask === 'function') {
      try {
        current = await service.getTask(id)
      } catch {
        current = null
      }
    }
    const changes = action === 'update'
      ? Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, { before: current?.[key] ?? null, after: value }]))
      : { status: { before: current?.status ?? null, after: 'revoked' } }
    return {
      ok: true,
      needsConfirm: true,
      action: 'correct',
      correctAction: action,
      type,
      id,
      title: current?.title ?? null,
      preview: { type, id, action, changes, reason: reason ?? null },
      message: `纠错/撤回是 L3 操作（需要用户确认）：${action === 'update' ? '修改' : '撤回'}${type} ${id}。请把变更与影响告诉用户；用户明确同意后再次调用并传 confirm:true 才会执行，也可以在面板操作。`,
    }
  }

  requireMethod(service, 'correctDerived')
  const input = { type, id, action }
  if (patch) input.patch = patch
  if (reason) input.reason = reason
  const result = await service.correctDerived(input, buildWriteMeta(exec))
  return {
    ok: true,
    action: 'correct',
    correctAction: action,
    type,
    id,
    reason: reason ?? null,
    affected: normalizeAffected(result),
  }
}

function renderChangesList(changes) {
  const lines = []
  for (const [key, change] of Object.entries(changes ?? {})) {
    if (change && typeof change === 'object' && 'before' in change && 'after' in change) {
      lines.push(`- ${key}：${formatChangeValue(change.before)} → ${formatChangeValue(change.after)}`)
    } else {
      lines.push(`- ${key}：${formatChangeValue(change)}`)
    }
  }
  return lines
}

/** `lifeos_triage` 的 render：批次/候选中文摘要，强调"只提交候选、用户确认前不落事实"。 */
export function renderTriage(_args, value) {
  if (!value || value.ok !== true) {
    const code = value?.error?.code ?? 'internal'
    const message = value?.error?.message ?? ERROR_HINTS.internal
    const hint = value?.error?.hint ?? ERROR_HINTS.internal
    return textBlocks(`整理操作失败（${code}）：${message} ${hint}`)
  }

  if (value.action === 'begin') {
    const lines = [
      `整理批次：${value.runId}｜待抽取原文 ${value.count ?? 0} 条${value.alreadyDone ? '（该 run 已存在，复用）' : ''}`,
    ]
    const batches = asArray(value.batches)
    for (const batch of batches.slice(0, TRIAGE_RENDER_LIMIT)) {
      const date = batch.localDate ? `${batch.localDate}｜` : ''
      lines.push(`- ${batch.rawRecordId}｜${date}${String(batch.text ?? '').slice(0, 60)}`)
    }
    if (batches.length > TRIAGE_RENDER_LIMIT) lines.push(`…另有 ${batches.length - TRIAGE_RENDER_LIMIT} 条`)
    if (asArray(value.candidates).length > 0) {
      const brief = value.candidates.slice(0, TRIAGE_RENDER_LIMIT)
        .map((candidate) => `${TRIAGE_KIND_LABELS[candidate.kind] ?? candidate.kind ?? '?'}${candidate.requiresConfirm ? '（需确认）' : ''}`)
        .join('、')
      lines.push(`规则已预生成候选 ${value.candidates.length} 条：${brief}（可直接展示给用户确认，不要自行落库）`)
    }
    if (value.pendingCount !== null && value.pendingCount !== undefined) lines.push(`待整理总数：${value.pendingCount} 条`)
    lines.push('请逐条抽取候选（只抽原文明确信息），再调用 lifeos_triage(commit, runId, candidates) 提交候选；用户确认前不要声称已创建。')
    return textBlocks(lines.join('\n'))
  }

  if (value.action === 'commit') {
    const lines = [
      `已保存整理候选：${value.saved ?? 0} 条（需用户确认 ${value.needsConfirm ?? 0} 条）｜run ${value.runId}`,
      '候选尚未写入业务表：请让用户在 Inbox 面板逐条确认；确认前不要声称已创建任务/事件。',
    ]
    return textBlocks(lines.join('\n'))
  }

  if (value.action === 'abort') {
    if (value.persisted === true) return textBlocks(`已放弃整理批次：${value.runId}`)
    return textBlocks(`已放弃本次整理（${value.runId}），但服务未持久化：${value.warning ?? 'run 可能悬留'}`)
  }

  return textBlocks(`整理操作完成（${value.action ?? 'unknown'}）`)
}

/** `lifeos_correct` 的 render：L3 预演 → 明确"需要用户确认"；成功 → 影响面。 */
export function renderCorrect(_args, value) {
  if (!value || value.ok !== true) {
    const code = value?.error?.code ?? 'internal'
    const message = value?.error?.message ?? ERROR_HINTS.internal
    const hint = value?.error?.hint ?? ERROR_HINTS.internal
    return textBlocks(`纠错失败（${code}）：${message} ${hint}`)
  }

  if (value.needsConfirm === true) {
    const preview = value.preview ?? {}
    const actionLabel = preview.action === 'revoke' ? '撤回' : '修改'
    const lines = [`需要你确认（纠错：${actionLabel}）${preview.type} ${preview.id}${value.title ? `：「${value.title}」` : ''}`]
    const changes = renderChangesList(preview.changes)
    if (changes.length) lines.push('将要变更：', ...changes)
    if (preview.reason) lines.push(`原因：${preview.reason}`)
    lines.push('确认后我再执行；你也可以直接在 LifeOS 面板里操作。')
    return textBlocks(lines.join('\n'))
  }

  const affected = asArray(value.affected)
  const actionLabel = value.correctAction === 'revoke' ? '撤回' : '更正'
  const lines = [`已${actionLabel} ${value.type} ${value.id}（L3 已确认）`]
  if (affected.length === 0) {
    lines.push('影响：无派生对象需要重算。')
  } else {
    const items = affected.slice(0, CORRECT_RENDER_LIMIT).map((item) => `${item.type ?? '派生'}${item.id ? ` ${item.id}` : ''}`)
    lines.push(`影响 ${affected.length} 项派生：${items.join('、')}${affected.length > CORRECT_RENDER_LIMIT ? ' …' : ''}`)
  }
  return textBlocks(lines.join('\n'))
}

/**
 * `lifeos_triage`：Inbox 整理（M2）。
 * begin 拿原文批次 → 模型抽取候选 → commit 只写候选草稿（不落业务表）→ 用户在面板确认。
 */
export function triageTool(service) {
  return {
    name: 'lifeos_triage',
    description: [
      '整理 LifeOS Inbox：begin 取待整理原文批次，commit 提交你抽取的候选，abort 放弃批次。',
      '何时用：用户说“整理一下今天记的/帮我分类这些随记/昨晚有什么没整理”，或夜间整理会话被调度起来时。',
      '何时不用：用户只是记录（用 lifeos_capture）；用户要直接建任务（用 lifeos_task，且只在用户明确要求时）。',
      '重要：commit 只保存候选、**不写业务事实**；用户确认前不得说“已创建/已记录”。每条候选必须有 source.quote（原文子串）与 start/end；否定表达不产正向事实；承诺/歧义候选 requiresConfirm=true。一次 begin 的原文条数有限（≤20），不要臆测未提供的原文。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: TRIAGE_ACTIONS, description: 'begin 取批次；commit 提交候选；abort 放弃' },
        scope: { type: 'string', enum: TRIAGE_SCOPES, description: 'begin 的取数范围：pending=全部待整理，ids=指定原始记录' },
        ids: { type: 'array', items: { type: 'string' }, description: 'scope=ids 时的原始记录 id 列表' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: TRIAGE_MAX_LIMIT,
          description: `begin 返回的原文条数，默认 ${TRIAGE_DEFAULT_LIMIT}，最大 ${TRIAGE_MAX_LIMIT}`,
        },
        runKey: { type: 'string', description: 'begin 的幂等键（可选；同键重复调用返回同一 run）' },
        runId: { type: 'string', description: 'commit/abort 必填，来自 begin 返回的 runId' },
        candidates: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'commit 的候选数组：{candidateId?, rawRecordId, kind, confidence?, source:{quote,start,end}, fields, reasons?, risks?, requiresConfirm?}',
        },
        reason: { type: 'string', description: 'abort 原因（可选）' },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderTriage },
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action.trim() : ''
      if (!TRIAGE_ACTIONS.includes(action)) {
        return failValue('validation_failed', `action 必须是 ${TRIAGE_ACTIONS.join(' / ')} 之一`)
      }
      try {
        if (action === 'begin') return await runTriageBegin(service, args)
        if (action === 'commit') return await runTriageCommit(service, args)
        return await runTriageAbort(service, args)
      } catch (error) {
        return toFailure(error)
      }
    },
  }
}

/**
 * `lifeos_correct`：纠正/撤回已确认的派生对象（M2）。
 * 始终 L3：先预演 needsConfirm + preview，`confirm:true` 后才调 correctDerived。
 */
export function correctTool(service) {
  return {
    name: 'lifeos_correct',
    description: [
      '纠正或撤回 LifeOS 已确认的派生对象（task/event/metric/habit_checkin），并触发派生统计重算。',
      '何时用：用户说“那条运动记录记错了/步数不是 800 是 8000/这个打卡撤回/任务日期不对”。',
      '何时不用：用户要改任务普通字段（标题/日期等，用 lifeos_task(update)）；用户要删除（M2 不提供删除，撤回用 revoke）。',
      '权限：本工具是 L3——不带 confirm 时只返回 needsConfirm + preview，不执行；用户明确同意后再调用并传 confirm:true。原始记录不可改：纠错只改派生对象并留审计。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: CORRECT_TYPES, description: '要纠错的派生对象类型' },
        id: { type: 'string', description: '派生对象 id' },
        action: { type: 'string', enum: CORRECT_ACTIONS, description: 'update=修改字段；revoke=撤回（软失效）' },
        patch: { type: 'object', additionalProperties: true, description: 'action=update 时的字段补丁（04 字段名）' },
        reason: { type: 'string', description: '纠错原因（写审计，建议用用户原话）' },
        confirm: { type: 'boolean', description: '仅 L3 确认流：上一轮返回 needsConfirm 且用户明确同意后传 true；不要自行传 true' },
      },
      required: ['type', 'id', 'action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderCorrect },
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      try {
        return await runCorrect(service, args, exec)
      } catch (error) {
        return toFailure(error)
      }
    },
  }
}

// ════════════════════════════════════════════════════════════════
// M2.5 · 笔记（notes）
// ════════════════════════════════════════════════════════════════

const NOTES_ACTIONS = ['list', 'read', 'search', 'create', 'append']
/** 单次 read 返回的字符上限（约 8KB 中文；超出截断并提示分段/在面板查看）。 */
const NOTES_READ_LIMIT_CHARS = 8000
const NOTES_DEFAULT_SEARCH_LIMIT = 20
const NOTES_MAX_SEARCH_LIMIT = 50
const NOTES_MAX_DEPTH = 10
const NOTES_MAX_CONTENT_CHARS = 200000
const NOTES_MAX_PATH_CHARS = 500
const NOTES_LIST_RENDER_LIMIT = 12
const NOTES_SEARCH_RENDER_LIMIT = 8
const NOTES_MAX_ENTRIES = 200

/** notes 操作的错误提示覆盖（conflict 在任务工具里是 rev 语义，笔记里是外部改动）。 */
function toNotesFailure(error) {
  const failure = toFailure(error, 'internal', NOTES_ERROR_HINTS)
  const code = failure?.error?.code
  if (code === 'conflict') {
    failure.error.hint = '笔记文件已被外部修改：先重新 read 最新内容，再决定 append 还是让用户在笔记 tab 里保留哪一份。'
  }
  return failure
}

/** 找 notes 服务：优先 ctx.lifeos.notes，兼容 noteService / getNotes()（挂接名待 B 最终确认）。 */
function resolveNotes(service) {
  const direct = [service?.notes, service?.noteService]
  for (const candidate of direct) {
    if (candidate && typeof candidate === 'object') return candidate
  }
  if (typeof service?.getNotes === 'function') {
    try {
      const notes = service.getNotes()
      if (notes && typeof notes === 'object') return notes
    } catch {
      /* 回退不到就按未就绪处理 */
    }
  }
  return null
}

function requireNotes(service) {
  const notes = resolveNotes(service)
  if (!notes) throw inputError('notes_unavailable', 'ctx.lifeos.notes 未挂接（Host 尚未提供笔记服务）')
  return notes
}

/** 目录配置检查：未配置/不可写给出明确中文提示，而不是让后续 fs 操作报错。 */
async function assertNotesConfigured(notes) {
  if (typeof notes.getConfig !== 'function') return null
  let config
  try {
    config = await notes.getConfig()
  } catch {
    return null
  }
  if (!config || typeof config !== 'object') return null
  const dir = typeof config.dir === 'string' ? config.dir.trim() : ''
  if (!dir || config.exists === false) {
    throw inputError('notes_dir_unconfigured', 'notes.dir 未配置或目录不存在')
  }
  if (config.writable === false) throw inputError('notes_dir_readonly', `notes.dir 不可写：${dir}`)
  return { dir, config }
}

function requireNotePath(args) {
  const path = readString(args, 'path')
  if (!path) throw inputError('validation_failed', '该 action 需要 path（笔记目录内的相对路径，如 "日记/2026-11-13.md"）')
  if (path.length > NOTES_MAX_PATH_CHARS) throw inputError('validation_failed', `path 超过 ${NOTES_MAX_PATH_CHARS} 字符`)
  return path
}

function normalizeNoteEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const path = firstString(entry.path)
  const name = firstString(entry.name, path ? path.split(/[\\/]/).pop() : null)
  if (!path || !name) return null
  return {
    name,
    path,
    type: entry.type === 'dir' ? 'dir' : 'file',
    size: pickNumber(entry.size),
    mtime: firstString(entry.mtime),
    editable: entry.editable !== false,
  }
}

function normalizeSearchItem(item) {
  if (!item || typeof item !== 'object') return null
  const path = firstString(item.path)
  if (!path) return null
  return {
    path,
    title: firstString(item.title) ?? null,
    snippet: firstString(item.snippet) ?? null,
    mtime: firstString(item.mtime) ?? null,
  }
}

function formatBytes(size) {
  if (!isFiniteNumber(size) || size < 0) return null
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`
  return `${(size / 1024 / 1024).toFixed(1)}MB`
}

async function runNotesList(notes, args) {
  requireMethod(notes, 'list')
  const configured = await assertNotesConfigured(notes)
  let dir = readString(args, 'dir')
  // list 的根目录：模型常传 "." 或 "./"，统一视为“不传 dir”（避免 path 不能为空）。
  if (dir === '.' || dir === './') dir = undefined
  const depth = readPositiveInt(args, 'depth', NOTES_MAX_DEPTH)
  const input = {}
  if (dir !== undefined) input.dir = dir
  if (depth !== undefined) input.depth = depth
  const result = await notes.list(input)
  const entries = asArray(result?.entries).map(normalizeNoteEntry).filter(Boolean)
  return {
    ok: true,
    action: 'list',
    dir: dir ?? configured?.dir ?? null,
    count: entries.length,
    entries: entries.slice(0, NOTES_MAX_ENTRIES),
    truncated: entries.length > NOTES_MAX_ENTRIES,
  }
}

async function runNotesRead(notes, args) {
  requireMethod(notes, 'read')
  await assertNotesConfigured(notes)
  const path = requireNotePath(args)
  const result = await notes.read({ path })
  const content = typeof result?.content === 'string' ? result.content : ''
  const truncated = content.length > NOTES_READ_LIMIT_CHARS
  return {
    ok: true,
    action: 'read',
    path: firstString(result?.path) ?? path,
    content: truncated ? content.slice(0, NOTES_READ_LIMIT_CHARS) : content,
    truncated,
    totalChars: content.length,
    size: pickNumber(result?.size),
    mtime: firstString(result?.mtime),
    hash: firstString(result?.hash),
    encoding: firstString(result?.encoding) ?? 'utf-8',
  }
}

async function runNotesSearch(notes, args) {
  requireMethod(notes, 'search')
  await assertNotesConfigured(notes)
  const q = readString(args, 'q')
  if (!q) throw inputError('validation_failed', 'search 需要 q（关键词）')
  const limit = readPositiveInt(args, 'limit', NOTES_MAX_SEARCH_LIMIT) ?? NOTES_DEFAULT_SEARCH_LIMIT
  const result = await notes.search({ q, limit })
  const items = asArray(result?.items).map(normalizeSearchItem).filter(Boolean).slice(0, limit)
  return { ok: true, action: 'search', q, count: items.length, items }
}

async function runNotesCreate(notes, args) {
  const path = requireNotePath(args)
  const content = typeof args?.content === 'string' ? args.content : ''
  if (content.length > NOTES_MAX_CONTENT_CHARS) {
    throw inputError('validation_failed', `content 最多 ${NOTES_MAX_CONTENT_CHARS} 字；请拆分或让用户在笔记 tab 里编辑`)
  }
  await assertNotesConfigured(notes)
  let result
  if (typeof notes.create === 'function') {
    result = await notes.create({ path, content })
  } else if (typeof notes.write === 'function') {
    result = await notes.write({ path, content, create: true })
  } else {
    throw inputError('internal', 'notes 服务未提供 create()/write()，无法新建笔记')
  }
  return {
    ok: true,
    action: 'create',
    path: firstString(result?.path) ?? path,
    chars: content.length,
    size: pickNumber(result?.size),
    mtime: firstString(result?.mtime),
    hash: firstString(result?.hash),
  }
}

async function runNotesAppend(notes, args) {
  const path = requireNotePath(args)
  const addition = typeof args?.content === 'string' ? args.content : ''
  if (!addition) throw inputError('validation_failed', 'append 需要非空 content')
  if (addition.length > NOTES_MAX_CONTENT_CHARS) {
    throw inputError('validation_failed', `content 最多 ${NOTES_MAX_CONTENT_CHARS} 字；请拆分后分次追加`)
  }
  await assertNotesConfigured(notes)

  if (typeof notes.append === 'function') {
    const result = await notes.append({ path, content: addition })
    return {
      ok: true,
      action: 'append',
      path: firstString(result?.path) ?? path,
      appendedChars: addition.length,
      totalChars: pickNumber(result?.totalChars, result?.chars),
      mtime: firstString(result?.mtime),
      hash: firstString(result?.hash),
    }
  }

  // 服务没有 append 时用 read + write(baseHash) 实现"追加不覆盖"，并保留冲突检测。
  requireMethod(notes, 'read')
  requireMethod(notes, 'write')
  const current = await notes.read({ path })
  if (!current || typeof current.content !== 'string') {
    throw inputError('not_found', `笔记不存在：${path}（新建请用 create）`)
  }
  const base = current.content
  const separator = base.length > 0 && !base.endsWith('\n') ? '\n' : ''
  const next = `${base}${separator}${addition}`
  const result = await notes.write({ path, content: next, baseHash: firstString(current.hash) ?? undefined })
  return {
    ok: true,
    action: 'append',
    path: firstString(result?.path) ?? path,
    appendedChars: addition.length,
    totalChars: next.length,
    mtime: firstString(result?.mtime),
    hash: firstString(result?.hash),
  }
}

/** `lifeos_notes` 的 render：目录/全文/搜索/写入结果都给可转述的中文。 */
export function renderNotes(_args, value) {
  if (!value || value.ok !== true) {
    const code = value?.error?.code ?? 'internal'
    const message = value?.error?.message ?? ERROR_HINTS.internal
    const hint = value?.error?.hint ?? ERROR_HINTS.internal
    return textBlocks(`笔记操作失败（${code}）：${message} ${hint}`)
  }

  if (value.action === 'list') {
    const entries = asArray(value.entries)
    const lines = [`笔记（${value.dir ?? '根目录'}）：${value.count ?? entries.length} 项`]
    if (entries.length === 0) {
      lines.push('暂无笔记（目录里还没有 md/txt 文件，可用 create 新建）')
    } else {
      for (const entry of entries.slice(0, NOTES_LIST_RENDER_LIMIT)) {
        if (entry.type === 'dir') {
          lines.push(`- 📁 ${entry.name}/`)
        } else {
          const size = formatBytes(entry.size)
          const mtime = entry.mtime ? `｜${entry.mtime}` : ''
          lines.push(`- ${entry.name}${size ? `｜${size}` : ''}${mtime}${entry.editable === false ? '（不可编辑）' : ''}`)
        }
      }
      if (entries.length > NOTES_LIST_RENDER_LIMIT) lines.push(`…另有 ${entries.length - NOTES_LIST_RENDER_LIMIT} 项`)
    }
    return textBlocks(lines.join('\n'))
  }

  if (value.action === 'read') {
    const header = `笔记：${value.path}｜${value.totalChars ?? 0} 字${value.truncated ? '（已截断）' : ''}`
    const blocks = [header, '', value.content ?? '']
    if (value.truncated) {
      const size = formatBytes(value.size)
      blocks.push(
        '',
        `…（已截断：原文 ${value.totalChars ?? '?'} 字${size ? `，约 ${size}` : ''}；这里只显示前 ${NOTES_READ_LIMIT_CHARS} 字。需要全文请让用户在笔记 tab 打开，或让 ta 指定更小范围后再读。）`,
      )
    }
    return textBlocks(blocks.join('\n'))
  }

  if (value.action === 'search') {
    const items = asArray(value.items)
    const lines = [`搜索「${value.q}」：${value.count ?? items.length} 条`]
    if (items.length === 0) {
      lines.push('没有匹配的笔记。')
    } else {
      for (const item of items.slice(0, NOTES_SEARCH_RENDER_LIMIT)) {
        const snippet = item.snippet ? `｜${String(item.snippet).slice(0, 80)}` : ''
        lines.push(`- ${item.title ? `${item.title}（${item.path}）` : item.path}${snippet}`)
      }
      if (items.length > NOTES_SEARCH_RENDER_LIMIT) lines.push(`…另有 ${items.length - NOTES_SEARCH_RENDER_LIMIT} 条`)
    }
    return textBlocks(lines.join('\n'))
  }

  if (value.action === 'create') {
    return textBlocks(`已创建笔记：${value.path}（${value.chars ?? 0} 字）`)
  }

  if (value.action === 'append') {
    const total = value.totalChars ? `，共 ${value.totalChars} 字` : ''
    return textBlocks(`已追加到笔记：${value.path}（+${value.appendedChars ?? 0} 字${total}）`)
  }

  return textBlocks(`笔记操作完成（${value.action ?? 'unknown'}）`)
}

/**
 * `lifeos_notes`：本地 Markdown 笔记（M2.5）。
 * 读 L1、写 L2（create/append 低风险自动执行，无需确认）；只在用户配置的笔记目录内操作。
 */
export function notesTool(service) {
  return {
    name: 'lifeos_notes',
    description: [
      '读写用户的本地 Markdown 笔记（配置的笔记目录内）：list 列目录、read 读原文、search 搜索、create 新建、append 追加。',
      '何时用：用户说“帮我看看我笔记里关于 X 的”“把这段写到今天的日记里”“在项目笔记末尾追加一条”“新建一个 XX 笔记”。',
      '何时不用：用户只是随口记录（用 lifeos_capture）；用户要改任务/习惯（用对应工具）；用户要删除/改名/移动笔记（M2.5 Agent 不提供，让用户在笔记 tab 操作）。',
      '重要：只在笔记目录内操作；list 用 dir（可选，省略或 "." 都是根目录，不要用 path）；read/create/append 用 path（相对笔记目录且带文件名，如 "日记/2026-11-13.md"），两个参数不要混用；**不覆盖用户原文**——补充内容优先 append；create/append 后必须回显完整路径；read 单次最多返回约 8KB，超出会截断（提示用户在笔记 tab 查看全文）；未配置笔记目录时会提示先设置。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: NOTES_ACTIONS, description: 'list/read/search 只读；create/append 写入（L2）' },
        dir: { type: 'string', description: 'list 时的子目录（相对笔记根目录；省略=根目录）' },
        depth: {
          type: 'integer',
          minimum: 1,
          maximum: NOTES_MAX_DEPTH,
          description: `list 的递归深度（默认 1，最大 ${NOTES_MAX_DEPTH}）`,
        },
        path: { type: 'string', description: 'read/create/append 的笔记路径（笔记目录内相对路径，如 "日记/2026-11-13.md"）' },
        q: { type: 'string', description: 'search 关键词（匹配文件名与正文）' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: NOTES_MAX_SEARCH_LIMIT,
          description: `search 返回条数，默认 ${NOTES_DEFAULT_SEARCH_LIMIT}，最大 ${NOTES_MAX_SEARCH_LIMIT}`,
        },
        content: { type: 'string', description: 'create/append 的 Markdown 内容（append 只追加，不覆盖原文）' },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderNotes },
    timeoutMs: 20_000,
    isConcurrencySafe: (args) => ['list', 'read', 'search'].includes(args?.action),
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action.trim() : ''
      if (!NOTES_ACTIONS.includes(action)) {
        return failValue('validation_failed', `action 必须是 ${NOTES_ACTIONS.join(' / ')} 之一`)
      }
      try {
        const notes = requireNotes(service)
        if (action === 'list') return await runNotesList(notes, args)
        if (action === 'read') return await runNotesRead(notes, args)
        if (action === 'search') return await runNotesSearch(notes, args)
        if (action === 'create') return await runNotesCreate(notes, args)
        return await runNotesAppend(notes, args)
      } catch (error) {
        return toNotesFailure(error)
      }
    },
  }
}

// ════════════════════════════════════════════════════════════════
// M3 · 设置元能力（settings）
// ════════════════════════════════════════════════════════════════

const SETTINGS_ACTIONS = ['get', 'set']
const SETTINGS_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const SETTINGS_MAX_WAIT = 600
const SETTINGS_TOP_KEYS = [
  'morningBrief',
  'eveningReview',
  'habitNudge',
  'nightlyInbox',
  'deadlineReminder',
  'dnd',
  'dailyBudget',
  'suggestions',
  'dndPolicy',
]
const SETTINGS_ROUTINE_LABELS = {
  morningBrief: '晨间简报',
  eveningReview: '晚报',
  habitNudge: '习惯追问',
  nightlyInbox: '夜间整理',
}
const SETTINGS_ROUTINE_KEYS = ['morningBrief', 'eveningReview', 'habitNudge', 'nightlyInbox']

/** M3-PLAN §1 默认设置；get 时用来补齐缺失字段。 */
const SETTINGS_DEFAULTS = {
  morningBrief: { enabled: true, time: '07:35' },
  eveningReview: { enabled: false, time: '21:00' },
  habitNudge: { enabled: false, time: '20:30' },
  nightlyInbox: { enabled: true, time: '21:30' },
  deadlineReminder: { enabled: true, leadMinutes: 60, dueDateAt: '09:00' },
  dnd: { start: '22:45', end: '07:30' },
  dailyBudget: 2,
  suggestions: { enabled: true, maxPerDay: 2 },
  dndPolicy: 'skip',
}

function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function timeOr(value, fallback) {
  return typeof value === 'string' && SETTINGS_TIME_RE.test(value) ? value : fallback
}

function inDnd(time, dnd) {
  if (!SETTINGS_TIME_RE.test(time) || !dnd || !SETTINGS_TIME_RE.test(dnd.start) || !SETTINGS_TIME_RE.test(dnd.end)) {
    return false
  }
  if (dnd.start === dnd.end) return false
  return dnd.start < dnd.end ? time >= dnd.start && time < dnd.end : time >= dnd.start || time < dnd.end
}

function mergeSettingsGroup(current, patch) {
  const next = {}
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
  for (const [key, value] of Object.entries(base)) next[key] = value
  for (const [key, value] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      next[key] = { ...(next[key] && typeof next[key] === 'object' ? next[key] : {}), ...value }
    } else {
      next[key] = value
    }
  }
  return next
}

/** 合并默认值 + 当前值（get 与 set 预览都用同一口径，避免"预览和实际不一致"）。 */
function withSettingsDefaults(settings) {
  const source = settings && typeof settings === 'object' ? settings : {}
  const merged = {
    morningBrief: { ...SETTINGS_DEFAULTS.morningBrief, ...(source.morningBrief ?? {}) },
    eveningReview: { ...SETTINGS_DEFAULTS.eveningReview, ...(source.eveningReview ?? {}) },
    habitNudge: { ...SETTINGS_DEFAULTS.habitNudge, ...(source.habitNudge ?? {}) },
    nightlyInbox: { ...SETTINGS_DEFAULTS.nightlyInbox, ...(source.nightlyInbox ?? {}) },
    deadlineReminder: { ...SETTINGS_DEFAULTS.deadlineReminder, ...(source.deadlineReminder ?? {}) },
    dnd: { ...SETTINGS_DEFAULTS.dnd, ...(source.dnd ?? {}) },
    suggestions: { ...SETTINGS_DEFAULTS.suggestions, ...(source.suggestions ?? {}) },
    dailyBudget: isFiniteNumber(source.dailyBudget) ? source.dailyBudget : SETTINGS_DEFAULTS.dailyBudget,
    dndPolicy: source.dndPolicy === 'defer' ? 'defer' : 'skip',
  }
  return merged
}

function normalizeAutomationSettings(settings) {
  const merged = withSettingsDefaults(settings)
  return {
    morningBrief: {
      enabled: boolOr(merged.morningBrief.enabled, SETTINGS_DEFAULTS.morningBrief.enabled),
      time: timeOr(merged.morningBrief.time, SETTINGS_DEFAULTS.morningBrief.time),
    },
    eveningReview: {
      enabled: boolOr(merged.eveningReview.enabled, SETTINGS_DEFAULTS.eveningReview.enabled),
      time: timeOr(merged.eveningReview.time, SETTINGS_DEFAULTS.eveningReview.time),
    },
    habitNudge: {
      enabled: boolOr(merged.habitNudge.enabled, SETTINGS_DEFAULTS.habitNudge.enabled),
      time: timeOr(merged.habitNudge.time, SETTINGS_DEFAULTS.habitNudge.time),
    },
    nightlyInbox: {
      enabled: boolOr(merged.nightlyInbox.enabled, SETTINGS_DEFAULTS.nightlyInbox.enabled),
      time: timeOr(merged.nightlyInbox.time, SETTINGS_DEFAULTS.nightlyInbox.time),
    },
    deadlineReminder: {
      enabled: boolOr(merged.deadlineReminder.enabled, SETTINGS_DEFAULTS.deadlineReminder.enabled),
      leadMinutes: isFiniteNumber(merged.deadlineReminder.leadMinutes)
        ? merged.deadlineReminder.leadMinutes
        : SETTINGS_DEFAULTS.deadlineReminder.leadMinutes,
      dueDateAt: timeOr(merged.deadlineReminder.dueDateAt, SETTINGS_DEFAULTS.deadlineReminder.dueDateAt),
    },
    dnd: {
      start: timeOr(merged.dnd.start, SETTINGS_DEFAULTS.dnd.start),
      end: timeOr(merged.dnd.end, SETTINGS_DEFAULTS.dnd.end),
    },
    dailyBudget: isFiniteNumber(merged.dailyBudget) ? merged.dailyBudget : SETTINGS_DEFAULTS.dailyBudget,
    suggestions: {
      enabled: boolOr(merged.suggestions.enabled, SETTINGS_DEFAULTS.suggestions.enabled),
      maxPerDay: isFiniteNumber(merged.suggestions.maxPerDay)
        ? merged.suggestions.maxPerDay
        : SETTINGS_DEFAULTS.suggestions.maxPerDay,
    },
    dndPolicy: merged.dndPolicy === 'defer' ? 'defer' : 'skip',
  }
}

/** 找 automation 服务：M3 优先 ctx.lifeos.automation；M2 旧接口降级为只读。 */
function resolveAutomation(service) {
  if (service?.automation && typeof service.automation === 'object') {
    return { automation: service.automation, via: 'named' }
  }
  if (typeof service?.getAutomation === 'function' || typeof service?.setAutomation === 'function') {
    return {
      automation: {
        getSettings: typeof service.getAutomation === 'function' ? () => service.getAutomation() : undefined,
      },
      via: 'legacy',
    }
  }
  return null
}

async function readAutomationSettings(resolved) {
  const automation = resolved.automation
  const getter = pickMethodName(automation, ['getSettings', 'get', 'read'])
  if (!getter) throw inputError('automation_unavailable', 'automation 服务未提供 getSettings()')
  const result = await automation[getter]()
  if (resolved.via === 'legacy') {
    // M2 旧接口只返回夜间整理 {enabled,time}：映射成统一结构并标记降级。
    const legacy = result && typeof result === 'object' ? result : {}
    return {
      settings: normalizeAutomationSettings({
        nightlyInbox: {
          enabled: boolOr(legacy.enabled, legacy.nightlyInbox?.enabled),
          time: legacy.time,
        },
      }),
      raw: legacy,
      revision: pickNumber(legacy.revision),
      legacy: true,
    }
  }
  const raw = result?.settings ?? result?.automation ?? result ?? {}
  return {
    settings: normalizeAutomationSettings(raw),
    raw,
    revision: pickNumber(result?.revision, raw?.revision),
    legacy: false,
  }
}

function requireSettingsTime(value, field) {
  if (typeof value !== 'string' || !SETTINGS_TIME_RE.test(value)) {
    throw inputError('invalid_time', `${field} 必须是 HH:mm（00:00–23:59）`)
  }
  return value
}

function normalizeRoutineSetting(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw inputError('validation_failed', `${key} 必须是对象（如 {"enabled":true,"time":"07:35"}）`)
  }
  const out = {}
  for (const sub of Object.keys(value)) {
    if (!['enabled', 'time'].includes(sub)) {
      throw inputError('validation_failed', `${key}.${sub} 不是可改字段（只支持 enabled/time）`)
    }
  }
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') throw inputError('validation_failed', `${key}.enabled 必须是布尔值`)
    out.enabled = value.enabled
  }
  if (value.time !== undefined) out.time = requireSettingsTime(value.time, `${key}.time`)
  return out
}

function normalizeDeadlineReminder(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw inputError('validation_failed', 'deadlineReminder 必须是对象')
  }
  const out = {}
  for (const sub of Object.keys(value)) {
    if (!['enabled', 'leadMinutes', 'dueDateAt'].includes(sub)) {
      throw inputError('validation_failed', `deadlineReminder.${sub} 不是可改字段（enabled/leadMinutes/dueDateAt）`)
    }
  }
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') throw inputError('validation_failed', 'deadlineReminder.enabled 必须是布尔值')
    out.enabled = value.enabled
  }
  if (value.leadMinutes !== undefined) {
    if (!Number.isInteger(value.leadMinutes) || value.leadMinutes < 5 || value.leadMinutes > 1440) {
      throw inputError('validation_failed', 'deadlineReminder.leadMinutes 必须是 5–1440 分钟的整数')
    }
    out.leadMinutes = value.leadMinutes
  }
  if (value.dueDateAt !== undefined) out.dueDateAt = requireSettingsTime(value.dueDateAt, 'deadlineReminder.dueDateAt')
  return out
}

function normalizeSuggestions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw inputError('validation_failed', 'suggestions 必须是对象')
  }
  const out = {}
  for (const sub of Object.keys(value)) {
    if (!['enabled', 'maxPerDay'].includes(sub)) {
      throw inputError('validation_failed', `suggestions.${sub} 不是可改字段（enabled/maxPerDay）`)
    }
  }
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') throw inputError('validation_failed', 'suggestions.enabled 必须是布尔值')
    out.enabled = value.enabled
  }
  if (value.maxPerDay !== undefined) {
    if (!Number.isInteger(value.maxPerDay) || value.maxPerDay < 0 || value.maxPerDay > 10) {
      throw inputError('validation_failed', 'suggestions.maxPerDay 必须是 0–10 的整数')
    }
    out.maxPerDay = value.maxPerDay
  }
  return out
}

/** 硬边界校验（服务端仍会再校验一次；这里负责给出可读中文与预演）。 */
function normalizeSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw inputError('validation_failed', 'set 需要 patch 对象，例如 {"dailyBudget":1} 或 {"morningBrief":{"time":"08:00"}}')
  }
  const keys = Object.keys(patch)
  if (keys.length === 0) throw inputError('validation_failed', 'patch 不能为空；请给出要改的设置项')
  const normalized = {}
  for (const key of keys) {
    const value = patch[key]
    if (!SETTINGS_TOP_KEYS.includes(key)) throw inputError('unknown_field', `不认识的设置项：${key}`)
    if (SETTINGS_ROUTINE_KEYS.includes(key)) {
      normalized[key] = normalizeRoutineSetting(key, value)
      continue
    }
    if (key === 'dnd') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw inputError('validation_failed', 'dnd 必须是对象（如 {"start":"23:00","end":"07:30"}）')
      }
      const dnd = {}
      for (const sub of Object.keys(value)) {
        if (!['start', 'end'].includes(sub)) throw inputError('validation_failed', `dnd.${sub} 不是可改字段（start/end）`)
      }
      if (value.start !== undefined) dnd.start = requireSettingsTime(value.start, 'dnd.start')
      if (value.end !== undefined) dnd.end = requireSettingsTime(value.end, 'dnd.end')
      const merged = { ...SETTINGS_DEFAULTS.dnd, ...dnd }
      if (merged.start === merged.end) throw inputError('dnd_invalid', '免打扰不能覆盖全天（开始与结束时间不能相同）')
      normalized.dnd = dnd
      continue
    }
    if (key === 'deadlineReminder') {
      normalized.deadlineReminder = normalizeDeadlineReminder(value)
      continue
    }
    if (key === 'suggestions') {
      normalized.suggestions = normalizeSuggestions(value)
      continue
    }
    if (key === 'dailyBudget') {
      if (!Number.isInteger(value) || value < 0 || value > 5) {
        throw inputError('budget_out_of_range', '每日主动消息预算必须是 0–5 的整数')
      }
      normalized.dailyBudget = value
      continue
    }
    if (key === 'dndPolicy') {
      if (value !== 'skip' && value !== 'defer') throw inputError('validation_failed', 'dndPolicy 只能是 skip 或 defer')
      normalized.dndPolicy = value
      continue
    }
  }
  return normalized
}

/** 交叉校验：已开启 routine 的时间不能落在免打扰窗口内（否则会被静默跳过）。 */
function findDndConflicts(settings) {
  const conflicts = []
  const dnd = settings?.dnd
  if (!dnd || !SETTINGS_TIME_RE.test(dnd.start) || !SETTINGS_TIME_RE.test(dnd.end) || dnd.start === dnd.end) return conflicts
  for (const key of SETTINGS_ROUTINE_KEYS) {
    const entry = settings?.[key]
    if (!entry || entry.enabled === false) continue
    if (SETTINGS_TIME_RE.test(entry.time) && inDnd(entry.time, dnd)) {
      conflicts.push(`${SETTINGS_ROUTINE_LABELS[key]}时间 ${entry.time} 落在免打扰 ${dnd.start}–${dnd.end} 内，会被静默跳过`)
    }
  }
  return conflicts
}

function buildSettingsDiff(patch, currentSettings) {
  const before = normalizeAutomationSettings(currentSettings)
  const after = normalizeAutomationSettings(mergeSettingsGroup(before, patch))
  const diff = []
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const sub of Object.keys(value)) {
        diff.push({ path: `${key}.${sub}`, before: before[key]?.[sub] ?? null, after: after[key]?.[sub] ?? null })
      }
    } else {
      diff.push({ path: key, before: before[key] ?? null, after: after[key] ?? null })
    }
  }
  return { diff: diff.filter((change) => JSON.stringify(change.before) !== JSON.stringify(change.after)), before, after }
}

/** 把 diff 翻成用户能看懂的影响面（预演确认时展示）。 */
function describeSettingsImpacts(diff, after) {
  const impacts = []
  const touched = new Set(diff.map((change) => change.path))
  for (const key of SETTINGS_ROUTINE_KEYS) {
    const label = SETTINGS_ROUTINE_LABELS[key]
    if (touched.has(`${key}.enabled`)) {
      impacts.push(
        after[key].enabled
          ? `将开启${label}定时任务（每天 ${after[key].time} 一次主动消息）`
          : `将关闭${label}定时任务`,
      )
    }
    if (touched.has(`${key}.time`)) impacts.push(`将把${label}时间改为 ${after[key].time}`)
  }
  if (touched.has('deadlineReminder.enabled')) {
    impacts.push(after.deadlineReminder.enabled ? '将开启任务截止提醒' : '将关闭任务截止提醒')
  }
  if (touched.has('deadlineReminder.leadMinutes')) {
    impacts.push(`截止提醒提前量改为 ${after.deadlineReminder.leadMinutes} 分钟`)
  }
  if (touched.has('deadlineReminder.dueDateAt')) {
    impacts.push(`仅日期任务的提醒时间改为 ${after.deadlineReminder.dueDateAt}`)
  }
  if (touched.has('dnd.start') || touched.has('dnd.end')) {
    impacts.push(`将把免打扰改为 ${after.dnd.start}–${after.dnd.end}`)
  }
  if (touched.has('dailyBudget')) impacts.push(`每日主动消息上限改为 ${after.dailyBudget} 条`)
  if (touched.has('suggestions.enabled')) {
    impacts.push(after.suggestions.enabled ? '将开启今日建议卡' : '将关闭今日建议卡')
  }
  if (touched.has('suggestions.maxPerDay')) impacts.push(`建议卡每天最多显示 ${after.suggestions.maxPerDay} 条`)
  if (touched.has('dndPolicy')) {
    impacts.push(after.dndPolicy === 'defer' ? '静默时段内到点的提醒将延后发送' : '静默时段内到点的提醒将被跳过')
  }
  const enabledRoutines = SETTINGS_ROUTINE_KEYS.filter((key) => after[key]?.enabled).length
  if (enabledRoutines > after.dailyBudget) {
    impacts.push(`注意：已开启 ${enabledRoutines} 个定时 routine，但每日预算只有 ${after.dailyBudget} 条，部分消息会被静默跳过`)
  }
  return impacts
}

function normalizeImpacted(impacted) {
  const labels = {
    morningBrief: '晨间简报',
    eveningReview: '晚报',
    habitNudge: '习惯追问',
    nightlyInbox: '夜间整理',
    deadlineReminder: '截止提醒',
    dnd: '免打扰',
    dailyBudget: '每日预算',
    suggestions: '建议卡',
    dndPolicy: '静默策略',
  }
  const list = Array.isArray(impacted) ? impacted : []
  return list
    .map((item) => {
      if (typeof item === 'string') return { kind: null, id: labels[item] ?? item, action: null }
      if (!item || typeof item !== 'object') return null
      return {
        kind: firstString(item.kind, item.type, item.routine) ?? null,
        id: firstString(item.id, item.scheduleId, item.key) ?? null,
        action: firstString(item.action, item.status) ?? null,
      }
    })
    .filter(Boolean)
}

function toSettingsFailure(error) {
  const failure = toFailure(error)
  const code = failure?.error?.code
  if (code === 'validation_failed') {
    const message = String(failure.error.message ?? '')
    // 只做窄匹配：避免把 "dailyBudget" / "enabled/time" 这类字段名误判成预算/时间错误。
    if (/预算/.test(message)) {
      failure.error.code = 'budget_out_of_range'
      failure.error.hint = ERROR_HINTS.budget_out_of_range
    } else if (/免打扰|静默时段/.test(message)) {
      failure.error.code = 'dnd_invalid'
      failure.error.hint = ERROR_HINTS.dnd_invalid
    } else if (/时间|HH:mm/.test(message)) {
      failure.error.code = 'invalid_time'
      failure.error.hint = ERROR_HINTS.invalid_time
    }
  }
  return failure
}

async function runSettingsGet(service) {
  const resolved = resolveAutomation(service)
  if (!resolved) throw inputError('automation_unavailable', 'Host 未挂接 ctx.lifeos.automation')
  const read = await readAutomationSettings(resolved)
  return {
    ok: true,
    action: 'get',
    settings: read.settings,
    revision: read.revision,
    legacy: read.legacy,
    degraded: read.legacy,
    note: read.legacy ? 'M3 自动化服务未就绪，当前只显示夜间整理设置（旧接口）' : null,
  }
}

async function runSettingsSet(service, args, exec) {
  const resolved = resolveAutomation(service)
  if (!resolved) throw inputError('automation_unavailable', 'Host 未挂接 ctx.lifeos.automation')
  if (resolved.via !== 'named') {
    throw inputError(
      'automation_unavailable',
      '当前只有 M2 旧接口（getAutomation/setAutomation），不能安全预演和修改完整设置；需要 M3 的 ctx.lifeos.automation.patchSettings',
    )
  }

  const patch = normalizeSettingsPatch(args?.patch)
  const current = await readAutomationSettings(resolved)
  const { diff, before, after } = buildSettingsDiff(patch, current.settings)

  if (diff.length === 0) {
    return {
      ok: true,
      action: 'set',
      noChange: true,
      diff: [],
      impacts: [],
      settings: before,
      message: '设置没有变化（当前值已经是你要求的）',
    }
  }

  const conflicts = findDndConflicts(after)
  if (conflicts.length > 0) throw inputError('dnd_conflict', conflicts[0])

  const impacts = describeSettingsImpacts(diff, after)
  const confirm = readBoolean(args, 'confirm') === true
  if (!confirm) {
    return {
      ok: true,
      needsConfirm: true,
      action: 'set',
      diff,
      impacts,
      patch,
      settings: before,
      message: `这是 L3 设置变更（会改变我以后主动找你的方式）：${impacts.join('；')}。请把变更与影响告诉用户；用户明确同意后再次调用并传 confirm:true 才会执行。`,
    }
  }

  const patchFn = pickMethodName(resolved.automation, ['patchSettings', 'patch', 'setSettings', 'updateSettings'])
  if (!patchFn) throw inputError('automation_unavailable', 'automation 服务未提供 patchSettings()')
  const meta = buildWriteMeta(exec)
  // A 的 patchSettings(patch, options) 支持 {source, actorSessionId, reason} 写审计（M3 §5）。
  const writeOptions = {
    source: meta.actor === 'agent' ? 'agent' : 'user',
    ...(meta.sessionId ? { actorSessionId: meta.sessionId } : {}),
    reason: '用户在会话中要求修改自动化设置',
  }
  const result = await resolved.automation[patchFn](patch, writeOptions)
  if (result && result.ok === false) {
    const failure = toSettingsFailure(Object.assign(new Error(result.error?.message ?? 'patchSettings 失败'), { code: result.error?.code ?? 'internal' }))
    return failure
  }
  const nextSettings = normalizeAutomationSettings(result?.settings ?? result?.automation ?? mergeSettingsGroup(before, patch))
  return {
    ok: true,
    action: 'set',
    applied: true,
    diff,
    impacts,
    settings: nextSettings,
    impacted: normalizeImpacted(result?.impacted ?? result?.schedules ?? result?.impactedSchedules),
    revision: pickNumber(result?.revision),
  }
}

function renderSettingsSummary(settings) {
  const lines = []
  for (const key of SETTINGS_ROUTINE_KEYS) {
    const entry = settings[key]
    lines.push(`- ${SETTINGS_ROUTINE_LABELS[key]}：${entry.enabled ? '开' : '关'} ${entry.time}`)
  }
  const deadline = settings.deadlineReminder
  lines.push(
    deadline.enabled
      ? `- 截止提醒：开（提前 ${deadline.leadMinutes} 分钟；仅日期任务 ${deadline.dueDateAt}）`
      : '- 截止提醒：关',
  )
  lines.push(`- 免打扰：${settings.dnd.start}–${settings.dnd.end}（静默期${settings.dndPolicy === 'defer' ? '延后' : '跳过'}）`)
  lines.push(`- 每日主动消息上限：${settings.dailyBudget} 条`)
  lines.push(`- 建议卡：${settings.suggestions.enabled ? '开' : '关'}，每天最多 ${settings.suggestions.maxPerDay} 条`)
  return lines
}

/** `lifeos_settings` 的 render：设置摘要 / L3 预演 / 执行结果 / 失败。 */
export function renderSettings(_args, value) {
  if (!value || value.ok !== true) {
    const code = value?.error?.code ?? 'internal'
    const message = value?.error?.message ?? ERROR_HINTS.internal
    const hint = value?.error?.hint ?? ERROR_HINTS.internal
    return textBlocks(`设置操作失败（${code}）：${message} ${hint}`)
  }

  if (value.action === 'get') {
    const lines = ['当前自动化设置：', ...renderSettingsSummary(value.settings)]
    if (value.degraded) lines.push(`⚠️ ${value.note ?? '当前为降级只读视图'}`)
    return textBlocks(lines.join('\n'))
  }

  if (value.noChange) return textBlocks(value.message ?? '设置没有变化')

  if (value.needsConfirm === true) {
    const lines = ['需要你确认（设置变更，L3）']
    for (const change of asArray(value.diff)) lines.push(`- ${change.path}：${formatChangeValue(change.before)} → ${formatChangeValue(change.after)}`)
    if (asArray(value.impacts).length > 0) lines.push('影响：', ...asArray(value.impacts).map((impact) => `- ${impact}`))
    lines.push('确认后我再执行；你也可以在设置页手动修改。')
    return textBlocks(lines.join('\n'))
  }

  const lines = [`已更新自动化设置（${asArray(value.diff).length} 项变更）`]
  for (const change of asArray(value.diff)) lines.push(`- ${change.path}：${formatChangeValue(change.before)} → ${formatChangeValue(change.after)}`)
  if (asArray(value.impacts).length > 0) lines.push('影响：', ...asArray(value.impacts).map((impact) => `- ${impact}`))
  const impacted = asArray(value.impacted)
  if (impacted.length > 0) {
    const brief = impacted
      .slice(0, 6)
      .map((item) => (item.kind ? `${item.kind}${item.action ? `(${item.action})` : ''}` : item.id ?? '定时任务'))
    lines.push(`受影响定时任务：${impacted.length} 项（${brief.join('、')}${impacted.length > 6 ? ' …' : ''}）`)
  } else {
    lines.push('定时任务已对账（无变化或不涉及 schedule）。')
  }
  lines.push('可在设置页查看或回滚。')
  return textBlocks(lines.join('\n'))
}

/**
 * `lifeos_settings`：自动化设置元能力（M3 §5）。
 * get 只读；set 恒 L3：未 confirm 只返回 diff + 影响面，confirm:true 才调 patchSettings。
 */
export function settingsTool(service) {
  return {
    name: 'lifeos_settings',
    description: [
      '查看或修改 LifeOS 的自动化设置（晨间简报/晚报/习惯追问/夜间整理/截止提醒/免打扰/每日预算/建议卡）。',
      '何时用：用户说“以后早上 8 点发简报”“每天最多 1 条主动消息”“免打扰改成 23 点”“晚上别推了”“截止提醒提前两小时”。',
      '何时不用：用户只是问“你现在会提醒我什么”（用 get 回答即可，不要改）；用户要改任务/笔记/习惯（用对应工具）。',
      '权限：set 是 L3——不带 confirm 时只返回变更 diff 与影响面，不执行；用户明确同意后再调用并传 confirm:true。边界：时间 HH:mm、预算 0–5、免打扰不能全天、已开 routine 的时间不能落在免打扰内；服务端会再校验一次。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: SETTINGS_ACTIONS, description: 'get=读取当前设置摘要；set=预演/执行修改（L3）' },
        patch: {
          type: 'object',
          additionalProperties: true,
          description: 'set 的修改项，如 {"morningBrief":{"time":"08:00"}}、{"dailyBudget":1}、{"dnd":{"start":"23:00"}}；字段结构见 get 返回',
        },
        confirm: {
          type: 'boolean',
          description: '仅 L3 确认流：上一轮返回 needsConfirm 且用户明确同意后传 true 才会执行；不要自行传 true',
        },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderSettings },
    timeoutMs: 20_000,
    isConcurrencySafe: (args) => args?.action === 'get',
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action.trim() : ''
      if (!SETTINGS_ACTIONS.includes(action)) {
        return failValue('validation_failed', `action 必须是 ${SETTINGS_ACTIONS.join(' / ')} 之一`)
      }
      try {
        if (action === 'get') return await runSettingsGet(service)
        return await runSettingsSet(service, args, exec)
      } catch (error) {
        return toSettingsFailure(error)
      }
    },
  }
}

// ════════════════════════════════════════════════════════════════
// M4 · 习惯 / 项目 / 目标（Agent 工具层）
// - 只读动作 L0；create/checkin 等 L2；结构变更（频率/周期/状态、项目
//   生命周期、目标创建/转化）是 L3：未 confirm 只返回 needsConfirm + 变更，
//   不落库（M4-PLAN §6）。
// - 服务方法名以 B 装配后的 ctx.lifeos 平铺方法为准；对 A 的原生方法名
//   （getStats/getMonth/todayHabits）保留别名，避免装配层差异导致工具不可用。
// ════════════════════════════════════════════════════════════════

const HABIT_ACTIONS = ['list', 'get', 'create', 'update', 'checkin', 'uncheck', 'stats', 'month']
const HABIT_READ_ACTIONS = ['list', 'get', 'stats', 'month']
const HABIT_CHECKIN_STATUSES = ['done', 'partial', 'skipped', 'not_done']
const HABIT_STATUSES = ['active', 'paused', 'archived']
const HABIT_FREQUENCY_KINDS = ['daily', 'weekly_days', 'weekly_count', 'interval']
const HABIT_WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const HABIT_CHECKIN_MODES = ['manual', 'event_auto', 'either']
const HABIT_STREAK_MODES = ['grace', 'strict']
/** update 里会改变计划结构的字段：命中即 L3（M4-PLAN §6）。 */
const HABIT_L3_UPDATE_FIELDS = ['frequencyRule', 'periodRule', 'status']
const HABIT_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const HABIT_LIST_LIMIT = 30
const HABIT_RENDER_LIMIT = 8
const HABIT_RECENT_CHECKIN_LIMIT = 5
const HABIT_NAME_MAX = 200
const HABIT_NOTE_MAX = 500
const HABIT_TODAY_LIMIT = 10

const HABIT_STATUS_LABELS = {
  active: '进行中',
  paused: '已暂停',
  archived: '已归档',
  done: '已完成',
  partial: '部分完成',
  skipped: '跳过',
  not_done: '未完成',
}

/** camelCase 工具字段 → habitView 的 snake_case 字段（L3 diff 用）。 */
const HABIT_FIELD_VIEW_KEYS = {
  name: 'name',
  description: 'description',
  frequencyRule: 'frequency_rule',
  periodRule: 'period_rule',
  targetJson: 'target_json',
  checkinMode: 'checkin_mode',
  startDate: 'start_date',
  endDate: 'end_date',
  timeHint: 'time_hint',
  status: 'status',
}

const PROJECT_ACTIONS = ['list', 'get', 'create', 'update', 'archive', 'progress']
const PROJECT_STATUSES = ['active', 'paused', 'completed', 'cancelled', 'archived']
const PROJECT_RENDER_LIMIT = 8
const PROJECT_STATUS_LABELS = {
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  archived: '已归档',
}

const GOAL_ACTIONS = ['list', 'get', 'create', 'update', 'convert_wish']
const GOAL_STATUSES = ['active', 'paused', 'achieved', 'abandoned']
const GOAL_HORIZONS = ['short', 'mid', 'long']
const GOAL_PROGRESS_MODES = ['manual', 'auto_by_projects', 'auto_by_tasks']
const GOAL_RENDER_LIMIT = 8
const GOAL_STATUS_LABELS = {
  active: '进行中',
  paused: '已暂停',
  achieved: '已达成',
  abandoned: '已放弃',
}
const GOAL_HORIZON_LABELS = { short: '短期', mid: '中期', long: '长期' }

const M4_KIND_LABELS = { habit: '习惯', project: '项目', goal: '目标', wish: '愿望' }

/** M4 服务方法缺失时给模型的中文错误（提示需要 M4 装配，而不是 M1 版本）。 */
function requireM4Method(service, method, kind, aliases = []) {
  const found = pickMethodName(service, [method, ...aliases])
  if (found) return found
  throw inputError('internal', `服务未提供 ${method}()，${kind}服务可能未就绪（需要 M4 装配）。不要编造数据；可以让用户稍后在 LifeOS 面板查看或重试。`)
}

function requireM4Id(args, key, label) {
  const id = readString(args, key)
  if (!id) throw inputError('validation_failed', `${label} 必填（来自 list/get 返回）`)
  return id
}

function readObjectArg(args, key) {
  const value = args?.[key]
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw inputError('validation_failed', `${key} 必须是对象`)
  }
  return value
}

function readNumberArg(args, key, { min, max } = {}) {
  const value = args?.[key]
  if (value === undefined) return undefined
  if (!isFiniteNumber(value)) throw inputError('validation_failed', `${key} 必须是数字`)
  if (min !== undefined && value < min) throw inputError('validation_failed', `${key} 不能小于 ${min}`)
  if (max !== undefined && value > max) throw inputError('validation_failed', `${key} 不能大于 ${max}`)
  return value
}

function readDateArg(args, key) {
  const value = readString(args, key)
  if (value !== undefined) assertDateOnly(value, key)
  return value
}

function assertHabitStatus(status, key = 'status') {
  if (!HABIT_STATUSES.includes(status)) {
    throw inputError('validation_failed', `${key} 必须是 ${HABIT_STATUSES.join(' / ')} 之一`)
  }
}

function assertCheckinStatus(status) {
  if (!HABIT_CHECKIN_STATUSES.includes(status)) {
    throw inputError('validation_failed', `status 必须是 ${HABIT_CHECKIN_STATUSES.join(' / ')} 之一（打卡状态，不是习惯状态）`)
  }
}

function assertFrequencyRule(rule) {
  const kind = firstString(rule?.kind)
  if (!kind) throw inputError('validation_failed', 'frequencyRule.kind 必填（daily/weekly_days/weekly_count/interval）')
  if (!HABIT_FREQUENCY_KINDS.includes(kind)) {
    throw inputError(
      'validation_failed',
      kind === 'monthly_count'
        ? 'monthly_count 属于 V1.5，M4a 不支持；请改用 weekly_count 或 interval'
        : `frequencyRule.kind 必须是 ${HABIT_FREQUENCY_KINDS.join(' / ')} 之一`,
    )
  }
  if (kind === 'weekly_days') {
    const days = asArray(rule.days)
    if (days.length === 0) throw inputError('validation_failed', 'weekly_days 需要非空 days 数组，如 ["MO","WE","FR"]')
    for (const day of days) {
      if (!HABIT_WEEKDAYS.includes(day)) throw inputError('validation_failed', `weekly_days.days 只能包含 ${HABIT_WEEKDAYS.join(' / ')}`)
    }
  }
  if (kind === 'weekly_count') {
    if (!isFiniteNumber(rule.count) || rule.count < 1) {
      throw inputError('validation_failed', 'weekly_count 需要 count（每周次数 ≥1）')
    }
  }
  if (kind === 'interval') {
    if (!isFiniteNumber(rule.days) || rule.days < 1) {
      throw inputError('validation_failed', 'interval 需要 days（间隔天数 ≥1）')
    }
  }
}

function assertPeriodRule(rule) {
  if (!rule || typeof rule !== 'object') throw inputError('validation_failed', 'periodRule 必须是对象')
  const period = firstString(rule.period)
  if (!['week', 'month'].includes(period)) {
    throw inputError('validation_failed', 'periodRule.period 必须是 week / month')
  }
  if (!isFiniteNumber(rule.targetCount, rule.target_count)) {
    throw inputError('validation_failed', 'periodRule.targetCount 必填（周期目标次数）')
  }
}

/** M4 通用 L3 确认值：needsConfirm + 变更预览（不执行写入）。 */
function m4Confirm({ kind, action, id, title, changes, current, proposal, message }) {
  const preview = { action, id: id ?? null, changes: changes ?? {} }
  if (proposal && typeof proposal === 'object') preview.proposal = proposal
  const kindLabel = M4_KIND_LABELS[kind] ?? '操作'
  return {
    ok: true,
    needsConfirm: true,
    kind,
    action,
    id: id ?? null,
    title: title ?? null,
    preview,
    currentStatus: current?.status ?? null,
    currentRev: isFiniteNumber(current?.rev) ? current.rev : null,
    message:
      message ??
      `这是 L3 操作（需要用户确认）：${action}${kindLabel}${id ? ` ${id}` : ''}。请先把变更和影响告诉用户；用户明确同意后，再次调用本工具并传 confirm:true 才会执行；用户也可以直接在 LifeOS 面板操作。`,
  }
}

function renderConfirmPreview(kindLabel, value) {
  const lines = [`需要你确认（${kindLabel}变更，L3）${value.title ? `：「${value.title}」` : ''}`]
  const changes = renderChanges(value.preview?.changes)
  if (changes.length) lines.push('将要变更：', ...changes)
  const proposal = value.preview?.proposal
  if (proposal && typeof proposal === 'object') {
    const entries = Object.entries(proposal).filter(([, raw]) => {
      if (raw === undefined || raw === null || raw === '') return false
      if (Array.isArray(raw)) return raw.length > 0
      if (typeof raw === 'object') return Object.keys(raw).length > 0
      return true
    })
    if (entries.length) {
      lines.push('将提交：')
      for (const [key, raw] of entries) lines.push(`- ${key}：${formatChangeValue(raw)}`)
    }
  }
  lines.push('确认后我再执行；你也可以直接在 LifeOS 面板里操作。')
  return lines
}

// ── 习惯 helpers ─────────────────────────────────────────────────

async function readServiceToday(service) {
  if (typeof service?.today !== 'function') return null
  try {
    const today = await service.today()
    const date = firstString(today?.date, today?.localDate, today?.local_date)
    return date && DATE_ONLY_RE.test(date) ? date : null
  } catch {
    return null
  }
}

function normalizeStreak(streak) {
  if (isFiniteNumber(streak)) return { mode: null, unit: 'day', value: streak, longest: null }
  if (!streak || typeof streak !== 'object') return null
  const value = pickNumber(streak.value, streak.current, streak.days)
  const longest = pickNumber(streak.longest, streak.best)
  if (value === null && longest === null) return null
  return {
    mode: firstString(streak.mode) ?? null,
    unit: firstString(streak.unit) ?? 'day',
    value,
    longest,
  }
}

function normalizeCoverage(coverage) {
  if (!coverage || typeof coverage !== 'object') return null
  const recorded = pickNumber(coverage.recorded, coverage.done)
  const expected = pickNumber(coverage.expected, coverage.total)
  const ratio = pickNumber(coverage.ratio)
  if (recorded === null && expected === null && ratio === null) return null
  return { recorded, expected, ratio }
}

function formatStreak(streak) {
  const normalized = normalizeStreak(streak)
  if (!normalized || normalized.value === null) return '—'
  const unit = { day: '天', week: '周', month: '月' }[normalized.unit] ?? normalized.unit ?? ''
  const mode = normalized.mode ? `（${normalized.mode} 口径）` : ''
  return `连续 ${normalized.value} ${unit}${mode}`
}

function formatCoverage(coverage) {
  const normalized = normalizeCoverage(coverage)
  if (!normalized) return '—'
  const ratio =
    isFiniteNumber(normalized.ratio)
      ? normalized.ratio
      : isFiniteNumber(normalized.recorded) && normalized.expected > 0
        ? normalized.recorded / normalized.expected
        : null
  const pct = ratio === null ? '' : `（${Math.round(ratio * 100)}%）`
  const recorded = normalized.recorded ?? '—'
  const expected = normalized.expected ?? '—'
  return `覆盖 ${recorded}/${expected}${pct}`
}

function habitText(habit) {
  if (!habit || typeof habit !== 'object') return '—'
  return firstString(habit.frequency_text, habit.frequencyText) ?? '—'
}

function habitName(habit) {
  return firstString(habit?.name, habit?.title) ?? (habit?.id ? String(habit.id) : '习惯')
}

function habitStatusLabel(status) {
  if (status === undefined || status === null || status === '') return '未记录'
  return HABIT_STATUS_LABELS[status] ?? status
}

function normalizeHabit(habit) {
  if (!habit || typeof habit !== 'object') return null
  const id = firstString(habit.id, habit.habitId, habit.habit_id)
  const name = firstString(habit.name, habit.title)
  if (!id && !name) return null
  return {
    id,
    name: name ?? id,
    status: firstString(habit.status) ?? null,
    frequency_text: firstString(habit.frequency_text, habit.frequencyText) ?? null,
    today_status: firstString(habit.today_status, habit.todayStatus, habit.today?.status) ?? null,
    rev: pickNumber(habit.rev),
    frequency_rule: habit.frequency_rule ?? habit.frequencyRule ?? null,
    period_rule: habit.period_rule ?? habit.periodRule ?? null,
    checkin_mode: firstString(habit.checkin_mode, habit.checkinMode) ?? null,
    start_date: firstString(habit.start_date, habit.startDate) ?? null,
    time_hint: firstString(habit.time_hint, habit.timeHint) ?? null,
    description: firstString(habit.description) ?? null,
    streak: normalizeStreak(habit.streak),
    coverage: normalizeCoverage(habit.coverage),
  }
}

function habitViewOf(result) {
  if (!result || typeof result !== 'object') return null
  if (result.habit && typeof result.habit === 'object') return result.habit
  if (result.habitView && typeof result.habitView === 'object') return result.habitView
  return result
}

function normalizeCheckin(checkin) {
  if (!checkin || typeof checkin !== 'object') return null
  const localDate = firstString(checkin.localDate, checkin.local_date)
  const status = firstString(checkin.status)
  if (!localDate && !status) return null
  return {
    habitId: firstString(checkin.habitId, checkin.habit_id) ?? null,
    localDate,
    status,
    value: checkin.value ?? checkin.value_json ?? null,
    note: firstString(checkin.note) ?? null,
    retro: checkin.retro === true || firstString(checkin.checkinKind, checkin.checkin_kind) === 'retro',
    revision: pickNumber(checkin.revision, checkin.rev),
  }
}

async function fetchHabitRaw(service, habitId) {
  const method = pickMethodName(service, ['getHabit'])
  if (!method) return null
  try {
    const result = await service[method](habitId)
    const raw = habitViewOf(result)
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

async function resolveHabitExpectedRev(service, habitId, args) {
  const explicit = readPositiveInt(args, 'expectedRev', Number.MAX_SAFE_INTEGER)
  if (explicit !== undefined) return explicit
  const current = await fetchHabitRaw(service, habitId)
  if (current && isFiniteNumber(current.rev)) return current.rev
  throw inputError('validation_failed', '缺少 expectedRev 且无法读取习惯当前版本；请先 action=get 读取习惯再用返回的 rev')
}

function readHabitCreateInput(args) {
  const name = readString(args, 'name')
  if (!name) throw inputError('validation_failed', 'create 需要 name')
  if (name.length > HABIT_NAME_MAX) throw inputError('validation_failed', `name 最长 ${HABIT_NAME_MAX} 字`)
  const frequencyRule = readObjectArg(args, 'frequencyRule')
  if (!frequencyRule) {
    throw inputError('validation_failed', 'create 需要 frequencyRule，如 {"kind":"daily","interval":1} 或 {"kind":"weekly_days","days":["MO","WE","FR"]}')
  }
  assertFrequencyRule(frequencyRule)
  const input = { name, frequencyRule }
  const description = readString(args, 'description')
  if (description !== undefined) input.description = description
  const periodRule = readObjectArg(args, 'periodRule')
  if (periodRule !== undefined) {
    assertPeriodRule(periodRule)
    input.periodRule = periodRule
  }
  if (firstString(frequencyRule.kind) === 'weekly_count' && periodRule === undefined) {
    throw inputError('validation_failed', 'weekly_count 频率必须同时给 periodRule（period=week, targetCount=每周次数）')
  }
  const targetJson = readObjectArg(args, 'targetJson')
  if (targetJson !== undefined) input.targetJson = targetJson
  const checkinMode = readString(args, 'checkinMode')
  if (checkinMode !== undefined) {
    if (!HABIT_CHECKIN_MODES.includes(checkinMode)) {
      throw inputError('validation_failed', `checkinMode 必须是 ${HABIT_CHECKIN_MODES.join(' / ')} 之一`)
    }
    input.checkinMode = checkinMode
  }
  const startDate = readDateArg(args, 'startDate')
  if (startDate !== undefined) input.startDate = startDate
  const timeHint = readString(args, 'timeHint')
  if (timeHint !== undefined) input.timeHint = timeHint
  return input
}

function readHabitPatch(args) {
  const patch = {}
  const name = readString(args, 'name')
  if (name !== undefined) {
    if (name.length > HABIT_NAME_MAX) throw inputError('validation_failed', `name 最长 ${HABIT_NAME_MAX} 字`)
    patch.name = name
  }
  if (typeof args?.description === 'string') patch.description = args.description
  const frequencyRule = readObjectArg(args, 'frequencyRule')
  if (frequencyRule !== undefined) {
    assertFrequencyRule(frequencyRule)
    patch.frequencyRule = frequencyRule
  }
  const periodRule = readObjectArg(args, 'periodRule')
  if (periodRule !== undefined) {
    assertPeriodRule(periodRule)
    patch.periodRule = periodRule
  }
  const targetJson = readObjectArg(args, 'targetJson')
  if (targetJson !== undefined) patch.targetJson = targetJson
  const checkinMode = readString(args, 'checkinMode')
  if (checkinMode !== undefined) {
    if (!HABIT_CHECKIN_MODES.includes(checkinMode)) {
      throw inputError('validation_failed', `checkinMode 必须是 ${HABIT_CHECKIN_MODES.join(' / ')} 之一`)
    }
    patch.checkinMode = checkinMode
  }
  const startDate = readDateArg(args, 'startDate')
  if (startDate !== undefined) patch.startDate = startDate
  const timeHint = readString(args, 'timeHint')
  if (timeHint !== undefined) patch.timeHint = timeHint
  const status = readString(args, 'status')
  if (status !== undefined) {
    assertHabitStatus(status)
    patch.status = status
  }
  return patch
}

function habitFieldBefore(current, field) {
  if (!current || typeof current !== 'object') return null
  const key = HABIT_FIELD_VIEW_KEYS[field] ?? field
  const value = current[key]
  return value === undefined ? null : value
}

async function runHabitList(service, args) {
  const method = requireM4Method(service, 'listHabits', '习惯')
  const input = {}
  const status = readString(args, 'status')
  if (status !== undefined) {
    assertHabitStatus(status)
    input.status = status
  }
  const includeArchived = readBoolean(args, 'includeArchived')
  if (includeArchived !== undefined) input.includeArchived = includeArchived
  const result = await service[method](input)
  const items = asArray(result?.items).map(normalizeHabit).filter(Boolean)
  return {
    ok: true,
    action: 'list',
    items,
    truncated: items.length > HABIT_LIST_LIMIT,
    today: firstString(result?.today) ?? null,
  }
}

async function runHabitGet(service, args) {
  const method = requireM4Method(service, 'getHabit', '习惯')
  const habitId = requireM4Id(args, 'habitId', 'habitId')
  const result = await service[method](habitId)
  if (!result) throw inputError('not_found', `习惯 ${habitId} 不存在（可能已归档或 id 不对）`)
  const habit = normalizeHabit(habitViewOf(result))
  if (!habit) throw inputError('internal', 'getHabit 返回了无法解析的习惯')
  const checkins = asArray(result?.checkins).map(normalizeCheckin).filter(Boolean)
  return {
    ok: true,
    action: 'get',
    habitId,
    habit,
    checkins: checkins.slice(0, HABIT_RECENT_CHECKIN_LIMIT),
    checkinCount: checkins.length,
  }
}

async function runHabitCreate(service, args, exec) {
  const method = requireM4Method(service, 'createHabit', '习惯')
  const input = readHabitCreateInput(args)
  const meta = buildWriteMeta(exec)
  const payload = meta.idempotencyKey ? { ...input, idempotencyKey: meta.idempotencyKey } : input
  const result = await service[method](payload, meta)
  const habit = normalizeHabit(habitViewOf(result))
  if (!habit) throw inputError('internal', 'createHabit 未返回习惯对象')
  return {
    ok: true,
    action: 'create',
    habit,
    rev: pickNumber(result?.revision, habit.rev),
    changedFields: Object.keys(input),
  }
}

async function runHabitUpdate(service, args, exec) {
  const method = requireM4Method(service, 'updateHabit', '习惯')
  const habitId = requireM4Id(args, 'habitId', 'habitId')
  const patch = readHabitPatch(args)
  const changedFields = Object.keys(patch)
  if (changedFields.length === 0) {
    throw inputError(
      'validation_failed',
      'update 没有可更新字段（可更新 name/description/frequencyRule/periodRule/targetJson/checkinMode/startDate/timeHint/status）',
    )
  }
  const l3Fields = changedFields.filter((field) => HABIT_L3_UPDATE_FIELDS.includes(field))
  const confirm = readBoolean(args, 'confirm') === true

  if (l3Fields.length > 0 && !confirm) {
    const current = await fetchHabitRaw(service, habitId)
    const changes = {}
    for (const field of changedFields) changes[field] = { before: habitFieldBefore(current, field), after: patch[field] }
    return m4Confirm({
      kind: 'habit',
      action: 'update',
      id: habitId,
      title: current ? habitName(current) : null,
      changes,
      current,
      proposal: patch,
      message: `这是 L3 操作（需要用户确认）：修改习惯计划结构（${l3Fields.join(' / ')}），会改变未来的计划日与统计口径。请先展示 before→after；用户明确同意后再次调用并传 confirm:true。`,
    })
  }

  const expectedRev = await resolveHabitExpectedRev(service, habitId, args)
  const result = await service[method](habitId, patch, { expectedRev, ...buildWriteMeta(exec) })
  const habit = normalizeHabit(habitViewOf(result)) ?? normalizeHabit(await fetchHabitRaw(service, habitId))
  return {
    ok: true,
    action: 'update',
    habitId,
    habit: habit ?? { id: habitId, name: patch.name ?? null },
    rev: pickNumber(result?.revision, habit?.rev),
    changedFields,
    diff: result?.diff ?? null,
  }
}

async function runHabitCheckin(service, args, exec) {
  const method = requireM4Method(service, 'checkin', '习惯')
  const habitId = requireM4Id(args, 'habitId', 'habitId')
  const explicitDate = readDateArg(args, 'localDate')
  const retro = readBoolean(args, 'retro') === true
  if (retro && !explicitDate) {
    throw inputError('validation_failed', 'retro 补记必须显式指定 localDate（今天往前 7 天内）')
  }
  const localDate = explicitDate ?? (await readServiceToday(service))
  if (!localDate) {
    throw inputError('validation_failed', '未提供 localDate 且无法确定本地今天；请显式传 YYYY-MM-DD')
  }
  const status = readString(args, 'status') ?? 'done'
  assertCheckinStatus(status)
  const input = { habitId, localDate, status }
  if (args?.value !== undefined) {
    if (!isFiniteNumber(args.value) && typeof args.value !== 'string') {
      throw inputError('validation_failed', 'value 只能是数字或字符串')
    }
    input.value = args.value
  }
  const note = readString(args, 'note')
  if (note !== undefined) {
    if (note.length > HABIT_NOTE_MAX) throw inputError('validation_failed', `note 最长 ${HABIT_NOTE_MAX} 字`)
    input.note = note
  }
  if (retro) input.retro = true
  const meta = buildWriteMeta(exec)
  if (meta.idempotencyKey) input.idempotencyKey = meta.idempotencyKey
  const result = await service[method](input, meta)
  const checkin = normalizeCheckin(result?.checkin ?? result) ?? { habitId, localDate, status, value: input.value ?? null, note: input.note ?? null }
  return {
    ok: true,
    action: 'checkin',
    habitId,
    localDate,
    status,
    checkin,
    merged: result?.merged === true,
    revision: pickNumber(result?.revision),
  }
}

async function runHabitUncheck(service, args, exec) {
  const method = requireM4Method(service, 'uncheck', '习惯')
  const habitId = requireM4Id(args, 'habitId', 'habitId')
  const localDate = readDateArg(args, 'localDate')
  if (!localDate) throw inputError('validation_failed', 'uncheck 需要 localDate（要撤销打卡的具体日期）')
  const input = { habitId, localDate }
  const expectedRev = readPositiveInt(args, 'expectedRev', Number.MAX_SAFE_INTEGER)
  if (expectedRev !== undefined) input.expectedRev = expectedRev
  const result = await service[method](input, buildWriteMeta(exec))
  return { ok: true, action: 'uncheck', habitId, localDate, revision: pickNumber(result?.revision) }
}

function normalizeStatsItem(item) {
  if (!item || typeof item !== 'object') return null
  const habitId = firstString(item.habitId, item.habit_id, item.id)
  if (!habitId) return null
  const period = item.period && typeof item.period === 'object' ? item.period : null
  return {
    habitId,
    name: firstString(item.name, item.title) ?? habitId,
    frequency_text: firstString(item.frequency_text, item.frequencyText) ?? null,
    streak: normalizeStreak(item.streak),
    coverage: normalizeCoverage(item.coverage),
    period: period
      ? {
          key: firstString(period.key) ?? null,
          target: pickNumber(period.target),
          achieved: pickNumber(period.achieved),
          met: period.met === true,
        }
      : null,
    today_status: firstString(item.today?.status, item.today_status, item.todayStatus) ?? null,
  }
}

async function runHabitStats(service, args) {
  const method = requireM4Method(service, 'getHabitStats', '习惯', ['getStats'])
  const from = readDateArg(args, 'from')
  const to = readDateArg(args, 'to')
  const mode = readString(args, 'mode') ?? 'grace'
  if (!HABIT_STREAK_MODES.includes(mode)) {
    throw inputError('validation_failed', `mode 必须是 ${HABIT_STREAK_MODES.join(' / ')}（streak 口径）`)
  }
  const input = { streakMode: mode }
  if (from !== undefined) input.from = from
  if (to !== undefined) input.to = to
  const result = await service[method](input)
  const range = result?.range && typeof result.range === 'object' ? result.range : null
  return {
    ok: true,
    action: 'stats',
    range: {
      from: firstString(range?.from) ?? from ?? null,
      to: firstString(range?.to) ?? to ?? null,
    },
    today: firstString(result?.today) ?? null,
    streakMode: firstString(result?.streakMode, result?.streak_mode) ?? mode,
    habits: asArray(result?.habits).map(normalizeStatsItem).filter(Boolean),
  }
}

function normalizeMonthHabits(result) {
  const raw = asArray(result?.habits).length
    ? result.habits
    : asArray(result?.items).length
      ? result.items
      : asArray(result?.matrix?.habits).length
        ? result.matrix.habits
        : []
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const habitId = firstString(entry.habitId, entry.habit_id, entry.id)
      const name = firstString(entry.name, entry.title) ?? habitId ?? '习惯'
      const rawDays = asArray(entry.days).length
        ? entry.days
        : asArray(entry.cells).length
          ? entry.cells
          : asArray(entry.checkins)
      const days = rawDays
        .map((cell) => {
          if (!cell || typeof cell !== 'object') return null
          const date = firstString(cell.date, cell.localDate, cell.local_date)
          if (!date) return null
          return { date, status: firstString(cell.status, cell.value) ?? null }
        })
        .filter(Boolean)
      return {
        habitId,
        name,
        days,
        doneCount: pickNumber(entry.done, entry.doneCount, entry.done_count),
      }
    })
    .filter(Boolean)
}

async function runHabitMonth(service, args) {
  const method = requireM4Method(service, 'getHabitMonth', '习惯', ['getMonth'])
  let month = readString(args, 'month')
  if (month !== undefined) {
    if (!HABIT_MONTH_RE.test(month)) throw inputError('validation_failed', 'month 必须是 YYYY-MM 格式（如 2026-11）')
  } else {
    const today = await readServiceToday(service)
    if (!today) throw inputError('validation_failed', '未提供 month 且无法确定当前月份；请显式传 YYYY-MM')
    month = today.slice(0, 7)
  }
  const result = await service[method]({ month })
  return { ok: true, action: 'month', month, habits: normalizeMonthHabits(result) }
}

const HABIT_MONTH_SYMBOLS = { done: '●', partial: '◐', skipped: '○', not_done: '×' }
const HABIT_CELL_LIMIT = 31

/** `lifeos_habit` 的 render：列表/详情/打卡/统计/月历 中文摘要；L3 预演优先。 */
export function renderHabit(_args, value) {
  if (!value || value.ok !== true) {
    const code = value?.error?.code ?? 'internal'
    const message = value?.error?.message ?? ERROR_HINTS.internal
    const hint = value?.error?.hint ?? ERROR_HINTS.internal
    return textBlocks(`习惯操作失败（${code}）：${message} ${hint}`)
  }
  if (value.needsConfirm === true) return textBlocks(renderConfirmPreview('习惯', value).join('\n'))

  const action = value.action ?? 'list'
  if (action === 'list') {
    const items = asArray(value.items)
    const lines = [`习惯列表：${items.length} 个`]
    if (items.length === 0) {
      lines.push('没有符合条件的习惯。')
    } else {
      for (const habit of items.slice(0, HABIT_RENDER_LIMIT)) {
        lines.push(
          `- ${habitName(habit)}｜${habitText(habit)}｜今日：${habitStatusLabel(habit.today_status)}｜${formatStreak(habit.streak)}${idLabel(habit.id)}`,
        )
      }
      if (items.length > HABIT_RENDER_LIMIT) lines.push(`…另有 ${items.length - HABIT_RENDER_LIMIT} 个，可在 LifeOS 面板查看。`)
    }
    return textBlocks(lines.join('\n'))
  }

  if (action === 'get') {
    const habit = value.habit ?? {}
    const lines = [`习惯详情：${habitName(habit)}（${habit.id ?? value.habitId ?? '—'}）`]
    lines.push(`- 状态：${habitStatusLabel(habit.status)}｜频率：${habitText(habit)}`)
    lines.push(`- 今日：${habitStatusLabel(habit.today_status)}｜${formatStreak(habit.streak)}`)
    if (habit.coverage) lines.push(`- ${formatCoverage(habit.coverage)}`)
    if (habit.checkin_mode) lines.push(`- 打卡方式：${habit.checkin_mode}`)
    if (habit.start_date) lines.push(`- 开始日期：${habit.start_date}`)
    if (habit.time_hint) lines.push(`- 提醒时间：${habit.time_hint}`)
    if (habit.description) lines.push(`- 备注：${habit.description}`)
    const checkins = asArray(value.checkins)
    if (checkins.length) {
      lines.push(`最近打卡（${value.checkinCount ?? checkins.length} 条中展示 ${checkins.length} 条）：`)
      for (const checkin of checkins) {
        lines.push(
          `- ${checkin.localDate ?? '—'} ${habitStatusLabel(checkin.status)}${checkin.note ? `（${checkin.note}）` : ''}${checkin.retro ? '（补记）' : ''}`,
        )
      }
    }
    return textBlocks(lines.join('\n'))
  }

  if (action === 'create') {
    const habit = value.habit ?? {}
    return textBlocks(`已创建习惯「${habitName(habit)}」（${habit.id ?? '—'}）｜频率：${habitText(habit)}`)
  }

  if (action === 'update') {
    const lines = [`已更新习惯「${habitName(value.habit ?? {})}」：${asArray(value.changedFields).join('、') || '无字段变更'}`]
    if (value.diff && typeof value.diff === 'object' && !Array.isArray(value.diff)) {
      lines.push(...renderChanges(value.diff))
    }
    return textBlocks(lines.join('\n'))
  }

  if (action === 'checkin') {
    const name = habitName(value.checkin?.habitId ? { id: value.checkin.habitId } : { id: value.habitId })
    const lines = [`已记录打卡：${name}｜${value.localDate ?? value.checkin?.localDate ?? '—'} ${habitStatusLabel(value.status ?? value.checkin?.status)}`]
    if (value.merged === true) lines.push('同日已有一条记录，已更新为本次内容。')
    else lines.push('同日没有变化时不会重复写入（幂等）。')
    if (value.checkin?.value !== null && value.checkin?.value !== undefined) lines.push(`数值：${formatChangeValue(value.checkin.value)}`)
    if (value.checkin?.note) lines.push(`备注：${value.checkin.note}`)
    if (value.checkin?.retro) lines.push('这是补记（retro）。')
    return textBlocks(lines.join('\n'))
  }

  if (action === 'uncheck') {
    return textBlocks(`已撤销打卡：${value.habitId ?? '—'}｜${value.localDate ?? '—'}`)
  }

  if (action === 'stats') {
    const range = value.range ?? {}
    const mode = value.streakMode ?? 'grace'
    const habits = asArray(value.habits)
    const lines = [`习惯统计：${range.from ?? '—'}–${range.to ?? '—'}（连续口径：${mode}）`]
    if (habits.length === 0) {
      lines.push('区间内没有可统计的习惯数据。')
    } else {
      for (const item of habits.slice(0, HABIT_RENDER_LIMIT)) {
        const parts = [item.name ?? item.habitId, item.frequency_text ?? '频率未设', formatStreak(item.streak), formatCoverage(item.coverage)]
        if (item.period) {
          parts.push(
            `周期 ${item.period.key ?? '—'}：${item.period.achieved ?? '—'}/${item.period.target ?? '—'}${item.period.met ? '（已达标）' : ''}`,
          )
        }
        lines.push(`- ${parts.join('｜')}`)
      }
      if (habits.length > HABIT_RENDER_LIMIT) lines.push(`…另有 ${habits.length - HABIT_RENDER_LIMIT} 个习惯，可在 LifeOS 面板查看。`)
    }
    return textBlocks(lines.join('\n'))
  }

  if (action === 'month') {
    const habits = asArray(value.habits)
    const lines = [`习惯月历 ${value.month ?? '—'}：${habits.length} 个习惯`, '图例：● 完成｜◐ 部分｜○ 跳过｜× 未完成｜· 未记录']
    if (habits.length === 0) {
      lines.push('本月没有习惯矩阵数据。')
    } else {
      for (const habit of habits.slice(0, HABIT_RENDER_LIMIT)) {
        if (habit.days.length === 0) {
          lines.push(`- ${habit.name}：（矩阵无明细${habit.doneCount !== null && habit.doneCount !== undefined ? `，本月完成 ${habit.doneCount} 次` : ''}）`)
          continue
        }
        const cells = habit.days
          .slice(0, HABIT_CELL_LIMIT)
          .map((cell) => HABIT_MONTH_SYMBOLS[cell.status] ?? (cell.status ? '?' : '·'))
          .join('')
        const done = habit.days.filter((cell) => cell.status === 'done').length
        lines.push(`- ${habit.name}：${cells}（完成 ${done} 天）`)
      }
      if (habits.length > HABIT_RENDER_LIMIT) lines.push(`…另有 ${habits.length - HABIT_RENDER_LIMIT} 个习惯，可在 LifeOS 面板查看。`)
    }
    return textBlocks(lines.join('\n'))
  }

  return textBlocks('习惯操作完成。')
}

/** `lifeos_habit`：习惯 CRUD/打卡/统计/月历（M4 §6）。 */
export function habitTool(service) {
  return {
    name: 'lifeos_habit',
    description: [
      '管理 LifeOS 习惯：查看（list/get）、创建、更新、打卡（checkin）、撤销打卡（uncheck）、统计（stats）、月历（month）。',
      '权限：list/get/stats/month 只读（L0）；create、checkin、uncheck、以及 update 中的普通字段是 L2，会直接执行；**update 里改频率（frequencyRule）/周期目标（periodRule）/状态（active/paused/archived）是 L3**——工具不会执行，只返回 needsConfirm + 变更，你必须先展示 before→after，用户明确同意后再传 confirm:true。',
      '何时用：用户说“每天读书 30 分钟”“周三周五跑步”“今天读了，帮我打卡”“昨天忘了打卡，补一下”“这周习惯完成得怎么样”“看看这个月打卡”。',
      '何时不用：用户只是随口说计划（先确认再建习惯）；用户没说做了/没做时不要替用户打卡，也不要由计划推断完成；没有记录就说“未记录”。',
      '重要：list 返回的每一项都带 id（形如 hab_…），后续 get/update/checkin 必须用返回的 id，不要用名字猜 id；打卡默认记今天（本地日期），补记必须显式给 localDate 且 retro:true（最多往前 7 天）；同一天重复打卡由服务合并；streak/覆盖率必须带口径（grace/strict）引用，不要编造。',
    ].join('\n'),
    parameters: {
      type: 'object',
      // 多 action 共用参数：不用 additionalProperties:false，具体校验在 execute 里做（与 lifeos_task 一致）。
      properties: {
        action: { type: 'string', enum: HABIT_ACTIONS, description: '要执行的动作；list/get/stats/month 只读，其余为写操作' },
        habitId: { type: 'string', description: '习惯 id（get/update/checkin/uncheck 必填，来自 list/get 返回）' },
        localDate: {
          type: 'string',
          description: '打卡/撤销的本地日期 YYYY-MM-DD；checkin 不传时默认今天；retro 补记必须显式传',
        },
        status: {
          type: 'string',
          enum: [...HABIT_CHECKIN_STATUSES, ...HABIT_STATUSES],
          description: 'checkin 时是打卡状态 done/partial/skipped/not_done；update 时是习惯状态 active/paused/archived（L3）；list 时可按状态筛选',
        },
        value: { type: 'string', description: '打卡数值（如阅读页数/分钟数；数字也可，工具内部兼容）' },
        note: { type: 'string', maxLength: HABIT_NOTE_MAX, description: '打卡备注' },
        retro: { type: 'boolean', description: 'true=补记（必须显式 localDate，只能补今天往前 7 天）；不要默认补记' },
        name: { type: 'string', maxLength: HABIT_NAME_MAX, description: 'create 必填；update 可改习惯名' },
        description: { type: 'string', description: '习惯描述/备注' },
        frequencyRule: {
          type: 'object',
          additionalProperties: true,
          description: '频率规则：{"kind":"daily","interval":1} / {"kind":"weekly_days","days":["MO","WE","FR"]} / {"kind":"weekly_count","count":3} / {"kind":"interval","days":2,"anchor_date":"YYYY-MM-DD"}；monthly_count 不支持',
        },
        periodRule: {
          type: 'object',
          additionalProperties: true,
          description: '周期目标：{"period":"week","targetCount":3,"weekStart":"MO"} 或 {"period":"month","targetCount":10}；weekly_count 必填',
        },
        targetJson: { type: 'object', additionalProperties: true, description: '量化目标，如 {"kind":"duration","minutes":30}' },
        checkinMode: { type: 'string', enum: HABIT_CHECKIN_MODES, description: '打卡方式：manual=手动 / event_auto=事件自动 / either=两者皆可' },
        startDate: { type: 'string', description: '开始日期 YYYY-MM-DD' },
        timeHint: { type: 'string', description: '打卡时间提示 HH:mm，如 "07:30"' },
        from: { type: 'string', description: 'stats 起始日期 YYYY-MM-DD（含）' },
        to: { type: 'string', description: 'stats 结束日期 YYYY-MM-DD（含）' },
        mode: { type: 'string', enum: HABIT_STREAK_MODES, description: 'stats 的 streak 口径：grace（默认，skipped/unknown 不打断）或 strict' },
        month: { type: 'string', description: 'month 动作的月份 YYYY-MM，默认当前月' },
        includeArchived: { type: 'boolean', description: 'list 是否包含已归档习惯' },
        expectedRev: { type: 'integer', minimum: 1, description: 'CAS 版本（写操作推荐显式传；不传时工具会先 get 当前对象取 rev）' },
        confirm: {
          type: 'boolean',
          description: '仅 L3（update 改频率/周期/状态）：上一轮返回 needsConfirm 且用户明确同意后传 true 才会执行；不要自行传 true',
        },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: (args, value) => renderHabit(args, value, { timeZone: toolTimeZone(service) }) },
    timeoutMs: 20_000,
    isConcurrencySafe: (args) => HABIT_READ_ACTIONS.includes(args?.action),
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action.trim() : ''
      if (!HABIT_ACTIONS.includes(action)) {
        return failValue('validation_failed', `action 必须是 ${HABIT_ACTIONS.join(' / ')} 之一`)
      }
      try {
        switch (action) {
          case 'list':
            return await runHabitList(service, args)
          case 'get':
            return await runHabitGet(service, args)
          case 'create':
            return await runHabitCreate(service, args, exec)
          case 'update':
            return await runHabitUpdate(service, args, exec)
          case 'checkin':
            return await runHabitCheckin(service, args, exec)
          case 'uncheck':
            return await runHabitUncheck(service, args, exec)
          case 'stats':
            return await runHabitStats(service, args)
          case 'month':
            return await runHabitMonth(service, args)
          default:
            return failValue('validation_failed', `未实现的动作：${action}`)
        }
      } catch (error) {
        return toFailure(error, 'internal', HABIT_ERROR_HINTS)
      }
    },
  }
}

// ── 项目 helpers ─────────────────────────────────────────────────

function normalizeProgress(progress) {
  if (!progress || typeof progress !== 'object') return null
  const mode = firstString(progress.mode, progress.progress_mode, progress.progressMode) ?? null
  const done = pickNumber(progress.done, progress.doneCount, progress.done_count)
  const total = pickNumber(progress.total, progress.totalCount, progress.total_count)
  const pct = pickNumber(progress.pct, progress.percent, progress.percentage)
  const label = firstString(progress.label) ?? null
  if (mode === null && done === null && total === null && pct === null) return null
  return { mode, done, total, pct, label }
}

function formatProgressText(progress) {
  if (!progress) return '—'
  const modeText =
    progress.mode === 'auto_by_tasks'
      ? '（根据任务计算）'
      : progress.mode === 'manual'
        ? '（手动）'
        : progress.mode === 'auto_by_projects'
          ? '（根据项目汇总）'
          : ''
  if (progress.done !== null && progress.done !== undefined && progress.total !== null && progress.total !== undefined) {
    let pctText = ''
    if (progress.pct !== null && progress.pct !== undefined) pctText = `${progress.pct}%`
    else if (progress.total > 0) pctText = `${Math.round((progress.done / progress.total) * 100)}%`
    return `${progress.done}/${progress.total}${pctText ? `（${pctText}）` : ''}${modeText}`
  }
  if (progress.pct !== null && progress.pct !== undefined) return `${progress.pct}%${modeText}`
  return `—${modeText}`
}

function projectStatusLabel(status) {
  return status ? PROJECT_STATUS_LABELS[status] ?? status : '—'
}

function normalizeProject(project) {
  if (!project || typeof project !== 'object') return null
  const id = firstString(project.id, project.projectId, project.project_id)
  const name = firstString(project.name, project.title)
  if (!id && !name) return null
  return {
    id,
    name: name ?? id,
    description: firstString(project.description) ?? null,
    color: firstString(project.color) ?? null,
    status: firstString(project.status) ?? null,
    start_date: firstString(project.start_date, project.startDate) ?? null,
    target_date: firstString(project.target_date, project.targetDate) ?? null,
    progress_mode: firstString(project.progress_mode, project.progressMode) ?? null,
    progress_pct: pickNumber(project.progress_pct, project.progressPct),
    has_tasks: project.has_tasks === true || project.hasTasks === true,
    rev: pickNumber(project.rev),
    progress: normalizeProgress(project.progress),
  }
}

function projectViewOf(result) {
  if (!result || typeof result !== 'object') return null
  if (result.projectView && typeof result.projectView === 'object') return result.projectView
  if (result.project && typeof result.project === 'object') return result.project
  return result
}

function taskStatusDone(task) {
  return task?.status === 'done' || task?.status === 'completed'
}

async function fetchProjectRaw(service, projectId) {
  const method = pickMethodName(service, ['getProject'])
  if (!method) return null
  try {
    const result = await service[method](projectId)
    const raw = projectViewOf(result)
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

async function resolveProjectExpectedRev(service, projectId, args) {
  const explicit = readPositiveInt(args, 'expectedRev', Number.MAX_SAFE_INTEGER)
  if (explicit !== undefined) return explicit
  const current = await fetchProjectRaw(service, projectId)
  if (current && isFiniteNumber(current.rev)) return current.rev
  throw inputError('validation_failed', '缺少 expectedRev 且无法读取项目当前版本；请先 action=get 读取项目再用返回的 rev')
}

function readProjectFields(args, { requireName = false } = {}) {
  const input = {}
  const name = readString(args, 'name')
  if (requireName && !name) throw inputError('validation_failed', 'create 需要 name')
  if (name !== undefined) input.name = name
  if (typeof args?.description === 'string') input.description = args.description
  const color = readString(args, 'color')
  if (color !== undefined) input.color = color
  const startDate = readDateArg(args, 'startDate')
  if (startDate !== undefined) input.startDate = startDate
  const targetDate = readDateArg(args, 'targetDate')
  if (targetDate !== undefined) input.targetDate = targetDate
  const progressMode = readString(args, 'progressMode')
  if (progressMode !== undefined) {
    if (!['auto_by_tasks', 'manual'].includes(progressMode)) {
      throw inputError('validation_failed', 'progressMode 必须是 auto_by_tasks / manual（M4a 仅这两种）')
    }
    input.progressMode = progressMode
  }
  const status = readString(args, 'status')
  if (status !== undefined) {
    if (!PROJECT_STATUSES.includes(status)) {
      throw inputError('validation_failed', `status 必须是 ${PROJECT_STATUSES.join(' / ')} 之一`)
    }
    input.status = status
  }
  return input
}

async function runProjectList(service, args) {
  const method = requireM4Method(service, 'listProjects', '项目')
  const input = {}
  const status = readString(args, 'status')
  if (status !== undefined) {
    if (!PROJECT_STATUSES.includes(status)) throw inputError('validation_failed', `status 必须是 ${PROJECT_STATUSES.join(' / ')} 之一`)
    input.status = status
  }
  const includeArchived = readBoolean(args, 'includeArchived')
  if (includeArchived !== undefined) input.includeArchived = includeArchived
  const result = await service[method](input)
  const items = asArray(result?.items).map(normalizeProject).filter(Boolean)
  return { ok: true, action: 'list', items, status: input.status ?? null }
}

async function loadProjectDetail(service, projectId) {
  const method = requireM4Method(service, 'getProject', '项目')
  const result = await service[method](projectId)
  if (!result) throw inputError('not_found', `项目 ${projectId} 不存在（可能已归档或 id 不对）`)
  const project = normalizeProject(projectViewOf(result))
  if (!project) throw inputError('internal', 'getProject 返回了无法解析的项目')
  const tasks = asArray(result?.tasks)
  const progress = normalizeProgress(result?.progress) ?? project.progress
  return { project, tasks, progress, recentActivityAt: firstString(result?.recentActivityAt, result?.recent_activity_at) ?? null }
}

async function runProjectGet(service, args) {
  const projectId = requireM4Id(args, 'projectId', 'projectId')
  const detail = await loadProjectDetail(service, projectId)
  return {
    ok: true,
    action: 'get',
    projectId,
    project: detail.project,
    tasks: detail.tasks.slice(0, 20),
    taskCount: detail.tasks.length,
    tasksDone: detail.tasks.filter(taskStatusDone).length,
    progress: detail.progress,
    recentActivityAt: detail.recentActivityAt,
  }
}

async function runProjectProgress(service, args) {
  const projectId = requireM4Id(args, 'projectId', 'projectId')
  const detail = await loadProjectDetail(service, projectId)
  return {
    ok: true,
    action: 'progress',
    projectId,
    name: detail.project.name,
    status: detail.project.status,
    progress: detail.progress,
    taskCount: detail.tasks.length,
    tasksDone: detail.tasks.filter(taskStatusDone).length,
  }
}

async function runProjectCreate(service, args, exec) {
  const method = requireM4Method(service, 'createProject', '项目')
  const input = readProjectFields(args, { requireName: true })
  const meta = buildWriteMeta(exec)
  const payload = meta.idempotencyKey ? { ...input, idempotencyKey: meta.idempotencyKey } : input
  const result = await service[method](payload, meta)
  const project = normalizeProject(projectViewOf(result))
  if (!project) throw inputError('internal', 'createProject 未返回项目对象')
  return { ok: true, action: 'create', project, rev: pickNumber(result?.revision, project.rev), changedFields: Object.keys(input) }
}

async function runProjectUpdate(service, args, exec) {
  const method = requireM4Method(service, 'updateProject', '项目')
  const projectId = requireM4Id(args, 'projectId', 'projectId')
  const patch = readProjectFields(args)
  const changedFields = Object.keys(patch)
  if (changedFields.length === 0) {
    throw inputError('validation_failed', 'update 没有可更新字段（可更新 name/description/color/status/startDate/targetDate/progressMode）')
  }
  const current = await fetchProjectRaw(service, projectId)
  const confirm = readBoolean(args, 'confirm') === true
  if (!confirm) {
    const changes = {}
    for (const field of changedFields) changes[field] = { before: current?.[field] ?? null, after: patch[field] }
    return m4Confirm({
      kind: 'project',
      action: 'update',
      id: projectId,
      title: current ? firstString(current.name, current.title) : null,
      changes,
      current,
      message: `这是 L3 操作（需要用户确认）：修改项目生命周期字段（${changedFields.join(' / ')}）。请先展示 before→after；用户明确同意后再次调用并传 confirm:true。`,
    })
  }
  const expectedRev = await resolveProjectExpectedRev(service, projectId, args)
  const result = await service[method](projectId, patch, { expectedRev, ...buildWriteMeta(exec) })
  const project = normalizeProject(projectViewOf(result))
  return {
    ok: true,
    action: 'update',
    projectId,
    project: project ?? { id: projectId, name: patch.name ?? null },
    rev: pickNumber(result?.revision, project?.rev),
    changedFields,
  }
}

async function runProjectArchive(service, args, exec) {
  const method = requireM4Method(service, 'archiveProject', '项目')
  const projectId = requireM4Id(args, 'projectId', 'projectId')
  const current = await fetchProjectRaw(service, projectId)
  if (!current) throw inputError('not_found', `项目 ${projectId} 不存在`)
  const confirm = readBoolean(args, 'confirm') === true
  if (!confirm) {
    return m4Confirm({
      kind: 'project',
      action: 'archive',
      id: projectId,
      title: firstString(current.name, current.title) ?? null,
      changes: { status: { before: current.status ?? 'active', after: 'archived' } },
      current,
      message: '这是 L3 操作（需要用户确认）：归档项目。归档后项目默认不在列表显示，任务与历史仍保留。用户明确同意后再次调用并传 confirm:true。',
    })
  }
  const expectedRev = await resolveProjectExpectedRev(service, projectId, args)
  const result = await service[method](projectId, { expectedRev, ...buildWriteMeta(exec) })
  const project = normalizeProject(projectViewOf(result))
  return { ok: true, action: 'archive', projectId, project: project ?? { id: projectId, status: 'archived' }, rev: pickNumber(result?.revision, project?.rev) }
}

/** `lifeos_project` 的 render。 */
export function renderProject(_args, value, renderContext = {}) {
  const timeZone = renderContext?.timeZone
  if (!value || value.ok !== true) {
    const code = value?.error?.code ?? 'internal'
    const message = value?.error?.message ?? ERROR_HINTS.internal
    const hint = value?.error?.hint ?? ERROR_HINTS.internal
    return textBlocks(`项目操作失败（${code}）：${message} ${hint}`)
  }
  if (value.needsConfirm === true) return textBlocks(renderConfirmPreview('项目', value).join('\n'))

  const action = value.action ?? 'list'
  if (action === 'list') {
    const items = asArray(value.items)
    const lines = [`项目列表：${items.length} 个${value.status ? `（${projectStatusLabel(value.status)}）` : ''}`]
    if (items.length === 0) {
      lines.push('没有符合条件的项目。')
    } else {
      for (const project of items.slice(0, PROJECT_RENDER_LIMIT)) {
        lines.push(
          `- ${project.name ?? project.id}｜${projectStatusLabel(project.status)}｜进度 ${formatProgressText(project.progress)}${idLabel(project.id)}`,
        )
      }
      if (items.length > PROJECT_RENDER_LIMIT) lines.push(`…另有 ${items.length - PROJECT_RENDER_LIMIT} 个，可在 LifeOS 面板查看。`)
    }
    return textBlocks(lines.join('\n'))
  }

  if (action === 'get') {
    const project = value.project ?? {}
    const lines = [`项目详情：${project.name ?? value.projectId ?? '—'}（${project.status ? projectStatusLabel(project.status) : '—'}）`]
    lines.push(`- id：${project.id ?? value.projectId ?? '—'}`)
    lines.push(`- 进度：${formatProgressText(value.progress ?? project.progress)}`)
    lines.push(`- 任务：${value.taskCount ?? 0} 个（已完成 ${value.tasksDone ?? 0}）`)
    if (project.start_date) lines.push(`- 开始日期：${project.start_date}`)
    if (project.target_date) lines.push(`- 目标日期：${project.target_date}`)
    if (project.description) lines.push(`- 描述：${project.description}`)
    if (value.recentActivityAt) lines.push(`- 最近活动：${formatDateTime(value.recentActivityAt, timeZone)}`)
    return textBlocks(lines.join('\n'))
  }

  if (action === 'progress') {
    return textBlocks(
      `项目进度：${value.name ?? value.projectId ?? '—'}｜${formatProgressText(value.progress)}｜任务 ${value.taskCount ?? 0} 个（已完成 ${value.tasksDone ?? 0}）`,
    )
  }

  if (action === 'create') {
    const project = value.project ?? {}
    return textBlocks(`已创建项目「${project.name ?? '—'}」（${project.id ?? '—'}）｜进度 ${formatProgressText(project.progress)}`)
  }

  if (action === 'archive') {
    const project = value.project ?? {}
    return textBlocks(`已归档项目「${project.name ?? value.projectId ?? '—'}」（${project.id ?? value.projectId ?? '—'}）。归档后不再出现在默认列表，任务与历史仍保留。`)
  }

  const project = value.project ?? {}
  const lines = [`已更新项目「${project.name ?? value.projectId ?? '—'}」：${asArray(value.changedFields).join('、') || '无字段变更'}`]
  lines.push(`- 进度：${formatProgressText(project.progress)}`)
  return textBlocks(lines.join('\n'))
}

/** `lifeos_project`：项目生命周期与进度（M4 §6）。 */
export function projectTool(service) {
  return {
    name: 'lifeos_project',
    description: [
      '管理 LifeOS 项目：查看（list/get）、创建、更新、归档（archive）、读取进度（progress）。',
      '权限：list/get/progress 只读（L0）；create 是 L2 直接执行；**update 与 archive 是 L3**——工具不会执行，只返回 needsConfirm + 变更，你必须先展示 before→after，用户明确同意后再传 confirm:true。',
      '何时用：用户说“建个项目/campaign”“把项目暂停/完成/归档”“这个项目做到哪了”“项目进度怎么样”。',
      '何时不用：用户只是记录想法（先 capture）；用户要新增/完成任务（用 lifeos_task）；不要替用户自报或估算进度百分比。',
      '重要：list 返回的每一项都带 id（形如 prj_…），get/update/archive/progress 必须用返回的 id，不要用项目名当 id；项目名判重不区分大小写，create 报“项目已存在”时会同时给出已有项目 id，直接复用而不要重复创建同名项目。项目进度一律“根据任务计算”（done/total），工具只转述服务返回的 progress，不自行估算；任务全部完成不会自动关闭项目；归档只改 status=archived 并保留任务与历史。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: PROJECT_ACTIONS, description: '要执行的动作；list/get/progress 只读，create 为 L2，update/archive 为 L3' },
        projectId: { type: 'string', description: '项目 id（get/update/archive/progress 必填，来自 list/get 返回）' },
        name: { type: 'string', description: 'create 必填；update 可改名' },
        description: { type: 'string', description: '项目描述' },
        color: { type: 'string', description: '项目颜色（如 #4F8EF7）' },
        status: {
          type: 'string',
          enum: PROJECT_STATUSES,
          description: '项目状态 active/paused/completed/cancelled/archived；list 时可按状态筛选；update 改状态属于 L3',
        },
        startDate: { type: 'string', description: '开始日期 YYYY-MM-DD' },
        targetDate: { type: 'string', description: '目标日期 YYYY-MM-DD' },
        progressMode: { type: 'string', enum: ['auto_by_tasks', 'manual'], description: '进度模式：auto_by_tasks（默认，根据任务计算）/ manual' },
        includeArchived: { type: 'boolean', description: 'list 是否包含已归档项目' },
        expectedRev: { type: 'integer', minimum: 1, description: 'CAS 版本（写操作推荐显式传；不传时工具会先 get 当前对象取 rev）' },
        confirm: { type: 'boolean', description: '仅 L3（update/archive）：上一轮返回 needsConfirm 且用户明确同意后传 true 才会执行；不要自行传 true' },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: (args, value) => renderProject(args, value, { timeZone: toolTimeZone(service) }) },
    timeoutMs: 15_000,
    isConcurrencySafe: (args) => ['list', 'get', 'progress'].includes(args?.action),
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action.trim() : ''
      if (!PROJECT_ACTIONS.includes(action)) {
        return failValue('validation_failed', `action 必须是 ${PROJECT_ACTIONS.join(' / ')} 之一`)
      }
      try {
        switch (action) {
          case 'list':
            return await runProjectList(service, args)
          case 'get':
            return await runProjectGet(service, args)
          case 'progress':
            return await runProjectProgress(service, args)
          case 'create':
            return await runProjectCreate(service, args, exec)
          case 'update':
            return await runProjectUpdate(service, args, exec)
          case 'archive':
            return await runProjectArchive(service, args, exec)
          default:
            return failValue('validation_failed', `未实现的动作：${action}`)
        }
      } catch (error) {
        return toFailure(error, 'internal', PROJECT_ERROR_HINTS)
      }
    },
  }
}

// ── 目标 helpers ─────────────────────────────────────────────────

function goalStatusLabel(status) {
  return status ? GOAL_STATUS_LABELS[status] ?? status : '—'
}

function normalizeGoal(goal) {
  if (!goal || typeof goal !== 'object') return null
  const id = firstString(goal.id, goal.goalId, goal.goal_id)
  const title = firstString(goal.title, goal.name)
  if (!id && !title) return null
  return {
    id,
    title: title ?? id,
    description: firstString(goal.description) ?? null,
    success_criteria: firstString(goal.success_criteria, goal.successCriteria) ?? null,
    horizon: firstString(goal.horizon) ?? null,
    status: firstString(goal.status) ?? null,
    start_date: firstString(goal.start_date, goal.startDate) ?? null,
    target_date: firstString(goal.target_date, goal.targetDate) ?? null,
    progress_mode: firstString(goal.progress_mode, goal.progressMode) ?? null,
    progress_pct: pickNumber(goal.progress_pct, goal.progressPct),
    achieved_at: firstString(goal.achieved_at, goal.achievedAt) ?? null,
    abandoned_reason: firstString(goal.abandoned_reason, goal.abandonedReason) ?? null,
    rev: pickNumber(goal.rev),
    progress:
      normalizeProgress(goal.progress) ??
      (goal.progress_pct !== undefined || goal.progressPct !== undefined
        ? { mode: firstString(goal.progress_mode, goal.progressMode) ?? 'manual', done: null, total: null, pct: pickNumber(goal.progress_pct, goal.progressPct), label: null }
        : null),
  }
}

function goalViewOf(result) {
  if (!result || typeof result !== 'object') return null
  if (result.goalView && typeof result.goalView === 'object') return result.goalView
  if (result.goal && typeof result.goal === 'object') return result.goal
  return result
}

function normalizeWish(wish) {
  if (!wish || typeof wish !== 'object') return null
  const id = firstString(wish.id, wish.wishId, wish.wish_id)
  if (!id) return null
  return {
    id,
    title: firstString(wish.title, wish.name) ?? id,
    status: firstString(wish.status) ?? null,
    converted_to_goal_id: firstString(wish.converted_to_goal_id, wish.convertedToGoalId) ?? null,
    rev: pickNumber(wish.rev),
  }
}

async function fetchGoalRaw(service, goalId) {
  const method = pickMethodName(service, ['getGoal'])
  if (!method) return null
  try {
    const result = await service[method](goalId)
    const raw = goalViewOf(result)
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

async function fetchWishRaw(service, wishId) {
  const method = pickMethodName(service, ['getWish'])
  if (!method) return null
  try {
    const result = await service[method](wishId)
    const raw = result?.wish && typeof result.wish === 'object' ? result.wish : result?.wishView && typeof result.wishView === 'object' ? result.wishView : result
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

async function resolveGoalExpectedRev(service, goalId, args) {
  const explicit = readPositiveInt(args, 'expectedRev', Number.MAX_SAFE_INTEGER)
  if (explicit !== undefined) return explicit
  const current = await fetchGoalRaw(service, goalId)
  if (current && isFiniteNumber(current.rev)) return current.rev
  throw inputError('validation_failed', '缺少 expectedRev 且无法读取目标当前版本；请先 action=get 读取目标再用返回的 rev')
}

function readGoalFields(args, { requireTitle = false } = {}) {
  const input = {}
  const title = readString(args, 'title')
  if (requireTitle && !title) throw inputError('validation_failed', 'create 需要 title')
  if (title !== undefined) input.title = title
  if (typeof args?.description === 'string') input.description = args.description
  if (typeof args?.successCriteria === 'string') input.successCriteria = args.successCriteria
  const horizon = readString(args, 'horizon')
  if (horizon !== undefined) {
    if (!GOAL_HORIZONS.includes(horizon)) throw inputError('validation_failed', `horizon 必须是 ${GOAL_HORIZONS.join(' / ')} 之一`)
    input.horizon = horizon
  }
  const status = readString(args, 'status')
  if (status !== undefined) {
    if (!GOAL_STATUSES.includes(status)) throw inputError('validation_failed', `status 必须是 ${GOAL_STATUSES.join(' / ')} 之一`)
    input.status = status
  }
  const startDate = readDateArg(args, 'startDate')
  if (startDate !== undefined) input.startDate = startDate
  const targetDate = readDateArg(args, 'targetDate')
  if (targetDate !== undefined) input.targetDate = targetDate
  const progressMode = readString(args, 'progressMode')
  if (progressMode !== undefined) {
    if (!GOAL_PROGRESS_MODES.includes(progressMode)) {
      throw inputError('validation_failed', `progressMode 必须是 ${GOAL_PROGRESS_MODES.join(' / ')} 之一`)
    }
    input.progressMode = progressMode
  }
  const progressPct = readNumberArg(args, 'progressPct', { min: 0, max: 100 })
  if (progressPct !== undefined) input.progressPct = progressPct
  return input
}

async function runGoalList(service, args) {
  const method = requireM4Method(service, 'listGoals', '目标')
  const input = {}
  const status = readString(args, 'status')
  if (status !== undefined) {
    if (!GOAL_STATUSES.includes(status)) throw inputError('validation_failed', `status 必须是 ${GOAL_STATUSES.join(' / ')} 之一`)
    input.status = status
  }
  const includeArchived = readBoolean(args, 'includeArchived')
  if (includeArchived !== undefined) input.includeArchived = includeArchived
  const result = await service[method](input)
  const items = asArray(result?.items).map(normalizeGoal).filter(Boolean)
  return { ok: true, action: 'list', items, status: input.status ?? null }
}

async function runGoalGet(service, args) {
  const method = requireM4Method(service, 'getGoal', '目标')
  const goalId = requireM4Id(args, 'goalId', 'goalId')
  const result = await service[method](goalId)
  if (!result) throw inputError('not_found', `目标 ${goalId} 不存在（可能已归档或 id 不对）`)
  const goal = normalizeGoal(goalViewOf(result))
  if (!goal) throw inputError('internal', 'getGoal 返回了无法解析的目标')
  const projects = asArray(result?.projects)
  return { ok: true, action: 'get', goalId, goal, projects: projects.slice(0, 20), projectCount: projects.length }
}

async function runGoalCreate(service, args, exec) {
  const method = requireM4Method(service, 'createGoal', '目标')
  const input = readGoalFields(args, { requireTitle: true })
  const confirm = readBoolean(args, 'confirm') === true
  if (!confirm) {
    return m4Confirm({
      kind: 'goal',
      action: 'create',
      proposal: input,
      message: '这是 L3 操作（需要用户确认）：创建目标。请先把目标信息展示给用户；用户明确同意后再次调用并传 confirm:true 才会创建。',
    })
  }
  const meta = buildWriteMeta(exec)
  const payload = meta.idempotencyKey ? { ...input, idempotencyKey: meta.idempotencyKey } : input
  const result = await service[method](payload, meta)
  const goal = normalizeGoal(goalViewOf(result))
  if (!goal) throw inputError('internal', 'createGoal 未返回目标对象')
  return { ok: true, action: 'create', goal, rev: pickNumber(result?.revision, goal.rev), changedFields: Object.keys(input) }
}

async function runGoalUpdate(service, args, exec) {
  const method = requireM4Method(service, 'updateGoal', '目标')
  const goalId = requireM4Id(args, 'goalId', 'goalId')
  const patch = readGoalFields(args)
  const changedFields = Object.keys(patch)
  if (changedFields.length === 0) {
    throw inputError(
      'validation_failed',
      'update 没有可更新字段（可更新 title/description/successCriteria/horizon/status/startDate/targetDate/progressMode/progressPct）',
    )
  }
  const current = await fetchGoalRaw(service, goalId)
  const confirm = readBoolean(args, 'confirm') === true
  if (!confirm) {
    const changes = {}
    for (const field of changedFields) changes[field] = { before: current?.[field] ?? null, after: patch[field] }
    return m4Confirm({
      kind: 'goal',
      action: 'update',
      id: goalId,
      title: current ? firstString(current.title, current.name) : null,
      changes,
      current,
      message: `这是 L3 操作（需要用户确认）：修改目标（${changedFields.join(' / ')}）。请先展示 before→after；用户明确同意后再次调用并传 confirm:true。`,
    })
  }
  const expectedRev = await resolveGoalExpectedRev(service, goalId, args)
  const result = await service[method](goalId, patch, { expectedRev, ...buildWriteMeta(exec) })
  const goal = normalizeGoal(goalViewOf(result)) ?? normalizeGoal(await fetchGoalRaw(service, goalId))
  return {
    ok: true,
    action: 'update',
    goalId,
    goal: goal ?? { id: goalId, title: patch.title ?? null },
    rev: pickNumber(result?.revision, goal?.rev),
    changedFields,
  }
}

async function runGoalConvertWish(service, args, exec) {
  const method = requireM4Method(service, 'convertWish', '目标')
  const wishId = requireM4Id(args, 'wishId', 'wishId')
  const goalInput = readGoalFields(args, { requireTitle: true })
  const confirm = readBoolean(args, 'confirm') === true
  const wish = await fetchWishRaw(service, wishId)

  if (!confirm) {
    const changes = wish ? { status: { before: wish.status ?? 'captured', after: 'committed' } } : {}
    return m4Confirm({
      kind: 'wish',
      action: 'convert_wish',
      id: wishId,
      title: wish ? firstString(wish.title, wish.name) : null,
      changes,
      current: wish,
      proposal: goalInput,
      message: '这是 L3 操作（需要用户确认）：把愿望转化为目标。转化会创建目标并把愿望标为 committed（愿望保留、不可重复转化）。请先展示目标信息；用户明确同意后再次调用并传 confirm:true。',
    })
  }

  let expectedRev = readPositiveInt(args, 'expectedRev', Number.MAX_SAFE_INTEGER)
  if (expectedRev === undefined && wish && isFiniteNumber(wish.rev)) expectedRev = wish.rev
  const options = { goal: goalInput, ...buildWriteMeta(exec) }
  if (expectedRev !== undefined) options.expectedRev = expectedRev
  const result = await service[method](wishId, options)
  return {
    ok: true,
    action: 'convert_wish',
    wishId,
    wish: normalizeWish(result?.wish ?? wish),
    goal: normalizeGoal(result?.goal ?? result?.createdGoal),
    rev: pickNumber(result?.revision),
  }
}

/** `lifeos_goal` 的 render。 */
export function renderGoal(_args, value, renderContext = {}) {
  const timeZone = renderContext?.timeZone
  if (!value || value.ok !== true) {
    const code = value?.error?.code ?? 'internal'
    const message = value?.error?.message ?? ERROR_HINTS.internal
    const hint = value?.error?.hint ?? ERROR_HINTS.internal
    return textBlocks(`目标操作失败（${code}）：${message} ${hint}`)
  }
  if (value.needsConfirm === true) return textBlocks(renderConfirmPreview('目标', value).join('\n'))

  const action = value.action ?? 'list'
  if (action === 'list') {
    const items = asArray(value.items)
    const lines = [`目标列表：${items.length} 个${value.status ? `（${goalStatusLabel(value.status)}）` : ''}`]
    if (items.length === 0) {
      lines.push('没有符合条件的目标。')
    } else {
      for (const goal of items.slice(0, GOAL_RENDER_LIMIT)) {
        const horizon = GOAL_HORIZON_LABELS[goal.horizon] ?? goal.horizon ?? '—'
        lines.push(`- ${goal.title}｜${goalStatusLabel(goal.status)}｜${horizon}｜进度 ${formatProgressText(goal.progress)}${idLabel(goal.id)}`)
      }
      if (items.length > GOAL_RENDER_LIMIT) lines.push(`…另有 ${items.length - GOAL_RENDER_LIMIT} 个，可在 LifeOS 面板查看。`)
    }
    return textBlocks(lines.join('\n'))
  }

  if (action === 'get') {
    const goal = value.goal ?? {}
    const lines = [`目标详情：${goal.title ?? value.goalId ?? '—'}（${goalStatusLabel(goal.status)}）`]
    lines.push(`- id：${goal.id ?? value.goalId ?? '—'}`)
    const horizon = GOAL_HORIZON_LABELS[goal.horizon] ?? goal.horizon
    if (horizon) lines.push(`- 周期：${horizon}`)
    lines.push(`- 进度：${formatProgressText(goal.progress)}${goal.progress_mode === 'auto_by_tasks' ? '（根据任务计算）' : ''}`)
    if (goal.success_criteria) lines.push(`- 成功标准：${goal.success_criteria}`)
    if (goal.start_date) lines.push(`- 开始日期：${goal.start_date}`)
    if (goal.target_date) lines.push(`- 目标日期：${goal.target_date}`)
    if (goal.achieved_at) lines.push(`- 达成时间：${formatDateTime(goal.achieved_at, timeZone)}`)
    if (goal.abandoned_reason) lines.push(`- 放弃原因：${goal.abandoned_reason}`)
    if (value.projectCount) lines.push(`- 关联项目：${value.projectCount} 个`)
    return textBlocks(lines.join('\n'))
  }

  if (action === 'convert_wish') {
    const goal = value.goal ?? {}
    const wish = value.wish ?? {}
    return textBlocks(
      `已把愿望「${wish.title ?? value.wishId ?? '—'}」转化为目标「${goal.title ?? '—'}」（${goal.id ?? '—'}）。愿望已标为 committed 并保留，不可重复转化。`,
    )
  }

  if (action === 'create') {
    const goal = value.goal ?? {}
    return textBlocks(`已创建目标「${goal.title ?? '—'}」（${goal.id ?? '—'}）｜${goalStatusLabel(goal.status)}｜进度 ${formatProgressText(goal.progress)}`)
  }

  const goal = value.goal ?? {}
  const lines = [`已更新目标「${goal.title ?? value.goalId ?? '—'}」：${asArray(value.changedFields).join('、') || '无字段变更'}`]
  lines.push(`- 进度：${formatProgressText(goal.progress)}`)
  return textBlocks(lines.join('\n'))
}

/** `lifeos_goal`：目标与愿望转化（M4 §6）。 */
export function goalTool(service) {
  return {
    name: 'lifeos_goal',
    description: [
      '管理 LifeOS 目标与愿望：查看（list/get）、创建目标（create）、更新目标（update）、把愿望转化为目标（convert_wish）。',
      '权限：list/get 只读（L0）；**create、update、convert_wish 全是 L3**——工具不会执行，只返回 needsConfirm + 待创建/变更内容，你必须先展示给用户；用户明确同意后再传 confirm:true。',
      '何时用：用户说“建个年度目标”“把这个目标改成已达成/放弃”“这个愿望我想认真做了，转成目标”“我有哪些目标”。',
      '何时不用：用户只是说愿望/想法（先 capture 或建 wish，不要擅自建目标）；用户要建项目或任务（用对应工具）。',
      '重要：list 返回的每一项都带 id（形如 gol_…），get/update 必须用返回的 id，不要用标题猜 id；目标进度 auto_by_tasks 时一律“根据任务计算”，不要自报百分比；status=achieved/abandoned 会写时间/原因；愿望转化会创建目标并把愿望标为 committed（愿望保留、不可重复转化）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: GOAL_ACTIONS, description: '要执行的动作；list/get 只读，create/update/convert_wish 为 L3' },
        goalId: { type: 'string', description: '目标 id（get/update 必填，来自 list/get 返回）' },
        wishId: { type: 'string', description: '愿望 id（convert_wish 必填）' },
        title: { type: 'string', description: 'create 必填；update/convert_wish 可改标题' },
        description: { type: 'string', description: '目标描述' },
        successCriteria: { type: 'string', description: '成功标准（可检验的完成定义）' },
        horizon: { type: 'string', enum: GOAL_HORIZONS, description: '目标周期 short/mid/long' },
        status: { type: 'string', enum: GOAL_STATUSES, description: '目标状态 active/paused/achieved/abandoned；list 时可按状态筛选' },
        startDate: { type: 'string', description: '开始日期 YYYY-MM-DD' },
        targetDate: { type: 'string', description: '目标日期 YYYY-MM-DD' },
        progressMode: {
          type: 'string',
          enum: GOAL_PROGRESS_MODES,
          description: '进度模式 manual/auto_by_projects/auto_by_tasks（auto_by_projects 在 M4a 降级为手动）',
        },
        progressPct: { type: 'number', minimum: 0, maximum: 100, description: '手动进度百分比（progressMode=manual 时有效）' },
        includeArchived: { type: 'boolean', description: 'list 是否包含已归档目标' },
        expectedRev: { type: 'integer', minimum: 1, description: 'CAS 版本（写操作推荐显式传；不传时工具会先 get 当前对象取 rev）' },
        confirm: { type: 'boolean', description: '仅 L3（create/update/convert_wish）：上一轮返回 needsConfirm 且用户明确同意后传 true 才会执行；不要自行传 true' },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: (args, value) => renderGoal(args, value, { timeZone: toolTimeZone(service) }) },
    timeoutMs: 20_000,
    isConcurrencySafe: (args) => ['list', 'get'].includes(args?.action),
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action.trim() : ''
      if (!GOAL_ACTIONS.includes(action)) {
        return failValue('validation_failed', `action 必须是 ${GOAL_ACTIONS.join(' / ')} 之一`)
      }
      try {
        switch (action) {
          case 'list':
            return await runGoalList(service, args)
          case 'get':
            return await runGoalGet(service, args)
          case 'create':
            return await runGoalCreate(service, args, exec)
          case 'update':
            return await runGoalUpdate(service, args, exec)
          case 'convert_wish':
            return await runGoalConvertWish(service, args, exec)
          default:
            return failValue('validation_failed', `未实现的动作：${action}`)
        }
      } catch (error) {
        return toFailure(error, 'internal', GOAL_ERROR_HINTS)
      }
    },
  }
}

// ── lifeos_today · include=habits（M4 §6） ───────────────────────

function normalizeTodayHabit(item) {
  if (!item || typeof item !== 'object') return null
  const habitId = firstString(item.habitId, item.habit_id, item.id)
  const name = firstString(item.name, item.title)
  if (!habitId && !name) return null
  return {
    habitId: habitId ?? null,
    name: name ?? habitId,
    frequency_text: firstString(item.frequency_text, item.frequencyText) ?? null,
    today_status: firstString(item.today_status, item.todayStatus, item.status, item.today?.status) ?? null,
    streak: normalizeStreak(item.streak),
  }
}

/** 读今日习惯：优先 A 的 todayHabits()，退化用 getStats() 的 today 字段；都没有返回 null。 */
async function readTodayHabits(service) {
  const todayMethod = pickMethodName(service, ['todayHabits'])
  if (todayMethod) {
    const result = await service[todayMethod]()
    return asArray(result).map(normalizeTodayHabit).filter(Boolean).slice(0, HABIT_TODAY_LIMIT)
  }
  const statsMethod = pickMethodName(service, ['getHabitStats', 'getStats'])
  if (statsMethod) {
    const result = await service[statsMethod]({})
    return asArray(result?.habits).map(normalizeTodayHabit).filter(Boolean).slice(0, HABIT_TODAY_LIMIT)
  }
  return null
}

function readTodayInclude(args) {
  const raw = args?.include
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw inputError('validation_failed', 'include 必须是字符串数组，目前只支持 ["habits"]')
  const include = []
  for (const item of raw) {
    if (typeof item !== 'string') throw inputError('validation_failed', 'include 里的值必须是字符串')
    const value = item.trim()
    if (!value) continue
    if (value !== 'habits') throw inputError('validation_failed', 'include 目前只支持 "habits"')
    if (!include.includes(value)) include.push(value)
  }
  return include
}

// ════════════════════════════════════════════════════════════════
// 注册（含 P0 隔离）
// ════════════════════════════════════════════════════════════════

/** 当前暴露给模型的工具名（单一来源见 tool-names.js）；顺序即注册顺序。 */
export const TOOL_NAMES = LIFEOS_TOOL_NAMES

/** L3 动作名（测试与文档用）。 */
export const TASK_CONFIRM_ACTIONS = [...TASK_L3_ACTIONS, 'update:due', 'correct:always']

/** P0（M2-PLAN §1 第 1 层）：注册层 `when` 门控，非 lifeos preset 会话不可见。 */
export function lifeosToolOptions() {
  return { when: (activation) => isLifeosAgent(activation?.agent) }
}

/**
 * 注册全部 LifeOS 工具，返回 disposer（由调用方用 `ctx.effect` 持有）。
 * - 每个工具都带 `{ when: isLifeosAgent }`，实现 P0 工具隔离（M2-G1 第一层）；
 * - 单个工具注册失败不拖垮其它工具（M0 热修结论 3）；失败写 stderr 供诊断。
 */
export function registerTools(ctx, service) {
  const disposers = []
  const definitions = [
    todayTool(service),
    captureTool(service),
    taskTool(service),
    triageTool(service),
    correctTool(service),
    notesTool(service),
    settingsTool(service),
    habitTool(service),
    projectTool(service),
    goalTool(service),
  ]
  for (const definition of definitions) {
    try {
      const dispose = ctx.tools.register(definition, lifeosToolOptions())
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      console.warn(`[lifeos-agent] 注册工具 ${definition.name} 失败：${error?.message ?? error}`)
    }
  }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        /* 卸载期忽略单个 disposer 异常 */
      }
    }
  }
}
