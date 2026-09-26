# EvoLink CLI（`evolink`）

[![CI](https://github.com/deeplearning-goethe/evolink-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/deeplearning-goethe/evolink-cli/actions/workflows/ci.yml)

一条命令把 Claude Code 接到 [EvoLink](https://evolink.ai)：检查环境 → 校验 Key 和余额 → 安全地写配置（先备份、只改自己负责的项）→ 发一条测试请求 → 告诉用户下一步。另有 `doctor`（自检，输出可以直接发给客服）和 `reset`（撤销）。

> **测试阶段**：v0.1.2，目前只支持 Claude Code，还没有发布到 npm。

## 用法

| 场景 | 命令 |
|---|---|
| macOS / Linux | `curl -fsSL https://cdn.evolink.ai/cli/setup.sh \| bash` |
| Windows PowerShell | `irm https://cdn.evolink.ai/cli/setup.ps1 \| iex` |
| 只预览改动，不写文件（macOS / Linux） | `curl -fsSL https://cdn.evolink.ai/cli/setup.sh \| bash -s -- --dry-run` |
| 带参数（macOS / Linux） | `curl -fsSL https://cdn.evolink.ai/cli/setup.sh \| bash -s -- --model claude-sonnet-5` |
| 带参数（Windows） | `& ([scriptblock]::Create((irm https://cdn.evolink.ai/cli/setup.ps1))) --model claude-sonnet-5` |
| 事后自检 / 撤销 | `~/.evolink/bin/evolink doctor`、`~/.evolink/bin/evolink reset`（Windows：`& "$env:USERPROFILE\.evolink\bin\evolink.cmd" doctor`） |

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
| 同上 | `CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000` | Opus 5.5 单次预扣从约 $2.5 降到约 $0.7，避免"余额不足" |
| 同上 | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | 减少非必要请求。**副作用是关掉自动更新**，加 `--no-disable-nonessential-traffic` 可以不设 |
| 同上（仅在需要时） | 删除这把 Key 用不了的模型覆盖项（`ANTHROPIC_DEFAULT_*_MODEL`、`model` 等）以及 `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY` | 从其他平台切换过来时常见的残留；不处理会报"模型不存在"，或者根本不走 EvoLink |
| 同上（仅在需要时） | shell / 注册表里的上述残留变量，在这里置为 `""` | 配置文件里的值优先于 shell，写空值就能压住 |
| `~/.claude.json` | `hasCompletedOnboarding: true`（只改这一个键；文件读不了就跳过，不覆盖） | 跳过首次启动的主题页和引导页 |
| `~/.claude.json`（需用户同意或 `--trust`） | `projects["<真实路径>"].hasTrustDialogAccepted: true` | 消掉"信任文件夹默认选中 No, exit"这个坑 |
| VS Code / Cursor 等编辑器的用户设置（检测到 Claude Code 扩展时） | `"claudeCode.disableLoginPrompt": true`，最小化插入，保留原有注释 | 只写 settings.json 过不了扩展自己的登录检查 |

**不写**：`.zshrc` 等 shell 配置文件、Windows 系统环境变量、hosts 文件。

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
| Ubuntu（Node 22 和 18） | 自动化测试、伪终端交互（直接运行和 `setup.sh` 管道运行）、`dist/` 与源码一致；Node 22 另用当天最新的 Claude Code 实测配置生效和首启画面 |
| macOS（Node 22） | 同上，含最新 Claude Code 实测 |
| Windows（Node 22） | 自动化测试；`setup.ps1` 在 PowerShell 5.1 和 7 下实跑：带参数运行、`irm \| iex`、启动器 doctor / reset、被篡改的脚本必须被拦下 |

每天定时跑一次，是为了及时发现 Claude Code 新版本带来的变化。手动验证记录：

| 平台 | 已验证 |
|---|---|
| Ubuntu 24.04（Node 22） | 自动化测试 40/40；伪终端交互（直接运行、`cat setup.sh \| bash`）各 7/7；真实 Claude Code 2.1.283 读取配置并请求模拟网关；**真实网关**：CDN 一行命令配置、doctor 测试请求、Claude Code 用 claude-sonnet-5 和 claude-opus-5-5 都正常 |
| macOS 26（Node 24） | 上一版：自动化测试、伪终端交互、真实 Claude Code 2.1.260 / 2.1.282 / 2.1.283 |
| Windows（GitHub Actions 的 Windows Server 虚拟机，Node 22） | 自动化测试 36 项（另 3 项只适用于 macOS / Linux）；`setup.ps1` 在 PowerShell 5.1 和 7 下实跑 18/18。还没有在 Windows 10 / 11 桌面实机和编辑器扩展里用过 |

## 开发

```bash
npm test                  # 单元 + 端到端（临时 HOME + 本地模拟网关，不联网，不需要 Claude Code）
npm run test:interactive  # 伪终端交互（需要 python3）
npm run test:claude       # 用真实 Claude Code 连模拟网关（默认 ~/.local/bin/claude；三个脚本也都接受路径参数）
npm run build             # 生成 dist/setup.sh、dist/setup.ps1、dist/evolink.mjs、dist/SHA256SUMS
```

- **不要在自己的工作电脑上用真实家目录跑 `setup`**：它会立刻接管这台电脑上所有的 Claude Code，包括编辑器里已经打开的会话。手动试用请用临时家目录（工具会标明"测试模式"，并给出带 `HOME=…` 的命令），或者用单独的测试机。
- 改版本号：改 `bin/evolink.mjs` 里的 `VERSION` 和 `package.json`，然后重新 build。
- 推荐模型列表：在 `bin/evolink.mjs` 的 `RECOMMENDED_MODELS` 里维护，会按 Key 实际可用的模型过滤。
- 模拟网关：`node test/mock-server.mjs <端口> <Key>`，返回格式与 EvoLink 网关一致。
- 发布脚本：`npm run build` 之后，把 `dist/setup.sh`、`dist/setup.ps1`、`dist/SHA256SUMS` 上传到 `cdn.evolink.ai/cli/`。
