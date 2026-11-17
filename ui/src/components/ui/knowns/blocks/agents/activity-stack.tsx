"use client";
/** @registry name="activity-stack" type="block" title="Activity stack" description="Several live agent activities at once: newest on top, one open at a time, a +N chip past the first few, arrivals that rise in, and a finished one that dims and then leaves. Takes a list of items, each picking one of the agent activity capsules." */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { MotionStyle, RowShell, useMotionList } from "@/ui/lib/knowns/motion";
import { AnimatedNumber } from "../../animated-number";
import { Button } from "../../button";
import { Progress } from "../../progress";
import { Spinner } from "../../spinner";
import { ActivityTicks, LiveActivity, formatClock, type ActivityState } from "../../live-activity/live-activity";
import { BudgetRingActivity, BudgetTicksActivity, EtaActivity, HandoffActivity, RunProgressActivity, VoiceActivity, type BudgetRingActivityProps, type BudgetTicksActivityProps, type EtaActivityProps, type HandoffActivityProps, type RunProgressActivityProps, type VoiceActivityProps } from "../../agent-activities/agent-activities";

type Common = { id: string; /** Finished: the capsule dims, then the stack asks you to drop it (onDismiss). */ done?: boolean };
export type ActivityItem =
  | ({ kind: "run" } & Common & RunProgressActivityProps)
  | ({ kind: "eta" } & Common & EtaActivityProps)
  | ({ kind: "budget" } & Common & BudgetTicksActivityProps)
  | ({ kind: "ring" } & Common & BudgetRingActivityProps)
  | ({ kind: "voice" } & Common & VoiceActivityProps)
  | ({ kind: "handoff" } & Common & HandoffActivityProps)
  | ({ kind: "operation" } & Common & OperationActivityProps);

export type OperationState = "queued" | "running" | "cancelling" | "done" | "failed" | "cancelled";
export interface OperationAction {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  /** "default" is the quiet secondary chip. Default "default". */
  variant?: "default" | "destructive" | "ghost";
  disabled?: boolean;
}
/** A generic background operation (an import, an export, a sync): not tied to an agent. */
export interface OperationActivityProps {
  title: ReactNode;
  /** A line under the title. A failed operation shows `error` there instead. */
  message?: ReactNode;
  state: OperationState;
  /** How far it is. null (or omitted) while running: unknown, shown as an indeterminate bar. */
  progress?: { done: number; total: number } | null;
  error?: ReactNode;
  /** Buttons in the open capsule, in this order. */
  actions?: readonly OperationAction[];
  /** Shows a Dismiss button once it has finished or failed; the stack also calls it when a finished capsule leaves. */
  onDismiss?: () => void;
  startedAt?: Date;
  finishedAt?: Date;
}

/** What each state looks like: the dot, a colour for it, a word, and whether it counts as finished. Failed is not finished: it stays until you dismiss it. */
export const OPERATION_TONE: Record<OperationState, { dot: ActivityState; color?: string; word: string; finished: boolean }> = {
  queued: { dot: "idle", word: "Queued", finished: false },
  running: { dot: "busy", word: "Running", finished: false },
  cancelling: { dot: "busy", color: "var(--color-amber-500)", word: "Cancelling", finished: false },
  done: { dot: "finished", color: "var(--color-emerald-500)", word: "Done", finished: true },
  failed: { dot: "failed", color: "var(--color-red-500)", word: "Failed", finished: false },
  cancelled: { dot: "idle", color: "var(--muted-foreground)", word: "Cancelled", finished: true },
};

/** Whether an item has finished: its own `done`, or what its kind implies (a finished run, an ETA of zero). */
export function isActivityDone(item: ActivityItem): boolean {
  if (item.done !== undefined) return item.done;
  if (item.kind === "run") return !!item.finished;
  if (item.kind === "eta") return item.etaMinutes <= 0;
  if (item.kind === "ring") return item.left <= 0;
  if (item.kind === "operation") return OPERATION_TONE[item.state].finished;
  return false;
}

