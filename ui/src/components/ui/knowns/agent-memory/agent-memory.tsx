"use client";
/** @registry name="agent-memory" type="ui" title="Agent memory" description="What an agent remembers: search, scope filter, inline edit, pin, forget with undo, forget everything from one source, and why a memory was used. Full and compact variants." */
/**
 * AgentMemory: what an agent remembers about the user or the project, and the controls to correct it.
 * Search, filter by scope, edit in place, pin, see which runs used a memory, and forget one or everything
 * from a source with an undo. Forgetting waits `forgetDelayMs` before calling onForget, so Undo needs no
 * restore logic in the app. `variant="compact"` fits a side panel.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { Badge, type BadgeTone } from "../badge";
import { Button } from "../button";
import { Input, Textarea } from "../input";
import { Menu, type MenuItem } from "../menu";
import { Popover } from "../popover";
import { SegmentedControl } from "../segmented-control";
import {
  SCOPES,
  SCOPE_HINT,
  SCOPE_LABEL,
  ago,
  cleanText,
  confidenceBars,
  confidenceLabel,
  filterMemories,
  forgotText,
  idsFromSource,
  scopeCounts,
  usedText,
  type MemoryItem as Memory,
  type MemoryScope,
  type ScopeFilter,
} from "./memory-utils";

export type { MemoryItem, MemoryScope, MemorySource, MemoryUse, ScopeFilter } from "./memory-utils";

export interface AgentMemoryProps {
  items: Memory[];
  title?: ReactNode;
  description?: ReactNode;
  /** Saves edited text (trimmed). Without it there is no Edit. */
  onEdit?: (id: string, text: string) => void;
  /** Forgets these ids, called once the undo window has passed. Without it there is no Forget. */
  onForget?: (ids: string[]) => void;
  onPin?: (id: string, pinned: boolean) => void;
  /** "default" (a full card) or "compact" (side panel: one menu per row, less metadata). */
  variant?: "default" | "compact";
  /** Controlled search and scope; otherwise kept inside. */
  query?: string;
  onQueryChange?: (query: string) => void;
  scope?: ScopeFilter;
  onScopeChange?: (scope: ScopeFilter) => void;
  /** How long Undo stays before onForget runs. Default 6000. */
  forgetDelayMs?: number;
  /** Fixes the clock for relative times (tests, screenshots). */
  now?: number;
  className?: string;
  /*
   * Knowns additions (not in the registry item; keep them when re-installing).
   * All optional: without them the block behaves exactly as shipped.
   */
  /** Rename scopes, e.g. { user: "Global", session: "Working" }. */
  scopeLabels?: Partial<Record<MemoryScope, string>>;
  /** Tooltips for the scope badges. */
  scopeHints?: Partial<Record<MemoryScope, string>>;
  /** Makes the memory text a button that opens the memory. */
  onOpen?: (id: string) => void;
  /** Replaces the text + source search, e.g. to also match ids, tags or content. */
  match?: (item: Memory, query: string) => boolean;
  /** Extra metadata after the scope badge (category, tags). */
  meta?: (item: Memory) => ReactNode;
  /** Shown when nothing is remembered at all. */
  emptyText?: ReactNode;
  /** In-app navigation for source and usage links (plain clicks only); otherwise they are normal links. */
  onNavigate?: (href: string) => void;
  /** Page use: the title stays only for screen readers (it still names the region), no description, and the count sits at the end of the toolbar. */
  hideHeading?: boolean;
}

const SCOPE_TONE: Record<MemoryScope, BadgeTone> = { user: "accent", project: "info", session: "neutral" };

type Pending = { ids: string[]; text: string };

