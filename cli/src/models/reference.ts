// Port of internal/models/reference.go.
import { z } from "zod";
import { int } from "./common.ts";

/** Default relation for plain refs. */
export const SEMANTIC_REFERENCE_RELATION_REFERENCES = "references";

export const docReferenceFragmentSchema = z.object({
  raw: z.string().optional(),
  line: int.optional(),
  rangeStart: int.optional(),
  rangeEnd: int.optional(),
  heading: z.string().optional(),
});
export type DocReferenceFragment = z.infer<typeof docReferenceFragmentSchema>;

export const semanticReferenceSchema = z.object({
  raw: z.string(),
  canonical: z.string(),
  type: z.string(),
  target: z.string(),
  relation: z.string(),
  explicitRelation: z.boolean().optional(),
  validRelation: z.boolean(),
  legacy: z.boolean().optional(),
  fragment: docReferenceFragmentSchema.optional(),
});
export type SemanticReference = z.infer<typeof semanticReferenceSchema>;

export const resolvedEntitySchema = z.object({
  type: z.string(),
  id: z.string(),
  path: z.string().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  tags: z.array(z.string()).optional(),
  memoryLayer: z.string().optional(),
  category: z.string().optional(),
  imported: z.boolean().optional(),
  source: z.string().optional(),
});
export type ResolvedEntity = z.infer<typeof resolvedEntitySchema>;

export const semanticResolutionSchema = z.object({
  reference: semanticReferenceSchema,
  entity: resolvedEntitySchema.optional(),
  found: z.boolean(),
});
export type SemanticResolution = z.infer<typeof semanticResolutionSchema>;
