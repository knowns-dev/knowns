// The `reconcile-knowledge` runtime job. TS no longer has a command that queues it (D7 removed
// `reconcile --execute`), but a Go 0.34.1 client sharing the daemon still can, so the TS daemon
// must run it the way Go does. Go side: `reconcile --execute --wait`, which spawns a real Go daemon
// in the sandbox HOME (KNOWNS_RUNTIME_INLINE only queues, it never runs the job). TS side: the same
// job through executeRuntimeJob. The `.knowns` trees must match.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { executeRuntimeJob } from "../../src/runtime/executor.ts";
import type { Job } from "../../src/runtime/queue.ts";
import { GO_BIN } from "../cli/oracle.ts";
import { disposePair, hasGoBin, makePair, type Pair, tree, treeDiff } from "./harness.ts";

const cases = hasGoBin ? describe : describe.skip;
const pairs: Pair[] = [];
afterEach(() => {
  for (const p of pairs.splice(0)) disposePair(p);
});

const editArchitecture = (dir: string) =>
  appendFileSync(join(dir, ".knowns", "docs", "architecture.md"), "\nEdited outside Knowns.\n");

cases("reconcile-knowledge runtime job", () => {
  test("an outside edit reconciles to the same .knowns tree as Go", async () => {
    const pair = makePair("full", editArchitecture);
    pairs.push(pair);
    const go = Bun.spawnSync([GO_BIN as string, "reconcile", "--execute", "--wait"], {
      cwd: pair.go.dir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: pair.go.home,
        USERPROFILE: pair.go.home,
        NO_UPDATE_CHECK: "1",
        CI: "1",
        KNOWNS_SEMANTIC_RUNTIME_DISABLED: "1",
        KNOWNS_RUNTIME_IDLE_TIMEOUT_MS: "1500",
      },
    });
    const pidFile = join(pair.go.home, ".knowns", "runtime", "knowns-runtime.pid");
    if (existsSync(pidFile)) {
      try {
        process.kill(Number.parseInt(readFileSync(pidFile, "utf8"), 10), "SIGKILL");
      } catch {
        // already idled out
      }
    }
    expect(go.exitCode, go.stderr.toString() + go.stdout.toString()).toBe(0);
    expect(go.stdout.toString()).toContain("completed job=");

    const job: Job = {
      id: "job-test",
      key: "reconcile-knowledge:",
      kind: "reconcile-knowledge",
      target: "",
      requestedAt: new Date().toISOString(),
      runAfter: new Date().toISOString(),
    };
    // Inside the daemon its own pid file says the runtime is up, so the handoff never spawns one;
    // in this process KNOWNS_RUNTIME_INLINE stands in for that.
    const keys = [
      "HOME",
      "USERPROFILE",
      "KNOWNS_RUNTIME_INLINE",
      "KNOWNS_SEMANTIC_RUNTIME_DISABLED",
    ];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.HOME = pair.ts.home;
    process.env.USERPROFILE = pair.ts.home;
    process.env.KNOWNS_RUNTIME_INLINE = "1";
    process.env.KNOWNS_SEMANTIC_RUNTIME_DISABLED = "1";
    try {
      await executeRuntimeJob(join(pair.ts.dir, ".knowns"), job);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
    expect(treeDiff(tree(pair.go), tree(pair.ts))).toEqual([]);
  }, 60_000);
});
