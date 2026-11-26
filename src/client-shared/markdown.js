/**
 * Markdown 解析与渲染（M19 #23）。
 *
 * 纯函数、零依赖、无 I/O：既能被 node:test 直接单测，也能由
 * `scripts/build-v2.mjs` 以「共享前导块」的方式内联进 `client.js`。
 *
 * 设计约束：
 * - 只产出虚拟节点（通过调用方传入的 `h`），不拼 HTML 字符串，因此没有 innerHTML 注入面；
 * - 链接只放行 http/https/mailto/# 与相对路径，`javascript:` 等一律降级为纯文本；
 * - 解析是「够用」而不是完整 CommonMark：覆盖标题/粗斜/删除线/行内代码/链接/图片/
 *   引用/分割线/有序与无序列表/任务列表/表格/围栏代码块，未知语法按段落原样呈现。
 */

const MAX_MARKDOWN_CHARS = 200000
const HEADING_SIZES = [22, 19, 17, 15, 14, 13]

function isBlank(line) {
  return /^\s*$/.test(line)
}

function isFence(line) {
  return /^\s{0,3}(```|~~~)\s*[\w+#.-]*\s*$/.test(line)
}

function isHeading(line) {
  return /^\s{0,3}#{1,6}\s+/.test(line)
}

function isHr(line) {
  return /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)
}

function isQuote(line) {
  return /^\s{0,3}>/.test(line)
}

function isListItem(line) {
  return /^(\s*)([-*+]|\d{1,9}[.)])\s+/.test(line)
}

function isTableDelimiter(line) {
  const trimmed = String(line || '').trim()
  if (trimmed.indexOf('-') < 0) return false
  const cells = splitRow(trimmed)
  if (!cells.length) return false
  return cells.every(function each(cell) {
    return /^:?-{1,}:?$/.test(cell.replace(/\s+/g, ''))
  })
}

function isTableStart(lines, index) {
  const line = lines[index]
  if (!line || line.indexOf('|') < 0) return false
  const next = lines[index + 1]
  if (next === undefined) return false
  return isTableDelimiter(next)
}

function isBlockStart(lines, index) {
  const line = lines[index]
  if (line === undefined) return true
  if (isBlank(line)) return true
  return isFence(line) || isHeading(line) || isHr(line) || isQuote(line) || isListItem(line) || isTableStart(lines, index)
}

function splitRow(line) {
  let text = String(line || '').trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  const cells = []
  let buffer = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\\' && text[i + 1] === '|') {
      buffer += '|'
      i += 1
      continue
    }
    if (ch === '|') {
      cells.push(buffer.trim())
      buffer = ''
      continue
    }
    buffer += ch
  }
  cells.push(buffer.trim())
  return cells
}

function alignmentOf(cell) {
  const text = String(cell || '').replace(/\s+/g, '')
  const left = text.startsWith(':')
  const right = text.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

/* ── 行内解析 ─────────────────────────────────────────────── */

function mergeText(nodes) {
  const out = []
  for (const node of nodes) {
    if (node.type === 'text' && out.length && out[out.length - 1].type === 'text') {
      out[out.length - 1] = { type: 'text', value: out[out.length - 1].value + node.value }
      continue
    }
    out.push(node)
  }
  return out
}

function indexOfClosingParen(source, start) {
  let depth = 1
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function isWordChar(ch) {
  return !!ch && /[0-9A-Za-z]/.test(ch)
}

/**
 * 找强调的收尾标记。
 * - `_` 不能出现在单词内部（`snake_case` 不应变成斜体）；
 * - 收尾标记前面不能是空白（`* a *` 不成立）。
 */
function emphasisEnd(source, marker, start) {
  const previous = source[start - 2]
  if (marker === '_' && isWordChar(previous)) return -1
  let index = start
  while (index < source.length) {
    const found = source.indexOf(marker, index)
    if (found < 0) return -1
    const before = source[found - 1]
    const after = source[found + marker.length]
    const wordBoundaryOk = marker !== '_' || !isWordChar(after)
    if (found > start && before && !/\s/.test(before) && wordBoundaryOk) return found
    index = found + marker.length
  }
  return -1
}

export function parseInline(source) {
  const text = String(source == null ? '' : source)
  const nodes = []
  let buffer = ''
  let i = 0
  function flush() {
    if (!buffer) return
    nodes.push({ type: 'text', value: buffer })
    buffer = ''
  }
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\' && i + 1 < text.length) {
      buffer += text[i + 1]
      i += 2
      continue
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        nodes.push({ type: 'code', value: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    if (ch === '!' && text[i + 1] === '[') {
      const labelEnd = text.indexOf(']', i + 2)
      if (labelEnd > 0 && text[labelEnd + 1] === '(') {
        const targetEnd = indexOfClosingParen(text, labelEnd + 2)
        if (targetEnd > 0) {
          flush()
          nodes.push({ type: 'image', alt: text.slice(i + 2, labelEnd), src: text.slice(labelEnd + 2, targetEnd).trim() })
          i = targetEnd + 1
          continue
        }
      }
    }
    if (ch === '[') {
      const labelEnd = text.indexOf(']', i + 1)
      if (labelEnd > 0 && text[labelEnd + 1] === '(') {
        const targetEnd = indexOfClosingParen(text, labelEnd + 2)
        if (targetEnd > 0) {
          flush()
          nodes.push({
            type: 'link',
            href: text.slice(labelEnd + 2, targetEnd).trim(),
            children: parseInline(text.slice(i + 1, labelEnd)),
          })
          i = targetEnd + 1
          continue
        }
      }
    }
    if (text.startsWith('**', i) || text.startsWith('__', i)) {
      const marker = text.slice(i, i + 2)
      const end = text.indexOf(marker, i + 2)
      if (end > i + 2) {
        flush()
        nodes.push({ type: 'strong', children: parseInline(text.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    if (text.startsWith('~~', i)) {
      const end = text.indexOf('~~', i + 2)
      if (end > i + 2) {
        flush()
        nodes.push({ type: 'del', children: parseInline(text.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    if (ch === '*' || ch === '_') {
      const end = emphasisEnd(text, ch, i + 1)
      if (end > i + 1) {
        flush()
        nodes.push({ type: 'em', children: parseInline(text.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }
    buffer += ch
    i += 1
  }
  flush()
  return mergeText(nodes)
}

/* ── 块解析 ───────────────────────────────────────────────── */

export function parseMarkdown(text) {
  const source = String(text == null ? '' : text).replace(/\r\n?/g, '\n').slice(0, MAX_MARKDOWN_CHARS)
  const lines = source.split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) {
      i += 1
      continue
    }
    const fence = /^\s{0,3}(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line)
    if (fence) {
      const marker = fence[1]
      const lang = fence[2] || ''
      const buffer = []
      i += 1
      while (i < lines.length && !new RegExp('^\\s{0,3}' + marker + '\\s*$').test(lines[i])) {
        buffer.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push({ type: 'code', lang, text: buffer.join('\n') })
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2]) })
      i += 1
      continue
    }
    if (isHr(line)) {
      blocks.push({ type: 'hr' })
      i += 1
      continue
    }
    if (isQuote(line)) {
      const inner = []
      while (i < lines.length && isQuote(lines[i])) {
        inner.push(lines[i].replace(/^\s{0,3}>\s?/, ''))
        i += 1
      }
      blocks.push({ type: 'quote', blocks: parseMarkdown(inner.join('\n')) })
      continue
    }
    if (isTableStart(lines, i)) {
      const header = splitRow(line)
      const align = splitRow(lines[i + 1]).map(alignmentOf)
      i += 2
      const rows = []
      while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf('|') >= 0 && !isListItem(lines[i])) {
        rows.push(splitRow(lines[i]).map(parseInline))
        i += 1
      }
      blocks.push({ type: 'table', header: header.map(parseInline), align, rows })
      continue
    }
    const listMatch = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line)
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[2])
      const start = ordered ? Number(String(listMatch[2]).replace(/[.)]$/, '')) || 1 : 1
      const items = []
      while (i < lines.length) {
        const current = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i])
        if (!current) break
        if (/^\d/.test(current[2]) !== ordered) break
        let body = current[3]
        let checked = null
        const task = /^\[([ xX])\]\s*(.*)$/.exec(body)
        if (task) {
          checked = task[1].toLowerCase() === 'x'
          body = task[2]
        }
        i += 1
        while (i < lines.length && !isBlank(lines[i]) && /^\s{2,}/.test(lines[i]) && !/^(\s*)([-*+]|\d{1,9}[.)])\s+/.test(lines[i])) {
          body += ' ' + lines[i].trim()
          i += 1
        }
        items.push({ checked, inline: parseInline(body) })
      }
      blocks.push({ type: 'list', ordered, start, items })
      continue
    }
    const paragraph = []
    while (i < lines.length && !isBlank(lines[i]) && (paragraph.length === 0 || !isBlockStart(lines, i))) {
      paragraph.push(lines[i].trim())
      i += 1
    }
    if (!paragraph.length) {
      i += 1
      continue
    }
    blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join(' ')) })
  }
  return blocks
}

/* ── 渲染 ─────────────────────────────────────────────────── */

function safeHref(href) {
  const value = String(href == null ? '' : href).trim()
  if (!value) return ''
  if (/^(https?:|mailto:|#|\/|\.\.?\/)/i.test(value)) return value
  if (/^[a-z0-9._~-]+(\/[^\s]*)?$/i.test(value)) return value
  return ''
}

export function renderInline(nodes, opts) {
  const h = opts.h
  const palette = opts.palette || {}
  const accent = palette.accent || '#4f7cff'
  const result = []
  for (const node of nodes || []) {
    if (node.type === 'text') result.push(node.value)
    else if (node.type === 'code') {
      result.push(
        h('code', {
          key: 'ic' + result.length,
          style: {
            padding: '1px 5px',
            borderRadius: 4,
            background: palette.codeBg || 'rgba(255,255,255,0.08)',
            fontFamily: palette.mono || 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '0.92em',
          },
        }, node.value),
      )
    } else if (node.type === 'strong') {
      result.push(h('strong', { key: 'b' + result.length, style: { fontWeight: 700 } }, renderInline(node.children, opts)))
    } else if (node.type === 'em') {
      result.push(h('em', { key: 'i' + result.length }, renderInline(node.children, opts)))
    } else if (node.type === 'del') {
      result.push(h('del', { key: 'd' + result.length, style: { opacity: 0.7 } }, renderInline(node.children, opts)))
    } else if (node.type === 'link') {
      const href = safeHref(node.href)
      const children = renderInline(node.children, opts)
      result.push(
        href
          ? h('a', {
            key: 'a' + result.length,
            href,
            target: '_blank',
            rel: 'noopener noreferrer',
            style: { color: accent, textDecoration: 'underline' },
          }, children)
          : h('span', { key: 'a' + result.length }, children),
      )
    } else if (node.type === 'image') {
      const src = safeHref(node.src)
      result.push(
        src
          ? h('img', {
            key: 'img' + result.length,
            src,
            alt: node.alt || '',
            style: { maxWidth: '100%', borderRadius: 6, display: 'block', margin: '6px 0' },
          })
          : h('span', { key: 'img' + result.length }, node.alt || ''),
      )
    }
  }
  return result
}

export function renderMarkdownBlocks(blocks, opts) {
  const h = opts.h
  const palette = opts.palette || {}
  const fontSize = opts.fontSize || 14
  const lineHeight = opts.lineHeight || 1.7
  const textColor = palette.text || 'inherit'
  const out = []
  const list = Array.isArray(blocks) ? blocks : []
  list.forEach(function renderBlock(block, index) {
    const key = 'mb' + index
    if (block.type === 'heading') {
      const size = Math.round(fontSize * (HEADING_SIZES[block.level - 1] || 13) / 14)
      out.push(
        h('h' + block.level, {
          key,
          style: {
            margin: index === 0 ? '0 0 8px' : '18px 0 8px',
            fontSize: size,
            fontWeight: 650,
            lineHeight: 1.35,
            color: textColor,
          },
        }, renderInline(block.inline, opts)),
      )
      return
    }
    if (block.type === 'paragraph') {
      out.push(h('p', { key, style: { margin: '8px 0', lineHeight } }, renderInline(block.inline, opts)))
      return
    }
    if (block.type === 'hr') {
      out.push(h('hr', { key, style: { border: 'none', borderTop: '1px solid ' + (palette.line || 'rgba(255,255,255,0.12)'), margin: '14px 0' } }))
      return
    }
    if (block.type === 'code') {
      const children = []
      if (block.lang) {
        children.push(h('div', {
          key: 'lang',
          style: {
            fontSize: 11,
            color: palette.faint || 'rgba(255,255,255,0.45)',
            fontFamily: palette.mono || 'ui-monospace, SFMono-Regular, Menlo, monospace',
            marginBottom: 6,
          },
        }, block.lang))
      }
      children.push(h('div', { key: 'body', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, block.text))
      out.push(h('pre', {
        key,
        style: {
          margin: '10px 0',
          padding: '10px 12px',
          background: palette.codeBg || 'rgba(255,255,255,0.06)',
          border: '1px solid ' + (palette.line || 'rgba(255,255,255,0.12)'),
          borderRadius: 8,
          overflowX: 'auto',
          fontSize: 12,
          lineHeight: '18px',
          fontFamily: palette.mono || 'ui-monospace, SFMono-Regular, Menlo, monospace',
        },
      }, children))
      return
    }
    if (block.type === 'quote') {
      out.push(
        h('blockquote', {
          key,
          style: {
            margin: '10px 0',
            padding: '2px 14px',
            borderLeft: '3px solid ' + (palette.accent || '#4f7cff'),
            color: palette.sub || 'rgba(255,255,255,0.72)',
          },
        }, renderMarkdownBlocks(block.blocks, opts)),
      )
      return
    }
    if (block.type === 'list') {
      const tag = block.ordered ? 'ol' : 'ul'
      const style = { margin: '8px 0', paddingLeft: 22 }
      if (block.ordered && block.start !== 1) style.start = block.start
      if (block.items.some(function marked(item) { return item.checked !== null })) style.listStyleType = 'none'
      out.push(
        h(tag, { key, style },
          block.items.map(function renderItem(item, itemIndex) {
            const children = []
            if (item.checked !== null) {
              children.push(h('span', {
                key: 'box',
                'aria-hidden': true,
                style: {
                  display: 'inline-block',
                  width: 14,
                  marginRight: 6,
                  color: item.checked ? (palette.accent || '#4f7cff') : (palette.faint || 'rgba(255,255,255,0.45)'),
                },
              }, item.checked ? '☑' : '☐'))
            }
            children.push(h('span', {
              key: 'text',
              style: item.checked === true ? { color: palette.sub || 'rgba(255,255,255,0.6)', textDecoration: 'line-through' } : null,
            }, renderInline(item.inline, opts)))
            return h('li', { key: 'li' + itemIndex, style: { margin: '3px 0', lineHeight } }, children)
          })),
      )
      return
    }
    if (block.type === 'table') {
      const cellStyle = {
        padding: '6px 10px',
        border: '1px solid ' + (palette.line || 'rgba(255,255,255,0.12)'),
        verticalAlign: 'top',
        lineHeight: 1.55,
        textAlign: 'left',
      }
      const alignOf = function alignOf(cellIndex) {
        const align = block.align[cellIndex]
        return align ? { textAlign: align } : null
      }
      out.push(
        h('div', { key, style: { overflowX: 'auto', margin: '10px 0' } },
          h('table', { style: { borderCollapse: 'collapse', fontSize: Math.max(12, fontSize - 1), minWidth: 260 } },
            h('thead', null,
              h('tr', null,
                block.header.map(function renderHeader(cell, cellIndex) {
                  return h('th', {
                    key: 'h' + cellIndex,
                    style: Object.assign({}, cellStyle, alignOf(cellIndex), { background: palette.codeBg || 'rgba(255,255,255,0.06)', fontWeight: 600 }),
                  }, renderInline(cell, opts))
                }))),
            h('tbody', null,
              block.rows.map(function renderRow(row, rowIndex) {
                return h('tr', { key: 'r' + rowIndex },
                  block.header.map(function renderCell(cell, cellIndex) {
                    return h('td', {
                      key: 'c' + cellIndex,
                      style: Object.assign({}, cellStyle, alignOf(cellIndex)),
                    }, renderInline(row[cellIndex] || [], opts))
                  }))
              })))),
      )
    }
  })
  return out
}

/** 解析 + 渲染一步到位；调用方提供 h 与调色板。 */
export function renderMarkdown(text, opts) {
  return renderMarkdownBlocks(parseMarkdown(text), opts)
}

export const MARKDOWN_MAX_CHARS = MAX_MARKDOWN_CHARS
