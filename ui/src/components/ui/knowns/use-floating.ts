import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Ref, type RefObject } from "react";
import { MOTION } from "@/ui/lib/knowns/motion-utils";

export type FloatingSide = "top" | "bottom" | "left" | "right";
export type FloatingAlign = "start" | "center" | "end";

export interface FloatingOptions {
  open: boolean;
  /** Preferred side. "auto" picks below or above, whichever has more room. Default "bottom". */
  side?: FloatingSide | "auto";
  align?: FloatingAlign;
  /** Gap between trigger and panel, px. Default 8. */
  offset?: number;
  /** Minimum distance from the viewport edges, px. Default 8. */
  margin?: number;
  /** Give the panel the trigger's width. */
  matchWidth?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Position {
  x: number;
  y: number;
  placement: FloatingSide;
  /** Room on the chosen side (vertical sides) or the viewport height minus margins. */
  maxHeight: number;
  maxWidth: number;
}

const OPPOSITE: Record<FloatingSide, FloatingSide> = { top: "bottom", bottom: "top", left: "right", right: "left" };
/** Below this much room a vertical panel is allowed to overlap the trigger rather than shrink further. */
const MIN_HEIGHT = 80;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Where to put a panel of `size` next to `trigger` inside `viewport`. Flips to the opposite side when the
 * preferred one is too small and the other has more room, then clamps into the viewport.
 */
export function computePosition(
  trigger: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  { side = "bottom", align = "start", offset = 8, margin = 8 }: Omit<FloatingOptions, "open" | "matchWidth"> = {},
): Position {
  const room: Record<FloatingSide, number> = {
    top: trigger.y - offset - margin,
    bottom: viewport.height - (trigger.y + trigger.height) - offset - margin,
    left: trigger.x - offset - margin,
    right: viewport.width - (trigger.x + trigger.width) - offset - margin,
  };
  const need = (s: FloatingSide) => (s === "top" || s === "bottom" ? size.height : size.width);

  let placement: FloatingSide;
  if (side === "auto") placement = size.height <= room.bottom || room.bottom >= room.top ? "bottom" : "top";
  else {
    placement = side;
    if (need(placement) > room[placement] && room[OPPOSITE[placement]] > room[placement]) placement = OPPOSITE[placement];
  }

  const vertical = placement === "top" || placement === "bottom";
  const fullH = viewport.height - 2 * margin;
  const fullW = viewport.width - 2 * margin;
  const maxHeight = vertical ? Math.min(fullH, Math.max(MIN_HEIGHT, room[placement])) : fullH;
  const maxWidth = vertical ? fullW : Math.max(0, room[placement]);
  const h = Math.min(size.height, maxHeight);
  const w = Math.min(size.width, maxWidth);

  const cross = (start: number, length: number, own: number) =>
    align === "start" ? start : align === "end" ? start + length - own : start + (length - own) / 2;

  let x: number;
  let y: number;
  if (vertical) {
    y = placement === "bottom" ? trigger.y + trigger.height + offset : trigger.y - offset - h;
    x = cross(trigger.x, trigger.width, w);
  } else {
    x = placement === "right" ? trigger.x + trigger.width + offset : trigger.x - offset - w;
    y = cross(trigger.y, trigger.height, h);
  }
  x = clamp(x, margin, viewport.width - margin - w);
  y = clamp(y, margin, viewport.height - margin - h);
  return { x: Math.round(x), y: Math.round(y), placement, maxHeight: Math.floor(maxHeight), maxWidth: Math.floor(maxWidth) };
}

/** Where floating UI should be portaled: an open modal <dialog> sits in the top layer above <body>, so render inside it. */
export function portalHostFor(el: Element | null | undefined): HTMLElement {
  return el?.closest<HTMLElement>("dialog[open]") ?? document.body;
}

/** Assign one node to several refs (object or callback). */
export function setRefs<T>(node: T | null, ...refs: (Ref<T> | undefined)[]) {
  for (const r of refs) {
    if (typeof r === "function") r(node);
    else if (r) (r as { current: T | null }).current = node;
  }
}

type Placed = { width?: number } & Position;

/** How long a closing panel stays mounted: the exit (`--kn-dur-fast`) plus 20ms of room, so the timer never cuts the fade. */
export const FLOAT_EXIT_MS = MOTION.fast + 20;

/**
 * The shared surface of every floating panel (menu, dropdown, user menu, popover, hover card, toast): radius 12px,
 * a hairline ring instead of a border (it cannot shift layout), one soft shadow. Content panels pad 12px (`p-3`),
 * list panels 4px (`p-1`) around rows that are 32px tall with an 8px radius. Modal surfaces (dialog, sheet, command
 * menu) use the larger radius and shadow in their own files.
 */
export const FLOAT_SURFACE =
  "rounded-xl bg-popover text-[13px] text-popover-foreground shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_12%,transparent),0_12px_32px_-12px_rgb(0_0_0/0.3),0_2px_6px_rgb(0_0_0/0.06)]";

/**
 * The shared enter and exit of every floating panel: a short opacity fade, no travel. The exit is the enter
 * in reverse on the same curve, about two thirds as long. Set `data-state` to "closed" while `closing`.
 */
export const FLOAT_FADE =
  "transition-opacity duration-(--kn-dur-fast) ease-(--kn-ease-out) starting:opacity-0 data-[state=closed]:pointer-events-none data-[state=closed]:opacity-0 data-[state=closed]:duration-[calc(var(--kn-dur-fast)*.67)] motion-reduce:transition-none";

/**
 * Viewport point that `position: fixed` coordinates start from for `el`. Normally (0, 0), but an
 * ancestor with a transform, translate, filter or containment becomes the containing block, and a
 * sheet <dialog> always carries `translate`. Without this the panel lands offset by the host's
 * position (a dropdown in a right-side sheet opened 620px too far right).
 */
export function fixedOrigin(el: Element | null): { x: number; y: number } {
  for (let n = el?.parentElement ?? null; n && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n);
    const makesBlock =
      cs.transform !== "none" ||
      (cs.translate && cs.translate !== "none") ||
      (cs.scale && cs.scale !== "none") ||
      (cs.rotate && cs.rotate !== "none") ||
      cs.filter !== "none" ||
      cs.perspective !== "none" ||
      /paint|layout|strict|content/.test(cs.contain) ||
      /transform|translate|filter/.test(cs.willChange);
    if (makesBlock) {
      const r = n.getBoundingClientRect();
      return { x: r.left + n.clientLeft - n.scrollLeft, y: r.top + n.clientTop - n.scrollTop };
    }
  }
  return { x: 0, y: 0 };
}

