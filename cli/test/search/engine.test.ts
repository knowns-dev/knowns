// Engine behaviour with in-memory embedder and vector store fakes over a copy of the Go-written
// `full` fixture: fusion, aggregation, boosts, filters, visibility, and failure classification.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Chunk,
  type EmbedderProvider,
  Engine,
  fusedMultiplyAddEnabled,
  type MemorySemanticStore,
  type ScoredChunk,
  SemanticUnavailableError,
  setFusedMultiplyAdd,
  type VectorSearchOpts,
  type VectorStore,
} from "../../src/search/index.ts";
import { fixtureId } from "../helpers/fixtures.ts";
import { cleanup, openFixture } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => cleanup(...dirs));
const hostFused = fusedMultiplyAddEnabled();
beforeAll(() => setFusedMultiplyAdd(false)); // exact arithmetic in the expectations below
afterAll(() => setFusedMultiplyAdd(hostFused));

function open() {
  const f = openFixture("full");
  dirs.push(f.dir.replace(/\/project$/, ""));
  return f;
}

class FakeEmbedder implements EmbedderProvider {
  queries: string[] = [];
  constructor(private readonly fail?: Error) {}
  async embedQuery(text: string) {
    this.queries.push(text);
    if (this.fail) throw this.fail;
    return Float32Array.of(1, 0);
  }
  embed = this.embedQuery;
  embedDocument = this.embedQuery;
  async embedBatch() {
    return [];
  }
  embedDocumentBatch = this.embedBatch;
  embedQueryBatch = this.embedBatch;
  dimensions = () => 2;
  modelConfig = () => ({ name: "fake", dimensions: 2, maxTokens: 512 });
  getTokenizer = () => undefined;
  close() {}
}

class FakeVectors implements VectorStore {
  calls: VectorSearchOpts[] = [];
  err: Error | undefined;
  constructor(
    private readonly hits: ScoredChunk[],
    private readonly total = 10,
  ) {}
  async search(_v: Float32Array, opts: VectorSearchOpts) {
    this.calls.push(opts);
    return this.hits.filter((h) => !opts.chunkType || h.type === opts.chunkType);
  }
  count = () => this.total;
  needsRebuild = () => false;
  stats = () => ({ chunkCount: this.total, model: "fake", indexedAt: undefined });
  model = () => "fake";
  close() {}
  lastSearchError = () => this.err;
}

const docChunk = (path: string, score: number, extra: Partial<Chunk> = {}): ScoredChunk => ({
  id: `doc:${path}:chunk:1`,
  type: "doc",
  content: "",
  tokenCount: 1,
  docPath: path,
  section: "## Section",
  score,
  ...extra,
});

