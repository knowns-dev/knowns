// The install layout (spec mcp-thin-proxy D10). A split install has the Go launcher as `knowns`
// and this engine beside it as `knowns-engine`; the launcher sets KNOWNS_LAUNCHER when it starts
// the engine. A legacy install is the engine alone under the name `knowns`, which is what a 0.34.x
// or 0.35.0 updater leaves when it unpacks a launcher archive (the archive's `knowns` is the engine
// on purpose, so that an older updater installs something that runs). `knowns update` finishes the
// split; until then a one-line hint is shown at most once a day on interactive commands.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Env, userHomeDir } from "../setup/env.ts";

/** The engine's file name once the install is split. */
export const ENGINE_NAME = "knowns-engine";
export const LAUNCHER_ENV = "KNOWNS_LAUNCHER";
const HINT_INTERVAL_MS = 24 * 3_600_000;

/** `knowns`, `knowns.exe`, `kn`, `knowns-engine` ... without .exe and in lower case. */
const stem = (exe: string): string =>
  exe
    .replace(/^.*[\\/]/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();

/**
 * Is this process the whole of a legacy install: a compiled binary called knowns (or kn) that no
 * launcher started? A dev run (bun), the engine started by its launcher (KNOWNS_LAUNCHER set) and
 * the engine invoked by its own name are not.
 */
export function isLegacyLayout(exe: string, env: Env = process.env): boolean {
  if ((env[LAUNCHER_ENV] ?? "").trim() !== "") return false;
  const s = stem(exe);
  return s === "knowns" || s === "kn";
}

export const LEGACY_LAYOUT_SUMMARY = "old layout (single binary)";
export const LEGACY_LAYOUT_COMMAND = "knowns update";

export interface ArchiveLayout {
  layout: number;
  version: string;
  launcher: { file: string; installAs: string };
  engine: { file: string; installAs: string };
}

const plainName = (n: unknown): n is string =>
  typeof n === "string" && n !== "" && n === basename(n) && !/[\\/]/.test(n) && n !== "..";

/** Parses layout.json of a release archive; throws on a layout this version does not know. */
export function parseArchiveLayout(text: string): ArchiveLayout {
  let raw: Partial<ArchiveLayout>;
  try {
    raw = JSON.parse(text) as Partial<ArchiveLayout>;
  } catch {
    throw new Error("release layout.json is not valid JSON");
  }
  if (raw.layout !== 1) {
    throw new Error(
      `release archive layout ${String(raw.layout)} is newer than this knowns understands; reinstall from the install script`,
    );
  }
  const { launcher, engine } = raw;
  if (
    !launcher ||
    !engine ||
    !plainName(launcher.file) ||
    !plainName(launcher.installAs) ||
    !plainName(engine.file) ||
    !plainName(engine.installAs)
  ) {
    throw new Error("release layout.json names no launcher or engine");
  }
  return {
    layout: 1,
    version: typeof raw.version === "string" ? raw.version : "",
    launcher: { file: launcher.file, installAs: launcher.installAs },
    engine: { file: engine.file, installAs: engine.installAs },
  };
}

/** Arguments that must never get the hint: the MCP server, machine output, update and doctor. */
const QUIET_ARGS = new Set([
  "mcp",
  "--stdio",
  "--json",
  "--plain",
  "update",
  "doctor",
  "--version",
  "-v",
  "--help",
  "-h",
]);

export interface HintSeams {
  exe: string;
  env: Env;
  isTTY: boolean;
  now: () => number;
}

function statePath(env: Env): string {
  try {
    return join(userHomeDir(env), ".knowns", "layout-hint.json");
  } catch {
    return "";
  }
}

/**
 * The hint for an interactive command on a legacy install, or "": at most once a day, never on a
 * non-TTY, never for `mcp --stdio`, `--json`/`--plain` output, `update` or `doctor`, never with
 * NO_UPDATE_CHECK=1 or in CI. Showing it records the time; every failure is silent.
 */
export function layoutHint(argv: string[], seams: Partial<HintSeams> = {}): string {
  const exe = seams.exe ?? process.execPath;
  const env = seams.env ?? process.env;
  const isTTY = seams.isTTY ?? Boolean(process.stdout.isTTY && process.stderr.isTTY);
  const now = seams.now ?? Date.now;
  if (!isTTY || !isLegacyLayout(exe, env)) return "";
  if (env.NO_UPDATE_CHECK === "1" || (env.CI ?? "") !== "") return "";
  if (argv.some((a) => QUIET_ARGS.has(a) || a.startsWith("__"))) return "";
  const path = statePath(env);
  if (path === "") return "";
  try {
    const last = Number(
      (JSON.parse(readFileSync(path, "utf8")) as { lastShown?: unknown }).lastShown,
    );
    if (Number.isFinite(last) && now() - last < HINT_INTERVAL_MS) return "";
  } catch {
    // never shown
  }
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    writeFileSync(path, JSON.stringify({ lastShown: now() }), { mode: 0o644 });
  } catch {
    return "";
  }
  return `\n knowns: this install still has the old single-binary layout. Run \`${LEGACY_LAYOUT_COMMAND}\` to finish the upgrade.\n`;
}
