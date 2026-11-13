"use client";
/** @registry name="sidebar" type="block" title="Sidebar" description="An app sidebar: a nav tree with full keyboard, an icon rail or a fully hidden mode that remembers its state with Cmd or Ctrl+B, flyouts for branches, search, a workspace switcher, and a modal sheet on mobile." */

/**
 * Sidebar: an app sidebar that collapses to an icon rail and becomes an off-canvas sheet on small
 * screens. Compose it from parts (SidebarHeader, SidebarContent, SidebarGroup, SidebarItem,
 * SidebarFooter) or feed SidebarNav a tree. State lives in SidebarProvider: the rail is remembered
 * under `storageKey`, Cmd/Ctrl+B toggles it, SidebarTrigger toggles it (or opens the sheet on mobile).
 * `collapsible="offcanvas"` hides the sidebar fully instead of showing the rail (a docs tree, where icons
 * alone say nothing). sidebarBootScript() applies a remembered collapse before the first paint.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { Avatar } from "../../avatar";
import { Kbd } from "../../kbd";
import { Menu, type MenuItem } from "../../menu";
import { Popover } from "../../popover";
import { Sheet } from "../../sheet";
import { Tooltip } from "../../tooltip";
import { BOOT_ATTR, ancestorsOf, initialOpen, pathTo, isToggleKey, loadJSON, saveJSON, treeKey, visibleRows, workspaceInitials, type SidebarNode } from "./sidebar-utils";

export { sidebarBootScript } from "./sidebar-utils";

export type { SidebarNode } from "./sidebar-utils";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const isMac = () => typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

/* ── State ── */

interface SidebarState {
  /** The desktop sidebar is the icon rail. */
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  /** The mobile sheet is open. */
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
  /** Below `mobileBelow`: the sidebar is a sheet. */
  isMobile: boolean;
  /** Collapse or expand on desktop, open or close the sheet on mobile. */
  toggle: () => void;
  mobileBelow: number;
  sheetId: string;
  storageKey?: string;
}

const Ctx = createContext<SidebarState | null>(null);
/** Where a part renders: in the rail (icons only) or in the sheet (always expanded). */
/** closeInline: the sheet has no header row, so its close button sits in the first SidebarHeader's row. */
const SurfaceCtx = createContext<{ rail: boolean; sheet: boolean; closeInline?: boolean }>({ rail: false, sheet: false });

export function useSidebar(): SidebarState {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSidebar must be used inside <SidebarProvider>");
  return s;
}

export interface SidebarProviderProps {
  children: ReactNode;
  /** Start as the icon rail (when nothing is remembered). */
  defaultCollapsed?: boolean;
  /** Controlled rail state. */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Remember the rail state in localStorage under this key. */
  storageKey?: string;
  /**
   * Cmd/Ctrl+B toggles the sidebar. Default true. A provider inside another sidebar's layout (a demo on a page
   * that has its own sidebar) only takes the shortcut while focus is inside it, so one press toggles one sidebar.
   */
  hotkey?: boolean;
  /** Below this width (px) the sidebar is an off-canvas sheet. Default 768. */
  mobileBelow?: number;
  className?: string;
}

/**
 * Holds the sidebar state and lays out its children in a row: put a Sidebar and a SidebarInset inside.
 */