describe("hybrid search", () => {
  test("fuses keyword and semantic legs with reciprocal rank fusion", async () => {
    const f = open();
    const vectors = new FakeVectors([
      docChunk("architecture", 0.8),
      docChunk("guides/setup-guide", 0.6),
    ]);
    const engine = new Engine({
      storage: f.storage,
      embedder: new FakeEmbedder(),
      vecStore: vectors,
      now: () => Date.parse("2030-01-01T00:00:00Z"), // far past every updatedAt: no recency bonus
    });
    const results = await engine.search({ query: "architecture", type: "doc", mode: "hybrid" });
    const arch = results.find((r) => r.id === "architecture");
    const guide = results.find((r) => r.id === "guides/setup-guide");
    expect(arch?.matchedBy).toEqual(["semantic", "keyword"]);
    expect(arch?.semanticScore).toBeCloseTo(0.8, 6);
    expect(guide?.matchedBy).toEqual(["semantic"]);
    expect(results[0]?.id).toBe("architecture");
    expect(results[0]?.score).toBe(1); // renormalized so the best result is exactly 1
    for (const r of results) expect(r.score).toBeLessThanOrEqual(1);
    // the vector store was asked for doc chunks only, above the 0.3 cosine threshold
    expect(vectors.calls[0]).toMatchObject({ chunkType: "doc", threshold: 0.3, topK: 20 * 2 });
  });

  test("a source scores its best chunk plus a tenth of the next two", async () => {
    const f = open();
    const vectors = new FakeVectors([
      docChunk("architecture", 0.5),
      docChunk("architecture", 0.9, { id: "doc:architecture:chunk:2", section: "## Best" }),
      docChunk("architecture", 0.7, { id: "doc:architecture:chunk:3" }),
      docChunk("architecture", 0.4, { id: "doc:architecture:chunk:4" }),
    ]);
    const engine = new Engine({
      storage: f.storage,
      embedder: new FakeEmbedder(),
      vecStore: vectors,
    });
    const [hit] = await engine.search({ query: "zzzz", type: "doc", mode: "semantic" });
    expect(hit?.id).toBe("architecture");
    expect(hit?.score).toBeCloseTo(0.9 + 0.7 * 0.1 + 0.5 * 0.1, 12);
    expect(hit?.semanticScore).toBeCloseTo(0.9, 6); // best raw cosine, without the bonus
    expect(hit?.snippet).toBe("## Best"); // the best chunk's section
  });

  test("heading path matching boosts a doc chunk by up to 15%", async () => {
    const f = open();
    const vectors = new FakeVectors([
      docChunk("architecture", 0.5, { headerPath: "Setup/Install" }),
      docChunk("guides/setup-guide", 0.5, { headerPath: "Other" }),
    ]);
    const engine = new Engine({
      storage: f.storage,
      embedder: new FakeEmbedder(),
      vecStore: vectors,
    });
    const results = await engine.search({ query: "setup install", type: "doc", mode: "semantic" });
    expect(results.find((r) => r.id === "architecture")?.score).toBeCloseTo(0.5 + 0.15, 12);
    expect(results.find((r) => r.id === "guides/setup-guide")?.score).toBeCloseTo(0.5, 12);
    expect(results[0]?.id).toBe("architecture");
  });

  test("hits for entities that no longer exist or are filtered out are dropped", async () => {
    const f = open();
    const rich = fixtureId("full", "task.rich");
    const vectors = new FakeVectors([
      {
        id: "task:GONE-1:chunk:description",
        type: "task",
        content: "",
        tokenCount: 1,
        taskId: "GONE-1",
        score: 0.9,
      },
      {
        id: `task:${rich}:chunk:description`,
        type: "task",
        content: "",
        tokenCount: 1,
        taskId: rich,
        score: 0.8,
      },
    ]);
    const engine = new Engine({
      storage: f.storage,
      embedder: new FakeEmbedder(),
      vecStore: vectors,
    });
    const results = await engine.search({ query: "zzzz", type: "task", mode: "semantic" });
    expect(results.map((r) => r.id)).toEqual([rich]);
    const filtered = await engine.search({
      query: "zzzz",
      type: "task",
      mode: "semantic",
      status: "blocked",
    });
    expect(filtered).toEqual([]);
  });
});

describe("failure classification (Locked Decision D3)", () => {
  test("an embedder failure degrades hybrid to keyword results and says why", async () => {
    const f = open();
    const engine = new Engine({
      storage: f.storage,
      embedder: new FakeEmbedder(new Error("connection refused")),
      vecStore: new FakeVectors([]),
    });
    const out = await engine.searchWithDegradation({ query: "login", mode: "hybrid" });
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results.every((r) => r.matchedBy?.join() === "keyword")).toBe(true);
    expect(out.degraded?.err).toBeInstanceOf(SemanticUnavailableError);
    expect(out.degraded?.err.message).toBe(
      "embed query: semantic search unavailable: connection refused",
    );
  });

  test("a failing vector query degrades semantic mode to keyword results", async () => {
    const f = open();
    const vectors = new FakeVectors([]);
    vectors.err = new Error("qdrant POST /x: status 500: down");
    const engine = new Engine({
      storage: f.storage,
      embedder: new FakeEmbedder(),
      vecStore: vectors,
    });
    const out = await engine.searchWithDegradation({ query: "login", mode: "semantic" });
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.degraded?.err.message).toBe(
      "semantic vector query failed: semantic search unavailable: qdrant POST /x: status 500: down",
    );
  });

  test("an error that is not an embedder-boundary failure is not swallowed", async () => {
    const f = open();
    const engine = new Engine({
      storage: f.storage,
      embedder: new FakeEmbedder(),
      vecStore: new FakeVectors([]),
    });
    f.storage.docs.list = () => {
      throw new Error("disk on fire");
    };
    await expect(engine.search({ query: "login", mode: "keyword" })).rejects.toThrow(
      "disk on fire",
    );
  });

  test("an empty vector store means keyword mode, silently", async () => {
    const f = open();
    const engine = new Engine({
      storage: f.storage,
      embedder: new FakeEmbedder(),
      vecStore: new FakeVectors([], 0),
    });
    const out = await engine.searchWithDegradation({ query: "login", mode: "hybrid" });
    expect(out.degraded).toBeUndefined();
    expect(out.results.length).toBeGreaterThan(0);
  });
});

