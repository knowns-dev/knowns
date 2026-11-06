// Port of internal/doctor/local.go, search_checks.go, ai_checks.go and runtime_lsp_checks.go: the
// checks that read only local state. Every external fact (readiness, LSP, runtime hooks, skills)
// comes through `LocalDeps`, so tests can replace one without touching the machine.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { LanguageRuntimeStatus } from "../../lsp/types.ts";
import { type Project, resolveSkillsScope } from "../../models/config.ts";
import {
  OllamaState,
  ollamaStateGuidance,
} from "../../storage/stores/embedding-registry-defaults.ts";
import type { Payload } from "../readiness/index.ts";
import { lookPath as lookPathEnv } from "../setup/env.ts";
import type { Status as RuntimeHookStatus } from "../setup/runtimeinstall.ts";
import { type DoctorProject, skippedForMissingProject } from "./foundation.ts";
import type { Checker, CheckOutcome, Evidence } from "./model.ts";
import { type QdrantSnapshot, qdrantCheckers } from "./qdrant-checks.ts";

/** The slice of a service status the search.model check reads. */
export interface ServiceStatusLike {
  type: string;
  status: string;
  details: Record<string, string>;
}

export interface LocalDeps {
  /** Project config; loads once per run. */
  project: DoctorProject | undefined;
  env: Record<string, string | undefined>;
  readiness: () => Payload;
  embedding: () => ServiceStatusLike[];
  lspStatuses: (signal: AbortSignal) => Promise<LanguageRuntimeStatus[]>;
  lspIds: () => string[];
  runtimeHooks: () => RuntimeHookStatus[];
  runtimeNames: () => string[];
  skillsOutOfSync: (projectRoot: string) => boolean;
  globalSkills: () => string[];
  globalScope: () => string;
  exists: (path: string) => boolean;
  lookPath: (name: string) => string | undefined;
  readFile: (path: string) => string;
  qdrant: (signal: AbortSignal) => Promise<QdrantSnapshot>;
  /** Overrides $HOME for the "~" rewrite of global skill paths. */
  home?: () => string;
}

export function defaultExists(path: string): boolean {
  return existsSync(path);
}
export const defaultReadFile = (path: string): string => readFileSync(path, "utf8");

class Memo<T> {
  private v: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  constructor(private readonly load: () => T) {}
  get(): T {
    if (!this.v) {
      try {
        this.v = { ok: true, value: this.load() };
      } catch (error) {
        this.v = { ok: false, error };
      }
    }
    if (!this.v.ok) throw this.v.error;
    return this.v.value;
  }
}

export interface LocalState {
  deps: LocalDeps;
  config: () => Project;
  readiness: () => Payload;
  embedding: () => ServiceStatusLike[];
  runtimeHooks: () => RuntimeHookStatus[];
  qdrant: (signal: AbortSignal) => Promise<QdrantSnapshot>;
}

export function newLocalState(deps: LocalDeps): LocalState {
  const config = new Memo<Project>(() => {
    if (!deps.project) throw new Error("project store unavailable");
    return deps.project.storage.config.load();
  });
  const readiness = new Memo(deps.readiness);
  const embedding = new Memo(deps.embedding);
  const hooks = new Memo(deps.runtimeHooks);
  let qdrant: Promise<QdrantSnapshot> | undefined;
  return {
    deps,
    config: () => config.get(),
    readiness: () => readiness.get(),
    embedding: () => embedding.get(),
    runtimeHooks: () => hooks.get(),
    qdrant: (signal) => {
      qdrant ??= deps.qdrant(signal);
      return qdrant;
    },
  };
}

const subsystemDisabled = (summary: string, reason: string): CheckOutcome => ({
  status: "skip",
  summary,
  skipReason: reason,
});

const providerName = (p: string | undefined): string => (p === undefined || p === "" ? "local" : p);

function semanticSettings(state: LocalState) {
  return state.config().settings.semanticSearch;
}

