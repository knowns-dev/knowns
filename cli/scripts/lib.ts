// Shared build helpers for build.ts and budget.ts. Both must compile and sign the same way
// so the budget comparison (knowns vs empty binary) is not distorted.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-windows-x64",
  "bun-windows-arm64",
] as const;

export function platformOf(target: string): string {
  return target.replace(/^bun-/, "");
}

export function exeName(target: string): string {
  return platformOf(target).startsWith("windows") ? "knowns.exe" : "knowns";
}

/** "0.35.0" -> "0.35.0.0"; anything that is not x.y.z[-pre] (a dev build) -> "0.0.0.0". */
export function windowsFileVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!m) return "0.0.0.0";
  return `${m[1]}.${m[2]}.${m[3]}.0`;
}

/**
 * The version resource and icon of knowns.exe, so Explorer, Properties and Task Manager say
 * Knowns instead of Bun. Bun applies these only when the compile itself runs on Windows (a macOS
 * or Linux host ignores them through the API and rejects them on the CLI), hence undefined elsewhere.
 */
export function windowsCompileOptions(
  version: string,
  host: string = process.platform,
): Bun.CompileBuildOptions["windows"] | undefined {
  if (host !== "win32") return undefined;
  return {
    icon: join(import.meta.dir, "assets", "knowns.ico"),
    title: "Knowns",
    publisher: "Knowns",
    version: windowsFileVersion(version),
    description: "Knowns",
    copyright: "Copyright (c) Knowns contributors",
  };
}

/** The real messages inside Bun.build's AggregateError (its own message is just "Bundle failed"). */
export function describeBuildError(e: unknown): string {
  const inner = (e as { errors?: unknown[] } | null)?.errors;
  const parts = Array.isArray(inner) ? inner.map((x) => String((x as Error)?.message ?? x)) : [];
  const own = e instanceof Error ? e.message : String(e);
  return parts.length ? `${own}: ${parts.join("; ")}` : own;
}

export async function compile(
  entry: string,
  target: string,
  outfile: string,
  define: Record<string, string> = {},
  opts: {
    /** Stamps Windows version info and icon when set. */
    releaseVersion?: string;
    /** Worker thread entry files: Bun embeds a worker only when it is an entrypoint of the build. */
    workers?: string[];
  } = {},
): Promise<void> {
  const { releaseVersion, workers = [] } = opts;
  mkdirSync(dirname(outfile), { recursive: true });
  const windows =
    releaseVersion !== undefined && platformOf(target).startsWith("windows")
      ? windowsCompileOptions(releaseVersion)
      : undefined;
  if (releaseVersion !== undefined && platformOf(target).startsWith("windows") && !windows) {
    console.warn(
      `warn ${target}: built off Windows, so knowns.exe keeps Bun's icon and version info`,
    );
  }
  let res: Awaited<ReturnType<typeof Bun.build>>;
  try {
    res = await Bun.build({
      entrypoints: [entry, ...workers],
      minify: true,
      define,
      compile: {
        target: target as Bun.Build.CompileTarget,
        outfile,
        ...(windows ? { windows } : {}),
      },
    });
  } catch (e) {
    // Bun.build throws an AggregateError whose own message is only "Bundle failed".
    throw new Error(`compile failed for ${target}: ${describeBuildError(e)}`);
  }
  if (!res.success) {
    throw new Error(`compile failed for ${target}: ${res.logs.map(String).join("\n")}`);
  }
  signIfDarwin(target, outfile);
}

/** Bun's compiled Mach-O can carry an invalid signature that macOS kills on launch; ad-hoc re-sign. */
function signIfDarwin(target: string, file: string): void {
  if (process.platform !== "darwin" || !platformOf(target).startsWith("darwin")) return;
  Bun.spawnSync(["codesign", "--remove-signature", file]);
  const sign = Bun.spawnSync(["codesign", "-s", "-", "-f", file]);
  if (sign.exitCode !== 0) console.error(`warn codesign failed for ${target}`);
}