export function SidebarProvider({ children, defaultCollapsed = false, collapsed: collapsedProp, onCollapsedChange, storageKey, hotkey = true, mobileBelow = 768, className }: SidebarProviderProps) {
  const [own, setOwn] = useState(defaultCollapsed);
  // Read the remembered rail state before paint on the client. sidebarBootScript() covered the server-rendered
  // paint until now; the state carries it from here, so drop its mark.
  useIsoLayoutEffect(() => {
    if (collapsedProp === undefined && storageKey) setOwn(loadJSON(`${storageKey}:collapsed`, defaultCollapsed));
    if (storageKey) unboot(storageKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  const collapsed = collapsedProp ?? own;
  const changeRef = useRef(onCollapsedChange);
  changeRef.current = onCollapsedChange;
  const setCollapsed = useCallback(
    (v: boolean) => {
      if (collapsedProp === undefined) setOwn(v);
      saveJSON(storageKey && `${storageKey}:collapsed`, v);
      changeRef.current?.(v);
    },
    [collapsedProp, storageKey],
  );

  const [isMobile, setIsMobile] = useState(false);
  useIsoLayoutEffect(() => {
    const mq = window.matchMedia(`(max-width: ${mobileBelow - 0.02}px)`);
    const on = () => setIsMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [mobileBelow]);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    if (!isMobile) setMobileOpen(false);
  }, [isMobile]);

  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const toggle = useCallback(() => {
    if (isMobile) setMobileOpen((o) => !o);
    else setCollapsed(!collapsedRef.current);
  }, [isMobile, setCollapsed]);

  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hotkey) return;
    const mac = isMac();
    const nested = !!wrapperRef.current?.parentElement?.closest("[data-kn-sidebar-wrapper]");
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isToggleKey(e, mac, e.target)) return;
      if (nested && !wrapperRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      toggle();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hotkey, toggle]);

  const sheetId = useId();
  const value = useMemo(
    () => ({ collapsed, setCollapsed, mobileOpen, setMobileOpen, isMobile, toggle, mobileBelow, sheetId, storageKey }),
    [collapsed, setCollapsed, mobileOpen, isMobile, toggle, mobileBelow, sheetId, storageKey],
  );
  return (
    <Ctx.Provider value={value}>
      <style href={`kn-sidebar-${mobileBelow}`} precedence="default">{`${MOTION}@media (max-width:${mobileBelow - 0.02}px){[data-kn-sidebar-aside][data-below="${mobileBelow}"]{display:none}}`}</style>
      {storageKey && <style href={`kn-sidebar-boot-${storageKey}-${mobileBelow}`} precedence="default">{bootCss(storageKey, mobileBelow)}</style>}
      <div ref={wrapperRef} data-kn-sidebar-wrapper className={cn("flex w-full", className)}>
        {children}
      </div>
    </Ctx.Provider>
  );
}

/* ── First paint ── */

const cssString = (v: string) => JSON.stringify(v);

/** While sidebarBootScript's mark is on <html>, the aside paints collapsed (without animating) and SidebarReveal shows. */
const bootCss = (key: string, mobileBelow: number) => {
  const on = `[${BOOT_ATTR}~=${cssString(key)}]`;
  const k = `[data-key=${cssString(key)}]`;
  return `${on} [data-kn-sidebar-aside]${k}{width:var(--kn-sb-collapsed)!important;transition:none!important}@media (min-width:${mobileBelow}px){${on} [data-kn-sidebar-reveal]${k}{display:inline-flex}}`;
};

function unboot(key: string) {
  const h = document.documentElement;
  const rest = (h.getAttribute(BOOT_ATTR) ?? "").split(" ").filter((k) => k && k !== key);
  if (rest.length) h.setAttribute(BOOT_ATTR, rest.join(" "));
  else h.removeAttribute(BOOT_ATTR);
}

/*
 * Motion, all CSS:
 * - the aside animates its width between 256px and the 56px rail (or 0 when off-canvas); labels fade while it does;
 * (the mobile sheet's slide is the Sheet component's.) Reduced motion: no width animation.
 */
const MOTION = `
[data-kn-sidebar-reveal]:not([data-shown]){display:none}
[data-kn-sidebar-aside]{transition:width 220ms var(--kn-ease-out)}
[data-kn-sidebar-fade]{transition:opacity 160ms ease-out}
@media (prefers-reduced-motion:reduce){
  [data-kn-sidebar-aside]{transition:none}
}
`;

/* ── Frame ── */

export interface SidebarProps {
  children: ReactNode;
  /** Accessible name of the sidebar landmark and the sheet. Default "Sidebar". */
  label?: string;
  /**
   * How the desktop sidebar collapses: true (default) to the 56px icon rail, "offcanvas" fully off (width 0,
   * inert), false never. The mobile sheet is the same in every mode.
   */
  collapsible?: boolean | "offcanvas";
  /** Expanded width in px. Default 256 (the rail is 56). */
  width?: number;
  /** Stick to the viewport and fill its height. Default true; false fills the parent (e.g. in a frame). */
  sticky?: boolean;
  /** Sticky offset in px, e.g. 64 under a 64px header (the height shrinks to match). Default 0. */
  top?: number;
  /**
   * The desktop sidebar is a complementary landmark (an <aside>) named by `label`. False renders a plain <div>,
   * for a sidebar inside another page's content (a demo), where a nested landmark would be wrong.
   */
  landmark?: boolean;
  /** Classes on the desktop aside (padding, border). */
  className?: string;
  /** Classes on the mobile sheet panel. */
  sheetClassName?: string;
  /**
   * The top row of the mobile sheet, beside its close button (e.g. the logo). Without it the close button
   * sits in the first SidebarHeader row, so start the sidebar with one.
   */
  sheetHeader?: ReactNode;
}

