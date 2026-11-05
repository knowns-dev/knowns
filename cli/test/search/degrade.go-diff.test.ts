// AC-4: when the embedder or the vector store fails, search returns the keyword results with the
// degraded notice 0.34.1 prints. Each scenario runs the real Go binary and the TypeScript library
// over the same project and compares the JSON byte for byte. The services are local fakes (and
// closed ports), so this needs only a Go binary.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { CONNECTION_REFUSED } from "../../src/platform/goerror.ts";
import {
  newQdrantPointer,
  retrieveWithRuntime,
  type SearchEnvironment,
  saveQdrantPointer,
  searchWithRuntime,
} from "../../src/search/index.ts";
import { createStorage, type Storage } from "../../src/storage/adapters.ts";
import { Store } from "../../src/storage/core/store.ts";
import { EmbeddingSettingsStore } from "../../src/storage/stores/index.ts";
import { hasGo } from "../history/helpers.ts";
import { buildCorpus, type GoProject, newGoProject } from "./go-corpus.ts";
import { writeRegistry } from "./live.ts";

const suite = hasGo() ? describe : describe.skip;

const DIMS = 384;
const vector = Array.from({ length: DIMS }, () => 0.1);

function closedPort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  s.stop(true);
  return port;
}

type Handler = (req: Request, path: string) => Response | Promise<Response>;

