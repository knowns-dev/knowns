// Types from internal/registry/registry.go. The registry operations (add, scan, save) are ported
// with the workspace registry in TSR-2BD194's later tasks; storage/core only reads it to resolve
// store-linked projects.
import { z } from "zod";

/** Names where a store-linked project keeps its knowledge: folder `project` in store clone `name`. */
export const storeMappingSchema = z.object({
  name: z.string(),
  project: z.string(),
  remote: z.string().optional(),
});
export type StoreMapping = z.infer<typeof storeMappingSchema>;

export const registryProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  lastUsed: z.string(),
  store: storeMappingSchema.optional(),
  /** Per-machine settings of a store-linked project; values are raw JSON. */
  machine: z.record(z.string(), z.unknown()).optional(),
});
export type RegistryProject = z.infer<typeof registryProjectSchema>;

/** Contents of ~/.knowns/registry.json: a bare JSON array of projects. */
export const registryFileSchema = z.array(registryProjectSchema);
export type RegistryFile = z.infer<typeof registryFileSchema>;