describe("task lifecycle visibility", () => {
  test("retrieval hides done tasks by default; includeHistorical shows done and archived, active first", async () => {
    const f = open();
    const engine = new Engine({ storage: f.storage });
    const archived = fixtureId("full", "task.archived");
    const human = await engine.search({ query: "parent epic", type: "task", mode: "keyword" });
    expect(human.map((r) => r.id)).not.toContain(archived); // archived is never in human search
    const historical = await engine.search({
      query: "child parent epic",
      type: "task",
      mode: "keyword",
      includeHistorical: true,
    });
    expect(historical.map((r) => r.id)).toContain(archived);
    const states = historical.map((r) => r.lifecycleState);
    const rank = { active: 0, done: 1, archived: 2 } as const;
    const ranks = states.map((s) => rank[s as keyof typeof rank]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

    const retrieved = await engine.retrieve({
      query: "login flow",
      mode: "keyword",
      sourceTypes: ["task"],
    });
    expect((retrieved.candidates ?? []).every((c) => c.lifecycleState === "active")).toBe(true);
  });
});

describe("memory semantic search", () => {
  test("semantic memory hits come from the project and global stores and are labelled", async () => {
    const f = open();
    const memId = fixtureId("full", "memory.preference");
    const memory = (layer: string, store: string): MemorySemanticStore => ({
      memoryLayer: layer,
      storeName: store,
      close() {},
      engine: new Engine({
        storage: f.storage,
        embedder: new FakeEmbedder(),
        vecStore: new FakeVectors([
          {
            id: `memory:${memId}:chunk:content`,
            type: "memory",
            content: "",
            tokenCount: 1,
            memoryId: memId,
            memoryLayer: "project",
            score: layer === "project" ? 0.9 : 0.5,
          },
        ]),
      }),
    });
    const engine = new Engine({
      storage: f.storage,
      memorySemantic: async () => [
        memory("project", "project-store"),
        memory("global", "global-store"),
      ],
    });
    const results = await engine.search({ query: "zzzz", type: "memory", mode: "semantic" });
    expect(results.map((r) => `${r.id}/${r.memoryStore}`)).toEqual([
      `${memId}/project-store`,
      `${memId}/global-store`,
    ]);
    expect(results[0]?.matchedBy).toEqual(["semantic"]);
  });
});

describe("retrieval", () => {
  const extractor = (refs: Record<string, [string, string][]>) => ({
    extract: (content: string) =>
      Object.entries(refs)
        .filter(([needle]) => content.includes(needle))
        .flatMap(([, list]) => list)
        .map(([type, target]) => ({
          raw: `@${type}/${target}`,
          canonical: `@${type}/${target}`,
          type,
          target,
          relation: "references",
          validRelation: true,
        })),
  });

  test("candidates carry citations, sort docs before decisions before tasks, and fill a context pack", async () => {
    const f = open();
    const engine = new Engine({ storage: f.storage });
    const res = await engine.retrieve({ query: "architecture", mode: "keyword" });
    expect(res.mode).toBe("keyword");
    const first = res.candidates?.[0];
    expect(first).toMatchObject({
      type: "doc",
      id: "architecture",
      directMatch: true,
      sourcePreference: 0,
      citation: { type: "doc", id: "architecture", path: "architecture" },
    });
    const item = res.contextPack.items?.[0];
    expect(item?.content.startsWith("Architecture")).toBe(true);
    expect(res.contextPack.mode).toBe("docs-first");
    const prefs = (res.candidates ?? []).map((c) => c.sourcePreference);
    expect(prefs).toEqual([...prefs].sort((a, b) => a - b));
  });

  test("expanding references adds linked sources at half score, marked as expanded", async () => {
    const f = open();
    const rich = fixtureId("full", "task.plain");
    const engine = new Engine({
      storage: f.storage,
      references: extractor({ Overview: [["task", rich]] }),
    });
    const res = await engine.retrieve({
      query: "architecture",
      mode: "keyword",
      expandReferences: true,
    });
    const direct = res.candidates?.find((c) => c.id === "architecture");
    const expanded = res.candidates?.find((c) => c.id === rich);
    expect(expanded).toMatchObject({
      type: "task",
      directMatch: false,
      expandedFrom: ["doc:architecture"],
      citation: { type: "task", id: rich },
    });
    expect(expanded?.score).toBe((direct?.score ?? 0) * 0.5);
  });

  test("expanding references without an extractor fails loudly", async () => {
    const f = open();
    await expect(
      new Engine({ storage: f.storage }).retrieve({
        query: "architecture",
        mode: "keyword",
        expandReferences: true,
      }),
    ).rejects.toThrow("reference extractor");
  });
});
