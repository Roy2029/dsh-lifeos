import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createNoteService } from '../../../src/application/note-service.js'

async function setup(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lifeos-notes-'))
  t.after(async () => {
    try {
      await fsp.rm(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })
  const service = createNoteService({ getRoot: () => root })
  return { root, service }
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `期望 ${code}，实际 ${error.code}: ${error.message}`)
    assert.equal(error.name, 'LifeosError')
    return true
  })
}

test('config：未配置/相对路径/不存在目录/options 校验/create', async (t) => {
  const unconfigured = createNoteService({ getRoot: () => null })
  const config = unconfigured.getConfig()
  assert.deepEqual(config, { dir: null, options: { sort: 'name', autosaveMs: 800, historyLimit: 20, includeHidden: false }, exists: false, writable: false })
  await expectCode(unconfigured.list(), 'validation_failed')

  const { root, service } = await setup(t)
  const current = service.getConfig()
  assert.equal(current.exists, true)
  assert.equal(current.writable, true)
  assert.equal(current.dir, fs.realpathSync.native(root))

  await expectCode(service.setConfig({ dir: 'relative/dir' }), 'validation_failed')
  await expectCode(service.setConfig({ dir: path.join(root, 'missing') }), 'not_found')

  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'lifeos-notes-cfg-'))
  t.after(async () => {
    await fsp.rm(base, { recursive: true, force: true })
  })
  const target = path.join(base, 'child', 'notes')
  const created = await service.setConfig({ dir: target, create: true })
  assert.equal(created.exists, true)
  assert.equal(created.writable, true)
  assert.ok(fs.existsSync(target))

  await expectCode(service.setConfig({ options: { sort: 'bad' } }), 'validation_failed')
  await expectCode(service.setConfig({ options: { autosaveMs: 1 } }), 'validation_failed')
  await expectCode(service.setConfig({ options: { historyLimit: 999 } }), 'validation_failed')
  const optionsUpdated = await service.setConfig({ options: { includeHidden: true, autosaveMs: 1000 } })
  assert.equal(optionsUpdated.options.includeHidden, true)
  assert.equal(optionsUpdated.options.autosaveMs, 1000)
})

test('create/list/read/write 基础链路', async (t) => {
  const { root, service } = await setup(t)
  const created = await service.create({ path: 'daily/今天.md', content: 'line1\nline2' })
  assert.equal(created.path, 'daily/今天.md')
  assert.match(created.hash, /^[0-9a-f]{40}$/)
  assert.ok(fs.existsSync(path.join(root, 'daily', '今天.md')))

  const autoExt = await service.create({ path: 'note', content: '' })
  assert.equal(autoExt.path, 'note.md')

  await expectCode(service.create({ path: 'note.md' }), 'path_exists')

  const tree = await service.list()
  assert.ok(tree.entries.some((entry) => entry.type === 'dir' && entry.path === 'daily'))
  assert.ok(tree.entries.some((entry) => entry.type === 'file' && entry.path === 'note.md'))
  const dirs = tree.entries.filter((entry) => entry.type === 'dir')
  const files = tree.entries.filter((entry) => entry.type === 'file')
  assert.ok(tree.entries.indexOf(dirs[0]) < tree.entries.indexOf(files[0]), '目录排在文件前')

  const daily = await service.list({ dir: 'daily' })
  assert.equal(daily.entries.length, 1)
  assert.equal(daily.entries[0].path, 'daily/今天.md')
  assert.equal(daily.entries[0].editable, true)

  const read = await service.read({ path: 'daily/今天.md' })
  assert.equal(read.content, 'line1\nline2')
  assert.equal(read.encoding, 'utf-8')
  assert.equal(read.newline, 'lf')
  assert.equal(read.bom, false)
  assert.equal(read.size, Buffer.byteLength('line1\nline2'))
  assert.match(read.hash, /^[0-9a-f]{40}$/)
  assert.ok(!Number.isNaN(Date.parse(read.mtime)))

  const written = await service.write({ path: 'daily/今天.md', content: 'line1\nline2\nline3', baseHash: read.hash })
  assert.equal(written.created, false)
  assert.notEqual(written.hash, read.hash)
  assert.equal((await service.read({ path: 'daily/今天.md' })).content, 'line1\nline2\nline3')

  await expectCode(service.write({ path: 'missing.md', content: 'x' }), 'not_found')
  const createdByWrite = await service.write({ path: 'missing.md', content: 'x', create: true })
  assert.equal(createdByWrite.created, true)
})

