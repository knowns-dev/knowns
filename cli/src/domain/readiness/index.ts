// Port of internal/readiness: the unified readiness payload shared by `knowns status`, the HTTP
// status endpoint and MCP. No CLI imports.
//
// Seams (documented gaps, not hidden): the `lsp` section needs the LSP manager and adapters
// (TSR-XSEKND). `BuildOptions.lsp` takes the statuses from whoever has them; without it the
// section is empty and omitted from the JSON.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decisionCurrentForDefaultRetrieval } from "../../models/decision.ts";
import { isLegacyDecisionMemoryCategory } from "../../models/memory.ts";
import {
  environmentOf,
  type SearchEnvironment,
  semanticRuntimeDisabledReason,
} from "../../search/config.ts";
import { resolveSemanticIndexReadiness } from "../../search/readiness.ts";
import type { Storage } from "../../storage/adapters.ts";
import { VERSION } from "../../version.ts";
import type { RuntimeStatus } from "./runtime-status.ts";

export type { RuntimeStatus } from "./runtime-status.ts";
export { loadRuntimeReadiness, runtimeRoot } from "./runtime-status.ts";

export interface MemoryCounts {
  project: number;
  global: number;
  legacyDecision: number;
  awaitingReview: number;
}
export interface DecisionCounts {
  total: number;
  current: number;
  draft: number;
  historical: number;
}
export interface KnowledgeStatus {
  docs: number;
  tasks: number;
  templates: number;
  memories: MemoryCounts;
  decisions: DecisionCounts;
  relations: number;
  imports: number;
}
export interface SemanticRuntimeReadiness {
  enabled: boolean;
  disabledBy?: string;
  loaded: boolean;
  entries: number;
  activeSessions?: number;
  consumers?: number;
  idleTimeout?: string;
  idleUnloadAfter?: string;
}
export interface SearchStatus {
  semanticEnabled: boolean;
  modelConfigured: boolean;
  modelInstalled: boolean;
  projectIndexReady: boolean;
  projectIndexStale: boolean;
  projectIndexModel?: string;
  globalIndexReady: boolean;
  globalIndexStale: boolean;
  globalIndexModel?: string;
  lastReindex?: string;
  semanticRuntime?: SemanticRuntimeReadiness;
  semanticBackend?: string;
  semanticMode?: string;
  semanticDegraded?: boolean;
  semanticDegradedReason?: string;
}
/** One LSP language status (internal/readiness LSPStatus). Fields beyond these pass through. */
export interface LSPStatus {
  id: string;
  name: string;
  enabled: boolean;
  detected: boolean;
  status: string;
  installState: string;
  runningState: string;
  readinessState: string;
  binary?: string;
  source?: string;
  installCmd?: string;
  backend?: string;
  logPath?: string;
  [key: string]: unknown;
}
export interface PermissionStatus {
  preset: string;
  allowedCapabilities: string[];
  deniedCapabilities: string[];
  isDefault: boolean;
}
export interface Payload {
  active: boolean;
  projectName: string;
  projectPath: string;
  version: string;
  knowledge?: KnowledgeStatus;
  search?: SearchStatus;
  runtime?: RuntimeStatus;
  lsp?: LSPStatus[];
  permissions?: PermissionStatus;
  capabilities?: string[];
}

export interface BuildOptions {
  runtime?: RuntimeStatus;
  lsp?: LSPStatus[];
}

export function inactivePayload(): Payload {
  return { active: false, projectName: "", projectPath: "", version: VERSION };
}

function buildKnowledge(storage: Storage): KnowledgeStatus {
  const ks: KnowledgeStatus = {
    docs: 0,
    tasks: 0,
    templates: 0,
    memories: { project: 0, global: 0, legacyDecision: 0, awaitingReview: 0 },
    decisions: { total: 0, current: 0, draft: 0, historical: 0 },
    relations: 0,
    imports: 0,
  };
  try {
    ks.docs = storage.docs.list().length;
  } catch {
    // Go keeps the zero value when a list fails
  }
  try {
    ks.tasks = storage.tasks.listActive().length;
  } catch {}
  try {
    ks.templates = storage.templates.list().length;
  } catch {}

  const count = (entries: ReturnType<Storage["memory"]["listLocal"]>) => {
    for (const m of entries) {
      if (isLegacyDecisionMemoryCategory(m.category ?? "")) ks.memories.legacyDecision++;
      if (m.status === "proposed") ks.memories.awaitingReview++;
    }
  };
  try {
    const local = storage.memory.listLocal();
    ks.memories.project = local.length;
    count(local);
  } catch {}
  try {
    const global = storage.memory.listGlobalOnly();
    ks.memories.global = global.length;
    count(global);
  } catch {}

  try {
    const decisions = storage.decisions.list();
    ks.decisions.total = decisions.length;
    for (const d of decisions) {
      if (decisionCurrentForDefaultRetrieval(d)) ks.decisions.current++;
      else if (d.status === "draft") ks.decisions.draft++;
      else ks.decisions.historical++;
    }
  } catch {}

  // Imports: subdirectories of .knowns/imports that hold _import.json.
  const importsDir = join(storage.store.root, "imports");
  try {
    for (const e of readdirSync(importsDir, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(importsDir, e.name, "_import.json"))) ks.imports++;
    }
  } catch {}

  // Relations come from code_edges, which no longer exist (Store.CodeRefIndexExists is false).
  return ks;
}