/** The sidebar itself: a 256px aside on desktop (56px as the rail, or hidden off-canvas), a modal sheet on mobile. */
export function Sidebar({ children, label = "Sidebar", collapsible = true, width = 256, sticky = true, top = 0, landmark = true, className, sheetClassName, sheetHeader }: SidebarProps) {
  const s = useSidebar();
  const offcanvas = collapsible === "offcanvas";
  const rail = collapsible === true && s.collapsed;
  const off = offcanvas && s.collapsed;
  const Aside = landmark ? "aside" : "div";
  const style = { width: rail ? 56 : off ? 0 : width, "--kn-sb-collapsed": offcanvas ? "0px" : "56px", ...(sticky ? { top, height: `calc(100dvh - ${top}px)` } : null) } as CSSProperties;
  return (
    <>
      {!s.isMobile && (
        <Aside
          data-kn-sidebar-aside
          data-below={s.mobileBelow}
          data-key={s.storageKey}
          data-rail={rail || undefined}
          data-offcanvas={offcanvas || undefined}
          data-collapsed={off || undefined}
          aria-label={landmark ? label : undefined}
          // Hidden off-canvas: out of the tab order and the accessibility tree, not only out of sight.
          inert={off || undefined}
          style={style}
          className={cn("group/sb flex shrink-0 flex-col overflow-hidden", !offcanvas && "border-r bg-background text-foreground", sticky ? "sticky" : "h-full", !offcanvas && className)}
        >
          <SurfaceCtx.Provider value={{ rail, sheet: false }}>
            {offcanvas ? (
              // A fixed-width panel inside the animating aside: its content never reflows, it slides out of view.
              <div style={{ width }} className={cn("flex min-h-0 flex-1 shrink-0 flex-col border-r bg-background text-foreground", className)}>
                {children}
              </div>
            ) : (
              children
            )}
          </SurfaceCtx.Provider>
        </Aside>
      )}
      {s.isMobile && (
        <SidebarSheet label={label} header={sheetHeader} className={sheetClassName}>
          {children}
        </SidebarSheet>
      )}
    </>
  );
}

function SidebarSheet({ children, label, header, className }: { children: ReactNode; label: string; header?: ReactNode; className?: string }) {
  const { mobileOpen, setMobileOpen, sheetId } = useSidebar();
  // Land on the current page's row rather than the close button: people open the nav to move from there.
  // Its list scrolled while the sheet was closed (no layout then), so bring it into view now.
  const focusCurrent = (d: HTMLDialogElement) => {
    const row = d.querySelector<HTMLElement>('[aria-current="page"]');
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "center" });
  };
  const close = (
    <button
      type="button"
      onClick={() => setMobileOpen(false)}
      aria-label="Close"
      className="grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className="size-4">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  );
  return (
    <Sheet
      bare
      side="left"
      open={mobileOpen}
      onOpenChange={setMobileOpen}
      label={label}
      closeOnLink
      onOpen={focusCurrent}
      id={sheetId}
      className={cn(
        // Sheet pins it to both edges: the visible height, so a mobile URL bar never pushes the bottom off-screen.
        "group/sb w-[min(18rem,calc(100vw-3rem))] bg-background text-foreground shadow-xl",
        className,
      )}
    >
      {header ? (
        <div className="flex h-14 shrink-0 items-center gap-2 pr-2 pl-4">
          <div className="flex min-w-0 flex-1 items-center gap-2 font-semibold tracking-tight">{header}</div>
          {close}
        </div>
      ) : (
        // No header row: the close button sits top-right, in line with the first SidebarHeader row.
        <div className="absolute top-2 right-2 z-10">{close}</div>
      )}
      <SurfaceCtx.Provider value={{ rail: false, sheet: true, closeInline: !header }}>{children}</SurfaceCtx.Provider>
    </Sheet>
  );
}

/** Top of the sidebar: a logo, a SidebarSwitcher, a SidebarSearch. */
export function SidebarHeader({ children, className }: { children: ReactNode; className?: string }) {
  const { closeInline } = useContext(SurfaceCtx);
  // In a sheet without a header row, the first row (a switcher, a logo) leaves room for the close button.
  return <div className={cn("flex shrink-0 flex-col gap-2 p-2", closeInline && "[&>:first-child]:max-w-[calc(100%-3rem)]", className)}>{children}</div>;
}

/** The scrolling middle. */
export function SidebarContent({ children, className }: { children: ReactNode; className?: string }) {
  const { rail } = useContext(SurfaceCtx);
  // The rail has no room for a scrollbar gutter (kn-scroll-auto keeps one for the expanded sidebar).
  return (
    <div className={cn("kn-scroll-auto flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden overscroll-contain p-2", className)} style={rail ? { scrollbarGutter: "auto" } : undefined}>
      {children}
    </div>
  );
}

