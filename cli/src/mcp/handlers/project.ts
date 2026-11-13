// Port of internal/mcp/handlers/project.go.
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ErrLoadConfig, ErrNoKnownsDir, ErrNoProject, errMsg } from "../args.ts";
import { goMap, marshalIndent } from "../gojson.ts";
import { getLspStatuses } from "../lsp-status.ts";
import type { McpState } from "../state.ts";
import {
  argsOf,
  type CallToolRequest,
  type CallToolResult,
  errorResult,
  requireString,
  textResult,
} from "../tool.ts";

export async function handle(
  state: McpState,
  ctx: { signal?: AbortSignal },
  req: CallToolRequest,
): Promise<CallToolResult> {
  const a = requireString(req, "action");
  if (!a.ok) return errorResult("action is required");
  switch (a.value) {
    case "detect":
      return projectDetect(req);
    case "current":
      return projectCurrent(state);
    case "set":
      return projectSet(state, req);
    case "status":
      return projectStatus(state, ctx.signal);
    default:
      return errorResult(`unknown project action: ${a.value}`);
  }
}

async function projectDetect(req: CallToolRequest): Promise<CallToolResult> {
  const args = argsOf(req);
  let home = "";
  try {
    home = homedir();
  } catch {
    home = "";
  }
  const dirs = [
    join(home, "Desktop"),
    join(home, "Documents"),
    join(home, "Workspaces"),
    join(home, "workspace"),
    join(home, "projects"),
    join(home, "Projects"),
    join(home, "dev"),
    join(home, "Dev"),
    "/tmp",
  ];
  const extra = args.additionalPaths;
  if (Array.isArray(extra)) for (const item of extra) if (typeof item === "string") dirs.push(item);

  const { Store } = await import("../../storage/core/store.ts");
  const { createStorage } = await import("../../storage/adapters.ts");
  const seen = new Set<string>();
  const projects: Array<{ projectRoot: string; name?: string }> = [];
  for (const dir of dirs) {
    if (dir === "") continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const candidate = join(dir, e.name);
      const knownsDir = join(candidate, ".knowns");
      try {
        statSync(join(knownsDir, "config.json"));
      } catch {
        continue;
      }
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const info: { projectRoot: string; name?: string } = { projectRoot: candidate };
      try {
        const name = createStorage(Store.open(knownsDir)).config.load().name;
        if (name) info.name = name;
      } catch {
        // unreadable config: no name
      }
      projects.push(info);
    }
  }
  return textResult(marshalIndent(projects.length === 0 ? null : projects));
}

function projectCurrent(state: McpState): CallToolResult {
  const root = state.getRoot();
  const project = state.getProject();
  if (!project || root === "") {
    return textResult(
      marshalIndent(goMap({ projectRoot: null, valid: false, message: ErrNoProject })),
    );
  }
  const result: Record<string, unknown> = { projectRoot: root, valid: true };
  try {
    result.projectName = project.storage.config.load().name;
  } catch {
    // no name
  }
  return textResult(marshalIndent(goMap(result)));
}

async function projectSet(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const r = requireString(req, "projectRoot");
  if (!r.ok) return errorResult(r.error);
  const core = await import("../../storage/core/index.ts");
  let loc: ReturnType<typeof core.locateProjectAt>;
  try {
    loc = core.locateProjectAt(r.value);
  } catch {
    return errorResult(ErrNoKnownsDir(r.value));
  }
  const store = new core.Store(loc.knowledgeRoot, loc.projectRoot);
  const { createStorage } = await import("../../storage/adapters.ts");
  let name: string;
  try {
    name = createStorage(store).config.load().name;
  } catch (e) {
    return errorResult(ErrLoadConfig(errMsg(e)));
  }
  await state.setProject(store, loc.projectRoot);
  return textResult(
    marshalIndent(goMap({ success: true, projectRoot: loc.projectRoot, projectName: name })),
  );
}

async function projectStatus(state: McpState, signal?: AbortSignal): Promise<CallToolResult> {
  const project = state.getProject();
  const { buildReadiness, inactivePayload } = await import("../../domain/readiness/index.ts");
  if (!project) return textResult(marshalIndent(inactivePayload()));
  const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
  const { lspStatusFromRuntime, collectProjectRuntimeStatuses } = await import(
    "../../lsp/project.ts"
  );
  let statuses = await getLspStatuses(state, signal);
  if (!statuses || statuses.length === 0) {
    const manager = await state.getLspManager();
    if (manager) statuses = await manager.runtimeStatuses(signal);
  }
  // BuildReadiness inspects the project statically when it is handed no statuses at all.
  if (!statuses) statuses = await collectProjectRuntimeStatuses(project.store.projectRoot);
  const payload = buildReadiness(project.storage, buildSearchEnvironment(), {
    lsp: statuses.map((s) => lspStatusFromRuntime(s) as never),
  });
  return textResult(marshalIndent(payload));
}
