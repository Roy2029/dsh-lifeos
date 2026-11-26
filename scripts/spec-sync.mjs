#!/usr/bin/env node
/**
 * spec-sync — keep a software project's code, docs, plans, and status in sync.
 *
 * Zero dependencies. Safe to copy into any repository as `scripts/spec-sync.mjs`.
 *
 * Commands:
 *   init       scaffold STATUS.md, backlog, workflow, AGENTS block, and this CLI
 *   check      verify status/version/tests/backlog/plans/links consistency
 *   status     print a compact project dashboard
 *   sync       refresh mechanical STATUS fields (version/tests/date/commit)
 *   archive-plan <file>   move a finished plan into docs/plans/archive
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(import.meta.url);
const CLI_VERSION = '0.1.0';

const STATUS_FIELDS = [
  'project',
  'version',
  'milestone',
  'phase',
  'tests',
  'last-verified',
  'last-verified-commit',
  'openspec',
];

const STATUS_VALUES = new Set([
  'todo',
  'in-progress',
  'partial',
  'done',
  'deferred',
  'external',
  'dropped',
]);

const AGENTS_BEGIN = '<!-- spec-sync:begin -->';
const AGENTS_END = '<!-- spec-sync:end -->';

const DEFAULTS = {
  statusFile: 'STATUS.md',
  backlogFile: 'docs/product/backlog.md',
  workflowFile: 'docs/development/workflow.md',
  plansDir: 'docs/plans',
  archiveDir: 'docs/plans/archive',
  readmeFile: 'README.md',
  agentsFile: 'AGENTS.md',
  versionSources: [{ file: 'package.json', kind: 'json', pointer: 'version' }],
  testCommand: 'npm test',
  testCountPattern: '(?:#|ℹ)\\s*pass\\s+(\\d+)',
  forbiddenReadmeClaims: [],
  requiredFiles: [
    'README.md',
    'STATUS.md',
    'docs/product/backlog.md',
    'docs/development/workflow.md',
    'AGENTS.md',
  ],
};

/**
 * Process-wide hooks so tests can drive the CLI without spawning a child
 * process (DSH's file sandbox blocks piped child stdio with EPERM).
 */
const active = { spawn: spawnSync };

function main(argv, context = {}) {
  const [command, ...rest] = argv;
  const opts = parseArgs(rest);
  active.spawn = context.spawn ?? spawnSync;
  if (command === undefined || command === 'help' || opts.help === true) {
    printHelp();
    return 0;
  }
  const root = path.resolve(opts.root ?? context.cwd ?? process.cwd());
  switch (command) {
    case 'init':
      return cmdInit(root, opts);
    case 'check':
      return cmdCheck(root, opts);
    case 'status':
      return cmdStatus(root);
    case 'sync':
      return cmdSync(root, opts);
    case 'archive-plan':
      return cmdArchivePlan(root, opts);
    default:
      throw new Error(`unknown command "${command}" (try: init, check, status, sync, archive-plan)`);
  }
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      opts._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      opts[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    if (key === 'force' || key === 'tests' || key === 'json' || key === 'openspec' || key === 'help' || key === 'update-cli') {
      opts[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i += 1;
    }
  }
  return opts;
}

function printHelp() {
  console.log(`spec-sync ${CLI_VERSION}

Usage:
  node scripts/spec-sync.mjs init [--root DIR] [--name NAME] [--test-command CMD] [--force]
  node scripts/spec-sync.mjs check [--tests] [--json] [--openspec]
  node scripts/spec-sync.mjs status
  node scripts/spec-sync.mjs sync [--tests]
  node scripts/spec-sync.mjs archive-plan <plan.md>

Design:
  STATUS.md is the single source of truth for current state.
  docs/product/backlog.md tracks every user-visible item with evidence.
  docs/plans/*.md holds milestone plans; finished plans move to archive/.
  README.md stays stable: no volatile test counts or \"next milestone\" prose.
`);
}

function fail(message) {
  throw new Error(message);
}

function warn(message) {
  console.log(`! ${message}`);
}

function ok(message) {
  console.log(`✓ ${message}`);
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return undefined;
  }
}

