#!/usr/bin/env bash
# EvoLink one-command setup for Claude Code and Codex (macOS / Linux), version 0.4.0
#
#   curl -fsSL https://cdn.evolink.ai/cli/setup.sh | bash
#   curl -fsSL https://cdn.evolink.ai/cli/setup.sh | bash -s -- --model claude-sonnet-5
#   curl -fsSL https://cdn.evolink.ai/cli/setup.sh | bash -s -- codex
#   curl -fsSL https://cdn.evolink.ai/cli/setup.sh | bash -s -- doctor
#
# What it does: finds Node.js (18+), saves the EvoLink CLI to ~/.evolink/cli, adds a launcher at
# ~/.evolink/bin/evolink, then runs `evolink setup`. It does not change your PATH or shell profile.
# The CLI source is embedded below and verified against its SHA-256 before it runs.

set -u

evolink_main() {
  local version="0.4.0"
  local expected_sha="968024cf5782267d4f0c63a6cdb904ec5d21edc68b2a48f52babe34d259d1c10"
  local home_dir="${EVOLINK_HOME:-$HOME/.evolink}"
  local zh=0
  case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in zh* | *_CN* | *_TW* | *_HK*) zh=1 ;; esac
  say() { if [ "$zh" = 1 ]; then printf '%s\n' "$1" >&2; else printf '%s\n' "$2" >&2; fi; }

  local tty=0
  if (exec </dev/tty) 2>/dev/null; then tty=1; fi

  # 1. Node.js 18+
  local node="" c
  for c in "${EVOLINK_NODE:-}" "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
    if [ -n "$c" ] && [ -x "$c" ] && "$c" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null; then node="$c"; break; fi
  done
  if [ -z "$node" ] && [ -d "$HOME/.nvm/versions/node" ]; then
    for c in $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -t v -k 2 -V -r); do
      if "$c" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null; then node="$c"; break; fi
    done
  fi
  if [ -z "$node" ]; then
    say "没有找到 Node.js 18 或更高版本（Claude Code 需要 Node.js 22+）。" "Node.js 18+ was not found (Claude Code itself wants Node.js 22+)."
    if [ "$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1 && [ "$tty" = 1 ]; then
      say "可以用 Homebrew 安装：brew install node" "It can be installed with Homebrew: brew install node"
      printf '%s' "$([ "$zh" = 1 ] && echo '现在安装吗？[Y/n] ' || echo 'Install now? [Y/n] ')" >&2
      local ans=""
      read -r ans </dev/tty || ans="n"
      case "$ans" in "" | y | Y | yes | YES)
        brew install node && node="$(command -v node 2>/dev/null || true)" ;;
      esac
    fi
    if [ -z "$node" ]; then
      say "请先安装 Node.js 22，再重新运行这条命令：" "Install Node.js 22, then run this command again:"
      say "  中国大陆：https://npmmirror.com/mirrors/node/ （选最新的 v22 安装包）" "  Mainland China mirror: https://npmmirror.com/mirrors/node/"
      say "  官网：https://nodejs.org/zh-cn/download" "  Official: https://nodejs.org/en/download"
      return 3
    fi
  fi

  # 2. Save the CLI and a launcher under ~/.evolink
  mkdir -p "$home_dir/cli" "$home_dir/bin" || return 1
  chmod 700 "$home_dir" 2>/dev/null || true
  local cli="$home_dir/cli/evolink.mjs"
  local tmp="$cli.tmp.$$"
  cat >"$tmp" <<'__EVOLINK_CLI_EOF__'
#!/usr/bin/env node
// EvoLink CLI: one-command setup for Claude Code and Codex on EvoLink.
// Zero dependencies. Requires Node.js >= 18. macOS / Linux / Windows.
//
//   evolink setup [codex]    configure Claude Code (default) or the Codex CLI
//   evolink doctor [codex]   read-only diagnostics plus a redacted report for support
//   evolink reset [codex]    undo the changes made by `evolink setup`

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.4.0';
export const DEFAULT_BASE_URL = 'https://direct.evolink.ai';
export const DEFAULT_MAX_OUTPUT_TOKENS = 0; // 0 = leave unset (Claude Code's own default); --max-output-tokens 32000 lowers the per-request hold
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
// What Claude Code 2.1.284+ sends for the "sonnet" alias (09-29 live test); EvoLink only served it from 09-30. Setup pins
// ANTHROPIC_DEFAULT_SONNET_MODEL to the newest Sonnet the key can use so the next switch cannot break the alias either;
// doctor warns when an unpinned alias would fail.
const CLAUDE_CODE_SONNET_ALIAS = 'claude-sonnet-5-5';
const RESTRICTIVE_POLICIES = new Set(['Restricted', 'AllSigned', 'Undefined']);
const DLP_KEY = 'claudeCode.disableLoginPrompt';
const CLAUDE_EXTENSION = 'anthropic.claude-code';
const CODEX_EXTENSION = 'openai.chatgpt';

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

