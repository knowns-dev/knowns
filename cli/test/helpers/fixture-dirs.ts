// Recreates the empty directories of the golden fixtures, which git does not track.
//
// Why: `knowns init` (Go and TS alike) creates storage directories such as .knowns/tasks and
// .knowns/templates even when they stay empty. scripts/gen-fixtures.ts snapshots them, but a clean
// clone (CI) drops every empty directory, so a copied fixture silently differed from the Go
// snapshot and tests that expect them (doctor removing .knowns/tasks) failed with ENOENT. A
// .gitkeep inside .knowns would be listed by parity tests that enumerate files, so the manifest
// records the directories instead (`emptyDirs`) and this module restores them in place.
//
// Runs from the test preload (sandbox-home.ts), before any harness copies a fixture. mkdir with
// `recursive` is idempotent, so concurrent test processes are safe.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");

export function ensureFixtureDirs(): void {
  const manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, "manifest.json"), "utf8")) as {
    fixtures: Record<string, { emptyDirs?: string[] }>;
  };
  for (const [name, entry] of Object.entries(manifest.fixtures)) {
    for (const rel of entry.emptyDirs ?? []) {
      mkdirSync(join(FIXTURES_DIR, name, ...rel.split("/")), { recursive: true });
    }
  }
}

ensureFixtureDirs();
