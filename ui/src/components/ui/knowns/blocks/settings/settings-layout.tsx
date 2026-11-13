"use client";
/** @registry name="settings-layout" type="block" title="Settings layout" description="Settings page layout with a responsive section nav, titled sections, label-control rows, a save bar with unsaved-change tracking and a danger zone." */
/**
 * Settings layout: a page title, a section nav (a sidebar from lg up, a scrolling tab row below), and the
 * content. Plus the pieces every settings page uses: SettingsSection (a titled panel with a footer),
 * SettingsRow (label left, control right), SaveBar (unsaved changes) and a Danger zone.
 */
import { Fragment, useEffect, useRef, type ElementType, type ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { Button } from "../../button";
import type { SettingsResult } from "./settings-utils";

export interface SettingsNavItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** A count or short tag after the label, e.g. "3" pending invites. */
  badge?: ReactNode;
  /** Items with the same group sit together under its heading (sidebar) or after a divider (tab row). */
  group?: string;
}

export interface SettingsLayoutProps {
  title?: ReactNode;
  description?: ReactNode;
  sections: SettingsNavItem[];
  active: string;
  /** Without `hrefFor` the nav renders buttons that call this. */
  onActiveChange?: (id: string) => void;
  /** Links instead of buttons, for routed settings (one URL per section). */
  hrefFor?: (id: string) => string;
  /** The link component for hrefFor, e.g. Next's Link for client-side navigation. Default "a". */
  linkAs?: ElementType;
  /** Shown in the header row, right of the title (e.g. the signed-in email or a Help link). */
  actions?: ReactNode;
  /** Show the section nav. Default true; false when an app sidebar already lists the sections. */
  nav?: boolean;
  children: ReactNode;
  className?: string;
}

const itemClass = (on: boolean) =>
  cn(
    "flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13.5px] whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none",
    on ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
  );

