// The tray registry against the REAL daemon job source (runtime/job-operations.ts, queue files in a
// temp home): the contract between the two halves of KN-3PPEM9 and the daemon job events task.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobCancelledError } from "../../src/runtime/job-cancel.ts";
import * as real from "../../src/runtime/job-operations.ts";
import type { JobOperationSource, Operation } from "../../src/runtime/operation-types.ts";
import * as q from "../../src/runtime/queue.ts";
import { OperationRegistry } from "../../src/server/operations.ts";
import { setProcessHome } from "../helpers/process-env.ts";
import { type Side, startSide, stopSide, testEnv } from "./harness.ts";

const home = mkdtempSync(join(tmpdir(), "knowns-tray-jobs-"));
const root = join(home, "proj", ".knowns");
let restoreHome: () => void = () => {};

beforeAll(() => {
  restoreHome = setProcessHome(home);
  process.env.KNOWNS_RUNTIME_INLINE = "1";
  process.env.KNOWNS_JOB_CANCEL_GRACE_MS = "60";
  mkdirSync(root, { recursive: true });
});
afterAll(() => {
  restoreHome();
  rmSync(home, { recursive: true, force: true });
});

const clear = () =>
  q.updateQueue(root, (s) => {
    s.jobs = [];
    s.recent = [];
  });

/** The real source, pinned to the temp project (the daemon passes its registered projects). */
const source: JobOperationSource = {
  listJobOperations: () => real.listJobOperations([root]),
  onJobOperation: real.onJobOperation,
  cancelJobOperation: real.cancelJobOperation,
  retryJobOperation: real.retryJobOperation,
};

function setup() {
  const sent: { name: string; op?: Operation; id?: string }[] = [];
  const reg = new OperationRegistry({
    emit: (name, data) => {
      const d = data as { operation?: Operation; id?: string };
      sent.push({ name, ...(d.operation && { op: d.operation }), ...(d.id && { id: d.id }) });
    },
    jobs: async () => source,
    minIntervalMs: 10,
    doneExpiryMs: 60_000,
  });
  return { reg, sent };
}
const settle = () => Bun.sleep(30);
const last = (sent: { op?: Operation }[], id: string) =>
  [...sent].reverse().find((s) => s.op?.id === id)?.op;

// Needs the real daemon source (feat/activity-tray-daemon); with the empty stand-in it is skipped.
const haveRealSource = "observeJobs" in real;

describe.skipIf(!haveRealSource)("registry with the daemon job source", () => {
  test("a queued reindex is listed at attach; housekeeping jobs (per-item index, reconciles) stay out unless they fail", async () => {
    clear();
    const re = q.enqueueReindex(root);
    const doc = q.enqueueJob(root, "index-doc", "a.md");
    const rq = q.enqueueJob(root, "reconcile-qdrant", "x");
    const { reg } = setup();
    reg.clientsChanged(1);
    await settle();
    const ids = reg.snapshot().operations.map((o) => o.id);
    expect(ids).toContain(`job:${re.id}`);
    expect(ids).not.toContain(`job:${doc.id}`);
    expect(ids).not.toContain(`job:${rq.id}`);
    reg.clientsChanged(0);
    reg.close();
  });

  test("a running reindex streams progress and ends done; a fast job arrives only finished", async () => {
    clear();
    const re = q.enqueueReindex(root);
    const { reg, sent } = setup();
    reg.clientsChanged(1);
    await settle();
    real.observeJobs([root]); // baseline
    q.markJobStarted(root, re.id);
    q.reportProgress(root, re.id, "docs", 4, 10);
    real.observeJobs([root]);
    expect(reg.get(`job:${re.id}`)).toMatchObject({
      state: "running",
      progress: { done: 4, total: 10 },
    });
    q.completeJob(root, { ...re, startedAt: "x" } as q.Job, undefined);
    real.observeJobs([root]);
    expect(last(sent, `job:${re.id}`)?.state).toBe("done");
    expect(sent.at(-1)?.name).toBe("operation:finished");
    // a job that came and went between two observations is reported finished with no started
    const fast = q.enqueueReindex(root);
    real.observeJobs([root]);
    q.markJobStarted(root, fast.id);
    q.completeJob(root, { ...fast, startedAt: "x" } as q.Job, undefined);
    real.observeJobs([root]);
    expect(last(sent, `job:${fast.id}`)?.state).toBe("done");
    reg.clientsChanged(0);
    reg.close();
  });

  test("cancel of a queued job stays cancelling until the source reports the outcome", async () => {
    clear();
    const re = q.enqueueReindex(root);
    const { reg } = setup();
    reg.clientsChanged(1);
    await settle();
    const r = await reg.cancel(`job:${re.id}`);
    expect(r.status).toBe("ok");
    expect(r.operation?.state).toBe("cancelling"); // not cancelled yet: the runner may hold it
    expect(reg.get(`job:${re.id}`)?.state).toBe("cancelling");
    await Bun.sleep(150); // the daemon's grace window passes with neither start nor result
    expect(reg.get(`job:${re.id}`)?.state).toBe("cancelled");
    // a repeated cancel is a no-op
    expect((await reg.cancel(`job:${re.id}`)).operation?.state).toBe("cancelled");
    reg.clientsChanged(0);
    reg.close();
  });

  test("a stopped reindex ends cancelled and retry puts the same job id back in the queue", async () => {
    clear();
    const re = q.enqueueReindex(root);
    q.markJobStarted(root, re.id);
    const { reg } = setup();
    reg.clientsChanged(1);
    await settle();
    real.observeJobs([root]);
    q.completeJob(root, { ...re, startedAt: "x" } as q.Job, new JobCancelledError());
    real.observeJobs([root]);
    const id = `job:${re.id}`;
    expect(reg.get(id)).toMatchObject({ state: "cancelled", retryable: true });
    const rt = await reg.retry(id);
    expect(rt.status).toBe("ok");
    expect(q.loadQueue(root).jobs.some((j) => j.kind === "reindex-search")).toBe(true);
    expect(
      reg.snapshot().operations.some((o) => o.kind === "reindex-search" && o.state === "queued"),
    ).toBe(true);
    reg.clientsChanged(0);
    reg.close();
  });

  test("the job source is unsubscribed with the last client, and a dismissed failure stays dismissed", async () => {
    clear();
    const { reg } = setup();
    reg.clientsChanged(1);
    await settle();
    expect(real.hasJobListeners()).toBe(true);
    const doc = q.enqueueJob(root, "index-doc", "bad.md");
    real.observeJobs([root]);
    q.completeJob(root, doc, new Error("boom"));
    real.observeJobs([root]);
    const id = `job:${doc.id}`;
    expect(reg.get(id)).toMatchObject({ state: "failed", error: "boom" });
    expect(reg.dismiss(id).status).toBe("ok");
    expect(reg.get(id)).toBeUndefined();
    reg.clientsChanged(0);
    expect(real.hasJobListeners()).toBe(false);
    reg.close();
  });
});

