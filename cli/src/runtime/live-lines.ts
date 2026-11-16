// Text and JSON for the daemon's live report as `knowns runtime ps` shows it (@task-KN-A1Q129).
// Everything here is empty when there is nothing to show, so the output of a machine without MCP
// sessions, a UI listener or a proxy fallback stays what it always was.
import {
  type FallbackRecord,
  type LiveReport,
  readFallbacks,
  readLiveReports,
} from "./live-report.ts";

export interface LiveView {
  reports: LiveReport[];
  fallbacks: FallbackRecord[];
}

export function loadLiveView(root?: string): LiveView {
  return { reports: readLiveReports(root), fallbacks: readFallbacks(root) };
}

export const liveViewEmpty = (v: LiveView): boolean =>
  v.fallbacks.length === 0 &&
  v.reports.every((r) => r.sessions.length === 0 && r.uiListeners.length === 0 && !r.pool);

export function liveViewJson(v: LiveView): unknown {
  return {
    daemons: v.reports.map((r) => ({
      pid: r.pid,
      pool: r.pool ?? null,
      sessions: r.sessions,
      uiListeners: r.uiListeners,
      version: r.version,
    })),
    fallbacks: v.fallbacks,
  };
}

export function liveViewLines(v: LiveView): string[] {
  const out: string[] = [];
  for (const r of v.reports) {
    out.push(`MCP daemon v${r.version} (pid ${r.pid}): ${r.sessions.length} session(s)`);
    for (const s of r.sessions) {
      out.push(
        `  session ${s.id}  ${s.client || "unknown client"}  ${s.project || "(no project yet)"}  pid ${s.pid ?? "?"}`,
      );
    }
    for (const l of r.uiListeners) {
      out.push(`  web UI http://localhost:${l.port}  ${l.projectRoot || "(workspace picker)"}`);
    }
    if (r.pool)
      out.push(`  worker pool ${r.pool.busy}/${r.pool.size} busy, ${r.pool.queued} queued`);
  }
  if (v.fallbacks.length > 0) {
    out.push(`Recent MCP proxy fallbacks: ${v.fallbacks.length}`);
    for (const f of v.fallbacks.slice(-5)) {
      out.push(`  ${f.at}  pid ${f.pid}  ${f.code || "fallback"}: ${f.reason}`);
    }
  }
  return out;
}
