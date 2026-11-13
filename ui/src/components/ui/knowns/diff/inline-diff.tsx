"use client";
/** @registry name="inline-diff" type="ui" title="Inline diff" description="Unified or split diff with word-level changes, folded context and accept or reject per hunk." */

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { Button } from "../button";
import { SegmentedControl } from "../segmented-control";
import { countChanges, diffLines, parsePatch, splitRows, toHunks, type DiffLine, type Hunk } from "./diff-utils";

export type { DiffLine, Hunk } from "./diff-utils";
export type HunkDecision = "accepted" | "rejected";
export type DiffView = "unified" | "split";

export interface InlineDiffProps {
  /** The file before and after (line diff computed here; unchanged runs between hunks can be expanded). */
  before?: string;
  after?: string;
  /** Or a unified diff of one file ("@@ -a,b +c,d @@" hunks). */
  patch?: string;
  /** Or the hunks themselves. */
  hunks?: Hunk[];
  /** File path in the header. */
  path?: ReactNode;
  view?: DiffView;
  defaultView?: DiffView;
  onViewChange?: (view: DiffView) => void;
  /** Unchanged lines kept around each change. Default 3. */
  context?: number;
  /** Accept / Reject on every hunk. Decisions are kept here unless you pass `decisions`. */
  onHunk?: (index: number, decision: HunkDecision | null, hunk: Hunk) => void;
  decisions?: Record<number, HunkDecision | undefined>;
  /** Wrap long lines instead of scrolling sideways. Default: wrap in split view. */
  wrap?: boolean;
  /** Header with path, +/− counts and the view switch. Default true. */
  header?: boolean;
  /** Extra controls on the right of the header. */
  actions?: ReactNode;
  className?: string;
}

const ROW: Record<DiffLine["type"], string> = {
  context: "",
  add: "bg-emerald-500/[0.09] dark:bg-emerald-400/[0.10]",
  del: "bg-red-500/[0.08] dark:bg-red-400/[0.10]",
};
const MARK: Record<DiffLine["type"], string> = {
  context: "",
  add: "rounded-[3px] bg-emerald-500/25 dark:bg-emerald-400/25",
  del: "rounded-[3px] bg-red-500/25 dark:bg-red-400/25",
};
const SIGN: Record<DiffLine["type"], string> = { context: " ", add: "+", del: "−" };
const SR: Record<DiffLine["type"], string> = { context: "", add: "Added: ", del: "Removed: " };

/** A line's text with its changed words highlighted (no syntax colours). */
function LineText({ line }: { line: DiffLine }) {
  if (!line.marks?.length) return <>{line.text || " "}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  line.marks.forEach(([s, e], i) => {
    if (s > at) parts.push(line.text.slice(at, s));
    const Tag = line.type === "add" ? "ins" : "del";
    parts.push(
      <Tag key={i} className={cn("no-underline", MARK[line.type])}>
        {line.text.slice(s, e)}
      </Tag>,
    );
    at = e;
  });
  if (at < line.text.length) parts.push(line.text.slice(at));
  return <>{parts}</>;
}

const num = "select-none px-2 text-right tabular-nums text-muted-foreground";

/** +12 −3 */
export function ChangeCounts({ added, removed, className }: { added: number; removed: number; className?: string }) {
  return (
    <span className={cn("inline-flex gap-1.5 font-mono text-[12px] tabular-nums", className)} aria-label={`${added} added, ${removed} removed`}>
      <span className="text-emerald-700 dark:text-emerald-400">+{added}</span>
      <span className="text-red-700 dark:text-red-400">−{removed}</span>
    </span>
  );
}

type Segment = { kind: "hunk"; hunk: Hunk; index: number } | { kind: "gap"; count: number; lines?: DiffLine[]; id: number };

/**
 * One file's changes, unified or side by side, without syntax colours: changed words stand out inside
 * changed lines, +/− counts in the header, unchanged runs fold away (expand them when the full text is
 * known), and every hunk can be accepted or rejected.
 */
