// Copyright 2024 EvoLink AI. SPDX-License-Identifier: Apache-2.0
// Generated from Evolink-AI/evolink-mcp; adapted for direct REST operations. See platform/LICENSE and platform/NOTICE.
import { currentCredentialMode } from '../request-context.js';
import { getCredits } from '../services/api-client.js';
import { CREDITS_PER_USD } from '../services/error-handler.js';
import { API_KEYS_URL, MCP_CONSOLE_URL, MCP_KEY_NAME, TOP_UP_URL } from '../services/http-policy.js';
import { trackedLink } from '../services/utm.js';
import { READ_ONLY, dailyLimitOf, errorResult, money, ok, usdOf } from './shared.js';
/** Below this the user is told the balance, or the limit, is nearly gone (about $1). */
const LOW_BALANCE_CREDITS = CREDITS_PER_USD;
export function registerCheckBalance(server, config) {
    server.registerTool('check_balance', {
        title: 'Check balance',
        description: [
            'Show the EvoLink account balance and what has been spent: by EvoLink MCP in total (all assistants connected by sign-in) or by this API key, with its limit if one is set. Free.',
            'Also a quick way to confirm the connection works.',
            'Credits: 68 credits ≈ $1.',
        ].join(' '),
        inputSchema: {},
        annotations: { title: 'Check balance', ...READ_ONLY },
    }, async () => {
        try {
            const credits = await getCredits(config);
            // A signed-in connection spends the account's MCP key: its spend and limit cover every connected assistant.
            const signedIn = currentCredentialMode() === 'signed_in';
            const who = signedIn ? 'EvoLink MCP (all assistants connected to this account)' : 'This API key';
            const limitName = signedIn ? 'the EvoLink MCP limit' : 'its limit';
            const balance = Math.max(0, credits.user.remaining_credits);
            const lines = [`Account balance: ${money(balance)}`];
            const structured = {
                account_balance_credits: balance,
                account_balance_usd: usdOf(balance),
                spent_scope: signedIn ? 'mcp' : 'api_key',
                spent_credits: credits.token.used_credits,
                spent_usd: usdOf(credits.token.used_credits),
                has_limit: !credits.token.unlimited_credits,
                top_up_url: trackedLink(TOP_UP_URL, 'top_up'),
                ...(signedIn ? { mcp_settings_url: trackedLink(MCP_CONSOLE_URL, 'api_keys') } : {}),
            };
            const daily = dailyLimitOf(credits.token);
            if (credits.token.unlimited_credits) {
                // A daily limit, if any, is named on its own line below: do not say that only the balance applies.
                const spent = money(credits.token.used_credits);
                lines.push(signedIn
                    ? (daily ? `${who} has spent ${spent}; no total EvoLink MCP limit is set.` : `${who} has spent ${spent}; no EvoLink MCP limit is set, so only the account balance applies.`)
                    : (daily ? `${who} has spent ${spent} and has no total spending limit of its own.` : `${who} has spent ${spent} and has no spending limit of its own (the account balance applies).`));
            }
            else {
                const left = Math.max(0, credits.token.remaining_credits);
                lines.push(`${who} has spent ${money(credits.token.used_credits)}; ${money(left)} of ${limitName} is left.`);
                structured.limit_remaining_credits = left;
                structured.limit_remaining_usd = usdOf(left);
                if (left < LOW_BALANCE_CREDITS) {
                    const state = left <= 0 ? 'used up' : 'nearly used up';
                    lines.push(signedIn
                        ? `The EvoLink MCP limit is ${state} (it is a limit, not the account balance); the user can raise it at ${trackedLink(MCP_CONSOLE_URL, 'api_keys')} (the key named "${MCP_KEY_NAME}").`
                        : `This API key's limit is ${state}; raise it at ${trackedLink(API_KEYS_URL, 'api_keys')}.`);
                }
            }
            if (daily) {
                const resets = `it resets at midnight${daily.zone ? ` (${daily.zone})` : ''}`;
                lines.push(signedIn
                    ? `Today EvoLink MCP has spent ${money(daily.used)} of its ${money(daily.limit)} daily limit; ${resets}.`
                    : `Today this API key has spent ${money(daily.used)} of its ${money(daily.limit)} daily limit; ${resets}.`);
                if (daily.left < LOW_BALANCE_CREDITS)
                    lines.push(`Today's limit is ${daily.left <= 0 ? 'used up' : 'nearly used up'} (${money(daily.left)} left).`);
                Object.assign(structured, {
                    daily_limit_credits: daily.limit,
                    daily_used_credits: daily.used,
                    daily_left_credits: daily.left,
                    ...(daily.zone ? { reset_timezone: daily.zone } : {}),
                });
            }
            if (balance < LOW_BALANCE_CREDITS)
                lines.push('The account balance is low; paid generations may be refused.');
            lines.push(`Top up: ${trackedLink(TOP_UP_URL, 'top_up')}`);
            return ok(lines.join('\n'), structured);
        }
        catch (error) {
            return errorResult(error);
        }
    });
}