// Newest "claude-sonnet-*" the key can use: 5-5 > 5 > 4-6 > 4-5-20250929 > 4-20250514; null when there is none.
export function pickSonnetPin(ids) {
  let best = null;
  for (const id of ids) {
    const m = /^claude-sonnet-(\d+)((?:-\d+)*)$/.exec(id);
    if (!m) continue;
    const rest = m[2].split('-').filter(Boolean);
    const minor = rest.length && rest[0].length <= 2 ? Number(rest[0]) : 0; // a 6+ digit segment is a date, not a minor version
    const rank = [Number(m[1]), minor, rest.some((seg) => seg.length >= 6) ? 0 : 1];
    const newer = !best || rank.reduce((acc, v, i) => (acc !== 0 ? acc : Math.sign(v - best.rank[i])), 0) > 0;
    if (newer) best = { id, rank };
  }
  return best ? best.id : null;
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

function hasExtension(ed, extId) {
  try {
    const prefix = `${extId.toLowerCase()}-`;
    return fs.readdirSync(path.join(os.homedir(), ed.ext, 'extensions')).some((n) => n.toLowerCase().startsWith(prefix));
  } catch {
    return false;
  }
}

// Editors that have the Claude Code extension installed and have been opened at least once
// (or whose extension setup has just installed: `also` lists them by name).
export function detectEditors({ also = [] } = {}) {
  const out = [];
  for (const ed of EDITORS) {
    if (!hasExtension(ed, CLAUDE_EXTENSION)) continue;
    const settings = editorSettingsPath(ed.app);
    if (isDir(path.dirname(settings)) || also.includes(ed.name)) out.push({ name: ed.name, settings });
  }
  return out;
}

// Editors (desktop, or the server side of a Remote-SSH / WSL session on this machine) that have an extension.
const EXTENSION_HOMES = [...EDITORS, { name: 'VS Code Server', ext: '.vscode-server' }, { name: 'Cursor Server', ext: '.cursor-server' }, { name: 'Windsurf Server', ext: '.windsurf-server' }];
export function editorsWithExtension(extId) {
  return EXTENSION_HOMES.filter((ed) => hasExtension(ed, extId)).map((ed) => ed.name);
}

// Editors opened at least once that lack an extension: setup names the install link at the end.
export function editorsMissing(extId) {
  return EDITORS.filter((ed) => EXTENSION_LINKS[ed.name] && isDir(path.dirname(editorSettingsPath(ed.app))) && !hasExtension(ed, extId)).map((ed) => ed.name);
}

// Install links documented by Anthropic and OpenAI for their extensions.
const EXTENSION_LINKS = { 'VS Code': 'vscode', 'VS Code Insiders': 'vscode-insiders', Cursor: 'cursor' };
export const extensionLink = (editor, extId) => `${EXTENSION_LINKS[editor] || 'vscode'}:extension/${extId}`;

// Command-line launchers that can install extensions. macOS keeps `code` inside the app bundle until
// "Shell Command: Install 'code' command in PATH" is run, so look there too. In a VS Code Remote-SSH
// terminal, `code` on PATH is the remote CLI and installs into the remote server.
const EDITOR_CLIS = [
  { name: 'VS Code', cmd: 'code', mac: 'Visual Studio Code.app', win: 'Microsoft VS Code' },
  { name: 'VS Code Insiders', cmd: 'code-insiders', mac: 'Visual Studio Code - Insiders.app', win: 'Microsoft VS Code Insiders' },
  { name: 'Cursor', cmd: 'cursor', mac: 'Cursor.app', win: 'cursor' },
  { name: 'Windsurf', cmd: 'windsurf', mac: 'Windsurf.app', win: 'Windsurf' },
  { name: 'VSCodium', cmd: 'codium', mac: 'VSCodium.app', win: 'VSCodium' },
];

export function findEditorClis() {
  const out = [];
  for (const ed of EDITOR_CLIS) {
    const candidates = which(ed.cmd).filter((p) => !/\.ps1$/i.test(p));
    // A test home must not reach the real editors in /Applications (tests put fake CLIs on PATH instead).
    if (process.platform === 'darwin' && !sandboxHome()) {
      for (const root of ['/Applications', path.join(os.homedir(), 'Applications')]) candidates.push(path.join(root, ed.mac, 'Contents', 'Resources', 'app', 'bin', ed.cmd));
    } else if (process.platform === 'win32') {
      const roots = [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs'), process.env.ProgramFiles].filter(Boolean);
      for (const root of roots) candidates.push(path.join(root, ed.win, 'bin', `${ed.cmd}.cmd`));
    }
    const cli = candidates.find((p) => isFile(p));
    if (cli) out.push({ name: ed.name, cli });
  }
  return out;
}

// Install an editor extension with each editor's own CLI (`code --install-extension <id>`); skips editors that have it.
async function installExtension(extId, opts) {
  const results = [];
  const clis = findEditorClis();
  if (!clis.length) {
    ui.warn(L(`没有找到 VS Code 等编辑器的命令行（code），装不了扩展。可以在编辑器里打开 ${extensionLink('VS Code', extId)} 安装。`, `No editor command line (code) found, so the extension cannot be installed here. Open ${extensionLink('VS Code', extId)} in the editor instead.`));
    return results;
  }
  for (const { name, cli } of clis) {
    const listed = run(cli, ['--list-extensions'], { timeout: 60000 });
    if (listed.code === 0 && listed.stdout.split(/\r?\n/).some((l) => l.trim().toLowerCase() === extId.toLowerCase())) {
      ui.ok(L(`${name} 已装 ${extId}`, `${name} already has ${extId}`));
      results.push({ editor: name, action: 'already' });
      continue;
    }
    if (opts.dryRun) {
      ui.info(L(`预览（--dry-run）：会运行 ${tildify(cli)} --install-extension ${extId}`, `Preview (--dry-run): would run ${tildify(cli)} --install-extension ${extId}`));
      results.push({ editor: name, action: 'would_install' });
      continue;
    }
    ui.info(L(`正在给 ${name} 安装扩展 ${extId}…`, `Installing ${extId} into ${name}…`));
    const r = run(cli, ['--install-extension', extId], { timeout: 300000 });
    if (r.code === 0) {
      ui.ok(L(`${name}：扩展 ${extId} 安装完成`, `${name}: ${extId} installed`));
      results.push({ editor: name, action: 'installed' });
    } else {
      const why = `${r.stderr || r.stdout || r.error?.message || ''}`.trim().split(/\r?\n/).pop();
      ui.warn(L(`${name}：扩展安装失败（${why || `退出码 ${r.code}`}）。可以在编辑器里打开 ${extensionLink(name, extId)} 手动安装。`, `${name}: install failed (${why || `exit ${r.code}`}). Open ${extensionLink(name, extId)} in the editor to install it.`));
      results.push({ editor: name, action: 'failed', error: why || `exit ${r.code}` });
    }
  }
  return results;
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
          '余额偏低：Opus 等高价模型每次请求会先按输出上限预留额度，不够就会报"余额不足"。加 --max-output-tokens 32000 可把单次预留降到约原来的四分之一。',
          'Low balance: pricey models such as Opus hold credits per request based on the output limit and fail with "insufficient credits" when the hold does not fit. Add --max-output-tokens 32000 to cut the hold to about a quarter.',
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
  if (CODEX_TARGETS.includes(target)) return cmdSetupCodex(opts);
  if (COPILOT_TARGETS.includes(target)) return cmdSetupCopilot(opts);
  if (!['claude-code', 'claude'].includes(target)) {
    throw new CliError(L(`暂不支持 ${target}，目前支持 claude-code、codex 和 copilot。`, `${target} is not supported yet; claude-code, codex and copilot are.`), EXIT.USAGE);
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
  // The terminal CLI works without the editor extension, so it is installed only on request (--install-extension).
  const extensions = opts.installExtension ? await installExtension(CLAUDE_EXTENSION, opts) : [];
  if (extensions.length) result.extensions = extensions;
  if (claude.installed && claude.version && !opts.skipChecks) {
    const latest = await latestNpmVersion(opts);
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
  const editors = opts.vscode === false ? [] : detectEditors({ also: extensions.filter((e) => e.action === 'installed').map((e) => e.editor) });
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
  return installWithNpm({ pkg: CLAUDE_PKG, label: 'Claude Code', bin: 'claude', nodeMin: 22, detect: detectClaude, guide }, opts, interactive);
}

// Installs a CLI with `npm install -g` from whichever registry answers (npmjs or npmmirror); never in a dry run.
async function installWithNpm({ pkg, label, bin, nodeMin = 0, detect, guide }, opts, interactive) {
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
  if (nodeMajor < nodeMin) {
    ui.warn(L(`当前 Node.js ${process.versions.node}，${label} 要求 ${nodeMin} 或更高（旧版本通常也能装上，但会有警告）。`, `Node.js ${process.versions.node} is older than the ${nodeMin} ${label} asks for; install usually works with a warning.`));
  }
  const reg = await pickRegistry(opts, pkg);
  if (!reg) {
    ui.err(L('npm 官方源和 npmmirror 都连不上。', 'Neither npmjs nor npmmirror is reachable.'));
    guide();
    return { installed: false };
  }
  const args = ['install', '-g', pkg, `--registry=${reg.url}`];
  const ver = reg.version ? ` ${reg.version}` : '';
  if (opts.dryRun) {
    ui.info(L(`预览（--dry-run）：会从 ${reg.name} 安装 ${label}${ver}，这次不安装：`, `Preview (--dry-run): would install ${label}${ver} from ${reg.name}; not installing now:`));
    ui.sub(`npm ${args.join(' ')}`);
    return { installed: false };
  }
  ui.info(L(`将从 ${reg.name} 安装 ${label}${ver}：`, `Installing ${label}${ver} from ${reg.name}:`));
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
  const c = detect();
  if (c.installed) ui.ok(L(`${label} ${c.version || ''} 安装完成`, `${label} ${c.version || ''} installed`));
  else {
    const prefix = run(npm, ['prefix', '-g']).stdout.trim();
    ui.warn(L(`已经装好，但当前终端还找不到 ${bin} 命令。请打开新终端再试。`, `Installed, but this terminal cannot find ${bin} yet. Open a new terminal.`));
    if (prefix) ui.sub(L(`npm 全局目录：${prefix}（需要在 PATH 里）`, `npm global folder: ${prefix} (must be on PATH)`));
  }
  return c.installed ? c : { installed: false };
}

async function pickRegistry(opts, pkg = CLAUDE_PKG) {
  if (opts.registry) return { name: opts.registry, url: opts.registry.replace(/\/+$/, '') };
  const probe = async (name, url) => {
    const r = await http('GET', `${url}/${pkg}/latest`, { timeout: 8000 });
    return { name, url, ok: r.ok, ms: r.ms, version: r.json?.version };
  };
  const [a, b] = await Promise.all([probe('npmjs', REGISTRIES.npmjs), probe('npmmirror', REGISTRIES.npmmirror)]);
  if (a.ok && (!b.ok || a.ms <= b.ms * 1.5 + 300)) return a;
  if (b.ok) return b;
  return null;
}

// Newest version of a package on npm (the --registry if given, else whichever of npmjs / npmmirror answers first); null when offline.
async function latestNpmVersion(opts, pkg = CLAUDE_PKG) {
  const urls = opts.registry ? [opts.registry.replace(/\/+$/, '')] : Object.values(REGISTRIES);
  const probes = urls.map(async (url) => {
    const r = await http('GET', `${url}/${pkg}/latest`, { timeout: 6000 });
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

async function obtainAndCheckKey(opts, interactive, base, existingKey, { tool = 'claude' } = {}) {
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
      if (check.ok && tool === 'copilot') {
        const chat = copilotModelIds(check.ids, { all: true }).models.length;
        ui.ok(L(`Key 有效（${maskKey(key)}）· 可用模型 ${check.count} 个，其中可以在 Chat 里用的 ${chat} 个`, `Key is valid (${maskKey(key)}) · ${check.count} models, ${chat} usable in Chat`));
        printBalance(check.balance);
        return { key, check };
      }
      if (check.ok && tool === 'codex') {
        const gpt = codexModelIds(check.ids).length;
        ui.ok(L(`Key 有效（${maskKey(key)}）· 可用模型 ${check.count} 个，其中 GPT ${gpt} 个`, `Key is valid (${maskKey(key)}) · ${check.count} models, ${gpt} GPT`));
        printBalance(check.balance);
        return { key, check };
      }
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
  if (opts.disableNonessentialTraffic === true) set.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  const remove = [];
  if (decision.action === 'set') set.ANTHROPIC_MODEL = decision.model;
  if (decision.action === 'default') remove.push('ANTHROPIC_MODEL');
  for (const v of MODEL_OVERRIDE_VARS) {
    if (v === 'ANTHROPIC_MODEL') continue;
    if (hasOwn(env, v) && env[v] !== '' && known && !modelAvailable(env[v], ids)) remove.push(v);
  }
  // Claude Code 2.1.284 moved the "sonnet" alias to claude-sonnet-5-5 a day or two before EvoLink served it (09-29 live test):
  // pin the alias to the newest Sonnet this key can use, unless the user already has a usable pin of their own.
  if (opts.pinSonnet !== false && known) {
    const own = hasOwn(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL') ? env.ANTHROPIC_DEFAULT_SONNET_MODEL : undefined;
    const ownOk = own !== undefined && own !== '' && !MODEL_ALIASES.has(String(own).toLowerCase()) && modelAvailable(own, ids);
    const pin = pickSonnetPin(ids);
    if (pin && !ownOk) set.ANTHROPIC_DEFAULT_SONNET_MODEL = pin;
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
  // Claude Code 2.1.283+ starts in auto mode, whose review requests EvoLink cannot serve yet (09-28 live test:
  // every reviewed action is blocked after 4 billed retries). Keep users in the classic prompt mode until the gateway is fixed.
  if (opts.autoMode !== true && settings.disableAutoMode !== 'disable') {
    topChanges.push({ key: 'disableAutoMode', before: settings.disableAutoMode, after: 'disable', changed: true });
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
  for (const c of plan.settings.topChanges) out.push({ file: plan.settings.file, key: c.key, before: c.before === undefined ? null : String(c.before), after: c.after === undefined ? null : c.after });
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
  ANTHROPIC_DEFAULT_SONNET_MODEL: ['/model 里的 Sonnet 用它：这把 Key 能用的最新 Sonnet，Claude Code 以后换默认 Sonnet 也不会选到 EvoLink 还没有的模型', 'used for the Sonnet alias: the newest Sonnet this key can use, so a later Claude Code default EvoLink lacks cannot break it'],
  disableAutoMode: ['先关掉 auto mode：EvoLink 暂不支持它的审核请求，开着会被拦并计费；网关修好后重跑 setup --auto-mode 即可恢复', 'auto mode off for now: EvoLink cannot serve its review requests yet (actions get blocked and billed); re-run setup --auto-mode once the gateway supports it'],
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
  for (const c of s.topChanges) {
    if (c.key === 'model') ui.print(`    model  ${c.before} → ${L('（删除：这把 Key 用不了）', '(removed: not usable with this key)')}`);
    else ui.print(`    ${c.key}  ${displayValue('', c.before)} → ${displayValue('', c.after)}${WHY[c.key] ? ui.dim(`  ${L(...WHY[c.key])}`) : ''}`);
  }
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
    for (const c of s.topChanges) {
      if (c.after === undefined) delete next[c.key];
      else next[c.key] = c.after;
    }
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
  const missing = editorsMissing(CLAUDE_EXTENSION);
  if (missing.length) {
    const link = extensionLink(missing[0], CLAUDE_EXTENSION);
    ui.print(`  ${ui.mark('dot')} ${L(`想在 ${missing.join(' / ')} 里用 Claude Code：在编辑器里打开 ${link} 安装扩展，或重新运行 setup 并加 --install-extension`, `To use Claude Code in ${missing.join(' / ')}: open ${link} in the editor to install the extension, or re-run setup with --install-extension`)}`);
  }
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
// config.toml editing (for `setup codex --vscode`: the Codex extension reads only the main config.toml). Not a TOML
// library: it finds where every statement starts and ends (multi-line strings, arrays and inline tables included),
// rewrites whole statements, and leaves every other byte as it was, line endings and comments included.

export class TomlSyntaxError extends Error {
  constructor(line, what) {
    super(`config.toml line ${line}: ${what}`);
    this.line = line;
  }
}

const tomlSkipWs = (s, p) => {
  while (s[p] === ' ' || s[p] === '\t') p++;
  return p;
};
const tomlSkipComment = (s, p) => {
  while (p < s.length && s[p] !== '\n') p++;
  return p;
};
// Whitespace, line breaks and comments, as allowed between the items of an array.
const tomlSkipGap = (s, p) => {
  for (;;) {
    p = tomlSkipWs(s, p);
    if (s[p] === '\n' || s[p] === '\r') p++;
    else if (s[p] === '#') p = tomlSkipComment(s, p);
    else return p;
  }
};

function tomlReadString(s, p, fail) {
  for (const q of ['"""', "'''"]) {
    if (!s.startsWith(q, p)) continue;
    let i = p + 3;
    for (;;) {
      const e = s.indexOf(q, i);
      if (e < 0) fail(p, 'unterminated multi-line string');
      let bs = 0;
      for (let k = e - 1; q === '"""' && k >= i && s[k] === '\\'; k--) bs++;
      if (bs % 2) {
        i = e + 1;
        continue;
      }
      let end = e + 3;
      while (s[end] === q[0] && end - e < 5) end++;
      return end;
    }
  }
  const quote = s[p];
  let i = p + 1;
  while (i < s.length && s[i] !== quote && s[i] !== '\n') i += quote === '"' && s[i] === '\\' ? 2 : 1;
  if (s[i] !== quote) fail(p, 'unterminated string');
  return i + 1;
}

function tomlReadKey(s, p, fail) {
  const parts = [];
  for (;;) {
    p = tomlSkipWs(s, p);
    if (s[p] === '"' || s[p] === "'") {
      if (s.startsWith(s[p].repeat(3), p)) fail(p, 'a key cannot be a multi-line string');
      const e = tomlReadString(s, p, fail);
      parts.push(tomlDecodeString(s.slice(p, e)));
      p = e;
    } else {
      let q = p;
      while (q < s.length && /[A-Za-z0-9_-]/.test(s[q])) q++;
      if (q === p) fail(p, 'expected a key');
      parts.push(s.slice(p, q));
      p = q;
    }
    const after = tomlSkipWs(s, p);
    if (s[after] !== '.') return { parts, end: p };
    p = after + 1;
  }
}

function tomlReadValue(s, p, fail) {
  const c = s[p];
  if (c === '"' || c === "'") return tomlReadString(s, p, fail);
  if (c === '[' || c === '{') {
    const close = c === '[' ? ']' : '}';
    p++;
    for (;;) {
      p = tomlSkipGap(s, p);
      if (s[p] === close) return p + 1;
      if (p >= s.length) fail(p, `unclosed ${c}`);
      if (c === '{') {
        p = tomlSkipWs(s, tomlReadKey(s, p, fail).end);
        if (s[p] !== '=') fail(p, 'expected "="');
        p = tomlSkipWs(s, p + 1);
      }
      p = tomlSkipGap(s, tomlReadValue(s, p, fail));
      if (s[p] === ',') p++;
      else if (s[p] !== close) fail(p, `expected "," or "${close}"`);
    }
  }
  // Numbers, booleans, dates; a date and a time may be separated by one space.
  let q = p;
  while (q < s.length && !/[\s,\]}#]/.test(s[q])) q++;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s.slice(p, q)) && s[q] === ' ' && /\d/.test(s[q + 1] || '')) {
    q++;
    while (q < s.length && !/[\s,\]}#]/.test(s[q])) q++;
  }
  if (q === p) fail(p, 'expected a value');
  return q;
}

// The value of a TOML string literal; other values come back as their raw text.
export function tomlDecodeString(raw) {
  const r = String(raw);
  const multi = r.startsWith('"""') || r.startsWith("'''");
  const q = multi ? r.slice(0, 3) : r[0];
  if (q !== '"' && q !== "'" && q !== '"""' && q !== "'''") return r;
  let body = r.slice(q.length, r.length - q.length);
  if (multi) body = body.replace(/^\r?\n/, '');
  if (q[0] === "'") return body;
  if (multi) body = body.replace(/\\[ \t]*\r?\n[\s]*/g, '');
  const esc = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };
  return body.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_, e) => (e.length > 1 ? String.fromCodePoint(parseInt(e.slice(1), 16)) : esc[e] ?? `\\${e}`));
}

// Statements with their line ranges (inclusive, 0-based): { kind: 'blank' | 'comment' | 'table' | 'array' | 'kv',
// start, end, table (the enclosing table's key path; [] at the top), name (headers), key / value / tail (kv) }.
export function parseTomlStatements(text) {
  const s = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');
  const starts = [0];
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') starts.push(i + 1);
  const lineOf = (p) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= p) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const fail = (p, what) => {
    throw new TomlSyntaxError(lineOf(p) + 1, what);
  };
  const out = [];
  let table = [];
  let p = 0;
  while (p < s.length) {
    let q = tomlSkipWs(s, p);
    let st;
    if (q >= s.length || s[q] === '\n') st = { kind: 'blank', table };
    else if (s[q] === '#') {
      q = tomlSkipComment(s, q);
      st = { kind: 'comment', table };
    } else if (s[q] === '[') {
      const array = s[q + 1] === '[';
      const k = tomlReadKey(s, q + (array ? 2 : 1), fail);
      q = tomlSkipWs(s, k.end);
      if (array ? !s.startsWith(']]', q) : s[q] !== ']') fail(q, 'unclosed table header');
      q += array ? 2 : 1;
      table = k.parts;
      st = { kind: array ? 'array' : 'table', name: k.parts, table };
    } else {
      const k = tomlReadKey(s, q, fail);
      q = tomlSkipWs(s, k.end);
      if (s[q] !== '=') fail(q, 'expected "="');
      const v0 = tomlSkipWs(s, q + 1);
      const v1 = tomlReadValue(s, v0, fail);
      st = { kind: 'kv', key: k.parts, value: s.slice(v0, v1), table, indent: s.slice(p, tomlSkipWs(s, p)) };
      q = v1;
      const eol = s.indexOf('\n', q);
      st.tail = s.slice(q, eol < 0 ? s.length : eol);
    }
    q = tomlSkipWs(s, q);
    if (s[q] === '#') q = tomlSkipComment(s, q);
    if (q < s.length && s[q] !== '\n') fail(q, 'unexpected text after the value');
    st.start = lineOf(p);
    st.end = lineOf(q < s.length ? q : Math.max(p, s.length - 1));
    out.push(st);
    p = q + 1;
  }
  return out;
}

const tomlPathEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const tomlPathStarts = (a, prefix) => a.length >= prefix.length && prefix.every((x, i) => a[i] === x);

// The file as lines plus the line break after each one, so untouched lines keep CRLF or LF exactly as they were.
function tomlDoc(text) {
  const raw = String(text ?? '');
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const pieces = raw.slice(bom.length).split(/(\r?\n)/);
  const lines = [];
  for (let i = 0; i < pieces.length; i += 2) lines.push({ t: pieces[i], e: pieces[i + 1] ?? '' });
  const crlf = lines.filter((l) => l.e === '\r\n').length;
  const lf = lines.filter((l) => l.e === '\n').length;
  return { bom, lines, eol: crlf > lf ? '\r\n' : '\n', sts: parseTomlStatements(raw) };
}
const tomlText = (doc) => doc.bom + doc.lines.map((l) => l.t + l.e).join('');

// Replaces lines a..b (inclusive; b = a - 1 inserts before line a) with new lines of text. The last new line keeps
// the line break of the last replaced one (none at the end of a file that has none).
function tomlSplice(doc, a, b, texts) {
  const repl = texts.map((t) => ({ t, e: doc.eol }));
  if (repl.length && b >= a) repl[repl.length - 1].e = doc.lines[b].e;
  doc.lines.splice(a, b - a + 1, ...repl);
}

// Appends lines at the end of the file, which then ends with a line break.
function tomlAppend(doc, texts) {
  const L = doc.lines;
  if (L.length && L[L.length - 1].t === '' && L[L.length - 1].e === '') L.pop();
  if (L.length && L[L.length - 1].e === '') L[L.length - 1].e = doc.eol;
  for (const t of texts) L.push({ t, e: doc.eol });
  L.push({ t: '', e: '' });
}

const tomlTopKv = (sts, key) => sts.find((st) => st.kind === 'kv' && st.table.length === 0 && tomlPathEq(st.key, [key]));
const stLines = (doc, st) => doc.lines.slice(st.start, st.end + 1).map((l) => l.t);

// A top-level key: { value (decoded when it is a string), raw, lines (the statement's exact text) }, or undefined.
export function tomlTopValue(text, key) {
  const doc = tomlDoc(text);
  const st = tomlTopKv(doc.sts, key);
  return st ? { value: tomlDecodeString(st.value), raw: st.value, lines: stLines(doc, st) } : undefined;
}

// Sets a top-level key to a raw TOML value (or to exact statement lines, `{ lines }`), keeping a trailing comment.
// New keys go after the last top-level key, before the first [table].
export function setTomlTop(text, key, rawValue) {
  const doc = tomlDoc(text);
  const st = tomlTopKv(doc.sts, key);
  const texts = Array.isArray(rawValue?.lines) ? rawValue.lines : [`${st ? st.indent : ''}${key} = ${rawValue}${st && st.start === st.end && /^\s*(#.*)?$/.test(st.tail) ? st.tail : ''}`];
  if (st) {
    tomlSplice(doc, st.start, st.end, texts);
    return tomlText(doc);
  }
  const firstHeader = doc.sts.findIndex((x) => x.kind === 'table' || x.kind === 'array');
  const top = firstHeader < 0 ? doc.sts : doc.sts.slice(0, firstHeader);
  const lastKv = [...top].reverse().find((x) => x.kind === 'kv');
  let at;
  if (lastKv) at = lastKv.end + 1;
  else {
    // After a leading comment block that is followed by a blank line (a file header), else at the very top.
    let i = 0;
    while (i < top.length && top[i].kind === 'comment') i++;
    at = i > 0 && top[i]?.kind === 'blank' ? top[i].end + 1 : 0;
  }
  if (at >= doc.lines.length || (at === doc.lines.length - 1 && doc.lines[at].t === '' && doc.lines[at].e === '')) tomlAppend(doc, texts);
  else tomlSplice(doc, at, at - 1, texts);
  return tomlText(doc);
}

export function deleteTomlTop(text, key) {
  const doc = tomlDoc(text);
  const st = tomlTopKv(doc.sts, key);
  if (!st) return String(text ?? '');
  tomlSplice(doc, st.start, st.end, []);
  return tomlText(doc);
}

// A [table] from its header to its last key (comments right before the next header belong to that one).
function tomlFindTable(sts, name) {
  const i = sts.findIndex((x) => x.kind === 'table' && tomlPathEq(x.name, name));
  if (i < 0) return null;
  let j = i + 1;
  while (j < sts.length && sts[j].kind !== 'table' && sts[j].kind !== 'array') j++;
  const body = sts.slice(i + 1, j);
  const lastKv = [...body].reverse().find((x) => x.kind === 'kv');
  return { header: sts[i], body, start: sts[i].start, end: (lastKv || sts[i]).end, after: lastKv || sts[i] };
}

// { pairs: { key: decoded value }, lines: the table's exact text } for a [table], or null.
export function readTomlTable(text, name) {
  const doc = tomlDoc(text);
  const t = tomlFindTable(doc.sts, name);
  if (!t) return null;
  const pairs = {};
  for (const st of t.body) if (st.kind === 'kv' && st.key.length === 1) pairs[st.key[0]] = tomlDecodeString(st.value);
  return { pairs, lines: doc.lines.slice(t.start, t.end + 1).map((l) => l.t) };
}

// Sets keys inside a [table], creating it at the end of the file (after a comment line) when missing.
export function upsertTomlTable(text, name, entries, comment = null) {
  let doc = tomlDoc(text);
  if (!tomlFindTable(doc.sts, name)) {
    const header = `[${name.map((n) => (/^[A-Za-z0-9_-]+$/.test(n) ? n : tomlString(n))).join('.')}]`;
    const block = [...(comment ? [comment] : []), header, ...entries.map(([k, v]) => `${k} = ${v}`)];
    // A blank line of its own before the new table (unless the file is empty): removing the table takes exactly that
    // line with it, so the file comes back byte for byte.
    const content = doc.lines.filter((l, i) => !(i === doc.lines.length - 1 && l.t === '' && l.e === ''));
    if (!content.length) doc.lines = [];
    tomlAppend(doc, [...(content.length ? [''] : []), ...block]);
    return tomlText(doc);
  }
  for (const [k, v] of entries) {
    const t = tomlFindTable(doc.sts, name);
    const st = t.body.find((x) => x.kind === 'kv' && tomlPathEq(x.key, [k]));
    if (st) tomlSplice(doc, st.start, st.end, [`${st.indent}${k} = ${v}${st.start === st.end && /^\s*(#.*)?$/.test(st.tail) ? st.tail : ''}`]);
    else tomlSplice(doc, t.after.end + 1, t.after.end, [`${k} = ${v}`]);
    doc = tomlDoc(tomlText(doc));
  }
  return tomlText(doc);
}

// Replaces a [table] (header to last key) with exact lines, or removes it with `lines = null`; a comment line equal to
// `comment` right above the header and one blank line around it go too.
export function replaceTomlTable(text, name, lines, comment = null) {
  const doc = tomlDoc(text);
  const t = tomlFindTable(doc.sts, name);
  if (!t) return String(text ?? '');
  let a = t.start;
  if (comment && a > 0 && doc.lines[a - 1].t === comment) a--;
  if (lines) {
    tomlSplice(doc, a, t.end, lines);
    return tomlText(doc);
  }
  if (a > 0 && doc.lines[a - 1].t.trim() === '') a--;
  tomlSplice(doc, a, t.end, []);
  return tomlText(doc);
}

// Places where `name` is also defined some other way (dotted keys, inline tables, [[array]] headers, a second
// [header]): writing a [name] table next to them would make the file invalid.
export function tomlTableConflicts(text, name) {
  const lines = [];
  let headers = 0;
  for (const st of parseTomlStatements(text)) {
    if (st.kind === 'table' && tomlPathEq(st.name, name)) headers++;
    if (st.kind === 'array' && tomlPathStarts(st.name, name)) lines.push(st.start + 1);
    if (st.kind !== 'kv') continue;
    const full = [...st.table, ...st.key];
    const inside = tomlPathStarts(st.table, name);
    if (!inside && tomlPathStarts(full, name)) lines.push(st.start + 1);
  }
  if (headers > 1) lines.push('duplicate');
  return lines;
}

// ---------------------------------------------------------------------------
// Codex CLI: `evolink setup codex` writes a separate profile, so `codex -p evolink` goes through EvoLink while a
// plain `codex` keeps the user's own setup. The main config.toml is never touched in this mode.

const CODEX_PKG = '@openai/codex';
const CODEX_PROFILE = 'evolink';
// Not "evolink": our docs taught [model_providers.evolink] with env_key = "OPENAI_API_KEY" in config.toml, and a profile
// deep-merges into config.toml, so that env_key would win over the key written here (Codex 0.159.2 source).
const CODEX_PROVIDER = 'evolink-cli';
const CODEX_TARGETS = ['codex', 'codex-cli'];

// Offered in the interactive picker, filtered by what the key can use; the first usable one is the default. All are in
// Codex 0.159's own model list (so no "metadata not found" warning) and none triggers its model-migration prompt.
export const RECOMMENDED_CODEX_MODELS = [
  { id: 'gpt-6.1-sol', zh: 'Codex 默认的模型，性价比高', en: "Codex's own default; good value" },
  { id: 'gpt-6-sol', zh: '上一版 Sol，价格相同', en: 'the previous Sol, same price' },
  { id: 'gpt-6-astra', zh: '最强，单价也最高', en: 'strongest; most expensive' },
  { id: 'gpt-6-luna', zh: '最便宜、最快，适合轻量任务', en: 'cheapest and fastest' },
];

export function codexPaths() {
  const home = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  return { home, profile: path.join(home, `${CODEX_PROFILE}.config.toml`), config: path.join(home, 'config.toml') };
}

// GPT text models the key can use. Every one answers on /v1/responses (09-30 live test), but /v1/models does not say
// which endpoint a model supports (GPT models all list only "openai"), so image models are filtered out by name.
export function codexModelIds(ids) {
  return [...ids].filter((id) => /^gpt-\d/i.test(id) && !/image/i.test(id)).sort();
}

export function detectCodex() {
  const found = which('codex').filter((p) => !/\.ps1$/i.test(p));
  if (!found.length) return { installed: false };
  const r = run(found[0], ['--version'], { timeout: 30000 });
  const m = /(\d+\.\d+\.\d+)/.exec(`${r.stdout}\n${r.stderr}`);
  return { installed: true, path: found[0], version: m ? m[1] : null };
}

async function maybeInstallCodex(opts, interactive) {
  const guide = () => {
    ui.sub(L('可以这样安装 Codex：', 'Install Codex like this:'));
    ui.sub(`  npm install -g ${CODEX_PKG}${L(`（中国大陆加 --registry=${REGISTRIES.npmmirror}）`, `   (mainland China: add --registry=${REGISTRIES.npmmirror})`)}`);
    if (process.platform === 'darwin') ui.sub(L('  或者：brew install --cask codex', '  or: brew install --cask codex'));
    ui.sub(L('配置可以先写好，装好 Codex 后直接生效。', 'The profile can be written now and works once Codex is installed.'));
  };
  return installWithNpm({ pkg: CODEX_PKG, label: 'Codex', bin: 'codex', detect: detectCodex, guide }, opts, interactive);
}

const tomlString = (s) => JSON.stringify(String(s));

// Keys setup manages in the profile. Codex itself also writes into the profile ([tui] on the first launch, [projects."…"]
// when a folder is trusted, [notice] …; 09-30 live test), and users may add their own settings: those are kept.
const CODEX_MANAGED_KEYS = new Set(['model', 'model_provider', 'web_search', 'approvals_reviewer']);
const CODEX_PROVIDER_TABLE = `model_providers.${CODEX_PROVIDER}`;

// Written in one piece: setup's keys and provider table, then whatever else the file held (`kept`, from splitCodexProfile).
export function renderCodexProfile({ base, key, model, reviewer = null, kept = { top: '', tables: '' } }) {
  const lines = [
    '# EvoLink profile for Codex, written by `evolink setup codex` (https://github.com/deeplearning-goethe/evolink-cli).',
    `# Start Codex with:  codex -p ${CODEX_PROFILE}        Undo:  evolink reset codex`,
    '# Your own config.toml is not changed. This file holds your EvoLink key: keep it private.',
    `model = ${tomlString(model)}`,
    `model_provider = ${tomlString(CODEX_PROVIDER)}`,
    // EvoLink does not run OpenAI's hosted web search tool.
    'web_search = "disabled"',
  ];
  // config.toml turns on automatic approval review, whose codex-auto-review model EvoLink does not serve: every reviewed
  // command would be denied. Only written when config.toml asks for it.
  if (reviewer) lines.push(`approvals_reviewer = ${tomlString(reviewer)}`);
  // Top-level keys must come before the first [table], or TOML files them under it.
  if (kept.top) lines.push(kept.top);
  lines.push(
    '',
    `[${CODEX_PROVIDER_TABLE}]`,
    'name = "EvoLink"',
    `base_url = ${tomlString(`${base}/v1`)}`,
    'wire_api = "responses"',
    // A key in the file reaches the CLI and the VS Code extension alike (an env_key variable does not reach apps started
    // from the Dock), and Codex keeps it out of its logs and session files (09-30 live test, Codex 0.159.2).
    `experimental_bearer_token = ${tomlString(key)}`,
  );
  if (kept.tables) lines.push('', kept.tables);
  return `${lines.join('\n')}\n`;
}

// Splits a profile into setup's part (`core`: the managed keys and the provider table, as written) and everything else
// (`top`: other top-level lines, `tables`: other tables). `ours` tells whether setup's provider table is still there.
export function splitCodexProfile(text) {
  const core = [];
  const top = [];
  const tables = [];
  let table = null;
  let ours = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    const h = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (h) {
      table = h[1].replace(/"/g, '').replace(/\s+/g, '');
      if (table === CODEX_PROVIDER_TABLE) {
        ours = true;
        core.push(line.trim());
      } else tables.push(line);
      continue;
    }
    if (table === CODEX_PROVIDER_TABLE) {
      if (line.trim()) core.push(line.trim());
    } else if (table !== null) tables.push(line);
    else if (line.trim() && !/^\s*#/.test(line)) {
      const kv = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
      if (kv && CODEX_MANAGED_KEYS.has(kv[1])) core.push(line.trim());
      else top.push(line);
    }
  }
  return { core: core.join('\n'), top: top.join('\n').trim(), tables: tables.join('\n').trim(), ours };
}
export const codexProfileCore = (text) => splitCodexProfile(text).core;

// Settings in config.toml that a `-p evolink` session inherits or trips over (a profile layers on top of config.toml).
export function scanCodexConfig(text) {
  const out = { profileTable: false, legacyProfile: null, autoReview: false, evolinkEnvKey: null };
  let table = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const h = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (h) {
      table = h[1].replace(/"/g, '').replace(/\s+/g, '');
      if (table === `profiles.${CODEX_PROFILE}`) out.profileTable = true;
      continue;
    }
    const kv = /^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/.exec(line);
    if (!kv) continue;
    if (table === null && kv[1] === 'profile') out.legacyProfile = kv[2];
    if (table === null && kv[1] === 'approvals_reviewer' && ['auto_review', 'guardian_subagent'].includes(kv[2])) out.autoReview = true;
    if (table === 'model_providers.evolink' && kv[1] === 'env_key') out.evolinkEnvKey = kv[2];
  }
  return out;
}

// Reads back the keys setup writes (doctor, and reusing the key on a re-run). Not a general TOML parser.
export function parseCodexProfile(text) {
  const out = {};
  for (const k of ['model', 'model_provider', 'model_catalog_json', 'web_search', 'approvals_reviewer', 'base_url', 'wire_api', 'experimental_bearer_token', 'env_key']) {
    const m = new RegExp(`^[ \\t]*${k}[ \\t]*=[ \\t]*"((?:[^"\\\\\\n]|\\\\.)*)"`, 'm').exec(String(text || ''));
    if (!m) continue;
    try {
      out[k] = JSON.parse(`"${m[1]}"`);
    } catch {
      out[k] = m[1];
    }
  }
  return out;
}

// The key setup offers to reuse: an earlier Codex profile first, then config.toml (VS Code mode), then Claude Code.
function existingCodexKey(paths) {
  if (isFile(paths.profile)) {
    const p = parseCodexProfile(fs.readFileSync(paths.profile, 'utf8'));
    if (p.experimental_bearer_token && isEvolinkUrl(p.base_url || '')) return p.experimental_bearer_token;
  }
  if (isFile(paths.config)) {
    const t = readCodexMainConfig(fs.readFileSync(paths.config, 'utf8')).table;
    if (t?.experimental_bearer_token && isEvolinkUrl(t.base_url || '')) return t.experimental_bearer_token;
  }
  return existingEvolinkKey(readJson(claudePaths().settings).data);
}

async function decideCodexModel(opts, interactive, current, ids) {
  const known = ids.size > 0;
  const usable = codexModelIds(ids);
  if (known && !usable.length) {
    throw new CliError(L('这把 Key 没有开通任何 GPT 模型，Codex 用不了；请在控制台调整 Key 的模型范围。', 'This key has no GPT models, so Codex cannot use it. Adjust the key in the dashboard.'), EXIT.AUTH);
  }
  const ok = (m) => !known || usable.includes(m);
  const suggest = (m) => {
    const s = suggestModel(m, new Set(usable));
    return s ? L(`，你是不是想用 ${s}？`, `; did you mean ${s}?`) : '';
  };
  if (opts.model) {
    const m = opts.model.trim();
    if (!ok(m)) throw new CliError(L(`这把 Key 在 Codex 里用不了模型 ${m}`, `This key cannot use model ${m} in Codex`) + (suggest(m) || L('。', '.')), EXIT.AUTH);
    ui.ok(L(`默认模型：${m}`, `Default model: ${m}`));
    return m;
  }
  const recommended = RECOMMENDED_CODEX_MODELS.filter((r) => ok(r.id));
  const fallback = recommended[0]?.id || usable[usable.length - 1] || RECOMMENDED_CODEX_MODELS[0].id;
  const currentOk = !!current && ok(current);
  if (current && !currentOk) ui.warn(L(`现在配置的模型 ${current} 这把 Key 用不了，将改用 ${fallback}。`, `The configured model ${current} is not available for this key; switching to ${fallback}.`));
  if (!interactive) {
    const m = currentOk ? current : fallback;
    ui.ok(currentOk ? L(`保持现有模型：${m}`, `Keeping model: ${m}`) : L(`默认模型：${m}`, `Default model: ${m}`));
    return m;
  }
  const options = [];
  if (currentOk) options.push({ label: L(`保持现有设置：${current}`, `Keep current: ${current}`), value: current });
  for (const r of recommended) if (r.id !== current) options.push({ label: r.id, note: L(r.zh, r.en), value: r.id });
  options.push({ label: L('手动输入模型 ID', 'Type a model ID'), value: null });
  const idx = await choose(L('Codex 默认用哪个模型？（之后在 Codex 里输入 /model 随时能换）', 'Which model should Codex use by default? (switch any time with /model)'), options, 0);
  let m = options[idx].value;
  while (!m) {
    const t = (await askLine(L('  模型 ID：', '  Model ID: '))).trim();
    if (!t) continue;
    if (ok(t)) m = t;
    else ui.warn(L(`这把 Key 在 Codex 里用不了 ${t}`, `This key cannot use ${t} in Codex`) + suggest(t));
  }
  return m;
}

// What config.toml means for `codex -p evolink`: errors stop Codex outright; info explains an old setup that stays as is.
function codexConfigNotes(mainConfig, paths) {
  const file = tildify(paths.config);
  const notes = [];
  if (mainConfig.profileTable) {
    notes.push({
      level: 'error',
      text: L(
        `${file} 里有 [profiles.${CODEX_PROFILE}] 这一段：新版 Codex 遇到它会直接报错，codex -p ${CODEX_PROFILE} 起不来。请把这一整段删掉（它已经被独立配置档取代）。`,
        `${file} has a [profiles.${CODEX_PROFILE}] table: current Codex refuses to start codex -p ${CODEX_PROFILE} while it exists. Delete that table (the profile file replaces it).`,
      ),
    });
  }
  if (mainConfig.legacyProfile) {
    notes.push({
      level: 'error',
      all: true,
      text: L(
        `${file} 里有 profile = "${mainConfig.legacyProfile}"：新版 Codex 不再支持这种写法，所有 codex 命令都会报错。请删掉这一行（要用某个配置档时改用 codex -p 名字）。`,
        `${file} sets profile = "${mainConfig.legacyProfile}", which current Codex rejects for every command. Delete that line (pick a profile with codex -p <name> instead).`,
      ),
    });
  }
  if (mainConfig.evolinkEnvKey) {
    notes.push({
      level: 'info',
      text: L(
        `${file} 里有旧教程写的 [model_providers.evolink]（Key 取自环境变量 ${mainConfig.evolinkEnvKey}）：直接运行 codex 仍按它走；codex -p ${CODEX_PROFILE} 用本工具写的配置，不受它影响。`,
        `${file} has an older [model_providers.evolink] setup (key from ${mainConfig.evolinkEnvKey}): plain codex still uses it; codex -p ${CODEX_PROFILE} uses this tool's profile and is not affected.`,
      ),
    });
  }
  return notes;
}

function buildCodexPlan({ base, key, model, paths, mainConfig }) {
  const existed = isFile(paths.profile);
  const before = existed ? fs.readFileSync(paths.profile, 'utf8') : null;
  const reviewer = mainConfig.autoReview ? 'user' : null;
  const content = renderCodexProfile({ base, key, model, reviewer, kept: before ? splitCodexProfile(before) : undefined });
  const changed = before === null || codexProfileCore(before) !== codexProfileCore(content);
  return { files: [{ kind: 'profile', file: paths.profile, content, existed, changed }], base, key, model, reviewer, mainConfig };
}

function printCodexPlan(plan, paths) {
  ui.print('');
  for (const f of plan.files) {
    const tag = !f.existed ? L('  （新建）', '  (new file)') : f.changed ? L('  （替换，原文件先备份）', '  (replaced; the old file is backed up first)') : L('  （无需改动）', '  (unchanged)');
    ui.print(`  ${tildify(f.file)}${tag}`);
    if (f.kind === 'profile') {
      ui.print(`    model_provider  → ${CODEX_PROVIDER}${ui.dim(`  ${plan.base}/v1 · Responses API`)}`);
      ui.print(`    model           → ${plan.model}`);
      ui.print(`    ${L('Key', 'key')}             → ${maskKey(plan.key)}${ui.dim(`  ${L('只存在这个文件里，只有你能读', 'kept in this file, readable only by you')}`)}`);
      ui.print(`    web_search      → disabled${ui.dim(`  ${L('EvoLink 不提供 OpenAI 自带的联网搜索', "EvoLink does not run OpenAI's hosted web search")}`)}`);
      if (plan.reviewer) ui.print(`    approvals_reviewer → user${ui.dim(`  ${L('你的 config.toml 开了自动审批审核，它用的 codex-auto-review 模型 EvoLink 没有，开着会拒绝执行命令', 'your config.toml turns on automatic approval review; EvoLink does not serve its codex-auto-review model, so reviewed commands would be denied')}`)}`);
    }
  }
  ui.print(`  ${tildify(paths.config)}${ui.dim(`  ${L('不改：直接运行 codex 仍是你原来的设置', 'not changed: plain `codex` keeps your own setup')}`)}`);
}

function applyCodexPlan(plan) {
  const state = loadState();
  const cx = (state.codex ||= { files: {} });
  const backup = newBackupSession();
  const written = [];
  for (const f of plan.files) {
    if (!f.changed) continue;
    let original = null;
    if (f.existed && !cx.files[f.file]) {
      // A file setup did not write: keep a copy outside the rotating backups, so reset can put it back.
      original = path.join(evolinkHome(), 'originals', `codex-${path.basename(f.file)}`);
      fs.mkdirSync(path.dirname(original), { recursive: true, mode: 0o700 });
      fs.copyFileSync(f.file, original);
      try {
        fs.chmodSync(original, 0o600);
      } catch {}
    }
    if (f.existed) backupFile(backup, f.file, `codex-${path.basename(f.file)}`);
    writeAtomic(f.file, f.content);
    if (!cx.files[f.file]) cx.files[f.file] = { existed: f.existed, original };
    written.push(f.file);
  }
  cx.updatedAt = new Date().toISOString();
  saveState(state);
  pruneBackups();
  return { written, backupDir: backup.files.length ? backup.dir : null };
}

// ---------------------------------------------------------------------------
// Codex in VS Code: `evolink setup codex --vscode`. The extension (openai.chatgpt) runs its bundled `codex app-server`,
// which reads only the main config.toml, never a profile, so EvoLink becomes the model provider there. A custom
// provider needs no OpenAI sign-in: app-server answers account/read with requiresOpenaiAuth = false and the extension
// skips its login page (Codex 0.159.2 source and live test, 10-01). A plain `codex` then uses EvoLink as well.

const CODEX_PROVIDER_PATH = ['model_providers', CODEX_PROVIDER];
const CODEX_VSCODE_MARK = '# EvoLink, added by `evolink setup codex --vscode` (undo: evolink reset codex)';
const AUTO_REVIEWERS = new Set(['auto_review', 'guardian_subagent']);

// What the VS Code mode looks at in config.toml (null: not set). `error` when the file is not valid TOML.
export function readCodexMainConfig(text) {
  const out = { error: null, provider: null, model: null, webSearch: null, reviewer: null, legacyProfile: null, table: null, conflicts: [] };
  try {
    const get = (k) => tomlTopValue(text, k)?.value ?? null;
    out.provider = get('model_provider');
    out.model = get('model');
    out.webSearch = get('web_search');
    out.reviewer = get('approvals_reviewer');
    out.legacyProfile = get('profile');
    out.table = readTomlTable(text, CODEX_PROVIDER_PATH)?.pairs || null;
    out.conflicts = tomlTableConflicts(text, CODEX_PROVIDER_PATH);
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// What reset compares against: the provider table still points where setup pointed it, with the same key.
const codexTableSignature = (pairs) => hashValue(JSON.stringify([pairs?.base_url ?? null, pairs?.experimental_bearer_token ?? null, pairs?.wire_api ?? null]));

// The edits to config.toml; `changes` keeps each top-level key's exact lines from before, for reset.
export function planCodexMainConfig(text, { base, key, model }) {
  const original = String(text ?? '');
  let t = original;
  const changes = [];
  const set = (k, v) => {
    const cur = tomlTopValue(t, k);
    const changed = !cur || cur.value !== v;
    changes.push({ key: k, before: cur ? cur.lines : null, beforeValue: cur ? cur.value : undefined, after: v, changed });
    if (changed) t = setTomlTop(t, k, tomlString(v));
  };
  set('model_provider', CODEX_PROVIDER);
  set('model', model);
  // EvoLink does not run OpenAI's hosted web search tool.
  set('web_search', 'disabled');
  // Automatic approval review asks for codex-auto-review, which EvoLink does not serve: reviewed commands would be denied.
  if (AUTO_REVIEWERS.has(tomlTopValue(t, 'approvals_reviewer')?.value)) set('approvals_reviewer', 'user');
  const old = readTomlTable(t, CODEX_PROVIDER_PATH);
  t = upsertTomlTable(
    t,
    CODEX_PROVIDER_PATH,
    [
      ['name', '"EvoLink"'],
      ['base_url', tomlString(`${base}/v1`)],
      ['wire_api', '"responses"'],
      // In the file, the key reaches the extension however VS Code was started (a variable set in a shell profile does
      // not reach an app opened from the Dock), and Codex keeps it out of its logs and session files.
      ['experimental_bearer_token', tomlString(key)],
    ],
    CODEX_VSCODE_MARK,
  );
  const now = readTomlTable(t, CODEX_PROVIDER_PATH);
  const table = { existed: !!old, before: old ? old.lines : null, after: codexTableSignature(now.pairs), changed: !old || old.lines.join('\n') !== now.lines.join('\n') };
  return { text: t, changes, table, changed: t !== original, base, key, model };
}

// Undo what setup recorded, key by key; anything changed since (or added by Codex, such as trusted folders) stays.
export function planCodexMainRestore(text, rec) {
  const original = String(text ?? '');
  let t = original;
  const restored = [];
  const skipped = [];
  for (const [k, r] of Object.entries(rec.keys || {})) {
    if (hashValue(tomlTopValue(t, k)?.value) !== r.after) {
      skipped.push(k);
      continue;
    }
    t = r.existed ? setTomlTop(t, k, { lines: r.before }) : deleteTomlTop(t, k);
    restored.push(k);
  }
  let keyRemoved = false;
  if (rec.table) {
    const cur = readTomlTable(t, CODEX_PROVIDER_PATH);
    if (cur && codexTableSignature(cur.pairs) === rec.table.after) {
      t = replaceTomlTable(t, CODEX_PROVIDER_PATH, rec.table.existed ? rec.table.before : null, CODEX_VSCODE_MARK);
      restored.push(`[${CODEX_PROVIDER_TABLE}]`);
      keyRemoved = true;
    } else if (cur) skipped.push(`[${CODEX_PROVIDER_TABLE}]`);
  }
  return { text: t, restored, skipped, changed: t !== original, remove: !rec.existed && t.trim() === '', keyRemoved };
}

function printCodexMainPlan(plan, paths) {
  ui.print('');
  const existed = isFile(paths.config);
  const tag = !existed ? L('  （新建）', '  (new file)') : plan.changed ? L('  （修改，原文件先备份）', '  (changed; backed up first)') : L('  （无需改动）', '  (unchanged)');
  ui.print(`  ${tildify(paths.config)}${tag}`);
  const show = (k, note = '') => {
    const c = plan.changes.find((x) => x.key === k);
    if (!c) return;
    const value = c.changed ? `${c.beforeValue === undefined ? '' : `${c.beforeValue} → `}${c.after}` : `${c.after}${L('（不变）', ' (kept)')}`;
    ui.print(`    ${k.padEnd(19)}${value}${note ? ui.dim(`  ${note}`) : ''}`);
  };
  show('model_provider', `${plan.base}/v1 · Responses API`);
  show('model');
  ui.print(`    ${L('Key', 'key').padEnd(19)}${maskKey(plan.key)}${ui.dim(`  ${L(`写在 [${CODEX_PROVIDER_TABLE}] 里，文件改成只有你能读写`, `kept in [${CODEX_PROVIDER_TABLE}]; the file becomes readable only by you`)}`)}`);
  show('web_search', L('EvoLink 不提供 OpenAI 自带的联网搜索', "EvoLink does not run OpenAI's hosted web search"));
  show('approvals_reviewer', L('自动审批审核要用的 codex-auto-review 模型 EvoLink 没有，开着会拒绝执行命令', 'automatic approval review needs codex-auto-review, which EvoLink does not serve'));
  ui.print(ui.dim(`    ${L('其他设置（MCP、信任的文件夹、注释等）都不动', 'everything else (MCP servers, trusted folders, comments) stays as it is')}`));
}

function applyCodexMainPlan(plan, paths) {
  const state = loadState();
  const cx = (state.codex ||= { files: {} });
  const file = paths.config;
  const existed = isFile(file);
  if (!cx.config || cx.config.file !== file) {
    let mode = null;
    if (existed && process.platform !== 'win32') {
      try {
        mode = fs.statSync(file).mode & 0o777;
      } catch {}
    }
    cx.config = { file, existed, mode, keys: {}, table: null };
  }
  const rec = cx.config;
  const backup = newBackupSession();
  if (existed) backupFile(backup, file, 'codex-config.toml');
  // Owner-only from now on: the file holds the key.
  writeAtomic(file, plan.text);
  for (const c of plan.changes) {
    if (!c.changed) continue;
    if (rec.keys[c.key]) rec.keys[c.key].after = hashValue(c.after);
    else rec.keys[c.key] = { existed: c.before !== null, before: c.before, after: hashValue(c.after) };
  }
  if (rec.table) rec.table.after = plan.table.after;
  else rec.table = { existed: plan.table.existed, before: plan.table.before, after: plan.table.after };
  cx.updatedAt = new Date().toISOString();
  saveState(state);
  pruneBackups();
  return { backupDir: backup.files.length ? backup.dir : null };
}

// Codex speaks the Responses API; a dozen tokens is enough to prove the key and the model.
async function testResponses(base, key, model) {
  const r = await http('POST', `${base}/v1/responses`, { key, timeout: 90000, body: { model, input: 'ping', max_output_tokens: 16 } });
  return r.ok ? { ok: true, model, ms: r.ms } : { ok: false, model, failure: describeFailure(r), ms: r.ms };
}

async function cmdSetupCodex(opts) {
  const interactive = !opts.yes && !opts.json;
  const vscode = opts.vscode === true;
  const result = { command: 'setup', target: 'codex', mode: vscode ? 'vscode' : 'profile', version: VERSION, ok: false, warnings: [] };
  const baseNorm = normalizeBaseUrl(opts.baseUrl || process.env.EVOLINK_BASE_URL || DEFAULT_BASE_URL);
  if (baseNorm.error) throw new CliError(L('接口地址格式不对，应类似 https://direct.evolink.ai', 'Invalid base URL; expected something like https://direct.evolink.ai'), EXIT.USAGE);
  const base = baseNorm.url;

  if (vscode) {
    ui.title(L(`EvoLink 一键配置 · Codex（VS Code 扩展）  v${VERSION}`, `EvoLink setup · Codex in VS Code  v${VERSION}`));
    ui.print(ui.dim(L('Codex 扩展只读主配置 config.toml，所以要在里面把 EvoLink 设为模型提供方：扩展和终端里直接运行的 codex 都会走 EvoLink。改之前自动备份，随时可以撤销。', 'The Codex extension reads only the main config.toml, so EvoLink becomes the model provider there: the extension and a plain `codex` in the terminal both use EvoLink. Everything is backed up first and can be undone.')));
  } else {
    ui.title(L(`EvoLink 一键配置 · Codex  v${VERSION}`, `EvoLink setup · Codex  v${VERSION}`));
    ui.print(ui.dim(L(`只新建一个 Codex 配置档（${CODEX_PROFILE}），你原来的 config.toml 不动；改之前自动备份，随时可以撤销。`, `Only adds a Codex profile ("${CODEX_PROFILE}"); your config.toml is left alone. Everything is backed up first and can be undone.`)));
  }
  const sandbox = sandboxHome();
  if (sandbox) {
    ui.info(
      vscode
        ? L(
            `测试模式：HOME 是 ${sandbox.home}，只改这里面的配置，你真实的家目录 ${sandbox.real} 不受影响（安装扩展除外，可加 --no-install-extension）。`,
            `Test mode: HOME is ${sandbox.home}; only settings under it change and your real home ${sandbox.real} is left alone (except installing the extension; add --no-install-extension).`,
          )
        : L(
            `测试模式：HOME 是 ${sandbox.home}，只改这里面的配置，你真实的家目录 ${sandbox.real} 不受影响（自动安装 Codex 除外，可加 --no-install）。`,
            `Test mode: HOME is ${sandbox.home}; only settings under it change and your real home ${sandbox.real} is left alone (except installing Codex; add --no-install).`,
          ),
    );
  }

  // [1/5] environment
  ui.step(1, 5, L('检查环境', 'Environment'));
  ui.ok(`${osLabel()} · Node ${process.versions.node}`);
  const paths = codexPaths();
  let codex = detectCodex();
  if (codex.installed) ui.ok(`Codex ${codex.version || '?'}  ${ui.dim(tildify(codex.path))}`);
  else if (vscode) ui.info(L('没有装 Codex 命令行：VS Code 扩展自带 Codex，用不到它。', 'The Codex CLI is not installed; the VS Code extension brings its own Codex.'));
  else {
    // The profile does nothing without Codex itself, so it is installed by default (--no-install skips it).
    ui.warn(L('没有找到 Codex。', 'Codex is not installed.'));
    codex = await maybeInstallCodex(opts, interactive);
  }
  result.codex = { installed: codex.installed, version: codex.version || null, path: codex.path || null };
  if (codex.installed && codex.version && !opts.skipChecks) {
    const latest = await latestNpmVersion(opts, CODEX_PKG);
    if (latest && compareVersions(codex.version, latest) < 0) {
      ui.warn(L(`Codex 有新版本 ${latest}（当前 ${codex.version}），建议更新：npm install -g ${CODEX_PKG}@latest`, `Codex ${latest} is available (you have ${codex.version}); update with: npm install -g ${CODEX_PKG}@latest`));
      result.codex.latest = latest;
    }
  }
  let mainText = '';
  let main = null;
  if (vscode) {
    const have = editorsWithExtension(CODEX_EXTENSION);
    if (have.length) ui.ok(L(`Codex 扩展：${have.join('、')}`, `Codex extension: ${have.join(', ')}`));
    else if (opts.installExtension === false) ui.info(L('还没装 Codex 扩展（加了 --no-install-extension，不自动安装）', 'The Codex extension is not installed (--no-install-extension: not installing it)'));
    else ui.info(L('还没装 Codex 扩展：写好配置后自动安装', 'The Codex extension is not installed yet; it is installed after the config is written'));
    result.extension = { installedIn: have };
    mainText = isFile(paths.config) ? fs.readFileSync(paths.config, 'utf8') : '';
    main = readCodexMainConfig(mainText);
    if (main.error) {
      throw new CliError(L(`${tildify(paths.config)} 格式有误，没法安全地修改（${main.error}）。请先修好，再重新运行。`, `${tildify(paths.config)} is not valid TOML, so it cannot be edited safely (${main.error}). Fix it first, then run setup again.`), EXIT.CONFIG);
    }
    if (main.conflicts.length) {
      const where = main.conflicts.map((l) => (l === 'duplicate' ? L('重复的表头', 'a repeated header') : L(`第 ${l} 行`, `line ${l}`))).join(L('、', ', '));
      throw new CliError(
        L(`${tildify(paths.config)} 里已经用别的写法定义了 ${CODEX_PROVIDER_TABLE}（${where}），自动修改会让文件失效。请删掉这些内容，再重新运行。`, `${tildify(paths.config)} already defines ${CODEX_PROVIDER_TABLE} another way (${where}); editing it would break the file. Remove that, then run setup again.`),
        EXIT.CONFIG,
      );
    }
    ui.ok(isFile(paths.config) ? tildify(paths.config) : L(`${tildify(paths.config)}（还没有，会新建）`, `${tildify(paths.config)} (not there yet; will be created)`));
  }

  // [2/5] key
  ui.step(2, 5, L('API Key', 'API key'));
  const current = vscode ? { model: main.model } : isFile(paths.profile) ? parseCodexProfile(fs.readFileSync(paths.profile, 'utf8')) : {};
  const { key, check } = await obtainAndCheckKey(opts, interactive, base, existingCodexKey(paths), { tool: 'codex' });
  result.key = maskKey(key);
  const ids = check?.ids || new Set();
  if (check) result.api = { models: check.count, gptModels: codexModelIds(ids).length, balance: check.balance };

  // [3/5] model
  ui.step(3, 5, L('模型', 'Model'));
  const model = await decideCodexModel(opts, interactive, current.model || null, ids);
  result.model = model;

  const ctx = { opts, interactive, result, base, key, model, ids, paths, codex, sandbox };
  return vscode ? finishCodexVscode({ ...ctx, mainText, main }) : finishCodexProfile(ctx);
}

// [4/5] and [5/5] of `setup codex`: the profile.
async function finishCodexProfile({ opts, interactive, result, base, key, model, ids, paths, codex, sandbox }) {
  ui.step(4, 5, L('确认改动', 'Review changes'));
  const mainConfig = scanCodexConfig(isFile(paths.config) ? fs.readFileSync(paths.config, 'utf8') : '');
  const plan = buildCodexPlan({ base, key, model, paths, mainConfig });
  printCodexPlan(plan, paths);
  for (const n of codexConfigNotes(mainConfig, paths)) {
    if (n.level === 'error') {
      ui.warn(n.text);
      result.warnings.push(n.text);
    } else ui.info(n.text);
  }
  const pending = plan.files.filter((f) => f.changed).length;
  result.changes = plan.files.map((f) => ({ file: f.file, action: !f.existed ? 'create' : f.changed ? 'replace' : 'keep' }));
  if (opts.dryRun) {
    ui.print('');
    ui.info(L('这是预览（--dry-run），没有写入任何文件。', 'Preview only (--dry-run); nothing was written.'));
    result.ok = true;
    result.dryRun = true;
    return finish(result, opts);
  }
  if (pending === 0) ui.ok(L('配置已经是最新的，不需要改动。', 'Already up to date; nothing to change.'));
  else if (interactive && !(await confirm(L('确认写入？', 'Apply these changes?'), true))) throw new CancelledError();

  ui.step(5, 5, L('写入并验证', 'Apply and verify'));
  if (pending > 0) {
    const applied = applyCodexPlan(plan);
    if (applied.backupDir) ui.ok(L(`已备份原文件到 ${tildify(applied.backupDir)}`, `Backed up originals to ${tildify(applied.backupDir)}`));
    for (const f of applied.written) ui.ok(L(`已写入 ${tildify(f)}`, `Wrote ${tildify(f)}`));
    result.backupDir = applied.backupDir;
    result.written = applied.written;
  }
  await codexTestRequest({ opts, interactive, result, base, key, model, ids });
  result.ok = !result.test || result.test.ok;
  printCodexNextSteps({ codex, sandbox });
  return finish(result, opts, result.ok ? EXIT.OK : EXIT.AUTH);
}

// [4/5] and [5/5] of `setup codex --vscode`: config.toml, then the extension.
async function finishCodexVscode({ opts, interactive, result, base, key, model, ids, paths, sandbox, mainText, main }) {
  const cmd = sandboxPrefix(sandbox) + commandHint(sandbox);
  ui.step(4, 5, L('确认改动', 'Review changes'));
  const plan = planCodexMainConfig(mainText, { base, key, model });
  printCodexMainPlan(plan, paths);
  if (opts.installExtension !== false && !editorsWithExtension(CODEX_EXTENSION).length) {
    ui.print(`  ${L('Codex 扩展', 'Codex extension')} ${CODEX_EXTENSION}${ui.dim(`  ${L('写好配置后用编辑器的命令行安装（不想装：加 --no-install-extension）', 'installed with the editor command line after the config is written (--no-install-extension skips it)')}`)}`);
  }
  if (main.legacyProfile) {
    const text = L(`${tildify(paths.config)} 里有 profile = "${main.legacyProfile}"：新版 Codex 不再支持这种写法，扩展和 codex 都会报错。请删掉这一行。`, `${tildify(paths.config)} sets profile = "${main.legacyProfile}", which current Codex rejects (the extension and codex both fail). Delete that line.`);
    ui.warn(text);
    result.warnings.push(text);
  }
  if (scanCodexConfig(mainText).evolinkEnvKey) {
    ui.info(L('旧教程写的 [model_providers.evolink] 保留不动，之后不再使用（撤销时 model_provider 会改回原来的值）。', 'The older [model_providers.evolink] table stays as is but is no longer used (reset puts model_provider back).'));
  }
  result.changes = [{ file: paths.config, action: !isFile(paths.config) ? 'create' : plan.changed ? 'modify' : 'keep', keys: plan.changes.filter((c) => c.changed).map((c) => c.key), providerTable: plan.table.changed }];
  if (opts.dryRun) {
    if (opts.installExtension !== false) result.extensions = await installExtension(CODEX_EXTENSION, opts);
    ui.print('');
    ui.info(L('这是预览（--dry-run），没有写入任何文件。', 'Preview only (--dry-run); nothing was written.'));
    result.ok = true;
    result.dryRun = true;
    return finish(result, opts);
  }
  if (!plan.changed) ui.ok(L('配置已经是最新的，不需要改动。', 'Already up to date; nothing to change.'));
  else if (interactive) {
    ui.print('');
    ui.warn(L('这会让 VS Code（以及 Cursor 等）里的 Codex 扩展、终端里直接运行的 codex，都改走 EvoLink。', 'The Codex extension in VS Code (and Cursor and similar editors) and a plain `codex` in the terminal will all use EvoLink.'));
    if (isFile(path.join(paths.home, 'auth.json'))) ui.sub(L('你登录的 ChatGPT 账号保留不动，只是暂时不用；撤销后恢复原来的设置。', 'Your ChatGPT sign-in stays but goes unused; reset brings your own setup back.'));
    ui.sub(L('Key 会写进 config.toml，文件权限改成只有你能读写；如果你用 git 等同步这个文件，请先把它排除。', 'The key goes into config.toml, which becomes readable only by you; if you sync that file (git, dotfiles), exclude it first.'));
    ui.sub(L(`随时可以撤销：${cmd} reset codex`, `Undo any time: ${cmd} reset codex`));
    if (!(await confirm(L('确认修改 config.toml？', 'Change config.toml?'), false))) throw new CancelledError();
  }

  ui.step(5, 5, L('写入并验证', 'Apply and verify'));
  if (plan.changed) {
    const applied = applyCodexMainPlan(plan, paths);
    if (applied.backupDir) ui.ok(L(`已备份原文件到 ${tildify(applied.backupDir)}`, `Backed up originals to ${tildify(applied.backupDir)}`));
    ui.ok(L(`已写入 ${tildify(paths.config)}`, `Wrote ${tildify(paths.config)}`));
    result.backupDir = applied.backupDir;
    result.written = [paths.config];
  }
  // Without the extension this mode does nothing in the editor, so it is installed by default (09-30 rule).
  if (opts.installExtension !== false) result.extensions = await installExtension(CODEX_EXTENSION, opts);
  await codexTestRequest({ opts, interactive, result, base, key, model, ids });
  result.ok = !result.test || result.test.ok;
  printCodexVscodeNextSteps({ sandbox });
  return finish(result, opts, result.ok ? EXIT.OK : EXIT.AUTH);
}

async function codexTestRequest({ opts, interactive, result, base, key, model, ids }) {
  if (opts.skipChecks || opts.test === false || !ids.size) return;
  if (interactive && !(await confirm(L(`发一条测试消息确认能用吗？（模型 ${model}，十几个 token，费用约 0.01 Credits）`, `Send a tiny test request with ${model}? (a dozen tokens, about 0.01 credits)`), true))) return;
  const t = await testResponses(base, key, model);
  result.test = t.ok ? { ok: true, model, ms: t.ms } : { ok: false, model, error: t.failure };
  if (t.ok) ui.ok(L(`测试通过：${model} 正常返回（${t.ms} ms）`, `Test passed: ${model} answered (${t.ms} ms)`));
  else for (const line of failureLines(t.failure, base)) ui.err(line);
}

const CODEX_TOKENS_NOTE = () => L('Codex 每轮都会带上很长的系统提示和工具说明：一句简单的话也要约 9 千个输入 token。', 'Codex sends a long system prompt and tool list every turn: even a one-line question costs about 9K input tokens.');

function printCodexNextSteps({ codex, sandbox }) {
  const cmd = sandboxPrefix(sandbox) + commandHint(sandbox);
  ui.print('');
  ui.title(`${ui.mark('ok')} ${L('配置完成', 'All set')}`);
  const n = [];
  if (!codex.installed) {
    n.push(L(`先安装 Codex：npm install -g ${CODEX_PKG}（中国大陆加 --registry=${REGISTRIES.npmmirror}）`, `Install Codex first: npm install -g ${CODEX_PKG} (in mainland China add --registry=${REGISTRIES.npmmirror})`));
  }
  if (sandbox) {
    n.push(L(`测试模式：在这个终端里用 ${sandboxPrefix(sandbox)}codex -p ${CODEX_PROFILE} 启动（不带 HOME 就会用你真实的配置）`, `Test mode: start it with ${sandboxPrefix(sandbox)}codex -p ${CODEX_PROFILE} in this terminal (without HOME it uses your real settings)`));
  } else {
    n.push(L('打开一个新的终端窗口，进入你的项目文件夹：cd 你的项目路径', 'Open a new terminal and go to your project: cd <your project>'));
    n.push(L(`运行：codex -p ${CODEX_PROFILE}`, `Run: codex -p ${CODEX_PROFILE}`));
  }
  n.forEach((line, i) => ui.print(`  ${i + 1}. ${line}`));
  ui.print(`  ${ui.mark('dot')} ${L(`带 -p ${CODEX_PROFILE} 才走 EvoLink；直接运行 codex 仍是你原来的设置（ChatGPT 账号或你自己的 config.toml）。`, `EvoLink is used only with -p ${CODEX_PROFILE}; plain codex keeps your own setup (ChatGPT sign-in or your config.toml).`)}`);
  ui.print(`  ${ui.mark('dot')} ${L('在 Codex 里输入 /model 可以换成这把 Key 能用的其他 GPT 模型。', 'Inside Codex, /model switches to any other GPT model this key can use.')}`);
  ui.print(`  ${ui.mark('dot')} ${L('第一次在某个文件夹启动会问是否信任它，按提示选即可；启动时提示 "Running without the shared background server" 是正常的（带 -p 时 Codex 都这样）。', 'The first launch in a folder asks whether to trust it; answer as you like. The note "Running without the shared background server" is normal with -p.')}`);
  ui.print(`  ${ui.mark('dot')} ${CODEX_TOKENS_NOTE()}`);
  // The extension never reads a profile: point at the mode that covers it.
  if (editorsWithExtension(CODEX_EXTENSION).length) {
    ui.print(`  ${ui.mark('dot')} ${L(`编辑器里装了 Codex 扩展：扩展不认配置档，还是原来的设置。想让它也走 EvoLink：${cmd} setup codex --vscode（会修改 config.toml）`, `The Codex extension in your editor ignores profiles and keeps your own setup. To route it through EvoLink too: ${cmd} setup codex --vscode (changes config.toml)`)}`);
  }
  ui.print('');
  ui.print(`  ${L('撤销本次配置：', 'Undo these changes: ')}${cmd} reset codex`);
  ui.print(`  ${L('遇到问题：运行 ', 'Having trouble? Run ')}${cmd} doctor codex${L('，把输出发给客服（Key 会自动隐去）', ' and send the output to support (your key is hidden)')}`);
}

function printCodexVscodeNextSteps({ sandbox }) {
  const cmd = sandboxPrefix(sandbox) + commandHint(sandbox);
  ui.print('');
  ui.title(`${ui.mark('ok')} ${L('配置完成', 'All set')}`);
  const n = [];
  if (!editorsWithExtension(CODEX_EXTENSION).length) {
    n.push(L(`安装 Codex 扩展：在 VS Code 里打开 ${extensionLink('VS Code', CODEX_EXTENSION)}，或在扩展页搜索 Codex（发布者 OpenAI）`, `Install the Codex extension: open ${extensionLink('VS Code', CODEX_EXTENSION)} in VS Code, or search the Extensions view for Codex (publisher OpenAI)`));
  }
  n.push(L('VS Code 已经开着的话：在命令面板运行 "Developer: Reload Window"，或者重启 VS Code', 'If VS Code is already open: run "Developer: Reload Window" from the Command Palette, or restart VS Code'));
  n.push(L('打开 Codex 面板直接对话，不需要登录 ChatGPT', 'Open the Codex panel and start chatting; no ChatGPT sign-in is needed'));
  n.forEach((line, i) => ui.print(`  ${i + 1}. ${line}`));
  ui.print(`  ${ui.mark('dot')} ${L('终端里直接运行 codex 也会走 EvoLink（读的是同一个 config.toml）。', 'A plain `codex` in the terminal uses EvoLink too (same config.toml).')}`);
  ui.print(`  ${ui.mark('dot')} ${L('在扩展的模型菜单里（或 codex 里输入 /model）可以换成这把 Key 能用的其他 GPT 模型。', "Switch to any other GPT model this key can use from the extension's model menu (or /model in codex).")}`);
  ui.print(`  ${ui.mark('dot')} ${L('用 VS Code Remote-SSH 时，这条命令要在远端的终端里运行：扩展在远端运行，读的是远端的配置。', 'With VS Code Remote-SSH, run this command in the remote terminal: the extension runs there and reads the remote config.')}`);
  ui.print(`  ${ui.mark('dot')} ${CODEX_TOKENS_NOTE()}`);
  ui.print('');
  ui.print(`  ${L('撤销本次配置：', 'Undo these changes: ')}${cmd} reset codex`);
  ui.print(`  ${L('遇到问题：运行 ', 'Having trouble? Run ')}${cmd} doctor codex${L('，把输出发给客服（Key 会自动隐去）', ' and send the output to support (your key is hidden)')}`);
}

async function cmdDoctorCodex(opts) {
  const report = { command: 'doctor', target: 'codex', version: VERSION, problems: [], warnings: [], summary: [] };
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
  ui.title(L(`EvoLink 诊断 · Codex v${VERSION} · ${new Date().toLocaleString('zh-CN', { hour12: false })}`, `EvoLink doctor · Codex v${VERSION} · ${new Date().toISOString()}`));

  const paths = codexPaths();
  const mainText = isFile(paths.config) ? fs.readFileSync(paths.config, 'utf8') : '';
  const main = readCodexMainConfig(mainText);
  // VS Code mode: config.toml itself points at EvoLink (the extension reads only that file).
  const vscodeMode = main.provider === CODEX_PROVIDER || !!main.table;
  const hasProfile = isFile(paths.profile);
  const vscodeOnly = vscodeMode && !hasProfile;

  ui.step(1, 4, L('环境', 'Environment'));
  const osl = osLabel();
  ui.ok(`${osl} · Node ${process.versions.node}`);
  const codex = detectCodex();
  let latest = null;
  if (codex.installed) {
    ui.ok(`Codex ${codex.version || '?'}  ${ui.dim(tildify(codex.path))}`);
    if (codex.version) {
      latest = await latestNpmVersion(opts, CODEX_PKG);
      if (latest && compareVersions(codex.version, latest) < 0) warn(L(`Codex 有新版本 ${latest}（当前 ${codex.version}），建议更新：npm install -g ${CODEX_PKG}@latest`, `Codex ${latest} is available (you have ${codex.version}); update with: npm install -g ${CODEX_PKG}@latest`));
    }
  } else if (vscodeOnly) ui.info(L('没有装 Codex 命令行：VS Code 扩展自带 Codex，用不到它', 'The Codex CLI is not installed; the VS Code extension brings its own Codex'));
  else problem(L('没有找到 Codex', 'Codex is not installed'));
  report.summary.push(`evolink-doctor ${VERSION} codex | ${osl} | node ${process.versions.node} | codex ${codex.installed ? codex.version || '?' : 'missing'}${latest ? ` (latest ${latest})` : ''}`);

  ui.step(2, 4, L('配置', 'Configuration'));
  let prof = {};
  let catalogState = '-';
  if (!hasProfile && !vscodeMode) problem(L(`${tildify(paths.profile)} 不存在，还没配置过（运行 ${cmd} setup codex；VS Code 扩展用 ${cmd} setup codex --vscode）`, `${tildify(paths.profile)} does not exist; run ${cmd} setup codex (for the VS Code extension: ${cmd} setup codex --vscode)`));
  if (hasProfile) {
    prof = parseCodexProfile(fs.readFileSync(paths.profile, 'utf8'));
    ui.ok(tildify(paths.profile));
    if (prof.model_provider !== CODEX_PROVIDER) problem(L(`model_provider = ${prof.model_provider || '（没设）'}，应为 ${CODEX_PROVIDER}（重新运行 ${cmd} setup codex 可修复）`, `model_provider = ${prof.model_provider || '(unset)'}; expected ${CODEX_PROVIDER} (re-run ${cmd} setup codex)`));
    if (!prof.base_url) problem(L('没有设置 base_url', 'base_url is not set'));
    else if (!isEvolinkUrl(prof.base_url)) problem(L(`base_url 指向 ${prof.base_url}，不是 EvoLink`, `base_url points to ${prof.base_url}, not EvoLink`));
    else if (!/\/v1\/?$/.test(prof.base_url)) problem(L(`base_url = ${prof.base_url}：Codex 需要以 /v1 结尾`, `base_url = ${prof.base_url}: Codex needs it to end in /v1`));
    else ui.ok(`base_url = ${prof.base_url}`);
    if (prof.wire_api && prof.wire_api !== 'responses') problem(L(`wire_api = ${prof.wire_api}：Codex 只支持 responses`, `wire_api = ${prof.wire_api}: Codex only supports responses`));
    if (prof.experimental_bearer_token) ui.ok(`key = ${maskKey(prof.experimental_bearer_token)}`);
    else if (prof.env_key) {
      if (process.env[prof.env_key]) ui.ok(L(`Key 取自环境变量 ${prof.env_key}（${maskKey(process.env[prof.env_key])}）`, `key from ${prof.env_key} (${maskKey(process.env[prof.env_key])})`));
      else problem(L(`Key 要从环境变量 ${prof.env_key} 读取，但现在没有设置（Codex 会报 Missing environment variable）`, `The key comes from ${prof.env_key}, which is not set (Codex fails with "Missing environment variable")`));
    } else problem(L('配置档里没有 Key', 'The profile has no key'));
    if (prof.model) ui.ok(`model = ${prof.model}`);
    else warn(L('没有设置 model：Codex 会用它自己的默认模型，EvoLink 上可能没有', 'model is not set: Codex falls back to its own default, which EvoLink may not serve'));
    if (prof.web_search && prof.web_search !== 'disabled') warn(L(`web_search = ${prof.web_search}：EvoLink 不提供 OpenAI 自带的联网搜索`, `web_search = ${prof.web_search}: EvoLink does not run OpenAI's hosted web search`));
    if (prof.model_catalog_json) {
      // Relative paths are resolved against CODEX_HOME by Codex.
      const c = readJson(path.resolve(paths.home, prof.model_catalog_json));
      catalogState = !c.exists ? 'missing' : c.data ? 'ok' : 'invalid';
      if (!c.exists) warn(L(`模型目录 ${tildify(prof.model_catalog_json)} 不存在：/model 里只剩 Codex 自带的模型`, `Model catalog ${tildify(prof.model_catalog_json)} is missing; /model shows only Codex's built-in models`));
      else if (!c.data) problem(L(`模型目录 ${tildify(prof.model_catalog_json)} 不是有效的 JSON（${c.error}）`, `Model catalog ${tildify(prof.model_catalog_json)} is not valid JSON (${c.error})`));
      else ui.ok(L(`模型目录 ${tildify(prof.model_catalog_json)}`, `model catalog ${tildify(prof.model_catalog_json)}`));
    }
  }
  const mainConfig = scanCodexConfig(mainText);
  for (const n of codexConfigNotes(mainConfig, paths)) {
    // Without a profile only what breaks every codex command matters; with VS Code mode on, a plain codex uses EvoLink.
    if ((!hasProfile && !n.all) || (vscodeMode && n.level === 'info')) continue;
    (n.level === 'error' ? problem : ui.info.bind(ui))(n.text);
  }
  if (hasProfile && mainConfig.autoReview && prof.approvals_reviewer !== 'user') {
    problem(L(`${tildify(paths.config)} 开了自动审批审核（approvals_reviewer = "auto_review"），它用的 codex-auto-review 模型 EvoLink 没有，需要审核的命令会被拒绝；重新运行 ${cmd} setup codex 会在配置档里关掉它`, `${tildify(paths.config)} turns on automatic approval review (approvals_reviewer = "auto_review"); EvoLink does not serve its codex-auto-review model, so reviewed commands are denied. Re-run ${cmd} setup codex to turn it off in the profile`));
  }
  let mainKey = null;
  if (vscodeMode) {
    ui.ok(L(`${tildify(paths.config)}（VS Code 模式：扩展和直接运行的 codex 都用它）`, `${tildify(paths.config)} (VS Code mode: the extension and a plain codex use it)`));
    const fix = L(`重新运行 ${cmd} setup codex --vscode 可修复`, `re-run ${cmd} setup codex --vscode`);
    const t = main.table;
    if (main.error) problem(L(`${tildify(paths.config)} 不是有效的 TOML（${main.error}）：Codex 起不来`, `${tildify(paths.config)} is not valid TOML (${main.error}); Codex cannot start`));
    else {
      if (main.provider !== CODEX_PROVIDER) problem(L(`model_provider = ${main.provider || '（没设）'}：没有启用 [${CODEX_PROVIDER_TABLE}]（${fix}）`, `model_provider = ${main.provider || '(unset)'}: [${CODEX_PROVIDER_TABLE}] is not in use (${fix})`));
      if (!t) problem(L(`model_provider = ${CODEX_PROVIDER}，但没有 [${CODEX_PROVIDER_TABLE}] 这一段，Codex 会报错（${fix}）`, `model_provider = ${CODEX_PROVIDER} but there is no [${CODEX_PROVIDER_TABLE}] table, so Codex fails (${fix})`));
      else {
        if (!t.base_url) problem(L(`[${CODEX_PROVIDER_TABLE}] 里没有 base_url`, `[${CODEX_PROVIDER_TABLE}] has no base_url`));
        else if (!isEvolinkUrl(t.base_url)) problem(L(`base_url 指向 ${t.base_url}，不是 EvoLink`, `base_url points to ${t.base_url}, not EvoLink`));
        else if (!/\/v1\/?$/.test(t.base_url)) problem(L(`base_url = ${t.base_url}：Codex 需要以 /v1 结尾`, `base_url = ${t.base_url}: Codex needs it to end in /v1`));
        else ui.ok(`base_url = ${t.base_url}`);
        if (t.wire_api && t.wire_api !== 'responses') problem(L(`wire_api = ${t.wire_api}：Codex 只支持 responses`, `wire_api = ${t.wire_api}: Codex only supports responses`));
        // Codex prefers env_key over the key in the file.
        if (t.env_key && !process.env[t.env_key]) problem(L(`[${CODEX_PROVIDER_TABLE}] 要从环境变量 ${t.env_key} 读 Key，但现在没有设置（Codex 会报 Missing environment variable）`, `[${CODEX_PROVIDER_TABLE}] reads the key from ${t.env_key}, which is not set (Codex fails with "Missing environment variable")`));
        mainKey = (t.env_key ? process.env[t.env_key] : null) || t.experimental_bearer_token || null;
        if (mainKey) ui.ok(`key = ${maskKey(mainKey)}${t.env_key ? ` (${t.env_key})` : ''}`);
        else if (!t.env_key) problem(L(`[${CODEX_PROVIDER_TABLE}] 里没有 Key（${fix}）`, `[${CODEX_PROVIDER_TABLE}] has no key (${fix})`));
        if (process.platform !== 'win32' && t.experimental_bearer_token) {
          const mode = fs.statSync(paths.config).mode & 0o777;
          if (mode & 0o077) warn(L(`${tildify(paths.config)} 里有 Key，但别的用户也能读（权限 ${mode.toString(8)}）：运行 chmod 600 ${tildify(paths.config)}`, `${tildify(paths.config)} holds the key but others can read it (mode ${mode.toString(8)}): run chmod 600 ${tildify(paths.config)}`));
        }
      }
      if (main.model) ui.ok(`model = ${main.model}`);
      else warn(L('没有设置 model：Codex 会用它自己的默认模型，EvoLink 上可能没有', 'model is not set: Codex falls back to its own default, which EvoLink may not serve'));
      if (main.webSearch !== 'disabled') warn(L(`web_search = ${main.webSearch || '（没设，默认会带上联网搜索）'}：EvoLink 不提供 OpenAI 自带的联网搜索，应为 disabled`, `web_search = ${main.webSearch || '(unset; web search is on by default)'}: EvoLink does not run OpenAI's hosted web search; expected disabled`));
      if (AUTO_REVIEWERS.has(main.reviewer)) problem(L(`approvals_reviewer = "${main.reviewer}"：它要用的 codex-auto-review 模型 EvoLink 没有，需要审核的命令会被拒绝（${fix}）`, `approvals_reviewer = "${main.reviewer}" needs codex-auto-review, which EvoLink does not serve, so reviewed commands are denied (${fix})`));
      if (main.conflicts.length) problem(L(`[${CODEX_PROVIDER_TABLE}] 还用别的写法定义了一次，config.toml 会失效`, `[${CODEX_PROVIDER_TABLE}] is also defined another way; config.toml is invalid`));
    }
  }
  const profKey = prof.experimental_bearer_token || (prof.env_key ? process.env[prof.env_key] : null) || null;
  if (profKey && mainKey && profKey !== mainKey) warn(L('配置档和 config.toml 里的 Key 不一样：codex -p evolink 用配置档的，扩展和直接运行的 codex 用 config.toml 的', 'The profile and config.toml hold different keys: codex -p evolink uses the profile, the extension and a plain codex use config.toml'));
  // The online checks use the profile when there is one, else config.toml.
  const key = profKey || mainKey;
  const keyBase = profKey ? prof.base_url : main.table?.base_url;
  const keyModel = profKey ? prof.model : main.model;
  report.summary.push(`profile: ${hasProfile ? 'yes' : 'no'} provider=${prof.model_provider || '-'} base=${prof.base_url || '-'} key=${profKey ? maskKey(profKey) : '-'} model=${prof.model || '-'} wire=${prof.wire_api || '-'} web_search=${prof.web_search || '-'} catalog=${catalogState}`);
  report.summary.push(`config.toml: ${isFile(paths.config) ? 'yes' : 'no'} profiles_table=${mainConfig.profileTable ? 'yes' : 'no'} legacy_profile=${mainConfig.legacyProfile ? 'yes' : 'no'} auto_review=${mainConfig.autoReview ? 'yes' : 'no'} old_evolink_provider=${mainConfig.evolinkEnvKey ? 'yes' : 'no'}`);
  report.summary.push(`vscode: ${vscodeMode ? `yes provider=${main.provider || '-'} base=${main.table?.base_url || '-'} key=${mainKey ? maskKey(mainKey) : '-'} model=${main.model || '-'} web_search=${main.webSearch || '-'} reviewer=${main.reviewer || '-'}` : 'no'}`);

  ui.step(3, 4, L('连接与 Key', 'Connection and key'));
  if (key && keyBase && isEvolinkUrl(keyBase)) {
    const base = normalizeBaseUrl(keyBase).url;
    const check = await checkKey(base, key);
    if (check.ok) {
      const gpt = codexModelIds(check.ids);
      ui.ok(L(`Key 有效 · 可用模型 ${check.count} 个，其中 GPT ${gpt.length} 个（${check.ms} ms）`, `Key valid · ${check.count} models, ${gpt.length} GPT (${check.ms} ms)`));
      if (!gpt.length) problem(L('这把 Key 没有开通 GPT 模型，Codex 用不了', 'This key has no GPT models, so Codex cannot use it'));
      printBalance(check.balance);
      if (keyModel && gpt.length && !gpt.includes(keyModel)) problem(L(`model = ${keyModel}：这把 Key 在 Codex 里用不了`, `model = ${keyModel} is not available for this key in Codex`));
      report.summary.push(`api: models=${check.count} gpt=${gpt.length} balance=${check.balance?.user ?? '-'} key_quota=${check.balance?.unlimited ? 'unlimited' : check.balance?.token ?? '-'}`);
      if (opts.test && keyModel) {
        const t = await testResponses(base, key, keyModel);
        if (t.ok) ui.ok(L(`测试请求通过：${keyModel}（${t.ms} ms）`, `Test request passed: ${keyModel} (${t.ms} ms)`));
        else for (const l of failureLines(t.failure, base)) problem(l);
        report.summary.push(`test: ${t.ok ? `ok ${keyModel}` : `fail ${t.failure.kind} ${t.failure.status || ''}`}`);
      }
    } else {
      for (const l of failureLines(check.failure, base)) problem(l);
      report.summary.push(`api: fail ${check.failure.kind} ${check.failure.status || check.failure.code || ''}`);
    }
  } else ui.info(L('没有可用的 EvoLink 配置，跳过联网检查', 'No EvoLink configuration; skipping online checks'));

  ui.step(4, 4, L('其他', 'Other'));
  if (process.env.CODEX_HOME) ui.info(`CODEX_HOME = ${process.env.CODEX_HOME}`);
  const chatgpt = isFile(path.join(paths.home, 'auth.json'));
  if (vscodeMode) {
    if (chatgpt) ui.info(L('这台电脑的 Codex 也登录了 ChatGPT：config.toml 现在用 EvoLink，登录信息保留但不使用', 'Codex is also signed in to ChatGPT here: config.toml now uses EvoLink, so the sign-in is kept but unused'));
    else ui.ok(L('启动：在 VS Code 里打开 Codex 面板，或直接运行 codex', 'Start: open the Codex panel in VS Code, or run codex'));
  } else if (chatgpt) ui.info(L(`这台电脑的 Codex 也登录了账号：直接运行 codex 用它，带 -p ${CODEX_PROFILE} 才走 EvoLink`, `Codex is also signed in here: plain codex uses that sign-in, -p ${CODEX_PROFILE} uses EvoLink`));
  else ui.ok(L(`启动命令：codex -p ${CODEX_PROFILE}`, `Start with: codex -p ${CODEX_PROFILE}`));
  const ext = editorsWithExtension(CODEX_EXTENSION);
  if (vscodeMode) {
    if (ext.length) ui.ok(L(`Codex 扩展：${ext.join('、')}`, `Codex extension: ${ext.join(', ')}`));
    else ui.info(L(`还没装 Codex 扩展：在 VS Code 里打开 ${extensionLink('VS Code', CODEX_EXTENSION)} 安装`, `The Codex extension is not installed: open ${extensionLink('VS Code', CODEX_EXTENSION)} in VS Code`));
  } else if (ext.length) ui.info(L(`编辑器里装了 Codex 扩展：它不认配置档；想让它也走 EvoLink，运行 ${cmd} setup codex --vscode`, `The Codex extension is installed; it ignores profiles. To route it through EvoLink too: ${cmd} setup codex --vscode`));
  report.summary.push(`extension: ${ext.length ? ext.join(',') : 'none'}`);
  report.summary.push(`codex_home: ${process.env.CODEX_HOME ? 'custom' : 'default'} signed_in: ${chatgpt ? 'yes' : 'no'}`);

  ui.print('');
  if (report.problems.length) ui.title(`${ui.mark('err')} ${L(`发现 ${report.problems.length} 个问题（见上方 ✗）`, `${report.problems.length} problem(s) found (marked above)`)}`);
  else ui.title(`${ui.mark('ok')} ${L('没有发现问题', 'No problems found')}`);
  if (report.problems.length) ui.print(`  ${L('多数问题重新运行一次 setup 就能修好：', 'Most problems are fixed by running setup again: ')}${cmd} setup codex${vscodeOnly ? ' --vscode' : ''}`);
  ui.print('');
  ui.print(ui.dim(L('—— 以下内容可以直接发给客服（Key 已隐去）——', '--- Send the lines below to support (key hidden) ---')));
  for (const line of report.summary) ui.print(line);
  if (report.problems.length) ui.print(`problems: ${report.problems.length}`);
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.problems.length ? EXIT.ERROR : EXIT.OK;
}

async function resetCodex(opts) {
  const interactive = !opts.yes && !opts.json;
  const state = loadState();
  const cx = state.codex;
  ui.title(L(`EvoLink 撤销配置 · Codex v${VERSION}`, `EvoLink reset · Codex v${VERSION}`));
  if (!cx || (!Object.keys(cx.files || {}).length && !cx.config)) {
    ui.info(L('没有找到 evolink setup codex 的改动记录，无需撤销。', 'No changes recorded by evolink setup codex; nothing to undo.'));
    return { result: { ok: true, changes: [] }, code: EXIT.OK };
  }
  const actions = [];
  const skipped = [];
  for (const [file, rec] of Object.entries(cx.files || {})) {
    if (!isFile(file)) continue;
    // Still ours while setup's provider table is there, even with the settings Codex adds by itself (trusted folders,
    // [tui] …) or a different model; the file is backed up before it goes.
    const parts = splitCodexProfile(fs.readFileSync(file, 'utf8'));
    if (!parts.ours) {
      skipped.push(file);
      continue;
    }
    actions.push({ file, restore: !!(rec.existed && rec.original && isFile(rec.original)), original: rec.original, extra: !!(parts.top || parts.tables) });
  }
  // config.toml (VS Code mode): key by key.
  const mainRec = cx.config;
  let main = null;
  if (mainRec && isFile(mainRec.file)) {
    try {
      main = { ...planCodexMainRestore(fs.readFileSync(mainRec.file, 'utf8'), mainRec), file: mainRec.file };
    } catch (e) {
      ui.warn(L(`${tildify(mainRec.file)} 现在不是有效的 TOML（${e.message}），没法自动还原；setup 改之前的副本在 ~/.evolink/backups/ 里。`, `${tildify(mainRec.file)} is not valid TOML now (${e.message}), so it cannot be undone automatically; the copy from before setup is in ~/.evolink/backups/.`));
    }
  }
  const mainSkipped = main?.skipped || [];
  ui.print('');
  for (const a of actions) {
    ui.print(`  ${tildify(a.file)}  ${a.restore ? L('还原为 setup 之前的内容', 'restored to what it was before setup') : L('删除（由 setup 新建）', 'deleted (created by setup)')}`);
    if (a.extra) ui.print(ui.dim(`    ${L('里面后来加上的设置（例如信任过的文件夹）也会一起去掉，可以从备份找回', 'settings added to it later (such as trusted folders) go too; they stay in the backup')}`));
  }
  if (main?.changed) {
    ui.print(`  ${tildify(main.file)}  ${main.remove ? L('删除（由 setup 新建）', 'deleted (created by setup)') : L('改回 setup 之前的设置', 'put back as it was before setup')}`);
    if (!main.remove) ui.print(ui.dim(`    ${main.restored.join(', ')}${L('；其他内容不动', '; nothing else changes')}`));
  }
  if (mainSkipped.length) ui.warn(L(`config.toml 里这些项在 setup 之后被改过，保持不动：${mainSkipped.join(', ')}`, `Changed in config.toml since setup, left as is: ${mainSkipped.join(', ')}`));
  if (skipped.length) ui.warn(L(`这些文件已经不是 setup 写的内容，保持不动：${skipped.map(tildify).join(', ')}`, `No longer the file setup wrote, left as is: ${skipped.map(tildify).join(', ')}`));
  if (!actions.length && !main?.changed) {
    ui.ok(L('没有需要撤销的内容。', 'Nothing to undo.'));
    if (!opts.dryRun) {
      delete state.codex;
      saveState(state);
    }
    return { result: { ok: true, changes: [], skipped: [...skipped, ...mainSkipped] }, code: EXIT.OK };
  }
  if (opts.dryRun) {
    ui.info(L('这是预览（--dry-run），没有写入任何文件。', 'Preview only (--dry-run); nothing was written.'));
    return { result: { ok: true, dryRun: true }, code: EXIT.OK };
  }
  if (interactive && !(await confirm(L('确认撤销？', 'Undo these changes?'), true))) throw new CancelledError();
  const backup = newBackupSession();
  for (const a of actions) {
    backupFile(backup, a.file, `codex-${path.basename(a.file)}`);
    if (a.restore) writeAtomic(a.file, fs.readFileSync(a.original));
    else fs.unlinkSync(a.file);
    if (a.original) {
      try {
        fs.unlinkSync(a.original);
      } catch {}
    }
  }
  if (main?.changed) {
    backupFile(backup, main.file, 'codex-config.toml');
    if (main.remove) fs.unlinkSync(main.file);
    // With the key gone, the file gets its old permissions back.
    else writeAtomic(main.file, main.text, { mode: main.keyRemoved && mainRec.existed && mainRec.mode !== null ? mainRec.mode : 0o600 });
  }
  delete state.codex;
  saveState(state);
  ui.ok(L(`已撤销。改动前的文件备份在 ${tildify(backup.dir)}`, `Undone. Backups are in ${tildify(backup.dir)}`));
  return { result: { ok: true, backupDir: backup.dir, restored: actions.length + (main?.changed ? 1 : 0), skipped: [...skipped, ...mainSkipped] }, code: EXIT.OK };
}

// ---------------------------------------------------------------------------
// VS Code Chat (Copilot) custom endpoint: `evolink setup copilot` adds an "EvoLink" provider group to VS Code's
// chatLanguageModels.json. VS Code takes the group's key only from its own secret storage: a key written into the file
// is ignored (VS Code 1.140 source and UI test, 10-01), so the key is pasted once in VS Code ("Update API Key").
// Needs no GitHub sign-in and no Copilot plan; VS Code picks changes to the file up without a reload.

const COPILOT_TARGETS = ['copilot', 'vscode-chat'];
const COPILOT_GROUP = 'EvoLink';
const COPILOT_VENDOR = 'customendpoint';
// Desktop editors with the built-in chat and its custom endpoint provider (the settings live on the local machine,
// also in a Remote-SSH window).
const COPILOT_EDITORS = [
  { name: 'VS Code', app: 'Code' },
  { name: 'VS Code Insiders', app: 'Code - Insiders' },
];
// Output cap per model. VS Code sends it with every request, and EvoLink holds credit against it up front.
export const COPILOT_MAX_OUTPUT = 32000;
// Gemini fails in Agent mode: the gateway passes the "$comment" keys in Copilot's tool schemas on to Gemini, which
// rejects them with a 400 (10-01). Left out until the gateway strips them.
const COPILOT_SKIP = /^gemini-/i;
const COPILOT_FAMILIES = /^(claude-|gpt-\d|deepseek-|kimi-|glm-|qwen|grok-|doubao-seed-)/i;
const COPILOT_NOT_CHAT = /(image|seededit|voice|tts|audio|embed|whisper|i2i|vision-exp)/i;
const COPILOT_PATHS = { messages: '/v1/messages', responses: '/v1/responses', 'chat-completions': '/v1/chat/completions' };

// Offered by default (the ones this key has); --all-models adds every other chat model.
export const RECOMMENDED_COPILOT_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5-20251001',
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-luna',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'kimi-k3',
  'glm-5.3',
  'qwen3.8-max',
  'grok-4.7',
  'doubao-seed-2.0-pro',
  'doubao-seed-2.0-code',
];

// Claude speaks the Messages API, GPT the Responses API, everything else Chat Completions (each tested 10-01).
export const copilotApiType = (id) => (/^claude-/i.test(id) ? 'messages' : /^gpt-/i.test(id) ? 'responses' : 'chat-completions');

const NAME_WORDS = { gpt: 'GPT', glm: 'GLM', deepseek: 'DeepSeek', kimi: 'Kimi', grok: 'Grok', doubao: 'Doubao', claude: 'Claude', seed: 'Seed' };
// claude-sonnet-5-5 → "Claude Sonnet 5.5 (EvoLink)"; gpt-6.1-sol → "GPT-6.1 Sol (EvoLink)".
export function copilotModelName(id) {
  const out = [];
  for (const p of String(id).replace(/-\d{8}$/, '').split('-')) {
    if (/^\d+$/.test(p) && out.length && /\d$/.test(out[out.length - 1])) out[out.length - 1] += `.${p}`;
    else if (/^\d/.test(p)) out.push(p);
    else out.push(NAME_WORDS[p.toLowerCase()] || p[0].toUpperCase() + p.slice(1));
  }
  return `${out.join(' ').replace(/^GPT (\d)/, 'GPT-$1')} (EvoLink)`;
}

// Chat models of this key, recommended ones first unless `all`; `held` lists the Gemini models left out (COPILOT_SKIP).
export function copilotModelIds(ids, { all = false } = {}) {
  const chat = [...ids].filter((id) => (COPILOT_FAMILIES.test(id) || COPILOT_SKIP.test(id)) && !COPILOT_NOT_CHAT.test(id));
  const usable = chat.filter((id) => !COPILOT_SKIP.test(id)).sort();
  const held = chat.filter((id) => COPILOT_SKIP.test(id)).sort();
  if (all) return { models: usable, held };
  const picked = RECOMMENDED_COPILOT_MODELS.filter((id) => usable.includes(id));
  return { models: picked.length ? picked : usable, held };
}

// One model in the provider group. contextWindow comes from the public price list when it has it.
export function copilotModelEntry(id, base, contextWindow) {
  const apiType = copilotApiType(id);
  const window = Number(contextWindow) > COPILOT_MAX_OUTPUT * 2 ? Number(contextWindow) : 128000;
  const entry = {
    id,
    name: copilotModelName(id),
    url: `${base}${COPILOT_PATHS[apiType]}`,
    apiType,
    toolCalling: true,
    vision: /^(claude|gpt)-/i.test(id),
    contextWindow: window,
    maxInputTokens: window - COPILOT_MAX_OUTPUT,
    maxOutputTokens: COPILOT_MAX_OUTPUT,
  };
  // Kimi accepts only temperature 1; Chat sends its own sampling values otherwise (400, 10-01). null leaves top_p out.
  if (/^kimi-/i.test(id)) entry.modelOptions = { temperature: 1, top_p: null };
  return entry;
}

// The EvoLink group written into chatLanguageModels.json (a JSON array of provider groups). Everything else in the
// file stays; an existing EvoLink group keeps its key reference and settings, only its model list is replaced.
export function planCopilotFile(raw, models) {
  let groups = [];
  if (raw !== null && raw !== undefined && raw.trim()) {
    const parsed = JSON.parse(stripJsonComments(raw.replace(/^\uFEFF/, '')).replace(/,(\s*[}\]])/g, '$1'));
    if (!Array.isArray(parsed)) throw new Error('not a JSON array');
    groups = parsed;
  }
  const i = groups.findIndex((g) => isPlainObject(g) && g.vendor === COPILOT_VENDOR && g.name === COPILOT_GROUP);
  const before = i >= 0 ? groups[i] : null;
  const group = { ...(before || { name: COPILOT_GROUP, vendor: COPILOT_VENDOR }), models };
  if (i >= 0) groups[i] = group;
  else groups.push(group);
  // VS Code writes this file with tabs.
  const text = `${JSON.stringify(groups, null, '\t')}\n`;
  return { text, before, groupExisted: i >= 0, hasKey: copilotKeySet(group), changed: text !== raw };
}

// VS Code keeps the key in its secret storage and writes "${input:chat.lm.secret.…}" into the file.
export const copilotKeySet = (group) => typeof group?.apiKey === 'string' && /^\$\{input:[^}]+\}$/.test(group.apiKey);

// Reverse planCopilotFile: put back the group that was there before setup, or remove ours.
export function planCopilotRestore(raw, rec) {
  const groups = JSON.parse(stripJsonComments(String(raw).replace(/^\uFEFF/, '')).replace(/,(\s*[}\]])/g, '$1'));
  if (!Array.isArray(groups)) throw new Error('not a JSON array');
  const i = groups.findIndex((g) => isPlainObject(g) && g.vendor === COPILOT_VENDOR && g.name === COPILOT_GROUP);
  if (i < 0) return { changed: false };
  const keyWasSet = copilotKeySet(groups[i]);
  if (rec.groupExisted && rec.before) groups[i] = JSON.parse(rec.before);
  else groups.splice(i, 1);
  if (!rec.existed && !groups.length) return { changed: true, remove: true, keyWasSet };
  return { changed: true, text: `${JSON.stringify(groups, null, '\t')}\n`, keyWasSet };
}

export function copilotFiles() {
  return COPILOT_EDITORS.map((ed) => {
    const dir = path.dirname(editorSettingsPath(ed.app));
    return { name: ed.name, dir, file: path.join(dir, 'chatLanguageModels.json') };
  }).filter((x) => isDir(x.dir));
}

// Context windows from the public price list (no key needed); empty when it cannot be read.
async function contextWindows(base) {
  const r = await http('GET', `${base}/web/api/models/pricing`, { timeout: 20000 });
  const out = new Map();
  for (const it of r.json?.data || []) if (it?.model_name && Number(it.context_window) > 0) out.set(it.model_name, Number(it.context_window));
  return out;
}

async function testChatCompletions(base, key, model) {
  const r = await http('POST', `${base}/v1/chat/completions`, { key, timeout: 90000, body: { model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] } });
  return r.ok ? { ok: true, model, ms: r.ms } : { ok: false, model, failure: describeFailure(r), ms: r.ms };
}

const copilotPasteSteps = () => [
  L('在 VS Code 里打开右侧的 Chat，点模型列表 → "Manage Models..."', 'In VS Code, open Chat, click the model list → "Manage Models..."'),
  L(`在 "${COPILOT_GROUP}" 这一组上点右键 → "Update API Key"，粘贴你的 EvoLink Key（只需一次，VS Code 会存进系统钥匙串）`, `Right-click the "${COPILOT_GROUP}" group → "Update API Key" and paste your EvoLink key (once; VS Code keeps it in the system keychain)`),
  L('回到 Chat，在模型列表里选一个带 (EvoLink) 的模型开始对话', 'Back in Chat, pick a model marked (EvoLink) and start chatting'),
];

async function cmdSetupCopilot(opts) {
  const interactive = !opts.yes && !opts.json;
  const result = { command: 'setup', target: 'copilot', version: VERSION, ok: false, warnings: [] };
  const baseNorm = normalizeBaseUrl(opts.baseUrl || process.env.EVOLINK_BASE_URL || DEFAULT_BASE_URL);
  if (baseNorm.error) throw new CliError(L('接口地址格式不对，应类似 https://direct.evolink.ai', 'Invalid base URL; expected something like https://direct.evolink.ai'), EXIT.USAGE);
  const base = baseNorm.url;
  ui.title(L(`EvoLink 一键配置 · VS Code Chat（Copilot）  v${VERSION}`, `EvoLink setup · VS Code Chat (Copilot)  v${VERSION}`));
  ui.print(ui.dim(L('在 VS Code 内置的 Chat 里加一组 EvoLink 模型，不需要登录 GitHub，也不需要 Copilot 订阅。改之前自动备份，随时可以撤销。', "Adds a group of EvoLink models to VS Code's built-in Chat; no GitHub sign-in or Copilot plan needed. Everything is backed up first and can be undone.")));

  // [1/4] environment
  ui.step(1, 4, L('检查环境', 'Environment'));
  ui.ok(`${osLabel()} · Node ${process.versions.node}`);
  const targets = copilotFiles();
  if (!targets.length) {
    const remote = !!process.env.VSCODE_IPC_HOOK_CLI || isDir(path.join(os.homedir(), '.vscode-server'));
    throw new CliError(
      remote
        ? L('Chat 的模型配置保存在你本机的 VS Code 里：请在本机（不是 Remote-SSH 的远端）运行这条命令。', "Chat's model settings live in the VS Code on your own computer: run this there, not on the Remote-SSH side.")
        : L('没有找到桌面版 VS Code 的用户目录：先装好 VS Code 并打开一次，再运行这条命令。', 'No desktop VS Code user folder found: install VS Code and open it once, then run this again.'),
      EXIT.NOT_INSTALLED,
    );
  }
  for (const t of targets) ui.ok(`${t.name}  ${ui.dim(tildify(t.file))}`);
  result.editors = targets.map((t) => t.name);

  // [2/4] key (only to see which models it can use: VS Code takes the key from its own keychain)
  ui.step(2, 4, L('API Key', 'API key'));
  const { key, check } = await obtainAndCheckKey(opts, interactive, base, existingCodexKey(codexPaths()), { tool: 'copilot' });
  result.key = maskKey(key);
  const ids = check?.ids || new Set();

  // [3/4] models
  ui.step(3, 4, L('模型', 'Models'));
  const { models: chosen, held } = copilotModelIds(ids, { all: !!opts.allModels });
  if (!chosen.length) throw new CliError(L('这把 Key 没有开通可以在 Chat 里用的文本模型；请在控制台调整 Key 的模型范围。', 'This key has no chat models for VS Code; adjust the key in the dashboard.'), EXIT.AUTH);
  const windows = opts.skipChecks ? new Map() : await contextWindows(base);
  const models = chosen.map((id) => copilotModelEntry(id, base, windows.get(id)));
  ui.ok(L(`${models.length} 个模型${opts.allModels ? '（全部）' : '（推荐的；要全部加上：--all-models）'}`, `${models.length} models${opts.allModels ? ' (all)' : ' (recommended; add all with --all-models)'}`));
  const size = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}K`);
  for (const m of models) ui.print(`    ${m.name.padEnd(36)}${ui.dim(`${m.apiType} · ${size(m.contextWindow)}`)}`);
  if (held.length) ui.info(L(`暂不加入 Gemini（${held.length} 个）：网关转发 Chat 的工具参数时会被 Gemini 拒绝，等网关修复后再加`, `Gemini (${held.length}) is left out for now: the gateway passes Chat's tool parameters on in a form Gemini rejects; it will be added once that is fixed`));
  result.models = models.map((m) => m.id);

  // [4/4] write
  ui.step(4, 4, L('写入', 'Apply'));
  const plans = [];
  for (const t of targets) {
    const existed = isFile(t.file);
    const raw = existed ? fs.readFileSync(t.file, 'utf8') : null;
    let p;
    try {
      p = planCopilotFile(raw, models);
    } catch (e) {
      throw new CliError(L(`${tildify(t.file)} 不是有效的 JSON（${e.message}），没法安全地修改；请先修好或删掉它。`, `${tildify(t.file)} is not valid JSON (${e.message}), so it cannot be edited safely; fix or delete it first.`), EXIT.CONFIG);
    }
    plans.push({ ...t, ...p, existed });
    const tag = !existed ? L('（新建）', '(new file)') : p.changed ? L('（修改，原文件先备份）', '(changed; backed up first)') : L('（无需改动）', '(unchanged)');
    ui.print(`  ${tildify(t.file)}  ${tag}`);
    ui.print(ui.dim(`    ${p.groupExisted ? L(`更新 "${COPILOT_GROUP}" 这一组的模型列表，保留已经设置的 Key`, `updates the model list of the "${COPILOT_GROUP}" group; a key already set stays`) : L(`新加一组 "${COPILOT_GROUP}"；其他提供方不动`, `adds the "${COPILOT_GROUP}" group; other providers stay as they are`)}`));
  }
  result.changes = plans.map((p) => ({ file: p.file, action: !p.existed ? 'create' : p.changed ? 'modify' : 'keep', keySet: p.hasKey }));
  if (opts.dryRun) {
    ui.print('');
    ui.info(L('这是预览（--dry-run），没有写入任何文件。', 'Preview only (--dry-run); nothing was written.'));
    result.ok = true;
    result.dryRun = true;
    return finish(result, opts);
  }
  const pending = plans.filter((p) => p.changed);
  if (!pending.length) ui.ok(L('配置已经是最新的，不需要改动。', 'Already up to date; nothing to change.'));
  else if (interactive && !(await confirm(L('确认写入？', 'Apply these changes?'), true))) throw new CancelledError();
  if (pending.length) {
    const state = loadState();
    const cp = (state.copilot ||= { files: {} });
    const backup = newBackupSession();
    for (const p of pending) {
      if (p.existed) backupFile(backup, p.file, 'chatLanguageModels.json');
      writeAtomic(p.file, p.text, { mode: 0o644 });
      if (!cp.files[p.file]) cp.files[p.file] = { existed: p.existed, groupExisted: p.groupExisted, before: p.before ? JSON.stringify(p.before) : null };
      ui.ok(L(`已写入 ${tildify(p.file)}`, `Wrote ${tildify(p.file)}`));
    }
    cp.updatedAt = new Date().toISOString();
    saveState(state);
    pruneBackups();
    if (backup.files.length) result.backupDir = backup.dir;
  }

  // One tiny request per API type, to prove the key and the gateway side.
  if (!opts.skipChecks && opts.test !== false && ids.size) {
    const byType = new Map();
    // The cheapest of each kind when the key has it.
    const prefer = ['claude-haiku-4-5-20251001', 'gpt-6-luna', 'deepseek-v4-flash'];
    const rank = (id) => (prefer.includes(id) ? prefer.indexOf(id) : prefer.length);
    for (const m of [...models].sort((a, b) => rank(a.id) - rank(b.id))) if (!byType.has(m.apiType)) byType.set(m.apiType, m.id);
    result.tests = [];
    for (const [type, model] of byType) {
      const t = type === 'messages' ? await testMessage(base, key, model) : type === 'responses' ? await testResponses(base, key, model) : await testChatCompletions(base, key, model);
      result.tests.push(t.ok ? { ok: true, model, type } : { ok: false, model, type, error: t.failure });
      if (t.ok) ui.ok(L(`测试通过：${model}（${type}，${t.ms} ms）`, `Test passed: ${model} (${type}, ${t.ms} ms)`));
      else for (const line of failureLines(t.failure, base)) ui.err(line);
    }
  }
  result.ok = !(result.tests || []).some((t) => !t.ok);
  result.keySet = plans.every((p) => p.hasKey);

  const cmd = sandboxPrefix(sandboxHome()) + commandHint(sandboxHome());
  ui.print('');
  ui.title(`${ui.mark('ok')} ${L('配置完成', 'All set')}`);
  if (result.keySet) ui.print(`  ${L('VS Code 里已经设置过 Key，直接在 Chat 的模型列表里选带 (EvoLink) 的模型即可。', 'A key is already set in VS Code: pick a model marked (EvoLink) in the Chat model list.')}`);
  else {
    ui.print(`  ${L('最后一步（只需一次）：VS Code 只从自己的钥匙串读 Key，工具没法替你写进去。', 'One last step (once): VS Code reads the key only from its own keychain, so this tool cannot put it there.')}`);
    copilotPasteSteps().forEach((line, i) => ui.print(`  ${i + 1}. ${line}`));
  }
  ui.print(`  ${ui.mark('dot')} ${L('不用重启 VS Code：它会自动读到新的模型列表。', 'No restart needed: VS Code picks the new model list up by itself.')}`);
  ui.print(`  ${ui.mark('dot')} ${L('Agent 模式每轮都会带上很长的系统提示和工具说明：一句简单的话也要约 2 万个输入 token；只聊天可以切到 Ask 模式。', 'Agent mode sends a long system prompt and tool list every turn: even a one-line question costs about 20K input tokens; switch to Ask mode for plain chat.')}`);
  ui.print(`  ${ui.mark('dot')} ${L('VS Code 提示 "Set BYOK utility models" 时，可以选一个便宜的 EvoLink 模型（如 DeepSeek V4 Flash）做标题、摘要这类辅助工作；不设也能正常聊天。', 'If VS Code asks to "Set BYOK utility models", a cheap EvoLink model (such as DeepSeek V4 Flash) can do titles and summaries; chat works without it.')}`);
  ui.print(`  ${ui.mark('dot')} ${L('Chat 的设置跟着 VS Code 的默认配置文件走；用了别的 Profile 的话，要在那个 Profile 里另外添加。', "This goes into VS Code's default profile; other profiles need their own setup.")}`);
  ui.print('');
  ui.print(`  ${L('撤销本次配置：', 'Undo these changes: ')}${cmd} reset copilot`);
  ui.print(`  ${L('遇到问题：运行 ', 'Having trouble? Run ')}${cmd} doctor copilot${L('，把输出发给客服（Key 会自动隐去）', ' and send the output to support (your key is hidden)')}`);
  return finish(result, opts, result.ok ? EXIT.OK : EXIT.AUTH);
}

