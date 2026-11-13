"use client";
/** @registry name="docs-page-header" type="block" title="Docs page header" description="Docs page header: breadcrumb, title, lead, a Copy page split button with a menu of more actions, and previous / next arrows." */
/**
 * Docs page header: breadcrumb, title, one-line lead, and on the title row a "Copy page" split button
 * (the main half copies the page, the chevron opens a menu of more actions) plus previous / next arrows.
 */
import { useEffect, useRef, useState, type ElementType, type ReactNode } from "react";
import { cn, writeClipboard } from "@/ui/lib/knowns/utils";
import { Breadcrumb, type BreadcrumbItem } from "../../breadcrumb";
import { Menu, type MenuItem, type MenuSection } from "../../menu";
import { Tooltip } from "../../tooltip";

export interface DocsPageLink {
  href: string;
  title: string;
}

export interface CopyPageButtonProps {
  /** The text the main half copies (e.g. the page as Markdown or a prompt). May be async. */
  getText: () => string | Promise<string>;
  label?: ReactNode;
  copiedLabel?: ReactNode;
  /** More actions behind the chevron. Rows with `href` open the link; others go to onSelect. */
  items?: MenuItem[] | MenuSection[];
  onSelect?: (item: MenuItem) => void;
  /** Called after a successful copy, e.g. to show a toast. */
  onCopied?: () => void;
  className?: string;
}

const CopyGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" className="size-3.5">
    <rect x="5.25" y="5.25" width="8" height="8" rx="1.75" />
    <path d="M10.75 5.25v-1.5a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h1.5" />
  </svg>
);
const Check = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-3.5">
    <path d="m3.5 8.5 3 3 6-7" />
  </svg>
);
const Down = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="size-3.5">
    <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
  </svg>
);
const Arrow = ({ dir }: { dir: "left" | "right" }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-4">
    {dir === "left" ? <path d="M12.5 8h-9M7 4.5 3.5 8 7 11.5" /> : <path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" />}
  </svg>
);

const seg =
  "inline-flex h-8 items-center gap-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:relative focus-visible:z-10 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring";

/** Split button: copy the page, or open more actions. */
export function CopyPageButton({ getText, label = "Copy page", copiedLabel = "Copied", items, onSelect, onCopied, className }: CopyPageButtonProps) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await writeClipboard(await getText());
    } catch {
      return;
    }
    setDone(true);
    onCopied?.();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1600);
  };
  return (
    <div role="group" aria-label="Page actions" className={cn("inline-flex shrink-0 overflow-hidden rounded-lg border bg-card", className)}>
      <button type="button" onClick={() => void copy()} className={cn(seg, "px-2.5")}>
        {done ? <Check /> : <CopyGlyph />}
        <span aria-live="polite">{done ? copiedLabel : label}</span>
      </button>
      {items && items.length > 0 && (
        <Menu
          aria-label="More page actions"
          align="end"
          items={items}
          onSelect={(item) => onSelect?.(item)}
          trigger={
            <button type="button" aria-label="More page actions" className={cn(seg, "w-8 justify-center border-l text-muted-foreground hover:text-foreground")}>
              <Down />
            </button>
          }
        />
      )}
    </div>
  );
}

export interface DocsPageHeaderProps {
  title: ReactNode;
  /** One line under the title. */
  lead?: ReactNode;
  breadcrumb?: BreadcrumbItem[];
  /** Before the breadcrumb on its row, e.g. a SidebarReveal that brings a hidden sidebar back. */
  breadcrumbLeading?: ReactNode;
  /** Next to the title, e.g. a Pro badge. */
  badge?: ReactNode;
  /** The Copy page button, or any actions for the title row. */
  actions?: ReactNode;
  prev?: DocsPageLink | null;
  next?: DocsPageLink | null;
  /** Link component for prev / next (e.g. Next's Link). Default "a". */
  linkAs?: ElementType;
  className?: string;
}

function PagerArrow({ link, dir, linkAs: L = "a" }: { link?: DocsPageLink | null; dir: "left" | "right"; linkAs?: ElementType }) {
  const cls = "grid size-8 place-items-center rounded-lg border bg-card text-muted-foreground transition-colors focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring";
  const what = dir === "left" ? "Previous" : "Next";
  if (!link)
    return (
      <span aria-hidden="true" className={cn(cls, "opacity-40")}>
        <Arrow dir={dir} />
      </span>
    );
  return (
    <Tooltip content={`${what}: ${link.title}`}>
      <L href={link.href} aria-label={`${what}: ${link.title}`} rel={dir === "left" ? "prev" : "next"} className={cn(cls, "hover:bg-muted hover:text-foreground")}>
        <Arrow dir={dir} />
      </L>
    </Tooltip>
  );
}

export function DocsPageHeader({ title, lead, breadcrumb, breadcrumbLeading, badge, actions, prev, next, linkAs, className }: DocsPageHeaderProps) {
  const pager = prev !== undefined || next !== undefined;
  return (
    <header className={cn("min-w-0", className)}>
      {breadcrumbLeading ? (
        <div className="mb-3 flex min-h-7 items-center gap-1.5">
          {breadcrumbLeading}
          {breadcrumb && breadcrumb.length > 0 && <Breadcrumb items={breadcrumb} size="sm" className="min-w-0" />}
        </div>
      ) : (
        breadcrumb && breadcrumb.length > 0 && <Breadcrumb items={breadcrumb} size="sm" className="mb-3" />
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <h1 className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[32px] leading-tight font-semibold tracking-[-0.03em] text-balance">
          {title}
          {badge}
        </h1>
        {(actions || pager) && (
          <div className="flex items-center gap-2 pt-1">
            {actions}
            {pager && (
              // A group, not a nav: the page's pager at the bottom is the landmark (one per label).
              <div role="group" aria-label="Previous and next page" className="flex items-center gap-1">
                <PagerArrow link={prev} dir="left" linkAs={linkAs} />
                <PagerArrow link={next} dir="right" linkAs={linkAs} />
              </div>
            )}
          </div>
        )}
      </div>
      {lead && <p className="mt-2 max-w-[72ch] text-[15px] leading-relaxed text-pretty text-muted-foreground">{lead}</p>}
    </header>
  );
}
