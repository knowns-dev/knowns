"use client";
/** @registry name="button" type="ui" title="Button" description="Primary, secondary, ghost and destructive buttons with icons, three sizes and a loading state that stays focusable." */

import { cva } from "class-variance-authority";
import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { Spinner } from "./spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive" | "quiet";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  // Dark chip in light mode, light chip in dark mode, with a thin top light for depth. Reads --kn-accent (default --primary).
  primary:
    "bg-[color:var(--kn-accent,var(--primary))] text-[color:var(--kn-accent-foreground,var(--primary-foreground))] shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(0_0_0/0.14),0_2px_6px_-2px_rgb(0_0_0/0.18)] not-disabled:hover:bg-[color:var(--kn-accent,var(--primary))]/90 disabled:bg-transparent disabled:text-foreground disabled:shadow-[0_0_0_1px_var(--border)] dark:disabled:shadow-[0_0_0_1px_var(--border)] dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.6),0_1px_2px_rgb(0_0_0/0.4)]",
  // Card chip with a hairline ring and a whisper of shadow.
  secondary:
    "bg-card text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/0.05)] not-disabled:hover:bg-[color-mix(in_srgb,var(--muted)_55%,var(--card))] dark:bg-[color-mix(in_srgb,var(--muted)_55%,var(--card))] dark:not-disabled:hover:bg-muted",
  ghost: "text-muted-foreground not-disabled:hover:bg-[color-mix(in_srgb,var(--muted)_70%,transparent)] not-disabled:hover:text-foreground",
  // Soft red with a faint ring: serious without shouting.
  destructive:
    "bg-red-500/[0.08] text-red-700 shadow-[0_0_0_1px_rgb(239_68_68/0.16)] not-disabled:hover:bg-red-500/[0.13] dark:bg-red-500/12 dark:text-red-300 dark:shadow-[0_0_0_1px_rgb(248_113_113/0.2)] dark:not-disabled:hover:bg-red-500/18",
  // Inline text action ("Show more", "Add back"): no chip, no lift, just muted ink that brightens.
  quiet: "text-muted-foreground not-disabled:hover:text-foreground",
};

// 24 / 28 / 32 / 36px high with generous side padding; taller on touch screens.
const SIZE: Record<ButtonSize, string> = {
  xs: "h-6 gap-1 rounded-[7px] px-2 text-[12px] [&_svg]:size-3.5 pointer-coarse:h-8",
  sm: "h-7 gap-1.5 rounded-[8px] px-3 text-[12.5px] [&_svg]:size-3.5 pointer-coarse:h-9",
  md: "h-8 gap-2 rounded-[9px] px-3.5 text-[13.5px] [&_svg]:size-4 pointer-coarse:h-10",
  lg: "h-9 gap-2 rounded-[10px] px-4.5 text-sm [&_svg]:size-[17px] pointer-coarse:h-11",
};
const SQUARE: Record<ButtonSize, string> = {
  xs: "w-6 px-0 pointer-coarse:w-8",
  sm: "w-7 px-0 pointer-coarse:w-9",
  md: "w-8 px-0 pointer-coarse:w-10",
  lg: "w-9 px-0 pointer-coarse:w-11",
};

// Quiet buttons sit in running text: no fixed height, just a hair of padding for the focus ring.
const QUIET_SIZE: Record<ButtonSize, string> = {
  xs: "gap-1 rounded-[5px] px-0.5 text-[12px] [&_svg]:size-3",
  sm: "gap-1 rounded-[5px] px-0.5 text-[12.5px] [&_svg]:size-3.5",
  md: "gap-1.5 rounded-[6px] px-0.5 text-[13.5px] [&_svg]:size-4",
  lg: "gap-1.5 rounded-[6px] px-0.5 text-sm [&_svg]:size-[17px]",
};

const SIZES = ["xs", "sm", "md", "lg"] as const;
const CHIPS = ["primary", "secondary", "ghost", "destructive"] as const;

/**
 * The button look as a cva map: add a variant of your own here (a `brand` entry under `variant`) and use it as
 * `<Button variant="brand">`, or call it on a link: `<a className={buttonVariants({ variant: "secondary" })}>`.
 * The primary variant takes its colour from `--kn-accent` (default `--primary`).
 */
export const buttonVariants = cva(
  [
    "inline-flex flex-none cursor-pointer items-center justify-center overflow-hidden font-medium tracking-[0.005em] whitespace-nowrap select-none",
    "transition-[background-color,color,box-shadow,scale] duration-[var(--kn-dur-fast,120ms)] ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))]",
    "disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:flex-none",
    focusRing,
  ],
  {
    variants: {
      variant: VARIANT,
      size: { xs: "", sm: "", md: "", lg: "" },
      square: { true: "", false: "" },
    },
    compoundVariants: [
      // Chips shrink a touch while pressed (a button is clicked all day: no hover lift); quiet buttons do not.
      { variant: [...CHIPS], class: "not-disabled:active:scale-[.97] motion-reduce:transform-none" },
      ...SIZES.flatMap((size) => [
        { variant: [...CHIPS], size, class: SIZE[size] },
        { variant: "quiet" as const, size, class: QUIET_SIZE[size] },
        { variant: [...CHIPS], size, square: true, class: SQUARE[size] },
      ]),
    ],
    defaultVariants: { variant: "primary", size: "md", square: false },
  },
);

/** Classes for the button look, e.g. on a link: `<a className={buttonClass("secondary")}>`. */
export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", square = false, className?: string) {
  return cn(buttonVariants({ variant, size, square }), className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Swaps the left icon for a spinner and sweeps a band across the label. The button stays
   * focusable and announces aria-busy; clicks are ignored.
   */
  loading?: boolean;
  /** Icon before the label. Without children the button becomes square (give it an aria-label). */
  icon?: ReactNode;
  /** Icon after the label. */
  iconRight?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  iconRight,
  className,
  children,
  onClick,
  type = "button",
  ...rest
}: ButtonProps) {
  const square = children === undefined || children === null || children === false;
  const left = loading ? <Spinner className="size-[1.1em]" label="" /> : icon;
  return (
    <button
      type={type}
      aria-busy={loading || undefined}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        if (loading) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      // "relative" only while loading (for the sweep), so callers can position the button absolutely.
      className={buttonClass(variant, size, square, cn(loading && "relative cursor-progress", className))}
      {...rest}
    >
      {left && <span aria-hidden="true" className="contents">{left}</span>}
      {!square && <span className="relative">{children}</span>}
      {iconRight && <span aria-hidden="true" className="contents">{iconRight}</span>}
      {loading && !square && (
        // A soft band sweeping across the label while it works.
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 bg-linear-to-r from-transparent via-[color-mix(in_srgb,var(--background)_45%,transparent)] to-transparent animate-[kn-shimmer_1.3s_ease-in-out_infinite] motion-reduce:hidden"
        />
      )}
    </button>
  );
}
