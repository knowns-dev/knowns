// Project-level helpers of internal/cli/helpers.go (getLSPManagerForRoot) and internal/readiness (buildLSP).
import { join } from "node:path";
import { all as allAdapters } from "./adapters/index.ts";
import { Config } from "./config.ts";
import { Manager } from "./manager.ts";
import { collectRuntimeStatuses } from "./status.ts";
import type { LanguageAdapter, LanguageRuntimeStatus } from "./types.ts";

type ProjectLike = Parameters<typeof Config.fromProject>[0];

/** Loads project config plus the global defaults; any failure yields the empty side like Go. */
export async function loadLspConfig(root: string): Promise<Config> {
  const { Store } = await import("../storage/core/index.ts");
  const { createStorage } = await import("../storage/adapters.ts");
  const { EmbeddingSettingsStore } = await import("../storage/stores/embedding-settings-store.ts");
  let project: ProjectLike;
  try {
    project = createStorage(Store.open(join(root, ".knowns"))).config.load();
  } catch {
    project = undefined;
  }
  let defaults: { settings?: unknown } | undefined;
  try {
    defaults = new EmbeddingSettingsStore().load().projectDefaults;
  } catch {
    defaults = undefined;
  }
  return Config.fromProject(project, defaults);
}

/** getLSPManagerForRoot: a Manager with every built-in and plugin adapter registered. */
export async function getLSPManagerForRoot(
  root: string,
  warn: (line: string) => void = (l) => process.stderr.write(l),
): Promise<Manager> {
  const manager = new Manager(root, await loadLspConfig(root));
  for (const adapter of allAdapters()) {
    try {
      manager.registerAdapter(adapter);
    } catch (e) {
      warn(`warn: could not register LSP adapter ${adapter.id()}: ${(e as Error).message}\n`);
    }
  }
  for (const err of manager.registerPluginAdapters({})) {
    warn(`warn: could not load LSP plugin adapter: ${err.message}\n`);
  }
  return manager;
}

/** buildLSP's collection half: statuses without starting anything. */
export async function collectProjectRuntimeStatuses(
  root: string,
  adapters: LanguageAdapter[] = allAdapters(),
): Promise<LanguageRuntimeStatus[]> {
  return collectRuntimeStatuses(undefined, { root, config: await loadLspConfig(root), adapters });
}

/** lspStatusFromRuntime: the camelCase readiness shape (internal/readiness LSPStatus). */
export function lspStatusFromRuntime(s: LanguageRuntimeStatus): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown, always = false): void => {
    if (!always && (v === undefined || v === "" || v === 0 || v === false)) return;
    if (!always && Array.isArray(v) && v.length === 0) return;
    out[k] = v;
  };
  put("id", s.id, true);
  put("name", s.name, true);
  put("enabled", s.enabled, true);
  put("detected", s.detected, true);
  put("status", s.status, true);
  put("installState", s.install_state, true);
  put("runningState", s.running_state, true);
  put("readinessState", s.readiness_state, true);
  put("binary", s.binary);
  put("binaryPath", s.binary_path);
  put("source", s.source);
  put("version", s.version);
  put("cachePath", s.cache_path);
  put("selectedPath", s.selected_path);
  put("cleanupEligible", s.cleanup_eligible);
  put("installError", s.install_error);
  put("updateError", s.update_error);
  put("installCmd", s.install_cmd);
  put("backend", s.backend);
  put("backendSource", s.backend_source);
  put("projectPath", s.project_path);
  put("projectKind", s.project_kind);
  put("logPath", s.log_path);
  put("attempts", s.attempts);
  put("owner", s.owner);
  put("daemonState", s.daemon_state);
  put("daemonPid", s.daemon_pid);
  put("daemonClients", s.daemon_clients);
  put("daemonTransport", s.daemon_transport);
  put("daemonEndpoint", s.daemon_endpoint);
  put("daemonIdleDeadline", s.daemon_idle_deadline);
  put("daemonLeaseCount", s.daemon_lease_count);
  put("daemonLeaseOwners", s.daemon_lease_owners);
  put("capabilitiesKnown", s.capabilities_known);
  put("capabilities", s.capabilities);
  put("advertisedCapabilities", s.advertised_capabilities);
  put("observedCapabilities", s.observed_capabilities);
  put("requiredCapabilities", s.required_capabilities);
  put("missingCapabilities", s.missing_capabilities);
  return out;
}
