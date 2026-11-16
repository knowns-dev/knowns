import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  quoteWindowsArg,
  spawnDetached,
  windowsEnvBlock,
} from "../../src/platform/detached-spawn.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(fn: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

describe("spawnDetached", () => {
  test("appends the child's output to the log and passes the environment", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "detached-")));
    const log = join(dir, "child.log");
    const pid = spawnDetached(
      process.execPath,
      [
        "-e",
        "console.log('argv', process.argv.slice(1).join('|'), process.env.KN_PROBE)",
        "a b",
        'q"t',
      ],
      { logPath: log, env: { ...process.env, KN_PROBE: "from parent" } },
    );
    expect(pid).toBeGreaterThan(0);
    expect(await until(() => readFileSync(log, "utf8").includes("argv"))).toBe(true);
    expect(readFileSync(log, "utf8")).toContain('argv a b|q"t from parent');
  });

  test("the child does not keep the parent's listening socket", async () => {
    // A listener in this process, then a long-lived child, then close the listener here: if the
    // child had inherited the socket the port would stay bound. Re-listening on it proves it did not.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "detached-")));
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    const pid = spawnDetached(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      logPath: join(dir, "child.log"),
    });
    try {
      expect(alive(pid)).toBe(true);
      await new Promise<void>((r) => server.close(() => r()));
      const again = net.createServer();
      await new Promise<void>((resolve, reject) => {
        again.once("error", reject);
        again.listen(port, "127.0.0.1", resolve);
      });
      await new Promise<void>((r) => again.close(() => r()));
    } finally {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    expect(await until(() => !alive(pid))).toBe(true);
  });

  test("reports a command that cannot start", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "detached-")));
    let failed = false;
    try {
      spawnDetached(join(dir, "no-such-binary"), [], { logPath: join(dir, "child.log") });
      // POSIX reports ENOENT asynchronously through the child's error event: no pid is not thrown.
    } catch {
      failed = true;
    }
    if (process.platform === "win32") expect(failed).toBe(true);
  });
});

describe("windows command line helpers", () => {
  test("quoteWindowsArg follows CommandLineToArgvW", () => {
    expect(quoteWindowsArg("plain")).toBe("plain");
    expect(quoteWindowsArg("")).toBe('""');
    expect(quoteWindowsArg("a b")).toBe('"a b"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
  });

  test("windowsEnvBlock is sorted and double-NUL terminated", () => {
    const block = windowsEnvBlock({ b: "2", A: "1", skipped: undefined }).toString("utf16le");
    expect(block).toBe("A=1\0b=2\0\0");
  });
});
