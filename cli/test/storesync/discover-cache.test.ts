// A daemon with a UI open asks which stores are linked every few seconds; the registry is only
// loaded again when its file changed (KN-B3NWK3, review of the open-tab profile).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverStats, discoverStores } from "../../src/domain/storesync/service.ts";

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
