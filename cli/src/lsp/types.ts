// Shared shapes of internal/lsp. Field names of anything Go serializes equal the Go JSON tags, so
// a value can be JSON.stringify'd without a translation layer; omitempty fields are optional.
import type { Ctx } from "./context.ts";

// ---- LSP protocol shapes (queries.go) ----
export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export interface Location {
  uri: string;
  range: Range;
}
export interface Diagnostic {
  range: Range;
  severity?: number;
  message: string;
}
export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}
export interface WorkspaceSymbolResult {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}
export interface TextEdit {
  range: Range;
  newText: string;
}
export interface TextDocumentEdit {
  textDocument: { uri: string; version: number | null };
  edits: TextEdit[];
}
export interface WorkspaceEdit {
  changes: Record<string, TextEdit[]> | null;
  documentChanges: TextDocumentEdit[] | null;
}

/** WorkspaceEdit.AllChanges: merges Changes and DocumentChanges into URI -> edits. */
export function allChanges(w: WorkspaceEdit): Record<string, TextEdit[]> {
  if (w.changes && Object.keys(w.changes).length > 0) return w.changes;
  const result: Record<string, TextEdit[]> = {};
  for (const dc of w.documentChanges ?? []) {
    const list = result[dc.textDocument.uri] ?? [];
    list.push(...dc.edits);
    result[dc.textDocument.uri] = list;
  }
  return result;
}

// ---- Server lifecycle (adapter.go) ----
export const StatusNotInstalled = 0;
export const StatusInstalled = 1;
export const StatusStarting = 2;
export const StatusRunning = 3;
export const StatusCrashed = 4;
export const StatusDisabled = 5;
/** ServerStatus: iota values in Go order. 0 is the map zero value ("no status recorded"). */
export type ServerStatus = 0 | 1 | 2 | 3 | 4 | 5;

export function serverStatusString(s: ServerStatus): string {
  switch (s) {
    case StatusNotInstalled:
      return "not_installed";
    case StatusInstalled:
      return "installed";
    case StatusStarting:
      return "starting";
    case StatusRunning:
      return "running";
    case StatusCrashed:
      return "crashed";
    case StatusDisabled:
      return "disabled";
    default:
      return "unknown";
  }
}

export interface InstallGuide {
  command?: string;
  url?: string;
  knowns_cmd?: string;
  notes?: string;
}

export interface RuntimeDependency {
  id?: string;
  platform_id?: string;
  version?: string;
  recommended_version?: string;
  recommended_integrity?: string;
  source?: string;
  url?: string;
  sha256?: string;
  sha512?: string;
  package_source?: string;
  archive_type?: string;
  binary_name?: string;
  extract_path?: string;
  package_name?: string;
  packages?: string[];
}

export interface InstallSelector {
  latest?: boolean;
  version?: string;
}

export type DependencyResolver = (
  ctx: Ctx,
  dep: RuntimeDependency,
  selector: InstallSelector,
) => Promise<DependencyResolution>;

export interface InstallOptions {
  selector: InstallSelector;
  npmResolver?: DependencyResolver;
  releaseResolver?: DependencyResolver;
  beforeCleanup?: (path: string) => Promise<void> | void;
}

export interface DependencyResolution {
  dependency: RuntimeDependency;
  requested_version: string;
  resolved_version: string;
  source: string;
  integrity?: string;
  verified: boolean;
}

export interface ManagedDependencyStatus {
  language_id: string;
  version?: string;
  requested_version?: string;
  resolved_version?: string;
  source?: string;
  source_location?: string;
  integrity?: string;
  installed_at?: string;
  verified: boolean;
  cache_path?: string;
  selected_path?: string;
  cleanup_eligible: boolean;
  install_error?: string;
  update_error?: string;
  installed: boolean;
  installable: boolean;
  selected_version_id?: string;
}

export interface Prerequisite {
  name?: string;
  check_cmd?: string;
  install_hint?: string;
}

export interface BinaryCandidate {
  name: string;
  args?: string[];
  check_args?: string[];
}

export interface DocumentSyncOptions {
  languageID: string;
  suppress: boolean;
}

export interface PathCapabilityDecision {
  supported: boolean;
  capabilities?: string[];
  advertisedCapabilities?: string[];
  explanation?: string;
}

export interface CapabilityProfile {
  required: string[];
  legacyPushDiagnostics?: boolean;
  enforceAdvertised?: boolean;
}

/**
 * LanguageAdapter. The Go optional interfaces (PathMatcherAdapter, LazyStartAdapter,
 * PathDocumentSyncAdapter, PathCapabilityAdapter, CapabilityBaselineProvider,
 * RuntimeDependencyResolverProvider) are optional members here; test with `typeof a.m === "function"`.
 */
