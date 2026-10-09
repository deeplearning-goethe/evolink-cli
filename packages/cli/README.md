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

For an installation preflight in a POSIX shell, treat an absent command as an expected first-time setup state:

```sh
if command -v evolink >/dev/null 2>&1; then
  evolink --version
else
  printf '%s\n' 'EvoLink CLI is not installed or not on PATH.'
fi
```

Check Node.js and npm separately when installation is needed. In PowerShell, use `Get-Command evolink -ErrorAction SilentlyContinue` inside an `if`. If installation already succeeded, check PATH and the active Node/npm installation. Do not suppress actual version, runtime or installation failures with `|| true`. `auth status --json` returning `ok: true` and `authenticated: false` means sign-in is needed; an error should be resolved before login.

The skill is bundled with the package. By default it installs into `~/.agents/skills/evolink-cli` (Codex, Cursor, Gemini CLI, OpenCode and Copilot CLI), `~/.claude/skills/evolink-cli` (Claude Code), `~/.openclaw/skills/evolink-cli` (OpenClaw) and `~/.hermes/skills/evolink-cli` (Hermes). Select one with `skills install --agent NAME`; run `--help` for the supported names. Verify discovery in the assistant rather than treating a written skill file as proof of integration. Browser-only chat assistants should keep using the hosted MCP connection. See [Claude Code skill locations](https://code.claude.com/docs/en/skills) and [Cursor skill locations](https://cursor.com/docs/skills).

After upgrading the npm package, run `evolink skills install` again to refresh the installed skill copies, then verify that the assistant discovers the updated skill. Open a new conversation only if discovery does not refresh. Fix reusable guidance in `skills/evolink-cli/SKILL.md` in this package; editing only a local installed copy will not distribute the fix.

## Setup and skill updates

Starting with CLI 0.6.0, use the selected assistant's name:

```sh
evolink setup --agent codex --json
evolink skills status --agent codex --json
evolink doctor --agent codex --json
```

`setup` checks Node.js, writable state and credential storage, synchronizes the selected skill, reuses an existing login only after checking the real account connection, and verifies model discovery. When needed it waits for browser approval. Repeating setup reuses completed steps; connection errors do not automatically trigger a new login. Checks submit no paid media tasks. The default agent is `all`; use `--agent` to install only for the assistant you are using. Commands sharing a state directory serialize setup; skill writes also serialize across state directories in the same home.

CLI checks cannot prove that the assistant has loaded a skill. A successful result leaves `assistant_discovery: not_checked`; ask the assistant to confirm discovery in the current conversation. Reopen only when the assistant cannot refresh. A failed stage returns its error and a setup recovery command without erasing completed installations.

`auth login` and `setup` accept `--timeout SECONDS` (30–900, default 180). Keep the login process running until it reports completion. If it times out or is interrupted, start a new login and open the new link. The local callback page acknowledges receipt and returns you to the assistant for verification; it does not claim the account connection was verified. Repeated callbacks are refused and the browser page clears the authorization query from its visible URL.

The installer copies SKILL.md and its bundled references, records their hashes and CLI version, and skips identical installations. `skills status` distinguishes missing, current, outdated, legacy, unmanaged, modified and conflicting installations. The unmodified published 0.5.0 or 0.5.1 skill migrates automatically. Local changes are preserved by default. Only after choosing to replace those changes, run:

```sh
evolink skills install --agent codex --replace-modified --json
```

Replacement backs up the previous skill directory under `~/.evolink-media/skill-backups/`, outside assistant discovery folders. Untracked user assets are preserved, and an installation failure rolls back completed directory swaps. Unowned skills, damaged manifests and symbolic-link destinations require resolving the conflict first. After upgrading the CLI, run `skills status` and `skills install` to synchronize its bundle; npm upgrades do not automatically update assistant skill folders.

For an idempotent installation prompt, check Node.js 22+ and `evolink --version` before installing; reuse a suitable installed CLI. In a released version supporting `setup`, use it with the current assistant's name. With older versions, retain the four separate setup steps above, reuse a working login, and explicitly verify balance, model discovery and assistant skill discovery. Installation authorization does not authorize a paid test generation.

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
evolink tasks list --status processing --json
evolink tasks list --status completed --type video --limit 50 --json
evolink tasks resume --quote QUOTE_ID --json
evolink upload /absolute/reference.mp4 --json
evolink uploads get UPLOAD_ID --json
evolink download TASK_ID --output /absolute/result.mp4 --index 1 --json
```

Task-list filters are case-sensitive:

| Option | Allowed values | When omitted |
| --- | --- | --- |
| `--status` | `processing`, `completed`, `failed`, `cancelled` | Recent tasks across all states |
| `--type` | `image`, `video`, `audio` | All media types |
| `--since` | ISO 8601, Unix seconds, or a relative time such as `30m`, `2h`, `1d` | No creation-time filter |
| `--limit` | Integer from 1 to 50 | 20 |

`processing` includes queued tasks. Do not use `pending`, `queued`, `canceled` or `all` as a status filter. A task response can report `pending`; response statuses and accepted list filters are separate contracts. `cancelled` lets you read that state; this CLI does not provide a cancellation command. Run `evolink tasks list --help` for details, or add `--json` for its machine-readable help envelope.

An invalid status is rejected locally before login or an MCP request. The `invalid_status` error includes `param`, the supplied `value`, `allowed_values`, `queued_filter`, `request_sent: false` and a recovery `next_step`. Correct the free query rather than creating another paid task. A successful query with an empty list, or a task whose `status` is `failed`, is not a failed CLI invocation.

The CLI persists the request ID before paid submission. Recovery reuses that ID; it never silently submits with a new one. For an uncertain submission, omit `--status` so completed or failed tasks remain visible. Lists are account-wide, newest first and limited to the returned recent batch; `--since` filters that batch rather than searching all history. An empty list does not prove no task was created. Keep the original IDs and use `tasks get` or `tasks resume` as appropriate; after an expired uncertain quote, inspect recent tasks before considering another paid submission. Ctrl-C stops local waiting, not generation. Task links expire after 24 hours.

Uploads stream up to the service limit (currently 95 MB) through a one-time address. Its token is not stored or forwarded elsewhere. Downloads use a product User-Agent, validate redirect destinations, check content types and common media file headers, stream at most 1 GiB per result, and refuse to overwrite existing files. HTTP 200 HTML/error documents are rejected with `invalid_download_content`, with no final file left behind. Header checks do not fully decode codecs. These commands transfer originals and do not alter the generated content or guarantee host inline previews. Missing files/directories, denied permissions and exhausted disk space have separate error codes; fix the local problem and retry the same task's download.

## Authentication and state

Login uses a native public OAuth client, PKCE, a loopback callback and `mcp offline_access` on the existing Passport service. Dynamically registered clients currently appear as unverified on the consent page. Device-code login is not included in this release.

Tokens are stored only in the OS credential store. Linux requires a running Secret Service keyring; the CLI does not silently fall back to an in-memory kernel store or plaintext credential files. A one-command OAuth access token can be passed through stdin with `--token-stdin`, never as a command argument. `auth logout` revokes this session and preserves the account's shared MCP key.

Run `evolink doctor --json` to check Node.js, writable local state, credential storage, saved login, balance connectivity and model discovery. Add `--agent NAME` to check installed skills. It reports failed and skipped checks together and exits nonzero until the connection is verified. On Linux, run login and later commands in the same unlocked Secret Service/D-Bus session. A keyring package alone does not start or unlock that session.

On an SSH host, the OAuth loopback callback belongs to the host running the CLI. If you open the link on your own computer, forward its callback port: run `evolink auth login --no-browser` remotely, read the `127.0.0.1:PORT` in the printed link's `redirect_uri`, then use a second local terminal with `ssh -N -L PORT:127.0.0.1:PORT USER@HOST` before opening that link. Keep both commands alive until approval finishes (the login waits up to three minutes). Otherwise run the CLI locally. `--no-browser` prints a link but does not forward it. Device-code login is not provided.

Quotes, request IDs and non-secret public client metadata retain the existing `~/.evolink-media` location so an upgrade can reuse saved requests and the OS-stored login. `EVOLINK_CLI_HOME` selects an isolated state directory; the original `EVOLINK_MEDIA_HOME` remains supported. The credential-service identity and skill ownership marker also remain stable across the command rename. Browser links are printed on stderr. Tokens and PKCE verifiers are not printed. Never include credentials in bug reports.

All machine-readable commands accept `--json`. Stdout contains one envelope with `schema_version: 1` and `ok`; progress goes to stderr. Errors return `ok: false`, an error code and a nonzero exit code (130 for interruption).

## Development and migration

Run installation and tests on the test cloud host, not the development Mac. In this package directory: `npm ci`, `npm test`, `npm run test:mutations`, and `npm pack`. Tests use loopback fixtures and never spend production credits. Real paid acceptance requires a separate quote and user approval.

Development starts in `deeplearning-goethe/evolink-cli`. After acceptance, repository management will arrange migration to `Evolink-AI/evolink-cli`. Keep package/bin names and service identity stable; update repository metadata, publishing permissions and installation links during migration.

## Host permission compatibility

CLI command validation does not grant the assistant permission to run a command. Respect host denials and keep the original budget, model and request IDs. Gemini CLI 0.63.0 can reject shell arguments derived from tool output in a noninteractive session, even with a command-prefix allow rule. Use an interactive session to review permissions; for a separately selected native MCP workflow, configure Gemini's Streamable HTTP connection and authorize it with `/mcp auth evolink`. CLI OAuth credentials are not exported or copied into MCP settings. Do not automatically switch routes after a denial or disable host safety checks.

```json
{
  "mcpServers": {
    "evolink": { "httpUrl": "https://mcp.evolink.ai/mcp" }
  }
}
```

Run `gemini mcp list` from the intended project directory. If EvoLink is `Disabled` because the folder is untrusted, review that folder using Gemini's normal trust dialog or `/permissions`; do not disable folder-trust checks globally. `Connected` confirms discovery, so also verify a real read-only model or balance call.

Headless mode exposes only tools permitted by its policy. In Gemini CLI 0.63.0, a scoped MCP rule uses `mcpName`, not `serverName`; allow only the tools needed for the chosen workflow. For example, a quote-only policy can allow `search_models`, `get_model`, `estimate_cost`, `check_balance` and `get_task` on `evolink`. Generation still requires the user's quote approval and the host's normal tool permission. Do not silently add a generation allow rule or treat a successful process exit without EvoLink tool calls as acceptance.

See [Gemini trusted folders](https://geminicli.com/docs/cli/trusted-folders/) and [Gemini MCP configuration and OAuth](https://geminicli.com/docs/tools/mcp-server/). A cloud terminal test does not prove desktop inline previews, browser handoff on another machine or permission defaults in every host.
