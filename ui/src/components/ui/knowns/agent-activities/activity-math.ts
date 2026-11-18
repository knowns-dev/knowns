export type GraphNodeState = "done" | "running" | "queued" | "failed";
export interface GraphNode {
  id: string;
  label?: string;
  state: GraphNodeState;
  /** Ids this node waits for. Edges run from each of them to this node. */
  after?: readonly string[];
}

/** Columns by depth (the longest chain behind a node), rows by order inside a column. Positions are fractions 0 to 1 of the box. */
export function layoutGraph(nodes: readonly GraphNode[]): { pos: Map<string, { x: number; y: number }>; edges: [string, string][] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0; // a cycle: stop here
    seen.add(id);
    const n = byId.get(id);
    const d = n?.after?.length ? 1 + Math.max(...n.after.filter((a) => byId.has(a)).map((a) => depthOf(a, seen)), -1) : 0;
    depth.set(id, d);
    return d;
  };
  for (const n of nodes) depthOf(n.id, new Set());
  const cols = Math.max(1, ...[...depth.values()].map((d) => d + 1));
  const rows = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    rows.set(d, [...(rows.get(d) ?? []), n.id]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, ids] of rows) ids.forEach((id, i) => pos.set(id, { x: (d + 0.5) / cols, y: (i + 0.5) / ids.length }));
  const edges: [string, string][] = [];
  for (const n of nodes) for (const a of n.after ?? []) if (byId.has(a)) edges.push([a, n.id]);
  return { pos, edges };
}

/** stroke-dashoffset for a ring drawn with pathLength 1 that shows `fraction` of the circle. */
export const ringOffset = (fraction: number) => 1 - (Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0);

export type BudgetTone = "ok" | "low" | "critical";
/** How much budget is left, as a tone: under 5% is critical, under 20% (80% used) is low. */
export const budgetTone = (leftFraction: number): BudgetTone => (leftFraction < 0.05 ? "critical" : leftFraction < 0.2 ? "low" : "ok");
export const TONE_COLOR: Record<BudgetTone, string> = {
  ok: "#6366f1",
  low: "#f59e0b",
  critical: "#ef4444",
};
/** One accent for every kind of activity; colour beyond it only says status (amber low, red over). */
export const ACCENT = { run: "#6366f1", eta: "#6366f1", voice: "#6366f1", handoff: "#6366f1" } as const;

/** The last `count` levels (each 0 to 1), padded on the left with 0 so the bars keep their places. */
export function waveBars(levels: readonly number[], count: number): number[] {
  const tail = levels.slice(-count).map((l) => (Number.isFinite(l) ? Math.min(1, Math.max(0, l)) : 0));
  return [...Array(Math.max(0, count - tail.length)).fill(0), ...tail];
}

/** The handoff clock: "22s" under a minute, "1:05" above. */
export function shortClock(ms: number): string {
  const s = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "About 4 min", "under a minute", "about 1 h 20 min". */
export function etaWords(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "done";
  if (minutes < 1) return "under a minute";
  const m = Math.round(minutes);
  if (m < 60) return `about ${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `about ${h} h ${r} min` : `about ${h} h`;
}