export interface LanguageAdapter {
  id(): string;
  name(): string;
  extensions(): string[];

  binaries(): BinaryCandidate[];
  prerequisites(): Prerequisite[];
  checkPrerequisites(ctx: Ctx): Promise<void>;
  installGuide(): InstallGuide;

  canInstall(): boolean;
  runtimeDeps(): RuntimeDependency[];
  install(ctx: Ctx, targetDir: string): Promise<string>;
  installedPath(): string | undefined;

  defaultArgs(): string[];
  initializeParams(
    root: string,
    settings: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined;
  initializationOptions(
    settings: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined;

  isIgnoredDir(name: string): boolean;
  normalizeSymbolName(name: string): string;
  supportsImplementation(): boolean;
  supportsReferences(): boolean;

  // Optional capabilities.
  pathMatchers?(): PathMatcher[];
  lazyStart?(): boolean;
  documentSyncForPath?(path: string): DocumentSyncOptions;
  pathCapabilityForAction?(
    path: string,
    action: string,
    capability: string,
  ): [PathCapabilityDecision, boolean];
  capabilityProfile?(): CapabilityProfile;
  resolveRuntimeDependency?(
    ctx: Ctx,
    dep: RuntimeDependency,
    selector: InstallSelector,
  ): Promise<DependencyResolution>;
  sourcePath?(): string;
}

/** BaseAdapter defaults; language adapters extend it. */
export abstract class BaseAdapter {
  isIgnoredDir(_name: string): boolean {
    return false;
  }
  normalizeSymbolName(name: string): string {
    return name;
  }
  supportsImplementation(): boolean {
    return true;
  }
  supportsReferences(): boolean {
    return true;
  }
}

// ---- Registry (registry.go) ----
export type PathMatcherKind = "suffix" | "exact_name" | "shebang";
export interface PathMatcher {
  kind: PathMatcherKind;
  pattern: string;
  priority?: number;
  explicitOnly?: boolean;
}
export interface Binary {
  name: string;
  args?: string[];
  checkArgs?: string[];
}
export interface Language {
  id: string;
  name: string;
  extensions?: string[];
  binaries?: Binary[];
  matchers?: PathMatcher[];
  lazyStart?: boolean;
}
export interface BackendAttempt {
  backend: string;
  status: string;
  reason?: string;
  path?: string;
}
export interface ServerCommand {
  language: string;
  name: string;
  path: string;
  args: string[];
  backend?: string;
  projectPath?: string;
  logPath?: string;
  attempts?: BackendAttempt[];
}

// ---- Capabilities (capabilities.go) ----
export const CapabilityDocumentSymbols = "document_symbols";
export const CapabilityWorkspaceSymbols = "workspace_symbols";
export const CapabilityDefinition = "definition";
export const CapabilityReferences = "references";
export const CapabilityRename = "rename";
export const CapabilityImplementation = "implementation";
export const CapabilityDiagnostics = "diagnostics";
export const CapabilityFormatting = "formatting";
export const CapabilityHover = "hover";
export const CapabilityCompletion = "completion";
export const CapabilityDocumentLinks = "document_links";

export interface CapabilitySnapshot {
  known: boolean;
  capabilities?: string[];
  advertised_capabilities?: string[];
  observed_capabilities?: string[];
}

// ---- Runtime status (status.go) ----
export const RuntimeInstallDisabled = "disabled";
export const RuntimeInstallInstalled = "installed";
export const RuntimeInstallNotInstalled = "not_installed";
export const RuntimeInstallError = "error";
export const RuntimeRunningDisabled = "disabled";
export const RuntimeRunningRunning = "running";
export const RuntimeRunningStarting = "starting";
export const RuntimeRunningStopped = "stopped";
export const RuntimeRunningCrashed = "crashed";
export const RuntimeRunningUnknown = "unknown";
export const RuntimeReadinessReady = "ready";
export const RuntimeReadinessIndexing = "indexing";
export const RuntimeReadinessUnknown = "unknown";
export const RuntimeReadinessNotApplicable = "not_applicable";
export const RuntimeSourcePATH = "PATH";
export const RuntimeSourceKnowns = "knowns";
export const RuntimeSourceConfig = "config";
export const RuntimeSourceAuto = "auto";
export const RuntimeStatusDegraded = "degraded";

/** LanguageRuntimeStatus. omitempty fields are optional; build with makeRuntimeStatus, serialize with runtimeStatusJSON. */
export interface LanguageRuntimeStatus {
  id: string;
  name: string;
  enabled: boolean;
  detected: boolean;
  status: string;
  install_state: string;
  running_state: string;
  readiness_state: string;
  binary?: string;
  binary_path?: string;
  source?: string;
  version?: string;
  requested_version?: string;
  resolved_version?: string;
  source_location?: string;
  integrity?: string;
  installed_at?: string;
  verified: boolean;
  cache_path?: string;
  selected_path?: string;
  cleanup_eligible?: boolean;
  install_error?: string;
  update_error?: string;
  install_cmd?: string;
  backend?: string;
  backend_source?: string;
  project_path?: string;
  project_kind?: string;
  log_path?: string;
  attempts?: BackendAttempt[];
  owner?: string;
  daemon_state?: string;
  daemon_pid?: number;
  daemon_clients?: number;
  daemon_transport?: string;
  daemon_endpoint?: string;
  daemon_idle_deadline?: string;
  daemon_lease_count?: number;
  daemon_lease_owners?: string[];
  capabilities_known?: boolean;
  capabilities?: string[];
  advertised_capabilities?: string[];
  observed_capabilities?: string[];
  required_capabilities?: string[];
  missing_capabilities?: string[];
}

/** Member of the Go LanguageInfo struct (camelCase JSON), used by the HTTP/MCP surfaces. */
export interface LanguageInfo {
  id: string;
  name: string;
  enabled: boolean;
  detected: boolean;
  status?: string;
  binary: string;
  binaryPath?: string;
  source?: string;
  installed: boolean;
  running: boolean;
  installState?: string;
  runningState?: string;
  readinessState?: string;
  version?: string;
  requestedVersion?: string;
  resolvedVersion?: string;
  sourceLocation?: string;
  integrity?: string;
  installedAt?: string;
  verified: boolean;
  cachePath?: string;
  selectedPath?: string;
  cleanupEligible?: boolean;
  installError?: string;
  updateError?: string;
  installHint?: string;
  backend?: string;
  backendSource?: string;
  projectPath?: string;
  projectKind?: string;
  logPath?: string;
  attempts?: BackendAttempt[];
  traceEnabled?: boolean;
  owner?: string;
  daemonState?: string;
  daemonPid?: number;
  daemonClients?: number;
  daemonTransport?: string;
  daemonEndpoint?: string;
  daemonIdleDeadline?: string;
  daemonLeaseCount?: number;
  daemonLeaseOwners?: string[];
  capabilitiesKnown?: boolean;
  capabilities?: string[];
  advertisedCapabilities?: string[];
  observedCapabilities?: string[];
  requiredCapabilities?: string[];
  missingCapabilities?: string[];
}

export interface MissingServer {
  languageID: string;
  name: string;
  binaryName: string;
  guide: InstallGuide;
}

export interface LogTail {
  language: string;
  kind: string;
  path: string;
  lines: string[];
}

// ---- Session (session.go) ----
export interface Session {
  start(ctx: Ctx): Promise<void>;
  stop(ctx: Ctx): Promise<void>;
  waitReady(ctx: Ctx): Promise<void>;
  alive(): boolean;
  withFile(ctx: Ctx, path: string, fn: () => Promise<void>): Promise<void>;
  didChange(ctx: Ctx, path: string, text: string): Promise<void>;

  definition(ctx: Ctx, path: string, line: number, col: number): Promise<Location>;
  references(ctx: Ctx, path: string, line: number, col: number): Promise<Location[]>;
  implementations(ctx: Ctx, path: string, line: number, col: number): Promise<Location[]>;
  diagnostics(ctx: Ctx, path: string): Promise<Diagnostic[]>;
  documentSymbols(ctx: Ctx, path: string): Promise<DocumentSymbol[]>;
  workspaceSymbol(ctx: Ctx, query: string): Promise<WorkspaceSymbolResult[]>;
  rename(
    ctx: Ctx,
    path: string,
    line: number,
    col: number,
    newName: string,
  ): Promise<WorkspaceEdit>;
}

// ---- Language ids and C# backend constants (csharp.go, dart.go) ----
export const CSharpLanguageID = "csharp";
export const CSharpBackendAuto = "auto";
export const CSharpBackendRoslyn = "roslyn-ls";
export const CSharpBackendCSharp = "csharp-ls";
export const CSharpBackendOmni = "omnisharp";
export const RoslynLanguageServerVersion = "5.0.0-1.25277.114";
export const RoslynNuGetPackagePrefix = "Microsoft.CodeAnalysis.LanguageServer";
export const BackendAttemptFailed = "failed";
export const BackendAttemptChosen = "selected";
export const BackendAttemptSkipped = "skipped";
export const DartLanguageID = "dart";