/** time.Time.UTC().Format(time.RFC3339): whole seconds. */
function rfc3339(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// --- search ---------------------------------------------------------------------------------------

function searchCheckers(state: LocalState): Checker[] {
  const has = () => state.deps.project !== undefined;
  const checkers: Checker[] = [
    {
      id: "search.semantic",
      scope: "search",
      check: (): CheckOutcome => {
        if (!has()) return skippedForMissingProject();
        const s = semanticSettings(state);
        if (!s?.enabled) return subsystemDisabled("Semantic search is disabled", "config_disabled");
        const provider = providerName(s.provider);
        if ((s.model ?? "") === "") {
          return {
            status: "warn",
            summary: "Semantic search is enabled without a configured model",
            evidence: { provider },
            remediation: {
              description: "Choose an embedding model in Knowns settings.",
              command: "knowns settings",
            },
          };
        }
        return {
          status: "pass",
          summary: "Semantic search configuration is valid",
          evidence: { provider, model: s.model },
        };
      },
    },
    {
      id: "search.global-index",
      scope: "search",
      check: (): CheckOutcome => {
        if (!has()) return skippedForMissingProject();
        const s = semanticSettings(state);
        if (!s?.enabled) {
          return subsystemDisabled("Global semantic index is disabled", "config_disabled");
        }
        const payload = state.readiness();
        if (!payload.search) throw new Error("search readiness unavailable");
        const globalMemories = payload.knowledge?.memories.global ?? 0;
        if (globalMemories === 0) {
          return subsystemDisabled(
            "Global semantic index has no applicable memories",
            "not_applicable",
          );
        }
        if (payload.search.globalIndexStale) {
          let summary = "Global semantic index is stale";
          const indexModel = payload.search.globalIndexModel ?? "";
          if (indexModel !== "" && (s.model ?? "") !== "" && indexModel !== s.model) {
            summary = "Global semantic index was built with a different model";
          }
          const evidence: Evidence = {
            ready: true,
            indexModel,
            model: s.model ?? "",
            stale: true,
          };
          const reason = payload.search.semanticDegradedReason ?? "";
          if (reason !== "") evidence.reason = reason;
          return {
            status: "warn",
            summary,
            evidence,
            remediation: {
              description: "Rebuild the project and global semantic indices.",
              command: "knowns search index --wait",
            },
          };
        }
        if (!payload.search.globalIndexReady) {
          return {
            status: "warn",
            summary: "Global semantic index is empty or unavailable",
            evidence: { ready: false, globalMemories },
            remediation: {
              description: "Rebuild the project and global semantic indices.",
              command: "knowns search --reindex",
            },
          };
        }
        return {
          status: "pass",
          summary: "Global semantic index is ready",
          evidence: { ready: true, globalMemories },
        };
      },
    },
    {
      id: "search.model",
      scope: "search",
      check: (): CheckOutcome => {
        if (!has()) return skippedForMissingProject();
        const s = semanticSettings(state);
        if (!s?.enabled) {
          return subsystemDisabled("Semantic model check is disabled", "config_disabled");
        }
        if ((s.model ?? "") === "") {
          return {
            status: "warn",
            summary: "No semantic model is configured",
            remediation: {
              description: "Choose an embedding model in Knowns settings.",
              command: "knowns settings",
            },
          };
        }
        const provider = providerName(s.provider);
        if (provider === "ollama" && state.deps.lookPath("ollama") === undefined) {
          const guidance = ollamaStateGuidance(OllamaState.NotInstalled, s.model);
          return {
            status: "warn",
            summary: "Ollama is configured but is not installed",
            evidence: {
              model: s.model,
              provider,
              installed: false,
              errorCode: "provider_binary_missing",
            },
            remediation: { description: guidance.description, command: guidance.command },
          };
        }
        const embedding = state.embedding().find((x) => x.type === "embedding");
        if (!embedding) {
          return {
            status: "warn",
            summary: "Semantic model availability could not be established",
            evidence: { model: s.model, errorCode: "embedding_status_unavailable" },
            remediation: {
              description: "Inspect semantic runtime and model status.",
              command: "knowns runtime status",
            },
          };
        }
        if (
          embedding.status === "disabled" &&
          embedding.details.reason === "semantic runtime disabled"
        ) {
          return subsystemDisabled("Semantic runtime is explicitly disabled", "runtime_disabled");
        }
        const evidence: Evidence = { model: s.model, status: embedding.status, provider };
        if (embedding.status === "error") {
          evidence.errorCode = "embedding_configuration_invalid";
          return {
            status: "warn",
            summary: "Configured semantic model or provider is unavailable",
            evidence,
            remediation: {
              description: "Review the embedding model and provider configuration.",
              command: "knowns settings",
            },
          };
        }
        return {
          status: "pass",
          summary:
            provider === "ollama"
              ? "Configured semantic model is registered"
              : "Configured semantic model is available",
          evidence,
        };
      },
    },
    {
      id: "search.project-index",
      scope: "search",
      check: (): CheckOutcome => {
        if (!has()) return skippedForMissingProject();
        const s = semanticSettings(state);
        if (!s?.enabled) {
          return subsystemDisabled("Project semantic index is disabled", "config_disabled");
        }
        const payload = state.readiness();
        if (!payload.search) throw new Error("search readiness unavailable");
        if (payload.search.projectIndexStale) {
          let summary = "Project semantic index is stale";
          const indexModel = payload.search.projectIndexModel ?? "";
          if (indexModel !== "" && (s.model ?? "") !== "" && indexModel !== s.model) {
            summary = "Project semantic index was built with a different model";
          }
          const evidence: Evidence = {
            ready: true,
            indexModel,
            model: s.model ?? "",
            stale: true,
          };
          const reason = payload.search.semanticDegradedReason ?? "";
          if (reason !== "") evidence.reason = reason;
          return {
            status: "warn",
            summary,
            evidence,
            remediation: {
              description: "Rebuild the project and global semantic indices.",
              command: "knowns search index --wait",
            },
          };
        }
        if (!payload.search.projectIndexReady) {
          return {
            status: "warn",
            summary: "Project semantic index is empty or unavailable",
            evidence: { ready: false },
            remediation: {
              description: "Rebuild the project and global semantic indices.",
              command: "knowns search --reindex",
            },
          };
        }
        const evidence: Evidence = { ready: true };
        if (payload.search.lastReindex) evidence.indexedAt = rfc3339(payload.search.lastReindex);
        return { status: "pass", summary: "Project semantic index is ready", evidence };
      },
    },
    {
      id: "search.semantic-runtime",
      scope: "search",
      check: (): CheckOutcome => {
        if (!has()) return skippedForMissingProject();
        const s = semanticSettings(state);
        if (!s?.enabled) {
          return subsystemDisabled("Semantic runtime is disabled", "config_disabled");
        }
        const payload = state.readiness();
        const rt = payload.search?.semanticRuntime;
        if (!rt) {
          return {
            status: "warn",
            summary: "Semantic runtime status is unavailable",
            evidence: { errorCode: "semantic_runtime_status_unavailable" },
            remediation: {
              description: "Inspect the shared semantic runtime.",
              command: "knowns runtime status",
            },
          };
        }
        if (!rt.enabled) {
          return subsystemDisabled("Semantic runtime is explicitly disabled", "runtime_disabled");
        }
        return {
          status: "pass",
          summary: "Semantic runtime is available",
          evidence: {
            enabled: rt.enabled,
            loaded: rt.loaded,
            entries: rt.entries,
            activeSessions: rt.activeSessions ?? 0,
            consumers: rt.consumers ?? 0,
          },
        };
      },
    },
  ];
  return [...checkers, ...qdrantCheckers(state)];
}

// --- runtime and LSP ------------------------------------------------------------------------------

function runtimeCheckers(state: LocalState): Checker[] {
  return [
    {
      id: "runtime.managed-services",
      scope: "runtime",
      timeoutMs: 10_000,
      check: (): CheckOutcome => {
        if (!state.deps.project) return skippedForMissingProject();
        // Knowns manages no runtime service of its own any more (see Go).
        return {
          status: "skip",
          summary: "No configured managed runtime services",
          skipReason: "not_configured",
        };
      },
    },
  ];
}

function lspEvidence(s: LanguageRuntimeStatus): Evidence {
  const e: Evidence = {
    language: s.id,
    enabled: s.enabled,
    detected: s.detected,
    installState: s.install_state,
    runningState: s.running_state,
    readinessState: s.readiness_state,
  };
  if (s.backend) e.backend = s.backend;
  if (s.version) e.version = s.version;
  if (s.source) e.source = s.source;
  if (s.missing_capabilities && s.missing_capabilities.length > 0) {
    e.missingCapabilities = [...s.missing_capabilities];
  }
  if (s.daemon_state) e.daemonState = s.daemon_state;
  if (s.owner) e.owner = s.owner;
  if (s.daemon_pid && s.daemon_pid > 0) e.daemonPid = s.daemon_pid;
  if (s.capabilities && s.capabilities.length > 0) e.capabilities = [...s.capabilities];
  return e;
}

function lspCheckers(state: LocalState): Checker[] {
  let statuses: Promise<LanguageRuntimeStatus[]> | undefined;
  return state.deps.lspIds().map((languageId) => ({
    id: `lsp.${languageId}`,
    scope: "lsp" as const,
    timeoutMs: 10_000,
    check: async (signal: AbortSignal): Promise<CheckOutcome> => {
      if (!state.deps.project) return skippedForMissingProject();
      const cfg = state.config();
      const lsp = cfg.settings.lsp;
      if (lsp && lsp.enabled !== undefined && lsp.enabled === false) {
        return { status: "skip", summary: "LSP is disabled", skipReason: "config_disabled" };
      }
      statuses ??= state.deps.lspStatuses(signal);
      const status = (await statuses).find((s) => s.id === languageId);
      if (!status) {
        return {
          status: "skip",
          summary: "Language is not applicable",
          skipReason: "not_detected",
        };
      }
      const explicit = !!lsp?.languages && Object.hasOwn(lsp.languages, languageId);
      if (!status.enabled) {
        return {
          status: "skip",
          summary: `${status.name} LSP is disabled`,
          evidence: lspEvidence(status),
          skipReason: "config_disabled",
        };
      }
      if (!status.detected && !explicit) {
        return {
          status: "skip",
          summary: `${status.name} is not detected in this project`,
          evidence: lspEvidence(status),
          skipReason: "not_detected",
        };
      }
      if (status.install_state === "not_installed" || status.install_state === "error") {
        const command = status.install_cmd || `knowns lsp install ${languageId}`;
        return {
          status: "warn",
          summary: `${status.name} language server is unavailable`,
          evidence: lspEvidence(status),
          remediation: {
            description: `Install or repair the ${status.name} language server.`,
            command,
          },
        };
      }
      if (status.running_state === "crashed" || (status.missing_capabilities ?? []).length > 0) {
        return {
          status: "warn",
          summary: `${status.name} language server is degraded`,
          evidence: lspEvidence(status),
          remediation: {
            description:
              "Inspect the language-server status and repair the reported capability gap.",
            command: "knowns lsp list",
          },
        };
      }
      return {
        status: "pass",
        summary: `${status.name} language server is available`,
        evidence: lspEvidence(status),
      };
    },
  }));
}

// --- AI integration -------------------------------------------------------------------------------

const GUIDELINES_START = "<!-- KNOWNS GUIDELINES START -->";
const GUIDELINES_END = "<!-- KNOWNS GUIDELINES END -->";

const PLATFORM_INSTRUCTION_FILES: Record<string, string> = {
  "claude-code": "CLAUDE.md",
  opencode: "OPENCODE.md",
  codex: "AGENTS.md",
  hermes: "AGENTS.md",
  gemini: "GEMINI.md",
  copilot: join(".github", "copilot-instructions.md"),
  agents: "AGENTS.md",
};
const ALL_INSTRUCTION_FILES = [
  "CLAUDE.md",
  "OPENCODE.md",
  "GEMINI.md",
  "AGENTS.md",
  join(".github", "copilot-instructions.md"),
];
const PLATFORM_CONFIG_FILES: Record<string, string> = {
  "claude-code": ".mcp.json",
  opencode: "opencode.json",
  codex: join(".codex", "config.toml"),
  kiro: join(".kiro", "settings", "mcp.json"),
  cursor: join(".cursor", "mcp.json"),
};
const PLATFORM_SETUP_ALIASES: Record<string, string> = {
  "claude-code": "claude",
  opencode: "opencode",
  codex: "codex",
  kiro: "kiro",
  cursor: "cursor",
};
const SKILL_DIRS = [join(".claude", "skills"), join(".agents", "skills"), join(".kiro", "skills")];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const slash = (p: string): string => p.split(sep).join("/");

function normalizedStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v !== ""))].sort(cmp);
}
const slashPaths = (paths: readonly string[]): string[] => paths.map(slash).sort(cmp);

