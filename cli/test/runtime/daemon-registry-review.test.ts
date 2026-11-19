// KN-69EHXE: review fixes for the version-scoped daemon registry (P2-1, P2-2, P3-1, P3-2).
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimRunner,
  currentRunner,
  DaemonAlreadyRunning,
  findDaemon,
  predatesBoot,
  registerDaemon,
  releaseRunner,
  unregisterDaemon,
} from "../../src/runtime/daemon-registry.ts";
import * as q from "../../src/runtime/queue.ts";
import { VERSION } from "../../src/version.ts";
import { spawnLivePid } from "../helpers/live-pid.ts";

let root: string;
let saved: string | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kn-regrev-")));
  saved = process.env.KNOWNS_RUNTIME_ROOT;
  process.env.KNOWNS_RUNTIME_ROOT = root;
});
afterEach(() => {
  if (saved === undefined) delete process.env.KNOWNS_RUNTIME_ROOT;
  else process.env.KNOWNS_RUNTIME_ROOT = saved;
});
const ME = process.pid;
const other = spawnLivePid();
const OTHER = other.pid;
afterAll(() => other.kill());

describe("P2-1: registry files that survive a reboot", () => {
  test("predatesBoot compares the registered time with the boot time", () => {
    const clock = { now: Date.parse("2026-11-17T12:00:00Z"), uptimeSec: 3600 }; // booted 11:00
    expect(predatesBoot("2026-11-17T10:00:00Z", clock)).toBe(true);
    expect(predatesBoot("2026-11-17T11:30:00Z", clock)).toBe(false);
    expect(predatesBoot("garbage", clock)).toBe(false);
  });

  test("a daemon entry written before the boot is not a live daemon, even if its pid is alive", () => {
    mkdirSync(join(root, "daemons"), { recursive: true });
    const old = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();
    writeFileSync(
      join(root, "daemons", "9.9.9.json"),
      JSON.stringify({ pid: OTHER, version: "9.9.9", startedAt: old }),
    );
    expect(findDaemon("9.9.9")).toBeUndefined();
    expect(existsSync(join(root, "daemons", "9.9.9.json"))).toBe(false);
  });

  test("a runner claim whose pid is alive but not a registered daemon of that version is ignored", () => {
    writeFileSync(
      join(root, "runner.json"),
      JSON.stringify({ pid: OTHER, version: "9.9.9", claimedAt: new Date().toISOString() }),
    );
    expect(currentRunner()).toBeUndefined();
    // So a real daemon of an older version can take the role instead of standing by forever.
    registerDaemon("0.1.0", ME);
    expect(claimRunner("0.1.0", ME)).toBe(true);
    expect(currentRunner()?.pid).toBe(ME);
    releaseRunner(ME);
    unregisterDaemon("0.1.0", ME);
  });
});

describe("P3-2: one daemon per version", () => {
  test("registering over a different live pid is refused", () => {
    registerDaemon("1.2.3", OTHER);
    expect(() => registerDaemon("1.2.3", ME)).toThrow(DaemonAlreadyRunning);
    expect(findDaemon("1.2.3")?.pid).toBe(OTHER);
    registerDaemon("1.2.3", OTHER); // the holder may refresh its own entry
    unregisterDaemon("1.2.3", OTHER);
  });
});

describe("P3-1: stale runner lock is stolen by one contender", () => {
  test("a lock of a dead holder is replaced and no stale copies are left behind", () => {
    writeFileSync(
      join(root, "runner.lock"),
      JSON.stringify({ pid: 2_000_000_000, at: Date.now() - 60_000 }),
    );
    registerDaemon("1.0.0", ME);
    expect(claimRunner("1.0.0", ME)).toBe(true);
    expect(readdirSync(root).filter((n) => n.includes(".stale."))).toEqual([]);
    expect(existsSync(join(root, "runner.lock"))).toBe(false); // released after the claim
    releaseRunner(ME);
    unregisterDaemon("1.0.0", ME);
  });

  test("a live lock caught by mistake is put back", () => {
    registerDaemon("1.0.0", ME);
    registerDaemon("1.0.1", OTHER);
    // A lock held by a live registered daemon is not stale: claimRunner must wait and give up
    // (lock timeout) while leaving the lock in place.
    const lock = join(root, "runner.lock");
    writeFileSync(lock, JSON.stringify({ pid: OTHER, at: Date.now() }));
    expect(claimRunner("1.0.0", ME)).toBe(false);
    expect(existsSync(lock)).toBe(true);
    unregisterDaemon("1.0.0", ME);
    unregisterDaemon("1.0.1", OTHER);
  }, 15_000);
});

describe("P2-2: an exiting daemon stops advertising before it drains", () => {
  test("retire runs before the registry entry goes and before services are awaited; a late session keeps it alive", async () => {
    const proj = join(root, "proj", ".knowns");
    mkdirSync(proj, { recursive: true });
    process.env.KNOWNS_RUNTIME_IDLE_TIMEOUT_MS = "1000";
    const order: string[] = [];
    let sessions = 0;
    let first = true;
    const ac = new AbortController();
    const d = q.runDaemon(ac.signal, {
      executor: async () => {},
      keepAlive: () => false,
      retire: () => {
        order.push(`retire(entry=${findDaemon(VERSION) ? "present" : "gone"})`);
      },
      reopen: () => {
        order.push("reopen");
      },
      busy: () => {
        // A session shows up only in the window after the first retire.
        if (first && order.length > 0) {
          first = false;
          sessions = 1;
        }
        return sessions > 0;
      },
    });
    const deadline = Date.now() + 15_000;
    while (!order.includes("reopen") && Date.now() < deadline) await Bun.sleep(50);
    expect(order[0]).toBe("retire(entry=present)"); // advertising stops while still registered
    expect(order).toContain("reopen");
    expect(findDaemon(VERSION)?.pid).toBe(ME); // re-registered, the daemon continues
    sessions = 0;
    await Bun.sleep(100);
    ac.abort();
    await d;
    expect(findDaemon(VERSION)).toBeUndefined();
    delete process.env.KNOWNS_RUNTIME_IDLE_TIMEOUT_MS;
  }, 40_000);
});
