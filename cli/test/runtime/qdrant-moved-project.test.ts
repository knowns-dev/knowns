// KN-448EF2: a project folder that moved or was renamed. Its Qdrant pointer names the old path, so
// every targeted reconcile fails the ownership check. The queue must park those jobs (no retries, no
// dead letters, one diagnostic naming the rebuild), a rebuild must clear what they left, and the
// generations built under the old path must be removable, but only on proof they are this store's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupQdrantGenerations } from "../../src/runtime/index/reindex.ts";
import * as q from "../../src/runtime/queue.ts";
import {
  isQdrantOwnershipMismatch,
  newQdrantPointer,
  QDRANT_GENERATION_STATUS_ACTIVE,
  QDRANT_GENERATION_STATUS_INACTIVE,
  type QdrantGenerationRecord,
  QdrantOwnershipMismatchError,
  saveQdrantGenerations,
  saveQdrantPointer,
} from "../../src/search/qdrant/pointer.ts";
import { Registry } from "../../src/storage/stores/registry.ts";
import { setProcessHome } from "../helpers/process-env.ts";

const home = mkdtempSync(join(tmpdir(), "knowns-moved-"));
const saved = { INLINE: process.env.KNOWNS_RUNTIME_INLINE };
let restoreHome: () => void = () => {};
beforeAll(() => {
  restoreHome = setProcessHome(home);
  process.env.KNOWNS_RUNTIME_INLINE = "1";
});
afterAll(() => {
  restoreHome();
  if (saved.INLINE === undefined) delete process.env.KNOWNS_RUNTIME_INLINE;
  else process.env.KNOWNS_RUNTIME_INLINE = saved.INLINE;
  rmSync(home, { recursive: true, force: true });
});

const storeAt = (name: string): string => {
  const root = join(home, name, ".knowns");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), "{}");
  return root;
};
const intent = (id: string): q.QdrantIntent => ({
  entityType: "task",
  entityId: id,
  revision: 1,
  operation: "update",
  canonicalHash: "h",
  path: `tasks/${id}.md`,
  generation: 0,
});
const emb = { model: "m", dimensions: 3 } as never;

describe("a moved project's reconcile jobs", () => {
  test("every change is parked once: no retry, no dead letter, ONE diagnostic naming the rebuild", () => {
    const root = storeAt("parked");
    for (let i = 0; i < 12; i++) {
      const job = q.enqueueQdrantIntent(root, intent(`T-${i}`));
      const started = q.markJobStarted(root, job.id);
      q.completeJob(root, started, new QdrantOwnershipMismatchError());
    }
    const state = q.loadQueue(root);
    expect(state.jobs).toHaveLength(0);
    expect(q.listDeadLetters(root)).toHaveLength(0);
    const failures = (state.recent ?? []).filter((r) => r.error);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toContain("knowns search index --wait");
    expect(failures[0]?.retryable).toBeFalsy();
    expect(isQdrantOwnershipMismatch(failures[0]?.error)).toBe(true);
  });

  test("other failures still retry and dead-letter as before", () => {
    const root = storeAt("other");
    const job = q.enqueueQdrantIntent(root, intent("T-1"));
    q.completeJob(root, q.markJobStarted(root, job.id), new Error("connection refused"));
    expect(q.loadQueue(root).jobs).toHaveLength(1);
  });

  test("clearOwnershipMismatchJobs drops mismatch dead letters and results, nothing else", () => {
    const root = storeAt("clear");
    const keep = q.enqueueQdrantIntent(root, intent("T-keep"));
    const dead = q.enqueueQdrantIntent(root, intent("T-dead"));
    q.updateQueue(root, (s) => {
      for (const j of s.jobs) {
        if (j.id === dead.id) {
          j.deadLetter = true;
          j.lastError = new QdrantOwnershipMismatchError().message;
        }
      }
      s.recent = [
        {
          jobId: "x",
          key: "k",
          kind: "reconcile-qdrant",
          success: false,
          completedAt: q.nowString(),
          requestedAt: q.nowString(),
          startedAt: q.nowString(),
          attemptCount: 1,
          error: new QdrantOwnershipMismatchError().message,
        },
      ];
    });
    expect(q.clearOwnershipMismatchJobs(root)).toBe(2);
    expect(q.loadQueue(root).jobs.map((j) => j.id)).toEqual([keep.id]);
    expect(q.loadQueue(root).recent ?? []).toHaveLength(0);
  });
});

