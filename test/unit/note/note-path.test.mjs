import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  EDITABLE_EXTS,
  HISTORY_DIR,
  NotePathError,
  compareKey,
  ensureExt,
  extOf,
  formatTimestamp,
  historyKey,
  isEditableName,
  isIgnoredName,
  isInside,
  isTempName,
  normalizeRel,
  parseTimestamp,
  resolveInside,
  resolveRoot,
  samePath,
  sanitizeName,
  sha1Hex,
  toRel,
} from '../../../src/domain/note-path.js'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-notepath-'))
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

test('normalizeRel：合法相对路径规范化（含反斜杠/./）', () => {
  assert.equal(normalizeRel('a.md'), 'a.md')
  assert.equal(normalizeRel('folder\\note.md'), 'folder/note.md')
  assert.equal(normalizeRel('./folder/note.md'), 'folder/note.md')
  assert.equal(normalizeRel('folder//note.md'), 'folder/note.md')
  assert.equal(normalizeRel('folder/note.md/'), 'folder/note.md')
  assert.equal(normalizeRel('日常/2026-11-13.md'), '日常/2026-11-13.md')
})

test('normalizeRel：绝对路径/盘符/UNC/.. /非法字符/保留名/结尾点空格全部拒绝', () => {
  const bad = [
    '/etc/passwd',
    'C:\\Windows\\a.md',
    'c:/temp/a.md',
    '\\\\server\\share\\a.md',
    '..',
    '../outside.md',
    'a/../../b.md',
    'a/./b.md',
    'a\u0000b.md',
    'bad\u0001.md',
    'a<b.md',
    'a>b.md',
    'a:b.md',
    'a"b.md',
    'a|b.md',
    'a?b.md',
    'a*b.md',
    'trailingdot.',
    'trailing space ',
    'CON',
    'con.md',
    'COM1.md',
    'LPT9.txt',
  ]
  for (const value of bad) {
    assert.throws(
      () => normalizeRel(value),
      (error) => {
        assert.ok(error instanceof NotePathError)
        assert.ok(['path_forbidden', 'validation_failed'].includes(error.code))
        return true
      },
      `应拒绝：${value}`,
    )
  }
})

test('resolveRoot：不存在/非目录拒绝；允许时返回 realpath', () => {
  const root = tmpRoot()
  try {
    const real = resolveRoot(root)
    assert.equal(real, fs.realpathSync.native(root))
    assert.throws(() => resolveRoot(path.join(root, 'not-exist')), NotePathError)
    const filePath = path.join(root, 'file.md')
    fs.writeFileSync(filePath, 'x')
    assert.throws(() => resolveRoot(filePath), NotePathError)
    assert.throws(() => resolveRoot('relative/dir'), NotePathError)
    assert.throws(() => resolveRoot(''), NotePathError)
  } finally {
    cleanup(root)
  }
})

test('resolveInside：root 内路径可解析；不存在路径也可解析（exists=false）', () => {
  const root = tmpRoot()
  try {
    const created = path.join(root, 'folder')
    fs.mkdirSync(created)
    const file = path.join(created, 'a.md')
    fs.writeFileSync(file, 'hello')

    const resolved = resolveInside(root, 'folder/a.md')
    assert.equal(fs.realpathSync.native(resolved.abs), fs.realpathSync.native(file))
    assert.equal(resolved.rel, 'folder/a.md')
    assert.equal(resolved.exists, true)

    const missing = resolveInside(root, 'folder/new/note.md')
    assert.equal(missing.exists, false)
    assert.ok(missing.abs.startsWith(fs.realpathSync.native(root)))
    assert.equal(resolveInside(root, '', { allowRoot: true }).rel, '')
    assert.equal(resolveInside(root, '.', { allowRoot: true }).rel, '')
    assert.equal(resolveInside(root, './', { allowRoot: true }).rel, '')
    assert.throws(() => resolveInside(root, ''), NotePathError)
  } finally {
    cleanup(root)
  }
})

test('resolveInside：../、绝对路径、保留目录、盘符全部 path_forbidden', () => {
  const root = tmpRoot()
  try {
    for (const bad of ['../x.md', '/tmp/x.md', 'C:\\x.md', '.lifeos-history/x.md', '.trash/x.md']) {
      assert.throws(() => resolveInside(root, bad), NotePathError, `应拒绝 ${bad}`)
    }
  } finally {
    cleanup(root)
  }
})

test('resolveInside：符号链接/junction 指向 root 外必须拒绝', () => {
  const root = tmpRoot()
  const outside = tmpRoot()
  let link = null
  try {
    fs.writeFileSync(path.join(outside, 'secret.md'), 'top secret')
    link = path.join(root, 'link')
    let ok = true
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      ok = false
    }
    if (!ok) return // 平台不允许创建链接（权限），跳过
    assert.throws(
      () => resolveInside(root, 'link/secret.md'),
      (error) => error instanceof NotePathError && error.code === 'path_forbidden',
    )
    // 指向 root 内部的链接允许
    const insideDir = path.join(root, 'inside')
    fs.mkdirSync(insideDir)
    const insideLink = path.join(root, 'inside-link')
    fs.symlinkSync(insideDir, insideLink, process.platform === 'win32' ? 'junction' : 'dir')
    const allowed = resolveInside(root, 'inside-link/a.md')
    assert.ok(isInside(root, allowed.abs, { allowSelf: true }))
  } finally {
    if (link) {
      try {
        fs.unlinkSync(link)
      } catch {
        /* ignore */
      }
    }
    cleanup(root)
    cleanup(outside)
  }
})