test('路径安全：../、绝对路径、盘符、非法扩展、保留目录、符号链接逃逸', async (t) => {
  const { root, service } = await setup(t)
  await expectCode(service.read({ path: '../outside.md' }), 'path_forbidden')
  await expectCode(service.read({ path: path.join(root, 'x.md') }), 'path_forbidden')
  await expectCode(service.read({ path: 'C:\\Windows\\win.ini' }), 'path_forbidden')
  await expectCode(service.list({ dir: 'a/../../..' }), 'path_forbidden')
  await expectCode(service.write({ path: 'a.png', content: 'x' }), 'validation_failed')
  await expectCode(service.create({ path: 'escape/../../x.md' }), 'path_forbidden')
  await expectCode(service.write({ path: '.lifeos-history/x.md', content: 'x' }), 'path_forbidden')
  await expectCode(service.write({ path: '.trash/x.md', content: 'x' }), 'path_forbidden')
  await service.create({ path: 'a.md', content: 'x' })
  await expectCode(service.rename({ path: 'a.md', toPath: '../b.md' }), 'path_forbidden')

  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'lifeos-notes-out-'))
  t.after(async () => {
    await fsp.rm(outside, { recursive: true, force: true })
  })
  await fsp.writeFile(path.join(outside, 'secret.md'), 'secret')
  const link = path.join(root, 'link')
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    return
  }
  await expectCode(service.read({ path: 'link/secret.md' }), 'path_forbidden')
  const tree = await service.list()
  assert.equal(tree.entries.some((entry) => entry.path.startsWith('link')), false, '指向外部的链接不出现在文件树')
})

test('BOM 与 CRLF：读取识别并保持原文件风格', async (t) => {
  const { root, service } = await setup(t)
  const bomCrlf = path.join(root, 'bom-crlf.md')
  await fsp.writeFile(bomCrlf, Buffer.from('\uFEFF第一行\r\n第二行\r\n', 'utf8'))
  const read = await service.read({ path: 'bom-crlf.md' })
  assert.equal(read.bom, true)
  assert.equal(read.newline, 'crlf')
  assert.equal(read.content, '第一行\n第二行\n')

  await service.write({ path: 'bom-crlf.md', content: '第一行\n第二行\n第三行' })
  const raw = await fsp.readFile(bomCrlf)
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM 必须保留')
  assert.ok(raw.toString('utf8').includes('\r\n'), 'CRLF 必须保留')
  const reread = await service.read({ path: 'bom-crlf.md' })
  assert.equal(reread.bom, true)
  assert.equal(reread.newline, 'crlf')
  assert.equal(reread.content, '第一行\n第二行\n第三行')

  const lf = path.join(root, 'lf.md')
  await fsp.writeFile(lf, 'a\nb\n')
  await service.write({ path: 'lf.md', content: 'a\nb\nc' })
  assert.equal((await fsp.readFile(lf)).toString('utf8'), 'a\nb\nc')
})

test('冲突：baseHash 不匹配返回 409 conflict（带 currentHash/mtime）', async (t) => {
  const { root, service } = await setup(t)
  await service.create({ path: 'conflict.md', content: 'v1' })
  const first = await service.read({ path: 'conflict.md' })
  await fsp.writeFile(path.join(root, 'conflict.md'), 'external change')
  await assert.rejects(service.write({ path: 'conflict.md', content: 'v2', baseHash: first.hash }), (error) => {
    assert.equal(error.code, 'conflict')
    assert.equal(error.details.path, 'conflict.md')
    assert.match(error.details.currentHash, /^[0-9a-f]{40}$/)
    assert.ok(error.details.mtime)
    return true
  })
  const current = await service.read({ path: 'conflict.md' })
  assert.equal(current.content, 'external change')
  const saved = await service.write({ path: 'conflict.md', content: 'v2', baseHash: current.hash })
  assert.equal(saved.created, false)
  assert.equal((await service.read({ path: 'conflict.md' })).content, 'v2')
})

