// The `sqlite` vector backend against the Go 0.34.1 oracle (TSR-778Y9G). A local stub embedding
// API gives both binaries the same deterministic vectors, so semantic and hybrid results are real
// cosine rankings over a real `.search/index.db`, not the keyword fallback.
//
// The mock embedder (KNOWNS_EMBED_MOCK) is no use here: Go honours it only in the legacy
// InitSemantic path, while search, retrieve, MCP and the hook's memory sessions go through the
// runtime session, which always calls the configured API.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../mcp/harness.ts";
import { hasGoBin } from "../oracle.ts";
import {
  goInTemplate,
  goInTemplateAsync,
  makeSandbox,
  type Outcome,
  type RunOptions,
  runGoIn,
  runTsIn,
  type Sandbox,
  sandboxEnv,
} from "./subprocess-diff.ts";

const t = test.skipIf(!hasGoBin);
const DIMS = 16;
const INLINE = { KNOWNS_RUNTIME_INLINE: "1", KNOWNS_LSP_DAEMON: "0" };

let server: ReturnType<typeof Bun.serve> | undefined;
let sqliteBox: Sandbox;
let legacyBox: Sandbox;
const cleanup: string[] = [];

/** A bag-of-words vector: each token hashes into one of DIMS buckets, plus a constant floor. */
function embed(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0.05);
  for (const tok of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619) >>> 0;
    v[h % DIMS] = (v[h % DIMS] as number) + 1;
  }
  return v;
}

function writeJSON(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/** Points the project's semantic search at the stub model with the given vector store. */
function configure(box: Sandbox, vectorStore: Record<string, unknown> | undefined): void {
  const path = join(box.proj, ".knowns", "config.json");
  const cfg = JSON.parse(readFileSync(path, "utf8")) as { settings: Record<string, unknown> };
  cfg.settings.semanticSearch = {
    enabled: true,
    provider: "ollama",
    model: "stub-embed",
    ...(vectorStore && { vectorStore }),
  };
  writeFileSync(path, JSON.stringify(cfg, null, 2));
}

function ageFixture(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== ".search") ageFixture(path);
    } else if (name.endsWith(".md")) {
      const text = readFileSync(path, "utf8");
      writeFileSync(
        path,
        text.replace(/^(createdAt|updatedAt): .*$/gm, "$1: '2026-01-05T10:00:00.000Z'"),
      );
    }
  }
}

function buildTemplate(prefix: string, backend: Record<string, unknown> | undefined): Sandbox {
  const box = makeSandbox(prefix);
  cleanup.push(box.root);
  mkdirSync(box.home, { recursive: true });
  mkdirSync(box.proj, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: box.proj });
  goInTemplate(box, ["init", "vectors", "--no-wizard"]);
  writeJSON(join(box.home, ".knowns", "settings.json"), {
    embeddingProviders: {
      stub: { name: "Stub", apiBase: `http://127.0.0.1:${server?.port}/v1` },
    },
    embeddingModels: {
      "stub-embed": { provider: "stub", model: "stub-embed", dimensions: DIMS, maxTokens: 512 },
    },
  });
  const doc = (folder: string, title: string, content: string) =>
    goInTemplate(box, ["doc", "create", title, "-f", folder, "-c", content]);
  doc(
    "specs",
    "vector-store",
    "The vector store keeps embeddings in sqlite and answers cosine queries.",
  );
  doc("guides", "qdrant-setup", "Install qdrant, start the managed runtime, then reindex.");
  doc("guides", "release-checklist", "Bump the version, tag the release, publish npm packages.");
  goInTemplate(box, [
    "task",
    "create",
    "Tune cosine threshold",
    "-d",
    "The sqlite vector search threshold drops weak embeddings.",
  ]);
  goInTemplate(box, [
    "task",
    "create",
    "Publish npm release",
    "-d",
    "Tag and publish the packages.",
  ]);
  goInTemplate(box, [
    "memory",
    "create",
    "Embeddings live in sqlite",
    "--category",
    "pattern",
    "--status",
    "active",
    "-c",
    "Vector embeddings for search live in the sqlite index under .search.",
  ]);
  goInTemplate(box, [
    "memory",
    "create",
    "Release on Fridays",
    "--category",
    "convention",
    "--status",
    "active",
    "-c",
    "Releases are tagged on Fridays after the checklist.",
  ]);
  // The hybrid rerank adds a recency bonus for anything under a week old, measured from the wall
  // clock of each run; back-date the fixture so the two runs score identically.
  ageFixture(join(box.proj, ".knowns"));
  configure(box, backend);
  return box;
}

