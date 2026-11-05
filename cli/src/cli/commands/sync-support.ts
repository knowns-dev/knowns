// The rendering of `knowns sync` (internal/cli/sync.go): Go's text around the steps in
// domain/setup/sync-steps.ts. Each step writes through `Out` so the command, tests and any
// embedder see the same stdout/stderr split Go produces.
import { searchRuntimeHooks } from "../../domain/searchenv/index.ts";
import {
  checkEmbeddingModel,
  planSyncReindex,
  resolveSkillsScope,
  syncInstructionFiles,
  syncPlatformConfigs,
  syncProjectMcpConfigs,
  syncRuntimeHooks,
  syncSkillsForScope,
} from "../../domain/setup/sync-steps.ts";
import { goQuote } from "../core/gofmt.ts";
import {
  renderCmd,
  renderInfo,
  renderSuccess,
  renderWarning,
  StyleBold,
  StyleDim,
  StyleInfo,
  StyleSuccess,
  StyleWarning,
} from "../core/plainoutput.ts";
import { renderNextSteps, searchDim, searchWarn } from "./search-support.ts";

export { resolveSkillsScope };

export interface Out {
  print(text: string): void;
  printErr(text: string): void;
}

type Env = Record<string, string | undefined>;

/** runSyncSkillsForScope: route skill materialisation by settings.skillsScope. */
export function runSyncSkillsForScope(
  out: Out,
  projectRoot: string,
  platforms: readonly string[],
  scope: string,
  env: Env,
): void {
  const result = syncSkillsForScope(projectRoot, platforms, scope, env, (kind, count) => {
    out.print(
      kind === "global"
        ? `${renderInfo(`Syncing ${StyleBold.render(String(count))} skill(s) to global directories...`)}\n`
        : `${renderInfo(`Syncing ${StyleBold.render(String(count))} skill(s)...`)}\n`,
    );
  });
  switch (result.kind) {
    case "none":
      out.print(`${renderInfo('Skills scope is "none": leaving skill directories untouched.')}\n`);
      return;
    case "empty":
      out.print(`${StyleDim.render("No embedded built-in skills found. Skipping skill sync.")}\n`);
      return;
    case "global":
      out.print(
        `${renderSuccess(`Synced ${result.count} skill(s) globally. Project skill directories were left untouched.`)}\n`,
      );
      return;
    case "project":
      // force is always true in sync.
      out.print(`  ${StyleWarning.render("Force sync: overwritten all existing skill files.")}\n`);
      out.print(`${renderSuccess(`Synced ${result.count} skill(s).`)}\n`);
  }
}

/** runSyncInstructions: the canonical guidance shims, refreshing only the managed block. */
export function runSyncInstructions(
  out: Out,
  projectRoot: string,
  platform: string,
  configPlatforms: readonly string[],
): void {
  syncInstructionFiles(
    projectRoot,
    platform,
    configPlatforms,
    (r) =>
      out.print(
        `  ${StyleSuccess.render(`[${r.name}]`)} ${r.base} ${StyleDim.render(r.created ? "created." : "synced.")}\n`,
      ),
    () => out.print(`${StyleBold.render("Checking agent instruction files...")}\n`),
  );
}

/** runSyncPlatformConfigs: MCP config and rule files for explicitly selected platforms. */
export function runSyncPlatformConfigs(
  out: Out,
  projectRoot: string,
  platforms: readonly string[],
  env: Env,
): void {
  syncPlatformConfigs(projectRoot, platforms, env, (id, text) =>
    out.print(`  ${StyleSuccess.render(`[${id}]`)} ${StyleDim.render(text)}\n`),
  );
}