test('原子写：rename 失败时原文件不变、不残留临时文件', async (t) => {
  const { root, service } = await setup(t)
  await service.create({ path: 'atomic.md', content: 'original' })
  const broken = createNoteService({
    getRoot: () => root,
    fs: {
      async rename() {
        const error = new Error('simulated disk error')
        error.code = 'EIO'
        throw error
      },
    },
  })
  await assert.rejects(broken.write({ path: 'atomic.md', content: 'changed' }), (error) => {
    assert.equal(error.name, 'LifeosError')
    return true
  })
  assert.equal((await fsp.readFile(path.join(root, 'atomic.md'))).toString('utf8'), 'original')
  const names = await fsp.readdir(root)
  assert.equal(names.some((name) => name.startsWith('.~')), false, '不得残留临时文件')
})

test('快照与历史：写前快照、保留最近 20、手动 snapshot', async (t) => {
  const { root, service } = await setup(t)
  await service.create({ path: 'hist.md', content: 'v1' })
  await service.write({ path: 'hist.md', content: 'v2' })
  await service.write({ path: 'hist.md', content: 'v3' })
  let history = await service.history({ path: 'hist.md' })
  assert.equal(history.items.length, 2, 'create 无旧内容不快照；两次写入各留一份')
  assert.ok(history.items[0].id > history.items[1].id, '新→旧排序')
  assert.equal(history.items[0].size, Buffer.byteLength('v2'))
  const snapshotFile = path.join(root, history.items[0].snapshotPath)
  assert.equal((await fsp.readFile(snapshotFile)).toString('utf8'), 'v2')

  const manual = await service.snapshot({ path: 'hist.md' })
  assert.ok(manual.snapshotPath.startsWith('.lifeos-history/'))
  assert.ok(fs.existsSync(path.join(root, manual.snapshotPath)))
  history = await service.history({ path: 'hist.md' })
  assert.equal(history.items.length, 3)

  for (let i = 0; i < 25; i++) await service.write({ path: 'hist.md', content: `v${i + 4}` })
  history = await service.history({ path: 'hist.md' })
  assert.equal(history.items.length, 20, '历史默认保留最近 20 个')
  // history 目录不出现在文件树
  const tree = await service.list()
  assert.equal(tree.entries.some((entry) => entry.path.startsWith('.lifeos-history')), false)
})

test('删除：默认进 .trash 可恢复；trash:false 物理删除', async (t) => {
  const { root, service } = await setup(t)
  await service.create({ path: 'trash-me.md', content: 'x' })
  const removed = await service.remove({ path: 'trash-me.md' })
  assert.equal(removed.removed, true)
  assert.ok(removed.trashPath.startsWith('.trash/'))
  assert.ok(fs.existsSync(path.join(root, removed.trashPath)))
  await expectCode(service.read({ path: 'trash-me.md' }), 'not_found')
  const tree = await service.list()
  assert.equal(tree.entries.some((entry) => entry.path.startsWith('.trash')), false, '.trash 不出现在文件树')

  await service.create({ path: 'hard.md', content: 'x' })
  const hard = await service.remove({ path: 'hard.md', trash: false })
  assert.deepEqual(hard, { removed: true, type: 'file' })
  await expectCode(service.read({ path: 'hard.md' }), 'not_found')
})

