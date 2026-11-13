// Public surface of the reference library (port of internal/references). No CLI imports.
import type { ReferenceExtractor } from "../../search/engine.ts";
import { extract } from "./references.ts";

export * from "./references.ts";
export * from "./rewrite.ts";

/**
 * The adapter for `SearchEnvironment.references` / `Engine` deps: pass this to the search library so
 * `expandReferences` can follow inline references.
 */
export const referenceExtractor: ReferenceExtractor = { extract };
