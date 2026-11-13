// Port of internal/models/structural.go.
import { z } from "zod";
import { int, nilableArray } from "./common.ts";

export const structuralParamsSchema = z.object({
  /** "outbound" (default), "inbound", or "both". */
  direction: z.string().optional(),
  /** Maximum traversal hops (1-3, default 1). */
  depth: int.optional(),
  relationTypes: z.array(z.string()).optional(),
  entityTypes: z.array(z.string()).optional(),
});
export type StructuralParams = z.infer<typeof structuralParamsSchema>;

export function isStructural(p: StructuralParams): boolean {
  return (
    (p.direction ?? "") !== "" ||
    (p.depth ?? 0) > 0 ||
    (p.relationTypes?.length ?? 0) > 0 ||
    (p.entityTypes?.length ?? 0) > 0
  );
}

/** StructuralParams.Normalize: fills defaults and clamps depth to 1..3. */
export function normalizeStructuralParams(p: StructuralParams): StructuralParams {
  const out = { ...p };
  if (!out.direction) out.direction = "outbound";
  let depth = out.depth ?? 0;
  if (depth <= 0) depth = 1;
  if (depth > 3) depth = 3;
  out.depth = depth;
  return out;
}

export const structuralEntitySchema = z.object({
  kind: z.string(),
  id: z.string(),
  title: z.string().optional(),
});
export type StructuralEntity = z.infer<typeof structuralEntitySchema>;

export const ORIGIN_FIELD_BACKED = "field-backed";
export const ORIGIN_INLINE = "inline";
export const ORIGIN_CODE_GRAPH = "code-graph";

export const structuralEdgeSchema = z.object({
  source: structuralEntitySchema,
  target: structuralEntitySchema,
  relation: z.string(),
  /** "outbound" or "inbound" relative to the traversal root. */
  direction: z.string(),
  /** 1-based hop count at which the edge was found. */
  depth: int,
  /** "field-backed", "inline", or "code-graph". */
  origin: z.string(),
  resolved: z.boolean(),
});
export type StructuralEdge = z.infer<typeof structuralEdgeSchema>;

export const unresolvedEdgeSchema = z.object({ ref: z.string(), reason: z.string() });
export type UnresolvedEdge = z.infer<typeof unresolvedEdgeSchema>;

export const structuralResultSchema = z.object({
  root: structuralEntitySchema,
  edges: nilableArray(structuralEdgeSchema),
  unresolved: nilableArray(unresolvedEdgeSchema),
});
export type StructuralResult = z.infer<typeof structuralResultSchema>;

/** OriginPriority: lower wins when deduplicating edges. */
export function originPriority(origin: string): number {
  switch (origin) {
    case ORIGIN_FIELD_BACKED:
      return 0;
    case ORIGIN_INLINE:
      return 1;
    case ORIGIN_CODE_GRAPH:
      return 2;
    default:
      return 3;
  }
}