export function InlineDiff({
  before,
  after,
  patch,
  hunks: hunksProp,
  path,
  view: viewProp,
  defaultView = "unified",
  onViewChange,
  context = 3,
  onHunk,
  decisions: decisionsProp,
  wrap,
  header = true,
  actions,
  className,
}: InlineDiffProps) {
  const [ownView, setOwnView] = useState(defaultView);
  const view = viewProp ?? ownView;
  const setView = (v: DiffView) => {
    if (viewProp === undefined) setOwnView(v);
    onViewChange?.(v);
  };
  const [ownDecisions, setOwnDecisions] = useState<Record<number, HunkDecision | undefined>>({});
  const decisions = decisionsProp ?? ownDecisions;
  const decide = (i: number, d: HunkDecision | null, h: Hunk) => {
    if (!decisionsProp) setOwnDecisions((x) => ({ ...x, [i]: d ?? undefined }));
    onHunk?.(i, d, h);
  };
  const [opened, setOpened] = useState<Set<number>>(new Set());

  // Hunks, and the unchanged runs between them (with their lines when the whole file is known).
  const { segments, counts } = useMemo(() => {
    const full = before !== undefined || after !== undefined ? diffLines(before ?? "", after ?? "") : null;
    const hunks = hunksProp ?? (patch !== undefined ? parsePatch(patch) : toHunks(full ?? [], context));
    const segs: Segment[] = [];
    let oldAt = 1;
    hunks.forEach((h, i) => {
      const gap = h.oldStart - oldAt;
      if (gap > 0) segs.push({ kind: "gap", count: gap, id: i, lines: full?.filter((l) => l.type === "context" && l.oldNo! >= oldAt && l.oldNo! < h.oldStart) });
      segs.push({ kind: "hunk", hunk: h, index: i });
      oldAt = h.oldStart + h.oldLines;
    });
    if (full) {
      const rest = full.filter((l) => l.type === "context" && l.oldNo! >= oldAt);
      if (rest.length && hunks.length) segs.push({ kind: "gap", count: rest.length, id: hunks.length, lines: rest });
    }
    return { segments: segs, counts: countChanges(hunks.flatMap((h) => h.lines)) };
  }, [before, after, patch, hunksProp, context]);

  const wraps = wrap ?? view === "split";
  const text = cn("pr-3", wraps ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre");
  const hunkCount = segments.filter((s) => s.kind === "hunk").length;

  const unifiedRow = (l: DiffLine, key: string, dim?: boolean) => (
    <div key={key} className={cn("grid grid-cols-[3.25rem_3.25rem_1.25rem_1fr]", ROW[l.type], dim && "opacity-45")}>
      <span className={num}>{l.oldNo ?? ""}</span>
      <span className={num}>{l.newNo ?? ""}</span>
      <span aria-hidden="true" className={cn("select-none text-center", l.type === "add" ? "text-emerald-700 dark:text-emerald-400" : l.type === "del" ? "text-red-700 dark:text-red-400" : "")}>
        {SIGN[l.type]}
      </span>
      <span className={text}>
        {SR[l.type] && <span className="sr-only">{SR[l.type]}</span>}
        <LineText line={l} />
      </span>
    </div>
  );
  const splitRow = (r: { left?: DiffLine; right?: DiffLine }, key: string, dim?: boolean) => (
    <div key={key} className={cn("grid grid-cols-[3rem_1fr_3rem_1fr]", dim && "opacity-45")}>
      {[r.left, r.right].map((l, side) => (
        <Fragment key={side}>
          <span className={cn(num, l ? ROW[l.type] : "bg-muted/40", side === 1 && "border-l")}>{side === 0 ? (l?.oldNo ?? "") : (l?.newNo ?? "")}</span>
          <span className={cn(text, l ? ROW[l.type] : "bg-muted/40")}>
            {l && SR[l.type] && <span className="sr-only">{SR[l.type]}</span>}
            {l ? <LineText line={l} /> : ""}
          </span>
        </Fragment>
      ))}
    </div>
  );
  const rows = (lines: DiffLine[], key: string, dim?: boolean) =>
    view === "split" ? splitRows(lines).map((r, i) => splitRow(r, `${key}-${i}`, dim)) : lines.map((l, i) => unifiedRow(l, `${key}-${i}`, dim));

  return (
    <div className={cn("overflow-hidden rounded-xl border bg-card text-foreground", className)}>
      {header && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/30 px-3 py-2">
          {path && <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{path}</span>}
          <ChangeCounts {...counts} className={cn(!path && "flex-1")} />
          {actions}
          <SegmentedControl
            size="sm"
            aria-label="Diff view"
            value={view}
            onValueChange={(v) => setView(v as DiffView)}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Split" },
            ]}
          />
        </div>
      )}
      {hunkCount === 0 ? (
        <div className="px-3 py-6 text-center text-[13px] text-muted-foreground">No changes.</div>
      ) : (
        <div className={cn("font-mono text-[12.5px] leading-5", !wraps && "overflow-x-auto")}>
          <div className={cn(!wraps && "min-w-max")}>
            {segments.map((s) => {
              if (s.kind === "gap") {
                const open = opened.has(s.id) && s.lines;
                if (open) return <Fragment key={`gap-${s.id}`}>{rows(s.lines!, `gap-${s.id}`)}</Fragment>;
                return (
                  <div key={`gap-${s.id}`} className="flex items-center gap-2 bg-muted/40 px-3 py-1 font-sans text-[12px] text-muted-foreground">
                    {s.lines ? (
                      <button
                        type="button"
                        onClick={() => setOpened((x) => new Set(x).add(s.id))}
                        className="rounded px-1 hover:bg-muted hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        Show {s.count} unchanged {s.count === 1 ? "line" : "lines"}
                      </button>
                    ) : (
                      <span className="px-1">
                        {s.count} unchanged {s.count === 1 ? "line" : "lines"}
                      </span>
                    )}
                  </div>
                );
              }
              const h = s.hunk;
              const d = decisions[s.index];
              return (
                <section key={`h-${s.index}`} aria-label={`Change ${s.index + 1} of ${hunkCount}, lines ${h.newStart}–${h.newStart + Math.max(0, h.newLines - 1)}${d ? `, ${d}` : ""}`}>
                  <div className="sticky left-0 flex items-center gap-2 border-y bg-indigo-500/[0.05] px-3 py-1 font-sans text-[12px] text-muted-foreground first:border-t-0 dark:bg-indigo-400/[0.06]">
                    <span className="truncate font-mono">
                      @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@{h.header ? ` ${h.header}` : ""}
                    </span>
                    {onHunk && (
                      <span className="ml-auto flex flex-none items-center gap-1.5">
                        {d ? (
                          <>
                            <span className={cn("font-medium", d === "accepted" ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")} role="status">
                              {d === "accepted" ? "Accepted" : "Rejected"}
                            </span>
                            <Button size="xs" variant="ghost" onClick={() => decide(s.index, null, h)}>
                              Undo
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button size="xs" variant="ghost" onClick={() => decide(s.index, "rejected", h)} aria-label={`Reject change ${s.index + 1}`}>
                              Reject
                            </Button>
                            <Button size="xs" variant="secondary" onClick={() => decide(s.index, "accepted", h)} aria-label={`Accept change ${s.index + 1}`}>
                              Accept
                            </Button>
                          </>
                        )}
                      </span>
                    )}
                  </div>
                  {rows(h.lines, `h-${s.index}`, d === "rejected")}
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
