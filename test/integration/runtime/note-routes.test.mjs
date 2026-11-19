/** B：M2.5 笔记 HTTP/SSE 路由测试（mock note service + 直调 handler）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEventBus, createSseServer, publishNoteChange } from '../../../src/runtime/sse.js';
import { createRoutes } from '../../../src/runtime/routes.js';
import { LifeosError } from '../../../src/application/errors.js';
import { call, callWrite, makeReq, makeRes } from '../helpers/fake-http.mjs';

function fakeService() {
  return {
    status: () => ({
      ok: true,
      degraded: false,
      units: {},
      counts: { inboxPending: 0, today: 0 },
      version: '0.0.1',
      timeZone: 'Asia/Shanghai',
      backend: 'fake',
      diagnosticsPath: null,
    }),
    bootstrap: () => ({ apiVersion: '0.4', today: { date: '2026-11-13', tasks: [], inboxCount: 0 } }),
  };
}

function makeNotesMock() {
  const files = new Map();
  const calls = { setConfig: 0, write: 0, create: 0, rename: 0, remove: 0, snapshot: 0, mkdir: 0 };
  const folders = new Set(['日记']);
  let config = { dir: 'C:/Notes', options: { autosaveMs: 800 }, exists: true, writable: true };
  const hashOf = (content) => `hash-${content.length}-${content.slice(0, 4)}`.padEnd(12, '0');
  const recordOf = (path) => ({ path, content: files.get(path).content, mtime: files.get(path).mtime, hash: files.get(path).hash, size: files.get(path).content.length, encoding: 'utf-8' });
  return {
    calls,
    seed(path, content) {
      files.set(path, { content, mtime: '2026-11-13T10:00:00.000Z', hash: hashOf(content) });
    },
    hashOf,
    getConfig: () => ({ ...config }),
    setConfig(input) {
      calls.setConfig += 1;
      if (input.dir) config = { ...config, dir: input.dir };
      if (input.create) config = { ...config, exists: true };
      if (input.options) config = { ...config, options: input.options };
      return { ...config };
    },
    list: () => ({ entries: [...files.keys()].map((path) => ({ name: path.split('/').pop(), path, type: 'file', size: files.get(path).content.length, mtime: files.get(path).mtime, editable: true })) }),
    read: ({ path }) => {
      if (!files.has(path)) throw new LifeosError('not_found', `文件不存在：${path}`);
      return recordOf(path);
    },
    write({ path, content, baseHash }) {
      calls.write += 1;
      const current = files.get(path);
      if (!current) throw new LifeosError('not_found', `文件不存在：${path}`);
      if (baseHash && current.hash !== baseHash) {
        throw new LifeosError('conflict', '文件已在外部修改', { currentHash: current.hash, mtime: current.mtime });
      }
      const next = { content, mtime: '2026-11-13T11:00:00.000Z', hash: hashOf(content) };
      files.set(path, next);
      return { path, mtime: next.mtime, hash: next.hash, size: content.length, created: false };
    },
    create({ path, content }) {
      calls.create += 1;
      if (files.has(path)) throw new LifeosError('path_exists', `文件已存在：${path}`);
      const next = { content, mtime: '2026-11-13T11:00:00.000Z', hash: hashOf(content) };
      files.set(path, next);
      return { path, mtime: next.mtime, hash: next.hash };
    },
    mkdir({ path, recursive }) {
      calls.mkdir += 1;
      if (folders.has(path) || files.has(path)) throw new LifeosError('path_exists', `目录已存在：${path}`);
      if (!recursive) {
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        if (parent && !folders.has(parent)) throw new LifeosError('parent_not_found', `父目录不存在：${parent}`);
      } else {
        const parts = path.split('/');
        for (let index = 1; index <= parts.length; index += 1) folders.add(parts.slice(0, index).join('/'));
      }
      folders.add(path);
      return { path, created: true };
    },
    rename({ path, toPath }) {
      calls.rename += 1;
      if (folders.has(path)) {
        if (folders.has(toPath) || files.has(toPath)) throw new LifeosError('path_exists', `目标已存在：${toPath}`);
        folders.delete(path);
        folders.add(toPath);
        return { path: toPath };
      }
      if (!files.has(path)) throw new LifeosError('not_found', `文件不存在：${path}`);
      if (files.has(toPath) || folders.has(toPath)) throw new LifeosError('path_exists', `目标已存在：${toPath}`);
      files.set(toPath, files.get(path));
      files.delete(path);
      return { path: toPath };
    },
    remove({ path, trash, recursive }) {
      calls.remove += 1;
      if (folders.has(path)) {
        if (trash === false) throw new LifeosError('validation_failed', '文件夹必须进回收站');
        const hasChild = [...files.keys()].some((key) => key.startsWith(`${path}/`))
          || [...folders].some((folder) => folder.startsWith(`${path}/`));
        if (hasChild && !recursive) throw new LifeosError('validation_failed', '目录非空，需 recursive:true');
        for (const key of [...files.keys()]) if (key.startsWith(`${path}/`)) files.delete(key);
        for (const folder of [...folders]) if (folder === path || folder.startsWith(`${path}/`)) folders.delete(folder);
        return { removed: true, trashPath: `.trash/ts-${path.split('/').pop()}`, recursive: true };
      }
      if (!files.has(path)) throw new LifeosError('not_found', `文件不存在：${path}`);
      files.delete(path);
      return { removed: true, trashPath: trash ? `.trash/${path}` : null };
    },
    search: ({ q }) => ({ items: [...files.entries()].filter(([, value]) => value.content.includes(q)).map(([path, value]) => ({ path, title: path, snippet: value.content.slice(0, 40), mtime: value.mtime })) }),
    history: ({ path }) => ({ items: files.has(path) ? [{ id: 'snap_1', at: '2026-11-13T10:00:00.000Z', size: files.get(path).content.length }] : [] }),
    snapshot({ path }) {
      calls.snapshot += 1;
      if (!files.has(path)) throw new LifeosError('not_found', `文件不存在：${path}`);
      return { snapshotPath: `history/${path}`, mtime: files.get(path).mtime };
    },
    _files: files,
  };
}

function makeHarness({ notes } = {}) {
  const bus = createEventBus();
  const sse = createSseServer({ bus, heartbeatMs: 60000, setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} });
  const notesMock = notes === undefined ? makeNotesMock() : notes;
  const configEvents = [];
  const routes = createRoutes({
    service: fakeService(),
    diagnostics: null,
    sse,
    config: { devMode: false },
    connection: null,
    notes: notesMock,
    onNotesConfig: (configValue) => configEvents.push(configValue),
    now: () => Date.parse('2026-11-13T12:00:00.000Z'),
  });
  return { routes, bus, sse, notes: notesMock, configEvents };
}

function jsonBody(value) {
  return JSON.stringify(value);
}

test('GET /notes/config + PUT /notes/config（写成功回调 + 幂等）', async () => {
  const { routes, notes, configEvents } = makeHarness();
  const config = await call(routes, { url: '/api/lifeos/notes/config' });
  assert.equal(config.status, 200);
  assert.equal(config.json().value.dir, 'C:/Notes');
  assert.equal(config.headers['x-lifeos-api'], '0.7');

  const body = ({ dir: 'D:/Notes', create: true, requestId: 'cfg-1' });
  const first = await callWrite(routes, { method: 'PUT', url: '/api/lifeos/notes/config', body });
  assert.equal(first.status, 200);
  assert.equal(first.json().value.dir, 'D:/Notes');
  const second = await callWrite(routes, { method: 'PUT', url: '/api/lifeos/notes/config', body });
  assert.equal(second.status, 200);
  assert.equal(second.json().value.dir, 'D:/Notes');
  assert.equal(notes.calls.setConfig, 1, '同 requestId 幂等只调用一次');
  assert.equal(configEvents.length, 1);

  const invalid = await callWrite(routes, { method: 'PUT', url: '/api/lifeos/notes/config', body: ({}) });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.json().error.code, 'validation_failed');
});

test('GET tree/file/search/history 端点', async () => {
  const { routes, notes } = makeHarness();
  notes.seed('日记/2026-11-13.md', '# 今天');
  const tree = await call(routes, { url: '/api/lifeos/notes/tree?dir=&depth=2' });
  assert.equal(tree.status, 200);
  assert.equal(tree.json().value.entries.length, 1);
  assert.equal(tree.json().value.entries[0].path, '日记/2026-11-13.md');

  const file = await call(routes, { url: '/api/lifeos/notes/file?path=' + encodeURIComponent('日记/2026-11-13.md') });
  assert.equal(file.status, 200);
  assert.equal(file.json().value.content, '# 今天');

  const search = await call(routes, { url: '/api/lifeos/notes/search?q=' + encodeURIComponent('今天') });
  assert.equal(search.status, 200);
  assert.equal(search.json().value.items.length, 1);

  const history = await call(routes, { url: '/api/lifeos/notes/history?path=' + encodeURIComponent('日记/2026-11-13.md') });
  assert.equal(history.status, 200);
  assert.equal(history.json().value.items.length, 1);

  const missing = await call(routes, { url: '/api/lifeos/notes/file?path=' + encodeURIComponent('nope.md') });
  assert.equal(missing.status, 404);
  assert.equal(missing.json().error.code, 'not_found');
});

test('PUT /notes/file：成功 / 409 conflict 带 currentHash+mtime / 422 非法 path', async () => {
  const { routes, notes } = makeHarness();
  notes.seed('a.md', 'v1');
  const ok1 = await callWrite(routes, {
    method: 'PUT',
    url: '/api/lifeos/notes/file',
    body: ({ path: 'a.md', content: 'version-2', baseHash: notes.hashOf('v1') }),
  });
  assert.equal(ok1.status, 200);
  assert.equal(ok1.json().value.hash, notes.hashOf('version-2'));

  const conflict = await callWrite(routes, {
    method: 'PUT',
    url: '/api/lifeos/notes/file',
    body: ({ path: 'a.md', content: 'v3', baseHash: 'stale-hash-123' }),
  });
  assert.equal(conflict.status, 409);
  const error = conflict.json().error;
  assert.equal(error.code, 'conflict');
  assert.equal(error.details.currentHash, notes.hashOf('version-2'));
  assert.equal(typeof error.details.mtime, 'string');

  const forbidden = await callWrite(routes, {
    method: 'PUT',
    url: '/api/lifeos/notes/file',
    body: ({ path: '../escape.md', content: 'x' }),
  });
  assert.equal(forbidden.status, 422);
  assert.equal(forbidden.json().error.code, 'validation_failed');
});

test('POST /notes/file：创建成功 / 已存在 409 path_exists / 非法扩展名 422', async () => {
  const { routes } = makeHarness();
  const created = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/file', body: ({ path: 'new-note', content: 'hi' }) });
  assert.equal(created.status, 200);
  assert.equal(created.json().value.path, 'new-note.md');

  const duplicate = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/file', body: ({ path: 'new-note.md', content: 'hi' }) });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json().error.code, 'path_exists');

  const bad = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/file', body: ({ path: 'image.png' }) });
  assert.equal(bad.status, 422);
});

test('POST rename / remove / snapshot 端点', async () => {
  const { routes, notes } = makeHarness();
  notes.seed('a.md', 'a');
  const renamed = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/rename', body: ({ path: 'a.md', toPath: 'b.md' }) });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json().value.path, 'b.md');

  const snapshot = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/snapshot', body: ({ path: 'b.md' }) });
  assert.equal(snapshot.status, 200);
  assert.match(snapshot.json().value.snapshotPath, /history/);

  const removed = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/remove', body: ({ path: 'b.md' }) });
  assert.equal(removed.status, 200);
  assert.equal(removed.json().value.removed, true);
  assert.match(removed.json().value.trashPath, /^\.trash\//);

  const again = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/remove', body: ({ path: 'b.md' }) });
  assert.equal(again.status, 404);
});

test('写接口幂等：同 requestId 只写一次，重复写同内容不报错', async () => {
  const { routes, notes } = makeHarness();
  notes.seed('a.md', 'v1');
  const body = ({ path: 'a.md', content: 'v2', requestId: 'w-1' });
  const first = await callWrite(routes, { method: 'PUT', url: '/api/lifeos/notes/file', body });
  const second = await callWrite(routes, { method: 'PUT', url: '/api/lifeos/notes/file', body });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.json().value, first.json().value);
  assert.equal(notes.calls.write, 1);

  const third = await callWrite(routes, {
    method: 'PUT',
    url: '/api/lifeos/notes/file',
    body: ({ path: 'a.md', content: 'v2' }),
  });
  assert.equal(third.status, 200, '重复写同内容不应报错');
});

test('错误码别名：PATH_FORBIDDEN/file_too_large 映射到 422', async () => {
  const notes = makeNotesMock();
  const originalRead = notes.read;
  notes.read = () => {
    const error = new Error('path escapes root');
    error.code = 'PATH_FORBIDDEN';
    throw error;
  };
  const { routes } = makeHarness({ notes });
  const forbidden = await call(routes, { url: '/api/lifeos/notes/file?path=a.md' });
  assert.equal(forbidden.status, 422);
  assert.equal(forbidden.json().error.code, 'path_forbidden');

  notes.read = () => {
    const error = new Error('too large');
    error.code = 'file_too_large';
    throw error;
  };
  const large = await call(routes, { url: '/api/lifeos/notes/file?path=a.md' });
  assert.equal(large.status, 422);
  assert.equal(large.json().error.code, 'file_too_large');
  notes.read = originalRead;
});

test('notes 未装配：全部 notes 端点 503 notes_unavailable；M2 健康检查不回归', async () => {
  const { routes } = makeHarness({ notes: null });
  const config = await call(routes, { url: '/api/lifeos/notes/config' });
  assert.equal(config.status, 503);
  assert.equal(config.json().error.code, 'notes_unavailable');
  const health = await call(routes, { url: '/api/lifeos/health' });
  assert.equal(health.status, 200);
  assert.equal(health.json().ok, true);
});

test('SSE：publishNoteChange 广播 event: notes/changed（path/kind 形状）', async () => {
  const { routes, bus, sse } = makeHarness();
  const req = makeReq({ url: '/api/lifeos/events', headers: { accept: 'text/event-stream' } });
  const res = makeRes();
  await routes.handle(req, res);
  assert.match(res.text(), /event: hello/);

  publishNoteChange(bus, { path: '日记/2026-11-13.md', kind: 'change' });
  publishNoteChange(bus, { path: '新笔记.md', kind: 'add' });
  publishNoteChange(bus, { path: '旧笔记.md', kind: 'unlink' });
  const stream = res.text();
  assert.match(stream, /event: notes\/changed/);
  assert.match(stream, /"path":"日记\/2026-11-13\.md"/);
  assert.match(stream, /"kind":"add"/);
  assert.match(stream, /"kind":"unlink"/);
  const payloads = stream
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((payload) => payload && typeof payload.path === 'string');
  assert.equal(payloads.length >= 3, true);
  for (const payload of payloads) {
    assert.equal(typeof payload.path, 'string');
    assert.ok(['add', 'change', 'unlink'].includes(payload.kind));
    assert.equal(typeof payload.at, 'string');
  }
  sse.close();
});

/* ───────── M2.6：文件夹端点 ───────── */

