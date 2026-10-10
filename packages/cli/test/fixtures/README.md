# Public pricing response fixture

`pricing-rules-public-20261010.json` matches the anonymous full response fixture
in the MCP repository, captured on 2026-10-10 at 06:52 UTC from
`https://api.evolink.ai/v1/catalog/pricing-rules?view=full`.

The CLI tests refresh only cache validity and check that the generated shared
parser preserves all public media rules without accessing credentials. These
rules are configuration references, not account quotes or final budget caps.