test('isEditableName / extOf / ensureExt', () => {
  assert.deepEqual([...EDITABLE_EXTS], ['.md', '.markdown', '.txt'])
  assert.equal(isEditableName('a.md'), true)
  assert.equal(isEditableName('a.MARKDOWN'), true)
  assert.equal(isEditableName('a.txt'), true)
  assert.equal(isEditableName('a.png'), false)
  assert.equal(isEditableName('a'), false)
  assert.equal(extOf('a.md'), '.md')
  assert.equal(extOf('.md'), '')
  assert.equal(extOf('a'), '')
  assert.equal(ensureExt('note'), 'note.md')
  assert.equal(ensureExt('note.txt'), 'note.txt')
  assert.equal(ensureExt('note', '.markdown'), 'note.markdown')
  assert.throws(() => ensureExt('image.png'), NotePathError)
  assert.throws(() => ensureExt(''), NotePathError)
})

test('sanitizeName：非法字符替换/保留名/补扩展/空名', () => {
  assert.equal(sanitizeName('我的笔记'), '我的笔记.md')
  assert.equal(sanitizeName('a<b>c.md'), 'a-b-c.md')
  assert.equal(sanitizeName('  hello   world  '), 'hello world.md')
  assert.equal(sanitizeName('note.'), 'note.md')
  assert.equal(sanitizeName('CON'), '_CON.md')
  assert.equal(sanitizeName('   '), '未命名.md')
  assert.throws(() => sanitizeName('图片.png'), NotePathError, '非 md/txt 扩展应拒绝')
  assert.throws(() => sanitizeName('a/b'), NotePathError)
  assert.throws(() => sanitizeName('a\\b'), NotePathError)
  assert.throws(() => sanitizeName('C:\\a'), NotePathError)
})

test('isIgnoredName / isTempName：忽略保留目录/隐藏/临时文件', () => {
  assert.equal(isIgnoredName('.lifeos-history'), true)
  assert.equal(isIgnoredName('.trash'), true)
  assert.equal(isIgnoredName('.hidden.md'), true)
  assert.equal(isIgnoredName('.hidden.md', { includeHidden: true }), false)
  assert.equal(isIgnoredName('.~a.md.tmp'), true)
  assert.equal(isIgnoredName('a.md'), false)
  assert.equal(isTempName('.~a.md'), true)
  assert.equal(isTempName('a.md.tmp'), true)
  assert.equal(isTempName('a.md~'), true)
  assert.equal(isTempName('a.md'), false)
})

test('isInside / samePath / compareKey / toRel', () => {
  assert.equal(isInside('C:\\Notes', 'C:\\Notes\\a.md'), true)
  assert.equal(isInside('C:\\Notes', 'C:\\Notes2\\a.md'), false)
  assert.equal(isInside('C:\\Notes', 'C:\\Notes', { allowSelf: true }), true)
  assert.equal(isInside('C:\\Notes', 'C:\\Notes'), false)
  if (process.platform === 'win32') {
    assert.equal(compareKey('C:\\Notes'), compareKey('c:/notes'))
    assert.equal(isInside('C:\\Notes', 'c:\\notes\\a.md'), true)
  }
  assert.equal(samePath('C:\\a\\b.md', 'C:/a/b.md') || process.platform !== 'win32', true)
  const root = tmpRoot()
  try {
    const file = path.join(root, 'x', 'a.md')
    assert.equal(toRel(root, file), 'x/a.md')
    assert.equal(toRel(root, root), '')
  } finally {
    cleanup(root)
  }
})

test('historyKey：稳定且平台路径大小写归一', () => {
  const a = historyKey('folder/a.md')
  const b = historyKey('folder//a.md'.replace('//', '/'))
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{40}$/)
  if (process.platform === 'win32') assert.equal(historyKey('Folder/A.md'), historyKey('folder/a.md'))
  assert.match(sha1Hex('abc'), /^[0-9a-f]{40}$/)
  assert.notEqual(sha1Hex('abc'), sha1Hex('abd'))
})

test('formatTimestamp / parseTimestamp：紧凑时间往返', () => {
  const date = new Date(2026, 10, 13, 23, 0, 5, 7)
  const stamp = formatTimestamp(date)
  assert.match(stamp, /^20261113T230005007$/)
  const parsed = parseTimestamp(stamp)
  assert.equal(parsed.getTime() - date.getTime() < 1000, true)
  assert.equal(parseTimestamp('bad'), null)
  assert.equal(HISTORY_DIR, '.lifeos-history')
})


test('resolveInside：allowSymlinkLeaf 只校验父链（供删除链接本身）', () => {
  const root = tmpRoot()
  const outside = tmpRoot()
  let link = null
  try {
    fs.writeFileSync(path.join(outside, 'secret.md'), 'x')
    link = path.join(root, 'link')
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return
    }
    assert.throws(() => resolveInside(root, 'link'), NotePathError, '默认应拒绝外部符号链接')
    const resolved = resolveInside(root, 'link', { allowSymlinkLeaf: true })
    assert.equal(resolved.exists, true)
    assert.equal(resolved.rel, 'link')
    // 经链接祖先逃逸仍要拒绝
    assert.throws(() => resolveInside(root, 'link/secret.md', { allowSymlinkLeaf: true }), NotePathError)
  } finally {
    if (link) {
      try {
        fs.unlinkSync(link)
      } catch {
        /* ignore */
      }
    }
    cleanup(root)
    cleanup(outside)
  }
})
