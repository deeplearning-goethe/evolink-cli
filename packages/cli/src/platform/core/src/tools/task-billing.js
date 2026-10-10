// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { publicNumber } from '../services/public-error.js';
/** Ledger facts are distinct from the task outcome and from approximate usage costs. */
export function taskBilling(task) {
    const raw = task.billing;
    const billing = { charge_status: 'unknown', refund_status: 'unknown', limit_restoration: 'unknown' };
    if (!raw || raw.refund_scope !== 'account_balance')
        return billing;
    billing.refund_scope = 'account_balance';
    if (['unknown', 'reserved', 'charged', 'released'].includes(raw.charge_status ?? ''))
        billing.charge_status = raw.charge_status;
    if (['unknown', 'not_required', 'pending', 'failed'].includes(raw.refund_status ?? ''))
        billing.refund_status = raw.refund_status;
    for (const field of ['reserved_credits', 'charged_credits']) {
        const n = publicNumber(raw[field]);
        if (n !== undefined)
            billing[field] = n;
    }
    const refunded = publicNumber(raw.refunded_credits);
    const timestamp = typeof raw.refunded_at === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(raw.refunded_at)
        && Number.isFinite(Date.parse(raw.refunded_at)) ? raw.refunded_at : undefined;
    // Require the authoritative release, amount and timestamp together. Status alone is not proof.
    if (raw.refund_status === 'completed' && raw.charge_status === 'released' && timestamp
        && refunded !== undefined && refunded > 0 && refunded === billing.reserved_credits) {
        billing.refund_status = 'completed';
        billing.refunded_credits = refunded;
        billing.refunded_at = timestamp;
    }
    return billing;
}
