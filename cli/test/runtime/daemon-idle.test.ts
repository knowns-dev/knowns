// KN-M5GY1J: an idle runtime daemon costs almost nothing, backs off and wakes on work, serves
// projects round-robin, never forgets a project root merely because it is unreachable, and runs
// below normal priority.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_PRIORITY, lowerProcessPriority } from "../../src/runtime/priority.ts";
import * as q from "../../src/runtime/queue.ts";

const home = mkdtempSync(join(tmpdir(), "knowns-idle-"));
const rt = join(home, "runtime");
const saved = {
  root: process.env.KNOWNS_RUNTIME_ROOT,
  idle: process.env.KNOWNS_RUNTIME_IDLE_TIMEOUT_MS,
};

beforeAll(() => {
  process.env.KNOWNS_RUNTIME_ROOT = rt;
  mkdirSync(rt, { recursive: true });
});
afterAll(() => {
  if (saved.root === undefined) delete process.env.KNOWNS_RUNTIME_ROOT;
  else process.env.KNOWNS_RUNTIME_ROOT = saved.root;
  if (saved.idle === undefined) delete process.env.KNOWNS_RUNTIME_IDLE_TIMEOUT_MS;
  else process.env.KNOWNS_RUNTIME_IDLE_TIMEOUT_MS = saved.idle;
  rmSync(home, { recursive: true, force: true });
});

const project = (name: string): string => {
  const p = join(home, name, ".knowns");
  mkdirSync(p, { recursive: true });
  return p;
};
const due = (id: string, requestedAt: number) => ({
  id,
  key: `index-task::${id}`,
  kind: "index-task" as const,
  requestedAt: q.nowString(requestedAt),
  runAfter: q.nowString(requestedAt),
});

describe("queue scan cache", () => {
  test("an unchanged queue file is not parsed again, a changed one is", () => {
    const p = project("cache");
    q.updateQueue(p, (s) => {
      s.jobs.push(due("a", Date.now()));
    });
    const first = q.loadQueueCached(p);
    expect(q.loadQueueCached(p)).toBe(first);
    q.updateQueue(p, (s) => {
      s.jobs.push(due("b", Date.now()));
    });
    const next = q.loadQueueCached(p);
    expect(next).not.toBe(first);
    expect(next.jobs.map((j) => j.id)).toEqual(["a", "b"]);
  });

  test("a project without a queue file scans as empty", () => {
    expect(q.loadQueueCached(project("none")).jobs).toEqual([]);
  });
});

describe("scanQueues", () => {
  test("round-robin: the project served last waits while another has due work", () => {
    const a = project("rr-a");
    const b = project("rr-b");
    const now = Date.now();
    q.updateQueue(a, (s) => {
      s.jobs.push(due("a1", now - 5000));
    });
    q.updateQueue(b, (s) => {
      s.jobs.push(due("b1", now - 1000));
    });
    expect(q.scanQueues([a, b], undefined, now).next?.storeRoot).toBe(a);
    expect(q.scanQueues([a, b], a, now).next?.storeRoot).toBe(b);
    // Nothing else is due: the avoided project still runs.
    expect(q.scanQueues([a], a, now).next?.storeRoot).toBe(a);
  });

  test("counts pending jobs, ignores dead letters and reports the next wake time", () => {
    const p = project("wake");
    const now = Date.now();
    q.updateQueue(p, (s) => {
      s.jobs.push({ ...due("dead", now), deadLetter: true });
      s.jobs.push({ ...due("later", now), runAfter: q.nowString(now + 4000) });
    });
    const scan = q.scanQueues([p], undefined, now);
    expect(scan.next).toBeUndefined();
    expect(scan.pending).toBe(1);
    expect(scan.wakeAt).toBeGreaterThanOrEqual(now + 3000);
    expect(scan.wakeAt).toBeLessThanOrEqual(now + 4000);
  });

  test("the fingerprint changes when a project's jobs change and not otherwise", () => {
    const p = project("fp");
    q.updateQueue(p, (s) => {
      s.jobs.push(due("x", Date.now()));
    });
    const before = q.scanQueues([p]).fingerprint;
    expect(q.scanQueues([p]).fingerprint).toBe(before);
    q.updateQueue(p, (s) => {
      s.jobs.push(due("y", Date.now()));
    });
    expect(q.scanQueues([p]).fingerprint).not.toBe(before);
  });
});

describe("job pacing", () => {
  test("the gap after a job is as long as the job, between 100 ms and 2 s", () => {
    const prev = process.env.KNOWNS_RUNTIME_JOB_GAP_MS;
    delete process.env.KNOWNS_RUNTIME_JOB_GAP_MS;
    try {
      expect(q.jobGapMs(5)).toBe(100);
      expect(q.jobGapMs(700)).toBe(700);
      expect(q.jobGapMs(60_000)).toBe(2000);
      process.env.KNOWNS_RUNTIME_JOB_GAP_MS = "0";
      expect(q.jobGapMs(700)).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.KNOWNS_RUNTIME_JOB_GAP_MS;
      else process.env.KNOWNS_RUNTIME_JOB_GAP_MS = prev;
    }
  });
});