/**
 * Keeps a floating panel next to its trigger: fixed positioning from getBoundingClientRect, flip and
 * clamp inside the viewport, follows scroll, resize and size changes of either element.
 * Render the panel with `createPortal(…, portalHost)` once `portalHost` is set, and spread `style` on it.
 */
export function useFloating<T extends HTMLElement = HTMLElement, F extends HTMLElement = HTMLElement>({
  open,
  side = "bottom",
  align = "start",
  offset = 8,
  margin = 8,
  matchWidth = false,
}: FloatingOptions) {
  const triggerRef = useRef<T | null>(null) as RefObject<T | null>;
  const floatingRef = useRef<F | null>(null) as RefObject<F | null>;
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<Placed | null>(null);
  const [closing, setClosing] = useState(false);
  const wasOpen = useRef(false);

  // Closing keeps the panel mounted and in place for the exit, then lets go. Reduced motion: no exit.
  useLayoutEffect(() => {
    if (open) {
      wasOpen.current = true;
      setClosing(false);
      setPortalHost(portalHostFor(triggerRef.current));
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const still = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (still) {
      setPos(null);
      return;
    }
    setClosing(true);
    const t = setTimeout(() => {
      setClosing(false);
      setPos(null);
    }, FLOAT_EXIT_MS);
    return () => clearTimeout(t);
  }, [open]);

  // Closed since the last commit that was open: already exiting on this very render, so the panel never unmounts between.
  const exiting = closing || (!open && wasOpen.current);

  const update = useCallback(() => {
    const t = triggerRef.current;
    const f = floatingRef.current;
    if (!t || !f || !t.isConnected) return;
    const r = t.getBoundingClientRect();
    // Measure the natural size: lift our own limits for the read, then put them back (no paint in between).
    const { maxHeight, maxWidth } = f.style;
    f.style.maxHeight = "none";
    f.style.maxWidth = "none";
    const size = { width: matchWidth ? r.width : f.offsetWidth, height: f.offsetHeight };
    f.style.maxHeight = maxHeight;
    f.style.maxWidth = maxWidth;
    const origin = fixedOrigin(f);
    const placed = computePosition({ x: r.left, y: r.top, width: r.width, height: r.height }, size, { width: window.innerWidth, height: window.innerHeight }, { side, align, offset, margin });
    const next: Placed = {
      ...placed,
      x: Math.round(placed.x - origin.x),
      y: Math.round(placed.y - origin.y),
      width: matchWidth ? Math.round(r.width) : undefined,
    };
    setPos((p) =>
      p && p.x === next.x && p.y === next.y && p.placement === next.placement && p.maxHeight === next.maxHeight && p.maxWidth === next.maxWidth && p.width === next.width ? p : next,
    );
  }, [side, align, offset, margin, matchWidth]);

  // Place before paint whenever we render while open (content, options or host may have changed).
  useLayoutEffect(() => {
    if (open) update();
  });

  useEffect(() => {
    if (!open || !portalHost) return;
    const onMove = () => update();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onMove);
    if (triggerRef.current) ro?.observe(triggerRef.current);
    if (floatingRef.current) ro?.observe(floatingRef.current);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      ro?.disconnect();
    };
  }, [open, portalHost, update]);

  const style: CSSProperties = {
    position: "fixed",
    left: pos?.x ?? 0,
    top: pos?.y ?? 0,
    maxHeight: pos?.maxHeight,
    maxWidth: pos && (pos.placement === "left" || pos.placement === "right") ? pos.maxWidth : undefined,
    width: pos?.width,
    // Hidden (but measurable) until the first placement.
    visibility: pos ? undefined : "hidden",
  };

  return {
    triggerRef,
    floatingRef,
    style,
    placement: pos?.placement ?? (side === "auto" ? "bottom" : side),
    portalHost: open || exiting ? portalHost : null,
    /** True during the exit: the panel is still mounted, set `data-state="closed"` on it. */
    closing: exiting,
    /** True once the panel has been placed and is visible (focus it only after this). */
    ready: open && pos !== null,
    update,
  };
}

/**
 * Keeps a panel mounted for its exit. `mounted` is true while open and for `FLOAT_EXIT_MS` after; `closing`
 * is true during that exit (set `data-state="closed"`). Reduced motion unmounts at once.
 */
export function useExit(open: boolean, ms = FLOAT_EXIT_MS) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  useLayoutEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    const still = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (still) {
      setMounted(false);
      return;
    }
    setClosing(true);
    const t = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return { mounted: mounted || open, closing: closing && !open };
}