/** Bottom of the sidebar: the account, an upgrade card. */
export function SidebarFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex shrink-0 flex-col gap-2 border-t p-2", className)}>{children}</div>;
}

/** The main column beside the sidebar. */
export function SidebarInset({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex min-w-0 flex-1 flex-col", className)}>{children}</div>;
}

/**
 * Panel-left: a rounded frame with a tinted left panel and its divider, so it reads at 16px. `opens` adds a
 * chevron pointing out of the panel (panel-left-open), for the button that brings a hidden sidebar back.
 */
const PanelGlyph = ({ opens }: { opens?: boolean }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-4 shrink-0">
    <path d="M4 2.75h2.25v10.5H4A2.25 2.25 0 0 1 1.75 11V5A2.25 2.25 0 0 1 4 2.75z" fill="currentColor" fillOpacity="0.28" stroke="none" />
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" />
    <path d="M6.25 2.75v10.5" />
    {opens && <path d="M9.5 6.25 11.25 8 9.5 9.75" />}
  </svg>
);

/**
 * Brings a collapsed sidebar back, from beside the content it would sit next to (e.g. left of a page's
 * breadcrumb). Renders nothing outside a SidebarProvider and stays hidden unless the desktop sidebar is collapsed,
 * so shared page chrome can always include it.
 */
export function SidebarReveal({ label = "Show sidebar", className }: { label?: string; className?: string }) {
  const s = useContext(Ctx);
  if (!s) return null;
  const mac = typeof navigator !== "undefined" && isMac();
  const shown = !s.isMobile && s.collapsed;
  return (
    <span data-kn-sidebar-reveal data-key={s.storageKey} data-shown={shown || undefined} className="inline-flex shrink-0">
      <Tooltip content={label} description={mac ? "⌘B" : "Ctrl+B"} side="bottom" disabled={!shown}>
        <button
          type="button"
          onClick={() => s.setCollapsed(false)}
          aria-label={label}
          aria-expanded={false}
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:size-11",
            className,
          )}
        >
          <PanelGlyph />
        </button>
      </Tooltip>
    </span>
  );
}

/**
 * Toggles the rail on desktop and opens the sheet on mobile. Put it in the sidebar header or the page header.
 * `label` names it on mobile (and on desktop without `labels`); `labels` names the desktop action by state,
 * e.g. { collapse: "Hide sidebar", expand: "Show sidebar" }. `className` goes on its wrapper (margins, hiding).
 * `look="field"` matches a search field (36px, its fill and radius); `look="float"` is a 36px floating button (card,
 * hairline border, soft shadow) for a trigger fixed over the page. Collapsed, the icon turns to panel-left-open.
 */