/** runSyncModel: verify the configured embedding provider is reachable (never fatal). */
export async function runSyncModel(
  out: Out,
  semantic: Parameters<typeof checkEmbeddingModel>[0],
  home: string,
): Promise<void> {
  const r = await checkEmbeddingModel(semantic, home);
  const warn = StyleWarning.render("⚠");
  switch (r.kind) {
    case "none":
      return;
    case "settings-error":
      out.print(`${warn} Could not load embedding settings: ${r.message}\n`);
      out.print(`${StyleDim.render("  Falling back to keyword-only search.")}\n`);
      return;
    case "model-missing":
      out.print(
        `${warn} Embedding model ${goQuote(r.model)} not found in ~/.knowns/settings.json\n`,
      );
      out.print(
        `${StyleDim.render(`  Pull it with \`ollama pull ${r.model}\`, then select it:`)}\n`,
      );
      out.print(
        `${StyleDim.render(`  knowns config set settings.semanticSearch.model ${r.model}`)}\n`,
      );
      return;
    case "provider-missing":
      out.print(`${warn} Provider ${goQuote(r.provider)} not found in ~/.knowns/settings.json\n`);
      out.print(`${StyleDim.render("  Configure it: knowns provider add")}\n`);
      return;
    case "unreachable":
      out.print(`${warn} Provider ${goQuote(r.provider)} unreachable at ${r.apiBase}\n`);
      out.print(`${StyleDim.render("  Falling back to keyword-only search.")}\n`);
      return;
    case "ready":
      out.print(
        `${StyleSuccess.render("✓")} Semantic search ready (api: ${r.provider}, model: ${r.model}, ${r.dimensions}d)\n`,
      );
  }
}

export interface ReindexInput {
  counts: { tasks: number; docs: number; decisions: number };
  semantic: Parameters<typeof planSyncReindex>[0]["semantic"];
  env: Env;
  storeRoot: string;
}

/**
 * runReindex as `sync` calls it. A reindex is handed to the runtime queue through the same seam
 * search uses (`searchRuntimeHooks.enqueueReindex`); the queue itself is TSR-2MPMDK, so until it
 * lands no job is written and the index is not rebuilt. Go announces the queued job with the line
 * printed here. Keyword-only projects reproduce Go's output exactly.
 */
export async function runSyncReindex(out: Out, input: ReindexInput): Promise<void> {
  const { tasks, docs, decisions } = input.counts;
  const plan = planSyncReindex(input);
  switch (plan.kind) {
    case "nothing-to-index":
      out.print(`${renderWarning("No tasks, docs, or decisions to index.")}\n`);
      return;
    case "silent":
      return;
    case "queue":
      try {
        await searchRuntimeHooks.enqueueReindex(input.storeRoot);
      } catch {
        // best effort, like the search bootstrap
      }
      out.print(
        `${renderInfo(`Queued runtime reindex (${tasks} tasks, ${docs} docs, ${decisions} decisions)...`)}\n\n`,
      );
      return;
    case "keyword-only":
      if (plan.globalLoadError !== undefined) out.print(`${searchWarn(plan.globalLoadError)}\n\n`);
      out.print(`${searchDim("Semantic search is not configured.")}\n\n`);
      out.print(
        `${renderNextSteps(renderCmd("knowns settings"), renderCmd("knowns search --reindex"))}\n`,
      );
      out.print(
        `${searchDim("Keyword search does not require indexing (scans tasks/docs on each query).")}\n`,
      );
      out.print(
        `${renderInfo(`Found ${tasks} tasks, ${docs} docs, and ${decisions} decisions available for keyword search.`)}\n`,
      );
  }
}

/** syncMCPConfigs (internal/cli/update.go): the project is found by walking up from cwd. */
export function runSyncMcpConfigs(out: Out, cwd: string, env: Env): void {
  const updated = syncProjectMcpConfigs(cwd, env, (label) =>
    out.print(`  ${StyleInfo.render("synced")} ${label}\n`),
  );
  if (updated === undefined) return;
  if (updated > 0) {
    out.print(`${StyleSuccess.render("✓")} Synced ${updated} MCP config(s) to use local binary.\n`);
  } else {
    out.print(`${StyleDim.render("·")} MCP configs already up to date.\n`);
  }
}

/** runSyncRuntimeHooks: re-install the hooks of the configured runtimes. */
export function runSyncRuntimeHooks(
  out: Out,
  configPlatforms: readonly string[],
  env: Env,
  cwd: string,
): void {
  const synced = syncRuntimeHooks(configPlatforms, env, cwd);
  if (synced > 0) {
    out.print(`${StyleSuccess.render("✓")} Runtime hooks synced for ${synced} platform(s).\n`);
  }
}
