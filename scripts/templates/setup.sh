#!/usr/bin/env bash
# EvoLink one-command setup for Claude Code (macOS / Linux), version __EVOLINK_VERSION__
#
#   curl -fsSL https://cdn.evolink.ai/cli/setup.sh | bash
#   curl -fsSL https://cdn.evolink.ai/cli/setup.sh | bash -s -- --model claude-sonnet-5
#   curl -fsSL https://cdn.evolink.ai/cli/setup.sh | bash -s -- doctor
#
# What it does: finds Node.js (18+), saves the EvoLink CLI to ~/.evolink/cli, adds a launcher at
# ~/.evolink/bin/evolink, then runs `evolink setup`. It does not change your PATH or shell profile.
# The CLI source is embedded below and verified against its SHA-256 before it runs.

set -u

evolink_main() {
  local version="__EVOLINK_VERSION__"
  local expected_sha="__EVOLINK_CLI_SHA256__"
  local home_dir="${EVOLINK_HOME:-$HOME/.evolink}"
  local zh=0
  case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in zh* | *_CN* | *_TW* | *_HK*) zh=1 ;; esac
  say() { if [ "$zh" = 1 ]; then printf '%s\n' "$1" >&2; else printf '%s\n' "$2" >&2; fi; }

  local tty=0
  if (exec </dev/tty) 2>/dev/null; then tty=1; fi

  # 1. Node.js 18+
  local node="" c
  for c in "${EVOLINK_NODE:-}" "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
    if [ -n "$c" ] && [ -x "$c" ] && "$c" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null; then node="$c"; break; fi
  done
  if [ -z "$node" ] && [ -d "$HOME/.nvm/versions/node" ]; then
    for c in $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -t v -k 2 -V -r); do
      if "$c" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null; then node="$c"; break; fi
    done
  fi
  if [ -z "$node" ]; then
    say "没有找到 Node.js 18 或更高版本（Claude Code 需要 Node.js 22+）。" "Node.js 18+ was not found (Claude Code itself wants Node.js 22+)."
    if [ "$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1 && [ "$tty" = 1 ]; then
      say "可以用 Homebrew 安装：brew install node" "It can be installed with Homebrew: brew install node"
      printf '%s' "$([ "$zh" = 1 ] && echo '现在安装吗？[Y/n] ' || echo 'Install now? [Y/n] ')" >&2
      local ans=""
      read -r ans </dev/tty || ans="n"
      case "$ans" in "" | y | Y | yes | YES)
        brew install node && node="$(command -v node 2>/dev/null || true)" ;;
      esac
    fi
    if [ -z "$node" ]; then
      say "请先安装 Node.js 22，再重新运行这条命令：" "Install Node.js 22, then run this command again:"
      say "  中国大陆：https://npmmirror.com/mirrors/node/ （选最新的 v22 安装包）" "  Mainland China mirror: https://npmmirror.com/mirrors/node/"
      say "  官网：https://nodejs.org/zh-cn/download" "  Official: https://nodejs.org/en/download"
      return 3
    fi
  fi

  # 2. Save the CLI and a launcher under ~/.evolink
  mkdir -p "$home_dir/cli" "$home_dir/bin" || return 1
  chmod 700 "$home_dir" 2>/dev/null || true
  local cli="$home_dir/cli/evolink.mjs"
  local tmp="$cli.tmp.$$"
  cat >"$tmp" <<'__EVOLINK_CLI_EOF__'
__EVOLINK_CLI_SOURCE__
__EVOLINK_CLI_EOF__
  local actual=""
  if command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$tmp" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp" | awk '{print $1}')"
  else actual="$("$node" -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$tmp")"; fi
  if [ "$actual" != "$expected_sha" ]; then
    rm -f "$tmp"
    say "下载的脚本不完整（校验失败），请重新运行。" "The downloaded script is incomplete (checksum mismatch); please run it again."
    return 1
  fi
  mv -f "$tmp" "$cli"
  local launcher="$home_dir/bin/evolink"
  {
    printf '#!/bin/sh\n'
    printf '# EvoLink CLI launcher (version %s)\n' "$version"
    printf 'NODE="${EVOLINK_NODE:-$(command -v node 2>/dev/null)}"\n'
    printf '[ -x "$NODE" ] || NODE="%s"\n' "$node"
    printf 'exec "$NODE" "%s" "$@"\n' "$cli"
  } >"$launcher"
  chmod 755 "$launcher"

  # 3. Run it (commands: setup / doctor / reset; setup when omitted)
  case "${1:-}" in setup | doctor | reset | help | --help | -h | --version | -v) ;; *) set -- setup "$@" ;; esac
  local shown="$launcher"
  case "$launcher" in "$HOME"/*) shown="~${launcher#"$HOME"}" ;; esac
  if [ "$tty" = 1 ]; then
    EVOLINK_CMD="$shown" "$node" "$cli" "$@" </dev/tty
  else
    EVOLINK_CMD="$shown" "$node" "$cli" "$@"
  fi
}

evolink_main "$@"