function existingPaths(
  root: string,
  candidates: string[],
  exists: (p: string) => boolean,
): string[] {
  return normalizedStrings(candidates.filter((c) => exists(join(root, c))));
}

function skillDirsForPlatforms(platforms: string[]): string[] {
  const dirs: string[] = [];
  for (const p of platforms) {
    switch (p) {
      case "claude-code":
        dirs.push(join(".claude", "skills"));
        break;
      case "kiro":
        dirs.push(join(".kiro", "skills"));
        break;
      case "agents":
      case "opencode":
      case "antigravity":
      case "codex":
      case "cursor":
      case "gemini":
      case "hermes":
        dirs.push(join(".agents", "skills"));
        break;
    }
  }
  return normalizedStrings(dirs);
}

function homeRelativePaths(state: LocalState, paths: string[]): string[] {
  if (paths.length === 0) return [];
  let home = "";
  try {
    home = state.deps.home ? state.deps.home() : (state.deps.env.HOME ?? homedir());
  } catch {
    home = "";
  }
  return paths
    .map((p) => {
      let out = p;
      if (home !== "" && out.startsWith(home + sep)) out = `~${out.slice(home.length)}`;
      return slash(out);
    })
    .sort(cmp);
}

function globalSetupTarget(stale: string[]): string {
  for (const p of stale) {
    if (p.includes("/.claude/")) return "claude";
    if (p.includes("/.kiro/")) return "kiro";
  }
  return "agents";
}