test('POST /notes/folder：创建成功 / 已存在 409 / 非法路径 422 / requestId 幂等', async () => {
  const { routes, notes } = makeHarness();
  const body = { path: '日记/2026', requestId: 'fold-1' };
  const first = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/folder', body });
  assert.equal(first.status, 200);
  assert.equal(first.json().value.path, '日记/2026');
  const second = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/folder', body });
  assert.equal(second.status, 200);
  assert.equal(notes.calls.mkdir, 1, '同 requestId 幂等只 mkdir 一次');

  const dup = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/folder', body: { path: '日记/2026' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.json().error.code, 'path_exists');

  const forbidden = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/folder', body: { path: '../escape' } });
  assert.equal(forbidden.status, 422);
  assert.equal(forbidden.json().error.code, 'validation_failed');
});

test('POST /notes/folder：parents 映射 recursive；parent_not_found 映射 422', async () => {
  const { routes, notes } = makeHarness();
  const created = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/folder', body: { path: '深/层/目录', parents: true } });
  assert.equal(created.status, 200);
  assert.equal(notes.calls.mkdir, 1);

  const checked = [];
  const originalMkdir = notes.mkdir;
  notes.mkdir = (input) => {
    checked.push(input);
    return originalMkdir(input);
  };
  const parentMissing = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/folder', body: { path: '不存在/x' } });
  assert.equal(parentMissing.status, 422);
  assert.equal(parentMissing.json().error.code, 'parent_not_found');
  assert.equal(checked.length, 1);
  assert.equal(checked[0].recursive, false);
});