async function cmdDoctorCopilot(opts) {
  const report = { command: 'doctor', target: 'copilot', version: VERSION, problems: [], warnings: [], summary: [] };
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
  ui.title(L(`EvoLink 诊断 · VS Code Chat v${VERSION}`, `EvoLink doctor · VS Code Chat v${VERSION}`));
  ui.step(1, 2, L('环境', 'Environment'));
  const osl = osLabel();
  ui.ok(`${osl} · Node ${process.versions.node}`);
  const targets = copilotFiles();
  if (!targets.length) problem(L('没有找到桌面版 VS Code 的用户目录（要在装了 VS Code 的电脑上运行）', 'No desktop VS Code user folder found (run this on the computer with VS Code)'));
  report.summary.push(`evolink-doctor ${VERSION} copilot | ${osl} | node ${process.versions.node} | editors ${targets.map((t) => t.name).join(',') || 'none'}`);

  ui.step(2, 2, L('配置', 'Configuration'));
  for (const t of targets) {
    if (!isFile(t.file)) {
      problem(L(`${t.name}：${tildify(t.file)} 不存在，还没配置过（运行 ${cmd} setup copilot）`, `${t.name}: ${tildify(t.file)} does not exist; run ${cmd} setup copilot`));
      report.summary.push(`${t.name}: file=no`);
      continue;
    }
    let groups;
    try {
      groups = JSON.parse(stripJsonComments(fs.readFileSync(t.file, 'utf8').replace(/^\uFEFF/, '')).replace(/,(\s*[}\]])/g, '$1'));
    } catch (e) {
      problem(L(`${t.name}：${tildify(t.file)} 不是有效的 JSON（${e.message}）`, `${t.name}: ${tildify(t.file)} is not valid JSON (${e.message})`));
      report.summary.push(`${t.name}: file=invalid`);
      continue;
    }
    const g = Array.isArray(groups) ? groups.find((x) => isPlainObject(x) && x.vendor === COPILOT_VENDOR && x.name === COPILOT_GROUP) : null;
    if (!g) {
      problem(L(`${t.name}：没有 "${COPILOT_GROUP}" 这一组（运行 ${cmd} setup copilot）`, `${t.name}: no "${COPILOT_GROUP}" group; run ${cmd} setup copilot`));
      report.summary.push(`${t.name}: group=no`);
      continue;
    }
    const models = Array.isArray(g.models) ? g.models : [];
    ui.ok(L(`${t.name}：${models.length} 个 EvoLink 模型  ${ui.dim(tildify(t.file))}`, `${t.name}: ${models.length} EvoLink models  ${ui.dim(tildify(t.file))}`));
    // Model URLs end in the API path (/v1/messages …); the base address is what identifies EvoLink.
    const notEvolink = models.filter((m) => !isEvolinkUrl(String(m?.url || '').replace(/\/v1\/(messages|responses|chat\/completions)\/?$/, '')));
    if (notEvolink.length) problem(L(`${t.name}：${notEvolink.length} 个模型的地址不是 EvoLink（${notEvolink.map((m) => m.id).join(', ')}）`, `${t.name}: ${notEvolink.length} model(s) do not point at EvoLink (${notEvolink.map((m) => m.id).join(', ')})`));
    const gemini = models.filter((m) => /^gemini-/i.test(String(m?.id)));
    if (gemini.length) warn(L(`${t.name}：Gemini 模型在 Agent 模式下会被拒绝（网关转发工具参数的问题，等修复）`, `${t.name}: Gemini models are rejected in Agent mode (a gateway issue with tool parameters, pending a fix)`));
    const keySet = copilotKeySet(g);
    if (keySet) ui.ok(L(`${t.name}：已在 VS Code 里设置 Key（存在系统钥匙串，这里看不到内容）`, `${t.name}: a key is set in VS Code (kept in the system keychain; not visible here)`));
    else if (typeof g.apiKey === 'string' && g.apiKey) problem(L(`${t.name}：文件里直接写了 Key，VS Code 不会用它；请在 VS Code 里用 "Update API Key" 重新粘贴，并把文件里的 Key 删掉`, `${t.name}: the file holds a plain key, which VS Code ignores; paste it with "Update API Key" in VS Code and remove it from the file`));
    else {
      problem(L(`${t.name}：还没在 VS Code 里粘贴 Key，EvoLink 的模型用不了`, `${t.name}: no key pasted in VS Code yet, so the EvoLink models cannot be used`));
      copilotPasteSteps().forEach((line, i) => ui.sub(`${i + 1}. ${line}`));
    }
    report.summary.push(`${t.name}: group=yes models=${models.length} key=${keySet ? 'set' : g.apiKey ? 'plain' : 'missing'} non_evolink=${notEvolink.length} gemini=${gemini.length}`);
  }
  ui.print('');
  if (report.problems.length) ui.title(`${ui.mark('err')} ${L(`发现 ${report.problems.length} 个问题（见上方 ✗）`, `${report.problems.length} problem(s) found (marked above)`)}`);
  else ui.title(`${ui.mark('ok')} ${L('没有发现问题', 'No problems found')}`);
  ui.print('');
  ui.print(ui.dim(L('—— 以下内容可以直接发给客服（Key 已隐去）——', '--- Send the lines below to support (key hidden) ---')));
  for (const line of report.summary) ui.print(line);
  if (report.problems.length) ui.print(`problems: ${report.problems.length}`);
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.problems.length ? EXIT.ERROR : EXIT.OK;
}

