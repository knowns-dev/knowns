// `knowns eval retrieval` against the Go 0.34.1 oracle: the canonical fixture and its embedded
// keyword baseline (gate, report, --json, --output, --update-baseline), project-local --cases, the
// strict fixture decoder, flag validation and the semantic readiness failures. Latency is wall
// clock and report-only, so its numbers are masked; everything else is compared byte for byte.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasGoBin } from "../oracle.ts";
import {
  goInTemplate,
  makeSandbox,
  type Outcome,
  type RunOptions,
  runGoIn,
  runTsIn,
  type Sandbox,
} from "./subprocess-diff.ts";

const t = test.skipIf(!hasGoBin);
let box: Sandbox;

function put(rel: string, text: string): void {
  writeFileSync(join(box.proj, rel), text);
}

beforeAll(() => {
  if (!hasGoBin) return;
  box = makeSandbox("knowns-eval-");
  mkdirSync(box.home, { recursive: true });
  mkdirSync(box.proj, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: box.proj });
  goInTemplate(box, ["init", "evals", "--no-wizard"]);
  const doc = (folder: string, title: string, content: string) =>
    goInTemplate(box, ["doc", "create", title, "-f", folder, "-c", content]);
  doc(
    "specs",
    "semantic-search",
    "Semantic search spec: embeddings, hybrid ranking and the vector store.",
  );
  doc("guides", "semantic-search-guide", "How to enable semantic search with Ollama and reindex.");
  doc(
    "specs",
    "rag-retrieval-foundation",
    "RAG retrieval foundation: candidates, context pack, citations.",
  );
  doc(
    "specs",
    "3-layer-memory-system",
    "The 3 layer memory system: working, project and global memory.",
  );
  doc(
    "guides",
    "cli-guide",
    "Knowns quick start: initialize a project, then task create, doc create, search.",
  );
  doc(
    "specs",
    "semantic-search-quality-improvements",
    "Search quality improvements for semantic ranking.",
  );
  doc("research", "rag-chunking-strategies-research", "Research on RAG chunking strategies.");
  doc("research", "research-graph-code-ux", "Graph code UX research for the code view.");
  doc("guides", "workflow-guide", "Workflow guide: tasks, plan, implement, verify.");

  put(
    "cases.json",
    JSON.stringify({
      schemaVersion: 1,
      cases: [
        {
          id: "c1",
          category: "exact",
          query: "semantic search",
          qrels: [
            { source: "specs/semantic-search", relevance: 3 },
            { source: "nope/doc", relevance: 1 },
          ],
          expectedCitations: ["doc:specs/semantic-search"],
          forbiddenSources: ["doc:guides/semantic-search-guide"],
          modes: ["keyword"],
          sourceTypes: ["doc"],
          notes: "notes <&> kept",
        },
        {
          id: "c2",
          category: "memory",
          query: "memory layers",
          qrels: [{ source: "specs/3-layer-memory-system", relevance: 2 }],
          expectedCitations: ["doc:specs/missing"],
          modes: ["keyword", "hybrid"],
          limit: 5,
        },
      ],
    }),
  );
  put("unknown-field.json", '{"schemaVersion":1,"cases":[{"id":"c1","bogus":1}]}');
  put("type-mismatch.json", '{"schemaVersion":"1","cases":[]}');
  put(
    "fraction.json",
    '{"schemaVersion":1,"cases":[{"id":"c1","category":"x","query":"q","qrels":[{"source":"a","relevance":1.5}],"modes":["keyword"]}]}',
  );
  put("two-values.json", '{"schemaVersion":1,"cases":[]} {}');
  put("trailing-garbage.json", '{"schemaVersion":1,"cases":[]} x');
  put("truncated.json", '{"schemaVersion":1,');
  put("empty.json", "");
  put("no-cases.json", '{"schemaVersion":1,"cases":[]}');
  put("bad-id.json", '{"schemaVersion":1,"cases":[{"id":"c 1"}]}');
  put(
    "no-relevant.json",
    '{"schemaVersion":1,"cases":[{"id":"c1","category":"x","query":"q","qrels":[{"source":"a","relevance":0}],"modes":["keyword"]}]}',
  );
  put(
    "dup-mode.json",
    '{"schemaVersion":1,"cases":[{"id":"c1","category":"x","query":"q","qrels":[{"source":"a","relevance":1}],"modes":["keyword","keyword"]}]}',
  );
  put("bad-baseline.json", '{"schemaVersion":2}');
}, 60_000);

