// Doctor checks for the MCP thin proxy (@task-KN-A1Q129, spec FR-10): what the shared daemon is
// serving, the recent proxy fallbacks, and MCP config entries that point at a knowns-proxy that is
// not there. A check exists only when there is something to report, so a machine that never ran a
// proxy sees the same doctor output as before. Evidence carries counts and codes, never the
// free-text reasons the proxies record.
import type { FallbackRecord, LiveReport } from "../../runtime/live-report.ts";
import type { Checker, CheckOutcome, Evidence } from "./model.ts";

export interface MissingProxyEntry {
  /** Config file relative to the project root. */
  file: string;
  /** The command the entry runs. */
  command: string;
}

/** The finder is findMissingProxyEntries (domain/setup/mcp-audit.ts) once that lands. */
export interface ProxyCheckInput {
  proxyEnabled: boolean;
  reports: LiveReport[];
  fallbacks: FallbackRecord[];
  missingEntries: MissingProxyEntry[];
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
  if (input.missingEntries.length > 0) {
    out.push({
      id: "runtime.mcp-config",
      scope: "runtime",
      check: (): CheckOutcome => ({
        status: "warn",
        summary: "An MCP config entry points at a knowns-proxy that cannot be found",
        evidence: {
          entries: input.missingEntries.length,
          files: [...new Set(input.missingEntries.map((e) => e.file))].sort(),
        },
        remediation: {
          description: "Rewrite the MCP entries to the binary that exists.",
          command: "knowns sync",
        },
      }),
    });
  }
  return out;
}