test('搜索：文件名 + 内容 includes，忽略非文本/隐藏/保留目录，limit 生效', async (t) => {
  const { service } = await setup(t)
  await service.create({ path: 'a.md', content: '今天做了力量训练 hello' })
  await service.create({ path: 'b.txt', content: 'nothing here' })
  await service.create({ path: 'sub/c.md', content: 'hello world' })
  await service.write({ path: 'sub/c.md', content: 'hello world' })
  await service.create({ path: '.hidden.md', content: 'hello hidden' })

  const byContent = await service.search({ q: 'hello' })
  const contentPaths = byContent.items.map((item) => item.path).sort()
  assert.deepEqual(contentPaths, ['a.md', 'sub/c.md'])
  const hit = byContent.items.find((item) => item.path === 'a.md')
  assert.equal(hit.title, 'a')
  assert.ok(hit.snippet.includes('hello'))
  assert.ok(!Number.isNaN(Date.parse(hit.mtime)))

  assert.deepEqual((await service.search({ q: '力量' })).items.map((item) => item.path), ['a.md'])
  assert.deepEqual((await service.search({ q: 'c' })).items.map((item) => item.path), ['sub/c.md'])
  assert.equal((await service.search({ q: 'hello', limit: 1 })).items.length, 1)
  await expectCode(service.search({ q: '   ' }), 'validation_failed')
})

test('非文本文件不写；超大文件读取拒绝；rename 不覆盖', async (t) => {
  const { root, service } = await setup(t)
  await expectCode(service.write({ path: 'image.png', content: 'x' }), 'validation_failed')
  await expectCode(service.create({ path: 'image.png' }), 'validation_failed')

  await fsp.writeFile(path.join(root, 'image.png'), 'binary')
  const tree = await service.list()
  const png = tree.entries.find((entry) => entry.path === 'image.png')
  assert.ok(png)
  assert.equal(png.editable, false)
  assert.equal((await fsp.readFile(path.join(root, 'image.png'))).toString('utf8'), 'binary', '不得修改非文本文件')

  const big = path.join(root, 'big.md')
  await fsp.writeFile(big, 'x'.repeat(2 * 1024 * 1024 + 1))
  await expectCode(service.read({ path: 'big.md' }), 'file_too_large')

  await service.create({ path: 'rename-a.md', content: 'a' })
  await service.create({ path: 'rename-b.md', content: 'b' })
  const renamed = await service.rename({ path: 'rename-a.md', toPath: 'renamed.md' })
  assert.equal(renamed.path, 'renamed.md')
  await expectCode(service.read({ path: 'rename-a.md' }), 'not_found')
  await expectCode(service.rename({ path: 'renamed.md', toPath: 'rename-b.md' }), 'path_exists')
})

test('list 过滤隐藏/临时文件；includeHidden 可配置', async (t) => {
  const { root, service } = await setup(t)
  await service.create({ path: 'visible.md', content: 'x' })
  await fsp.writeFile(path.join(root, '.hidden.md'), 'x')
  await fsp.writeFile(path.join(root, '.~tmp.md'), 'x')
  await fsp.writeFile(path.join(root, 'temp.md.tmp'), 'x')
  const hidden = await service.list()
  assert.deepEqual(
    hidden.entries.filter((entry) => entry.type === 'file').map((entry) => entry.path),
    ['visible.md'],
  )
  const cfg = await service.setConfig({ options: { includeHidden: true } })
  assert.equal(cfg.options.includeHidden, true)
  const all = await service.list()
  assert.ok(all.entries.some((entry) => entry.path === '.hidden.md'))
  assert.equal(all.entries.some((entry) => entry.path.includes('.~tmp')), false)
  assert.equal(all.entries.some((entry) => entry.path.endsWith('.tmp')), false)
})


// ---------------------------------------------------------------------------
// M2.6：文件夹操作（mkdir / rename dir / remove dir / 符号链接）
// ---------------------------------------------------------------------------