async function resetCopilot(opts) {
  const interactive = !opts.yes && !opts.json;
  const state = loadState();
  const cp = state.copilot;
  ui.title(L(`EvoLink 撤销配置 · VS Code Chat v${VERSION}`, `EvoLink reset · VS Code Chat v${VERSION}`));
  if (!cp || !Object.keys(cp.files || {}).length) {
    ui.info(L('没有找到 evolink setup copilot 的改动记录，无需撤销。', 'No changes recorded by evolink setup copilot; nothing to undo.'));
    return { result: { ok: true, changes: [] }, code: EXIT.OK };
  }
  const actions = [];
  for (const [file, rec] of Object.entries(cp.files)) {
    if (!isFile(file)) continue;
    try {
      const p = planCopilotRestore(fs.readFileSync(file, 'utf8'), rec);
      if (p.changed) actions.push({ file, ...p });
    } catch (e) {
      ui.warn(L(`${tildify(file)} 现在不是有效的 JSON（${e.message}），没法自动撤销；改动前的副本在 ~/.evolink/backups/ 里。`, `${tildify(file)} is not valid JSON now (${e.message}), so it cannot be undone automatically; the copy from before setup is in ~/.evolink/backups/.`));
    }
  }
  ui.print('');
  for (const a of actions) ui.print(`  ${tildify(a.file)}  ${a.remove ? L('删除（由 setup 新建）', 'deleted (created by setup)') : L(`去掉 "${COPILOT_GROUP}" 这一组（setup 之前就有的话还原成原来的样子）`, `the "${COPILOT_GROUP}" group goes (or is put back as it was before setup)`)}`);
  if (actions.some((a) => a.keyWasSet)) ui.info(L('VS Code 钥匙串里保存的 Key 不会跟着删除；要删的话，先在 VS Code 的 Language Models 页面里删掉这一组，再撤销。', "The key VS Code saved in its keychain stays there; to remove it too, delete the group in VS Code's Language Models page before undoing."));
  if (!actions.length) {
    ui.ok(L('没有需要撤销的内容。', 'Nothing to undo.'));
    if (!opts.dryRun) {
      delete state.copilot;
      saveState(state);
    }
    return { result: { ok: true, changes: [] }, code: EXIT.OK };
  }
  if (opts.dryRun) {
    ui.info(L('这是预览（--dry-run），没有写入任何文件。', 'Preview only (--dry-run); nothing was written.'));
    return { result: { ok: true, dryRun: true }, code: EXIT.OK };
  }
  if (interactive && !(await confirm(L('确认撤销？', 'Undo these changes?'), true))) throw new CancelledError();
  const backup = newBackupSession();
  for (const a of actions) {
    backupFile(backup, a.file, 'chatLanguageModels.json');
    if (a.remove) fs.unlinkSync(a.file);
    else writeAtomic(a.file, a.text, { mode: 0o644 });
  }
  delete state.copilot;
  saveState(state);
  ui.ok(L(`已撤销。改动前的文件备份在 ${tildify(backup.dir)}`, `Undone. Backups are in ${tildify(backup.dir)}`));
  return { result: { ok: true, backupDir: backup.dir, restored: actions.length }, code: EXIT.OK };
}

