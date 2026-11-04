// Chunk boundaries, ids and metadata against the real Go chunker. Point ids derive from chunk
// ids, so a different split would orphan an index built by 0.34.1.
import { describe, expect, test } from "bun:test";
import type { DecisionEntry } from "../../src/models/decision.ts";
import type { MemoryEntry } from "../../src/models/memory.ts";
import type { Task } from "../../src/models/task.ts";
import { chunkDecision, chunkDocument, chunkMemory, chunkTask } from "../../src/search/chunker.ts";
import type { Chunk } from "../../src/search/types.ts";
import { askGo, hasSearchHelper } from "./search-helper.ts";

const suite = hasSearchHelper() ? describe : describe.skip;

/** The Go chunk's JSON (omitempty) as a TS chunk. */
function fromGo(c: Record<string, unknown>): Chunk {
  return { content: "", ...c } as unknown as Chunk;
}

function prune(c: Chunk): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === "embedding") continue;
    if (v === undefined || v === "" || v === 0 || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  // The Go struct always writes id, type, content and tokenCount.
  out.id = c.id;
  out.type = c.type;
  out.content = c.content;
  out.tokenCount = c.tokenCount;
  return out;
}

const normalize = (chunks: Chunk[]) => chunks.map(prune);
const goChunks = (r: unknown) =>
  ((r as { Chunks: Record<string, unknown>[] | null }).Chunks ?? []).map(fromGo);

const longPara = (n: number, w: string) =>
  Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");

const docs: {
  content: string;
  path: string;
  title: string;
  description: string;
  maxTokens: number;
}[] = [
  { content: "", path: "empty", title: "Empty", description: "", maxTokens: 512 },
  {
    content: "Just text, no headings.",
    path: "flat",
    title: "Flat",
    description: "A flat doc",
    maxTokens: 512,
  },
  {
    content:
      "# Title\n\nIntro under h1.\n\n## One\n\nBody one.\n\n### Deep\n\nDeep body.\n\n## Two\n\nBody two.",
    path: "guides/setup",
    title: "Setup",
    description: "How to set up",
    maxTokens: 512,
  },
  {
    content: `## Big\n\n${longPara(60, "alpha")}\n\n${longPara(60, "beta")}\n\n${longPara(60, "gamma")}\n\n## Small\n\nok`,
    path: "big",
    title: "Big",
    description: "",
    maxTokens: 80,
  },
  {
    content: "## Win\r\n\r\nCRLF body line\r\n\r\n## Next\r\n\r\nmore\r\n",
    path: "crlf",
    title: "CRLF",
    description: "d",
    maxTokens: 512,
  },
  {
    content:
      "# Code\n\n```md\n# not a heading\n## nor this\n```\n\n## Real\n\ntext\n\n```\n## unclosed\n",
    path: "fences",
    title: "Fences",
    description: "",
    maxTokens: 512,
  },
  {
    content:
      "## Tiếng Việt\n\nXin chào thế giới, đây là một đoạn văn dài hơn một chút.\n\n## 日本語\n\n本文です。",
    path: "unicode/vi",
    title: "Unicode",
    description: "Mô tả",
    maxTokens: 20,
  },
  {
    content: "#NoSpace\n\n# \n\n#  Spaced   \n\nbody\n\n####### seven",
    path: "odd",
    title: "Odd",
    description: "",
    maxTokens: 0,
  },
];

const task = (extra: Partial<Task> = {}): Task => ({
  id: "FX-1",
  title: "Implement login",
  description: "Users sign in with email.",
  status: "in-progress",
  priority: "high",
  labels: ["auth", "feature"],
  createdAt: "2026-11-03T13:37:35.549Z",
  updatedAt: "2026-11-03T13:37:35.549Z",
  archived: false,
  acceptanceCriteria: [
    { text: "Valid credentials sign in", completed: true },
    { text: "Invalid credentials are rejected", completed: false },
  ],
  timeSpent: 0,
  implementationPlan: "1. a\n\n2. b",
  implementationNotes: "done",
  ...extra,
});

