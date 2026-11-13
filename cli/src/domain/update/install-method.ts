// Port of DetectInstallMethod (internal/util/update_notifier.go): how this binary was installed,
// from its path and the environment first and the persisted install.json only as a fallback.
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type Env, userHomeDir } from "../setup/env.ts";
import { type InstallMetadata, isScriptManaged, loadInstallMetadata } from "./install-metadata.ts";

export type InstallMethod = "script" | "brew" | "npm" | "bun" | "yarn" | "pnpm" | "unknown";

/** ResolveExecutable: follow symlinks, or return the path unchanged. */
export function resolveExecutable(exe: string): string {
  try {
    return realpathSync(exe);
  } catch {
    return exe;
  }
}

const toSlash = (p: string): string => p.replaceAll("\\", "/");

export interface DetectOptions {
  env?: Env;
  /** Metadata to use instead of reading install.json (tests). */
  metadata?: InstallMetadata | undefined | null;
}

/** detectInstallMethodFor with the executable injected. */
export function detectInstallMethodFor(
  exe: string,
  opts: DetectOptions = {},
): { method: InstallMethod; command: string } {
  const env = opts.env ?? process.env;
  const candidates: string[] = [];
  if (exe !== "") {
    const real = resolveExecutable(exe);
    if (real !== exe) candidates.push(real);
    candidates.push(exe);
  }
  let meta: InstallMetadata | undefined;
  if (opts.metadata !== undefined) meta = opts.metadata ?? undefined;
  else {
    try {
      meta = loadInstallMetadata(env);
    } catch {
      meta = undefined;
    }
  }
  if (meta?.binaryPath) candidates.push(meta.binaryPath);

  let home = "";
  try {
    home = userHomeDir(env);
  } catch {
    home = "";
  }

  for (const path of candidates) {
    const lower = toSlash(path).toLowerCase();
    if (
      lower.includes("/homebrew/") ||
      lower.includes("/cellar/") ||
      lower.includes("/linuxbrew/")
    ) {
      return { method: "brew", command: "brew upgrade knowns-dev/tap/knowns" };
    }
    if (
      lower.includes("/pnpm/") ||
      lower.includes("/pnpm-global/") ||
      path.toLowerCase().includes("\\pnpm\\")
    ) {
      return { method: "pnpm", command: "pnpm add -g knowns" };
    }
    if (lower.includes("/.yarn/") || lower.includes("/yarn/")) {
      return { method: "yarn", command: "yarn global add knowns" };
    }
    if (lower.includes("/.bun/") || lower.includes("/bun/")) {
      return { method: "bun", command: "bun add -g knowns" };
    }
    if (lower.includes("/npm/") || lower.includes("/node_modules/")) {
      return { method: "npm", command: "npm i -g knowns" };
    }
    if (home !== "") {
      const defaultDir = toSlash(resolveExecutable(join(home, ".knowns", "bin"))).toLowerCase();
      if (
        lower.startsWith(`${defaultDir}/`) ||
        lower === `${defaultDir}/knowns` ||
        lower === `${defaultDir}/knowns.exe`
      ) {
        return { method: "script", command: "knowns update" };
      }
    }
  }

  const ua = env.npm_config_user_agent ?? "";
  if (ua.startsWith("pnpm/")) return { method: "pnpm", command: "pnpm add -g knowns" };
  if (ua.startsWith("yarn/")) return { method: "yarn", command: "yarn global add knowns" };
  if (ua.startsWith("bun/")) return { method: "bun", command: "bun add -g knowns" };
  if (ua.startsWith("npm/")) return { method: "npm", command: "npm i -g knowns" };

  if (meta) {
    const by = meta.managedBy ?? "";
    if (by !== "") {
      if (isScriptManaged(meta)) return { method: "script", command: "knowns update" };
      if (by.includes("brew"))
        return { method: "brew", command: "brew upgrade knowns-dev/tap/knowns" };
      if (by.includes("bun")) return { method: "bun", command: "bun add -g knowns" };
      if (by.includes("pnpm")) return { method: "pnpm", command: "pnpm add -g knowns" };
      if (by.includes("yarn")) return { method: "yarn", command: "yarn global add knowns" };
      if (by.includes("npm")) return { method: "npm", command: "npm i -g knowns" };
    }
    if (meta.method === "script") return { method: "script", command: "knowns update" };
  }

  if (home !== "" && existsSync(join(home, ".knowns", "install.json"))) {
    return { method: "script", command: "knowns update" };
  }
  return { method: "unknown", command: "" };
}
