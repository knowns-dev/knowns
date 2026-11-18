#!/usr/bin/env python3
"""Drive a command on a pseudo-terminal (unix only).

usage: ptydrive.py <cwd> <spec.json>
spec: {"env": {...}, "argv": [...], "steps": [[expect_regex_or_null, keys, resend?], ...], "cols": 140, "rows": 50}
The driver answers the terminal queries a real terminal answers (background colour OSC 11, cursor
position CSI 6n): huh asks both at the start of every form and swallows the keys typed until the
reply arrives or its own timeout passes, so on a slow host a key sent after the title appeared was
lost and Go stayed in the sub-form.
Each step waits (max 20s) until the ANSI-stripped output since the previous step matches expect,
waits for the screen to be quiet for 0.6s (at most 6s), then sends keys. After the last step it waits for the process to
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
tail = b""


def answer(d):
    """Replies to terminal queries found in the output chunk `d` (a query may span two chunks)."""
    global tail
    data = tail + d
    for _ in re.findall(rb"\x1b\]11;\?(?:\x07|\x1b\\)?", data):
        os.write(fd, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
    for _ in re.findall(rb"\x1b\[6n", data):
        os.write(fd, b"\x1b[1;1R")
    # Keep only an unfinished query (ESC at the end of the chunk) for the next chunk.
    cut = data.rfind(b"\x1b")
    tail = data[cut:] if cut >= 0 and len(data) - cut < 8 and not re.search(rb"\x1b\]11;\?|\x1b\[6n", data[cut:]) else b""


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
            answer(d)


def settle(quiet=0.6, cap=6.0):
    """Waits until the program has printed nothing for `quiet` seconds (at most `cap`): a fixed
    pause was too short for a slow host still drawing the screen the keys are meant for."""
    end = time.time() + cap
    last = len(full)
    since = time.time()
    while alive and time.time() < end and time.time() - since < quiet:
        pump(0.1)
        if len(full) != last:
            last = len(full)
            since = time.time()


RESEND_AFTER = 4.0
prev_keys, prev_at, prev_resend = None, 0.0, False
for step in spec["steps"]:
    expect, keys = step[0], step[1]
    resend = len(step) > 2 and bool(step[2])
    if expect:
        deadline = time.time() + 20
        while alive and time.time() < deadline and not re.search(expect.encode(), ansi.sub(b"", window)):
            pump(0.1)
            # A key that changed nothing on screen is sent once more: a program that was not reading
            # its terminal yet drops it (the Go form's ctrl-C on a slow host), and the next step
            # would then wait for a screen that never comes. Only steps marked "resend" (keys that
            # are safe to repeat) are treated this way.
            if prev_resend and prev_keys is not None and time.time() - prev_at > RESEND_AFTER:
                window = b""
                os.write(fd, prev_keys)
                prev_resend = False
    else:
        pump(0.3)
    if not alive:
        break
    settle()
    window = b""
    os.write(fd, keys.encode())
    prev_keys, prev_at, prev_resend = keys.encode(), time.time(), resend

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
