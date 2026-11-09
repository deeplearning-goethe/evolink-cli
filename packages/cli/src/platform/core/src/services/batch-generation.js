// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { ApiHttpError, submitTask } from './api-client.js';
import { remainingMs } from './http-policy.js';
import { QuoteError, quoteRequestHash } from './pricing-quote-client.js';
import { APPROVAL_TTL_MS, MAX_BATCH_ITEMS, amountsForUC, approvalExpired, priceRose } from './pricing-rules-estimate.js';
export { MAX_BATCH_ITEMS };
/** Submissions of one batch in flight at once. */
export const BATCH_SUBMIT_CONCURRENCY = 10;
/**
 * No item of a batch starts later than this after the call began. Submissions usually take 1–3 s, so 50 items need
 * 5–15 s; the rest of a slow batch is reported not submitted, to be finished with the same client_request_id.
 */
export const BATCH_SUBMIT_DEADLINE_MS = 25_000;
/** A batch client_request_id leaves room for the ".NN" each item adds, within the gateway's 96 characters. */
export const BATCH_REQUEST_ID_MAX = 93;
let submitDeadlineMs = BATCH_SUBMIT_DEADLINE_MS;
/** Tests shorten the submission deadline; undefined restores it. */
export function setBatchSubmitDeadlineForTests(ms) { submitDeadlineMs = ms ?? BATCH_SUBMIT_DEADLINE_MS; }
/** Item `index` of the batch `batchId` always has this idempotency key, so a retry finds what an earlier call submitted. */
export function batchItemRequestId(batchId, index) {
    return `${batchId}.${String(index).padStart(2, '0')}`;
}
const unique = (lines) => [...new Set(lines)];
/**
 * The inputs' estimates as one: complete only when every input is. Any input that still needs usage leaves the batch
 * without a total (needs_input), any partial one makes it partial; amounts add up exactly in UC.
 */
export function batchTotal(model, items) {
    const statusOf = (item) => item.estimate.status;
    const needsInput = items.flatMap((item, index) => statusOf(item) === 'needs_input' ? [index] : []);
    const partial = items.flatMap((item, index) => statusOf(item) === 'partial' ? [index] : []);
    const status = needsInput.length ? 'needs_input' : partial.length ? 'partial'
        : items.some(item => statusOf(item) === 'token_billed') ? 'token_billed' : 'estimated';
    const amounts = amountsForUC(String(items.reduce((sum, item) => sum + BigInt(item.amounts.uc), 0n)));
    const approval = { source: 'pricing_rules', price_scope: 'public_default', model_id: model,
        request_hash: quoteRequestHash(model, { batch: items.map(item => item.approval.request_hash) }),
        fingerprint: quoteRequestHash(model, { batch: items.map(item => item.approval.fingerprint) }),
        total_uc: amounts.uc, expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(), batch_items: items.length };
    const missing = unique(items.flatMap(item => item.estimate.missing_usage ?? [])).sort();
    const basis = unique(items.flatMap(item => item.estimate.basis));
    const estimate = { status,
        ...(status === 'needs_input' ? {} : { min_usd: Number(amounts.usd), max_usd: Number(amounts.usd),
            min_credits: Number(amounts.credits), max_credits: Number(amounts.credits) }),
        total_known: status === 'estimated',
        // A reference price names each input's tokens; past a few inputs only the first one is shown.
        basis: basis.length > 3 ? [basis[0], `The other inputs are priced the same way (${basis.length - 1} more lines; see items).`] : basis,
        possible_extras: unique(items.flatMap(item => item.estimate.possible_extras)),
        notes: unique(items.flatMap(item => item.estimate.notes)),
        ...(missing.length ? { uncheckable_reason: 'usage', missing_usage: missing,
            usage_help: unique(items.flatMap(item => item.estimate.usage_help ?? [])) } : {}) };
    return { status, amounts, approval, estimate, partial, needsInput };
}
function fail(code, message) { throw new QuoteError(code, message); }
/**
 * A batch approval holds for the same inputs, in the same order, until its expires_at, at the approved total or lower:
 * the total counts, not any one input's price. An approval of one input never approves a batch.
 */
export function checkBatchApproval(approval, fresh) {
    if (approval.batch_items === undefined) {
        fail('quote_input_changed', 'This pricing_quote approves one input; estimate these inputs together (inputs) and obtain approval.');
    }
    if (approval.batch_items !== fresh.batch_items || approval.request_hash !== fresh.request_hash || approval.model_id !== fresh.model_id) {
        fail('quote_input_changed', 'The inputs differ from the approved batch estimate (the same inputs, in the same order).');
    }
    if (approvalExpired(approval)) {
        fail('quote_expired', `The approved batch estimate expired at ${approval.expires_at}. Estimate these inputs again and obtain approval. If this call finishes a batch submitted earlier, check list_tasks first: within 24 hours of its first submission, finish it with the new pricing_quote, the same client_request_id and the same inputs; past that, submit only the inputs that did not go through, as a new batch with a new client_request_id.`);
    }
    if (priceRose(approval, fresh))
        fail('price_changed', 'The estimated total of the batch rose after it was approved. Estimate again and obtain approval.');
}
/**
 * The gateway answered every attempt without running it: a rate limit (it releases the key, so the same key can be
 * submitted again) or a key already used for a different input. Only then is a failed item certainly not submitted.
 */
export function refusedBeforeRunning(submission) {
    return submission.attempts.length > 0 && submission.attempts.every(error => error instanceof ApiHttpError
        && (error.status === 429 || error.status === 409 && error.info?.code === 'idempotency_conflict'));
}
/** The item's key was used before for a different input: the same call conflicts again, so only exactly that input finishes it. */
export function keyConflict(submission) {
    return submission.attempts.some(error => error instanceof ApiHttpError && error.status === 409 && error.info?.code === 'idempotency_conflict');
}
/**
 * A refusal the gateway keeps for the key: it checks the key's model access after recording the key and releases a
 * key only after a 402 or 429 refusal, so the same client_request_id gets this refusal again for 24 hours. Other
 * refusals before dispatch are fixed and finished with the same client_request_id (auth refusals come before the key).
 */
export function keptRefusal(code) {
    return code?.toLowerCase() === 'key_model_not_allowed';
}
/**
 * Submits every body, at most BATCH_SUBMIT_CONCURRENCY at once, each with its item's idempotency key. No submission
 * starts after the deadline or once `signal` is aborted; one already started is never interrupted.
 */
export async function submitBatch(config, options) {
    const deadline = options.startedMono + submitDeadlineMs;
    const submissions = options.bodies.map((_, index) => ({ index, requestId: batchItemRequestId(options.batchId, index),
        started: false, attempts: [] }));
    let next = 0, done = 0;
    const worker = async () => {
        while (next < submissions.length && !options.signal?.aborted && remainingMs(deadline) > 0) {
            const item = submissions[next++];
            item.started = true;
            try {
                item.receipt = await submitTask(config, { path: options.path, body: options.bodies[item.index], tool: options.tool,
                    idempotencyKey: item.requestId, onAttemptError: error => item.attempts.push(error) });
            }
            catch (error) {
                item.error = error;
            }
            options.onSubmitted?.(++done);
        }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_SUBMIT_CONCURRENCY, submissions.length) }, worker));
    return submissions;
}
