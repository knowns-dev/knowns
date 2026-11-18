// KN-V3GE5Q review: the reconciler never records the middle of a writer's operation, and its index
// handoff runs outside the writers' lock.
import { afterEach, expect, test } from "bun:test";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FilesystemReconciler } from "../../src/domain/reconcile/reconciler.ts";
import { Store } from "../../src/storage/core/store.ts";
import { dispose, makeProject, type Project } from "./harness.ts";

const projects: Project[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) dispose(p);
});
const setup = (index?: (r: unknown) => Promise<void>) => {
  const p = makeProject("full");
  projects.push(p);
  const root = join(p.dir, ".knowns");
  const rec = new FilesystemReconciler(root, { index: index as never });
  return { root, rec, store: Store.open(root) };
};
const slow = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the index handoff runs after the doc lock is released", async () => {
  let handoffs = 0;
  let lockedInside = false;
  let storeRef: Store | undefined;
  const { root, rec, store } = setup(async () => {
    handoffs++;
    // A callback that takes the same writer lock must not hang: the lock is already released.
    await (storeRef as Store).withDocMutationLocks(
      ["guides/setup-guide"],
      () => {
        lockedInside = true;
      },
      { timeoutMs: 1500 },
    );
  });
  storeRef = store;
  await rec.reconcile(true);
  const file = join(root, "docs/guides/setup-guide.md");
  writeFileSync(file, `${readFileSync(file, "utf8")}\nedited outside\n`);
  await rec.reconcile(true);
  expect(handoffs).toBeGreaterThan(0);
  expect(lockedInside).toBe(true);
});

test("a rename waits for the writer's doc locks and is then recorded once", async () => {
  const { root, rec, store } = setup();
  await rec.reconcile(true);
  await rec.reconcileLifecycle(true);
  const oldFile = join(root, "docs/guides/setup-guide.md");
  renameSync(oldFile, join(root, "docs/guides/moved.md"));
  let release: (() => void) | undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let acquired!: () => void;
  const got = new Promise<void>((r) => {
    acquired = r;
  });
  // The writer of this rename holds both path locks while it finishes its history append.
  const writer = store.withDocMutationLocks(
    ["guides/moved", "guides/setup-guide"],
    async () => {
      acquired();
      await held;
    },
    { timeoutMs: 5000 },
  );
  await got;
  let done = false;
  const pass = rec.reconcileLifecycle(true).then((r) => {
    done = true;
    return r;
  });
  await slow(400);
  expect(done).toBe(false); // blocked on the writer's lock, not recording its own revision
  release?.();
  await writer;
  const results = await pass;
  expect(results.filter((r) => r.operation === "rename")).toHaveLength(1);
});

test("a busy writer lock defers the file and the rest of the batch instead of waiting per file", async () => {
  const { root, rec, store } = setup();
  await rec.reconcile(true);
  rec.setWriterLockTimeout(300);
  const a = join(root, "docs/guides/setup-guide.md");
  const b = join(root, "docs/architecture.md");
  writeFileSync(a, `${readFileSync(a, "utf8")}\nedit a\n`);
  writeFileSync(b, `${readFileSync(b, "utf8")}\nedit b\n`);
  let release: (() => void) | undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let acquired!: () => void;
  const got = new Promise<void>((r) => {
    acquired = r;
  });
  // Both docs are busy: without the cut-off the pass would wait 2 x 300 ms.
  const writer = store.withDocMutationLocks(
    ["architecture", "guides/setup-guide"],
    async () => {
      acquired();
      await held;
    },
    { timeoutMs: 5000 },
  );
  await got;
  const t0 = Date.now();
  const results = await rec.reconcile(true);
  const elapsed = Date.now() - t0;
  const busy = results.filter((r) => r.pending && /writer lock busy/.test(r.diagnostic));
  expect(busy.length).toBeGreaterThanOrEqual(2); // both edited docs deferred, with a retry time
  expect(busy.every((r) => r.retryAt !== undefined)).toBe(true);
  expect(elapsed).toBeLessThan(550); // one wait, not one per file
  release?.();
  await writer;
  // Once the writer is done the deferred files are reconciled.
  const again = await rec.reconcile(true);
  expect(again.filter((r) => r.pending)).toHaveLength(0);
  expect(again.some((r) => r.changed)).toBe(true);
});
