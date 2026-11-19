/**
 * dsh-lifeos —— Host 入口（B 所有；装配一切）。
 *
 * 契约：M0-PLAN §3.1 / §3.2 / §3.5 / §3.8。
 * 原则：
 *  - 零 `@deepseek-ai/*`、零第三方依赖；只用 ctx.* 服务。
 *  - 所有注册由 ctx.effect 持有；apply 内任何失败都降级/记录，绝不抛回宿主。
 *  - 数据 owner 单例：这里唯一打开 3 个 kv unit，并把门面 expose 为 `lifeos` 服务。
 *  - 工具/prompt 在 preset 平面（D 线 agent.js），Host 行只注册 preset 定义。
 */

import { createLifeosService } from './src/application/lifeos-service.js';
import { createDiagnostics } from './src/runtime/diagnostics.js';
import { createEventBus, publishNoteChange } from './src/runtime/sse.js';
import { createSseServer } from './src/runtime/sse.js';
import { registerHostRoutes } from './src/runtime/routes.js';
import { loadAgentPreset, loadLifeosStore } from './src/runtime/store-loader.js';
import { createScheduler, createScheduleAdapter, createAutomationRuntime, retryAutomationReconcile } from './src/runtime/scheduler.js';
import { createSuggestionService } from './src/application/suggestion-service.js';
import { newId as runtimeNewId } from './src/runtime/ids.js';
import { installToolScope } from './src/runtime/tool-scope.js';
import { startNoteWatch } from './src/runtime/note-watch.js';

export const name = 'lifeos';

/** 硬依赖：缺任一不激活（webServer 用于 HTTP/SSE；agentPresets 用于注册生活教练 preset）。 */
export const inject = ['storage', 'webServer', 'tools', 'agentPresets'];

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  timeZone: 'Asia/Shanghai',
  devMode: false,
  selfCheck: false,
  clientSelfCheck: false,
  httpPrefix: '/api/lifeos',
  heartbeatMs: 15000,
  sseRingSize: 50,
  units: { core: 'lifeos', raw: 'lifeos_raw', log: 'lifeos_log' },
  version: '0.0.1',
});

export function normalizeConfig(raw) {
  const warnings = [];
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const config = { ...DEFAULT_CONFIG };

  if (input.enabled !== undefined) {
    if (typeof input.enabled === 'boolean') config.enabled = input.enabled;
    else warnings.push('enabled 应为布尔值，已忽略');
  }
  if (input.timeZone !== undefined) {
    if (typeof input.timeZone === 'string' && input.timeZone.length > 0) {
      try {
        new Intl.DateTimeFormat('en-CA', { timeZone: input.timeZone });
        config.timeZone = input.timeZone;
      } catch {
        warnings.push(`timeZone 非法：${input.timeZone}，回退 ${DEFAULT_CONFIG.timeZone}`);
      }
    } else warnings.push('timeZone 应为 IANA 字符串，已忽略');
  }
  if (input.devMode !== undefined) {
    if (typeof input.devMode === 'boolean') config.devMode = input.devMode;
    else warnings.push('devMode 应为布尔值，已忽略');
  }
  if (input.selfCheck !== undefined) {
    if (input.selfCheck === false || input.selfCheck === true || input.selfCheck === 'once') {
      config.selfCheck = input.selfCheck;
    } else warnings.push('selfCheck 应为 false | true | "once"，已忽略');
  }
  if (input.clientSelfCheck !== undefined) {
    if (typeof input.clientSelfCheck === 'boolean') config.clientSelfCheck = input.clientSelfCheck;
    else warnings.push('clientSelfCheck 应为布尔值，已忽略');
  }
  if (input.httpPrefix !== undefined) {
    if (typeof input.httpPrefix === 'string' && input.httpPrefix.startsWith('/')) config.httpPrefix = input.httpPrefix;
    else warnings.push('httpPrefix 必须以 / 开头，已忽略');
  }
  for (const key of ['heartbeatMs', 'sseRingSize']) {
    if (input[key] !== undefined) {
      if (Number.isInteger(input[key]) && input[key] > 0) config[key] = input[key];
      else warnings.push(`${key} 应为正整数，已忽略`);
    }
  }
  if (input.units !== undefined) {
    if (input.units && typeof input.units === 'object') {
      for (const slot of ['core', 'raw', 'log']) {
        const value = input.units[slot];
        if (typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value)) config.units[slot] = value;
        else if (value !== undefined) warnings.push(`units.${slot} 非法，已忽略`);
      }
    } else warnings.push('units 应为对象，已忽略');
  }
  if (typeof input.version === 'string') config.version = input.version;
  if (typeof input.diagnosticsPath === 'string') config.diagnosticsPath = input.diagnosticsPath;
  if (typeof input.clientReportPath === 'string') config.clientReportPath = input.clientReportPath;
  return { config, warnings };
}

