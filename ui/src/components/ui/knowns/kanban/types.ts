import type { ReactNode } from "react";

/**
 * Contract shared by <KanbanBoard> (generic, kanban-board.tsx) and <AgentBoard>
 * (run-store adapter, agent-board.tsx). Change it only by agreement between both.
 */

export interface KanbanColumn {
  id: string;
  title: string;
  /** Soft WIP limit. Over the limit the count reads "4/3" and the column is marked, never blocked. */
  limit?: number;
  /** Tone of the small dot next to the title. */
  tone?: "neutral" | "accent" | "info" | "success" | "warning" | "danger";
  /** Cards can't be dropped here (e.g. a "Running" column driven by agents). */
  locked?: boolean;
}

export interface KanbanPerson {
  id: string;
  name: string;
  /** Agents show their provider logo from `model`. */
  kind?: "human" | "agent";
  model?: string;
  icon?: ReactNode;
}

export interface KanbanCard {
  id: string;
  column: string;
  title: string;
  /** Short key such as "BIL-142". */
  key?: string;
  /** Small labels shown as badges. */
  labels?: { text: string; tone?: KanbanColumn["tone"] }[];
  assignee?: string;
  due?: string;
  points?: number;
  /** Checklist progress, rendered as "2/5". */
  checklist?: { done: number; total: number };
  /** 0–1. Shown as a thin bar, e.g. for a running agent task. */
  progress?: number;
  /** Live state; "busy" breathes, "blocked" asks for attention, "failed" is marked. */
  state?: "idle" | "busy" | "blocked" | "failed" | "finished";
  /** Card can't be dragged (agent-driven). */
  locked?: boolean;
  /** Free slot under the title (e.g. inline approve / deny buttons). */
  footer?: ReactNode;
}

/** Where a card was moved: target column and its index within that column (after removal). */
export interface KanbanMove {
  card: string;
  from: string;
  to: string;
  index: number;
}

export interface KanbanBoardProps {
  columns: KanbanColumn[];
  people?: KanbanPerson[];
  /** Controlled cards (ordered: order within a column is array order). */
  cards?: KanbanCard[];
  defaultCards?: KanbanCard[];
  onCardsChange?: (cards: KanbanCard[]) => void;
  /** Fired after a drop or keyboard move; return false to reject it. */
  onMove?: (move: KanbanMove) => boolean | void;
  /** "status" = columns; "assignee" = swimlanes per person, columns stay. */
  groupBy?: "status" | "assignee";
  defaultGroupBy?: "status" | "assignee";
  onGroupByChange?: (g: "status" | "assignee") => void;
  /** Shows "Add card" at the bottom of each unlocked column. */
  onAddCard?: (column: string, title: string) => void;
  onCardOpen?: (card: KanbanCard) => void;
  /** Override card rendering; the default card is exported as <KanbanCardView>. */
  renderCard?: (card: KanbanCard, ctx: { dragging: boolean; person?: KanbanPerson }) => ReactNode;
  title?: ReactNode;
  /** Right side of the header. */
  actions?: ReactNode;
  /** Quiet text on the right of the header (e.g. "3 agents working · $0.54"). Default: "N cards" next to the title. */
  summary?: ReactNode;
  /** Columns share the width but never get narrower than this (px); past that the board scrolls. Default 248. */
  columnMinWidth?: number;
  /** "panel" (default): the board sits on its own card. "none": no outer surface, for a page or a docs frame. */
  surface?: "panel" | "none";
  className?: string;
  "aria-label"?: string;
}