suite("degraded search against Go 0.34.1", () => {
  let go: GoProject;
  let storage: Storage;
  let handler: Handler = () => new Response("unset", { status: 599 });
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  let qdrantBase = "";
  let currentQdrant = "";

  beforeAll(() => {
    go = newGoProject();
    buildCorpus(go, 5);
    server = Bun.serve({
      port: 0,
      fetch: (req) => handler(req, new URL(req.url).pathname),
    });
    base = `http://127.0.0.1:${server.port}`;
    qdrantBase = base;
    const knowns = join(go.project, ".knowns");
    for (const [k, v] of [
      ["settings.semanticSearch.enabled", "true"],
      ["settings.semanticSearch.provider", "ollama"],
      ["settings.semanticSearch.model", "all-minilm"],
    ] as const) {
      const r = go.run(["config", "set", k, v, "--plain"], {
        KNOWNS_SEMANTIC_RUNTIME_DISABLED: "1",
      });
      if (r.code !== 0) throw new Error(r.stderr);
    }
    rmSync(join(knowns, "history", "state", "qdrant-index-watermarks.json"), { force: true });
    storage = createStorage(Store.open(knowns), { globalRoot: join(go.home, ".knowns") });
    const pointer = {
      ...newQdrantPointer(knowns, "diff", {
        provider: "ollama",
        model: "all-minilm",
        dimensions: DIMS,
      }),
      lastIndexedAt: "2026-11-03T18:38:11.463273Z",
      chunkCount: 10,
    };
    saveQdrantPointer(knowns, pointer);
  }, 120_000);

  afterAll(() => {
    server?.stop(true);
    rmSync(join(go.project, ".."), { recursive: true, force: true });
  });

  const useServices = (ollama: string, qdrant: string) => {
    currentQdrant = qdrant;
    writeRegistry(go.home, ollama);
  };

  const tsEnv = (): SearchEnvironment => {
    const registry = new EmbeddingSettingsStore(join(go.home, ".knowns", "settings.json"));
    return {
      embeddingRegistry: () => registry.load(),
      env: { KNOWNS_QDRANT_URL: currentQdrant, KNOWNS_SEMANTIC_VECTOR_ENABLED: "1" },
      sleep: async () => {},
      queueReindex: () => {},
    };
  };

  const goJson = async (args: string[]) => {
    const r = await go.runAsync([...args, "--json"], {
      KNOWNS_QDRANT_URL: currentQdrant,
      KNOWNS_SEMANTIC_VECTOR_ENABLED: "1",
    });
    expect(r.code, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  };

  async function compare(query: string) {
    const search = await searchWithRuntime(storage, tsEnv(), {
      query,
      type: "",
      mode: "hybrid",
      limit: 20,
    });
    expect(search.runtime?.degraded).toBe(true);
    expect(JSON.stringify(search.results, null, 2)).toBe(
      JSON.stringify(await goJson(["search", query]), null, 2),
    );
    const { response, runtime } = await retrieveWithRuntime(storage, tsEnv(), {
      query,
      mode: "hybrid",
      limit: 20,
    });
    expect(JSON.stringify({ ...response, _runtime: runtime }, null, 2)).toBe(
      JSON.stringify(await goJson(["retrieve", query]), null, 2),
    );
    return search.runtime?.message ?? "";
  }

  test("embedder answers HTTP 500: retried, then degraded", async () => {
    handler = (_req, path) =>
      path === "/v1/embeddings"
        ? new Response("boom", { status: 500 })
        : new Response("", { status: 404 });
    useServices(base, qdrantBase);
    const message = await compare("vector embedding model");
    expect(message).toBe(
      "semantic runtime unavailable; returned keyword results only: embed query: semantic search unavailable: " +
        "embedding API failed after 1 retries: server error (HTTP 500): boom; qdrant bootstrap/reindex queued",
    );
  });

  test("embedder answers HTTP 429: retried, then degraded", async () => {
    handler = (_req, path) =>
      path === "/v1/embeddings"
        ? new Response("slow down", { status: 429 })
        : new Response("", { status: 404 });
    useServices(base, qdrantBase);
    expect(await compare("login")).toContain(
      "embedding API failed after 1 retries: rate limited (HTTP 429)",
    );
  });

  test("embedder answers HTTP 400: not retried", async () => {
    handler = (_req, path) =>
      path === "/v1/embeddings"
        ? new Response('{"error":"model not found"}', { status: 400 })
        : new Response("", { status: 404 });
    useServices(base, qdrantBase);
    expect(await compare("login")).toContain('API error (HTTP 400): {"error":"model not found"}');
  });

  test("embedder unreachable (connection refused)", async () => {
    const dead = `http://127.0.0.1:${closedPort()}`;
    useServices(dead, qdrantBase);
    const message = await compare("deploy");
    expect(message).toContain(CONNECTION_REFUSED);
  });

  test("embedder fine, Qdrant answers HTTP 500", async () => {
    handler = (_req, path) => {
      if (path === "/v1/embeddings") {
        return Response.json({ data: [{ index: 0, embedding: vector }] });
      }
      return new Response("qdrant down", { status: 500 });
    };
    useServices(base, qdrantBase);
    const message = await compare("password reset email");
    expect(message).toContain(
      "semantic vector query failed: semantic search unavailable: qdrant POST /collections/",
    );
    expect(message).toContain("status 500: qdrant down");
  });

  test("embedder fine, Qdrant unreachable", async () => {
    handler = (_req, path) =>
      path === "/v1/embeddings"
        ? Response.json({ data: [{ index: 0, embedding: vector }] })
        : new Response("", { status: 404 });
    useServices(base, `http://127.0.0.1:${closedPort()}`);
    const message = await compare("deploy rollback");
    expect(message).toContain(CONNECTION_REFUSED);
  });

  test("no index pointer: the index is reported empty", async () => {
    const knowns = join(go.project, ".knowns");
    const path = join(knowns, ".search", "qdrant.json");
    const saved = await Bun.file(path).text();
    rmSync(path);
    try {
      useServices(base, qdrantBase);
      const message = await compare("login");
      expect(message).toBe(
        "semantic runtime unavailable; returned keyword results only: semantic index is empty or unavailable; qdrant bootstrap/reindex queued",
      );
    } finally {
      await Bun.write(path, saved);
    }
  });

  test("semantic mode: a failing embedder degrades, a missing index is an error", async () => {
    handler = () => new Response("boom", { status: 500 });
    useServices(base, qdrantBase);
    const degraded = await searchWithRuntime(storage, tsEnv(), {
      query: "login",
      type: "",
      mode: "semantic",
      limit: 5,
    });
    expect(degraded.runtime?.degraded).toBe(true);
    expect(degraded.results.length).toBeGreaterThan(0);

    const path = join(go.project, ".knowns", ".search", "qdrant.json");
    const saved = await Bun.file(path).text();
    rmSync(path);
    try {
      await expect(
        searchWithRuntime(storage, tsEnv(), {
          query: "login",
          type: "",
          mode: "semantic",
          limit: 5,
        }),
      ).rejects.toThrow(
        "semantic runtime unavailable; qdrant bootstrap/reindex queued: semantic index is empty or unavailable",
      );
    } finally {
      await Bun.write(path, saved);
    }
  });

  test("keyword mode never touches the services", async () => {
    let hits = 0;
    handler = () => {
      hits++;
      return new Response("", { status: 500 });
    };
    useServices(base, qdrantBase);
    const out = await searchWithRuntime(storage, tsEnv(), {
      query: "login",
      type: "",
      mode: "keyword",
      limit: 5,
    });
    expect(out.runtime).toBeUndefined();
    expect(hits).toBe(0);
  });
});
