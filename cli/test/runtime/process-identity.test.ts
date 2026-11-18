// A pid file is not proof of a daemon: after a crash or reboot its pid may belong to any process.
// Nothing may be signalled unless the process is provably a Knowns runtime daemon.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandWords,
  isKnownsRuntimeDaemon,
  isProcessInstance,
  isRuntimeDaemonCommand,
  lastReadFailure,
  readProcessInfo,
  spawnRetryingSpurious,
} from "../../src/runtime/process-identity.ts";
import * as q from "../../src/runtime/queue.ts";
import { setProcessHome } from "../helpers/process-env.ts";

describe("isRuntimeDaemonCommand", () => {
  test("accepts a compiled and a from-source daemon, rejects everything else", () => {
    expect(isRuntimeDaemonCommand("/usr/local/bin/knowns __runtime run")).toBe(true);
    expect(isRuntimeDaemonCommand('"C:\\Program Files\\knowns\\knowns.exe" __runtime run')).toBe(
      true,
    );
    expect(isRuntimeDaemonCommand("/opt/bun /repo/cli/src/main.ts __runtime run")).toBe(true);
    expect(isRuntimeDaemonCommand("/usr/local/bin/knowns __runtime status")).toBe(false);
    expect(isRuntimeDaemonCommand("sleep 300")).toBe(false);
    expect(isRuntimeDaemonCommand("/bin/vim __runtime run")).toBe(false);
    expect(isRuntimeDaemonCommand("/usr/bin/python3 run __runtime")).toBe(false);
    expect(commandWords('a "b c" d')).toEqual(["a", "b c", "d"]);
  });
});

describe("isKnownsRuntimeDaemon", () => {
  const daemon = { commandLine: "/usr/local/bin/knowns __runtime run", startedAt: 1_000_000 };
  test("never this process, never an unreadable one", () => {
    expect(isKnownsRuntimeDaemon(process.pid, 0, { info: () => daemon })).toBe(false);
    expect(isKnownsRuntimeDaemon(4242, 2_000_000, { info: () => undefined })).toBe(false);
  });
  test("a command that is not a daemon is not one", () => {
    expect(
      isKnownsRuntimeDaemon(4242, 2_000_000, {
        info: () => ({ commandLine: "sleep 5", startedAt: 1 }),
      }),
    ).toBe(false);
  });
  test("a process that started after the pid file was written is a reused pid", () => {
    expect(isKnownsRuntimeDaemon(4242, 2_000_000, { info: () => daemon })).toBe(true);
    expect(isKnownsRuntimeDaemon(4242, 500_000, { info: () => daemon })).toBe(false);
  });
});

