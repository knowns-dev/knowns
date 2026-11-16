// Doctor checks for the MCP thin proxy (@task-KN-A1Q129, spec FR-10): what the shared daemon is
// serving, the recent proxy fallbacks, and MCP config entries that still name the dropped knowns-proxy,
// and a launcher/engine pair that is not whole. A check exists only when there is something to report, so a machine that never ran a
// proxy sees the same doctor output as before. Evidence carries counts and codes, never the
// free-text reasons the proxies record.
import type { FallbackRecord, LiveReport } from "../../runtime/live-report.ts";
import type { Checker, CheckOutcome, Evidence } from "./model.ts";

export interface ProxyNamedEntry {
  /** Config file relative to the project root. */
  file: string;
  /** The command the entry runs. */
  command: string;
}

/** The finder is findProxyNamedEntries (domain/setup/mcp-audit.ts) once that lands. */
export interface ProxyCheckInput {
  proxyEnabled: boolean;
  reports: LiveReport[];
  fallbacks: FallbackRecord[];
  proxyNamedEntries: ProxyNamedEntry[];
  /** launcherProblem() from platform/launcher.ts; undefined when whole or there is no launcher. */
  launcher?: { kind: "launcher-missing" | "engine-missing"; path: string };
  /** This install is the engine alone under the name knowns (spec mcp-thin-proxy D10). */
  legacyLayout?: boolean;
}

export function proxyCheckers(input: ProxyCheckInput): Checker[] {
  const out: Checker[] = [];
  const sessions = input.reports.reduce((n, r) => n + r.sessions.length, 0);
  const listeners = input.reports.reduce((n, r) => n + r.uiListeners.length, 0);
  if (input.fallbacks.length > 0 || input.reports.length > 0) {
    out.push({
      id: "runtime.mcp-proxy",
      scope: "runtime",
      check: (): CheckOutcome => {
        const evidence: Evidence = {
          proxyEnabled: input.proxyEnabled,
          daemons: input.reports.length,
          sessions,
          uiListeners: listeners,
        };
        const pool = input.reports.find((r) => r.pool)?.pool;
        if (pool) {
          evidence.poolSize = pool.size;
          evidence.poolBusy = pool.busy;
          evidence.poolQueued = pool.queued;
        }
        if (input.fallbacks.length > 0) {
          const last = input.fallbacks[input.fallbacks.length - 1];
          evidence.recentFallbacks = input.fallbacks.length;
          if (last) {
            evidence.lastFallbackAt = last.at;
            if (last.code) evidence.lastFallbackCode = last.code;
          }
          return {
            status: "warn",
            summary: `MCP proxy fell back to in-process ${input.fallbacks.length} time(s) recently`,
            evidence,
            remediation: {
              description:
                "Sessions kept working in-process. Check why the runtime daemon could not serve them.",
              command: "knowns runtime logs",
            },
          };
        }
        return {
          status: "pass",
          summary: `Runtime daemon serves ${sessions} MCP session(s) and ${listeners} web UI listener(s)`,
          evidence,
        };
      },
    });
  }
  if (input.legacyLayout) {
    out.push({
      id: "runtime.layout",
      scope: "runtime",
      check: (): CheckOutcome => ({
        status: "warn",
        summary: "old layout: knowns is the engine alone, without the launcher",
        evidence: { layout: "single-binary" },
        remediation: {
          description:
            "An older updater installed the engine as knowns. Run the update to finish the split into launcher + engine; every session otherwise starts the full engine.",
          command: "knowns update",
        },
      }),
    });
  }
  if (input.proxyNamedEntries.length > 0) {
    out.push({
      id: "runtime.mcp-config",
      scope: "runtime",
      check: (): CheckOutcome => ({
        status: "warn",
        summary: "An MCP config entry names knowns-proxy, which is no longer shipped",
        evidence: {
          entries: input.proxyNamedEntries.length,
          files: [...new Set(input.proxyNamedEntries.map((e) => e.file))].sort(),
        },
        remediation: {
          description: "Rewrite the MCP entries to the bare `knowns` command.",
          command: "knowns sync",
        },
      }),
    });
  }
  const lp = input.launcher;
  if (lp) {
    out.push({
      id: "runtime.launcher",
      scope: "runtime",
      check: (): CheckOutcome => ({
        status: "fail",
        summary:
          lp.kind === "engine-missing"
            ? "The knowns launcher cannot find its engine (knowns-engine)"
            : "The knowns launcher that started this process no longer exists",
        evidence: { kind: lp.kind, path: lp.path },
        remediation: {
          description: "Reinstall Knowns so the launcher and knowns-engine sit side by side.",
          command: "knowns update",
        },
      }),
    });
  }
  return out;
}
