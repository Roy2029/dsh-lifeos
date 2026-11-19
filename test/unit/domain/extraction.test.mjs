import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CANDIDATE_KINDS,
  buildEvidenceRefs,
  extractCandidates,
  splitClauses,
} from '../../../src/domain/extraction.js'

const LOCAL = '2026-11-13'
const TZ = 'Asia/Shanghai'

function X(text, opts = {}) {
  return extractCandidates(text, { localDate: LOCAL, timeZone: TZ, ...opts })
}
const of = (list, kind) => list.filter((candidate) => candidate.kind === kind)
const first = (list, kind) => of(list, kind)[0]
const codes = (list) => of(list, 'metric').map((candidate) => candidate.fields.metric_code)

/** ≥30 句真实用户风格样本（M2-G2 固定评测集） */
const SAMPLES = [
  '今天没睡好，睡眠时间是00:30-08:30，睡眠时长虽然有8小时，但是起床还是很困。',
  '今天步数9000，做了3组下肢训练力竭组，做了1套八段锦，冥想30分钟；喝了30g蛋白粉和5g肌酸，还吃了两颗维生素D3和甘氨酸镁；今天早晨吃了一份麦片、玉米、鸡蛋和酸奶，正餐吃了有150g肉和两大份绿叶菜。',
  '今天抽空把业余项目的视频剪辑推进了一下，完成了搜集素材和脚本构思编写。',
  '周五之前还要给导师发送实验结果。',
  '我一直想开发一款围棋 RPG。现在我决定认真做这个项目。',
  '今天没有运动。',
  '我没去健身房，也没做八段锦。',
  '今天走了9000步，冥想30分钟。',
  '明天下午3点开会。',
  '提醒我明天上午9点交材料。',
  '每天坚持冥想10分钟。',
  '今天做了1套八段锦。',
  '今天做了30分钟力量训练。',
  '今天步数9000。',
  '今天喝了30g蛋白粉和5g肌酸。',
  '今天吃了两颗维生素D3和甘氨酸镁。',
  '今天早餐吃了一份麦片、玉米、鸡蛋和酸奶。',
  '正餐吃了150g肉和两大份绿叶菜。',
  '后天上午10点去医院。',
  '下周一交材料。',
  '11月20日之前完成实验。',
  '2026-12-01前提交申请。',
  '今天下午2点到4点写文档。',
  '晚上8点跑步。',
  '体重65kg，喝水500ml。',
  '睡了8小时。',
  '今天走了9000步，下午又走了9000步。',
  '我想去日本旅行。',
  '希望今年能瘦到70kg。',
  '今天没做八段锦。',
  '不想开发围棋 RPG。',
  '今天开会开了2小时。',
  '昨天做了一组深蹲。',
  '明天要交报告。',
  '今天读了30分钟论文。',
  '今天心情不好。',
  '今天犯困，起床还是很困。',
  '周五前把实验结果发给导师，另外提醒我买牛奶。',
  '每天坚持跑步30分钟。',
  '喝了2杯咖啡。',
  '凌晨1点睡的。',
  '上周日去了杭州。',
]
const NEGATIVE_SAMPLES = ['今天没有运动。', '我没去健身房，也没做八段锦。', '今天没做八段锦。', '不想开发围棋 RPG。']

function assertSpans(list, rawText) {
  for (const candidate of list) {
    assert.ok(candidate.source.quote.length > 0)
    assert.equal(rawText.slice(candidate.source.start, candidate.source.end), candidate.source.quote, 'span 必须回指原文')
    assert.ok(rawText.includes(candidate.source.quote))
  }
}

test('样本集与候选结构不变量（≥30 句，M2-G2）', () => {
  assert.ok(SAMPLES.length >= 30, `样本数不足：${SAMPLES.length}`)
  for (const text of SAMPLES) {
    const candidates = X(text)
    assertSpans(candidates, text)
    for (const candidate of candidates) {
      assert.ok(CANDIDATE_KINDS.includes(candidate.kind), `非法 kind：${candidate.kind}`)
      assert.match(candidate.candidateId, /^cand_[0-9A-HJKMNP-TV-Z]{26}$/)
      assert.equal(typeof candidate.confidence, 'number')
      assert.ok(candidate.confidence > 0 && candidate.confidence <= 1)
      assert.ok(Array.isArray(candidate.reasons) && candidate.reasons.length > 0)
      assert.ok(Array.isArray(candidate.risks))
      assert.equal(typeof candidate.requiresConfirm, 'boolean')
      assert.equal(typeof candidate.fields, 'object')
      assert.ok(['task', 'event', 'metric', 'habit_checkin', 'wish'].includes(candidate.kind))
      assert.ok(!('ignore' in candidate))
    }
  }
})