beforeAll(async () => {
  if (!hasGoBin) return;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/embeddings")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json().catch(() => ({}))) as { input?: string[] | string };
      const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
      return Response.json({
        data: inputs.map((text, index) => ({ index, embedding: embed(text) })),
      });
    },
  });
  // The index is built once, by Go, and both binaries read it.
  sqliteBox = buildTemplate("knowns-sqlite-", { backend: "sqlite" });
  await goInTemplateAsync(sqliteBox, ["search", "--reindex"], INLINE);
  // A Qdrant project that has not activated a generation yet: no pointer, an old index.db.
  legacyBox = buildTemplate("knowns-legacy-", { backend: "sqlite" });
  await goInTemplateAsync(legacyBox, ["search", "--reindex"], INLINE);
  configure(legacyBox, { backend: "qdrant", mode: "external", url: "http://127.0.0.1:1" });
}, 120_000);

afterAll(() => {
  server?.stop(true);
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

async function same(box: Sandbox, args: string[], opts: RunOptions = {}): Promise<Outcome> {
  const o = { ...opts, env: { ...INLINE, ...opts.env } };
  const go = await runGoIn(box, args, o);
  const ts = await runTsIn(box, args, o);
  expect(ts).toEqual(go);
  return ts;
}

const SEARCHES: string[][] = [
  ["search", "sqlite vector embeddings"],
  ["search", "sqlite vector embeddings", "--json"],
  ["search", "sqlite vector embeddings", "--plain"],
  ["search", "qdrant reindex", "--type", "doc", "--json"],
  ["search", "cosine threshold", "--type", "task", "--json"],
  ["search", "embeddings sqlite", "--type", "memory", "--json"],
  ["search", "release friday", "--keyword", "--json"],
  ["search", "zzzz unrelated words", "--json"],
  ["retrieve", "sqlite vector embeddings", "--json"],
  ["retrieve", "release checklist publish", "--plain"],
];

describe("sqlite backend: search and retrieve match Go", () => {
  t("the Go index exists", () => {
    expect(existsSync(join(sqliteBox.proj, ".knowns", ".search", "index.db"))).toBe(true);
  });
  for (const args of SEARCHES) {
    t(args.join(" "), async () => {
      const r = await same(sqliteBox, args);
      expect(r.code).toBe(0);
    });
  }
  t("results are semantic, not the keyword fallback", async () => {
    const r = await same(sqliteBox, ["search", "sqlite vector embeddings", "--json"]);
    expect(r.stdout).toContain('"semantic"');
  });
});

describe("sqlite backend: MCP search and retrieve match Go", () => {
  const calls: [string, Record<string, unknown>][] = [
    ["search", { query: "sqlite vector embeddings" }],
    ["search", { query: "sqlite vector embeddings", mode: "semantic" }],
    ["search", { query: "qdrant reindex", type: "doc", mode: "hybrid" }],
    ["search", { query: "embeddings sqlite", type: "memory" }],
    ["retrieve", { query: "sqlite vector embeddings" }],
  ];
  for (const [tool, args] of calls) {
    t(`${tool} ${JSON.stringify(args)}`, async () => {
      const outs: string[] = [];
      for (const side of ["go", "ts"] as const) {
        const run = mkdtempSync(join(tmpdir(), "knowns-mcp-sqlite-"));
        try {
          cpSync(sqliteBox.root, run, { recursive: true });
          const s = new McpSession(side, {
            cwd: join(run, "proj"),
            home: join(run, "home"),
            env: INLINE,
          });
          try {
            await s.initialize();
            const r = await s.tool(tool, args);
            outs.push(r.text.replaceAll(run, "<RUN>"));
          } finally {
            await s.close();
          }
        } finally {
          rmSync(run, { recursive: true, force: true });
        }
      }
      expect(outs[1]).toEqual(outs[0]);
    });
  }
});

describe("a qdrant project with no pointer reads its legacy index like Go", () => {
  for (const args of [
    ["search", "sqlite vector embeddings", "--json"],
    ["search", "qdrant reindex", "--type", "doc", "--json"],
    ["retrieve", "sqlite vector embeddings", "--json"],
  ]) {
    t(args.join(" "), () => same(legacyBox, args).then(() => undefined));
  }
});

/** The rows of an index.db, minus the wall-clock indexedAt. */
function indexRows(dbPath: string): unknown {
  // Read-only would need a -shm file next to a WAL database; nothing here writes.
  const db = new Database(dbPath, { readwrite: true, create: false });
  try {
    return {
      metadata: db
        .query("SELECT key, value FROM metadata WHERE key != 'indexedAt' ORDER BY key")
        .all(),
      chunks: db
        .query(
          "SELECT id, type, content, token_count, hex(embedding) AS embedding, doc_path, section, heading_level, header_path, position, task_id, field, status, priority, labels, memory_id, memory_layer, memory_store, decision_id, name, signature, visibility, detail FROM chunks ORDER BY id",
        )
        .all(),
      hashes: db.query("SELECT source_id, hash FROM content_hashes ORDER BY source_id").all(),
    };
  } finally {
    db.close();
  }
}

function freshCopy(box: Sandbox): string {
  const run = mkdtempSync(join(tmpdir(), "knowns-reindex-"));
  cpSync(box.root, run, { recursive: true });
  rmSync(join(run, "proj", ".knowns", ".search"), { recursive: true, force: true });
  return run;
}

describe("sqlite backend: reindex writes the rows Go writes", () => {
  t(
    "search --reindex (inline) and the daemon reindex job",
    async () => {
      const goRun = freshCopy(sqliteBox);
      const tsRun = freshCopy(sqliteBox);
      const jobRun = freshCopy(sqliteBox);
      try {
        const reindex = async (bin: string[], run: string) => {
          const p = Bun.spawn([...bin, "search", "--reindex"], {
            cwd: join(run, "proj"),
            env: sandboxEnv(join(run, "home"), INLINE),
            stdout: "pipe",
            stderr: "pipe",
          });
          const [out, err, code] = await Promise.all([
            new Response(p.stdout).text(),
            new Response(p.stderr).text(),
            p.exited,
          ]);
          return { code, out: out.replaceAll(run, "<RUN>"), err: err.replaceAll(run, "<RUN>") };
        };
        const go = await reindex([process.env.KNOWNS_GO_BIN as string], goRun);
        const ts = await reindex(
          [process.execPath, join(import.meta.dir, "..", "..", "..", "src", "bin.ts")],
          tsRun,
        );
        expect(ts).toEqual(go);
        expect(go.code).toBe(0);

        // The daemon runs the queued job through executeRuntimeJob; Go's daemon cannot be pointed at
        // a stub here, so its rows are compared with Go's inline reindex, which shares the indexer.
        const job = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, "run-reindex-job.ts"),
            join(jobRun, "proj", ".knowns"),
          ],
          { env: sandboxEnv(join(jobRun, "home"), INLINE), stdout: "pipe", stderr: "pipe" },
        );
        const jobErr = await new Response(job.stderr).text();
        expect(await job.exited).toBe(0);
        expect(jobErr).toBe("");

        const goRows = indexRows(join(goRun, "proj", ".knowns", ".search", "index.db"));
        expect(indexRows(join(tsRun, "proj", ".knowns", ".search", "index.db"))).toEqual(goRows);
        expect(indexRows(join(jobRun, "proj", ".knowns", ".search", "index.db"))).toEqual(goRows);
      } finally {
        for (const r of [goRun, tsRun, jobRun]) rmSync(r, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe("sqlite backend: the runtime memory hook's semantic branch matches Go", () => {
  const hook = [
    "runtime-memory",
    "hook",
    "--runtime",
    "claude-code",
    "--event",
    "user-prompt-submit",
  ];
  const prompt = (p: string) => JSON.stringify({ prompt: p });
  for (const [label, p, extra] of [
    ["--json, a strong semantic match", "where do vector embeddings for search live", ["--json"]],
    [
      "--json --mode debug",
      "where do vector embeddings for search live",
      ["--json", "--mode", "debug"],
    ],
    ["serialized payload", "embeddings sqlite index", []],
    ["--json, weak match below the floor", "zzzz qqqq", ["--json"]],
  ] as [string, string, string[]][]) {
    t(label, async () => {
      const r = await same(sqliteBox, [...hook, ...extra], { stdin: prompt(p) });
      if (extra.includes("--json"))
        expect(r.stdout).not.toContain('"retrievalMode": "heuristic-fallback"');
    });
  }
});
