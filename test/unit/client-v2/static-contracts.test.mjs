import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const V2_DIR = path.join(ROOT, 'client-v2')
const MAX_LIMIT = 100

function readV2(name) {
  return fs.readFileSync(path.join(V2_DIR, name), 'utf8')
}

function listV2() {
  return fs
    .readdirSync(V2_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()
}

test('client-v2：所有列表请求 limit 不得超过 Host MAX_LIMIT=100', () => {
  const offenders = []
  for (const name of listV2()) {
    const source = readV2(name)
    const pattern = /[?&]limit=(\d+)/g
    let match = pattern.exec(source)
    while (match) {
      const limit = Number(match[1])
      if (limit > MAX_LIMIT) offenders.push({ name, limit })
      match = pattern.exec(source)
    }
  }
  assert.deepEqual(offenders, [], `limit 超过 ${MAX_LIMIT} 的请求会让 Host 返回 422：${JSON.stringify(offenders)}`)
})

test('client-v2：M6 自检暴露调试切 Tab 句柄且带轮询/回退诊断字段', () => {
  const shell = readV2('10-shell.js')
  assert.match(shell, /window\.__lifeosV2Debug\s*=\s*\{/)
  assert.match(shell, /setTab:\s*function setTabFromDebug/)
  assert.match(shell, /getTab:\s*function getTabFromDebug/)
  assert.match(shell, /function runM6SelfCheck\(force\)/)
  assert.match(shell, /persistedTab/)
  assert.match(shell, /rootAlive/)
  assert.match(shell, /via:\s*via/)
  assert.match(shell, /function panelVisible\(\)/)
  assert.match(shell, /visibilityState !== 'visible'/)
  assert.match(shell, /errorVisible/)
})

test('client-v2：手动自检 toast 必须使用 (kind, text) 两参签名', () => {
  const shell = readV2('10-shell.js')
  assert.match(shell, /runtime\.toast\(ok \? 'success' : 'error', message\)/)
  assert.match(shell, /runtime\.toast\('error', '界面自检执行失败'\)/)
})

test('client-v2：快速捕获桥接与随记前 12 字命名', () => {
  const shell = readV2('10-shell.js')
  assert.match(shell, /window\.__lifeosV2OpenCapture\s*=\s*function/)
  assert.match(shell, /function submitCapture\(\)/)
  assert.match(shell, /function captureNoteName\(text\)/)
  assert.match(shell, /\.slice\(0, 12\)/)
  assert.match(shell, /notesCreateApi\('随记\/' \+ name/)
  assert.match(shell, /apiRequest\('\/tasks'/)
  const client = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
  assert.match(client, /window\.__lifeosV2OpenCapture/)
})

test('client-v2：任务 Tab 子任务嵌套与时间 patch 不再携带 timeKind', () => {
  const tasks = readV2('20-tasks.js')
  assert.match(tasks, /function subtasksOf\(taskId\)/)
  assert.match(tasks, /function renderTaskRow\(task, depth(?:, carded)?\)/)
  assert.match(tasks, /const flatScope = state\.scope\.kind === 'done'/)
  assert.match(tasks, /v2IsoAddMinutes/)
  assert.doesNotMatch(tasks, /patchTask\([^)]*timeKind/)
})

test('client-v2：跨清单移动清空分组 / 空清单可建分组 / 清单与分组可拖拽排序', () => {
  const tasks = readV2('20-tasks.js')
  /* 跨清单移动时同时清 groupId，避免 Host 报「分组不属于目标清单」 */
  assert.match(tasks, /patch\.groupId = null/)
  assert.match(tasks, /batchMoveToList/)
  /* 空清单也渲染分组列表，从而保留“新建分组”入口 */
  assert.match(tasks, /if \(listScope\) \{/)
  assert.match(tasks, /return renderGroupedList\(\[\]\)/)
  /* 未分组桶名称固定，不随有无分组变化 */
  assert.match(tasks, /name: '未分组'/)
  assert.doesNotMatch(tasks, /name: groups\.length/)
  /* 清单与分组拖拽排序提交顺序到 Host */
  assert.match(tasks, /'\/lists\/reorder'/)
  assert.match(tasks, /'\/groups\/reorder'/)
  assert.match(tasks, /window\.__lifeosV2DragListId/)
  assert.match(tasks, /window\.__lifeosV2DragGroupId/)
})

test('client-v2：LifeOS 设置页（V2）接通并驱动四个页签', () => {
  const settings = readV2('60-settings.js')
  /* 统一设置存储、默认值、枚举校验与变更广播 */
  assert.match(settings, /const V2_SETTINGS_KEY = 'lifeos\.v2\.settings'/)
  assert.match(settings, /function v2ReadSettings\(\)/)
  assert.match(settings, /function v2UpdateSettings\(patch\)/)
  assert.match(settings, /lifeos:settings-changed/)
  assert.match(settings, /function LifeosSettingsV2\(\)/)
  assert.match(settings, /function v2SettingsApplyCalendarView\(view\)/)
  /* 设置注册优先使用 V2 设置页，并保留旧诊断页回退 */
  const client = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
  assert.match(client, /typeof LifeosSettingsV2 === 'function' \? LifeosSettingsV2 : LifeosSettings/)
  /* 读取点：记住页签 / 任务默认视图与排序 / 日历默认视图 / 习惯暂停分组 / 笔记保存延迟与字号 */
  assert.match(readV2('10-shell.js'), /v2ReadSettings\(\)\.restoreLastTab === false/)
  assert.match(readV2('20-tasks.js'), /view: prefs\.taskView === 'board' \? 'board' : 'list'/)
  assert.match(readV2('20-tasks.js'), /sort: prefs\.taskSort \|\| 'custom'/)
  assert.match(readV2('30-calendar.js'), /v2ReadSettings\(\)\.calendarView/)
  assert.match(readV2('40-habits.js'), /v2ReadSettings\(\)\.habitShowPaused !== false/)
  assert.match(readV2('50-notes.js'), /notesPrefs\.notesAutosaveMs/)
  assert.match(readV2('50-notes.js'), /fontSize: notesFontSize/)
})