/** buildSemanticRuntimeReadiness with the default (idle) runtime: no entries are ever loaded. */
function buildSemanticRuntimeReadiness(
  env: Record<string, string | undefined>,
): SemanticRuntimeReadiness {
  const { disabled, reason } = semanticRuntimeDisabledReason(env);
  const ms = Number.parseInt((env.KNOWNS_SEMANTIC_RUNTIME_IDLE_TIMEOUT_MS ?? "").trim(), 10);
  const idle = Number.isInteger(ms) && ms > 0 ? ms : 120_000;
  // Go's field order: enabled, disabledBy, loaded, entries, ..., idleTimeout.
  const out: SemanticRuntimeReadiness = {
    enabled: !disabled,
    ...(reason !== "" && { disabledBy: reason }),
    loaded: false,
    entries: 0,
    idleTimeout: formatGoDuration(Math.round(idle / 1000) * 1000),
  };
  return out;
}

/** time.Duration.String for whole seconds (the value is rounded to seconds first). */
function formatGoDuration(ms: number): string {
  let s = Math.round(ms / 1000);
  if (s === 0) return "0s";
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return `${h > 0 ? `${h}h` : ""}${h > 0 || m > 0 ? `${m}m` : ""}${s}s`;
}

function buildSearch(storage: Storage, env: SearchEnvironment): SearchStatus {
  const ss: SearchStatus = {
    semanticEnabled: false,
    modelConfigured: false,
    modelInstalled: false,
    projectIndexReady: false,
    projectIndexStale: false,
    globalIndexReady: false,
    globalIndexStale: false,
    semanticRuntime: buildSemanticRuntimeReadiness(environmentOf(env)),
  };
  let cfg: ReturnType<Storage["config"]["load"]>;
  try {
    cfg = storage.config.load();
  } catch {
    return ss;
  }

  const project = resolveSemanticIndexReadiness(storage, env);
  ss.semanticEnabled = project.enabled;
  if (project.backend) ss.semanticBackend = project.backend;
  if (project.mode) ss.semanticMode = project.mode;
  if (project.degraded) ss.semanticDegraded = true;
  if (project.reason) ss.semanticDegradedReason = project.reason;

  const sem = cfg.settings.semanticSearch;
  if (sem) {
    ss.modelConfigured = (sem.model ?? "") !== "";
    // Every provider manages model availability remotely: "installed" reduces to "configured".
    ss.modelInstalled = (sem.model ?? "") !== "";
  }

  ss.projectIndexReady = project.ready;
  ss.projectIndexStale = project.stale === true;
  if (project.model) ss.projectIndexModel = project.model;
  if (project.indexedAt && !project.indexedAt.startsWith("0001-01-01")) {
    ss.lastReindex = project.indexedAt;
  }

  const globalStorage = env.globalStorage?.();
  if (globalStorage) {
    const global = resolveSemanticIndexReadiness(globalStorage, env);
    ss.globalIndexReady = global.ready;
    ss.globalIndexStale = global.stale === true;
    if (global.model) ss.globalIndexModel = global.model;
  }
  return ss;
}

const PRESETS: Record<string, { allowed: string[]; denied: string[] }> = {
  "read-only": {
    allowed: ["read"],
    denied: ["admin", "archive", "delete", "generate", "write"],
  },
  "read-write": {
    allowed: ["archive", "delete", "generate", "read", "write"],
    denied: ["admin"],
  },
  "read-write-no-delete": {
    allowed: ["archive", "generate", "read", "write"],
    denied: ["admin", "delete"],
  },
  "generate-dry-run": {
    allowed: ["read"],
    denied: ["admin", "archive", "delete", "write"],
  },
};
const DEFAULT_PRESET = "read-write-no-delete";

function buildPermissions(storage: Storage): PermissionStatus {
  let preset = "";
  let isDefault = true;
  try {
    const cfg = storage.config.load();
    const p = cfg.settings.permissions;
    preset = p?.preset ?? "";
    isDefault = !p || (p.preset ?? "") === "";
  } catch {
    preset = "";
    isDefault = true;
  }
  // EffectivePolicy: an unknown preset falls back to the default policy.
  const name = preset === "" || !PRESETS[preset] ? DEFAULT_PRESET : preset;
  const policy = PRESETS[name] as { allowed: string[]; denied: string[] };
  return {
    preset: name,
    allowedCapabilities: [...policy.allowed],
    deniedCapabilities: [...policy.denied],
    isDefault,
  };
}

function buildCapabilities(ss: SearchStatus | undefined, rs: RuntimeStatus | undefined): string[] {
  const caps = [
    "task-updates",
    "doc-updates",
    "memory-tools",
    "system-decisions",
    "decision-migration",
    "validation",
    "search",
  ];
  if (ss?.semanticEnabled && ss.modelInstalled && ss.projectIndexReady)
    caps.push("semantic-search");
  caps.push("template-generation");
  if (ss?.projectIndexReady) caps.push("code-search", "graph");
  if (rs?.running && rs.state === "healthy") caps.push("browser-chat");
  return caps;
}

/** BuildReadiness: every section computed from the store; runtime and LSP come from the options. */
export function buildReadiness(
  storage: Storage,
  env: SearchEnvironment,
  opts: BuildOptions = {},
): Payload {
  const projectPath = storage.store.projectRoot;
  const parts = projectPath.split(/[\\/]/).filter((p) => p !== "");
  const p: Payload = {
    active: true,
    projectName: parts[parts.length - 1] ?? "/",
    projectPath,
    version: VERSION,
  };
  p.knowledge = buildKnowledge(storage);
  p.search = buildSearch(storage, env);
  if (opts.runtime) p.runtime = opts.runtime;
  if (opts.lsp && opts.lsp.length > 0) p.lsp = opts.lsp;
  p.permissions = buildPermissions(storage);
  p.capabilities = buildCapabilities(p.search, p.runtime);
  return p;
}
