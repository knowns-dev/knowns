import { describe, expect, test } from "bun:test";
import type {
  DecisionEntry,
  Doc,
  MemoryEntry,
  SemanticReference,
  Task,
  Template,
} from "../../src/models/index.ts";
import {
  isStructural,
  normalizeStructuralParams,
  type StructuralEdge,
} from "../../src/models/index.ts";
import type { ReferenceParser } from "../../src/storage/history/reference-resolution.ts";
import type { StructuralReaders } from "../../src/storage/history/structural-edges.ts";
import { structuralResolve } from "../../src/storage/history/structural-traversal.ts";

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
    docs: [
      doc({
        path: "specs/auth",
        title: "Auth Spec",
        content: "# Auth Spec\n\nDepends on @doc/specs/base{depends}.",
      }),
      doc({ path: "specs/base", title: "Base Spec", content: "# Base" }),
      doc({
        path: "specs/current",
        title: "Current Spec",
        content: "Depends on @doc/specs/deleted-feature{depends}.",
      }),
    ],
    tasks: [
      task({ id: "task01", title: "Implement JWT", spec: "specs/auth" }),
      task({ id: "task02", title: "Implement OAuth", spec: "specs/auth" }),
      task({ id: "task03", title: "Implement RBAC", spec: "specs/auth" }),
      task({ id: "taskA", title: "Task A", description: "Blocked by @task-taskB{blocked-by}" }),
      task({ id: "taskB", title: "Task B", description: "Blocked by @task-taskC{blocked-by}" }),
      task({ id: "taskC", title: "Task C" }),
      task({ id: "child1", title: "Child Task", parent: "task01" }),
    ],
  });
}

const filter = (edges: StructuralEdge[], relation: string) =>
  edges.filter((e) => e.relation === relation);

