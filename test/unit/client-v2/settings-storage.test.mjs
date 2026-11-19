import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'client-v2', '60-settings.js'), 'utf8')

function createStorage(initial) {
  const data = Object.assign({}, initial || {})
  return {
    data,
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null
    },
    setItem(key, value) {
      data[key] = String(value)
    },
    removeItem(key) {
      delete data[key]
    },
  }
}

function loadSettings(initial) {
  const storage = createStorage(initial)
  const events = []
  class FakeCustomEvent {
    constructor(type, init) {
      this.type = type
      this.detail = init && init.detail
    }
  }
  const sandbox = {
    window: {
      localStorage: storage,
      dispatchEvent(event) {
        events.push(event)
        return true
      },
    },
    CustomEvent: FakeCustomEvent,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: '60-settings.js' })
  vm.runInContext('this.__EXPORTS__ = { v2ReadSettings: v2ReadSettings, v2UpdateSettings: v2UpdateSettings, v2SettingsApplyCalendarView: v2SettingsApplyCalendarView, V2_SETTINGS_DEFAULTS: V2_SETTINGS_DEFAULTS }', sandbox)
  const api = Object.assign({}, sandbox.__EXPORTS__)
  return { sandbox, api, storage, events }
}

test('设置存储：无数据时使用完整默认值', () => {
  const { api } = loadSettings()
  assert.deepEqual(api.v2ReadSettings(), api.V2_SETTINGS_DEFAULTS)
})

test('设置存储：损坏 JSON 与非法枚举回退默认值', () => {
  const { api } = loadSettings({
    'lifeos.v2.settings': '{not-json',
  })
  assert.deepEqual(api.v2ReadSettings(), api.V2_SETTINGS_DEFAULTS)

  const invalid = loadSettings({
    'lifeos.v2.settings': JSON.stringify({
      taskView: 'timeline',
      taskSort: 'random',
      calendarView: 'year',
      habitShowPaused: 'no',
      notesAutosaveMs: 999,
      notesFontSize: 99,
    }),
  })
  assert.deepEqual(invalid.api.v2ReadSettings(), invalid.api.V2_SETTINGS_DEFAULTS)
})

test('设置存储：合法值合并默认值并持久化', () => {
  const { api, storage, events } = loadSettings({
    'lifeos.v2.settings': JSON.stringify({ taskView: 'board', notesFontSize: 15 }),
  })
  const read = api.v2ReadSettings()
  assert.equal(read.taskView, 'board')
  assert.equal(read.notesFontSize, 15)
  assert.equal(read.taskSort, 'custom')
  assert.equal(read.restoreLastTab, true)

  const next = api.v2UpdateSettings({ calendarView: 'month', habitShowPaused: false })
  assert.equal(next.calendarView, 'month')
  assert.equal(next.habitShowPaused, false)
  assert.equal(next.taskView, 'board')
  const persisted = JSON.parse(storage.getItem('lifeos.v2.settings'))
  assert.equal(persisted.calendarView, 'month')
  assert.equal(persisted.taskView, 'board')
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'lifeos:settings-changed')
  assert.equal(events[0].detail.calendarView, 'month')
})

test('设置存储：日历默认视图同步写入日历状态且保留 anchor', () => {
  const { api, storage } = loadSettings({
    'lifeos.v2.calendar': JSON.stringify({ view: 'week', anchor: '2026-11-19' }),
  })
  api.v2SettingsApplyCalendarView('day')
  const calendar = JSON.parse(storage.getItem('lifeos.v2.calendar'))
  assert.equal(calendar.view, 'day')
  assert.equal(calendar.anchor, '2026-11-19')
})

test('设置存储：localStorage 不可用时读取仍返回默认值', () => {
  const sandbox = { window: { localStorage: { getItem() { throw new Error('blocked') } } }, CustomEvent: class {}, console }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: '60-settings.js' })
  vm.runInContext('this.__EXPORTS__ = { v2ReadSettings: v2ReadSettings, V2_SETTINGS_DEFAULTS: V2_SETTINGS_DEFAULTS }', sandbox)
  assert.deepEqual(sandbox.__EXPORTS__.v2ReadSettings(), sandbox.__EXPORTS__.V2_SETTINGS_DEFAULTS)
})
