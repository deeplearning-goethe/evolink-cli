import { randomUUID } from 'node:crypto';
import { hash } from './state.mjs';
import { CliError, requireThat, fileError } from './errors.mjs';
import { APPROVAL_TTL_MS, REFERENCE_BUDGET_FACTOR, priceRose, referenceBudgetExceeded, rulesBudgetExceeded } from './platform/core/src/services/pricing-rules-estimate.js';
import { compareDecimal } from './platform/core/src/services/pricing-quote-client.js';
import { DASHBOARD_URL } from './platform/core/src/services/http-policy.js';
import { dashboardCheck } from './platform/core/src/tools/shared.js';
import { NEXT_READ_MIN_MS, pollIntervalMs } from './platform/core/src/tools/task-format.js';

/** Longest single get_task round inside a local wait; each round shares the wait's one deadline. */
const WAIT_ROUND_SECONDS = 30;
const ROUND_PAUSE_MS = 500;
/** The first round starts with at least this much of the wait left; a later round needs the shared core's NEXT_READ_MIN_MS. */
const MIN_ROUND_MS = 300;
/** Drift ignored when the time left becomes whole seconds; the shared core still ends each round at the deadline. */
const ROUND_DRIFT_MS = 50;
const WAIT_STOPS_LOCAL = 'Stopping does not cancel the task.';
/**
 * EvoLink keeps a request ID's outcome for 24 hours (agent idempotency); after that the same ID could start a second
 * paid task. Recovery with the original ID stays an hour inside that window, counted from the first submission.
 */
export const RECOVERY_WINDOW_MS = 23 * 60 * 60_000;
/** Saved states that tasks resume replays with the original request ID. */
const RECOVERABLE = ['submitting', 'outcome_unknown', 'partial'];

/** A quote for several inputs of one model (estimate --inputs-file), submitted in one call. */
const isBatch = quote => Array.isArray(quote.args?.inputs);

/**
 * A quote holds until its expires_at, 24 hours after the estimate at most. Past it a first submission needs a new
 * estimate and approval; recovery cannot replay it either, so the user checks what already went through first.
 */
function expiredQuote(quote, id, resume) {
  const at = new Date(quote.expires_at).toISOString(), batch = isBatch(quote), ids = quote.task_ids ?? [];
  const list = 'evolink tasks list --since 2d', collect = ids.length ? `evolink tasks batch --ids ${ids.join(',')}` : undefined;
  const message = !resume ? `This quote expired at ${at}. Refresh it with evolink estimate --refresh-quote ${id} and obtain the user's approval again. Nothing was submitted.`
    : batch ? `This quote expired at ${at}, so its batch cannot be finished with it. Check ${collect ? `${collect} and ${list}` : list} first to see which inputs went through; then estimate only the inputs that did not and, after the user approves, submit them as a new batch. Nothing was submitted.`
      : `This quote expired at ${at}, so its submission cannot be recovered with it. Check ${list} first to see whether it went through; only if it did not, estimate it again and, after the user approves, submit it as a new generation. Nothing was submitted.`;
  return new CliError('quote_expired', message, { quote_id: id, client_request_id: quote.client_request_id, expired_at: at, submission_allowed: false,
    ...(ids.length ? { task_ids: ids } : {}), next_step: resume ? collect ?? list : `evolink estimate --refresh-quote ${id}`, ...(resume ? dashboardCheck() : {}) });
}

/**
 * Whether a fresh estimate still matches the approved quote: the same input at the approved price or lower. With the
 * core's approval record that is its request hash and total, whatever else changed in the rules. Without one on both
 * sides (an older service, or rules that cannot be read now), any change to the estimate needs a new approval.
 */
export function approvalHolds(fresh, quote) {
  const approved = quote.args?.pricing_quote, now = fresh.pricing_quote;
  if (approved && now) {
    return { input: approved.request_hash === now.request_hash && approved.model_id === now.model_id && approved.batch_items === now.batch_items,
      rose: priceRose(approved, now) };
  }
  const account = quote.account_quote, current = fresh.account_quote;
  if (account && current) return { input: account.request_hash === current.request_hash, rose: compareDecimal(current.quote.amount, account.quote.amount) > 0 };
  return { input: true, rose: priceFingerprint(fresh) !== quote.fingerprint, byFingerprint: true };
}

