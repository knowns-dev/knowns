// Port of handlers/helpers.go argument accessors and handlers/messages.go message constants.
import type { Args } from "./gojson.ts";
import { type CallToolResult, errorResult } from "./tool.ts";

export const ErrNoProject = "No project set. Call set_project with the project root path.";
export const ErrTaskIDReq = "taskId is required";
export const ErrPathReq = "path is required";
export const ErrNoKnownsDir = (path: string): string => `No .knowns/ directory found at ${path}`;
export const ErrLoadConfig = (msg: string): string => `Failed to load project config: ${msg}`;

export const noProjectError = (): CallToolResult => errorResult(ErrNoProject);
export const errNotFound = (entity: string, err: unknown): CallToolResult =>
  errorResult(`${entity} not found: ${errMsg(err)}`);
export const errFailed = (action: string, err: unknown): CallToolResult =>
  errorResult(`Failed to ${action}: ${errMsg(err)}`);

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** stringArg: [value, ok]. Text is stored verbatim. */
export function stringArg(args: Args, key: string): [string, boolean] {
  if (!Object.hasOwn(args, key)) return ["", false];
  const v = args[key];
  return typeof v === "string" ? [v, true] : ["", false];
}

/** intArg: JSON numbers are float64; int(n) truncates. */
export function intArg(args: Args, key: string): [number, boolean] {
  const v = args[key];
  if (typeof v === "number") return [Math.trunc(v), true];
  return [0, false];
}

export function boolArg(args: Args, key: string): boolean {
  return args[key] === true;
}

/** stringSliceArg: non-string items are dropped. */
export function stringSliceArg(args: Args, key: string): [string[], boolean] {
  const v = args[key];
  if (Array.isArray(v)) return [v.filter((i): i is string => typeof i === "string"), true];
  return [[], false];
}

export function stringSetArg(args: Args, key: string): Set<string> {
  const [values, ok] = stringSliceArg(args, key);
  const set = new Set<string>();
  if (!ok) return set;
  for (const v of values) if (v !== "") set.add(v);
  return set;
}

export function intSliceArg(args: Args, key: string): [number[], boolean] {
  const v = args[key];
  if (Array.isArray(v)) {
    return [v.filter((i): i is number => typeof i === "number").map((n) => Math.trunc(n)), true];
  }
  return [[], false];
}

/** args[key] != nil in Go: present and not JSON null. */
export const notNil = (args: Args, key: string): boolean =>
  Object.hasOwn(args, key) && args[key] !== null && args[key] !== undefined;

export function historyPageArgs(args: Args): [number, number, string | undefined] {
  const parse = (key: string): [number, string | undefined] => {
    if (!Object.hasOwn(args, key)) return [0, undefined];
    const value = args[key];
    if (typeof value !== "number") return [0, `${key} must be a non-negative integer`];
    if (
      Number.isNaN(value) ||
      !Number.isFinite(value) ||
      value < 0 ||
      Math.trunc(value) !== value ||
      value > Number.MAX_SAFE_INTEGER
    ) {
      return [0, `${key} must be a non-negative integer`];
    }
    return [value, undefined];
  };
  const [offset, e1] = parse("offset");
  if (e1) return [0, 0, e1];
  const [limit, e2] = parse("limit");
  if (e2) return [0, 0, e2];
  return [offset, limit, undefined];
}

export const MUTATION_SUMMARY = "summary";
export const MUTATION_FULL = "full";

/** parseMutationReturn: the mode, or the error text. */
export function parseMutationReturn(args: Args): { mode: string; error?: string } {
  if (!Object.hasOwn(args, "return")) return { mode: MUTATION_SUMMARY };
  const value = args.return;
  if (typeof value !== "string" || (value !== MUTATION_SUMMARY && value !== MUTATION_FULL)) {
    return {
      mode: "",
      error: `invalid return value ${goV(value)}; valid values are "${MUTATION_SUMMARY}" and "${MUTATION_FULL}"`,
    };
  }
  return { mode: value };
}

import { goSprintV } from "./gojson.ts";

const goV = goSprintV;

export function containsString(slice: readonly string[] | undefined, val: string): boolean {
  return (slice ?? []).includes(val);
}
