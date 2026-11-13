// Port of internal/models/search.go.
import { z } from "zod";
import { int, nilableArray, timestampSchema } from "./common.ts";
import { taskLifecycleStateSchema } from "./task.ts";

export const runtimeWarningSchema = z.object({
  degraded: z.boolean().optional(),
  warming: z.boolean().optional(),
  bootstrapQueued: z.boolean().optional(),
  mode: z.string().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
});
export type RuntimeWarning = z.infer<typeof runtimeWarningSchema>;

/** A hit across tasks, docs, memories, decisions, and code. */
export const searchResultSchema = z.object({
  /** "task", "doc", "memory", "decision", or "code". */
  type: z.string(),
  id: z.string(),
  title: z.string(),
  /** For hybrid results a RANK (best = 1.0), not a similarity. */
  score: z.number(),
  /** Raw cosine similarity of the best chunk; absolute, unlike `score`. */
  semanticScore: z.number().optional(),
  snippet: z.string().optional(),
  /** "keyword" and/or "semantic". */
  matchedBy: z.array(z.string()).optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  lifecycleState: taskLifecycleStateSchema.optional(),
  completedAt: timestampSchema.optional(),
  archivedAt: timestampSchema.optional(),
  path: z.string().optional(),
  tags: z.array(z.string()).optional(),
  memoryLayer: z.string().optional(),
  category: z.string().optional(),
  memoryStore: z.string().optional(),
  name: z.string().optional(),
  signature: z.string().optional(),
  _runtime: runtimeWarningSchema.optional(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const retrievalOptionsSchema = z.object({
  query: z.string(),
  mode: z.string().optional(),
  limit: int.optional(),
  sourceTypes: z.array(z.string()).optional(),
  expandReferences: z.boolean().optional(),
  tag: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  assignee: z.string().optional(),
  label: z.string().optional(),
  includeHistorical: z.boolean().optional(),
});
export type RetrievalOptions = z.infer<typeof retrievalOptionsSchema>;

export const citationSchema = z.object({
  type: z.string(),
  id: z.string(),
  path: z.string().optional(),
  section: z.string().optional(),
});
export type Citation = z.infer<typeof citationSchema>;

export const sourceRecordSchema = z.object({
  type: z.string(),
  id: z.string(),
  path: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  lifecycleState: taskLifecycleStateSchema.optional(),
  completedAt: timestampSchema.optional(),
  archivedAt: timestampSchema.optional(),
  memoryLayer: z.string().optional(),
  category: z.string().optional(),
  memoryStore: z.string().optional(),
  updatedAt: timestampSchema.optional(),
  imported: z.boolean().optional(),
  source: z.string().optional(),
});
export type SourceRecord = z.infer<typeof sourceRecordSchema>;

export const retrievalCandidateSchema = z.object({
  type: z.string(),
  id: z.string(),
  title: z.string(),
  path: z.string().optional(),
  score: z.number(),
  matchedBy: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  citation: citationSchema,
  directMatch: z.boolean(),
  expandedFrom: z.array(z.string()).optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  lifecycleState: taskLifecycleStateSchema.optional(),
  completedAt: timestampSchema.optional(),
  archivedAt: timestampSchema.optional(),
  tags: z.array(z.string()).optional(),
  memoryLayer: z.string().optional(),
  category: z.string().optional(),
  memoryStore: z.string().optional(),
  sourcePreference: int,
  updatedAt: timestampSchema.optional(),
  metadata: sourceRecordSchema,
});
export type RetrievalCandidate = z.infer<typeof retrievalCandidateSchema>;

export const contextItemSchema = z.object({
  type: z.string(),
  id: z.string(),
  title: z.string(),
  content: z.string(),
  snippet: z.string().optional(),
  directMatch: z.boolean(),
  expandedFrom: z.array(z.string()).optional(),
  citation: citationSchema,
  lifecycleState: taskLifecycleStateSchema.optional(),
  completedAt: timestampSchema.optional(),
  archivedAt: timestampSchema.optional(),
  metadata: sourceRecordSchema,
});
export type ContextItem = z.infer<typeof contextItemSchema>;

export const contextPackSchema = z.object({
  items: nilableArray(contextItemSchema),
  mode: z.string(),
});
export type ContextPack = z.infer<typeof contextPackSchema>;

export const retrievalResponseSchema = z.object({
  query: z.string(),
  mode: z.string(),
  candidates: nilableArray(retrievalCandidateSchema),
  contextPack: contextPackSchema,
});
export type RetrievalResponse = z.infer<typeof retrievalResponseSchema>;
