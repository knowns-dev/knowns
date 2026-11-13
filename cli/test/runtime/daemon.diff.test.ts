// AC5: with the daemon enabled, task/doc/memory writes queue the same jobs, start a daemon, the
// daemon runs them and leaves the same queue (recent results), registry and files as Go's.
// Each side spawns its own real daemon in a sandboxed HOME.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pair } from "../cli/commands/harness.ts";
import { hasGoBin, makePair, mask, runSide, runtimeSnapshot, waitFor } from "./helpers.ts";

const suite = hasGoBin ? describe : describe.skip;

const DAEMON_ENV = {
  KNOWNS_RUNTIME_IDLE_TIMEOUT_MS: "1500",
  KNOWNS_ENTITY_INDEX_DEBOUNCE_MS: "0",
};

function pidOf(pair: Pair, side: "go" | "ts"): number | undefined {
  const f = join(pair[side].home, ".knowns", "runtime", "knowns-runtime.pid");
  if (!existsSync(f)) return undefined;
  const n = Number.parseInt(readFileSync(f, "utf8"), 10);
  return Number.isFinite(n) ? n : undefined;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

suite("daemon spawn and job execution equal Go", () => {
  test("writes start the daemon, which runs the queued jobs and idles out", async () => {
    const pair = makePair("full");
    const pids: Record<string, number> = {};
    for (const side of ["go", "ts"] as const) {
      for (const args of [
        ["task", "create", "Daemon task", "-d", "x"],
        ["doc", "create", "Daemon doc", "-d", "d", "-c", "body"],
        ["memory", "create", "Daemon memory", "--content", "remember this"],
      ]) {
        const r = await runSide(pair, side, args, DAEMON_ENV);
        expect(r.code, `${side} ${args.join(" ")}: ${r.stderr}${r.stdout}`).toBe(0);
      }
      // The first write started a daemon.
      const started = await waitFor(() => pidOf(pair, side) !== undefined, 10_000);
      expect(started, `${side} daemon pid file`).toBe(true);
      pids[side] = pidOf(pair, side) as number;
    }
    try {
      for (const side of ["go", "ts"] as const) {
        // Jobs drain, then the daemon idles out and removes its pid file.
        const gone = await waitFor(
          () => pidOf(pair, side) === undefined && !alive(pids[side] as number),
          30_000,
        );
        expect(gone, `${side} daemon exit`).toBe(true);
      }
    } finally {
      for (const pid of Object.values(pids)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    const go = runtimeSnapshot(pair, "go");
    const ts = runtimeSnapshot(pair, "ts");
    expect(Object.keys(ts)).toEqual(Object.keys(go));
    expect(ts).toEqual(go);
    const queue = Object.entries(go).find(([k]) => k.includes("queues/"));
    expect(queue).toBeDefined();
    const state = JSON.parse((queue as [string, string])[1]);
    expect(state.jobs).toHaveLength(0);
    expect(state.recent.length).toBeGreaterThanOrEqual(3);
    expect(mask(pair, "ts", "")).toBe("");
  }, 90_000);
});
