import { useState, useSyncExternalStore } from "react";
import type { Actor, AgentEvent, AgentSnapshot, Approval, Link, Span, Task } from "./types";

/**
 * An agent run: a small store fed with events (from a stream, a websocket, a trace…).
 * Every Knowns UI component can read the same run, so they stay in sync.
 */
export interface AgentRun {
  emit(event: AgentEvent | AgentEvent[]): void;
  getSnapshot(): AgentSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface AgentRunOptions {
  initial?: Partial<AgentSnapshot>;
  /** Oldest spans are dropped past this many. Default 500. */
  maxSpans?: number;
  /** Clock used when an event has no `at`. Default Date.now. */
  now?: () => number;
}

const EMPTY: AgentSnapshot = { actors: [], spans: [], links: [], tasks: [], approvals: [] };

export function createAgentRun(options: AgentRunOptions = {}): AgentRun {
  const maxSpans = options.maxSpans ?? 500;
  const now = options.now ?? Date.now;
  let snap: AgentSnapshot = {
    actors: options.initial?.actors ?? [],
    spans: options.initial?.spans ?? [],
    links: options.initial?.links ?? [],
    tasks: options.initial?.tasks ?? [],
    approvals: options.initial?.approvals ?? [],
  };
  const listeners = new Set<() => void>();

  const apply = (s: AgentSnapshot, e: AgentEvent): AgentSnapshot => {
    switch (e.type) {
      case "actor": {
        const i = s.actors.findIndex((a) => a.id === e.actor.id);
        const actors = s.actors.slice();
        if (i === -1) actors.push(e.actor);
        else actors[i] = { ...actors[i], ...e.actor } as Actor;
        return { ...s, actors };
      }
      case "actor.remove":
        return {
          approvals: s.approvals.filter((x) => x.actor !== e.id),
          tasks: s.tasks.filter((x) => x.actor !== e.id),
          actors: s.actors.filter((a) => a.id !== e.id),
          spans: s.spans.filter((x) => x.from !== e.id && x.to !== e.id),
          links: s.links.filter(([a, b]) => a !== e.id && b !== e.id),
        };
      case "span.start": {
        const span: Span = { id: e.id, from: e.from, to: e.to, startedAt: e.at ?? now(), summary: e.summary, input: e.input };
        const spans = s.spans.filter((x) => x.id !== e.id);
        spans.push(span);
        return { ...s, spans: spans.length > maxSpans ? spans.slice(spans.length - maxSpans) : spans };
      }
      case "span.end": {
        const i = s.spans.findIndex((x) => x.id === e.id);
        if (i === -1) return s;
        const spans = s.spans.slice();
        spans[i] = {
          ...spans[i],
          endedAt: e.at ?? now(),
          outcome: e.outcome ?? "success",
          summary: e.summary ?? spans[i].summary,
          output: e.output ?? spans[i].output,
          error: e.error ?? spans[i].error,
        };
        return { ...s, spans };
      }
      case "link": {
        if (s.links.some(([a, b]) => (a === e.from && b === e.to) || (a === e.to && b === e.from))) return s;
        return { ...s, links: [...s.links, [e.from, e.to] as Link] };
      }
      case "task.start": {
        const task: Task = { id: e.id, actor: e.actor, title: e.title, startedAt: e.at ?? now() };
        const tasks = [...s.tasks.filter((x) => x.id !== e.id), task];
        return { ...s, tasks: tasks.length > maxSpans ? tasks.slice(tasks.length - maxSpans) : tasks };
      }
      case "task.end": {
        const i = s.tasks.findIndex((x) => x.id === e.id);
        if (i === -1 || s.tasks[i].outcome) return s;
        const tasks = s.tasks.slice();
        tasks[i] = {
          ...tasks[i],
          endedAt: e.at ?? now(),
          outcome: e.outcome ?? "success",
          summary: e.summary ?? tasks[i].summary,
          handoffTo: e.handoffTo ?? tasks[i].handoffTo,
          handoffItems: e.handoffItems ?? tasks[i].handoffItems,
        };
        return { ...s, tasks };
      }
      case "task.item.restore": {
        const i = s.tasks.findIndex((x) => x.id === e.id);
        const items = i === -1 ? undefined : s.tasks[i].handoffItems;
        if (!items?.some((it) => it.id === e.item && it.lost)) return s;
        const tasks = s.tasks.slice();
        tasks[i] = { ...tasks[i], handoffItems: items.map((it) => (it.id === e.item ? { id: it.id, label: it.label, kind: it.kind } : it)) };
        return { ...s, tasks };
      }
      case "approval.request": {
        const approval: Approval = { id: e.id, actor: e.actor, title: e.title, detail: e.detail, task: e.task, requestedAt: e.at ?? now() };
        return { ...s, approvals: [...s.approvals.filter((x) => x.id !== e.id), approval] };
      }
      case "approval.resolve": {
        const i = s.approvals.findIndex((x) => x.id === e.id);
        if (i === -1 || s.approvals[i].decision) return s;
        const approvals = s.approvals.slice();
        approvals[i] = { ...approvals[i], decision: e.decision, decidedAt: e.at ?? now() };
        return { ...s, approvals };
      }
      case "reset":
        return EMPTY;
    }
  };

  return {
    emit(event) {
      const events = Array.isArray(event) ? event : [event];
      const next = events.reduce(apply, snap);
      if (next === snap) return;
      snap = next;
      listeners.forEach((l) => l());
    },
    getSnapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A run that lives as long as the component. */
export function useAgentRun(options?: AgentRunOptions): AgentRun {
  const [run] = useState(() => createAgentRun(options));
  return run;
}

const noop = () => () => {};
const none = () => undefined;

/** Current snapshot of a run, re-rendering on every change. Undefined when no run is given. */
export function useAgentSnapshot(run: AgentRun | undefined): AgentSnapshot | undefined {
  return useSyncExternalStore(run ? run.subscribe : noop, run ? run.getSnapshot : none, run ? run.getSnapshot : none);
}
