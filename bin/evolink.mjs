#!/usr/bin/env node
// EvoLink CLI: one-command setup for Claude Code on EvoLink.
// Zero dependencies. Requires Node.js >= 18. macOS / Linux / Windows.
//
//   evolink setup    configure Claude Code (default command)
//   evolink doctor   read-only diagnostics plus a redacted report for support
//   evolink reset    undo the changes made by `evolink setup`

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.1.2';
export const DEFAULT_BASE_URL = 'https://direct.evolink.ai';
export const DEFAULT_MAX_OUTPUT_TOKENS = 32000;
const LOW_BALANCE_CREDITS = 50;
const CLAUDE_PKG = '@anthropic-ai/claude-code';
const REGISTRIES = { npmjs: 'https://registry.npmjs.org', npmmirror: 'https://registry.npmmirror.com' };
const DASHBOARD_KEYS_URL = 'https://evolink.ai/dashboard/keys';
const EVOLINK_HOSTS = /(^|\.)evolink\.ai$/i;

// Models offered in the interactive picker, filtered by what the key can use.
export const RECOMMENDED_MODELS = [
  { id: 'claude-sonnet-5', zh: '性价比高，适合日常编程', en: 'best value for everyday coding' },
  { id: 'claude-opus-5-5', zh: '更强，单价和单次预扣都更高', en: 'stronger; higher price and per-request hold' },
  { id: 'claude-fable-5-1', zh: '推理最强，价格最高', en: 'strongest reasoning; most expensive' },
  { id: 'claude-haiku-4-5-20251001', zh: '最便宜、最快，适合轻量任务', en: 'cheapest and fastest' },
];

// Variables that pick models; a value the key cannot use breaks every request of that tier.
export const MODEL_OVERRIDE_VARS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];
// Provider switches beat every credential; any of them silently bypasses EvoLink.
export const PROVIDER_VARS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
export const WATCH_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  ...MODEL_OVERRIDE_VARS,
  ...PROVIDER_VARS,
];
const SECRET_VARS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']);
const MODEL_ALIASES = new Set(['default', 'best', 'opus', 'sonnet', 'haiku', 'opusplan']);
const RESTRICTIVE_POLICIES = new Set(['Restricted', 'AllSigned', 'Undefined']);
const DLP_KEY = 'claudeCode.disableLoginPrompt';

const EXIT = { OK: 0, ERROR: 1, USAGE: 2, AUTH: 2, NOT_INSTALLED: 3, CONFIG: 4, NETWORK: 5, CANCELLED: 130 };

// ---------------------------------------------------------------------------
// Language and terminal output

let LANG = 'en';
const L = (zh, en) => (LANG === 'zh' ? zh : en);

export function detectLang(explicit, env = process.env) {
  const pick = (v) => (v && /^zh/i.test(v) ? 'zh' : v && /^en/i.test(v) ? 'en' : null);
  const fromArg = pick(explicit) || pick(env.EVOLINK_LANG);
  if (fromArg) return fromArg;
  const posix = [env.LC_ALL, env.LC_MESSAGES, env.LANG].filter(Boolean).join(' ');
  if (posix) return /(^|[^a-z])zh/i.test(posix) ? 'zh' : 'en';
  try {
    return /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

const ui = {
  quiet: false,
  color: false,
  ascii: false,
  init({ json = false } = {}) {
    this.quiet = json;
    this.color = !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
    this.ascii = process.platform === 'win32' && !process.env.WT_SESSION && process.env.TERM_PROGRAM !== 'vscode';
  },
  paint(code, s) {
    return this.color ? `\x1b[${code}m${s}\x1b[0m` : s;
  },
  mark(kind) {
    const marks = this.ascii
      ? { ok: '[OK]', warn: '[!]', err: '[X]', dot: '-' }
      : { ok: '✓', warn: '⚠', err: '✗', dot: '·' };
    return this.paint({ ok: 32, warn: 33, err: 31, dot: 2 }[kind], marks[kind]);
  },
  print(s = '') {
    if (!this.quiet) process.stdout.write(`${s}\n`);
  },
  ok(s) {
    this.print(`  ${this.mark('ok')} ${s}`);
  },
  warn(s) {
    this.print(`  ${this.mark('warn')} ${s}`);
  },
  err(s) {
    this.print(`  ${this.mark('err')} ${s}`);
  },
  info(s) {
    this.print(`  ${this.mark('dot')} ${s}`);
  },
  sub(s) {
    this.print(`      ${s}`);
  },
  title(s) {
    this.print(this.paint('1', s));
  },
  step(i, n, s) {
    this.print('');
    this.print(`${this.paint('1;36', `[${i}/${n}]`)} ${this.paint('1', s)}`);
  },
  dim(s) {
    return this.paint('2', s);
  },
};

// ---------------------------------------------------------------------------
// Errors

class CliError extends Error {
  constructor(message, exitCode = EXIT.ERROR, hints = []) {
    super(message);
    this.exitCode = exitCode;
    this.hints = hints;
  }
}
class CancelledError extends CliError {
  constructor(message) {
    super(message || L('已取消，没有改动任何文件。', 'Cancelled. No files were changed.'), EXIT.CANCELLED);
  }
}

// ---------------------------------------------------------------------------
// Small helpers

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => isPlainObject(o) && Object.prototype.hasOwnProperty.call(o, k);
const truthy = (v) => v !== undefined && v !== null && !/^(|0|false|no|off)$/i.test(String(v).trim());
export const hashValue = (v) =>
  v === undefined ? null : crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 16);

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
export function tildify(p) {
  const home = os.homedir();
  if (!p) return p;
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}
function stamp(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const fmtCredits = (n) =>
  Number(n).toLocaleString(LANG === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// Keys, URLs and models (pure; unit tested)

export function normalizeKey(input) {
  let k = String(input ?? '');
  k = k.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[\u00A0\u3000]/g, ' ').trim();
  k = k.replace(/^(?:export\s+)?(?:ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|EVOLINK_API_KEY)\s*=\s*/i, '');
  k = k.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').trim();
  k = k.replace(/^bearer\s+/i, '').trim();
  return k;
}

export function checkKeyFormat(k) {
  if (!k) return { ok: false, reason: 'empty' };
  if (/\s/.test(k)) return { ok: false, reason: 'whitespace' };
  if (/[^\x21-\x7e]/.test(k)) return { ok: false, reason: 'non_ascii' };
  const body = k.startsWith('sk-') ? k.slice(3) : k;
  if (body.includes('-')) return { ok: true, warn: 'dash_suffix' };
  if (!/^[A-Za-z0-9]{48}$/.test(body)) return { ok: true, warn: 'unusual_format' };
  return { ok: true };
}

export function maskKey(k) {
  if (!k) return '';
  const s = String(k);
  const prefix = s.startsWith('sk-') ? 'sk-' : '';
  const body = s.slice(prefix.length);
  if (body.length <= 8) return `${prefix}****`;
  return `${prefix}${body.slice(0, 4)}…${body.slice(-4)}`;
}

export function normalizeBaseUrl(input) {
  const s = String(input || '').trim();
  let u;
  try {
    u = new URL(s);
  } catch {
    return { error: 'invalid' };
  }
  if (!/^https?:$/.test(u.protocol)) return { error: 'invalid' };
  let pathname = u.pathname.replace(/\/+$/, '');
  const strippedV1 = /\/v1$/i.test(pathname);
  if (strippedV1) pathname = pathname.replace(/\/v1$/i, '');
  return { url: `${u.protocol}//${u.host}${pathname}`, strippedV1 };
}

// An EvoLink domain, or the endpoint explicitly chosen with EVOLINK_BASE_URL (private deployments, tests).
export function isEvolinkUrl(u) {
  try {
    if (EVOLINK_HOSTS.test(new URL(u).hostname)) return true;
  } catch {
    return false;
  }
  const custom = process.env.EVOLINK_BASE_URL && normalizeBaseUrl(process.env.EVOLINK_BASE_URL).url;
  return !!custom && normalizeBaseUrl(u).url === custom;
}

export function modelAvailable(id, ids) {
  if (id === undefined || id === null || String(id).trim() === '') return true;
  const base = String(id).trim().replace(/\[1m\]$/i, '');
  if (MODEL_ALIASES.has(base.toLowerCase())) return true;
  return ids.has(base);
}

export function suggestModel(input, ids) {
  const norm = String(input || '').trim().toLowerCase().replace(/\s+/g, '').replace(/\./g, '-').replace(/\[1m\]$/, '');
  if (!norm) return null;
  if (ids.has(norm)) return norm;
  const all = [...ids];
  return all.find((i) => i.startsWith(norm)) || all.find((i) => i.includes(norm)) || null;
}

export function pickTestModel(preferred, ids) {
  if (preferred && ids.has(preferred)) return preferred;
  const claude = [...ids].filter((i) => i.startsWith('claude-'));
  return claude.find((i) => i.includes('haiku')) || claude.find((i) => i.includes('sonnet')) || claude[0] || null;
}

// Numeric compare of dotted versions ("2.1.260" < "2.1.283"); pre-release suffixes are ignored.
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export function displayValue(name, value) {
  if (value === undefined) return L('（无）', '(none)');
  if (value === '') return '""';
  if (SECRET_VARS.has(name)) return maskKey(String(value));
  return String(value);
}

// ---------------------------------------------------------------------------
// Settings plans (pure; unit tested)

export function planEnvChanges(env, { set = {}, remove = [] } = {}) {
  const cur = isPlainObject(env) ? env : {};
  const changes = [];
  for (const [key, after] of Object.entries(set)) {
    const before = hasOwn(cur, key) ? cur[key] : undefined;
    changes.push({ key, before, after, changed: before !== after });
  }
  for (const key of new Set(remove)) {
    if (hasOwn(cur, key) && !hasOwn(set, key)) {
      changes.push({ key, before: cur[key], after: undefined, removed: true, changed: true });
    }
  }
  return changes;
}

export function applyEnvChanges(settings, changes) {
  const next = JSON.parse(JSON.stringify(isPlainObject(settings) ? settings : {}));
  if (!isPlainObject(next.env)) next.env = {};
  for (const c of changes) {
    if (!c.changed) continue;
    if (c.after === undefined) delete next.env[c.key];
    else next.env[c.key] = c.after;
  }
  return next;
}

// Remember the value that existed before the first change, and a hash of what we wrote.
export function recordChanges(section, changes) {
  for (const c of changes) {
    if (!c.changed) continue;
    const rec = section[c.key];
    if (rec) rec.after = hashValue(c.after);
    else section[c.key] = { existed: c.before !== undefined, before: c.before === undefined ? null : c.before, after: hashValue(c.after) };
  }
}

// Undo only what still matches what we wrote; anything edited since is left alone.
export function planRestore(obj, recorded) {
  const cur = isPlainObject(obj) ? obj : {};
  const out = { changes: [], skipped: [] };
  for (const [key, rec] of Object.entries(recorded || {})) {
    const now = hasOwn(cur, key) ? cur[key] : undefined;
    if (hashValue(now) !== rec.after) {
      out.skipped.push(key);
      continue;
    }
    const after = rec.existed ? rec.before : undefined;
    out.changes.push({ key, before: now, after, changed: now !== after });
  }
  return out;
}

// Minimal, format-preserving edit of a VS Code settings file (JSON with comments).
export function planDisableLoginPrompt(raw) {
  if (raw === null || raw === undefined) return { action: 'create', text: `{\n  "${DLP_KEY}": true\n}\n` };
  const re = /("claudeCode\.disableLoginPrompt"\s*:\s*)(true|false)\b/;
  const m = re.exec(raw);
  if (m) return m[2] === 'true' ? { action: 'none' } : { action: 'flip', text: raw.replace(re, '$1true') };
  const open = firstSignificantBrace(raw);
  if (open < 0) return { action: 'manual' };
  const rest = raw.slice(open + 1);
  const empty = /^\s*}\s*$/.test(stripJsonComments(rest));
  const line = `\n  "${DLP_KEY}": true`;
  const text = empty ? `${raw.slice(0, open + 1)}${line}\n}\n` : `${raw.slice(0, open + 1)}${line},${rest}`;
  if (!jsoncValid(text)) return { action: 'manual' };
  return { action: empty ? 'fill' : 'insert', text, inserted: empty ? null : `${line},` };
}

// Reverse planDisableLoginPrompt; returns the new text, '' to delete the file, or null when nothing to do.
export function undoDisableLoginPrompt(raw, rec) {
  const onlyOurKey = () => {
    if (!jsoncValid(raw)) return false;
    const obj = JSON.parse(stripJsonComments(raw.replace(/^﻿/, '')).replace(/,(\s*[}\]])/g, '$1'));
    return Object.keys(obj).length === 1 && obj[DLP_KEY] === true;
  };
  const flipped = raw.replace(/("claudeCode\.disableLoginPrompt"\s*:\s*)true\b/, '$1false');
  let text = null;
  if (rec.action === 'create' && onlyOurKey()) text = '';
  else if (rec.action === 'fill' && onlyOurKey()) text = '{}\n';
  else if (rec.action === 'insert' && rec.inserted && raw.includes(rec.inserted)) text = raw.replace(rec.inserted, '');
  else if (flipped !== raw) text = flipped;
  return text === raw ? null : text;
}

