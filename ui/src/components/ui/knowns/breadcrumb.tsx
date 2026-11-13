"use client";
/** @registry name="breadcrumb" type="ui" title="Breadcrumb" description="Path of links that collapses middle items into an overflow menu." */

import type { ReactNode } from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { Menu } from "./menu";

export interface BreadcrumbItem {
  label: string;
  href?: string;
  /** 16px glyph before the label. */
  icon?: ReactNode;
  /** Called on click (with or without href), e.g. for client-side routing. */
  onClick?: () => void;
}

/* ── Pure helper (exported for tests) ── */

/**
 * Splits a trail into what stays visible and what folds into the overflow menu. Keeps the first
 * `keepStart` items and the last `keepEnd`; the middle collapses once the trail is longer than `max`.
 */
export function collapseItems<T>(items: T[], max: number, keepStart = 1, keepEnd = 2): { head: T[]; hidden: T[]; tail: T[] } {
  if (items.length <= Math.max(max, keepStart + keepEnd)) return { head: items, hidden: [], tail: [] };
  return { head: items.slice(0, keepStart), hidden: items.slice(keepStart, items.length - keepEnd), tail: items.slice(items.length - keepEnd) };
}

/* ── Component ── */

const SEPARATORS = {
  chevron: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-3.5">
      <path d="M6.5 4 10.5 8l-4 4" />
    </svg>
  ),
  slash: <span className="px-0.5 text-[13px]">/</span>,
};

export interface BreadcrumbProps {
  /** The trail, root first. The last item is the current page. */
  items: BreadcrumbItem[];
  /** Longest trail shown in full; longer ones fold their middle into a "…" menu. Default 4. */
  maxItems?: number;
  /** Items kept before / after the fold. Default 1 / 2. */
  keepStart?: number;
  keepEnd?: number;
  separator?: "chevron" | "slash";
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}

/** Where you are in a hierarchy. Long trails fold the middle into a menu; the last item is the current page. */
export function Breadcrumb({ items, maxItems = 4, keepStart = 1, keepEnd = 2, separator = "chevron", size = "md", className, "aria-label": label = "Breadcrumb" }: BreadcrumbProps) {
  const { head, hidden, tail } = collapseItems(items, maxItems, keepStart, keepEnd);
  const last = items[items.length - 1];
  const text = size === "sm" ? "text-[12.5px]" : "text-[13.5px]";
  const sep = (
    <span aria-hidden="true" className="flex flex-none items-center text-muted-foreground/60">
      {SEPARATORS[separator]}
    </span>
  );

  const crumb = (item: BreadcrumbItem) => {
    const current = item === last;
    const inner = (
      <>
        {item.icon && <span className="grid flex-none [&_svg]:size-3.5">{item.icon}</span>}
        <span className="truncate">{item.label}</span>
      </>
    );
    const base = cn("inline-flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-[6px] px-1 py-0.5", focusRing);
    if (current)
      return (
        <span aria-current="page" className={cn(base, "font-medium text-foreground")}>
          {inner}
        </span>
      );
    if (item.href)
      return (
        <a href={item.href} onClick={item.onClick} className={cn(base, "text-muted-foreground transition-colors duration-150 hover:text-foreground")}>
          {inner}
        </a>
      );
    return (
      <button type="button" onClick={item.onClick} className={cn(base, "cursor-pointer text-muted-foreground transition-colors duration-150 hover:text-foreground")}>
        {inner}
      </button>
    );
  };

  const row = (list: BreadcrumbItem[], keyFrom: number) =>
    list.map((item, i) => (
      <li key={`${keyFrom + i}-${item.label}`} className="flex min-w-0 items-center gap-1">
        {(keyFrom + i > 0) && sep}
        {crumb(item)}
      </li>
    ));

  return (
    <nav aria-label={label} className={className}>
      <ol className={cn("flex min-w-0 flex-wrap items-center gap-y-1", text)}>
        {row(head, 0)}
        {hidden.length > 0 && (
          <li className="flex items-center gap-1">
            {sep}
            <Menu
              aria-label={`${hidden.length} more`}
              items={hidden.map((h, i) => ({ id: String(i), label: h.label, icon: h.icon, href: h.href }))}
              onSelect={(m) => hidden[Number(m.id)]?.onClick?.()}
              trigger={
                <button
                  type="button"
                  aria-label={`Show ${hidden.length} more`}
                  className={cn(
                    "grid h-6 min-w-7 cursor-pointer place-items-center rounded-[6px] px-1 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
                    focusRing,
                  )}
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="size-3.5">
                    <circle cx="3.5" cy="8" r="1.2" />
                    <circle cx="8" cy="8" r="1.2" />
                    <circle cx="12.5" cy="8" r="1.2" />
                  </svg>
                </button>
              }
            />
          </li>
        )}
        {row(tail, head.length + (hidden.length ? 1 : 0))}
      </ol>
    </nav>
  );
}
