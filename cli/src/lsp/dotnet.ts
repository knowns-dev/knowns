// Port of internal/lsp/dotnet.go.
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Ctx } from "./context.ts";
import { defaultRunCommand, type LookPath, type RunCommand } from "./exec.ts";
import { RuntimeError } from "./runtime-error.ts";
import { CSharpBackendRoslyn, CSharpLanguageID } from "./types.ts";

export const minDotnetMajor = 10;

export function stringSetting(settings: Record<string, unknown> | undefined, key: string): string {
  if (!settings) return "";
  const v = settings[key];
  return typeof v === "string" ? v.trim() : "";
}

export function splitCommand(command: string): [string, string[]] {
  const parts = command.split(/\s+/).filter((p) => p !== "");
  const first = parts[0];
  if (first === undefined) return ["", []];
  return [first, parts.slice(1)];
}

export function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (v === "" || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function parseMajorMinorVersion(output: string): [number, number, boolean] {
  const m = /([0-9]+)\.([0-9]+)/.exec(output);
  if (!m) return [0, 0, false];
  return [Number.parseInt(m[1] ?? "", 10), Number.parseInt(m[2] ?? "", 10), true];
}

function dotnetRuntimeError(
  code: string,
  message: string,
  remediation: string,
  logPath: string,
  cause?: unknown,
): RuntimeError {
  return new RuntimeError({
    code,
    language: CSharpLanguageID,
    backend: CSharpBackendRoslyn,
    message,
    remediation,
    logPath,
    cause,
  });
}

export function dotnetCandidates(
  settings: Record<string, unknown> | undefined,
  lookPath: LookPath,
): string[] {
  const candidates: string[] = [];
  const p = stringSetting(settings, "dotnetPath");
  if (p !== "") candidates.push(p);
  const dir = stringSetting(settings, "dotnetInstallDir");
  if (dir !== "")
    candidates.push(join(dir, process.platform === "win32" ? "dotnet.exe" : "dotnet"));
  const found = lookPath("dotnet");
  if (found) candidates.push(found);
  return dedupeStrings(candidates);
}

export async function firstDotnet10(
  ctx: Ctx,
  candidates: string[],
  runCommand: RunCommand,
): Promise<string> {
  let lastErr: Error | undefined;
  for (const path of candidates) {
    if (path === "") continue;
    let output: string;
    try {
      output = await runCommand(ctx, path, "--version");
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      continue;
    }
    const [major, , ok] = parseMajorMinorVersion(output);
    if (!ok) {
      lastErr = new Error(`could not parse dotnet version from ${JSON.stringify(output.trim())}`);
      continue;
    }
    if (major >= minDotnetMajor) return path;
    lastErr = new Error(`.NET SDK ${minDotnetMajor}+ required, found ${output.trim()}`);
  }
  throw lastErr ?? new Error("file does not exist");
}

export async function resolveDotnet10(
  ctx: Ctx,
  cfg: Config,
  lookPath: LookPath | undefined,
  runCommand: RunCommand | undefined,
  logPath: string,
): Promise<string> {
  const look: LookPath = lookPath ?? (() => undefined);
  const run: RunCommand = runCommand ?? defaultRunCommand;
  const settings = cfg.languageSettings(CSharpLanguageID);
  let candidates = dotnetCandidates(settings, look);
  try {
    return await firstDotnet10(ctx, candidates, run);
  } catch {
    // fall through to bootstrap
  }

  const bootstrap = stringSetting(settings, "dotnetBootstrapCommand");
  if (bootstrap !== "") {
    const [name, args] = splitCommand(bootstrap);
    if (name === "") {
      throw dotnetRuntimeError(
        "dotnet_bootstrap_invalid",
        "Configured .NET bootstrap command is empty",
        "Set settings.lsp.languages.csharp.settings.dotnetBootstrapCommand to a valid command.",
        logPath,
      );
    }
    try {
      await run(ctx, name, ...args);
    } catch (e) {
      const output = (e as { output?: string }).output ?? "";
      throw dotnetRuntimeError(
        "dotnet_bootstrap_failed",
        `Configured .NET bootstrap command failed: ${output.trim()}`,
        "Install .NET SDK 10+ manually or fix dotnetBootstrapCommand.",
        logPath,
        e,
      );
    }
    candidates = dotnetCandidates(settings, look);
    try {
      return await firstDotnet10(ctx, candidates, run);
    } catch {
      // fall through
    }
  }

  throw dotnetRuntimeError(
    "dotnet_10_missing",
    ".NET SDK 10+ is required for Roslyn LS but was not found",
    "Install .NET SDK 10+ or configure settings.lsp.languages.csharp.settings.dotnetPath / dotnetBootstrapCommand.",
    logPath,
  );
}
