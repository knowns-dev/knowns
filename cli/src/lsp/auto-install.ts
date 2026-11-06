// The download half of internal/cli/init.go autoInstallLSPServers: for each detected language whose
// adapter can install and whose server is not already available, install it. Never throws.
import { all } from "./adapters/index.ts";
import { Config } from "./config.ts";
import { withTimeout } from "./context.ts";
import { defaultLSPBaseDir } from "./dependency-adapter.ts";
import { collectRuntimeStatuses } from "./status.ts";
import { RuntimeInstallInstalled } from "./types.ts";

/** Per language server; a full download of the largest server takes well under this. A seam for tests. */
export const lspInitInstallLimits = { timeoutMs: 10 * 60_000 };

/** Not in Go (context.Background there): a stalled mirror must not hang init forever. */
export async function installWithDeadline(
  adapter: { install(ctx: AbortSignal, targetDir: string): Promise<string> },
  targetDir: string,
): Promise<string> {
  const { ctx, cancel } = withTimeout(undefined, lspInitInstallLimits.timeoutMs);
  try {
    return await adapter.install(ctx, targetDir);
  } finally {
    cancel();
  }
}

export async function installDetectedServers(
  cwd: string,
  detectedIDs: string[],
  print: (text: string) => void,
): Promise<void> {
  const adapters = all();
  const byID = new Map(adapters.map((a) => [a.id(), a]));
  for (const id of detectedIDs) {
    const adapter = byID.get(id);
    if (!adapter?.canInstall()) continue;
    const [status] = await collectRuntimeStatuses(undefined, {
      root: cwd,
      config: new Config(),
      adapters: [adapter],
    });
    if (
      status &&
      status.install_state === RuntimeInstallInstalled &&
      (status.binary_path ?? "") !== ""
    )
      continue;
    try {
      await adapter.checkPrerequisites(undefined);
    } catch (e) {
      print(`  ⚠ ${adapter.name()} — prerequisites not met: ${(e as Error).message}\n`);
      continue;
    }
    try {
      const path = await installWithDeadline(adapter, defaultLSPBaseDir());
      print(`  ✓ Installed ${adapter.name()} → ${path}\n`);
    } catch (e) {
      print(`  ⚠ ${adapter.name()} — install failed: ${(e as Error).message}\n`);
    }
  }
}
