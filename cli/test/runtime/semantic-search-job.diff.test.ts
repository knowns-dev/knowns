// TSR-2W21YT: a Go 0.34.1 client that shares a runtime daemon hands its semantic searches to the
// daemon as `semantic-search` jobs. Before, the TS daemon threw "unsupported runtime job kind",
// so the job dead-lettered and the Go client's search failed. Here the same Go client searches the
// same project twice: with HOME A it starts and uses its own Go daemon, with HOME B it finds a TS
// daemon (same version) already running and hands the job to it. The client's output and the job
// result payload the daemon reports must be identical, and no job may dead-letter.
//
// Embeddings come from a local stub of the embeddings API (as in sqlite-backend.test.ts); the
// project and its SQLite index are built once, by Go, and only read by both runs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  goInTemplate,
  goInTemplateAsync,
  makeSandbox,
  type Sandbox,
  sandboxEnv,
} from "../cli/commands/subprocess-diff.ts";
import { GO_BIN, hasGoBin } from "../cli/oracle.ts";

const DIMS = 16;
const MAIN = resolve(import.meta.dir, "..", "..", "src", "main.ts");
const INLINE = { KNOWNS_RUNTIME_INLINE: "1", KNOWNS_LSP_DAEMON: "0" };
// Daemon mode: no KNOWNS_RUNTIME_INLINE, a short idle timeout so the daemons exit by themselves.
const DAEMON = {
  KNOWNS_LSP_DAEMON: "0",
  KNOWNS_RUNTIME_IDLE_TIMEOUT_MS: "4000",
  KNOWNS_ENTITY_INDEX_DEBOUNCE_MS: "0",
};

const QUERIES: string[][] = [
  ["search", "sqlite vector embeddings", "--json"],
  ["search", "sqlite vector embeddings"],
  ["search", "embeddings sqlite", "--type", "memory", "--json"],
  ["search", "cosine threshold", "--type", "task", "--status", "todo", "--json"],
  ["retrieve", "sqlite vector embeddings", "--json"],
];

let server: ReturnType<typeof Bun.serve> | undefined;
let box: Sandbox;
const homes: Record<"go" | "ts", string> = { go: "", ts: "" };
const cleanup: string[] = [];
let tsDaemon: ReturnType<typeof Bun.spawn> | undefined;

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

function stubSettings(home: string): void {
  writeJSON(join(home, ".knowns", "settings.json"), {
    embeddingProviders: { stub: { name: "Stub", apiBase: `http://127.0.0.1:${server?.port}/v1` } },
    embeddingModels: {
      "stub-embed": { provider: "stub", model: "stub-embed", dimensions: DIMS, maxTokens: 512 },
    },
  });
}

function ageFixture(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== ".search") ageFixture(path);
    } else if (name.endsWith(".md")) {
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(
          /^(createdAt|updatedAt): .*$/gm,
          "$1: '2026-01-05T10:00:00.000Z'",
        ),
      );
    }
  }
}

/** The queue file's finished semantic-search results for a HOME, oldest first. */
function semanticResults(home: string): {
  success: boolean;
  deadLetter?: boolean;
  error?: string;
  details?: { phase?: string; result?: unknown } | null;
}[] {
  const dir = join(home, ".knowns", "runtime", "queues");
  if (!existsSync(dir)) return [];
  const out: ReturnType<typeof semanticResults> = [];
  for (const f of readdirSync(dir)) {
    const state = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
      jobs?: { kind: string; deadLetter?: boolean }[];
      recent?: {
        kind: string;
        success: boolean;
        deadLetter?: boolean;
        error?: string;
        details?: { phase?: string; result?: unknown } | null;
      }[];
    };
    for (const j of state.jobs ?? []) {
      if (j.kind === "semantic-search" && j.deadLetter)
        out.push({ success: false, deadLetter: true });
    }
    for (const r of state.recent ?? []) if (r.kind === "semantic-search") out.push(r);
  }
  return out;
}