describe("structuralResolve", () => {
  test("inbound implements is field-backed", async () => {
    const r = await structuralResolve(seed(), refs, "@doc/specs/auth{implements}", {
      direction: "inbound",
    });
    expect(r.root.kind).toBe("doc");
    expect(r.root.id).toBe("specs/auth");
    const edges = filter(r.edges, "implements");
    expect(edges).toHaveLength(3);
    for (const e of edges) {
      expect(e.origin).toBe("field-backed");
      expect(e.direction).toBe("inbound");
      expect(e.depth).toBe(1);
      expect(e.resolved).toBe(true);
    }
  });

  test("multi-hop blocked chain", async () => {
    const r = await structuralResolve(seed(), refs, "@task-taskA{blocked-by}", {
      direction: "outbound",
      depth: 2,
      relationTypes: ["blocked-by"],
    });
    const edges = filter(r.edges, "blocked-by");
    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((e) => e.depth))).toEqual(new Set([1, 2]));
    for (const e of edges) expect(e.origin).toBe("inline");
  });

  test("canonical and legacy refs", async () => {
    const readers = makeReaders({
      tasks: [
        task({
          id: "source",
          title: "Source",
          description:
            "See @task/target{related}, @memory-note{follows}, and @decision/20260618-1024-use-qdrant{depends}.",
        }),
        task({ id: "target", title: "Target" }),
      ],
      memories: [memory({ id: "mem001", title: "Note", category: "pattern" })],
      decisions: [
        decision({
          id: "20260618-1024-use-qdrant",
          title: "Use Qdrant",
          sources: ["@task/source"],
        }),
      ],
    });
    const r = await structuralResolve(readers, refs, "@task/source", {
      direction: "outbound",
      depth: 1,
    });
    const targets = r.edges.map((e) => `${e.target.kind}:${e.target.id}`);
    expect(targets).toContain("task:target");
    expect(targets).toContain("memory:mem001");
    expect(targets).toContain("decision:20260618-1024-use-qdrant");
  });

  test("field-backed wins over inline in dedup", async () => {
    const readers = makeReaders({
      docs: [doc({ path: "specs/api", title: "API Spec", content: "# API Spec" })],
      tasks: [
        task({
          id: "taskX",
          title: "Task X",
          spec: "specs/api",
          description: "Implements @doc/specs/api{implements}",
        }),
      ],
    });
    const r = await structuralResolve(readers, refs, "@doc/specs/api{implements}", {
      direction: "inbound",
      relationTypes: ["implements"],
    });
    const edges = filter(r.edges, "implements");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.origin).toBe("field-backed");
  });

  test("entity type filter", async () => {
    const r = await structuralResolve(seed(), refs, "@doc/specs/auth{references}", {
      direction: "inbound",
      entityTypes: ["task"],
    });
    expect(r.edges.length).toBeGreaterThan(0);
    for (const e of r.edges) expect(e.source.kind).toBe("task");
  });

  test("unresolved edge", async () => {
    const r = await structuralResolve(seed(), refs, "@doc/specs/current{depends}", {
      direction: "outbound",
    });
    expect(r.unresolved.length).toBeGreaterThan(0);
    expect(r.unresolved.some((u) => u.reason === "entity not found")).toBe(true);
    expect(r.unresolved[0]?.ref).toBe("@doc/specs/deleted-feature{depends}");
  });

  test("depth limit", async () => {
    const r = await structuralResolve(seed(), refs, "@task-taskA{blocked-by}", {
      direction: "outbound",
      depth: 1,
      relationTypes: ["blocked-by"],
    });
    const edges = filter(r.edges, "blocked-by");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.depth).toBe(1);
  });

  test("outbound spec edges from a task", async () => {
    const r = await structuralResolve(seed(), refs, "@task-task01{spec}", {
      direction: "outbound",
    });
    const edges = filter(r.edges, "spec");
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) expect(`${e.target.kind}:${e.target.id}`).toBe("doc:specs/auth");
  });

  test("parent relation", async () => {
    const r = await structuralResolve(seed(), refs, "@task-child1{parent}", {
      direction: "outbound",
      relationTypes: ["parent"],
    });
    const edges = filter(r.edges, "parent");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.target.id).toBe("task01");
    expect(edges[0]?.origin).toBe("field-backed");
  });

  test("both directions", async () => {
    const r = await structuralResolve(seed(), refs, "@task-taskB{blocked-by}", {
      direction: "both",
      relationTypes: ["blocked-by"],
    });
    expect(r.edges.length).toBeGreaterThanOrEqual(2);
    const dirs = new Set(r.edges.map((e) => e.direction));
    expect(dirs.has("inbound") && dirs.has("outbound")).toBe(true);
  });

  test("invalid ref throws Go-style message", async () => {
    await expect(
      structuralResolve(seed(), refs, "not-a-ref", { direction: "outbound" }),
    ).rejects.toThrow('invalid semantic reference: "not-a-ref"');
  });

  test("template-for edge and unresolved template doc", async () => {
    const readers = makeReaders({
      docs: [doc({ path: "guides/x", title: "X" })],
      templates: [
        { name: "t1", doc: "guides/x" } as never,
        { name: "t2", doc: "guides/missing" } as never,
      ],
    });
    const r = await structuralResolve(readers, refs, "@doc/guides/x", { direction: "inbound" });
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]?.relation).toBe("template-for");
    expect(r.edges[0]?.source).toEqual({ kind: "template", id: "t1", title: "t1" });
  });
});

describe("StructuralParams helpers", () => {
  test("normalize clamps and defaults", () => {
    expect(normalizeStructuralParams({ depth: 5 })).toMatchObject({
      depth: 3,
      direction: "outbound",
    });
    expect(normalizeStructuralParams({}).depth).toBe(1);
  });
  test("isStructural", () => {
    expect(isStructural({})).toBe(false);
    expect(isStructural({ direction: "inbound" })).toBe(true);
    expect(isStructural({ depth: 2 })).toBe(true);
    expect(isStructural({ relationTypes: ["spec"] })).toBe(true);
    expect(isStructural({ entityTypes: ["task"] })).toBe(true);
  });
});