afterAll(() => {
  if (box) rmSync(box.root, { recursive: true, force: true });
});

function mask(o: Outcome): Outcome {
  const m = (s: string) =>
    s
      .replace(/("(?:retrieval|evaluation|total|p50|p95)Millis": )[0-9.e+-]+/g, "$1N")
      .replace(/(latency=|p50=|p95=)[0-9.]+ms/g, "$1Nms");
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.files)) files[k] = m(v);
  return { code: o.code, stdout: m(o.stdout), stderr: m(o.stderr), files };
}

async function same(args: string[], opts: RunOptions = {}): Promise<Outcome> {
  const o = { ...opts, watch: ["proj/out", "proj/report.json", "proj/internal"] };
  const go = mask(await runGoIn(box, args, o));
  const ts = mask(await runTsIn(box, args, o));
  expect(ts).toEqual(go);
  return ts;
}

describe("canonical evaluation matches Go", () => {
  t("text report and gate", async () => {
    const r = await same(["eval", "retrieval"]);
    // The fixture digest matched the embedded baseline, so the run got as far as the gate.
    expect(r.stdout).toContain("Scope: canonical");
  });
  t("--json", () => same(["eval", "retrieval", "--json"]));
  t("--output writes the JSON report", async () => {
    const r = await same(["eval", "retrieval", "--output", "out/report.json"]);
    expect(Object.keys(r.files)).toContain("proj/out/report.json");
  });
  t("--update-baseline to an explicit path", async () => {
    const r = await same([
      "eval",
      "retrieval",
      "--update-baseline",
      "--reason",
      "reviewed",
      "--baseline",
      "out/b.json",
    ]);
    expect(r.code).toBe(0);
    expect(r.files["proj/out/b.json"] ?? "").toContain('"reason": "reviewed"');
  });
  t("--update-baseline to the canonical path", () =>
    same(["eval", "retrieval", "--update-baseline", "--reason", "reviewed"]),
  );
  t("an explicit baseline that does not decode", () =>
    same(["eval", "retrieval", "--baseline", "bad-baseline.json"]),
  );
  t("an explicit baseline that does not exist", () =>
    same(["eval", "retrieval", "--baseline", "missing.json"]),
  );
});

describe("project-local cases match Go", () => {
  t("report-only with hard invariants", () => same(["eval", "retrieval", "--cases", "cases.json"]));
  t("--json", () => same(["eval", "retrieval", "--cases", "cases.json", "--json"]));
  for (const file of [
    "unknown-field.json",
    "type-mismatch.json",
    "fraction.json",
    "two-values.json",
    "trailing-garbage.json",
    "truncated.json",
    "empty.json",
    "no-cases.json",
    "bad-id.json",
    "no-relevant.json",
    "dup-mode.json",
    "missing.json",
  ]) {
    t(`fixture ${file}`, () => same(["eval", "retrieval", "--cases", file]));
  }
});

describe("flag validation and readiness match Go", () => {
  for (const args of [
    ["--mode", "bogus"],
    ["--mode", "semantic"],
    ["--mode", "hybrid", "--runtime-id", "x"],
    ["--cases", "cases.json", "--baseline", "b.json"],
    ["--cases", "cases.json", "--update-baseline"],
    ["--update-baseline"],
    ["--mode", "semantic", "--runtime-id", "x", "--update-baseline", "--reason", "r"],
    ["extra"],
  ]) {
    t(args.join(" "), () => same(["eval", "retrieval", ...args]));
  }
  t("mock runtime pinned, canonical keyword baseline rejects the mode", () =>
    same(
      ["eval", "retrieval", "--mode", "semantic", "--runtime-id", "mock/mock-deterministic@32"],
      {
        env: { KNOWNS_EMBED_MOCK: "1" },
      },
    ),
  );
  t("mock runtime identity mismatch", () =>
    same(["eval", "retrieval", "--mode", "hybrid", "--runtime-id", "wrong"], {
      env: { KNOWNS_EMBED_MOCK: "1" },
    }),
  );
  t("runtime disabled", () =>
    same(
      [
        "eval",
        "retrieval",
        "--mode",
        "semantic",
        "--runtime-id",
        "ollama/qwen3-embedding:0.6b@1024",
      ],
      {
        env: { KNOWNS_SEMANTIC_RUNTIME: "0" },
      },
    ),
  );
  for (const args of [["eval"], ["eval", "--help"], ["eval", "retrieval", "--help"]]) {
    t(args.join(" "), () => same(args));
  }
});