async function goClient(home: string, args: string[]) {
  const p = Bun.spawn([GO_BIN as string, ...args], {
    cwd: box.proj,
    env: sandboxEnv(home, DAEMON),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

const pidFile = (home: string) => join(home, ".knowns", "runtime", "knowns-runtime.pid");

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await Bun.sleep(100);
  }
  return cond();
}

describe.skipIf(!hasGoBin)("semantic-search jobs from a Go client in a TS daemon", () => {
  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        if (!new URL(req.url).pathname.endsWith("/embeddings"))
          return new Response("not found", { status: 404 });
        const body = (await req.json().catch(() => ({}))) as { input?: string[] | string };
        const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
        return Response.json({
          data: inputs.map((text, index) => ({ index, embedding: embed(text) })),
        });
      },
    });
    box = makeSandbox("knowns-ssj-");
    cleanup.push(box.root);
    mkdirSync(box.home, { recursive: true });
    mkdirSync(box.proj, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: box.proj });
    goInTemplate(box, ["init", "vectors", "--no-wizard"]);
    stubSettings(box.home);
    const doc = (folder: string, title: string, content: string) =>
      goInTemplate(box, ["doc", "create", title, "-f", folder, "-c", content]);
    doc(
      "specs",
      "vector-store",
      "The vector store keeps embeddings in sqlite and answers cosine queries.",
    );
    doc("guides", "qdrant-setup", "Install qdrant, start the managed runtime, then reindex.");
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
    ageFixture(join(box.proj, ".knowns"));
    const cfgPath = join(box.proj, ".knowns", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { settings: Record<string, unknown> };
    cfg.settings.semanticSearch = {
      enabled: true,
      provider: "ollama",
      model: "stub-embed",
      vectorStore: { backend: "sqlite" },
    };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    await goInTemplateAsync(box, ["search", "--reindex"], INLINE);

    for (const side of ["go", "ts"] as const) {
      homes[side] = join(box.root, `home-${side}`);
      mkdirSync(homes[side], { recursive: true });
      stubSettings(homes[side]);
    }
  }, 180_000);

  afterAll(async () => {
    for (const home of Object.values(homes)) {
      if (home)
        Bun.spawnSync([GO_BIN as string, "runtime", "stop"], {
          cwd: box.proj,
          env: sandboxEnv(home, DAEMON),
        });
    }
    if (tsDaemon && tsDaemon.exitCode === null) tsDaemon.kill();
    server?.stop(true);
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  });

  test("the Go client gets the same answers and payloads from a TS daemon as from its own Go daemon", async () => {
    // A: the Go client starts its own Go daemon.
    const goOut = [];
    for (const q of QUERIES) goOut.push(await goClient(homes.go, q));
    const goPid = readFileSync(pidFile(homes.go), "utf8").trim();

    // B: a TS daemon of the same version is already running; the Go client hands jobs to it.
    // A Go client shuts down a daemon whose version differs from its own (EnsureDaemon), and an
    // oracle built without -ldflags says "dev" while unbuilt TS says 0.34.1, so the TS daemon
    // takes the oracle's own version.
    const goVersion = /^knowns version (\S+)/m.exec(
      Bun.spawnSync([GO_BIN as string, "--version"], {
        env: sandboxEnv(homes.go),
      }).stdout.toString(),
    )?.[1];
    expect(goVersion).toBeDefined();
    const define = `KNOWNS_VERSION=${JSON.stringify(goVersion)}`;
    tsDaemon = Bun.spawn([process.execPath, "--define", define, MAIN, "__runtime", "run"], {
      cwd: box.proj,
      env: sandboxEnv(homes.ts, DAEMON),
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await waitFor(() => existsSync(pidFile(homes.ts)), 15_000)).toBe(true);
    const tsPid = String(tsDaemon.pid);
    expect(readFileSync(pidFile(homes.ts), "utf8").trim()).toBe(tsPid);
    const tsOut = [];
    for (const q of QUERIES) tsOut.push(await goClient(homes.ts, q));
    // The TS daemon answered: it is still the registered daemon and was never replaced.
    expect(readFileSync(pidFile(homes.ts), "utf8").trim()).toBe(tsPid);
    expect(goPid).not.toBe(tsPid);

    // Same client output, query by query.
    for (let i = 0; i < QUERIES.length; i++) {
      expect({ q: QUERIES[i], ...tsOut[i] }).toEqual({ q: QUERIES[i], ...goOut[i] });
      expect(goOut[i]?.code).toBe(0);
    }
    // Same job payloads, and nothing failed or dead-lettered.
    const goJobs = semanticResults(homes.go);
    const tsJobs = semanticResults(homes.ts);
    expect(goJobs.length).toBeGreaterThan(0);
    expect(tsJobs.every((j) => j.success && !j.deadLetter)).toBe(true);
    expect(goJobs.every((j) => j.success && !j.deadLetter)).toBe(true);
    expect(tsJobs.map((j) => j.details)).toEqual(goJobs.map((j) => j.details));
    // Not a vacuous match of two keyword fallbacks: every answer used the semantic leg.
    for (const j of tsJobs) {
      const r = j.details?.result as { results: { matchedBy?: string[] }[]; _runtime?: unknown };
      expect(r._runtime).toBeUndefined();
      expect(r.results.some((x) => (x.matchedBy ?? []).includes("semantic"))).toBe(true);
    }
    for (const j of tsJobs) expect(j.details?.phase).toBe("semantic-search");
  }, 300_000);
});
