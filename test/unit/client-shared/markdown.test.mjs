import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseInline,
  parseMarkdown,
  renderMarkdown,
  renderMarkdownBlocks,
} from '../../../src/client-shared/markdown.js'

/** 极简 h()：把节点拍平成可断言的普通对象。 */
function h(tag, props, ...children) {
  const flat = []
  function push(value) {
    if (value === null || value === undefined || value === false || value === true) return
    if (Array.isArray(value)) {
      value.forEach(push)
      return
    }
    flat.push(value)
  }
  children.forEach(push)
  return { tag, props: props || null, children: flat }
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.value === 'string') return node.value
  if (Array.isArray(node.children)) return node.children.map(textOf).join('')
  return ''
}

const OPTS = { h, palette: { accent: '#6ea8fe' } }

test('markdown：标题层级与段落', () => {
  const blocks = parseMarkdown('# 一级\n\n正文一句\n\n### 三级')
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'heading'])
  assert.equal(blocks[0].level, 1)
  assert.equal(blocks[2].level, 3)
  const rendered = renderMarkdownBlocks(blocks, OPTS)
  assert.equal(rendered[0].tag, 'h1')
  assert.equal(rendered[1].tag, 'p')
  assert.equal(textOf(rendered[1]), '正文一句')
})

test('markdown：粗体 / 斜体 / 删除线 / 行内代码', () => {
  const inline = parseInline('这是 **粗体** 与 *斜体* 与 ~~删除~~ 与 `code` 混排')
  const kinds = inline.map((node) => node.type)
  assert.ok(kinds.includes('strong'))
  assert.ok(kinds.includes('em'))
  assert.ok(kinds.includes('del'))
  assert.ok(kinds.includes('code'))
  const code = inline.find((node) => node.type === 'code')
  assert.equal(code.value, 'code')
})

test('markdown：下划线强调不拆 snake_case，两侧空白不构成强调', () => {
  const inline = parseInline('snake_case_name 与 * 空 * 与 _真斜体_')
  const emphases = inline.filter((node) => node.type === 'em')
  assert.equal(emphases.length, 1)
  assert.equal(textOf(emphases[0]), '真斜体')
  assert.match(textOf(inline), /snake_case_name/)
})

test('markdown：行内代码优先于强调', () => {
  const inline = parseInline('`**不是粗体**`')
  assert.equal(inline.length, 1)
  assert.equal(inline[0].type, 'code')
  assert.equal(inline[0].value, '**不是粗体**')
})

test('markdown：反斜杠转义', () => {
  const inline = parseInline('字面量 \\*星号\\* 与 \\`反引号\\`')
  assert.equal(textOf(inline), '字面量 *星号* 与 `反引号`')
})

test('markdown：链接渲染为 a[target=_blank]，危险协议降级为文本', () => {
  const safe = renderMarkdown('[站点](https://example.com)', OPTS)
  const anchor = safe[0].children.find((child) => child && child.tag === 'a')
  assert.equal(anchor.props.href, 'https://example.com')
  assert.equal(anchor.props.target, '_blank')
  assert.equal(anchor.props.rel, 'noopener noreferrer')

  const unsafe = renderMarkdown('[坏链接](javascript:alert(1))', OPTS)
  const spans = unsafe[0].children.filter((child) => child && typeof child === 'object')
  assert.equal(spans.some((child) => child.tag === 'a'), false)
  assert.match(textOf(unsafe), /坏链接/)
})

test('markdown：图片渲染为受限 img', () => {
  const rendered = renderMarkdown('![山](images/mountain.png)', OPTS)
  const img = rendered[0].children.find((child) => child && child.tag === 'img')
  assert.equal(img.props.src, 'images/mountain.png')
  assert.equal(img.props.alt, '山')
  assert.match(img.props.style.maxWidth, /100%/)
})

test('markdown：围栏代码块保留语言与原始缩进', () => {
  const blocks = parseMarkdown('```js\nconst a = 1\n  indented\n```')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'code')
  assert.equal(blocks[0].lang, 'js')
  assert.equal(blocks[0].text, 'const a = 1\n  indented')
  const rendered = renderMarkdownBlocks(blocks, OPTS)
  assert.equal(rendered[0].tag, 'pre')
  assert.match(textOf(rendered[0]), /const a = 1/)
})

test('markdown：引用块递归解析内部块', () => {
  const blocks = parseMarkdown('> 引用第一行\n> **重点**')
  assert.equal(blocks[0].type, 'quote')
  assert.equal(blocks[0].blocks[0].type, 'paragraph')
  const rendered = renderMarkdownBlocks(blocks, OPTS)
  assert.equal(rendered[0].tag, 'blockquote')
})

test('markdown：分割线', () => {
  const blocks = parseMarkdown('上\n\n---\n\n下')
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'hr', 'paragraph'])
})

test('markdown：有序 / 无序 / 任务列表', () => {
  const unordered = parseMarkdown('- 甲\n- 乙')
  assert.equal(unordered[0].type, 'list')
  assert.equal(unordered[0].ordered, false)
  assert.equal(unordered[0].items.length, 2)

  const ordered = parseMarkdown('3. 丙\n4. 丁')
  assert.equal(ordered[0].ordered, true)
  assert.equal(ordered[0].start, 3)

  const tasks = parseMarkdown('- [ ] 未做\n- [x] 已做')
  assert.equal(tasks[0].items[0].checked, false)
  assert.equal(tasks[0].items[1].checked, true)
  const rendered = renderMarkdownBlocks(tasks, OPTS)
  const markers = textOf(rendered[0])
  assert.match(markers, /☐/)
  assert.match(markers, /☑/)
})

test('markdown：表格对齐与单元格行内解析', () => {
  const blocks = parseMarkdown('| 名称 | 数量 |\n| :--- | ---: |\n| 苹果 | **3** |\n| 梨 | 5 |')
  assert.equal(blocks[0].type, 'table')
  assert.deepEqual(blocks[0].align, ['left', 'right'])
  assert.equal(blocks[0].header.length, 2)
  assert.equal(blocks[0].rows.length, 2)
  const rendered = renderMarkdownBlocks(blocks, OPTS)
  const table = rendered[0].children.find((child) => child.tag === 'table')
  assert.ok(table)
  const headerCells = table.children[0].children[0].children
  assert.equal(headerCells.length, 2)
  assert.equal(headerCells[1].props.style.textAlign, 'right')
})

test('markdown：表格分隔行不会被当成列表或段落', () => {
  const blocks = parseMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n段落')
  assert.deepEqual(blocks.map((b) => b.type), ['table', 'paragraph'])
})

test('markdown：段落合并软换行，块起始行打断段落', () => {
  const blocks = parseMarkdown('第一行\n第二行\n# 标题')
  assert.equal(blocks[0].type, 'paragraph')
  assert.equal(textOf(blocks[0].inline), '第一行 第二行')
  assert.equal(blocks[1].type, 'heading')
})

test('markdown：超长输入被截断而不是抛错', () => {
  const blocks = parseMarkdown('a'.repeat(200001))
  assert.equal(blocks[0].type, 'paragraph')
  assert.ok(textOf(blocks[0].inline).length <= 200000)
})