test('文件夹 rename 支持目录；rename 文件仍自动补 .md', async () => {
  const { routes, notes } = makeHarness();
  const renamed = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/rename', body: { path: '日记', toPath: '2026日记' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json().value.path, '2026日记');

  notes.seed('a.md', 'a');
  const fileRenamed = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/rename', body: { path: 'a.md', toPath: 'b' } });
  assert.equal(fileRenamed.status, 200);
  assert.equal(fileRenamed.json().value.path, 'b.md');

  notes.seed('c.md', 'c');
  const dupTarget = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/rename', body: { path: 'b.md', toPath: 'c.md' } });
  assert.equal(dupTarget.status, 409);
  assert.equal(dupTarget.json().error.code, 'path_exists');
});

test('文件夹 remove：recursive 成功进 .trash / 非空未传 recursive 422 / trash:false 拒绝', async () => {
  const { routes } = makeHarness();
  await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/folder', body: { path: '临时/子', parents: true } });
  await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/file', body: { path: '临时/子/a.md', content: 'x' } });

  const blocked = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/remove', body: { path: '临时' } });
  assert.equal(blocked.status, 422);

  const noTrash = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/remove', body: { path: '临时', recursive: true, trash: false } });
  assert.equal(noTrash.status, 422);

  const removed = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/remove', body: { path: '临时', recursive: true } });
  assert.equal(removed.status, 200);
  assert.match(removed.json().value.trashPath, /^\.trash\//);

  const again = await callWrite(routes, { method: 'POST', url: '/api/lifeos/notes/remove', body: { path: '临时', recursive: true } });
  assert.equal(again.status, 404);
});
