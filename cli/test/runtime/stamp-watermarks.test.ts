// TSR-6T3JVM: a full reindex must stamp the watermarks of the entities it indexed even when the
// project has no manifest.json (a store used only through the CLI). Go 0.34.1 skips them, which
// leaves readiness reporting "not indexed at their current hash" after "semantic index completed".
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadWatermarks,
  stampWatermarksFromGeneration,
} from "../../src/runtime/index/qdrant-intent.ts";
import { qdrantEntityReadinessForStore } from "../../src/search/readiness.ts";

const root = mkdtempSync(join(tmpdir(), "knowns-stamp-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function seed(name: string, withManifest: boolean): string {
  const store = join(root, name);
  const state = join(store, "history", "state");
  mkdirSync(state, { recursive: true });
  const zero = "0001-01-01T00:00:00Z";
  writeFileSync(
    join(state, "qdrant-index-watermarks.json"),
    JSON.stringify({
      "task:abc123": {
        entityType: "task",
        entityId: "abc123",
        canonicalHash: "h-task",
        revision: 1,
        path: "tasks/abc123.md",
        indexedAt: zero,
        stale: true,
      },
      "doc:guides/setup": {
        entityType: "doc",
        entityId: "guides/setup",
        canonicalHash: "h-doc",
        revision: 2,
        path: "docs/guides/setup.md",
        indexedAt: zero,
        stale: true,
      },
    }),
  );
  if (withManifest) {
    writeFileSync(join(state, "manifest.json"), JSON.stringify({ entries: {} }));
  }
  return store;
}

test("stamps watermark-only entities when there is no manifest", () => {
  const store = seed("no-manifest", false);
  const stamped = stampWatermarksFromGeneration(
    store,
    new Set(["task:abc123", "doc:guides/setup"]),
    "2026-11-09T00:00:00Z",
  );
  expect(stamped).toBe(2);
  const marks = loadWatermarks(store);
  expect(marks["task:abc123"]?.stale).toBeFalsy();
  expect(marks["task:abc123"]?.indexedHash).toBe("h-task");
  expect(marks["task:abc123"]?.indexedAt).toBe("2026-11-09T00:00:00Z");
  expect(marks["doc:guides/setup"]?.indexedPath).toBe("docs/guides/setup.md");
  const readiness = qdrantEntityReadinessForStore(store);
  expect(readiness.length).toBe(2);
  expect(readiness.every((r) => !r.stale)).toBe(true);
});

test("stamps watermark-only entities next to an empty manifest, leaves unindexed ones stale", () => {
  const store = seed("empty-manifest", true);
  const stamped = stampWatermarksFromGeneration(
    store,
    new Set(["task:abc123"]),
    "2026-11-09T00:00:00Z",
  );
  expect(stamped).toBe(1);
  const marks = loadWatermarks(store);
  expect(marks["task:abc123"]?.stale).toBeFalsy();
  expect(marks["doc:guides/setup"]?.stale).toBe(true);
});
