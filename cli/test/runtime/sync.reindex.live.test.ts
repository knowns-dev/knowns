// AC6: `knowns sync` with semantic search configured and KNOWNS_RUNTIME_INLINE=1 rebuilds the index
// inline and prints Go's "semantic index rebuilt" lines. Live Ollama (all-minilm) embeds; stdout and
// stderr must equal Go's, and so must the set of indexed sources.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  copySide,
  dispose,
  editConfig,
  makeTemplate,
  normalize,
  runGoIn,
  runTsIn,
} from "../cli/commands/sync-harness.ts";
import { detectLive, LIVE_MODEL, OLLAMA_URL, writeRegistry } from "../search/live.ts";

const live = await detectLive();
const suite = live.available ? describe : describe.skip;
if (!live.available) console.warn(`sync.reindex.live.test.ts skipped: ${live.why}`);

const sources = (dir: string): string[] => {
  const db = new Database(join(dir, ".knowns", ".search", "index.db"));
  try {
    return (
      db.query("SELECT source_id FROM content_hashes ORDER BY source_id").all() as {
        source_id: string;
      }[]
    )
      .map((r) => r.source_id)
      .filter((id) => !id.startsWith("task:") || true)
      .map((id) => id.replace(/^task:.*/, "task:*"));
  } finally {
    db.close();
  }
};

suite("sync rebuilds the index inline", () => {
  test("project semantic index rebuilt lines equal Go", async () => {
    const tpl = makeTemplate([], (dir) => {
      editConfig(dir, (cfg) => {
        cfg.settings.semanticSearch = { enabled: true, provider: "ollama", model: LIVE_MODEL };
      });
      mkdirSync(join(dir, ".knowns", "docs"), { recursive: true });
      writeFileSync(
        join(dir, ".knowns", "docs", "guide.md"),
        "---\ntitle: Guide\ndescription: A guide\n---\n\nHow to log in and out.\n",
      );
    });
    const go = copySide(tpl);
    const ts = copySide(tpl);
    try {
      for (const s of [go, ts]) writeRegistry(s.home, OLLAMA_URL);
      const env = { KNOWNS_RUNTIME_INLINE: "1", KNOWNS_SEMANTIC_RUNTIME_DISABLED: "" };
      const g = runGoIn(go, ["sync", "--plain"], env);
      const t = await runTsIn(ts, ["sync", "--plain"], env);
      expect(g.code, g.stderr).toBe(0);
      expect(g.stdout).toContain("Project semantic index rebuilt");
      expect(t.code, t.stderr).toBe(g.code);
      expect(normalize(t.stdout, ts)).toBe(normalize(g.stdout, go));
      expect(normalize(t.stderr, ts)).toBe(normalize(g.stderr, go));
      expect(sources(ts.dir)).toEqual(sources(go.dir));
    } finally {
      dispose(tpl, go, ts);
    }
  }, 240_000);
});
