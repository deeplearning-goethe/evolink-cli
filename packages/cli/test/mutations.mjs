import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// fileURLToPath handles Windows drive letters and spaces.
const { fileURLToPath } = await import('node:url');
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const mutants = [
  ['task-response-accepted-id', 'src/media.mjs', 'if (acceptedId) {', 'if (false) {'],
  ['task-response-known-id-recovery', 'src/media.mjs', 'if (quote.task_id) return', 'if (false) return'],
  ['task-response-error-code', 'src/api.mjs', 'taskReadCode || data?.error?.category', 'data?.error?.category'],
  ['search-notice', 'src/platform/core/src/services/pricing-rules-estimate.js', 'estimate.notes.push(`${label} is enabled.', 'estimate.notes.slice(`${label} is enabled.'],
  ['search-dynamic-rate', 'src/platform/core/src/services/pricing-rules-estimate.js', 'amountsForUC(component.rate.uc)', "amountsForUC('0')"],
  ['search-submission-counts', 'src/platform/core/src/tools/generate.js', 'const body = { ...effectiveInput, model: entry.id };', 'const body = { ...effectiveInput, search_count: 0, model: entry.id };'],
  ['seedance-saved-input', 'src/media.mjs', '...(quote.effective_input ? { effective_input: quote.effective_input, defaults_applied: quote.defaults_applied } : {}),', ''],
  ['seedance-input-fingerprint', 'src/media.mjs', '...(quote.effective_input ? { effective_input: quote.effective_input } : {}),', ''],
  ['seedance-submit-body', 'src/platform/core/src/tools/generate.js', 'const body = { ...effectiveInput, model: entry.id };', 'const body = { ...input, model: entry.id };'],
  ['seedance-unknown-search', 'src/platform/core/src/services/pricing-rules-estimate.js', 'missing.add(search.parameter)', 'missing.delete(search.parameter)'],
  ['seedance-edit-duration', 'src/platform/core/src/services/pricing-quote-client.js', "const expectedEditDuration = name === 'duration_seconds' && entry.id === 'seedance-2.5-video-edit' && isSeedanceGeneration(entry)", 'const expectedEditDuration = false'],
  ['error-refusal-evidence', 'src/media.mjs', "&& ['not_submitted', 'rejected'].includes(e.details?.submission_state)", "&& true"],

  ['rest-capability', 'src/api.mjs', 'if (requireCapability)', 'if (false)'],
  ['rest-strict-input', 'src/platform/core/src/platform-client.js', 'z.object(definition.inputSchema).strict()', 'z.object(definition.inputSchema)'],
  ['rest-origin', 'src/api.mjs', 'origins.has(url.origin)', 'true'],
  ['file-credential-isolation', 'src/api.mjs', "authorization.startsWith('Bearer evup_')", 'true'],
  ['shared-estimate-fresh', 'src/platform/core/src/services/pricing-rules-estimate.js', '{ fresh: true }', '{ fresh: false }'],
  ['shared-submit-fresh', 'src/platform/core/src/services/pricing-rules-estimate.js', '{ fresh: true }', '{ fresh: false }'],
  ['quote-api-origin', 'src/media.mjs', '!quote.api_origin || quote.api_origin === this.client.apiUrl?.origin', 'true'],
  ['oauth-metadata-origin', 'src/oauth.mjs', 'endpoint.origin === issuer', 'true'],
  ['oauth-token-scope', 'src/oauth.mjs', "(!value.scope || value.scope.split(' ').includes('mcp'))", 'true'],
  ['oauth-new-grant-refresh', 'src/oauth.mjs', "parameters.grant_type === 'refresh_token' ? prior?.refresh_token : undefined", 'prior?.refresh_token'],
  ['approval', 'src/media.mjs', 'requireThat(confirmed || resume,', 'requireThat(true,'],
  ['fresh-price', 'src/media.mjs', 'resume && (account_quote || pricing_quote) || priceFingerprint(fresh) === quote.fingerprint', 'true'],
  ['cap-direction', 'src/media.mjs', 'quote.estimate.max_usd <= cap', 'quote.estimate.max_usd >= cap'],
  ['partial-cap', 'src/media.mjs', "quote.estimate?.status === 'estimated' && Number.isFinite(quote.estimate.max_usd)", 'Number.isFinite(quote.estimate.max_usd)'],
  ['invalid-input', 'src/media.mjs', 'quote.input_valid !== false', 'true'],
  ['balance', 'src/media.mjs', 'quote.enough_balance !== false', 'true'],
  ['mcp-limit', 'src/media.mjs', 'quote.enough_limit !== false', 'true'],
  ['daily-limit', 'src/media.mjs', 'quote.enough_daily_limit !== false', 'true'],
  ['input-validation-cap', 'src/media.mjs', 'quote.input_valid === true', 'true'],
  ['estimated-price-range', 'src/media.mjs', 'Number.isFinite(max_usd) && max_usd >= 0', 'true'],
  ['request-id', 'src/media.mjs', 'this.client.call(`generate_${kind}`, { ...generationArgs, client_request_id: quote.client_request_id })', 'this.client.call(`generate_${kind}`, { ...generationArgs, client_request_id: randomUUID() })'],
  ['journal', 'src/media.mjs', "quote.state = 'submitting';", "quote.state = 'quoted';"],
  ['never-submitted-recovery', 'src/media.mjs', "'submission_not_started'", "'submission_already_started'"],
  ['refused-recovery', 'src/media.mjs', "quote.state !== 'refused'", 'true'],
  ['login-binding', 'src/media.mjs', 'quote.binding === (await this.client.credentials.access()).binding', 'true'],
  ['expiry', 'src/media.mjs', 'this.now() < quote.expires_at', 'true'],
  ['quote-ttl-15-minutes', 'src/media.mjs', 'this.now() + APPROVAL_TTL_MS', 'this.now() + 15 * 60_000'],
  ['quote-ttl-server-expiry', 'src/media.mjs', 'Math.min(this.now() + APPROVAL_TTL_MS, serverExpiry ?? Infinity)', 'this.now() + APPROVAL_TTL_MS'],
  ['quote-ttl-expiry-boundary', 'src/media.mjs', 'this.now() < quote.expires_at', 'this.now() <= quote.expires_at'],
  ['input-binding', 'src/media.mjs', 'quote.args_hash === hash(quote.args)', 'true'],
  ['callback-state', 'src/auth.mjs', "url.searchParams.get('state') !== state", 'false'],
  ['logout-retention', 'src/auth.mjs', "requireThat(response.ok, 'logout_failed'", "requireThat(true, 'logout_failed'"],
  ['download-ua', 'src/network.mjs', "headers: { 'User-Agent': USER_AGENT }, signal }", "headers: {}, signal }"],
  ['download-private-address', 'src/network.mjs', 'addresses.every(a => !privateIP(a.address))', 'true'],
  ['download-dns-pinning', 'src/network.mjs', '? callback(null, [address])', "? callback(null, [{ address: '127.0.0.1', family: 4 }])"],
  ['download-content-type', 'src/media-content.mjs', 'generic || type.startsWith(`${kind}/`)', 'true'],
  ['download-media-header', 'src/media-content.mjs', 'kinds.includes(kind)', 'true'],
  ['quote-error-budget', 'src/media.mjs', '...(cap !== undefined ? { max_cost_usd: cap } : {})', '...{}'],
  ['doctor-prerequisites', 'src/doctor.mjs', 'runtime && storage && login', 'true'],
  ['skill-modified', 'src/skills.mjs', '!modified || replaceModified', 'true'],
  ['model-verification', 'src/doctor.mjs', 'result.models.length > 0', 'true'],
  ['setup-network-login', 'src/setup.mjs', '!LOGIN_ERRORS.has(error.code)', 'false'],
  ['callback-reuse', 'src/auth.mjs', 'if (settled)', 'if (false)'],
  ['doctor-exit-code', 'src/cli.mjs', "if (!view.ok) process.exitCode = view.error?.code === 'interrupted' ? 130 : 1;", 'if (!view.ok) process.exitCode = 0;'],
  ['status-filter-validation', 'src/cli.mjs', 'TASK_STATUS_FILTERS.includes(options.status)', 'true'],
  ['status-pending-alias', 'src/cli.mjs', "Object.freeze(['processing', 'completed', 'failed', 'cancelled'])", "Object.freeze(['processing', 'completed', 'failed', 'cancelled', 'pending'])"],
  ['status-error-values', 'src/cli.mjs', 'allowed_values: TASK_STATUS_FILTERS', 'allowed_values: []'],
  ['status-filter-forwarding', 'src/cli.mjs', 'status: options.status, since:', 'status: undefined, since:'],
  ['task-specific-help', 'src/cli.mjs', '? TASKS_LIST_HELP : reference?.help || HELP', '? HELP : reference?.help || HELP'],
  ['capability-before-call', 'test/legacy-mcp.mjs', 'if (requireCapability)', 'if (false)'],
  ['page-forwarding', 'src/cli.mjs', "key === 'page' ? Number(options[key]) : options[key]", "key === 'page' ? 1 : options[key]"],
  ['delivery-partial-status', 'src/files.mjs', 'ok: complete, task_id:', 'ok: true, task_id:'],
  ['delivery-digest-check', 'src/files.mjs', "digest.digest('hex') === saved.sha256", 'true'],
  ['delivery-duplicate-names', 'src/files.mjs', 'new Set(names.map(name => name.toLowerCase())).size === names.length', 'true'],
  ['delivery-existing-receipt', 'src/files.mjs', "requireThat(!receipt, 'delivery_exists'", "requireThat(true, 'delivery_exists'"],
  ['delivery-commit-journal', 'src/files.mjs', 'await beforeCommit?.(receipt);', 'await Promise.resolve();'],
  ['lock-crash-ticket', 'src/state.mjs', 'match[1] === hostID && dead(Number(match[2]))', 'false'],
  ['lock-error-propagation', 'src/state.mjs', "entered || error.code !== 'ENOENT'", "error.code !== 'ENOENT'"],
  ['state-replace-retry', 'src/state.mjs', "if (process.platform !== 'win32' || !busyReplace.has(error.code) || attempt === 10) throw error;", 'throw error;'],
  ['state-replace-windows-only', 'src/state.mjs', "if (process.platform !== 'win32' || !busyReplace.has", 'if (!busyReplace.has'],
  ['state-replace-codes', 'src/state.mjs', '!busyReplace.has(error.code) || attempt', 'attempt'],
  ['state-replace-limit', 'src/state.mjs', 'attempt === 10) throw error;', 'attempt === 11) throw error;'],
  ['utm-cli-campaign', 'src/api.mjs', "clientName: 'EvoLink CLI', linkCampaign: 'cli',\n", "clientName: 'EvoLink CLI',\n"],
  ['auth-status-offline', 'src/auth.mjs', 'if (!saved?.tokens) return {', 'if (!saved?.tokens || saved.expires_at <= Date.now()) return {'],
  ['login-update-advice', 'src/auth.mjs', 'if (advice) progress(advice);', 'if (false) progress(advice);'],
  ['login-update-isolation', 'src/auth.mjs', 'const updating = update?.().catch(() => undefined);', 'const updating = update?.();'],
  ['login-failure-advice', 'src/auth.mjs', 'if (hint) progress(hint);', ''],
  ['login-interrupt-quiet', 'src/auth.mjs', "error.code !== 'interrupted' && ", ''],
  ['doctor-update-advice', 'src/doctor.mjs', 'if (advice) guidance.push(advice);', 'if (false) guidance.push(advice);'],
  ['doctor-update-isolation', 'src/doctor.mjs', 'const updating = update?.().catch(() => undefined);', 'const updating = update?.();'],
  ['setup-update-isolation', 'src/setup.mjs', 'const updating = update?.().catch(() => undefined);', 'const updating = update?.();'],
  ['update-equal-version', 'src/update.mjs', "compareVersions(latest, current) > 0 ? 'available'", "compareVersions(latest, current) >= 0 ? 'available'"],
  ['update-older-version', 'src/update.mjs', "compareVersions(latest, current) > 0 ? 'available'", "compareVersions(latest, current) !== 0 ? 'available'"],
  ['update-stable-only', 'src/update.mjs', "requireThat(stable(latest), 'update_check_failed'", "requireThat(parseVersion(latest), 'update_check_failed'"],
  ['update-body-limit', 'src/update.mjs', 'size <= MAX_BODY', 'true'],
  ['update-deadline', 'src/update.mjs', 'timer = setTimeout(stop, timeout);', 'timer = undefined;'],
  ['update-abandoned-count', 'src/update.mjs', 'if (!settled) abandoned++;', ''],
  ['update-opt-out', 'src/update.mjs', 'if (OFF.includes(normalized(env[UPDATE_CHECK_ENV]))) return UPDATE_CHECK_ENV;', ''],
  ['update-opt-out-values', 'src/update.mjs', "const OFF = ['0', 'false', 'no', 'off'];", "const OFF = ['0'];"],
  ['update-no-update-notifier', 'src/update.mjs', "if (env.NO_UPDATE_NOTIFIER !== undefined) return 'NO_UPDATE_NOTIFIER';", ''],
  ['update-ci', 'src/update.mjs', "if (normalized(env.CI) && !OFF.includes(normalized(env.CI))) return 'CI';", ''],
  ['update-loopback', 'src/update.mjs', "if (server && loopback(server)) return 'loopback_server';", ''],
  ['update-cache-interval', 'src/update.mjs', 'if (force || !recent(saved.checked_at, time))', 'if (true)'],
  ['update-forced-check', 'src/update.mjs', 'if (force || !recent(saved.checked_at, time))', 'if (!recent(saved.checked_at, time))'],
  ['update-clock-skew', 'src/update.mjs', 'at <= time + CLOCK_SKEW && ', ''],
  ['update-keep-verified', 'src/update.mjs', 'const latest = stable(saved.latest_version)', 'const latest = !failed && stable(saved.latest_version)'],
  ['update-claim-first', 'src/update.mjs', "catch { if (!force) return view('unknown', null, { reason: 'state_unavailable' }); }", 'catch { /* continue */ }'],
  ['update-forced-claim', 'src/update.mjs', "if (!force) return view('unknown', null, { reason: 'state_unavailable' });", "return view('unknown', null, { reason: 'state_unavailable' });"],
  ['update-notice-throttle', 'src/update.mjs', 'saved.notified_version === result.latest_version && recent(saved.notified_at, time)', 'false'],
  ['update-notice-aborted', 'src/update.mjs', "if (result.status !== 'available' || options.signal?.aborted) return undefined;", "if (result.status !== 'available') return undefined;"],
  ['update-stderr', 'src/cli.mjs', 'io.stderr.write(notice', 'io.stdout.write(notice'],
  ['update-help-check', 'src/cli.mjs', 'const reference = commandHelp(positionals);', 'checkUpdate(); const reference = commandHelp(positionals);'],
  ['update-before-validation', 'src/cli.mjs', 'validateCommand(positionals, options);', 'checkUpdate(); validateCommand(positionals, options);'],
  ['update-after-validation', 'src/cli.mjs', 'const server = serverURL(options.server);', 'const server = serverURL(options.server); checkUpdate(server);'],
  ['update-command-notice', 'src/cli.mjs', "if (!NO_UPDATE_NOTICE.has(positionals[0]) && !NO_UPDATE_NOTICE.has(positionals.slice(0, 2).join(' '))) checkUpdate(server);", ''],
  ['update-auth-status-offline', 'src/cli.mjs', "new Set(['setup', 'doctor', 'auth login', 'auth status'])", "new Set(['setup', 'doctor', 'auth login'])"],
  ['update-doctor-ok', 'src/doctor.mjs', 'return { ok: !!runtime', 'return { ok: updateInfo?.update_available !== true && !!runtime'],
  ['plain-doctor-skills', 'src/doctor.mjs', 'installed = installedSkills(await skillStatus({ home: skillHome }));', 'installed = undefined;'],
  ['plain-doctor-ok', 'src/doctor.mjs', '(agent === undefined || skills?.current === true)', "(agent === undefined ? installed?.status !== 'outdated' : skills?.current === true)"],
  ['plain-doctor-attention', 'src/doctor.mjs', "installations.some(i => i.status !== 'current' && !SKILL_REFRESH.has(i.status)) ? 'needs_attention'", "false ? 'needs_attention'"],
  ['plain-doctor-refresh', 'src/doctor.mjs', "new Set(['outdated', 'legacy', 'unmanaged'])", "new Set(['legacy', 'unmanaged'])"],
  ['failed-wait-code', 'src/media.mjs', "task.error?.code ? ` with error code ${task.error.code}` : ''", "''"],
  ['failed-wait-status', 'src/media.mjs', "task.status === 'failed' ? 'failed' : 'was cancelled'", "'failed'"],
  ['failed-shared-channel', 'src/platform/core/src/services/error-handler.js', "code.startsWith('channel_') ? 'service_unavailable' : code", 'code'],
  ['failed-shared-billing', 'src/platform/core/src/tools/task-format.js', "status === 'failed' && billing.charge_status !== 'charged'", 'false'],
  ['failed-shared-list', 'src/platform/core/src/tools/list-tasks.js', "|| item.status === 'failed'", ''],
  ['failed-shared-message', 'src/platform/core/src/services/error-handler.js', 'publicTaskMessage(error.message)', 'undefined'],
  ['failed-shared-docs-link', 'src/platform/core/src/services/public-error.js', "&& !url.pathname.includes('//')", '&& false'],
  // Local waits: one deadline bounds every round, read, renewal check, pause and the optional update notice.
  ['wait-deadline-round-seconds', 'src/media.mjs', 'Math.floor((left + ROUND_DRIFT_MS) / 1000)', 'Math.ceil(left / 1000)'],
  ['wait-deadline-round-deadline', 'src/media.mjs', '/ 1000)) }, { deadline });', '/ 1000)) });'],
  ['wait-deadline-later-round-needs-time', 'src/media.mjs', '(rounds === 0 ? MIN_ROUND_MS : NEXT_READ_MIN_MS)', 'MIN_ROUND_MS'],
  ['wait-deadline-first-round-always', 'src/media.mjs', 'rounds === 0 ? MIN_ROUND_MS :', 'rounds === 0 ? NEXT_READ_MIN_MS :'],
  ['wait-deadline-polling-rhythm', 'src/media.mjs', 'pollIntervalMs(task.type) - sinceRead', '0'],
  ['wait-deadline-pause-bounded', 'src/media.mjs', 'pollIntervalMs(task.type) - sinceRead), rest)', 'pollIntervalMs(task.type) - sinceRead), Infinity)'],
  ['wait-deadline-round-timeout-continues', 'src/media.mjs', "if (!['task_query_timeout', 'wait_deadline_reached'].includes(error.code)) throw error;", 'throw error;'],
  ['wait-deadline-timeout-unverifies', 'src/media.mjs', "last = { ...last, status_check: 'unverified' };", 'last = { ...last };'],
  ['wait-deadline-unverified-snapshot', 'src/media.mjs', "read_at: task.read_at ?? last?.read_at, status_check: 'unverified' }", "read_at: task.read_at ?? last?.read_at, status_check: 'verified' }"],
  ['wait-deadline-renewal-covers-wait', 'src/auth.mjs', 'const coversWait = !force && Number.isFinite(left)', 'const coversWait = false && Number.isFinite(left)'],
  ['wait-deadline-renewal-needs-time', 'src/auth.mjs', 'if (left < REFRESH_MIN_MS) throw', 'if (false) throw'],
  ['wait-deadline-renewal-forced', 'src/auth.mjs', 'const coversWait = !force && Number.isFinite(left)', 'const coversWait = Number.isFinite(left)'],
  ['wait-deadline-credentials-deadline', 'src/api.mjs', 'this.credentials.access(attempt > 0, { deadline })', 'this.credentials.access(attempt > 0)'],
  ['wait-deadline-context-deadline', 'src/api.mjs', '...(deadline !== undefined ? { deadline } : {}) } };', '} };'],
  ['wait-deadline-query-timeout-code', 'src/api.mjs', "'task_status_unknown', 'task_query_timeout']", "'task_status_unknown']"],
  ['wait-deadline-notice-deadline', 'src/cli.mjs', 'timer = setTimeout(resolve, left);', 'timer = setTimeout(resolve, left + 2_000);'],
  // One generation per estimate: a refresh replaces its quote and keeps its request ID; only the current quote is submittable.
  ['quote-intent-current-only', 'src/media.mjs', 'await this.requireActive(quote, kind);', ''],
  ['quote-intent-recheck', 'src/media.mjs', 'const current = await this.refreshable(intentId);', 'const current = before;'],
  ['quote-intent-version', 'src/media.mjs', "requireThat(current.id === before.id, 'quote_refresh_conflict',", "requireThat(true, 'quote_refresh_conflict',"],
  ['quote-intent-request-id', 'src/media.mjs', 'client_request_id: current.client_request_id, refreshed_from: current.id', 'refreshed_from: current.id'],
  ['quote-intent-shared-lock', 'src/media.mjs', 'return this.state.lock(`quote-${intentId}`, async () => {', 'return this.state.lock(`quote-${id}`, async () => {'],
  ['quote-intent-first-check', 'src/media.mjs', 'const before = await this.state.lock(lock, () => this.refreshable(intentId));', 'const before = await this.load(id);'],
  ['quote-intent-incomplete', 'src/media.mjs', "if (!intent) throw new CliError('quote_refresh_incomplete',", "if (false) throw new CliError('quote_refresh_incomplete',"],
  ['quote-intent-supersede-mark', 'src/media.mjs', "await this.state.write('quotes', current.id, { ...current, state: 'superseded', superseded_by: next.id });", ''],
  ['quote-intent-active-task', 'src/media.mjs', "if (active?.task_id) throw new CliError('quote_superseded',", "if (false) throw new CliError('quote_superseded',"],
  ['quote-intent-active-recovery', 'src/media.mjs', "if (['submitting', 'outcome_unknown'].includes(active?.state)) throw new CliError('quote_superseded',", "if (false) throw new CliError('quote_superseded',"],
  ['quote-intent-refresh-recovery', 'src/media.mjs', ": ['submitting', 'outcome_unknown'].includes(active.state) ? { recovery:", ': false ? { recovery:'],
  // The vendored core prices Midjourney settings from model_params and promptless V7 edits as fast.
  ['mj-quote-nested-read', 'src/platform/core/src/services/pricing-quote-client.js', ': nestedSpec[key] ? nestedInput[key] : undefined', ': undefined'],
  ['mj-quote-prompt-present', 'src/platform/core/src/services/pricing-quote-client.js', "typeof input.prompt === 'string' && effectiveMjV7EditPrompt(input.prompt) !== ''", 'true'],
];

