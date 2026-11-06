// internal/services/status.go (the LSP leg and the aggregation) and routes/runtime_services.go.
// The cloudflared and embedding detectors live with `knowns runtime ps` (runtime-ps.ts) and are
// reused through detectAllServices; the LSP inventory comes from the server's LSP statuses.
import type { ServiceStatus } from "../cli/commands/runtime-ps.ts";
import type { Manager } from "../lsp/manager.ts";
import type { LanguageRuntimeStatus } from "../lsp/types.ts";
import {
  RuntimeInstallDisabled,
  RuntimeInstallError,
  RuntimeInstallInstalled,
  RuntimeRunningCrashed,
  RuntimeRunningDisabled,
  RuntimeRunningRunning,
  RuntimeRunningStarting,
} from "../lsp/types.ts";
import type { Project } from "../models/config.ts";
import type { Storage } from "../storage/adapters.ts";
import type { App } from "./app.ts";
import { jsonResponse, type Router, respondError } from "./http.ts";
import { lspRuntimeStatuses } from "./lsp.ts";
import type { Obj } from "./routes/support.ts";

function serviceStatusFromLSP(s: LanguageRuntimeStatus): string {
  switch (s.running_state) {
    case RuntimeRunningRunning:
    case RuntimeRunningStarting:
      return "running";
    case RuntimeRunningCrashed:
      return "error";
    case RuntimeRunningDisabled:
      return "disabled";
  }
  switch (s.status) {
    case RuntimeRunningRunning:
      return "running";
    case RuntimeRunningCrashed:
    case RuntimeInstallError:
      return "error";
    case RuntimeInstallDisabled:
      return "disabled";
    default:
      return "stopped";
  }
}

export function lspServicesFromRuntimeStatuses(
  proj: Project | undefined,
  statuses: LanguageRuntimeStatus[] | undefined,
): ServiceStatus[] {
  const lsp = proj?.settings.lsp;
  if (lsp && lsp.enabled !== undefined && lsp.enabled === false) {
    return [
      {
        name: "LSP (global)",
        type: "lsp",
        status: "disabled",
        enabledInConfig: false,
        details: {},
      },
    ];
  }
  if (!statuses || statuses.length === 0) {
    return [
      {
        name: "LSP",
        type: "lsp",
        status: "stopped",
        enabledInConfig: true,
        details: { reason: "no languages detected" },
      },
    ];
  }
  return statuses.map((s) => {
    const details: Record<string, string> = {
      language: s.id,
      detected: String(s.detected),
      enabled: String(s.enabled),
      install_state: s.install_state,
      running_state: s.running_state,
      readiness_state: s.readiness_state,
    };
    const add = (k: string, v: string | undefined): void => {
      if (v) details[k] = v;
    };
    add("binary", s.binary);
    add("source", s.source);
    add("backend", s.backend);
    add("backend_source", s.backend_source);
    add("version", s.version);
    add("selected_path", s.selected_path);
    add("project_path", s.project_path);
    add("log_path", s.log_path);
    add("install_cmd", s.install_cmd);
    add("install_error", s.install_error);
    add("update_error", s.update_error);
    add("owner", s.owner);
    add("daemon_state", s.daemon_state);
    add("daemon_transport", s.daemon_transport);
    add("daemon_endpoint", s.daemon_endpoint);
    add("daemon_idle_deadline", s.daemon_idle_deadline);
    if ((s.daemon_pid ?? 0) > 0) details.daemon_pid = String(s.daemon_pid);
    if ((s.daemon_clients ?? 0) > 0) details.daemon_clients = String(s.daemon_clients);
    if ((s.daemon_lease_count ?? 0) > 0) details.daemon_lease_count = String(s.daemon_lease_count);
    if ((s.daemon_lease_owners ?? []).length > 0) {
      details.daemon_lease_owners = (s.daemon_lease_owners ?? []).join(",");
    }
    if (s.install_state !== RuntimeInstallInstalled) details.reason = s.install_state;
    return {
      name: `LSP (${s.id})`,
      type: "lsp",
      status: serviceStatusFromLSP(s),
      enabledInConfig: s.enabled,
      details,
    };
  });
}

/** Detects every service: LSP from the server's statuses plus the shared detectors. */
export async function detectRuntimeServices(
  app: App,
  lspManager: Manager | undefined,
  storage: Storage,
  acquireLease: boolean,
  signal?: AbortSignal,
): Promise<ServiceStatus[]> {
  const { detectAllServices, serviceSeams } = await import("../cli/commands/runtime-ps.ts");
  let proj: Project | undefined;
  try {
    proj = storage.config.load();
  } catch {
    proj = undefined;
  }
  const statuses = await lspRuntimeStatuses(app, lspManager, storage, acquireLease, signal);
  const lsp = lspServicesFromRuntimeStatuses(proj, statuses);
  const previous = serviceSeams.detectLsp;
  // detectAllServices is synchronous, so this seam is only ever read by this call.
  serviceSeams.detectLsp = () => lsp;
  try {
    return detectAllServices(storage.store);
  } finally {
    serviceSeams.detectLsp = previous;
  }
}

/** time.Duration.Round(time.Second).String() for a positive duration given in nanoseconds. */
export function goDurationSeconds(ns: number): string {
  let secs = Math.round(ns / 1e9);
  if (secs <= 0) return "0s";
  const h = Math.floor(secs / 3600);
  secs -= h * 3600;
  const m = Math.floor(secs / 60);
  secs -= m * 60;
  let out = "";
  if (h > 0) out += `${h}h`;
  if (h > 0 || m > 0) out += `${m}m`;
  return `${out}${secs}s`;
}

export function registerRuntimeServices(
  r: Router,
  app: App,
  getManager: () => Manager | undefined,
): void {
  r.get("/api/runtime/services", async (c) => {
    if (app.manager.getStore() === undefined) return respondError(503, "no active project");
    const storage = app.need();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const results = await Promise.race([
        detectRuntimeServices(app, getManager(), storage, true, controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("timeout")));
        }),
      ]);
      const resp = results.map((s) => {
        const o: Obj = { name: s.name, type: s.type, status: s.status };
        if (s.pid) o.pid = s.pid;
        if (s.port) o.port = s.port;
        if ((s.uptime ?? 0) > 0) o.uptime = goDurationSeconds(s.uptime as number);
        o.enabledInConfig = s.enabledInConfig;
        const keys = Object.keys(s.details).sort((a, b) =>
          Buffer.compare(Buffer.from(a), Buffer.from(b)),
        );
        if (keys.length > 0) {
          const d: Record<string, string> = {};
          for (const k of keys) d[k] = s.details[k] as string;
          o.details = d;
        }
        return o;
      });
      return jsonResponse(200, { services: resp });
    } catch {
      return respondError(504, "service detection timed out");
    } finally {
      clearTimeout(timer);
      void c;
    }
  });
}
