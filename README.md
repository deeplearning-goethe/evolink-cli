# EvoLink CLI（`evolink`）

图片、视频和音频生成 CLI 的首版候选位于 [packages/media-cli](packages/media-cli/README.md)，通过浏览器登录，使用独立命令 `evolink-media`。现有 `evolink` 配置工具保留。

[![CI](https://github.com/deeplearning-goethe/evolink-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/deeplearning-goethe/evolink-cli/actions/workflows/ci.yml)

一条命令把 Claude Code 或 Codex 接到 [EvoLink](https://evolink.ai)：检查环境 → 校验 Key 和余额 → 安全地写配置（先备份、只改自己负责的项）→ 发一条测试请求 → 告诉用户下一步。另有 `doctor`（自检，输出可以直接发给客服）和 `reset`（撤销）。

> **测试阶段**：v0.4.0，支持 Claude Code、Codex 命令行、VS Code 等编辑器里的 Codex 扩展，以及 VS Code 内置的 Chat（Copilot 自定义端点）。npm 包 `@evolinkai/cli` 发布后可用 `npx -y @evolinkai/cli`；发布前请用下面的一行命令。

## 用法

| 场景 | 命令 |
|---|---|
| macOS / Linux | `curl -fsSL https://cdn.evolink.ai/cli/setup.sh \| bash` |
| Windows PowerShell | `irm https://cdn.evolink.ai/cli/setup.ps1 \| iex` |
| 只预览改动，不写文件、不安装任何东西（macOS / Linux） | `curl -fsSL https://cdn.evolink.ai/cli/setup.sh \| bash -s -- --dry-run` |
| 带参数（macOS / Linux） | `curl -fsSL https://cdn.evolink.ai/cli/setup.sh \| bash -s -- --model claude-sonnet-5` |
| 带参数（Windows） | `& ([scriptblock]::Create((irm https://cdn.evolink.ai/cli/setup.ps1))) --model claude-sonnet-5` |
| Codex（macOS / Linux） | `curl -fsSL https://cdn.evolink.ai/cli/setup.sh \| bash -s -- codex` |
| Codex（Windows） | `& ([scriptblock]::Create((irm https://cdn.evolink.ai/cli/setup.ps1))) codex` |
| VS Code 里的 Codex 扩展（macOS / Linux） | `curl -fsSL https://cdn.evolink.ai/cli/setup.sh \| bash -s -- codex --vscode` |
| VS Code 里的 Codex 扩展（Windows） | `& ([scriptblock]::Create((irm https://cdn.evolink.ai/cli/setup.ps1))) codex --vscode` |
| VS Code 内置的 Chat（macOS / Linux，在装了 VS Code 的电脑上运行） | `curl -fsSL https://cdn.evolink.ai/cli/setup.sh \| bash -s -- copilot` |
| VS Code 内置的 Chat（Windows） | `& ([scriptblock]::Create((irm https://cdn.evolink.ai/cli/setup.ps1))) copilot` |
| 顺便给 VS Code / Cursor 装上 Claude Code 扩展 | `curl -fsSL https://cdn.evolink.ai/cli/setup.sh \| bash -s -- --install-extension` |
| 事后自检 / 撤销 | `~/.evolink/bin/evolink doctor`、`~/.evolink/bin/evolink reset`（Windows：`& "$env:USERPROFILE\.evolink\bin\evolink.cmd" doctor`）；Codex 加 `codex`：`evolink doctor codex`、`evolink reset codex`；不带 `codex` 的 `reset` 会把两边都撤销 |

脚本的 SHA-256 见 `https://cdn.evolink.ai/cli/SHA256SUMS`，与本仓库 `dist/` 下的文件一致。全部选项见 `evolink --help`。

引导脚本（`setup.sh` / `setup.ps1`）会做三件事：
1. 找 Node.js 18+。找不到时，macOS 提示用 Homebrew 装，Windows 提示用 winget 装，其他情况给出 npmmirror 下载地址。
2. 把 CLI 存到 `~/.evolink/cli/`，并建一个启动器 `~/.evolink/bin/evolink`。
3. 运行 `evolink setup`。

它**不改 PATH，也不改 shell 配置文件**。CLI 源码直接内嵌在脚本里，运行前会校验 SHA-256。

## 它会改什么

| 文件 | 内容 | 为什么 |
|---|---|---|
| `~/.claude/settings.json` 的 `env` | `ANTHROPIC_BASE_URL=https://direct.evolink.ai`、`ANTHROPIC_AUTH_TOKEN=<Key>` | 官方推荐的位置，优先级高于 shell 变量；Windows 和 macOS 通用，关掉终端也不失效 |
| 同上 | `ANTHROPIC_API_KEY=""` | 压住 shell 或注册表里残留的旧 Key。不压的话，旧 Key 会被优先使用，导致 401 并不停重试 |
| 同上 | `ANTHROPIC_DEFAULT_SONNET_MODEL=<这把 Key 能用的最新 Sonnet>`（现在是 `claude-sonnet-5-5`） | Claude Code 换默认 Sonnet 时，EvoLink 可能晚一两天才有：2.1.284 起 `/model` 里的 Sonnet 和 `--model sonnet` 都指向 `claude-sonnet-5-5`，EvoLink 09-30 才接入，这期间选了就报"模型不存在"（09-29 实测）。钉住后 `sonnet` / `sonnet[1m]` 都走这把 Key 能用的最新 Sonnet；你自己设过可用的值就不动；加 `--no-pin-sonnet` 不写；`reset` 会还原 |
| 同上（仅加 `--max-output-tokens 32000` 时） | `CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000` | 默认不设，跟随 Claude Code 自己的输出上限（Sonnet 5 为 64K，Opus 5.5 为 128K）。余额少时加这个参数，Opus 5.5 单次预扣从约 $2.5 降到约 $0.7 |
| 同上（仅加 `--disable-nonessential-traffic` 时） | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | 默认不设。设了会减少非必要请求，**副作用是关掉自动更新** |
| `~/.claude/settings.json` 顶层 | `"disableAutoMode": "disable"` | 先关掉 Claude Code 2.1.283 起默认开启的 auto mode。EvoLink 网关暂不支持它的审核请求：开着的话需要审核的命令会被拦下，而且每条命令会白白计费 4 次审核请求（09-28 线上实测）。加 `--auto-mode` 可以不关；网关修好后重跑 `setup --auto-mode` 即可恢复，`reset` 也会还原 |
| 同上（仅在需要时） | 删除这把 Key 用不了的模型覆盖项（`ANTHROPIC_DEFAULT_*_MODEL`、`model` 等）以及 `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY` | 从其他平台切换过来时常见的残留；不处理会报"模型不存在"，或者根本不走 EvoLink |
| 同上（仅在需要时） | shell / 注册表里的上述残留变量，在这里置为 `""` | 配置文件里的值优先于 shell，写空值就能压住 |
| `~/.claude.json` | `hasCompletedOnboarding: true`（只改这一个键；文件读不了就跳过，不覆盖） | 跳过首次启动的主题页和引导页 |
| `~/.claude.json`（需用户同意或 `--trust`） | `projects["<真实路径>"].hasTrustDialogAccepted: true` | 消掉"信任文件夹默认选中 No, exit"这个坑 |
| VS Code / Cursor 等编辑器的用户设置（检测到 Claude Code 扩展时） | `"claudeCode.disableLoginPrompt": true`，最小化插入，保留原有注释 | 只写 settings.json 过不了扩展自己的登录检查 |
| VS Code / Cursor 等编辑器（仅加 `--install-extension` 时） | 用编辑器自己的命令行安装 Claude Code 扩展（`code --install-extension anthropic.claude-code`；macOS 没把 `code` 加进 PATH 时，到应用包里找） | 默认不装：终端里的 `claude` 用不到它。检测到打开过的编辑器没装扩展时，结尾给出安装链接 `vscode:extension/anthropic.claude-code` |

**不写**：`.zshrc` 等 shell 配置文件、Windows 系统环境变量、hosts 文件。

## Codex（`evolink setup codex`）

| 文件 | 内容 | 为什么 |
|---|---|---|
| `~/.codex/evolink.config.toml`（设了 `CODEX_HOME` 就放在那里） | `model`、`model_provider = "evolink-cli"`、`web_search = "disabled"`，以及 `[model_providers.evolink-cli]`：`base_url = "https://direct.evolink.ai/v1"`、`wire_api = "responses"`、Key（`experimental_bearer_token`） | 独立配置档：只有 `codex -p evolink` 走 EvoLink，直接运行 `codex` 仍是你原来的设置（ChatGPT 账号或自己的 `config.toml`）。Key 写在这个文件里（权限 0600），不依赖环境变量，所以 VS Code 等从 Dock 启动的程序也能读到；Codex 不会把它写进日志和会话记录（09-30 用 Codex 0.159.2 实测） |
| 同上（仅当 `config.toml` 开了自动审批审核时） | `approvals_reviewer = "user"` | 配置档会继承 `config.toml` 的设置。自动审批审核用的 `codex-auto-review` 模型 EvoLink 没有，开着的话需要审核的命令都会被拒绝 |
| `~/.codex/config.toml` | **不改** | — |

- **模型**：从这把 Key 能用的 GPT 文本模型里选（09-30 实测 11 个都支持 `/v1/responses`；图像模型自动排除），默认跟随 Codex 自己的默认模型 `gpt-6.1-sol`（这把 Key 没有时依次改用 gpt-6-sol、gpt-6-astra、gpt-6-luna）。Codex 0.159 自带的 8 个模型 EvoLink 都有，进入 Codex 后用 `/model` 可以直接换。
- **为什么 provider 叫 `evolink-cli`**：配置档会和 `config.toml` 合并。以前的文档教过在 `config.toml` 里写 `[model_providers.evolink]`（Key 取自环境变量 `OPENAI_API_KEY`），同名的话，那里的 `env_key` 会盖过配置档里的 Key。
- **`config.toml` 里会让 Codex 直接报错的写法**：`[profiles.evolink]` 这一段、顶层的 `profile = "…"`。新版 Codex 已不支持，setup 和 doctor 都会指出来，需要手动删掉（`setup codex` 不改 `config.toml`）。
- **Codex 自己也会往配置档里写东西**：第一次打开界面写 `[tui]`，信任某个文件夹时写 `[projects."…"]`。重跑 setup 时，这些和你自己加的设置都会保留；只有 setup 管的几项会被更新。
- **启动提示**：带 `-p` 时 Codex 总会提示 "Running without the shared background server"，这是正常的。
- **没装 Codex**：默认用 npm 安装（`npm install -g @openai/codex`，自动选官方源或 npmmirror）；`--no-install` 跳过。
- **费用提醒**：Codex 每轮都带很长的系统提示和工具说明，一句简单的话也要约 9 千个输入 token。
- **撤销**：`evolink reset codex` 删除配置档（先备份），连同 Codex 后来写进去的信任记录等一起删掉；setup 之前就有的同名文件会还原；已经被整个换成别的内容的文件保持不动。
- **VS Code 里的 Codex 扩展不认独立配置档**：要让扩展也走 EvoLink，用下一节的 `setup codex --vscode`。`setup codex` 结尾检测到扩展时会提示。

## VS Code 里的 Codex 扩展（`evolink setup codex --vscode`）

Codex 扩展（`openai.chatgpt`）运行的是它自带的 `codex app-server`，只读主配置 `config.toml`，不认独立配置档。所以这个模式直接改 `config.toml`：扩展和终端里直接运行的 `codex` 都会走 EvoLink。

| 文件 | 内容 | 为什么 |
|---|---|---|
| `~/.codex/config.toml` 顶层 | `model_provider = "evolink-cli"`、`model`（这把 Key 能用的 GPT 模型；原来的值能用就不动）、`web_search = "disabled"` | 让扩展和 `codex` 都用 EvoLink；EvoLink 不提供 OpenAI 自带的联网搜索 |
| 同上（仅当开了自动审批审核时） | `approvals_reviewer = "user"` | 自动审批审核要用的 `codex-auto-review` 模型 EvoLink 没有 |
| 同上，文件末尾 | 一行注释，加上 `[model_providers.evolink-cli]`：`base_url`、`wire_api = "responses"`、Key（`experimental_bearer_token`） | 自定义的模型提供方不需要登录 OpenAI：`app-server` 回报 `requiresOpenaiAuth = false`，扩展就不显示登录页（10-01 读 Codex 0.159.2 源码并实测） |
| VS Code / Cursor 等编辑器 | 用编辑器自己的命令行安装 Codex 扩展（`code --install-extension openai.chatgpt`）；`--no-install-extension` 跳过 | 没有扩展，这个模式就没用，所以默认安装 |

- **只改这几项**：注释、MCP 服务器、信任的文件夹等其他内容一字不动。工具按整条语句编辑，多行数组、多行字符串、CRLF 换行、BOM 都保留。改之前备份到 `~/.evolink/backups/`。
- **Key 在 `config.toml` 里**：文件权限改为 0600，只有你自己能读写。如果你用 git 等同步这个文件，请先把它排除。`doctor codex` 会检查权限。
- **会先确认**：交互运行时先说明影响（扩展和直接运行的 `codex` 都改走 EvoLink；登录过的 ChatGPT 账号保留，只是暂时不用），默认选"否"；加 `--yes` 直接写。
- **装好之后**：VS Code 已经开着的话，运行 "Developer: Reload Window" 或重启 VS Code；打开 Codex 面板直接对话，不需要登录。在扩展的模型菜单里换模型。
- **Remote-SSH**：在远端的终端里运行这条命令。扩展在远端运行，读的是远端的配置；远端终端里的 `code` 也会把扩展装到远端。
- **写不了的情况**：`config.toml` 格式有误，或者已经用别的写法（点号键、内联表）定义了 `model_providers.evolink-cli`。这时 setup 会停下并指出行号，什么都不写。
- **撤销**：`evolink reset codex` 逐项还原 setup 改过的设置，删掉 `[model_providers.evolink-cli]`，恢复原来的文件权限。setup 之后被你或 Codex 改过的项（例如换了模型）保持不动并列出来；Codex 后来写入的信任记录等也保留。如果文件是 setup 新建的，撤销后又没有别的内容，就删掉。
- **和命令行配置档可以同时用**：`codex -p evolink` 用配置档，扩展和直接运行的 `codex` 用 `config.toml`；`reset codex` 两边一起撤销。

## VS Code 内置的 Chat（`evolink setup copilot`）

VS Code 自带的 Chat（Copilot Chat）支持"自定义端点"：在 VS Code 的 `chatLanguageModels.json` 里加一组模型就能用，**不需要登录 GitHub，也不需要 Copilot 订阅**（10-01 用 VS Code 1.140 实测）。

| 文件 | 内容 | 为什么 |
|---|---|---|
| VS Code 用户目录下的 `chatLanguageModels.json`（macOS `~/Library/Application Support/Code/User/`，Linux `~/.config/Code/User/`，Windows `%APPDATA%\Code\User\`；装了 Insiders 也一起写） | 一组 `"name": "EvoLink"`、`"vendor": "customendpoint"` 的模型：Claude 走 Messages 接口（`/v1/messages`），GPT 走 Responses 接口（`/v1/responses`），其他走 Chat Completions（`/v1/chat/completions`）；上下文长度取自 EvoLink 的公开价格目录；单次输出上限 32K | 三种接口 10-01 都在真实 VS Code 里测通过（Claude Haiku 4.5、GPT-6 Luna、DeepSeek V4 Flash、GLM 5.3 Flash、Doubao Seed 2.0 Lite）。输出上限定在 32K，是因为 VS Code 每次请求都会带上它，EvoLink 按它预扣额度 |

- **Key 要在 VS Code 里粘贴一次**：VS Code 只从自己的钥匙串读这组的 Key，文件里写明文 Key 会被忽略（读过源码，也实测过）。所以工具不写 Key，只在结尾告诉你：Chat 的模型列表 → "Manage Models..." → 右键 "EvoLink" → "Update API Key" → 粘贴。粘贴后 VS Code 在文件里写的是 `${input:chat.lm.secret.…}` 引用，Key 本身存进系统钥匙串。
- **默认加推荐的十几个模型**（这把 Key 有的），`--all-models` 加入全部聊天模型。
- **Gemini 暂时不加**：Chat 的 Agent 模式会在工具参数里带 `$comment` 字段，网关转给 Gemini 时没有去掉，Gemini 返回 400。等网关修复后再加。
- **不用重启 VS Code**：VS Code 会监听这个文件，改完立刻生效。
- **重跑 setup**：只更新 EvoLink 这一组的模型列表，已经粘贴过的 Key 引用和其他提供方都保留。
- **测试请求**：每种接口各发一条十几个 token 的测试消息（Claude Haiku、GPT-6 Luna、DeepSeek V4 Flash 优先），只验证 EvoLink 这一侧；VS Code 那一侧要粘贴 Key 后在 Chat 里试。
- **费用提醒**：Agent 模式每轮都带很长的系统提示和工具说明，一句简单的话约 2 万个输入 token；只聊天可以切到 Ask 模式。
- **Remote-SSH**：Chat 的模型配置在你本机的 VS Code 里，要在本机运行这条命令（在远端运行会提示你）。
- **只写默认 Profile**：用了别的 VS Code Profile 的话，要在那个 Profile 里另外添加。
- **撤销**：`evolink reset copilot` 去掉 EvoLink 这一组（setup 之前就有同名组的话还原成原来的样子），其他提供方不动；文件是 setup 新建的、撤销后为空就删掉。VS Code 钥匙串里存的 Key 不会跟着删，要删的话先在 VS Code 的 Language Models 页面里删掉这一组。
- **自检**：`evolink doctor copilot` 检查文件、模型地址、有没有在 VS Code 里粘贴过 Key（只看引用，看不到 Key 本身）。

**Windows 额外处理**：如果 npm 装的 `claude.ps1` 会被执行策略拦下，工具会在征得同意后，把当前用户的执行策略改为 `RemoteSigned`；也可以改用 `claude.cmd`。

## 安全与可回滚

- **Key 的输入**：只从隐藏输入、环境变量 `EVOLINK_API_KEY` 或 `--key-stdin` 读取，不接受命令行参数（会留在 shell 历史里）。
- **Key 的输出与存储**：所有输出只显示 `sk-前4位…后4位`；状态文件里只存哈希，不存 Key。
- **写入之前**：先校验 Key（`GET /v1/models`、`GET /v1/credits`，都不扣费）；校验失败时不改任何文件。
- **写入方式**：先备份到 `~/.evolink/backups/<时间>/`，再原子写入（临时文件 + rename），`settings.json` 的权限设为 0600。
- **目标文件已损坏**：默认停止，不覆盖；加 `--replace-invalid`（或在交互中确认）才会备份后重建。
- **撤销**：`reset` 只还原"写入后没被改过"的项，用户后来自己改过的保持不动。
- **已登录 Anthropic 官方账号**（`~/.claude.json` 有 `oauthAccount`，或有 `.credentials.json`，且 `settings.json` 里还没有地址 / Key）：确认写入前单独提醒"所有 Claude Code 都会改走 EvoLink，包括编辑器里已经打开的会话，立刻生效；想切回运行 reset"，这一步默认选"否"。`--yes` 照常写入，但仍输出提醒，`--json` 里带 `officialLogin: true`。
- **Claude Code 正在运行**：在确认之前提醒，因为打开的会话会热加载 `settings.json`，立刻改用新配置。
- **测试模式**（`HOME` 和系统登记的家目录不一致，例如临时家目录）：开头标明"测试模式"；结尾给的 `claude`、`reset`、`doctor` 命令都带上同一个 `HOME=…`；不提示"Claude Code 正在运行"，因为那是真实家目录里的进程。
- **Claude Code 版本落后**：`setup` 和 `doctor` 会查询 npm 上的最新版本，落后时提示 `claude update`。旧版本不认识新模型（例如 2.1.260 会把 claude-opus-5-5 当成 200K 上下文），请求可能报错。
- **其他**：不埋点，不夹带厂商私货（署名、effort 等）。

## 测试情况

GitHub Actions 在每次推送到 main、每个 PR，以及每天 09:00（北京时间）自动运行：

| 系统 | 内容 |
|---|---|
| Ubuntu（Node 22 和 18） | 自动化测试、伪终端交互（Claude Code 和 Codex，各自直接运行和 `setup.sh` 管道运行）、`dist/` 与源码一致；Node 22 另用当天最新的 Claude Code 实测配置生效和首启画面，用当天最新的 Codex 实测配置档和 VS Code 扩展模式都生效（扩展模式还会像扩展那样启动 `codex app-server`，确认不需要登录并发一轮消息） |
| macOS（Node 22） | 同上，含最新 Claude Code 和 Codex 实测 |
| Windows（Node 22） | 自动化测试（62 项，另 11 项只适用于 macOS / Linux）；`setup.ps1` 在 PowerShell 5.1 和 7 下实跑：带参数运行、`irm \| iex`、启动器 doctor / reset、被篡改的脚本必须被拦下 |

每天定时跑一次，是为了及时发现 Claude Code 和 Codex 新版本带来的变化。手动验证记录：

| 平台 | 已验证 |
|---|---|
| Ubuntu 24.04（Node 22） | **v0.4.0（10-01）**：自动化测试 73/73；伪终端交互 6 种共 52 项；**编辑器界面实测**（测试云主机上的桌面版 VS Code 1.140，真实网关）：Codex 扩展 26.928 在 `setup codex --vscode` 之前显示 ChatGPT 登录页，之后不再显示，发一句话回复 OK；Claude Code 扩展 2.1.286 没配置时显示登录页，只要有 `setup` 写的 `~/.claude/settings.json`（编辑器设置里没有 `disableLoginPrompt`）就不再显示，回复 OK；**VS Code 内置 Chat 线上实测**：`setup copilot` 写入推荐的 14 个模型，三种接口各一条测试请求通过，文件里没有 Key；在 VS Code 里粘贴一次 Key 后，Claude Haiku 4.5、GPT-6 Luna、DeepSeek V4 Pro / Flash、Kimi K3、GLM 5.3、Qwen3.8 Max、Grok 4.7、Doubao Seed 2.0 Code 共 9 个模型在 Chat 里回复 OK；`doctor copilot` 能看出粘贴前后的区别；`reset copilot` 删掉 setup 新建的文件，临时家目录里（备份目录除外）搜不到 Key。**v0.3.0（10-01）**：自动化测试 68/68；伪终端交互 6 种共 52 项；真实 Codex 0.159.3 连模拟网关 17/17，把 `app-server` 换成扩展内置的 codex 0.159.2 同样 17/17；真实 Claude Code 2.1.286 8/8 + 首启画面；**扩展模式线上实测**：真实网关上 `setup codex --vscode`（原来的 `config.toml` 带注释、MCP 服务器、信任记录和自动审批审核），之后直接运行 `codex exec` 返回 OK，扩展内置的 `app-server` 回报不需要登录并返回 OK（各约 1 万 token），`doctor codex --test` 没有问题；`reset codex` 后 `config.toml` 与 setup 之前逐字节一致，权限改回 644，临时家目录里（备份目录除外）搜不到 Key。**v0.2.0（09-30）**：自动化测试 58/58；伪终端交互 4 种共 30 项；真实 Codex 0.159.2 连模拟网关 8/8；真实 Claude Code 2.1.285 8/8 + 首启画面；**Codex 线上实测**：真实网关上 `setup codex`、`codex exec -p evolink` 返回 OK（gpt-6.1-sol，一句话约 1 万 token）、`doctor codex --test`、`reset codex` 后临时家目录外搜不到 Key；真实 Codex 界面里答完信任提示，Codex 往配置档写了 `[tui]`、`[projects."…"]`，`reset codex` 照样能删掉。**更早（v0.1.4）**：自动化测试 43/43；伪终端交互（直接运行、`cat setup.sh \| bash`）各 7/7；真实 Claude Code 2.1.283 / 2.1.284 读取配置并请求模拟网关（含 `--model sonnet` 跟随钉档）；**真实网关**：CDN 一行命令配置、doctor 测试请求、Claude Code 用 claude-sonnet-5 和 claude-opus-5-5 都正常；**auto mode 线上实测（09-28）**：不写设置 / `CLAUDE_CODE_AUTO_MODE_SERVER=0` 都被拦并计费，`disableAutoMode` / `permissions.defaultMode=default` 正常弹确认框并执行，模拟网关修好后两种 auto mode 配置都能正常执行；**Sonnet 钉档线上实测（09-29，v0.1.4）**：Claude Code 2.1.284 的 `--model sonnet` / `sonnet[1m]` 经真实网关都返回 OK，删掉钉档后同一命令报 "There's an issue with the selected model (claude-sonnet-5-5)" |
| macOS 26（Node 24） | v0.4.0：自动化测试 73/73、伪终端交互 6 种共 52 项（临时目录 + 模拟网关）；v0.3.0：68/68；v0.2.0：58/58；更早的版本：真实 Claude Code 2.1.260 / 2.1.282 / 2.1.283 |
| Windows（GitHub Actions 的 Windows Server 虚拟机，Node 22） | v0.4.0：自动化测试 62 项（另 11 项只适用于 macOS / Linux）；`setup.ps1` 在 PowerShell 5.1 和 7 下实跑 18/18。还没有在 Windows 10 / 11 桌面实机和编辑器扩展里用过 |

## 开发

```bash
npm test                  # 单元 + 端到端（临时 HOME + 本地模拟网关，不联网，不需要 Claude Code）
npm run test:interactive  # 伪终端交互（需要 python3）
npm run test:claude       # 用真实 Claude Code 连模拟网关（默认 ~/.local/bin/claude；三个脚本也都接受路径参数）
npm run test:codex        # 用真实 Codex 连模拟网关（默认 PATH 里的 codex；也接受路径参数）
npm run build             # 生成 dist/setup.sh、dist/setup.ps1、dist/evolink.mjs、dist/SHA256SUMS
```

- **不要在自己的工作电脑上用真实家目录跑 `setup`**：它会立刻接管这台电脑上所有的 Claude Code，包括编辑器里已经打开的会话。手动试用请用临时家目录（工具会标明"测试模式"，并给出带 `HOME=…` 的命令），或者用单独的测试机。
- 改版本号：改 `bin/evolink.mjs` 里的 `VERSION`、`package.json`，以及本文开头"测试阶段"那一行，然后重新 build。
- 推荐模型列表：在 `bin/evolink.mjs` 的 `RECOMMENDED_MODELS`（Claude Code）和 `RECOMMENDED_CODEX_MODELS`（Codex）里维护，会按 Key 实际可用的模型过滤。
- 模拟网关：`node test/mock-server.mjs <端口> <Key>`，返回格式与 EvoLink 网关一致。
- 发布脚本：`npm run build` 之后，把 `dist/setup.sh`、`dist/setup.ps1`、`dist/SHA256SUMS` 上传到 `cdn.evolink.ai/cli/`。
