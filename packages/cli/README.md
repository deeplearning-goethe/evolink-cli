# EvoLink CLI

Generate images, video, music and speech through the existing EvoLink MCP service. The CLI provides browser login, model discovery, quotes, task recovery, reference uploads and original-result downloads.

The package connects to the hosted EvoLink service using the assistant's terminal. Requires Node.js 22+.

## Status and installation

Install `@evolinkai/cli`, sign in with the `evolink` command, install the bundled skill and verify the connection:

```sh
npm install -g @evolinkai/cli
evolink auth login
evolink skills install
evolink balance --json
```

The same setup prompt can be used in coding assistants with terminal access:

> 帮我设置 EvoLink，让我可以直接在这里生成图片、视频和音频。
>
> 1. 安装 CLI：运行 `npm install -g @evolinkai/cli`，需要 Node.js 22 或更新版本。
> 2. 完成登录：运行 `evolink auth login`，由我在浏览器里登录 EvoLink 并点同意；没有打开浏览器时，把登录链接发给我。
> 3. 安装配套技能：运行 `evolink skills install`，确认当前助手能发现 `evolink-cli`。
> 4. 验证连接：运行 `evolink balance --json`，成功后告诉我可以开始了。
>
> 媒体生成默认使用 EvoLink，每次付费任务先报价，等我明确确认后再生成。

The skill is bundled with the package. By default it installs into `~/.agents/skills/evolink-cli` (Codex, Cursor, Gemini CLI, OpenCode and Copilot CLI), `~/.claude/skills/evolink-cli` (Claude Code), `~/.openclaw/skills/evolink-cli` (OpenClaw) and `~/.hermes/skills/evolink-cli` (Hermes). Select one with `skills install --agent NAME`; run `--help` for the supported names. Verify discovery in the assistant rather than treating a written skill file as proof of integration. Browser-only chat assistants should keep using the hosted MCP connection. See [Claude Code skill locations](https://code.claude.com/docs/en/skills) and [Cursor skill locations](https://cursor.com/docs/skills).

## Quoted generation

```sh
evolink models search --type image --query seedream --json
evolink models show MODEL --json
evolink estimate --model MODEL --input-file input.json --max-cost-usd 0.10 --json
# After the user approves the returned quote:
evolink generate image --quote QUOTE_ID --confirm --json
evolink tasks wait TASK_ID --json
evolink download TASK_ID --output /absolute/result.png --json
```

For video/audio, choose the corresponding generation command and a model's documented input. `estimate` never submits a task. Quotes last 15 minutes, bind to the login and exact input, and are checked again before generation. A changed quote requires a new approval. `--confirm` conveys the user's approval; the CLI cannot verify a conversation by itself.

`--max-cost-usd` is an estimate-based submission guard, not a final-settlement guarantee. A complete estimate automatically uses its quoted maximum as this guard unless the user supplied a cap. Incomplete or unknown totals cannot use it. `--media-seconds` is a pricing hint, never a model parameter. Token-billed and unknown-duration models require explicit acceptance of their billing uncertainty; a missing price is refused.

A failed or blocked estimate is not a quote. Catalog starting prices must not replace a task quote. Fix the reported problem and quote again while retaining the user's cap; do not ask for generation approval or submit using an invented total. Quote errors report `submission_allowed: false` and preserve the supplied budget.

## Tasks and files

```sh
evolink tasks get TASK_ID --json
evolink tasks list --since 30m --type video --json
evolink tasks resume --quote QUOTE_ID --json
evolink upload /absolute/reference.mp4 --json
evolink uploads get UPLOAD_ID --json
evolink download TASK_ID --output /absolute/result.mp4 --index 1 --json
```

The CLI persists the request ID before paid submission. Recovery reuses that ID; it never silently submits with a new one. After an expired uncertain quote, inspect recent tasks before considering another paid submission. Ctrl-C stops local waiting, not generation. Task links expire after 24 hours.

Uploads stream up to the service limit (currently 95 MB) through a one-time address. Its token is not stored or forwarded elsewhere. Downloads use a product User-Agent, validate redirect destinations, check content types and common media file headers, stream at most 1 GiB per result, and refuse to overwrite existing files. HTTP 200 HTML/error documents are rejected with `invalid_download_content`, with no final file left behind. Header checks do not fully decode codecs. These commands transfer originals and do not alter the generated content or guarantee host inline previews. Missing files/directories, denied permissions and exhausted disk space have separate error codes; fix the local problem and retry the same task's download.

## Authentication and state

Login uses a native public OAuth client, PKCE, a loopback callback and `mcp offline_access` on the existing Passport service. Dynamically registered clients currently appear as unverified on the consent page. Device-code login is not included in this release.

Tokens are stored only in the OS credential store. Linux requires a running Secret Service keyring; the CLI does not silently fall back to an in-memory kernel store or plaintext credential files. A one-command OAuth access token can be passed through stdin with `--token-stdin`, never as a command argument. `auth logout` revokes this session and preserves the account's shared MCP key.

Run `evolink doctor --json` to check Node.js, writable local state, credential storage, saved login and balance connectivity. It reports failed and skipped checks together and exits nonzero until the connection is verified. On Linux, run login and later commands in the same unlocked Secret Service/D-Bus session. A keyring package alone does not start or unlock that session.

On an SSH host, the OAuth loopback callback belongs to the host running the CLI. If you open the link on your own computer, forward its callback port: run `evolink auth login --no-browser` remotely, read the `127.0.0.1:PORT` in the printed link's `redirect_uri`, then use a second local terminal with `ssh -N -L PORT:127.0.0.1:PORT USER@HOST` before opening that link. Keep both commands alive until approval finishes (the login waits up to three minutes). Otherwise run the CLI locally. `--no-browser` prints a link but does not forward it. Device-code login is not provided.

Quotes, request IDs and non-secret public client metadata retain the existing `~/.evolink-media` location so an upgrade can reuse saved requests and the OS-stored login. `EVOLINK_CLI_HOME` selects an isolated state directory; the original `EVOLINK_MEDIA_HOME` remains supported. The credential-service identity and skill ownership marker also remain stable across the command rename. Browser links are printed on stderr. Tokens and PKCE verifiers are not printed. Never include credentials in bug reports.

All machine-readable commands accept `--json`. Stdout contains one envelope with `schema_version: 1` and `ok`; progress goes to stderr. Errors return `ok: false`, an error code and a nonzero exit code (130 for interruption).

## Development and migration

Run installation and tests on the test cloud host, not the development Mac. In this package directory: `npm ci`, `npm test`, `npm run test:mutations`, and `npm pack`. Tests use loopback fixtures and never spend production credits. Real paid acceptance requires a separate quote and user approval.

Development starts in `deeplearning-goethe/evolink-cli`. After acceptance, repository management will arrange migration to `Evolink-AI/evolink-cli`. Keep package/bin names and service identity stable; update repository metadata, publishing permissions and installation links during migration.