function exists(file) {
  return fs.existsSync(file);
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Run a child process and capture its output without using OS pipes.
 *
 * DSH's file sandbox (and some locked-down CI runners) deny piped child stdio
 * with EPERM while still allowing inherited/file descriptors. Redirecting both
 * streams into a temp file keeps `check --tests` and git metadata working there.
 * Injected spawn functions (tests) bypass the file path.
 */
function runCaptured(command, args, options = {}) {
  if (active.spawn !== spawnSync) {
    const res = active.spawn(command, args, { ...options, encoding: 'utf8' });
    return res ?? {};
  }
  const file = path.join(os.tmpdir(), `spec-sync-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  let fd;
  try {
    fd = fs.openSync(file, 'w');
    const spawnOptions = { ...options, stdio: ['ignore', fd, fd] };
    delete spawnOptions.encoding;
    const res = args === undefined ? spawnSync(command, spawnOptions) : spawnSync(command, args, spawnOptions);
    fs.closeSync(fd);
    fd = undefined;
    const output = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    return { status: res.status, signal: res.signal, error: res.error, stdout: output, stderr: '' };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

function gitCommit(root) {
  const res = runCaptured('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: root,
    shell: false,
  });
  return res.status === 0 ? res.stdout.trim() : 'unknown';
}

function loadConfig(root) {
  const file = path.join(root, '.spec-sync.json');
  if (!exists(file)) {
    fail(`missing ${path.relative(root, file)}; run "node scripts/spec-sync.mjs init" in ${root}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readText(file));
  } catch (error) {
    fail(`.spec-sync.json is not valid JSON: ${error.message}`);
  }
  const config = { ...DEFAULTS, ...parsed };
  for (const key of ['statusFile', 'backlogFile', 'workflowFile', 'plansDir', 'archiveDir', 'readmeFile', 'agentsFile']) {
    config[key] = path.resolve(root, config[key]);
  }
  config.root = root;
  config.versionSources = Array.isArray(parsed.versionSources) ? parsed.versionSources : DEFAULTS.versionSources;
  config.requiredFiles = Array.isArray(parsed.requiredFiles) ? parsed.requiredFiles : DEFAULTS.requiredFiles;
  config.forbiddenReadmeClaims = Array.isArray(parsed.forbiddenReadmeClaims) ? parsed.forbiddenReadmeClaims : [];
  return config;
}

function parseStatus(text) {
  const fields = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[-*]\s*([^:]+):\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    fields.set(match[1].trim().toLowerCase().replace(/\s+/g, '-'), match[2].trim());
  }
  return fields;
}

function checkStatus(config) {
  const problems = [];
  if (!exists(config.statusFile)) return ['STATUS.md is missing'];
  const fields = parseStatus(readText(config.statusFile));
  for (const key of STATUS_FIELDS) {
    if (!fields.has(key)) problems.push(`STATUS.md is missing "- ${key}: value"`);
  }
  const tests = fields.get('tests');
  if (tests !== undefined && !/^\d+$/.test(tests)) {
    problems.push(`STATUS.md Tests must be a non-negative integer, got "${tests}"`);
  }
  const date = fields.get('last-verified');
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    problems.push(`STATUS.md Last verified must be YYYY-MM-DD, got "${date}"`);
  }
  const phase = fields.get('phase');
  if (phase !== undefined && !['planning', 'active', 'paused', 'blocked', 'done'].includes(phase.toLowerCase())) {
    problems.push(`STATUS.md Phase must be planning|active|paused|blocked|done, got "${phase}"`);
  }
  return problems;
}

