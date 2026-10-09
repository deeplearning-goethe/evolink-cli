import { randomUUID } from 'node:crypto';
import { hash } from './state.mjs';
import { CliError, requireThat, fileError } from './errors.mjs';

function quoteError(error, cap) {
  const cause = fileError(error);
  return new CliError(cause instanceof CliError ? cause.code : 'estimate_unavailable',
    cause instanceof CliError ? cause.message : 'The quote could not be obtained. No generation was submitted.', {
      ...(cause instanceof CliError ? cause.details : {}), phase: 'estimate', submission_allowed: false,
      ...(cap !== undefined ? { max_cost_usd: cap } : {}),
      next_step: 'Resolve the quote error and estimate again with the same budget. Do not use catalog starting prices as task quotes or remove the user budget.',
    }, cause.exitCode);
}

export function priceFingerprint(quote) {
  return hash({ model: quote.model, type: quote.type, input_valid: quote.input_valid, estimate: quote.estimate,
    warnings: quote.warnings, pricing_warning: quote.pricing_warning });
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
    requireThat(quote.estimate.max_usd <= cap, 'cost_exceeds_cap', 'The estimated cost exceeds max-cost-usd.', { estimate: quote.estimate, max_cost_usd: cap });
  }
  requireThat(['estimated', 'partial', 'token_billed'].includes(quote.estimate?.status), 'estimate_unavailable', 'Complete the estimate input or choose a model with pricing before submission.', { estimate: quote.estimate });
}

export class Media {
  constructor({ mcp, state, server, now = Date.now }) { this.mcp = mcp; this.state = state; this.server = server.href; this.now = now; }
  async estimate(args) {
    const { max_cost_usd, ...input } = args;
    let quote;
    try {
      quote = await this.mcp.call('estimate_cost', input);
      checkEstimate(quote, max_cost_usd);
      requireThat(['image', 'video', 'audio'].includes(quote.type), 'unsupported_model', 'This model is not a media generation model.');
    } catch (error) { throw quoteError(error, max_cost_usd); }
    // A complete quote also guards a pricing change between the refresh and POST.
    const quotedMax = quote.estimate.max_usd;
    const effectiveCap = max_cost_usd ?? (quote.input_valid === true && quote.estimate.status === 'estimated' && Number.isFinite(quotedMax) && quotedMax > 0 && quotedMax <= 10_000 ? quotedMax : undefined);
    const id = randomUUID();
    const argsToSubmit = { ...input, model: quote.model, ...(effectiveCap !== undefined ? { max_cost_usd: effectiveCap } : {}) };
    const stored = { id, server: this.server, binding: quote._binding, args: argsToSubmit,
      type: quote.type, args_hash: hash(argsToSubmit), fingerprint: priceFingerprint(quote), estimate: quote.estimate,
      created_at: this.now(), expires_at: this.now() + 15 * 60_000, state: 'quoted', client_request_id: `cli-${randomUUID()}` };
    await this.state.write('quotes', id, stored);
    return { ...quote, quote_id: id, input: input.input || {}, max_cost_usd: effectiveCap, cap_source: max_cost_usd !== undefined ? 'user' : effectiveCap !== undefined ? 'quote' : undefined, expires_at: new Date(stored.expires_at).toISOString(),
      requires_confirmation: true, next_step: `After the user approves, run evolink generate ${quote.type} --quote ${id} --confirm.` };
  }
  async load(id) {
    const quote = await this.state.read('quotes', id);
    requireThat(quote?.server === this.server, 'quote_not_found', 'This quote does not exist for the current server.');
    requireThat(quote.binding === (await this.mcp.credentials.access()).binding, 'quote_session_changed', 'This quote belongs to a different login. Estimate again in the current session.');
    requireThat(quote.args_hash === hash(quote.args), 'quote_changed', 'The saved request changed. Estimate again.');
    return quote;
  }
  async generate(kind, id, { confirmed = false, resume = false } = {}) {
    requireThat(['image', 'video', 'audio'].includes(kind), 'invalid_type', 'Choose image, video or audio.');
    requireThat(confirmed || resume, 'confirmation_required', 'Show the quote to the user and obtain approval before adding --confirm.');
    return this.state.lock(`quote-${id}`, async () => {
      const quote = await this.load(id);
      requireThat(quote.type === kind, 'quote_type_mismatch', 'Use the media type shown in the saved quote.');
      if (quote.task_id) return { ...await this.mcp.call('get_task', { task_id: quote.task_id, wait_seconds: 0 }), quote_id: id, recovered: true };
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
      const { max_cost_usd, ...checkArgs } = quote.args;
      let fresh;
      try {
        fresh = await this.mcp.call('estimate_cost', checkArgs);
        requireThat(priceFingerprint(fresh) === quote.fingerprint, 'price_changed', 'The quote changed. Estimate again and obtain approval for the new quote.', { estimate: fresh.estimate });
        checkEstimate(fresh, max_cost_usd);
      } catch (error) { throw quoteError(error, max_cost_usd); }
      quote.state = 'submitting';
      quote.approved_at ??= this.now();
      await this.state.write('quotes', id, quote);
      let result;
      try {
        result = await this.mcp.call(`generate_${kind}`, { ...quote.args, client_request_id: quote.client_request_id });
        requireThat(typeof result.task_id === 'string' && result.task_id.length > 0, 'outcome_unknown', 'The submission returned no task ID. Recover with the original quote.');
      } catch (e) {
        quote.state = e.details?.charged === 'no' ? 'refused' : 'outcome_unknown';
        await this.state.write('quotes', id, quote);
        throw new CliError(e.code || 'outcome_unknown', e.message, { ...(e.details || {}), quote_id: id, client_request_id: quote.client_request_id,
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
      const task = await this.mcp.call('get_task', { task_id: taskId, wait_seconds: Math.min(30, remaining) });
      if (task.status === 'completed') return task;
      if (['failed', 'cancelled'].includes(task.status)) throw new CliError('task_failed', 'The generation task did not complete.', { task });
      progress(`${task.task_id}: ${task.status}${task.progress !== undefined ? ` (${task.progress}%)` : ''}`);
      if (Date.now() >= deadline) throw new CliError('wait_timeout', 'The task is still running. Continue with tasks wait.', { task_id: taskId });
      await new Promise(resolve => { const timer = setTimeout(done, 500); function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); } signal?.addEventListener('abort', done, { once: true }); });
    }
  }
}
