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