export function SettingsLayout({ title = "Settings", description, sections, active, onActiveChange, hrefFor, linkAs: LinkAs = "a", actions, nav = true, children, className }: SettingsLayoutProps) {
  const row = useRef<HTMLDivElement>(null);
  // Keep the active tab visible in the mobile row.
  useEffect(() => {
    // Scrolls the row only (scrollIntoView could also move the page vertically).
    const r = row.current;
    const el = r?.querySelector<HTMLElement>("[aria-current=page]");
    if (!r || !el || r.scrollWidth <= r.clientWidth) return;
    const left = el.offsetLeft; // the row is `relative`, so it is the offset parent
    if (left < r.scrollLeft || left + el.offsetWidth > r.scrollLeft + r.clientWidth) r.scrollLeft = Math.max(0, left - 16);
  }, [active]);

  const item = (s: SettingsNavItem) => {
    const on = s.id === active;
    const inner = (
      <>
        {s.icon && <span aria-hidden="true" className="grid size-4 place-items-center [&_svg]:size-4">{s.icon}</span>}
        <span>{s.label}</span>
        {s.badge !== undefined && s.badge !== null && <span className="ml-auto rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums lg:ml-auto">{s.badge}</span>}
      </>
    );
    return hrefFor ? (
      <LinkAs key={s.id} href={hrefFor(s.id)} aria-current={on ? "page" : undefined} className={itemClass(on)} onClick={() => onActiveChange?.(s.id)}>
        {inner}
      </LinkAs>
    ) : (
      <button key={s.id} type="button" aria-current={on ? "page" : undefined} className={itemClass(on)} onClick={() => onActiveChange?.(s.id)}>
        {inner}
      </button>
    );
  };

  return (
    <div className={cn("w-full", className)}>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3 lg:mb-7">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-[-0.015em]">{title}</h1>
          {description && <p className="mt-1 text-[13.5px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className={cn("grid gap-5", nav && "lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-10")}>
        {nav && (
        <nav aria-label="Settings sections" className="-mx-4 min-w-0 lg:mx-0">
          <div ref={row} className="relative flex gap-1 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:sticky lg:top-6 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0 [&::-webkit-scrollbar]:hidden">
            {groupSections(sections).map(({ group, items }, i) => (
              <Fragment key={group ?? `_${i}`}>
                {i > 0 && <span aria-hidden="true" className="mx-1 my-1.5 w-px shrink-0 self-stretch bg-border lg:mx-0 lg:my-2 lg:h-px lg:w-auto" />}
                {group && (
                  <span className="hidden px-2.5 pt-1 pb-1 text-[12px] font-medium text-muted-foreground lg:block">
                    {group}
                  </span>
                )}
                {items.map(item)}
              </Fragment>
            ))}
          </div>
        </nav>
        )}
        <div className="flex min-w-0 flex-col gap-5">{children}</div>
      </div>
    </div>
  );
}

/** Consecutive runs of the same `group`, in order (an ungrouped run has group undefined). */
export function groupSections(sections: SettingsNavItem[]): { group?: string; items: SettingsNavItem[] }[] {
  const out: { group?: string; items: SettingsNavItem[] }[] = [];
  for (const s of sections) {
    const last = out.at(-1);
    if (last && last.group === s.group) last.items.push(s);
    else out.push({ group: s.group, items: [s] });
  }
  return out;
}

export interface SettingsSectionProps {
  title: ReactNode;
  description?: ReactNode;
  /** Right of the title, e.g. an "Invite" button. */
  actions?: ReactNode;
  children?: ReactNode;
  /** A footer bar, usually a hint on the left and Save on the right. */
  footer?: ReactNode;
  /** "danger" tints the border, for delete and leave actions. */
  tone?: "default" | "danger";
  id?: string;
  className?: string;
}

export function SettingsSection({ title, description, actions, children, footer, tone = "default", id, className }: SettingsSectionProps) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section id={id} aria-labelledby={headingId} className={cn("rounded-xl border bg-card text-card-foreground", tone === "danger" && "border-red-500/35 dark:border-red-400/30", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 sm:px-5 sm:pt-5">
        <div className="min-w-0">
          <h2 id={headingId} className={cn("text-[15px] font-semibold", tone === "danger" && "text-red-700 dark:text-red-400")}>
            {title}
          </h2>
          {description && <p className="mt-1 max-w-[60ch] text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children !== undefined && children !== null && <div className="px-4 py-4 sm:px-5">{children}</div>}
      {footer && <div className="flex flex-wrap items-center justify-between gap-3 rounded-b-xl border-t bg-muted/40 px-4 py-3 text-[12.5px] text-muted-foreground sm:px-5">{footer}</div>}
    </section>
  );
}

/** One setting: label and help on the left, the control on the right; stacked on narrow screens. */
export function SettingsRow({ label, description, htmlFor, children, className }: { label: ReactNode; description?: ReactNode; htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6", className)}>
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[13.5px] font-medium">
            {label}
          </label>
        ) : (
          <div className="text-[13.5px] font-medium">{label}</div>
        )}
        {description && <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Warns before leaving the page (reload, close tab) while there are unsaved changes. */
export function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}

/** The footer of a form section: the last result (or a hint) on the left, Discard and Save on the right. */
export function SaveBar({ dirty, saving, result, hint = "Changes are saved when you press Save.", onSave, onDiscard, saveLabel = "Save" }: { dirty: boolean; saving?: boolean; result?: SettingsResult | null; hint?: ReactNode; onSave: () => void; onDiscard?: () => void; saveLabel?: string }) {
  useUnsavedWarning(dirty);
  return (
    <>
      <span role="status" aria-live="polite" className={cn("min-w-0", result && !result.ok && "text-red-600 dark:text-red-400", result?.ok && !dirty && "text-emerald-700 dark:text-emerald-400")}>
        {result && !result.ok ? result.error : dirty ? "You have unsaved changes." : result?.ok ? (result.message ?? "Saved.") : hint}
      </span>
      {/* Nothing to save: Save stays (outlined when disabled, not a grey slab) so the hint is true; Discard only appears with changes. */}
      <span className="flex min-h-8 items-center gap-2">
        {(dirty || saving) && onDiscard && (
          <Button size="sm" variant="ghost" disabled={saving} onClick={onDiscard}>
            Discard
          </Button>
        )}
        <Button size="sm" loading={saving} disabled={!dirty && !saving} onClick={onSave}>
          {saveLabel}
        </Button>
      </span>
    </>
  );
}

/** A danger-zone section with one action per row. */
export function DangerZone({ title = "Danger zone", description, children }: { title?: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <SettingsSection title={title} description={description} tone="danger">
      <div className="divide-y">{children}</div>
    </SettingsSection>
  );
}