export interface ActivityStackProps {
  /** Newest first. */
  items: readonly ActivityItem[];
  /** How many show before the "+N" chip. Default 3. */
  max?: number;
  /** The open capsule's id: controlled. Only one is open at a time. */
  expandedId?: string | null;
  defaultExpandedId?: string | null;
  onExpandedChange?: (id: string | null) => void;
  /** Surface of every capsule: "auto" (default), "inverse" or "surface", as on the capsule itself. */
  tone?: "auto" | "inverse" | "surface";
  /** How long a finished capsule stays, dimmed, before onDismiss(id) is called. Default 4000. Pass 0 to never. */
  dismissAfterMs?: number;
  onDismiss?: (id: string) => void;
  className?: string;
}

const OP_VARIANT = { default: "secondary", destructive: "destructive", ghost: "ghost" } as const;

function OperationBody({ p }: { p: OperationActivityProps }) {
  const { state, progress, startedAt, finishedAt } = p;
  const running = state === "running" || state === "cancelling";
  const ms = useElapsedMs(startedAt, running, finishedAt);
  const fraction = progress && progress.total > 0 ? progress.done / progress.total : 0;
  const color = OPERATION_TONE[state].color;
  return (
    <>
      {progress ? <ActivityTicks value={state === "done" ? 1 : fraction} color={color} label="Progress" /> : state === "running" || state === "cancelling" ? <Progress indeterminate aria-label="In progress" size="sm" tone={state === "cancelling" ? "warning" : "accent"} /> : null}
      {p.state === "failed" && p.error ? <p className="text-[13px] text-red-600 dark:text-red-400">{p.error}</p> : null}
      {ms !== null && <p className="text-[12px] text-muted-foreground tabular-nums">{formatClock(ms)}</p>}
    </>
  );
}

/** Elapsed ms since startedAt, ticking while running; frozen at finishedAt. Null without a start. */
function useElapsedMs(startedAt: Date | undefined, running: boolean, finishedAt?: Date): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt || !running || finishedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt, running, finishedAt]);
  if (!startedAt) return null;
  return Math.max(0, (finishedAt ? finishedAt.getTime() : now) - startedAt.getTime());
}