function firstSignificantBrace(raw) {
  let i = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < raw.length) {
    const c = raw[i];
    if (/\s/.test(c)) i++;
    else if (raw.startsWith('//', i)) {
      const nl = raw.indexOf('\n', i);
      i = nl < 0 ? raw.length : nl + 1;
    } else if (raw.startsWith('/*', i)) {
      const end = raw.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 2;
    } else return c === '{' ? i : -1;
  }
  return -1;
}

export function stripJsonComments(s) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += s[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 1;
    } else out += c;
  }
  return out;
}

function jsoncValid(text) {
  try {
    const noComments = stripJsonComments(text.replace(/^\uFEFF/, ''));
    JSON.parse(noComments.replace(/,(\s*[}\]])/g, '$1'));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Files: read JSON, atomic write, backups, state

export function readJson(file) {
  if (!fs.existsSync(file)) return { file, exists: false, data: null };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { file, exists: true, data: null, error: e.message };
  }
  const bom = raw.charCodeAt(0) === 0xfeff;
  if (bom) raw = raw.slice(1);
  if (raw.trim() === '') return { file, exists: true, data: {}, raw, bom, empty: true };
  try {
    const data = JSON.parse(raw);
    if (!isPlainObject(data)) return { file, exists: true, data: null, raw, bom, error: 'not a JSON object' };
    return { file, exists: true, data, raw, bom };
  } catch (e) {
    return { file, exists: true, data: null, raw, bom, error: e.message, where: jsonErrorLocation(raw, e.message) };
  }
}

function jsonErrorLocation(raw, message) {
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) return { line: Number(lc[1]), col: Number(lc[2]) };
  const pos = /position (\d+)/.exec(message);
  if (!pos) return null;
  const before = raw.slice(0, Number(pos[1]));
  return { line: before.split('\n').length, col: Number(pos[1]) - before.lastIndexOf('\n') };
}

export function jsonHints(raw) {
  const hints = [];
  if (/[，：“”‘’]/.test(raw || '')) hints.push('fullwidth');
  if (/,\s*[}\]]/.test(raw || '')) hints.push('trailing_comma');
  if (/(^|[^:])\/\/|\/\*/.test(raw || '')) hints.push('comments');
  return hints;
}

function renameWithRetry(src, dst) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (e) {
      const retryable = process.platform === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code);
      if (!retryable || attempt >= 5) throw e;
      sleepSync(150 * (attempt + 1));
    }
  }
}

export function writeAtomic(file, content, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.evolink-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    renameWithRetry(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, mode);
    } catch {}
  }
}

const toJsonText = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

export function evolinkHome() {
  return process.env.EVOLINK_HOME ? path.resolve(process.env.EVOLINK_HOME) : path.join(os.homedir(), '.evolink');
}

function newBackupSession() {
  return { dir: path.join(evolinkHome(), 'backups', stamp()), files: [] };
}

function backupFile(session, file, label) {
  if (!isFile(file)) return null;
  fs.mkdirSync(session.dir, { recursive: true, mode: 0o700 });
  const name = label || path.basename(file);
  let dest = path.join(session.dir, name);
  for (let i = 1; fs.existsSync(dest); i++) dest = path.join(session.dir, `${i}-${name}`);
  fs.copyFileSync(file, dest);
  try {
    fs.chmodSync(dest, 0o600);
  } catch {}
  session.files.push({ source: file, backup: dest });
  return dest;
}

function pruneBackups(keep = 20) {
  const root = path.join(evolinkHome(), 'backups');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root).filter((n) => isDir(path.join(root, n))).sort();
  } catch {
    return;
  }
  for (const d of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    try {
      fs.rmSync(path.join(root, d), { recursive: true, force: true });
    } catch {}
  }
}

function statePath() {
  return path.join(evolinkHome(), 'state.json');
}
function loadState() {
  const r = readJson(statePath());
  return r.data && r.data.version === 1 ? r.data : { version: 1 };
}
function saveState(state) {
  fs.mkdirSync(evolinkHome(), { recursive: true, mode: 0o700 });
  writeAtomic(statePath(), toJsonText(state));
}

export function claudePaths() {
  const home = os.homedir();
  const custom = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : null;
  const configDir = custom || path.join(home, '.claude');
  return {
    configDir,
    settings: path.join(configDir, 'settings.json'),
    globalConfig: custom ? path.join(custom, '.claude.json') : path.join(home, '.claude.json'),
  };
}

// ---------------------------------------------------------------------------
// Processes and detection

function quoteWin(a) {
  const s = String(a);
  return /[\s"&|<>^()%!]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function run(cmd, args = [], { timeout = 20000, env } = {}) {
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const r = spawnSync(shell ? quoteWin(cmd) : cmd, shell ? args.map(quoteWin) : args, {
    encoding: 'utf8',
    timeout,
    env: env || process.env,
    shell,
    windowsHide: true,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

function runInherit(cmd, args, { toStderr = false } = {}) {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    const stdio = toStderr ? ['ignore', process.stderr, process.stderr] : 'inherit';
    const child = spawn(shell ? quoteWin(cmd) : cmd, shell ? args.map(quoteWin) : args, { stdio, shell });
    child.on('error', (error) => resolve({ code: -1, error }));
    child.on('close', (code) => resolve({ code }));
  });
}

function which(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];
  const out = [];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, name + e);
      if (!out.includes(p) && isFile(p)) out.push(p);
    }
  }
  return out;
}

export function detectClaude() {
  const onPath = which('claude');
  const native = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  const all = [...onPath];
  if (isFile(native) && !all.includes(native)) all.push(native);
  if (!all.length) return { installed: false };
  const runnable = all.find((p) => !/\.ps1$/i.test(p));
  let version = null;
  if (runnable) {
    const r = run(runnable, ['--version'], { timeout: 30000, env: { ...process.env, DISABLE_AUTOUPDATER: '1' } });
    const m = /(\d+\.\d+\.\d+)/.exec(`${r.stdout}\n${r.stderr}`);
    version = m ? m[1] : null;
  }
  return {
    installed: true,
    path: runnable || all[0],
    version,
    onPath: onPath.length > 0,
    npmShim: all.some((p) => /\.ps1$/i.test(p)),
  };
}

function windowsExecutionPolicy() {
  if (process.platform !== 'win32') return null;
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'], { timeout: 20000 });
  return r.stdout.trim() || null;
}

function claudeRunning() {
  try {
    if (process.platform === 'win32') return /claude\.exe/i.test(run('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/NH']).stdout);
    return run('pgrep', ['-x', 'claude']).code === 0;
  } catch {
    return false;
  }
}

// HOME points away from the account's own home folder: a throwaway test home. Running Claude Code
// processes and a plain `claude` in a new terminal both use the real home, not this one.
export function sandboxHome() {
  if (process.platform === 'win32') return null;
  let real;
  try {
    real = os.userInfo().homedir;
  } catch {
    return null;
  }
  const home = os.homedir();
  return real && realpathOr(home) !== realpathOr(real) ? { home, real } : null;
}

// Signed in with /login (Claude subscription or Console). macOS keeps the token in the Keychain,
// Linux and Windows in .credentials.json; oauthAccount in ~/.claude.json exists on all three.
export function officialAccount(globalData, configDir) {
  const acct = isPlainObject(globalData?.oauthAccount) ? globalData.oauthAccount : null;
  if (!acct && !isFile(path.join(configDir, '.credentials.json'))) return null;
  return { email: typeof acct?.emailAddress === 'string' ? acct.emailAddress : null };
}

// Settings that already take precedence over a /login account.
export function overridesLogin(settings) {
  const env = isPlainObject(settings?.env) ? settings.env : {};
  return !!(env.ANTHROPIC_BASE_URL || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || settings?.apiKeyHelper);
}

function osLabel() {
  const arch = process.arch;
  if (process.platform === 'darwin') {
    const v = run('sw_vers', ['-productVersion'], { timeout: 5000 }).stdout.trim();
    return `macOS ${v || os.release()} ${arch}`;
  }
  if (process.platform === 'win32') return `Windows ${os.release()} ${arch}`;
  try {
    const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(fs.readFileSync('/etc/os-release', 'utf8'));
    if (m) return `${m[1]} ${arch}`;
  } catch {}
  return `${process.platform} ${arch}`;
}

const EDITORS = [
  { name: 'VS Code', ext: '.vscode', app: 'Code' },
  { name: 'VS Code Insiders', ext: '.vscode-insiders', app: 'Code - Insiders' },
  { name: 'Cursor', ext: '.cursor', app: 'Cursor' },
  { name: 'Windsurf', ext: '.windsurf', app: 'Windsurf' },
  { name: 'Trae', ext: '.trae', app: 'Trae' },
  { name: 'Trae CN', ext: '.trae-cn', app: 'Trae CN' },
  { name: 'VSCodium', ext: '.vscode-oss', app: 'VSCodium' },
];

function editorSettingsPath(app) {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', app, 'User', 'settings.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), app, 'User', 'settings.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), app, 'User', 'settings.json');
}

// Editors that have the Claude Code extension installed and have been opened at least once.
export function detectEditors() {
  const out = [];
  for (const ed of EDITORS) {
    let has = false;
    try {
      has = fs.readdirSync(path.join(os.homedir(), ed.ext, 'extensions')).some((n) => /^anthropic\.claude-code-/i.test(n));
    } catch {}
    if (!has) continue;
    const settings = editorSettingsPath(ed.app);
    if (isDir(path.dirname(settings))) out.push({ name: ed.name, settings });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conflict scanning

export function scanShellText(text, file) {
  const hits = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      const m =
        /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t) ||
        /^set\s+(?:-[A-Za-z]+\s+)*([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/.exec(t) ||
        /^\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/i.exec(t) ||
        /^\[(?:System\.)?Environment\]::SetEnvironmentVariable\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*,\s*(.*)$/i.exec(t);
      if (!m) return;
      const name = m[1].toUpperCase();
      if (!WATCH_VARS.includes(name)) return;
      const value = m[2].replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*?)\1.*$/, '$2');
      hits.push({ source: 'file', where: `${tildify(file)}:${i + 1}`, name, value });
    });
  return hits;
}

export function parseRegQuery(text, label) {
  const hits = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].toUpperCase();
    if (WATCH_VARS.includes(name)) hits.push({ source: 'registry', where: label, name, value: m[2].trim() });
  }
  return hits;
}

function shellProfileFiles() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const docs = path.join(home, 'Documents');
    return [
      path.join(docs, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
      path.join(docs, 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    ];
  }
  return ['.zshrc', '.zprofile', '.zshenv', '.zlogin', '.bashrc', '.bash_profile', '.bash_login', '.profile', path.join('.config', 'fish', 'config.fish')].map((f) =>
    path.join(home, f),
  );
}

