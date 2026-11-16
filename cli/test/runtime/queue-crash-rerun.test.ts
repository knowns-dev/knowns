// KN-ZSGXK9: a fast job's start mark is written together with its completion. If the daemon dies
// mid-job the job is still queued (unmarked) and runs again after the restart. Every job kind is
// idempotent (see the task notes), so the re-run has the same outcome as an uninterrupted run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as q from "../../src/runtime/queue.ts";

const home = mkdtempSync(join(tmpdir(), "knowns-crash-"));
const rt = join(home, "runtime");
const saved = {
  root: process.env.KNOWNS_RUNTIME_ROOT,
  idle: process.env.KNOWNS_RUNTIME_IDLE_TIMEOUT_MS,
};
beforeAll(() => {
  process.env.KNOWNS_RUNTIME_ROOT = rt;
  process.env.KNOWNS_RUNTIME_IDLE_TIMEOUT_MS = "600000";
  mkdirSync(rt, { recursive: true });
});
afterAll(() => {
  for (const [k, v] of [
    ["KNOWNS_RUNTIME_ROOT", saved.root],
    ["KNOWNS_RUNTIME_IDLE_TIMEOUT_MS", saved.idle],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const job = (id: string) => ({
  id,
  key: `index-task::${id}`,
  kind: "index-task" as const,
  target: id,
  requestedAt: q.nowString(),
  runAfter: q.nowString(),
});

async function until(cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(20);
}

describe("job re-run after a crash", () => {
  test("a fast job interrupted before its completion runs again with the same outcome", async () => {
    const p = join(home, "proj", ".knowns");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(rt, "projects.json"), JSON.stringify([p]));
    // The "index": an idempotent apply of the current state, as every executor kind is.
    const apply = (index: Map<string, string>, target: string) =>
      index.set(target, `state:${target}`);

    // Reference: an uninterrupted run.
    const clean = new Map<string, string>();
    apply(clean, "T-1");

    // Run 1 starts the job and is killed (aborted) while it is still in flight.
    const crashed = new Map<string, string>();
    q.updateQueue(p, (s) => {
      s.jobs.push(job("T-1"));
    });
    let started = false;
    const ac1 = new AbortController();
    const d1 = q.runDaemon(ac1.signal, {
      keepAlive: () => true,
      executor: async (_r, j) => {
        apply(crashed, j.target ?? "");
        started = true;
        await new Promise(() => {}); // never settles: the process "dies" here
      },
    });
    await until(() => started, 5000);
    expect(started).toBe(true);
    ac1.abort();
    await d1;
    // Nothing recorded the start (the mark is deferred) and nothing completed: still queued.
    const mid = q.loadQueue(p);
    expect(mid.jobs.map((j) => j.id)).toEqual(["T-1"]);
    expect(mid.jobs[0]?.startedAt ?? null).toBeNull();
    expect(mid.recent ?? []).toHaveLength(0);

    // Run 2 (the restart) picks it up again and completes it.
    const ac2 = new AbortController();
    const d2 = q.runDaemon(ac2.signal, {
      keepAlive: () => true,
      executor: async (_r, j) => {
        apply(crashed, j.target ?? "");
      },
    });
    await until(() => q.loadQueue(p).jobs.length === 0, 8000);
    ac2.abort();
    await d2;

    const done = q.loadQueue(p);
    expect(done.jobs).toHaveLength(0);
    expect(done.recent).toHaveLength(1);
    expect(done.recent?.[0]?.success).toBe(true);
    expect(done.recent?.[0]?.attemptCount).toBe(1);
    expect([...crashed]).toEqual([...clean]);
  }, 30_000);

  test("a job longer than the delay has its start mark on disk while it runs", async () => {
    const p = join(home, "proj2", ".knowns");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(rt, "projects.json"), JSON.stringify([p]));
    q.updateQueue(p, (s) => {
      s.jobs.push(job("T-9"));
    });
    let release: () => void = () => {};
    let running = false;
    const ac = new AbortController();
    const d = q.runDaemon(ac.signal, {
      keepAlive: () => true,
      executor: async () => {
        running = true;
        await new Promise<void>((r) => {
          release = r;
        });
      },
    });
    await until(() => running, 5000);
    await until(() => q.loadQueue(p).jobs[0]?.startedAt != null, 3000);
    const j = q.loadQueue(p).jobs[0];
    expect(j?.startedAt).toBeTruthy();
    expect(j?.attempts).toBe(1);
    release();
    await until(() => q.loadQueue(p).jobs.length === 0, 8000);
    expect(q.loadQueue(p).recent?.[0]?.attemptCount).toBe(1);
    ac.abort();
    await d;
  }, 30_000);
});

describe("write-through queue cache", () => {
  test("our own write is a cache hit; another process's write is still seen by updateQueue", () => {
    const p = join(home, "proj3", ".knowns");
    mkdirSync(p, { recursive: true });
    q.updateQueue(p, (s) => {
      s.jobs.push(job("A"));
    });
    const first = q.loadQueueCached(p);
    expect(q.loadQueueCached(p)).toBe(first); // no re-parse after our own write
    // Another process rewrites the file (different size and mtime): the next update must start
    // from it, not from the cached copy.
    const path = q.queuePath(p);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.jobs.push({ ...raw.jobs[0], id: "B", key: "index-task::B" });
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
    q.updateQueue(p, (s) => {
      s.jobs.push(job("C"));
    });
    expect(q.loadQueue(p).jobs.map((j) => j.id)).toEqual(["A", "B", "C"]);
    // A mutation that throws leaves the cache and file consistent.
    expect(() =>
      q.updateQueue(p, (s) => {
        s.jobs.length = 0;
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(q.loadQueue(p).jobs).toHaveLength(3);
    expect(q.loadQueueCached(p).jobs).toHaveLength(3);
  });
});
