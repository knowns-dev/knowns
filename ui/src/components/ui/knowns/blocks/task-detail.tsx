"use client";
/** @registry name="task-detail" type="block" title="Task detail" description="A task's own page in a side sheet, built on Page header: breadcrumbs, status, meta, progress, milestones, steps, activity and files, with move and overflow actions." */

import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { popLayer, pushLayer } from "@/ui/components/ui/modal-layer";
import { cn, focusRing, writeClipboard } from "@/ui/lib/knowns/utils";
import { modelIcon } from "@/ui/lib/knowns/icons/model-icons";
import { PersonGlyph } from "@/ui/lib/knowns/icons/actor-icon";
import { Avatar } from "../avatar";
import { Badge } from "../badge";
import { Button } from "../button";
import { Progress } from "../progress";
import { TabsContent } from "../tabs";
import type { KanbanCard, KanbanColumn, KanbanPerson } from "../kanban/types";
import { PageHeader, type PageHeaderAction, type PageHeaderCrumb, type PageHeaderMeta, type PageHeaderPerson } from "./page-header";
import { formatProgress } from "./page-header-utils";
import { countDone, detailCrumbs, detailStatus, moveTargets, nextColumn, timeAgo, type DetailTone } from "./task-detail-utils";

/* ── Data ── */

export interface DetailStep {
  id: string;
  title: ReactNode;
  status: "done" | "running" | "planned" | "failed";
  /** Right-aligned muted text, e.g. "Shipped Sep 18" or "1.4s". */
  meta?: ReactNode;
  /** Small logo before the title (e.g. a tool). */
  icon?: ReactNode;
  /** Shown under the row when it is opened (e.g. a ToolCallCard). */
  expand?: ReactNode;
}

export interface DetailActivity {
  id: string;
  who: { name: string; src?: string; icon?: ReactNode; model?: string; kind?: "human" | "agent" };
  /** What happened, after the name: "moved PRC-9 to review". */
  text: ReactNode;
  at: number;
}

export interface DetailFile {
  id: string;
  label: string;
  kind?: "file" | "note" | "data" | "link";
  /** Didn't make it across a hand-off. */
  lost?: { reason: string };
}

/** A tab added after Overview: its content is yours (Knowns: Plan, Notes, Time). */
export interface DetailTab {
  value: string;
  label: string;
  count?: number;
  content: ReactNode;
}

export interface TaskDetailProps {
  card: KanbanCard;
  people?: KanbanPerson[];
  columns?: KanbanColumn[];
  boardTitle?: string;
  /** Overrides: status pill, description, owner, extra meta, progress. */
  status?: { label: string; tone: DetailTone };
  description?: ReactNode;
  owner?: PageHeaderPerson & { model?: string; kind?: "human" | "agent" };
  meta?: PageHeaderMeta[];
  progress?: { value: number; total: number; unit?: string; label?: string };
  /** Checklist items (human cards): the milestone list on Overview. */
  checklist?: { id: string; title: ReactNode; done: boolean; meta?: ReactNode }[];
  /** Agent steps (tool calls): a Steps tab, and the milestone list on Overview. */
  steps?: DetailStep[];
  activity?: DetailActivity[];
  files?: DetailFile[];
  /** Extension: replaces the title text (e.g. an in-place editable title). */
  titleSlot?: ReactNode;
  /** Extension: replaces the Overview body (progress, checklist, recent activity) with your own. */
  overview?: ReactNode;
  /** Extension: tabs after Overview, before Activity. */
  tabs?: DetailTab[];
  /** Extension: replaces the Activity tab body (e.g. a version history with diffs). Its count is then hidden. */
  activityContent?: ReactNode;
  /** Extension: replaces the breadcrumbs (board › column › key), e.g. with links. */
  breadcrumbs?: PageHeaderCrumb[];
  /** A Comments tab with this content. */
  comments?: ReactNode;
  commentsCount?: number;
  /** Replace the generic actions. */
  primaryAction?: PageHeaderAction;
  actions?: PageHeaderAction[];
  moreActions?: PageHeaderAction[];
  /** Generic actions: "Move to ⟨next column⟩", the "Move to…" submenu. The board moves the card. */
  onMove?: (column: string) => void;
  onAssign?: () => void;
  onDelete?: () => void;
  /** Link for "Copy link". Default: the page URL with #card-id. */
  link?: string;
  /** Clock for relative times. Default Date.now(). */
  now?: number;
  defaultTab?: string;
  /** The scrolling element the header condenses against (the sheet body). */
  scrollContainer?: RefObject<HTMLElement | null>;
  /** End of the action row (the sheet passes its close button). */
  trailing?: ReactNode;
  className?: string;
}