// Mutants of the update, login, local-wait and quote-refresh changes run only the test that covers them, which keeps the CI matrix fast.
const PATTERNS = {
  'callback-state': 'callback rejects wrong state',
  ...Object.fromEntries([
    [['update-equal-version', 'update-older-version', 'update-stable-only', 'update-body-limit', 'update-deadline', 'update-abandoned-count'], '^a forced check reports a newer release'],
    [['update-opt-out', 'update-opt-out-values', 'update-no-update-notifier', 'update-ci', 'update-loopback'], '^every switch, convention and server combination'],
    [['update-cache-interval', 'update-forced-check', 'update-clock-skew', 'update-keep-verified'], '^cache state, registry answer'],
    [['update-claim-first', 'update-forced-claim'], '^an unwritable state directory'],
    [['update-notice-throttle', 'update-notice-aborted'], '^notices repeat a release'],
    [['update-stderr', 'update-help-check', 'update-before-validation', 'update-after-validation', 'update-command-notice', 'update-auth-status-offline'], '^main prints the notice on stderr'],
    [['update-doctor-ok', 'plain-doctor-skills', 'plain-doctor-ok', 'plain-doctor-attention', 'plain-doctor-refresh'], '^plain doctor reports update'],
    [['auth-status-offline', 'login-update-advice', 'login-update-isolation'], '^auth status is an offline view'],
    [['login-failure-advice', 'login-interrupt-quiet'], '^a failed login still names an available update'],
    [['doctor-update-advice', 'doctor-update-isolation', 'setup-update-isolation'], '^doctor and setup report the latest published release'],
    [['wait-deadline-round-seconds', 'wait-deadline-round-deadline', 'wait-deadline-later-round-needs-time', 'wait-deadline-first-round-always', 'wait-deadline-polling-rhythm', 'wait-deadline-pause-bounded'], '^rounds share one deadline'],
    [['wait-deadline-round-timeout-continues'], '^a round that ran out of time'],
    [['wait-deadline-timeout-unverifies', 'wait-deadline-unverified-snapshot'], '^after a verified status'],
    [['wait-deadline-renewal-covers-wait', 'wait-deadline-renewal-needs-time', 'wait-deadline-renewal-forced', 'wait-deadline-credentials-deadline'], '^near a deadline'],
    [['wait-deadline-context-deadline', 'wait-deadline-query-timeout-code'], '^one get_task round carries'],
    [['wait-deadline-notice-deadline'], '^the update notice is awaited'],
    [['quote-intent-current-only', 'quote-intent-request-id', 'quote-intent-first-check', 'quote-intent-supersede-mark', 'quote-intent-active-task'], '^a refresh replaces the quote'],
    [['quote-intent-recheck'], '^a submission that finishes while a refresh waits'],
    [['quote-intent-shared-lock'], '^a refresh during the current quote'],
    [['quote-intent-version'], '^two refreshes at once'],
    [['quote-intent-incomplete'], '^crash orderings'],
    [['quote-intent-active-recovery', 'quote-intent-refresh-recovery'], '^an unverified submission of the current quote'],
    [['state-replace-retry', 'state-replace-windows-only', 'state-replace-codes', 'state-replace-limit'], '^on Windows a replacement denied'],
    [['mj-quote-nested-read', 'mj-quote-prompt-present'], '^Midjourney settings in model_params'],
  ].flatMap(([names, pattern]) => names.map(name => [name, pattern]))),
};

