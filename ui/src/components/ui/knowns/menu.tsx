"use client";
/** @registry name="menu" type="ui" title="Menu" description="Dropdown menu for a button: sections, checkable items, descriptions, icons, typeahead and arrow-key navigation." */

import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/ui/lib/knowns/utils";
import { FLOAT_FADE, setRefs, useExit, useFloating } from "./use-floating";

export interface MenuItem {
  id: string;
  label: ReactNode;
  /** Second line, muted. */
  description?: ReactNode;
  /** 16px box on the left; svgs fill it. */
  icon?: ReactNode;
  /** Right-aligned muted text, e.g. "⌘U". */
  shortcut?: string;
  /** Right-aligned extra after the shortcut, e.g. a Badge or a count. */
  trailing?: ReactNode;
  disabled?: boolean;
  /** Red text, for destructive actions. */
  danger?: boolean;
  /**
   * "radio" / "checkbox": a check mark on the right when `checked`.
   * "switch": a small on/off switch on the right (menuitemcheckbox); stays open.
   */
  kind?: "item" | "radio" | "checkbox" | "switch";
  /** For radio / checkbox / switch items. */
  checked?: boolean;
  /** Text used for typeahead when label is not a string. */
  textValue?: string;
  /** Render the row as a real link (<a role="menuitem">): modifier clicks, middle-click and the context menu work. onSelect still fires. */
  href?: string;
  /** Link target, e.g. "_blank" (gets rel="noopener noreferrer"). */
  target?: string;
  /** Keep the menu open after picking this row. Default: true for checkbox and switch rows, false otherwise. */
  keepOpen?: boolean;
  /** Nested rows: the row shows › and opens a submenu (role="menu" only). */
  items?: MenuItem[] | MenuSection[];
}
export interface MenuSection {
  id: string;
  label?: string;
  items: MenuItem[];
}

/** Second argument of onSelect. For link rows, preventDefault() cancels the navigation. */
export interface MenuSelectEvent {
  preventDefault(): void;
}

export interface MenuProps {
  /**
   * A single element (usually a Button). It is cloned with onClick, onKeyDown, aria-haspopup, aria-expanded, aria-controls and a ref.
   * With openOn="contextmenu" it is the region that is right-clicked, cloned with onContextMenu, onKeyDown and a ref.
   */
  trigger: ReactElement;
  /** Flat list or sections (sections get an optional small label and a separator between them). */
  items: MenuItem[] | MenuSection[];
  /** Called when an enabled leaf row is picked (rows with submenus open them instead). The whole menu closes unless the row keeps it open. */
  onSelect: (item: MenuItem, event: MenuSelectEvent) => void;
  /** "menu" (default): role=menu / menuitem / menuitemradio / menuitemcheckbox. "listbox": role=listbox / option with aria-selected - use for single-choice pickers. */
  role?: "menu" | "listbox";
  /** "click" (default): the trigger toggles the menu. "contextmenu": right-click (or Shift+F10) on the trigger opens it at the pointer. */
  openOn?: "click" | "contextmenu";
  /** Horizontal alignment to the trigger. Default "start". */
  align?: "start" | "end";
  /** Preferred side; "auto" (default) opens toward the side with more room. Always kept inside the viewport (8px margin). */
  side?: "top" | "bottom" | "auto";
  /** Panel width in px, or "trigger" to match the trigger. Default: content width, min 200, max 320. */
  width?: number | "trigger";
  /** Optional content above / below the items (e.g. a title, a "Learn more" link). */
  header?: ReactNode;
  footer?: ReactNode;
  /** Extra classes on every panel (the root and submenus). */
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  "aria-label": string;
}

/* ── Pure helpers (exported for tests) ── */

type Navigable = Pick<MenuItem, "disabled">;

