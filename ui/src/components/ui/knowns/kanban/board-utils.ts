import type { KanbanCard, KanbanColumn, KanbanPerson } from "./types";

/** Lane id for cards without a (known) assignee. */
export const UNASSIGNED = "__unassigned";
/** Lane id used when the board is grouped by status (a single lane). */
export const ALL = "__all";

export type GroupBy = "status" | "assignee";

/** Lane a card belongs to. */
export function laneOf(card: Pick<KanbanCard, "assignee">, groupBy: GroupBy, people: Set<string>): string {
  if (groupBy === "status") return ALL;
  return card.assignee && people.has(card.assignee) ? card.assignee : UNASSIGNED;
}

export const cellKey = (column: string, lane: string) => `${column}\u0000${lane}`;

/** Cards per cell (column × lane), each list in array order. Arrays are fresh only when `cards` changes. */
export function groupCards(cards: KanbanCard[], groupBy: GroupBy, people: Set<string>): Map<string, KanbanCard[]> {
  const map = new Map<string, KanbanCard[]>();
  for (const c of cards) {
    const k = cellKey(c.column, laneOf(c, groupBy, people));
    const list = map.get(k);
    if (list) list.push(c);
    else map.set(k, [c]);
  }
  return map;
}

export interface CellTarget {
  column: string;
  /** ALL, UNASSIGNED or a person id. */
  lane: string;
  /** Position within the cell, counted without the moving card. */
  index: number;
}

/**
 * Move a card to `target`. The card takes `index` among the other cards of the target cell; its
 * column (and assignee, when the lane is a person or UNASSIGNED) are updated. Returns a new array;
 * the input is not changed. Unknown card ids return the input.
 */
export function moveCard(cards: KanbanCard[], id: string, target: CellTarget, groupBy: GroupBy, people: Set<string>): KanbanCard[] {
  const from = cards.findIndex((c) => c.id === id);
  if (from < 0) return cards;
  const card = cards[from];
  const moved: KanbanCard = { ...card, column: target.column };
  if (groupBy === "assignee" && target.lane !== laneOf(card, groupBy, people)) {
    moved.assignee = target.lane === UNASSIGNED ? undefined : target.lane;
  }
  const rest = cards.filter((_, i) => i !== from);
  const inCell = (c: KanbanCard) => c.column === target.column && laneOf(c, groupBy, people) === target.lane;
  const cell: number[] = [];
  rest.forEach((c, i) => inCell(c) && cell.push(i));
  let at: number;
  if (target.index < cell.length) at = cell[Math.max(0, target.index)];
  else if (cell.length) at = cell[cell.length - 1] + 1;
  else {
    // Empty cell: after the last card of the same column, else at the end.
    let last = -1;
    rest.forEach((c, i) => c.column === target.column && (last = i));
    at = last >= 0 ? last + 1 : rest.length;
  }
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

/** Index of a card among the cards of its column (the KanbanMove.index convention). */
export function columnIndex(cards: KanbanCard[], id: string): number {
  const card = cards.find((c) => c.id === id);
  if (!card) return -1;
  return cards.filter((c) => c.column === card.column).findIndex((c) => c.id === id);
}

/** Count text and whether a soft WIP limit is exceeded: "3", "2/3", "4/3". */
export function wip(count: number, limit?: number): { label: string; over: boolean } {
  if (limit === undefined || limit < 0) return { label: String(count), over: false };
  return { label: `${count}/${limit}`, over: count > limit };
}

/** Insertion index for pointer `y` given the vertical midpoints of the other cards (top to bottom). */
export function slotIndex(mids: number[], y: number): number {
  let i = 0;
  while (i < mids.length && mids[i] < y) i++;
  return i;
}

/**
 * Auto-scroll speed (px per frame) for pointer position `p` inside [min, max]: zero in the middle,
 * ramping (quadratically) to ±`max` speed inside `zone` px of either edge, and capped beyond it.
 */
export function edgeSpeed(p: number, min: number, max: number, zone = 56, speed = 18): number {
  if (max - min < zone * 2) zone = Math.max(8, (max - min) / 3);
  if (p < min + zone) return -speed * Math.min(1, ((min + zone - p) / zone) ** 2);
  if (p > max - zone) return speed * Math.min(1, ((p - (max - zone)) / zone) ** 2);
  return 0;
}

export interface GridPos {
  col: number;
  lane: number;
  index: number;
}

/**
 * Keyboard move of a lifted card. ↑/↓ move within the cell, ←/→ jump to the next unlocked column
 * (keeping the position where it fits), Shift+↑/↓ change lane. `size(col, lane)` is the cell's
 * card count without the lifted card. Returns null when the key doesn't move it.
 */
export function keyboardMove(
  pos: GridPos,
  key: string,
  shift: boolean,
  columns: Pick<KanbanColumn, "locked">[],
  lanes: number,
  size: (col: number, lane: number) => number,
): GridPos | null {
  if (shift && (key === "ArrowUp" || key === "ArrowDown")) {
    const lane = pos.lane + (key === "ArrowUp" ? -1 : 1);
    if (lane < 0 || lane >= lanes) return null;
    return { col: pos.col, lane, index: Math.min(pos.index, size(pos.col, lane)) };
  }
  if (key === "ArrowUp") return pos.index > 0 ? { ...pos, index: pos.index - 1 } : null;
  if (key === "ArrowDown") return pos.index < size(pos.col, pos.lane) ? { ...pos, index: pos.index + 1 } : null;
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const dir = key === "ArrowRight" ? 1 : -1;
    for (let c = pos.col + dir; c >= 0 && c < columns.length; c += dir) {
      if (!columns[c].locked) return { col: c, lane: pos.lane, index: Math.min(pos.index, size(c, pos.lane)) };
    }
    return null;
  }
  return null;
}

/** "Moved to In review, position 2 of 4" (with the lane when there is one). */
export function positionText(verb: string, column: string, index: number, total: number, lane?: string): string {
  return `${verb} ${column}${lane ? `, ${lane}` : ""}, position ${index + 1} of ${total}`;
}

/** Name of a lane for people and announcements. */
export function laneName(lane: string, people: KanbanPerson[]): string | undefined {
  if (lane === ALL) return undefined;
  if (lane === UNASSIGNED) return "Unassigned";
  return people.find((p) => p.id === lane)?.name ?? lane;
}
