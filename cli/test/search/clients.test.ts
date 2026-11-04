// The HTTP clients against local fakes: request shapes, retry policy, error texts, 404 handling,
// batching, URL validation and the Ollama detector's boundary parsing.
import { afterAll, describe, expect, test } from "bun:test";
import {
  APIEmbedder,
  OllamaDetector,
  pathEscape,
  QDRANT_UPSERT_BATCH_SIZE,
  QdrantHttpClient,
  QdrantNotFoundError,
} from "../../src/search/index.ts";

interface Seen {
  method: string;
  path: string;
  query: string;
  body: string;
  headers: Headers;
}

function serve(handler: (req: Request, url: URL, body: string) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      seen.push({
        method: req.method,
        path: url.pathname,
        query: url.search.slice(1),
        body,
        headers: req.headers,
      });
      return handler(req, url, body);
    },
  });
  return { seen, base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const servers: { stop: () => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop();
});
function fake(handler: Parameters<typeof serve>[0]) {
  const s = serve(handler);
  servers.push(s);
  return s;
}

describe("APIEmbedder", () => {
  const cfg = (base: string, extra = {}) => ({
    apiBase: `${base}/v1`,
    model: "m",
    dimensions: 3,
    retry: { maxRetries: 2, initialDelay: 10, maxDelay: 25 },
    ...extra,
  });

  test("posts model and input to /v1/embeddings, prefixes by side, sorts by index", async () => {
    const s = fake(() =>
      Response.json({
        data: [
          { index: 1, embedding: [4, 5, 6] },
          { index: 0, embedding: [1, 2, 3] },
        ],
      }),
    );
    const e = new APIEmbedder(cfg(s.base, { apiKey: "k", queryPrefix: "q: ", docPrefix: "d: " }));
    const q = await e.embedQuery("hi");
    expect([...q]).toEqual([1, 2, 3]); // data sorted by index
    expect(s.seen[0]?.path).toBe("/v1/embeddings");
    expect(s.seen[0]?.body).toBe('{"model":"m","input":["q: hi"]}');
    expect(s.seen[0]?.headers.get("authorization")).toBe("Bearer k");
    await e.embedDocument("doc");
    expect(s.seen[1]?.body).toBe('{"model":"m","input":["d: doc"]}');
  });

  test("an apiBase already ending in /embeddings is used as is", async () => {
    const s = fake(() => Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
    await new APIEmbedder(cfg(s.base, { apiBase: `${s.base}/custom/embeddings` })).embed("x");
    expect(s.seen[0]?.path).toBe("/custom/embeddings");
  });

  test("batches by size and returns vectors in the original order", async () => {
    const s = fake((_r, _u, body) => {
      const input = (JSON.parse(body) as { input: string[] }).input;
      return Response.json({
        data: input.map((t, i) => ({ index: i, embedding: [t.length, 0, 0] })),
      });
    });
    const e = new APIEmbedder(cfg(s.base, { batchSize: 2 }));
    const out = await e.embedDocumentBatch(["ccc", "a", "bb", "dddd", "e"]);
    expect(out.map((v) => v[0])).toEqual([3, 1, 2, 4, 1]);
    expect(s.seen).toHaveLength(3);
  });

  test("429 and 5xx are retried with exponential backoff, then reported with Go's text", async () => {
    const sleeps: number[] = [];
    const s = fake(() => new Response("overloaded", { status: 503 }));
    const e = new APIEmbedder(cfg(s.base), { sleep: async (ms) => void sleeps.push(ms) });
    await expect(e.embedQuery("x")).rejects.toThrow(
      "embedding API failed after 2 retries: server error (HTTP 503): overloaded",
    );
    expect(s.seen).toHaveLength(3);
    expect(sleeps).toEqual([10, 20]);

    const limited = fake(() => new Response("", { status: 429 }));
    await expect(
      new APIEmbedder(cfg(limited.base), { sleep: async () => {} }).embedQuery("x"),
    ).rejects.toThrow("embedding API failed after 2 retries: rate limited (HTTP 429)");
  });

  test("other 4xx are not retried and a recovery on retry succeeds", async () => {
    const bad = fake(() => new Response("nope", { status: 404 }));
    await expect(new APIEmbedder(cfg(bad.base)).embedQuery("x")).rejects.toThrow(
      "API error (HTTP 404): nope",
    );
    expect(bad.seen).toHaveLength(1);

    let n = 0;
    const flaky = fake(() =>
      ++n < 2
        ? new Response("", { status: 500 })
        : Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
    );
    const v = await new APIEmbedder(cfg(flaky.base), { sleep: async () => {} }).embedQuery("x");
    expect([...v]).toEqual([1, 2, 3]);
  });

  test("error bodies are truncated at 200 bytes and a malformed body is a parse error", async () => {
    const long = fake(() => new Response("x".repeat(500), { status: 400 }));
    await expect(new APIEmbedder(cfg(long.base)).embedQuery("x")).rejects.toThrow(
      `API error (HTTP 400): ${"x".repeat(200)}...`,
    );
    const junk = fake(() => new Response("{not json", { status: 200 }));
    await expect(new APIEmbedder(cfg(junk.base)).embedQuery("x")).rejects.toThrow(
      /^parse response:/,
    );
  });

  test("validation and model config", () => {
    expect(() => new APIEmbedder({ apiBase: "", model: "m", dimensions: 1 })).toThrow(
      "apiBase is required",
    );
    expect(() => new APIEmbedder({ apiBase: "http://x", model: "", dimensions: 1 })).toThrow(
      "model is required",
    );
    expect(() => new APIEmbedder({ apiBase: "http://x", model: "m", dimensions: 0 })).toThrow(
      "dimensions must be positive",
    );
    const e = new APIEmbedder({ apiBase: "http://x", model: "m", dimensions: 3 });
    expect(e.modelConfig().maxTokens).toBe(512); // the conservative default
    expect(
      new APIEmbedder({
        apiBase: "http://x",
        model: "m",
        dimensions: 3,
        maxTokens: 8192,
      }).modelConfig().maxTokens,
    ).toBe(8192);
  });
});

describe("QdrantHttpClient", () => {
  test("URL validation matches the Go client", () => {
    expect(() => new QdrantHttpClient({ url: "" })).toThrow("qdrant url is required");
    expect(() => new QdrantHttpClient({ url: "localhost:6333" })).toThrow();
    expect(() => new QdrantHttpClient({ url: "http://user:pw@127.0.0.1:6333" })).toThrow(
      "qdrant url must not contain credentials, query secrets, or fragments",
    );
    expect(() => new QdrantHttpClient({ url: "http://127.0.0.1:6333?key=x" })).toThrow(
      "qdrant url must not contain credentials, query secrets, or fragments",
    );
    expect(() => new QdrantHttpClient({ url: "http://qdrant.example.com:6333" })).toThrow(
      "non-loopback Qdrant endpoints require HTTPS",
    );
    for (const ok of [
      "http://127.0.0.1:6333",
      "http://localhost:6333/",
      "http://[::1]:6333",
      "https://q.example.com",
    ]) {
      expect(() => new QdrantHttpClient({ url: ok })).not.toThrow();
    }
  });

  test("path segments are escaped like url.PathEscape", () => {
    expect(pathEscape("kn_abc")).toBe("kn_abc");
    expect(pathEscape("a b/c")).toBe("a%20b%2Fc");
    expect(pathEscape("a:b@c+d=e&f$g")).toBe("a:b@c+d=e&f$g");
    expect(pathEscape("é!")).toBe("%C3%A9%21");
  });

  test("exists/inspect/count and 404 mapping", async () => {
    const s = fake((req, url) => {
      if (url.pathname === "/collections/kn_a/exists")
        return Response.json({ result: { exists: true } });
      if (url.pathname === "/collections/kn_a") {
        return Response.json({
          result: {
            status: "green",
            points_count: 7,
            config: { params: { vectors: { size: 384, distance: "Cosine" } } },
          },
        });
      }
      if (url.pathname === "/collections/kn_named") {
        return Response.json({
          result: {
            status: "green",
            points_count: null,
            config: { params: { vectors: { dense: { size: 8, distance: "Dot" } } } },
          },
        });
      }
      if (url.pathname === "/collections/kn_named/exists")
        return Response.json({ result: { exists: true } });
      if (url.pathname === "/collections/kn_a/points/count")
        return Response.json({ result: { count: 7 } });
      if (req.method === "DELETE") return new Response("", { status: 404 });
      return new Response("{}", { status: 404 });
    });
    const c = new QdrantHttpClient({ url: s.base, apiKey: "secret" });
    expect(await c.collectionExists("kn_a")).toBe(true);
    expect(await c.collectionExists("kn_missing")).toBe(false);
    expect(await c.inspectCollection("kn_a")).toEqual({
      name: "kn_a",
      exists: true,
      dimensions: 384,
      distance: "cosine",
      status: "green",
      pointsCount: 7,
    });
    expect(await c.inspectCollection("kn_named")).toMatchObject({
      dimensions: 8,
      distance: "dot",
      pointsCount: 0,
    });
    expect((await c.inspectCollection("kn_missing")).exists).toBe(false);
    expect(await c.countPoints("kn_a")).toBe(7);
    expect(s.seen.find((x) => x.path.endsWith("/count"))?.body).toBe('{"exact":true}');
    expect(s.seen[0]?.headers.get("api-key")).toBe("secret");
    await c.deleteCollection("kn_gone"); // missing counts as deleted
    await expect(c.countPoints("kn_missing")).rejects.toBeInstanceOf(QdrantNotFoundError);
  });

  test("non-2xx errors carry the method, path, status and body", async () => {
    const s = fake(() => new Response("  bad things  ", { status: 500 }));
    const c = new QdrantHttpClient({ url: s.base });
    await expect(c.countPoints("kn_a")).rejects.toThrow(
      "qdrant POST /collections/kn_a/points/count: status 500: bad things",
    );
  });

  test("a response that is not the documented shape is a decode error", async () => {
    const s = fake(() => Response.json({ result: { count: "many" } }));
    await expect(new QdrantHttpClient({ url: s.base }).countPoints("kn_a")).rejects.toThrow(
      /^decode qdrant response:/,
    );
  });

  test("upserts go out in batches of 256 with wait=true", async () => {
    const s = fake(() => Response.json({ result: {} }));
    const c = new QdrantHttpClient({ url: s.base });
    const points = Array.from({ length: QDRANT_UPSERT_BATCH_SIZE * 2 + 5 }, (_, i) => ({
      id: `id-${i}`,
      vector: Float32Array.of(0.1, 0.2),
      payload: { z: 1, a: "x" },
    }));
    await c.upsertPoints("kn_a", points);
    expect(s.seen).toHaveLength(3);
    expect(s.seen.every((x) => x.method === "PUT" && x.query === "wait=true")).toBe(true);
    expect((JSON.parse(s.seen[2]?.body ?? "{}") as { points: unknown[] }).points).toHaveLength(5);
    expect(
      s.seen[0]?.body.startsWith(
        '{"points":[{"id":"id-0","vector":[0.1,0.2],"payload":{"a":"x","z":1}}',
      ),
    ).toBe(true);
  });

  test("search sends the vector with float32 digits, limit, filter and threshold", async () => {
    const s = fake(() =>
      Response.json({
        result: [
          {
            id: "u",
            score: 0.9,
            payload: { chunk_id: "doc:a:chunk:1", type: "doc", doc_path: "a" },
          },
        ],
      }),
    );
    const c = new QdrantHttpClient({ url: s.base });
    const hits = await c.query("kn_a", Float32Array.of(0.1, -0.25), {
      topK: 7,
      threshold: 0.3,
      chunkType: "doc",
    });
    expect(s.seen[0]?.body).toBe(
      '{"vector":[0.1,-0.25],"limit":7,"with_payload":true,"filter":{"must":[{"key":"type","match":{"value":"doc"}}]},"score_threshold":0.3}',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "doc:a:chunk:1", docPath: "a", score: 0.9 });
    await c.query("kn_a", Float32Array.of(1), { topK: 0, threshold: 0 });
    expect(s.seen[1]?.body).toBe('{"vector":[1],"limit":20,"with_payload":true}');
    await expect(c.query("kn_a", new Float32Array(0), { topK: 1, threshold: 0 })).rejects.toThrow(
      "query vector is required",
    );
  });
});

