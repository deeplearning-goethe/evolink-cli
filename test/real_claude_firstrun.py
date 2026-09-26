#!/usr/bin/env python3
"""Which first-run screens does the real Claude Code show after `evolink setup`?

Starts the interactive `claude` in a pseudo-terminal, in a throwaway HOME, against the local
mock gateway, and reports the screens it lands on:
  A. evolink setup as shipped (onboarding flag written), project folder not trusted
  B. same settings but a fresh ~/.claude.json (no onboarding flag)
  C. evolink setup --trust <project>

    python3 test/real_claude_firstrun.py [path-to-claude]
"""
import json
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
CLAUDE = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.local/bin/claude")
KEY = "sk-" + "Fr5tRun0" * 6
PORT = 18767

MARKERS = {
    "theme picker": r"Choose the text style|text style that looks best",
    "login method": r"Select login method|Claude account with subscription|Anthropic Console account",
    "security notes": r"Security notes",
    "trust dialog": r"trust the files in this folder|project you created or one you trust|Yes, I trust this folder",
    "api key approval": r"Detected a custom API key|Do you want to use this API key",
    # 2.1.283 replaced the "? for shortcuts" footer with "auto mode on (shift+tab to cycle)".
    "main prompt": r"\? for shortcuts|Try \"|for shortcuts|shift\+tab to cycle|auto mode on",
    "connect error": r"Unable to connect to Anthropic services",
}


def strip_ansi(s):
    s = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", " ", s)
    s = re.sub(r"\x1b\][^\x07]*(\x07|\x1b\\)", " ", s)
    return re.sub(r"[ \t]+", " ", s)


def run_claude(home, cwd, seconds=12):
    env = {"HOME": home, "PATH": "/usr/bin:/bin", "TERM": "xterm-256color", "DISABLE_AUTOUPDATER": "1", "LANG": "en_US.UTF-8", "COLUMNS": "120", "LINES": "40"}
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execve(CLAUDE, [CLAUDE], env)
    out = b""
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.3)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            out += data
    # Keep draining the pty while the child exits; a full pty buffer blocks its exit otherwise.
    signals = [signal.SIGINT, signal.SIGINT, signal.SIGTERM, signal.SIGKILL]
    deadline = time.time() + 15
    while time.time() < deadline:
        done, _ = os.waitpid(pid, os.WNOHANG)
        if done:
            break
        if signals:
            try:
                os.kill(pid, signals.pop(0))
            except ProcessLookupError:
                pass
        r, _, _ = select.select([fd], [], [], 0.4)
        if r:
            try:
                out += os.read(fd, 65536)
            except OSError:
                pass
    os.close(fd)
    text = strip_ansi(out.decode("utf-8", "replace"))
    return [name for name, pat in MARKERS.items() if re.search(pat, text)], text


def evolink_setup(home, extra):
    env = {"HOME": home, "PATH": f"{os.path.dirname(NODE)}:/usr/bin:/bin", "NO_COLOR": "1", "LANG": "en_US.UTF-8", "EVOLINK_API_KEY": KEY, "EVOLINK_BASE_URL": f"http://127.0.0.1:{PORT}"}
    r = subprocess.run([NODE, os.path.join(ROOT, "bin", "evolink.mjs"), "setup", "--yes", "--no-install", "--no-test", *extra], env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


def main():
    mock = subprocess.Popen([NODE, os.path.join(ROOT, "test", "mock-server.mjs"), str(PORT), KEY], stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    results = {}
    try:
        home = tempfile.mkdtemp(prefix="evolink-firstrun-")
        proj = os.path.join(home, "proj")
        os.makedirs(proj)
        evolink_setup(home, [])
        results["A. setup (onboarding flag), untrusted folder"], text_a = run_claude(home, proj)

        home_b = tempfile.mkdtemp(prefix="evolink-firstrun-")
        proj_b = os.path.join(home_b, "proj")
        os.makedirs(proj_b)
        evolink_setup(home_b, ["--no-onboarding"])
        results["B. same settings, no onboarding flag"], text_b = run_claude(home_b, proj_b)

        home_c = tempfile.mkdtemp(prefix="evolink-firstrun-")
        proj_c = os.path.join(home_c, "proj")
        os.makedirs(proj_c)
        evolink_setup(home_c, ["--trust", proj_c])
        results["C. setup --trust <folder>"], text_c = run_claude(home_c, proj_c)
    finally:
        mock.terminate()
    for name, screens in results.items():
        print(f"{name}: {', '.join(screens) or '(nothing recognised)'}")
    if "--dump" in sys.argv:
        for label, t in (("A", text_a), ("B", text_b), ("C", text_c)):
            print(f"\n===== screen text {label} =====\n{t[-2500:]}")
    for h in (home, home_b, home_c):
        shutil.rmtree(h, ignore_errors=True)


if __name__ == "__main__":
    main()
