// Port of internal/mcp/handlers/search.go.
import { isStructural, type StructuralParams } from "../../models/structural.ts";
import { goTrimSpace } from "../../storage/core/util.ts";
import { boolArg, intArg, noProjectError, stringArg } from "../args.ts";
import { goMap, marshalIndent } from "../gojson.ts";
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
  _ctx: unknown,
  req: CallToolRequest,
): Promise<CallToolResult> {
  const a = requireString(req, "action");
  if (!a.ok) return errorResult("action is required");
  switch (a.value) {
    case "search":
      return search(state, req);
    case "retrieve":
      return retrieve(state, req);
    case "resolve":
      return resolve(state, req);
    default:
      return errorResult(`unknown search action: ${a.value}`);
  }
}

/** scoreToNorm: normalise to the best score, rounded to 4 places, never below 0.01 when positive. */
function scoreToNorm(score: number, max: number): number {
  if (max <= 0) return 0;
  const n = score / max;
  if (n > 1) return 1;
  if (n < 0.01 && score > 0) return 0.01;
  return Math.trunc(n * 10000 + 0.5) / 10000;
}

function normalizeScores<T extends { score: number }>(items: T[]): void {
  let max = 0;
  for (const r of items) if (r.score > max) max = r.score;
  for (const r of items) r.score = scoreToNorm(r.score, max);
}

async function search(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const q = requireString(req, "query");
  if (!q.ok) return errorResult(q.error);
  const args = argsOf(req);
  let [searchType, tok] = stringArg(args, "type");
  if (!tok) searchType = "all";
  const [mode] = stringArg(args, "mode");
  const [status] = stringArg(args, "status");
  const [priority] = stringArg(args, "priority");
  const [assignee] = stringArg(args, "assignee");
  const [label] = stringArg(args, "label");
  const [tag] = stringArg(args, "tag");
  let limit = 20;
  const [l, lok] = intArg(args, "limit");
  if (lok && l > 0) limit = l;
  const { searchWithRuntime } = await import("../../search/runtime.ts");
  const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
  let response: Awaited<ReturnType<typeof searchWithRuntime>>;
  try {
    response = await searchWithRuntime(project.storage, buildSearchEnvironment(), {
      query: q.value,
      type: searchType,
      mode,
      status,
      priority,
      assignee,
      label,
      tag,
      limit,
      includeHistorical: boolArg(args, "includeHistorical"),
    });
  } catch (e) {
    return errorResult((e as Error).message);
  }
  const results = response.results ?? [];
  if (results.length === 0) {
    const wrapper: Record<string, unknown> = {
      results,
      _projectRoot: project.store.root,
      _hint:
        'Search returned 0 results. Verify the active project is correct via project({ action: "current" }). Use project({ action: "set" }) to switch if needed.',
    };
    if (response.runtime) wrapper._runtime = response.runtime;
    return textResult(marshalIndent(goMap(wrapper)));
  }
  normalizeScores(results);
  return textResult(marshalIndent(results));
}

async function retrieve(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const q = requireString(req, "query");
  if (!q.ok) return errorResult(q.error);
  const args = argsOf(req);
  const [mode] = stringArg(args, "mode");
  const [status] = stringArg(args, "status");
  const [priority] = stringArg(args, "priority");
  const [assignee] = stringArg(args, "assignee");
  const [label] = stringArg(args, "label");
  const [tag] = stringArg(args, "tag");
  let limit = 20;
  const [l, lok] = intArg(args, "limit");
  if (lok && l > 0) limit = l;
  const raw = args.sourceTypes;
  const sourceTypes = Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string" && s !== "")
    : undefined;
  const { retrieveWithRuntime } = await import("../../search/runtime.ts");
  const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
  let out: Awaited<ReturnType<typeof retrieveWithRuntime>>;
  try {
    out = await retrieveWithRuntime(project.storage, buildSearchEnvironment(), {
      query: q.value,
      mode,
      limit,
      ...(sourceTypes !== undefined && { sourceTypes }),
      expandReferences: boolArg(args, "expandReferences"),
      status,
      priority,
      assignee,
      label,
      tag,
      includeHistorical: boolArg(args, "includeHistorical"),
    });
  } catch (e) {
    return errorResult((e as Error).message);
  }
  const { response, runtime } = out;
  normalizeScores(response.candidates ?? []);
  if (runtime) {
    return textResult(
      marshalIndent(
        goMap({
          query: response.query,
          mode: response.mode,
          candidates: response.candidates,
          contextPack: response.contextPack,
          _runtime: runtime,
        }),
      ),
    );
  }
  return textResult(marshalIndent(response));
}

/** splitCommaSeparated: trimmed, non-empty parts. */
function splitComma(s: string): string[] {
  return s
    .split(",")
    .map(goTrimSpace)
    .filter((p) => p !== "");
}

async function resolve(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const ref = requireString(req, "ref");
  if (!ref.ok) return errorResult(ref.error);
  const args = argsOf(req);
  const params: StructuralParams = {};
  const [direction, dok] = stringArg(args, "direction");
  if (dok) params.direction = direction;
  const [depth, dpok] = intArg(args, "depth");
  if (dpok) params.depth = depth;
  const [relationTypes, rok] = stringArg(args, "relationTypes");
  if (rok && relationTypes !== "") params.relationTypes = splitComma(relationTypes);
  const [entityTypes, eok] = stringArg(args, "entityTypes");
  if (eok && entityTypes !== "") params.entityTypes = splitComma(entityTypes);
  const { resolveRaw, resolveStructural } = await import("../../cli/commands/resolve-support.ts");
  try {
    if (isStructural(params)) {
      return textResult(marshalIndent(await resolveStructural(project.storage, ref.value, params)));
    }
    return textResult(marshalIndent(await resolveRaw(project.storage, ref.value)));
  } catch (e) {
    return errorResult((e as Error).message);
  }
}
