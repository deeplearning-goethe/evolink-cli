import { randomUUID } from 'node:crypto';
import { hash } from './state.mjs';
import { CliError, requireThat, fileError } from './errors.mjs';
import { rulesBudgetExceeded } from './platform/core/src/services/pricing-rules-estimate.js';
import { compareDecimal } from './platform/core/src/services/pricing-quote-client.js';

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
  if (quote.estimate?.status === 'estimated') {
    const { min_usd, max_usd } = quote.estimate;
    requireThat(Number.isFinite(max_usd) && max_usd >= 0 && (min_usd === undefined || Number.isFinite(min_usd) && min_usd >= 0 && min_usd <= max_usd),
      'estimate_unavailable', 'The service returned an invalid price range. Obtain a valid quote before submission.');
  }
  if (cap !== undefined) {
    requireThat(Number.isFinite(cap) && cap > 0 && cap <= 10_000, 'invalid_cap', 'max-cost-usd must be greater than 0 and at most 10000.');
    requireThat(quote.input_valid === true, 'uncheckable_input', 'The service could not validate the model input. The CLI cannot submit this request with a spending cap.', { problems: quote.problems });
    requireThat(quote.estimate?.status === 'estimated' && Number.isFinite(quote.estimate.max_usd),
      'uncheckable_cap', 'This request has no complete cost estimate. The CLI cannot submit it with a spending cap.', { estimate: quote.estimate });
    const withinBudget = quote.pricing_quote ? !rulesBudgetExceeded(quote.pricing_quote.total_uc, cap) : quote.account_quote
      ? compareDecimal(quote.account_quote.quote.amount, String(cap)) <= 0
      : quote.estimate.max_usd <= cap;
    requireThat(withinBudget, 'cost_exceeds_cap', 'The estimated cost exceeds max-cost-usd.', { estimate: quote.estimate, max_cost_usd: cap });
  }
  requireThat(['estimated', 'partial', 'token_billed'].includes(quote.estimate?.status), 'estimate_unavailable', 'Complete the estimate input or choose a model with pricing before submission.', { estimate: quote.estimate });
}

