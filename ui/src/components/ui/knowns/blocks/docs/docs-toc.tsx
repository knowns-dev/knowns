"use client";
/** @registry name="docs-toc" type="block" title="Docs table of contents" description="Right rail with a nested, scroll-aware On this page list, optional links (e.g. Contribute) and cards, and a floating pill below xl." */
/**
 * Docs right rail: "On this page" with nested items and scroll-spy, optional links (e.g. Contribute)
 * and cards under it. Below the rail breakpoint the same list opens from a small floating pill.
 * Also exports useDocHeadings (reads h2/h3 from the article) and DocsAsideCard (a small rail card).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { activeHeading, tocTree, type TocItem, type TocNode } from "./docs-utils";

/** A heading's text without its extras: parts marked data-toc="false" (e.g. a tier badge) are left out. */
function headingText(h: Element) {
  if (!h.querySelector("[data-toc='false']")) return (h.textContent ?? "").trim();
  const c = h.cloneNode(true) as Element;
  c.querySelectorAll("[data-toc='false']").forEach((n) => n.remove());
  return (c.textContent ?? "").trim();
}

/** h2 and h3 headings with ids inside `root` (a selector or element), updated when the content changes. */
export function useDocHeadings(root: string | (() => Element | null) = "article", deps: unknown[] = []): TocItem[] {
  const [items, setItems] = useState<TocItem[]>([]);
  useEffect(() => {
    const el = typeof root === "string" ? document.querySelector(root) : root();
    if (!el) return;
    const read = () => {
      const next = [...el.querySelectorAll("h2[id], h3[id]")]
        // Dialog titles and headings marked data-toc="false" are not page sections.
        .filter((h) => !h.closest("dialog, [role=dialog], [data-toc='false']") && (h as HTMLElement).offsetParent !== null)
        .map((h) => ({ id: h.id, text: headingText(h), depth: h.tagName === "H3" ? 3 : 2 }))
        .filter((h) => h.text);
      setItems((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    read();
    let raf = 0;
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(read);
    });
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return items;
}

/** The id of the heading the reader is at. */
function useActive(ids: string[], offset: number) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!ids.length) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const tops = ids.map((id) => ({ id, top: document.getElementById(id)?.getBoundingClientRect().top ?? Infinity })).filter((t) => t.top !== Infinity);
      // At the bottom of the page the last heading wins even if it never reaches the top.
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      setActive(atEnd ? (tops[tops.length - 1]?.id ?? null) : activeHeading(tops, offset));
    };
    const on = () => (raf ||= requestAnimationFrame(update));
    update();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
      cancelAnimationFrame(raf);
    };
  }, [ids.join("|"), offset]); // eslint-disable-line react-hooks/exhaustive-deps
  return [active, setActive] as const;
}

export interface DocsTocLink {
  label: string;
  href: string;
  icon?: ReactNode;
}

export interface DocsTocProps {
  /** Headings, e.g. from useDocHeadings(). h3s nest under the h2 before them. */
  items: TocItem[];
  title?: ReactNode;
  /** A titled list of links under the contents, e.g. Contribute. */
  links?: { title: ReactNode; items: DocsTocLink[] } | null;
  /** Cards at the bottom of the rail (e.g. an upgrade card or "Need help?"). */
  children?: ReactNode;
  /** Distance from the top that counts as "reading", px. Default 96 (under a sticky header). */
  offset?: number;
  /** Hide the floating pill on small screens. */
  noPill?: boolean;
  /** Where the rail starts; below it the pill shows. Default "xl" (1280px). */
  from?: "xl" | "2xl";
  /** Which bottom corner the small-screen pill sits in. Default "right". */
  pillSide?: "left" | "right";
  /** Sticky top of the rail, as a class. Default "top-22". */
  stickyClassName?: string;
  className?: string;
}