function makeLogger(ctx) {
  let facade = null;
  try {
    if (ctx && typeof ctx.logger === 'function') facade = ctx.logger('lifeos');
  } catch {
    facade = null;
  }
  if (!facade || typeof facade.info !== 'function') facade = null;
  const emit = (level) => (message) => {
    const text = `[lifeos] ${String(message)}`;
    try {
      if (facade && typeof facade[level] === 'function') facade[level](text);
      else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(`${text}\n`);
    } catch {
      /* ignore */
    }
  };
  return {
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    get enabled() {
      return facade !== null;
    },
  };
}

function hold(ctx, callback, label) {
  if (ctx && typeof ctx.effect === 'function') {
    try {
      return ctx.effect(callback, label);
    } catch {
      /* 降级：不回抛 */
    }
  }
  try {
    const teardown = callback();
    if (typeof teardown === 'function') return teardown;
  } catch {
    /* ignore */
  }
  return undefined;
}

/** 读取 app_setting 某个 key 的 value_json（同步，存储是内存权威）。 */
function readAppSetting(store, key) {
  try {
    const record = store.get('lifeos', 'app_setting', key);
    return record ? record.value_json ?? null : null;
  } catch {
    return null;
  }
}

/** 写入 app_setting（notes.dir / notes.options 等；M0 已有该表，不新增表）。 */
async function writeAppSetting(store, key, valueJson) {
  const record = {
    key,
    id: key,
    value_json: valueJson,
    updated_at: new Date().toISOString(),
  };
  await store.transaction([{ unit: 'lifeos', table: 'app_setting', key, value: record }]);
  return valueJson;
}

/** notes.dir 兼容两种形态：字符串 或 {dir}。 */
function readNotesDir(store) {
  const value = readAppSetting(store, 'notes.dir');
  if (typeof value === 'string') return value;
  if (value && typeof value.dir === 'string') return value.dir;
  return '';
}

/** 笔记配置持久化（A 的 setConfig 若自身持久化，重复写同值无害）。 */
async function saveNotesConfig(store, configValue) {
  if (!configValue || typeof configValue !== 'object') return;
  if (typeof configValue.dir === 'string' && configValue.dir.length > 0) {
    await writeAppSetting(store, 'notes.dir', { dir: configValue.dir });
  }
  if (configValue.options && typeof configValue.options === 'object') {
    await writeAppSetting(store, 'notes.options', configValue.options);
  }
}

/** 动态装载 A 的 note-service（未交付时返回 null，插件降级继续）。 */
async function loadNoteService() {
  const candidates = [
    './src/application/note-service.js',
    './src/application/notes-service.js',
  ];
  for (const spec of candidates) {
    let mod;
    try {
      mod = await import(spec);
    } catch (error) {
      if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) continue;
      throw error;
    }
    const factory = mod?.createNoteService || mod?.createNotesService || mod?.default;
    if (typeof factory === 'function') return { factory, source: spec };
  }
  return null;
}

async function loadAutomationService() {
  const candidates = [
    './src/application/automation-service.js',
  ];
  for (const spec of candidates) {
    let mod;
    try {
      mod = await import(spec);
    } catch (error) {
      if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')) continue;
      throw error;
    }
    const factory = mod?.createAutomationService || mod?.default;
    if (typeof factory === 'function') return { factory, source: spec };
  }
  return null;
}

function getService(ctx, key) {  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(key) : ctx ? ctx[key] : undefined;
  } catch {
    return undefined;
  }
}

