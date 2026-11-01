# Public pricing response fixture

`pricing-rules-public-20261010.json` matches the anonymous full response fixture
in the MCP repository, captured on 2026-10-10 at 06:52 UTC from
`https://api.evolink.ai/v1/catalog/pricing-rules?view=full`.

The CLI tests refresh only cache validity and check that the generated shared
parser preserves all public media rules without accessing credentials. These
rules are configuration references, not account quotes or final budget caps.

# Usage-billed media policies

`pricing-rules-usage-20261023.json` is the same snapshot as in the MCP repository:
nine anonymous full rules captured on 2026-10-23 at 12:47 UTC from
`https://api.evolink.ai/v1/catalog/pricing-rules?view=full`. The CLI tests use
`seedance-2.0-mini-reference-to-video` (billed by the input video length) to
check that an estimate short of usage saves no quote and names the CLI option
that gives it.

# Token-billed media policies

`pricing-rules-token-billed-20261031.json` holds five anonymous full rules from
`https://api.evolink.ai/v1/catalog/pricing-rules?view=full`, read on 2026-10-31
at 15:58 UTC: `gpt-image-1.5`, `gpt-image-2`, `gpt-image-2.5-flare` and
`gpt-image-2.5-sunburst`, which get a reference price from the input, and
`gemini-omni-flash-text-to-video`, which is billed only by token counts the
request cannot give. The GPT Image rules are the same as the MCP repository's
`pricing-rules-gpt-image-20261031.json`.
