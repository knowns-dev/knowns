// A daemon with a UI open asks which stores are linked every few seconds; the registry is only
// loaded again when its file changed (KN-B3NWK3, review of the open-tab profile).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverStats,
  discoverStores,
  RegistryWatch,
} from "../../src/domain/storesync/service.ts";

// A file written by a test is brand new, which the racy rule never serves from a cache; -1 lets
// the tests below exercise real cache hits (the rule itself is covered by its own test).
let savedRacy: string | undefined;
beforeAll(() => {
  savedRacy = process.env.KNOWNS_STAT_RACY_MS;
  process.env.KNOWNS_STAT_RACY_MS = "-1";
});
afterAll(() => {
  if (savedRacy === undefined) delete process.env.KNOWNS_STAT_RACY_MS;
  else process.env.KNOWNS_STAT_RACY_MS = savedRacy;
});

test("an unchanged registry is loaded once, a changed one is loaded again", () => {
  const dir = mkdtempSync(join(tmpdir(), "knowns-discover-"));
  try {
    const path = join(dir, "registry.json");
    mkdirSync(join(dir, "proj"), { recursive: true });
    mkdirSync(join(dir, "proj2"), { recursive: true });
    const entry = (name: string) => ({
      id: name,
      name,
      path: join(dir, "proj"),
      lastUsed: "2026-11-16T00:00:00Z",
      store: { name, remote: "git@example.com:x.git", project: name },
    });
    writeFileSync(path, JSON.stringify([entry("one")]));
    const before = discoverStats.loads;
    const first = discoverStores(path);
    expect(first.map((f) => f.store)).toEqual(["one"]);
    for (let i = 0; i < 20; i++) discoverStores(path);
    expect(discoverStats.loads - before).toBe(1);
    // A caller that edits its copy does not corrupt the cached answer.
    first[0]?.projects.push("junk");
    expect(discoverStores(path)[0]?.projects).toEqual(["one"]);

    writeFileSync(
      path,
      JSON.stringify([entry("one"), { ...entry("two"), path: join(dir, "proj2") }]),
    );
    expect(discoverStores(path).map((f) => f.store)).toEqual(["one", "two"]);
    expect(discoverStats.loads - before).toBe(2);
    // A missing registry is empty, and stays cheap.
    expect(discoverStores(join(dir, "nope.json"))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the idle wait ends at once when the registry changes, and on abort", async () => {
  const { sleepUntilChange } = await import("../../src/domain/storesync/service.ts");
  const dir = mkdtempSync(join(tmpdir(), "knowns-idlewait-"));
  try {
    const path = join(dir, "registry.json");
    const ctl = new AbortController();
    const t0 = Date.now();
    const waiting = sleepUntilChange(path, 8000, ctl.signal);
    await Bun.sleep(150);
    writeFileSync(path, "[]");
    await waiting;
    // Where the platform does not deliver the event the 8 s timeout is the wake-up; the watch
    // normally ends it well before that.
    expect(Date.now() - t0).toBeLessThan(8000);

    const t1 = Date.now();
    const again = sleepUntilChange(path, 8000, ctl.signal);
    ctl.abort();
    await again;
    expect(Date.now() - t1).toBeLessThan(1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P2-1: a failed registry load is never cached as 'no stores'", () => {
  const dir = mkdtempSync(join(tmpdir(), "knowns-discover-fail-"));
  try {
    const path = join(dir, "registry.json");
    mkdirSync(join(dir, "proj"), { recursive: true });
    const entry = {
      id: "one",
      name: "one",
      path: join(dir, "proj"),
      lastUsed: "2026-11-16T00:00:00Z",
      store: { name: "one", remote: "git@example.com:x.git", project: "one" },
    };
    // Nothing known yet and the file is half written: empty, but not remembered.
    writeFileSync(path, '[{"id":"one",');
    expect(discoverStores(path)).toEqual([]);
    writeFileSync(path, JSON.stringify([entry]));
    expect(discoverStores(path).map((f) => f.store)).toEqual(["one"]);
    // A good answer is known; a later unreadable file keeps it instead of reporting no stores.
    writeFileSync(path, '[{"id":"one",');
    expect(discoverStores(path).map((f) => f.store)).toEqual(["one"]);
    // The repaired file is picked up on the very next call (the failure was not cached for 30 s).
    writeFileSync(path, JSON.stringify([{ ...entry, store: { ...entry.store, name: "two" } }]));
    expect(discoverStores(path).map((f) => f.store)).toEqual(["two"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P2-1: a registry touched moments ago is read again, not cached (racy rule)", () => {
  const dir = mkdtempSync(join(tmpdir(), "knowns-discover-racy-"));
  const saved = process.env.KNOWNS_STAT_RACY_MS;
  delete process.env.KNOWNS_STAT_RACY_MS; // the default window
  try {
    const path = join(dir, "registry.json");
    writeFileSync(path, "[]");
    const before = discoverStats.loads;
    discoverStores(path);
    discoverStores(path);
    expect(discoverStats.loads - before).toBe(2);
  } finally {
    process.env.KNOWNS_STAT_RACY_MS = saved ?? "-1";
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P3-2: one watch serves many waits, and a change between two waits is not lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowns-regwatch-"));
  try {
    const path = join(dir, "registry.json");
    const watcher = new RegistryWatch(path);
    const ctl = new AbortController();
    const t0 = Date.now();
    const first = watcher.sleep(8000, ctl.signal);
    await Bun.sleep(100);
    writeFileSync(path, "[]");
    await first;
    expect(Date.now() - t0).toBeLessThan(5000);
    // Changes while nobody sleeps end the next wait at once.
    writeFileSync(path, "[ ]");
    await Bun.sleep(300);
    const t1 = Date.now();
    await watcher.sleep(8000, ctl.signal);
    expect(Date.now() - t1).toBeLessThan(1000);
    const t2 = Date.now();
    const third = watcher.sleep(8000, ctl.signal);
    ctl.abort();
    await third;
    expect(Date.now() - t2).toBeLessThan(1000);
    watcher.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
