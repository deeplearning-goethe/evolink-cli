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
`gpt-image-2.5-sunburst`, and `gemini-omni-flash-text-to-video`. All five get a
reference price from the input (Gemini Omni Flash since evolink-mcp 01ed943). The
GPT Image rules are the same as the MCP repository's
`pricing-rules-gpt-image-20261031.json`.

`pricing-rules-gpt-image-26-20261107.json` is the MCP repository's file of the
same name: the anonymous full rules of `gpt-image-2.6-flare` and
`gpt-image-2.6-sunburst`, read on 2026-11-07 at 07:03 UTC.

`pricing-rules-omni-20261107.json` is the MCP repository's file of the same name:
the anonymous full rules of the fifteen Gemini Omni Flash video models, read on
2026-11-07 at 14:26 UTC. The CLI tests use the Gemini Omni 1.2 edit and upscale
rules for the price at each input resolution.

`pricing-rules-qwen-tts-20261108.json` is the MCP repository's file of the same
name: the anonymous full rule of `qwen-audio-3.1-tts-flash`, read on 2026-11-08 at
15:55 UTC, which gets a reference price from its text since evolink-mcp 9e31094.

`pricing-rules-tts-20261014.json` holds one rule of the MCP repository's
`pricing-rules-public-20261014.json` (read on 2026-10-14, meta.updated_at 14:41:59
UTC): `qwen-audio-3.1-tts-flash`, billed only by input and output token counts the
request cannot give. Since that model gets a reference price, the CLI tests publish
this rule for `qwen3-tts-vd`, which has none, for an estimate short of token usage.
