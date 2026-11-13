// `search` and `retrieve` against the real services: a Qdrant collection written by the Go binary
// (Ollama all-minilm embeddings) is queried by the Go CLI and by the TypeScript CLI in the same
// project and home, and the two must print the same thing. Skipped unless Qdrant (6333), Ollama
// (11434, all-minilm) and a Go binary are reachable; the collection it creates is deleted afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildLiveProject, detectLive, type LiveProject } from "../../search/live.ts";
import { runTs } from "../oracle.ts";

const live = await detectLive();
const suite = live.available ? describe : describe.skip;
if (!live.available) console.warn(`search.live.test.ts skipped: ${live.why}`);

suite("search and retrieve over a live Go-written Qdrant index", () => {
  let p: LiveProject;
  beforeAll(async () => {
    p = await buildLiveProject({ source: "full" });
  }, 180_000);
  afterAll(async () => {
    await p?.dispose();
  });

  async function both(args: string[], extra: Record<string, string> = {}) {
    const go = p.go.run(args, { ...p.goEnv, ...extra });
    // The storage layer reads the machine root from process.env.HOME.
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = p.go.home;
    process.env.USERPROFILE = p.go.home;
    try {
      const ts = await runTs(args, {
        cwd: p.go.project,
        env: {
          ...p.goEnv,
          ...extra,
          HOME: p.go.home,
          USERPROFILE: p.go.home,
          KNOWNS_RUNTIME_INLINE: "1",
          NO_COLOR: "1",
        },
      });
      return { go: { code: go.code, stdout: go.stdout, stderr: go.stderr }, ts };
    } finally {
      if (saved.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = saved.HOME;
      if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = saved.USERPROFILE;
    }
  }

  /** Go orders results with exactly equal scores by map iteration; compare with ties in one order. */
  const canonJSON = (text: string): string => {
    const v = JSON.parse(text) as unknown;
    const byScore = (a: { score: number; type: string; id: string }, b: typeof a) =>
      b.score - a.score || a.type.localeCompare(b.type) || a.id.localeCompare(b.id);
    if (Array.isArray(v)) return JSON.stringify([...v].sort(byScore), null, 2);
    const r = v as { candidates?: (typeof v)[]; contextPack?: { items?: unknown[] } };
    return JSON.stringify(r, null, 2);
  };

  const queries = ["login flow", "setup guide install", "controller pattern", "architecture"];

  for (const q of queries) {
    test(`search ${JSON.stringify(q)} --json is hybrid and equals Go`, async () => {
      const { go, ts } = await both(["search", q, "--json"]);
      expect(go.code, go.stderr).toBe(0);
      expect(ts.code, ts.stderr).toBe(0);
      expect(ts.stderr).toBe(go.stderr);
      expect(canonJSON(ts.stdout)).toBe(canonJSON(go.stdout));
      // The semantic leg answered: no runtime notice and at least one semantic match.
      expect(go.stdout).not.toContain("_runtime");
      expect(go.stdout).toContain('"semantic"');
    });

    test(`search ${JSON.stringify(q)} text output equals Go`, async () => {
      for (const mode of [[], ["--plain"], ["--type", "doc", "--plain"]]) {
        const { go, ts } = await both(["search", q, ...mode]);
        expect(ts.code).toBe(go.code);
        expect(ts.stderr).toBe(go.stderr);
        if (ts.stdout !== go.stdout) {
          // A tie in the score is the only legitimate difference: same lines in a different order.
          expect(ts.stdout.split("\n").sort()).toEqual(go.stdout.split("\n").sort());
        }
      }
    });

    test(`retrieve ${JSON.stringify(q)} equals Go`, async () => {
      const { go, ts } = await both(["retrieve", q, "--json"]);
      expect(go.code, go.stderr).toBe(0);
      expect(ts.code, ts.stderr).toBe(0);
      expect(canonJSON(ts.stdout)).toBe(canonJSON(go.stdout));
      const plain = await both(["retrieve", q, "--plain"]);
      expect(plain.ts.stderr).toBe(plain.go.stderr);
      expect(plain.ts.stdout.split("\n").sort()).toEqual(plain.go.stdout.split("\n").sort());
    });
  }

  test("the semantic leg is used only in hybrid mode", async () => {
    const { go, ts } = await both(["search", "login flow", "--keyword", "--json"]);
    expect(ts.stdout).toBe(go.stdout);
    expect(go.stdout).not.toContain('"semantic"');
  });

  test("a stopped Qdrant degrades to keyword with Go's notice", async () => {
    const { go, ts } = await both(["search", "login flow", "--plain"], {
      KNOWNS_QDRANT_URL: "http://127.0.0.1:1",
    });
    expect(ts.code).toBe(go.code);
    expect(ts.stdout).toBe(go.stdout);
    expect(ts.stderr).toBe(go.stderr);
    expect(go.stdout).toContain("semantic runtime unavailable");
  });

  test("status reports the live index as ready", async () => {
    const { go, ts } = await both(["search", "--status-check", "--plain"]);
    expect(ts.stdout).toBe(go.stdout);
    expect(go.stdout).toContain("ready");
  });
});