function runtimeConfigured(platforms: readonly string[] | undefined, runtime: string): boolean {
  for (const raw of platforms ?? []) {
    let p = raw.trim().toLowerCase();
    if (p === "claude") p = "claude-code";
    if (p === runtime) return true;
  }
  return false;
}

function aiCheckers(state: LocalState): Checker[] {
  const root = (): string => (state.deps.project as DoctorProject).store.projectRoot;
  const exists = state.deps.exists;
  const checkers: Checker[] = [
    {
      id: "ai.instructions",
      scope: "ai",
      check: (): CheckOutcome => {
        if (!state.deps.project) return skippedForMissingProject();
        const project = state.config();
        const projectRoot = root();
        const platforms = normalizedStrings(project.settings.platforms ?? []);
        let expected = normalizedStrings(
          platforms.map((p) => PLATFORM_INSTRUCTION_FILES[p] ?? "").filter((f) => f !== ""),
        );
        if (expected.length === 0)
          expected = existingPaths(projectRoot, ALL_INSTRUCTION_FILES, exists);
        if (expected.length === 0) {
          return subsystemDisabled(
            "No local AI instruction integration is configured",
            "not_configured",
          );
        }
        const missing: string[] = [];
        const outOfSync: string[] = [];
        for (const rel of expected) {
          const full = join(projectRoot, rel);
          if (!exists(full)) {
            missing.push(slash(rel));
            continue;
          }
          let data: string;
          try {
            data = state.deps.readFile(full);
          } catch {
            missing.push(slash(rel));
            continue;
          }
          if (!data.includes(GUIDELINES_START) || !data.includes(GUIDELINES_END)) {
            outOfSync.push(slash(rel));
          }
        }
        missing.sort(cmp);
        outOfSync.sort(cmp);
        const evidence: Evidence = { platforms, files: slashPaths(expected) };
        if (missing.length > 0 || outOfSync.length > 0) {
          if (missing.length > 0) evidence.missingFiles = missing;
          if (outOfSync.length > 0) evidence.outOfSyncFiles = outOfSync;
          return {
            status: "warn",
            summary: "AI instruction artifacts are missing or out of sync",
            evidence,
            remediation: {
              description: "Synchronize the configured AI platform artifacts.",
              command: "knowns sync --instructions",
            },
          };
        }
        return {
          status: "pass",
          summary: "AI instruction artifacts are present and synchronized",
          evidence,
        };
      },
    },
    {
      id: "ai.platform-config",
      scope: "ai",
      check: (): CheckOutcome => {
        // Go does not guard a missing project here: the config load fails and the runner reports
        // checker_error.
        const project = state.config();
        const projectRoot = root();
        const platforms = normalizedStrings(project.settings.platforms ?? []);
        const expectedByPlatform = new Map<string, string>();
        if (platforms.length > 0) {
          for (const p of platforms) {
            const path = PLATFORM_CONFIG_FILES[p];
            if (path) expectedByPlatform.set(p, path);
          }
        } else {
          for (const [p, path] of Object.entries(PLATFORM_CONFIG_FILES)) {
            if (exists(join(projectRoot, path))) expectedByPlatform.set(p, path);
          }
        }
        if (expectedByPlatform.size === 0) {
          return subsystemDisabled(
            "No configured AI platform requires a project config artifact",
            "not_applicable",
          );
        }
        const configured: string[] = [];
        const files: string[] = [];
        const missing: string[] = [];
        let missingPlatform = "";
        for (const [p, rel] of expectedByPlatform) {
          configured.push(p);
          files.push(slash(rel));
          if (!exists(join(projectRoot, rel))) {
            missing.push(slash(rel));
            if (missingPlatform === "" || p < missingPlatform) missingPlatform = p;
          }
        }
        configured.sort(cmp);
        files.sort(cmp);
        missing.sort(cmp);
        const evidence: Evidence = { platforms: configured, configFiles: files };
        if (missing.length > 0) {
          evidence.missingFiles = missing;
          return {
            status: "warn",
            summary: "Configured AI platform artifacts are missing",
            evidence,
            remediation: {
              description: "Regenerate the missing project integration artifact.",
              command: `knowns setup ${PLATFORM_SETUP_ALIASES[missingPlatform] ?? ""}`,
            },
          };
        }
        return {
          status: "pass",
          summary: "Configured AI platform artifacts are present",
          evidence,
        };
      },
    },
    {
      id: "ai.skills",
      scope: "ai",
      check: (): CheckOutcome => {
        if (!state.deps.project) return skippedForMissingProject();
        const project = state.config();
        const projectRoot = root();
        const platforms = normalizedStrings(project.settings.platforms ?? []);
        const scope = resolveSkillsScope(
          project.settings.skillsScope ?? "",
          state.deps.globalScope(),
        );

        let expected: string[] = [];
        if (scope === "project") {
          expected = skillDirsForPlatforms(platforms);
          if (platforms.length === 0) expected = existingPaths(projectRoot, SKILL_DIRS, exists);
        }
        const shadowing: string[] =
          scope !== "project" ? existingPaths(projectRoot, SKILL_DIRS, exists) : [];
        const globalStale = homeRelativePaths(state, state.deps.globalSkills());

        if (expected.length === 0 && globalStale.length === 0 && shadowing.length === 0) {
          return subsystemDisabled(
            "No configured AI platform requires synchronized skills",
            "not_applicable",
          );
        }
        const missing = expected
          .filter((rel) => !exists(join(projectRoot, rel)))
          .map(slash)
          .sort(cmp);
        const outOfSync =
          expected.length > 0 && missing.length === 0 && state.deps.skillsOutOfSync(projectRoot);
        const evidence: Evidence = { platforms, skillDirs: slashPaths(expected) };
        if (missing.length > 0) evidence.missingPaths = missing;
        if (outOfSync) evidence.outOfSync = true;
        if (globalStale.length > 0) evidence.globalStalePaths = globalStale;
        evidence.skillsScope = scope;
        if (shadowing.length > 0) {
          evidence.shadowingPaths = slashPaths(shadowing);
          return {
            status: "warn",
            summary: `Project skill directories shadow the ${scope} install`,
            remediation: {
              description: `settings.skillsScope is ${JSON.stringify(scope)}, but this project still holds skill directories. A project copy takes precedence over the global one, so the configured install is overridden.`,
              command: `rm -rf ${slashPaths(shadowing).join(" ")}`,
            },
            evidence,
          };
        }
        const projectNeedsSync = missing.length > 0 || outOfSync;
        if (projectNeedsSync || globalStale.length > 0) {
          let summary = "AI skills are missing or out of sync";
          let description = "Synchronize built-in skills for the configured AI platforms.";
          if (globalStale.length > 0) {
            description += ` Then run \`knowns setup ${globalSetupTarget(globalStale)} --global\` for the user-level copies.`;
          }
          let remediation = { description, command: "knowns sync --skills" };
          if (!projectNeedsSync) {
            summary = "User-level AI skills are out of sync";
            remediation = {
              description: "Re-run global setup so user-level skills match this binary.",
              command: `knowns setup ${globalSetupTarget(globalStale)} --global`,
            };
          }
          return { status: "warn", summary, evidence, remediation };
        }
        return { status: "pass", summary: "AI skills are synchronized", evidence };
      },
    },
  ];

  for (const runtimeName of state.deps.runtimeNames()) {
    checkers.push({
      id: `ai.runtime-hook.${runtimeName}`,
      scope: "ai",
      check: (): CheckOutcome => {
        if (!state.deps.project) return skippedForMissingProject();
        const project = state.config();
        const status = state.runtimeHooks().find((s) => s.runtime === runtimeName);
        if (!status) {
          return subsystemDisabled(
            `${runtimeName} runtime hook status is unavailable`,
            "status_unavailable",
          );
        }
        const configured = runtimeConfigured(project.settings.platforms, runtimeName);
        const evidence: Evidence = {
          runtime: status.runtime,
          displayName: status.displayName,
          hookKind: status.hookKind,
          configured,
          available: status.available,
          state: status.state,
        };
        if (!configured && !status.available) {
          return {
            status: "skip",
            summary: `${status.displayName} runtime hook is not configured or available`,
            evidence,
            skipReason: "runtime_not_configured_or_available",
          };
        }
        if (status.installed) {
          return {
            status: "pass",
            summary: `${status.displayName} Knowns runtime-memory hook is installed`,
            evidence,
          };
        }
        evidence.statusSummary = status.summary;
        const description = status.available
          ? `Install or refresh the Knowns runtime-memory hook for ${status.displayName}.`
          : `Install ${status.displayName}, then install or refresh its Knowns runtime-memory hook.`;
        return {
          status: "warn",
          summary: `${status.displayName} Knowns runtime-memory hook is missing or out of sync`,
          evidence,
          remediation: { description, command: `knowns runtime install ${status.runtime}` },
        };
      },
    });
  }
  return checkers;
}

/** LocalCheckers: search, runtime, lsp and ai. */
export function localCheckers(deps: LocalDeps): Checker[] {
  const state = newLocalState(deps);
  return [
    ...searchCheckers(state),
    ...runtimeCheckers(state),
    ...lspCheckers(state),
    ...aiCheckers(state),
  ];
}

export { lookPathEnv };
