#!/usr/bin/env python3
"""Drive `evolink setup` through a real pseudo-terminal (macOS / Linux).

Checks what the node:test suite cannot: hidden key input in raw mode, the numbered
model picker, yes/no prompts and the trust question, all in a throwaway HOME.

    python3 test/interactive_pty.py
"""
import json
import os
import pty
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
KEY = "sk-" + "Pt7yIn4t" * 6
PORT = 18765


def read_until(fd, pattern, buf, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        if re.search(pattern, buf[0]):
            return
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            buf[0] += data.decode("utf-8", "replace")
    raise AssertionError(f"timed out waiting for {pattern!r}; output so far:\n{buf[0][-2000:]}")


def main():
    mock = subprocess.Popen([NODE, os.path.join(ROOT, "test", "mock-server.mjs"), str(PORT), KEY], stderr=subprocess.PIPE)
    time.sleep(0.8)
    home = tempfile.mkdtemp(prefix="evolink-pty-")
    project = os.path.join(home, "my-project")
    os.makedirs(project)
    env = {
        "HOME": home,
        "PATH": f"{os.path.dirname(NODE)}:/usr/bin:/bin",
        "LANG": "zh_CN.UTF-8",
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "EVOLINK_BASE_URL": f"http://127.0.0.1:{PORT}",
    }
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(project)
        if "--via-bootstrap" in sys.argv:
            # Same as `curl -fsSL .../setup.sh | bash`: the script arrives on stdin, prompts must use /dev/tty.
            os.execve("/bin/bash", ["/bin/bash", "-c", f"cat '{os.path.join(ROOT, 'dist', 'setup.sh')}' | bash -s -- --no-install"], env)
        os.execve(NODE, [NODE, os.path.join(ROOT, "bin", "evolink.mjs"), "setup", "--no-install"], env)
    buf = [""]
    try:
        read_until(fd, r"粘贴 API Key", buf)
        os.write(fd, KEY[:20].encode())  # typed in two chunks, like a slow paste
        time.sleep(0.1)
        os.write(fd, (KEY[20:] + "\r").encode())
        read_until(fd, r"输入序号", buf)
        assert KEY[3:] not in buf[0], "the key was echoed"
        assert "*" * 10 in buf[0], "no masked echo"
        os.write(fd, b"2\r")  # claude-sonnet-5
        read_until(fd, r"已信任", buf)
        os.write(fd, b"y\r")
        read_until(fd, r"确认写入", buf)
        os.write(fd, b"\r")
        read_until(fd, r"发一条测试消息", buf)
        os.write(fd, b"\r")
        read_until(fd, r"撤销本次配置", buf, timeout=30)
        time.sleep(0.5)
        try:
            buf[0] += os.read(fd, 65536).decode("utf-8", "replace")
        except OSError:
            pass
    except AssertionError:
        print(buf[0][-3000:])
        os.kill(pid, 15)
        os.waitpid(pid, 0)
        mock.terminate()
        raise
    _, status = os.waitpid(pid, 0)
    mock.terminate()
    out = buf[0]
    settings = json.load(open(os.path.join(home, ".claude", "settings.json")))
    claude_json = json.load(open(os.path.join(home, ".claude.json")))
    real_project = os.path.realpath(project)
    checks = {
        "exit code 0": os.waitstatus_to_exitcode(status) == 0,
        "key hidden in terminal": KEY[3:] not in out,
        "model chosen from picker": settings["env"].get("ANTHROPIC_MODEL") == "claude-sonnet-5",
        "key written": settings["env"].get("ANTHROPIC_AUTH_TOKEN") == KEY,
        "onboarding skipped": claude_json.get("hasCompletedOnboarding") is True,
        "project trusted": claude_json.get("projects", {}).get(real_project, {}).get("hasTrustDialogAccepted") is True,
        "test request passed": "测试通过" in out,
    }
    print(out)
    print("-" * 60)
    for name, ok in checks.items():
        print(("PASS " if ok else "FAIL ") + name)
    shutil.rmtree(home, ignore_errors=True)
    sys.exit(0 if all(checks.values()) else 1)


if __name__ == "__main__":
    main()
