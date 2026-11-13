// Index readiness and hit validation: when a Go-written index may be used, and when a hit must be
// dropped because its source changed.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHUNK_VERSION,
  contentHash,
  loadQdrantGenerations,
  loadQdrantPointer,
  newQdrantPointer,
  type QdrantPointer,
  qdrantEntityReadinessForStore,
  resolveSemanticIndexReadiness,
  saveQdrantGenerations,
  saveQdrantPointer,
  validateQdrantHitPayload,
} from "../../src/search/index.ts";
import { fixtureId } from "../helpers/fixtures.ts";
import { cleanup, openFixture } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => cleanup(...dirs));

function project() {
  const f = openFixture("full", { KNOWNS_SEMANTIC_RUNTIME_DISABLED: "" });
  dirs.push(f.dir.replace(/\/project$/, ""));
  const root = f.storage.store.root;
  rmSync(join(root, "history", "state", "qdrant-index-watermarks.json"), { force: true });
  const configPath = join(root, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    settings: Record<string, unknown>;
  };
  config.settings.semanticSearch = { enabled: true, provider: "ollama", model: "all-minilm" };
  writeFileSync(configPath, JSON.stringify(config));
  const pointer = (extra: Partial<QdrantPointer> = {}): QdrantPointer => ({
    ...newQdrantPointer(root, "p", { provider: "ollama", model: "all-minilm", dimensions: 384 }),
    chunkCount: 9,
    lastIndexedAt: "2026-11-03T00:00:00Z",
    ...extra,
  });
  return { ...f, root, pointer };
}

describe("Qdrant readiness", () => {
  test("a current pointer is ready", () => {
    const p = project();
    saveQdrantPointer(p.root, p.pointer());
    const r = resolveSemanticIndexReadiness(p.storage, p.env);
    expect(r).toMatchObject({ ready: true, backend: "qdrant", model: "all-minilm", chunkCount: 9 });
  });

  const stale: [string, (root: string) => Partial<QdrantPointer>, RegExp][] = [
    [
      "a different model",
      () => ({ embedding: { provider: "ollama", model: "other", dimensions: 384 } }),
      /model "other" != configured model "all-minilm"/,
    ],
    [
      "different dimensions",
      () => ({ embedding: { provider: "ollama", model: "all-minilm", dimensions: 768 } }),
      /dimensions 768 != configured dimensions 384/,
    ],
    [
      "an old chunk version",
      () => ({ chunkVersion: CHUNK_VERSION - 1 }),
      /chunk version 4 != current chunk version 5/,
    ],
    [
      "another store's fingerprint",
      () => ({ owner: { projectId: "p", storeRootFingerprint: "sha256:00" } }),
      /owner fingerprint mismatch/,
    ],
    ["a newer schema", () => ({ schemaVersion: 2 }), /schema version = 2, want 1/],
  ];
  for (const [name, change, reason] of stale) {
    test(`${name} makes the index stale`, () => {
      const p = project();
      saveQdrantPointer(p.root, p.pointer(change(p.root)));
      const r = resolveSemanticIndexReadiness(p.storage, p.env);
      expect(r.ready).toBe(false);
      expect(r.stale).toBe(true);
      expect(r.reason).toMatch(reason);
    });
  }

  test("a never-indexed pointer is degraded, a missing pointer falls back to the legacy check", () => {
    const p = project();
    saveQdrantPointer(p.root, p.pointer({ chunkCount: 0 }));
    expect(resolveSemanticIndexReadiness(p.storage, p.env)).toMatchObject({
      ready: false,
      degraded: true,
      reason: "qdrant pointer exists but chunk count is zero (never indexed)",
    });
    rmSync(join(p.root, ".search", "qdrant.json"));
    expect(resolveSemanticIndexReadiness(p.storage, p.env).reason).toBe(
      "no qdrant pointer; no legacy sqlite semantic index",
    );
  });

  test("entities whose indexed hash differs from the canonical hash make an otherwise valid index stale", () => {
    const p = project();
    saveQdrantPointer(p.root, p.pointer());
    mkdirSync(join(p.root, "history", "state"), { recursive: true });
    writeFileSync(
      join(p.root, "history", "state", "qdrant-index-watermarks.json"),
      JSON.stringify({
        "doc:architecture": {
          entityType: "doc",
          entityId: "architecture",
          canonicalHash: "h2",
          revision: 2,
          path: "docs/architecture.md",
          indexedHash: "h1",
          indexedRevision: 1,
          indexedPath: "docs/architecture.md",
        },
      }),
    );
    const entities = qdrantEntityReadinessForStore(p.root);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.stale).toBe(true);
    const r = resolveSemanticIndexReadiness(p.storage, p.env);
    expect(r).toMatchObject({ ready: false, stale: true, entitiesOnlyStale: true });
    expect(r.reason).toBe("1 canonical Task/Doc entities are not indexed at their current hash");
  });

  test("opt-out and the none backend are not an error", () => {
    const p = project();
    const none = { ...p.env, env: { KNOWNS_SEMANTIC_VECTOR_BACKEND: "none" } };
    expect(resolveSemanticIndexReadiness(p.storage, none)).toMatchObject({
      ready: false,
      reason: "semantic vector search disabled (backend none)",
    });
    const off = { ...p.env, env: { KNOWNS_SEMANTIC_VECTOR_ENABLED: "0" } };
    expect(resolveSemanticIndexReadiness(p.storage, off).optedOut).toBe(true);
  });

  test("pointer and generation files survive a round trip", () => {
    const p = project();
    const pointer = p.pointer();
    saveQdrantPointer(p.root, pointer);
    expect(loadQdrantPointer(p.root)).toEqual({
      ...pointer,
      embedding: { ...pointer.embedding, distance: "cosine" },
    });
    expect(loadQdrantGenerations(p.root)).toEqual([]);
    saveQdrantGenerations(p.root, [
      {
        generation: 1,
        collectionUUID: pointer.collectionUUID,
        collectionName: pointer.collectionName,
        schemaVersion: 1,
        chunkVersion: 5,
        embedding: pointer.embedding,
        owner: pointer.owner,
        status: "active",
        chunkCount: 9,
        createdAt: "2026-11-03T00:00:00Z",
      },
    ]);
    expect(loadQdrantGenerations(p.root)[0]?.status).toBe("active");
  });
});

