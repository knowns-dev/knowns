// A project whose Qdrant index was written by the real Go binary, for the tests that read it back.
// Requires a reachable Qdrant (default http://127.0.0.1:6333) and Ollama (http://127.0.0.1:11434)
// with the all-minilm model, plus a Go binary (KNOWNS_GO_BIN). Everything else is a private temp
// directory; the one shared resource is the Qdrant collection, which `dispose` deletes.
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchEnvironment } from "../../src/search/index.ts";
import { createStorage, type Storage } from "../../src/storage/adapters.ts";
import { Store } from "../../src/storage/core/store.ts";
import { EmbeddingSettingsStore } from "../../src/storage/stores/index.ts";
import { fixtureRoot } from "../helpers/fixtures.ts";
import { goBinary } from "../history/helpers.ts";
import { buildCorpus, type GoProject, goEnv } from "./go-corpus.ts";

export const QDRANT_URL = process.env.KNOWNS_TEST_QDRANT_URL ?? "http://127.0.0.1:6333";
export const OLLAMA_URL = process.env.KNOWNS_TEST_OLLAMA_URL ?? "http://127.0.0.1:11434";
export const LIVE_MODEL = "all-minilm";

async function ok(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface LiveAvailability {
  available: boolean;
  why: string;
}

/** True only when the Go binary, Qdrant and an Ollama with all-minilm are all reachable. */
export async function detectLive(): Promise<LiveAvailability> {
  if (!goBinary()) return { available: false, why: "no Go binary" };
  if (!(await ok(`${QDRANT_URL}/collections`))) return { available: false, why: "no Qdrant" };
  if (!(await ok(`${OLLAMA_URL}/api/version`))) return { available: false, why: "no Ollama" };
  try {
    const tags = (await (await fetch(`${OLLAMA_URL}/api/tags`)).json()) as {
      models?: { name: string }[];
    };
    if (!tags.models?.some((m) => m.name.startsWith(`${LIVE_MODEL}:`) || m.name === LIVE_MODEL)) {
      return { available: false, why: `Ollama lacks ${LIVE_MODEL}` };
    }
  } catch {
    return { available: false, why: "Ollama tags unreadable" };
  }
  return { available: true, why: "" };
}

export interface LiveProject {
  go: GoProject;
  storage: Storage;
  env: SearchEnvironment;
  /** Env the Go binary needs to find the same index. */
  goEnv: Record<string, string>;
  collection: string;
  pointerJson: string;
  dispose(): Promise<void>;
}

/** The registry file Go reads: the local provider pointed at `ollamaBase`, retries kept short. */
export function writeRegistry(home: string, ollamaBase: string): void {
  const dir = join(home, ".knowns");
  mkdirSync(dir, { recursive: true });
  const settings = {
    embeddingProviders: {
      ollama: {
        name: "Ollama Local",
        apiBase: `${ollamaBase}/v1`,
        timeout: 30,
        batchSize: 64,
        retry: { maxRetries: 1, initialDelay: 1, maxDelay: 1 },
      },
    },
  };
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

/** Moves every frontmatter updatedAt to 2020 so the recency bonus (< 7 days) never applies. */
export function ageEntities(knowns: string): void {
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === "history" || name === ".search") continue;
        walk(p);
      } else if (name.endsWith(".md")) {
        const text = readFileSync(p, "utf8");
        const next = text.replace(/^(updatedAt:\s*['"]?)\d{4}/m, "$12020");
        if (next !== text) writeFileSync(p, next);
      }
    }
  };
  walk(knowns);
}

export function runGoIn(go: GoProject, args: string[], extra: Record<string, string>) {
  const bin = goBinary();
  if (!bin) throw new Error("no Go binary");
  const res = Bun.spawnSync([bin, ...args], {
    cwd: go.project,
    env: goEnv(go.home, extra),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

export interface BuildOptions {
  source: "corpus" | "full";
  /** Base URLs; tests that record traffic point these at a proxy. */
  ollamaBase?: string;
  qdrantUrl?: string;
}

/** Builds the project, asks Go to index it into Qdrant, and opens it through the TS storage. */
export async function buildLiveProject(opts: BuildOptions): Promise<LiveProject> {
  const bin = goBinary();
  if (!bin) throw new Error("no Go binary");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "knowns-search-live-")));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", "."], { cwd: project });
  const go: GoProject = {
    project,
    home,
    run: (args, extra = {}) => runGoIn(go, args, extra),
    runAsync: async (args, extra = {}) => {
      const bin2 = goBinary() as string;
      const child = Bun.spawn([bin2, ...args], {
        cwd: go.project,
        env: goEnv(go.home, extra),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, stdout, stderr };
    },
  };
  const ollamaBase = opts.ollamaBase ?? OLLAMA_URL;
  const qdrantUrl = opts.qdrantUrl ?? QDRANT_URL;
  const indexEnv = {
    KNOWNS_SEMANTIC_VECTOR_ENABLED: "1",
    KNOWNS_QDRANT_URL: qdrantUrl,
    KNOWNS_SEMANTIC_RUNTIME_DISABLED: "",
  };
  writeRegistry(home, ollamaBase);

  if (opts.source === "corpus") {
    buildCorpus(go, 3);
  } else {
    cpSync(join(fixtureRoot("full"), ".knowns"), join(project, ".knowns"), { recursive: true });
    rmSync(join(project, ".knowns", ".search"), { recursive: true, force: true });
  }
  for (const [k, v] of [
    ["settings.semanticSearch.enabled", "true"],
    ["settings.semanticSearch.provider", "ollama"],
    ["settings.semanticSearch.model", LIVE_MODEL],
  ] as const) {
    const r = go.run(["config", "set", k, v, "--plain"], indexEnv);
    if (r.code !== 0) throw new Error(`config set ${k}: ${r.stderr}${r.stdout}`);
  }
  const idx = go.run(["search", "index", "--wait", "--plain"], indexEnv);
  if (idx.code !== 0) throw new Error(`search index: ${idx.stderr}${idx.stdout}`);

  const knowns = join(project, ".knowns");
  // The index is fresh, but pending per-entity watermarks written by the creation hooks would keep
  // readiness stale until the runtime queue reconciles them; the reconciler is not part of this
  // port, so the index state is declared clean the way a settled runtime leaves it.
  rmSync(join(knowns, "history", "state", "qdrant-index-watermarks.json"), { force: true });
  ageEntities(knowns);

  const pointerJson = readFileSync(join(knowns, ".search", "qdrant.json"), "utf8");
  const collection = (JSON.parse(pointerJson) as { collectionName: string }).collectionName;
  const storage = createStorage(Store.open(knowns), { globalRoot: join(home, ".knowns") });
  const registry = new EmbeddingSettingsStore(join(home, ".knowns", "settings.json"));
  const env: SearchEnvironment = {
    embeddingRegistry: () => registry.load(),
    env: { KNOWNS_QDRANT_URL: qdrantUrl, KNOWNS_SEMANTIC_VECTOR_ENABLED: "1" },
    sleep: async () => {},
    queueReindex: () => {},
  };
  return {
    go,
    storage,
    env,
    goEnv: { ...indexEnv },
    collection,
    pointerJson,
    async dispose() {
      await fetch(`${qdrantUrl}/collections/${collection}`, { method: "DELETE" }).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    },
  };
}
