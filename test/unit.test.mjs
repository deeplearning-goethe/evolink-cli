import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeKey,
  checkKeyFormat,
  maskKey,
  normalizeBaseUrl,
  isEvolinkUrl,
  modelAvailable,
  suggestModel,
  pickTestModel,
  pickSonnetPin,
  planEnvChanges,
  applyEnvChanges,
  recordChanges,
  planRestore,
  planDisableLoginPrompt,
  undoDisableLoginPrompt,
  stripJsonComments,
  scanShellText,
  parseRegQuery,
  classifyConflict,
  jsonHints,
  detectLang,
  parseArgs,
  describeFailure,
  compareVersions,
  officialAccount,
  overridesLogin,
  codexModelIds,
  renderCodexProfile,
  parseCodexProfile,
  splitCodexProfile,
  codexProfileCore,
  scanCodexConfig,
  extensionLink,
} from '../bin/evolink.mjs';

const KEY = `sk-${'A1b2C3d4'.repeat(6)}`;

test('normalizeKey strips paste noise', () => {
  assert.equal(normalizeKey(`  ${KEY}\n`), KEY);
  assert.equal(normalizeKey(`"${KEY}"`), KEY);
  assert.equal(normalizeKey(`“${KEY}”`), KEY);
  assert.equal(normalizeKey(`Bearer ${KEY}`), KEY);
  assert.equal(normalizeKey(`\u200B${KEY}\u3000`), KEY);
  assert.equal(normalizeKey(`export ANTHROPIC_AUTH_TOKEN="${KEY}"`), KEY);
});

test('checkKeyFormat flags broken keys', () => {
  assert.deepEqual(checkKeyFormat(KEY), { ok: true });
  assert.equal(checkKeyFormat('').reason, 'empty');
  assert.equal(checkKeyFormat(`${KEY.slice(0, 20)} ${KEY.slice(20)}`).reason, 'whitespace');
  assert.equal(checkKeyFormat(`${KEY}，`).reason, 'non_ascii');
  assert.equal(checkKeyFormat(`${KEY}-12`).warn, 'dash_suffix');
  assert.equal(checkKeyFormat('sk-short').warn, 'unusual_format');
  assert.deepEqual(checkKeyFormat(KEY.slice(3)), { ok: true });
});

test('maskKey never shows the middle of the key', () => {
  const m = maskKey(KEY);
  assert.equal(m, `sk-${KEY.slice(3, 7)}…${KEY.slice(-4)}`);
  assert.ok(!m.includes(KEY.slice(7, -4)));
  assert.equal(maskKey('sk-abc'), 'sk-****');
});

test('normalizeBaseUrl drops /v1 and trailing slashes', () => {
  assert.deepEqual(normalizeBaseUrl('https://direct.evolink.ai'), { url: 'https://direct.evolink.ai', strippedV1: false });
  assert.deepEqual(normalizeBaseUrl('https://direct.evolink.ai/v1/'), { url: 'https://direct.evolink.ai', strippedV1: true });
  assert.equal(normalizeBaseUrl('direct.evolink.ai').error, 'invalid');
  assert.ok(isEvolinkUrl('https://api.evolink.ai/v1'));
  assert.ok(!isEvolinkUrl('https://open.bigmodel.cn/api/anthropic'));
});

