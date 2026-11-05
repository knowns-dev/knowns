// Library half of `knowns resolve` (internal/cli/resolve.go plus the Store.ResolveRawReference and
// Store.StructuralResolve wrappers): the readers over a wired Storage and the plain text renderers.
// MCP and the server import this instead of the command.
import { extract, parse } from "../../domain/references/index.ts";
import type {
  DocReferenceFragment,
  SemanticResolution,
  StructuralResult,
} from "../../models/index.ts";
import type { Storage } from "../../storage/adapters.ts";
import {
  type ReferenceParser,
  resolveRawReference,
  type StructuralReaders,
  structuralResolve,
} from "../../storage/history/index.ts";

/** Go ignores every read error of a reference target ("not found"); so do these readers. */
function soft<T>(fn: () => T): Promise<T | undefined> {
  try {
    return Promise.resolve(fn());
  } catch {
    return Promise.resolve(undefined);
  }
}

/** The async read-only view the history library's resolvers take, over the wired stores. */
export function storageReaders(storage: Storage): StructuralReaders {
  return {
    tasks: {
      get: (id) => soft(() => storage.tasks.get(id)),
      listAll: async () => storage.tasks.listAll(),
    },
    docs: {
      get: (path) => soft(() => storage.docs.get(path)),
      list: async () => storage.docs.list(),
    },
    memory: {
      list: async (layer) => storage.memory.list(layer ?? ""),
      resolveReferenceTarget: (target) => soft(() => storage.memory.resolveReferenceTarget(target)),
    },
    decisions: {
      get: (id) => soft(() => storage.decisions.get(id)),
      list: async () => storage.decisions.list(),
    },
    templates: {
      get: (name) => soft(() => storage.templates.get(name)),
      list: async () => storage.templates.list(),
    },
  };
}

export const referenceParser: ReferenceParser = { parse, extract };

/** Go's field order is reference, entity, found; the library builds `found` first. */
function goOrder(r: SemanticResolution): SemanticResolution {
  return { reference: r.reference, ...(r.entity && { entity: r.entity }), found: r.found };
}

/** Store.ResolveRawReference. */
export async function resolveRaw(storage: Storage, raw: string): Promise<SemanticResolution> {
  return goOrder(await resolveRawReference(storageReaders(storage), referenceParser, raw));
}

/** Store.StructuralResolve. */
export function resolveStructural(
  storage: Storage,
  raw: string,
  params: Parameters<typeof structuralResolve>[3],
): Promise<StructuralResult> {
  return structuralResolve(storageReaders(storage), referenceParser, raw, params);
}

export function formatReferenceFragment(fragment: DocReferenceFragment | undefined): string {
  if (!fragment) return "";
  if ((fragment.heading ?? "") !== "") return `#${fragment.heading}`;
  if ((fragment.rangeStart ?? 0) > 0 && (fragment.rangeEnd ?? 0) > 0) {
    return `:${fragment.rangeStart}-${fragment.rangeEnd}`;
  }
  if ((fragment.line ?? 0) > 0) return `:${fragment.line}`;
  return fragment.raw ?? "";
}

export function plainResolution(resolution: SemanticResolution): string {
  const r = resolution.reference;
  let out = "";
  out += `Reference: ${r.raw}\n`;
  out += `Type: ${r.type}\n`;
  out += `Target: ${r.target}\n`;
  out += `Relation: ${r.relation}\n`;
  out += `Explicit Relation: ${r.explicitRelation === true}\n`;
  out += `Valid Relation: ${r.validRelation === true}\n`;
  out += `Resolved: ${resolution.found}\n`;
  if (r.fragment) out += `Fragment: ${formatReferenceFragment(r.fragment)}\n`;
  const e = resolution.entity;
  if (e) {
    out += `Entity Type: ${e.type}\n`;
    out += `Entity ID: ${e.id}\n`;
    if (e.path) out += `Path: ${e.path}\n`;
    if (e.title) out += `Title: ${e.title}\n`;
    if (e.status) out += `Status: ${e.status}\n`;
    if (e.priority) out += `Priority: ${e.priority}\n`;
    if (e.tags && e.tags.length > 0) out += `Tags: ${e.tags.join(", ")}\n`;
    if (e.memoryLayer) out += `Memory Layer: ${e.memoryLayer}\n`;
    if (e.category) out += `Category: ${e.category}\n`;
    if (e.imported) {
      out += "Imported: true\n";
      if (e.source) out += `Source: ${e.source}\n`;
    }
  }
  return out;
}

export function prettyResolution(resolution: SemanticResolution): string {
  return `Semantic Reference\n==================\n\n${plainResolution(resolution)}`;
}

export function plainStructuralResult(result: StructuralResult): string {
  let out = `Root: ${result.root.kind}:${result.root.id}\n`;
  if (result.root.title) out += `Root Title: ${result.root.title}\n`;
  const edges = result.edges ?? [];
  out += `Edges: ${edges.length}\n`;
  edges.forEach((e, i) => {
    out += `  [${i + 1}] ${e.source.kind}:${e.source.id} --${e.relation}--> ${e.target.kind}:${e.target.id} (depth=${e.depth}, origin=${e.origin}, dir=${e.direction})\n`;
  });
  const unresolved = result.unresolved ?? [];
  if (unresolved.length > 0) {
    out += `Unresolved: ${unresolved.length}\n`;
    for (const u of unresolved) out += `  - ${u.ref} (${u.reason})\n`;
  }
  return out;
}

export function prettyStructuralResult(result: StructuralResult): string {
  return `Structural Traversal\n====================\n\n${plainStructuralResult(result)}`;
}
