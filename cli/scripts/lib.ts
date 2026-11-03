// Shared build helpers for build.ts and budget.ts. Both must compile and sign the same way
// so the budget comparison (knowns vs empty binary) is not distorted.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

export async function compile(
  entry: string,
  target: string,
  outfile: string,
  define: Record<string, string> = {},
): Promise<void> {
  mkdirSync(dirname(outfile), { recursive: true });
  const res = await Bun.build({
    entrypoints: [entry],
    minify: true,
    define,
    compile: { target: target as Bun.Build.CompileTarget, outfile },
  });
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
