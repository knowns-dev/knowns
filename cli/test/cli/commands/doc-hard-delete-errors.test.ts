// The two error prefixes Go prints for a failed `doc hard-delete` (internal/cli/doc.go): a
// bootstrap reconcile failure reads "doc hard-delete reconcile: <err>", a purge failure reads
// "doc hard-delete: <err>". Both paths are hard to reach through a real store, so the hook throws.
import { afterEach, expect, test } from "bun:test";
import { docHooks } from "../../../src/cli/commands/doc-hooks.ts";
import { DocReconcileError } from "../../../src/domain/reconcile/purge.ts";
import { installWiring } from "../../../src/wiring/index.ts";
import { dispose, makeProject, type Project, runTsIn } from "./doc-harness.ts";

// The root installs the real seams before the first command runs; install them first so the
// stubs below are not overwritten.
await installWiring();
const saved = docHooks.hardDelete;
const cleanup: Project[] = [];
afterEach(() => {
  docHooks.hardDelete = saved;
  for (const p of cleanup.splice(0)) dispose(p);
});

const args = [
  "doc",
  "hard-delete",
  "architecture",
  "--allow-hard-delete",
  "--yes",
  "--reason",
  "r",
];

async function stderrWhenHookThrows(err: Error): Promise<string> {
  const p = makeProject("full");
  cleanup.push(p);
  docHooks.hardDelete = async () => {
    throw err;
  };
  const r = await runTsIn(p, args);
  expect(r.code).not.toBe(0);
  return r.stderr;
}

test("bootstrap reconcile failure uses Go's 'doc hard-delete reconcile:' prefix", async () => {
  const stderr = await stderrWhenHookThrows(new DocReconcileError(new Error("boom")));
  expect(stderr).toContain("doc hard-delete reconcile: boom");
  expect(stderr).not.toContain("doc hard-delete: reconcile");
});

test("purge failure uses 'doc hard-delete:' prefix", async () => {
  const stderr = await stderrWhenHookThrows(new Error("boom"));
  expect(stderr).toContain("doc hard-delete: boom");
});
