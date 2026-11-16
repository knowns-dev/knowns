// uniqueIdentity keeps what it parsed per stat signature (the runtime's startup reconcile was
// quadratic in the number of files). The cache must never hide a duplicate identity, and a file
// that changed must be read again.
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FilesystemReconciler } from "../../src/domain/reconcile/reconciler.ts";
import { dispose, makeProject, type Project } from "./harness.ts";

const projects: Project[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) dispose(p);
});

type WithIdentity = { uniqueIdentity(kind: string, id: string, target: string): void };

test("a duplicate task id is found through the cache, and cleared when the copy's id changes", () => {
  const p = makeProject("full");
  projects.push(p);
  const root = join(p.dir, ".knowns");
  const tasks = join(root, "tasks");
  const name = readdirSync(tasks).find((f) => f.endsWith(".md"));
  expect(name).toBeDefined();
  const original = join(tasks, name as string);
  const text = readFileSync(original, "utf8");
  const id = /^id: ["']?([^"'\n]+)["']?$/m.exec(text)?.[1] as string;
  expect(id).toBeDefined();

  const rec = new FilesystemReconciler(root) as unknown as WithIdentity;
  rec.uniqueIdentity("task", id, original); // unique, and now cached

  const copy = join(tasks, "zz-duplicate.md");
  copyFileSync(original, copy);
  expect(() => rec.uniqueIdentity("task", id, original)).toThrow(/ambiguous/);

  // The copy takes another id: its signature changed, so it is read again.
  writeFileSync(copy, text.replace(id, `${id}-other-with-a-longer-name`));
  expect(() => rec.uniqueIdentity("task", id, original)).not.toThrow();
});

type Scoped = WithIdentity & {
  withIdentityScope<T>(fn: () => Promise<T>): Promise<T>;
};

const taskFixture = () => {
  const p = makeProject("full");
  projects.push(p);
  const root = join(p.dir, ".knowns");
  const tasks = join(root, "tasks");
  const name = readdirSync(tasks).find((f) => f.endsWith(".md")) as string;
  const original = join(tasks, name);
  const text = readFileSync(original, "utf8");
  const id = /^id: ["']?([^"'\n]+)["']?$/m.exec(text)?.[1] as string;
  return { root, tasks, original, text, id };
};

test("inside a scope one walk answers every check, and duplicates still refuse", async () => {
  const { root, tasks, original, text, id } = taskFixture();
  const rec = new FilesystemReconciler(root) as unknown as Scoped;
  const copy = join(tasks, "zz-duplicate.md");
  copyFileSync(original, copy);
  await rec.withIdentityScope(async () => {
    expect(() => rec.uniqueIdentity("task", id, original)).toThrow(/ambiguous/);
    expect(() => rec.uniqueIdentity("task", id, copy)).toThrow(/ambiguous/);
  });
  // The scope is over: a copy that took another id is seen on the next walk.
  writeFileSync(copy, text.replace(id, `${id}-other-with-a-longer-name`));
  await rec.withIdentityScope(async () => {
    expect(() => rec.uniqueIdentity("task", id, original)).not.toThrow();
  });
});

test("a file created or edited after the index was built is still checked on its own", async () => {
  const { root, tasks, original, text, id } = taskFixture();
  const rec = new FilesystemReconciler(root) as unknown as Scoped;
  await rec.withIdentityScope(async () => {
    rec.uniqueIdentity("task", id, original); // builds the index
    // A new task appears: it is not in the index, but it is the file being reconciled.
    const fresh = join(tasks, "zz-new-task.md");
    writeFileSync(fresh, text.replace(id, `${id}-fresh-identity`));
    expect(() => rec.uniqueIdentity("task", `${id}-fresh-identity`, fresh)).not.toThrow();
    // Another file claims the original's id: the original is no longer the only match once the
    // index is rebuilt, and a check for the new file's own claim is refused.
    const claimant = join(tasks, "zz-claimant.md");
    writeFileSync(claimant, text);
    expect(() => rec.uniqueIdentity("task", id, claimant)).toThrow(/ambiguous/);
  });
});

test("outside a scope every check walks the disk (the destructive paths rely on it)", () => {
  const { root, tasks, original, text, id } = taskFixture();
  const rec = new FilesystemReconciler(root) as unknown as WithIdentity;
  rec.uniqueIdentity("task", id, original);
  writeFileSync(join(tasks, "zz-claimant.md"), text);
  expect(() => rec.uniqueIdentity("task", id, original)).toThrow(/ambiguous/);
});

// Review of perf/runtime-idle: a stale cache entry (a same-tick rewrite the signature cannot see)
// must not feed a destructive decision or be written into history.
type Poisonable = {
  canonicalCache: Map<string, { sig: string; kind: string; id: string; hash: string }>;
  resolveCanonicalHint(path: string): Promise<{ kind: string; id: string; hash: string }>;
  canonicalIdentityPaths(entityType: string, entityId: string): Promise<string[]>;
  reconcileLifecycleFile(
    path: string,
    previous: Record<string, unknown>,
    execute: boolean,
    source: string,
    batchId: string,
    operation: string,
  ): Promise<unknown>;
};

test("identity proofs read the file, not the cache; a lifecycle write refuses a cached hash that disagrees", async () => {
  process.env.KNOWNS_STAT_RACY_MS = "-1"; // let fresh files be cached, as an old file would be
  try {
    const { root, original, id } = taskFixture();
    const rec = new FilesystemReconciler(root) as unknown as Poisonable;
    const truth = await rec.resolveCanonicalHint(original); // cached under the file's signature
    expect(truth.id).toBe(id);
    // A same-tick rewrite the signature missed: the cache now describes some other content.
    const entry = rec.canonicalCache.get(original);
    expect(entry).toBeDefined();
    rec.canonicalCache.set(original, {
      ...(entry as NonNullable<typeof entry>),
      id: "TSK-STALE0",
      hash: "stale",
    });
    // canonicalIdentityPaths backs hard delete and restore proofs: it must see the real owner.
    expect(await rec.canonicalIdentityPaths("task", id)).toHaveLength(1);
    // The lifecycle write path records the hash of the bytes it read, and refuses a disagreement.
    rec.canonicalCache.set(original, {
      ...(entry as NonNullable<typeof entry>),
      hash: "stale",
    });
    await expect(
      rec.reconcileLifecycleFile(
        original,
        { entityType: "task", entityId: id, path: original, hash: truth.hash },
        false,
        "",
        "b1",
        "update",
      ),
    ).rejects.toThrow(/unstable canonical file; retry/);
  } finally {
    delete process.env.KNOWNS_STAT_RACY_MS;
  }
});
