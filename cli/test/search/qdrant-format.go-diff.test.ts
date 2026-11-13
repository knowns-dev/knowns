// Everything a TypeScript query must agree on with an index written by 0.34.1: point ids,
// pointer-only payloads, collection naming, the store fingerprint, and the exact bytes of
// qdrant.json and qdrant-generations.jsonl.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHUNK_VERSION,
  type Chunk,
  collectionNameFromUUID,
  float32ArrayJson,
  newQdrantPointer,
  type QdrantGenerationRecord,
  type QdrantPointer,
  qdrantPointFromChunk,
  qdrantPointIdForChunkId,
  qdrantPointJson,
  saveQdrantGenerations,
  saveQdrantPointer,
  sourceIdForChunk,
  storeRootFingerprint,
} from "../../src/search/index.ts";
import { cleanup } from "../history/helpers.ts";
import { askGo, hasSearchHelper } from "./search-helper.ts";

const suite = hasSearchHelper() ? describe : describe.skip;
const dirs: string[] = [];
afterAll(() => cleanup(...dirs));

const chunks: Chunk[] = [
  {
    id: "doc:guides/setup:chunk:2",
    type: "doc",
    content: "## Install\n\nRun it.",
    tokenCount: 7,
    docPath: "guides/setup",
    section: "## Install",
    headingLevel: 2,
    headerPath: "Setup/Install",
    position: 2,
  },
  {
    id: "task:FX-1:chunk:description",
    type: "task",
    content: "Implement login\n\nUsers sign in",
    tokenCount: 9,
    taskId: "FX-1",
    field: "description",
    status: "in-progress",
    priority: "high",
    labels: ["auth", "feature"],
  },
  {
    id: "memory:mem1:chunk:content",
    type: "memory",
    content: "Prefer bun [pattern]",
    tokenCount: 5,
    memoryId: "mem1",
    memoryLayer: "global",
    memoryStore: "global",
  },
  {
    id: "decision:20261103-1337-use-bun:chunk:content",
    type: "decision",
    content: "Use bun",
    tokenCount: 2,
    decisionId: "20261103-1337-use-bun",
    status: "accepted",
  },
  { id: "doc:odd<&>path:chunk:0", type: "doc", content: "", tokenCount: 0, docPath: "odd<&>path" },
  { id: "weird", type: "", content: "x", tokenCount: 1 },
  {
    id: "code::src/a.ts::0",
    type: "code",
    content: "fn",
    tokenCount: 1,
    docPath: "src/a.ts",
    name: "fn",
  },
];

suite("qdrant formats against Go", () => {
  test("point ids, source ids and point JSON bytes", () => {
    const vector = [0.1, -0.5, 1e-7, 123456.789, 0.3, 1, 0, 2.5e-9, 16777216, 3.4e38];
    const reqs = chunks.flatMap((c) => [
      { op: "pointID", text: c.id },
      { op: "sourceID", chunk: c },
      { op: "pointJSON", chunk: c, sourceHash: "abc123", vector },
    ]);
    const expected = askGo(reqs);
    chunks.forEach((c, i) => {
      expect(qdrantPointIdForChunkId(c.id), c.id).toBe(expected[i * 3] as string);
      expect(sourceIdForChunk(c), c.id).toBe(expected[i * 3 + 1] as string);
      const point = qdrantPointFromChunk({ ...c, embedding: Float32Array.from(vector) }, "abc123");
      expect(qdrantPointJson(point), c.id).toBe(expected[i * 3 + 2] as string);
    });
  });

  test("float32 digits match json.Marshal([]float32)", () => {
    const values = [
      0.1,
      0.2,
      1 / 3,
      1e-7,
      1e21,
      3.4028234663852886e38,
      16777217,
      -0.000001,
      100,
      1e-45,
      123.456,
      0.5,
      2.5e-9,
    ];
    const goJson = askGo([{ op: "f32json", values }])[0] as string;
    expect(float32ArrayJson(values.map(Math.fround))).toBe(goJson);
  });

  test("collection name and fingerprint", () => {
    const uuid = "8f2c6a7b-91d4-4f6a-b9f7-2ef84d72a9c1";
    const roots = ["/tmp/a/.knowns", "/tmp/a/../b/.knowns/", "/tmp//x/./y"];
    const expected = askGo([
      { op: "collectionName", uuid },
      ...roots.map((root) => ({ op: "fingerprint", root })),
    ]);
    expect(collectionNameFromUUID(uuid)).toBe(expected[0] as string);
    for (const [i, r] of roots.entries()) {
      expect(storeRootFingerprint(r), r).toBe(expected[i + 1] as string);
    }
  });

  test("qdrant.json and qdrant-generations.jsonl bytes", () => {
    const tsRoot = realpathSync(mkdtempSync(join(tmpdir(), "knowns-search-ptr-ts-")));
    const goRoot = realpathSync(mkdtempSync(join(tmpdir(), "knowns-search-ptr-go-")));
    dirs.push(tsRoot, goRoot);
    const pointer: QdrantPointer = {
      ...newQdrantPointer(tsRoot, "proj-1", {
        provider: "ollama",
        model: "nomic-embed-text",
        dimensions: 768,
      }),
      lastIndexedAt: "2026-11-03T13:37:35.500Z",
      chunkCount: 42,
    };
    const records: QdrantGenerationRecord[] = [
      {
        generation: 1,
        collectionUUID: pointer.collectionUUID,
        collectionName: pointer.collectionName,
        schemaVersion: 1,
        chunkVersion: CHUNK_VERSION,
        embedding: pointer.embedding,
        owner: pointer.owner,
        status: "active",
        chunkCount: 42,
        createdAt: "2026-11-03T13:37:35.123456Z",
      },
      {
        generation: 0,
        collectionUUID: "11111111-1111-4111-8111-111111111111",
        collectionName: "kn_11111111111141118111111111111111",
        schemaVersion: 1,
        chunkVersion: 4,
        embedding: { provider: "", model: "m<&>", dimensions: 3 },
        owner: {},
        status: "inactive",
        chunkCount: 0,
        createdAt: "2026-11-02T00:00:00Z",
        swappedAt: "2026-11-03T00:00:00Z",
        retiredAt: "2026-11-03T01:00:00Z",
      },
    ];
    saveQdrantPointer(tsRoot, pointer);
    saveQdrantGenerations(tsRoot, records);
    askGo([
      { op: "savePointer", root: goRoot, pointer },
      { op: "saveGenerations", root: goRoot, records },
    ]);
    for (const f of ["qdrant.json", "qdrant-generations.jsonl"]) {
      expect(readFileSync(join(tsRoot, ".search", f), "utf8"), f).toBe(
        readFileSync(join(goRoot, ".search", f), "utf8"),
      );
    }
  });
});
