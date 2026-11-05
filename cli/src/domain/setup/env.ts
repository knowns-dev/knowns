// Environment helpers shared by the setup writers: where "home" is and how a binary is found on
// PATH. Both take the run's environment (not process.env) so tests and embedders can isolate them.
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

export type Env = Record<string, string | undefined>;

/** os.UserHomeDir: $HOME on unix, %USERPROFILE% on windows; throws Go's message when unset. */
export function userHomeDir(env: Env = process.env, platform: string = process.platform): string {
  const key = platform === "win32" ? "USERPROFILE" : "HOME";
  const v = env[key];
  if (v === undefined || v === "") {
    throw new Error(platform === "win32" ? "%userprofile% is not defined" : "$HOME is not defined");
  }
  return v;
}

function isExecutable(path: string, windows: boolean): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    return windows ? true : (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** exec.LookPath: the first executable named `name` on PATH, or undefined. */
export function lookPath(
  name: string,
  env: Env = process.env,
  platform: string = process.platform,
): string | undefined {
  const windows = platform === "win32";
  const exts = windows
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "")
    : [""];
  const candidates = (base: string): string[] =>
    windows && /\.[^\\/.]+$/.test(base) ? [base] : exts.map((e) => base + e);
  if (name.includes("/") || (windows && name.includes("\\"))) {
    return candidates(name).find((c) => isExecutable(c, windows));
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    const d = dir === "" ? "." : dir;
    for (const c of candidates(join(d, name))) if (isExecutable(c, windows)) return c;
  }
  return undefined;
}