/** Next enabled index from `from` in direction `dir`, wrapping. `from` -1 starts before the first (or after the last). -1 when nothing is enabled. */
export function nextIndex(items: Navigable[], from: number, dir: 1 | -1): number {
  const n = items.length;
  if (n === 0) return -1;
  let i = from < 0 ? (dir === 1 ? -1 : n) : from;
  for (let step = 0; step < n; step++) {
    i = (((i + dir) % n) + n) % n;
    if (!items[i].disabled) return i;
  }
  return -1;
}

/** Text a row is matched by when typing ahead. */
export function itemText(item: Pick<MenuItem, "label" | "textValue">): string {
  return item.textValue ?? (typeof item.label === "string" || typeof item.label === "number" ? String(item.label) : "");
}

/**
 * Typeahead: the first enabled item after `from` whose text starts with `query` (case-insensitive),
 * wrapping. Repeating one letter ("aaa") cycles through items starting with it. -1 when none match.
 */
export function matchIndex(items: Pick<MenuItem, "label" | "textValue" | "disabled">[], from: number, query: string): number {
  const q = query.toLowerCase();
  if (!q) return -1;
  const same = q.length > 1 && [...q].every((c) => c === q[0]);
  const needle = same ? q[0] : q;
  const n = items.length;
  // A longer query keeps the current item if it still matches; a single letter moves on.
  const start = needle.length > 1 ? Math.max(from, 0) : from + 1;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    if (!items[i].disabled && itemText(items[i]).trim().toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

const ROW_ONLY = ["icon", "description", "shortcut", "trailing", "kind", "checked", "disabled", "danger", "textValue", "href", "target", "keepOpen"];

/**
 * Sections vs a flat list. Rows can carry `items` (submenus) too, so a list counts as sections only when
 * every entry has an `items` array and none has a row-only field. A flat list made only of bare
 * `{ id, label, items }` submenu rows reads as sections: wrap it in one section (`[{ id, items }]`).
 */
export function isSections(items: MenuItem[] | MenuSection[]): items is MenuSection[] {
  return items.length > 0 && items.every((it) => Array.isArray((it as MenuSection).items) && !ROW_ONLY.some((k) => k in it));
}

/** Rows of a flat list or of sections, in order. */
export function flatten(items: MenuItem[] | MenuSection[]): MenuItem[] {
  return isSections(items) ? items.flatMap((s) => s.items) : items;
}

/** Whether a row opens a submenu. */
export function hasSubmenu(item: Pick<MenuItem, "items">): boolean {
  return !!item.items && item.items.length > 0;
}

/** Whether picking the row leaves the menu open. */
export function keepsOpen(item: Pick<MenuItem, "kind" | "keepOpen">): boolean {
  return item.keepOpen ?? (item.kind === "checkbox" || item.kind === "switch");
}

/** The data-kind a row is rendered with. */
export function rowKind(item: Pick<MenuItem, "kind" | "items" | "href">): string {
  if (hasSubmenu(item)) return "submenu";
  if (item.kind && item.kind !== "item") return item.kind;
  return item.href ? "link" : "item";
}

export type MenuKeyAction = "next" | "prev" | "first" | "last" | "activate" | "open-sub" | "close-sub" | "close" | "tab" | "type" | null;

/**
 * What a key does inside a menu panel. `depth` is 0 for the root panel; `hasSub` is whether the
 * highlighted row opens a submenu; `typing` is whether a typeahead query is in progress (Space then types).
 */
export function menuKeyAction(key: string, { depth, hasSub, typing }: { depth: number; hasSub: boolean; typing: boolean }): MenuKeyAction {
  switch (key) {
    case "Escape":
      return depth > 0 ? "close-sub" : "close";
    case "Tab":
      return "tab";
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "prev";
    case "Home":
    case "PageUp":
      return "first";
    case "End":
    case "PageDown":
      return "last";
    case "ArrowRight":
      return hasSub ? "open-sub" : null;
    case "ArrowLeft":
      return depth > 0 ? "close-sub" : null;
    case "Enter":
      return hasSub ? "open-sub" : "activate";
    case " ":
      if (typing) return "type";
      return hasSub ? "open-sub" : "activate";
  }
  return key.length === 1 ? "type" : null;
}

export interface Point {
  x: number;
  y: number;
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon({ x, y }: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * The area the pointer may cross on its way from `from` (where it left the parent row) into a submenu
 * panel `rect` without the submenu closing: a wedge from the pointer to the panel's near edge, plus the panel.
 */
export function graceArea(from: Point, rect: { left: number; right: number; top: number; bottom: number }): Point[] {
  const toRight = rect.left >= from.x;
  const near = toRight ? rect.left : rect.right;
  const far = toRight ? rect.right : rect.left;
  const back = toRight ? -3 : 3; // a few px behind the pointer so tiny jitters stay inside
  return [
    { x: from.x + back, y: from.y - 2 },
    { x: near, y: rect.top },
    { x: far, y: rect.top },
    { x: far, y: rect.bottom },
    { x: near, y: rect.bottom },
    { x: from.x + back, y: from.y + 2 },
  ];
}

/* ── Glyphs ── */

/** The check glyph used for checked radio / checkbox items. */
export function MenuCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={cn("size-4", className)}>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/** The small switch drawn on kind="switch" rows. Purely visual: the row carries aria-checked. */
export function MenuSwitch({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex h-4 w-7 flex-none items-center rounded-full p-0.5",
        "transition-colors duration-[var(--kn-dur-fast,120ms)] ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))] motion-reduce:transition-none",
        on ? "bg-primary" : "bg-[color-mix(in_srgb,var(--foreground)_16%,transparent)]",
        className,
      )}
    >
      <span
        className={cn(
          "size-3 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)]",
          "transition-[translate] duration-[var(--kn-dur-fast,120ms)] ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))] motion-reduce:transition-none",
          on && "translate-x-3 dark:bg-[var(--primary-foreground)]",
        )}
      />
    </span>
  );
}

const SubChevron = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-3.5">
    <path d="M6.5 4.5L10 8l-3.5 3.5" />
  </svg>
);

/**
 * One highlight that follows the active row of a scrolling list. Returns the offset and height of the row
 * with id `activeId` (null hides it) and keeps that row scrolled into view. Shared by Menu and Combobox.
 */
export function useGlide(list: RefObject<HTMLElement | null>, activeId: string | null, ...deps: unknown[]) {
  const [hi, setHi] = useState<{ top: number; height: number; instant: boolean } | null>(null);
  useLayoutEffect(() => {
    const l = list.current;
    const row = activeId && l ? l.querySelector<HTMLElement>(`[id="${CSS.escape(activeId)}"]`) : null;
    if (!l || !row) {
      setHi(null);
      return;
    }
    // Rows must be positioned against the list (the list is the offsetParent).
    const top = row.offsetTop;
    const height = row.offsetHeight;
    setHi((prev) => (prev && prev.top === top && prev.height === height ? prev : { top, height, instant: !prev }));
    if (top < l.scrollTop) l.scrollTop = top - 4;
    else if (top + height > l.scrollTop + l.clientHeight) l.scrollTop = top + height - l.clientHeight + 4;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, list, ...deps]);
  return hi;
}

/** The highlight element, placed instantly on the active row (a menu is a high-frequency list: no glide). Render it first inside a `relative` list. */
export function GlideHighlight({ hi, danger }: { hi: ReturnType<typeof useGlide>; danger?: boolean }) {
  return (
    <div
      aria-hidden
      style={{ translate: `0 ${hi?.top ?? 0}px`, height: hi?.height ?? 0 }}
      className={cn(
        "pointer-events-none absolute inset-x-1 top-0 rounded-[8px]",
        danger ? "bg-red-500/[0.09] dark:bg-red-500/15" : "bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)]",
        hi ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

type TriggerProps = {
  onClick?: (e: ReactMouseEvent<HTMLElement>) => void;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLElement>) => void;
  onContextMenu?: (e: ReactMouseEvent<HTMLElement>) => void;
  ref?: Ref<HTMLElement>;
};

/* ── Panel (root and submenus) ── */

type Initial = "checked" | "first" | "last" | "none";

interface Tree {
  /** Marks every panel of one menu, for outside-press detection. */
  id: string;
  role: "menu" | "listbox";
  className?: string;
  select: (item: MenuItem, event?: MenuSelectEvent) => void;
  closeAll: (refocus: boolean) => void;
  /** Tab: close everything and let the browser move focus on from the trigger. */
  tab: () => void;
}

interface PanelProps {
  /** The exit is playing: fade out, take no input. Only the root panel exits; a submenu closes at once (it opens and closes on every hover and arrow key, so it stays instant). */
  closing?: boolean;
  tree: Tree;
  items: MenuItem[] | MenuSection[];
  depth: number;
  anchor: () => HTMLElement | null;
  side: "top" | "bottom" | "auto" | "right";
  align: "start" | "end";
  offset: number;
  width?: number | "trigger";
  header?: ReactNode;
  footer?: ReactNode;
  label?: string;
  labelledBy?: string;
  listId: string;
  /** Increment to move focus into the panel (0: leave focus where it is). */
  focusRequest: number;
  initial: Initial;
  /** Submenus: close this panel; `refocus` returns focus to the parent row's list. */
  onClose?: (refocus: boolean) => void;
}

const HOVER_OPEN_MS = 100;
const GRACE_MS = 450;

function startIndex(flat: MenuItem[], initial: Initial) {
  if (initial === "none") return -1;
  if (initial === "last") return nextIndex(flat, -1, -1);
  if (initial === "checked") {
    const checked = flat.findIndex((it) => it.checked && !it.disabled);
    if (checked >= 0) return checked;
  }
  return nextIndex(flat, -1, 1);
}

function MenuPanel(p: PanelProps) {
  const { tree, items, depth } = p;
  const role = depth > 0 ? "menu" : tree.role;
  const baseId = useId();
  const rowId = (i: number) => `${baseId}-row-${i}`;
  const subListId = (i: number) => `${baseId}-sub-${i}`;

  const grouped = isSections(items);
  const sections: MenuSection[] = grouped ? items : [{ id: "all", items: items as MenuItem[] }];
  const flat = sections.flatMap((s) => s.items);
  const multi = role === "listbox" && flat.some((it) => it.kind === "checkbox" || it.kind === "switch");
  const canNest = role === "menu";

  const [active, setActive] = useState(() => startIndex(flat, p.initial));
  const activeRef = useRef(active);
  activeRef.current = active;
  const [sub, setSub] = useState<{ index: number; focus: number; initial: Initial } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", timer: undefined as ReturnType<typeof setTimeout> | undefined });
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const grace = useRef<{ poly: Point[]; until: number } | null>(null);

  const fl = useFloating<HTMLElement, HTMLDivElement>({
    open: true,
    side: p.side,
    align: p.align,
    offset: p.offset,
    matchWidth: p.width === "trigger",
  });
  // The anchor is the trigger (root) or the parent row (submenu); it exists before this panel mounts.
  fl.triggerRef.current = p.anchor();

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  /* Move focus into the panel once it is placed, and again on each new request. */
  useEffect(() => {
    if (!fl.ready || !p.focusRequest) return;
    list.current?.focus({ preventScroll: true });
    if (activeRef.current < 0 && p.initial !== "none") setActive(startIndex(flat, p.initial));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fl.ready, p.focusRequest]);

  const hi = useGlide(list, fl.ready && active >= 0 ? rowId(active) : null, items);

  const subPanel = () => (sub ? document.getElementById(`${subListId(sub.index)}-panel`) : null);
  const closeSub = (refocus?: boolean) => {
    clearTimeout(hoverTimer.current);
    grace.current = null;
    if (!sub) return;
    const hadFocus = !!subPanel()?.contains(document.activeElement);
    setSub(null);
    if (refocus || hadFocus) list.current?.focus({ preventScroll: true });
  };
  const openSub = (i: number, focus: boolean, initial: Initial) => {
    clearTimeout(hoverTimer.current);
    setActive(i);
    setSub((s) => (s && s.index === i ? (focus ? { ...s, focus: s.focus + 1, initial } : s) : { index: i, focus: focus ? 1 : 0, initial }));
  };

  const pick = (i: number, event?: MenuSelectEvent) => {
    const item = flat[i];
    if (!item || item.disabled) return;
    if (canNest && hasSubmenu(item)) return openSub(i, true, "none");
    tree.select(item, event);
  };

  /** Enter / Space: links are clicked for real so the browser follows them; other rows are picked. */
  const activate = (i: number) => {
    const item = flat[i];
    if (!item || item.disabled) return;
    if (item.href) document.getElementById(rowId(i))?.click();
    else pick(i);
  };

  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keys from a submenu bubble here through the React tree; that panel handles its own.
    if (!list.current || !list.current.contains(e.target as Node)) return;
    const row = flat[active];
    const t = typed.current;
    const modified = e.metaKey || e.ctrlKey || e.altKey;
    const action = menuKeyAction(e.key, { depth, hasSub: canNest && !!row && !row.disabled && hasSubmenu(row), typing: !!t.text });
    if (!action || (modified && action === "type")) return;
    const move = (i: number) => {
      e.preventDefault();
      if (i >= 0) {
        if (sub && sub.index !== i) closeSub();
        setActive(i);
      }
    };
    switch (action) {
      case "close":
        e.preventDefault();
        e.stopPropagation();
        return tree.closeAll(true);
      case "close-sub":
        e.preventDefault();
        e.stopPropagation();
        return p.onClose?.(true);
      case "tab":
        return tree.tab();
      case "next":
        return move(nextIndex(flat, active, 1));
      case "prev":
        return move(nextIndex(flat, active, -1));
      case "first":
        return move(nextIndex(flat, -1, 1));
      case "last":
        return move(nextIndex(flat, -1, -1));
      case "open-sub":
        e.preventDefault();
        return openSub(active, true, "first");
      case "activate":
        e.preventDefault();
        return activate(active);
      case "type": {
        clearTimeout(t.timer);
        t.text += e.key;
        t.timer = setTimeout(() => (t.text = ""), 500);
        return move(matchIndex(flat, active, t.text));
      }
    }
  };

  /** Pointer over row i: highlight it, open / close submenus with a little hover intent. */
  const onRowPointerMove = (e: ReactPointerEvent<HTMLElement>, i: number) => {
    const g = grace.current;
    if (g) {
      if (performance.now() < g.until && pointInPolygon({ x: e.clientX, y: e.clientY }, g.poly)) return;
      grace.current = null;
    }
    // Pointer back in this panel while focus sits in a submenu (or elsewhere in the menu): take focus back.
    const focused = document.activeElement;
    if (focused !== list.current && focused?.closest(`[data-kn-menu="${tree.id}"]`) && !subPanel()?.contains(focused)) list.current?.focus({ preventScroll: true });

    const item = flat[i];
    if (item.disabled) {
      if (sub) closeSub();
      return;
    }
    if (active !== i) setActive(i);
    if (canNest && hasSubmenu(item)) {
      if (sub?.index === i) return clearTimeout(hoverTimer.current);
      if (sub) closeSub();
      clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => openSub(i, false, "none"), HOVER_OPEN_MS);
    } else {
      clearTimeout(hoverTimer.current);
      if (sub) closeSub();
    }
  };

  /** Leaving the row whose submenu is open: allow a diagonal path into the submenu. */
  const onRowPointerLeave = (e: ReactPointerEvent<HTMLElement>, i: number) => {
    if (sub?.index !== i) return;
    const panel = subPanel();
    if (!panel) return;
    grace.current = { poly: graceArea({ x: e.clientX, y: e.clientY }, panel.getBoundingClientRect()), until: performance.now() + GRACE_MS };
  };

  const activeItem = flat[active];
  let index = 0;

  return (
    <>
      {fl.portalHost &&
        createPortal(
          <div
            ref={fl.floatingRef}
            id={depth > 0 ? `${p.listId}-panel` : undefined}
            data-kn-menu={tree.id}
            data-state={p.closing ? "closed" : "open"}
            style={{
              ...fl.style,
              width: typeof p.width === "number" ? p.width : fl.style.width,
              // Line the submenu's first row up with its parent row (the list has 4px padding).
              marginTop: depth > 0 ? -5 : undefined,
            }}
            className={cn(
              "z-[60] flex flex-col overflow-hidden rounded-xl bg-popover text-[13px] text-popover-foreground",
              "shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_12%,transparent),0_12px_32px_-12px_rgb(0_0_0/0.3),0_2px_6px_rgb(0_0_0/0.06)]",
              p.width === undefined && "w-max max-w-[min(320px,calc(100vw-16px))] min-w-[200px]",
              depth > 0 && "min-w-[180px]",
              FLOAT_FADE,
              tree.className,
            )}
          >
            {p.header && <div className="flex-none border-b px-3 py-2.5">{p.header}</div>}
            <div
              ref={list}
              id={p.listId}
              role={role}
              aria-label={p.label}
              aria-labelledby={p.labelledBy}
              aria-multiselectable={multi || undefined}
              aria-activedescendant={active >= 0 ? rowId(active) : undefined}
              tabIndex={-1}
              onKeyDown={onListKey}
              onPointerLeave={() => {
                clearTimeout(hoverTimer.current);
                if (!sub) setActive(-1);
              }}
              className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 outline-none"
            >
              {/* One highlight that glides between rows. */}
              <GlideHighlight hi={hi} danger={activeItem?.danger} />
              {sections.map((section, s) => {
                const labelId = section.label ? `${baseId}-sec-${s}` : undefined;
                return (
                  <div key={section.id} role={grouped ? "group" : undefined} aria-labelledby={labelId}>
                    {s > 0 && <div role={role === "menu" ? "separator" : undefined} aria-hidden={role === "menu" ? undefined : true} className="mx-1.5 my-1 h-px bg-border" />}
                    {section.label && (
                      <div id={labelId} role="presentation" className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-[0.01em] text-muted-foreground">
                        {section.label}
                      </div>
                    )}
                    {section.items.map((item) => {
                      const i = index++;
                      const nested = canNest && hasSubmenu(item);
                      const checkable = item.kind === "radio" || item.kind === "checkbox";
                      const isSwitch = item.kind === "switch";
                      const rowRole =
                        role === "listbox"
                          ? "option"
                          : item.kind === "radio"
                            ? "menuitemradio"
                            : checkable || isSwitch
                              ? "menuitemcheckbox"
                              : "menuitem";
                      const link = !!item.href && !nested;
                      const external = link && item.target === "_blank";
                      const rowProps = {
                        id: rowId(i),
                        role: rowRole,
                        "data-kind": rowKind(item),
                        "aria-disabled": item.disabled || undefined,
                        "aria-checked": role === "menu" && (checkable || isSwitch) ? !!item.checked : undefined,
                        "aria-selected": role === "listbox" ? !!item.checked : undefined,
                        "aria-haspopup": nested ? ("menu" as const) : undefined,
                        "aria-expanded": nested ? sub?.index === i : undefined,
                        "aria-controls": nested && sub?.index === i ? subListId(i) : undefined,
                        onPointerMove: (e: ReactPointerEvent<HTMLElement>) => onRowPointerMove(e, i),
                        onPointerLeave: (e: ReactPointerEvent<HTMLElement>) => onRowPointerLeave(e, i),
                        onClick: (e: ReactMouseEvent<HTMLElement>) => {
                          if (item.disabled) {
                            e.preventDefault();
                            return;
                          }
                          pick(i, e);
                        },
                        className: cn(
                          "relative flex min-h-8 items-start gap-2.5 rounded-[8px] px-2.5 py-1.5 leading-5 no-underline select-none",
                          item.disabled ? "cursor-default opacity-45" : "cursor-pointer",
                          item.danger ? "text-red-600 dark:text-red-400" : "text-popover-foreground",
                        ),
                      };
                      const content = (
                        <>
                          {item.icon && (
                            <span className={cn("mt-0.5 grid size-4 flex-none place-items-center [&>svg]:size-full", !item.danger && "text-muted-foreground")}>{item.icon}</span>
                          )}
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate">{item.label}</span>
                            {item.description && <span className="text-[12px] leading-[1.35] text-muted-foreground">{item.description}</span>}
                          </span>
                          {item.shortcut && <span className="flex-none pt-px pl-3 text-[11.5px] tracking-[0.02em] text-muted-foreground tabular-nums">{item.shortcut}</span>}
                          {item.trailing !== undefined && item.trailing !== null && item.trailing !== false && (
                            <span className={cn("flex h-5 flex-none items-center", !item.shortcut && "pl-3")}>{item.trailing}</span>
                          )}
                          {external && <span className="sr-only">(opens in a new tab)</span>}
                          {checkable && (
                            <span className={cn("mt-0.5 flex-none text-foreground", !item.checked && "invisible")}>
                              <MenuCheck />
                            </span>
                          )}
                          {isSwitch && (
                            <span className="flex h-5 flex-none items-center pl-1">
                              <MenuSwitch on={!!item.checked} />
                            </span>
                          )}
                          {nested && (
                            <span className="flex h-5 flex-none items-center text-muted-foreground">
                              <SubChevron />
                            </span>
                          )}
                        </>
                      );
                      return link ? (
                        <a
                          key={item.id}
                          {...rowProps}
                          href={item.disabled ? undefined : item.href}
                          target={item.target}
                          rel={external ? "noopener noreferrer" : undefined}
                          tabIndex={-1}
                          // Keep focus on the list: a clicked link would otherwise take it.
                          onMouseDown={(e) => e.preventDefault()}
                          draggable={false}
                        >
                          {content}
                        </a>
                      ) : (
                        <div key={item.id} {...rowProps}>
                          {content}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            {p.footer && <div className="flex-none border-t px-3 py-2 text-[12.5px] text-muted-foreground">{p.footer}</div>}
          </div>,
          fl.portalHost,
        )}
      {sub && flat[sub.index]?.items && (
        <MenuPanel
          key={sub.index}
          tree={tree}
          items={flat[sub.index].items!}
          depth={depth + 1}
          anchor={() => document.getElementById(rowId(sub.index))}
          side="right"
          align="start"
          offset={6}
          labelledBy={rowId(sub.index)}
          listId={subListId(sub.index)}
          focusRequest={sub.focus}
          initial={sub.initial}
          onClose={(refocus) => closeSub(refocus)}
        />
      )}
    </>
  );
}

/**
 * Action menu or single-choice picker opened from a trigger. The panel renders in a portal on
 * <body> with fixed positioning, so ancestors with transforms or overflow-hidden never clip it.
 * Inside an open modal <dialog> it portals into that dialog instead (the top layer would cover <body>).
 * Positioning comes from useFloating: flips to the side with room, stays 8px inside the viewport.
 * Focus sits on the list and the highlighted row is exposed with aria-activedescendant.
 * Rows can be links, switches, or open submenus (side right, flipping left).
 */
export function Menu({
  trigger,
  items,
  onSelect,
  role = "menu",
  openOn = "click",
  align = "start",
  side = "auto",
  width,
  header,
  footer,
  className,
  open: openProp,
  onOpenChange,
  "aria-label": label,
}: MenuProps) {
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const { mounted, closing } = useExit(open);
  const openRef = useRef(open);
  openRef.current = open;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const controlled = openProp !== undefined;
  const set = useCallback(
    (v: boolean) => {
      if (!controlled) setOwn(v);
      onOpenChangeRef.current?.(v);
    },
    [controlled],
  );

  const baseId = useId();
  const listId = `${baseId}-list`;
  const context = openOn === "contextmenu";

  /** Highlight to apply on the next open (set by the trigger's keyboard handler). */
  const intent = useRef<Initial>("checked");
  const triggerEl = useRef<HTMLElement | null>(null);
  /** Context menus: a zero-size element at the pointer to anchor the panel to. */
  const pointEl = useRef<HTMLSpanElement>(null);
  const [point, setPoint] = useState<Point>({ x: 0, y: 0 });

  const close = useCallback(
    (refocus: boolean) => {
      set(false);
      if (refocus) triggerEl.current?.focus();
    },
    [set],
  );

  /* Trigger ref: keep the consumer's ref working, and close if the trigger goes away. */
  const userRef = (trigger.props as TriggerProps).ref;
  const setTrigger = useCallback(
    (node: HTMLElement | null) => {
      setRefs(node, triggerEl, userRef);
      if (!node)
        queueMicrotask(() => {
          // A callback ref swap detaches then reattaches in the same commit; only a real unmount stays null.
          if (!triggerEl.current && openRef.current) set(false);
        });
    },
    [userRef, set],
  );

  /* While open: close on a press outside the trigger and every panel of this menu. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element;
      if (target.closest?.(`[data-kn-menu="${baseId}"]`) || triggerEl.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, close, baseId]);

  const tree: Tree = {
    id: baseId,
    role,
    className,
    select: (item, event) => {
      onSelectRef.current(item, event ?? { preventDefault() {} });
      if (keepsOpen(item)) return;
      // Links: close after the click has been dispatched, so the browser still follows them.
      if (item.href) setTimeout(() => close(true), 0);
      else close(true);
    },
    closeAll: close,
    tab: () => {
      // Let the browser move focus on from the trigger, as if the menu had never been there.
      triggerEl.current?.focus();
      set(false);
    },
  };

  const tp = trigger.props as TriggerProps;
  const openAt = (x: number, y: number, initial: Initial) => {
    intent.current = initial;
    setPoint({ x: Math.round(x), y: Math.round(y) });
    set(true);
  };
  const triggerNode = context
    ? cloneElement(trigger as ReactElement<Record<string, unknown>>, {
        ref: setTrigger,
        onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
          tp.onContextMenu?.(e);
          if (e.defaultPrevented) return;
          e.preventDefault();
          // Keyboard-generated contextmenu events come at 0,0 on some platforms: use the element instead.
          if (e.clientX === 0 && e.clientY === 0) {
            const r = (e.target as HTMLElement).getBoundingClientRect();
            return openAt(r.left + 8, r.top + 8, "first");
          }
          openAt(e.clientX, e.clientY, "none");
        },
        onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
          tp.onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
            e.preventDefault();
            const r = (e.target as HTMLElement).getBoundingClientRect();
            openAt(r.left + 8, r.top + 8, "first");
          }
        },
      })
    : cloneElement(trigger as ReactElement<Record<string, unknown>>, {
        ref: setTrigger,
        "aria-haspopup": role,
        "aria-expanded": open,
        "aria-controls": open ? listId : undefined,
        onClick: (e: ReactMouseEvent<HTMLElement>) => {
          tp.onClick?.(e);
          if (!e.defaultPrevented) {
            intent.current = "checked";
            set(!open);
          }
        },
        onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
          tp.onKeyDown?.(e);
          if (e.defaultPrevented || open) return;
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            intent.current = e.key === "ArrowUp" ? "last" : "checked";
            set(true);
          }
        },
      });

  return (
    <>
      {triggerNode}
      {context &&
        typeof document !== "undefined" &&
        createPortal(<span ref={pointEl} aria-hidden style={{ position: "fixed", left: point.x, top: point.y, width: 0, height: 0, pointerEvents: "none" }} />, document.body)}
      {mounted && (
        <MenuPanel
          closing={closing}
          tree={tree}
          items={items}
          depth={0}
          anchor={() => (context ? pointEl.current : triggerEl.current)}
          side={context ? "bottom" : side}
          align={align}
          offset={context ? 2 : 6}
          width={width}
          header={header}
          footer={footer}
          label={label}
          listId={listId}
          focusRequest={1}
          initial={intent.current}
        />
      )}
    </>
  );
}

export default Menu;
