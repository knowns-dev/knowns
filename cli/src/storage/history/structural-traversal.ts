// Port of internal/storage/structural_traversal.go.
import {
  normalizeStructuralParams,
  type StructuralEdge,
  type StructuralEntity,
  type StructuralParams,
  type StructuralResult,
  type UnresolvedEdge,
} from "../../models/index.ts";
import type { ReferenceParser } from "./reference-resolution.ts";
import { resolveReference } from "./reference-resolution.ts";
import {
  collectAllEdges,
  errInvalidRef,
  makeSet,
  type RawEdge,
  type StructuralReaders,
} from "./structural-edges.ts";

/** StructuralResult with the nilable arrays narrowed: Go always returns non-nil slices here. */
export interface ResolvedStructuralResult extends StructuralResult {
  edges: StructuralEdge[];
  unresolved: UnresolvedEdge[];
}

/**
 * Structural traversal from a semantic reference: resolves the root entity, then walks typed
 * relation edges (BFS) according to `params`. Throws `invalid semantic reference: "<raw>"`.
 */
export async function structuralResolve(
  readers: StructuralReaders,
  refs: ReferenceParser,
  raw: string,
  params: StructuralParams = {},
): Promise<ResolvedStructuralResult> {
  const ref = refs.parse(raw);
  if (!ref) throw errInvalidRef(raw);

  const p = normalizeStructuralParams(params);
  const maxDepth = p.depth ?? 1;

  const resolution = await resolveReference(readers, ref);
  const root: StructuralEntity = { kind: ref.type, id: ref.target };
  if (resolution.found && resolution.entity) {
    root.title = resolution.entity.title;
    if (resolution.entity.path) root.id = resolution.entity.path;
    else if (resolution.entity.id) root.id = resolution.entity.id;
  }

  const allEdges = await collectAllEdges(readers, refs);

  const result: ResolvedStructuralResult = { root, edges: [], unresolved: [] };
  const { edges, unresolved } = result;

  const rootKey = `${root.kind}:${root.id}`;
  const visited = new Set<string>([rootKey]);
  const relFilter = makeSet(p.relationTypes);
  const entFilter = makeSet(p.entityTypes);

  let frontier: string[] = [rootKey];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const currentKey of frontier) {
      let candidates: RawEdge[] = [];
      switch (p.direction) {
        case "outbound":
          candidates = allEdges.outbound.get(currentKey) ?? [];
          break;
        case "inbound":
          candidates = allEdges.inbound.get(currentKey) ?? [];
          break;
        case "both":
          candidates = [
            ...(allEdges.outbound.get(currentKey) ?? []),
            ...(allEdges.inbound.get(currentKey) ?? []),
          ];
          break;
      }

      for (const c of candidates) {
        if (relFilter && !relFilter.has(c.relation)) continue;

        let otherKey = c.targetKey;
        let otherKind = c.targetKind;
        let direction = "outbound";
        if (c.sourceKey === currentKey && c.targetKey === currentKey) continue; // self-reference
        if (c.targetKey === currentKey) {
          otherKey = c.sourceKey;
          otherKind = c.sourceKind;
          direction = "inbound";
        }

        if (entFilter && !entFilter.has(otherKind)) continue;

        if (!c.resolved) {
          unresolved.push({ ref: c.rawRef, reason: "entity not found" });
          continue;
        }

        edges.push({
          source: { kind: c.sourceKind, id: c.sourceID, title: c.sourceTitle },
          target: { kind: c.targetKind, id: c.targetID, title: c.targetTitle },
          relation: c.relation,
          direction,
          depth,
          origin: c.origin,
          resolved: true,
        });

        if (!visited.has(otherKey)) {
          visited.add(otherKey);
          nextFrontier.push(otherKey);
        }
      }
    }

    frontier = nextFrontier;
  }

  return result;
}
