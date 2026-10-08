# EvoLink Media CLI

Generate images, video, music and speech through the existing EvoLink MCP service. The CLI provides browser login, model discovery, quotes, task recovery, reference uploads and original-result downloads.

This is a separate package from the repository's existing `@evolinkai/cli` configuration tool. It does not change the coding assistant's text-model provider. Requires Node.js 22+.

## Status and installation

Version 0.1.0 is a development candidate. The package name `@evolinkai/media-cli` is provisional and has not been published. Use the commands below only after its release is confirmed.

```sh
npm install -g @evolinkai/media-cli
evolink-media auth login
evolink-media skills install
evolink-media balance --json
```

The same setup prompt can be used in coding assistants with terminal access:

> 帮我设置 EvoLink，让我可以在这里生成图片、视频和音频。先运行 `npm install -g @evolinkai/media-cli`，再运行 `evolink-media auth login`。我会在打开的浏览器里登录并同意；如果浏览器没有打开，请把登录链接发给我。之后运行 `evolink-media skills install`，确认发现 `evolink-cli` 技能，并用 `evolink-media balance --json` 验证连接。验证成功后告诉我可以使用。媒体生成默认走 EvoLink，每次付费任务先报价，等我明确确认后再提交。

The skill is bundled with the package. By default it installs into `~/.agents/skills/evolink-cli` (Codex and local Cursor) and `~/.claude/skills/evolink-cli` (Claude Code). Select one with `skills install --agent codex|claude-code|cursor`. Other assistants need their supported skill installation method. Browser-only chat assistants should keep using the hosted MCP connection. See [Claude Code skill locations](https://code.claude.com/docs/en/skills) and [Cursor skill locations](https://cursor.com/docs/skills).

## Quoted generation

```sh
evolink-media models search --type image --query seedream --json
evolink-media models show MODEL --json
evolink-media estimate --model MODEL --input-file input.json --max-cost-usd 0.10 --json
# After the user approves the returned quote:
evolink-media generate image --quote QUOTE_ID --confirm --json
evolink-media tasks wait TASK_ID --json
evolink-media download TASK_ID --output /absolute/result.png --json
```

For video/audio, choose the corresponding generation command and a model's documented input. `estimate` never submits a task. Quotes last 15 minutes, bind to the login and exact input, and are checked again before generation. A changed quote requires a new approval. `--confirm` conveys the user's approval; the CLI cannot verify a conversation by itself.

`--max-cost-usd` is an estimate-based submission guard, not a final-settlement guarantee. A complete estimate automatically uses its quoted maximum as this guard unless the user supplied a cap. Incomplete or unknown totals cannot use it. `--media-seconds` is a pricing hint, never a model parameter. Token-billed and unknown-duration models require explicit acceptance of their billing uncertainty; a missing price is refused.

## Tasks and files

```sh
evolink-media tasks get TASK_ID --json
evolink-media tasks list --since 30m --type video --json
evolink-media tasks resume --quote QUOTE_ID --json
evolink-media upload /absolute/reference.mp4 --json
evolink-media uploads get UPLOAD_ID --json
evolink-media download TASK_ID --output /absolute/result.mp4 --index 1 --json
```

The CLI persists the request ID before paid submission. Recovery reuses that ID; it never silently submits with a new one. After an expired uncertain quote, inspect recent tasks before considering another paid submission. Ctrl-C stops local waiting, not generation. Task links expire after 24 hours.

Uploads stream up to the service limit (currently 95 MB) through a one-time address. Its token is not stored or forwarded elsewhere. Downloads use a product User-Agent, validate redirect destinations, stream at most 1 GiB per result, and refuse to overwrite existing files. These commands transfer originals and do not alter the generated content or guarantee host inline previews.

## Authentication and state

Login uses a native public OAuth client, PKCE, a loopback callback and `mcp offline_access` on the existing Passport service. Dynamically registered clients currently appear as unverified on the consent page. Device-code login is not included in this release.

Tokens are stored only in the OS credential store. Linux requires a running Secret Service keyring; the CLI does not silently fall back to an in-memory kernel store or plaintext credential files. A one-command OAuth access token can be passed through stdin with `--token-stdin`, never as a command argument. `auth logout` revokes this session and preserves the account's shared MCP key.

Quotes, request IDs and non-secret public client metadata are kept under `~/.evolink-media` with private file permissions (`EVOLINK_MEDIA_HOME` selects an isolated state directory). Browser links are printed on stderr. Tokens and PKCE verifiers are not printed. Never include credentials in bug reports.

All machine-readable commands accept `--json`. Stdout contains one envelope with `schema_version: 1` and `ok`; progress goes to stderr. Errors return `ok: false`, an error code and a nonzero exit code (130 for interruption).

## Development and migration

Run installation and tests on the test cloud host, not the development Mac. In this package directory: `npm ci`, `npm test`, `npm run test:mutations`, and `npm pack`. Tests use loopback fixtures and never spend production credits. Real paid acceptance requires a separate quote and user approval.

Development starts in `deeplearning-goethe/evolink-cli`. After acceptance, repository management will arrange migration to `Evolink-AI/evolink-cli`. Keep package/bin names and service identity stable; update repository metadata, publishing permissions and installation links during migration.