test('mkdir：正常创建 / 父缺失 422 parent_not_found / recursive / 已存在 409', async (t) => {
  const { root, service } = await setup(t)
  const created = await service.mkdir({ path: 'folder' })
  assert.deepEqual(created, { path: 'folder', type: 'dir', created: true })
  assert.ok(fs.statSync(path.join(root, 'folder')).isDirectory())

  await expectCode(service.mkdir({ path: 'folder' }), 'path_exists')

  await expectCode(service.mkdir({ path: 'a/b' }), 'parent_not_found')
  await service.mkdir({ path: 'a' })
  const nested = await service.mkdir({ path: 'a/b' })
  assert.equal(nested.path, 'a/b')

  const deep = await service.mkdir({ path: 'x/y/z', recursive: true })
  assert.equal(deep.path, 'x/y/z')
  assert.ok(fs.statSync(path.join(root, 'x', 'y', 'z')).isDirectory())

  // 目标已存在为文件时同样 409
  await service.create({ path: 'file.md', content: 'x' })
  await expectCode(service.mkdir({ path: 'file.md' }), 'path_exists')

  // 路径安全
  await expectCode(service.mkdir({ path: '../evil' }), 'path_forbidden')
  await expectCode(service.mkdir({ path: '.trash/evil' }), 'path_forbidden')
  await expectCode(service.mkdir({ path: '.lifeos-history/evil' }), 'path_forbidden')
  await expectCode(service.mkdir({ path: 'C:\\evil' }), 'path_forbidden')

  const tree = await service.list()
  assert.ok(tree.entries.some((entry) => entry.path === 'folder' && entry.type === 'dir'))
})

test('rename 目录：正常改名（内容保留）/ 目标占用 409 / 移入自身子目录 422 / 父缺失 422', async (t) => {
  const { root, service } = await setup(t)
  await service.mkdir({ path: 'old' })
  await service.create({ path: 'old/note.md', content: 'inside' })
  await service.mkdir({ path: 'occupied' })
  await service.mkdir({ path: 'only-parent' })

  const renamed = await service.rename({ path: 'old', toPath: 'new' })
  assert.equal(renamed.path, 'new')
  assert.equal(renamed.type, 'dir')
  assert.equal((await service.read({ path: 'new/note.md' })).content, 'inside')
  await expectCode(service.read({ path: 'old/note.md' }), 'not_found')
  assert.ok(fs.statSync(path.join(root, 'new')).isDirectory())

  // 目标已存在目录 → 409
  await expectCode(service.rename({ path: 'new', toPath: 'occupied' }), 'path_exists')
  // 移入自身/子目录 → 422
  await expectCode(service.rename({ path: 'new', toPath: 'new/sub' }), 'validation_failed')
  await expectCode(service.rename({ path: 'occupied', toPath: 'occupied/child' }), 'validation_failed')
  // 目标父目录不存在 → 422
  await expectCode(service.rename({ path: 'occupied', toPath: 'no/such/dir' }), 'parent_not_found')
  // 跨出 root → path_forbidden
  await expectCode(service.rename({ path: 'occupied', toPath: '../escape' }), 'path_forbidden')
  await expectCode(service.rename({ path: 'occupied', toPath: 'C:\\evil' }), 'path_forbidden')
  // 原目录仍在
  assert.ok(fs.statSync(path.join(root, 'only-parent')).isDirectory())
})

test('rename 目录：Windows 仅大小写改名允许（大小写不敏感目标不算占用）', async (t) => {
  const { root, service } = await setup(t)
  await service.mkdir({ path: 'CaseDir' })
  await service.create({ path: 'CaseDir/child.md', content: 'x' })
  const result = await service.rename({ path: 'CaseDir', toPath: 'casedir' })
  const expected = process.platform === 'win32' ? 'casedir' : 'casedir'
  assert.equal(result.path.toLowerCase(), expected)
  const entries = (await service.list()).entries.filter((entry) => entry.type === 'dir')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].path.toLowerCase(), 'casedir')
  assert.equal((await service.read({ path: `${result.path}/child.md` })).content, 'x')
  assert.ok(fs.existsSync(path.join(root, result.path)))
})

