// The `knowns` command is a small native launcher that runs this engine (spec mcp-thin-proxy D10).
// It sets KNOWNS_LAUNCHER to its own path, so the engine reports, updates and detects its install
// method by the launcher, and writes the launcher into hooks, never the engine path.
//
// The variable is only a claim: any parent environment can set it. It is believed only when it names
// a launcher (`knowns` or `kn`) whose neighbour `knowns-engine` is this very process.
import { existsSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { lookPath } from "../domain/setup/env.ts";

type Env = Record<string, string | undefined>;

/** The path rules of the platform being asked about, not of the machine running the check. */
const pathFor = (platform: string) => (platform === "win32" ? win32 : posix);

/** realpath that also resolves Windows 8.3 short names and normalises the drive letter. */
const nativeRealpath = (p: string): string => realpathSync.native(p);

/** The engine's file name next to the launcher. */
export const engineFileName = (platform: string = process.platform): string =>
  platform === "win32" ? "knowns-engine.exe" : "knowns-engine";

/** Seams for the checks that look at the machine; the defaults are the real ones. */
export interface LauncherSeams {
  execPath?: string;
  realpath?: (p: string) => string;
  exists?: (p: string) => boolean;
  platform?: string;
}

const stemOf = (p: string): string =>
  (p.replace(/^.*[\\/]/, "") || "").replace(/\.exe$/i, "").toLowerCase();

const sameFile = (a: string, b: string, platform: string): boolean =>
  platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * The launcher's own path (KNOWNS_LAUNCHER) when it is believable, else undefined (the engine was
 * started directly, or the variable is stale, foreign or hostile). Believable: absolute, named
 * knowns or kn, and the knowns-engine beside it is this process (realpath equal).
 */
export function launcherPath(
  env: Env = process.env,
  seams: LauncherSeams = {},
): string | undefined {
  const v = (env.KNOWNS_LAUNCHER ?? "").trim();
  const platform = seams.platform ?? process.platform;
  if (v === "" || !pathFor(platform).isAbsolute(v)) return undefined;
  const stem = stemOf(v);
  if (stem !== "knowns" && stem !== "kn") return undefined;
  const real = seams.realpath ?? nativeRealpath;
  try {
    const engine = real(engineBeside(v, platform));
    const self = real(seams.execPath ?? process.execPath);
    return sameFile(engine, self, platform) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A path for `knowns` that survives an upgrade of its package manager: the launcher reports the
 * symlink-resolved path, which for Homebrew is <prefix>/Cellar/knowns/<version>/bin/knowns and is
 * gone after the next `brew upgrade`. Such a path becomes <prefix>/bin/knowns when that exists.
 */
export function stableLauncherPath(
  launcher: string,
  exists: (p: string) => boolean = existsSync,
): string {
  const m = /^(.*)[\\/]Cellar[\\/][^\\/]+[\\/][^\\/]+[\\/]bin[\\/]([^\\/]+)$/.exec(launcher);
  if (m?.[1] && m[2]) {
    const linked = posix.join(m[1], "bin", m[2]);
    return exists(linked) ? linked : m[2].replace(/\.exe$/i, "");
  }
  return launcher;
}

/**
 * The executable that stands for `knowns` in a config: the launcher by a stable path, else this
 * process. A launcher inside a package manager's versioned directory is never recorded.
 */
export function selfExecutable(env: Env = process.env, seams: LauncherSeams = {}): string {
  const l = launcherPath(env, seams);
  return l === undefined ? process.execPath : stableLauncherPath(l, seams.exists);
}

/** Where the engine should sit for a launcher at `launcher`. */
export const engineBeside = (launcher: string, platform: string = process.platform): string => {
  const p = pathFor(platform);
  return p.join(p.dirname(launcher), engineFileName(platform));
};

/**
 * A problem with the launcher/engine pair, or undefined when it is whole (or there is no launcher).
 * A launcher path that vanished because the package manager moved it (Cellar) is not a problem when
 * the stable path or `knowns` on PATH still exists.
 */
export function launcherProblem(
  env: Env = process.env,
  exists: (p: string) => boolean = existsSync,
  platform: string = process.platform,
  seams: LauncherSeams = {},
): { kind: "launcher-missing" | "engine-missing"; path: string } | undefined {
  const launcher = launcherPath(env, { ...seams, platform });
  if (launcher === undefined) return undefined;
  let effective = launcher;
  if (!exists(launcher)) {
    const stable = stableLauncherPath(launcher, exists);
    const onPath = lookPath("knowns", env, platform);
    if (stable !== launcher && exists(stable)) effective = stable;
    else if (onPath !== undefined && exists(onPath)) effective = onPath;
    else return { kind: "launcher-missing", path: launcher };
  }
  let base = effective;
  try {
    base = (seams.realpath ?? nativeRealpath)(effective);
  } catch {
    // keep the path as given
  }
  const engine = engineBeside(base, platform);
  if (!exists(engine)) return { kind: "engine-missing", path: engine };
  return undefined;
}
