// The `knowns` command is a small native launcher that runs this engine (spec mcp-thin-proxy D10).
// It sets KNOWNS_LAUNCHER to its own path, so the engine reports, updates and detects its install
// method by the launcher, and writes the launcher into hooks, never the engine path.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

type Env = Record<string, string | undefined>;

/** The engine's file name next to the launcher. */
export const engineFileName = (platform: string = process.platform): string =>
  platform === "win32" ? "knowns-engine.exe" : "knowns-engine";

/** The launcher's own path (KNOWNS_LAUNCHER), or undefined when the engine was started directly. */
export function launcherPath(env: Env = process.env): string | undefined {
  const v = (env.KNOWNS_LAUNCHER ?? "").trim();
  return v === "" ? undefined : v;
}

/** The executable that stands for `knowns`: the launcher when there is one, else this process. */
export function selfExecutable(env: Env = process.env): string {
  return launcherPath(env) ?? process.execPath;
}

/** Where the engine should sit for a launcher at `launcher`. */
export const engineBeside = (launcher: string, platform: string = process.platform): string =>
  join(dirname(launcher), engineFileName(platform));

/** A problem with the launcher/engine pair, or undefined when it is whole (or there is no launcher). */
export function launcherProblem(
  env: Env = process.env,
  exists: (p: string) => boolean = existsSync,
  platform: string = process.platform,
): { kind: "launcher-missing" | "engine-missing"; path: string } | undefined {
  const launcher = launcherPath(env);
  if (launcher === undefined) return undefined;
  if (!exists(launcher)) return { kind: "launcher-missing", path: launcher };
  const engine = engineBeside(launcher, platform);
  if (!exists(engine)) return { kind: "engine-missing", path: engine };
  return undefined;
}