describe("readProcessInfo", () => {
  test("reads a live process", () => {
    const info = readProcessInfo(process.pid);
    // The reason is the failure message, so a CI log says why it was unknown.
    expect(info, lastReadFailure()).toBeDefined();
    expect(info?.commandLine.length).toBeGreaterThan(0);
    expect(Math.abs((info?.startedAt ?? 0) - Date.now())).toBeLessThan(24 * 3600 * 1000);
  });
  test("still reads a live process when PATH does not lead to the system tools", () => {
    // CI Windows: a PATH without System32 made `powershell.exe` unfindable and the read returned
    // undefined in 5 ms; an unknown identity means no stale daemon is ever recognised.
    const saved = process.env.PATH;
    process.env.PATH = join(tmpdir(), "knowns-no-such-bin");
    try {
      const info = readProcessInfo(process.pid);
      expect(info).toBeDefined();
      expect(info?.commandLine.length).toBeGreaterThan(0);
    } finally {
      if (saved === undefined) delete process.env.PATH;
      else process.env.PATH = saved;
    }
  });
  test("still reads a live process with the PSModulePath that PowerShell 7 hands to its children", () => {
    // pwsh 7 puts its own module directories first; a child Windows PowerShell 5.1 must not be
    // misled by them (CI Windows runs the suite from `shell: pwsh`).
    const saved = process.env.PSModulePath;
    process.env.PSModulePath = [
      "C:\\Users\\x\\Documents\\PowerShell\\Modules",
      "C:\\Program Files\\PowerShell\\Modules",
      "C:\\Program Files\\PowerShell\\7\\Modules",
      "C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules",
    ].join(";");
    try {
      expect(readProcessInfo(process.pid), lastReadFailure()).toBeDefined();
    } finally {
      if (saved === undefined) delete process.env.PSModulePath;
      else process.env.PSModulePath = saved;
    }
  });
  test("an ETIMEDOUT reported long before the timeout is retried; a real one is not", () => {
    const etimedout = Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" });
    let clock = 0;
    const now = () => clock;
    let calls = 0;
    const spurious = spawnRetryingSpurious(
      () => {
        calls++;
        clock += 15; // 15 ms against an 8000 ms timeout
        return calls < 3 ? { status: null, error: etimedout } : { status: 0 };
      },
      8000,
      now,
      () => {},
    );
    expect(spurious.result.status).toBe(0);
    expect(spurious.attempts).toBe(3);

    clock = 0;
    calls = 0;
    const real = spawnRetryingSpurious(
      () => {
        calls++;
        clock += 8000;
        return { status: null, error: etimedout };
      },
      8000,
      now,
      () => {},
    );
    expect(calls).toBe(1);
    expect(real.result.status).toBeNull();

    calls = 0;
    const always = spawnRetryingSpurious(
      () => {
        calls++;
        return { status: null, error: etimedout };
      },
      8000,
      now,
      () => {},
    );
    expect(calls).toBe(3); // bounded
    expect(always.attempts).toBe(3);
  });
  test("when every retry is spurious the fallback runs once, and a real timeout never reaches it", () => {
    const etimedout = Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" });
    let clock = 0;
    let calls = 0;
    let fell = 0;
    const fallback = () => {
      fell++;
      return { status: 0 as number | null };
    };
    const out = spawnRetryingSpurious(
      () => {
        calls++;
        clock += 15;
        return { status: null as number | null, error: etimedout };
      },
      8000,
      () => clock,
      () => {},
      fallback,
    );
    expect(calls).toBe(3);
    expect(fell).toBe(1);
    expect(out.usedFallback).toBe(true);
    expect(out.result.status).toBe(0);

    clock = 0;
    calls = 0;
    fell = 0;
    const real = spawnRetryingSpurious(
      () => {
        calls++;
        clock += 8000;
        return { status: null as number | null, error: etimedout };
      },
      8000,
      () => clock,
      () => {},
      fallback,
    );
    expect(calls).toBe(1);
    expect(fell).toBe(0);
    expect(real.usedFallback).toBe(false);

    // a command that really ran and failed is an answer, not a spurious failure
    fell = 0;
    const ran = spawnRetryingSpurious(
      () => ({ status: 1 as number | null }),
      8000,
      () => clock,
      () => {},
      fallback,
    );
    expect(fell).toBe(0);
    expect(ran.result.status).toBe(1);
  });
  test("the PowerShell-side guarded query returns the record of this process", () => {
    if (process.platform !== "win32") return;
    const exe = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").ProcessId`;
    const guarded = `$j = Start-Job -ScriptBlock { ${script} }; if (Wait-Job $j -Timeout 8) { Receive-Job $j } else { Stop-Job $j; exit 3 }`;
    const r = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", guarded], {
      encoding: "utf8",
    });
    expect(r.status, String(r.stderr)).toBe(0);
    expect(String(r.stdout).trim()).toBe(String(process.pid));
  });
  test("a pid that does not exist has no info", () => {
    expect(readProcessInfo(2 ** 22 - 3)).toBeUndefined();
  });
});

