/**
 * B：M3 主动建议服务（M3-PLAN §4 / design 08 §3.3-3.4）。
 *
 * 规则化生成（不依赖模型；文案固定模板，Host 不生成 routine 简报正文）：
 *  1. overdue_cleanup：存在逾期未完成任务；
 *  2. inbox_backlog：待整理 raw ≥ 3；
 *  3. habit_streak_risk：有习惯数据且最近一条打卡 ≤ 今天-2（中断 ≥2 天）；
 *  4. journal_morning：本地时间 > 10:00 且今天还没有任何记录。
 *
 * 约束：
 *  - 同类同日 ≤1（dedupe_key 唯一）；总预算 maxPerDay（来自 app_setting['automation'].suggestions.maxPerDay）；
 *  - 生成时同时写 `assistant_suggestion` + `operation_log` + `notification_outbox`（kind=coach_nudge, source_type=suggestion，计入预算）；
 *  - act：accept / dismiss（7 天内同类降权）/ snooze（到期重现）；
 *  - 表字段严格遵循 design/08：suggestion.status 用 proposed/accepted/rejected/expired，
 *    对客户端暴露视图状态 pending / snoozed / accepted / dismissed / expired。
 *
 * 零第三方依赖；只用 store.get/entries/transaction。
 */

import { LifeosError } from './errors.js';
import { newId as defaultNewId } from '../domain/ids.js';

const CORE = 'lifeos';
const LOG = 'lifeos_log';

export const SUGGESTION_RULES = Object.freeze(['overdue_cleanup', 'inbox_backlog', 'habit_streak_risk', 'journal_morning']);

const RULE_META = Object.freeze({
  overdue_cleanup: {
    suggestion_type: 'nudge',
    title: '有任务已逾期',
    buildBody: (data) => `有 ${data.overdueCount} 个任务已逾期，要不要今天处理掉？`,
    action: { id: 'open_todo', label: '查看待办', kind: 'navigate', target: 'todo' },
    priority: 'P2',
  },
  inbox_backlog: {
    suggestion_type: 'nudge',
    title: '待整理积压',
    buildBody: (data) => `待整理 ${data.inboxPending} 条，我可以在晚上帮你整理。`,
    action: { id: 'open_triage', label: '去整理', kind: 'navigate', target: 'triage' },
    priority: 'P2',
  },
  habit_streak_risk: {
    suggestion_type: 'nudge',
    title: '习惯快中断了',
    buildBody: (data) => `${data.habitName ? `「${data.habitName}」` : '有习惯'}已经 ${data.gapDays} 天没打卡，今天补一次吗？`,
    action: { id: 'open_today', label: '去打卡', kind: 'navigate', target: 'today' },
    priority: 'P2',
  },
  journal_morning: {
    suggestion_type: 'coach',
    title: '今天还没写晨记',
    buildBody: () => '已经过了 10 点，今天还没有记录。要不要让 Agent 起个晨记草稿？',
    action: { id: 'open_chat', label: '让 Agent 起草', kind: 'command', target: 'lifeos:journal-draft' },
    priority: 'P1',
  },
});

const RAW_PENDING = ['pending', 'processing', 'partial'];
const TASK_ACTIVE = ['todo', 'doing', 'in_progress'];
const DEFAULT_MAX_PER_DAY = 2;
const DISMISS_COOLDOWN_DAYS = 7;
const SNOOZE_DEFAULT_MINUTES = 60;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function localDateOfIso(isoValue, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(isoValue));
    const pick = (type) => parts.find((part) => part.type === type)?.value;
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
  } catch {
    return String(isoValue || '').slice(0, 10);
  }
}

function localTimeOfIso(isoValue, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(isoValue));
    const pick = (type) => parts.find((part) => part.type === type)?.value;
    return `${pick('hour')}:${pick('minute')}`;
  } catch {
    return '00:00';
  }
}

function addMinutesIso(baseIso, minutes) {
  return new Date(Date.parse(baseIso) + minutes * 60000).toISOString();
}

