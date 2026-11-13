import { describe, expect, test } from "bun:test";
import type {
  DecisionEntry,
  Doc,
  MemoryEntry,
  SemanticReference,
  Task,
  Template,
} from "../../src/models/index.ts";
import type { ReferenceParser } from "../../src/storage/history/reference-resolution.ts";
import { resolveRawReference } from "../../src/storage/history/reference-resolution.ts";
import type { StructuralReaders } from "../../src/storage/history/structural-edges.ts";

interface Data {
  tasks: Task[];
  docs: Doc[];
  memories: MemoryEntry[];
  decisions: DecisionEntry[];
  templates: Template[];
}

const RELATIONS = [
  "references",
  "implements",
  "depends",
  "blocked-by",
  "follows",
  "related",
  "spec",
  "parent",
];

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Minimal stand-in for internal/references (not ported yet).
function parseRef(raw: string): SemanticReference | undefined {
  const m = /^@(task|doc|memory|decision|template)[-/]([^{#]+?)(?:#([^{]+))?(?:\{([^}]+)\})?$/.exec(
    raw,
  );
  if (!m) return undefined;
  const type = m[1] as string;
  const target = m[2] as string;
  const rel = m[4];
  const relation = rel ?? "references";
  return {
    raw,
    canonical: `@${type}/${target}`,
    type,
    target,
    relation,
    explicitRelation: rel !== undefined,
    validRelation: RELATIONS.includes(relation),
    ...(m[3] ? { fragment: { heading: m[3] } } : {}),
  };
}

export const refs: ReferenceParser = {
  parse: parseRef,
  extract(content) {
    const out: SemanticReference[] = [];
    const re =
      /@(?:task|doc|memory|decision|template)[-/][A-Za-z0-9_./-]*[A-Za-z0-9_](?:\{[^}]+\})?/g;
    for (const m of content.matchAll(re)) {
      const r = parseRef(m[0]);
      if (r) out.push(r);
    }
    return out;
  },
};

const NOW = "2026-01-01T00:00:00Z";
export const task = (o: Partial<Task> & { id: string; title: string }): Task =>
  ({
    status: "todo",
    priority: "medium",
    labels: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...o,
  }) as Task;
export const doc = (o: Partial<Doc> & { path: string; title: string }): Doc =>
  ({ createdAt: NOW, updatedAt: NOW, ...o }) as Doc;
export const memory = (o: Partial<MemoryEntry> & { id: string; title: string }): MemoryEntry =>
  ({ layer: "project", createdAt: NOW, updatedAt: NOW, ...o }) as MemoryEntry;
export const decision = (
  o: Partial<DecisionEntry> & { id: string; title: string },
): DecisionEntry => ({ status: "accepted", createdAt: NOW, updatedAt: NOW, ...o }) as DecisionEntry;

export function makeReaders(d: Partial<Data>): StructuralReaders {
  const data: Data = { tasks: [], docs: [], memories: [], decisions: [], templates: [], ...d };
  return {
    tasks: {
      get: async (id) => data.tasks.find((t) => t.id === id),
      listAll: async () => data.tasks,
    },
    docs: { get: async (p) => data.docs.find((x) => x.path === p), list: async () => data.docs },
    memory: {
      list: async () => data.memories,
      resolveReferenceTarget: async (t) =>
        data.memories.find((m) => m.id === t || slug(m.title) === t),
    },
    decisions: {
      get: async (id) => data.decisions.find((x) => x.id === id),
      list: async () => data.decisions,
    },
    templates: {
      get: async (n) => data.templates.find((x) => x.name === n),
      list: async () => data.templates,
    },
  };
}

function seed() {
  return makeReaders({
    docs: [doc({ path: "guides/setup", title: "Setup Guide", tags: ["guide", "semantic"] })],
    tasks: [
      task({
        id: "rag001",
        title: "Implement runtime",
        status: "in-progress",
        priority: "high",
        labels: ["semantic", "cli"],
      }),
    ],
    memories: [
      memory({ id: "mem001", title: "Semantic note", category: "pattern", tags: ["semantic"] }),
    ],
    decisions: [decision({ id: "20260618-1024-use-qdrant", title: "Use Qdrant" })],
    templates: [{ name: "go-feature", description: "Go feature" } as never],
  });
}

describe("resolveRawReference", () => {
  test("doc with heading fragment and relation", async () => {
    const r = await resolveRawReference(seed(), refs, "@doc/guides/setup#overview{implements}");
    expect(r.found).toBe(true);
    expect(r.reference.relation).toBe("implements");
    expect(r.reference.fragment?.heading).toBe("overview");
    expect(r.entity).toMatchObject({ type: "doc", path: "guides/setup", id: "guides/setup" });
    expect(r.entity?.tags).toEqual(["guide", "semantic"]);
  });

  test("task, legacy and canonical forms agree", async () => {
    const a = await resolveRawReference(seed(), refs, "@task-rag001{blocked-by}");
    const b = await resolveRawReference(seed(), refs, "@task/rag001{blocked-by}");
    expect(a.entity).toMatchObject({
      status: "in-progress",
      priority: "high",
      tags: ["semantic", "cli"],
    });
    expect(b.entity?.id).toBe(a.entity?.id);
  });

  test("memory by id, canonical, and title slug", async () => {
    const a = await resolveRawReference(seed(), refs, "@memory-mem001");
    expect(a.reference.relation).toBe("references");
    expect(a.entity?.memoryLayer).toBe("project");
    expect(a.entity?.category).toBe("pattern");
    expect((await resolveRawReference(seed(), refs, "@memory/mem001")).entity?.id).toBe("mem001");
    const c = await resolveRawReference(seed(), refs, "@memory-semantic-note{follows}");
    expect(c.entity?.id).toBe("mem001");
    expect(c.reference.relation).toBe("follows");
  });

  test("decision and template", async () => {
    const d = await resolveRawReference(seed(), refs, "@decision/20260618-1024-use-qdrant");
    expect(d.entity?.status).toBe("accepted");
    const t = await resolveRawReference(seed(), refs, "@template/go-feature");
    expect(t.entity).toMatchObject({ type: "template", id: "go-feature", title: "go-feature" });
  });

  test("missing target is not found without entity", async () => {
    const r = await resolveRawReference(seed(), refs, "@task-nope");
    expect(r.found).toBe(false);
    expect(r.entity).toBeUndefined();
  });

  test("invalid ref throws", async () => {
    await expect(resolveRawReference(seed(), refs, "not-a-ref")).rejects.toThrow(
      'invalid semantic reference: "not-a-ref"',
    );
  });
});