export function SidebarTrigger({ className, label = "Toggle sidebar", labels, look = "ghost" }: { className?: string; label?: string; labels?: { collapse: string; expand: string }; look?: "ghost" | "field" | "float" }) {
  const s = useSidebar();
  const mac = typeof navigator !== "undefined" && isMac();
  const name = labels && !s.isMobile ? (s.collapsed ? labels.expand : labels.collapse) : label;
  return (
    // className sits on the outer wrapper (spacing, responsive hiding), so a hidden trigger leaves no empty flex item.
    <Tooltip content={name} description={mac ? "⌘B" : "Ctrl+B"} side="bottom" disabled={s.isMobile} className={cn("shrink-0", className)}>
      {/* The extra span keeps the hint: Tooltip mutes itself over an aria-expanded="true" child (a popup
          trigger), and an open sidebar's trigger is expanded. */}
      <span className="inline-flex">
        <button
          type="button"
          onClick={s.toggle}
          aria-label={name}
          aria-expanded={s.isMobile ? s.mobileOpen : !s.collapsed}
          aria-controls={s.isMobile ? s.sheetId : undefined}
          className={cn(
            "grid shrink-0 place-items-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:size-11",
            look === "field"
              ? "size-9 rounded-[10px] bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] text-foreground/70 hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)] hover:text-foreground"
              : look === "float"
                ? "size-9 rounded-[10px] border bg-card text-foreground/70 shadow-[0_1px_2px_rgb(0_0_0/0.06),0_4px_12px_-4px_rgb(0_0_0/0.12)] hover:bg-muted hover:text-foreground"
                : "size-8 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <PanelGlyph opens={!s.isMobile && s.collapsed} />
        </button>
      </span>
    </Tooltip>
  );
}

/* ── Rows ── */

/** Text that fades out in the rail (the row keeps its icon). */
function Fade({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span data-kn-sidebar-fade className={cn("min-w-0 group-data-[rail]/sb:pointer-events-none group-data-[rail]/sb:opacity-0", className)}>
      {children}
    </span>
  );
}

function Count({ n }: { n: number }) {
  return <span className="rounded-md bg-muted px-1.5 text-[10.5px] font-medium tabular-nums leading-[18px] text-muted-foreground">{n}</span>;
}

function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn("size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200 ease-(--kn-ease-out) motion-reduce:transition-none", open && "rotate-90", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

/** A labelled section of rows. In the rail the label gives way to a thin rule. */
export function SidebarGroup({
  label,
  action,
  count,
  collapsible,
  defaultOpen = true,
  children,
  className,
}: {
  label?: ReactNode;
  /** A small control on the right of the label, e.g. an add button. */
  action?: ReactNode;
  count?: number;
  /** The label folds the group. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const { rail } = useContext(SurfaceCtx);
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const shown = rail || !collapsible || open;
  return (
    <div role="group" aria-labelledby={label ? `${id}-l` : undefined} className={cn("group/grp flex flex-col gap-px", className)}>
      {label && (
        <div className="relative flex h-7 items-center gap-1 px-2">
          <span aria-hidden="true" className="absolute inset-x-1.5 top-1/2 h-px bg-border opacity-0 transition-opacity ease-(--kn-ease-out) group-first/grp:hidden group-data-[rail]/sb:opacity-100" />
          {collapsible ? (
            <button
              type="button"
              id={`${id}-l`}
              aria-expanded={open}
              aria-controls={id}
              onClick={() => setOpen((o) => !o)}
              className="flex min-w-0 flex-1 items-center gap-1 rounded-md text-left text-[11.5px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              tabIndex={rail ? -1 : undefined}
            >
              <Fade className="truncate">{label}</Fade>
              <Fade>
                <Chevron open={open} className="size-3" />
              </Fade>
            </button>
          ) : (
            <Fade className="flex-1 truncate text-[11.5px] font-medium text-muted-foreground">
              <span id={`${id}-l`}>{label}</span>
            </Fade>
          )}
          {count != null && (
            <Fade>
              <Count n={count} />
            </Fade>
          )}
          {action && <Fade className="flex">{action}</Fade>}
        </div>
      )}
      <Collapse id={id} open={shown}>
        <div className="flex flex-col gap-px">{children}</div>
      </Collapse>
    </div>
  );
}

function Collapse({ id, open, children }: { id?: string; open: boolean; children: ReactNode }) {
  return (
    <div
      id={id}
      className={cn("grid transition-[grid-template-rows,opacity] duration-200 ease-(--kn-ease-out) motion-reduce:transition-none", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

type LinkComponent = ComponentType<{ href: string; className?: string; children?: ReactNode; "aria-current"?: "page"; tabIndex?: number; onClick?: () => void; "data-kn-sidebar-row"?: string; onKeyDown?: (e: ReactKeyboardEvent) => void; onFocus?: () => void }>;

const ROW = cn(
  "relative flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-3 text-left text-[13px] text-muted-foreground outline-none",
  "hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
  "aria-[current=page]:bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] aria-[current=page]:font-medium aria-[current=page]:text-foreground",
  "aria-disabled:pointer-events-none aria-disabled:opacity-50",
  "pointer-coarse:h-10 forced-colors:aria-[current=page]:outline forced-colors:aria-[current=page]:outline-1",
);

export interface SidebarItemProps {
  label: string;
  icon?: ReactNode;
  href?: string;
  /** The current page (aria-current). */
  active?: boolean;
  badge?: ReactNode;
  count?: number;
  mark?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  /** Link component for href rows, e.g. Next's Link. Default "a". */
  linkAs?: LinkComponent | "a";
  className?: string;
}

/** One row: an icon, a label, then a badge, count or mark. In the rail only the icon shows, with the label as a tooltip. */
export function SidebarItem(props: SidebarItemProps) {
  return <ItemRow {...props} />;
}

function ItemRow({
  label,
  icon,
  href,
  active,
  badge,
  count,
  mark,
  disabled,
  onClick,
  linkAs: LinkAs = "a",
  className,
  rowProps,
}: SidebarItemProps & { rowProps?: { tabIndex?: number; onKeyDown?: (e: ReactKeyboardEvent) => void; onFocus?: () => void; "data-kn-sidebar-row"?: string } }) {
  const { rail } = useContext(SurfaceCtx);
  const inner = (
    <>
      {icon ? <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-4">{icon}</span> : <span aria-hidden="true" className="size-4 shrink-0" />}
      <Fade className="flex-1 truncate">{label}</Fade>
      {badge && <Fade className="shrink-0">{badge}</Fade>}
      {count != null && (
        <Fade className="shrink-0">
          <Count n={count} />
        </Fade>
      )}
      {mark && <Fade className="flex shrink-0">{mark}</Fade>}
    </>
  );
  const row =
    href && !disabled ? (
      <LinkAs href={href} aria-current={active ? "page" : undefined} onClick={onClick} className={cn(ROW, className)} {...rowProps}>
        {inner}
      </LinkAs>
    ) : (
      <button type="button" onClick={onClick} aria-current={active ? "page" : undefined} aria-disabled={disabled || undefined} aria-label={rail ? label : undefined} className={cn(ROW, className)} {...rowProps}>
        {inner}
      </button>
    );
  return (
    <Tooltip content={label} side="right" disabled={!rail} className="flex w-full">
      {row}
    </Tooltip>
  );
}

/* ── Data-driven nav ── */

export interface SidebarNavProps {
  items: SidebarNode[];
  /** The id of the current row: it gets aria-current and its branches open. */
  active?: string;
  /** Called for every row picked (links still navigate). */
  onSelect?: (node: SidebarNode) => void;
  /** Link component, e.g. Next's Link. Default "a". */
  linkAs?: LinkComponent | "a";
  /** Remember which branches are open under this localStorage key. */
  storageKey?: string;
  /** Accessible name. Default "Main". */
  label?: string;
  className?: string;
}

/**
 * A tree of rows. Branches fold (and are remembered); the active row's branches open on their own.
 * Keyboard: one tab stop; arrows move, Right opens or steps in, Left closes or steps out, Home and End
 * jump. In the rail a branch opens a flyout with its children.
 */
export function SidebarNav({ items, active, onSelect, linkAs, storageKey, label = "Main", className }: SidebarNavProps) {
  const { rail } = useContext(SurfaceCtx);
  const [open, setOpen] = useState<Set<string>>(() => initialOpen(items, null, active));
  useIsoLayoutEffect(() => {
    if (storageKey) setOpen(initialOpen(items, loadJSON<string[] | null>(storageKey, null), active));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  // A new active row opens its branches.
  const auto = ancestorsOf(items, active).join("|");
  useEffect(() => {
    if (!auto) return;
    setOpen((o) => (auto.split("|").every((k) => o.has(k)) ? o : new Set([...o, ...auto.split("|")])));
  }, [auto]);
  const write = (next: Set<string>) => {
    setOpen(next);
    saveJSON(storageKey, [...next]);
  };
  const toggle = (id: string) => {
    const n = new Set(open);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    write(n);
  };

  const rows = useMemo(() => visibleRows(items, rail ? new Set() : open), [items, open, rail]);
  const [focus, setFocus] = useState<string | null>(null);
  // The tab stop: the last focused row, else the active row or its nearest visible branch, else the first row.
  const onPath = [...pathTo(items, active)].reverse().find((id) => rows.some((r) => r.id === id));
  const tabStop = rows.some((r) => r.id === focus) ? focus : (onPath ?? rows.find((r) => !r.disabled)?.id);
  const root = useRef<HTMLElement>(null);
  const moveTo = (id: string) => {
    setFocus(id);
    root.current?.querySelector<HTMLElement>(`[data-kn-sidebar-row="${CSS.escape(id)}"]`)?.focus();
  };
  const onKey = (id: string) => (e: ReactKeyboardEvent) => {
    const m = treeKey(rows, rail ? new Set() : open, id, e.key);
    if (!m) return;
    e.preventDefault();
    if ("focus" in m) moveTo(m.focus);
    else if ("open" in m) write(new Set([...open, m.open]));
    else if ("close" in m) {
      const n = new Set(open);
      n.delete(m.close);
      write(n);
    }
  };
  const rowProps = (id: string) => ({ tabIndex: id === tabStop ? 0 : -1, onKeyDown: onKey(id), onFocus: () => setFocus(id), "data-kn-sidebar-row": id });

  const render = (nodes: SidebarNode[], depth: number): ReactNode =>
    nodes.map((n) => {
      const branch = Boolean(n.children?.length);
      const isOn = n.id === active;
      if (!branch)
        return (
          <li key={n.id}>
            <ItemRow
              label={n.label}
              icon={depth === 0 ? n.icon : undefined}
              href={n.href}
              active={isOn}
              badge={n.badge}
              count={n.count}
              mark={n.mark}
              disabled={n.disabled}
              linkAs={linkAs}
              onClick={() => onSelect?.(n)}
              className={depth > 0 ? "h-[30px] px-2 pointer-coarse:h-10" : undefined}
              rowProps={rowProps(n.id)}
            />
          </li>
        );
      const isOpen = open.has(n.id);
      const id = `kn-sb-${n.id.replace(/\W+/g, "-")}`;
      if (rail)
        return (
          <li key={n.id}>
            <Flyout node={n} active={active} linkAs={linkAs} onSelect={onSelect} rowProps={rowProps(n.id)} />
          </li>
        );
      return (
        <li key={n.id}>
          <button
            type="button"
            aria-expanded={isOpen}
            aria-controls={id}
            onClick={() => toggle(n.id)}
            className={cn(ROW, ancestorsOf(items, active).includes(n.id) && "text-foreground")}
            {...rowProps(n.id)}
          >
            {n.icon ? <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-4">{n.icon}</span> : <span aria-hidden="true" className="size-4 shrink-0" />}
            <Fade className="flex-1 truncate">{n.label}</Fade>
            {n.badge && <Fade className="shrink-0">{n.badge}</Fade>}
            {n.count != null && (
              <Fade className="shrink-0">
                <Count n={n.count} />
              </Fade>
            )}
            <Fade className="flex">
              <Chevron open={isOpen} />
            </Fade>
          </button>
          <Collapse id={id} open={isOpen}>
            <ul className="my-0.5 ml-[19px] flex flex-col gap-px border-l pl-2 [border-color:color-mix(in_srgb,var(--foreground)_10%,transparent)]">{render(n.children!, depth + 1)}</ul>
          </Collapse>
        </li>
      );
    });

  return (
    <nav ref={root} aria-label={label} className={cn("flex flex-col", className)}>
      <ul className="flex flex-col gap-px">{render(items, 0)}</ul>
    </nav>
  );
}

/** In the rail, a branch is an icon that opens a small panel of its children. */
function Flyout({
  node,
  active,
  linkAs: LinkAs = "a",
  onSelect,
  rowProps,
}: {
  node: SidebarNode;
  active?: string;
  linkAs?: LinkComponent | "a";
  onSelect?: (n: SidebarNode) => void;
  rowProps: { tabIndex?: number; onKeyDown?: (e: ReactKeyboardEvent) => void; onFocus?: () => void; "data-kn-sidebar-row"?: string };
}) {
  const [open, setOpen] = useState(false);
  // How it opened: a hover peek (closes when the pointer leaves, focus stays put) or a click / Enter (stays open,
  // focus moves in). A click on the trigger while peeking pins it instead of closing it.
  const [via, setVia] = useState<"hover" | "press">("press");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pressing = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const peek = (e: { pointerType: string }) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(timer.current);
    if (open) return;
    timer.current = setTimeout(() => {
      setVia("hover");
      setOpen(true);
    }, 120);
  };
  const leave = () => {
    clearTimeout(timer.current);
    if (via === "hover") timer.current = setTimeout(() => setOpen(false), 180);
  };
  const stay = () => clearTimeout(timer.current);
  const inside = active === node.id || ancestorsOf([node], active).includes(node.id);
  const leaves = (ns: SidebarNode[]): SidebarNode[] => ns.flatMap((n) => (n.children?.length ? leaves(n.children) : [n]));
  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        clearTimeout(timer.current);
        if (!v && open && via === "hover" && pressing.current) return setVia("press");
        if (v) setVia("press");
        setOpen(v);
      }}
      focusOnOpen={via === "press"}
      side="right"
      align="start"
      aria-label={node.label}
      className="w-56 p-1"
      trigger={
        <button
          type="button"
          aria-label={node.label}
          onPointerEnter={peek}
          onPointerLeave={leave}
          onPointerDown={() => {
            pressing.current = true;
            setTimeout(() => (pressing.current = false), 0);
          }}
          className={cn(ROW, inside && "bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] text-foreground")}
          {...rowProps}
        >
          {node.icon ? <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-4">{node.icon}</span> : <span aria-hidden="true" className="size-4 shrink-0" />}
        </button>
      }
    >
      <div onPointerEnter={stay} onPointerLeave={leave}>
      <p className="px-2 pt-1 pb-1.5 text-[11.5px] font-medium text-muted-foreground">{node.label}</p>
      <ul className="flex flex-col gap-px">
        {leaves(node.children ?? []).map((c) => (
          <li key={c.id}>
            {c.href && !c.disabled ? (
              <LinkAs
                href={c.href}
                aria-current={c.id === active ? "page" : undefined}
                onClick={() => {
                  onSelect?.(c);
                  setOpen(false);
                }}
                className={cn(ROW, "h-8 px-2")}
              >
                <span className="flex-1 truncate">{c.label}</span>
                {c.mark}
              </LinkAs>
            ) : (
              <button
                type="button"
                aria-disabled={c.disabled || undefined}
                onClick={() => {
                  onSelect?.(c);
                  setOpen(false);
                }}
                className={cn(ROW, "h-8 px-2")}
              >
                <span className="flex-1 truncate">{c.label}</span>
                {c.mark}
              </button>
            )}
          </li>
        ))}
      </ul>
      </div>
    </Popover>
  );
}

/* ── Header pieces ── */

const SearchGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className="size-4 shrink-0">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L13.5 13.5" />
  </svg>
);

/** A search-looking button that opens your CommandMenu. Shows ⌘K (or Ctrl K). */
export function SidebarSearch({ onOpen, label = "Search", shortcut = "K", className }: { onOpen: () => void; label?: string; shortcut?: string | false; className?: string }) {
  const { rail } = useContext(SurfaceCtx);
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(isMac()), []);
  return (
    <Tooltip content={label} side="right" disabled={!rail} className="flex w-full">
      <button
        type="button"
        onClick={onOpen}
        aria-label={rail ? label : undefined}
        className={cn(
          "flex h-8 w-full items-center gap-2.5 rounded-[10px] bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] px-3 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10",
          className,
        )}
      >
        <SearchGlyph />
        <Fade className="flex-1 truncate text-left">{label}</Fade>
        {shortcut && (
          <Fade className="flex shrink-0 gap-0.5">
            <Kbd size="sm">{mac ? "⌘" : "Ctrl"}</Kbd>
            <Kbd size="sm">{shortcut}</Kbd>
          </Fade>
        )}
      </button>
    </Tooltip>
  );
}

export interface SidebarWorkspace {
  id: string;
  name: string;
  /** Second line, e.g. the plan. */
  description?: string;
  /** Logo or avatar URL. */
  src?: string;
  icon?: ReactNode;
}

/** A workspace or team switcher: the current one, and a menu to pick another or create one. */
export function SidebarSwitcher({
  workspaces,
  value,
  onChange,
  onCreate,
  createLabel = "Create workspace",
  label = "Switch workspace",
  className,
}: {
  workspaces: SidebarWorkspace[];
  value: string;
  onChange?: (id: string) => void;
  onCreate?: () => void;
  createLabel?: string;
  label?: string;
  className?: string;
}) {
  const { rail } = useContext(SurfaceCtx);
  const current = workspaces.find((w) => w.id === value) ?? workspaces[0];
  const items: MenuItem[] = workspaces.map((w) => ({
    id: w.id,
    label: w.name,
    description: w.description,
    icon: <Avatar label={w.name} initials={workspaceInitials(w.name)} src={w.src} icon={w.icon} size="xs" shape="square" decorative />,
    kind: "radio",
    checked: w.id === current?.id,
  }));
  const sections = onCreate
    ? [
        { id: "ws", label: "Workspaces", items },
        {
          id: "new",
          items: [
            {
              id: "__create",
              label: createLabel,
              icon: (
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                  <path d="M8 3.5v9M3.5 8h9" />
                </svg>
              ),
            },
          ],
        },
      ]
    : [{ id: "ws", label: "Workspaces", items }];
  if (!current) return null;
  return (
    <Menu
      aria-label={label}
      items={sections}
      width={240}
      onSelect={(item) => (item.id === "__create" ? onCreate?.() : onChange?.(item.id))}
      trigger={
        <button
          type="button"
          aria-label={rail ? `${current.name}, ${label}` : undefined}
          className={cn("flex h-11 w-full min-w-0 items-center gap-2.5 rounded-lg px-1.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50", className)}
        >
          <Avatar label={current.name} initials={workspaceInitials(current.name)} src={current.src} icon={current.icon} size="md" shape="square" decorative />
          <Fade className="flex flex-1 flex-col leading-tight">
            <span className="truncate text-[13px] font-semibold text-foreground">{current.name}</span>
            {current.description && <span className="truncate text-[11.5px] text-muted-foreground">{current.description}</span>}
          </Fade>
          <Fade className="flex">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-3.5 text-muted-foreground">
              <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />
            </svg>
          </Fade>
        </button>
      }
    />
  );
}