describe("project pruning", () => {
  const registry = () => JSON.parse(readFileSync(join(rt, "projects.json"), "utf8")) as string[];
  const missingFile = () => join(rt, "projects-missing.json");

  test("a missing root is kept during the grace period and dropped after it", () => {
    const gone = join(home, "unmounted", ".knowns");
    const alive = project("prune-alive");
    writeFileSync(join(rt, "projects.json"), JSON.stringify([alive, gone].sort()));
    const now = Date.now();

    q.pruneRuntimeFiles(now);
    expect(registry()).toContain(gone);
    const since = JSON.parse(readFileSync(missingFile(), "utf8")) as Record<string, number>;
    expect(since[gone]).toBe(now);

    // 29 days later: still kept. 31 days later: gone, with its queue file.
    q.pruneRuntimeFiles(now + 29 * 24 * 3_600_000);
    expect(registry()).toContain(gone);
    q.pruneRuntimeFiles(now + 31 * 24 * 3_600_000);
    expect(registry()).toEqual([alive]);
    expect(existsSync(q.queuePath(gone))).toBe(false);
  });

  test("a root that comes back is forgotten as missing; one holding jobs is never dropped", () => {
    const back = project("prune-back");
    const busy = join(home, "unmounted-busy", ".knowns");
    q.updateQueue(busy, (s) => {
      s.jobs.push(due("keep", Date.now()));
    });
    writeFileSync(join(rt, "projects.json"), JSON.stringify([back, busy].sort()));
    writeFileSync(
      missingFile(),
      JSON.stringify({
        [back]: Date.now() - 40 * 24 * 3_600_000,
        [busy]: Date.now() - 40 * 24 * 3_600_000,
      }),
    );
    q.pruneRuntimeFiles(Date.now());
    expect(registry()).toEqual([back, busy].sort());
    const since = JSON.parse(readFileSync(missingFile(), "utf8")) as Record<string, number>;
    expect(back in since).toBe(false);
  });

  test("orphan queue files: an old empty one is removed, a young one and one with jobs stay", () => {
    writeFileSync(join(rt, "projects.json"), "[]");
    const dir = join(rt, "queues");
    mkdirSync(dir, { recursive: true });
    const old = (Date.now() - 8 * 24 * 3_600_000) / 1000;
    const oldEmpty = join(dir, "orphan-old-empty.json");
    const oldJobs = join(dir, "orphan-old-jobs.json");
    const young = join(dir, "orphan-young.json");
    writeFileSync(oldEmpty, '{"jobs":[]}');
    writeFileSync(oldJobs, '{"jobs":[{"id":"x"}]}');
    writeFileSync(young, '{"jobs":[]}');
    utimesSync(oldEmpty, old, old);
    utimesSync(oldJobs, old, old);
    q.pruneRuntimeFiles(Date.now());
    expect(existsSync(oldEmpty)).toBe(false);
    expect(existsSync(oldJobs)).toBe(true);
    expect(existsSync(young)).toBe(true);
  });
});

describe("daemon priority", () => {
  test("asks for nice +10 (BELOW_NORMAL on Windows) and never throws", () => {
    const calls: [number, number][] = [];
    expect(lowerProcessPriority({}, (pid, pr) => void calls.push([pid, pr]))).toBe(true);
    expect(calls).toEqual([[0, BACKGROUND_PRIORITY]]);
    expect(
      lowerProcessPriority({}, () => {
        throw new Error("EACCES");
      }),
    ).toBe(false);
    expect(
      lowerProcessPriority({ KNOWNS_RUNTIME_NORMAL_PRIORITY: "1" }, () => calls.push([1, 1])),
    ).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("idle daemon", () => {
  test("backs off while idle, then runs a new job promptly and rewrites status rarely", async () => {
    const p = project("daemon");
    process.env.KNOWNS_RUNTIME_IDLE_TIMEOUT_MS = "600000";
    writeFileSync(join(rt, "projects.json"), JSON.stringify([p]));
    const ran: string[] = [];
    const ac = new AbortController();
    const daemon = q.runDaemon(ac.signal, {
      keepAlive: () => true,
      executor: async (_root, job) => {
        ran.push(job.id);
      },
    });
    try {
      // Let the tick back off (500 ms, 1 s, 2 s, ...).
      await Bun.sleep(4500);
      const status = join(rt, "status.json");
      const mtime = statSync(status).mtimeMs;
      await Bun.sleep(1500);
      expect(statSync(status).mtimeMs).toBe(mtime);

      const t0 = Date.now();
      q.updateQueue(p, (s) => {
        s.jobs.push(due("wake-me", Date.now()));
      });
      const deadline = t0 + 2500;
      while (!ran.includes("wake-me") && Date.now() < deadline) await Bun.sleep(25);
      expect(ran).toContain("wake-me");
    } finally {
      ac.abort();
      await daemon;
    }
  }, 30_000);
});
