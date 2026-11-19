/**
 * B：M2 定时整理调度（M2-PLAN §3.3）。
 *
 * 职责：维护**恰好一条** `inbox_nightly` 宿主 schedule（幂等对账），配置存
 * `app_setting['automation.inbox_nightly']`（含 scheduleId + enabled + time）。
 *
 * 约束：
 *  - 不自建调度器；全部委托宿主 `ctx.schedule`（01 §1.4）；
 *  - 幂等：先查 app_setting.scheduleId → `schedule.view` 校验，失效（被删/归档）则重建；
 *    无 scheduleId 时按 title 收养已有任务，避免重复创建；
 *  - 关闭 = `schedule.edit({active:false})`，不删除（保留历史）；
 *  - 插件卸载不删除 schedule（宿主持久；下次 apply 对账恢复）。
 */

import { addDays } from '../domain/time.js';
import { newId } from '../domain/ids.js';

export const NIGHTLY_KEY = 'automation.inbox_nightly';
export const SCHEDULE_TITLE = 'LifeOS · 夜间整理';
export const DEFAULT_TIME = '21:30';
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

function getService(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(name);
    return ctx ? ctx[name] : undefined;
  } catch {
    return undefined;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 夜间整理 prompt（M2-PLAN §3.3：读今日待整理 → triage(begin) → 候选 → commit；无内容结束）。 */
export function buildNightlyPrompt(localDate, timeZone = DEFAULT_TIME_ZONE) {
  return [
    `[LifeOS 夜间整理] 日期 ${localDate}（时区 ${timeZone}）。`,
    '1) 先调用 lifeos_triage 的 begin（scope=pending，runKey=`inbox_nightly:' + localDate + '`）。',
    '2) 若返回 pending 为空或 alreadyDone，直接回复一句「今晚没有需要整理的记录」并结束，不要编造。',
    '3) 否则只依据返回的原文抽取候选（kind: task/event/metric/habit_checkin/wish/ignore），每个候选必须带原文子串作为 source.quote；拿不准就标 requiresConfirm 或不产出。',
    '4) 调用 lifeos_triage 的 commit 提交候选（不直接写业务事实），然后回复一句中文摘要（候选数/需确认数）。',
    '5) 不要修改原始记录；不要删除任何对象；不要发送额外消息。',
  ].join('\n');
}

function nightlyCron(time) {
  const [hour, minute] = String(time || DEFAULT_TIME).split(':').map((part) => Number(part));
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { expression: '30 21 * * *', time_zone: DEFAULT_TIME_ZONE };
  }
  return { expression: `${minute} ${hour} * * *`, time_zone: DEFAULT_TIME_ZONE };
}

/**
 * @param {object} deps
 * @param {object} deps.ctx Cordis 插件上下文（只读 get）
 * @param {object} deps.store LifeosStore
 * @param {object} [deps.config]
 * @param {object} [deps.diagnostics]
 * @param {()=>number} [deps.now]
 */
