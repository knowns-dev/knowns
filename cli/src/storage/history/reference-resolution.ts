// Port of internal/storage/reference_resolution.go.
import type { ResolvedEntity, SemanticReference, SemanticResolution } from "../../models/index.ts";
import type { StructuralReaders } from "./structural-edges.ts";
import { errInvalidRef } from "./structural-edges.ts";

/**
 * Port of internal/references Parse/Extract (not yet ported to TS), injected so this module does
 * not duplicate the parser. `parse` returns undefined when `raw` is not a valid reference.
 */
export interface ReferenceParser {
  parse(raw: string): SemanticReference | undefined;
  extract(content: string): SemanticReference[];
}

/** Drops fields Go would omit via omitempty (empty strings, false, empty arrays). */
function entity(e: ResolvedEntity): ResolvedEntity {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (v === undefined || v === "" || v === false) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as ResolvedEntity;
}

/** Parses and resolves a semantic reference expression. Throws on an invalid reference. */
export async function resolveRawReference(
  readers: StructuralReaders,
  refs: ReferenceParser,
  raw: string,
): Promise<SemanticResolution> {
  const ref = refs.parse(raw);
  if (!ref) throw errInvalidRef(raw);
  return resolveReference(readers, ref);
}

/** Resolves a parsed semantic reference against the stores. Never throws on "not found". */
export async function resolveReference(
  readers: StructuralReaders,
  ref: SemanticReference,
): Promise<SemanticResolution> {
  const result: SemanticResolution = { reference: ref, found: false };

  switch (ref.type) {
    case "task": {
      const task = await readers.tasks.get(ref.target);
      if (!task) return result;
      result.entity = entity({
        type: "task",
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        tags: task.labels ?? undefined,
      });
      result.found = true;
      break;
    }
    case "doc": {
      const doc = await readers.docs.get(ref.target);
      if (!doc) return result;
      result.entity = entity({
        type: "doc",
        id: doc.path,
        path: doc.path,
        title: doc.title,
        tags: doc.tags,
        imported: doc.isImported,
        source: doc.importSource,
      });
      result.found = true;
      break;
    }
    case "memory": {
      const memory = await readers.memory.resolveReferenceTarget(ref.target);
      if (!memory) return result;
      result.entity = entity({
        type: "memory",
        id: memory.id,
        title: memory.title,
        tags: memory.tags,
        memoryLayer: memory.layer,
        category: memory.category,
      });
      result.found = true;
      break;
    }
    case "decision": {
      const decision = await readers.decisions.get(ref.target);
      if (!decision) return result;
      result.entity = entity({
        type: "decision",
        id: decision.id,
        title: decision.title,
        status: decision.status,
        tags: decision.tags,
      });
      result.found = true;
      break;
    }
    case "template": {
      const tmpl = await readers.templates.get(ref.target);
      if (!tmpl) return result;
      result.entity = entity({
        type: "template",
        id: ref.target,
        title: tmpl.name,
        imported: tmpl.imported,
        source: tmpl.importName,
      });
      result.found = true;
      break;
    }
  }

  return result;
}
