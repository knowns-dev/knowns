// Port of internal/models/doc.go.
import { z } from "zod";
import { int, timestampSchema } from "./common.ts";

/** models.Doc (JSON shape). `path` is relative to .knowns/docs/ without the `.md` suffix. */
export const docSchema = z.object({
  /** Stable identity (`doc-<32 hex>`); legacy docs may lack it until their next mutation. */
  id: z.string().optional(),
  path: z.string(),
  title: z.string(),
  description: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  order: int.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** Derived at load time. */
  folder: z.string().optional(),
  isImported: z.boolean().optional(),
  importSource: z.string().optional(),
  canonicalHash: z.string().optional(),
});
export type Doc = z.infer<typeof docSchema>;

/** docFrontmatter in internal/storage/doc_store.go. */
export const docFrontmatterSchema = z.object({
  id: z.string().optional(),
  title: z.string().default(""),
  description: z.string().nullish(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  tags: z.array(z.string()).nullish(),
  order: int.optional(),
});
export type DocFrontmatter = z.infer<typeof docFrontmatterSchema>;
