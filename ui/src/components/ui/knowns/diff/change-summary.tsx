"use client";
/** @registry name="change-summary" type="ui" title="Change summary" description="Every file an agent changed with status, +/− counts and an expandable diff per file." */

import { useId, useMemo, useState, type ReactNode } from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { Button } from "../button";
import { SegmentedControl } from "../segmented-control";
import { changeBlocks, countChanges, hunksOf, splitPatchFiles, type FileStatus, type Hunk } from "./diff-utils";
import { ChangeCounts, InlineDiff, type DiffView, type HunkDecision } from "./inline-diff";

export type { FileStatus } from "./diff-utils";

export interface ChangedFile {
  path: string;
  /** For renames. */
  oldPath?: string;
  status?: FileStatus;
  /** Contents before / after, or a one-file unified patch. Leave both out to list the file with `added` / `removed` only. */
  before?: string;
  after?: string;
  patch?: string;
  added?: number;
  removed?: number;
}

export interface ChangeSummaryProps {
  files?: ChangedFile[];
  /** Or a whole multi-file git patch ("diff --git a/… b/…" blocks). */
  patch?: string;
  title?: ReactNode;
  /** Paths open at first. */
  defaultExpanded?: string[];
  view?: DiffView;
  defaultView?: DiffView;
  onViewChange?: (view: DiffView) => void;
  /** Accept / reject per hunk, per file. Keeps its own decisions. */
  onHunk?: (path: string, index: number, decision: HunkDecision | null, hunk: Hunk) => void;
  /** Extra actions in the header (e.g. "Apply all"). */
  actions?: ReactNode;
  className?: string;
}

const STATUS: Record<FileStatus, { letter: string; label: string; tone: string }> = {
  added: { letter: "A", label: "Added", tone: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400" },
  modified: { letter: "M", label: "Modified", tone: "bg-amber-500/12 text-amber-700 dark:text-amber-400" },
  deleted: { letter: "D", label: "Deleted", tone: "bg-red-500/12 text-red-700 dark:text-red-400" },
  renamed: { letter: "R", label: "Renamed", tone: "bg-indigo-500/12 text-indigo-600 dark:text-indigo-400" },
};

function Blocks({ added, removed }: { added: number; removed: number }) {
  const [a, d, e] = changeBlocks(added, removed);
  return (
    <span aria-hidden="true" className="flex gap-[2px]">
      {[...Array(a).fill("bg-emerald-500"), ...Array(d).fill("bg-red-500"), ...Array(e).fill("bg-foreground/15")].map((c, i) => (
        <span key={i} className={cn("size-2 rounded-[2px]", c)} />
      ))}
    </span>
  );
}

/**
 * What a change touched: every file with its status, +/− counts and a five-block bar, totals on top. Open
 * a file to see its diff (unified or split, one switch for all) and accept or reject each hunk.
 */
export function ChangeSummary({ files: filesProp, patch, title = "Changes", defaultExpanded, view: viewProp, defaultView = "unified", onViewChange, onHunk, actions, className }: ChangeSummaryProps) {
  const files = useMemo(() => {
    const list: ChangedFile[] = filesProp ?? (patch ? splitPatchFiles(patch).map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status, patch: f.patch })) : []);
    return list.map((f) => {
      const hasDiff = f.patch !== undefined || f.before !== undefined || f.after !== undefined;
      const hunks = hasDiff ? hunksOf(f) : [];
      const c = hasDiff ? countChanges(hunks.flatMap((h) => h.lines)) : { added: f.added ?? 0, removed: f.removed ?? 0 };
      const status: FileStatus = f.status ?? (f.before === undefined && f.after !== undefined ? "added" : f.after === undefined && f.before !== undefined ? "deleted" : "modified");
      return { ...f, status, hasDiff, ...c };
    });
  }, [filesProp, patch]);
  const totals = files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 });
  const [open, setOpen] = useState(() => new Set(defaultExpanded ?? []));
  const [ownView, setOwnView] = useState(defaultView);
  const view = viewProp ?? ownView;
  const setView = (v: DiffView) => {
    if (viewProp === undefined) setOwnView(v);
    onViewChange?.(v);
  };
  const toggle = (p: string) =>
    setOpen((x) => {
      const n = new Set(x);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  const expandable = files.filter((f) => f.hasDiff);
  const allOpen = expandable.length > 0 && expandable.every((f) => open.has(f.path));
  const titleId = useId();

  return (
    <section aria-labelledby={titleId} className={cn("@container flex flex-col rounded-2xl border bg-card text-foreground", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <div id={titleId} className="font-semibold">
            {title}
          </div>
          <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            {files.length} {files.length === 1 ? "file" : "files"} changed
            <ChangeCounts {...totals} />
          </div>
        </div>
        {actions}
        {expandable.length > 0 && (
          <>
            <Button size="xs" variant="ghost" onClick={() => setOpen(allOpen ? new Set() : new Set(expandable.map((f) => f.path)))}>
              {allOpen ? "Collapse all" : "Expand all"}
            </Button>
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
          </>
        )}
      </div>
      <ul className="flex flex-col">
        {files.map((f) => {
          const isOpen = open.has(f.path) && f.hasDiff;
          const slash = f.path.lastIndexOf("/");
          const dir = slash >= 0 ? f.path.slice(0, slash + 1) : "";
          const name = f.path.slice(slash + 1);
          const st = STATUS[f.status];
          return (
            <li key={f.path} className="border-b last:border-b-0">
              <button
                type="button"
                disabled={!f.hasDiff}
                aria-expanded={f.hasDiff ? isOpen : undefined}
                onClick={() => toggle(f.path)}
                className={cn("flex w-full items-center gap-2.5 px-4 py-2 text-left enabled:hover:bg-muted/50", focusRing, "focus-visible:-outline-offset-2")}
              >
                <svg aria-hidden="true" viewBox="0 0 16 16" className={cn("size-3.5 flex-none text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", isOpen && "rotate-90", !f.hasDiff && "opacity-0")}>
                  <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span title={st.label} className={cn("grid size-[18px] flex-none place-items-center rounded-[5px] font-mono text-[11px] font-semibold", st.tone)}>
                  <span aria-hidden="true">{st.letter}</span>
                  <span className="sr-only">{st.label}</span>
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                  {f.oldPath && <span className="text-muted-foreground">{f.oldPath} → </span>}
                  <span className="text-muted-foreground">{dir}</span>
                  <span className={cn("font-medium", f.status === "deleted" && "line-through decoration-foreground/40")}>{name}</span>
                </span>
                <ChangeCounts added={f.added} removed={f.removed} className="flex-none" />
                <span className="hidden @sm:block">
                  <Blocks added={f.added} removed={f.removed} />
                </span>
              </button>
              {isOpen && (
                <div className="px-3 pb-3">
                  <InlineDiff
                    before={f.patch === undefined ? f.before : undefined}
                    after={f.patch === undefined ? f.after : undefined}
                    patch={f.patch}
                    header={false}
                    view={view}
                    onHunk={onHunk ? (i, d, h) => onHunk(f.path, i, d, h) : undefined}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