const memory = (extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: "mem1",
  title: "Prefer bun",
  layer: "project",
  category: "preference",
  content: "Use bun, not node.",
  createdAt: "2026-11-03T13:37:35.549Z",
  updatedAt: "2026-11-03T13:37:35.549Z",
  ...extra,
});

const decision = (extra: Partial<DecisionEntry> = {}): DecisionEntry => ({
  id: "20261103-1337-use-bun",
  title: "Use bun",
  status: "accepted",
  tags: ["runtime"],
  sources: ["doc:architecture"],
  relatedDocs: ["architecture"],
  relatedTasks: ["FX-1"],
  context: "Scripts",
  decision: "Bun",
  alternativesConsidered: "",
  consequences: "One binary",
  content: "Body",
  createdAt: "2026-11-03T13:37:35.549Z",
  updatedAt: "2026-11-03T13:37:35.549Z",
  ...extra,
});

suite("chunker against Go", () => {
  test("documents", () => {
    const expected = askGo(docs.map((d) => ({ op: "chunkDoc", ...d })));
    docs.forEach((d, i) => {
      const got = chunkDocument(d.content, d.path, d.title, d.description, d.maxTokens);
      expect(normalize(got.chunks), d.path).toEqual(normalize(goChunks(expected[i])));
      expect(got.totalTokens, d.path).toBe((expected[i] as { TotalTokens: number }).TotalTokens);
    });
  });

  test("tasks", () => {
    const longPlan = [longPara(40, "step"), longPara(40, "next"), longPara(40, "last")].join(
      "\n\n",
    );
    const cases = [
      { t: task(), max: 512 },
      { t: task({ description: "", labels: null, acceptanceCriteria: null }), max: 512 },
      { t: task({ implementationPlan: longPlan, implementationNotes: longPlan }), max: 60 },
      { t: task({ description: longPlan }), max: 30 },
    ];
    const expected = askGo(cases.map((c) => ({ op: "chunkTask", task: c.t, maxTokens: c.max })));
    cases.forEach((c, i) => {
      const got = chunkTask(c.t, c.max);
      expect(normalize(got.chunks)).toEqual(normalize(goChunks(expected[i])));
      expect(got.totalTokens).toBe((expected[i] as { TotalTokens: number }).TotalTokens);
    });
  });

  test("memories", () => {
    const cases = [
      { m: memory(), max: 512 },
      { m: memory({ category: "", content: "" }), max: 512 },
      { m: memory({ title: "", category: "", content: "" }), max: 512 },
      { m: memory({ content: `${longPara(50, "m")}\n\n${longPara(50, "n")}` }), max: 40 },
      { m: memory({ layer: "global", content: "claim\n\n<!-- detail -->\n\nrest" }), max: 512 },
    ];
    const expected = askGo(
      cases.map((c) => ({ op: "chunkMemory", memory: c.m, maxTokens: c.max })),
    );
    cases.forEach((c, i) => {
      const got = chunkMemory(c.m, c.max);
      expect(normalize(got.chunks)).toEqual(normalize(goChunks(expected[i])));
      expect(got.totalTokens).toBe((expected[i] as { TotalTokens: number }).TotalTokens);
    });
  });

  test("decisions", () => {
    const cases = [
      { d: decision(), max: 512 },
      {
        d: decision({ tags: [], sources: [], relatedDocs: [], relatedTasks: [], content: "" }),
        max: 512,
      },
      { d: decision({ context: longPara(60, "c"), decision: longPara(60, "d") }), max: 50 },
    ];
    const expected = askGo(
      cases.map((c) => ({ op: "chunkDecision", decision: c.d, maxTokens: c.max })),
    );
    cases.forEach((c, i) => {
      const got = chunkDecision(c.d, c.max);
      expect(normalize(got.chunks)).toEqual(normalize(goChunks(expected[i])));
      expect(got.totalTokens).toBe((expected[i] as { TotalTokens: number }).TotalTokens);
    });
  });
});
