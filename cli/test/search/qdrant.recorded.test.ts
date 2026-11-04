// AC-3 without services: the HTTP exchanges the real Go binary had with Ollama and Qdrant while
// answering the queries below were recorded (record-live.ts) together with what it printed. The
// TypeScript library replays them against a fake server and must (a) send byte-identical requests
// (same vector digits, limit, filter, threshold, model input) and (b) print what Go printed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  retrieveWithRuntime,
  type SearchEnvironment,
  saveQdrantPointer,
  searchWithRuntime,
  storeRootFingerprint,
} from "../../src/search/index.ts";
import { createStorage, type Storage } from "../../src/storage/adapters.ts";
import { Store } from "../../src/storage/core/store.ts";
import { EmbeddingSettingsStore } from "../../src/storage/stores/index.ts";
import { fixtureRoot } from "../helpers/fixtures.ts";
import { tempDir } from "../history/helpers.ts";
import { ageEntities, writeRegistry } from "./live.ts";
import type { Exchange, Recording } from "./record-live.ts";

const recording = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "recorded", "full-hybrid.json"), "utf8"),
) as Recording;

describe("replaying the Go binary's recorded Ollama and Qdrant traffic", () => {
  let dir: string;
  let storage: Storage;
  let env: SearchEnvironment;
  let server: ReturnType<typeof Bun.serve>;
  const seen: Exchange[] = [];
  const unmatched: string[] = [];

  beforeAll(() => {
    dir = tempDir("knowns-search-replay-");
    const home = join(dir, "home");
    const knowns = join(dir, "project", ".knowns");
    mkdirSync(home, { recursive: true });
    cpSync(join(fixtureRoot("full"), ".knowns"), knowns, { recursive: true });
    rmSync(join(knowns, ".search"), { recursive: true, force: true });
    // Pending per-entity watermarks (written by the creation hooks) would keep readiness stale
    // until the runtime queue reconciles them; the recording was made with them settled.
    rmSync(join(knowns, "history", "state", "qdrant-index-watermarks.json"), { force: true });
    ageEntities(knowns);
    // Provider and model, as `knowns config set` wrote them for the recording.
    const configPath = join(knowns, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      settings: Record<string, unknown>;
    };
    config.settings.semanticSearch = { enabled: true, provider: "ollama", model: recording.model };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = await req.text();
        const query = url.search.replace(/^\?/, "");
        const hit = recording.exchanges.find(
          (e) =>
            e.method === req.method &&
            e.path === url.pathname &&
            e.query === query &&
            e.requestBody === body,
        );
        if (!hit) {
          unmatched.push(`${req.method} ${url.pathname}?${query}\n${body.slice(0, 200)}`);
          return new Response("no recorded exchange", { status: 599 });
        }
        seen.push(hit);
        return new Response(hit.responseBody, {
          status: hit.status,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    writeRegistry(home, base);

    storage = createStorage(Store.open(knowns), { globalRoot: join(home, ".knowns") });
    // The pointer a settled Go index leaves behind; only the owner fingerprint is path-specific.
    saveQdrantPointer(knowns, {
      backend: "qdrant",
      collectionUUID: recording.pointer.collectionUUID,
      collectionName: recording.pointer.collectionName,
      schemaVersion: 1,
      chunkVersion: 5,
      embedding: {
        provider: "ollama",
        model: recording.model,
        dimensions: recording.dimensions,
        distance: "cosine",
      },
      owner: { projectId: "fixture", storeRootFingerprint: storeRootFingerprint(knowns) },
      lastIndexedAt: recording.pointer.lastIndexedAt,
      chunkCount: recording.pointer.chunkCount,
    });
    const registry = new EmbeddingSettingsStore(join(home, ".knowns", "settings.json"));
    env = {
      embeddingRegistry: () => registry.load(),
      env: { KNOWNS_QDRANT_URL: base, KNOWNS_SEMANTIC_VECTOR_ENABLED: "1" },
      sleep: async () => {},
      queueReindex: () => {},
    };
  });

  afterAll(() => {
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  /** CLI flags to library options, the way internal/cli/search.go maps them. */
  function parse(args: string[]) {
    const [command, query] = args as [string, string];
    const flag = (name: string) => {
      const i = args.indexOf(name);
      return i >= 0 ? (args[i + 1] as string) : "";
    };
    return {
      command,
      query,
      type: flag("--type"),
      sourceTypes: flag("--source-types") ? flag("--source-types").split(",") : undefined,
    };
  }

  for (const q of recording.queries) {
    test(`knowns ${q.args.join(" ")}`, async () => {
      const a = parse(q.args);
      let actual: unknown;
      if (a.command === "search") {
        const out = await searchWithRuntime(storage, env, {
          query: a.query,
          type: a.type,
          mode: "hybrid",
          limit: 20,
        });
        expect(out.runtime).toBeUndefined();
        actual = out.results;
      } else {
        const { response, runtime } = await retrieveWithRuntime(storage, env, {
          query: a.query,
          mode: "hybrid",
          limit: 20,
          sourceTypes: a.sourceTypes,
        });
        actual = runtime ? { ...response, _runtime: runtime } : response;
      }
      expect(unmatched).toEqual([]);
      expect(JSON.stringify(actual, null, 2)).toBe(JSON.stringify(q.expected, null, 2));
    });
  }

  test("every recorded request was reproduced byte for byte, and nothing else was sent", () => {
    expect(unmatched).toEqual([]);
    const reproduced = new Set(seen);
    const missing = recording.exchanges.filter((e) => !reproduced.has(e));
    expect(missing.map((e) => `${e.method} ${e.path} ${e.requestBody.slice(0, 80)}`)).toEqual([]);
  });

  test("hybrid results came from the semantic leg of the recorded index", () => {
    const semantic = recording.queries.filter((q) =>
      JSON.stringify(q.expected).includes('"semantic"'),
    );
    expect(semantic.length).toBeGreaterThan(0);
  });
});