/* ── Glyphs ── */

const g = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const Icon = {
  arrow: (
    <svg {...g}>
      <path d="M3 8h9M8.75 4.75 12 8l-3.25 3.25" />
    </svg>
  ),
  link: (
    <svg {...g}>
      <path d="M6.75 9.25a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.5.5M9.25 6.75a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l.5-.5" />
    </svg>
  ),
  user: (
    <svg {...g}>
      <circle cx="8" cy="5.75" r="2.75" />
      <path d="M2.75 13.75c.9-2.4 2.9-3.75 5.25-3.75s4.35 1.35 5.25 3.75" />
    </svg>
  ),
  columns: (
    <svg {...g}>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2" />
      <path d="M6 2.75v10.5M10 2.75v10.5" />
    </svg>
  ),
  trash: (
    <svg {...g}>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
    </svg>
  ),
  calendar: (
    <svg {...g}>
      <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </svg>
  ),
  file: (
    <svg {...g}>
      <path d="M4 1.75h5L12.25 5v9.25H4V1.75Z M9 1.75V5h3.25" />
    </svg>
  ),
  note: (
    <svg {...g}>
      <path d="M3 2.75h10v10.5H3zM5.5 6h5M5.5 8.5h5M5.5 11h3" />
    </svg>
  ),
  data: (
    <svg {...g}>
      <ellipse cx="8" cy="4" rx="4.75" ry="1.75" />
      <path d="M3.25 4v8c0 1 2.1 1.75 4.75 1.75s4.75-.75 4.75-1.75V4M3.25 8c0 1 2.1 1.75 4.75 1.75S12.75 9 12.75 8" />
    </svg>
  ),
  chevron: (
    <svg {...g} strokeWidth={1.7}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 16 16" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
};

/** Milestone-style status marks: done check, in progress dashed ring, planned hollow ring, failed cross. */
function StepMark({ status }: { status: DetailStep["status"] }) {
  if (status === "done")
    return (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-4 flex-none text-emerald-600 dark:text-emerald-400">
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5.4 8.2 7.2 10l3.4-3.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (status === "running")
    return (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-4 flex-none text-blue-600 motion-safe:animate-[spin_6s_linear_infinite] dark:text-blue-400">
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.6 2.3" />
      </svg>
    );
  if (status === "failed")
    return (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-4 flex-none text-red-600 dark:text-red-400">
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
        <path d="m5.75 5.75 4.5 4.5m0-4.5-4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-4 flex-none text-muted-foreground/60">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
const STEP_TEXT: Record<DetailStep["status"], string> = { done: "done", running: "in progress", planned: "planned", failed: "failed" };

/* ── People ── */

/** One letter for a one-word name ("You" → "Y"), like the board's avatars; undefined for full names (initials). */
export function personLetter(name: string): string | undefined {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.length === 1 ? [...words[0]][0]?.toUpperCase() : undefined;
}

/** "You" gets a person glyph (like the graph's You node); one-word names a single letter; others their initials. */
export function PersonMark({ name, src, icon, size = "xs" }: { name: string; src?: string; icon?: ReactNode; size?: "xs" | "sm" }) {
  if (/^you$/i.test(name.trim()) && !src && !icon)
    return (
      <span
        aria-hidden
        className={cn(
          "grid flex-none place-items-center rounded-full border bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] text-muted-foreground [border-color:color-mix(in_srgb,var(--foreground)_10%,transparent)] [&_svg]:size-[62%]",
          size === "xs" ? "size-5" : "size-6",
        )}
      >
        <PersonGlyph />
      </span>
    );
  const letter = !icon ? personLetter(name) : undefined;
  return (
    <Avatar
      label={name}
      src={src}
      size={size}
      shape="circle"
      decorative
      icon={icon ?? (letter ? <span className="grid place-items-center leading-none font-semibold">{letter}</span> : undefined)}
    />
  );
}

/* ── Pieces ── */

function Heading({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <h3 className="mb-1.5 flex items-baseline gap-2 text-[13.5px] font-semibold text-foreground">
      {children}
      {count !== undefined && <span className="text-[12.5px] font-normal text-muted-foreground tabular-nums">{count}</span>}
    </h3>
  );
}

/** Rows with a status mark, a title and right-aligned meta, split by hairlines. Rows with `expand` open in place. */
export function MilestoneList({ items, label }: { items: DetailStep[]; label: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!items.length) return <p className="py-2 text-[13px] text-muted-foreground">Nothing yet.</p>;
  return (
    <ul aria-label={label} className="divide-y divide-[color-mix(in_srgb,var(--foreground)_8%,transparent)]">
      {items.map((s) => {
        const body = (
          <>
            <StepMark status={s.status} />
            {s.icon && <span aria-hidden className="grid size-4 flex-none place-items-center text-muted-foreground [&>*]:size-full [&_svg]:size-full">{s.icon}</span>}
            <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", s.status === "planned" ? "text-foreground/75" : s.status === "failed" ? "text-red-700 dark:text-red-300" : "text-foreground")}>
              {s.title}
              <span className="sr-only">, {STEP_TEXT[s.status]}</span>
            </span>
            {s.meta && <span className="flex-none text-[12.5px] text-muted-foreground tabular-nums">{s.meta}</span>}
          </>
        );
        const expanded = open === s.id;
        return (
          <li key={s.id}>
            {s.expand ? (
              <>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : s.id)}
                  className={cn("-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-3 rounded-lg px-1.5 py-2.5 text-left transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]", focusRing)}
                >
                  {body}
                  <span className={cn("grid size-3.5 flex-none place-items-center text-muted-foreground transition-[rotate] duration-200 ease-(--kn-ease-out) [&>svg]:size-full", expanded && "rotate-90")}>{Icon.chevron}</span>
                </button>
                {expanded && <div className="pt-1 pb-3 animate-[kn-rise_200ms_var(--kn-ease-out)_both] motion-reduce:animate-none">{s.expand}</div>}
              </>
            ) : (
              <div className="flex items-center gap-3 py-2.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function WhoMark({ who }: { who: DetailActivity["who"] }) {
  const logo = who.icon ?? (who.kind === "agent" ? modelIcon(who.model ?? who.name) : undefined);
  if (who.kind === "agent" || (logo && !who.src))
    return (
      <span aria-hidden className="grid size-6 flex-none place-items-center rounded-md border bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] p-1 text-muted-foreground [border-color:color-mix(in_srgb,var(--foreground)_8%,transparent)] [&>*]:size-full [&_svg]:size-full">
        {logo}
      </span>
    );
  return <PersonMark name={who.name} src={who.src} size="sm" />;
}

export function ActivityList({ items, now, limit }: { items: DetailActivity[]; now: number; limit?: number }) {
  const sorted = [...items].sort((a, b) => b.at - a.at).slice(0, limit ?? items.length);
  if (!sorted.length) return <p className="py-2 text-[13px] text-muted-foreground">No activity yet.</p>;
  return (
    <ol aria-label="Activity" className="flex flex-col">
      {sorted.map((a) => (
        <li key={a.id} className="flex items-center gap-3 py-2">
          <WhoMark who={a.who} />
          <span className="min-w-0 flex-1 text-[13.5px] leading-snug text-muted-foreground">
            <span className="font-medium text-foreground">{a.who.name}</span> {a.text}
          </span>
          <time dateTime={new Date(a.at).toISOString()} className="flex-none text-[12.5px] text-muted-foreground tabular-nums">
            {timeAgo(a.at, now)}
          </time>
        </li>
      ))}
    </ol>
  );
}

export function FileList({ items }: { items: DetailFile[] }) {
  if (!items.length) return <p className="py-2 text-[13px] text-muted-foreground">No files.</p>;
  return (
    <ul aria-label="Files" className="divide-y divide-[color-mix(in_srgb,var(--foreground)_8%,transparent)]">
      {items.map((f) => (
        <li key={f.id} className="flex items-center gap-3 py-2.5">
          <span aria-hidden className={cn("grid size-4 flex-none place-items-center [&>svg]:size-full", f.lost ? "text-muted-foreground/50" : "text-muted-foreground")}>
            {f.kind === "note" ? Icon.note : f.kind === "data" ? Icon.data : f.kind === "link" ? Icon.link : Icon.file}
          </span>
          <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", f.lost ? "text-muted-foreground line-through decoration-muted-foreground/50" : "text-foreground")}>{f.label}</span>
          {f.lost && (
            <span className="flex flex-none items-center gap-2 text-[12.5px] text-muted-foreground">
              <span className="max-w-48 truncate">{f.lost.reason}</span>
              <Badge tone="danger" size="sm">Lost</Badge>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ProgressReadout({ value, total, unit, label }: { value: number; total: number; unit?: string; label?: string }) {
  return (
    <div className="flex max-w-[480px] flex-col gap-2">
      {/* The count is the number; the bar is the proportion. No percentage beside it: that says the same thing twice. */}
      <div className="flex items-baseline justify-between text-[13.5px]">
        <span className="text-foreground/85">
          {value} of {total} {unit ? `${unit} ` : ""}done
        </span>
      </div>
      <Progress aria-label={label ?? "Progress"} value={value} max={Math.max(1, total)} valueLabel="none" size="sm" tone={total > 0 && value >= total ? "success" : "neutral"} format={() => formatProgress(value, total, unit)} />
    </div>
  );
}

/* ── TaskDetail ── */

/**
 * A card's detail page, built on PageHeader: breadcrumbs and actions on one row, a large title with a status
 * pill, meta, and tabs (Overview, Steps, Activity, Files, Comments). Works for any Kanban card; agent boards
 * pass steps, activity, files and approve / retry actions on top.
 */
export function TaskDetail({
  card,
  people = [],
  columns = [],
  boardTitle,
  status,
  description,
  owner,
  meta = [],
  progress,
  checklist,
  steps,
  activity = [],
  files,
  comments,
  commentsCount,
  titleSlot,
  overview,
  tabs: extraTabs = [],
  activityContent,
  breadcrumbs,
  primaryAction,
  actions,
  moreActions,
  onMove,
  onAssign,
  onDelete,
  link,
  now = Date.now(),
  defaultTab = "overview",
  scrollContainer,
  trailing,
  className,
}: TaskDetailProps) {
  const column = columns.find((c) => c.id === card.column);
  const person = people.find((p) => p.id === card.assignee);
  const who = owner ?? (person ? { label: person.name, icon: person.kind === "agent" ? (person.icon ?? modelIcon(person.model ?? person.name) ?? undefined) : person.icon, model: person.model, kind: person.kind } : undefined);
  const pill = status ?? detailStatus(card, columns);

  /* Generic actions; agent boards pass their own. */
  const movable = !card.locked && !!onMove;
  const next = movable ? nextColumn(columns, card.column) : undefined;
  const targets = movable ? moveTargets(columns, card.column) : [];
  const copyLink: PageHeaderAction = {
    id: "copy-link",
    label: "Copy link",
    icon: Icon.link,
    onSelect: async () => {
      const url = link ?? `${location.href.split("#")[0]}#${card.id}`;
      try {
        await writeClipboard(url);
      } catch {
        /* clipboard may be blocked; the announcement still helps */
      }
      return "Link copied";
    },
  };
  const primary = primaryAction ?? (next ? { id: "move-next", label: `Move to ${next.title}`, icon: Icon.arrow, onSelect: () => (onMove!(next.id), `Moved to ${next.title}`) } : undefined);
  const secondary = actions ?? [...(onAssign ? [{ id: "assign", label: "Assign", icon: Icon.user, onSelect: onAssign }] : []), copyLink];
  const more =
    moreActions ??
    [
      ...(targets.length ? [{ id: "move", label: "Move to", icon: Icon.columns, items: targets.map((c) => ({ id: `move:${c.id}`, label: c.title, onSelect: () => (onMove!(c.id), `Moved to ${c.title}`) })) }] : []),
      ...(onDelete ? [{ id: "delete", label: "Delete card", icon: Icon.trash, danger: true, onSelect: onDelete }] : []),
    ];

  /* Overview list: agent steps, else checklist items. */
  const milestones: DetailStep[] = steps ?? (checklist ?? []).map((c) => ({ id: c.id, title: c.title, status: c.done ? "done" : "planned", meta: c.meta }));
  const counts = steps ? countDone(steps) : checklist ? countDone(checklist) : card.checklist ? { done: card.checklist.done, total: card.checklist.total } : undefined;
  const readout = progress ?? (counts && counts.total > 0 ? { ...counts, value: counts.done, unit: steps ? "steps" : undefined, label: steps ? "Steps done" : "Checklist done" } : undefined);

  const tabs = [
    { value: "overview", label: "Overview" },
    ...extraTabs.map((t) => ({ value: t.value, label: t.label, count: t.count })),
    ...(steps ? [{ value: "steps", label: "Steps", count: steps.length }] : []),
    { value: "activity", label: "Activity", count: activityContent ? undefined : activity.length },
    ...(files ? [{ value: "files", label: "Files", count: files.length }] : []),
    ...(comments !== undefined ? [{ value: "comments", label: "Comments", count: commentsCount }] : []),
  ];

  const allMeta: PageHeaderMeta[] = [
    ...(who
      ? [
          {
            id: "owner",
            content: (
              <span className="inline-flex items-center gap-1.5">
                {who.kind === "agent" && who.icon ? (
                  <span aria-hidden className="grid size-5 place-items-center rounded-md border bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] p-[3px] [border-color:color-mix(in_srgb,var(--foreground)_8%,transparent)] [&>*]:size-full [&_svg]:size-full">{who.icon}</span>
                ) : (
                  <PersonMark name={who.label} src={who.src} icon={who.icon} />
                )}
                <span className="text-foreground">{who.label}</span>
                {who.model && <span className="text-muted-foreground">{who.model}</span>}
              </span>
            ),
          },
        ]
      : []),
    ...(card.labels?.length
      ? [{ id: "labels", content: <span className="inline-flex flex-wrap gap-1">{card.labels.map((l) => <Badge key={l.text} tone={l.tone ?? "neutral"} size="sm">{l.text}</Badge>)}</span> }]
      : []),
    ...(card.due ? [{ id: "due", label: "Due", icon: Icon.calendar, content: card.due }] : []),
    ...(card.points !== undefined ? [{ id: "points", label: "Points", content: String(card.points) }] : []),
    ...meta,
  ];

  return (
    <PageHeader
      layout="inline"
      size="lg"
      className={cn("pt-5", className)}
      breadcrumbs={breadcrumbs ?? detailCrumbs(boardTitle, column?.title === pill.label ? undefined : column?.title, card.key)}
      title={titleSlot ?? card.title}
      titleText={card.title}
      status={{ label: pill.label, tone: pill.tone }}
      description={description}
      meta={allMeta}
      tabs={tabs}
      defaultTab={defaultTab}
      primaryAction={primary}
      actions={secondary}
      moreActions={more}
      scrollContainer={scrollContainer}
      trailing={trailing}
    >
      <TabsContent value="overview" className="flex flex-col gap-8 pt-6 pb-2">
        {overview ?? (
          <>
        {readout && <ProgressReadout {...readout} />}
        {(milestones.length > 0 || steps) && (
          <section>
            <Heading>{steps ? "Steps" : "Checklist"}</Heading>
            <MilestoneList items={milestones.slice(0, 6)} label={steps ? "Steps" : "Checklist"} />
          </section>
        )}
        <section>
          <Heading>Recent activity</Heading>
          <ActivityList items={activity} now={now} limit={3} />
        </section>
          </>
        )}
      </TabsContent>
      {extraTabs.map((t) => (
        <TabsContent key={t.value} value={t.value} className="pt-5">
          {t.content}
        </TabsContent>
      ))}
      {steps && (
        <TabsContent value="steps" className="pt-5">
          <MilestoneList items={steps} label="Steps" />
        </TabsContent>
      )}
      <TabsContent value="activity" className="pt-4">
        {activityContent ?? <ActivityList items={activity} now={now} />}
      </TabsContent>
      {files && (
        <TabsContent value="files" className="pt-4">
          <FileList items={files} />
        </TabsContent>
      )}
      {comments !== undefined && (
        <TabsContent value="comments" className="pt-4">
          {comments}
        </TabsContent>
      )}
    </PageHeader>
  );
}

/* ── Sheet ── */

/*
 * The sheet's motion, all CSS: it slides in 24px over a fading backdrop and goes back out the way it came, a little
 * faster (the native dialog stays painted through `overlay` and `display` with allow-discrete; browsers without it
 * just close at once). Reduced motion: opacity only.
 */
const SHEET_CSS = `
[data-kn-td-sheet]{translate:0 0;opacity:1;transition:translate var(--kn-dur-slow) var(--kn-ease-out),opacity var(--kn-dur-slow) var(--kn-ease-out),overlay var(--kn-dur-slow) allow-discrete,display var(--kn-dur-slow) allow-discrete}
[data-kn-td-sheet]:not([open]){translate:24px 0;opacity:0;transition-duration:var(--kn-dur);transition-timing-function:var(--kn-ease-out)}
@starting-style{[data-kn-td-sheet][open]{translate:24px 0;opacity:0}}
[data-kn-td-sheet]::backdrop{background:rgb(0 0 0/.35);backdrop-filter:blur(2px);opacity:1;transition:opacity var(--kn-dur) var(--kn-ease-out),overlay var(--kn-dur) allow-discrete,display var(--kn-dur) allow-discrete}
[data-kn-td-sheet]:not([open])::backdrop{opacity:0}
@starting-style{[data-kn-td-sheet][open]::backdrop{opacity:0}}
@media (prefers-reduced-motion:reduce){[data-kn-td-sheet],[data-kn-td-sheet]:not([open]){translate:0 0!important;transition-property:opacity,overlay,display}}
`;

/** Keeps the sheet's content for the exit. (Swap for the motion lib's useExiting once it is on main.) */
function useKeepWhileClosing(open: boolean, ms = 200) {
  const [kept, setKept] = useState(open);
  useEffect(() => {
    if (open) {
      setKept(true);
      return;
    }
    const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(() => setKept(false), reduce ? 0 : ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return open || kept;
}

/**
 * A wide right-side sheet on the native <dialog> (focus trap, Escape, backdrop click). Full screen below 640px.
 * `children` gets the scroll element, so a PageHeader inside can condense against it.
 */
export function DetailSheet({
  open,
  onOpenChange,
  label,
  children,
  width = 720,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  children: (ctx: { scroller: RefObject<HTMLDivElement | null>; close: ReactNode }) => ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const id = useId();
  const showBody = useKeepWhileClosing(open);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // Like the app's other modals: hide the page behind from assistive tech, not just from the pointer.
      pushLayer(d);
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && d.open) {
      d.close();
      popLayer(d);
    }
  }, [open]);
  useEffect(() => {
    const d = ref.current;
    return () => {
      if (d) popLayer(d);
    };
  }, []);

  const close = (
    <Button variant="ghost" icon={Icon.close} aria-label="Close" data-autofocus onClick={() => onOpenChange(false)} />
  );

  // Portaled to <body> like the app's other modals, so the modal layer can hide the page beside it from assistive tech.
  const sheet = (
    <dialog
      ref={ref}
      data-kn-td-sheet=""
      role="dialog"
      aria-label={label}
      aria-describedby={undefined}
      id={id}
      onCancel={(e) => {
        // A dialog opened inside the sheet passes its cancel up the React tree: only handle our own Escape.
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onOpenChange(false);
      }}
      onClick={(e) => e.target === e.currentTarget && onOpenChange(false)}
      style={{ maxWidth: width }}
      className={cn(
        "fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full bg-background p-0 text-foreground",
        "border-l [border-color:color-mix(in_srgb,var(--foreground)_10%,transparent)] shadow-[-24px_0_64px_-24px_rgb(0_0_0/0.4)]",
        "max-sm:max-w-none! max-sm:border-l-0",
      )}
    >
      <style href="kn-task-detail-sheet" precedence="default">
        {SHEET_CSS}
      </style>
      {showBody && (
        <div ref={scroller} className="h-full overflow-y-auto overscroll-contain px-5 pb-10 sm:px-8">
          {children({ scroller, close })}
        </div>
      )}
    </dialog>
  );
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}

export default TaskDetail;
