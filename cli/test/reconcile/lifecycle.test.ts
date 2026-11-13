// Reconciler behaviour that needs no Go oracle: tombstone timing, rename, refusals, the scheduler
// and the VersionStore preview used for legacy streams.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FilesystemReconciler } from "../../src/domain/reconcile/reconciler.ts";
import { ReconcileScheduler } from "../../src/domain/reconcile/watcher.ts";
import { createStorage } from "../../src/storage/adapters.ts";
import { Store } from "../../src/storage/core/store.ts";
import { dispose, makeProject, type Project, runTsIn } from "./harness.ts";

const projects: Project[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) dispose(p);
});
const setup = () => {
  const p = makeProject("full");
  projects.push(p);
  const root = join(p.dir, ".knowns");
  const rec = new FilesystemReconciler(root);
  let now = new Date("2026-11-05T10:00:00Z");
  rec.setLifecycleClock(() => now);
  return { p, root, rec, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
};

describe("lifecycle pass", () => {
  test("a briefly missing file is not a deletion until the quiet window passes", async () => {
    const { root, rec, advance } = setup();
    await rec.reconcileLifecycle(true);
    const file = join(root, "docs/guides/setup-guide.md");
    const bytes = readFileSync(file);
    renameSync(file, `${file}.hold`);
    const first = await rec.reconcileLifecycle(true);
    expect(first.some((r) => r.pending && r.path === "docs/guides/setup-guide.md")).toBe(true);
    expect(first.some((r) => r.operation === "delete")).toBe(false);
    advance(1000);
    renameSync(`${file}.hold`, file);
    writeFileSync(file, bytes);
    const back = await rec.reconcileLifecycle(true);
    expect(back.some((r) => r.operation === "delete")).toBe(false);
  });

  test("a renamed file keeps its identity", async () => {
    const { root, rec } = setup();
    await rec.reconcileLifecycle(true);
    renameSync(join(root, "docs/guides/setup-guide.md"), join(root, "docs/guides/renamed.md"));
    const results = await rec.reconcileLifecycle(true);
    const rename = results.find((r) => r.operation === "rename");
    expect(rename?.previousPath).toBe("docs/guides/setup-guide.md");
    expect(rename?.currentPath).toBe("docs/guides/renamed.md");
    expect(results.some((r) => r.operation === "delete")).toBe(false);
  });

  test("restore refuses a path that holds different content", async () => {
    const { p, root, rec, advance } = setup();
    expect((await runTsIn(p, ["doc", "delete", "architecture", "--force"])).code).toBe(0);
    writeFileSync(
      join(root, "docs/architecture.md"),
      "---\nid: doc-other\ntitle: Other\n---\n\nsomething else\n",
    );
    advance(0);
    await expect(
      rec.restore("doc", "doc-f8f5f059990a91c0ffe3cdfbead46a36", { path: "docs/architecture.md" }),
    ).rejects.toThrow("restore path already exists");
  });

  test("hard delete needs trusted authorization, confirmation and a reason", async () => {
    const { rec } = setup();
    await expect(
      rec.hardDelete("doc", "doc-f8f5f059990a91c0ffe3cdfbead46a36", {
        trusted: true,
        confirmed: false,
        reason: "x",
      }),
    ).rejects.toThrow("hard delete requires trusted authorization, confirmation, and reason");
  });
});

describe("scheduler", () => {
  test("flushes after the quiet window and keeps only the latest path", () => {
    let t = 0;
    const out: string[][] = [];
    const s = new ReconcileScheduler(
      (b) => out.push(b.map((h) => h.path)),
      () => t,
    );
    s.offer("a", "", "/x/a.md");
    t = 1000;
    s.offer("a", "", "/x/a2.md");
    t = 3500;
    s.tick();
    expect(out).toEqual([]);
    t = 4100;
    s.tick();
    expect(out).toEqual([["/x/a2.md"]]);
  });
});

describe("VersionStore.readDocHistoryPreview", () => {
  test("finds a stream's history without writing and tolerates unknown paths", () => {
    const { root } = setup();
    const storage = createStorage(Store.open(root));
    const legacyPath = storage.versions.legacyDocVersionPath("legacy/doc");
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({
        docPath: "legacy/doc",
        currentVersion: 1,
        versions: [
          {
            id: "v1",
            docPath: "legacy/doc",
            version: 1,
            timestamp: "2026-01-01T00:00:00Z",
            snapshot: { title: "L" },
          },
        ],
      }),
    );
    const known = storage.versions.readDocHistoryPreview("legacy/doc");
    expect((known.versions ?? []).length).toBe(1);
    const unknown = storage.versions.readDocHistoryPreview("nope/missing");
    expect(unknown.versions).toEqual([]);
    expect(existsSync(join(root, "history/locks"))).toBe(false);
  });
});
