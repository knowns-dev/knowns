/** @registry part-of="agent-memory" */
/** Pure helpers for AgentMemory: filtering, ordering, counts and the words shown for time and confidence. */

export type MemoryScope = "user" | "project" | "session";

export interface MemorySource {
  id: string;
  /** "Chat: Pricing page copy", "Run #482". */
  label: string;
  href?: string;
  kind?: "conversation" | "run" | "manual";
}

export interface MemoryUse {
  id: string;
  /** What the run was doing: "Drafted release notes". */
  label: string;
  href?: string;
  at: Date | string | number;
}

export interface MemoryItem {
  id: string;
  text: string;
  scope: MemoryScope;
  source?: MemorySource;
  createdAt: Date | string | number;
  lastUsedAt?: Date | string | number | null;
  /** 0..1, how sure the agent is. Pinned items are kept regardless. */
  confidence?: number;
  pinned?: boolean;
  /** Recent runs that used it, newest first. */
  uses?: MemoryUse[];
  /** Total times used, if more than `uses` lists. */
  useCount?: number;
}

export type ScopeFilter = MemoryScope | "all";

export const SCOPES: MemoryScope[] = ["user", "project", "session"];
export const SCOPE_LABEL: Record<MemoryScope, string> = { user: "User", project: "Project", session: "Session" };
export const SCOPE_HINT: Record<MemoryScope, string> = {
  user: "About you, used everywhere",
  project: "About this project",
  session: "Only this session",
};

const ms = (t: Date | string | number | null | undefined) => (t === null || t === undefined || t === "" ? NaN : new Date(t).getTime());

/** Case- and accent-insensitive match on the text and the source label. Every word must match. */
export function matches(item: MemoryItem, query: string): boolean {
  const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold(`${item.text} ${item.source?.label ?? ""}`);
  return words.every((w) => hay.includes(w));
}

/** Pinned first, then most recently used (or created), newest first. Stable for ties. */
export function ordered(items: MemoryItem[]): MemoryItem[] {
  const key = (m: MemoryItem) => {
    const used = ms(m.lastUsedAt);
    return Number.isFinite(used) ? used : ms(m.createdAt);
  };
  return items
    .map((m, i) => ({ m, i }))
    .sort((a, b) => Number(Boolean(b.m.pinned)) - Number(Boolean(a.m.pinned)) || (key(b.m) || 0) - (key(a.m) || 0) || a.i - b.i)
    .map((x) => x.m);
}

export function filterMemories(
  items: MemoryItem[],
  o: { query?: string; scope?: ScopeFilter; hidden?: ReadonlySet<string>; match?: (item: MemoryItem, query: string) => boolean },
): MemoryItem[] {
  // Knowns: `match` replaces the built-in text + source search when given.
  const test = o.match ?? matches;
  const q = (o.query ?? "").trim();
  return ordered(items.filter((m) => !o.hidden?.has(m.id) && (o.scope === undefined || o.scope === "all" || m.scope === o.scope) && (q === "" || test(m, q))));
}

export function scopeCounts(items: MemoryItem[], hidden?: ReadonlySet<string>): Record<ScopeFilter, number> {
  const c: Record<ScopeFilter, number> = { all: 0, user: 0, project: 0, session: 0 };
  for (const m of items) {
    if (hidden?.has(m.id)) continue;
    c.all++;
    c[m.scope]++;
  }
  return c;
}

/** Ids of every (visible) memory that came from this source. */
export function idsFromSource(items: MemoryItem[], sourceId: string, hidden?: ReadonlySet<string>): string[] {
  return items.filter((m) => m.source?.id === sourceId && !hidden?.has(m.id)).map((m) => m.id);
}

export function confidenceLabel(c: number | undefined): string | null {
  if (c === undefined || !Number.isFinite(c)) return null;
  return c >= 0.8 ? "High confidence" : c >= 0.5 ? "Medium confidence" : "Low confidence";
}

/** 0-3 filled bars for a small confidence glyph. */
export const confidenceBars = (c: number | undefined) => (c === undefined || !Number.isFinite(c) ? 0 : c >= 0.8 ? 3 : c >= 0.5 ? 2 : 1);

/** "just now", "12 min ago", "3 h ago", "yesterday", "5 days ago", then a short date. */
export function ago(at: Date | string | number | null | undefined, now: number = Date.now()): string {
  const t = ms(at);
  if (!Number.isFinite(t)) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Used 4 times" / "Used once" / "Not used yet". */
export function usedText(item: MemoryItem): string {
  const n = item.useCount ?? item.uses?.length ?? 0;
  return n === 0 ? "Not used yet" : n === 1 ? "Used once" : `Used ${n} times`;
}

/** Text for the undo bar: "Forgot 1 memory" / "Forgot 3 memories from Run #482". */
export function forgotText(count: number, source?: string): string {
  return `Forgot ${count} ${count === 1 ? "memory" : "memories"}${source ? ` from ${source}` : ""}`;
}

/** Clean an edited memory: trimmed, inner whitespace runs kept as single spaces except newlines. */
export function cleanText(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
