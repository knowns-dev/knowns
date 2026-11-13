// The logic of `knowns sync` (internal/cli/sync.go) without any rendering: each step returns
// values or reports through an injected callback, so the CLI renders Go's text and MCP or the
// server can reuse the same writers. Nothing here imports src/cli.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { resolveSkillsScope as resolveScopeChain } from "../../models/config.ts";
import { goFsMessage, goNotExistReason } from "../../platform/goerror.ts";
import { globalSemanticStoreRoot } from "../../storage/core/store.ts";
import { resolveSemanticSearch } from "../../storage/history/semantic-resolve.ts";
import {
  EmbeddingSettingsStore,
  getModel,
  getProvider,
} from "../../storage/stores/embedding-settings-store.ts";
import {
  builtInSkillCount,
  generateInstructionContent,
  syncInstructionMarkerBlock,
  syncSkillsForPlatforms,
} from "../instructions/index.ts";
import { type Env, userHomeDir } from "./env.ts";
import { syncGlobalSkills } from "./global.ts";
import { createHermesMcpConfig } from "./hermes.ts";
import {
  createAntigravityMcpConfig,
  createAntigravityRules,
  createCodexMcpConfig,
  createCursorMcpConfig,
  syncMcpConfigs,
} from "./mcp-config.ts";
import { hasPlatform } from "./platforms.ts";
import * as runtimeinstall from "./runtimeinstall.ts";
import { selectSyncInstructionDefs } from "./sync-platforms.ts";

type Semantic = Parameters<typeof resolveSemanticSearch>[0];

// --- skills ------------------------------------------------------------------------------------

/** resolveSkillsScope: project scope, then the machine default in ~/.knowns/settings.json. */
export function resolveSkillsScope(projectScope: string | undefined, home: string): string {
  let global = "";
  try {
    const scope = new EmbeddingSettingsStore(join(home, ".knowns", "settings.json")).load()
      .projectDefaults?.settings.skillsScope;
    global = typeof scope === "string" ? scope : "";
  } catch {
    global = "";
  }
  return resolveScopeChain(projectScope ?? "", global);
}

export type SkillsSyncResult =
  | { kind: "none" }
  | { kind: "empty" }
  | { kind: "global"; count: number }
  | { kind: "project"; count: number };

/**
 * syncSkillsForScope: route skill materialisation by the scope. `onStart` fires after the count is
 * known and before files are written, like Go's "Syncing N skill(s)..." line.
 */
export function syncSkillsForScope(
  projectRoot: string,
  platforms: readonly string[],
  scope: string,
  env: Env,
  onStart: (kind: "global" | "project", count: number) => void = () => {},
): SkillsSyncResult {
  if (scope === "none") return { kind: "none" };
  const global = scope === "global";
  let home = "";
  if (global) {
    try {
      home = userHomeDir(env);
    } catch (e) {
      throw new Error(`resolve home directory: ${(e as Error).message}`);
    }
  }
  const count = builtInSkillCount();
  if (count === 0) return { kind: "empty" };
  onStart(global ? "global" : "project", count);
  if (global) syncGlobalSkills(home, platforms);
  else syncSkillsForPlatforms(projectRoot, platforms);
  return { kind: global ? "global" : "project", count };
}

// --- instruction files and platform configs ----------------------------------------------------

export interface InstructionFileResult {
  name: string;
  /** File name only, as Go prints it. */
  base: string;
  created: boolean;
}

/**
 * syncInstructionFiles: the canonical guidance shims, refreshing only the managed block. `onFile`
 * fires per file as it is written so a later failure leaves earlier reports intact.
 */
export function syncInstructionFiles(
  projectRoot: string,
  platform: string,
  configPlatforms: readonly string[],
  onFile: (r: InstructionFileResult) => void,
  onStart: () => void = () => {},
): void {
  const defs = selectSyncInstructionDefs(platform, configPlatforms);
  onStart();
  for (const p of defs) {
    const filePath = join(projectRoot, p.relPath);
    const exists = existsSync(filePath);
    const dir = dirname(filePath);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
    } catch (e) {
      throw new Error(`create directory ${dir}: ${goFsMessage(e)}`);
    }
    const content = generateInstructionContent(p.relPath, p.label, projectRoot);
    const base = p.relPath.split(/[\\/]/).pop() as string;
    if (exists) {
      try {
        syncInstructionMarkerBlock(filePath, content);
      } catch (e) {
        throw new Error(`sync ${filePath}: ${goFsMessage(e)}`);
      }
    } else {
      try {
        writeFileSync(filePath, content, { mode: 0o644 });
      } catch (e) {
        throw new Error(`write ${filePath}: ${goFsMessage(e)}`);
      }
    }
    onFile({ name: p.name, base, created: !exists });
  }
}

/** syncPlatformConfigs: MCP config and rule files for explicitly selected platforms. */
export function syncPlatformConfigs(
  projectRoot: string,
  platforms: readonly string[],
  env: Env,
  onSynced: (platformId: string, text: string) => void,
): void {
  if (platforms.length === 0) return;
  if (hasPlatform(platforms, "cursor")) {
    createCursorMcpConfig(projectRoot, env);
    onSynced("cursor", ".cursor/mcp.json synced.");
  }
  if (hasPlatform(platforms, "codex")) {
    createCodexMcpConfig(projectRoot, env);
    onSynced("codex", ".codex/config.toml synced.");
  }
  if (hasPlatform(platforms, "hermes")) {
    createHermesMcpConfig(projectRoot, env);
    onSynced("hermes", "~/.hermes/config.yaml synced.");
  }
  if (hasPlatform(platforms, "antigravity")) {
    createAntigravityRules(projectRoot, true);
    onSynced("antigravity", ".agents/rules/knowns.md synced.");
    createAntigravityMcpConfig(projectRoot, env);
    onSynced("antigravity", "~/.gemini/antigravity/mcp_config.json synced.");
  }
}

