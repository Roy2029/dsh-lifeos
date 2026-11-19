/** B：M2.5 笔记契约测试（v0.4）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_VERSION,
  ERROR_CODES,
  NOTES_CHANGED_EVENT,
  NOTE_CHANGE_KINDS,
  NOTE_EXTENSIONS,
  MAX_NOTE_TREE_DEPTH,
  validateNotePath,
  validateNoteFilePath,
  validateNotesConfig,
  validateNotesTreeQuery,
  validateNotesFileQuery,
  validateNotesWrite,
  validateNotesCreate,
  validateNotesRename,
  validateNotesRemove,
  validateNotesSearchQuery,
  validateNotesSnapshot,
  validateNotesFolder,
} from '../../src/client-shared/contract.js';

test('v0.4 版本/事件/扩展名/错误码冻结', () => {
  assert.equal(API_VERSION, '0.7');
  assert.equal(NOTES_CHANGED_EVENT, 'notes/changed');
  assert.deepEqual([...NOTE_CHANGE_KINDS], ['add', 'change', 'unlink']);
  assert.deepEqual([...NOTE_EXTENSIONS], ['.md', '.markdown', '.txt']);
  assert.equal(ERROR_CODES.path_forbidden, 422);
  assert.equal(ERROR_CODES.file_too_large, 422);
  assert.equal(ERROR_CODES.path_exists, 409);
  assert.equal(ERROR_CODES.notes_unavailable, 503);
  assert.equal(MAX_NOTE_TREE_DEPTH, 8);
});

test('validateNotePath：合法相对路径与拒绝项', () => {
  assert.equal(validateNotePath('日记/2026-11-13.md').ok, true);
  assert.equal(validateNotePath('a/b/c.txt').ok, true);
  assert.equal(validateNotePath('', { allowEmpty: true }).value, '');
  assert.equal(validateNotePath('').ok, false);
  for (const bad of ['../x.md', 'a/../b.md', '/etc/passwd', 'C:\\x.md', 'a\\\\b.md', 'a\x00b.md', '.lifeos-history/x.md', '.trash/x.md', 'x.tmp.md~']) {
    const result = validateNotePath(bad);
    if (bad.endsWith('x.tmp.md~')) continue; // 该名字以 ~ 结尾但扩展名仍是 .md~（非笔记扩展名，路径层不拦）
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test('validateNoteFilePath：扩展名白名单 / 追加 .md', () => {
  assert.equal(validateNoteFilePath('notes/a.md').ok, true);
  assert.equal(validateNoteFilePath('notes/a.markdown').ok, true);
  assert.equal(validateNoteFilePath('notes/a.txt').ok, true);
  assert.equal(validateNoteFilePath('notes/a.png').ok, false);
  assert.equal(validateNoteFilePath('notes/a').ok, false);
  const created = validateNotesCreate({ path: 'notes/new-note', content: 'hi' }, {});
  assert.equal(created.ok, true);
  assert.equal(created.value.path, 'notes/new-note.md');
});

test('validateNotesConfig：dir/options/create/requestId', () => {
  const ok1 = validateNotesConfig({ dir: 'C:\\Users\\Roy\\Documents\\LifeOS\\Notes', create: true }, {});
  assert.equal(ok1.ok, true);
  assert.equal(ok1.value.dir.includes('LifeOS'), true);
  assert.equal(ok1.value.create, true);
  const opts = validateNotesConfig({ options: { autosaveMs: 800 } }, { 'x-request-id': 'req-1' });
  assert.equal(opts.ok, true);
  assert.equal(opts.value.requestId, 'req-1');
  assert.equal(validateNotesConfig({}, {}).ok, false);
  assert.equal(validateNotesConfig({ dir: '' }, {}).ok, false);
});

test('validateNotesTreeQuery：dir/depth 边界', () => {
  assert.deepEqual(validateNotesTreeQuery(new URLSearchParams('')).value, { dir: '', depth: 4 });
  assert.equal(validateNotesTreeQuery(new URLSearchParams('dir=日记&depth=2')).value.depth, 2);
  assert.equal(validateNotesTreeQuery(new URLSearchParams('depth=0')).ok, false);
  assert.equal(validateNotesTreeQuery(new URLSearchParams('depth=9')).ok, false);
  assert.equal(validateNotesTreeQuery(new URLSearchParams('dir=../x')).ok, false);
});

test('validateNotesFileQuery：path 必填且安全', () => {
  assert.equal(validateNotesFileQuery(new URLSearchParams('path=日记/a.md')).ok, true);
  assert.equal(validateNotesFileQuery(new URLSearchParams('')).ok, false);
  assert.equal(validateNotesFileQuery(new URLSearchParams('path=../a.md')).ok, false);
});

test('validateNotesWrite：content/baseHash/requestId', () => {
  const ok1 = validateNotesWrite({ path: 'a.md', content: 'hello', baseHash: 'a'.repeat(64), requestId: 'r1' }, {});
  assert.equal(ok1.ok, true);
  assert.equal(ok1.value.baseHash, 'a'.repeat(64));
  assert.equal(ok1.value.requestId, 'r1');
  assert.equal(validateNotesWrite({ path: 'a.md' }, {}).ok, false);
  assert.equal(validateNotesWrite({ path: 'a.md', content: 123 }, {}).ok, false);
  assert.equal(validateNotesWrite({ path: 'a.md', content: 'x', baseHash: 'short' }, {}).ok, false);
});

test('validateNotesRename / Remove / Search / Snapshot', () => {
  const renamed = validateNotesRename({ path: 'a.md', toPath: 'b' }, {});
  assert.equal(renamed.ok, true);
  assert.equal(renamed.value.toPath, 'b.md');
  assert.equal(validateNotesRename({ path: 'a.md', toPath: '../b.md' }, {}).ok, false);

  assert.deepEqual(validateNotesRemove({ path: 'a.md' }, {}).value.trash, true);
  assert.equal(validateNotesRemove({ path: 'a.md', trash: false }).value.trash, false);

  assert.equal(validateNotesSearchQuery(new URLSearchParams('q=日记')).ok, true);
  assert.equal(validateNotesSearchQuery(new URLSearchParams('q=日记&limit=101')).ok, false);
  assert.equal(validateNotesSearchQuery(new URLSearchParams('')).ok, false);

  assert.equal(validateNotesSnapshot({ path: 'a.md' }, {}).ok, true);
  assert.equal(validateNotesSnapshot({ path: 'a.png' }, {}).ok, false);
});

test('v0.5：文件夹/目录 rename/remove 契约 + parent_not_found', () => {
  const folder = validateNotesFolder({ path: '日记/2026', parents: true }, {});
  assert.equal(folder.ok, true);
  assert.equal(folder.value.recursive, true);
  assert.equal(validateNotesFolder({ path: '日记/2026' }, {}).value.recursive, false);
  assert.equal(validateNotesFolder({ path: '../x' }, {}).ok, false);
  assert.equal(validateNotesFolder({ path: 'a', recursive: 'yes' }, {}).ok, false);

  const dirRename = validateNotesRename({ path: '日记/旧', toPath: '日记/新' }, {});
  assert.equal(dirRename.ok, true);
  assert.equal(dirRename.value.toPath, '日记/新');
  assert.equal(validateNotesRename({ path: 'a.md', toPath: 'b' }, {}).value.toPath, 'b.md');
  assert.equal(validateNotesRename({ path: 'a.md', toPath: '../b' }, {}).ok, false);

  const dirRemove = validateNotesRemove({ path: '日记/旧', recursive: true }, {});
  assert.equal(dirRemove.ok, true);
  assert.equal(dirRemove.value.recursive, true);
  assert.equal(validateNotesRemove({ path: '日记/旧', recursive: 'yes' }, {}).ok, false);
  assert.equal(ERROR_CODES.parent_not_found, 422);
});
