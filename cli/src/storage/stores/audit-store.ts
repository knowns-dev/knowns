// Port of internal/storage/audit_store.go: append-only MCP audit events in ~/.knowns/audit.jsonl,
// with size-based rotation (audit.jsonl.1, audit.jsonl.2).
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  type AuditAnalytics,
  type AuditAnalyticsQuery,
  type AuditCoverage,
  type AuditDailyBucket,
  type AuditEvent,
  type AuditStats,
  type AuditToolStats,
  UNKNOWN_AUDIT_PROJECT,
} from "../../models/audit.ts";
import { globalRootPath } from "../core/global-root.ts";
import { goJsonStringify } from "../core/util.ts";
import { goTimeJson, parseIso } from "./internal.ts";

const AUDIT_FILE = "audit.jsonl";
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_BACKUPS = 2;
const DEFAULT_RECENT = 50;
const MAX_RECENT = 500;

export interface AuditFilter {
  toolName?: string;
  actionClass?: string;
  result?: string;
  project?: string;
  since?: Date;
  until?: Date;
}

const tsMs = (e: AuditEvent) => parseIso(e.timestamp)?.ms ?? 0;

/** json.Marshal(AuditEvent): struct key order, omitempty fields dropped, timestamp as RFC 3339. */
function eventJson(e: AuditEvent): Record<string, unknown> {
  const out: Record<string, unknown> = { timestamp: goTimeJson(e.timestamp), toolName: e.toolName };
  if (e.action) out.action = e.action;
  out.actionClass = e.actionClass;
  if (e.projectRoot) out.projectRoot = e.projectRoot;
  if (e.dryRun) out.dryRun = true;
  out.result = e.result;
  out.durationMs = e.durationMs;
  if (e.errorMessage) out.errorMessage = e.errorMessage;
  if (e.entityRefs && e.entityRefs.length > 0) out.entityRefs = e.entityRefs;
  if (e.argumentSummary && Object.keys(e.argumentSummary).length > 0) {
    const sorted: Record<string, string> = {};
    for (const k of Object.keys(e.argumentSummary).sort())
      sorted[k] = e.argumentSummary[k] as string;
    out.argumentSummary = sorted;
  }
  if (e.client) out.client = e.client;
  return out;
}

export const auditToolKey = (e: Pick<AuditEvent, "toolName" | "action">): string =>
  e.action ? `${e.toolName}.${e.action}` : e.toolName;

function filterEvents(events: AuditEvent[], f: AuditFilter): AuditEvent[] {
  return events.filter((e) => {
    if (f.toolName && e.toolName !== f.toolName) return false;
    if (f.actionClass && e.actionClass !== f.actionClass) return false;
    if (f.result && e.result !== f.result) return false;
    if (f.project && e.projectRoot !== f.project) return false;
    if (f.since && tsMs(e) < f.since.getTime()) return false;
    if (f.until && tsMs(e) > f.until.getTime()) return false;
    return true;
  });
}

export function aggregateAuditStats(events: readonly AuditEvent[]): AuditStats {
  const stats: AuditStats = {
    totalCalls: 0,
    byTool: {},
    byActionClass: {},
    byResult: {},
    dryRunCount: 0,
    executeCount: 0,
    byToolResult: {},
  };
  const byTool = stats.byTool as Record<string, number>;
  const byAction = stats.byActionClass as Record<string, number>;
  const byResult = stats.byResult as Record<string, number>;
  const byToolResult = stats.byToolResult as Record<string, Record<string, number>>;
  for (const e of events) {
    stats.totalCalls++;
    const key = auditToolKey(e);
    byTool[key] = (byTool[key] ?? 0) + 1;
    byAction[e.actionClass] = (byAction[e.actionClass] ?? 0) + 1;
    byResult[e.result] = (byResult[e.result] ?? 0) + 1;
    if (e.dryRun) stats.dryRunCount++;
    else stats.executeCount++;
    const perTool = byToolResult[key] ?? {};
    byToolResult[key] = perTool;
    perTool[e.result] = (perTool[e.result] ?? 0) + 1;
  }
  return stats;
}

