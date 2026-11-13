"use client";
/** @registry name="dialog" type="ui" title="Dialog" description="Modal on the native dialog element." */

import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { Button } from "./button";

/*
 * Motion, all CSS: the panel fades in from 4px below and goes back the same way on close (the native dialog
 * stays painted through `overlay` / `display` with allow-discrete). As a bottom sheet (phones) it slides from
 * and back to the bottom edge. Reduced motion: opacity only.
 */
const MOTION = `
[data-kn-dialog]{opacity:1;translate:0 0;transition:opacity var(--kn-dur,180ms) var(--kn-ease-out,cubic-bezier(.22,1,.36,1)),translate var(--kn-dur,180ms) var(--kn-ease-out,cubic-bezier(.22,1,.36,1)),overlay var(--kn-dur,180ms) allow-discrete,display var(--kn-dur,180ms) allow-discrete}
[data-kn-dialog]:not([open]){opacity:0;translate:0 4px;transition-duration:var(--kn-dur-fast,120ms)}
@starting-style{[data-kn-dialog][open]{opacity:0;translate:0 4px}}
[data-kn-dialog]::backdrop{opacity:1;transition:opacity var(--kn-dur,180ms) var(--kn-ease-out,cubic-bezier(.22,1,.36,1)),overlay var(--kn-dur,180ms) allow-discrete,display var(--kn-dur,180ms) allow-discrete}
[data-kn-dialog]:not([open])::backdrop{opacity:0;transition-duration:var(--kn-dur-fast,120ms)}
@starting-style{[data-kn-dialog][open]::backdrop{opacity:0}}
@media (max-width:639px){
  [data-kn-dialog][data-sheet]{opacity:1;translate:0 0}
  [data-kn-dialog][data-sheet]:not([open]){opacity:1;translate:0 100%}
  @starting-style{[data-kn-dialog][data-sheet][open]{opacity:1;translate:0 100%}}
}
@media (prefers-reduced-motion:reduce){
  [data-kn-dialog],[data-kn-dialog]:not([open]),[data-kn-dialog]::backdrop,[data-kn-dialog]:not([open])::backdrop{translate:0 0!important;transition-duration:0s!important}
  [data-kn-dialog]:not([open]){opacity:0!important}
}
`;

/**
 * Modal dialog on the native <dialog> element: focus is trapped and Escape closes it
 * for free. Controlled with `open` / `onOpenChange`.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  className,
  bodyClassName,
  sheet,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Usually the actions, e.g. Cancel / Confirm buttons. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Replaces the default body padding ("px-5 py-2"), e.g. for a list that scrolls edge to edge. */
  bodyClassName?: string;
  /** Below 640px, open as a bottom sheet: full width, rounded top, slides up. */
  sheet?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // showModal() focuses the first focusable element; prefer one marked data-autofocus.
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <>
    <style href="kn-dialog" precedence="default">
      {MOTION}
    </style>
    <dialog
      ref={ref}
      data-kn-dialog
      data-sheet={sheet || undefined}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onOpenChange(false);
      }}
      onClick={(e) => {
        // Click on the backdrop (the dialog element itself, outside the panel) closes it.
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
      className={cn(
        "m-auto w-[calc(100%-2rem)] rounded-2xl border bg-popover p-0 text-[13.5px] text-popover-foreground shadow-[0_24px_64px_-16px_rgb(0_0_0/0.35)]",
        "backdrop:bg-black/40 backdrop:backdrop-blur-[2px]",
        size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-md",
        sheet && [
          "max-sm:mx-0 max-sm:mt-auto max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:pb-[env(safe-area-inset-bottom)]",
        ].join(" "),
        className,
      )}
    >
      <div className="flex flex-none items-start gap-3 px-5 pb-2 pt-5">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
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
      {children && <div className={bodyClassName ?? "px-5 py-2"}>{children}</div>}
      {footer && <div className={cn("mt-2 flex flex-none justify-end gap-2 rounded-b-2xl border-t bg-muted/30 px-5 py-3", sheet && "max-sm:rounded-b-none")}>{footer}</div>}
    </dialog>
    </>
  );
}
