// Public surface of the search library (port of internal/search). No CLI code is imported here and
// project storage is reached only through the wired `Storage` of createStorage.
//
//   keyword search      new Engine({ storage }).search(...)           BM25, no network
//   runtime search      searchWithRuntime(storage, env, opts)         semantic first, keyword fallback
//   retrieval           retrieveWithRuntime(storage, env, opts)       candidates + context pack
//
// Seams left for later waves: the runtime queue (`SearchEnvironment.queueReindex`), the reference
// extractor (`SearchEnvironment.references`), the machine-level embedding registry
// (`SearchEnvironment.embeddingRegistry`), and the generation builder / index service that write
// Qdrant collections (this port reads them).
export * from "./chunker.ts";
export * from "./config.ts";
export * from "./embedder.ts";
export * from "./engine.ts";
export * from "./errors.ts";
export { fma, fusedMultiplyAddEnabled, mulAdd, setFusedMultiplyAdd } from "./fma.ts";
export * from "./hash.ts";
export { float32ArrayJson, float32Json, goJson } from "./json.ts";
export * from "./lexical.ts";
export * from "./ollama.ts";
export * from "./qdrant/client.ts";
export * from "./qdrant/payload.ts";
export * from "./qdrant/pointer.ts";
export * from "./qdrant/store.ts";
export * from "./qdrant/validation.ts";
export * from "./readiness.ts";
export * from "./runtime.ts";
export * from "./types.ts";