test('remove 目录：递归移动到 .trash/<ts>-<name>/，可恢复且不再出现在文件树', async (t) => {
  const { root, service } = await setup(t)
  await service.mkdir({ path: 'work' })
  await service.create({ path: 'work/sub/note.md', content: 'keep me' })
  const removed = await service.remove({ path: 'work' })
  assert.equal(removed.removed, true)
  assert.equal(removed.type, 'dir')
  assert.ok(removed.trashPath.startsWith('.trash/'))
  assert.ok(fs.existsSync(path.join(root, removed.trashPath)), '回收站中保留目录')
  assert.equal((await fsp.readFile(path.join(root, removed.trashPath, 'sub', 'note.md'))).toString('utf8'), 'keep me')
  await expectCode(service.read({ path: 'work/sub/note.md' }), 'not_found')
  const tree = await service.list()
  assert.equal(tree.entries.some((entry) => entry.path === 'work'), false)
  assert.equal(tree.entries.some((entry) => entry.path.startsWith('.trash')), false)

  // 目录 trash:false 拒绝（必须可恢复）
  await service.mkdir({ path: 'keep' })
  await expectCode(service.remove({ path: 'keep', trash: false }), 'validation_failed')
  assert.ok(fs.existsSync(path.join(root, 'keep')))
})

test('remove 目录：移动失败时原目录与内容保持不变（不删原物）', async (t) => {
  const { root, service } = await setup(t)
  await service.mkdir({ path: 'safe' })
  await service.create({ path: 'safe/a.md', content: 'original' })
  const broken = createNoteService({
    getRoot: () => root,
    fs: {
      async rename() {
        const error = new Error('simulated move failure')
        error.code = 'EPERM'
        throw error
      },
    },
  })
  await assert.rejects(broken.remove({ path: 'safe' }), (error) => {
    assert.equal(error.name, 'LifeosError')
    return true
  })
  assert.ok(fs.statSync(path.join(root, 'safe')).isDirectory())
  assert.equal((await fsp.readFile(path.join(root, 'safe', 'a.md'))).toString('utf8'), 'original')
})

test('remove 符号链接：只删链接本身，不跟随目标', async (t) => {
  const { root, service } = await setup(t)
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'lifeos-notes-link-'))
  t.after(async () => {
    await fsp.rm(outside, { recursive: true, force: true })
  })
  await fsp.writeFile(path.join(outside, 'target.md'), 'outside')
  const link = path.join(root, 'outside-link')
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    return // 无权限建链接，跳过
  }
  const removed = await service.remove({ path: 'outside-link' })
  assert.equal(removed.removed, true)
  assert.ok(['file', 'dir'].includes(removed.type), '链接按链接本身移动（Windows junction 可能表现为 dir）')
  assert.equal(fs.existsSync(link), false)
  assert.ok(fs.existsSync(path.join(outside, 'target.md')), '链接目标不得被删除')
  // 链接不再出现在文件树
  const tree = await service.list()
  assert.equal(tree.entries.some((entry) => entry.path === 'outside-link'), false)
})

test('文件夹操作不影响目录内非 md 文件', async (t) => {
  const { root, service } = await setup(t)
  await service.mkdir({ path: 'assets' })
  const png = path.join(root, 'assets', 'image.png')
  await fsp.writeFile(png, 'binary-data')
  await service.rename({ path: 'assets', toPath: 'assets2' })
  assert.equal((await fsp.readFile(path.join(root, 'assets2', 'image.png'))).toString('utf8'), 'binary-data')
  const removed = await service.remove({ path: 'assets2' })
  assert.equal((await fsp.readFile(path.join(root, removed.trashPath, 'image.png'))).toString('utf8'), 'binary-data')
})

test('路径逃逸：rename/remove 同样拒绝 ../、绝对路径与保留目录', async (t) => {
  const { service } = await setup(t)
  await service.create({ path: 'a.md', content: 'x' })
  await expectCode(service.rename({ path: 'a.md', toPath: '/etc/passwd' }), 'path_forbidden')
  await expectCode(service.rename({ path: 'a.md', toPath: '.trash/a.md' }), 'path_forbidden')
  await expectCode(service.remove({ path: '../a.md' }), 'path_forbidden')
  await expectCode(service.remove({ path: 'C:\\a.md' }), 'path_forbidden')
  await expectCode(service.remove({ path: 'missing.md' }), 'not_found')
})
