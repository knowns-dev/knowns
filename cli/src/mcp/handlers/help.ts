// Port of internal/mcp/handlers/help.go.
import { goTrimSpace } from "../../storage/core/util.ts";
import { stringSliceArg } from "../args.ts";
import { compareBytes, goMap, marshalIndent } from "../gojson.ts";
import type { HelpEntry } from "../help-data.ts";
import type { McpState } from "../state.ts";
import {
  argsOf,
  type CallToolRequest,
  type CallToolResult,
  errorResult,
  textResult,
} from "../tool.ts";

type Registry = Map<string, HelpEntry>;

function helpSearchText(key: string, entry: HelpEntry): string {
  const parts = [key, entry.when, entry.why ?? "", entry.flow ?? ""];
  for (const [name, desc] of Object.entries(entry.params ?? {})) parts.push(name, desc);
  parts.push(...(entry.examples ?? []));
  return parts.join(" ").toLowerCase();
}

function helpMatches(registry: Registry, query: string): string[] {
  if (registry.has(query)) return [query];
  const keys: string[] = [];
  if (query.endsWith(".*")) {
    const prefix = query.slice(0, -1);
    for (const key of registry.keys()) if (key.startsWith(prefix)) keys.push(key);
  } else {
    const needle = query.toLowerCase();
    for (const [key, entry] of registry) {
      if (helpSearchText(key, entry).includes(needle)) keys.push(key);
    }
  }
  return keys.sort(compareBytes);
}

function cut(s: string, sep: string): [string, string, boolean] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, "", false] : [s.slice(0, i), s.slice(i + sep.length), true];
}

function sameHelpTool(key: string, query: string): boolean {
  const [tool, , ok] = cut(key, ".");
  if (!ok) return false;
  const [queryTool, , ok2] = cut(query, ".");
  return ok2 && tool === queryTool;
}

function helpSuggestions(registry: Registry, query: string): string[] {
  const needle = (query.endsWith("*") ? query.slice(0, -1) : query).toLowerCase();
  let keys: string[] = [];
  for (const key of registry.keys()) {
    const lower = key.toLowerCase();
    if (
      needle === "" ||
      lower.includes(needle) ||
      needle.includes(lower) ||
      sameHelpTool(lower, needle)
    ) {
      keys.push(key);
    }
  }
  if (keys.length === 0) keys = [...registry.keys()];
  keys.sort(compareBytes);
  return keys.length > 5 ? keys.slice(0, 5) : keys;
}

/** HelpEntry struct: when, params (null when nil), why, examples, flow in declaration order. */
function entryJson(e: HelpEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    when: e.when,
    params: e.params ? goMap(e.params) : null,
  };
  if (e.why) out.why = e.why;
  if (e.examples && e.examples.length > 0) out.examples = e.examples;
  if (e.flow) out.flow = e.flow;
  return out;
}

export function resolveHelpQueries(registry: Registry, queries: string[]): Record<string, unknown> {
  const matches = new Map<string, Map<string, HelpEntry>>();
  const suggestions = new Map<string, string[]>();
  for (const raw of queries) {
    const query = goTrimSpace(raw);
    if (query === "") continue;
    const keys = helpMatches(registry, query);
    if (keys.length === 0) {
      suggestions.set(query, helpSuggestions(registry, query));
      continue;
    }
    for (const key of keys) {
      const [tool, action, ok] = cut(key, ".");
      if (!ok || tool === "" || action === "") continue;
      if (!matches.has(tool)) matches.set(tool, new Map());
      matches.get(tool)?.set(action, registry.get(key) as HelpEntry);
    }
  }
  const result: Record<string, unknown> = {};
  for (const [tool, actions] of matches) {
    const m: Record<string, unknown> = {};
    for (const [action, entry] of actions) m[action] = entryJson(entry);
    result[tool] = goMap(m);
  }
  if (suggestions.size > 0) {
    const s: Record<string, unknown> = {};
    for (const [q, v] of suggestions) s[q] = v;
    result.suggestions = goMap(s);
  }
  return goMap(result);
}

export async function handle(
  state: McpState,
  _ctx: unknown,
  req: CallToolRequest,
): Promise<CallToolResult> {
  const [queries, ok] = stringSliceArg(argsOf(req), "queries");
  if (!ok || queries.length === 0) return errorResult("queries is required");
  return textResult(marshalIndent(resolveHelpQueries(state.help, queries)));
}
