// Port of internal/storage/structural_edges.go. The Go code is methods on *Store; here the entity
// stores are reached through the narrow, async `StructuralReaders` interface.
import {
  type DecisionEntry,
  type Doc,
  type MemoryEntry,
  ORIGIN_FIELD_BACKED,
  ORIGIN_INLINE,
  originPriority,
  type SemanticReference,
  type Task,
  type Template,
} from "../../models/index.ts";
import { type ReferenceParser, resolveReference } from "./reference-resolution.ts";

/**
 * Read-only view over the entity stores. All methods are async. "Not found" is represented by an
 * `undefined` (or `null`) return value, never a throw (the Go `err != nil` branch for Get).
 */
export interface StructuralReaders {
  tasks: {
    get(id: string): Promise<Task | undefined | null>;
    listAll(): Promise<Task[]>;
  };
  docs: {
    get(path: string): Promise<Doc | undefined | null>;
    list(): Promise<Doc[]>;
  };
  memory: {
    /** `layer` empty/omitted lists every layer. */
    list(layer?: string): Promise<MemoryEntry[]>;
    resolveReferenceTarget(target: string): Promise<MemoryEntry | undefined | null>;
  };
  decisions: {
    get(id: string): Promise<DecisionEntry | undefined | null>;
    list(): Promise<DecisionEntry[]>;
  };
  templates: {
    get(name: string): Promise<Template | undefined | null>;
    list(): Promise<Template[]>;
  };
}

/** Internal edge representation used during collection and dedup. */
export interface RawEdge {
  sourceKind: string;
  sourceID: string;
  sourceTitle: string;
  /** "kind:id" */
  sourceKey: string;
  targetKind: string;
  targetID: string;
  targetTitle: string;
  /** "kind:id" */
  targetKey: string;
  relation: string;
  /** "field-backed", "inline", "code-graph" */
  origin: string;
  resolved: boolean;
  /** Original reference string for unresolved edges. */
  rawRef: string;
}

export function edgeDedupKey(e: RawEdge): string {
  return `${e.sourceKey}|${e.targetKey}|${e.relation}`;
}

export interface EdgeIndex {
  /** key: "kind:id" of source */
  outbound: Map<string, RawEdge[]>;
  /** key: "kind:id" of target */
  inbound: Map<string, RawEdge[]>;
}

/** Gathers edges from all sources, deduplicates, and returns an indexed structure. */
export async function collectAllEdges(
  readers: StructuralReaders,
  refs: ReferenceParser,
): Promise<EdgeIndex> {
  const all: RawEdge[] = [];
  all.push(...(await collectFieldBackedEdges(readers)));
  all.push(...(await collectInlineRefEdges(readers, refs)));

  const deduped = deduplicateRawEdges(all);
  const idx: EdgeIndex = { outbound: new Map(), inbound: new Map() };
  for (const e of deduped) {
    push(idx.outbound, e.sourceKey, e);
    push(idx.inbound, e.targetKey, e);
  }
  return idx;
}

function push(m: Map<string, RawEdge[]>, key: string, e: RawEdge): void {
  const list = m.get(key);
  if (list) list.push(e);
  else m.set(key, [e]);
}

/** Like Go's `_ = err`: a failing list yields an empty list. */
async function orEmpty<T>(p: Promise<T[]>): Promise<T[]> {
  try {
    return (await p) ?? [];
  } catch {
    return [];
  }
}

/** Extracts edges from task fields (parent, spec) and template docs. */
export async function collectFieldBackedEdges(readers: StructuralReaders): Promise<RawEdge[]> {
  let tasks: Task[];
  try {
    tasks = (await readers.tasks.listAll()) ?? [];
  } catch {
    return [];
  }

  const docs = await orEmpty(readers.docs.list());
  const docTitles = new Map<string, string>();
  for (const d of docs) docTitles.set(d.path, d.title);

  const taskTitles = new Map<string, string>();
  for (const t of tasks) taskTitles.set(t.id, t.title);

  const edges: RawEdge[] = [];

  for (const t of tasks) {
    const srcKey = `task:${t.id}`;

    if (t.parent) {
      const parentTitle = taskTitles.get(t.parent) ?? "";
      let resolved = parentTitle !== "" || t.parent === t.id;
      if (await readers.tasks.get(t.parent)) resolved = true;
      edges.push({
        sourceKind: "task",
        sourceID: t.id,
        sourceTitle: t.title,
        sourceKey: srcKey,
        targetKind: "task",
        targetID: t.parent,
        targetTitle: parentTitle,
        targetKey: `task:${t.parent}`,
        relation: "parent",
        origin: ORIGIN_FIELD_BACKED,
        resolved,
        rawRef: "",
      });
    }

    if (t.spec) {
      const specTitle = docTitles.get(t.spec) ?? "";
      let resolved = specTitle !== "";
      if (await readers.docs.get(t.spec)) resolved = true;
      const base: RawEdge = {
        sourceKind: "task",
        sourceID: t.id,
        sourceTitle: t.title,
        sourceKey: srcKey,
        targetKind: "doc",
        targetID: t.spec,
        targetTitle: specTitle,
        targetKey: `doc:${t.spec}`,
        relation: "spec",
        origin: ORIGIN_FIELD_BACKED,
        resolved,
        rawRef: "",
      };
      edges.push(base);
      // Derived "implements" edge, also field-backed.
      edges.push({ ...base, relation: "implements" });
    }
  }

  const templates = await orEmpty(readers.templates.list());
  for (const tmpl of templates) {
    if (!tmpl.doc) continue;
    const docTitle = docTitles.get(tmpl.doc) ?? "";
    let resolved = docTitle !== "";
    if (await readers.docs.get(tmpl.doc)) resolved = true;
    edges.push({
      sourceKind: "template",
      sourceID: tmpl.name,
      sourceTitle: tmpl.name,
      sourceKey: `template:${tmpl.name}`,
      targetKind: "doc",
      targetID: tmpl.doc,
      targetTitle: docTitle,
      targetKey: `doc:${tmpl.doc}`,
      relation: "template-for",
      origin: ORIGIN_FIELD_BACKED,
      resolved,
      rawRef: "",
    });
  }

  return edges;
}

