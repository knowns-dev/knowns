// KN-F5CP12: every rename, link and read of store data goes through fs-retry, so the Windows
// busy-file race cannot come back at a site that forgot it. The scan covers the directories that
// hold store, history, sync, reconcile, index and runtime queue data.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");
const ROOTS = [
  "storage",
  "domain/storesync",
  "domain/reconcile",
  "domain/evaluation",
  "runtime/index",
  "search/qdrant",
  "mcp/log.ts",
  "runtime/queue.ts",
  "runtime/qdrant-endpoint.ts",
];
/** The helper itself, and nothing else: new exceptions need a reason here. */
const ALLOWED = new Set(["storage/core/fs-retry.ts"]);
const BARE = /\b(renameSync|linkSync|readFileSync)\b/;

function files(path: string): string[] {
  const abs = join(SRC, path);
  if (abs.endsWith(".ts")) return [abs];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(path, e.name)) : e.name.endsWith(".ts") ? [join(abs, e.name)] : [],
  );
}

describe("store data goes through fs-retry", () => {
  test("no bare renameSync, linkSync or readFileSync in the store, sync, reconcile, index or queue code", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(root)) {
        const rel = relative(SRC, f).replaceAll("\\", "/");
        if (ALLOWED.has(rel)) continue;
        readFileSync(f, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (BARE.test(line) && !/^\s*(\/\/|\/\*|\*)/.test(line)) {
              offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
            }
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