describe("hit validation", () => {
  test("a current document passes; a changed one, a missing one and a stale chunk version are dropped", () => {
    const p = project();
    const pointer = p.pointer();
    const doc = p.storage.docs.get("architecture");
    const hash = contentHash(`${doc.title}\n${doc.description ?? ""}\n${doc.content ?? ""}`);
    const ctx = {
      storage: p.storage,
      pointer,
      expectedModel: "all-minilm",
      expectedDimensions: 384,
    };
    const payload = {
      chunk_id: "doc:architecture:chunk:1",
      source_id: "doc:architecture",
      type: "doc",
      doc_path: "architecture",
      chunk_version: CHUNK_VERSION,
      content_hash: hash,
    };
    expect(validateQdrantHitPayload(ctx, payload).result.valid).toBe(true);
    const changed = validateQdrantHitPayload(ctx, { ...payload, content_hash: "0".repeat(64) });
    expect(changed.result).toMatchObject({
      valid: false,
      reasons: ["content hash mismatch"],
      reindexRecommended: true,
    });
    expect(validateQdrantHitPayload(ctx, { ...payload, doc_path: "gone" }).result.reasons).toEqual([
      "canonical source does not exist",
    ]);
    expect(validateQdrantHitPayload(ctx, { ...payload, chunk_version: 3 }).result.reasons).toEqual([
      "payload chunk_version 3 != current 5",
    ]);
    expect(validateQdrantHitPayload(ctx, { ...payload, chunk_id: "" }).result.reasons).toContain(
      "missing chunk_id",
    );
    const task = fixtureId("full", "task.rich");
    expect(
      validateQdrantHitPayload(ctx, {
        chunk_id: `task:${task}:chunk:description`,
        source_id: `task:${task}`,
        type: "task",
        task_id: task,
      }).result.valid,
    ).toBe(true);
  });
});
