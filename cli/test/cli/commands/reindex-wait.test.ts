// `search --reindex` waits for the runtime job for as long as it makes progress, and a job still
// running when the wait gives up is reported as running, not failed (@task-KN-Q6DVKQ, D12).
// 0.34.1 waited a fixed 5 minutes and printed "reindex failed" for a job the daemon then finished.
//
// A fake daemon in this process plays the job: it finds the queued reindex, starts it, reports
// progress and completes it, on a short stall window (KNOWNS_RUNTIME_REINDEX_STALL_MS).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReindexRuntimeStopped,
  ReindexStillRunning,
  runReindex,
} from "../../../src/cli/commands/search-index.ts";
import * as q from "../../../src/runtime/queue.ts";
import type { Storage } from "../../../src/storage/adapters.ts";
import { setProcessHome } from "../../helpers/process-env.ts";

const STALL_MS = 400;
const home = mkdtempSync(join(tmpdir(), "knowns-reindex-wait-"));
const savedInline = process.env.KNOWNS_RUNTIME_INLINE;
let restoreHome: () => void = () => {};

beforeAll(() => {
  restoreHome = setProcessHome(home);
  delete process.env.KNOWNS_RUNTIME_INLINE;
  // A pid file naming this process makes ensureDaemon see a running daemon and spawn nothing.
  mkdirSync(q.runtimeRoot(), { recursive: true });
  writeFileSync(q.pidFile(), String(process.pid));
});
afterAll(() => {
  restoreHome();
  if (savedInline === undefined) delete process.env.KNOWNS_RUNTIME_INLINE;
  else process.env.KNOWNS_RUNTIME_INLINE = savedInline;
  rmSync(home, { recursive: true, force: true });
});

let projects = 0;
function project(): { root: string; storage: Storage } {
  const root = join(home, `proj-${++projects}`, ".knowns");
  mkdirSync(root, { recursive: true });
  const storage = {
    store: { root },
    tasks: { listAll: () => [{}, {}, {}] },
    docs: { list: () => [{}] },
    decisions: { list: () => [] },
  } as unknown as Storage;
  return { root, storage };
}

const ms = (n: number) => new Promise((r) => setTimeout(r, n));

/** Waits for the reindex job the CLI queued, then plays `script` against it. */
async function fakeDaemon(root: string, script: (job: q.Job) => Promise<void>): Promise<void> {
  for (;;) {
    const job = q.loadQueue(root).jobs.find((j) => j.kind === "reindex-search");
    if (job) return script(q.markJobStarted(root, job.id));
    await ms(20);
  }
}

async function reindex(storage: Storage) {
  let text = "";
  const out = {
    print: (s: string) => {
      text += s;
    },
  };
  let error: Error | undefined;
  try {
    await runReindex(out, storage, { KNOWNS_RUNTIME_REINDEX_STALL_MS: String(STALL_MS) });
  } catch (err) {
    error = err as Error;
  }
  return { text, error };
}

describe("search --reindex waits on progress (KN-Q6DVKQ)", () => {
  test("a job that keeps progressing past the stall window completes and reports success", async () => {
    const { root, storage } = project();
    // Runs about 4x the stall window, but never goes STALL_MS without moving.
    const daemon = fakeDaemon(root, async (job) => {
      for (let i = 1; i <= 8; i++) {
        await ms(STALL_MS / 2);
        q.reportProgress(root, job.id, i <= 4 ? "tasks" : "docs", i, 8);
      }
      await ms(STALL_MS / 2);
      q.completeJob(root, job, undefined);
    });
    const { text, error } = await reindex(storage);
    await daemon;
    expect(error).toBeUndefined();
    expect(text).not.toContain("reindex failed");
    expect(text).not.toContain("still running");
    expect(text).toContain("Indexed tasks (8)");
    expect(text).toContain("Indexed docs (8)");
    expect(text).toContain("Search index rebuilt via runtime (3 tasks, 1 docs, 0 decisions");
  }, 20_000);

  test("a job that stops moving is reported as still running, exit 1, not as failed", async () => {
    const { root, storage } = project();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const daemon = fakeDaemon(root, async (job) => {
      q.reportProgress(root, job.id, "embedding", 40, 152);
      await held;
      q.completeJob(root, job, undefined);
    });
    const { text, error } = await reindex(storage);
    release();
    await daemon;
    expect(error).toBeInstanceOf(ReindexStillRunning);
    expect(error?.name).toBe("ReindexStillRunning");
    expect((error as ReindexStillRunning).code).toBe(1);
    expect(text).not.toContain("reindex failed");
    expect(text).toContain("Reindex is still running in the runtime");
    expect(text).toContain("embedding 40/152");
    expect(text).toContain("knowns runtime ps");
    expect(text).not.toContain("Search index rebuilt");
  }, 20_000);

  test("a job that is still queued when the wait gives up says so", async () => {
    const { root, storage } = project();
    // Nothing ever starts the job.
    const { text, error } = await reindex(storage);
    expect(error).toBeInstanceOf(ReindexStillRunning);
    expect(text).toContain("still running in the runtime");
    expect(text).toContain(", queued)");
  }, 20_000);

  test("a job that fails still reports reindex failed", async () => {
    const { root, storage } = project();
    const daemon = fakeDaemon(root, async (job) => {
      await ms(50);
      q.completeJob(root, job, new Error("embedder unavailable"));
    });
    const { text, error } = await reindex(storage);
    await daemon;
    expect(error).not.toBeInstanceOf(ReindexStillRunning);
    expect(error?.message).toBe("reindex failed: embedder unavailable");
    expect(text).not.toContain("still running");
  }, 20_000);
});