test('model availability, suggestions and test model', () => {
  const ids = new Set(['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'gpt-6-luna']);
  assert.ok(modelAvailable('claude-opus-5-5', ids));
  assert.ok(modelAvailable('claude-opus-5-5[1m]', ids));
  assert.ok(modelAvailable('opus', ids));
  assert.ok(!modelAvailable('glm-5.3', ids));
  assert.equal(suggestModel('claude-opus-5.5', ids), 'claude-opus-5-5');
  assert.equal(suggestModel('Claude-Sonnet-5', ids), 'claude-sonnet-5');
  assert.equal(pickTestModel(null, ids), 'claude-haiku-4-5-20251001');
  assert.equal(pickTestModel('claude-sonnet-5', ids), 'claude-sonnet-5');
  assert.equal(pickTestModel(null, new Set(['gpt-6-luna'])), null);
});

test('env plan: set, remove, record and restore round-trip', () => {
  const original = { env: { ANTHROPIC_BASE_URL: 'https://old.example.com', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3', KEEP: '1' }, permissions: { allow: ['Bash(ls)'] } };
  const changes = planEnvChanges(original.env, {
    set: { ANTHROPIC_BASE_URL: 'https://direct.evolink.ai', ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_API_KEY: '' },
    remove: ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'NOT_THERE'],
  });
  assert.equal(changes.length, 4);
  const next = applyEnvChanges(original, changes);
  assert.deepEqual(next.env, { ANTHROPIC_BASE_URL: 'https://direct.evolink.ai', KEEP: '1', ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_API_KEY: '' });
  assert.deepEqual(next.permissions, original.permissions);
  assert.equal(original.env.ANTHROPIC_BASE_URL, 'https://old.example.com', 'input is not mutated');

  const rec = {};
  recordChanges(rec, changes);
  assert.equal(rec.ANTHROPIC_BASE_URL.before, 'https://old.example.com');
  assert.equal(rec.ANTHROPIC_AUTH_TOKEN.existed, false);
  assert.ok(!JSON.stringify(rec).includes(KEY), 'state never stores the new key in clear text');

  const restore = planRestore(next.env, rec);
  assert.deepEqual(restore.skipped, []);
  const back = applyEnvChanges(next, restore.changes);
  assert.deepEqual(back.env, original.env);
});

test('restore leaves values edited after setup alone', () => {
  const changes = planEnvChanges({}, { set: { ANTHROPIC_MODEL: 'claude-sonnet-5' } });
  const rec = {};
  recordChanges(rec, changes);
  const r = planRestore({ ANTHROPIC_MODEL: 'claude-opus-5-5' }, rec);
  assert.deepEqual(r.skipped, ['ANTHROPIC_MODEL']);
  assert.equal(r.changes.length, 0);
});

test('second setup run keeps the original "before" value', () => {
  const rec = {};
  recordChanges(rec, planEnvChanges({ ANTHROPIC_AUTH_TOKEN: 'old' }, { set: { ANTHROPIC_AUTH_TOKEN: 'k1' } }));
  recordChanges(rec, planEnvChanges({ ANTHROPIC_AUTH_TOKEN: 'k1' }, { set: { ANTHROPIC_AUTH_TOKEN: 'k2' } }));
  const r = planRestore({ ANTHROPIC_AUTH_TOKEN: 'k2' }, rec);
  assert.equal(r.changes[0].after, 'old');
});

test('VS Code settings edits preserve comments and can be undone', () => {
  assert.equal(planDisableLoginPrompt(null).action, 'create');
  const created = planDisableLoginPrompt(null).text;
  assert.equal(undoDisableLoginPrompt(created, { action: 'create' }), '');

  const empty = planDisableLoginPrompt('{}\n');
  assert.equal(empty.action, 'fill');
  assert.deepEqual(JSON.parse(empty.text), { 'claudeCode.disableLoginPrompt': true });
  assert.equal(undoDisableLoginPrompt(empty.text, { action: 'fill' }), '{}\n');

  const src = '// my settings\n{\n  // font\n  "editor.fontSize": 14,\n  "files.autoSave": "afterDelay",\n}\n';
  const ins = planDisableLoginPrompt(src);
  assert.equal(ins.action, 'insert');
  assert.ok(ins.text.includes('// font') && ins.text.includes('// my settings'));
  const parsed = JSON.parse(stripJsonComments(ins.text).replace(/,(\s*[}\]])/g, '$1'));
  assert.equal(parsed['claudeCode.disableLoginPrompt'], true);
  assert.equal(parsed['editor.fontSize'], 14);
  assert.equal(undoDisableLoginPrompt(ins.text, { action: 'insert', inserted: ins.inserted }), src);

  const flip = planDisableLoginPrompt('{ "claudeCode.disableLoginPrompt": false }');
  assert.equal(flip.action, 'flip');
  assert.equal(undoDisableLoginPrompt(flip.text, { action: 'flip' }), '{ "claudeCode.disableLoginPrompt": false }');
  assert.equal(planDisableLoginPrompt('{ "claudeCode.disableLoginPrompt": true }').action, 'none');
  assert.equal(planDisableLoginPrompt('[1, 2]').action, 'manual');
});

test('stripJsonComments keeps // inside strings', () => {
  assert.equal(JSON.parse(stripJsonComments('{"u": "https://x.y/z" // c\n}')).u, 'https://x.y/z');
});

test('shell profile scanning finds exports in sh, fish and PowerShell forms', () => {
  const text = [
    '# export ANTHROPIC_API_KEY=commented',
    'export ANTHROPIC_API_KEY="sk-old"',
    'ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic',
    'export PATH="$HOME/bin:$PATH"',
    'set -gx ANTHROPIC_DEFAULT_SONNET_MODEL kimi-k3',
    '$env:CLAUDE_CODE_USE_BEDROCK = "1"',
    "[System.Environment]::SetEnvironmentVariable('ANTHROPIC_AUTH_TOKEN', 'sk-x', 'User')",
  ].join('\n');
  const hits = scanShellText(text, '/tmp/rc');
  assert.deepEqual(
    hits.map((h) => [h.name, h.value, h.where]),
    [
      ['ANTHROPIC_API_KEY', 'sk-old', '/tmp/rc:2'],
      ['ANTHROPIC_BASE_URL', 'https://open.bigmodel.cn/api/anthropic', '/tmp/rc:3'],
      ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'kimi-k3', '/tmp/rc:5'],
      ['CLAUDE_CODE_USE_BEDROCK', '1', '/tmp/rc:6'],
      ['ANTHROPIC_AUTH_TOKEN', 'sk-x', '/tmp/rc:7'],
    ],
  );
});

