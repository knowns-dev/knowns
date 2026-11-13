// Records the HTTP traffic of the real Go binary querying a Qdrant index it built, for the replay
// test (qdrant.recorded.test.ts) that needs no services. Not run by CI:
//
//   KNOWNS_GO_BIN=/path/to/knowns bun test/search/record-live.ts
//
// Needs Qdrant (127.0.0.1:6333), Ollama with all-minilm (127.0.0.1:11434) and a Go binary. It
// indexes a private copy of the `full` fixture into a temporary collection (deleted afterwards),
// then runs the queries below through a recording proxy and writes
// test/search/fixtures/recorded/full-hybrid.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildLiveProject,
  detectLive,
  LIVE_MODEL,
  OLLAMA_URL,
  QDRANT_URL,
  runGoIn,
  writeRegistry,
} from "./live.ts";

export interface Exchange {
  method: string;
  path: string;
  query: string;
  requestBody: string;
  status: number;
  responseBody: string;
}

export interface RecordedQuery {
  /** CLI arguments after `knowns`, without --json. */
  args: string[];
  /** What the Go binary printed (parsed JSON). */
  expected: unknown;
}

export interface Recording {
  recordedWith: string;
  model: string;
  dimensions: number;
  pointer: {
    collectionUUID: string;
    collectionName: string;
    chunkCount: number;
    lastIndexedAt: string;
  };
  queries: RecordedQuery[];
  exchanges: Exchange[];
}

export const QUERIES: string[][] = [
  ["search", "login"],
  ["search", "bun"],
  ["search", "architecture setup guide"],
  ["search", "login", "--type", "doc"],
  ["search", "login", "--type", "task"],
  ["search", "runtime", "--type", "decision"],
  ["search", "unicode"],
  ["retrieve", "login"],
  ["retrieve", "bun runtime"],
  ["retrieve", "setup", "--source-types", "doc"],
];

if (import.meta.main) {
  const live = await detectLive();
  if (!live.available) throw new Error(`live services unavailable: ${live.why}`);
  const p = await buildLiveProject({ source: "full" });
  try {
    const exchanges: Exchange[] = [];
    const proxy = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const target = url.pathname.startsWith("/v1/") ? OLLAMA_URL : QDRANT_URL;
        const body = await req.text();
        const upstream = await fetch(`${target}${url.pathname}${url.search}`, {
          method: req.method,
          headers: { "content-type": req.headers.get("content-type") ?? "application/json" },
          body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
        });
        const responseBody = await upstream.text();
        exchanges.push({
          method: req.method,
          path: url.pathname,
          query: url.search.replace(/^\?/, ""),
          requestBody: body,
          status: upstream.status,
          responseBody,
        });
        return new Response(responseBody, {
          status: upstream.status,
          headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
        });
      },
    });
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    writeRegistry(p.go.home, proxyUrl);
    const queries: RecordedQuery[] = [];
    for (const args of QUERIES) {
      const res = runGoAsync(p, args, proxyUrl);
      const out = await res;
      queries.push({ args, expected: JSON.parse(out) });
    }
    proxy.stop(true);
    const pointer = JSON.parse(p.pointerJson) as Recording["pointer"] & {
      embedding: { dimensions: number };
    };
    const recording: Recording = {
      recordedWith: "knowns Go binary (KNOWNS_GO_BIN)",
      model: LIVE_MODEL,
      dimensions: pointer.embedding.dimensions,
      pointer: {
        collectionUUID: pointer.collectionUUID,
        collectionName: pointer.collectionName,
        chunkCount: pointer.chunkCount,
        lastIndexedAt: pointer.lastIndexedAt,
      },
      queries,
      exchanges: dedupe(exchanges),
    };
    const dir = join(import.meta.dir, "fixtures", "recorded");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "full-hybrid.json"), `${JSON.stringify(recording, null, 1)}\n`);
    console.log(
      `recorded ${queries.length} queries, ${recording.exchanges.length} distinct exchanges`,
    );
  } finally {
    await p.dispose();
  }
}

function dedupe(all: Exchange[]): Exchange[] {
  const seen = new Set<string>();
  return all.filter((e) => {
    const key = `${e.method} ${e.path}?${e.query}\n${e.requestBody}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function runGoAsync(
  p: Awaited<ReturnType<typeof buildLiveProject>>,
  args: string[],
  proxyUrl: string,
): Promise<string> {
  const r = await p.go.runAsync([...args, "--json"], {
    KNOWNS_SEMANTIC_VECTOR_ENABLED: "1",
    KNOWNS_QDRANT_URL: proxyUrl,
  });
  if (r.code !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

void readFileSync;
void runGoIn;
