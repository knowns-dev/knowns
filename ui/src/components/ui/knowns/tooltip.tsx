"use client";
/** @registry name="tooltip" type="ui" title="Tooltip" description="Short hint on hover or focus, four sides, optional description; portaled above everything." */

import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/ui/lib/knowns/utils";
import { FLOAT_FADE, useFloating, type FloatingAlign, type FloatingSide } from "./use-floating";

export interface TooltipProps {
  /** The hint. Keep it short; it is read as the trigger's description. */
  content: ReactNode;
  /** Optional second, muted line. */
  description?: ReactNode;
  children: ReactNode;
  side?: FloatingSide;
  align?: FloatingAlign;
  /** Hover delay before showing, ms. Focus shows at once. Default 300. */
  delay?: number;
  /** Delay before hiding after the pointer leaves, ms. Default 80. */
  closeDelay?: number;
  /** Never show (the trigger keeps working). */
  disabled?: boolean;
  /** Classes for the inline wrapper around the trigger. */
  className?: string;
}

/** When a tooltip last closed: the next one within a moment opens at once, with no fade (a toolbar sweep). */
let lastClosed = 0;
const WARM_MS = 400;

const isExpanded = (v: unknown) => v === true || v === "true";

/**
 * Short hint on hover or focus. Wraps its child; the child should be focusable (a button, a link) so
 * keyboard users get the hint too. The hint renders in a portal with fixed positioning, flips when there
 * is no room, and hides itself while its trigger has an open popup (aria-expanded).
 */
export function Tooltip({ content, description, children, side = "top", align = "center", delay = 300, closeDelay = 80, disabled, className }: TooltipProps) {
  const [want, setWant] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const id = useId();

  const child = isValidElement(children) ? (children as ReactElement<Record<string, unknown>>) : null;
  const suppressed = disabled || (child ? isExpanded(child.props["aria-expanded"]) : false);
  const open = want && !suppressed;
  const { triggerRef, floatingRef, style, placement, portalHost, closing } = useFloating<HTMLSpanElement, HTMLDivElement>({ open, side, align, offset: 6 });
  const warm = useRef(false);

  const show = (now = false) => {
    clearTimeout(timer.current);
    warm.current = Date.now() - lastClosed < WARM_MS;
    timer.current = setTimeout(() => setWant(true), now || warm.current ? 0 : delay);
  };
  const hide = (now = false) => {
    clearTimeout(timer.current);
    const close = () => {
      lastClosed = Date.now();
      setWant(false);
    };
    if (now) close();
    else timer.current = setTimeout(close, closeDelay);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  // Escape dismisses even when the pointer, not focus, opened it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide(true);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Describe the focusable child itself; fall back to the wrapper for plain text children.
  const describedBy = open ? id : undefined;
  const trigger = child
    ? cloneElement(child, { "aria-describedby": cn(child.props["aria-describedby"], describedBy) || undefined })
    : children;

  return (
    <span
      ref={triggerRef}
      className={cn("inline-flex", className)}
      onPointerEnter={(e) => e.pointerType !== "touch" && show()}
      onPointerLeave={() => hide()}
      onPointerDown={() => hide(true)}
      onFocus={(e) => (e.target as HTMLElement).matches?.(":focus-visible") && show(true)}
      onBlur={() => hide(true)}
      aria-describedby={child ? undefined : describedBy}
    >
      {trigger}
      {portalHost &&
        createPortal(
          <div
            ref={floatingRef}
            id={id}
            role="tooltip"
            data-side={placement}
            data-state={closing ? "closed" : "open"}
            data-warm={warm.current || undefined}
            style={style}
            className={cn(
              "pointer-events-none z-[70] w-max max-w-64 rounded-[8px] bg-foreground px-2 py-1 text-xs leading-[1.35] font-medium text-background",
              "shadow-[0_6px_20px_-8px_rgb(0_0_0/0.35)]",
              FLOAT_FADE,
              "data-[warm=true]:transition-none",
            )}
          >
            {content}
            {description && <div className="mt-0.5 font-normal text-background/70">{description}</div>}
          </div>,
          portalHost,
        )}
    </span>
  );
}