export function AgentMemory({
  items,
  title = "Memory",
  description = "What the agent remembers. Correct it, pin what matters, forget the rest.",
  onEdit,
  onForget,
  onPin,
  variant = "default",
  query: queryProp,
  onQueryChange,
  scope: scopeProp,
  onScopeChange,
  forgetDelayMs = 6000,
  now,
  className,
  scopeLabels,
  scopeHints,
  onOpen,
  match,
  meta,
  emptyText = "Nothing remembered yet. The agent saves facts here as it works with you.",
  onNavigate,
  hideHeading = false,
}: AgentMemoryProps) {
  // React events bubble through portals, so this also catches links in the "Why was this used?" popover.
  const routeLinks = (e: MouseEvent<HTMLElement>) => {
    if (!onNavigate || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest?.("a[href]");
    const href = a?.getAttribute("href");
    if (!href || !href.startsWith("/")) return;
    e.preventDefault();
    onNavigate(href);
  };
  const compact = variant === "compact";
  const label = (s: MemoryScope) => scopeLabels?.[s] ?? SCOPE_LABEL[s];
  const hint = (s: MemoryScope) => scopeHints?.[s] ?? SCOPE_HINT[s];
  const headingId = useId();
  const [ownQuery, setOwnQuery] = useState("");
  const [ownScope, setOwnScope] = useState<ScopeFilter>("all");
  const query = queryProp ?? ownQuery;
  const scope = scopeProp ?? ownScope;
  const setQuery = (q: string) => (onQueryChange ? onQueryChange(q) : setOwnQuery(q));
  const setScope = (s: ScopeFilter) => (onScopeChange ? onScopeChange(s) : setOwnScope(s));
  const [editing, setEditing] = useState<string | null>(null);

  // Forget with undo: hidden now, committed after the delay (or when the next forget comes, or on unmount).
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forgetRef = useRef(onForget);
  forgetRef.current = onForget;
  const commit = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    if (p) forgetRef.current?.(p.ids);
  };
  useEffect(() => () => commit(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const forget = (ids: string[], text: string) => {
    if (ids.length === 0) return;
    if (pendingRef.current) commit();
    const p = { ids, text };
    pendingRef.current = p;
    setPending(p);
    timer.current = setTimeout(commit, forgetDelayMs);
  };
  const undo = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pendingRef.current = null;
    setPending(null);
  };

  const hidden = useMemo(() => new Set(pending?.ids ?? []), [pending]);
  const counts = useMemo(() => scopeCounts(items, hidden), [items, hidden]);
  const shown = useMemo(() => filterMemories(items, { query, scope, hidden, match }), [items, query, scope, hidden, match]);

  return (
    <section aria-labelledby={headingId} onClick={routeLinks} className={cn("relative flex w-full flex-col rounded-2xl border bg-card text-card-foreground", className)}>
      <header className={cn("flex flex-col gap-3 border-b", compact ? "px-3 py-3" : "px-4 py-3.5 sm:px-5")}>
        {hideHeading ? (
          <h3 id={headingId} className="sr-only">
            {title}
          </h3>
        ) : (
          <div className="flex items-baseline justify-between gap-3">
            <h3 id={headingId} className={cn("font-semibold tracking-tight", compact ? "text-[14px]" : "text-[15px]")}>
              {title}
            </h3>
            <span className="text-[12.5px] text-muted-foreground tabular-nums">
              {`${counts.all} ${counts.all === 1 ? "memory" : "memories"}`}
            </span>
          </div>
        )}
        {description && !compact && !hideHeading && <p className="-mt-2 text-[13px] text-muted-foreground">{description}</p>}
        <div className={cn("flex gap-2", compact ? "flex-col" : "flex-wrap items-center")}>
          <Input
            type="search"
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memories"
            aria-label="Search memories"
            icon={<SearchIcon />}
            className={compact ? undefined : "min-w-[180px] max-w-[260px] flex-1"}
          />
          <SegmentedControl
            aria-label="Scope"
            size="sm"
            value={scope}
            onValueChange={(v) => setScope(v as ScopeFilter)}
            options={[
              { value: "all", label: "All" },
              ...SCOPES.map((s) => ({ value: s, label: compact ? label(s) : `${label(s)} ${counts[s]}` })),
            ]}
          />
          {hideHeading && !compact && (
            <span className="ml-auto text-[12.5px] text-muted-foreground tabular-nums">
              {`${counts.all} ${counts.all === 1 ? "memory" : "memories"}`}
            </span>
          )}
        </div>
      </header>

      {shown.length === 0 ? (
        <p className={cn("text-center text-[13px] text-muted-foreground", compact ? "px-3 py-8" : "px-5 py-12")}>
          {counts.all === 0 ? emptyText : query ? `No memories match "${query}".` : `No ${scope === "all" ? "" : `${label(scope as MemoryScope).toLowerCase()} `}memories.`}
        </p>
      ) : (
        <ul className="divide-y" aria-label="Memories">
          {shown.map((m) => (
            <MemoryRow
              key={m.id}
              item={m}
              compact={compact}
              now={now}
              editing={editing === m.id}
              onStartEdit={onEdit ? () => setEditing(m.id) : undefined}
              onStopEdit={() => setEditing(null)}
              onSave={(text) => {
                onEdit?.(m.id, text);
                setEditing(null);
              }}
              onPin={onPin}
              onForget={onForget ? () => forget([m.id], forgotText(1)) : undefined}
              sourceCount={m.source ? idsFromSource(items, m.source.id, hidden).length : 0}
              onForgetSource={onForget && m.source ? () => forget(idsFromSource(items, m.source!.id, hidden), forgotText(idsFromSource(items, m.source!.id, hidden).length, m.source!.label)) : undefined}
              scopeLabel={label(m.scope)}
              scopeHint={hint(m.scope)}
              onOpen={onOpen}
              meta={meta}
            />
          ))}
        </ul>
      )}

      {/* Undo bar (a toast scoped to this card). */}
      <div aria-live="polite" role="status" className="pointer-events-none sticky bottom-3 z-10 flex justify-center px-3">
        {pending && (
          <div className="pointer-events-auto mb-3 flex items-center gap-3 rounded-xl border bg-popover py-1.5 pl-3.5 pr-1.5 text-[13px] text-popover-foreground shadow-lg">
            <span>{pending.text}</span>
            <Button size="sm" variant="secondary" onClick={undo}>
              Undo
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function MemoryRow({
  item: m,
  compact,
  now,
  editing,
  onStartEdit,
  onStopEdit,
  onSave,
  onPin,
  onForget,
  sourceCount,
  onForgetSource,
  scopeLabel,
  scopeHint,
  onOpen,
  meta,
}: {
  item: Memory;
  compact: boolean;
  now?: number;
  editing: boolean;
  onStartEdit?: () => void;
  onStopEdit: () => void;
  onSave: (text: string) => void;
  onPin?: (id: string, pinned: boolean) => void;
  onForget?: () => void;
  sourceCount: number;
  onForgetSource?: () => void;
  scopeLabel: string;
  scopeHint: string;
  onOpen?: (id: string) => void;
  meta?: (item: Memory) => ReactNode;
}) {
  const [draft, setDraft] = useState(m.text);
  const editId = useId();
  useEffect(() => {
    if (editing) setDraft(m.text);
  }, [editing, m.text]);
  const save = () => {
    const text = cleanText(draft);
    if (!text || text === m.text) return onStopEdit();
    onSave(text);
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onStopEdit();
    }
  };
  const short = m.text.length > 40 ? `${m.text.slice(0, 40)}…` : m.text;

  const menu: MenuItem[] = [
    ...(onPin ? [{ id: "pin", label: m.pinned ? "Unpin" : "Pin" }] : []),
    ...(onStartEdit ? [{ id: "edit", label: "Edit" }] : []),
    ...(onForget ? [{ id: "forget", label: "Forget", danger: true }] : []),
    ...(onForgetSource && m.source ? [{ id: "forget-source", label: `Forget all from ${m.source.label}`, description: `${sourceCount} ${sourceCount === 1 ? "memory" : "memories"}`, danger: true }] : []),
  ];
  const pick = (id: string) => {
    if (id === "pin") onPin?.(m.id, !m.pinned);
    else if (id === "edit") onStartEdit?.();
    else if (id === "forget") onForget?.();
    else if (id === "forget-source") onForgetSource?.();
  };

  return (
    <li data-memory-id={m.id} className={cn("group flex gap-3", compact ? "px-3 py-2.5" : "px-4 py-3.5 sm:px-5", m.pinned && "bg-muted/25")}>
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex flex-col gap-2">
            <label htmlFor={editId} className="sr-only">
              Edit memory
            </label>
            <Textarea id={editId} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={keys} autoGrow autoFocus rows={2} maxRows={8} />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={save} disabled={!cleanText(draft)}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={onStopEdit}>
                Cancel
              </Button>
              <span className="text-[12px] text-muted-foreground">Enter saves · Shift+Enter new line · Esc cancels</span>
            </div>
          </div>
        ) : (
          <p
            className={cn(
              "text-pretty whitespace-pre-line",
              compact ? "line-clamp-3 text-[13px]" : "text-[14px] leading-relaxed",
              // Knowns: a button is always inline-block, so with onOpen the pin sits in a flex row (hanging indent).
              onOpen && m.pinned && "flex items-start gap-1.5",
            )}
          >
            {m.pinned && (
              <span className={cn("inline-flex text-foreground", onOpen ? "flex-none translate-y-[4px]" : "mr-1.5 translate-y-[2px]")} title="Pinned">
                <PinIcon filled />
                <span className="sr-only">Pinned. </span>
              </span>
            )}
            {onOpen ? (
              <button
                type="button"
                data-memory-open={m.id}
                onClick={() => onOpen(m.id)}
                className={cn("inline rounded text-left underline-offset-2 hover:underline", focusRing)}
              >
                {m.text}
              </button>
            ) : (
              m.text
            )}
          </p>
        )}

        {!editing && (
          <div className={cn("mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground", compact && "mt-1")}>
            <Badge size="sm" tone={SCOPE_TONE[m.scope]} title={scopeHint}>
              {scopeLabel}
            </Badge>
            {meta?.(m)}
            {m.source && !compact && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <SourceIcon kind={m.source.kind} />
                {m.source.href ? (
                  <a href={m.source.href} className={cn("truncate underline-offset-2 hover:text-foreground hover:underline", focusRing, "rounded")}>
                    {m.source.label}
                  </a>
                ) : (
                  <span className="truncate">{m.source.label}</span>
                )}
              </span>
            )}
            <span suppressHydrationWarning>{compact ? ago(m.lastUsedAt ?? m.createdAt, now) : `Saved ${ago(m.createdAt, now)}`}</span>
            {!compact && <Confidence value={m.confidence} />}
            <WhyUsed item={m} now={now} compact={compact} />
          </div>
        )}
      </div>

      {!editing && menu.length > 0 && (
        <div className={cn("flex flex-none items-start gap-0.5", !compact && "pt-0.5")}>
          {!compact && onPin && (
            <Button size="sm" variant="ghost" icon={<PinIcon filled={m.pinned} />} aria-pressed={Boolean(m.pinned)} aria-label={`${m.pinned ? "Unpin" : "Pin"}: ${short}`} onClick={() => onPin(m.id, !m.pinned)} />
          )}
          {!compact && onStartEdit && <Button size="sm" variant="ghost" icon={<EditIcon />} aria-label={`Edit: ${short}`} onClick={onStartEdit} />}
          {!compact && onForget && <Button size="sm" variant="ghost" icon={<ForgetIcon />} aria-label={`Forget: ${short}`} onClick={onForget} />}
          {(compact || (onForgetSource && m.source)) && (
            <Menu
              aria-label={`More for: ${short}`}
              align="end"
              items={compact ? menu : menu.filter((i) => i.id === "forget-source")}
              onSelect={(i) => pick(i.id)}
              trigger={<Button size="sm" variant="ghost" icon={<MoreIcon />} aria-label={`More for: ${short}`} />}
            />
          )}
        </div>
      )}
    </li>
  );
}

function Confidence({ value }: { value?: number }) {
  const label = confidenceLabel(value);
  if (!label) return null;
  const bars = confidenceBars(value);
  return (
    <span className="inline-flex items-center gap-1" title={`${label} (${Math.round((value ?? 0) * 100)}%)`}>
      <span aria-hidden="true" className="inline-flex items-end gap-[2px]">
        {[1, 2, 3].map((b) => (
          <span key={b} className={cn("w-[3px] rounded-[1px]", b <= bars ? "bg-current" : "bg-current opacity-25")} style={{ height: 3 + b * 2 }} />
        ))}
      </span>
      <span className="sr-only sm:not-sr-only">{label.replace(" confidence", "")}</span>
      <span className="sr-only"> confidence</span>
    </span>
  );
}

/** "Used 4 times" opens the recent runs that used this memory. */
function WhyUsed({ item: m, now, compact }: { item: Memory; now?: number; compact: boolean }) {
  // Knowns: with no usage data at all (neither uses nor useCount), say nothing rather than "Not used yet".
  if (m.uses === undefined && m.useCount === undefined) return null;
  const text = usedText(m);
  const uses = m.uses ?? [];
  if (uses.length === 0) return <span>{text}</span>;
  return (
    <Popover
      aria-label="Why was this used?"
      align={compact ? "end" : "start"}
      trigger={
        <button type="button" className={cn("rounded underline decoration-dotted underline-offset-2 hover:text-foreground", focusRing)}>
          {text}
        </button>
      }
    >
      <div className="w-[min(300px,calc(100vw-32px))] p-1">
        <p className="px-2 pt-1.5 text-[13px] font-medium">Why was this used?</p>
        <p className="px-2 pb-2 text-[12px] text-muted-foreground">Recent runs that read this memory.</p>
        <ul className="flex flex-col">
          {uses.slice(0, 5).map((u) => (
            <li key={u.id}>
              {u.href ? (
                <a href={u.href} className={cn("flex items-baseline justify-between gap-3 rounded-lg px-2 py-1.5 text-[13px] hover:bg-muted", focusRing)}>
                  <span className="min-w-0 truncate">{u.label}</span>
                  <span className="flex-none text-[12px] text-muted-foreground" suppressHydrationWarning>
                    {ago(u.at, now)}
                  </span>
                </a>
              ) : (
                <div className="flex items-baseline justify-between gap-3 px-2 py-1.5 text-[13px]">
                  <span className="min-w-0 truncate">{u.label}</span>
                  <span className="flex-none text-[12px] text-muted-foreground" suppressHydrationWarning>
                    {ago(u.at, now)}
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
        {(m.useCount ?? uses.length) > Math.min(5, uses.length) && <p className="px-2 pb-1 pt-1.5 text-[12px] text-muted-foreground">and {(m.useCount ?? uses.length) - Math.min(5, uses.length)} more</p>}
      </div>
    </Popover>
  );
}

const svg = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
const SearchIcon = () => (
  <svg {...svg}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </svg>
);
const PinIcon = ({ filled }: { filled?: boolean }) => (
  <svg {...svg} width={14} height={14} fill={filled ? "currentColor" : "none"}>
    <path d="M9.8 2.2 13.8 6.2 11.6 7l-2.4 2.4.3 3-1 1L2.6 7.5l1-1 3 .3L9 4.4l.8-2.2ZM5.3 10.7 2.2 13.8" />
  </svg>
);
const EditIcon = () => (
  <svg {...svg}>
    <path d="m10.5 2.8 2.7 2.7L6 12.7l-3.4.7.7-3.4 7.2-7.2Z" />
  </svg>
);
const ForgetIcon = () => (
  <svg {...svg}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
  </svg>
);
const MoreIcon = () => (
  <svg {...svg} fill="currentColor" stroke="none">
    <circle cx="3.5" cy="8" r="1.3" />
    <circle cx="8" cy="8" r="1.3" />
    <circle cx="12.5" cy="8" r="1.3" />
  </svg>
);
const SourceIcon = ({ kind }: { kind?: "conversation" | "run" | "manual" }) =>
  kind === "run" ? (
    <svg {...svg} width={12} height={12}>
      <path d="M4 3.2v9.6L12.5 8 4 3.2Z" />
    </svg>
  ) : kind === "manual" ? (
    <svg {...svg} width={12} height={12}>
      <path d="m10.5 2.8 2.7 2.7L6 12.7l-3.4.7.7-3.4 7.2-7.2Z" />
    </svg>
  ) : (
    <svg {...svg} width={12} height={12}>
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2v-7Z" />
    </svg>
  );