describe("cleaning up generations of the previous path", () => {
  /** A store whose active pointer is new and whose history holds generations built at `oldRoot`. */
  function moved(name: string, projectId = "Macss-App", oldRoot = `/old/path/${name}/.knowns`) {
    const root = storeAt(name);
    const old = newQdrantPointer(oldRoot, projectId, emb);
    const older = newQdrantPointer(oldRoot, projectId, emb);
    const active = newQdrantPointer(root, projectId, emb);
    const rec = (p: typeof old, generation: number, status: string): QdrantGenerationRecord =>
      ({
        generation,
        collectionUUID: p.collectionUUID,
        collectionName: p.collectionName,
        schemaVersion: p.schemaVersion,
        chunkVersion: p.chunkVersion,
        embedding: p.embedding,
        owner: p.owner,
        status,
        chunkCount: 1,
        createdAt: "2026-01-01T00:00:00Z",
        swappedAt: "2026-01-01T00:00:00Z",
        retiredAt: "2026-01-02T00:00:00Z",
      }) as QdrantGenerationRecord;
    saveQdrantPointer(root, active);
    saveQdrantGenerations(root, [
      rec(older, 1, QDRANT_GENERATION_STATUS_INACTIVE),
      rec(old, 2, QDRANT_GENERATION_STATUS_INACTIVE),
      rec(active, 3, QDRANT_GENERATION_STATUS_ACTIVE),
    ]);
    return { root, active, old, older };
  }
  const fakeClient = () => {
    const deleted: string[] = [];
    return {
      deleted,
      client: {
        deleteCollection: async (n: string) => {
          deleted.push(n);
        },
      } as never,
    };
  };
  const far = Date.now() + 365 * 86_400_000;

  test("old-path generations of the same project are deleted once the rebuild owns the pointer", async () => {
    const { root, active, old, older } = moved("cleanup");
    const { client, deleted } = fakeClient();
    const out = await cleanupQdrantGenerations(root, client, active, 0, 1000, far);
    expect(out.errors).toEqual([]);
    expect(new Set(deleted)).toEqual(new Set([old.collectionName, older.collectionName]));
    expect(deleted).not.toContain(active.collectionName);
  });

  test("a generation of ANOTHER project id is refused", async () => {
    const { root, active, old } = moved("other-id");
    const other = newQdrantPointer("/old/else/.knowns", "Some-Other", emb);
    saveQdrantGenerations(root, [
      {
        generation: 9,
        collectionUUID: other.collectionUUID,
        collectionName: other.collectionName,
        schemaVersion: other.schemaVersion,
        chunkVersion: other.chunkVersion,
        embedding: other.embedding,
        owner: other.owner,
        status: QDRANT_GENERATION_STATUS_INACTIVE,
        chunkCount: 1,
        createdAt: "2026-01-01T00:00:00Z",
        swappedAt: "2026-01-01T00:00:00Z",
        retiredAt: "2026-01-02T00:00:00Z",
      } as QdrantGenerationRecord,
    ]);
    const { client, deleted } = fakeClient();
    const out = await cleanupQdrantGenerations(root, client, active, 0, 1000, far);
    expect(deleted).toEqual([]);
    expect(out.errors[0]?.message).toContain("ownership proof mismatch");
    void old;
  });

  test("a collection another registered project still serves (a copied folder) is refused", async () => {
    const { root, active, old } = moved("copied");
    const orig = storeAt("original");
    // The original keeps serving what the copy lists as its old generation.
    saveQdrantPointer(orig, { ...old, owner: { ...old.owner } });
    const reg = new Registry();
    reg.load();
    reg.add(join(home, "original"));
    const { client, deleted } = fakeClient();
    await cleanupQdrantGenerations(root, client, active, 0, 1000, far);
    expect(deleted).not.toContain(old.collectionName);
  });

  test("a copy whose original is known only to the runtime (never registered) is refused", async () => {
    const original = storeAt("never-registered");
    const { root, active, old } = moved("copy-of-unregistered", "Macss-App", original);
    mkdirSync(q.runtimeRoot(), { recursive: true });
    writeFileSync(join(q.runtimeRoot(), "projects.json"), JSON.stringify([original, root]));
    const { client, deleted } = fakeClient();
    await cleanupQdrantGenerations(root, client, active, 0, 1000, far);
    expect(deleted).not.toContain(old.collectionName);
  });

  test("a move: the old path is still in the runtime list but its folder is gone, so it is deleted", async () => {
    const gone = join(home, "gone-after-move", ".knowns");
    const { root, active, old } = moved("really-moved", "Macss-App", gone);
    mkdirSync(q.runtimeRoot(), { recursive: true });
    writeFileSync(join(q.runtimeRoot(), "projects.json"), JSON.stringify([gone, root]));
    const { client, deleted } = fakeClient();
    await cleanupQdrantGenerations(root, client, active, 0, 1000, far);
    expect(deleted).toContain(old.collectionName);
  });

  test("without an active pointer owned by this path nothing is deleted", async () => {
    const { root, old } = moved("unowned");
    const { client, deleted } = fakeClient();
    const out = await cleanupQdrantGenerations(root, client, old, 0, 1000, far);
    expect(deleted).toEqual([]);
    expect(out.errors.length).toBeGreaterThan(0);
  });
});