// --- calendar helpers in an IANA zone (the Go code resolves ranges in the caller's timezone) ----

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function zoneYmd(ms: number, timeZone: string): Ymd {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

const ymdString = ({ y, m, d }: Ymd) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const ymdDays = ({ y, m, d }: Ymd) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
const addDays = (v: Ymd, n: number): Ymd => {
  const t = new Date(Date.UTC(v.y, v.m - 1, v.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

function topTool(tools: Map<string, number>): { tool: string; calls: number } {
  let tool = "";
  let calls = 0;
  for (const [t, c] of tools) {
    if (c > calls || (c === calls && t < tool)) {
      tool = t;
      calls = c;
    }
  }
  return { tool, calls };
}

export class AuditStore {
  constructor(readonly dir: string = globalRootPath()) {}

  filePath(): string {
    return join(this.dir, AUDIT_FILE);
  }

  /** Append: write one event as a JSON line, rotating first when the file is over 5 MB. */
  append(event: AuditEvent): void {
    try {
      this.rotateIfNeeded();
    } catch {
      // rotation failure never blocks audit writes
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o755 });
    // goJsonStringify with indent 0 is compact encoding/json output.
    appendFileSync(this.filePath(), `${goJsonStringify(eventJson(event), 0)}\n`, { mode: 0o644 });
  }

  private rotateIfNeeded(): void {
    const path = this.filePath();
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    if (size < MAX_FILE_SIZE) return;
    for (let i = MAX_BACKUPS; i >= 1; i--) {
      const src = `${path}.${i}`;
      if (i === MAX_BACKUPS) rmSync(src, { force: true });
      else if (existsSync(src)) renameSync(src, `${path}.${i + 1}`);
    }
    renameSync(path, `${path}.1`);
  }

  /** Recent: the most recent N events, newest first. */
  recent(limit = DEFAULT_RECENT, filter?: AuditFilter): AuditEvent[] {
    let n = limit <= 0 ? DEFAULT_RECENT : limit;
    if (n > MAX_RECENT) n = MAX_RECENT;
    let events = this.readRetained();
    if (filter) events = filterEvents(events, filter);
    return events.reverse().slice(0, n);
  }

  stats(filter?: AuditFilter): AuditStats {
    let events = this.readRetained();
    if (filter) events = filterEvents(events, filter);
    return aggregateAuditStats(events);
  }

  /** readRetained: rotated backups oldest first, then the live file, stably sorted by time. */
  readRetained(): AuditEvent[] {
    const path = this.filePath();
    const paths: string[] = [];
    for (let i = MAX_BACKUPS; i >= 1; i--) paths.push(`${path}.${i}`);
    paths.push(path);
    const events: AuditEvent[] = [];
    for (const p of paths) events.push(...readAuditFile(p));
    return events.sort((a, b) => tsMs(a) - tsMs(b));
  }

  /** Analytics: per-day buckets and per-tool totals for a calendar range in the caller's zone. */
  analytics(query: AuditAnalyticsQuery, now: Date = new Date()): AuditAnalytics {
    if (![7, 30, 90].includes(query.days))
      throw new Error("audit: analytics days must be 7, 30, or 90");
    const timezone = query.timezone || "UTC";
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      throw new Error(`audit: load timezone "${timezone}": unknown time zone ${timezone}`);
    }
    const today = zoneYmd(now.getTime(), timezone);
    const rangeEnd = today;
    const rangeStart = addDays(rangeEnd, -(query.days - 1));
    const startDay = ymdDays(rangeStart);
    const endDay = ymdDays(rangeEnd);
    const dayOf = (e: AuditEvent) => ymdDays(zoneYmd(tsMs(e), timezone));

    const retained = this.readRetained();
    const coverage = auditCoverage(retained, timezone, rangeStart, rangeEnd, dayOf);

    const filtered = retained.filter((e) => {
      const day = dayOf(e);
      if (day < startDay || day > endDay) return false;
      if (!query.allProjects && query.project && e.projectRoot !== query.project) return false;
      return true;
    });

    const stats = aggregateAuditStats(filtered);
    const buckets: AuditDailyBucket[] = [];
    const days = new Map<string, { durationTotal: number; tools: Map<string, number> }>();
    for (let i = 0; i < query.days; i++) {
      const date = ymdString(addDays(rangeStart, i));
      buckets.push({
        date,
        covered:
          coverage.startDate !== "" &&
          date >= (coverage.startDate ?? "") &&
          date <= (coverage.endDate ?? ""),
        totalCalls: 0,
        successCount: 0,
        errorCount: 0,
        deniedCount: 0,
        needsAttention: 0,
        averageDurationMs: 0,
        topTool: "",
        topToolCalls: 0,
      } as AuditDailyBucket);
      days.set(date, { durationTotal: 0, tools: new Map() });
    }

    const toolDurations = new Map<string, number>();
    const byProject: Record<string, number> = {};
    let durationTotal = 0;
    for (const e of filtered) {
      const index = dayOf(e) - startDay;
      const bucket = buckets[index];
      if (!bucket) continue;
      bucket.totalCalls++;
      if (e.result === "success") bucket.successCount++;
      else if (e.result === "error") bucket.errorCount++;
      else if (e.result === "denied") bucket.deniedCount++;
      bucket.needsAttention = bucket.errorCount + bucket.deniedCount;
      const day = days.get(bucket.date) as { durationTotal: number; tools: Map<string, number> };
      day.durationTotal += e.durationMs;
      const key = auditToolKey(e);
      day.tools.set(key, (day.tools.get(key) ?? 0) + 1);
      toolDurations.set(key, (toolDurations.get(key) ?? 0) + e.durationMs);
      const project = e.projectRoot || UNKNOWN_AUDIT_PROJECT;
      byProject[project] = (byProject[project] ?? 0) + 1;
      durationTotal += e.durationMs;
    }

    let needsAttention = 0;
    for (const bucket of buckets) {
      if (bucket.totalCalls > 0) {
        const day = days.get(bucket.date) as { durationTotal: number; tools: Map<string, number> };
        bucket.averageDurationMs = day.durationTotal / bucket.totalCalls;
        const top = topTool(day.tools);
        bucket.topTool = top.tool;
        bucket.topToolCalls = top.calls;
      }
      needsAttention += bucket.needsAttention;
    }

    const tools: AuditToolStats[] = Object.entries(stats.byTool ?? {}).map(([tool, total]) => ({
      tool,
      totalCalls: total,
      byResult: stats.byToolResult?.[tool] ?? {},
      averageDurationMs: (toolDurations.get(tool) ?? 0) / total,
    }));
    tools.sort((a, b) =>
      a.totalCalls === b.totalCalls ? (a.tool < b.tool ? -1 : 1) : b.totalCalls - a.totalCalls,
    );

    return {
      ...stats,
      timezone,
      rangeStart: ymdString(rangeStart),
      rangeEnd: ymdString(rangeEnd),
      coverage,
      dailyBuckets: buckets,
      tools,
      byProject,
      needsAttention,
      averageDurationMs: stats.totalCalls > 0 ? durationTotal / stats.totalCalls : 0,
    } as AuditAnalytics;
  }
}

function readAuditFile(path: string): AuditEvent[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`audit: open file: ${(e as Error).message}`);
  }
  const events: AuditEvent[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const e = JSON.parse(line) as AuditEvent;
      if (typeof e !== "object" || e === null) continue;
      if (!e.timestamp || !parseIso(e.timestamp) || !e.toolName) continue;
      events.push(e);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

function auditCoverage(
  events: readonly AuditEvent[],
  timeZone: string,
  rangeStart: Ymd,
  rangeEnd: Ymd,
  dayOf: (e: AuditEvent) => number,
): AuditCoverage {
  if (events.length === 0) return { partial: true } as AuditCoverage;
  const oldest = events[0] as AuditEvent;
  const newest = events[events.length - 1] as AuditEvent;
  const oldestDay = dayOf(oldest);
  const startDay = ymdDays(rangeStart);
  const start = Math.max(oldestDay, startDay);
  if (dayOf(newest) < startDay || start > ymdDays(rangeEnd))
    return { partial: true } as AuditCoverage;
  void timeZone;
  const startYmd = addDays(rangeStart, start - startDay);
  return {
    startDate: ymdString(startYmd),
    endDate: ymdString(rangeEnd),
    partial: start > startDay,
  } as AuditCoverage;
}
