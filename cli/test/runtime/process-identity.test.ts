// A pid file is not proof of a daemon: after a crash or reboot its pid may belong to any process.
// Nothing may be signalled unless the process is provably a Knowns runtime daemon.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandWords,
  isKnownsRuntimeDaemon,
  isRuntimeDaemonCommand,
  readProcessInfo,
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
    expect(info).toBeDefined();
    expect(info?.commandLine.length).toBeGreaterThan(0);
    expect(Math.abs((info?.startedAt ?? 0) - Date.now())).toBeLessThan(24 * 3600 * 1000);
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