function List({ nodes, active, onPick, nested }: { nodes: TocNode[]; active: string | null; onPick: (id: string) => void; nested?: boolean }) {
  return (
    <ul className={cn("flex flex-col", !nested && "border-l [border-color:color-mix(in_srgb,var(--foreground)_10%,transparent)]")}>
      {nodes.map((n) => (
        <li key={n.id}>
          <a
            href={`#${n.id}`}
            aria-current={active === n.id ? "location" : undefined}
            onClick={(e) => {
              e.preventDefault();
              onPick(n.id);
            }}
            className={cn(
              "-ml-px block border-l-2 border-transparent py-1 text-[13px] leading-snug text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring",
              "aria-[current=location]:border-foreground aria-[current=location]:font-medium aria-[current=location]:text-foreground",
              nested ? "pl-6" : "pl-3",
            )}
          >
            {n.text}
          </a>
          {n.children.length > 0 && <List nodes={n.children} active={active} onPick={onPick} nested />}
        </li>
      ))}
    </ul>
  );
}

export function DocsToc({ items, title = "On this page", links, children, offset = 96, noPill, from = "xl", pillSide = "right", stickyClassName = "top-22", className }: DocsTocProps) {
  const tree = tocTree(items);
  const [active, setActive] = useActive(
    items.map((i) => i.id),
    offset,
  );
  const [open, setOpen] = useState(false);
  const pill = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        setOpen(false);
        button.current?.focus();
      } else if (!pill.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, [open]);

  const pick = (id: string, after?: () => void) => {
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    history.replaceState(null, "", `#${id}`);
    setActive(id);
    after?.();
  };

  const showList = items.length >= 2;
  const current = items.find((i) => i.id === active)?.text;

  return (
    <>
      <aside className={cn("sticky hidden h-fit max-h-[calc(100dvh-7rem)] flex-col gap-6 overflow-y-auto pb-6", from === "2xl" ? "2xl:flex" : "xl:flex", stickyClassName, className)}>
        {showList && (
          <nav aria-label={typeof title === "string" ? title : "On this page"}>
            <p className="mb-2 text-[12px] font-medium text-foreground">{title}</p>
            <List nodes={tree} active={active} onPick={(id) => pick(id)} />
          </nav>
        )}
        {links && links.items.length > 0 && (
          <div>
            <p className="mb-2 text-[12px] font-medium text-foreground">{links.title}</p>
            <ul className="grid gap-1">
              {links.items.map((l) => (
                <li key={l.href}>
                  <a
                    href={l.href}
                    target={/^https?:/.test(l.href) ? "_blank" : undefined}
                    rel={/^https?:/.test(l.href) ? "noopener noreferrer" : undefined}
                    className="flex items-center gap-2 py-0.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-3.5"
                  >
                    {l.icon}
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        {children}
      </aside>

      {showList && !noPill && (
        <div ref={pill} data-toc-pill="" className={cn("fixed bottom-5 z-40", pillSide === "left" ? "left-5" : "right-5", from === "2xl" ? "2xl:hidden" : "xl:hidden")}>
          {open && (
            <nav aria-label={typeof title === "string" ? title : "On this page"} className={cn("absolute bottom-full mb-2", pillSide === "left" ? "left-0" : "right-0", " max-h-[60dvh] w-64 overflow-y-auto rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg")}>
              <p className="mb-2 text-[12px] font-medium text-foreground">{title}</p>
              <List nodes={tree} active={active} onPick={(id) => pick(id, () => setOpen(false))} />
            </nav>
          )}
          <button
            ref={button}
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="flex max-w-[60vw] items-center gap-2 rounded-full border bg-background/90 px-3.5 py-2 text-[13px] shadow-md backdrop-blur outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" className="size-3.5 shrink-0">
              <path d="M3 4h10M3 8h7M3 12h5" />
            </svg>
            <span className="truncate">{current ?? (typeof title === "string" ? title : "On this page")}</span>
          </button>
        </div>
      )}
    </>
  );
}

/** A small card for the rail: a title, a line, and an action. */
export function DocsAsideCard({ eyebrow, title, children, action, className }: { eyebrow?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border bg-card p-4", className)}>
      {eyebrow && <p className="mb-1.5 text-[11.5px] font-medium tracking-wide text-muted-foreground uppercase">{eyebrow}</p>}
      <h2 data-toc="false" className="text-[14px] font-semibold tracking-tight">
        {title}
      </h2>
      {children && <div className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </section>
  );
}