function addDaysIso(baseIso, days) {
  return new Date(Date.parse(baseIso) + days * 86400000).toISOString();
}

function dateOnlyMinusDays(localDate, days) {
  const base = Date.parse(`${localDate}T00:00:00Z`);
  return new Date(base - days * 86400000).toISOString().slice(0, 10);
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {(prefix?:string)=>string} [deps.newId]
 * @param {()=>number} [deps.now]
 * @param {string} [deps.timeZone]
 * @param {(type:string, ids:string[], meta?:object)=>void} [deps.emitChanged]
 * @param {{warn?:Function,error?:Function}} [deps.logger]
 */
export function createSuggestionService(deps = {}) {
  const store = deps.store;
  if (!store || typeof store.entries !== 'function') {
    throw new LifeosError('store_unavailable', 'createSuggestionService 需要已打开的 store');
  }
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const timeZone = deps.timeZone || 'Asia/Shanghai';
  const logger = deps.logger || { warn() {}, error() {} };
  const emitChanged = typeof deps.emitChanged === 'function' ? deps.emitChanged : () => {};

  // 兜底必须产出合法 ID（sug_ + 26 位 Crockford Base32），否则真实 store 校验会拒绝。
  const newId = typeof deps.newId === 'function' ? deps.newId : (prefix = 'sug') => defaultNewId(prefix);

  const isoNow = () => iso(now());
  const todayLocal = () => localDateOfIso(isoNow(), timeZone);

  function entries(unit, table) {
    try {
      return store.entries(unit, table);
    } catch {
      return [];
    }
  }

  function records(table, unit = CORE) {
    return entries(unit, table).map(([, record]) => record).filter((record) => record && !record.deleted_at);
  }

  function assertWritable() {
    if (store.degraded === true) throw new LifeosError('store_unavailable', '存储不可用（只读降级）');
  }

  /* ───────── 设置（单一真源 app_setting['automation']）───────── */

  const DEFAULT_AUTOMATION = Object.freeze({
    morningBrief: { enabled: true, time: '07:35' },
    eveningReview: { enabled: false, time: '21:00' },
    habitNudge: { enabled: false, time: '20:30' },
    nightlyInbox: { enabled: true, time: '21:30' },
    deadlineReminder: { enabled: true, leadMinutes: 60, dueDateAt: '09:00' },
    dnd: { start: '22:45', end: '07:30' },
    dailyBudget: 2,
    suggestions: { enabled: true, maxPerDay: DEFAULT_MAX_PER_DAY },
  });

  function readAutomationSetting() {
    try {
      const record = store.get(CORE, 'app_setting', 'automation');
      const value = record && (record.value_json ?? record.value);
      if (isPlainObject(value)) {
        return {
          ...DEFAULT_AUTOMATION,
          ...value,
          suggestions: { ...DEFAULT_AUTOMATION.suggestions, ...(isPlainObject(value.suggestions) ? value.suggestions : {}) },
          dnd: { ...DEFAULT_AUTOMATION.dnd, ...(isPlainObject(value.dnd) ? value.dnd : {}) },
        };
      }
    } catch {
      /* ignore */
    }
    // M2 兼容：旧 automation.inbox_nightly → 映射到 nightlyInbox
    try {
      const legacy = store.get(CORE, 'app_setting', 'automation.inbox_nightly');
      const legacyValue = legacy && (legacy.value_json ?? legacy.value);
      if (isPlainObject(legacyValue)) {
        return {
          ...DEFAULT_AUTOMATION,
          nightlyInbox: {
            enabled: legacyValue.enabled !== false,
            time: typeof legacyValue.time === 'string' ? legacyValue.time : '21:30',
          },
        };
      }
    } catch {
      /* ignore */
    }
    return { ...DEFAULT_AUTOMATION, suggestions: { ...DEFAULT_AUTOMATION.suggestions } };
  }

  /* ───────── 记录构造 ───────── */

  function baseRecord(fields, prefix = 'sug') {
    const nowIso = isoNow();
    return {
      id: newId(prefix),
      created_at: nowIso,
      updated_at: nowIso,
      deleted_at: null,
      rev: 1,
      schema_version: 1,
      meta_json: null,
      origin_type: fields.origin_type || 'agent_inference',
      origin_ref: fields.origin_ref || null,
      confirmation_status: fields.confirmation_status || 'not_required',
      ...fields,
    };
  }

  function oplog(fields) {
    return baseRecord({
      actor_type: 'system',
      actor_ref: null,
      action: fields.action,
      occurred_at: isoNow(),
      target_type: fields.target_type,
      target_id: fields.target_id,
      target_ids_json: fields.target_id ? [fields.target_id] : [],
      permission_id: null,
      permission_level: 'L2',
      decision: 'allowed',
      status: fields.status || 'applied',
      before_json: fields.before ?? null,
      after_json: fields.after ?? null,
      diff_json: null,
      state_change_ids: null,
      evidence_refs: [],
      undo_of_id: null,
      reversible: true,
      undo_patch_json: null,
    }, 'opl');
  }

  function suggestionRecord(rule, localDate, data, nowIso) {
    const meta = RULE_META[rule];
    const dedupeKey = `suggestion:${rule}:${localDate}`;
    return baseRecord({
      suggestion_type: meta.suggestion_type,
      trigger_source: 'schedule',
      topic_key: `suggestion:${rule}`,
      dedupe_key: dedupeKey,
      session_id: null,
      message_id: null,
      context_snapshot: { now: nowIso, localDate, rule, ...data },
      problem_tags: [],
      options: [],
      chosen_index: null,
      theory_tags: [],
      status: 'proposed',
      expected_signal: { type: 'user_statement' },
      evidence_refs: [],
      outcome: null,
      user_feedback_text: null,
      user_rating: null,
      proposed_at: nowIso,
      accepted_at: null,
      follow_up_at: null,
      reviewed_at: null,
      cooldown_until: null,
      parent_suggestion_id: null,
      origin_ref: { rule, local_date: localDate },
      meta_json: { ruleType: rule, title: meta.title, body: meta.buildBody(data), action: meta.action },
    });
  }

  function outboxRecord(suggestion, rule, nowIso) {
    const meta = RULE_META[rule];
    return baseRecord({
      kind: 'coach_nudge',
      title: String(meta.title).slice(0, 60),
      body: String(suggestion.meta_json.body).slice(0, 150),
      action_json: [meta.action],
      priority: meta.priority,
      dedupe_key: `coach_nudge:${suggestion.dedupe_key}`,
      status: 'pending',
      channel: 'in_app',
      source_type: 'suggestion',
      source_id: suggestion.id,
      session_id: null,
      attempt_count: 0,
      last_error: null,
      delivered_at: null,
      read_at: null,
      replied_at: null,
      dismissed_at: null,
      expired_at: null,
      expires_at: addDaysIso(nowIso, 1),
      origin_ref: { suggestion_id: suggestion.id },
      meta_json: { suggestionId: suggestion.id, ruleType: rule },
    }, 'notif');
  }

  /* ───────── 规则评估 ───────── */

  function activeTasks() {
    return records('task').filter((task) => TASK_ACTIVE.includes(task.status || 'todo'));
  }

  function evaluateRules(localDate, nowIso) {
    const results = [];
    const tasks = activeTasks();
    const overdue = tasks.filter((task) => {
      const due = task.due_at || task.due_date;
      if (!due) return false;
      if (typeof due !== 'string') return false;
      if (due.length === 10) return due < localDate;
      return Date.parse(due) < now();
    });
    if (overdue.length > 0) results.push({ rule: 'overdue_cleanup', data: { overdueCount: overdue.length } });

    const inboxPending = records('raw_record', 'lifeos_raw').filter(
      (record) => RAW_PENDING.includes(record.processing_status) || record.processing_status === undefined,
    ).length;
    if (inboxPending >= 3) results.push({ rule: 'inbox_backlog', data: { inboxPending } });

    const habits = records('habit');
    if (habits.length > 0) {
      const checkins = records('habit_checkin');
      let worst = null;
      for (const habit of habits) {
        if (habit.archived_at || habit.deleted_at) continue;
        const latest = checkins
          .filter((checkin) => (checkin.habit_id || checkin.habit_key) === habit.id && (checkin.status || 'done') !== 'skipped')
          .map((checkin) => checkin.local_date || localDateOfIso(checkin.created_at, timeZone))
          .sort()
          .pop();
        const reference = latest || localDateOfIso(habit.created_at, timeZone) || localDate;
        const gapDays = Math.round((Date.parse(`${localDate}T00:00:00Z`) - Date.parse(`${reference}T00:00:00Z`)) / 86400000);
        if (gapDays >= 2 && (!worst || gapDays > worst.gapDays)) {
          worst = { habitName: habit.name || habit.title || null, gapDays, habitId: habit.id };
        }
      }
      if (worst) results.push({ rule: 'habit_streak_risk', data: worst });
    }

    const [hour, minute] = localTimeOfIso(nowIso, timeZone).split(':').map(Number);
    const afterTen = hour > 10 || (hour === 10 && minute >= 0);
    if (afterTen) {
      const todayRecords = records('raw_record', 'lifeos_raw').filter(
        (record) => localDateOfIso(record.created_at, timeZone) === localDate,
      );
      if (todayRecords.length === 0) results.push({ rule: 'journal_morning', data: {} });
    }
    return results;
  }

  function suggestionViews() {
    return records('assistant_suggestion');
  }

  function viewStatus(suggestion, nowMs) {
    if (suggestion.status === 'accepted') return 'accepted';
    if (suggestion.status === 'rejected') return 'dismissed';
    if (suggestion.status === 'expired') return 'expired';
    const snoozeUntil = suggestion.meta_json && suggestion.meta_json.snooze_until;
    if (snoozeUntil && Date.parse(snoozeUntil) > nowMs) return 'snoozed';
    return 'pending';
  }

  function toView(suggestion) {
    const nowMs = now();
    const meta = isPlainObject(suggestion.meta_json) ? suggestion.meta_json : {};
    const snoozeUntil = typeof meta.snooze_until === 'string' && Date.parse(meta.snooze_until) > nowMs ? meta.snooze_until : null;
    return {
      id: suggestion.id,
      ruleType: meta.ruleType || (suggestion.origin_ref && suggestion.origin_ref.rule) || null,
      title: meta.title || suggestion.topic_key,
      body: meta.body || '',
      status: viewStatus(suggestion, nowMs),
      action: meta.action || null,
      snoozeUntil,
      createdAt: suggestion.created_at,
      proposedAt: suggestion.proposed_at,
      acceptedAt: suggestion.accepted_at || null,
      cooldownUntil: suggestion.cooldown_until || null,
    };
  }

  function todaySuggestions(localDate) {
    return suggestionViews().filter(
      (suggestion) => localDateOfIso(suggestion.proposed_at || suggestion.created_at, timeZone) === localDate,
    );
  }

  function isSuppressed(rule, localDate) {
    const dedupeKey = `suggestion:${rule}:${localDate}`;
    if (suggestionViews().some((suggestion) => suggestion.dedupe_key === dedupeKey)) return true;
    const nowMs = now();
    return suggestionViews().some((suggestion) => {
      if ((suggestion.origin_ref && suggestion.origin_ref.rule) !== rule) return false;
      if (suggestion.status !== 'rejected') return false;
      return suggestion.cooldown_until && Date.parse(suggestion.cooldown_until) > nowMs;
    });
  }

  /* ───────── 公共 API ───────── */

  /** 幂等生成：同类同日 ≤1、预算 maxPerDay、7 天降权。 */
  async function generate(input = {}) {
    assertWritable();
    const nowMs = Number.isFinite(input.now) ? input.now : now();
    const nowIso = iso(nowMs);
    const localDate = input.localDate || localDateOfIso(nowIso, timeZone);
    const setting = readAutomationSetting();
    const suggestionsConfig = isPlainObject(setting.suggestions) ? setting.suggestions : {};
    if (suggestionsConfig.enabled === false) {
      return { localDate, generated: [], skipped: 'disabled', counts: { budget: 0 } };
    }
    const maxPerDay = Math.min(Math.max(Number(suggestionsConfig.maxPerDay ?? DEFAULT_MAX_PER_DAY), 0), 5);
    const alreadyToday = todaySuggestions(localDate).length;
    let budgetLeft = Math.max(maxPerDay - alreadyToday, 0);
    const generated = [];
    const skipped = [];
    for (const item of evaluateRules(localDate, nowIso)) {
      if (budgetLeft <= 0) {
        skipped.push({ rule: item.rule, reason: 'budget' });
        continue;
      }
      if (isSuppressed(item.rule, localDate)) {
        skipped.push({ rule: item.rule, reason: 'dedupe_or_cooldown' });
        continue;
      }
      const suggestion = suggestionRecord(item.rule, localDate, item.data, nowIso);
      const notification = outboxRecord(suggestion, item.rule, nowIso);
      const log = oplog({
        action: 'suggestion.generate',
        target_type: 'assistant_suggestion',
        target_id: suggestion.id,
        after: { rule: item.rule, localDate, dedupeKey: suggestion.dedupe_key },
      });
      await store.transaction([
        { unit: CORE, table: 'assistant_suggestion', key: suggestion.id, value: suggestion },
        { unit: CORE, table: 'notification_outbox', key: notification.id, value: notification },
        { unit: LOG, table: 'operation_log', key: log.id, value: log },
      ]);
      budgetLeft -= 1;
      generated.push(toView(suggestion));
      try {
        emitChanged('suggestion', [suggestion.id], { action: 'create', rule: item.rule });
        emitChanged('notification', [notification.id], { action: 'create', kind: 'coach_nudge' });
      } catch (error) {
        logger.warn?.(`suggestion emit 失败：${error?.message || error}`);
      }
    }
    return {
      localDate,
      generated,
      skipped,
      counts: { generated: generated.length, budget: maxPerDay, usedToday: alreadyToday + generated.length, maxPerDay },
    };
  }

  function list(input = {}) {
    const status = typeof input.status === 'string' && input.status.length > 0 ? input.status : 'pending';
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
    const items = suggestionViews()
      .map(toView)
      .filter((suggestion) => (status === 'all' ? true : suggestion.status === status))
      .sort((a, b) => String(b.proposedAt ?? '').localeCompare(String(a.proposedAt ?? '')));
    return { items: items.slice(0, limit), counts: { [status]: items.length, total: items.length } };
  }

  async function act(id, input = {}) {
    assertWritable();
    if (typeof id !== 'string' || id.length === 0) throw new LifeosError('validation_failed', 'id 必填');
    const action = input.action;
    if (!['accept', 'dismiss', 'snooze'].includes(action)) {
      throw new LifeosError('validation_failed', 'action 必须为 accept/dismiss/snooze', { action });
    }
    const suggestion = records('assistant_suggestion').find((record) => record.id === id);
    if (!suggestion) throw new LifeosError('not_found', `建议不存在：${id}`, { id });
    const nowIso = isoNow();
    const meta = isPlainObject(suggestion.meta_json) ? { ...suggestion.meta_json } : {};
    const next = { ...suggestion, updated_at: nowIso, rev: (suggestion.rev ?? 1) + 1, meta_json: meta };
    if (action === 'accept') {
      next.status = 'accepted';
      next.accepted_at = nowIso;
      next.follow_up_at = addDaysIso(nowIso, 2);
      next.cooldown_until = null;
    } else if (action === 'dismiss') {
      next.status = 'rejected';
      next.cooldown_until = addDaysIso(nowIso, DISMISS_COOLDOWN_DAYS);
      meta.dismissed_at = nowIso;
    } else {
      const snoozeMinutes = Math.min(Math.max(Number(input.snoozeMinutes) || SNOOZE_DEFAULT_MINUTES, 5), 1440);
      next.status = 'proposed';
      meta.snooze_until = addMinutesIso(nowIso, snoozeMinutes);
      meta.snooze_minutes = snoozeMinutes;
    }
    const log = oplog({
      action: `suggestion.${action}`,
      target_type: 'assistant_suggestion',
      target_id: suggestion.id,
      before: { status: suggestion.status },
      after: { status: next.status, action },
    });
    await store.transaction([
      { unit: CORE, table: 'assistant_suggestion', key: suggestion.id, value: next },
      { unit: LOG, table: 'operation_log', key: log.id, value: log },
    ]);
    try {
      emitChanged('suggestion', [suggestion.id], { action });
    } catch {
      /* ignore */
    }
    return { suggestion: toView(next), action };
  }

  function listNotifications(input = {}) {
    const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 50);
    const status = typeof input.status === 'string' && input.status.length > 0 ? input.status : null;
    const items = records('notification_outbox')
      .filter((notification) => (status ? notification.status === status : true))
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
      .slice(0, limit)
      .map((notification) => ({
        id: notification.id,
        kind: notification.kind,
        title: notification.title,
        body: notification.body,
        priority: notification.priority,
        status: notification.status,
        channel: notification.channel,
        sourceType: notification.source_type || null,
        sourceId: notification.source_id || null,
        actions: Array.isArray(notification.action_json) ? notification.action_json : [],
        createdAt: notification.created_at,
        readAt: notification.read_at || null,
        expiresAt: notification.expires_at || null,
      }));
    return {
      items,
      unread: records('notification_outbox').filter((notification) => notification.status !== 'expired' && !notification.read_at).length,
    };
  }

  async function markRead(notificationId) {
    assertWritable();
    const notification = records('notification_outbox').find((record) => record.id === notificationId);
    if (!notification) throw new LifeosError('not_found', `通知不存在：${notificationId}`, { id: notificationId });
    const nowIso = isoNow();
    const next = {
      ...notification,
      status: notification.status === 'pending' ? 'delivered' : notification.status,
      delivered_at: notification.delivered_at || nowIso,
      read_at: notification.read_at || nowIso,
      updated_at: nowIso,
      rev: (notification.rev ?? 1) + 1,
    };
    const log = oplog({
      action: 'notification.read',
      target_type: 'notification_outbox',
      target_id: notificationId,
      before: { read_at: notification.read_at ?? null },
      after: { read_at: next.read_at },
    });
    await store.transaction([
      { unit: CORE, table: 'notification_outbox', key: notificationId, value: next },
      { unit: LOG, table: 'operation_log', key: log.id, value: log },
    ]);
    try {
      emitChanged('notification', [notificationId], { action: 'read' });
    } catch {
      /* ignore */
    }
    return { id: notificationId, readAt: next.read_at, status: next.status };
  }

  function status() {
    const localDate = todayLocal();
    const all = suggestionViews();
    const pending = all.map(toView).filter((suggestion) => suggestion.status === 'pending').length;
    return {
      localDate,
      pending,
      snoozed: all.map(toView).filter((suggestion) => suggestion.status === 'snoozed').length,
      todayGenerated: todaySuggestions(localDate).length,
      maxPerDay: Math.min(Math.max(Number(readAutomationSetting().suggestions?.maxPerDay ?? DEFAULT_MAX_PER_DAY), 0), 5),
      unreadNotifications: records('notification_outbox').filter((notification) => !notification.read_at && notification.status !== 'expired').length,
    };
  }

  return {
    generate,
    list,
    act,
    listNotifications,
    markRead,
    status,
    readAutomationSetting,
    evaluateRules,
    _viewStatus: viewStatus,
    DEFAULT_AUTOMATION,
  };
}

export default createSuggestionService;
