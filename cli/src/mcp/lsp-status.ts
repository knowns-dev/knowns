// getLSPStatuses / getCodeRuntime of internal/mcp/server.go: the daemon-backed LSP view, with the
// manager as the fallback when the daemon is disabled or unreachable.
import type { LanguageRuntimeStatus } from "../lsp/types.ts";
import type { McpState } from "./state.ts";

export async function getLspStatuses(
  state: McpState,
  signal?: AbortSignal,
): Promise<LanguageRuntimeStatus[] | undefined> {
  const project = state.getProject();
  if (!project) return undefined;
  const daemon = await import("../lspdaemon/lifecycle.ts");
  if (daemon.disabledByEnv()) {
    state.warnDaemonDisabledOnce(daemon.disabledWarning());
    const manager = await state.getLspManager();
    if (manager) {
      return daemon.annotateLocalStatuses(
        await manager.runtimeStatuses(signal),
        daemon.DaemonStateDisabledByEnv,
      );
    }
    return undefined;
  }
  try {
    const client = await (await import("../lspdaemon/client.ts")).ensureClient(
      signal,
      project.store.projectRoot,
    );
    return await client.runtimeStatuses(signal);
  } catch {
    // fall back to the manager below
  }
  const manager = await state.getLspManager();
  if (manager) {
    return daemon.annotateLocalStatuses(
      await manager.runtimeStatuses(signal),
      daemon.DaemonStateUnavailable,
    );
  }
  return undefined;
}