let killed = 0;
const selected = process.env.EVOLINK_MUTATION_ONLY ? mutants.filter(item => item[0] === process.env.EVOLINK_MUTATION_ONLY) : mutants;
if (!selected.length) throw new Error('Unknown mutation name');
for (const [name, file, before, after] of selected) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evolink-mutant-'));
  try {
    for (const dir of ['src', 'test', 'bin', 'skills']) await fs.cp(path.join(packageRoot, dir), path.join(home, dir), { recursive: true });
    await fs.copyFile(path.join(packageRoot, 'package.json'), path.join(home, 'package.json'));
    await fs.symlink(path.join(packageRoot, 'node_modules'), path.join(home, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const target = path.join(home, file); const source = await fs.readFile(target, 'utf8');
    if (!source.includes(before)) throw new Error(`Missing mutation target: ${name}`);
    await fs.writeFile(target, source.replace(before, after));
    const files = name.startsWith('task-response-') ? ['task-response.test.mjs']
      : name.startsWith('search-') ? ['search-pricing.test.mjs']
      : name.startsWith('seedance-') ? ['seedance-pricing.test.mjs']
      : name.startsWith('quote-ttl-') ? ['quote-expiry.test.mjs']
      : ['rest-capability', 'rest-strict-input', 'rest-origin', 'file-credential-isolation', 'shared-estimate-fresh', 'shared-submit-fresh', 'quote-api-origin', 'oauth-metadata-origin', 'oauth-token-scope', 'oauth-new-grant-refresh', 'utm-cli-campaign'].includes(name) ? ['api.test.mjs']
      : name.startsWith('delivery-') || ['page-forwarding', 'capability-before-call'].includes(name) ? ['capabilities.test.mjs']
      : name === 'error-refusal-evidence' ? ['media.test.mjs']
      : name.startsWith('failed-') ? ['failed-task.test.mjs']
      : name === 'callback-state' ? ['auth.test.mjs']
      : name.startsWith('status-') || name === 'task-specific-help' ? ['task-help.test.mjs']
      : name.startsWith('lock-') || name.startsWith('state-replace-') ? ['state.test.mjs']
      : ['request-id', 'journal', 'download-ua'].includes(name) ? ['e2e.test.mjs']
      : name.startsWith('update-') || name.startsWith('plain-doctor-') ? ['update.test.mjs']
      : ['auth-status-offline', 'login-update-advice', 'login-update-isolation', 'login-failure-advice', 'login-interrupt-quiet'].includes(name) ? ['auth.test.mjs']
      : ['doctor-update-advice', 'doctor-update-isolation', 'setup-update-isolation'].includes(name) ? ['setup.test.mjs']
      : name.startsWith('wait-deadline-') ? ['wait-deadline.test.mjs']
      : name.startsWith('quote-intent-') ? ['quote-intent.test.mjs']
      : name.startsWith('mj-quote-') ? ['mj-pricing.test.mjs']
      : ['media.test.mjs', 'auth.test.mjs', 'acceptance.test.mjs', 'readiness.test.mjs', 'setup.test.mjs', 'skills.test.mjs'];
    const tests = files.map(n => path.join(home, 'test', n));
    const selection = PATTERNS[name] ? [`--test-name-pattern=${PATTERNS[name]}`] : [];
    const run = spawnSync(process.execPath, ['--test', ...selection, ...tests], { cwd: home, encoding: 'utf8', timeout: 60_000 });
    const output = `${run.stdout || ''}\n${run.stderr || ''}`;
    if (run.status > 0 && !run.error && /not ok \d+|✖ /.test(output) && !output.includes('SyntaxError:')) { killed++; console.log(`DETECTED ${name}`); }
    else { console.error(`${run.error || run.signal ? 'INCONCLUSIVE' : 'SURVIVED'} ${name} (status=${run.status}, signal=${run.signal}, error=${run.error?.code || 'none'})\n${output.slice(-2000)}`); process.exitCode = 1; }
  } finally { await fs.rm(home, { recursive: true, force: true }); }
}
console.log(`${killed}/${selected.length} mutations detected`);
