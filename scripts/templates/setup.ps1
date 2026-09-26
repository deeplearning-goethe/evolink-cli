# EvoLink one-command setup for Claude Code (Windows PowerShell 5.1+ / PowerShell 7), version __EVOLINK_VERSION__
#
#   irm https://cdn.evolink.ai/cli/setup.ps1 | iex
#   & ([scriptblock]::Create((irm https://cdn.evolink.ai/cli/setup.ps1))) --model claude-sonnet-5
#   & ([scriptblock]::Create((irm https://cdn.evolink.ai/cli/setup.ps1))) doctor
#
# What it does: finds Node.js (18+; offers winget if missing), saves the EvoLink CLI to
# %USERPROFILE%\.evolink\cli, adds %USERPROFILE%\.evolink\bin\evolink.cmd, then runs `evolink setup`.
# It does not change PATH. This file is ASCII only; Chinese text is base64 so any download
# encoding works. The CLI is embedded as base64 and checked against its SHA-256 before it runs.

function Invoke-EvoLinkSetup {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs)
    $ErrorActionPreference = 'Stop'
    $version = '__EVOLINK_VERSION__'
    $expectedSha = '__EVOLINK_CLI_SHA256__'
    $zh = ((Get-UICulture).Name -like 'zh*') -or ((Get-Culture).Name -like 'zh*')
    function T([string]$zhB64, [string]$en) {
        if ($zh) { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($zhB64)) }
        return $en
    }
    function Say([string]$zhB64, [string]$en) { Write-Host (T $zhB64 $en) }

    # 1. Node.js 18+
    function Find-Node {
        $candidates = @()
        $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($cmd) { $candidates += $cmd.Source }
        $candidates += @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")
        if (${env:ProgramFiles(x86)}) { $candidates += "${env:ProgramFiles(x86)}\nodejs\node.exe" }
        foreach ($p in $candidates) {
            if ($p -and (Test-Path $p)) {
                $major = & $p -p "process.versions.node.split('.')[0]" 2>$null
                if ([int]$major -ge 18) { return $p }
            }
        }
        return $null
    }
    $node = Find-Node
    if (-not $node) {
        Say '{{zh:没有找到 Node.js 18 或更高版本（Claude Code 需要 Node.js 22+）。}}' 'Node.js 18+ was not found (Claude Code itself wants Node.js 22+).'
        if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
            $ans = Read-Host (T '{{zh:现在用 winget 安装 Node.js LTS 吗？[Y/n]}}' 'Install Node.js LTS with winget now? [Y/n]')
            if ($ans -eq '' -or $ans -match '^[Yy]') {
                winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
                $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
                $node = Find-Node
            }
        }
        if (-not $node) {
            Say '{{zh:请先安装 Node.js 22，再重新运行这条命令：}}' 'Install Node.js 22, then run this command again:'
            Say '{{zh:  中国大陆：https://npmmirror.com/mirrors/node/ （选最新的 v22 的 .msi 安装包）}}' '  Mainland China mirror: https://npmmirror.com/mirrors/node/'
            Say '{{zh:  官网：https://nodejs.org/zh-cn/download}}' '  Official: https://nodejs.org/en/download'
            $global:LASTEXITCODE = 3
            return
        }
    }

    # 2. Save the CLI and a launcher under %USERPROFILE%\.evolink
    $homeDir = if ($env:EVOLINK_HOME) { $env:EVOLINK_HOME } else { Join-Path $env:USERPROFILE '.evolink' }
    $cliDir = Join-Path $homeDir 'cli'
    $binDir = Join-Path $homeDir 'bin'
    New-Item -ItemType Directory -Force -Path $cliDir, $binDir | Out-Null
    $cliPath = Join-Path $cliDir 'evolink.mjs'
    $cliB64 = @'
__EVOLINK_CLI_B64__
'@
    $bytes = [Convert]::FromBase64String(($cliB64 -replace '\s', ''))
    $sha = [Security.Cryptography.SHA256]::Create()
    $actual = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
    if ($actual -ne $expectedSha) {
        Say '{{zh:下载的脚本不完整（校验失败），请重新运行。}}' 'The downloaded script is incomplete (checksum mismatch); please run it again.'
        $global:LASTEXITCODE = 1
        return
    }
    [IO.File]::WriteAllBytes($cliPath, $bytes)
    $launcher = Join-Path $binDir 'evolink.cmd'
    $launcherText = "@echo off`r`nrem EvoLink CLI launcher (version $version)`r`n`"$node`" `"$cliPath`" %*`r`n"
    [IO.File]::WriteAllText($launcher, $launcherText, (New-Object Text.UTF8Encoding $false))

    # 3. Run it (commands: setup / doctor / reset; setup when omitted)
    $known = @('setup', 'doctor', 'reset', 'help', '--help', '-h', '--version', '-v')
    if (-not $CliArgs -or $known -notcontains $CliArgs[0]) { $CliArgs = @('setup') + @($CliArgs | Where-Object { $_ }) }
    $shown = $launcher
    if ($launcher.StartsWith($env:USERPROFILE)) { $shown = '$env:USERPROFILE' + $launcher.Substring($env:USERPROFILE.Length) }
    $env:EVOLINK_CMD = "& `"$shown`""
    try {
        & $node $cliPath @CliArgs
    }
    finally {
        Remove-Item Env:EVOLINK_CMD -ErrorAction SilentlyContinue
    }
}

Invoke-EvoLinkSetup @args