function OperationCapsule({ item, shared }: { item: OperationActivityProps; shared: { tone: "auto" | "inverse" | "surface"; expanded: boolean; onExpandedChange: (open: boolean) => void; className: string; dimmed: boolean; pulse: boolean } }) {
  const t = OPERATION_TONE[item.state];
  const ended = t.finished || item.state === "failed";
  const count = item.progress ? <span><AnimatedNumber value={item.progress.done} /> / {item.progress.total.toLocaleString()}</span> : null;
  const trailing = item.state === "cancelling" ? <span className="inline-flex items-center gap-2">{count ?? "Cancelling…"}<Spinner label="Cancelling" /></span> : count ?? t.word;
  return (
    <LiveActivity
      {...shared}
      pulse={shared.pulse && item.state === "running"}
      accent={t.color}
      title={item.title}
      subtitle={item.message ?? (item.progress && item.state !== "failed" ? t.word : undefined)}
      state={t.dot}
      trailing={trailing}
      actions={
        (item.actions && item.actions.length > 0) || (ended && item.onDismiss) ? (
          <>
            {item.actions?.map((a) => (
              <Button key={a.id} size="sm" variant={OP_VARIANT[a.variant ?? "default"]} className="rounded-full" disabled={a.disabled} onClick={a.onSelect}>
                {a.label}
              </Button>
            ))}
            {ended && item.onDismiss && (
              <Button size="sm" variant="ghost" className="rounded-full" onClick={item.onDismiss}>
                Dismiss
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      <OperationBody p={item} />
    </LiveActivity>
  );
}

function Capsule({ item, tone, expanded, onToggle, pulse }: { item: ActivityItem; tone: "auto" | "inverse" | "surface"; expanded: boolean; onToggle: (open: boolean) => void; pulse: boolean }) {
  const shared = { tone, expanded, onExpandedChange: onToggle, className: "max-w-none", dimmed: isActivityDone(item), pulse };
  switch (item.kind) {
    case "run": {
      const { kind: _k, id: _i, done: _d, ...p } = item;
      return <RunProgressActivity {...p} {...shared} />;
    }
    case "eta": {
      const { kind: _k, id: _i, done: _d, ...p } = item;
      return <EtaActivity {...p} {...shared} />;
    }
    case "budget": {
      const { kind: _k, id: _i, done: _d, ...p } = item;
      return <BudgetTicksActivity {...p} {...shared} />;
    }
    case "ring": {
      const { kind: _k, id: _i, done: _d, ...p } = item;
      return <BudgetRingActivity {...p} {...shared} />;
    }
    case "voice": {
      const { kind: _k, id: _i, done: _d, ...p } = item;
      return <VoiceActivity {...p} {...shared} />;
    }
    case "handoff": {
      const { kind: _k, id: _i, done: _d, ...p } = item;
      return <HandoffActivity {...p} {...shared} />;
    }
    case "operation": {
      const { kind: _k, id: _i, done: _d, ...p } = item;
      return <OperationCapsule item={p} shared={shared} />;
    }
  }
}

/**
 * Many agents at once as a stack of capsules. The newest is on top, one is open at a time, and past `max` a "+N" chip holds
 * the rest. A capsule that arrives rises in (180ms, staggered by 40ms for the first four); one that finishes dims its content to 60% (it keeps its own surface), and
 * `onDismiss` fires after `dismissAfterMs` so you can drop it, which collapses its row.
 */
export function ActivityStack({ items, max = 3, expandedId, defaultExpandedId = null, onExpandedChange, tone = "auto", dismissAfterMs = 4000, onDismiss, className }: ActivityStackProps) {
  const [kept, setKept] = useState<string | null>(defaultExpandedId);
  const [all, setAll] = useState(false);
  const open = expandedId !== undefined ? expandedId : kept;
  const setOpen = (id: string | null) => {
    if (expandedId === undefined) setKept(id);
    onExpandedChange?.(id);
  };
  const shown = all ? items : items.slice(0, max);
  const hidden = Math.max(0, items.length - shown.length);
  const rows = useMotionList([...shown], (i) => i.id);

  // One timer per finished id, started once when it finishes and kept across re-renders: a parent that re-renders every second, or
  // passes a new onDismiss each time, must not restart it. The latest onDismiss is read when the timer fires.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const live = useRef(items);
  live.current = items;
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const doneIds = items.filter(isActivityDone).map((i) => i.id).join("|");
  useEffect(() => {
    const done = new Set(doneIds.split("|").filter(Boolean));
    for (const [id, t] of timers.current) {
      if (!done.has(id)) {
        clearTimeout(t);
        timers.current.delete(id);
      }
    }
    if (!dismissAfterMs) return;
    for (const id of done) {
      if (timers.current.has(id)) continue;
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          const it = live.current.find((i) => i.id === id);
          if (it?.kind === "operation") it.onDismiss?.();
          dismiss.current?.(id);
        }, dismissAfterMs),
      );
    }
  }, [doneIds, dismissAfterMs]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  // One ping per stack: the open capsule, else the first one still running.
  const pingId = open ?? items.find((i) => !isActivityDone(i))?.id;

  let n = 0;
  return (
    <div className={cn("flex w-full max-w-sm flex-col gap-2", className)}>
      <MotionStyle />
      <ul className="flex flex-col" aria-label="Agent activities">
        {rows.map((row) => {
          const item = row.item;
          const delay = row.entering && !row.exiting ? Math.min(n++, 3) * 40 : 0;
          return (
            <RowShell key={row.key} row={row} innerClassName="pb-2" style={delay ? { animationDelay: `${delay}ms` } : undefined}>
              <Capsule item={item} tone={tone} expanded={open === item.id} pulse={item.id === pingId} onToggle={(o) => setOpen(o ? item.id : null)} />
            </RowShell>
          );
        })}
      </ul>
      {(hidden > 0 || (all && items.length > max)) && (
        <button type="button" onClick={() => setAll(!all)} aria-expanded={all} className={cn("-mt-1 h-8 cursor-pointer self-center rounded-full border border-border px-3 text-[12.5px] font-medium text-muted-foreground tabular-nums transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:bg-muted hover:text-foreground", )}>
          {all ? "Show fewer" : `+${hidden} more`}
        </button>
      )}
    </div>
  );
}

export default ActivityStack;
