import type { AgentSnapshot } from "@/ui/lib/knowns/types";

/** Container widths (px) where the header changes shape. */
export const NARROW = 560;
export const TINY = 460;

/** What the header shows at a container width. */
export function headerLayout(width: number) {
  return {
    /** Below ~560px the first (root) breadcrumb is dropped. */
    hideRootCrumb: width > 0 && width < NARROW,
    /** Below ~460px the primary action shows only its icon. */
    iconOnlyPrimary: width > 0 && width < TINY,
  };
}

/**
 * How many secondary actions fit, in order, in `available` px. When not all fit, room is kept
 * for the overflow button (`more` px). `gap` sits between buttons.
 */
export function fitActions(widths: number[], available: number, gap: number, more: number): number {
  const total = widths.reduce((s, w, i) => s + w + (i > 0 ? gap : 0), 0);
  if (total <= available) return widths.length;
  let used = more;
  let n = 0;
  for (const w of widths) {
    const next = used + gap + w;
    if (next > available) break;
    used = next;
    n++;
  }
  return n;
}

/** Room the title keeps before actions take the rest of the row. */
export function titleReserve(width: number): number {
  return Math.min(360, Math.max(160, Math.round(width * 0.4)));
}

/**
 * Condensed or not, with hysteresis so it doesn't flicker at the threshold.
 * `scrolled` is how far (px) the header's top has moved past the top of its scroll area.
 */
export function nextCondensed(prev: boolean, scrolled: number, on = 16, off = 8): boolean {
  return prev ? scrolled > off : scrolled > on;
}

/**
 * Sticky `top` for the header so that, once stuck, only the compact bar and the tabs stay in view:
 * the rest of the header slides up under the edge. Never positive.
 */
export function stickyTop(fullHeight: number, compactHeight: number, tabsHeight: number): number {
  return Math.min(0, compactHeight + tabsHeight - fullHeight);
}

/** "31 of 40 issues · 78%". */
export function formatProgress(value: number, total: number, unit?: string): string {
  const pct = total > 0 ? Math.round((Math.min(Math.max(value, 0), total) / total) * 100) : 0;
  return `${value} of ${total}${unit ? ` ${unit}` : ""} · ${pct}%`;
}

export type RunState = "running" | "blocked" | "failed" | "done" | "idle";
export interface RunSummary {
  state: RunState;
  label: string;
  tone: "info" | "warning" | "danger" | "success" | "neutral";
  spend: number;
  agents: { id: string; label: string; model?: string }[];
  /** Pending approvals. */
  waiting: number;
}

/**
 * A run in one line: needs you (pending approval or a blocked actor) beats running (an open span or a
 * busy actor), then failed, then done. A run with nothing yet is idle.
 */
export function runSummary(snap: AgentSnapshot | undefined): RunSummary {
  const actors = snap?.actors ?? [];
  const waiting = (snap?.approvals ?? []).filter((a) => !a.decision).length;
  const open = (snap?.spans ?? []).some((s) => !s.outcome) || (snap?.tasks ?? []).some((t) => !t.outcome);
  const states = new Set(actors.map((a) => a.state));
  const spend = actors.reduce((s, a) => s + (a.spend ?? 0), 0);
  const agents = actors.filter((a) => a.type === "agent").map((a) => ({ id: a.id, label: a.label, model: a.model }));
  const base = { spend, agents, waiting };
  if (waiting > 0 || states.has("blocked")) return { ...base, state: "blocked", label: "Needs you", tone: "warning" };
  if (open || states.has("busy")) return { ...base, state: "running", label: "Running", tone: "info" };
  if (states.has("failed")) return { ...base, state: "failed", label: "Failed", tone: "danger" };
  if (actors.length === 0 && !snap?.spans.length) return { ...base, state: "idle", label: "Not started", tone: "neutral" };
  return { ...base, state: "done", label: "Done", tone: "success" };
}

/** "Jun 30", or "Jun 30, 2027" when not this year. */
export function formatDue(date: Date | string | number, now = new Date()): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return String(date);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) };
  return d.toLocaleDateString("en-US", opts);
}
