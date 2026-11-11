"use client";
/** @registry name="segmented-control" type="ui" title="Segmented control" description="Mutually exclusive options with a sliding thumb." */

import { cva } from "class-variance-authority";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";

export interface SegmentedOption {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  /** `role="tablist"` only: the id of this tab, so a panel can point back with aria-labelledby. */
  id?: string;
  /** `role="tablist"` only: the id of the panel this tab controls (aria-controls). */
  controls?: string;
}

export type SegmentedTone = "neutral" | "accent";

/** The sliding thumb as a cva map. `accent` fills it with `--kn-accent` (default `--primary`) and the chosen label with `--kn-accent-foreground`. */
export const segmentedThumbVariants = cva("absolute inset-y-0.5 left-0.5 rounded-[8px] transition-[translate] duration-[var(--kn-dur-fast,120ms)] ease-[var(--kn-ease-inout,cubic-bezier(.65,0,.35,1))] motion-reduce:transition-none", {
  variants: {
    tone: {
      neutral: "bg-card shadow-[0_0_0_1px_var(--border),0_1px_3px_rgb(0_0_0/0.08)] dark:bg-[color-mix(in_srgb,var(--foreground)_12%,var(--card))]",
      accent: "bg-[color:var(--kn-accent,var(--primary))] shadow-[0_1px_3px_rgb(0_0_0/0.12)]",
    },
  },
  defaultVariants: { tone: "neutral" },
});

/** A row of mutually exclusive options (role="radiogroup") with a sliding thumb. */
export function SegmentedControl({
  options,
  value,
  defaultValue,
  onValueChange,
  size = "md",
  tone = "neutral",
  role = "radiogroup",
  disabled,
  className,
  "aria-label": label,
}: {
  options: SegmentedOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  size?: "sm" | "md";
  /** `accent` fills the selected segment with --kn-accent. */
  tone?: SegmentedTone;
  /**
   * `radiogroup` (default): a choice. `tablist`: the options are tabs that switch a panel; give each option an
   * `id` and `controls`, and mark the panel role="tabpanel" with aria-labelledby. Same thumb, same arrow keys.
   */
  role?: "radiogroup" | "tablist";
  /** Shows the current value but takes no input. */
  disabled?: boolean;
  className?: string;
  "aria-label": string;
}) {
  const [own, setOwn] = useState(defaultValue ?? options[0]?.value);
  const current = value ?? own;
  const name = useId();
  const ref = useRef<HTMLDivElement>(null);
  const tabs = role === "tablist";
  const index = Math.max(0, options.findIndex((o) => o.value === current));
  const set = (v: string) => {
    if (disabled) return;
    if (value === undefined) setOwn(v);
    onValueChange?.(v);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.key === "Home" || e.key === "End") && !disabled) {
      e.preventDefault();
      const edge = options[e.key === "Home" ? 0 : options.length - 1];
      set(edge.value);
      ref.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(edge.value)}"]`)?.focus();
      return;
    }
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d || disabled) return;
    e.preventDefault();
    const next = options[(index + d + options.length) % options.length];
    set(next.value);
    ref.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  };
  return (
    <div
      ref={ref}
      role={role}
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={cn("relative inline-grid auto-cols-fr grid-flow-col rounded-[10px] bg-muted p-0.5", disabled && "opacity-55", className)}
    >
      <span
        aria-hidden="true"
        style={{ width: `calc((100% - 4px) / ${options.length})`, translate: `calc(${index} * 100%) 0` }}
        className={segmentedThumbVariants({ tone })}
      />
      {options.map((o) => {
        const on = o.value === current;
        return (
          <button
            key={o.value}
            type="button"
            id={tabs ? o.id : undefined}
            role={tabs ? "tab" : "radio"}
            aria-checked={tabs ? undefined : on}
            aria-selected={tabs ? on : undefined}
            aria-controls={tabs ? o.controls : undefined}
            data-value={o.value}
            name={tabs ? undefined : name}
            disabled={disabled}
            tabIndex={on ? 0 : -1}
            onClick={() => set(o.value)}
            className={cn(
              "relative z-10 inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-[8px] font-medium whitespace-nowrap transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) [&_svg]:size-3.5",
              size === "sm" ? "h-6 px-2.5 text-xs pointer-coarse:h-8" : "h-7 px-3 text-[13px] pointer-coarse:h-9",
              on ? (tone === "accent" ? "text-[color:var(--kn-accent-foreground,var(--primary-foreground))]" : "text-foreground") : "text-muted-foreground",
              !on && !disabled && "hover:text-foreground",
              disabled && "cursor-not-allowed",
              focusRing,
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