/** The shared core's batch result names its own tool calls; for the CLI these lines name the CLI commands instead. */
export function cliBatchText(text, id, taskIds) {
  return (text ?? '').split('\n').map(line => {
    if (line.startsWith('Collect the results with list_tasks')) return `Collect the results with evolink tasks batch --ids ${taskIds.join(',')}; it is free and read-only.`;
    if (line.startsWith('To finish the batch, call ')) {
      // tasks resume replays the request ID for 23 of the gateway's 24 hours (RECOVERY_WINDOW_MS).
      return line.replace(/^To finish the batch, call \S+ again with client_request_id "[^"]*" and exactly the same inputs/, `To finish the batch, run evolink tasks resume --quote ${id}`)
        .replace(' within 24 hours of its first submission', ' within 23 hours of its first submission');
    }
    if (line.startsWith('The outcome of ')) {
      return line.replace(/retry later with the same client_request_id and inputs, or check list_tasks\.$/, `run evolink tasks resume --quote ${id} later, or check evolink tasks list --since 30m.`);
    }
    if (line.startsWith('Never resubmit ')) return 'Never resubmit accepted, not-submitted or unknown-outcome inputs with a new estimate or generate command: that creates and charges new tasks.';
    return line;
  }).join('\n');
}

/** The shared core's refusal of a replayed approval, before anything is sent: its price rose, or it expired. */
function replayRefusal(error) {
  const code = error?.details?.error?.code;
  return ['price_changed', 'quote_expired'].includes(code) && error.details.charged === 'no' ? code : undefined;
}

function interrupted(taskId) {
  return new CliError('interrupted', 'Stopped waiting locally. The EvoLink task continues.', { task_id: taskId }, 130);
}

/** At the local limit, report what was last verified instead of claiming the task is still running. */
function waitTimeout(taskId, last) {
  const verified = last?.status_check === 'verified' && last.status;
  return new CliError('wait_timeout', verified
    ? `Stopped waiting at the timeout. ${WAIT_STOPS_LOCAL} Last verified status: ${last.status}${last.read_at ? ` (read at ${last.read_at})` : ''}. Continue with evolink tasks wait ${taskId}.`
    : `Stopped waiting at the timeout. ${WAIT_STOPS_LOCAL} Its latest status could not be verified${last?.status ? ` (last verified: ${last.status})` : ''}. Query it with evolink tasks get ${taskId}.`,
  { task_id: taskId, status_check: verified ? 'verified' : 'unverified',
    ...(last?.status ? { last_status: last.status } : {}), ...(last?.read_at ? { read_at: last.read_at } : {}),
    ...(verified ? {} : dashboardCheck()), recovery: `evolink tasks wait ${taskId}` });
}

