/** Shared command helpers (helpers.go). */
import type { Command } from "./command.ts";
import { SilentExit } from "./exit.ts";
import { goJSONIndent } from "./gofmt.ts";

function boolFlag(cmd: Command, name: string): boolean {
  const local = cmd.flags().lookup(name);
  if (local?.value.type === "bool" && local.value.get() === true) return true;
  const root = cmd.root().persistentFlags().lookup(name);
  return root?.value.type === "bool" && root.value.get() === true;
}

/** Whether --plain is set, locally or on the root. */
export function isPlain(cmd: Command): boolean {
  return boolFlag(cmd, "plain");
}

/** Whether --json is set, locally or on the root. */
export function isJSON(cmd: Command): boolean {
  return boolFlag(cmd, "json");
}

/** The output mode the global flags select; --json wins over --plain. */
export type OutputMode = "json" | "plain" | "styled";
export function outputMode(cmd: Command): OutputMode {
  return isJSON(cmd) ? "json" : isPlain(cmd) ? "plain" : "styled";
}

/** Marshals v to indented JSON (Go's json.MarshalIndent text) and prints it with a newline. */
export function printJSON(cmd: Command, v: unknown): void {
  let text: string;
  try {
    text = goJSONIndent(v);
  } catch (e) {
    cmd.printErr(`Error encoding JSON: ${e instanceof Error ? e.message : String(e)}\n`);
    return;
  }
  cmd.stdout(`${text}\n`);
}

/** Formats seconds as a human-readable duration ("1h 5m", "3m 2s", "0m"). */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0m";
  const h = Math.trunc(seconds / 3600);
  const m = Math.trunc((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0 && s > 0) return `${m}m ${s}s`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Splits a comma-separated string into trimmed, non-empty parts. */
export function splitCSV(s: string): string[] {
  if (s === "") return [];
  return s
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

/**
 * Finds the project and returns its Store. On failure prints Go's two-line diagnostic to stderr
 * and exits 1 (via SilentExit, which the run loop turns into the exit status).
 */
export async function getStore(cmd: Command, cwd: string = cmd.cwd()) {
  const { Store, locateProject, locationWarnings } = await import("../../storage/core/index.ts");
  let loc: ReturnType<typeof locateProject>;
  try {
    loc = locateProject(cwd);
  } catch (e) {
    cmd.printErr(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
    cmd.printErr(
      "Run 'knowns init' to keep knowledge in this repository, or 'knowns store link <remote>' to keep it in a store.\n",
    );
    throw new SilentExit(1);
  }
  for (const msg of locationWarnings(loc)) cmd.printErr(`Warning: ${msg}\n`);
  return new Store(loc.knowledgeRoot, loc.projectRoot);
}

/** Like getStore, but throws the error instead of printing it. */
export async function getStoreErr(cmd: Command, cwd: string = cmd.cwd()) {
  const { Store, locateProject, locationWarnings } = await import("../../storage/core/index.ts");
  const loc = locateProject(cwd);
  for (const msg of locationWarnings(loc)) cmd.printErr(`Warning: ${msg}\n`);
  return new Store(loc.knowledgeRoot, loc.projectRoot);
}
