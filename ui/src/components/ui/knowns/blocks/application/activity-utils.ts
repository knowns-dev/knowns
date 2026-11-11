export type ActivityWho = "all" | "people" | "agents";

export interface ActivityLike {
  id: string;
  at: number;
  type: string;
  unread?: boolean;
  actor: { name: string; agent?: boolean };
}

/** Filter by who did it and by type. An empty `types` means every type. */
export function filterActivity<T extends ActivityLike>(items: readonly T[], who: ActivityWho, types: readonly string[] = []): T[] {
  return items
    .filter((i) => (who === "all" ? true : who === "agents" ? !!i.actor.agent : !i.actor.agent) && (types.length === 0 || types.includes(i.type)))
    .sort((a, b) => b.at - a.at);
}

/** The distinct types in a feed, most frequent first, then alphabetical. */
export function activityTypes(items: readonly { type: string }[]): string[] {
  const n = new Map<string, number>();
  for (const i of items) n.set(i.type, (n.get(i.type) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

/** "3 files, +42 -7" (zero sides left out). */
export function diffSummary(d: { files: number; added: number; removed: number }): string {
  const files = `${d.files} file${d.files === 1 ? "" : "s"}`;
  const lines = [d.added ? `+${d.added}` : "", d.removed ? `-${d.removed}` : ""].filter(Boolean).join(" ");
  return lines ? `${files}, ${lines}` : files;
}

/** Ids that arrived (not in `seen`) and are newer than everything seen: these are what the "N new" pill counts. */
export function newerThanSeen(items: readonly { id: string; at: number }[], seen: ReadonlySet<string>): string[] {
  let top = 0;
  for (const i of items) if (seen.has(i.id)) top = Math.max(top, i.at);
  return items.filter((i) => !seen.has(i.id) && i.at >= top).map((i) => i.id);
}

export function newPillText(count: number): string {
  return `${count} new ${count === 1 ? "update" : "updates"}`;
}

/** Unread by the item's own flag, unless the reader has read it here. */
export function isUnread(item: { id: string; unread?: boolean }, read: ReadonlySet<string>): boolean {
  return !!item.unread && !read.has(item.id);
}

/** How many items are still unread. */
export function unreadCount(items: readonly { id: string; unread?: boolean }[], read: ReadonlySet<string>): number {
  let n = 0;
  for (const i of items) if (isUnread(i, read)) n++;
  return n;
}

/** Ids of the unread items (what "Mark all read" reports). */
export function unreadIds(items: readonly { id: string; unread?: boolean }[], read: ReadonlySet<string>): string[] {
  return items.filter((i) => isUnread(i, read)).map((i) => i.id);
}

/** Counts per type plus the total, for the tab labels. Types with no items are 0. */
export function typeCounts(items: readonly { type: string }[], types: readonly string[] = []): { all: number; byType: Record<string, number> } {
  const byType: Record<string, number> = {};
  for (const t of types) byType[t] = 0;
  for (const i of items) byType[i.type] = (byType[i.type] ?? 0) + 1;
  return { all: items.length, byType };
}

/** Put incoming items on top, newest first. Items whose id is already there are skipped. */
export function insertNew<T extends { id: string; at: number }>(items: readonly T[], incoming: readonly T[]): T[] {
  const have = new Set(items.map((i) => i.id));
  const fresh = incoming.filter((i) => !have.has(i.id));
  return [...fresh, ...items].sort((a, b) => b.at - a.at);
}

/** Delay in ms for row `index` of the mark-all-read sweep: at most 4 rows are staggered, the rest go with the last. */
export function sweepDelay(index: number, step = 40, max = 4): number {
  return Math.min(Math.max(index, 0), max - 1) * step;
}
