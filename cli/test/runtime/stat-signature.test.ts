// Review of perf/runtime-idle: a stat-signature cache must not give a false hit for a file that was
// rewritten, with the same size, inside one timestamp tick.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registeredProjects } from "../../src/runtime/queue.ts";
import { RACY_WINDOW_MS, statSignature } from "../../src/storage/core/stat-signature.ts";

const dir = mkdtempSync(join(tmpdir(), "knowns-statsig-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a recently touched file has no signature; an old one has a stable one", () => {
  const p = join(dir, "a.json");
  writeFileSync(p, "one");
  expect(statSignature(statSync(p, { bigint: true }))).toBeUndefined();
  // ctime cannot be set, so look at the file from a later "now".
  const later = Date.now() + RACY_WINDOW_MS + 5000;
  const sig = statSignature(statSync(p, { bigint: true }), later);
  expect(sig).toBeDefined();
  expect(statSignature(statSync(p, { bigint: true }), later)).toBe(sig);
  // A mtime in the future cannot be trusted either.
  const future = (later + 60_000) / 1000;
  utimesSync(p, future, future);
  expect(statSignature(statSync(p, { bigint: true }), later)).toBeUndefined();
});

test("the project registry sees a same-size rewrite made right after a read", () => {
  const prev = process.env.KNOWNS_RUNTIME_ROOT;
  process.env.KNOWNS_RUNTIME_ROOT = join(dir, "runtime");
  try {
    const file = join(dir, "runtime", "projects.json");
    require("node:fs").mkdirSync(join(dir, "runtime"), { recursive: true });
    writeFileSync(file, '["/p/aaa"]');
    expect(registeredProjects()).toEqual(["/p/aaa"]);
    // Same size, immediately: a (mtime, size, ino) cache would answer /p/aaa again.
    writeFileSync(file, '["/p/bbb"]');
    expect(registeredProjects()).toEqual(["/p/bbb"]);
  } finally {
    if (prev === undefined) delete process.env.KNOWNS_RUNTIME_ROOT;
    else process.env.KNOWNS_RUNTIME_ROOT = prev;
  }
});
