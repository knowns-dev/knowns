// Unit tests for the queue state machine (internal/runtimequeue): coalescing, the Qdrant retry
// ladder, dead letters and their bound, successor generations.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as q from "../../src/runtime/queue.ts";

const home = mkdtempSync(join(tmpdir(), "knowns-queue-"));
const root = join(home, "proj", ".knowns");
const saved = { HOME: process.env.HOME, INLINE: process.env.KNOWNS_RUNTIME_INLINE };

beforeAll(() => {
  process.env.HOME = home;
  process.env.KNOWNS_RUNTIME_INLINE = "1";
  mkdirSync(root, { recursive: true });
});
afterAll(() => {
  if (saved.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = saved.HOME;
  if (saved.INLINE === undefined) delete process.env.KNOWNS_RUNTIME_INLINE;
  else process.env.KNOWNS_RUNTIME_INLINE = saved.INLINE;
  rmSync(home, { recursive: true, force: true });
});

const intent = (rev: number): q.QdrantIntent => ({
  entityType: "task",
  entityId: "T-1",
  revision: rev,
  operation: "update",
  canonicalHash: `h${rev}`,
  path: "tasks/T-1.md",
  generation: 0,
});

describe("runtime queue", () => {
  test("enqueue coalesces by key and refuses a full reindex through enqueueJob", () => {
    const a = q.enqueueJob(root, "index-memory", "m1");
    const b = q.enqueueJob(root, "index-memory", "m1");
    expect(b.id).toBe(a.id);
    expect(() => q.enqueueJob(root, "reindex-search", "")).toThrow(
      "full search reindex requires EnqueueReindex",
    );
    expect(q.enqueueReindex(root).kind).toBe("reindex-search");
  });

  test("a newer qdrant intent replaces an older one; an older one is ignored", () => {
    const j1 = q.enqueueQdrantIntent(root, intent(1));
    const j2 = q.enqueueQdrantIntent(root, intent(3));
    expect(j2.id).toBe(j1.id);
    expect(j2.intent?.generation).toBe(3);
    expect(q.enqueueQdrantIntent(root, intent(2)).intent?.generation).toBe(3);
  });

  test("failures retry with backoff, then dead-letter after 8 attempts; retry releases", () => {
    const job = q.enqueueQdrantIntent(root, { ...intent(5), entityId: "T-2" });
    let cur = job;
    for (let i = 1; i <= 8; i++) {
      cur = q.markJobStarted(root, job.id);
      expect(cur.attempts).toBe(i);
      q.completeJob(root, cur, new Error("connection refused"));
    }
    const dead = q.listDeadLetters(root);
    expect(dead.map((d) => d.id)).toContain(job.id);
    expect(q.loadQueue(root).recent?.[0]?.deadLetter).toBe(true);
    expect(q.nextReadyJob([root])?.job.id).not.toBe(job.id);
    const released = q.retryJob(root, job.id);
    expect(released.deadLetter).toBeFalsy();
    expect(released.attempts ?? 0).toBe(0);
    expect(() => q.retryJob(root, "missing")).toThrow("not found");
    expect(() => q.retryJob(root, q.enqueueJob(root, "index-doc", "d").id)).toThrow(
      "not a qdrant dead letter",
    );
  });

  test("retry delay doubles and caps at five minutes", () => {
    expect([1, 2, 3, 10].map(q.qdrantRetryDelayMs)).toEqual([1000, 2000, 4000, 300000]);
  });
});
