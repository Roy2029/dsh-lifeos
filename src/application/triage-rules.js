/**
 * B：M2 整理规则适配层（A 线 `domain/extraction.js` / `domain/recompute.js` 未就绪时的临时实现）。
 *
 * M2-PLAN §2.3/§2.4 约定 A 提供纯函数：
 *  - `extractCandidates(rawText, {localDate, timeZone}) → candidate[]`
 *  - `recomputeAfterCorrection({before, after}) → {affected, plan}`
 * 本文件在模块加载时动态 import A 的模块：可用则原样代理；否则使用保守 fallback
 * （宁少勿错：任务/指标/事件/愿望；不产 habit_checkin，否定句不产正向事实）。
 *
 * 写作用域：src/application/**（B 所有）。A 交付后无需改这里即可自动切换。
 */

import { addDays, localDate, nowIso } from '../domain/time.js';

let extractionModule = null;
let recomputeModule = null;
try {
  const mod = await import('../domain/extraction.js');
  if (mod && typeof mod.extractCandidates === 'function') extractionModule = mod;
} catch {
  extractionModule = null;
}
try {
  const mod = await import('../domain/recompute.js');
  if (mod && typeof mod.recomputeAfterCorrection === 'function') recomputeModule = mod;
} catch {
  recomputeModule = null;
}

export const USING_EXTERNAL_EXTRACTION = Boolean(extractionModule);
export const USING_EXTERNAL_RECOMPUTE = Boolean(recomputeModule);

const METRIC_UNITS = [
  { re: /(\d+(?:\.\d+)?)\s*(步)/, code: 'steps', unit: '步' },
  { re: /(\d+(?:\.\d+)?)\s*(分钟|min)/, code: 'duration_min', unit: '分钟' },
  { re: /(\d+(?:\.\d+)?)\s*(小时|h)/, code: 'duration_hour', unit: '小时' },
  { re: /(\d+(?:\.\d+)?)\s*(组)/, code: 'sets', unit: '组' },
  { re: /(\d+(?:\.\d+)?)\s*(kg)/i, code: 'weight_kg', unit: 'kg' },
  { re: /(\d+(?:\.\d+)?)\s*(g)(?![a-z])/i, code: 'grams', unit: 'g' },
  { re: /(\d+(?:\.\d+)?)\s*(ml)/i, code: 'volume_ml', unit: 'ml' },
  { re: /(\d+(?:\.\d+)?)\s*(次)/, code: 'count', unit: '次' },
];

const EVENT_VERBS = [
  ['训练', 'exercise'],
  ['锻炼', 'exercise'],
  ['跑步', 'exercise'],
  ['散步', 'exercise'],
  ['游泳', 'exercise'],
  ['瑜伽', 'exercise'],
  ['八段锦', 'exercise'],
  ['冥想', 'health'],
  ['阅读', 'study'],
  ['读书', 'study'],
];
const NEGATION_RE = /(没|没有|没去|没做|未|取消|暂停)/;

function spanOf(text, index, length) {
  return { quote: text.slice(index, index + length), start: index, end: index + length };
}

