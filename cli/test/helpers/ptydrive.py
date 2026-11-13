#!/usr/bin/env python3
"""Drive a command on a pseudo-terminal (unix only).

usage: ptydrive.py <cwd> <spec.json>
spec: {"env": {...}, "argv": [...], "steps": [[expect_regex_or_null, keys], ...], "cols": 140, "rows": 50}
Each step waits (max 20s) until the ANSI-stripped output since the previous step matches expect,
lets the screen settle for 0.6s, then sends keys. After the last step it waits for the process to
exit (max 20s, then kills it). Prints one JSON object: {"transcript": str, "exit": int|null}.
"""
import fcntl, json, os, pty, re, select, signal, struct, sys, termios, time

cwd, spec_path = sys.argv[1], sys.argv[2]
spec = json.load(open(spec_path))
env = dict(os.environ)
env.update(spec.get("env", {}))
env.update({"TERM": "xterm-256color", "NO_COLOR": "1"})
argv = spec["argv"]

pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(argv[0], argv, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", spec.get("rows", 50), spec.get("cols", 140), 0, 0))

ansi = re.compile(rb"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]")
full = b""
window = b""
alive = True


def pump(t):
    global full, window, alive
    end = time.time() + t
    while time.time() < end and alive:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                alive = False
                return
            if not d:
                alive = False
                return
            full += d
            window += d


for expect, keys in spec["steps"]:
    if expect:
        deadline = time.time() + 20
        while alive and time.time() < deadline and not re.search(expect.encode(), ansi.sub(b"", window)):
            pump(0.1)
    else:
        pump(0.3)
    if not alive:
        break
    pump(0.6)
    window = b""
    os.write(fd, keys.encode())

deadline = time.time() + 20
code = None
while time.time() < deadline:
    pump(0.1)
    try:
        p, status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        break
    if p != 0:
        code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
        break
if code is None:
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except Exception:
        pass
pump(0.2)
print(json.dumps({"transcript": ansi.sub(b"", full).decode("utf8", "replace"), "exit": code}))