describe("search --reindex when the runtime daemon is gone (KN-Q6DVKQ review)", () => {
  // A pid that no longer runs: a child that has already exited.
  const deadPid = Bun.spawnSync(["true"]).pid;
  const alive = () => writeFileSync(q.pidFile(), String(process.pid));
  const crash = () => writeFileSync(q.pidFile(), String(deadPid));

  test("a queued job whose daemon died is not reported as still running", async () => {
    expect(q.isProcessAlive(deadPid)).toBe(false);
    const { root, storage } = project();
    // The daemon is alive when the CLI queues the job (so nothing is spawned), then dies.
    const daemon = (async () => {
      while (!q.loadQueue(root).jobs.some((j) => j.kind === "reindex-search")) await ms(20);
      crash();
    })();
    try {
      const { text, error } = await reindex(storage);
      await daemon;
      expect(error).toBeInstanceOf(ReindexRuntimeStopped);
      expect((error as ReindexRuntimeStopped).code).toBe(1);
      expect(text).not.toContain("still running");
      expect(text).not.toContain("reindex failed");
      expect(text).toContain("The runtime stopped before the reindex finished");
      expect(text).toContain(", queued)");
      expect(text).toContain("knowns search --reindex");
    } finally {
      alive();
    }
  }, 20_000);

  test("a started job whose daemon crashed mid-run says the runtime stopped, with its phase", async () => {
    const { root, storage } = project();
    const daemon = fakeDaemon(root, async (job) => {
      q.reportProgress(root, job.id, "embedding", 12, 152);
      crash();
    });
    try {
      const { text, error } = await reindex(storage);
      await daemon;
      expect(error).toBeInstanceOf(ReindexRuntimeStopped);
      expect(text).toContain("The runtime stopped before the reindex finished");
      expect(text).toContain("embedding 12/152");
      expect(text).not.toContain("still running");
    } finally {
      alive();
    }
  }, 20_000);

  test("a new reindex request reuses the job a stopped runtime left queued", () => {
    const { root } = project();
    const first = q.enqueueReindex(root);
    expect(q.enqueueReindex(root).id).toBe(first.id);
  });
});

describe("waitForJobProgress", () => {
  test("a job in neither the queue nor recent results times out as waitForJob does", async () => {
    const { root } = project();
    q.updateQueue(root, () => {});
    await expect(q.waitForJobProgress(root, "missing", 100)).rejects.toThrow(
      "timed out waiting for runtime job missing",
    );
  });

  test("a queued job counts as moving while the jobs ahead of it finish", async () => {
    const { root } = project();
    const ahead = q.enqueueJob(root, "index-doc", "a");
    const target = q.enqueueReindex(root);
    const others = [ahead, ...[1, 2, 3, 4].map((i) => q.enqueueJob(root, "index-doc", `d${i}`))];
    const daemon = (async () => {
      for (const j of others) {
        await ms(150);
        q.completeJob(root, q.markJobStarted(root, j.id), undefined);
      }
      await ms(150);
      q.completeJob(root, q.markJobStarted(root, target.id), undefined);
    })();
    const outcome = await q.waitForJobProgress(root, target.id, 300);
    await daemon;
    expect(outcome.status).toBe("completed");
  }, 20_000);
});
