# Usage and budget boundaries

Read when the user asks about cost, historical usage, bills or spending limits.

```sh
evolink balance --json
evolink usage --since 30d --max-pages 5 --json
evolink usage --since 2026-10-01T00:00:00Z --until 2026-10-09T00:00:00Z --model MODEL --json
```

`balance` reports the account balance and calling MCP key's reported limits. `usage` is an account-wide summary of retained generation tasks, grouped by task creation time. It scans at most `max-pages` × 50 tasks (default 5 pages, maximum 20), counts task states, and sums valid reported credits only for completed tasks. USD is approximate at 68 credits per dollar.

Always show the interval, account-wide scope, completed-task cost, missing-cost count and coverage. `complete_for_retained_tasks` means all currently retained matching tasks were scanned under the observed pagination; historical retention and snapshot consistency are not guaranteed. `truncated`, invalid rows or detected concurrent changes prevent claiming a full total. Do not turn missing costs into zero or infer a refund from failed/cancelled task status. This summary excludes reservations, payments, refunds and non-task charges. It is not a bill, tax invoice or a transactions API.

The default flow shows the estimated cost and asks for approval; it creates no spending cap. When the user specifies a budget, compare the estimate with that budget and preserve it across retries. The compatibility option `--max-cost-usd` checks this estimate comparison, not the final charge. Unknown totals, token usage, generated audio duration or incompletely priced reference inputs can prevent a complete comparison. Pause if the estimate exceeds the budget or cannot be checked; explain the uncertainty before accepting any changed requirement.

A final task/workflow cap requires server-side reservation and settlement enforcement with an authoritative quote and ledger. This client cannot create that guarantee by polling, summing history or stopping local waiting. Do not label this version as supporting final settlement budgets or downloadable invoices.


Estimates use published full pricing rules and show public default prices, excluding
personal discounts. The local approval expires no later than the rules' freshness.
Use `evolink estimate --refresh-quote ID` only for an unsubmitted approval; preserve
the input and explicit user budget and obtain approval again. Supply missing billing
usage with `--pricing-parameters JSON`; never invent unknown token counts or media
lengths. Partial subtotals cannot check a budget. If rules are unavailable or change,
pause and preserve the budget. Actual usage can change the final charge; final
settlement caps require gateway/Worker support.