export function createScheduler(deps) {
  const { ctx, store } = deps;
  const config = deps.config || {};
  const diagnostics = deps.diagnostics || null;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const timeZone = config.timeZone || DEFAULT_TIME_ZONE;
  const schedule = deps.schedule || getService(ctx, 'schedule');
  const actorSessionId = deps.actorSessionId || null;
  const last = {
    at: null,
    status: 'never',
    created: false,
    adopted: false,
    repaired: false,
    error: null,
    scheduleId: null,
  };

  function isoNow() {
    return new Date(now()).toISOString();
  }

  function localDateOfNow() {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date(now()));
      const pick = (type) => parts.find((part) => part.type === type)?.value;
      return `${pick('year')}-${pick('month')}-${pick('day')}`;
    } catch {
      return new Date(now()).toISOString().slice(0, 10);
    }
  }

  function readSetting() {
    try {
      const record = store.get('lifeos', 'app_setting', NIGHTLY_KEY);
      if (!record) return null;
      if (isPlainObject(record.value_json)) return { ...record.value_json };
      if (isPlainObject(record.value)) return { ...record.value };
      return null;
    } catch {
      return null;
    }
  }

  function writeSetting(value) {
    const record = {
      key: NIGHTLY_KEY,
      id: NIGHTLY_KEY,
      value_json: value,
      updated_at: isoNow(),
    };
    return store.transaction([{ unit: 'lifeos', table: 'app_setting', key: NIGHTLY_KEY, value: record }]);
  }

  function normalizeSetting(raw) {
    const value = isPlainObject(raw) ? raw : {};
    return {
      enabled: value.enabled !== false,
      time: typeof value.time === 'string' && /^\d{2}:\d{2}$/.test(value.time) ? value.time : DEFAULT_TIME,
      timeZone: typeof value.timeZone === 'string' ? value.timeZone : timeZone,
      scheduleId: typeof value.scheduleId === 'string' ? value.scheduleId : null,
      lastReconciledAt: typeof value.lastReconciledAt === 'string' ? value.lastReconciledAt : null,
      lastRunAt: typeof value.lastRunAt === 'string' ? value.lastRunAt : null,
    };
  }

  async function safeView(scheduleId) {
    if (!schedule || typeof schedule.view !== 'function' || !scheduleId) return null;
    try {
      return await schedule.view({ id: scheduleId });
    } catch {
      return null;
    }
  }

  async function safeCatalog() {
    if (!schedule) return [];
    try {
      if (typeof schedule.catalog === 'function') return (await schedule.catalog()) || [];
      if (typeof schedule.list === 'function') {
        const listed = await schedule.list({});
        return Array.isArray(listed) ? listed : listed?.items || [];
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  function targetOf() {
    return { kind: 'new', create: { agentPreset: 'lifeos' } };
  }

  async function createSchedule(setting) {
    const request = {
      title: SCHEDULE_TITLE,
      prompt: buildNightlyPrompt(localDateOfNow(), setting.timeZone),
      timing: { kind: 'cron', cron: nightlyCron(setting.time) },
      target: targetOf(),
    };
    const created = await schedule.create(request, actorSessionId || undefined);
    const scheduleId =
      (created && (created.id || created.record?.id || created.scheduleId)) ||
      (created && created.catalogEntry && created.catalogEntry.id) ||
      null;
    if (!scheduleId) throw new Error('schedule.create 未返回 id');
    return { scheduleId, created };
  }

  /**
   * 对账：确保恰好一条 inbox_nightly（enabled=true → active；false → 暂停）。
   * @returns {Promise<object>} automation 视图
   */
  async function ensureNightlySchedule() {
    last.at = isoNow();
    last.created = false;
    last.adopted = false;
    last.repaired = false;
    last.error = null;
    let setting = normalizeSetting(readSetting());
    if (!schedule) {
      last.status = 'schedule-unavailable';
      last.error = '宿主 schedule 服务不可用';
      diagnostics?.recordError?.('schedule_unavailable', '夜间整理：宿主 schedule 服务不可用');
      return { ...setting, schedule: null, reconcile: { ...last } };
    }
    if (!setting.enabled) {
      if (setting.scheduleId) {
        try {
          await schedule.edit({ id: setting.scheduleId, action: 'update', patch: { active: false } }, actorSessionId || undefined);
        } catch (error) {
          last.error = String(error?.message || error);
          diagnostics?.recordError?.('schedule_pause_failed', `暂停夜间整理失败：${last.error}`);
        }
      }
      setting = normalizeSetting({ ...setting, lastReconciledAt: isoNow() });
      await writeSetting(setting).catch(() => {});
      last.status = 'paused';
      last.scheduleId = setting.scheduleId;
      return { ...setting, schedule: await safeView(setting.scheduleId), reconcile: { ...last } };
    }

    // 已有 scheduleId：校验存在性 + active 状态
    if (setting.scheduleId) {
      const view = await safeView(setting.scheduleId);
      if (view) {
        const status = String(view.status || view.record?.status || 'active');
        if (status === 'ended' || status === 'deleted') {
          last.repaired = true;
        } else {
          if (status === 'paused') {
            try {
              await schedule.edit({ id: setting.scheduleId, action: 'update', patch: { active: true } }, actorSessionId || undefined);
            } catch {
              /* 下次再试 */
            }
          }
          setting = normalizeSetting({ ...setting, lastReconciledAt: isoNow() });
          await writeSetting(setting).catch(() => {});
          last.status = 'ok';
          last.scheduleId = setting.scheduleId;
          return { ...setting, schedule: view, reconcile: { ...last } };
        }
      } else {
        last.repaired = true;
      }
    }

    // 无有效 id：先尝试按 title 收养（避免重复创建）
    if (!last.repaired) {
      const catalog = await safeCatalog();
      const existing = catalog.find((entry) => entry && entry.title === SCHEDULE_TITLE);
      const adoptedId = existing && (existing.id || existing.record?.id);
      if (adoptedId) {
        setting = normalizeSetting({ ...setting, scheduleId: adoptedId, lastReconciledAt: isoNow() });
        await writeSetting(setting);
        last.status = 'ok';
        last.adopted = true;
        last.scheduleId = adoptedId;
        return { ...setting, schedule: await safeView(adoptedId), reconcile: { ...last } };
      }
    }

    try {
      const { scheduleId } = await createSchedule(setting);
      setting = normalizeSetting({ ...setting, scheduleId, lastReconciledAt: isoNow() });
      await writeSetting(setting);
      last.status = 'ok';
      last.created = true;
      last.scheduleId = scheduleId;
      diagnostics?.setGate?.('M2.G5', true, { scheduleId });
      return { ...setting, schedule: await safeView(scheduleId), reconcile: { ...last } };
    } catch (error) {
      last.status = 'error';
      last.error = String(error?.message || error);
      diagnostics?.recordError?.('schedule_create_failed', `夜间整理注册失败：${last.error}`);
      return { ...setting, schedule: null, reconcile: { ...last } };
    }
  }

  async function getAutomation() {
    const setting = normalizeSetting(readSetting());
    const view = setting.scheduleId ? await safeView(setting.scheduleId) : null;
    return {
      ...setting,
      schedule: view,
      healthy: Boolean(view),
      nextRun: view?.nextRun || view?.next_at || view?.record?.scheduledAt || null,
      reconcile: { ...last },
    };
  }

  async function setAutomation(patch = {}) {
    const current = normalizeSetting(readSetting());
    const next = normalizeSetting({
      ...current,
      enabled: patch.enabled === undefined ? current.enabled : Boolean(patch.enabled),
      time: typeof patch.time === 'string' ? patch.time : current.time,
    });
    await writeSetting(next);
    return ensureNightlySchedule();
  }

  /** 夜间 run 结束后回写 lastRunAt（B 在 applyTriage 后调用，可选） */
  async function noteRun(dateLocal) {
    const current = normalizeSetting(readSetting());
    await writeSetting(normalizeSetting({ ...current, lastRunAt: dateLocal || localDateOfNow() })).catch(() => {});
  }

  return {
    ensureNightlySchedule,
    getAutomation,
    setAutomation,
    noteRun,
    buildNightlyPrompt,
    last: () => ({ ...last }),
    localDateOfNow,
    get schedule() {
      return schedule;
    },
  };
}

export { nightlyCron, addDays };

/* ═══════════════════════ M3：自动化设置 / schedule adapter / 降级实现 ═══════════════════════ */

export const AUTOMATION_SETTING_KEY = 'automation';

export const AUTOMATION_DEFAULTS = Object.freeze({
  morningBrief: { enabled: true, time: '07:35' },
  eveningReview: { enabled: false, time: '21:00' },
  habitNudge: { enabled: false, time: '20:30' },
  nightlyInbox: { enabled: true, time: '21:30' },
  deadlineReminder: { enabled: true, leadMinutes: 60, dueDateAt: '09:00' },
  dnd: { start: '22:45', end: '07:30' },
  dndPolicy: 'skip',
  dailyBudget: 2,
  suggestions: { enabled: true, maxPerDay: 2 },
});

/** 宿主 schedule 服务 → A 的 automation-service 可用 adapter（绑定 actor 会话）。 */
export function createScheduleAdapter(ctx, actorSessionId = undefined) {
  const schedule = getService(ctx, 'schedule');
  if (!schedule) return null;
  return {
    available: true,
    view: (input) => schedule.view(input),
    create: (request) => schedule.create(request, actorSessionId),
    edit: (request) => schedule.edit(request, actorSessionId),
    run: async (input) => {
      if (typeof schedule.run !== 'function') throw new Error('schedule.run 不可用');
      return schedule.run(input);
    },
    list: async (input) => (typeof schedule.list === 'function' ? schedule.list(input || {}) : []),
    catalog: async () => (typeof schedule.catalog === 'function' ? schedule.catalog() : []),
  };
}

/** 读取 app_setting['automation']（合并默认值 + M2 automation.inbox_nightly 迁移）。 */
export function readAutomationSettings(store) {
  const read = (key) => {
    try {
      const record = store.get('lifeos', 'app_setting', key);
      const value = record && (record.value_json ?? record.value);
      return isPlainObject(value) ? value : null;
    } catch {
      return null;
    }
  };
  const stored = read(AUTOMATION_SETTING_KEY) || {};
  const merged = {
    ...AUTOMATION_DEFAULTS,
    ...stored,
    nightlyInbox: { ...AUTOMATION_DEFAULTS.nightlyInbox, ...(isPlainObject(stored.nightlyInbox) ? stored.nightlyInbox : {}) },
    morningBrief: { ...AUTOMATION_DEFAULTS.morningBrief, ...(isPlainObject(stored.morningBrief) ? stored.morningBrief : {}) },
    eveningReview: { ...AUTOMATION_DEFAULTS.eveningReview, ...(isPlainObject(stored.eveningReview) ? stored.eveningReview : {}) },
    habitNudge: { ...AUTOMATION_DEFAULTS.habitNudge, ...(isPlainObject(stored.habitNudge) ? stored.habitNudge : {}) },
    deadlineReminder: { ...AUTOMATION_DEFAULTS.deadlineReminder, ...(isPlainObject(stored.deadlineReminder) ? stored.deadlineReminder : {}) },
    dnd: { ...AUTOMATION_DEFAULTS.dnd, ...(isPlainObject(stored.dnd) ? stored.dnd : {}) },
    suggestions: { ...AUTOMATION_DEFAULTS.suggestions, ...(isPlainObject(stored.suggestions) ? stored.suggestions : {}) },
  };
  if (!stored.nightlyInbox) {
    const legacy = read(NIGHTLY_KEY);
    if (legacy && typeof legacy.time === 'string') {
      merged.nightlyInbox = { enabled: legacy.enabled !== false, time: legacy.time };
    }
  }
  return merged;
}

export async function writeAutomationSettings(store, settings, { now = Date.now } = {}) {
  const nowIso = new Date(now()).toISOString();
  const record = {
    key: AUTOMATION_SETTING_KEY,
    id: AUTOMATION_SETTING_KEY,
    value_json: settings,
    updated_at: nowIso,
  };
  const log = {
    id: newId('opl'),
    actor_type: 'user',
    actor_ref: null,
    action: 'settings.update',
    target_type: 'app_setting',
    target_id: AUTOMATION_SETTING_KEY,
    target_ids_json: [AUTOMATION_SETTING_KEY],
    permission_id: null,
    permission_level: 'L2',
    decision: 'allowed',
    status: 'applied',
    before_json: null,
    after_json: { keys: Object.keys(settings || {}) },
    diff_json: null,
    state_change_ids: null,
    evidence_refs: [],
    undo_of_id: null,
    reversible: false,
    undo_patch_json: null,
    occurred_at: nowIso,
    created_at: nowIso,
    updated_at: nowIso,
    deleted_at: null,
    rev: 1,
    schema_version: 1,
    meta_json: null,
    origin_type: 'user_stated',
    origin_ref: null,
    confirmation_status: 'confirmed',
  };
  await store.transaction([
    { unit: 'lifeos', table: 'app_setting', key: AUTOMATION_SETTING_KEY, value: record },
    { unit: 'lifeos_log', table: 'operation_log', key: log.id, value: log },
  ]);
  return settings;
}

function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

/**
 * 降级 automation-service（A 的 task-33 未就绪时使用）：设置读写 + 最小 reconcile/status。
 * 真实实现由 index.js 动态装载 A 的 `createAutomationService` 替换。
 */
export function createFallbackAutomationService(options = {}) {
  const { store, schedule = null, nightlyScheduler = null } = options;
  const logger = options.logger || { info() {}, warn() {} };
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const lastReconcile = { at: null, impacted: [], error: null };

  async function getSettings() {
    return readAutomationSettings(store);
  }

  async function patchSettings(patch) {
    const current = readAutomationSettings(store);
    const next = deepMerge(current, patch || {});
    await writeAutomationSettings(store, next, { now });
    return next;
  }

  async function reconcile() {
    const impacted = [];
    try {
      if (nightlyScheduler && typeof nightlyScheduler.ensureNightlySchedule === 'function') {
        const result = await nightlyScheduler.ensureNightlySchedule();
        impacted.push({ routine: 'nightlyInbox', scheduleId: result?.scheduleId || null, status: result?.status || 'ok' });
      }
      lastReconcile.at = new Date(now()).toISOString();
      lastReconcile.impacted = impacted;
      lastReconcile.error = null;
    } catch (error) {
      lastReconcile.error = String(error?.message || error);
      logger.warn?.(`[automation] reconcile 失败：${lastReconcile.error}`);
    }
    return { impacted, at: lastReconcile.at, error: lastReconcile.error };
  }

  async function getStatus() {
    const settings = await getSettings();
    return {
      settings,
      routines: {
        nightlyInbox: {
          enabled: settings.nightlyInbox.enabled,
          time: settings.nightlyInbox.time,
          lastRun: nightlyScheduler && typeof nightlyScheduler.getAutomation === 'function'
            ? (await nightlyScheduler.getAutomation()).lastRun || null
            : null,
        },
      },
      dnd: settings.dnd,
      dailyBudget: settings.dailyBudget,
      suggestions: settings.suggestions,
      lastReconcile,
      scheduler: schedule ? { available: true } : { available: false },
      source: 'fallback',
    };
  }

  return { getSettings, patchSettings, reconcile, getStatus, source: 'fallback' };
}

/**
 * M3 装配（B）：automation-service 与 legacy M2 nightly 的唯一裁决点。
 *
 * 规则（Lead M3 集成冲突修复）：
 *  - A 的 automation-service 加载成功 → 由它的 `reconcileSchedules/reconcileReminders` 管理
 *    routine（含 nightlyInbox）；**不调用** legacy `scheduler.ensureNightlySchedule()`；
 *  - 仅当降级为 fallback automation（模块缺失 / factory 抛错）时，legacy nightly 对账保留
 *    （fallback.reconcile 内部调用 legacy scheduler）；
 *  - 返回的 `nightly` 供 index 写 M2.G5 诊断门。
 *
 * @param {object} options
 * @param {object} options.store
 * @param {object|null} options.schedule createScheduleAdapter(ctx) 产出
 * @param {object|null} options.legacyScheduler M2 createScheduler 实例
 * @param {()=>Promise<{factory:Function,source:string}|null>} options.loadAutomation
 * @param {object} [options.config]
 * @param {object} [options.logger]
 * @param {()=>number} [options.now]
 */
export async function createAutomationRuntime(options = {}) {
  const { store, schedule = null, legacyScheduler = null } = options;
  const config = options.config || {};
  const logger = options.logger || { warn() {} };
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const loadAutomation = typeof options.loadAutomation === 'function' ? options.loadAutomation : async () => null;

  let automation = null;
  let loaded = null;
  let usedFallback = false;
  let source = 'fallback';
  const errors = [];

  try {
    loaded = await loadAutomation();
    if (loaded && typeof loaded.factory === 'function') {
      try {
        automation = await loaded.factory({
          store,
          schedule,
          config,
          logger,
          now,
          timeZone: config.timeZone,
          actorSessionId: options.actorSessionId || null,
        });
        source = loaded.source || 'automation-service';
      } catch (error) {
        errors.push(`automation factory 失败：${error?.message || error}`);
        logger.warn?.(`[automation] A 的 automation-service 初始化失败，降级 fallback：${error?.message || error}`);
        automation = null;
      }
    }
  } catch (error) {
    errors.push(`automation 装载失败：${error?.message || error}`);
    automation = null;
  }

  if (!automation) {
    usedFallback = true;
    source = 'fallback';
    automation = createFallbackAutomationService({
      store,
      schedule,
      nightlyScheduler: legacyScheduler,
      config,
      logger,
      now,
    });
  }

  let reconcileResult = null;
  let nightly = { scheduleId: null, status: null, source: null };
  let legacyNightlyCalled = false;
  try {
    if (!usedFallback && typeof automation.reconcileSchedules === 'function') {
      reconcileResult = await automation.reconcileSchedules();
      if (typeof automation.reconcileReminders === 'function') {
        try {
          const reminderResult = await automation.reconcileReminders();
          // 提醒创建同样走 new_once 目标；失败信息原先只留在 result.errors，必须并入启动错误，
          // 否则 M3.G1 为 true 但截止提醒实际没建（M3 验收发现的静默失败）。
          const reminderErrors = Array.isArray(reminderResult?.errors) ? reminderResult.errors : [];
          for (const message of reminderErrors) errors.push(`提醒对账：${message}`);
        } catch (error) {
          errors.push(`reconcileReminders 失败：${error?.message || error}`);
        }
      }
      const nightlyEntry = Array.isArray(reconcileResult?.schedules)
        ? reconcileResult.schedules.find((entry) => entry && (entry.key === 'nightlyInbox' || entry.routine === 'nightlyInbox'))
        : null;
      nightly = {
        scheduleId: nightlyEntry?.scheduleId ?? null,
        status: nightlyEntry?.status ?? reconcileResult?.status ?? null,
        source: 'automation-service',
      };
    } else if (typeof automation.reconcile === 'function') {
      reconcileResult = await automation.reconcile();
      legacyNightlyCalled = true;
      nightly = {
        scheduleId: reconcileResult?.impacted?.find?.((item) => item?.routine === 'nightlyInbox')?.scheduleId ?? null,
        status: reconcileResult?.impacted?.length > 0 ? 'ok' : 'ok',
        source: 'fallback-legacy',
      };
    }
  } catch (error) {
    errors.push(`reconcile 失败：${error?.message || error}`);
    logger.warn?.(`[automation] 启动 reconcile 失败：${error?.message || error}`);
    nightly = { scheduleId: nightly.scheduleId, status: 'error', source: nightly.source };
  }

  return {
    automation,
    usedFallback,
    source,
    reconcileResult,
    nightly,
    legacyNightlyCalled,
    errors,
    // index 依据此字段决定是否写 M2.G5 / 是否还保留 legacy 调用
    legacyNightlyNeeded: usedFallback,
  };
}

/* ── 启动补偿：宿主 sessionController 时序竞态 ───────────────────── */

/** 宿主 schedule 拒绝 new_once/new 目标时的固定错误文本。 */
export const SESSION_TARGET_ERROR_RE = /cannot create sessions?|choose an existing session target/i;

export function isSessionTargetError(message) {
  return SESSION_TARGET_ERROR_RE.test(String(message || ''));
}

/**
 * 有界后台重试：等宿主 sessionController（Web activation provider）就绪后补建 routine/提醒。
 *
 * 背景：dsh-schedule 的 new_once/new 目标会调用 requireSessionCreation()，若插件 apply 早于
 * Web activation provider 就绪，创建会抛 `This Host cannot create Sessions; choose an existing
 * Session target.`；此时不应把 M3 门禁判死，也不应阻塞插件激活，而是延迟补偿。
 *
 * @param {object} options
 * @param {object} options.automation A 的 automation-service（需有 reconcileSchedules）
 * @param {number} [options.intervalMs=3000] 重试间隔
 * @param {number} [options.maxAttempts=40] 最大尝试次数
 * @param {(errors:string[])=>boolean} [options.shouldRetry] 默认仅对 session 目标错误重试
 * @param {(info:object)=>void} [options.onAttempt] 每次尝试后回调
 * @param {(info:object)=>void} [options.onSuccess] 成功（errors 为空）回调
 * @param {(info:object)=>void} [options.onFailure] 放弃回调（reason: max-attempts | non-retryable | error）
 * @param {(fn:Function, ms:number)=>any} [options.setTimeoutImpl] 测试注入
 * @param {(handle:any)=>void} [options.clearTimeoutImpl] 测试注入
 */
export function retryAutomationReconcile(options = {}) {
  const automation = options.automation;
  if (!automation || typeof automation.reconcileSchedules !== 'function') {
    return { started: false, stop() {}, attempts: () => 0, lastErrors: () => [] };
  }
  const intervalMs = Number.isInteger(options.intervalMs) && options.intervalMs >= 0 ? options.intervalMs : 3000;
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0 ? options.maxAttempts : 40;
  const setTimeoutImpl = typeof options.setTimeoutImpl === 'function' ? options.setTimeoutImpl : (fn, ms) => setTimeout(fn, ms);
  const clearTimeoutImpl = typeof options.clearTimeoutImpl === 'function' ? options.clearTimeoutImpl : (handle) => clearTimeout(handle);
  const onAttempt = typeof options.onAttempt === 'function' ? options.onAttempt : () => {};
  const onSuccess = typeof options.onSuccess === 'function' ? options.onSuccess : () => {};
  const onFailure = typeof options.onFailure === 'function' ? options.onFailure : () => {};
  const shouldRetry = typeof options.shouldRetry === 'function'
    ? options.shouldRetry
    : (errors) => (Array.isArray(errors) ? errors : []).some(isSessionTargetError);

  let attempts = 0;
  let timer = null;
  let stopped = false;
  let running = false;
  let lastErrors = [];

  const clearTimer = () => {
    if (timer === null) return;
    try {
      clearTimeoutImpl(timer);
    } catch {
      /* ignore */
    }
    timer = null;
  };
  const stop = () => {
    stopped = true;
    clearTimer();
  };
  const fail = (reason, extra = {}) => {
    stop();
    try {
      onFailure({ attempts, errors: [...lastErrors], reason, ...extra });
    } catch {
      /* ignore */
    }
  };
  const scheduleNext = () => {
    if (stopped) return;
    if (attempts >= maxAttempts) {
      fail('max-attempts');
      return;
    }
    timer = setTimeoutImpl(run, intervalMs);
  };

  async function run() {
    timer = null;
    if (stopped || running) return;
    if (attempts >= maxAttempts) {
      fail('max-attempts');
      return;
    }
    attempts += 1;
    running = true;
    try {
      const result = await automation.reconcileSchedules();
      let reminders = null;
      if (typeof automation.reconcileReminders === 'function') {
        try {
          reminders = await automation.reconcileReminders();
        } catch (error) {
          reminders = { errors: [`reconcileReminders 失败：${error?.message || error}`] };
        }
      }
      const resultErrors = Array.isArray(result?.errors) ? result.errors : [];
      const reminderErrors = Array.isArray(reminders?.errors) ? reminders.errors : [];
      lastErrors = [...resultErrors, ...reminderErrors];
      try {
        onAttempt({ attempt: attempts, errors: [...lastErrors], result, reminders });
      } catch {
        /* ignore */
      }
      if (lastErrors.length === 0) {
        stop();
        try {
          onSuccess({ attempt: attempts, result, reminders });
        } catch {
          /* ignore */
        }
        return;
      }
      if (!shouldRetry(lastErrors)) {
        fail('non-retryable');
        return;
      }
      scheduleNext();
    } catch (error) {
      lastErrors = [String(error?.message || error)];
      try {
        onAttempt({ attempt: attempts, errors: [...lastErrors], thrown: true });
      } catch {
        /* ignore */
      }
      if (attempts >= maxAttempts) fail('error', { error: lastErrors[0] });
      else scheduleNext();
    } finally {
      running = false;
    }
  }

  scheduleNext();
  return {
    started: true,
    stop,
    attempts: () => attempts,
    lastErrors: () => [...lastErrors],
  };
}
