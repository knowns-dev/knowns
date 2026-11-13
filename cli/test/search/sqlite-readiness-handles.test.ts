// The sqlite readiness preflight runs before every semantic search, so it must not leave a handle
// on index.db behind. bun:sqlite cannot open a WAL database read-only without its -shm file, so
// an index Go wrote (its driver removes -shm on close) takes the fallback open, and that path once leaked the first handle: a
// long-running MCP server accumulated one per search. Counted with lsof (not on Windows).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { semanticIndexReadinessSqlite } from "../../src/search/readiness.ts";
import { SQLiteVectorStore } from "../../src/search/sqlite-store.ts";
import type { Storage } from "../../src/storage/adapters.ts";

const DIMS = 4;

function openHandles(path: string): number {
  const r = Bun.spawnSync(["lsof", "-p", String(process.pid)]);
  return r.stdout
    .toString()
    .split("\n")
    .filter((l) => l.includes(path)).length;
}

describe.skipIf(process.platform === "win32")("sqlite readiness handles", () => {
  test("a hundred preflights leave no handle on index.db", () => {
    // Resolved: lsof prints real paths (/private/var on macOS, where tmpdir() is /var).
    const root = realpathSync(mkdtempSync(join(tmpdir(), "knowns-ready-")));
    try {
      const store = new SQLiteVectorStore(join(root, ".search"), "m", DIMS);
      store.load();
      store.addChunks([
        {
          id: "doc:a:0",
          type: "doc",
          content: "a",
          tokenCount: 1,
          embedding: new Float32Array(DIMS).fill(0.5),
        },
      ]);
      store.save();
      store.close();
      // Leave the index the way Go 0.34.x does after a clean close: checkpointed, no -wal or -shm.
      // Only then does the read-only open fail and the fallback (where the leak was) run.
      const raw = new Database(join(root, ".search", "index.db"));
      raw.run("PRAGMA wal_checkpoint(TRUNCATE)");
      raw.close();
      for (const ext of ["-wal", "-shm"])
        rmSync(join(root, ".search", `index.db${ext}`), { force: true });

      const storage = { store: { root } } as unknown as Storage;
      const dbPath = join(root, ".search", "index.db");
      for (let i = 0; i < 100; i++) {
        const r = semanticIndexReadinessSqlite(storage, { model: "m", dimensions: DIMS }, []);
        expect(r.ready).toBe(true);
      }
      expect(openHandles(dbPath)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
