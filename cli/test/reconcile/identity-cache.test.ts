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