describe("a stale pid file", () => {
  const home = mkdtempSync(join(tmpdir(), "knowns-pid-identity-"));
  let restore: () => void = () => {};
  beforeAll(() => {
    restore = setProcessHome(home);
    mkdirSync(q.runtimeRoot(), { recursive: true });
  });
  afterAll(() => {
    restore();
    rmSync(home, { recursive: true, force: true });
  });

  test("naming this very process is dropped, and this process is not signalled", () => {
    writeFileSync(q.pidFile(), String(process.pid));
    q.retireUnregisteredDaemon();
    expect(existsSync(q.pidFile())).toBe(false);
    expect(q.isProcessAlive(process.pid)).toBe(true);
  });

  test("naming an unrelated live process leaves it alone and drops the file", async () => {
    const child = spawn(
      process.platform === "win32" ? "ping" : "sleep",
      process.platform === "win32" ? ["-n", "60", "127.0.0.1"] : ["60"],
      { stdio: "ignore" },
    );
    try {
      await new Promise((r) => setTimeout(r, 200));
      const pid = child.pid as number;
      writeFileSync(q.pidFile(), String(pid));
      q.retireUnregisteredDaemon(); // must not throw and must not kill
      expect(existsSync(q.pidFile())).toBe(false);
      expect(q.isProcessAlive(pid)).toBe(true);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      child.kill();
    }
  });
});

describe("isProcessInstance (generic)", () => {
  const at = (commandLine: string, startedAt = 1_000_000) => ({
    info: () => ({ commandLine, startedAt }),
  });
  test("by exact path, by names, by args", () => {
    const q = "/home/u/.knowns/runtime/qdrant/bin/qdrant";
    expect(isProcessInstance(4242, { path: q }, at(q))).toBe(true);
    expect(isProcessInstance(4242, { path: q }, at("/usr/bin/sleep 60"))).toBe(false);
    expect(
      isProcessInstance(
        4242,
        { path: "C:\\Users\\a b\\qdrant.exe" },
        at('"C:\\Users\\a b\\QDRANT.EXE" --x'),
      ),
    ).toBe(true);
    const t = { names: ["cloudflared"], args: ["tunnel"] };
    expect(
      isProcessInstance(4242, t, at("/usr/local/bin/cloudflared tunnel --url http://localhost:1")),
    ).toBe(true);
    expect(isProcessInstance(4242, t, at("/usr/local/bin/cloudflared update"))).toBe(false);
    expect(isProcessInstance(4242, t, at("/bin/vim tunnel"))).toBe(false);
  });
  test("start time, self, pid 1 and an empty expectation", () => {
    const t = { names: ["cloudflared"], startedBefore: 500_000 };
    expect(isProcessInstance(4242, t, at("cloudflared tunnel", 2_000_000))).toBe(false);
    expect(isProcessInstance(4242, t, at("cloudflared tunnel", 400_000))).toBe(true);
    expect(isProcessInstance(process.pid, { names: ["bun"] }, at("bun"))).toBe(false);
    expect(isProcessInstance(1, { names: ["init"] }, at("init"))).toBe(false);
    expect(isProcessInstance(4242, {}, at("anything"))).toBe(false);
  });
  test("a real unrelated process is not an instance of the tunnel or of qdrant", async () => {
    const child = spawn(...unrelatedCommand());
    try {
      await new Promise((r) => setTimeout(r, 300));
      const pid = child.pid as number;
      expect(isProcessInstance(pid, { names: ["cloudflared"], args: ["tunnel"] })).toBe(false);
      expect(isProcessInstance(pid, { path: "/nonexistent/runtime/qdrant/bin/qdrant" })).toBe(
        false,
      );
      expect(
        isProcessInstance(pid, { names: [process.platform === "win32" ? "ping" : "sleep"] }),
      ).toBe(true);
    } finally {
      child.kill();
    }
  });
});

/** A long-running process that has nothing to do with Knowns, on any platform. */
export function unrelatedCommand(): [string, string[], { stdio: "ignore" }] {
  return process.platform === "win32"
    ? ["ping", ["-n", "60", "127.0.0.1"], { stdio: "ignore" }]
    : ["sleep", ["60"], { stdio: "ignore" }];
}
