/** B：M2.5 笔记文件监听测试（真实 fs + 临时目录；抖动容错）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { startNoteWatch, isManagedPath } from '../../../src/runtime/note-watch.js';

function tempDir(prefix = 'lifeos-watch-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 25 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function makeWatch(root, overrides = {}) {
  const events = [];
  const watch = startNoteWatch({
    root,
    debounceMs: 60,
    pollMs: 40,
    onChange: (change) => events.push(change),
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  });
  return { watch, events };
}

test('isManagedPath：只管理 md/markdown/txt，忽略历史/垃圾/临时', () => {
  assert.equal(isManagedPath('日记/2026-11-13.md'), true);
  assert.equal(isManagedPath('a/b/c.txt'), true);
  assert.equal(isManagedPath('a/b/c.markdown'), true);
  assert.equal(isManagedPath('a/b/c.png'), false);
  assert.equal(isManagedPath('.lifeos-history/a.md'), false);
  assert.equal(isManagedPath('a/.trash/b.md'), false);
  assert.equal(isManagedPath('a/~$b.md'), false);
  assert.equal(isManagedPath('a/b.md.tmp'), false);
  assert.equal(isManagedPath('a/.DS_Store'), false);
});

test('watch：新增/修改/删除文件产生 add/change/unlink（真实 fs，抖动容错）', async () => {
  const dir = tempDir();
  const { watch, events } = makeWatch(dir);
  try {
    writeFileSync(join(dir, 'note-a.md'), '# hello', 'utf8');
    const added = await waitFor(() => events.some((event) => event.path === 'note-a.md' && event.kind === 'add'));
    if (!added) {
      // fs.watch 在某些环境不触发：用 scanOnce 兜底同样验证语义
      watch.scanOnce();
      assert.ok(events.some((event) => event.path === 'note-a.md' && event.kind === 'add'));
    }

    appendFileSync(join(dir, 'note-a.md'), '\nmore', 'utf8');
    const changed = await waitFor(() => events.some((event) => event.path === 'note-a.md' && event.kind === 'change'));
    if (!changed) {
      watch.scanOnce();
      assert.ok(events.some((event) => event.path === 'note-a.md' && event.kind === 'change'));
    }

    unlinkSync(join(dir, 'note-a.md'));
    const removed = await waitFor(() => events.some((event) => event.path === 'note-a.md' && event.kind === 'unlink'));
    if (!removed) {
      watch.scanOnce();
      assert.ok(events.some((event) => event.path === 'note-a.md' && event.kind === 'unlink'));
    }
    for (const event of events) {
      assert.equal(typeof event.at, 'string');
      assert.equal(event.path.includes('\\'), false, 'path 必须是 / 分隔的相对路径');
    }
  } finally {
    watch.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watch：忽略 .trash/.lifeos-history/临时/非 md 文件', async () => {
  const dir = tempDir();
  const { watch, events } = makeWatch(dir, { forcePolling: true });
  try {
    mkdirSync(join(dir, '.trash'));
    mkdirSync(join(dir, '.lifeos-history'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, '.trash', 'x.md'), 'x');
    writeFileSync(join(dir, '.lifeos-history', 'y.md'), 'y');
    writeFileSync(join(dir, '~$tmp.md'), 'z');
    writeFileSync(join(dir, 'image.png'), 'png');
    writeFileSync(join(dir, 'sub', 'ok.md'), '# ok');
    await waitFor(() => events.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(events.map((event) => event.path), ['sub/ok.md']);
    assert.equal(watch.getMode(), 'poll');
  } finally {
    watch.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watch：轮询兜底检测 add/change/unlink；scanOnce 可直接调用', async () => {
  const dir = tempDir();
  const watch = startNoteWatch({
    root: dir,
    forcePolling: true,
    pollMs: 30,
    debounceMs: 0,
    onChange: () => {},
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    writeFileSync(join(dir, 'a.md'), '1');
    const first = watch.scanOnce();
    assert.deepEqual(first.map((change) => [change.path, change.kind]), [['a.md', 'add']]);
    writeFileSync(join(dir, 'a.md'), '22');
    const second = watch.scanOnce();
    assert.deepEqual(second.map((change) => [change.path, change.kind]), [['a.md', 'change']]);
    unlinkSync(join(dir, 'a.md'));
    const third = watch.scanOnce();
    assert.deepEqual(third.map((change) => [change.path, change.kind]), [['a.md', 'unlink']]);
    assert.ok(watch.stats().scans >= 3);
  } finally {
    watch.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watch：updateRoot 重建监听并切换相对路径基准', async () => {
  const dirA = tempDir('lifeos-watch-a-');
  const dirB = tempDir('lifeos-watch-b-');
  const events = [];
  const watch = startNoteWatch({
    root: dirA,
    forcePolling: true,
    pollMs: 30,
    debounceMs: 0,
    onChange: (change) => events.push(change),
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    writeFileSync(join(dirA, 'a.md'), 'a');
    watch.scanOnce();
    assert.ok(events.some((event) => event.path === 'a.md'));
    const result = watch.updateRoot(dirB);
    assert.equal(result.rebuilt, true);
    assert.equal(watch.getRoot(), dirB);
    writeFileSync(join(dirB, 'b.md'), 'b');
    await waitFor(() => events.some((event) => event.path === 'b.md' && event.kind === 'add'));
    assert.equal(events.some((event) => event.path === 'b.md'), true);
  } finally {
    watch.stop();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('watch：未配置 root 不启动；stop 后不再产生事件', async () => {
  const idle = startNoteWatch({ root: '', onChange: () => {}, logger: { info() {}, warn() {}, error() {} } });
  assert.equal(idle.getMode(), 'idle');
  idle.stop();
  assert.equal(idle.getMode(), 'stopped');

  const dir = tempDir();
  const events = [];
  const watch = startNoteWatch({
    root: dir,
    forcePolling: true,
    pollMs: 20,
    onChange: (change) => events.push(change),
    logger: { info() {}, warn() {}, error() {} },
  });
  watch.stop();
  writeFileSync(join(dir, 'late.md'), 'late');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(events.length, 0);
  rmSync(dir, { recursive: true, force: true });
});
