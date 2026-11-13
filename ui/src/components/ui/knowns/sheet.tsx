"use client";
/** @registry name="sheet" type="ui" title="Sheet" description="A panel that slides in from any edge on the native dialog element: focus trap, Escape, scroll lock, and a bottom drawer you drag down to dismiss." */

import { useEffect, useId, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { Button } from "./button";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export type SheetSide = "left" | "right" | "top" | "bottom";

/**
 * Whether a released drag closes the drawer: pulled past 30% of its height, or flicked down fast
 * (more than 0.5 px/ms). A drag upward never closes it.
 */
export function shouldDismiss(distance: number, height: number, velocity: number): boolean {
  if (distance <= 0 || height <= 0) return false;
  return distance / height > 0.3 || velocity > 0.5;
}

/*
 * Motion, all CSS: the panel slides from its edge over a fading backdrop and slides back out on close (a real
 * exit: the native dialog stays painted through `overlay` / `display` with allow-discrete). While dragging,
 * the transition is off so the panel follows the pointer. Reduced motion: opacity only.
 */
const MOTION = `
[data-kn-sheet]{translate:0 var(--kn-sheet-drag,0px);transition:translate 260ms var(--kn-ease-out,cubic-bezier(.22,1,.36,1)),overlay 260ms allow-discrete,display 260ms allow-discrete}
[data-kn-sheet][data-dragging]{transition:none}
[data-kn-sheet]:not([open]){transition-duration:200ms;transition-timing-function:cubic-bezier(.4,0,1,1)}
[data-kn-sheet][data-side=left]:not([open]){translate:-100% 0}
[data-kn-sheet][data-side=right]:not([open]){translate:100% 0}
[data-kn-sheet][data-side=top]:not([open]){translate:0 -100%}
[data-kn-sheet][data-side=bottom]:not([open]){translate:0 100%}
@starting-style{
  [data-kn-sheet][data-side=left][open]{translate:-100% 0}
  [data-kn-sheet][data-side=right][open]{translate:100% 0}
  [data-kn-sheet][data-side=top][open]{translate:0 -100%}
  [data-kn-sheet][data-side=bottom][open]{translate:0 100%}
}
[data-kn-sheet]::backdrop{background:rgb(0 0 0/.4);opacity:1;transition:opacity 220ms ease-out,overlay 220ms allow-discrete,display 220ms allow-discrete}
[data-kn-sheet]:not([open])::backdrop{opacity:0;transition-duration:180ms}
@starting-style{[data-kn-sheet][open]::backdrop{opacity:0}}
@media (prefers-reduced-motion:reduce){
  [data-kn-sheet],[data-kn-sheet]:not([open]){translate:0 0!important;transition-property:opacity,overlay,display}
  [data-kn-sheet]:not([open]){opacity:0}
  @starting-style{[data-kn-sheet][open]{opacity:0}}
}
`;

/** Open sheets lock the page scroll together: it unlocks when the last one closes. */
let locks = 0;
let before = "";
function lockScroll() {
  if (locks++ === 0) {
    before = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
  }
}
function unlockScroll() {
  if (--locks === 0) document.documentElement.style.overflow = before;
}

const SIDE: Record<SheetSide, string> = {
  left: "inset-y-0 left-0 right-auto h-auto max-h-none border-r pt-[env(safe-area-inset-top)]",
  right: "inset-y-0 right-0 left-auto h-auto max-h-none border-l pt-[env(safe-area-inset-top)]",
  top: "inset-x-0 top-0 bottom-auto mx-auto w-full max-h-[85dvh] border-b rounded-b-2xl sm:max-w-2xl pt-[env(safe-area-inset-top)]",
  bottom: "inset-x-0 bottom-0 top-auto mx-auto w-full max-h-[85dvh] border-t rounded-t-2xl sm:max-w-2xl pb-[env(safe-area-inset-bottom)]",
};
const WIDTH = { sm: "w-[min(20rem,calc(100vw-3rem))]", md: "w-[min(25rem,calc(100vw-3rem))]", lg: "w-[min(32rem,calc(100vw-3rem))]" } as const;

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The edge it slides in from. Default "right". */
  side?: SheetSide;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Actions on a muted strip at the bottom. */
  footer?: ReactNode;
  /** Width of a left or right sheet. Top and bottom sheets are full width, capped at 42rem from 640px up. Default "md". */
  size?: "sm" | "md" | "lg";
  /** Pull the bottom sheet down to close it (on its handle and header). Default true. */
  dragToDismiss?: boolean;
  /** Replaces the default body padding ("px-5 py-3"), e.g. for a list that scrolls edge to edge. */
  bodyClassName?: string;
  className?: string;
  /** The dialog element's id, e.g. for a trigger's aria-controls. */
  id?: string;
  /** Accessible name when there is no `title`. */
  label?: string;
  /** Draws no header, handle or close button, only your children: bring your own chrome and close with onOpenChange. */
  bare?: boolean;
  /** A click on a link inside closes the sheet, for navigation. */
  closeOnLink?: boolean;
  /** Called right after it opens, for custom focus: the dialog element is passed in. */
  onOpen?: (dialog: HTMLDialogElement) => void;
}