test('reg query output parsing', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\x\r\n    ANTHROPIC_API_KEY    REG_SZ    sk-old\r\n    ANTHROPIC_BASE_URL    REG_SZ    https://direct.evolink.ai\r\n';
  const hits = parseRegQuery(out, 'user');
  assert.deepEqual(hits.map((h) => [h.name, h.value]), [['ANTHROPIC_API_KEY', 'sk-old'], ['ANTHROPIC_BASE_URL', 'https://direct.evolink.ai']]);
});

test('conflict classification', () => {
  const ids = new Set(['claude-sonnet-5']);
  assert.equal(classifyConflict({ source: 'env', name: 'CLAUDE_CODE_USE_BEDROCK', value: '1' }, ids), 'error');
  assert.equal(classifyConflict({ source: 'env', name: 'CLAUDE_CODE_USE_BEDROCK', value: '0' }, ids), null);
  assert.equal(classifyConflict({ source: 'managed', name: 'ANTHROPIC_BASE_URL', value: 'x' }, ids), 'error');
  assert.equal(classifyConflict({ source: 'project', name: 'ANTHROPIC_MODEL', value: 'claude-sonnet-5' }, ids), 'warn');
  assert.equal(classifyConflict({ source: 'file', name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: 'glm-5.3' }, ids), 'error');
  assert.equal(classifyConflict({ source: 'file', name: 'ANTHROPIC_API_KEY', value: 'sk-old' }, ids), 'info');
});

test('JSON hints for hand-edited files', () => {
  assert.deepEqual(jsonHints('{ "env": { "A"： "1" } }'), ['fullwidth']);
  assert.deepEqual(jsonHints('{ "env": { "A": "1", } }'), ['trailing_comma']);
  assert.deepEqual(jsonHints('{"u": "https://a"}'), []);
});

