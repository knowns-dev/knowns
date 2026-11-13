"use client";
/** @registry name="popover" type="ui" title="Popover" description="Floating panel that closes on Escape or an outside click and returns focus." */

import { cloneElement, useEffect, useId, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/ui/lib/knowns/utils";
import { FLOAT_FADE, setRefs, useFloating } from "./use-floating";

const TABBABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

const tabbables = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.getClientRects().length > 0);

type TriggerProps = { onClick?: (e: unknown) => void; "aria-expanded"?: boolean; "aria-controls"?: string; "aria-haspopup"?: string; ref?: Ref<HTMLElement> };

/**
 * Floating panel opened by a trigger. Closes on Escape or a click outside and returns focus to the
 * trigger. `trigger` must be a single element that accepts onClick and a ref. The panel renders in a
 * portal with fixed positioning (flips when there is no room); Tab order continues as if it sat right
 * after the trigger.
 */
export function Popover({
  trigger,
  children,
  open: openProp,
  onOpenChange,
  side = "bottom",
  align = "start",
  className,
  focusOnOpen = true,
  "aria-label": label,
}: {
  trigger: ReactElement<TriggerProps>;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
  /** Move focus into the panel when it opens. Default true; false for a panel opened by hover, which must not steal focus. */
  focusOnOpen?: boolean;
  "aria-label"?: string;
}) {
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const set = (v: boolean) => {
    if (openProp === undefined) setOwn(v);
    onOpenChange?.(v);
  };
  const id = useId();
  const { triggerRef, floatingRef, style, placement, portalHost, ready, closing } = useFloating<HTMLElement, HTMLDivElement>({ open, side, align, offset: 8 });

  // Focus the first control once the panel is placed (it is visibility:hidden until then).
  useEffect(() => {
    if (!ready || !focusOnOpen) return;
    const panel = floatingRef.current;
    (panel && (tabbables(panel)[0] ?? panel))?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, floatingRef]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (floatingRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      set(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); // keep an enclosing <dialog> open
      set(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** The panel lives at the end of <body>: stitch it into the tab order right after the trigger. */
  const onPanelKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const panel = floatingRef.current;
    const t = triggerRef.current;
    if (!panel || !t) return;
    const inside = tabbables(panel);
    const first = inside[0] ?? panel;
    const last = inside[inside.length - 1] ?? panel;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      t.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      const all = tabbables(document).filter((el) => !panel.contains(el));
      const next = all[all.indexOf(t) + 1];
      set(false);
      (next ?? t).focus();
    }
  };

  const tp = trigger.props;
  return (
    <>
      {cloneElement(trigger, {
        ref: (node: HTMLElement | null) => setRefs(node, triggerRef, tp.ref),
        onClick: (e: unknown) => {
          tp.onClick?.(e);
          set(!open);
        },
        "aria-expanded": open,
        "aria-controls": open ? id : undefined,
        "aria-haspopup": "dialog",
      })}
      {portalHost &&
        createPortal(
          <div
            ref={floatingRef}
            id={id}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            data-side={placement}
            data-state={closing ? "closed" : "open"}
            style={style}
            onKeyDown={onPanelKey}
            className={cn(
              "z-[60] min-w-48 overflow-auto rounded-xl bg-popover p-3 text-[13px] text-popover-foreground outline-none",
              "shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_12%,transparent),0_12px_32px_-12px_rgb(0_0_0/0.3),0_2px_6px_rgb(0_0_0/0.06)]",
              FLOAT_FADE,
              className,
            )}
          >
            {children}
          </div>,
          portalHost,
        )}
    </>
  );
}