// --- MCP configs and runtime hooks -------------------------------------------------------------

/** The project root found by walking up from cwd to a .knowns entry, or "". */
export function findProjectRootUpwards(cwd: string): string {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".knowns"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
}

/**
 * syncProjectMcpConfigs (internal/cli/update.go syncMCPConfigs): the number of configs rewritten,
 * or undefined when cwd is not inside a project.
 */
export function syncProjectMcpConfigs(
  cwd: string,
  env: Env,
  onSynced: (label: string) => void,
): number | undefined {
  const projectRoot = findProjectRootUpwards(cwd);
  if (projectRoot === "") return undefined;
  return syncMcpConfigs(projectRoot, env, onSynced);
}

/** syncRuntimeHooks: re-install the hooks of the configured runtimes; the number installed. */
export function syncRuntimeHooks(
  configPlatforms: readonly string[],
  env: Env,
  cwd: string,
): number {
  const opts = runtimeinstall.defaultOptions(env, cwd);
  let targets = runtimeinstall.runtimeNames();
  if (configPlatforms.length > 0) {
    const set = new Set(configPlatforms);
    targets = targets.filter((n) => set.has(n));
  }
  let synced = 0;
  for (const name of targets) {
    try {
      runtimeinstall.install(name, opts);
    } catch {
      continue;
    }
    synced++;
  }
  return synced;
}

// --- embedding model ---------------------------------------------------------------------------

export type ModelCheck =
  | { kind: "none" }
  | { kind: "settings-error"; message: string }
  | { kind: "model-missing"; model: string }
  | { kind: "provider-missing"; provider: string }
  | { kind: "unreachable"; provider: string; apiBase: string }
  | { kind: "ready"; provider: string; model: string; dimensions: number };

/** testProviderConnectivity: any HTTP answer below 500 means reachable. */
export async function providerReachable(
  apiBase: string,
  apiKey: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const resp = await fetchFn(`${apiBase}/embeddings`, {
      method: "POST",
      headers,
      body: '{"model":"test","input":["hello"]}',
      signal: controller.signal,
    });
    return resp.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** checkEmbeddingModel (runSyncModelAPI): never throws; reports what the machine registry says. */
export async function checkEmbeddingModel(
  semantic: Semantic,
  home: string,
  fetchFn: typeof fetch = fetch,
): Promise<ModelCheck> {
  const ss = resolveSemanticSearch(semantic);
  if (!ss) return { kind: "none" };
  let settings: ReturnType<EmbeddingSettingsStore["load"]>;
  try {
    settings = new EmbeddingSettingsStore(join(home, ".knowns", "settings.json")).load();
  } catch (e) {
    return { kind: "settings-error", message: (e as Error).message };
  }
  let model: ReturnType<typeof getModel>;
  try {
    model = getModel(settings, ss.model);
  } catch {
    return { kind: "model-missing", model: ss.model };
  }
  let provider: ReturnType<typeof getProvider>;
  try {
    provider = getProvider(settings, model.provider);
  } catch {
    return { kind: "provider-missing", provider: model.provider };
  }
  if (!(await providerReachable(provider.apiBase, provider.apiKey, fetchFn))) {
    return { kind: "unreachable", provider: model.provider, apiBase: provider.apiBase };
  }
  return {
    kind: "ready",
    provider: model.provider,
    model: model.model,
    dimensions: model.dimensions,
  };
}

// --- reindex plan ------------------------------------------------------------------------------

/** Whether the semantic settings would make Go build an index. */
export function semanticConfigured(semantic: Semantic): boolean {
  const ss = resolveSemanticSearch(semantic);
  return !!ss && ss.enabled === true && (ss.model ?? "") !== "";
}

const globalConfigSchema = z.looseObject({
  settings: z.looseObject({ semanticSearch: z.looseObject({}).optional() }).optional(),
});

/** The semanticSearch settings of the machine-level store config, or undefined when unusable. */
function readGlobalSemantic(path: string): Semantic {
  try {
    const parsed = globalConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? (parsed.data.settings?.semanticSearch as Semantic) : undefined;
  } catch {
    return undefined;
  }
}

export type ReindexPlan =
  | { kind: "nothing-to-index" }
  /** Hand the reindex to the runtime queue. */
  | { kind: "queue" }
  /** Go returns without printing anything. */
  | { kind: "silent" }
  /** Keyword-only fallback; `globalLoadError` is the failure text Go prints first, if any. */
  | { kind: "keyword-only"; globalLoadError?: string };

/** planSyncReindex: which branch of Go's runReindex a sync takes. */
export function planSyncReindex(input: {
  counts: { tasks: number; docs: number; decisions: number };
  semantic: Semantic;
  env: Env;
}): ReindexPlan {
  const { tasks, docs, decisions } = input.counts;
  if (tasks + docs + decisions === 0) return { kind: "nothing-to-index" };
  if (input.env.KNOWNS_RUNTIME_INLINE !== "1") return { kind: "queue" };
  if (semanticConfigured(input.semantic)) return { kind: "queue" };
  // The global semantic store: Go opens it through the same config loader.
  const globalConfig = join(globalSemanticStoreRoot(), "config.json");
  if (!existsSync(globalConfig)) {
    const reason = goNotExistReason(existsSync(dirname(globalConfig)));
    return {
      kind: "keyword-only",
      globalLoadError: `Semantic search initialization failed: load config: load config: open ${globalConfig}: ${reason}`,
    };
  }
  if (semanticConfigured(readGlobalSemantic(globalConfig))) return { kind: "queue" };
  // Nothing configured and nothing failed: Go returns silently.
  return { kind: "silent" };
}