function readVersionSource(root, source) {
  const file = path.resolve(root, source.file);
  if (!exists(file)) fail(`version source ${source.file} does not exist`);
  if (source.kind === 'json') {
    const data = readJson(file);
    if (data === undefined) fail(`version source ${source.file} is not valid JSON`);
    const segments = String(source.pointer ?? 'version').replace(/^\//, '').split(/[./]/).filter(Boolean);
    let value = data;
    for (const segment of segments) {
      if (value === null || typeof value !== 'object') return undefined;
      value = value[segment];
    }
    return typeof value === 'string' ? value : undefined;
  }
  if (source.kind === 'regex') {
    if (typeof source.pattern !== 'string' || source.pattern.length === 0) {
      fail(`version source ${source.file} needs a regex pattern`);
    }
    const match = new RegExp(source.pattern, 'm').exec(readText(file));
    return match ? (match[1] ?? match[0]) : undefined;
  }
  fail(`version source ${source.file} has unknown kind "${source.kind}"`);
  return undefined;
}

function checkVersion(config, fields) {
  const problems = [];
  const statusVersion = fields.get('version');
  if (statusVersion === undefined) return problems;
  for (const source of config.versionSources) {
    const actual = readVersionSource(config.root, source);
    if (actual === undefined) {
      problems.push(`cannot read version from ${source.file}`);
    } else if (actual !== statusVersion) {
      problems.push(`version drift: STATUS.md=${statusVersion}, ${source.file}=${actual}`);
    }
  }
  if (exists(config.readmeFile)) {
    const readme = readText(config.readmeFile);
    const match = /当前版本[^\n]*?[`"']?v?(\d+\.\d+\.\d+)/.exec(readme);
    if (match && match[1] !== statusVersion) {
      problems.push(`version drift: STATUS.md=${statusVersion}, README.md=${match[1]}`);
    }
  }
  return problems;
}

function checkReadme(config, fields) {
  const problems = [];
  if (!exists(config.readmeFile)) return problems;
  const readme = readText(config.readmeFile);
  const tests = fields.get('tests');
  const claims = [...readme.matchAll(/(\d+)\s*项测试/g)].map((m) => m[1]);
  for (const claim of claims) {
    if (tests !== undefined && claim !== tests) {
      problems.push(`README.md says ${claim} tests, STATUS.md says ${tests}`);
    }
  }
  for (const claim of config.forbiddenReadmeClaims) {
    if (readme.includes(claim)) problems.push(`README.md still contains forbidden claim "${claim}"`);
  }
  return problems;
}

function runTests(config) {
  if (!config.testCommand) fail('no testCommand configured');
  const res = runCaptured(config.testCommand, undefined, {
    cwd: config.root,
    shell: true,
    timeout: 20 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  if (res.error) fail(`test command failed to start: ${res.error.message}`);
  const match = new RegExp(config.testCountPattern, 'm').exec(output);
  if (!match) {
    const tail = output.trim().split(/\r?\n/).slice(-12).join('\n');
    fail(`could not parse a test count from "${config.testCommand}"; configured pattern ${config.testCountPattern}\n${tail}`);
  }
  if (res.status !== 0) {
    const tail = output.trim().split(/\r?\n/).slice(-12).join('\n');
    fail(`test command exited ${res.status}\n${tail}`);
  }
  return Number(match[1]);
}

function checkTests(config, fields, opts) {
  const problems = [];
  const statusTests = fields.get('tests');
  if (statusTests === undefined) return problems;
  if (opts.tests === true) {
    const actual = runTests(config);
    if (String(actual) !== statusTests) {
      problems.push(`test count drift: STATUS.md=${statusTests}, actual=${actual}`);
    }
  }
  return problems;
}

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return undefined;
  return trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function parseBacklog(text) {
  const lines = text.split(/\r?\n/);
  let header;
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const cells = splitTableRow(lines[i]);
    if (cells === undefined) continue;
    const normalized = cells.map((cell) => cell.toLowerCase());
    if (normalized.includes('id') && normalized.includes('status')) {
      header = cells;
      headerIndex = i;
      break;
    }
  }
  if (header === undefined) return { header: undefined, items: [] };
  const index = Object.fromEntries(header.map((cell, i) => [cell.toLowerCase(), i]));
  const items = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const cells = splitTableRow(lines[i]);
    if (cells === undefined) break;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell) || cell === '')) continue;
    items.push({
      id: cells[index.id] ?? '',
      item: cells[index.item] ?? '',
      status: (cells[index.status] ?? '').toLowerCase(),
      milestone: cells[index.milestone] ?? '',
      evidence: cells[index.evidence] ?? '',
      line: i + 1,
    });
  }
  return { header, items };
}

function checkBacklog(config) {
  const problems = [];
  if (!exists(config.backlogFile)) return ['backlog file is missing'];
  const { header, items } = parseBacklog(readText(config.backlogFile));
  if (header === undefined) return ['backlog has no markdown table with ID and Status columns'];
  for (const column of ['id', 'item', 'status', 'milestone', 'evidence']) {
    if (!header.map((cell) => cell.toLowerCase()).includes(column)) {
      problems.push(`backlog table is missing the "${column}" column`);
    }
  }
  const seen = new Set();
  for (const item of items) {
    if (!item.id) problems.push(`backlog line ${item.line}: empty ID`);
    if (seen.has(item.id)) problems.push(`backlog line ${item.line}: duplicate ID ${item.id}`);
    seen.add(item.id);
    if (!item.item) problems.push(`backlog ${item.id || `line ${item.line}`}: empty item`);
    if (!STATUS_VALUES.has(item.status)) {
      problems.push(`backlog ${item.id}: status "${item.status}" is not one of ${[...STATUS_VALUES].join('|')}`);
    }
    if (item.status === 'done' && !hasEvidence(item.evidence)) {
      problems.push(`backlog ${item.id}: done requires evidence (commit/test/screenshot/doc path)`);
    }
    if (item.status === 'partial' && !hasEvidence(item.evidence)) {
      problems.push(`backlog ${item.id}: partial requires a note describing what remains`);
    }
  }
  return problems;
}

function hasEvidence(value) {
  const text = value.trim();
  return text.length > 0 && text !== '—' && text !== '–' && text !== '-' && text.toLowerCase() !== 'n/a';
}

function backlogCounts(config) {
  const counts = Object.fromEntries([...STATUS_VALUES].map((status) => [status, 0]));
  if (!exists(config.backlogFile)) return counts;
  const { items } = parseBacklog(readText(config.backlogFile));
  for (const item of items) {
    if (counts[item.status] !== undefined) counts[item.status] += 1;
    else counts.unknown = (counts.unknown ?? 0) + 1;
  }
  return counts;
}

function planFiles(config) {
  if (!exists(config.plansDir)) return [];
  return fs.readdirSync(config.plansDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(config.plansDir, entry.name));
}

function parsePlan(text) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  let status;
  if (frontmatter) {
    const match = /^status\s*:\s*(\S+)/m.exec(frontmatter[1]);
    if (match) status = match[1].toLowerCase();
  }
  if (status === undefined) {
    const head = text.split(/\r?\n/).slice(0, 20).join('\n');
    const match = /状态[:：]\s*([^\s（(]+)/.exec(head);
    if (match) {
      const raw = match[1];
      if (raw.includes('进行中')) status = 'active';
      else if (raw.includes('已完成') || raw.includes('完成')) status = 'completed';
      else if (raw.includes('已归档') || raw.includes('归档')) status = 'archived';
      else status = raw.toLowerCase();
    }
  }
  const unchecked = (text.match(/^\s*[-*]\s*\[ \]/gm) ?? []).length;
  const checked = (text.match(/^\s*[-*]\s*\[[xX]\]/gm) ?? []).length;
  return { status, unchecked, checked };
}

function checkPlans(config) {
  const problems = [];
  const warnings = [];
  for (const file of planFiles(config)) {
    const name = path.basename(file);
    const { status, unchecked } = parsePlan(readText(file));
    if (status === undefined) {
      warnings.push(`plan ${name} has no status; add frontmatter "status: active|completed|archived"`);
      continue;
    }
    if (!['active', 'completed', 'archived', 'paused'].includes(status)) {
      warnings.push(`plan ${name} has unknown status "${status}"`);
    }
    if (status === 'active' && unchecked === 0) {
      warnings.push(`plan ${name} is active but has no unchecked tasks; archive it when the milestone is verified`);
    }
    if ((status === 'completed' || status === 'archived') && unchecked > 0) {
      problems.push(`plan ${name} is ${status} but still has ${unchecked} unchecked task(s)`);
    }
  }
  return { problems, warnings };
}

function stripFencedCode(text) {
  return text.replace(/^```[\s\S]*?^```/gm, '');
}

function checkLinks(config) {
  const problems = [];
  const files = new Set();
  for (const file of [config.readmeFile, config.statusFile, config.workflowFile, config.backlogFile, config.agentsFile]) {
    if (exists(file)) files.add(file);
  }
  const docsDir = path.join(config.root, 'docs');
  const walk = (dir) => {
    if (!exists(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'archive' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.name.endsWith('.md')) {
        files.add(full);
      }
    }
  };
  walk(docsDir);
  let count = 0;
  for (const file of files) {
    const text = stripFencedCode(readText(file));
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      let target = match[1].trim();
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
      target = target.split(/\s+/)[0];
      if (!target || target.startsWith('#') || target.startsWith('/')) continue;
      if (/^(?:https?|mailto|tel|data):/i.test(target)) continue;
      if (target.includes('{{')) continue;
      const withoutAnchor = target.split('#')[0].split('?')[0];
      if (!withoutAnchor) continue;
      let decoded = withoutAnchor;
      try {
        decoded = decodeURIComponent(withoutAnchor);
      } catch {
        // Keep the raw path when malformed percent escapes appear.
      }
      const resolved = path.resolve(path.dirname(file), decoded);
      count += 1;
      if (!exists(resolved)) {
        problems.push(`${path.relative(config.root, file)} links to missing ${decoded}`);
      }
    }
  }
  return { problems, count };
}

function checkAgents(config) {
  const warnings = [];
  if (!exists(config.agentsFile)) return warnings;
  const text = readText(config.agentsFile);
  if (!text.includes(AGENTS_BEGIN) || !text.includes(AGENTS_END)) {
    warnings.push('AGENTS.md has no spec-sync managed block; run init again');
  } else if (!/STATUS\.md/.test(text)) {
    warnings.push('AGENTS.md spec-sync block does not mention STATUS.md');
  }
  return warnings;
}

function checkOpenSpec(config, opts, fields) {
  const problems = [];
  const changesDir = path.join(config.root, 'openspec', 'changes');
  if (exists(changesDir)) {
    for (const entry of fs.readdirSync(changesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'archive') continue;
      const dir = path.join(changesDir, entry.name);
      const artifacts = fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
      if (artifacts.length === 0) {
        problems.push(`openspec change ${entry.name} has no markdown artifacts`);
      }
    }
  }
  if (opts.openspec === true) {
    const res = runCaptured('openspec', ['validate', '--all', '--strict'], {
      cwd: config.root,
      shell: true,
      timeout: 120000,
    });
    if (res.error) {
      problems.push(`openspec validate could not start: ${res.error.message}`);
    } else if (res.status !== 0) {
      const tail = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim().split(/\r?\n/).slice(-10).join('\n');
      problems.push(`openspec validate --all --strict failed\n${tail}`);
    }
  }
  if (fields.get('openspec') === 'adopted' && !exists(path.join(config.root, 'openspec'))) {
    problems.push('STATUS.md says OpenSpec: adopted, but openspec/ does not exist');
  }
  return problems;
}

function cmdInit(root, opts) {
  fs.mkdirSync(root, { recursive: true });
  const pkg = readJson(path.join(root, 'package.json'));
  const name = String(opts.name ?? pkg?.name ?? path.basename(root));
  const version = String(pkg?.version ?? '0.0.0');
  const testCommand = String(opts['test-command'] ?? (pkg?.scripts?.test ? 'npm test' : ''));
  const milestone = String(opts.milestone ?? 'unplanned');
  const force = opts.force === true;
  const configFile = path.join(root, '.spec-sync.json');
  const config = {
    schemaVersion: 1,
    project: name,
    statusFile: DEFAULTS.statusFile,
    backlogFile: DEFAULTS.backlogFile,
    workflowFile: DEFAULTS.workflowFile,
    plansDir: DEFAULTS.plansDir,
    archiveDir: DEFAULTS.archiveDir,
    readmeFile: DEFAULTS.readmeFile,
    agentsFile: DEFAULTS.agentsFile,
    versionSources: pkg ? [{ file: 'package.json', kind: 'json', pointer: 'version' }] : [],
    testCommand,
    testCountPattern: DEFAULTS.testCountPattern,
    forbiddenReadmeClaims: [],
    requiredFiles: DEFAULTS.requiredFiles,
  };

  const results = [];
  const put = (relative, content, label) => {
    const file = path.join(root, relative);
    if (exists(file) && !force) {
      results.push(`skip ${label} (exists; use --force to overwrite)`);
      return false;
    }
    writeText(file, content);
    results.push(`write ${label}`);
    return true;
  };

  put('.spec-sync.json', `${JSON.stringify(config, null, 2)}\n`, '.spec-sync.json');
  put(DEFAULTS.statusFile, statusTemplate({ name, version, milestone, date: today(), commit: gitCommit(root) }), 'STATUS.md');
  put(DEFAULTS.backlogFile, backlogTemplate(milestone), 'docs/product/backlog.md');
  put(DEFAULTS.workflowFile, workflowTemplate(), 'docs/development/workflow.md');
  fs.mkdirSync(path.join(root, DEFAULTS.archiveDir), { recursive: true });

  const agentsFile = path.join(root, DEFAULTS.agentsFile);
  const existingAgents = exists(agentsFile) ? readText(agentsFile) : '# AGENTS.md\n';
  writeText(agentsFile, upsertAgentsBlock(existingAgents));
  results.push('update AGENTS.md managed block');

  const destCli = path.join(root, 'scripts', 'spec-sync.mjs');
  if (!exists(destCli) || force || opts['update-cli'] === true) {
    writeText(destCli, readText(CLI_PATH));
    try {
      fs.chmodSync(destCli, 0o755);
    } catch {
      // Windows does not need POSIX mode bits.
    }
    results.push('write scripts/spec-sync.mjs');
  } else {
    results.push('skip scripts/spec-sync.mjs (exists; use --update-cli to refresh)');
  }

  for (const line of results) console.log(`- ${line}`);
  if (opts.tests === true && testCommand) {
    const actual = runTests(loadConfig(root));
    updateStatusFile(root, { tests: String(actual) });
    console.log(`- Tests: ${actual}`);
  }
  console.log(`\nInitialized ${name}. Next: fill STATUS.md Now/Next, seed docs/product/backlog.md, then run check.`);
  return 0;
}

function statusTemplate({ name, version, milestone, date, commit }) {
  return `# STATUS

> Single source of truth for the current state. Keep this file short and current.
> README.md is the stable user-facing overview; do not duplicate volatile numbers there.

- Project: ${name}
- Version: ${version}
- Milestone: ${milestone}
- Phase: planning
- Tests: 0
- Last verified: ${date}
- Last verified commit: ${commit}
- OpenSpec: optional

## Now

- Bootstrap the project state; replace this line with the current objective.

## Next

- Add the next milestone plan under \`docs/plans/\`.

## Decisions needed

- None.
`;
}

function backlogTemplate(milestone) {
  return `# Product backlog

> One row per user-visible item. Status: todo | in-progress | partial | done | deferred | external | dropped.
> \`done\` rows require evidence (commit, test, screenshot, or doc path).
> \`partial\` rows require a note describing what remains.

| ID | Item | Status | Milestone | Evidence |
|---|---|---|---|---|
| #1 | Replace with the first item | todo | ${milestone} | — |
`;
}

function workflowTemplate() {
  return `# Development workflow

This file is the contract between code, docs, and status. It is intentionally
short; the executable rules live in \`scripts/spec-sync.mjs\`.

## Single sources of truth

| Question | File |
|---|---|
| What are we building now? | \`STATUS.md\` |
| What is left, and what proves it shipped? | \`docs/product/backlog.md\` |
| What did we agree to build? | \`docs/plans/*.md\` and \`openspec/specs\` |
| How do I use the product? | \`README.md\` (stable; no volatile numbers) |

## Lifecycle

### 1. Start

- Run \`node scripts/spec-sync.mjs status\`.
- Pick one backlog item or one milestone plan. Do not work on several unrelated
  items at once.
- If the item changes behavior, write the acceptance criteria first (plan or
  OpenSpec change).

### 2. Work

- Keep commits small and scoped to one item.
- Update the plan's checkboxes only after the corresponding evidence exists.
- Do not edit \`STATUS.md\` mid-work unless the milestone changes.

### 3. Finish

- Run the real test command and \`node scripts/spec-sync.mjs check --tests\`.
- Add evidence to the backlog row: commit, test name/output, screenshot path, or
  doc path.
- Update \`STATUS.md\`: milestone, phase, test count, date, commit.
- Archive the milestone plan only after user-visible verification.

### 4. Archive

- Move finished plans to \`docs/plans/archive/\` with
  \`node scripts/spec-sync.mjs archive-plan docs/plans/Mx-PLAN.md\`.
- Archive OpenSpec changes with \`openspec archive <name>\` after validation.
- Keep history; never delete a plan.

## Definition of done

- [ ] The user-visible behavior works, not just the code path.
- [ ] Tests pass with the documented command; the count is in \`STATUS.md\`.
- [ ] Backlog row has evidence and the correct status.
- [ ] Plan checkboxes match reality; no "in progress" plan with everything done.
- [ ] \`node scripts/spec-sync.mjs check --tests\` passes.
- [ ] README still describes the product, not the current sprint.

## Status vocabulary

- \`todo\`: not started.
- \`in-progress\`: actively being built.
- \`partial\`: some user-visible part shipped; evidence says what remains.
- \`done\`: verified; evidence is required.
- \`deferred\`: intentionally postponed; record why.
- \`external\`: owned by another team/branch.
- \`dropped\`: no longer planned; record why.

## Guardrails

- Never mark a checkbox from a plan or a test you did not actually run.
- Never put changing numbers (test counts, version, current milestone) in
  \`README.md\`; link to \`STATUS.md\` instead.
- Plans live in the repository, not in a chat or an external folder.
- When code and docs disagree, treat the code as evidence and the doc as a bug.
`;
}

function upsertAgentsBlock(text) {
  const block = `${AGENTS_BEGIN}
## Project state and docs (managed by spec-sync)

- \`STATUS.md\` is the single source of truth for version, milestone, phase, test
  count, and last verified commit.
- \`docs/product/backlog.md\` is the only place for item status and evidence.
- Before work, run \`node scripts/spec-sync.mjs status\`.
- After work, update \`STATUS.md\` and the backlog, then run
  \`node scripts/spec-sync.mjs check --tests\`.
- Do not put volatile numbers in \`README.md\`; link to \`STATUS.md\`.
- Finished plans move to \`docs/plans/archive/\`; never delete them.
${AGENTS_END}
`;
  if (text.includes(AGENTS_BEGIN) && text.includes(AGENTS_END)) {
    const pattern = new RegExp(`${escapeRegExp(AGENTS_BEGIN)}[\\s\\S]*?${escapeRegExp(AGENTS_END)}\\n?`);
    return text.replace(pattern, block);
  }
  const trimmed = text.replace(/\s*$/, '');
  return `${trimmed}\n\n${block}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function updateStatusFile(root, updates) {
  const config = loadConfig(root);
  const file = config.statusFile;
  if (!exists(file)) fail('STATUS.md is missing');
  let text = readText(file);
  for (const [key, value] of Object.entries(updates)) {
    const label = key.split('-').map(escapeRegExp).join('[\\s-]+');
    const pattern = new RegExp(`^(\\s*[-*]\\s*${label}\\s*:\\s*).*$`, 'mi');
    if (!pattern.test(text)) fail(`STATUS.md has no "- ${key}:" field`);
    text = text.replace(pattern, `$1${value}`);
  }
  writeText(file, text);
}

function cmdCheck(root, opts) {
  const config = loadConfig(root);
  const problems = [];
  const warnings = [];
  const summary = [];

  for (const relative of config.requiredFiles) {
    if (!exists(path.resolve(root, relative))) problems.push(`required file missing: ${relative}`);
  }
  if (problems.length === 0) summary.push(`required files (${config.requiredFiles.length})`);

  problems.push(...checkStatus(config));
  if (problems.length === 0 || problems.every((p) => !p.startsWith('STATUS.md'))) {
    summary.push('STATUS fields');
  }

  if (!exists(config.statusFile)) {
    reportCheck(summary, problems, warnings, opts);
    return 1;
  }
  const fields = parseStatus(readText(config.statusFile));

  const versionProblems = checkVersion(config, fields);
  problems.push(...versionProblems);
  if (versionProblems.length === 0) summary.push(`version ${fields.get('version')} (${config.versionSources.length} source)`);

  const testProblems = checkTests(config, fields, opts);
  problems.push(...testProblems);
  if (testProblems.length === 0) summary.push(`tests ${fields.get('tests')}${opts.tests === true ? ' (verified)' : ''}`);

  problems.push(...checkReadme(config, fields));
  const backlogProblems = checkBacklog(config);
  problems.push(...backlogProblems);
  if (backlogProblems.length === 0) {
    const counts = backlogCounts(config);
    summary.push(`backlog (${Object.entries(counts).filter(([key]) => key !== 'unknown').map(([key, value]) => `${key} ${value}`).join(', ')})`);
  }

  const planResult = checkPlans(config);
  problems.push(...planResult.problems);
  warnings.push(...planResult.warnings);
  summary.push(`plans (${planFiles(config).length})`);

  const linkResult = checkLinks(config);
  problems.push(...linkResult.problems);
  if (linkResult.problems.length === 0) summary.push(`links (${linkResult.count})`);

  warnings.push(...checkAgents(config));
  problems.push(...checkOpenSpec(config, opts, fields));

  reportCheck(summary, problems, warnings, opts);
  return problems.length > 0 ? 1 : 0;
}

function reportCheck(summary, problems, warnings, opts) {
  if (opts.json === true) {
    console.log(JSON.stringify({ ok: problems.length === 0, summary, problems, warnings }, null, 2));
    return;
  }
  for (const line of summary) ok(line);
  for (const line of warnings) warn(line);
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const line of problems) console.error(`✗ ${line}`);
  } else {
    console.log('\nAll checks passed.');
  }
}

function cmdStatus(root) {
  const config = loadConfig(root);
  if (!exists(config.statusFile)) fail('STATUS.md is missing');
  const fields = parseStatus(readText(config.statusFile));
  const counts = backlogCounts(config);
  const plans = planFiles(config).map((file) => {
    const { status } = parsePlan(readText(file));
    return `${path.basename(file)} (${status ?? 'no-status'})`;
  });
  const changesDir = path.join(root, 'openspec', 'changes');
  const changes = exists(changesDir)
    ? fs.readdirSync(changesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
      .map((entry) => entry.name)
    : [];

  console.log(`${fields.get('project') ?? path.basename(root)} ${fields.get('version') ?? '?'} · ${fields.get('milestone') ?? '?'} · ${fields.get('phase') ?? '?'}`);
  console.log(`Tests: ${fields.get('tests') ?? '?'} · verified ${fields.get('last-verified') ?? '?'} @ ${fields.get('last-verified-commit') ?? '?'}`);
  console.log(`Backlog: ${Object.entries(counts).filter(([key]) => key !== 'unknown').map(([key, value]) => `${key} ${value}`).join(' · ')}`);
  console.log(`Plans: ${plans.length > 0 ? plans.join(', ') : 'none'}`);
  console.log(`Changes: ${changes.length > 0 ? changes.join(', ') : 'none'}`);
  if (fields.get('openspec') === 'adopted') console.log('OpenSpec: adopted');
}

function cmdSync(root, opts) {
  const config = loadConfig(root);
  if (!exists(config.statusFile)) fail('STATUS.md is missing');
  const fields = parseStatus(readText(config.statusFile));
  const updates = {};
  const source = config.versionSources[0];
  if (source !== undefined) {
    const version = readVersionSource(root, source);
    if (version !== undefined) updates.version = version;
  }
  if (opts.tests === true) updates.tests = String(runTests(config));
  updates['last-verified'] = today();
  updates['last-verified-commit'] = gitCommit(root);
  updateStatusFile(root, updates);
  for (const [key, value] of Object.entries(updates)) {
    console.log(`- ${key}: ${value}`);
  }
  if (fields.get('version') !== updates.version) {
    console.log(`! version was ${fields.get('version')}; update README/version sources if needed`);
  }
  return 0;
}

function cmdArchivePlan(root, opts) {
  const config = loadConfig(root);
  const target = opts._[0];
  if (!target) fail('usage: archive-plan <plan.md>');
  const file = path.resolve(root, target);
  if (!exists(file)) fail(`plan not found: ${target}`);
  const relative = path.relative(config.plansDir, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`plan must live under ${path.relative(root, config.plansDir)}`);
  }
  if (relative.startsWith('archive')) fail('plan is already archived');
  let text = readText(file);
  const date = today();
  if (/^---\r?\n[\s\S]*?\r?\n---/.test(text)) {
    if (/^status\s*:/m.test(text)) text = text.replace(/^status\s*:.*$/m, 'status: archived');
    else text = text.replace(/^---\r?\n/, `---\nstatus: archived\narchived: ${date}\n`);
    if (!/^archived\s*:/m.test(text)) {
      text = text.replace(/^status\s*:.*$/m, (line) => `${line}\narchived: ${date}`);
    }
  } else if (/^状态[:：]/m.test(text)) {
    text = text.replace(/^状态[:：].*$/m, `状态：已归档（${date}）`);
  } else {
    text = `> Archived: ${date}\n\n${text}`;
  }
  const dest = path.join(config.archiveDir, path.basename(file));
  if (exists(dest)) fail(`archive target already exists: ${path.relative(root, dest)}`);
  fs.mkdirSync(config.archiveDir, { recursive: true });
  writeText(file, text);
  fs.renameSync(file, dest);
  console.log(`archived ${path.relative(root, file)} -> ${path.relative(root, dest)}`);
  return 0;
}

const isEntryPoint = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(CLI_PATH);

if (isEntryPoint) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`spec-sync: ${error.message}`);
    process.exitCode = 1;
  }
}

export { main, parseStatus, checkReadme, checkVersion, parseBacklog };