test('language detection', () => {
  assert.equal(detectLang(undefined, { LANG: 'zh_CN.UTF-8' }), 'zh');
  assert.equal(detectLang(undefined, { LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(detectLang('zh', { LANG: 'en_US.UTF-8' }), 'zh');
  assert.equal(detectLang(undefined, { EVOLINK_LANG: 'en', LANG: 'zh_CN' }), 'en');
});

test('argument parsing', () => {
  const o = parseArgs(['setup', '-y', '--model', 'claude-sonnet-5', '--no-test', '--max-output-tokens=0', '--trust', '.']);
  assert.deepEqual(o._, ['setup']);
  assert.equal(o.yes, true);
  assert.equal(o.model, 'claude-sonnet-5');
  assert.equal(o.test, false);
  assert.equal(o.maxOutputTokens, 0);
  assert.equal(o.trust, '.');
  assert.throws(() => parseArgs(['--nope']));
  assert.throws(() => parseArgs(['--max-output-tokens', 'abc']));
  assert.equal(parseArgs([]).maxOutputTokens, 0);
  assert.equal(parseArgs(['--max-output-tokens', '32000']).maxOutputTokens, 32000);
  assert.equal(parseArgs(['--disable-nonessential-traffic']).disableNonessentialTraffic, true);
  assert.equal(parseArgs([]).disableNonessentialTraffic, undefined);
  assert.equal(parseArgs(['--auto-mode']).autoMode, true);
  assert.equal(parseArgs([]).autoMode, undefined);
});

test('failure description maps gateway errors', () => {
  const r = (status, message) => ({ status, json: { error: { message: `${message} (request id: 123)` } } });
  assert.deepEqual(describeFailure(r(401, 'Invalid API key')), { kind: 'auth', status: 401, message: 'Invalid API key' });
  assert.equal(describeFailure(r(401, 'This API key has expired')).kind, 'expired');
  assert.equal(describeFailure(r(403, '余额不足: 可用 ¥0.1; insufficient credits')).kind, 'balance');
  assert.equal(describeFailure(r(404, "Model 'x' is not available")).kind, 'model');
  assert.equal(describeFailure({ status: 0, error: { cause: { code: 'ENOTFOUND' } } }).kind, 'dns');
  assert.equal(describeFailure({ status: 0, error: { name: 'TimeoutError' } }).kind, 'timeout');
});

test('version comparison', () => {
  assert.equal(compareVersions('2.1.260', '2.1.283'), -1);
  assert.equal(compareVersions('2.1.283', '2.1.283'), 0);
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(compareVersions('2.1', '2.1.0'), 0);
  assert.equal(compareVersions('2.1.284-beta.1', '2.1.283'), 1);
});

test('official login is detected, and only counts when settings.json does not already override it', () => {
  const noCreds = '/nonexistent-evolink-test';
  assert.deepEqual(officialAccount({ oauthAccount: { emailAddress: 'dev@example.com' } }, noCreds), { email: 'dev@example.com' });
  assert.deepEqual(officialAccount({ oauthAccount: {} }, noCreds), { email: null });
  assert.equal(officialAccount({ numStartups: 3 }, noCreds), null);
  assert.equal(officialAccount(null, noCreds), null);
  assert.equal(overridesLogin({ env: { HTTP_PROXY: 'http://127.0.0.1:7890' }, model: 'opus' }), false);
  assert.equal(overridesLogin({ env: { ANTHROPIC_API_KEY: '' } }), false, 'a blank key overrides nothing');
  assert.equal(overridesLogin({ env: { ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic' } }), true);
  assert.equal(overridesLogin({ env: { ANTHROPIC_AUTH_TOKEN: 'x' } }), true);
  assert.equal(overridesLogin({ apiKeyHelper: '~/bin/key.sh' }), true);
  assert.equal(overridesLogin(null), false);
});

test('sonnet pin picks the newest Sonnet the key can use', () => {
  // Claude Code 2.1.284 sends claude-sonnet-5-5 for the "sonnet" alias; the pin must follow what the key can use.
  assert.equal(pickSonnetPin(new Set(['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'gpt-6-luna'])), 'claude-sonnet-5');
  assert.equal(pickSonnetPin(new Set(['claude-sonnet-5', 'claude-sonnet-5-5'])), 'claude-sonnet-5-5');
  assert.equal(pickSonnetPin(new Set(['claude-sonnet-4-5-20250929', 'claude-sonnet-4-6', 'claude-sonnet-4-20250514'])), 'claude-sonnet-4-6');
  assert.equal(pickSonnetPin(new Set(['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'])), 'claude-sonnet-4-5', 'a dated id loses to the plain id of the same version');
  assert.equal(pickSonnetPin(new Set(['claude-sonnet-4-20250514', 'claude-sonnet-4-0'])), 'claude-sonnet-4-0');
  assert.equal(pickSonnetPin(new Set(['claude-opus-5-5', 'gpt-6-luna'])), null);
  assert.equal(pickSonnetPin(new Set()), null);
});

test('Codex models: GPT text models only, image models left out', () => {
  const ids = new Set(['gpt-6-sol', 'gpt-5.5', 'gpt-image-2', 'gpt-4o-image', 'gpt-image-1.5-lite', 'claude-sonnet-5', 'gemini-3.8-flash', 'gpt-6.1-sol']);
  assert.deepEqual(codexModelIds(ids), ['gpt-5.5', 'gpt-6-sol', 'gpt-6.1-sol']);
  assert.deepEqual(codexModelIds(new Set(['claude-opus-5-5'])), []);
});

test('Codex profile: written whole, read back, strings escaped for TOML', () => {
  const text = renderCodexProfile({ base: 'https://direct.evolink.ai', key: KEY, model: 'gpt-6.1-sol' });
  assert.match(text, /^model = "gpt-6\.1-sol"$/m);
  assert.match(text, /^model_provider = "evolink-cli"$/m);
  assert.match(text, /^web_search = "disabled"$/m);
  assert.match(text, /^\[model_providers\.evolink-cli\]$/m);
  assert.match(text, /^base_url = "https:\/\/direct\.evolink\.ai\/v1"$/m);
  assert.match(text, /^wire_api = "responses"$/m);
  assert.doesNotMatch(text, /approvals_reviewer|model_catalog_json/);
  // Top-level keys must come before the first [table], or TOML puts them inside it.
  const withReviewer = renderCodexProfile({ base: 'https://direct.evolink.ai', key: KEY, model: 'gpt-6.1-sol', reviewer: 'user' });
  assert.ok(withReviewer.indexOf('approvals_reviewer = "user"') < withReviewer.indexOf('[model_providers'));
  const p = parseCodexProfile(withReviewer);
  assert.equal(p.model, 'gpt-6.1-sol');
  assert.equal(p.model_provider, 'evolink-cli');
  assert.equal(p.experimental_bearer_token, KEY);
  assert.equal(p.base_url, 'https://direct.evolink.ai/v1');
  assert.equal(p.approvals_reviewer, 'user');
  assert.equal(parseCodexProfile('x = "a \\"quoted\\" C:\\\\path"\nmodel = "m"').model, 'm');
  assert.deepEqual(parseCodexProfile(''), {});
});

test('Codex profile: what Codex or the user adds is carried over; setup recognises its own file', () => {
  const ours = renderCodexProfile({ base: 'https://direct.evolink.ai', key: KEY, model: 'gpt-6.1-sol' });
  // What Codex 0.159.2 appended in a live TUI session, plus a user's own setting and table.
  const grown = `${ours}\n[tui]\nscreen_reader_detection_done = true\n\n[projects."/Users/a/proj"]\ntrust_level = "trusted"\n`.replace(
    'web_search = "disabled"\n',
    'web_search = "disabled"\nmodel_reasoning_effort = "high"\n',
  );
  const parts = splitCodexProfile(grown);
  assert.equal(parts.ours, true);
  assert.equal(parts.core, splitCodexProfile(ours).core, 'the managed part is unchanged');
  assert.equal(parts.top, 'model_reasoning_effort = "high"');
  assert.match(parts.tables, /^\[tui\]\nscreen_reader_detection_done = true\n\n\[projects\."\/Users\/a\/proj"\]\ntrust_level = "trusted"$/);
  assert.equal(codexProfileCore(grown), codexProfileCore(ours));
  const again = renderCodexProfile({ base: 'https://direct.evolink.ai', key: KEY, model: 'gpt-6-sol', kept: parts });
  assert.match(again, /^model = "gpt-6-sol"$/m);
  assert.ok(again.indexOf('model_reasoning_effort = "high"') < again.indexOf('[model_providers'), 'kept top-level keys stay above the first table');
  assert.ok(again.indexOf('[tui]') > again.indexOf('experimental_bearer_token'), 'kept tables follow ours');
  assert.match(again, /\[projects\."\/Users\/a\/proj"\]\ntrust_level = "trusted"\n$/);
  assert.deepEqual(splitCodexProfile(again), { ...splitCodexProfile(again), top: parts.top, tables: parts.tables, ours: true });
  assert.equal(splitCodexProfile('model = "o3"\n[model_providers.mine]\nname = "x"\n').ours, false, 'a file without our provider table is not ours');
});

test('config.toml scan: blockers and inherited settings for codex -p evolink', () => {
  const s = scanCodexConfig(`profile = "work"
approvals_reviewer = "auto_review"
model_provider = "evolink"

[model_providers.evolink]
name = "EvoLink"
env_key = "OPENAI_API_KEY"

[profiles.evolink]
model = "gpt-5.2"

[profiles.work]
approvals_reviewer = "user"
profile = "nested-is-not-top-level"
`);
  assert.deepEqual(s, { profileTable: true, legacyProfile: 'work', autoReview: true, evolinkEnvKey: 'OPENAI_API_KEY' });
  assert.deepEqual(scanCodexConfig('[profiles."evolink"]\n'), { profileTable: true, legacyProfile: null, autoReview: false, evolinkEnvKey: null });
  assert.deepEqual(scanCodexConfig('[x]\napprovals_reviewer = "auto_review"\n'), { profileTable: false, legacyProfile: null, autoReview: false, evolinkEnvKey: null });
  assert.deepEqual(scanCodexConfig(''), { profileTable: false, legacyProfile: null, autoReview: false, evolinkEnvKey: null });
});

test('extension install links', () => {
  assert.equal(extensionLink('VS Code', 'anthropic.claude-code'), 'vscode:extension/anthropic.claude-code');
  assert.equal(extensionLink('Cursor', 'anthropic.claude-code'), 'cursor:extension/anthropic.claude-code');
  assert.equal(extensionLink('Windsurf', 'openai.chatgpt'), 'vscode:extension/openai.chatgpt');
});
