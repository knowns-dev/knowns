// What the runtime daemon shows about itself to `knowns runtime status/ps` and `knowns doctor`
// (@task-KN-A1Q129, spec FR-10): connected MCP sessions, UI listeners, worker pool usage, and the
// recent proxy fallbacks the proxies record. The daemon writes one small file per version; readers
// ignore the report of a dead daemon. Only new files under the runtime root: 0.34.x ignores them.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../version.ts";
import { isProcessAlive, nowString, runtimeRoot } from "./queue.ts";

export interface LiveSession {
  id: string;
  pid?: number;
  client: string;
  project: string;
  startedAt: string;
}
export interface LiveListener {
  id: string;
  port: number;
  projectRoot: string;
  pid?: number;
  startedAt: string;
}
export interface PoolUsage {
  size: number;
  busy: number;
  queued: number;
}
export interface LiveReport {
  version: string;
  pid: number;
  updatedAt: string;
  sessions: LiveSession[];
  uiListeners: LiveListener[];
  pool?: PoolUsage;
}

const dir = (root: string): string => join(root, "live");
const fileFor = (version: string, root: string): string =>
  join(dir(root), `daemon-${version.replace(/[^A-Za-z0-9._+-]/g, "_")}.json`);

export function writeLiveReport(report: LiveReport, root: string = runtimeRoot()): void {
  mkdirSync(dir(root), { recursive: true });
  const path = fileFor(report.version, root);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(report)}\n`);
  renameSync(tmp, path);
}

export function removeLiveReport(version: string = VERSION, root: string = runtimeRoot()): void {
  rmSync(fileFor(version, root), { force: true });
}

/** Reports of daemons that are still running, newest version name first. */
export function readLiveReports(
  root: string = runtimeRoot(),
  alive: (pid: number) => boolean = isProcessAlive,
): LiveReport[] {
  let names: string[];
  try {
    names = readdirSync(dir(root)).filter((n) => n.startsWith("daemon-") && n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: LiveReport[] = [];
  for (const name of names.sort()) {
    try {
      const r = JSON.parse(readFileSync(join(dir(root), name), "utf8")) as LiveReport;
      if (typeof r.pid !== "number" || !alive(r.pid)) continue;
      out.push({
        ...r,
        sessions: Array.isArray(r.sessions) ? r.sessions : [],
        uiListeners: Array.isArray(r.uiListeners) ? r.uiListeners : [],
      });
    } catch {
      // a half-written or foreign file is not a report
    }
  }
  return out;
}

export interface FallbackRecord {
  at: string;
  pid: number;
  version: string;
  kind: "fallback" | "recovered";
  code: string;
  reason: string;
  session?: string;
}

export const FALLBACK_STALE_MS = 6 * 3_600_000;

/**
 * Recent proxy fallbacks from <runtime root>/mcp/proxy-fallback.jsonl (appendix "proxy fallback
 * record" of the mcp-thin-proxy spec). A missing file, a malformed line or an unknown field is
 * tolerated. An event is stale when its pid is gone and it is hours old; a fallback followed by a
 * `recovered` row of the same pid is no longer current.
 */
export function readFallbacks(
  root: string = runtimeRoot(),
  now: number = Date.now(),
  alive: (pid: number) => boolean = isProcessAlive,
): FallbackRecord[] {
  let text: string;
  try {
    text = readFileSync(join(root, "mcp", "proxy-fallback.jsonl"), "utf8");
  } catch {
    return [];
  }
  const rows: FallbackRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as Partial<FallbackRecord>;
      if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) continue;
      if (r.kind !== "fallback" && r.kind !== "recovered") continue;
      rows.push({
        at: r.at,
        pid: typeof r.pid === "number" ? r.pid : 0,
        version: typeof r.version === "string" ? r.version : "",
        kind: r.kind,
        code: typeof r.code === "string" ? r.code : "",
        reason: typeof r.reason === "string" ? r.reason : "",
        ...(typeof r.session === "string" ? { session: r.session } : {}),
      });
    } catch {
      // malformed line
    }
  }
  const recovered = new Map<number, number>();
  for (const r of rows) {
    if (r.kind === "recovered") {
      recovered.set(r.pid, Math.max(recovered.get(r.pid) ?? 0, Date.parse(r.at)));
    }
  }
  return rows.filter((r) => {
    if (r.kind !== "fallback") return false;
    const at = Date.parse(r.at);
    if ((recovered.get(r.pid) ?? 0) >= at) return false;
    return alive(r.pid) || now - at < FALLBACK_STALE_MS;
  });
}

export const liveReportNow = (
  sessions: LiveSession[],
  uiListeners: LiveListener[],
  pool?: PoolUsage,
): LiveReport => ({
  version: VERSION,
  pid: process.pid,
  updatedAt: nowString(),
  sessions,
  uiListeners,
  ...(pool ? { pool } : {}),
});