test('睡眠区间：event sleep + duration metric + 质量事实', () => {
  const text = SAMPLES[0]
  const candidates = X(text)
  const sleep = of(candidates, 'event').find((candidate) => candidate.fields.event_type === 'sleep' && candidate.fields.occurred_end_at)
  assert.ok(sleep, '应识别睡眠区间事件')
  assert.equal(sleep.fields.title, '睡眠')
  assert.equal(sleep.fields.occurred_start_at, '2026-11-12T16:30:00.000Z') // 本地 11-13 00:30
  assert.equal(sleep.fields.occurred_end_at, '2026-11-13T00:30:00.000Z') // 本地 11-13 08:30
  assert.equal(sleep.fields.duration_minutes, 480)
  assert.equal(sleep.fields.time_precision, 'minute')
  const duration = of(candidates, 'metric').find((candidate) => candidate.fields.metric_code === 'sleep_duration_min')
  assert.ok(duration, '显式"8小时"应产出睡眠时长指标')
  assert.equal(duration.fields.value_num, 480)
  assert.equal(duration.fields.unit, 'min')
  const poor = of(candidates, 'event').find((candidate) => candidate.fields.title === '睡眠质量差')
  assert.ok(poor, '"没睡好"应被标注为睡眠质量差事实')
  assert.equal(poor.requiresConfirm, true)
})

test('大段日常：步数/训练/八段锦/冥想/补剂/早餐/正餐 全部抽取且不混淆单位', () => {
  const text = SAMPLES[1]
  const candidates = X(text)
  const metricCodes = new Set(codes(candidates))
  for (const code of [
    'steps',
    'exercise_sets',
    'meditation_duration_min',
    'protein_powder_g',
    'creatine_g',
    'vitamin_d3_count',
    'food_quantity_g',
  ]) {
    assert.ok(metricCodes.has(code), `缺少指标 ${code}（实际：${[...metricCodes].join(',')}）`)
  }
  const valueOf = (code) => of(candidates, 'metric').find((candidate) => candidate.fields.metric_code === code).fields
  assert.equal(valueOf('steps').value_num, 9000)
  assert.equal(valueOf('steps').unit, 'count')
  assert.equal(valueOf('exercise_sets').value_num, 3)
  assert.equal(valueOf('exercise_sets').unit, 'set')
  assert.equal(valueOf('meditation_duration_min').value_num, 30)
  assert.equal(valueOf('protein_powder_g').value_num, 30)
  assert.equal(valueOf('protein_powder_g').unit, 'g')
  assert.equal(valueOf('creatine_g').value_num, 5)
  assert.equal(valueOf('vitamin_d3_count').value_num, 2)
  assert.equal(valueOf('food_quantity_g').value_num, 150)
  // 习惯打卡：八段锦
  const habit = first(candidates, 'habit_checkin')
  assert.ok(habit)
  assert.equal(habit.fields.habit_key, '八段锦')
  assert.equal(habit.fields.status, 'done')
  assert.equal(habit.fields.local_date, LOCAL)
  // 事件：运动 + 早餐 + 正餐；补剂不当作 meal
  const eventTypes = of(candidates, 'event').map((candidate) => candidate.fields.event_type)
  assert.ok(eventTypes.includes('exercise'))
  assert.ok(eventTypes.includes('meal'))
  assert.equal(
    of(candidates, 'event').some((candidate) => candidate.source.quote.includes('蛋白粉')),
    false,
    '补剂不应产出 meal 事件',
  )
  const breakfast = of(candidates, 'event').find((candidate) => candidate.fields.title === '早餐')
  assert.ok(breakfast)
  assert.deepEqual(breakfast.fields.payload_json.items, ['麦片', '玉米', '鸡蛋', '酸奶'])
  for (const item of breakfast.fields.payload_json.items) assert.ok(text.includes(item), 'payload 条目必须来自原文')
  const mainMeal = of(candidates, 'event').find((candidate) => candidate.fields.title === '正餐')
  assert.ok(mainMeal)
  assert.equal(mainMeal.fields.payload_json.meal_type, 'main_meal')
  // 指标时间不伪造时刻：无具体时刻 → 日精度 + 风险标注
  assert.ok(valueOf('steps').measured_at.startsWith('2026-11-12T16:00:00'), '日精度 measured_at 用本地日 00:00 占位')
})

