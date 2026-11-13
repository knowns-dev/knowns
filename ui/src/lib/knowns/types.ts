import type { ReactNode } from "react";

/** Who takes part in a run. */
export type ActorType = "agent" | "tool" | "human";

/** busy: working · blocked: waiting on a human · failed · finished. */
export type ActorState = "idle" | "busy" | "blocked" | "failed" | "finished";

export type SpanOutcome = "success" | "failure";

export interface Actor {
  id: string;
  type: ActorType;
  label: string;
  /** Shorter label for narrow containers. */
  short?: string;
  /** What this actor is for, e.g. "Finds the sources and decides the angle." */
  description?: string;
  /** Model name, e.g. "Opus 5.5" or "GPT-5". Agents get the provider logo from it. */
  model?: string;
  /** Overrides the logo picked from `model` (agents) or `label` (tools). */
  icon?: ReactNode;
  state?: ActorState;
  /** What the actor is doing right now. */
  activity?: string;
  /** Money spent so far. */
  spend?: number;
  /** The coordinating agent, placed right under the human. Defaults to the first agent. */
  root?: boolean;
}

/** One call from an actor to another. No `outcome` yet means it is still running. */
export interface Span {
  id: string;
  from: string;
  to: string;
  /** Epoch ms. */
  startedAt: number;
  endedAt?: number;
  outcome?: SpanOutcome;
  summary?: string;
  /** Arguments sent with the call (any JSON-serialisable value). */
  input?: unknown;
  /** Result returned by the call. */
  output?: unknown;
  /** Error message when the outcome is a failure. */
  error?: string;
}

/**
 * A piece of work an agent is doing, e.g. "Collect competitor pricing". Coarser than spans:
 * a task usually contains many tool calls. No `outcome` yet means it is still running.
 */
export interface Task {
  id: string;
  /** Agent doing the work. */
  actor: string;
  title: string;
  /** Epoch ms. */
  startedAt: number;
  endedAt?: number;
  outcome?: SpanOutcome;
  /** What came out of it, shown when the task is opened. */
  summary?: string;
  /** Agent the work was handed to when this task ended. */
  handoffTo?: string;
  /** Context passed along with the hand-off: files, notes, data, links. */
  handoffItems?: TaskItem[];
}

/** One piece of context handed from one agent to the next. `lost` marks what did not make it across. */
export interface TaskItem {
  id: string;
  label: string;
  kind?: "file" | "note" | "data" | "link";
  lost?: { reason: string };
}

export type ApprovalDecision = "approved" | "denied";

/** A request from an actor that needs a human decision before it can go on. */
export interface Approval {
  id: string;
  /** Actor asking. */
  actor: string;
  /** What it wants to do, e.g. "Post the report to #pricing". */
  title: string;
  /** Preview of the action: a message, a diff, a command… */
  detail?: string;
  /** Task that is waiting on this decision. */
  task?: string;
  /** Epoch ms. */
  requestedAt: number;
  decision?: ApprovalDecision;
  decidedAt?: number;
}

export type Link = [string, string];

export type AgentEvent =
  /** Add an actor, or merge into an existing one with the same id. */
  | { type: "actor"; actor: Actor }
  | { type: "actor.remove"; id: string }
  | { type: "span.start"; id: string; from: string; to: string; summary?: string; input?: unknown; at?: number }
  | { type: "span.end"; id: string; outcome?: SpanOutcome; summary?: string; output?: unknown; error?: string; at?: number }
  | { type: "task.start"; id: string; actor: string; title: string; at?: number }
  | { type: "task.end"; id: string; outcome?: SpanOutcome; summary?: string; handoffTo?: string; handoffItems?: TaskItem[]; at?: number }
  /** Put a lost hand-off item back (clears its `lost`). */
  | { type: "task.item.restore"; id: string; item: string }
  | { type: "approval.request"; id: string; actor: string; title: string; detail?: string; task?: string; at?: number }
  | { type: "approval.resolve"; id: string; decision: ApprovalDecision; at?: number }
  /** A permanent link, drawn before any span uses it. */
  | { type: "link"; from: string; to: string }
  | { type: "reset" };

export interface AgentSnapshot {
  actors: Actor[];
  spans: Span[];
  links: Link[];
  tasks: Task[];
  approvals: Approval[];
}
