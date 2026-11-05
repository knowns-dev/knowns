// The shared SearchEnvironment builder (MCP and the server reuse it): the machine embedding
// registry, the global semantic store, the references adapter and the runtime-queue seam.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { referenceExtractor } from "../../../src/domain/references/index.ts";
import { buildSearchEnvironment, searchRuntimeHooks } from "../../../src/domain/searchenv/index.ts";
import { searchWithRuntime } from "../../../src/search/index.ts";
import { createStorage } from "../../../src/storage/adapters.ts";
import { Store } from "../../../src/storage/core/store.ts";
import { dispose, hasGoBin, makeFixtureProject } from "./search-harness.ts";
import { expectParity } from "./search-parity.ts";

const made: ReturnType<typeof makeFixtureProject>[] = [];
afterEach(() => {
  for (const p of made.splice(0)) dispose(p);
});

function open() {
  // storage.config.set cannot be used on an in-repo project: createStorage gives every ConfigStore
  // the personal/machine split that only a store clone should have (reported in the task notes).
  const p = makeFixtureProject("full", (dir) => {
    const path = join(dir, ".knowns", "config.json");
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    cfg.settings.semanticSearch = { enabled: true, model: "m" };
    writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  });
  made.push(p);
  const storage = createStorage(Store.open(join(p.dir, ".knowns")), {
    globalRoot: join(p.home, ".knowns"),
  });
  return { p, storage };
}

describe("buildSearchEnvironment", () => {
  test("reads the embedding registry from the given settings file, lazily", () => {
    const { p } = open();
    const settingsPath = join(p.home, ".knowns", "settings.json");
    mkdirSync(join(p.home, ".knowns"), { recursive: true });
    const env = buildSearchEnvironment({ settingsPath });
    // Missing file: the seeded defaults (never written).
    expect(Object.keys(env.embeddingRegistry().models).length).toBeGreaterThan(0);
    writeFileSync(
      settingsPath,
      JSON.stringify({
        embeddingProviders: { local: { apiBase: "http://127.0.0.1:9/v1" } },
        embeddingModels: {},
      }),
    );
    expect(env.embeddingRegistry().providers.local?.apiBase).toBe("http://127.0.0.1:9/v1");
  });

  test("wires the references adapter from domain/references", () => {
    expect(buildSearchEnvironment().references).toBe(referenceExtractor);
  });

  test("opens the global semantic store once, under the machine root", () => {
    const { p } = open();
    const saved = process.env.HOME;
    process.env.HOME = p.home;
    try {
      const env = buildSearchEnvironment();
      const a = env.globalStorage?.();
      expect(a?.store.root).toBe(join(p.home, ".knowns", "global"));
      expect(env.globalStorage?.()).toBe(a);
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
    }
  });

  test("carries the caller's environment, fetch, sleep and clock through", () => {
    const fetchFn = (() => Promise.reject(new Error("x"))) as unknown as typeof fetch;
    const sleep = async () => {};
    const now = () => 5;
    const env = buildSearchEnvironment({ env: { A: "1" }, fetch: fetchFn, sleep, now });
    expect(env.env).toEqual({ A: "1" });
    expect(env.fetch).toBe(fetchFn);
    expect(env.sleep).toBe(sleep);
    expect(env.now?.()).toBe(5);
  });

  test("queueReindex goes through the runtime-queue hook, which is a no-op until that port lands", async () => {
    const env = buildSearchEnvironment();
    expect(await env.queueReindex?.("/x")).toBeUndefined();
    const seen: string[] = [];
    const original = searchRuntimeHooks.enqueueReindex;
    searchRuntimeHooks.enqueueReindex = (root) => {
      seen.push(root);
    };
    try {
      await env.queueReindex?.("/some/.knowns");
    } finally {
      searchRuntimeHooks.enqueueReindex = original;
    }
    expect(seen).toEqual(["/some/.knowns"]);
  });

  test("a degraded search queues the bootstrap once and says so, like Go", async () => {
    const { p, storage } = open();
    const queued: string[] = [];
    const env = buildSearchEnvironment({
      env: { KNOWNS_SEMANTIC_VECTOR_ENABLED: "1", KNOWNS_QDRANT_URL: "http://127.0.0.1:1" },
      settingsPath: join(p.home, ".knowns", "settings.json"),
      globalStorage: () => undefined,
      queueReindex: (root) => {
        queued.push(root);
      },
    });
    const out = await searchWithRuntime(storage, env, { query: "auth", limit: 5 });
    expect(out.runtime).toMatchObject({
      degraded: true,
      warming: true,
      bootstrapQueued: true,
      message: expect.stringContaining("qdrant bootstrap/reindex queued"),
    });
    await Promise.resolve();
    expect(queued).toEqual([storage.store.root]);
  });
});

const cases = hasGoBin ? describe : describe.skip;

cases("the queue seam keeps Go's notice text without a runtime queue", () => {
  test("unreachable Qdrant, semantic search configured", async () => {
    const env = { KNOWNS_SEMANTIC_VECTOR_ENABLED: "1", KNOWNS_QDRANT_URL: "http://127.0.0.1:1" };
    await expectParity("full", [
      ["config", "set", "embedding", "true"],
      ["config", "set", "settings.semanticSearch.model", "m"],
      { args: ["search", "auth", "--plain"], env },
      { args: ["search", "auth", "--json"], env },
      { args: ["retrieve", "auth", "--json"], env },
    ]);
  });
});
