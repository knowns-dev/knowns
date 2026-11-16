// The daemon job source of the Activity Tray: listing, change events, cancel and retry.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelRequested,
  clearJobCancel,
  JobCancelledError,
} from "../../src/runtime/job-cancel.ts";
import * as ops from "../../src/runtime/job-operations.ts";
import type { Operation } from "../../src/runtime/operation-types.ts";
import * as q from "../../src/runtime/queue.ts";
import { setProcessHome } from "../helpers/process-env.ts";

const home = mkdtempSync(join(tmpdir(), "knowns-jobops-"));
const root = join(home, "proj", ".knowns");
let restoreHome: () => void = () => {};
let prevInline: string | undefined;

beforeAll(() => {
  restoreHome = setProcessHome(home);
  prevInline = process.env.KNOWNS_RUNTIME_INLINE;
  process.env.KNOWNS_RUNTIME_INLINE = "1";
  mkdirSync(root, { recursive: true });
});
afterAll(() => {
  restoreHome();
  if (prevInline === undefined) delete process.env.KNOWNS_RUNTIME_INLINE;
  else process.env.KNOWNS_RUNTIME_INLINE = prevInline;
  rmSync(home, { recursive: true, force: true });
});

const clearQueue = () =>
  q.updateQueue(root, (s) => {
    s.jobs = [];
    s.recent = [];
  });

describe("job operations", () => {
  test("lists a queued job with a readable title, the project name and cancellable true", () => {
    clearQueue();
    const job = q.enqueueReindex(root);
    const list = ops.listJobOperations([root]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: `job:${job.id}`,
      source: "daemon",
      kind: "reindex-search",
      title: "Rebuilding the search index",
      project: "proj",
      state: "queued",
      cancellable: true,
      progress: null,
    });
  });

  test("events: started with progress, then finished, with no timers", () => {
    clearQueue();
    const job = q.enqueueReindex(root);
    const got: Operation[] = [];
    const off = ops.onJobOperation((o) => got.push(o));
    ops.observeJobs([root]); // baseline
    q.markJobStarted(root, job.id);
    q.reportProgress(root, job.id, "docs", 3, 10);
    ops.observeJobs([root]);
    expect(got.at(-1)).toMatchObject({
      state: "running",
      progress: { done: 3, total: 10 },
      cancellable: true,
    });
    ops.observeJobs([root]); // nothing changed: nothing emitted
    const n = got.length;
    ops.observeJobs([root]);
    expect(got).toHaveLength(n);
    q.completeJob(root, { ...job, startedAt: "x" } as q.Job, undefined);
    ops.observeJobs([root]);
    expect(got.at(-1)).toMatchObject({ state: "done", cancellable: false });
    expect(got.at(-1)?.finishedAt).not.toBeNull();
    off();
  });

  test("a failure carries its error; a non-reindex failure is not retryable", () => {
    clearQueue();
    const job = q.enqueueJob(root, "index-doc", "a.md");
    const got: Operation[] = [];
    const off = ops.onJobOperation((o) => got.push(o));
    ops.observeJobs([root]);
    q.completeJob(root, job, new Error("boom"));
    ops.observeJobs([root]);
    expect(got.at(-1)).toMatchObject({ state: "failed", error: "boom", retryable: false });
    off();
  });

  test("cancel removes a queued job, is idempotent, and a late cancel is gone", async () => {
    clearQueue();
    const job = q.enqueueJob(root, "index-doc", "b.md");
    const got: Operation[] = [];
    const off = ops.onJobOperation((o) => got.push(o));
    ops.observeJobs([root]);
    expect(await ops.cancelJobOperation(root, job.id)).toBe("cancelled");
    expect(q.loadQueue(root).jobs).toHaveLength(0);
    expect(got.at(-1)).toMatchObject({ state: "cancelled", cancellable: false });
    expect(await ops.cancelJobOperation(root, job.id)).toBe("gone");
    off();
  });

  test("a running reindex is asked to stop; other running kinds are not cancellable", async () => {
    clearQueue();
    const re = q.enqueueReindex(root);
    const doc = q.enqueueJob(root, "index-doc", "c.md");
    q.markJobStarted(root, re.id);
    q.markJobStarted(root, doc.id);
    const byId = new Map(ops.listJobOperations([root]).map((o) => [o.id, o]));
    expect(byId.get(`job:${re.id}`)?.cancellable).toBe(true);
    expect(byId.get(`job:${doc.id}`)?.cancellable).toBe(false);
    expect(await ops.cancelJobOperation(root, doc.id)).toBe("not_cancellable");
    expect(cancelRequested(doc.id)).toBe(false);
    expect(await ops.cancelJobOperation(root, re.id)).toBe("cancelling");
    expect(cancelRequested(re.id)).toBe(true);
    expect(ops.listJobOperations([root]).find((o) => o.id === `job:${re.id}`)?.state).toBe(
      "cancelling",
    );
    clearJobCancel(re.id);
    expect(existsSync(join(home, ".knowns"))).toBeTrue();
  });

  test("a job that stopped on request is recorded as cancelled and can be retried", async () => {
    clearQueue();
    const job = q.enqueueReindex(root);
    q.markJobStarted(root, job.id);
    const got: Operation[] = [];
    const off = ops.onJobOperation((o) => got.push(o));
    ops.observeJobs([root]);
    q.completeJob(root, { ...job, startedAt: "x" } as q.Job, new JobCancelledError());
    ops.observeJobs([root]);
    expect(got.at(-1)).toMatchObject({ state: "cancelled", retryable: true, error: null });
    expect(await ops.retryJobOperation(root, job.id)).toBe(true);
    expect(q.loadQueue(root).jobs.some((j) => j.kind === "reindex-search")).toBe(true);
    off();
  });

  test("the pick-up race: a job the runner already holds ends as done, not cancelled", async () => {
    clearQueue();
    const job = q.enqueueJob(root, "index-doc", "race.md");
    const held = { ...job, startedAt: "x" } as q.Job; // the runner took it before any start mark
    const got: Operation[] = [];
    const off = ops.onJobOperation((o) => got.push(o));
    ops.observeJobs([root]);
    expect(await ops.cancelJobOperation(root, job.id)).toBe("cancelled");
    expect(cancelRequested(job.id)).toBe(true);
    q.completeJob(root, held, undefined); // it was not cancellable: it finishes
    ops.observeJobs([root]);
    expect(got.at(-1)).toMatchObject({ id: `job:${job.id}`, state: "done" });
    clearJobCancel(job.id);
    off();
  });

  test("the pick-up race for a reindex: the request stops it and it ends as cancelled", async () => {
    clearQueue();
    const job = q.enqueueReindex(root);
    const held = { ...job, startedAt: "x" } as q.Job;
    const got: Operation[] = [];
    const off = ops.onJobOperation((o) => got.push(o));
    ops.observeJobs([root]);
    await ops.cancelJobOperation(root, job.id);
    expect(cancelRequested(job.id)).toBe(true); // the runner's first check sees it
    q.completeJob(root, held, new JobCancelledError());
    ops.observeJobs([root]);
    expect(got.at(-1)).toMatchObject({ state: "cancelled" });
    clearJobCancel(job.id);
    off();
  });
});