export class Media {
  constructor({ client, mcp = client, state, server, now = Date.now }) { this.client = mcp; this.state = state; this.server = server.href; this.now = now; }
  async estimate(args) {
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
    const expires = Math.min(this.now() + 15 * 60_000, serverExpiry ?? Infinity);
    const stored = { id, server: this.server, binding: quote._binding, args: argsToSubmit,
      ...(this.client.apiUrl ? { backend: 'platform', api_origin: this.client.apiUrl.origin } : {}),
      type: quote.type, args_hash: hash(argsToSubmit), fingerprint: priceFingerprint(quote), estimate: quote.estimate,
      created_at: this.now(), expires_at: expires, ...(quote.account_quote ? { backend_estimate_id: quote.account_quote.quote.estimate_id,
        server_expires_at: serverExpiry, account_quote: quote.account_quote } : {}), state: 'quoted', client_request_id: `cli-${randomUUID()}` };
    await this.state.write('quotes', id, stored);
    return { ...quote, quote_id: id, input: input.input || {}, ...(max_cost_usd !== undefined ? { max_cost_usd, cap_source: 'user' } : {}), expires_at: new Date(stored.expires_at).toISOString(),
      requires_confirmation: true, next_step: `After the user approves, run evolink generate ${quote.type} --quote ${id} --confirm.` };
  }
  async refresh(id) {
    const quote = await this.load(id);
    requireThat(quote.state === 'quoted' && !quote.task_id, 'submission_already_started',
      'This submission has started. Recover its original task instead of refreshing its quote.');
    const { account_quote, pricing_quote, ...args } = quote.args;
    return { ...await this.estimate(args), refreshed_from: id };
  }
  async load(id) {
    const quote = await this.state.read('quotes', id);
    requireThat(quote?.server === this.server, 'quote_not_found', 'This quote does not exist for the current server.');
    requireThat(!quote.api_origin || quote.api_origin === this.client.apiUrl?.origin, 'quote_platform_changed', 'This quote belongs to a different platform API.');
    requireThat(quote.binding === (await this.client.credentials.access()).binding, 'quote_session_changed', 'This quote belongs to a different login. Estimate again in the current session.');
    requireThat(quote.args_hash === hash(quote.args), 'quote_changed', 'The saved request changed. Estimate again.');
    return quote;
  }
  async generate(kind, id, { confirmed = false, resume = false } = {}) {
    requireThat(['image', 'video', 'audio'].includes(kind), 'invalid_type', 'Choose image, video or audio.');
    requireThat(confirmed || resume, 'confirmation_required', 'Show the quote to the user and obtain approval before adding --confirm.');
    return this.state.lock(`quote-${id}`, async () => {
      const quote = await this.load(id);
      requireThat(quote.type === kind, 'quote_type_mismatch', 'Use the media type shown in the saved quote.');
      if (quote.task_id) return { ...await this.client.call('get_task', { task_id: quote.task_id, wait_seconds: 0 }), quote_id: id, recovered: true };
      requireThat(quote.state !== 'refused', 'submission_refused',
        'EvoLink refused this submission and reported no charge. Resolve the original error, estimate again with the same budget, and obtain approval for the new quote.',
        { quote_id: id, client_request_id: quote.client_request_id, charged: 'no', submission_allowed: false });
      if (resume && quote.state === 'quoted') throw new CliError('submission_not_started',
        'This quote has never been submitted. After user approval, use generate with this same quote; tasks resume only recovers an uncertain submission.',
        { quote_id: id, client_request_id: quote.client_request_id, submission_allowed: false,
          next_step: `After user approval, run evolink generate ${kind} --quote ${id} --confirm.` });
      requireThat(resume ? ['submitting', 'outcome_unknown'].includes(quote.state) : quote.state === 'quoted',
        'submission_already_started', 'A submission already started. Use tasks resume with this quote; do not create a new request ID.', { quote_id: id, client_request_id: quote.client_request_id });
      requireThat(this.now() <= quote.expires_at, 'quote_expired', 'The quote expired. Check recent tasks before preparing another submission.', { quote_id: id, client_request_id: quote.client_request_id });
      const { max_cost_usd, account_quote, pricing_quote, ...checkArgs } = quote.args;
      let fresh;
      try {
        // Preserve the original approved request during uncertain submission recovery.
        fresh = resume && (account_quote || pricing_quote) ? { model: quote.args.model, type: quote.type, input_valid: true, estimate: quote.estimate, account_quote, pricing_quote }
          : await this.client.call('estimate_cost', checkArgs);
        requireThat(resume && (account_quote || pricing_quote) || priceFingerprint(fresh) === quote.fingerprint, 'price_changed', 'The quote changed. Estimate again and obtain approval for the new quote.', { estimate: fresh.estimate });
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
      quote.state = 'submitting';
      quote.approved_at ??= this.now();
      await this.state.write('quotes', id, quote);
      let result;
      try {
        const { pricing_source, ...generationArgs } = quote.args;
        result = await this.client.call(`generate_${kind}`, { ...generationArgs, client_request_id: quote.client_request_id });
        requireThat(typeof result.task_id === 'string' && result.task_id.length > 0, 'outcome_unknown', 'The submission returned no task ID. Recover with the original quote.');
      } catch (e) {
        quote.state = !resume && e.details?.charged === 'no' && ['not_submitted', 'rejected'].includes(e.details?.submission_state) ? 'refused' : 'outcome_unknown';
        await this.state.write('quotes', id, quote);
        throw new CliError(resume ? 'outcome_unknown' : e.code || 'outcome_unknown', resume ? 'The original submission remains unverified. The replay could not proceed; check recent tasks with the original request ID before preparing any new generation.' : e.message, { ...(e.details || {}), ...(quote.state === 'outcome_unknown' ? { charged: 'unknown', submission_state: 'outcome_unknown' } : {}), quote_id: id, client_request_id: quote.client_request_id,
          recovery: `evolink tasks resume --quote ${id}` }, e.exitCode);
      }
      quote.state = 'submitted';
      quote.task_id = result.task_id;
      await this.state.write('quotes', id, quote);
      return { ...result, quote_id: id, client_request_id: quote.client_request_id };
    });
  }
  async resume(id) {
    const quote = await this.load(id);
    return this.generate(quote.type, id, { resume: true });
  }
  async wait(taskId, { timeout = 1800, signal, progress = () => {} } = {}) {
    const deadline = Date.now() + timeout * 1000;
    for (;;) {
      if (signal?.aborted) throw new CliError('interrupted', 'Stopped waiting locally. The EvoLink task continues.', { task_id: taskId }, 130);
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const task = await this.client.call('get_task', { task_id: taskId, wait_seconds: Math.min(30, remaining) });
      if (task.status === 'completed') return task;
      if (['failed', 'cancelled'].includes(task.status)) throw new CliError('task_failed', 'The generation task did not complete.', { task });
      progress(`${task.task_id}: ${task.status}${task.progress !== undefined ? ` (${task.progress}%)` : ''}`);
      if (Date.now() >= deadline) throw new CliError('wait_timeout', 'The task is still running. Continue with tasks wait.', { task_id: taskId });
      await new Promise(resolve => { const timer = setTimeout(done, 500); function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); } signal?.addEventListener('abort', done, { once: true }); });
    }
  }
}