describe("OllamaDetector", () => {
  test("version, models and embedding dimensions", async () => {
    const s = fake((_req, url, body) => {
      if (url.pathname === "/api/version") return Response.json({ version: "0.40.13" });
      if (url.pathname === "/api/tags") {
        return Response.json({
          models: [
            { name: "nomic-embed-text:latest", size: 5 },
            { name: "llama3:8b", size: 9 },
          ],
        });
      }
      if (url.pathname === "/api/show") {
        const name = (JSON.parse(body) as { name: string }).name;
        return name.startsWith("nomic")
          ? Response.json({ model_info: { "nomic-bert.embedding_length": 768 }, details: {} })
          : Response.json({
              model_info: { "llama.context_length": 8192 },
              template: "{{ .Prompt }}",
            });
      }
      return new Response("", { status: 404 });
    });
    const d = new OllamaDetector(s.base);
    expect(await d.isRunning()).toEqual({ running: true, version: "0.40.13" });
    expect(await d.listEmbeddingModels()).toEqual([
      { name: "nomic-embed-text:latest", shortName: "nomic-embed-text", dimensions: 768, size: 5 },
    ]);
    expect(await new OllamaDetector("http://127.0.0.1:9").isRunning()).toEqual({
      running: false,
      version: "",
    });
    expect(d.getEmbeddingDimensions({ model_info: { "general.embedding_length": 384 } })).toBe(384);
    expect(d.getEmbeddingDimensions(undefined)).toBe(0);
    await expect(new OllamaDetector(`${s.base}/nowhere`).listModels()).rejects.toThrow(/HTTP 404/);
  });
});
