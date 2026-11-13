import type { KanbanCard, KanbanColumn } from "../kanban/types";

export type DetailTone = "neutral" | "info" | "warning" | "success" | "danger" | "accent";

/** Status pill: a live card state wins (Working / Needs you / Failed / Done), else the column. */
export function detailStatus(card: Pick<KanbanCard, "state" | "column">, columns: KanbanColumn[] = []): { label: string; tone: DetailTone } {
  switch (card.state) {
    case "busy":
      return { label: "Working", tone: "info" };
    case "blocked":
      return { label: "Needs you", tone: "warning" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "finished":
      return { label: "Done", tone: "success" };
  }
  const col = columns.find((c) => c.id === card.column);
  return { label: col?.title ?? card.column, tone: col?.tone ?? "neutral" };
}

/** The next unlocked column after the card's, for a "Move to …" primary action. */
export function nextColumn(columns: KanbanColumn[], current: string): KanbanColumn | undefined {
  const i = columns.findIndex((c) => c.id === current);
  if (i < 0) return undefined;
  return columns.slice(i + 1).find((c) => !c.locked);
}

/** Columns a person may move the card to: unlocked, not the current one. */
export function moveTargets(columns: KanbanColumn[], current: string): KanbanColumn[] {
  return columns.filter((c) => !c.locked && c.id !== current);
}

/** "Board › Column › KEY" (missing parts dropped). */
export function detailCrumbs(boardTitle: string | undefined, column: string | undefined, key: string | undefined): { label: string }[] {
  return [boardTitle, column, key].filter((x): x is string => !!x).map((label) => ({ label }));
}

/** "just now", "12s ago", "4m ago", "2h ago", "3d ago". */
export function timeAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "820 ms", "1.4s", "2m 05s". */
export function formatSpan(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

/** Done / total from steps or checklist items. */
export function countDone(items: { status?: string; done?: boolean }[]): { done: number; total: number } {
  return { done: items.filter((i) => i.done ?? i.status === "done").length, total: items.length };
}
