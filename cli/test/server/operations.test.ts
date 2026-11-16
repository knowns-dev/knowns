// Activity Tray server side (KN-3PPEM9, spec specs/2026-11-17/activity-tray): the operation
// registry's coalescing, expiry, cancel, retry, dismiss and snapshot rules, and the batch archive as
// the first registered operation over a real server.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  JobOperationSource,
  Operation,
  OperationEvent,
  OperationRemovedEvent,
} from "../../src/runtime/operation-types.ts";
import { OperationRegistry } from "../../src/server/operations.ts";
import { type Side, send, startSide, stopSide, testEnv } from "./harness.ts";

setDefaultTimeout(180_000);

interface Seen {
  name: string;
  data: OperationEvent & OperationRemovedEvent;
}

function registry(over: Partial<ConstructorParameters<typeof OperationRegistry>[0]> = {}) {
  const seen: Seen[] = [];
  const reg = new OperationRegistry({
    emit: (name, data) => seen.push({ name, data: data as Seen["data"] }),
    minIntervalMs: 40,
    doneExpiryMs: 60,
    ...over,
  });
  reg.clientsChanged(1);
  return { reg, seen };
}

const names = (seen: Seen[]) => seen.map((s) => s.name);

describe("OperationRegistry", () => {
  test("the queue watch exists only while an event stream is open, and a poke re-reads the source", async () => {
    let started = 0;
    let stopped = 0;
    let observed = 0;
    let poke: (() => void) | undefined;
    const src: JobOperationSource = {
      listJobOperations: () => [],
      onJobOperation: () => () => {},
      cancelJobOperation: async () => "gone",
      retryJobOperation: async () => false,
      observeJobs: () => {
        observed++;
      },
    };
    const reg = new OperationRegistry({
      emit: () => {},
      jobs: async () => src,
      watchJobs: (p) => {
        started++;
        poke = p;
        return () => {
          stopped++;
        };
      },
    });
    expect(started).toBe(0);
    reg.clientsChanged(1);
    await Bun.sleep(20);
    expect({ started, observed }).toEqual({ started: 1, observed: 1 }); // baseline taken at attach
    poke?.();
    expect(observed).toBe(2);
    reg.clientsChanged(0);
    expect(stopped).toBe(1);
    poke?.(); // a late poke after detach does nothing harmful
    reg.close();
  });

  test("a burst of progress is coalesced: leading edge, then at most one event per window", async () => {
    const { reg, seen } = registry();
    const h = reg.start({
      kind: "batch_archive",
      title: "Archiving 1000 tasks",
      progress: { done: 0, total: 1000 },
      cancellable: true,
    });
    const t0 = Date.now();
    for (let i = 1; i <= 1000; i++) {
      h.progress(i, 1000);
      if (i % 50 === 0) await Bun.sleep(5);
    }
    await Bun.sleep(80);
    const updates = seen.filter((s) => s.name === "operation:updated");
    const secs = (Date.now() - t0) / 1000;
    expect(updates.length).toBeLessThanOrEqual(Math.ceil(secs / 0.04 + 2));
    expect(updates.length).toBeLessThan(40);
    // the last value is never lost
    expect(updates.at(-1)?.data.operation.progress).toEqual({ done: 1000, total: 1000 });
    // seq only grows
    const seqs = seen.map((s) => s.data.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    h.finish("1000 archived");
    expect(names(seen).at(-1)).toBe("operation:finished");
    expect(seen.at(-1)?.data.operation.progress).toEqual({ done: 1000, total: 1000 });
  });

  test("started and finished are never delayed; a state change flushes at once", () => {
    const { reg, seen } = registry();
    const h = reg.start({ kind: "x", title: "X", state: "queued" });
    h.progress(1, 2);
    h.progress(2, 2); // inside the window: no extra event yet
    expect(names(seen)).toEqual(["operation:started"]);
    h.fail("boom");
    expect(names(seen)).toEqual(["operation:started", "operation:finished"]);
    expect(seen.at(-1)?.data.operation).toMatchObject({
      state: "failed",
      error: "boom",
      cancellable: false,
    });
  });

  test("cancel is idempotent, a finished operation is a no-op, a non-cancellable one conflicts", async () => {
    const { reg } = registry();
    const h = reg.start({ kind: "batch_archive", title: "A", cancellable: true });
    const first = await reg.cancel(h.id);
    expect(first.status).toBe("ok");
    expect(first.operation?.state).toBe("cancelling");
    expect(h.cancelRequested).toBe(true);
    expect((await reg.cancel(h.id)).operation?.state).toBe("cancelling");
    h.cancelled("3 archived, 7 left");
    const late = await reg.cancel(h.id);
    expect(late.status).toBe("ok");
    expect(late.operation).toMatchObject({ state: "cancelled", message: "3 archived, 7 left" });
    const fixed = reg.start({ kind: "x", title: "no safe stop", cancellable: false });
    expect((await reg.cancel(fixed.id)).status).toBe("conflict");
    expect((await reg.cancel("op_nope")).status).toBe("unknown");
  });

  test("done and cancelled operations expire, a failed one stays until dismissed, retry re-runs", async () => {
    const { reg, seen } = registry();
    const ok = reg.start({ kind: "x", title: "ok" });
    ok.finish();
    let runs = 0;
    const bad = reg.start({
      kind: "batch_archive",
      title: "bad",
      retry: () => {
        runs++;
        return reg.get(reg.start({ kind: "batch_archive", title: "bad (retry)" }).id) as Operation;
      },
    });
    bad.fail("permission denied");
    expect(reg.get(bad.id)?.retryable).toBe(true);
    await Bun.sleep(120);
    expect(reg.get(ok.id)).toBeUndefined();
    expect(seen.some((s) => s.name === "operation:removed" && s.data.id === ok.id)).toBe(true);
    expect(reg.get(bad.id)?.state).toBe("failed");
    expect(reg.dismiss(ok.id).status).toBe("unknown");
    const r = await reg.retry(bad.id);
    expect(r.status).toBe("ok");
    expect(runs).toBe(1);
    expect(reg.get(bad.id)).toBeUndefined(); // the old id is gone
    expect(reg.dismiss(r.operation?.id as string).status).toBe("conflict"); // still running
    const fail2 = reg.start({ kind: "x", title: "f2" });
    fail2.fail("nope");
    expect(reg.dismiss(fail2.id).status).toBe("ok");
    expect(reg.get(fail2.id)).toBeUndefined();
  });

  test("failed operations are capped, oldest first", () => {
    const { reg } = registry({ failedCap: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const h = reg.start({ kind: "x", title: `f${i}` });
      h.fail("e");
      ids.push(h.id);
    }
    expect(reg.snapshot().operations.map((o) => o.id)).toEqual(ids.slice(2));
  });

  test("the snapshot carries a seq newer than any event it covers", () => {
    const { reg, seen } = registry();
    const a = reg.start({ kind: "x", title: "a" });
    a.progress(1, 4);
    const snap = reg.snapshot();
    expect(snap.operations.map((o) => o.id)).toEqual([a.id]);
    expect(snap.seq).toBeGreaterThanOrEqual(Math.max(...seen.map((s) => s.data.seq)));
  });

  test("the daemon job source is read only while a client is connected, and merged", async () => {
    let listed = 0;
    let subscribed = 0;
    let cb: ((op: Operation) => void) | undefined;
    const job = (state: Operation["state"], done = 0): Operation => ({
      id: "job:j1",
      source: "daemon",
      kind: "reindex-search",
      title: "Reindexing project",
      project: "p",
      projectRoot: "/p",
      state,
      progress: { done, total: 10 },
      cancellable: state === "queued",
      retryable: state === "failed",
      error: state === "failed" ? "dead letter" : null,
      message: null,
      startedAt: 1,
      updatedAt: 2,
      finishedAt: state === "done" || state === "failed" ? 3 : null,
    });
    const src: JobOperationSource = {
      listJobOperations: () => {
        listed++;
        return [job("queued")];
      },
      onJobOperation: (f) => {
        subscribed++;
        cb = f;
        return () => {
          cb = undefined;
        };
      },
      cancelJobOperation: async () => "cancelled",
      retryJobOperation: async () => true,
    };
    const seen: Seen[] = [];
    const reg = new OperationRegistry({
      emit: (name, data) => seen.push({ name, data: data as Seen["data"] }),
      jobs: async () => src,
      minIntervalMs: 20,
      doneExpiryMs: 5_000,
    });
    expect(subscribed).toBe(0); // nobody connected: nothing read, nothing subscribed
    reg.clientsChanged(1);
    await Bun.sleep(20);
    expect(subscribed).toBe(1);
    expect(reg.get("job:j1")?.state).toBe("queued");
    cb?.(job("running", 3));
    expect(reg.get("job:j1")?.state).toBe("running");
    const c = await reg.cancel("job:j1"); // running is not cancellable in this fake
    expect(c.status).toBe("conflict");
    cb?.(job("failed"));
    expect(reg.get("job:j1")).toMatchObject({ state: "failed", retryable: true });
    expect(reg.dismiss("job:j1").status).toBe("ok");
    cb?.(job("failed")); // a dismissed job stays dismissed
    expect(reg.get("job:j1")).toBeUndefined();
    reg.clientsChanged(0);
    expect(cb).toBeUndefined(); // unsubscribed with the last client
    expect(listed).toBeGreaterThan(0);
  });
});

// ---- over a real server -------------------------------------------------------------------------

const J = { "Content-Type": "application/json" };
const N = 120;
let ts: Side;

function seedTs(): string {
  const root = mkdtempSync(join(tmpdir(), "knowns-ops-tpl-"));
  const dir = join(root, "proj");
  const home = join(root, "home");
  mkdirSync(dir);
  mkdirSync(home);
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  const r = Bun.spawnSync(
    [
      "bun",
      join(import.meta.dir, "..", "..", "src", "main.ts"),
      "init",
      "Ops",
      "--no-wizard",
      "--no-open",
    ],
    {
      cwd: dir,
      env: testEnv(home),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (r.exitCode !== 0) throw new Error(`init failed: ${r.stderr.toString()}`);
  return dir;
}

interface Collected {
  // biome-ignore lint/suspicious/noExplicitAny: event payloads are checked field by field in the tests
  events: { name: string; data: Record<string, any> }[];
  stop: () => void;
}

function collectEvents(base: string): Collected {
  const events: Collected["events"] = [];
  const ctl = new AbortController();
  void (async () => {
    const res = await fetch(`${base}/api/events`, { signal: ctl.signal });
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
        if (name?.startsWith("operation:")) events.push({ name, data: JSON.parse(data as string) });
        i = buf.indexOf("\n\n");
      }
    }
  })();
  return { events, stop: () => ctl.abort() };
}

async function waitFor<T>(fn: () => T | undefined, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

describe("batch archive as an operation", () => {
  const ids: string[] = [];
  beforeAll(async () => {
    ts = await startSide("ts", seedTs());
    for (let i = 0; i < N; i++) {
      const r = await send(ts, "POST", "/api/tasks", {
        body: JSON.stringify({ title: `Done ${String(i).padStart(3, "0")}`, status: "done" }),
        headers: J,
      });
      if (r.status !== 201 && r.status !== 200)
        throw new Error(`create ${i}: ${r.status} ${r.text}`);
      ids.push(JSON.parse(r.text).id);
    }
  });
  afterAll(() => ts && stopSide(ts));

  test("background: 202 with an operation, few progress events, finished with the count, snapshot and expiry", async () => {
    const ev = collectEvents(ts.base);
    await Bun.sleep(300);
    const half = ids.slice(0, 60);
    const t0 = Date.now();
    const r = await send(ts, "POST", "/api/tasks/batch-archive", {
      body: JSON.stringify({ ids: half, execute: true, background: true }),
      headers: J,
    });
    expect(r.status).toBe(202);
    const op = JSON.parse(r.text).operation as Operation;
    expect(op).toMatchObject({
      source: "web",
      kind: "batch_archive",
      title: "Archiving 60 tasks",
      cancellable: true,
    });
    expect(op.progress).toEqual({ done: 0, total: 60 });
    // the snapshot shows it while it runs (or already finished), with a seq
    const snap = JSON.parse((await send(ts, "GET", "/api/operations")).text);
    expect(typeof snap.seq).toBe("number");
    const fin = await waitFor(() =>
      ev.events.find((e) => e.name === "operation:finished" && e.data.operation.id === op.id),
    );
    const secs = (Date.now() - t0) / 1000;
    expect(fin.data.operation).toMatchObject({
      state: "done",
      message: "60 archived",
      progress: { done: 60, total: 60 },
    });
    const updates = ev.events.filter(
      (e) => e.name === "operation:updated" && e.data.operation.id === op.id,
    );
    expect(updates.length).toBeLessThanOrEqual(Math.ceil(secs * 4) + 2);
    expect(ev.events.filter((e) => e.name === "operation:started").length).toBe(1);
    // done operations leave the server list after the expiry
    const gone = await waitFor(
      () => ev.events.find((e) => e.name === "operation:removed" && e.data.id === op.id),
      30_000,
    );
    expect(gone.data.seq).toBeGreaterThan(fin.data.seq);
    ev.stop();
  });

  test("cancel stops after the current chunk, keeps what was archived and reports the count", async () => {
    const rest = ids.slice(60);
    const ev = collectEvents(ts.base);
    await Bun.sleep(300);
    const r = await send(ts, "POST", "/api/tasks/batch-archive", {
      body: JSON.stringify({ ids: rest, execute: true, background: true }),
      headers: J,
    });
    const op = JSON.parse(r.text).operation as Operation;
    const c = await send(ts, "POST", `/api/operations/${op.id}/cancel`);
    expect(c.status).toBe(200);
    expect(["cancelling", "cancelled", "done"]).toContain(JSON.parse(c.text).operation.state);
    const fin = await waitFor(() =>
      ev.events.find((e) => e.name === "operation:finished" && e.data.operation.id === op.id),
    );
    const o = fin.data.operation as Operation;
    expect(o.state).toBe("cancelled");
    const archived = Number(/^(\d+) archived, (\d+) left$/.exec(o.message ?? "")?.[1]);
    const left = Number(/^(\d+) archived, (\d+) left$/.exec(o.message ?? "")?.[2]);
    expect(archived + left).toBe(rest.length);
    expect(archived).toBeGreaterThan(0);
    expect(left).toBeGreaterThan(0);
    // those tasks stay archived, the rest are untouched
    const active = JSON.parse((await send(ts, "GET", "/api/tasks?summary=true")).text);
    const activeIds = new Set(
      (Array.isArray(active) ? active : active.tasks).map((t: { id: string }) => t.id),
    );
    expect(rest.filter((id) => activeIds.has(id)).length).toBe(left);
    // retry re-runs the same request: the new operation finishes the rest, the old id is removed
    const rr = await send(ts, "POST", `/api/operations/${op.id}/retry`);
    expect(rr.status).toBe(202);
    const again = JSON.parse(rr.text).operation as Operation;
    expect(again.id).not.toBe(op.id);
    const fin2 = await waitFor(() =>
      ev.events.find((e) => e.name === "operation:finished" && e.data.operation.id === again.id),
    );
    expect(fin2.data.operation.state).toBe("done");
    const after = JSON.parse((await send(ts, "GET", "/api/tasks?summary=true")).text);
    const afterIds = new Set(
      (Array.isArray(after) ? after : after.tasks).map((x: { id: string }) => x.id),
    );
    expect(rest.filter((id) => afterIds.has(id)).length).toBe(0);
    expect((await send(ts, "POST", `/api/operations/${op.id}/retry`)).status).toBe(404);
    // a late cancel is a no-op; dismiss of a finished one works; an unknown id is 404
    expect((await send(ts, "POST", `/api/operations/${again.id}/cancel`)).status).toBe(200);
    expect((await send(ts, "POST", `/api/operations/${again.id}/dismiss`)).status).toBe(200);
    expect((await send(ts, "POST", `/api/operations/${again.id}/dismiss`)).status).toBe(404);
    expect((await send(ts, "POST", "/api/operations/op_missing/cancel")).status).toBe(404);
    ev.stop();
  });

  test("without background the request still answers with the lifecycle response and the operation is registered", async () => {
    const r = await send(ts, "POST", "/api/tasks/batch-unarchive", {
      body: JSON.stringify({ ids: ids.slice(0, 5), execute: true }),
      headers: J,
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text);
    expect(body).toMatchObject({
      operation: "batch_unarchive",
      processed: 5,
      changed: 5,
      completed: true,
    });
    const snap = JSON.parse((await send(ts, "GET", "/api/operations")).text);
    expect(
      snap.operations.some((o: Operation) => o.kind === "batch_unarchive" && o.state === "done"),
    ).toBe(true);
  });
});