/**
 * Sheet: a panel from the left, right, top or bottom edge on the native <dialog>, so focus is trapped and Escape
 * closes it for free. The page behind does not scroll, focus returns to what opened it, and a click on the
 * backdrop closes it. The bottom edge is a drawer: grab its handle and pull it down. Controlled with
 * `open` / `onOpenChange`; the API follows Dialog.
 */
export function Sheet({
  open,
  onOpenChange,
  side = "right",
  title,
  description,
  children,
  footer,
  size = "md",
  dragToDismiss = true,
  bodyClassName,
  className,
  id,
  label,
  bare,
  closeOnLink,
  onOpen,
}: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();
  const drag = useRef<{ y: number; ly: number; t: number; v: number; h: number; id: number } | null>(null);
  const horizontal = side === "left" || side === "right";
  const drawer = side === "bottom" && dragToDismiss && !bare;

  useIsoLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      d.style.removeProperty("--kn-sheet-drag");
      d.showModal();
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
      onOpen?.(d);
    }
    if (!open && d.open) {
      d.close();
      returnTo.current?.focus?.({ preventScroll: true });
    }
    // onOpen is read when it opens; a new function each render must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The page behind a modal sheet does not scroll.
  useEffect(() => {
    if (!open) return;
    lockScroll();
    return unlockScroll;
  }, [open]);

  const down = (e: ReactPointerEvent<HTMLElement>) => {
    const d = ref.current;
    if (!drawer || !d || e.button !== 0 || (e.target as Element).closest("button, a, input, textarea, select")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, ly: e.clientY, t: e.timeStamp, v: 0, h: d.offsetHeight, id: e.pointerId };
    d.setAttribute("data-dragging", "");
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const s = drag.current;
    const d = ref.current;
    if (!s || !d || s.id !== e.pointerId) return;
    const dy = Math.max(0, e.clientY - s.y);
    const dt = e.timeStamp - s.t;
    if (dt > 0) s.v = (e.clientY - s.ly) / dt;
    s.t = e.timeStamp;
    s.ly = e.clientY;
    d.style.setProperty("--kn-sheet-drag", `${dy}px`);
  };
  const up = (e: ReactPointerEvent<HTMLElement>) => {
    const s = drag.current;
    const d = ref.current;
    if (!s || !d || s.id !== e.pointerId) return;
    drag.current = null;
    d.removeAttribute("data-dragging");
    const dy = parseFloat(d.style.getPropertyValue("--kn-sheet-drag")) || 0;
    if (e.type === "pointerup" && shouldDismiss(dy, s.h, s.v)) onOpenChange(false);
    else d.style.removeProperty("--kn-sheet-drag");
  };

  return (
    <>
      <style href="kn-sheet" precedence="default">
        {MOTION}
      </style>
      <dialog
        ref={ref}
        id={id}
        data-kn-sheet
        data-side={side}
        aria-label={title ? undefined : label}
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        onCancel={(e) => {
          e.preventDefault();
          onOpenChange(false);
        }}
        // A click on the backdrop lands on the dialog element itself.
        onClick={(e) => {
          if (e.target === e.currentTarget || (closeOnLink && (e.target as Element).closest?.("a[href]"))) onOpenChange(false);
        }}
        className={cn(
          "fixed m-0 max-w-none flex-col overflow-hidden bg-popover p-0 text-[13.5px] text-popover-foreground shadow-[0_24px_64px_-16px_rgb(0_0_0/0.35)] open:flex",
          SIDE[side],
          horizontal && WIDTH[size],
          className,
        )}
      >
        {!bare && (
          <div onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} className={cn("flex-none", drawer && "cursor-grab touch-none select-none active:cursor-grabbing")}>
            {side === "bottom" && <div aria-hidden="true" className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-border" />}
            <div className="flex items-start gap-3 px-5 pb-2 pt-4">
              <div className="min-w-0 flex-1">
                {title && (
                  <h2 id={titleId} className="text-base font-semibold tracking-tight">
                    {title}
                  </h2>
                )}
                {description && (
                  <p id={descId} className="mt-1 leading-relaxed text-muted-foreground">
                    {description}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Close"
                onClick={() => onOpenChange(false)}
                className="-mr-2 -mt-1"
                icon={
                  <svg viewBox="0 0 16 16">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                }
              />
            </div>
          </div>
        )}
        {bare ? children : children && <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", bodyClassName ?? "px-5 py-3")}>{children}</div>}
        {!bare && footer && <div className="flex flex-none justify-end gap-2 border-t bg-muted/30 px-5 py-3">{footer}</div>}
      </dialog>
    </>
  );
}