/** Extracts edges from inline @references in task/doc/memory/decision content. */
export async function collectInlineRefEdges(
  readers: StructuralReaders,
  refs: ReferenceParser,
): Promise<RawEdge[]> {
  const edges: RawEdge[] = [];

  const add = async (kind: string, id: string, title: string, content: string) => {
    for (const ref of refs.extract(content)) {
      if (!ref.validRelation) continue;
      edges.push(await refToEdge(readers, kind, id, title, ref, ORIGIN_INLINE));
    }
  };

  for (const t of await orEmpty(readers.tasks.listAll())) {
    const content = [t.description ?? "", t.implementationPlan ?? "", t.implementationNotes ?? ""];
    await add("task", t.id, t.title, content.join("\n"));
  }

  for (const d of await orEmpty(readers.docs.list())) {
    await add("doc", d.path, d.title, d.content ?? "");
  }

  for (const m of await orEmpty(readers.memory.list(""))) {
    await add("memory", m.id, m.title, m.content ?? "");
  }

  for (const d of await orEmpty(readers.decisions.list())) {
    const content = [
      d.context ?? "",
      d.decision ?? "",
      d.alternativesConsidered ?? "",
      d.consequences ?? "",
      d.content ?? "",
      (d.sources ?? []).join("\n"),
      (d.relatedDocs ?? []).join("\n"),
      (d.relatedTasks ?? []).join("\n"),
    ].join("\n");
    await add("decision", d.id, d.title, content);
  }

  return edges;
}

/** Converts a parsed semantic reference into a RawEdge. */
export async function refToEdge(
  readers: StructuralReaders,
  srcKind: string,
  srcID: string,
  srcTitle: string,
  ref: SemanticReference,
  origin: string,
): Promise<RawEdge> {
  const targetKind = ref.type;
  let targetID = ref.target;
  let targetTitle = "";
  let resolved = false;

  const resolution = await resolveReference(readers, ref);
  if (resolution.found && resolution.entity) {
    resolved = true;
    targetTitle = resolution.entity.title ?? "";
    if (resolution.entity.path) targetID = resolution.entity.path;
    else if (resolution.entity.id) targetID = resolution.entity.id;
  }

  return {
    sourceKind: srcKind,
    sourceID: srcID,
    sourceTitle: srcTitle,
    sourceKey: `${srcKind}:${srcID}`,
    targetKind,
    targetID,
    targetTitle,
    targetKey: `${targetKind}:${targetID}`,
    relation: ref.relation,
    origin,
    resolved,
    rawRef: ref.raw,
  };
}

/** Keeps the highest-priority origin per (source, target, relation); first-seen order. */
export function deduplicateRawEdges(edges: RawEdge[]): RawEdge[] {
  const best = new Map<string, RawEdge>();
  for (const e of edges) {
    const key = edgeDedupKey(e);
    const existing = best.get(key);
    if (!existing || originPriority(e.origin) < originPriority(existing.origin)) best.set(key, e);
  }
  return [...best.values()];
}

/** Creates a lookup set from a string list (trimmed, blanks dropped). Empty result is undefined. */
export function makeSet(items: readonly string[] | undefined): Set<string> | undefined {
  if (!items || items.length === 0) return undefined;
  const set = new Set<string>();
  for (const item of items) {
    const t = item.trim();
    if (t !== "") set.add(t);
  }
  return set.size === 0 ? undefined : set;
}

export function errInvalidRef(raw: string): Error {
  return new Error(`invalid semantic reference: ${JSON.stringify(raw)}`);
}
