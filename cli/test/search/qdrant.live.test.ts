// AC-3, against the real services: a Qdrant collection written by the Go binary is queried by the
// TypeScript library without reindexing, and the results equal the Go binary's own output (same
// ids, order, scores, semantic scores). Skipped unless Qdrant, Ollama (all-minilm) and a Go binary
// are available; the collection it creates is deleted afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { retrieveWithRuntime, searchWithRuntime } from "../../src/search/index.ts";
import { buildLiveProject, detectLive, type LiveProject, QDRANT_URL } from "./live.ts";

const live = await detectLive();
const suite = live.available ? describe : describe.skip;
if (!live.available) console.warn(`qdrant.live.test.ts skipped: ${live.why}`);

suite("semantic search against a Go-written Qdrant collection", () => {
  let p: LiveProject;
  beforeAll(async () => {
    p = await buildLiveProject({ source: "corpus" });
  }, 180_000);
  afterAll(async () => {
    await p?.dispose();
  });

  /**
   * Results with exactly equal scores come out in map-iteration order in Go (and so differ from
   * run to run); the library orders them deterministically. Compare with ties put in one order.
   */
  const canon = (results: unknown): string => {
    const list = results as { score: number; type: string; id: string }[];
    const sorted = [...list].sort(
      (a, b) => b.score - a.score || a.type.localeCompare(b.type) || a.id.localeCompare(b.id),
    );
    return JSON.stringify(sorted, null, 2);
  };

  const goSearch = (args: string[]) => {
    const r = p.go.run([...args, "--json"], p.goEnv);
    expect(r.code, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  };

  const queries = [
    "vector embedding model",
    "login",
    "deploy rollback release",
    "password reset email",
  ];

  for (const q of queries) {
    test(`hybrid search ${JSON.stringify(q)} equals Go and used the semantic leg`, async () => {
      const out = await searchWithRuntime(p.storage, p.env, {
        query: q,
        type: "",
        mode: "hybrid",
        limit: 20,
      });
      expect(out.runtime).toBeUndefined();
      expect(out.results.some((r) => r.matchedBy?.includes("semantic"))).toBe(true);
      expect(canon(out.results)).toBe(canon(goSearch(["search", q])));
    });

    test(`type filters for ${JSON.stringify(q)}`, async () => {
      for (const type of ["doc", "task"]) {
        const out = await searchWithRuntime(p.storage, p.env, {
          query: q,
          type,
          mode: "hybrid",
          limit: 20,
        });
        expect(canon(out.results)).toBe(canon(goSearch(["search", q, "--type", type])));
      }
    });

    test(`retrieve ${JSON.stringify(q)} equals Go`, async () => {
      const { response, runtime } = await retrieveWithRuntime(p.storage, p.env, {
        query: q,
        mode: "hybrid",
        limit: 20,
      });
      const actual = runtime ? { ...response, _runtime: runtime } : response;
      expect(JSON.stringify(actual, null, 2)).toBe(
        JSON.stringify(goSearch(["retrieve", q]), null, 2),
      );
    });
  }

  test("pure semantic mode returns semantic hits only", async () => {
    const out = await searchWithRuntime(p.storage, p.env, {
      query: "vector embedding model",
      type: "",
      mode: "semantic",
      limit: 10,
    });
    expect(out.results.length).toBeGreaterThan(0);
    for (const r of out.results) {
      expect(r.matchedBy).toEqual(["semantic"]);
      expect(r.semanticScore ?? 0).toBeGreaterThan(0.3 - 1e-6);
    }
  });

  test("querying does not touch the index (no reindexing)", async () => {
    const before = (await (await fetch(`${QDRANT_URL}/collections/${p.collection}`)).json()) as {
      result: { points_count: number };
    };
    await searchWithRuntime(p.storage, p.env, {
      query: "auth",
      type: "",
      mode: "hybrid",
      limit: 5,
    });
    const after = (await (await fetch(`${QDRANT_URL}/collections/${p.collection}`)).json()) as {
      result: { points_count: number };
    };
    expect(after.result.points_count).toBe(before.result.points_count);
    expect(readFileSync(join(p.storage.store.root, ".search", "qdrant.json"), "utf8")).toBe(
      p.pointerJson,
    );
  });

  test("an edited document is dropped as stale, not served from the old index", async () => {
    // Change a doc's body after indexing: its content hash no longer matches the payload.
    const docs = p.storage.docs.list();
    const doc = docs[0];
    expect(doc).toBeDefined();
    if (!doc) return;
    const before = await searchWithRuntime(p.storage, p.env, {
      query: doc.title,
      type: "doc",
      mode: "semantic",
      limit: 20,
    });
    expect(before.results.some((r) => r.id === doc.path)).toBe(true);
    p.storage.docs.update({ ...doc, content: `${doc.content ?? ""}\n\nchanged after indexing` });
    const after = await searchWithRuntime(p.storage, p.env, {
      query: doc.title,
      type: "doc",
      mode: "semantic",
      limit: 20,
    });
    expect(after.results.some((r) => r.id === doc.path)).toBe(false);
  });
});