function pause(ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(done, Math.max(0, ms));
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

function quoteError(error, cap) {
  const cause = fileError(error);
  const code = cause.details?.input_valid === false ? 'invalid_input'
    : cap !== undefined && ['quote_usage_required', 'quote_parameter_required'].includes(cause.details?.error?.code) ? 'uncheckable_cap'
    : cause instanceof CliError ? cause.code : 'estimate_unavailable';
  return new CliError(code,
    cause instanceof CliError ? cause.message : 'The quote could not be obtained. No generation was submitted.', {
      ...(cause instanceof CliError ? cause.details : {}), phase: 'estimate', submission_allowed: false,
      ...(cap !== undefined ? { max_cost_usd: cap } : {}),
      next_step: 'Resolve the quote error and estimate again with the same budget. Do not use catalog starting prices as task quotes or remove the user budget.',
    }, cause.exitCode);
}

export function priceFingerprint(quote) {
  return hash({ model: quote.model, type: quote.type, input_valid: quote.input_valid, estimate: quote.estimate,
    ...(quote.effective_input ? { effective_input: quote.effective_input } : {}),
    ...(Array.isArray(quote.items) ? { items: quote.items.map(item => item.effective_input ?? null) } : {}),
    warnings: quote.warnings, pricing_warning: quote.pricing_warning, pricing_scope: quote.pricing_scope,
    rules: quote.pricing_quote && { fingerprint: quote.pricing_quote.fingerprint, request_hash: quote.pricing_quote.request_hash, total_uc: quote.pricing_quote.total_uc },
    account: quote.account_quote && { request_hash: quote.account_quote.request_hash, parameters: quote.account_quote.parameters,
      quote: Object.fromEntries(Object.entries(quote.account_quote.quote).filter(([key]) => !['estimate_id', 'expires_at', 'assumptions'].includes(key))) } });
}

export function checkEstimate(quote, cap) {
  requireThat(quote.input_valid !== false, 'invalid_input', 'The model input is invalid.', { problems: quote.problems });
  requireThat(quote.enough_limit !== false, 'insufficient_limit', 'The EvoLink MCP or API key spending limit does not cover this estimate. Adjust that limit; this is not the account balance.', { limit_scope: quote.limit_scope });
  requireThat(quote.enough_daily_limit !== false, 'insufficient_daily_limit', 'The daily spending limit does not cover this estimate. Wait for its reset or adjust that limit; this is not the account balance.');
  requireThat(quote.enough_balance !== false, 'insufficient_balance', 'The EvoLink account balance does not cover this estimate.');
  if (quote.estimate?.status === 'estimated' || quote.estimate?.status === 'token_billed' && quote.estimate.max_usd !== undefined) {
    const { min_usd, max_usd } = quote.estimate;
    requireThat(Number.isFinite(max_usd) && max_usd >= 0 && (min_usd === undefined || Number.isFinite(min_usd) && min_usd >= 0 && min_usd <= max_usd),
      'estimate_unavailable', 'The service returned an invalid price range. Obtain a valid quote before submission.');
  }
  if (cap !== undefined) {
    requireThat(Number.isFinite(cap) && cap > 0 && cap <= 10_000, 'invalid_cap', 'max-cost-usd must be greater than 0 and at most 10000.');
    requireThat(quote.input_valid === true, 'uncheckable_input', 'The service could not validate the model input. The CLI cannot submit this request with a spending cap.', { problems: quote.problems });
    // A token-billed reference price settles at actual usage: the budget must cover the core's allowance above it.
    const reference = quote.estimate?.status === 'token_billed' && Number.isFinite(quote.estimate.max_usd)
      && quote.estimate.uncheckable_reason === undefined && quote.pricing_quote;
    requireThat(reference || quote.estimate?.status === 'estimated' && Number.isFinite(quote.estimate.max_usd),
      'uncheckable_cap', 'This request has no complete cost estimate. The CLI cannot submit it with a spending cap.', { estimate: quote.estimate });
    const withinBudget = reference ? !referenceBudgetExceeded(quote.pricing_quote.total_uc, cap) : quote.pricing_quote ? !rulesBudgetExceeded(quote.pricing_quote.total_uc, cap) : quote.account_quote
      ? compareDecimal(quote.account_quote.quote.amount, String(cap)) <= 0
      : quote.estimate.max_usd <= cap;
    requireThat(withinBudget, 'cost_exceeds_cap', reference
      ? `The reference price is billed by actual token usage, and ${REFERENCE_BUDGET_FACTOR} times it exceeds max-cost-usd.`
      : 'The estimated cost exceeds max-cost-usd.', { estimate: quote.estimate, max_cost_usd: cap });
  }
  // The core names each missing usage in MCP terms; say once how they map to CLI options.
  requireThat(quote.estimate?.status !== 'needs_input' || !quote.estimate.usage_help?.length, 'estimate_unavailable', [
    'The total cannot be estimated yet, so no quote was saved. It depends on:', ...(quote.estimate?.usage_help ?? []).map(line => `- ${line}`),
    'In the CLI, media_seconds is --media-seconds and pricing_parameters is --pricing-parameters (a JSON object).'].join('\n'),
  // A copy: the redaction of error details shows an object it has already printed as "[truncated]".
  { estimate: quote.estimate, missing_usage: [...(quote.estimate?.missing_usage ?? [])] });
  requireThat(['estimated', 'partial', 'token_billed'].includes(quote.estimate?.status), 'estimate_unavailable', 'Complete the estimate input or choose a model with pricing before submission.', { estimate: quote.estimate });
}

export class Media {
  constructor({ client, mcp = client, state, server, now = Date.now }) { this.client = mcp; this.state = state; this.server = server.href; this.now = now; }
  async estimate(args) {
    const { stored, view } = await this.prepareQuote(args);
    await this.state.write('quotes', stored.id, stored);
    return view;
  }
  /** Obtains and checks an estimate and builds its quote record; nothing is saved. */
  async prepareQuote(args) {
    const { max_cost_usd, ...input } = args;
    let quote;
    try {
      quote = await this.client.call('estimate_cost', input);

      checkEstimate(quote, max_cost_usd);
      requireThat(['image', 'video', 'audio'].includes(quote.type), 'unsupported_model', 'This model is not a media generation model.');
    } catch (error) { throw quoteError(error, max_cost_usd); }
    // Keep an explicit user budget; an estimate does not create a spending cap.
    const id = randomUUID();
    const argsToSubmit = { ...input, model: quote.model, ...(quote.pricing_quote ? { pricing_quote: quote.pricing_quote } : {}), ...(quote.account_quote ? { account_quote: quote.account_quote } : {}), ...(max_cost_usd !== undefined ? { max_cost_usd } : {}) };
    const serverExpiry = quote.pricing_quote ? Date.parse(quote.pricing_quote.expires_at) : quote.account_quote ? Date.parse(quote.account_quote.quote.expires_at) : undefined;
    requireThat(serverExpiry === undefined || Number.isFinite(serverExpiry) && serverExpiry > this.now(),
      'quote_expired', 'The estimate expired before it could be saved. Request another estimate.');
    const expires = Math.min(this.now() + APPROVAL_TTL_MS, serverExpiry ?? Infinity);
    const stored = { id, server: this.server, binding: quote._binding, args: argsToSubmit,
      ...(this.client.apiUrl ? { backend: 'platform', api_origin: this.client.apiUrl.origin } : {}),
      type: quote.type, args_hash: hash(argsToSubmit), fingerprint: priceFingerprint(quote), estimate: quote.estimate,
      ...(quote.effective_input ? { effective_input: quote.effective_input, defaults_applied: quote.defaults_applied } : {}),
      created_at: this.now(), expires_at: expires, ...(quote.account_quote ? { backend_estimate_id: quote.account_quote.quote.estimate_id,
        server_expires_at: serverExpiry, account_quote: quote.account_quote } : {}), state: 'quoted', client_request_id: `cli-${randomUUID()}` };
    const view = { ...quote, quote_id: id, ...(input.inputs ? { inputs: input.inputs } : { input: input.input || {} }), ...(max_cost_usd !== undefined ? { max_cost_usd, cap_source: 'user' } : {}), expires_at: new Date(stored.expires_at).toISOString(),
      requires_confirmation: true, next_step: `After the user approves, run evolink generate ${quote.type} --quote ${id} --confirm.` };
    return { stored, view };
  }
  /**
   * One generation per estimate. A refresh gives it a new quote but keeps its request ID, and moves a single pointer
   * (intents/<first quote ID>) to the new quote, which is saved first; only the quote that pointer names can be submitted.
   * A quote never refreshed is its own generation and has no pointer, as in earlier releases.
   */
  intentOf(quote) { return quote.intent_id ?? quote.id; }
  async refresh(id) {
    const intentId = this.intentOf(await this.load(id));
    const lock = `quote-${intentId}`;
    // Checked before and again after the estimate, under the lock that submission and recovery share: a submission
    // or another refresh while the estimate ran means no new submittable quote is saved.
    const before = await this.state.lock(lock, () => this.refreshable(intentId));
    const { account_quote, pricing_quote, skip_estimate, ...args } = before.args;
    const { stored, view } = await this.prepareQuote(args);
    return this.state.lock(lock, async () => {
      const current = await this.refreshable(intentId);
      requireThat(current.id === before.id, 'quote_refresh_conflict',
        `Another refresh already replaced this quote with quote ${current.id}. Show the user that quote and obtain approval for it.`,
        { quote_id: id, active_quote_id: current.id, client_request_id: current.client_request_id, submission_allowed: false });
      // Nothing was ever submitted with this request ID, so the refreshed quote keeps it.
      const next = { ...stored, intent_id: intentId, client_request_id: current.client_request_id, refreshed_from: current.id };
      await this.state.write('quotes', next.id, next);
      const intent = await this.state.read('intents', intentId);
      await this.state.write('intents', intentId, { id: intentId, client_request_id: next.client_request_id, active_quote_id: next.id,
        quotes: [...(intent?.quotes ?? [intentId]), next.id], updated_at: this.now() });
      // The pointer above decides; marking the replaced quote only explains it.
      await this.state.write('quotes', current.id, { ...current, state: 'superseded', superseded_by: next.id });
      return { ...view, refreshed_from: id, superseded_quote_id: current.id, client_request_id: next.client_request_id };
    });
  }
  /** The generation's current quote, which must not have started a submission. */
  async refreshable(intentId) {
    const intent = await this.state.read('intents', intentId);
    const active = await this.load(intent?.active_quote_id ?? intentId);
    requireThat(active.state === 'quoted' && !active.task_id, 'submission_already_started',
      'This submission has started. Recover its original task instead of refreshing its quote.', {
        quote_id: active.id, client_request_id: active.client_request_id, submission_allowed: false,
        ...(active.task_id ? { task_id: active.task_id, recovery: `evolink tasks get ${active.task_id}` }
          : active.task_ids?.length && active.state === 'submitted' ? { task_ids: active.task_ids, recovery: `evolink tasks batch --ids ${active.task_ids.join(',')}` }
            : RECOVERABLE.includes(active.state) ? { recovery: `evolink tasks resume --quote ${active.id}` } : {}) });
    return active;
  }
  /** Only the generation's current quote may be submitted or recovered; any other names the current one or its task. */
  async requireActive(quote, kind) {
    const intentId = this.intentOf(quote);
    const intent = await this.state.read('intents', intentId);
    const activeId = intent?.active_quote_id ?? intentId;
    if (activeId === quote.id) return;
    const details = { quote_id: quote.id, active_quote_id: activeId, client_request_id: quote.client_request_id, submission_allowed: false };
    if (!intent) throw new CliError('quote_refresh_incomplete',
      `This refreshed quote was not saved completely and cannot be submitted. Use quote ${activeId} or refresh it again.`, details);
    const active = await this.state.read('quotes', activeId);
    if (active?.task_id) throw new CliError('quote_superseded',
      `This quote was replaced by quote ${activeId}, which was already submitted as task ${active.task_id}. Do not generate again.`,
      { ...details, task_id: active.task_id, recovery: `evolink tasks get ${active.task_id}` });
    if (active?.state === 'submitted' && active.task_ids?.length) throw new CliError('quote_superseded',
      `This quote was replaced by quote ${activeId}, which was already submitted as ${active.task_ids.length} tasks. Do not generate again.`,
      { ...details, task_ids: active.task_ids, recovery: `evolink tasks batch --ids ${active.task_ids.join(',')}` });
    if (RECOVERABLE.includes(active?.state)) throw new CliError('quote_superseded',
      `This quote was replaced by quote ${activeId}, whose submission is unverified. Recover that quote; do not create a new request.`,
      { ...details, recovery: `evolink tasks resume --quote ${activeId}` });
    throw new CliError('quote_superseded', `This quote was replaced by quote ${activeId}. Show the user that quote and obtain approval for it.`,
      { ...details, next_step: `After the user approves, run evolink generate ${kind} --quote ${activeId} --confirm.` });
  }
  async load(id) {
    const quote = await this.state.read('quotes', id);
    requireThat(quote?.server === this.server, 'quote_not_found', 'This quote does not exist for the current server.');
    requireThat(!quote.api_origin || quote.api_origin === this.client.apiUrl?.origin, 'quote_platform_changed', 'This quote belongs to a different platform API.');
    requireThat(quote.binding === (await this.client.credentials.access()).binding, 'quote_session_changed', 'This quote belongs to a different login. Estimate again in the current session.');
    requireThat(quote.args_hash === hash(quote.args), 'quote_changed', 'The saved request changed. Estimate again.');
    return quote;
  }
  /**
   * Generation without a quote, only when the user explicitly opted out of estimates (skip_estimate). The saved record
   * has its own request ID, so tasks resume recovers an uncertain submission and a retry never submits twice.
   */
  async direct(kind, args) {
    requireThat(['image', 'video', 'audio'].includes(kind), 'invalid_type', 'Choose image, video or audio.');
    const { binding } = await this.client.credentials.access();
    const id = randomUUID(), submitArgs = { ...args, skip_estimate: true };
    await this.state.write('quotes', id, { id, server: this.server, binding, args: submitArgs,
      ...(this.client.apiUrl ? { backend: 'platform', api_origin: this.client.apiUrl.origin } : {}),
      type: kind, args_hash: hash(submitArgs), skip_estimate: true, created_at: this.now(), state: 'quoted', client_request_id: `cli-${randomUUID()}` });
    return this.generate(kind, id, { confirmed: true });
  }
  async generate(kind, id, { confirmed = false, resume = false } = {}) {
    requireThat(['image', 'video', 'audio'].includes(kind), 'invalid_type', 'Choose image, video or audio.');
    requireThat(confirmed || resume, 'confirmation_required', 'Show the quote to the user and obtain approval before adding --confirm.');
    // Submission, recovery and refresh of one generation share its lock; the quote is validated inside it.
    const intentId = this.intentOf((await this.state.read('quotes', id)) ?? { id });
    return this.state.lock(`quote-${intentId}`, async () => {
      const quote = await this.load(id);
      requireThat(quote.type === kind, 'quote_type_mismatch', 'Use the media type shown in the saved quote.');
      const batch = isBatch(quote);
      if (quote.task_id) return { ...await this.client.call('get_task', { task_id: quote.task_id, wait_seconds: 0 }), quote_id: id, recovered: true };
      // A batch whose every input was accepted is read back, never submitted again.
      if (batch && quote.state === 'submitted') return { ...await this.client.call('list_tasks', { task_ids: quote.task_ids }), quote_id: id,
        client_request_id: quote.client_request_id, task_ids: quote.task_ids, recovered: true };
      await this.requireActive(quote, kind);
      requireThat(quote.state !== 'refused', 'submission_refused',
        'EvoLink refused this submission and reported no charge. Resolve the original error, estimate again with the same budget, and obtain approval for the new quote.',
        { quote_id: id, client_request_id: quote.client_request_id, charged: 'no', submission_allowed: false });
      if (resume && quote.state === 'quoted') throw new CliError('submission_not_started',
        'This quote has never been submitted. After user approval, use generate with this same quote; tasks resume only recovers an uncertain submission.',
        { quote_id: id, client_request_id: quote.client_request_id, submission_allowed: false,
          next_step: `After user approval, run evolink generate ${kind} --quote ${id} --confirm.` });
      requireThat(resume ? RECOVERABLE.includes(quote.state) : quote.state === 'quoted',
        'submission_already_started', 'A submission already started. Use tasks resume with this quote; do not create a new request ID.',
        { quote_id: id, client_request_id: quote.client_request_id, recovery: `evolink tasks resume --quote ${id}` });
      // Past the gateway's 24 hours the original request ID no longer prevents a second paid task.
      if (resume) requireThat(this.now() < (quote.approved_at ?? quote.created_at) + RECOVERY_WINDOW_MS, 'recovery_window_passed',
        'This request ID was first submitted more than 23 hours ago. EvoLink keeps a request ID for 24 hours, so replaying it now could create and charge a new task. Check recent tasks with evolink tasks list --since 2d instead.',
        { quote_id: id, client_request_id: quote.client_request_id, submission_allowed: false, ...dashboardCheck() });
      if (!quote.skip_estimate && this.now() >= quote.expires_at) throw expiredQuote(quote, id, resume);
      const { max_cost_usd, account_quote, pricing_quote, skip_estimate, ...checkArgs } = quote.args;
      // skip_estimate: the user opted out of estimates; the shared core still refuses invalid input and an unpriceable budget.
      if (!quote.skip_estimate) {
        let fresh;
        try {
          // Recovery sends the original approved request, which the shared core checks against the current price itself.
          const replay = resume && (account_quote || pricing_quote);
          fresh = replay ? { model: quote.args.model, type: quote.type, input_valid: true, estimate: quote.estimate, account_quote, pricing_quote }
            : await this.client.call('estimate_cost', checkArgs);
          if (!replay) {
            const held = approvalHolds(fresh, quote);
            requireThat(held.input, 'quote_input_changed', 'The input as EvoLink reads it changed since the quote. Estimate again and obtain approval for the new quote.', { estimate: fresh.estimate });
            requireThat(!held.rose, 'price_changed', held.byFingerprint ? 'The quote changed. Estimate again and obtain approval for the new quote.'
              : 'The price rose since the quote was approved. Estimate again and obtain approval for the new quote.', { estimate: fresh.estimate });
          }
          checkEstimate(fresh, max_cost_usd);
        } catch (error) { throw quoteError(error, max_cost_usd); }
        if (!resume && fresh.pricing_quote) {
          const expires = Date.parse(fresh.pricing_quote.expires_at);
          requireThat(Number.isFinite(expires) && expires > this.now(), 'quote_expired', 'The refreshed estimate expired before submission.');
          quote.args.pricing_quote = fresh.pricing_quote;
          quote.server_expires_at = expires;
          quote.args_hash = hash(quote.args);
        }
        if (!resume && fresh.account_quote) {
          const expires = Date.parse(fresh.account_quote.quote.expires_at);
          requireThat(Number.isFinite(expires) && expires > this.now(), 'quote_expired', 'The refreshed account quote expired before submission.');
          quote.args.account_quote = fresh.account_quote; quote.account_quote = fresh.account_quote;
          quote.backend_estimate_id = fresh.account_quote.quote.estimate_id; quote.server_expires_at = expires;
          quote.args_hash = hash(quote.args);
        }
      }
      const previous = quote.state;
      quote.state = 'submitting';
      quote.approved_at ??= this.now();
      await this.state.write('quotes', id, quote);
      const { pricing_source, ...generationArgs } = quote.args;
      const request = { ...generationArgs, client_request_id: quote.client_request_id };
      if (batch) return this.submitBatch(kind, id, quote, request, { resume, previous });
      let result;
      try {
        result = await this.client.call(`generate_${kind}`, request);
        requireThat(typeof result.task_id === 'string' && result.task_id.length > 0, 'outcome_unknown', 'The submission returned no task ID. Recover with the original quote.');
      } catch (e) {
        // Acceptance survives later read/format failures; recovery must query this ID, never POST again.
        const acceptedId = e.details?.submission_state === 'accepted' && typeof e.details?.task_id === 'string'
          && /^[A-Za-z0-9._:-]{1,128}$/.test(e.details.task_id) ? e.details.task_id : undefined;
        if (acceptedId) {
          quote.state = 'submitted';
          quote.task_id = acceptedId;
          await this.state.write('quotes', id, quote);
          throw new CliError(e.code || 'task_response_invalid', e.message, { ...e.details,
            quote_id: id, client_request_id: quote.client_request_id, status_check: 'unverified',
            dashboard_url: DASHBOARD_URL,
            recovery: `evolink tasks get ${acceptedId}` }, e.exitCode);
        }
        quote.state = !resume && e.details?.charged === 'no' && ['not_submitted', 'rejected'].includes(e.details?.submission_state) ? 'refused' : 'outcome_unknown';
        await this.state.write('quotes', id, quote);
        // The shared core refused the replay before sending it: the approval no longer holds (price or age).
        const approval = resume && replayRefusal(e);
        if (approval) throw new CliError(approval, `${approval === 'price_changed' ? 'The price rose since the quote was approved' : 'The quote expired'}, so the replay was not sent, and the original submission remains unverified. Check evolink tasks list --since 2d first to see whether it went through; only if it did not, estimate it again and, after the user approves, submit it as a new generation.`,
          { ...(e.details || {}), charged: 'unknown', submission_state: 'outcome_unknown', quote_id: id, client_request_id: quote.client_request_id, submission_allowed: false,
            next_step: 'evolink tasks list --since 2d', ...dashboardCheck() }, e.exitCode);
        throw new CliError(resume ? 'outcome_unknown' : e.code || 'outcome_unknown', resume ? 'The original submission remains unverified. The replay could not proceed; check recent tasks with the original request ID before preparing any new generation.' : e.message, { ...(e.details || {}), ...(quote.state === 'outcome_unknown' ? { charged: 'unknown', submission_state: 'outcome_unknown' } : {}), quote_id: id, client_request_id: quote.client_request_id,
          recovery: `evolink tasks resume --quote ${id}` }, e.exitCode);
      }
      quote.state = 'submitted';
      quote.task_id = result.task_id;
      await this.state.write('quotes', id, quote);
      return { ...result, quote_id: id, client_request_id: quote.client_request_id };
    });
  }
  /**
   * Submits a batch quote's inputs in one shared-core call and records each input's outcome. The same request ID and
   * inputs (tasks resume) later return accepted inputs without a new charge and submit only those still to finish.
   */
  async submitBatch(kind, id, quote, request, { resume, previous }) {
    let result, failure;
    try { result = await this.client.call(`generate_${kind}`, request); } catch (error) { failure = error; }
    const outcome = result ?? failure?.details ?? {};
    const items = Array.isArray(outcome.items) ? outcome.items : undefined;
    // Refused before any input was sent, so this call charged nothing; inputs accepted earlier keep their tasks.
    const refusedBefore = !items && failure?.details?.charged === 'no' && ['not_submitted', 'rejected'].includes(failure.details.submission_state);
    if (items) {
      quote.items = items.map(item => ({ index: item.index, client_request_id: item.client_request_id, submission_state: item.submission_state,
        ...(typeof item.task_id === 'string' ? { task_id: item.task_id } : {}), ...(typeof item.finishable === 'boolean' ? { finishable: item.finishable } : {}) }));
      quote.task_ids = items.flatMap(item => item.submission_state === 'accepted' && typeof item.task_id === 'string' ? [item.task_id] : []);
      // partial: the same request ID can still finish or verify some input. Refusals it would only get again close
      // the batch: submitted when some input was accepted, refused when none was.
      quote.state = quote.task_ids.length === quote.args.inputs.length ? 'submitted'
        : items.some(item => item.submission_state === 'outcome_unknown' || item.finishable) ? 'partial' : quote.task_ids.length ? 'submitted' : 'refused';
    } else quote.state = refusedBefore ? (resume ? (previous === 'partial' ? 'partial' : 'outcome_unknown') : 'refused') : 'outcome_unknown';
    await this.state.write('quotes', id, quote);
    const taskIds = quote.task_ids ?? [];
    const view = { ...outcome, quote_id: id, client_request_id: quote.client_request_id, task_ids: taskIds, text: cliBatchText(outcome.text, id, taskIds),
      ...(taskIds.length ? { collect: `evolink tasks batch --ids ${taskIds.join(',')}` } : {}),
      ...(RECOVERABLE.includes(quote.state) ? { recovery: `evolink tasks resume --quote ${id}` } : {}) };
    if (result) return view;
    if (items) throw new CliError(failure.code || 'batch_not_submitted', failure.message, view, failure.exitCode);
    // The shared core refused the replay before sending anything because the approval no longer holds (price or age).
    const approval = resume && refusedBefore && replayRefusal(failure);
    const check = `${taskIds.length ? `evolink tasks batch --ids ${taskIds.join(',')} and ` : ''}evolink tasks list --since 2d`;
    throw new CliError(approval || (resume && !refusedBefore ? 'outcome_unknown' : failure.code || 'outcome_unknown'), approval
      ? `${approval === 'price_changed' ? 'The total price rose since the quote was approved' : 'The quote expired'}, so nothing was sent. Check ${check} first to see which inputs went through; then estimate only the inputs that did not and, after the user approves, submit them as a new batch.`
      : resume && !refusedBefore ? 'The batch submission remains unverified. The replay could not proceed; check recent tasks with the original request ID before preparing any new generation.' : failure.message, {
      ...view, ...(quote.state === 'outcome_unknown' ? { charged: 'unknown', submission_state: 'outcome_unknown' } : {}),
      ...(refusedBefore && quote.state === 'partial' ? { items: quote.items, next_step: 'This call submitted nothing. Accepted inputs keep their tasks (task_ids). Resolve the error; then finish the rest with tasks resume, or estimate them again as a new batch if their price or input changed.' } : {}),
    }, failure.exitCode);
  }
  async resume(id) {
    const quote = await this.load(id);
    return this.generate(quote.type, id, { resume: true });
  }
  /**
   * Waits locally for one task. A single monotonic deadline bounds every round, read, retry and pause; a round asks
   * only for the whole seconds left. budget.deadline lets the command keep optional work (the update notice) inside it.
   */
  async wait(taskId, { timeout = 1800, signal, progress = () => {}, budget } = {}) {
    const deadline = performance.now() + timeout * 1000;
    if (budget) budget.deadline = deadline;
    let last, rounds = 0;
    for (;;) {
      if (signal?.aborted) throw interrupted(taskId);
      const left = deadline - performance.now();
      // Too little time for another round: report the last verified state as it is. Like a later read in the shared
      // core, a later round needs time to finish; started with less, it would only turn a verified status unverified.
      if (left < (rounds === 0 ? MIN_ROUND_MS : NEXT_READ_MIN_MS)) throw waitTimeout(taskId, last);
      rounds += 1;
      let task;
      try {
        task = await this.client.call('get_task', { task_id: taskId, wait_seconds: Math.min(WAIT_ROUND_SECONDS, Math.floor((left + ROUND_DRIFT_MS) / 1000)) }, { deadline });
      } catch (error) {
        if (signal?.aborted) throw interrupted(taskId);
        // A round that ran out of time is not a task outcome; continue while the wait itself has time left.
        if (!['task_query_timeout', 'wait_deadline_reached'].includes(error.code)) throw error;
        last = { ...last, status_check: 'unverified' };
        const rest = deadline - performance.now();
        if (rest < NEXT_READ_MIN_MS) throw waitTimeout(taskId, last);
        progress(`${taskId}: latest status unverified${last.status ? ` (last verified: ${last.status})` : ''}`);
        await pause(Math.min(ROUND_PAUSE_MS, rest), signal);
        continue;
      }
      if (task.status === 'completed') return task;
      // task.error.code is the shared core's user-facing code, the one the API reports.
      if (['failed', 'cancelled'].includes(task.status)) {
        throw new CliError('task_failed', `The generation task ${task.status === 'failed' ? 'failed' : 'was cancelled'}${
          task.error?.code ? ` with error code ${task.error.code}` : ''}.`, { task });
      }
      last = task.status ? { status: task.status, read_at: task.read_at, status_check: 'verified' }
        : { status: task.last_known_status ?? last?.status, read_at: task.read_at ?? last?.read_at, status_check: 'unverified' };
      progress(task.status ? `${task.task_id}: ${task.status}${task.progress !== undefined ? ` (${task.progress}%)` : ''}`
        : `${taskId}: latest status unverified${last.status ? ` (last verified: ${last.status})` : ''}`);
      const rest = deadline - performance.now();
      if (rest <= 0) throw waitTimeout(taskId, last);
      // Rounds keep the shared polling rhythm for the task type: a short round does not mean reading more often.
      const readMs = Date.parse(task.read_at);
      const sinceRead = Number.isFinite(readMs) ? Math.max(0, Date.now() - readMs) : 0;
      await pause(Math.min(Math.max(ROUND_PAUSE_MS, pollIntervalMs(task.type) - sinceRead), rest), signal);
    }
  }
}