// ---------------------------------------------------------------------------
// doctor

async function cmdDoctor(opts) {
  const target = opts._[1];
  if (CODEX_TARGETS.includes(target)) return cmdDoctorCodex(opts);
  if (COPILOT_TARGETS.includes(target)) return cmdDoctorCopilot(opts);
  if (target && !['claude-code', 'claude'].includes(target)) throw new CliError(L(`不认识 ${target}（可用：claude-code、codex、copilot）`, `Unknown target ${target} (claude-code, codex, copilot)`), EXIT.USAGE);
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
      latest = await latestNpmVersion(opts);
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
  else ui.info(L('没设 CLAUDE_CODE_MAX_OUTPUT_TOKENS（默认不设）：Opus 等模型单次预扣较高，余额少时可重新运行 setup --max-output-tokens 32000', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS not set (the default); pricey models hold more credits per request, re-run setup --max-output-tokens 32000 if credits are low'));
  if (env.ANTHROPIC_MODEL) ui.info(`ANTHROPIC_MODEL = ${env.ANTHROPIC_MODEL}`);
  const autoModeOff = sr.data?.disableAutoMode === 'disable';
  if (autoModeOff) ui.ok(L('auto mode 已关闭（EvoLink 暂不支持它的审核请求）', 'auto mode is off (EvoLink cannot serve its review requests yet)'));
  else warn(L('auto mode 没有关闭：Claude Code 2.1.283 起默认开启，走 EvoLink 时需要审核的命令会被拦下并计费；重新运行 setup 可关闭', 'auto mode is not turned off: Claude Code 2.1.283+ starts in auto mode, and through EvoLink reviewed commands get blocked and billed; re-run setup to turn it off'));
  for (const v of PROVIDER_VARS) if (truthy(env[v])) problem(L(`settings.json 里 ${v}=${env[v]}：Claude Code 会改走其他云，EvoLink 不生效`, `settings.json sets ${v}=${env[v]}; EvoLink is bypassed`));
  const credential = token || apiKey || null;
  report.summary.push(`settings: base=${baseUrl || '-'} token=${token ? maskKey(token) : '-'} api_key=${apiKey === '' ? '""' : apiKey ? maskKey(apiKey) : '-'} maxout=${env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '-'} model=${env.ANTHROPIC_MODEL || '-'} sonnet=${env.ANTHROPIC_DEFAULT_SONNET_MODEL || '-'} automode=${autoModeOff ? 'off' : 'on'}`);

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
    if (ids.size) {
      const sonnetPin = env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      const best = pickSonnetPin(ids);
      if (sonnetPin && modelAvailable(sonnetPin, ids)) ui.ok(L(`ANTHROPIC_DEFAULT_SONNET_MODEL = ${sonnetPin}（/model 里的 Sonnet 用它）`, `ANTHROPIC_DEFAULT_SONNET_MODEL = ${sonnetPin} (used for the Sonnet alias)`));
      else if (!sonnetPin && best && !ids.has(CLAUDE_CODE_SONNET_ALIAS)) warn(L(`没设 ANTHROPIC_DEFAULT_SONNET_MODEL：Claude Code 2.1.284 起 /model 里的 Sonnet 指向 ${CLAUDE_CODE_SONNET_ALIAS}，这把 Key 用不了；重新运行 setup 会把它钉到 ${best}`, `ANTHROPIC_DEFAULT_SONNET_MODEL is not set: Claude Code 2.1.284+ resolves the Sonnet alias to ${CLAUDE_CODE_SONNET_ALIAS}, which this key cannot use; re-run setup to pin it to ${best}`));
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
  for (const name of editorsMissing(CLAUDE_EXTENSION)) {
    ui.info(L(`${name} 没装 Claude Code 扩展（需要的话：${cmd} setup --install-extension）`, `${name} does not have the Claude Code extension (to add it: ${cmd} setup --install-extension)`));
  }
  if (isFile(codexPaths().profile)) ui.info(L(`也配置了 Codex：运行 ${cmd} doctor codex 查看`, `Codex is set up too: run ${cmd} doctor codex`));

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
  const target = opts._[1] || null;
  const codex = !target || CODEX_TARGETS.includes(target);
  const claude = !target || ['claude-code', 'claude'].includes(target);
  const copilot = !target || COPILOT_TARGETS.includes(target);
  if (!codex && !claude && !copilot) throw new CliError(L(`不认识 ${target}（可用：claude-code、codex、copilot）`, `Unknown target ${target} (claude-code, codex, copilot)`), EXIT.USAGE);
  // Without a target, undo everything setup recorded; with nothing recorded at all, the Claude Code part says so.
  const state = loadState();
  const parts = {};
  let code = EXIT.OK;
  if (claude && (target || state.claudeCode || (!state.codex && !state.copilot))) {
    const r = await resetClaude(opts);
    parts.claudeCode = r.result;
    code = code || r.code;
  }
  if (codex && (target || state.codex)) {
    if (parts.claudeCode) ui.print('');
    const r = await resetCodex(opts);
    parts.codex = r.result;
    code = code || r.code;
  }
  if (copilot && (target || state.copilot)) {
    if (Object.keys(parts).length) ui.print('');
    const r = await resetCopilot(opts);
    parts.copilot = r.result;
    code = code || r.code;
  }
  const names = Object.keys(parts);
  const result = names.length === 1 ? { command: 'reset', ...parts[names[0]] } : { command: 'reset', ok: names.every((k) => parts[k].ok), ...parts };
  return finish(result, opts, code);
}

async function resetClaude(opts) {
  const interactive = !opts.yes && !opts.json;
  const state = loadState();
  const cc = state.claudeCode;
  ui.title(L(`EvoLink 撤销配置 v${VERSION}`, `EvoLink reset v${VERSION}`));
  if (!cc) {
    ui.info(L('没有找到 evolink setup 的改动记录，无需撤销。', 'No changes recorded by evolink setup; nothing to undo.'));
    return { result: { ok: true, changes: [] }, code: EXIT.OK };
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
    return { result: { ok: true, changes: [] }, code: EXIT.OK };
  }
  if (opts.dryRun) {
    ui.info(L('这是预览（--dry-run），没有写入任何文件。', 'Preview only (--dry-run); nothing was written.'));
    return { result: { ok: true, dryRun: true }, code: EXIT.OK };
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
  return { result: { ok: true, backupDir: backup.dir, restored: total, skipped }, code: EXIT.OK };
}

// ---------------------------------------------------------------------------
// CLI entry

const BOOL_FLAGS = new Set(['yes', 'dry-run', 'json', 'help', 'version', 'install', 'test', 'onboarding', 'key-stdin', 'skip-checks', 'replace-invalid', 'vscode', 'disable-nonessential-traffic', 'auto-mode', 'pin-sonnet', 'install-extension', 'all-models']);
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
    `EvoLink 命令行工具 v${VERSION}：一键把 Claude Code / Codex 接到 EvoLink

用法：
  evolink [setup]      配置 Claude Code（默认命令）
  evolink setup codex  配置 Codex 命令行：新建独立配置档，用 codex -p evolink 启动，不动你原来的 config.toml
  evolink setup codex --vscode  配置 VS Code 等编辑器里的 Codex 扩展：修改 config.toml（终端里直接运行 codex 也会走 EvoLink），默认顺便装上扩展
  evolink setup copilot  在 VS Code 内置的 Chat 里加一组 EvoLink 模型（不需要 GitHub 账号）；Key 要在 VS Code 里粘贴一次
  evolink doctor       诊断当前配置，输出可以直接发给客服（Key 已隐去）；Codex、Chat 用 evolink doctor codex / copilot
  evolink reset        撤销 setup 做的改动（只撤销某一项：evolink reset codex / copilot）

常用选项：
  --model <id>         默认模型，如 claude-sonnet-5（Codex 如 gpt-6-sol）；default 表示跟随 Claude Code 默认
  --yes, -y            不提问，全部用默认值（Key 从环境变量 EVOLINK_API_KEY 读取）
  --key-stdin          从标准输入读取 Key
  --dry-run            只预览改动，不写文件
  --trust <文件夹>      预先信任这个文件夹，首次启动不再询问（macOS / Linux）
  --max-output-tokens <n>  单次输出上限，默认不设置（跟随 Claude Code）；余额少时建议 32000，可降低单次预扣
  --disable-nonessential-traffic  关闭自动更新、遥测等非必要请求（默认不关）
  --auto-mode          不关闭 Claude Code 的 auto mode（默认关闭：EvoLink 暂不支持它的审核请求）
  --no-pin-sonnet      不把 /model 里的 Sonnet 钉到这把 Key 能用的最新 Sonnet（默认钉住：Claude Code 换默认 Sonnet 时，EvoLink 可能晚一两天才有）
  --no-install         没装 Claude Code（或 Codex）时不自动安装
  --install-extension  顺便给 VS Code / Cursor 等编辑器装上 Claude Code 扩展（默认不装：终端里的 claude 用不到它）
  --no-install-extension  setup codex --vscode 时不装 Codex 扩展（默认会装：没有扩展这个模式用不了）
  --all-models         setup copilot 时加入这把 Key 能用的全部聊天模型（默认只加推荐的十几个）
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
    `EvoLink CLI v${VERSION}: connect Claude Code or Codex to EvoLink in one command

Usage:
  evolink [setup]      configure Claude Code (default)
  evolink setup codex  configure the Codex CLI: a separate profile, started with codex -p evolink; your config.toml is left alone
  evolink setup codex --vscode  configure the Codex extension in VS Code and similar editors: changes config.toml (a plain codex then uses EvoLink too) and installs the extension
  evolink setup copilot  add a group of EvoLink models to VS Code's built-in Chat (no GitHub account needed); paste the key once in VS Code
  evolink doctor       diagnose the setup; output is safe to send to support (Codex / Chat: evolink doctor codex / copilot)
  evolink reset        undo what setup changed (one part only: evolink reset codex / copilot)

Options:
  --model <id>         default model, e.g. claude-sonnet-5 (Codex: gpt-6-sol); "default" = Claude Code's own default
  --yes, -y            no prompts (key from EVOLINK_API_KEY)
  --key-stdin          read the key from stdin
  --dry-run            preview only
  --trust <folder>     pre-trust a folder (macOS / Linux)
  --max-output-tokens <n>  output cap, unset by default (Claude Code's own); 32000 lowers the per-request hold when credits are low
  --disable-nonessential-traffic  turn off auto-update, telemetry and other background traffic (on by default)
  --auto-mode          keep Claude Code's auto mode on (off by default: EvoLink cannot serve its review requests yet)
  --no-pin-sonnet      do not pin the Sonnet alias to the newest Sonnet this key can use (pinned by default: when Claude Code moves the alias, EvoLink may lag a day or two)
  --no-install         do not install Claude Code (or Codex) when missing
  --install-extension  also install the Claude Code extension into VS Code, Cursor and similar editors (off by default: the terminal claude does not need it)
  --no-install-extension  with setup codex --vscode, do not install the Codex extension (installed by default: the mode needs it)
  --all-models         with setup copilot, add every chat model this key can use (only the recommended dozen or so by default)
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
__EVOLINK_CLI_EOF__
  local actual=""
  if command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$tmp" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp" | awk '{print $1}')"
  else actual="$("$node" -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$tmp")"; fi
  if [ "$actual" != "$expected_sha" ]; then
    rm -f "$tmp"
    say "下载的脚本不完整（校验失败），请重新运行。" "The downloaded script is incomplete (checksum mismatch); please run it again."
    return 1
  fi
  mv -f "$tmp" "$cli"
  local launcher="$home_dir/bin/evolink"
  {
    printf '#!/bin/sh\n'
    printf '# EvoLink CLI launcher (version %s)\n' "$version"
    printf 'NODE="${EVOLINK_NODE:-$(command -v node 2>/dev/null)}"\n'
    printf '[ -x "$NODE" ] || NODE="%s"\n' "$node"
    printf 'exec "$NODE" "%s" "$@"\n' "$cli"
  } >"$launcher"
  chmod 755 "$launcher"

  # 3. Run it (commands: setup / doctor / reset; setup when omitted)
  case "${1:-}" in setup | doctor | reset | help | --help | -h | --version | -v) ;; *) set -- setup "$@" ;; esac
  local shown="$launcher"
  case "$launcher" in "$HOME"/*) shown="~${launcher#"$HOME"}" ;; esac
  if [ "$tty" = 1 ]; then
    EVOLINK_CMD="$shown" "$node" "$cli" "$@" </dev/tty
  else
    EVOLINK_CMD="$shown" "$node" "$cli" "$@"
  fi
}

evolink_main "$@"
