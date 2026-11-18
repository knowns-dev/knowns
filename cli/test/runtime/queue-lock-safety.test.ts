// Review of perf/runtime-idle: removing a queue file takes the queue's lock, and a lock timeout says
// why it gave up.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as q from "../../src/runtime/queue.ts";

const home = mkdtempSync(join(tmpdir(), "knowns-locksafe-"));
const saved = process.env.KNOWNS_RUNTIME_ROOT;
beforeAll(() => {
  process.env.KNOWNS_RUNTIME_ROOT = join(home, "runtime");
  mkdirSync(join(home, "runtime", "queues"), { recursive: true });
});
afterAll(() => {
  if (saved === undefined) delete process.env.KNOWNS_RUNTIME_ROOT;
  else process.env.KNOWNS_RUNTIME_ROOT = saved;
  rmSync(home, { recursive: true, force: true });
});

const projectDir = (name: string): string => {
  const p = join(home, name, ".knowns");
  mkdirSync(p, { recursive: true });
  return p;
};

test("a held queue lock makes updateQueue fail with the last error code", () => {
  const p = projectDir("held");
  q.updateQueue(p, () => {}); // creates the queue file
  const lock = `${join(home, "runtime", "queues")}/${require("node:fs")
    .readdirSync(join(home, "runtime", "queues"))
    .find((n: string) => n.endsWith(".json"))}.lock`;
  writeFileSync(lock, "999999"); // a fresh lock another process holds
  try {
    expect(() => q.updateQueue(p, () => {})).toThrow(
      /timed out waiting for lock .*\(last error: EEXIST\)/,
    );
  } finally {
    rmSync(lock, { force: true });
  }
});

test("the orphan sweep leaves a queue file whose lock is held, and never deletes the lock", () => {
  const orphan = join(home, "runtime", "queues", "orphan-x.json");
  writeFileSync(orphan, JSON.stringify({ jobs: [] }));
  const old = (Date.now() - 8 * 24 * 3_600_000) / 1000;
  utimesSync(orphan, old, old);
  const lock = `${orphan}.lock`;
  writeFileSync(lock, "999999");
  try {
    q.pruneRuntimeFiles(Date.now());
    expect(existsSync(orphan)).toBe(true); // locked: left alone
    expect(existsSync(lock)).toBe(true); // not ours to delete
  } finally {
    rmSync(lock, { force: true });
  }
  q.pruneRuntimeFiles(Date.now());
  expect(existsSync(orphan)).toBe(false); // unlocked and empty: removed
});
