#!/usr/bin/env node
// Inline client-v2/*.js modules into client.js between the V2 markers.
// Usage: node scripts/build-v2.mjs [--check]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const sourceDir = path.join(repo, 'client-v2')
const targetFile = path.join(repo, 'client.js')
const START = '/* ==== V2-MODULES-START ==== */'
const END = '/* ==== V2-MODULES-END ==== */'

const checkOnly = process.argv.includes('--check')

function fail(message) {
  console.error('[build-v2] ' + message)
  process.exit(1)
}

const client = fs.readFileSync(targetFile, 'utf8')
const startIndex = client.indexOf(START)
const endIndex = client.indexOf(END)
if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
  fail('V2 markers not found in client.js')
}

if (!fs.existsSync(sourceDir)) {
  fail('client-v2 directory not found: ' + sourceDir)
}

const files = fs
  .readdirSync(sourceDir)
  .filter((name) => name.endsWith('.js'))
  .sort()

if (!files.length) fail('no client-v2/*.js files')

const chunks = []
for (const name of files) {
  const filePath = path.join(sourceDir, name)
  let code = fs.readFileSync(filePath, 'utf8')
  code = code.replace(/\r\n/g, '\n')
  if (/^[ \t]*import[ \t]/m.test(code) || /^[ \t]*export[ \t]/m.test(code)) {
    fail(name + ' must not contain ESM import/export')
  }
  const lines = code.split('\n').length
  chunks.push('/* ---- ' + name + ' (' + lines + ' lines) ---- */\n' + code.trim() + '\n')
}

const body = chunks.join('\n')
const before = client.slice(0, startIndex + START.length)
const after = client.slice(endIndex)
const next = before + '\n' + body + '\n' + after

if (checkOnly) {
  const current = client.slice(startIndex + START.length, endIndex).trim()
  if (current !== body.trim()) {
    console.error('[build-v2] client.js is stale; run node scripts/build-v2.mjs')
    process.exit(2)
  }
  console.log('[build-v2] client.js is up to date (' + files.length + ' modules)')
  process.exit(0)
}

if (next === client) {
  console.log('[build-v2] no changes (' + files.length + ' modules)')
  process.exit(0)
}

fs.writeFileSync(targetFile, next, 'utf8')
console.log('[build-v2] inlined ' + files.length + ' modules into client.js (' + files.join(', ') + ')')
console.log('[build-v2] client.js size ' + fs.statSync(targetFile).size + ' bytes')
