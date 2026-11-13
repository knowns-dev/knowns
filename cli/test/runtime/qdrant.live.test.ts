// Live Qdrant + Ollama: the runtime daemon reconciles a write into the Qdrant collection and
// stamps the watermark exactly as Go's daemon does, and `search index --wait` builds a new
// generation that the Go binary can query. Collections are deleted through the Qdrant API.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setDaemonCommand } from "../../src/runtime/queue.ts";
import { installRuntime } from "../../src/wiring/runtime.ts";
import { runTs } from "../cli/oracle.ts";
import { buildLiveProject, detectLive, type LiveProject, QDRANT_URL } from "../search/live.ts";

const live = await detectLive();
const suite = live.available ? describe : describe.skip;
if (!live.available) console.warn(`runtime/qdrant.live.test.ts skipped: ${live.why}`);

installRuntime();
setDaemonCommand(() => ({
  cmd: process.execPath,
  args: [join(import.meta.dir, "..", "..", "src", "main.ts"), "__runtime", "run"],
}));

const DAEMON = {
  KNOWNS_RUNTIME_INLINE: "0",
  KNOWNS_RUNTIME_IDLE_TIMEOUT_MS: "1500",
  KNOWNS_ENTITY_INDEX_DEBOUNCE_MS: "0",
};

async function runTsIn(p: LiveProject, args: string[], extra: Record<string, string> = {}) {
  const env = {
    ...p.goEnv,
    ...extra,
    HOME: p.go.home,
    USERPROFILE: p.go.home,
    NO_UPDATE_CHECK: "1",
    CI: "1",
    NO_COLOR: "1",
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await runTs(args, { cwd: p.go.project, env });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const pidFile = (p: LiveProject) => join(p.go.home, ".knowns", "runtime", "knowns-runtime.pid");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(150);
  }
  return cond();
}

async function pointsFor(collection: string, source: string): Promise<number> {
  const res = await fetch(`${QDRANT_URL}/collections/${collection}/points/count`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      exact: true,
      filter: { must: [{ key: "source_id", match: { value: source } }] },
    }),
  });
  return ((await res.json()) as { result: { count: number } }).result.count;
}

function watermarks(p: LiveProject): Record<string, Record<string, unknown>> {
  const f = join(p.go.project, ".knowns", "history", "state", "qdrant-index-watermarks.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
}

suite("runtime daemon against live Qdrant", () => {
  let goP: LiveProject;
  let tsP: LiveProject;
  const extra: string[] = [];
  beforeAll(async () => {
    goP = await buildLiveProject({ source: "corpus" });
    tsP = await buildLiveProject({ source: "corpus" });
  }, 240_000);
  afterAll(async () => {
    for (const name of extra)
      await fetch(`${QDRANT_URL}/collections/${name}`, { method: "DELETE" }).catch(() => {});
    await goP?.dispose();
    await tsP?.dispose();
  });

  test("a task write is reconciled into Qdrant by the daemon and the watermark settles", async () => {
    const args = [
      "task",
      "create",
      "Live daemon task",
      "-d",
      "reconciled into qdrant by the runtime",
    ];
    const g = goP.go.run(args, { ...goP.goEnv, ...DAEMON });
    expect(g.code, g.stderr).toBe(0);
    const t = await runTsIn(tsP, args, DAEMON);
    expect(t.code, t.stderr).toBe(0);
    const idOf = (out: string) => /Created task (\S+?):/.exec(out)?.[1] as string;
    const ids = { go: idOf(g.stdout), ts: idOf(t.stdout) };
    for (const [name, p] of [
      ["go", goP],
      ["ts", tsP],
    ] as const) {
      const started = await waitFor(() => existsSync(pidFile(p)), 10_000);
      expect(started, `${name} daemon started`).toBe(true);
      const pid = Number.parseInt(readFileSync(pidFile(p), "utf8"), 10);
      const done = await waitFor(() => !existsSync(pidFile(p)), 40_000);
      expect(done, `${name} daemon exited`).toBe(true);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    const goPoints = await pointsFor(goP.collection, `task:${ids.go}`);
    const tsPoints = await pointsFor(tsP.collection, `task:${ids.ts}`);
    expect(goPoints).toBeGreaterThan(0);
    expect(tsPoints).toBe(goPoints);
    const wg = watermarks(goP)[`task:${ids.go}`] as Record<string, unknown>;
    const wt = watermarks(tsP)[`task:${ids.ts}`] as Record<string, unknown>;
    expect(wg.stale ?? false).toBe(false);
    expect(wt.stale ?? false).toBe(false);
    expect(wt.indexedHash).toBe(wt.canonicalHash);
    expect({
      ...wt,
      entityId: "",
      path: "",
      canonicalHash: "",
      indexedHash: "",
      indexedAt: "",
      indexedPath: "",
    }).toEqual({
      ...wg,
      entityId: "",
      path: "",
      canonicalHash: "",
      indexedHash: "",
      indexedAt: "",
      indexedPath: "",
    });
  }, 120_000);

  test("search index --wait builds a generation the Go binary can query", async () => {
    const before = JSON.parse(
      readFileSync(join(tsP.go.project, ".knowns", ".search", "qdrant.json"), "utf8"),
    ).collectionName as string;
    const r = await runTsIn(tsP, ["search", "index", "--wait", "--plain"], {
      KNOWNS_RUNTIME_INLINE: "1",
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("semantic index completed\n");
    const ptr = JSON.parse(
      readFileSync(join(tsP.go.project, ".knowns", ".search", "qdrant.json"), "utf8"),
    );
    extra.push(ptr.collectionName);
    expect(ptr.collectionName).not.toBe(before);
    expect(ptr.chunkCount).toBeGreaterThan(0);
    const q = tsP.go.run(["search", "login", "--plain"], {
      ...tsP.goEnv,
      KNOWNS_RUNTIME_INLINE: "1",
    });
    expect(q.code, q.stderr).toBe(0);
    expect(q.stderr).not.toContain("degraded");
    // The previous generation is retained (inactive), the new one is recorded active.
    const gens = readFileSync(
      join(tsP.go.project, ".knowns", ".search", "qdrant-generations.jsonl"),
      "utf8",
    );
    expect(gens).toContain(ptr.collectionName);
  }, 180_000);
});
