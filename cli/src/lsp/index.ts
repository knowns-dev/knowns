// Public API of the LSP module: mirrors the Go names of internal/lsp (camelCased) so the MCP and
// HTTP ports call it the way Go calls internal/lsp. Adapters live in ./adapters/index.ts
// (allAdapters, all, find) and the daemon in ../lspdaemon/index.ts.

export {
  codeCapabilityProfile,
  documentConfigCapabilityProfile,
  hasCapability,
  missingCapabilities,
  normalizeCapabilities,
} from "./capabilities.ts";
export { extractFileLSP, findSourceFiles } from "./code-extract.ts";
export {
  buildCodeSummaries,
  type CodeBM25Result,
  CodeBM25Scorer,
  type CodeSummary,
  codeSymbolKindString,
  packageFromPath,
} from "./code-search.ts";
export { Config, type LanguageConfig } from "./config.ts";
export * from "./context.ts";
export { DependencyAdapter, defaultLSPBaseDir } from "./dependency-adapter.ts";
export { Detector, isAutoDetectionIgnoredDir, languageLogPath } from "./detect.ts";
export * from "./errors.ts";
export { type LookPath, lookPath, type RunCheck, type RunCommand, runProcess } from "./exec.ts";
export { currentPlatformID, Installer } from "./installer.ts";
export {
  languageInfoFromRuntimeStatus,
  languageTraceLogPath,
  Manager,
  runtimeBinariesForAdapter,
  tailLogFile,
} from "./manager.ts";
export { loadPluginAdapters, PluginAdapter } from "./plugin-adapter.ts";
export {
  collectProjectRuntimeStatuses,
  getLSPManagerForRoot,
  loadLspConfig,
  lspStatusFromRuntime,
} from "./project.ts";
export { findSymbolPosition, isSymbolRune, nameAt, snippet, utf16Col } from "./queries.ts";
export { builtinLanguages, Registry } from "./registry.ts";
export { csharpLogPath, RuntimeError } from "./runtime-error.ts";
export { Server, TraceLogWriter, type Writer } from "./server.ts";
export {
  applyRuntimeStatusOverlays,
  cloneLanguageRuntimeStatuses,
  collectRuntimeInventoryStatuses,
  collectRuntimeStatuses,
  type RuntimeStatusOptions,
  runtimeStatusJSON,
} from "./status.ts";
export * from "./types.ts";
export { fileURI, pathFromFileURI, sameFileURI } from "./uri.ts";