test('项目进度：保守产出 event(work/study) 且 requiresConfirm', () => {
  const text = '今天抽空把业余项目的视频剪辑推进了一下，完成了搜集素材和脚本构思编写。'
  const candidates = X(text)
  const events = of(candidates, 'event')
  assert.ok(events.length >= 1)
  assert.ok(events.every((candidate) => ['work', 'study'].includes(candidate.fields.event_type)))
  assert.ok(events.every((candidate) => candidate.requiresConfirm === true))
  assert.ok(events.some((candidate) => candidate.risks.includes('语义模糊：描述的是进度而非明确完成标准')))
  assert.equal(of(candidates, 'metric').length, 0, '不应从进度描述编造指标')
})

test('任务意图 + 截止：周五之前发实验结果', () => {
  const text = '周五之前还要给导师发送实验结果。'
  const candidates = X(text)
  assert.equal(candidates.length, 1)
  const task = candidates[0]
  assert.equal(task.kind, 'task')
  assert.equal(task.fields.title, '给导师发送实验结果')
  assert.equal(task.fields.status, 'todo')
  assert.match(task.fields.due_date, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(new Date(`${task.fields.due_date}T00:00:00Z`).getUTCDay(), 5, '应解析为周五')
  assert.ok(task.fields.due_date >= LOCAL)
  assert.equal(task.requiresConfirm, true)
  assert.ok(task.risks.some((risk) => risk.includes('承诺')))
  assert.ok(task.reasons.some((reason) => reason.includes('截止')))
})

test('愿望：想开发围棋 RPG → 只产 wish 且必须确认', () => {
  const candidates = X('我一直想开发一款围棋 RPG。现在我决定认真做这个项目。')
  const wishes = of(candidates, 'wish')
  assert.equal(wishes.length, 1)
  assert.equal(wishes[0].fields.title, '开发一款围棋 RPG')
  assert.equal(wishes[0].fields.status, 'captured')
  assert.equal(wishes[0].requiresConfirm, true)
  assert.equal(of(candidates, 'task').length, 0, '愿望不得直接升级为任务')
  assert.equal(of(candidates, 'event').length, 0, '决定/计划不得当作已发生事实')
})

test('否定句：不产正向事实（event/metric/habit_checkin/wish/task 均不产）', () => {
  for (const text of NEGATIVE_SAMPLES) {
    const candidates = X(text)
    assert.equal(candidates.length, 0, `否定句不应产候选：${text} → ${JSON.stringify(candidates)}`)
  }
})

test('歧义数字：30g 与 30 分钟按单位区分，不混用', () => {
  const candidates = X('今天喝了30g蛋白粉，冥想30分钟。')
  const protein = of(candidates, 'metric').find((candidate) => candidate.fields.metric_code === 'protein_powder_g')
  const meditation = of(candidates, 'metric').find((candidate) => candidate.fields.metric_code === 'meditation_duration_min')
  assert.equal(protein.fields.value_num, 30)
  assert.equal(protein.fields.unit, 'g')
  assert.equal(meditation.fields.value_num, 30)
  assert.equal(meditation.fields.unit, 'min')
  assert.equal(protein.fields.measured_at.slice(0, 10), meditation.fields.measured_at.slice(0, 10))
})

test('同类去重：同一天重复提到步数只保留一条', () => {
  const candidates = X('今天走了9000步，下午又走了9000步。')
  const steps = of(candidates, 'metric').filter((candidate) => candidate.fields.metric_code === 'steps')
  assert.equal(steps.length, 1)
})

test('习惯打卡：做了1套八段锦', () => {
  const candidates = X('今天做了1套八段锦。')
  const habit = candidates.find((candidate) => candidate.kind === 'habit_checkin')
  assert.ok(habit)
  assert.equal(habit.fields.habit_key, '八段锦')
  assert.equal(habit.fields.local_date, LOCAL)
  assert.equal(habit.fields.status, 'done')
  assert.equal(habit.fields.checkin_kind, 'from_event')
  assert.deepEqual(habit.fields.value_json, { amount: 1, unit: '套' })
  assert.equal(habit.requiresConfirm, false)
})

test('时间表达矩阵：今天/明天/后天/下周X/月日/绝对日期/时间段/时刻', () => {
  const tomorrowTask = X('明天要交报告。')[0]
  assert.equal(tomorrowTask.kind, 'task')
  assert.equal(tomorrowTask.fields.scheduled_date, '2026-11-14')
  assert.equal(tomorrowTask.requiresConfirm, true)

  const dayAfter = X('后天上午10点去医院。')[0]
  assert.equal(dayAfter.kind, 'task')
  assert.equal(dayAfter.fields.scheduled_start_at, '2026-11-15T02:00:00.000Z')

  const nextWeek = X('下周一交材料。')[0]
  assert.equal(nextWeek.kind, 'task')
  assert.ok(nextWeek.fields.scheduled_date > '2026-11-17', `下周X 应晚于本周：${nextWeek.fields.scheduled_date}`)

  const monthDay = X('11月20日之前完成实验。')[0]
  assert.equal(monthDay.kind, 'task')
  assert.equal(monthDay.fields.due_date, '2026-11-20')

  const absolute = X('2026-12-01前提交申请。')[0]
  assert.equal(absolute.fields.due_date, '2026-12-01')

  const span = X('今天下午2点到4点写文档。')[0]
  assert.equal(span.kind, 'task')
  assert.equal(span.fields.scheduled_start_at, '2026-11-13T06:00:00.000Z')
  assert.equal(span.fields.scheduled_end_at, '2026-11-13T08:00:00.000Z')
  assert.equal(span.fields.time_kind, 'span')

  const meeting = X('明天下午3点开会。')[0]
  assert.equal(meeting.kind, 'task')
  assert.equal(meeting.fields.scheduled_start_at, '2026-11-14T07:00:00.000Z')
  assert.equal(meeting.fields.time_kind, 'datetime')

  const reminder = X('提醒我明天上午9点交材料。')[0]
  assert.equal(reminder.kind, 'task')
  assert.equal(reminder.fields.scheduled_start_at, '2026-11-14T01:00:00.000Z')
  assert.equal(reminder.requiresConfirm, true)
})

test('指标单位矩阵：kg/ml/次/杯 与未知编码确认', () => {
  const candidates = X('体重65kg，喝水500ml，喝了2杯咖啡。')
  const byCode = Object.fromEntries(
    of(candidates, 'metric').map((candidate) => [candidate.fields.metric_code, candidate]),
  )
  assert.equal(byCode.body_weight_kg.fields.value_num, 65)
  assert.equal(byCode.body_weight_kg.fields.unit, 'kg')
  assert.equal(byCode.water_ml.fields.value_num, 500)
  assert.equal(byCode.other_cup.fields.value_num, 2)
  assert.equal(byCode.other_cup.requiresConfirm, true, '未知编码必须确认')
})

test('不编造：指标值来自原文数字，payload 条目来自原文', () => {
  for (const text of SAMPLES) {
    for (const candidate of of(X(text), 'metric')) {
      const quote = candidate.source.quote
      const value = candidate.fields.value_num
      const digits = String(value)
      const fromHours = candidate.fields.unit === 'min' && value % 60 === 0 && quote.includes(String(value / 60)) && quote.includes('小时')
      const cnSource = /[一二两三四五六七八九十]/.test(quote)
      assert.ok(quote.includes(digits) || fromHours || cnSource, `指标值 ${value} 不在原文片段「${quote}」中`)
    }
    for (const candidate of of(X(text), 'event')) {
      const items = candidate.fields.payload_json?.items
      if (Array.isArray(items)) {
        for (const item of items) assert.ok(text.includes(item), `payload 条目不在原文：${item}`)
      }
    }
  }
})

test('buildEvidenceRefs：04 §8.4 结构 + span 回指', () => {
  const text = SAMPLES[0]
  const candidate = X(text, { rawRecordId: 'rr_test' })[0]
  const refs = buildEvidenceRefs(candidate)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].type, 'raw_record')
  assert.equal(refs[0].id, 'rr_test')
  assert.deepEqual(refs[0].locator.span, [candidate.source.start, candidate.source.end])
  assert.equal(refs[0].excerpt, candidate.source.quote)
  assert.equal(text.slice(...refs[0].locator.span), refs[0].excerpt)
  // 无 rawRecordId 时返回空（不伪造证据）
  assert.deepEqual(buildEvidenceRefs({ source: candidate.source }), [])
  assert.deepEqual(buildEvidenceRefs(null), [])
})

test('splitClauses：偏移可回指原文', () => {
  const text = '今天做了3组训练，晚上跑了5公里。明天要交报告。'
  const clauses = splitClauses(text)
  assert.ok(clauses.length >= 3)
  for (const clause of clauses) assert.equal(text.slice(clause.start, clause.end), clause.quote)
})

test('输入校验：非法 rawText / localDate 抛 TypeError', () => {
  assert.throws(() => extractCandidates(42, { localDate: LOCAL }), TypeError)
  assert.throws(() => extractCandidates('x', { localDate: '2026-02-30' }), TypeError)
  assert.throws(() => extractCandidates('x', {}), TypeError)
})