function parseDateHint(text, localDay) {
  if (/今天/.test(text)) return localDay;
  if (/明天/.test(text)) return addDays(localDay, 1);
  if (/后天/.test(text)) return addDays(localDay, 2);
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const md = /(\d{1,2})月(\d{1,2})日/.exec(text);
  if (md) {
    const year = localDay.slice(0, 4);
    return `${year}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
  }
  const week = /(?:下周|周|星期)([一二三四五六日天1-7])/.exec(text);
  if (week) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };
    const target = map[week[1]];
    if (target) {
      const current = new Date(`${localDay}T00:00:00Z`).getUTCDay() || 7;
      let delta = target - current;
      if (delta <= 0) delta += 7;
      return addDays(localDay, delta);
    }
  }
  if (/之前|截止|前/.test(text)) return null;
  return null;
}

/**
 * Fallback 规则抽取（保守）。返回 M2-PLAN §2.2 的候选数组（无 candidateId，由上层补）。
 */
export function fallbackExtractCandidates(rawText, options = {}) {
  const text = String(rawText || '');
  const localDay = options.localDate || localDate(options.timeZone || 'Asia/Shanghai');
  const now = options.nowIso || nowIso();
  const candidates = [];
  if (!text.trim()) return candidates;

  // 指标（否定句不产正向事实）
  if (!NEGATION_RE.test(text)) {
    for (const { re, code, unit } of METRIC_UNITS) {
      const match = re.exec(text);
      if (!match) continue;
      const value = Number(match[1]);
      if (!Number.isFinite(value)) continue;
      candidates.push({
        kind: 'metric',
        confidence: 0.82,
        source: spanOf(text, match.index, match[0].length),
        fields: {
          metric_code: code,
          value_num: value,
          unit,
          measured_at: now,
          measured_tz: options.timeZone || 'Asia/Shanghai',
          local_date: localDay,
        },
        reasons: [`命中数值+单位「${match[0]}」`],
        risks: [],
        requiresConfirm: false,
      });
    }
  }

  // 过去事实（event）：动词 + 今日；否定句不产
  if (!NEGATION_RE.test(text)) {
    for (const [verb, eventType] of EVENT_VERBS) {
      const index = text.indexOf(verb);
      if (index < 0) continue;
      const day = parseDateHint(text, localDay) || localDay;
      const startIso = `${day}T00:00:00.000Z`;
      candidates.push({
        kind: 'event',
        confidence: 0.7,
        source: spanOf(text, index, verb.length),
        fields: {
          event_type: eventType,
          title: verb,
          occurred_start_at: startIso,
          occurred_tz: options.timeZone || 'Asia/Shanghai',
          occurred_date: day,
          time_precision: 'day',
        },
        reasons: [`命中活动动词「${verb}」`],
        risks: ['发生时间只精确到日'],
        requiresConfirm: false,
      });
      break; // 每句只取一个活动事件，避免过度抽取
    }
  }

  // 任务意图
  const taskMatch =
    /(?:要|需要|得|记得|帮我|提醒我)([^。；\n]{2,60})/.exec(text) ||
    /([^。；\n]{2,40}?)(?:之前|截止)([^。；\n]{0,40})/.exec(text);
  if (taskMatch) {
    const raw = (taskMatch[1] || taskMatch[0]).trim();
    const title = raw.replace(/^(要|需要|得|记得|帮我|提醒我)/, '').trim().slice(0, 500) || raw.slice(0, 500);
    const dueDay = parseDateHint(text, localDay);
    const confirm = /之前|截止|前/.test(text);
    candidates.push({
      kind: 'task',
      confidence: confirm ? 0.78 : 0.72,
      source: spanOf(text, taskMatch.index, taskMatch[0].length),
      fields: {
        title,
        priority: /重要|紧急/.test(text) ? 'high' : 'none',
        due_date: dueDay,
        scheduled_date: null,
      },
      reasons: ['命中任务意图词', dueDay ? `解析日期 ${dueDay}` : '未解析到明确日期'],
      risks: confirm ? ['承诺升级', '日期歧义'] : ['意图可能不明确'],
      requiresConfirm: confirm,
    });
  }

  // 愿望
  const wishMatch = /(?:想|希望|以后)([^。；\n]{2,60})/.exec(text);
  if (wishMatch && !candidates.some((candidate) => candidate.kind === 'task')) {
    candidates.push({
      kind: 'wish',
      confidence: 0.6,
      source: spanOf(text, wishMatch.index, wishMatch[0].length),
      fields: { title: wishMatch[0].trim().slice(0, 500), status: 'captured' },
      reasons: ['命中愿望词'],
      risks: ['愿望未承诺', '时间不明确'],
      requiresConfirm: true,
    });
  }

  // 同 kind 去重（同 title/指标 code）
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.kind}:${candidate.fields.title || candidate.fields.metric_code || candidate.fields.event_type}:${candidate.fields.local_date || candidate.fields.occurred_date || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 合并：优先 A 的外部实现，否则 fallback。 */
export function extractCandidates(rawText, options = {}) {
  if (extractionModule) return extractionModule.extractCandidates(rawText, options);
  return fallbackExtractCandidates(rawText, options);
}

/** 纠错后的派生重算：优先 A 的实现，否则保守返回受影响项。 */
export function recomputeAfterCorrection(input = {}) {
  if (recomputeModule) return recomputeModule.recomputeAfterCorrection(input);
  const before = input.before || {};
  const after = input.after || {};
  const affected = [];
  if (before.metric_code || after.metric_code) affected.push({ type: 'metric_stat', code: after.metric_code || before.metric_code });
  if (before.habit_id || after.habit_id) affected.push({ type: 'habit_streak', habitId: after.habit_id || before.habit_id });
  if (before.event_type || after.event_type) affected.push({ type: 'event_index', eventType: after.event_type || before.event_type });
  return { affected, plan: [], version: 'm2-fallback' };
}

export { parseDateHint };