// ---- a server that does not run the daemon loop ---------------------------------------------------

describe.skipIf(!haveRealSource)("foreground server sees queue changes live (NFR-4)", () => {
  let side: Side | undefined;
  const rt = mkdtempSync(join(tmpdir(), "knowns-tray-rt-"));

  afterAll(() => {
    if (side) stopSide(side);
    rmSync(rt, { recursive: true, force: true });
  });

  function seed(): string {
    const r = mkdtempSync(join(tmpdir(), "knowns-tray-tpl-"));
    const dir = join(r, "proj");
    const h = join(r, "home");
    mkdirSync(dir);
    mkdirSync(h);
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    const init = Bun.spawnSync(
      [
        "bun",
        join(import.meta.dir, "..", "..", "src", "main.ts"),
        "init",
        "Jobs",
        "--no-wizard",
        "--no-open",
      ],
      {
        cwd: dir,
        env: { ...testEnv(h), KNOWNS_RUNTIME_ROOT: rt },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (init.exitCode !== 0) throw new Error(init.stderr.toString());
    return dir;
  }

  test("a job enqueued while a foreground server has an SSE client shows started, then finished", async () => {
    side = await startSide("ts", seed(), { env: { KNOWNS_RUNTIME_ROOT: rt } });
    const storeRoot = join(side.dir, ".knowns");
    process.env.KNOWNS_RUNTIME_ROOT = rt;
    const events: { name: string; op: Operation }[] = [];
    const ctl = new AbortController();
    void (async () => {
      const res = await fetch(`${side?.base}/api/events`, { signal: ctl.signal });
      const reader = res.body?.getReader();
      if (!reader) return;
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        buf += dec.decode(value);
        let i = buf.indexOf("\n\n");
        while (i >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const name = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (name?.startsWith("operation:") && data) {
            events.push({ name, op: (JSON.parse(data) as { operation: Operation }).operation });
          }
          i = buf.indexOf("\n\n");
        }
      }
    })();
    try {
      await Bun.sleep(500); // the stream is open and the server has taken its baseline
      // another process (the shared daemon, a CLI) works the queue; this server only watches it
      const job = q.enqueueReindex(storeRoot);
      const id = `job:${job.id}`;
      const until = async (f: () => boolean, ms = 8000) => {
        const end = Date.now() + ms;
        while (!f()) {
          if (Date.now() > end)
            throw new Error(
              `timed out; saw ${JSON.stringify(events.map((e) => [e.name, e.op.id === id ? e.op.state : e.op.kind]))}`,
            );
          await Bun.sleep(25);
        }
      };
      await until(() => events.some((e) => e.op.id === id && e.name === "operation:started"));
      q.markJobStarted(storeRoot, job.id);
      q.reportProgress(storeRoot, job.id, "docs", 5, 10);
      await until(() =>
        events.some((e) => e.op.id === id && e.op.state === "running" && e.op.progress?.done === 5),
      );
      q.completeJob(storeRoot, { ...job, startedAt: "x" } as q.Job, undefined);
      await until(() =>
        events.some(
          (e) => e.op.id === id && e.name === "operation:finished" && e.op.state === "done",
        ),
      );
    } finally {
      ctl.abort();
    }
  });
});