function managedSettingsFiles() {
  if (process.platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  if (process.platform === 'win32') return ['C:\\Program Files\\ClaudeCode\\managed-settings.json', 'C:\\ProgramData\\ClaudeCode\\managed-settings.json'];
  return ['/etc/claude-code/managed-settings.json'];
}

function envHitsFromSettings(file, source) {
  const r = readJson(file);
  if (!r.data || !isPlainObject(r.data.env)) return [];
  return Object.entries(r.data.env)
    .filter(([k]) => WATCH_VARS.includes(k))
    .map(([name, value]) => ({ source, where: tildify(file), name, value: String(value) }));
}

// Everything outside the user settings file that can change which endpoint, key or model Claude Code uses.
export function scanConflicts({ cwd = process.cwd() } = {}) {
  const hits = [];
  for (const name of WATCH_VARS) {
    if (process.env[name] !== undefined) hits.push({ source: 'env', where: L('当前终端环境变量', 'current shell environment'), name, value: process.env[name] });
  }
  for (const f of shellProfileFiles()) {
    if (isFile(f)) {
      try {
        hits.push(...scanShellText(fs.readFileSync(f, 'utf8'), f));
      } catch {}
    }
  }
  if (process.platform === 'win32') {
    const hives = [
      ['HKCU\\Environment', L('Windows 用户环境变量', 'Windows user environment')],
      ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', L('Windows 系统环境变量', 'Windows system environment')],
    ];
    for (const [hive, label] of hives) {
      const r = run('reg', ['query', hive], { timeout: 15000 });
      if (r.code === 0) hits.push(...parseRegQuery(r.stdout, label));
    }
  }
  for (const f of managedSettingsFiles()) if (isFile(f)) hits.push(...envHitsFromSettings(f, 'managed'));
  // Run from the home folder, <cwd>/.claude is the user config itself, not a project override.
  const userSettings = realpathOr(claudePaths().settings);
  for (const f of ['settings.json', 'settings.local.json']) {
    const p = path.join(cwd, '.claude', f);
    if (isFile(p) && realpathOr(p) !== userSettings && realpathOr(cwd) !== realpathOr(os.homedir())) hits.push(...envHitsFromSettings(p, 'project'));
  }
  return hits;
}

function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// error: EvoLink will not be used / requests fail. warn: works, but not everywhere. info: overridden by our settings.
export function classifyConflict(hit, ids) {
  if (PROVIDER_VARS.includes(hit.name)) return truthy(hit.value) ? 'error' : null;
  if (hit.source === 'managed') return 'error';
  if (hit.source === 'project') return 'warn';
  if (MODEL_OVERRIDE_VARS.includes(hit.name) && ids && ids.size && !modelAvailable(hit.value, ids)) return 'error';
  return 'info';
}

function conflictText(hit, level) {
  const where = `${hit.where} · ${hit.name}=${displayValue(hit.name, hit.value)}`;
  if (PROVIDER_VARS.includes(hit.name)) {
    return hit.source === 'managed' || hit.source === 'project'
      ? `${where}  ${L('会让 Claude Code 改走 Bedrock / Vertex / Foundry，EvoLink 不生效', 'routes Claude Code to Bedrock / Vertex / Foundry; EvoLink will not be used')}`
      : `${where}  ${L('会让 Claude Code 改走其他云，已在 settings.json 里置空压住；建议删掉原处', 'would route Claude Code elsewhere; neutralised in settings.json, but remove it at the source')}`;
  }
  if (hit.source === 'managed') return `${where}  ${L('企业托管配置优先级最高，会覆盖你的设置；请联系管理员', 'managed settings override yours; ask your administrator')}`;
  if (hit.source === 'project') return `${where}  ${L('只在这个项目里生效，会覆盖你的用户配置', 'applies in this project and overrides your user settings')}`;
  if (level === 'error') return `${where}  ${L('这把 Key 用不了这个模型，已在 settings.json 里置空压住；建议删掉原处', 'this key cannot use that model; neutralised in settings.json, but remove it at the source')}`;
  if (hit.name === 'ANTHROPIC_API_KEY') return `${where}  ${L('旧 Key，已在 settings.json 里置空压住；建议删掉原处', 'old key; neutralised in settings.json, but remove it at the source')}`;
  return `${where}  ${L('会被 settings.json 覆盖，对 Claude Code 无影响；OpenCode 等其他工具可能受影响，建议删掉', 'overridden by settings.json for Claude Code; other tools such as OpenCode may still pick it up')}`;
}

// ---------------------------------------------------------------------------
// EvoLink API

async function http(method, url, { key, body, timeout = 15000, headers = {} } = {}) {
  const h = { 'user-agent': `evolink-cli/${VERSION}`, ...headers };
  if (key) h.authorization = `Bearer ${key}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      redirect: 'manual',
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json, text, ms: Date.now() - started };
  } catch (error) {
    return { status: 0, ok: false, error, ms: Date.now() - started };
  }
}

// fetch() wraps the real socket error (sometimes an AggregateError) in `cause`.
function networkErrorCode(e) {
  const queue = [e];
  const seen = new Set();
  while (queue.length) {
    const x = queue.shift();
    if (!x || typeof x !== 'object' || seen.has(x)) continue;
    seen.add(x);
    if (x.name === 'TimeoutError' || x.name === 'AbortError') return x.name;
    if (typeof x.code === 'string' && x.code) return x.code;
    const m = /\b(E[A-Z]{3,}|UND_ERR_[A-Z_]+)\b/.exec(String(x.message || ''));
    if (m) return m[1];
    if (x.cause) queue.push(x.cause);
    if (Array.isArray(x.errors)) queue.push(...x.errors);
  }
  return String(e?.cause?.message || e?.message || e || 'unknown');
}

export function describeFailure(r) {
  if (!r.status) {
    const code = networkErrorCode(r.error);
    if (/Timeout|Abort|TIMEDOUT/i.test(code)) return { kind: 'timeout', code };
    if (/ENOTFOUND|EAI_AGAIN/.test(code)) return { kind: 'dns', code };
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS|EPROTO/i.test(code)) return { kind: 'tls', code };
    if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET/.test(code)) return { kind: 'connect', code };
    return { kind: 'network', code };
  }
  const raw = r.json?.error?.message || r.json?.message || (r.text || '').slice(0, 300);
  const message = String(raw).replace(/\s*\(request id: [^)]*\)/i, '').trim();
  if (r.status === 401) {
    if (/expired/i.test(message)) return { kind: 'expired', status: 401, message };
    if (/disabled/i.test(message)) return { kind: 'disabled', status: 401, message };
    return { kind: 'auth', status: 401, message };
  }
  if (r.status === 402 || /insufficient|余额不足|预扣|pre-?consume|quota/i.test(message)) return { kind: 'balance', status: r.status, message };
  if (r.status === 403) return { kind: 'forbidden', status: 403, message };
  if (r.status === 404) return { kind: /model/i.test(message) ? 'model' : 'not_found', status: 404, message };
  if (r.status === 429) return { kind: 'rate', status: 429, message };
  if (r.status >= 500) return { kind: 'server', status: r.status, message };
  return { kind: 'http', status: r.status, message };
}

function failureLines(f, base) {
  const host = (() => {
    try {
      return new URL(base).host;
    } catch {
      return base;
    }
  })();
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  const proxyHint = proxy
    ? [L(`检测到代理设置（${proxy}）。本工具的联网检查不走代理；可以加 --skip-checks 跳过检查直接写配置。`, `A proxy is set (${proxy}); this tool's checks do not use it. Add --skip-checks to write the config without online checks.`)]
    : [];
  switch (f.kind) {
    case 'auth':
      return [L(`Key 无效（${f.message}）。请到控制台重新复制完整的 Key：${DASHBOARD_KEYS_URL}`, `Invalid key (${f.message}). Copy the full key again from ${DASHBOARD_KEYS_URL}`)];
    case 'expired':
      return [L('这把 Key 已过期，请到控制台延长有效期或新建一把。', 'This key has expired; extend it or create a new one in the dashboard.')];
    case 'disabled':
      return [L('这把 Key 已被禁用，请到控制台启用或新建一把。', 'This key is disabled; enable it or create a new one in the dashboard.')];
    case 'forbidden':
      return [L(`访问被拒绝（403：${f.message}）。`, `Access denied (403: ${f.message}).`)];
    case 'balance':
      return [
        L(`余额或 Key 额度不足（${f.message}）。`, `Not enough credits or key quota (${f.message}).`),
        L('请求会先按输出上限预留额度，余额低于预留就会被拦截；充值或调高 Key 的额度上限后再试。', 'Each request first holds credits based on its output limit; top up or raise the key limit.'),
      ];
    case 'model':
      return [L(`模型不可用（${f.message}）。`, `Model not available (${f.message}).`)];
    case 'rate':
      return [L('请求太频繁（429），稍后再试。', 'Rate limited (429); try again shortly.')];
    case 'server':
      return [L(`服务端暂时出错（${f.status}），稍后再试。`, `Server error (${f.status}); try again shortly.`)];
    case 'timeout':
      return [L(`连接 ${host} 超时。请检查网络；公司网络或代理软件可能拦截了请求。`, `Timed out connecting to ${host}. Check your network, proxy or firewall.`), ...proxyHint];
    case 'dns':
      return [L(`找不到 ${host}（DNS 解析失败），请检查网络。`, `Cannot resolve ${host} (DNS). Check your network.`), ...proxyHint];
    case 'tls':
      return [L(`HTTPS 证书校验失败（${f.code}），通常是代理或安全软件在拦截 HTTPS。`, `TLS verification failed (${f.code}); a proxy or security software may be intercepting HTTPS.`), ...proxyHint];
    case 'connect':
      return [L(`连不上 ${host}（${f.code}），请检查网络、防火墙或代理。`, `Cannot connect to ${host} (${f.code}); check network, firewall or proxy.`), ...proxyHint];
    case 'network':
      return [L(`网络错误（${f.code}）。`, `Network error (${f.code}).`), ...proxyHint];
    default:
      return [L(`请求失败（HTTP ${f.status}：${f.message}）`, `Request failed (HTTP ${f.status}: ${f.message})`)];
  }
}

function exitCodeFor(f) {
  return ['timeout', 'dns', 'tls', 'connect', 'network'].includes(f.kind) ? EXIT.NETWORK : EXIT.AUTH;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

async function checkKey(base, key) {
  const models = await http('GET', `${base}/v1/models`, { key });
  if (!models.ok) return { ok: false, failure: describeFailure(models), ms: models.ms };
  const list = Array.isArray(models.json?.data) ? models.json.data : [];
  const ids = new Set(list.map((m) => m && m.id).filter(Boolean));
  const credits = await http('GET', `${base}/v1/credits`, { key });
  let balance = null;
  if (credits.ok && credits.json && credits.json.success !== false && isPlainObject(credits.json.data)) {
    const d = credits.json.data;
    balance = { user: num(d.user?.remaining_credits), token: num(d.token?.remaining_credits), unlimited: d.token?.unlimited_credits === true };
  }
  return { ok: true, ids, count: ids.size, claudeCount: [...ids].filter((i) => i.startsWith('claude-')).length, balance, ms: models.ms };
}

async function testMessage(base, key, model) {
  const r = await http('POST', `${base}/v1/messages`, {
    key,
    timeout: 90000,
    headers: { 'anthropic-version': '2023-06-01' },
    body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
  });
  return r.ok ? { ok: true, model, ms: r.ms } : { ok: false, model, failure: describeFailure(r), ms: r.ms };
}

function printBalance(balance) {
  if (!balance) return;
  if (balance.user !== null) {
    const low = balance.user < LOW_BALANCE_CREDITS;
    (low ? ui.warn : ui.ok).call(ui, L(`账户余额 ${fmtCredits(balance.user)} Credits`, `Account balance ${fmtCredits(balance.user)} credits`));
  }
  if (!balance.unlimited && balance.token !== null) {
    const low = balance.token < LOW_BALANCE_CREDITS;
    (low ? ui.warn : ui.info).call(ui, L(`这把 Key 设了额度上限，还剩 ${fmtCredits(balance.token)} Credits`, `This key has a quota; ${fmtCredits(balance.token)} credits left`));
  }
  const lowest = Math.min(balance.user ?? Infinity, balance.unlimited ? Infinity : balance.token ?? Infinity);
  if (lowest < LOW_BALANCE_CREDITS) {
    ui.sub(
      ui.dim(
        L(
          '余额偏低：Opus 等高价模型每次请求会先按输出上限预留额度，不够就会报"余额不足"。本工具会把输出上限设为 32000，单次预留约降到原来的四分之一。',
          'Low balance: pricey models such as Opus hold credits per request based on the output limit and fail with "insufficient credits" when the hold does not fit. This tool caps output at 32000, cutting the hold to about a quarter.',
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Prompts (TTY with hidden input; line-based when stdin is piped)

let lineQueue = null;
function nextStdinLine() {
  if (!lineQueue) {
    lineQueue = { lines: [], waiters: [], ended: false };
    lineQueue.rl = readline.createInterface({ input: process.stdin });
    lineQueue.rl.on('line', (l) => {
      const w = lineQueue.waiters.shift();
      if (w) w(l);
      else lineQueue.lines.push(l);
    });
    lineQueue.rl.on('close', () => {
      lineQueue.ended = true;
      for (const w of lineQueue.waiters.splice(0)) w(null);
    });
  }
  if (lineQueue.lines.length) return Promise.resolve(lineQueue.lines.shift());
  if (lineQueue.ended) return Promise.resolve(null);
  return new Promise((resolve) => lineQueue.waiters.push(resolve));
}
function closeStdin() {
  if (lineQueue?.rl) lineQueue.rl.close();
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  } catch {}
  process.stdin.pause();
}

async function askLine(question) {
  if (!process.stdin.isTTY) {
    process.stdout.write(question);
    const l = await nextStdinLine();
    process.stdout.write('\n');
    if (l === null) throw new CancelledError();
    return l;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve, reject) => {
      rl.on('SIGINT', () => reject(new CancelledError()));
      rl.question(question, resolve);
    });
  } finally {
    rl.close();
  }
}

async function confirm(question, def = true) {
  for (;;) {
    const a = (await askLine(`  ${question} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    if (!a) return def;
    if (/^(y|yes|是|好|对|嗯)$/.test(a)) return true;
    if (/^(n|no|否|不|不要)$/.test(a)) return false;
  }
}

async function choose(question, options, defIndex = 0) {
  ui.print(`  ${question}`);
  options.forEach((o, i) => ui.print(`    ${i + 1}) ${o.label}${o.note ? `  ${ui.dim(o.note)}` : ''}`));
  for (;;) {
    const a = (await askLine(L(`  输入序号 [${defIndex + 1}]：`, `  Choose [${defIndex + 1}]: `))).trim();
    if (!a) return defIndex;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
  }
}

async function askSecret(question) {
  if (!process.stdin.isTTY) return askLine(question);
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let buf = '';
    let esc = false;
    // Raw mode before the prompt: a key pasted the instant the prompt appears must not be echoed.
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    process.stdout.write(question);
    const done = (err) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(buf);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (esc) {
          if (/[A-Za-z~]/.test(ch)) esc = false;
          continue;
        }
        if (ch === '\u001b') esc = true;
        else if (ch === '\r' || ch === '\n' || ch === '\u0004') return done();
        else if (ch === '\u0003') return done(new CancelledError());
        else if (ch === '\u007f' || ch === '\b') {
          if (buf.length) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (ch >= ' ') {
          buf += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------------------
// Command hint shown in "next steps" (how the user can run doctor / reset later)

// In a test home the hint follows HOME="…" on the same line, where ~ still means the real home: spell paths out.
function commandHint(sandbox) {
  const untilde = (s) => (sandbox && /^~(?=\/|$)/.test(s) ? os.homedir() + s.slice(1) : s);
  if (process.env.EVOLINK_CMD) return untilde(process.env.EVOLINK_CMD);
  const self = process.argv[1] || '';
  if (/[\\/]_npx[\\/]/.test(self)) return 'npx -y @evolinkai/cli';
  if (which('evolink').length) return 'evolink';
  // Started through the launcher that setup.sh installed: point at the launcher, not the file behind it.
  const launcher = path.join(evolinkHome(), 'bin', 'evolink');
  if (process.platform !== 'win32' && realpathOr(self) === realpathOr(path.join(evolinkHome(), 'cli', 'evolink.mjs')) && isFile(launcher)) {
    return sandbox ? launcher : tildify(launcher);
  }
  return `node ${quoteWin(sandbox ? self : tildify(self))}`;
}

// ---------------------------------------------------------------------------
// setup

async function cmdSetup(opts) {
  const interactive = !opts.yes && !opts.json;
  if (opts.json && !opts.yes) throw new CliError(L('--json 需要和 --yes 一起用（不能交互）。', '--json requires --yes (no prompts).'), EXIT.USAGE);
  const target = opts._[1] || 'claude-code';
  if (!['claude-code', 'claude'].includes(target)) {
    throw new CliError(L(`暂不支持 ${target}，目前只支持 claude-code。`, `${target} is not supported yet; only claude-code is.`), EXIT.USAGE);
  }
  const result = { command: 'setup', version: VERSION, ok: false, warnings: [] };
  const baseNorm = normalizeBaseUrl(opts.baseUrl || process.env.EVOLINK_BASE_URL || DEFAULT_BASE_URL);
  if (baseNorm.error) throw new CliError(L('接口地址格式不对，应类似 https://direct.evolink.ai', 'Invalid base URL; expected something like https://direct.evolink.ai'), EXIT.USAGE);
  const base = baseNorm.url;

  ui.title(L(`EvoLink 一键配置 · Claude Code  v${VERSION}`, `EvoLink setup · Claude Code  v${VERSION}`));
  ui.print(ui.dim(L('只改 Claude Code 的配置，改之前自动备份，随时可以撤销。', 'Only Claude Code settings are changed. Everything is backed up first and can be undone.')));
  const sandbox = sandboxHome();
  if (sandbox) {
    ui.info(
      L(
        `测试模式：HOME 是 ${sandbox.home}，只改这里面的配置，你真实的家目录 ${sandbox.real} 不受影响（自动安装 Claude Code 除外，可加 --no-install）。`,
        `Test mode: HOME is ${sandbox.home}; only settings under it change and your real home ${sandbox.real} is left alone (except installing Claude Code; add --no-install).`,
      ),
    );
  }
  if (baseNorm.strippedV1) ui.warn(L(`地址末尾的 /v1 已去掉（Claude Code 会自己拼接）：${base}`, `Removed the trailing /v1 (Claude Code appends it itself): ${base}`));

  // [1/5] environment
  ui.step(1, 5, L('检查环境', 'Environment'));
  ui.ok(`${osLabel()} · Node ${process.versions.node}`);
  let claude = detectClaude();
  if (claude.installed) {
    ui.ok(`Claude Code ${claude.version || '?'}  ${ui.dim(tildify(claude.path))}`);
    if (!claude.onPath) ui.warn(L('claude 不在 PATH 里：新开终端可能找不到命令，请把它所在的文件夹加入 PATH。', 'claude is not on PATH; add its folder to PATH so new terminals can find it.'));
  } else {
    ui.warn(L('没有找到 Claude Code。', 'Claude Code is not installed.'));
    claude = await maybeInstallClaude(opts, interactive);
  }
  result.claudeCode = { installed: claude.installed, version: claude.version || null, path: claude.path || null };
  if (claude.installed && claude.version && !opts.skipChecks) {
    const latest = await latestClaudeVersion(opts);
    if (latest && compareVersions(claude.version, latest) < 0) {
      ui.warn(updateHint(claude.version, latest));
      result.claudeCode.latest = latest;
    }
  }

  // [2/5] key
  ui.step(2, 5, L('API Key', 'API key'));
  const paths = claudePaths();
  let settingsRead = readJson(paths.settings);
  const existingKey = existingEvolinkKey(settingsRead.data);
  const { key, check } = await obtainAndCheckKey(opts, interactive, base, existingKey);
  result.key = maskKey(key);
  const ids = check?.ids || new Set();
  if (check) result.api = { models: check.count, claudeModels: check.claudeCount, balance: check.balance };

  // [3/5] model
  ui.step(3, 5, L('模型', 'Model'));
  const conflicts = scanConflicts();
  const shellModel = conflicts.find((h) => h.name === 'ANTHROPIC_MODEL' && ['env', 'file', 'registry'].includes(h.source));
  const decision = await decideModel(opts, interactive, settingsRead.data, ids, shellModel);
  result.model = decision.action === 'set' ? decision.model : decision.action;

  // [4/5] plan
  ui.step(4, 5, L('确认改动', 'Review changes'));
  if (settingsRead.exists && !settingsRead.data) settingsRead = await handleInvalidSettings(settingsRead, opts, interactive);
  const trustDirs = await decideTrust(opts, interactive, paths);
  const editors = opts.vscode === false ? [] : detectEditors();
  const plan = buildPlan({ opts, base, key, ids, decision, conflicts, settingsRead, paths, trustDirs, editors });
  printConflicts(conflicts, ids);
  printPlan(plan);
  // Our token outranks a /login account, so writing silently takes over every Claude Code on the machine.
  const official = overridesLogin(settingsRead.data) ? null : officialAccount(readJson(paths.globalConfig).data, paths.configDir);
  if (official) {
    printOfficialWarning(official, sandbox);
    result.officialLogin = true;
    result.warnings.push(L('这台电脑登录了 Anthropic 官方账号，写入后 Claude Code 改走 EvoLink', 'Signed in to an Anthropic account; Claude Code switches to EvoLink'));
  }
  if (editors.length && plan.vscode.length && interactive) {
    const names = [...new Set(editors.map((e) => e.name))].join(' / ');
    ui.print('');
    const yes = await confirm(
      L(
        `检测到 ${names} 装了 Claude Code 扩展。要打开扩展的"跳过登录提示"吗？不打开的话，扩展会一直要求登录 Anthropic 账号。`,
        `The Claude Code extension is installed in ${names}. Turn on "Disable Login Prompt"? Otherwise the extension keeps asking for an Anthropic login.`,
      ),
      true,
    );
    if (!yes) plan.vscode = [];
  }
  const pending = countChanges(plan);
  result.changes = summarizePlan(plan);
  if (opts.dryRun) {
    ui.print('');
    ui.info(L('这是预览（--dry-run），没有写入任何文件。', 'Preview only (--dry-run); nothing was written.'));
    result.ok = true;
    result.dryRun = true;
    return finish(result, opts);
  }
  if (pending === 0) ui.ok(L('配置已经是最新的，不需要改动。', 'Already up to date; nothing to change.'));
  else {
    // Running sessions reload settings.json; in a test home they belong to the real home and are unaffected.
    if (!sandbox && claudeRunning()) {
      ui.print('');
      ui.warn(
        L(
          'Claude Code 正在运行：已经打开的会话会立刻用上新配置；它退出时还可能覆盖 ~/.claude.json 的改动。建议先退出所有 Claude Code 再继续。',
          'Claude Code is running: open sessions pick up the new settings right away, and it may overwrite ~/.claude.json when it exits. Quit Claude Code first for best results.',
        ),
      );
    }
    if (interactive && !(await confirm(L('确认写入？', 'Apply these changes?'), !official))) throw new CancelledError();
  }

  // [5/5] apply and verify
  ui.step(5, 5, L('写入并验证', 'Apply and verify'));
  if (pending > 0) {
    const applied = applyPlan(plan);
    for (const w of applied.warnings) ui.warn(w);
    if (applied.backupDir) ui.ok(L(`已备份原文件到 ${tildify(applied.backupDir)}`, `Backed up originals to ${tildify(applied.backupDir)}`));
    for (const f of applied.written) ui.ok(L(`已写入 ${tildify(f)}`, `Wrote ${tildify(f)}`));
    result.backupDir = applied.backupDir;
    result.written = applied.written;
    result.warnings.push(...applied.warnings);
  }
  if (process.platform === 'win32' && claude.installed && claude.npmShim) await fixExecutionPolicy(interactive);
  if (!opts.skipChecks && opts.test !== false && ids.size) {
    const model = pickTestModel(decision.action === 'set' ? decision.model : null, ids);
    let go = !!model;
    if (go && interactive) {
      go = await confirm(L(`发一条测试消息确认能用吗？（模型 ${model}，只要 1 个 token，费用约 0.01 Credits）`, `Send a 1-token test request with ${model}? (about 0.01 credits)`), true);
    }
    if (go) {
      const t = await testMessage(base, key, model);
      result.test = t.ok ? { ok: true, model, ms: t.ms } : { ok: false, model, error: t.failure };
      if (t.ok) ui.ok(L(`测试通过：${model} 正常返回（${t.ms} ms）`, `Test passed: ${model} answered (${t.ms} ms)`));
      else for (const line of failureLines(t.failure, base)) ui.err(line);
    }
  }
  result.ok = !result.test || result.test.ok;
  printNextSteps({ plan, claude, editors: plan.vscode.length ? editors : [], trusted: trustDirs.length > 0, sandbox });
  return finish(result, opts, result.ok ? EXIT.OK : EXIT.AUTH);
}

function printOfficialWarning(official, sandbox) {
  const cmd = sandboxPrefix(sandbox) + commandHint(sandbox);
  ui.print('');
  ui.warn(
    L(
      `这台电脑的 Claude Code 登录了 Anthropic 官方账号${official.email ? `（${official.email}）` : ''}。写入后：`,
      `Claude Code here is signed in to an Anthropic account${official.email ? ` (${official.email})` : ''}. Once written:`,
    ),
  );
  ui.sub(L('· 所有 Claude Code 都改走 EvoLink，包括 VS Code 等编辑器里已经打开的会话，立刻生效', '· every Claude Code switches to EvoLink, including sessions already open in VS Code and other editors, right away'));
  ui.sub(L('· 官方账号不会退出，只是暂时不用；claude.ai 连接器也会停用', '· you stay signed in, but the account is not used; claude.ai connectors are turned off'));
  ui.sub(L(`· 想切回官方账号：${cmd} reset`, `· to switch back: ${cmd} reset`));
}

// In a test home, commands shown to the user must carry the same HOME, or they act on the real one.
function sandboxPrefix(sandbox) {
  return sandbox ? `HOME=${JSON.stringify(sandbox.home)} ` : '';
}

function existingEvolinkKey(settings) {
  const env = isPlainObject(settings?.env) ? settings.env : {};
  return env.ANTHROPIC_AUTH_TOKEN && isEvolinkUrl(env.ANTHROPIC_BASE_URL) ? String(env.ANTHROPIC_AUTH_TOKEN) : null;
}

async function maybeInstallClaude(opts, interactive) {
  const guide = () => {
    ui.sub(L('可以任选一种方式安装 Claude Code：', 'Install Claude Code in one of these ways:'));
    ui.sub(L('· 中国大陆：先装 Node.js 22（https://npmmirror.com/mirrors/node/），再运行', '· Mainland China: install Node.js 22 (https://npmmirror.com/mirrors/node/), then run'));
    ui.sub(`  npm install -g ${CLAUDE_PKG} --registry=${REGISTRIES.npmmirror}`);
    ui.sub(L('· 海外网络：macOS / Linux 运行 curl -fsSL https://claude.ai/install.sh | bash', '· Outside China: on macOS / Linux run curl -fsSL https://claude.ai/install.sh | bash'));
    ui.sub(L('            Windows PowerShell 运行 irm https://claude.ai/install.ps1 | iex', '            on Windows PowerShell run irm https://claude.ai/install.ps1 | iex'));
    ui.sub(L('配置可以先写好，装好 Claude Code 后直接生效。', 'The configuration can be written now and takes effect once Claude Code is installed.'));
  };
  if (opts.install === false) {
    ui.info(L('按 --no-install 跳过安装；配置照常写入。', 'Skipping install (--no-install); the configuration is still written.'));
    return { installed: false };
  }
  const npm = which('npm').find((p) => !/\.ps1$/i.test(p));
  if (!npm) {
    guide();
    if (interactive && !(await confirm(L('先不装，继续写配置？', 'Continue without installing?'), true))) throw new CancelledError();
    return { installed: false };
  }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22) {
    ui.warn(L(`当前 Node.js ${process.versions.node}，Claude Code 要求 22 或更高（旧版本通常也能装上，但会有警告）。`, `Node.js ${process.versions.node} is older than the 22 Claude Code asks for; install usually works with a warning.`));
  }
  const reg = await pickRegistry(opts);
  if (!reg) {
    ui.err(L('npm 官方源和 npmmirror 都连不上。', 'Neither npmjs nor npmmirror is reachable.'));
    guide();
    return { installed: false };
  }
  const args = ['install', '-g', CLAUDE_PKG, `--registry=${reg.url}`];
  ui.info(L(`将从 ${reg.name} 安装 Claude Code${reg.version ? ` ${reg.version}` : ''}：`, `Installing Claude Code${reg.version ? ` ${reg.version}` : ''} from ${reg.name}:`));
  ui.sub(`npm ${args.join(' ')}`);
  if (interactive && !(await confirm(L('现在安装？', 'Install now?'), true))) {
    ui.info(L('先不安装，继续写配置。', 'Not installing; continuing with the configuration.'));
    return { installed: false };
  }
  const r = await runInherit(npm, args, { toStderr: opts.json });
  if (r.code !== 0) {
    ui.err(L('安装失败。', 'Install failed.'));
    if (process.platform !== 'win32') {
      ui.sub(L('如果看到 EACCES（没有权限）：不要加 sudo，改用官方安装脚本，或把 npm 全局目录设到自己家目录：', 'If you saw EACCES: do not use sudo; use the official installer, or point npm globals at your home folder:'));
      ui.sub('npm config set prefix ~/.npm-global  &&  export PATH="$HOME/.npm-global/bin:$PATH"');
    }
    guide();
    return { installed: false };
  }
  const c = detectClaude();
  if (c.installed) ui.ok(L(`Claude Code ${c.version || ''} 安装完成`, `Claude Code ${c.version || ''} installed`));
  else {
    const prefix = run(npm, ['prefix', '-g']).stdout.trim();
    ui.warn(L('已经装好，但当前终端还找不到 claude 命令。请打开新终端再试。', 'Installed, but this terminal cannot find claude yet. Open a new terminal.'));
    if (prefix) ui.sub(L(`npm 全局目录：${prefix}（需要在 PATH 里）`, `npm global folder: ${prefix} (must be on PATH)`));
  }
  return c.installed ? c : { installed: false };
}

async function pickRegistry(opts) {
  if (opts.registry) return { name: opts.registry, url: opts.registry.replace(/\/+$/, '') };
  const probe = async (name, url) => {
    const r = await http('GET', `${url}/${CLAUDE_PKG}/latest`, { timeout: 8000 });
    return { name, url, ok: r.ok, ms: r.ms, version: r.json?.version };
  };
  const [a, b] = await Promise.all([probe('npmjs', REGISTRIES.npmjs), probe('npmmirror', REGISTRIES.npmmirror)]);
  if (a.ok && (!b.ok || a.ms <= b.ms * 1.5 + 300)) return a;
  if (b.ok) return b;
  return null;
}

// Newest Claude Code on npm (the --registry if given, else whichever of npmjs / npmmirror answers first); null when offline.
async function latestClaudeVersion(opts) {
  const urls = opts.registry ? [opts.registry.replace(/\/+$/, '')] : Object.values(REGISTRIES);
  const probes = urls.map(async (url) => {
    const r = await http('GET', `${url}/${CLAUDE_PKG}/latest`, { timeout: 6000 });
    if (!r.ok || typeof r.json?.version !== 'string') throw new Error('no version');
    return r.json.version;
  });
  try {
    return await Promise.any(probes);
  } catch {
    return null;
  }
}

function updateHint(installed, latest) {
  return L(
    `Claude Code 有新版本 ${latest}（当前 ${installed}）：旧版本可能不认识新模型（比如 claude-opus-5-5），请求会报错。建议先运行：claude update`,
    `Claude Code ${latest} is available (you have ${installed}); older versions may not know newer models such as claude-opus-5-5 and requests can fail. Run: claude update`,
  );
}

async function obtainAndCheckKey(opts, interactive, base, existingKey) {
  let from = null;
  let raw = null;
  if (process.env.EVOLINK_API_KEY) {
    raw = process.env.EVOLINK_API_KEY;
    from = 'env';
    ui.info(L('使用环境变量 EVOLINK_API_KEY 里的 Key', 'Using the key from EVOLINK_API_KEY'));
  } else if (opts.keyStdin) {
    raw = (await nextStdinLine()) || '';
    from = 'stdin';
  } else if (existingKey && (!interactive || (await confirm(L(`已经配置过 EvoLink Key（${maskKey(existingKey)}），继续用它吗？`, `An EvoLink key is already configured (${maskKey(existingKey)}). Keep using it?`), true)))) {
    raw = existingKey;
    from = 'existing';
  } else if (!interactive) {
    throw new CliError(L('没有拿到 API Key：请设置环境变量 EVOLINK_API_KEY，或加 --key-stdin 从标准输入读取。', 'No API key: set EVOLINK_API_KEY or pass --key-stdin.'), EXIT.AUTH);
  }
  for (let attempt = 1; ; attempt++) {
    if (raw === null) {
      if (attempt === 1) ui.info(L(`还没有 Key？到控制台创建并复制：${DASHBOARD_KEYS_URL}`, `No key yet? Create and copy one at ${DASHBOARD_KEYS_URL}`));
      raw = await askSecret(L('  粘贴 API Key（输入不显示，回车确认）：', '  Paste your API key (hidden, press Enter): '));
      from = 'prompt';
    }
    const key = normalizeKey(raw);
    const fmt = checkKeyFormat(key);
    let problem = null;
    if (!fmt.ok) {
      problem = {
        empty: L('没有输入 Key。', 'No key entered.'),
        whitespace: L('Key 中间有空格或换行，请重新复制一次完整的 Key。', 'The key contains spaces or line breaks; copy it again.'),
        non_ascii: L('Key 里有中文或全角字符，请重新复制一次完整的 Key。', 'The key contains non-ASCII characters; copy it again.'),
      }[fmt.reason];
    } else {
      if (fmt.warn === 'dash_suffix') {
        ui.warn(L('Key 的 "sk-" 后面还有 "-"：平台会把 "-" 后面当成渠道参数，普通账号会被拒绝（403）。请确认复制的是原样、完整的 Key。', 'The key has a "-" after "sk-"; the gateway treats the rest as a channel pin and rejects it (403) for normal accounts. Use the key exactly as shown.'));
      } else if (fmt.warn === 'unusual_format') {
        ui.warn(L('Key 的格式和常见的不一样（一般是 sk- 加 48 位字母和数字），先校验一下。', 'The key does not look like the usual sk- plus 48 letters and digits; checking it anyway.'));
      }
      if (opts.skipChecks) {
        ui.warn(L('按 --skip-checks 跳过在线校验。', 'Skipping online checks (--skip-checks).'));
        return { key, check: null };
      }
      const check = await checkKey(base, key);
      if (check.ok) {
        ui.ok(L(`Key 有效（${maskKey(key)}）· 可用模型 ${check.count} 个，其中 Claude ${check.claudeCount} 个`, `Key is valid (${maskKey(key)}) · ${check.count} models, ${check.claudeCount} Claude`));
        if (check.claudeCount === 0) ui.warn(L('这把 Key 没有开通任何 Claude 模型，Claude Code 用不了；请在控制台调整 Key 的模型范围。', 'This key has no Claude models; Claude Code cannot work with it. Adjust the key in the dashboard.'));
        printBalance(check.balance);
        return { key, check };
      }
      const lines = failureLines(check.failure, base);
      const keyProblem = ['auth', 'expired', 'disabled'].includes(check.failure.kind);
      if (!(interactive && keyProblem && ['prompt', 'existing'].includes(from))) throw new CliError(lines[0], exitCodeFor(check.failure), lines.slice(1));
      problem = lines.join(' ');
    }
    if (!interactive || !['prompt', 'existing'].includes(from) || attempt >= 3) throw new CliError(problem, EXIT.AUTH);
    ui.err(problem);
    raw = null;
  }
}

async function decideModel(opts, interactive, settings, ids, shellModel) {
  const env = isPlainObject(settings?.env) ? settings.env : {};
  const known = ids.size > 0;
  const current = hasOwn(env, 'ANTHROPIC_MODEL') && env.ANTHROPIC_MODEL !== '' ? String(env.ANTHROPIC_MODEL) : shellModel?.value || null;
  if (opts.model) {
    const m = opts.model.trim();
    if (m === 'default') return { action: 'default' };
    if (known && !modelAvailable(m, ids)) {
      const s = suggestModel(m, ids);
      throw new CliError(L(`这把 Key 用不了模型 ${m}`, `This key cannot use model ${m}`) + (s ? L(`，你是不是想用 ${s}？`, `; did you mean ${s}?`) : L('。', '.')), EXIT.AUTH);
    }
    ui.ok(L(`默认模型：${m}`, `Default model: ${m}`));
    return { action: 'set', model: m };
  }
  const currentOk = current && (!known || modelAvailable(current, ids));
  if (current && !currentOk) ui.warn(L(`现在配置的模型 ${current} 这把 Key 用不了，将改为跟随 Claude Code 默认。`, `The configured model ${current} is not available for this key; switching to Claude Code's default.`));
  if (!interactive) {
    if (current && !currentOk) return { action: 'default' };
    ui.ok(currentOk ? L(`保持现有模型：${current}`, `Keeping model: ${current}`) : L('跟随 Claude Code 默认模型', "Using Claude Code's default model"));
    return { action: 'keep' };
  }
  const options = [];
  if (currentOk) options.push({ label: L(`保持现有设置：${current}`, `Keep current: ${current}`), value: { action: 'keep' } });
  options.push({
    label: L('跟随 Claude Code 默认', "Claude Code's default"),
    note: L('一般是最新的 Opus：最强，但单价和单次预扣最高', 'usually the latest Opus: strongest, highest price and hold'),
    value: { action: current ? 'default' : 'keep' },
  });
  for (const m of RECOMMENDED_MODELS) {
    if ((known && !ids.has(m.id)) || m.id === current) continue;
    options.push({ label: m.id, note: L(m.zh, m.en), value: { action: 'set', model: m.id } });
  }
  options.push({ label: L('手动输入模型 ID', 'Type a model ID'), value: { action: 'input' } });
  const idx = await choose(L('Claude Code 默认用哪个模型？（之后在 Claude Code 里输入 /model 随时能换）', 'Which model should Claude Code use by default? (switch any time with /model)'), options, 0);
  let v = options[idx].value;
  while (v.action === 'input') {
    const m = (await askLine(L('  模型 ID：', '  Model ID: '))).trim();
    if (!m) continue;
    if (!known || modelAvailable(m, ids)) v = { action: 'set', model: m };
    else {
      const s = suggestModel(m, ids);
      ui.warn(L(`这把 Key 用不了 ${m}`, `This key cannot use ${m}`) + (s ? L(`，你是不是想用 ${s}？`, `; did you mean ${s}?`) : ''));
    }
  }
  return v;
}

async function handleInvalidSettings(settingsRead, opts, interactive) {
  const where = settingsRead.where ? L(`（第 ${settingsRead.where.line} 行第 ${settingsRead.where.col} 列附近）`, ` (near line ${settingsRead.where.line}, column ${settingsRead.where.col})`) : '';
  ui.err(L(`${tildify(settingsRead.file)} 不是有效的 JSON${where}，Claude Code 读不了它。`, `${tildify(settingsRead.file)} is not valid JSON${where}; Claude Code cannot read it.`));
  const hints = jsonHints(settingsRead.raw);
  if (hints.includes('fullwidth')) ui.sub(L('里面有中文标点（，：“”），JSON 只认英文标点。', 'It contains full-width punctuation (，：“”); JSON needs ASCII punctuation.'));
  if (hints.includes('trailing_comma')) ui.sub(L('最后一项后面多了逗号。', 'There is a trailing comma.'));
  if (hints.includes('comments')) ui.sub(L('JSON 里不能写注释（// 或 /* */）。', 'JSON does not allow comments.'));
  let replace = opts.replaceInvalid;
  if (!replace && interactive) {
    replace = await confirm(L('把它备份后换成一份新的（只含 EvoLink 配置；原来的其他设置可以从备份里找回）？', 'Back it up and replace it with a fresh file containing only the EvoLink settings? (Other settings stay recoverable from the backup.)'), true);
  }
  if (!replace) {
    throw new CliError(L('为避免覆盖你的配置，已停止。修正文件后重试，或加 --replace-invalid 让本工具备份后重建。', 'Stopped to avoid overwriting your settings. Fix the file and retry, or pass --replace-invalid to back it up and rebuild it.'), EXIT.CONFIG);
  }
  return { ...settingsRead, data: {}, replaceInvalid: true };
}

async function decideTrust(opts, interactive, paths) {
  const dirs = [];
  // Claude Code keys trust by the physical path (macOS /var is /private/var), so resolve symlinks.
  if (opts.trust) {
    if (!isDir(opts.trust)) throw new CliError(L(`文件夹不存在：${opts.trust}`, `Folder not found: ${opts.trust}`), EXIT.USAGE);
    dirs.push(realpathOr(opts.trust));
  }
  const cwd = process.cwd();
  if (!opts.trust && interactive && process.platform !== 'win32' && realpathOr(cwd) !== realpathOr(os.homedir()) && opts.onboarding !== false) {
    const g = readJson(paths.globalConfig);
    if (g.data?.projects?.[cwd]?.hasTrustDialogAccepted !== true) {
      ui.print('');
      if (await confirm(L(`把当前文件夹设为"已信任"吗？这样在这里第一次启动 Claude Code 不会再问。\n    ${cwd}`, `Mark the current folder as trusted so Claude Code does not ask on first launch here?\n    ${cwd}`), false)) dirs.push(cwd);
    }
  }
  if (dirs.length && process.platform === 'win32') {
    ui.warn(L('Windows 上暂不支持预先信任文件夹，首次启动时请手动选 Yes。', 'Pre-trusting folders is not supported on Windows yet; choose Yes on first launch.'));
    return [];
  }
  return dirs;
}

function buildPlan({ opts, base, key, ids, decision, conflicts, settingsRead, paths, trustDirs, editors }) {
  const settings = settingsRead.data || {};
  const env = isPlainObject(settings.env) ? settings.env : {};
  const known = ids.size > 0;
  const set = { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '' };
  const maxOut = Number(opts.maxOutputTokens);
  if (maxOut > 0) set.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOut);
  if (opts.disableNonessentialTraffic !== false) set.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  const remove = [];
  if (decision.action === 'set') set.ANTHROPIC_MODEL = decision.model;
  if (decision.action === 'default') remove.push('ANTHROPIC_MODEL');
  for (const v of MODEL_OVERRIDE_VARS) {
    if (v === 'ANTHROPIC_MODEL') continue;
    if (hasOwn(env, v) && env[v] !== '' && known && !modelAvailable(env[v], ids)) remove.push(v);
  }
  for (const v of PROVIDER_VARS) if (hasOwn(env, v) && truthy(env[v])) remove.push(v);
  // Values from the shell, profiles or the registry lose to settings.json, so an empty string neutralises them.
  for (const c of conflicts) {
    if (!['env', 'file', 'registry'].includes(c.source) || hasOwn(set, c.name)) continue;
    const badModel = MODEL_OVERRIDE_VARS.includes(c.name) && known && !modelAvailable(c.value, ids);
    const shellDefaultModel = c.name === 'ANTHROPIC_MODEL' && decision.action === 'default';
    if ((PROVIDER_VARS.includes(c.name) && truthy(c.value)) || badModel || shellDefaultModel) set[c.name] = '';
  }
  const envChanges = planEnvChanges(env, { set, remove });
  const topChanges = [];
  if (hasOwn(settings, 'model') && known && !modelAvailable(settings.model, ids)) {
    topChanges.push({ key: 'model', before: settings.model, after: undefined, changed: true });
  }

  const globalRead = readJson(paths.globalConfig);
  const global = { file: paths.globalConfig, changes: [], skipped: null };
  if (globalRead.exists && !globalRead.data) {
    global.skipped = L(`${tildify(paths.globalConfig)} 读不了（${globalRead.error}），跳过"跳过首次引导"这一项。`, `${tildify(paths.globalConfig)} is unreadable (${globalRead.error}); skipping the onboarding flag.`);
  } else {
    const g = globalRead.data || {};
    if (opts.onboarding !== false && g.hasCompletedOnboarding !== true) {
      global.changes.push({ kind: 'onboarding', key: 'hasCompletedOnboarding', before: hasOwn(g, 'hasCompletedOnboarding') ? g.hasCompletedOnboarding : undefined, after: true });
    }
    for (const dir of trustDirs) {
      const entry = g.projects?.[dir];
      if (entry?.hasTrustDialogAccepted === true) continue;
      global.changes.push({ kind: 'trust', key: dir, created: !isPlainObject(entry), before: isPlainObject(entry) && hasOwn(entry, 'hasTrustDialogAccepted') ? entry.hasTrustDialogAccepted : undefined, after: true });
    }
  }

  const vscode = [];
  for (const ed of editors) {
    const raw = isFile(ed.settings) ? fs.readFileSync(ed.settings, 'utf8') : null;
    const p = planDisableLoginPrompt(raw);
    if (p.action !== 'none') vscode.push({ ...ed, ...p });
  }
  return {
    settings: { file: paths.settings, envChanges, topChanges, replaceInvalid: !!settingsRead.replaceInvalid, existed: settingsRead.exists },
    global,
    vscode,
  };
}

function countChanges(plan) {
  return (
    plan.settings.envChanges.filter((c) => c.changed).length +
    plan.settings.topChanges.length +
    (plan.settings.replaceInvalid ? 1 : 0) +
    plan.global.changes.length +
    plan.vscode.filter((v) => v.action !== 'manual').length
  );
}

function summarizePlan(plan) {
  const out = [];
  for (const c of plan.settings.envChanges) {
    if (c.changed) out.push({ file: plan.settings.file, key: `env.${c.key}`, before: displayValue(c.key, c.before), after: c.after === undefined ? null : displayValue(c.key, c.after) });
  }
  for (const c of plan.settings.topChanges) out.push({ file: plan.settings.file, key: c.key, before: String(c.before), after: null });
  for (const c of plan.global.changes) out.push({ file: plan.global.file, key: c.kind === 'trust' ? `projects["${c.key}"].hasTrustDialogAccepted` : c.key, after: true });
  for (const v of plan.vscode) out.push({ file: v.settings, key: DLP_KEY, after: v.action === 'manual' ? 'manual' : true });
  return out;
}

const WHY = {
  ANTHROPIC_BASE_URL: ['EvoLink 接口地址', 'EvoLink endpoint'],
  ANTHROPIC_AUTH_TOKEN: ['你的 EvoLink Key', 'your EvoLink key'],
  ANTHROPIC_API_KEY: ['置空，压住可能残留的旧 Key', 'blank, so a leftover key cannot take over'],
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: ['降低单次预扣，避免"余额不足"', 'lowers the per-request hold'],
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: ['减少非必要请求（与文档一致；也会关掉自动更新）', 'fewer background requests (also turns off auto-update)'],
  ANTHROPIC_MODEL: ['默认模型', 'default model'],
};

function printPlan(plan) {
  const s = plan.settings;
  const changed = s.envChanges.filter((c) => c.changed);
  ui.print('');
  ui.print(`  ${tildify(s.file)}${s.replaceInvalid ? L('  （备份后重建）', '  (backed up, then rebuilt)') : s.existed ? '' : L('  （新建）', '  (new file)')}`);
  if (!changed.length && !s.topChanges.length) ui.info(L('无需改动', 'no changes'));
  const width = Math.max(0, ...changed.map((c) => c.key.length));
  for (const c of changed) {
    const why = WHY[c.key] ? ui.dim(`  ${L(...WHY[c.key])}`) : c.after === '' ? ui.dim(`  ${L('置空，压住外部的旧值', 'blank, neutralises an outside value')}`) : '';
    const after = c.after === undefined ? L('（删除：这把 Key 用不了）', '(removed: not usable with this key)') : displayValue(c.key, c.after);
    ui.print(`    ${c.key.padEnd(width)}  ${displayValue(c.key, c.before)} → ${after}${why}`);
  }
  for (const c of s.topChanges) ui.print(`    model  ${c.before} → ${L('（删除：这把 Key 用不了）', '(removed: not usable with this key)')}`);
  if (changed.length) ui.print(ui.dim(`    ${L('其余配置保持不变', 'everything else is kept')}`));
  if (plan.global.changes.length || plan.global.skipped) {
    ui.print(`  ${tildify(plan.global.file)}`);
    if (plan.global.skipped) ui.warn(plan.global.skipped);
    for (const c of plan.global.changes) {
      if (c.kind === 'onboarding') ui.print(`    hasCompletedOnboarding  ${displayValue('', c.before)} → true${ui.dim(`  ${L('跳过首次启动的主题、登录引导', 'skips the first-run theme and login screens')}`)}`);
      else ui.print(`    ${L('信任文件夹', 'trust folder')} ${c.key}${ui.dim(`  ${L('这里首次启动不再询问', 'no trust prompt here')}`)}`);
    }
  }
  for (const v of plan.vscode) {
    ui.print(`  ${tildify(v.settings)}`);
    if (v.action === 'manual') ui.warn(L(`这个文件格式特殊，请手动加入 "${DLP_KEY}": true（在编辑器里搜索 "Claude Code login" 勾选即可）`, `Unusual file format; add "${DLP_KEY}": true yourself (search "Claude Code login" in the editor settings)`));
    else ui.print(`    ${DLP_KEY}  → true${ui.dim(`  ${L('扩展不再要求登录 Anthropic 账号', 'the extension stops asking for an Anthropic login')}`)}`);
  }
}

function printConflicts(conflicts, ids) {
  const items = conflicts.map((h) => ({ h, level: classifyConflict(h, ids) })).filter((x) => x.level);
  if (!items.length) {
    ui.ok(L('没有发现冲突的旧配置', 'No conflicting settings found'));
    return;
  }
  ui.print(`  ${L('发现这些会影响 Claude Code 的外部设置：', 'Settings outside settings.json that affect Claude Code:')}`);
  for (const { h, level } of items) {
    const line = conflictText(h, level);
    if (level === 'error' && ['managed', 'project'].includes(h.source)) ui.err(line);
    else if (level === 'error' || level === 'warn') ui.warn(line);
    else ui.info(line);
  }
}

function applyPlan(plan) {
  const state = loadState();
  const cc = (state.claudeCode ||= { env: {}, top: {}, trusted: {}, vscode: {} });
  cc.settingsFile = plan.settings.file;
  cc.globalFile = plan.global.file;
  const backup = newBackupSession();
  const written = [];
  const warnings = [];

  const s = plan.settings;
  if (s.envChanges.some((c) => c.changed) || s.topChanges.length || s.replaceInvalid) {
    backupFile(backup, s.file, 'settings.json');
    const fresh = readJson(s.file);
    if (fresh.exists && !fresh.data && !s.replaceInvalid) throw new CliError(L(`${tildify(s.file)} 刚刚被改坏了，已停止。`, `${tildify(s.file)} changed and is now invalid; stopped.`), EXIT.CONFIG);
    let next = applyEnvChanges(fresh.data || {}, s.envChanges);
    for (const c of s.topChanges) delete next[c.key];
    writeAtomic(s.file, toJsonText(next));
    recordChanges(cc.env, s.envChanges);
    recordChanges(cc.top, s.topChanges);
    written.push(s.file);
  }

  const g = plan.global;
  if (g.changes.length) {
    backupFile(backup, g.file, '.claude.json');
    const fresh = readJson(g.file);
    if (fresh.exists && !fresh.data) warnings.push(L(`${tildify(g.file)} 读不了，未修改。`, `${tildify(g.file)} is unreadable; left unchanged.`));
    else {
      const data = fresh.data || {};
      for (const c of g.changes) {
        if (c.kind === 'onboarding') {
          if (!cc.onboarding) cc.onboarding = { existed: c.before !== undefined, before: c.before ?? null };
          data.hasCompletedOnboarding = true;
        } else {
          if (!isPlainObject(data.projects)) data.projects = {};
          const created = !isPlainObject(data.projects[c.key]);
          if (created) data.projects[c.key] = {};
          if (!cc.trusted[c.key]) cc.trusted[c.key] = { created, existed: c.before !== undefined, before: c.before ?? null };
          data.projects[c.key].hasTrustDialogAccepted = true;
        }
      }
      writeAtomic(g.file, toJsonText(data));
      written.push(g.file);
    }
  }

  for (const v of plan.vscode) {
    if (v.action === 'manual') continue;
    const raw = isFile(v.settings) ? fs.readFileSync(v.settings, 'utf8') : null;
    const again = planDisableLoginPrompt(raw);
    if (again.action === 'none') continue;
    if (again.action === 'manual') {
      warnings.push(L(`${tildify(v.settings)} 格式特殊，请手动加入 "${DLP_KEY}": true`, `${tildify(v.settings)}: add "${DLP_KEY}": true manually`));
      continue;
    }
    if (raw !== null) backupFile(backup, v.settings, `${v.name.replace(/\W+/g, '-')}-settings.json`);
    writeAtomic(v.settings, again.text, { mode: 0o644 });
    if (!cc.vscode[v.settings]) cc.vscode[v.settings] = { action: raw === null ? 'create' : again.action, inserted: again.inserted || null };
    written.push(v.settings);
  }

  cc.updatedAt = new Date().toISOString();
  saveState(state);
  pruneBackups();
  return { written, warnings, backupDir: backup.files.length ? backup.dir : null };
}

async function fixExecutionPolicy(interactive) {
  const policy = windowsExecutionPolicy();
  if (!policy || !RESTRICTIVE_POLICIES.has(policy)) return;
  ui.warn(L(`PowerShell 的执行策略是 ${policy}：npm 装的 claude 会被拦下（报"禁止运行脚本"）。`, `PowerShell execution policy is ${policy}; the npm-installed claude script will be blocked.`));
  if (interactive && (await confirm(L('把当前用户的执行策略改为 RemoteSigned（开发者常用设置）吗？', 'Set the execution policy for the current user to RemoteSigned (a common developer setting)?'), true))) {
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force'], { timeout: 30000 });
    if (r.code === 0) {
      ui.ok(L('已改为 RemoteSigned（仅当前用户）', 'Set to RemoteSigned for the current user'));
      return;
    }
  }
  ui.info(L('不改也可以：在 PowerShell 里用 claude.cmd 代替 claude，或者在 CMD 里运行 claude。', 'Alternatively run claude.cmd instead of claude in PowerShell, or use CMD.'));
}

function printNextSteps({ plan, claude, editors, trusted, sandbox }) {
  const cmd = sandboxPrefix(sandbox) + commandHint(sandbox);
  ui.print('');
  ui.title(`${ui.mark('ok')} ${L('配置完成', 'All set')}`);
  const n = [];
  if (!claude.installed) {
    n.push(
      L(
        `先安装 Claude Code。中国大陆：npm install -g ${CLAUDE_PKG} --registry=${REGISTRIES.npmmirror}；海外：见 https://code.claude.com/docs/en/setup`,
        `Install Claude Code first: npm install -g ${CLAUDE_PKG} (in mainland China add --registry=${REGISTRIES.npmmirror}), or see https://code.claude.com/docs/en/setup`,
      ),
    );
  }
  if (sandbox) {
    n.push(L(`测试模式：在这个终端里用 ${sandboxPrefix(sandbox)}claude 启动（不带 HOME 就会用你真实的配置）`, `Test mode: start it with ${sandboxPrefix(sandbox)}claude in this terminal (without HOME it uses your real settings)`));
  } else {
    n.push(L('打开一个新的终端窗口，进入你的项目文件夹：cd 你的项目路径', 'Open a new terminal and go to your project: cd <your project>'));
    n.push(L('运行：claude', 'Run: claude'));
  }
  n.forEach((line, i) => ui.print(`  ${i + 1}. ${line}`));
  if (!trusted) {
    ui.print(
      `  ${ui.mark('warn')} ${L(
        '第一次在某个文件夹启动时会问 "Do you trust the files in this folder?"，默认选中的是 No, exit。请先用方向键选中 "Yes, I trust this folder" 再回车。',
        'On first launch in a folder Claude Code asks "Do you trust the files in this folder?" with "No, exit" selected. Use the arrow keys to pick "Yes, I trust this folder", then Enter.',
      )}`,
    );
  }
  ui.print(`  ${ui.mark('dot')} ${L('进入后输入 /status：Anthropic base URL 显示 EvoLink 地址，就说明配置生效了。', 'Inside, run /status: the Anthropic base URL line should show the EvoLink address.')}`);
  if (editors.length) ui.print(`  ${ui.mark('dot')} ${L('VS Code 等编辑器里的 Claude Code 扩展：重新加载窗口（Developer: Reload Window）后生效。', 'Editor extension: run "Developer: Reload Window" for it to take effect.')}`);
  if (claude.installed && claude.version) ui.print(`  ${ui.mark('dot')} ${L('用 claude update 可以手动更新 Claude Code。', 'Update Claude Code any time with: claude update')}`);
  ui.print('');
  ui.print(`  ${L('撤销本次配置：', 'Undo these changes: ')}${cmd} reset`);
  ui.print(`  ${L('遇到问题：运行 ', 'Having trouble? Run ')}${cmd} doctor${L('，把输出发给客服（Key 会自动隐去）', ' and send the output to support (your key is hidden)')}`);
  if (plan.settings.envChanges.some((c) => c.key === 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC' && c.changed)) {
    ui.print(ui.dim(`  ${L('不想关自动更新：重新运行并加 --no-disable-nonessential-traffic', 'To keep auto-update on, re-run with --no-disable-nonessential-traffic')}`));
  }
}

function finish(result, opts, code = EXIT.OK) {
  if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return code;
}

// ---------------------------------------------------------------------------
// doctor

async function cmdDoctor(opts) {
  const report = { command: 'doctor', version: VERSION, problems: [], warnings: [], summary: [] };
  const sandbox = sandboxHome();
  const cmd = sandboxPrefix(sandbox) + commandHint(sandbox);
  const problem = (s) => {
    report.problems.push(s);
    ui.err(s);
  };
  const warn = (s) => {
    report.warnings.push(s);
    ui.warn(s);
  };
  ui.title(L(`EvoLink 诊断 v${VERSION} · ${new Date().toLocaleString('zh-CN', { hour12: false })}`, `EvoLink doctor v${VERSION} · ${new Date().toISOString()}`));

  ui.step(1, 5, L('环境', 'Environment'));
  const osl = osLabel();
  ui.ok(`${osl} · Node ${process.versions.node}`);
  const claude = detectClaude();
  report.claudeCode = claude.installed ? { version: claude.version, path: tildify(claude.path) } : null;
  let latest = null;
  if (claude.installed) {
    ui.ok(`Claude Code ${claude.version || '?'}  ${ui.dim(tildify(claude.path))}`);
    if (!claude.onPath) warn(L('claude 不在 PATH 里，新终端可能找不到命令', 'claude is not on PATH'));
    if (claude.version) {
      latest = await latestClaudeVersion(opts);
      if (latest && compareVersions(claude.version, latest) < 0) warn(updateHint(claude.version, latest));
    }
  } else problem(L('没有找到 Claude Code', 'Claude Code is not installed'));
  if (process.platform === 'win32' && claude.npmShim) {
    const policy = windowsExecutionPolicy();
    if (policy && RESTRICTIVE_POLICIES.has(policy)) warn(L(`PowerShell 执行策略是 ${policy}，claude.ps1 会被拦下；可用 claude.cmd 或运行 evolink setup 修复`, `PowerShell policy ${policy} blocks claude.ps1; use claude.cmd or re-run setup`));
  }
  report.summary.push(`evolink-doctor ${VERSION} | ${osl} | node ${process.versions.node} | claude ${claude.installed ? claude.version || '?' : 'missing'}${latest ? ` (latest ${latest})` : ''}`);

  ui.step(2, 5, L('配置文件', 'Settings'));
  const paths = claudePaths();
  const sr = readJson(paths.settings);
  let env = {};
  if (!sr.exists) problem(L(`${tildify(paths.settings)} 不存在，还没配置过`, `${tildify(paths.settings)} does not exist`));
  else if (!sr.data) problem(L(`${tildify(paths.settings)} 不是有效的 JSON（${sr.error}）`, `${tildify(paths.settings)} is not valid JSON (${sr.error})`));
  else {
    env = isPlainObject(sr.data.env) ? sr.data.env : {};
    ui.ok(tildify(paths.settings));
    if (sr.bom) warn(L('文件开头有 BOM（Windows 记事本常见），部分工具会读取失败', 'The file starts with a BOM, which some tools reject'));
  }
  const baseUrl = env.ANTHROPIC_BASE_URL;
  if (!baseUrl) problem(L('没有设置 ANTHROPIC_BASE_URL', 'ANTHROPIC_BASE_URL is not set'));
  else if (!isEvolinkUrl(baseUrl)) problem(L(`ANTHROPIC_BASE_URL 指向 ${baseUrl}，不是 EvoLink`, `ANTHROPIC_BASE_URL points to ${baseUrl}, not EvoLink`));
  else {
    const n = normalizeBaseUrl(baseUrl);
    if (n.strippedV1 || /\/$/.test(baseUrl)) warn(L(`ANTHROPIC_BASE_URL = ${baseUrl}：标准写法不带 /v1 和结尾斜杠`, `ANTHROPIC_BASE_URL = ${baseUrl}: drop the /v1 and trailing slash`));
    else ui.ok(`ANTHROPIC_BASE_URL = ${baseUrl}`);
  }
  const token = env.ANTHROPIC_AUTH_TOKEN;
  const apiKey = env.ANTHROPIC_API_KEY;
  if (token) ui.ok(`ANTHROPIC_AUTH_TOKEN = ${maskKey(token)}`);
  if (apiKey === '') ui.ok(L('ANTHROPIC_API_KEY 已置空', 'ANTHROPIC_API_KEY is blanked'));
  else if (apiKey && token && apiKey !== token) problem(L('同时设了 ANTHROPIC_API_KEY 和 ANTHROPIC_AUTH_TOKEN 且不一样：EvoLink 会优先用 ANTHROPIC_API_KEY 这把，很可能是旧 Key', 'Both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are set and differ; EvoLink uses the API_KEY one, likely an old key'));
  else if (apiKey && !token) warn(L('用的是 ANTHROPIC_API_KEY：交互模式第一次要手动批准；建议改用 ANTHROPIC_AUTH_TOKEN（重新运行 setup 即可）', 'Using ANTHROPIC_API_KEY, which needs a one-time approval; ANTHROPIC_AUTH_TOKEN is recommended (re-run setup)'));
  else if (!token) problem(L('没有设置 Key（ANTHROPIC_AUTH_TOKEN）', 'No key set (ANTHROPIC_AUTH_TOKEN)'));
  if (env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) ui.ok(`CLAUDE_CODE_MAX_OUTPUT_TOKENS = ${env.CLAUDE_CODE_MAX_OUTPUT_TOKENS}`);
  else ui.info(L('没设 CLAUDE_CODE_MAX_OUTPUT_TOKENS：Opus 等模型单次预扣较高，余额少时容易报"余额不足"', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS not set; pricey models hold more credits per request'));
  if (env.ANTHROPIC_MODEL) ui.info(`ANTHROPIC_MODEL = ${env.ANTHROPIC_MODEL}`);
  for (const v of PROVIDER_VARS) if (truthy(env[v])) problem(L(`settings.json 里 ${v}=${env[v]}：Claude Code 会改走其他云，EvoLink 不生效`, `settings.json sets ${v}=${env[v]}; EvoLink is bypassed`));
  const credential = token || apiKey || null;
  report.summary.push(`settings: base=${baseUrl || '-'} token=${token ? maskKey(token) : '-'} api_key=${apiKey === '' ? '""' : apiKey ? maskKey(apiKey) : '-'} maxout=${env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '-'} model=${env.ANTHROPIC_MODEL || '-'}`);

  ui.step(3, 5, L('连接与 Key', 'Connection and key'));
  let ids = new Set();
  if (credential && baseUrl && isEvolinkUrl(baseUrl)) {
    const base = normalizeBaseUrl(baseUrl).url;
    const check = await checkKey(base, credential);
    if (check.ok) {
      ids = check.ids;
      ui.ok(L(`Key 有效 · 可用模型 ${check.count} 个，其中 Claude ${check.claudeCount} 个（${check.ms} ms）`, `Key valid · ${check.count} models, ${check.claudeCount} Claude (${check.ms} ms)`));
      if (!check.claudeCount) problem(L('这把 Key 没有开通 Claude 模型', 'This key has no Claude models'));
      printBalance(check.balance);
      if (check.balance?.user !== null && check.balance?.user !== undefined && check.balance.user < LOW_BALANCE_CREDITS) report.warnings.push('low balance');
      report.summary.push(`api: models=${check.count} claude=${check.claudeCount} balance=${check.balance?.user ?? '-'} key_quota=${check.balance?.unlimited ? 'unlimited' : check.balance?.token ?? '-'}`);
      if (opts.test) {
        const model = pickTestModel(env.ANTHROPIC_MODEL, ids);
        const t = model ? await testMessage(base, credential, model) : null;
        if (t?.ok) ui.ok(L(`测试请求通过：${model}（${t.ms} ms）`, `Test request passed: ${model} (${t.ms} ms)`));
        else if (t) for (const l of failureLines(t.failure, base)) problem(l);
        report.summary.push(`test: ${t ? (t.ok ? `ok ${model}` : `fail ${t.failure.kind} ${t.failure.status || ''}`) : 'skipped'}`);
      }
    } else {
      for (const l of failureLines(check.failure, base)) problem(l);
      report.summary.push(`api: fail ${check.failure.kind} ${check.failure.status || check.failure.code || ''}`);
    }
    for (const v of MODEL_OVERRIDE_VARS) {
      if (env[v] && ids.size && !modelAvailable(env[v], ids)) problem(L(`${v}=${env[v]}：这把 Key 用不了这个模型`, `${v}=${env[v]} is not available for this key`));
    }
    if (sr.data?.model && ids.size && !modelAvailable(sr.data.model, ids)) problem(L(`settings.json 的 model=${sr.data.model}：这把 Key 用不了`, `settings.json model=${sr.data.model} is not available for this key`));
  } else ui.info(L('没有可用的 EvoLink 配置，跳过联网检查', 'No EvoLink configuration; skipping online checks'));

  ui.step(4, 5, L('外部冲突', 'Conflicts'));
  const conflicts = scanConflicts();
  const items = conflicts.map((h) => ({ h, level: classifyConflict(h, ids) })).filter((x) => x.level);
  if (!items.length) ui.ok(L('没有发现冲突的外部设置', 'No conflicting outside settings'));
  for (const { h, level } of items) {
    // A blank value in user settings only beats the shell, profiles and the registry.
    const neutralised = ['env', 'file', 'registry'].includes(h.source) && hasOwn(env, h.name) && env[h.name] === '';
    const line = conflictText(h, level);
    if (level === 'error' && !neutralised) problem(line);
    else if (level === 'warn') warn(line);
    else ui.info(line);
  }
  report.summary.push(`conflicts: ${items.length ? items.map(({ h }) => `${h.source}:${h.name}`).join(',') : 'none'}`);

  ui.step(5, 5, L('首次启动与编辑器', 'First run and editors'));
  const g = readJson(paths.globalConfig);
  if (g.exists && !g.data) problem(L(`${tildify(paths.globalConfig)} 读不了（${g.error}）`, `${tildify(paths.globalConfig)} is unreadable (${g.error})`));
  else if (g.data?.hasCompletedOnboarding) ui.ok(L('已跳过首次引导（hasCompletedOnboarding）', 'First-run onboarding completed'));
  else ui.info(L('首次启动会先显示主题和引导页面', 'First launch will show the theme and onboarding screens'));
  const acct = officialAccount(g.data, paths.configDir);
  if (acct) {
    ui.info(
      overridesLogin(sr.data)
        ? L(`这台电脑也登录了 Anthropic 官方账号：现在用的是 settings.json 里的配置（优先级更高）；想切回官方账号，运行 ${cmd} reset`, `Also signed in to an Anthropic account; settings.json takes precedence. To switch back to the account: ${cmd} reset`)
        : L('这台电脑登录了 Anthropic 官方账号，现在用的是官方账号，没有走 EvoLink', 'Signed in to an Anthropic account, which is in use instead of EvoLink'),
    );
  }
  report.summary.push(`official_login: ${acct ? 'yes' : 'no'}`);
  const cwd = process.cwd();
  if (g.data?.projects?.[cwd]?.hasTrustDialogAccepted) ui.ok(L('当前文件夹已信任', 'Current folder is trusted'));
  else ui.info(L('当前文件夹还没信任：首次启动会问，请选 "Yes, I trust this folder"', 'Current folder not trusted yet; choose "Yes, I trust this folder" on first launch'));
  for (const ed of detectEditors()) {
    const raw = isFile(ed.settings) ? fs.readFileSync(ed.settings, 'utf8') : '';
    if (/"claudeCode\.disableLoginPrompt"\s*:\s*true/.test(raw)) ui.ok(L(`${ed.name}：Claude Code 扩展已跳过登录提示`, `${ed.name}: extension login prompt disabled`));
    else warn(L(`${ed.name}：Claude Code 扩展会要求登录 Anthropic 账号；运行 setup 或在设置里勾选 "Disable Login Prompt"`, `${ed.name}: the extension will ask for an Anthropic login; run setup or enable "Disable Login Prompt"`));
  }

  ui.print('');
  if (report.problems.length) ui.title(`${ui.mark('err')} ${L(`发现 ${report.problems.length} 个问题（见上方 ✗）`, `${report.problems.length} problem(s) found (marked above)`)}`);
  else ui.title(`${ui.mark('ok')} ${L('没有发现问题', 'No problems found')}`);
  if (report.problems.length) ui.print(`  ${L('多数问题重新运行一次 setup 就能修好：', 'Most problems are fixed by running setup again: ')}${cmd} setup`);
  ui.print('');
  ui.print(ui.dim(L('—— 以下内容可以直接发给客服（Key 已隐去）——', '--- Send the lines below to support (key hidden) ---')));
  for (const line of report.summary) ui.print(line);
  if (report.problems.length) ui.print(`problems: ${report.problems.length}`);
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.problems.length ? EXIT.ERROR : EXIT.OK;
}

// ---------------------------------------------------------------------------
// reset

async function cmdReset(opts) {
  const interactive = !opts.yes && !opts.json;
  const state = loadState();
  const cc = state.claudeCode;
  ui.title(L(`EvoLink 撤销配置 v${VERSION}`, `EvoLink reset v${VERSION}`));
  if (!cc) {
    ui.info(L('没有找到 evolink setup 的改动记录，无需撤销。', 'No changes recorded by evolink setup; nothing to undo.'));
    return finish({ command: 'reset', ok: true, changes: [] }, opts);
  }
  const settingsFile = cc.settingsFile || claudePaths().settings;
  const globalFile = cc.globalFile || claudePaths().globalConfig;
  const sr = readJson(settingsFile);
  const envPlan = sr.data ? planRestore(sr.data.env, cc.env) : { changes: [], skipped: Object.keys(cc.env || {}) };
  const topPlan = sr.data ? planRestore(sr.data, cc.top) : { changes: [], skipped: Object.keys(cc.top || {}) };
  const gr = readJson(globalFile);
  const trustChanges = [];
  for (const [dir, rec] of Object.entries(cc.trusted || {})) {
    const entry = gr.data?.projects?.[dir];
    if (!entry || entry.hasTrustDialogAccepted !== true) continue;
    trustChanges.push({ dir, rec });
  }
  const vscodeChanges = [];
  for (const [file, rec] of Object.entries(cc.vscode || {})) {
    if (!isFile(file)) continue;
    const text = undoDisableLoginPrompt(fs.readFileSync(file, 'utf8'), rec);
    if (text !== null) vscodeChanges.push({ file, text, remove: text === '' });
  }

  const envChanged = envPlan.changes.filter((c) => c.changed);
  ui.print('');
  if (envChanged.length || topPlan.changes.some((c) => c.changed)) ui.print(`  ${tildify(settingsFile)}`);
  for (const c of envChanged) ui.print(`    ${c.key}  ${displayValue(c.key, c.before)} → ${c.after === undefined ? L('（删除）', '(removed)') : displayValue(c.key, c.after)}`);
  for (const c of topPlan.changes.filter((x) => x.changed)) ui.print(`    ${c.key}  → ${displayValue('', c.after)}`);
  if (trustChanges.length) ui.print(`  ${tildify(globalFile)}`);
  for (const t of trustChanges) ui.print(`    ${L('取消信任', 'untrust')} ${t.dir}`);
  for (const v of vscodeChanges) ui.print(`  ${tildify(v.file)}\n    ${DLP_KEY} ${v.remove ? L('（删除文件：由 setup 新建）', '(delete file created by setup)') : L('还原', 'restored')}`);
  const skipped = [...envPlan.skipped, ...topPlan.skipped];
  if (skipped.length) ui.warn(L(`这些项在 setup 之后被改过，保持不动：${skipped.join(', ')}`, `Changed since setup, left as is: ${skipped.join(', ')}`));
  if (cc.onboarding) ui.info(L('"已完成首次引导"标记保留（撤销它只会让 Claude Code 重新显示引导页面）', 'The onboarding flag is kept (removing it would only replay the intro screens)'));
  const total = envChanged.length + topPlan.changes.filter((c) => c.changed).length + trustChanges.length + vscodeChanges.length;
  if (!total) {
    ui.ok(L('没有需要撤销的内容。', 'Nothing to undo.'));
    delete state.claudeCode;
    if (!opts.dryRun) saveState(state);
    return finish({ command: 'reset', ok: true, changes: [] }, opts);
  }
  if (opts.dryRun) {
    ui.info(L('这是预览（--dry-run），没有写入任何文件。', 'Preview only (--dry-run); nothing was written.'));
    return finish({ command: 'reset', ok: true, dryRun: true }, opts);
  }
  if (interactive && !(await confirm(L('确认撤销？', 'Undo these changes?'), true))) throw new CancelledError();

  const backup = newBackupSession();
  if (envChanged.length || topPlan.changes.some((c) => c.changed)) {
    backupFile(backup, settingsFile, 'settings.json');
    let next = applyEnvChanges(sr.data, envPlan.changes);
    for (const c of topPlan.changes) {
      if (!c.changed) continue;
      if (c.after === undefined) delete next[c.key];
      else next[c.key] = c.after;
    }
    if (isPlainObject(next.env) && !Object.keys(next.env).length) delete next.env;
    writeAtomic(settingsFile, toJsonText(next));
  }
  if (trustChanges.length && gr.data) {
    backupFile(backup, globalFile, '.claude.json');
    const fresh = readJson(globalFile).data || gr.data;
    for (const { dir, rec } of trustChanges) {
      const entry = fresh.projects?.[dir];
      if (!entry) continue;
      if (rec.created && Object.keys(entry).length === 1) delete fresh.projects[dir];
      else if (rec.existed) entry.hasTrustDialogAccepted = rec.before;
      else delete entry.hasTrustDialogAccepted;
    }
    writeAtomic(globalFile, toJsonText(fresh));
  }
  for (const v of vscodeChanges) {
    backupFile(backup, v.file, 'editor-settings.json');
    if (v.remove) fs.unlinkSync(v.file);
    else writeAtomic(v.file, v.text, { mode: 0o644 });
  }
  delete state.claudeCode;
  saveState(state);
  ui.ok(L(`已撤销。改动前的文件备份在 ${tildify(backup.dir)}`, `Undone. Backups are in ${tildify(backup.dir)}`));
  return finish({ command: 'reset', ok: true, backupDir: backup.dir, restored: total, skipped }, opts);
}

// ---------------------------------------------------------------------------
// CLI entry

const BOOL_FLAGS = new Set(['yes', 'dry-run', 'json', 'help', 'version', 'install', 'test', 'onboarding', 'key-stdin', 'skip-checks', 'replace-invalid', 'vscode', 'disable-nonessential-traffic']);
const VALUE_FLAGS = new Set(['model', 'max-output-tokens', 'base-url', 'registry', 'trust', 'lang']);
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function parseArgs(argv) {
  const opts = { _: [], maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (a === '-y') opts.yes = true;
    else if (a === '-h') opts.help = true;
    else if (a === '-v') opts.version = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const inline = eq > 0 ? a.slice(eq + 1) : undefined;
      if (name.startsWith('no-') && BOOL_FLAGS.has(name.slice(3)) && inline === undefined) opts[camel(name.slice(3))] = false;
      else if (BOOL_FLAGS.has(name)) opts[camel(name)] = inline === undefined ? true : !/^(0|false|no|off)$/i.test(inline);
      else if (VALUE_FLAGS.has(name)) {
        const v = inline !== undefined ? inline : argv[++i];
        if (v === undefined || v.startsWith('--')) throw new CliError(`--${name} needs a value`, EXIT.USAGE);
        opts[camel(name)] = v;
      } else throw new CliError(`Unknown option: --${name}`, EXIT.USAGE);
    } else opts._.push(a);
  }
  if (typeof opts.maxOutputTokens === 'string') {
    const n = Number(opts.maxOutputTokens);
    if (!Number.isInteger(n) || n < 0) throw new CliError('--max-output-tokens must be a whole number (0 = leave unset)', EXIT.USAGE);
    opts.maxOutputTokens = n;
  }
  return opts;
}

function helpText() {
  return L(
    `EvoLink 命令行工具 v${VERSION}：一键把 Claude Code 接到 EvoLink

用法：
  evolink [setup]      配置 Claude Code（默认命令）
  evolink doctor       诊断当前配置，输出可以直接发给客服（Key 已隐去）
  evolink reset        撤销 setup 做的改动

常用选项：
  --model <id>         默认模型，如 claude-sonnet-5；default 表示跟随 Claude Code 默认
  --yes, -y            不提问，全部用默认值（Key 从环境变量 EVOLINK_API_KEY 读取）
  --key-stdin          从标准输入读取 Key
  --dry-run            只预览改动，不写文件
  --trust <文件夹>      预先信任这个文件夹，首次启动不再询问（macOS / Linux）
  --max-output-tokens <n>  单次输出上限，默认 32000（0 表示不设置）
  --no-disable-nonessential-traffic  不关闭自动更新等非必要请求
  --no-install         没装 Claude Code 时不自动安装
  --no-onboarding      不修改 ~/.claude.json
  --no-vscode          不修改编辑器里 Claude Code 扩展的设置
  --no-test            不发测试请求
  --skip-checks        跳过所有联网检查（网络需要代理时用）
  --replace-invalid    settings.json 格式损坏时，备份后重建
  --registry <url>     安装 Claude Code 用的 npm 源（默认自动选择）
  --base-url <url>     接口地址，默认 ${DEFAULT_BASE_URL}
  --json               输出 JSON（setup 需同时加 --yes）
  --lang zh|en         界面语言

环境变量：EVOLINK_API_KEY、EVOLINK_BASE_URL、CLAUDE_CONFIG_DIR
所有改动前都会备份到 ~/.evolink/backups/。`,
    `EvoLink CLI v${VERSION}: connect Claude Code to EvoLink in one command

Usage:
  evolink [setup]      configure Claude Code (default)
  evolink doctor       diagnose the setup; output is safe to send to support
  evolink reset        undo what setup changed

Options:
  --model <id>         default model, e.g. claude-sonnet-5; "default" = Claude Code's own default
  --yes, -y            no prompts (key from EVOLINK_API_KEY)
  --key-stdin          read the key from stdin
  --dry-run            preview only
  --trust <folder>     pre-trust a folder (macOS / Linux)
  --max-output-tokens <n>  output cap, default 32000 (0 = leave unset)
  --no-disable-nonessential-traffic  keep auto-update and other background traffic on
  --no-install         do not install Claude Code when missing
  --no-onboarding      do not touch ~/.claude.json
  --no-vscode          do not touch editor settings for the Claude Code extension
  --no-test            skip the test request
  --skip-checks        skip all online checks (e.g. behind a proxy)
  --replace-invalid    back up and rebuild a broken settings.json
  --registry <url>     npm registry for installing Claude Code (auto by default)
  --base-url <url>     endpoint, default ${DEFAULT_BASE_URL}
  --json               JSON output (setup also needs --yes)
  --lang zh|en         interface language

Environment: EVOLINK_API_KEY, EVOLINK_BASE_URL, CLAUDE_CONFIG_DIR
Everything is backed up to ~/.evolink/backups/ before it changes.`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    LANG = detectLang();
    process.stderr.write(`${e.message}\n\n${helpText()}\n`);
    return EXIT.USAGE;
  }
  LANG = detectLang(opts.lang);
  ui.init({ json: !!opts.json });
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }
  const cmd = opts._[0] || 'setup';
  if (opts.help || cmd === 'help') {
    process.stdout.write(`${helpText()}\n`);
    return EXIT.OK;
  }
  if (Number(process.versions.node.split('.')[0]) < 18) {
    process.stderr.write(`${L('需要 Node.js 18 或更高版本。', 'Node.js 18 or newer is required.')}\n`);
    return EXIT.ERROR;
  }
  try {
    if (cmd === 'setup') return await cmdSetup(opts);
    if (cmd === 'doctor') return await cmdDoctor(opts);
    if (cmd === 'reset') return await cmdReset(opts);
    throw new CliError(L(`未知命令：${cmd}（可用：setup、doctor、reset）`, `Unknown command: ${cmd} (setup, doctor, reset)`), EXIT.USAGE);
  } catch (e) {
    if (e instanceof CliError) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, error: e.message, hints: e.hints, exitCode: e.exitCode }, null, 2)}\n`);
      else {
        ui.print('');
        ui.err(e.message);
        for (const h of e.hints || []) ui.sub(h);
      }
      return e.exitCode;
    }
    process.stderr.write(`${L('出错了：', 'Unexpected error: ')}${e?.stack || e}\n`);
    return EXIT.ERROR;
  } finally {
    closeStdin();
  }
}

const isMain = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().then((code) => {
    process.exitCode = code;
    // Keep-alive sockets or stdin can hold the loop open; exit once output has had time to flush.
    setTimeout(() => process.exit(code), 300).unref();
  });
}