export async function apply(ctx, rawConfig) {
  const log = makeLogger(ctx);
  const { config, warnings } = normalizeConfig(rawConfig);
  const diagnostics = createDiagnostics({
    diagnosticsPath: config.diagnosticsPath,
    clientReportPath: config.clientReportPath,
  });
  const startedAt = Date.now();
  for (const warning of warnings) log.warn(warning);
  const now = () => Date.now();

  diagnostics.setStage('config', { config: { ...config, diagnosticsPath: undefined, clientReportPath: undefined } });
  diagnostics.setGate('G1', false, 'apply 开始');

  if (!config.enabled) {
    diagnostics.setStage('disabled', { ok: true });
    log.info('enabled=false：不注册任何组件');
    return;
  }

  try {
    // ── 1. 存储（唯一 owner）──────────────────────────────────────────────
    const loaded = await loadLifeosStore(ctx, { config, diagnostics, logger: log });
    const store = loaded.store;
    let storeOpened = !store.degraded;
    diagnostics.setGate('G2', storeOpened, {
      backend: loaded.backend,
      source: loaded.source,
      degraded: Boolean(store.degraded),
      error: loaded.error ? String(loaded.error.message || loaded.error) : null,
    });

    if (storeOpened) {
      try {
        const recovered = await store.recoverJournal();
        diagnostics.setGate('G2.recover', true, recovered);
        const counts = store.status ? store.status() : { units: {} };
        diagnostics.setGate('G4', true, { units: counts.units || {}, phase: 'store-ready' });
      } catch (error) {
        storeOpened = false;
        diagnostics.recordError('journal_recover_failed', `journal 恢复失败：${error?.message || error}`);
        diagnostics.setGate('G2', false, { reason: 'recover-failed', error: String(error?.message || error) });
        diagnostics.setGate('G4', false, { reason: 'recover-failed' });
      }
    } else {
      diagnostics.setGate('G4', false, { reason: 'store-degraded' });
    }

    // ── M2：定时整理（宿主 schedule 对账；不阻塞其它装配）──────────────
    let scheduler = null;
    try {
      scheduler = createScheduler({ ctx, store, config, diagnostics });
    } catch (error) {
      diagnostics.recordError('scheduler_init_failed', `调度器初始化失败（降级继续）：${error?.message || error}`);
    }

    // ── 2. 总线 + 服务（数据 owner 单例）────────────────────────────────
    const bus = createEventBus();
    let service;
    try {
      service = createLifeosService({
        store,
        config,
        diagnostics,
        bus,
        ids: loaded.ids || undefined,
        scheduler,
        version: config.version,
      });
    } catch (error) {
      diagnostics.recordError('service_init_failed', `服务初始化失败：${error?.message || error}`);
      diagnostics.setStage('failed', { ok: false });
      log.error(`服务初始化失败：${error?.message || error}`);
      try {
        await store.close();
      } catch {
        /* ignore */
      }
      return;
    }

    try {
      const disposeProvide = ctx.provide('lifeos', service);
      if (typeof disposeProvide === 'function') hold(ctx, () => disposeProvide, 'lifeos.provide');
      else hold(ctx, () => () => {}, 'lifeos.provide');
    } catch (error) {
      diagnostics.recordError('provide_failed', `ctx.provide('lifeos') 失败：${error?.message || error}`);
      log.error(`ctx.provide 失败（preset 薄行将取不到服务）：${error?.message || error}`);
    }
    hold(ctx, () => async () => {
      try {
        await store.close();
      } catch {
        /* ignore */
      }
    }, 'lifeos.store');

    // ── 2.5 M2.5 笔记：service + 目录监听（未配置目录时 watch 不启动）────
    let notesService = null;
    let noteWatch = null;
    let notesDir = readNotesDir(store);
    try {
      const loadedNotes = await loadNoteService();
      if (loadedNotes) {
        notesService = await loadedNotes.factory({
          getRoot: () => readNotesDir(store) || notesDir,
          logger: log,
          store,
          bus,
          saveConfig: (configValue) => saveNotesConfig(store, configValue),
        });
        service.notes = notesService;
        diagnostics.setGate('M2.5.G1', true, { dir: notesDir || null, configured: Boolean(notesDir), source: loadedNotes.source });
      } else {
        service.notes = null;
        diagnostics.setGate('M2.5.G1', false, { reason: 'note-service-missing' });
        diagnostics.recordError('notes_service_unavailable', 'note-service 未就绪：笔记 HTTP 返回 notes_unavailable（A 线交付后自动装配）');
      }
    } catch (error) {
      service.notes = null;
      diagnostics.setGate('M2.5.G1', false, { reason: 'note-service-init-failed', error: String(error?.message || error) });
      diagnostics.recordError('notes_service_unavailable', `笔记服务初始化失败：${error?.message || error}`);
      log.warn(`笔记服务初始化失败（降级继续）：${error?.message || error}`);
    }

    const startWatchFor = (dir) => {
      try {
        if (noteWatch) noteWatch.stop();
      } catch {
        /* ignore */
      }
      noteWatch = null;
      if (!dir || !notesService) return;
      noteWatch = startNoteWatch({
        root: dir,
        onChange: (change) => publishNoteChange(bus, change),
        logger: log,
      });
      log.info(`笔记监听已启动：${dir}（mode=${noteWatch.getMode()}）`);
    };
    if (notesDir && notesService) startWatchFor(notesDir);
    hold(ctx, () => () => {
      try {
        noteWatch?.stop();
      } catch {
        /* ignore */
      }
    }, 'lifeos.note-watch');

    const onNotesConfig = async (result) => {
      const nextDir = result && typeof result.dir === 'string' ? result.dir : null;
      if (!nextDir) return;
      try {
        await saveNotesConfig(store, { dir: nextDir });
      } catch (error) {
        diagnostics.recordError('notes_config_persist_failed', `notes.dir 持久化失败：${error?.message || error}`);
      }
      if (nextDir !== notesDir) {
        notesDir = nextDir;
        if (notesService) startWatchFor(nextDir);
      }
    };

    // ── 2.6 M3 自动化（A）+ 建议（B）：失败降级不阻塞插件 ─────────
    let automationRuntime = null;
    let suggestionService = null;
    try {
      const scheduleAdapter = createScheduleAdapter(ctx);
      // 唯一裁决点：A 的 automation-service 加载成功时由它管理全部 routine（含夜间整理），
      // 不再调用 legacy scheduler.ensureNightlySchedule()；仅 fallback 时保留 legacy 对账。
      automationRuntime = await createAutomationRuntime({
        store,
        schedule: scheduleAdapter,
        legacyScheduler: scheduler,
        config,
        logger: log,
        now,
        loadAutomation: loadAutomationService,
      });
      service.automation = automationRuntime.automation;
      const reconcileErrors = [
        ...(automationRuntime.errors || []),
        ...((automationRuntime.reconcileResult && automationRuntime.reconcileResult.errors) || []),
      ];
      diagnostics.setGate('M3.G1', reconcileErrors.length === 0, {
        source: automationRuntime.source,
        usedFallback: automationRuntime.usedFallback,
        impacted: automationRuntime.reconcileResult?.impacted?.length || 0,
        errors: reconcileErrors,
      });
      if (reconcileErrors.length > 0) {
        diagnostics.recordError('automation_reconcile_errors', `自动化对账存在 ${reconcileErrors.length} 个错误`, {
          errors: reconcileErrors.slice(0, 5),
        });
      }
      // 启动补偿：宿主 schedule 的 new_once/new 目标要求同 Host 的 sessionController 就绪，
      // 而该服务由 Web activation provider 异步提供；插件 apply 早于它就绪时 routine/提醒会静默失败。
      // 这里做有界后台重试，sessionController 就绪后补齐，并把门禁恢复到真实状态。
      const sessionErrors = reconcileErrors.filter((message) => /cannot create sessions?|choose an existing session target/i.test(String(message)));
      if (sessionErrors.length > 0 && automationRuntime.automation) {
        const recovery = retryAutomationReconcile({
          automation: automationRuntime.automation,
          intervalMs: 3000,
          maxAttempts: 40,
          onSuccess: ({ attempt, result, reminders }) => {
            const schedules = Array.isArray(result?.schedules) ? result.schedules : [];
            const nightlyEntry = schedules.find((entry) => entry && (entry.key === 'nightlyInbox' || entry.routine === 'nightlyInbox'));
            diagnostics.setGate('M3.G1', true, {
              source: automationRuntime.source,
              usedFallback: false,
              recovered: true,
              attempts: attempt,
              impacted: Array.isArray(result?.impacted) ? result.impacted.length : 0,
              reminders: reminders && typeof reminders.created === 'number' ? reminders.created : null,
            });
            const okStatuses = ['ok', 'created', 'updated', 'resumed', 'paused', 'active'];
            diagnostics.setGate('M2.G5', okStatuses.includes(nightlyEntry?.status), {
              scheduleId: nightlyEntry?.scheduleId ?? null,
              status: nightlyEntry?.status ?? 'ok',
              source: 'automation-service',
              legacySkipped: true,
              recovered: true,
            });
            try {
              bus.publish({ type: 'changed', data: { kind: 'automation', ids: [], at: new Date(now()).toISOString(), recovered: true } });
            } catch {
              /* ignore */
            }
            log.info(`自动化对账已恢复（第 ${attempt} 次重试）：routine 与截止提醒就绪`);
          },
          onFailure: ({ attempts, errors, reason }) => {
            diagnostics.setGate('M3.G1', false, {
              source: automationRuntime.source,
              usedFallback: false,
              retryAttempts: attempts,
              retryReason: reason,
              errors: (errors || []).slice(0, 5),
            });
            diagnostics.recordError('automation_reconcile_retry_failed', `自动化对账重试 ${attempts} 次后仍失败（${reason}）`, {
              errors: (errors || []).slice(0, 5),
            });
            log.warn(`自动化对账重试失败：${(errors || [])[0] || reason}`);
          },
        });
        hold(ctx, () => () => recovery.stop(), 'lifeos.automation.recovery');
      }
    } catch (error) {
      service.automation = null;
      diagnostics.setGate('M3.G1', false, { reason: 'automation-init-failed', error: String(error?.message || error) });
      diagnostics.recordError('automation_unavailable', `自动化服务初始化失败：${error?.message || error}`);
      log.warn(`自动化服务初始化失败（降级继续）：${error?.message || error}`);
    }

    try {
      suggestionService = createSuggestionService({
        store,
        newId: (prefix) => (loaded.ids && typeof loaded.ids.newId === 'function' ? loaded.ids.newId(prefix) : runtimeNewId(prefix)),
        timeZone: config.timeZone || 'Asia/Shanghai',
        logger: log,
        emitChanged: (kind, idsList, extra) => {
          try {
            bus.publish({ type: 'changed', data: { kind, ids: idsList, at: new Date(now()).toISOString(), ...(extra || {}) } });
          } catch {
            /* ignore */
          }
        },
      });
      service.suggestions = suggestionService;
      diagnostics.setGate('M3.G3', false, { source: 'rule-engine' });
      try {
        const generated = await suggestionService.generate();
        diagnostics.setGate('M3.G3', true, {
          source: 'rule-engine',
          generated: generated.generated.length,
          budget: generated.counts.budget,
        });
      } catch (error) {
        diagnostics.recordError('suggestion_generate_failed', `启动生成建议失败：${error?.message || error}`);
      }
    } catch (error) {
      service.suggestions = null;
      diagnostics.recordError('suggestion_unavailable', `建议服务初始化失败：${error?.message || error}`);
      log.warn(`建议服务初始化失败（降级继续）：${error?.message || error}`);
    }

    // ── 3. SSE + HTTP ───────────────────────────────────────────────────
    const sse = createSseServer({
      bus,
      heartbeatMs: config.heartbeatMs,
      ringSize: config.sseRingSize,
    });
    hold(ctx, () => () => sse.close(), 'lifeos.sse');

    let httpOk = false;
    try {
      const connection = getService(ctx, 'connection');
      const registered = registerHostRoutes(ctx, {
        service,
        diagnostics,
        sse,
        config,
        connection,
        notes: notesService,
        onNotesConfig,
        automation: automationRuntime?.automation ?? null,
        suggestions: suggestionService,
        bus,
        apiPrefix: config.httpPrefix,
      });
      const dispose = registered && registered.dispose;
      const routes = registered && registered.routes;
      hold(
        ctx,
        () => () => {
          try {
            if (typeof dispose === 'function') dispose();
          } catch {
            /* ignore */
          }
        },
        'lifeos.http',
      );
      httpOk = true;
      diagnostics.setGate('G5', false, { phase: 'routes-registered', routeKeys: routes.routeKeys.length });
    } catch (error) {
      diagnostics.recordError('http_register_failed', `HTTP 注册失败：${error?.message || error}`);
      diagnostics.setGate('G5', false, { reason: 'register-failed', error: String(error?.message || error) });
      log.error(`HTTP 注册失败：${error?.message || error}`);
    }

    // ── 4. preset（D 线提供；缺失降级）─────────────────────────────────
    let presetOk = false;
    try {
      const presetAgentPresets = getService(ctx, 'agentPresets');
      if (!presetAgentPresets || typeof presetAgentPresets.register !== 'function') {
        throw new Error('agentPresets 服务不可用');
      }
      const loadedPreset = await loadAgentPreset();
      if (!loadedPreset.preset) throw loadedPreset.error || new Error('preset 未找到');
      const disposePreset = await presetAgentPresets.register(loadedPreset.preset);
      if (typeof disposePreset === 'function') {
        hold(
          ctx,
          () => () => {
            try {
              const result = disposePreset();
              if (result && typeof result.then === 'function') result.catch(() => {});
            } catch {
              /* ignore */
            }
          },
          'lifeos.preset',
        );
      }
      presetOk = true;
      diagnostics.setGate('G3', true, { presetId: loadedPreset.preset.id, source: loadedPreset.source });
    } catch (error) {
      diagnostics.setGate('G3', false, { reason: 'preset-unavailable', error: String(error?.message || error) });
      diagnostics.recordError('preset_register_failed', `preset 注册失败（降级继续）：${error?.message || error}`);
      log.warn(`preset 注册失败（降级继续）：${error?.message || error}`);
    }

    // ── 4.5 M2 nightly 对账（唯一裁决点）──────────────────────────────
    // automation 可用 → 由 M3 reconcileSchedules 接管，绝不再调 legacy；仅 fallback 时保留。
    if (automationRuntime && !automationRuntime.legacyNightlyNeeded) {
      const nightly = automationRuntime.nightly || {};
      const okStatuses = ['ok', 'paused', 'active'];
      diagnostics.setGate('M2.G5', okStatuses.includes(nightly.status), {
        scheduleId: nightly.scheduleId ?? null,
        status: nightly.status ?? null,
        source: nightly.source || 'automation-service',
        legacySkipped: true,
      });
    } else if (scheduler) {
      try {
        const automation = await scheduler.ensureNightlySchedule();
        diagnostics.setGate('M2.G5', automation?.reconcile?.status === 'ok' || automation?.reconcile?.status === 'paused', {
          scheduleId: automation?.scheduleId ?? null,
          status: automation?.reconcile?.status ?? null,
          source: 'legacy-fallback',
        });
      } catch (error) {
        diagnostics.recordError('schedule_reconcile_failed', `夜间整理对账失败（降级继续）：${error?.message || error}`);
      }
    } else {
      diagnostics.setGate('M2.G5', false, { reason: 'scheduler-unavailable' });
    }
    try {
      const scope = installToolScope(ctx, { logger: log });
      hold(ctx, () => () => scope.dispose(), 'lifeos.tool-scope');
      diagnostics.setGate('M2.G1', true, scope.stats());
    } catch (error) {
      diagnostics.recordError('tool_scope_failed', `工具隔离安装失败（不阻塞）：${error?.message || error}`);
      diagnostics.setGate('M2.G1', false, { error: String(error?.message || error) });
    }

    // ── 5. 收尾：诊断/日志 ──────────────────────────────────────────────
    diagnostics.setGate('G1', true, { pid: typeof process !== 'undefined' ? process.pid : 0 });
    diagnostics.setGate('G6', true, { mode: storeOpened ? 'ready' : 'readonly-degraded' });
    diagnostics.setGate('G5', diagnostics.state.gates.G5?.status === true, {
      routes: httpOk,
      note: '等待 client-report（面板自检）',
    });
    diagnostics.setStage(storeOpened ? 'ready' : 'degraded', {
      ok: true,
      units: (service.status().units || {}),
      counts: service.status().counts,
      backend: loaded.backend,
      version: config.version,
      detail: storeOpened ? `routes=${httpOk} preset=${presetOk}` : 'readonly',
    });
    // ── 6. M0 自检（可选；selfCheck: 'once' 时首次运行）──────────────────
    if (storeOpened && config.selfCheck) {
      try {
        const { runSelfCheck, hadSelfCheck } = await import('./src/runtime/selfcheck.js');
        if (config.selfCheck === 'once' && hadSelfCheck()) {
          log.info('自检：已运行过，跳过（删除 runtime-selfcheck.json 可重跑）');
        } else {
          const result = await runSelfCheck(ctx, { service, store, config, diagnostics, log });
          const passed = result.steps.filter((item) => item.ok).length;
          log.info(`自检完成：${result.ok ? 'PASS' : 'FAIL'}（${passed}/${result.steps.length}）`);
        }
      } catch (error) {
        diagnostics.recordError('selfcheck_failed', `自检失败（不影响插件）：${error?.message || error}`);
        log.warn(`自检失败：${error?.message || error}`);
      }
    }

    log.info(
      `就绪：stage=${diagnostics.state.stage} backend=${loaded.backend} routes=${httpOk} preset=${presetOk} ` +
        `degraded=${Boolean(store.degraded)} uptime=${Date.now() - startedAt}ms`,
    );
  } catch (error) {
    diagnostics.recordError('apply_failed', `apply 未预期失败：${error?.message || error}`, {
      stack: String(error?.stack || '').slice(0, 2000),
    });
    diagnostics.setStage('failed', { ok: false });
    log.error(`apply 未预期失败（已降级，不抛宿主）：${error?.message || error}`);
  }
}
