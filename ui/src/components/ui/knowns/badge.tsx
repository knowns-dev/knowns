"use client";
/** @registry name="badge" type="ui" title="Badge" description="Status labels in six tones: sizes, pill shape, icons, clickable and removable badges, and BadgeGroup with +N overflow." */

import {
  Children,
  isValidElement,
  useState,
  type HTMLAttributes,
  type MouseEvent,
  type MouseEventHandler,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { Tooltip } from "./tooltip";

export type BadgeTone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";
export type BadgeVariant = "soft" | "outline" | "solid";
export type BadgeSize = "sm" | "md" | "lg";
export type BadgeShape = "rounded" | "pill";

const SOFT: Record<BadgeTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  accent: "bg-[color:var(--kn-accent,var(--color-indigo-500))]/12 text-[color:var(--kn-accent,var(--color-indigo-700))] dark:text-[color:var(--kn-accent,var(--color-indigo-300))]",
  info: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  success: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  warning: "bg-amber-500/14 text-amber-800 dark:text-amber-300",
  danger: "bg-red-500/12 text-red-700 dark:text-red-300",
};
const OUTLINE: Record<BadgeTone, string> = {
  neutral: "border-border text-muted-foreground",
  accent: "border-[color:var(--kn-accent,var(--color-indigo-500))]/35 text-[color:var(--kn-accent,var(--color-indigo-700))] dark:text-[color:var(--kn-accent,var(--color-indigo-300))]",
  info: "border-sky-500/35 text-sky-700 dark:text-sky-300",
  success: "border-emerald-500/35 text-emerald-700 dark:text-emerald-300",
  warning: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  danger: "border-red-500/35 text-red-700 dark:text-red-300",
};
const SOLID: Record<BadgeTone, string> = {
  neutral: "bg-foreground text-background",
  accent: "bg-[color:var(--kn-accent,var(--color-indigo-600))] text-[color:var(--kn-accent-foreground,white)]",
  info: "bg-sky-600 text-white",
  success: "bg-emerald-600 text-white",
  warning: "bg-amber-500 text-amber-950",
  danger: "bg-red-600 text-white",
};
const DOT: Record<BadgeTone, string> = {
  neutral: "bg-muted-foreground",
  accent: "bg-[color:var(--kn-accent,var(--color-indigo-500))]",
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
};

/* md is the original badge, unchanged. */
const SIZE: Record<BadgeSize, string> = {
  sm: "h-5 gap-1 px-1.5 text-[11px] [&_svg]:size-2.5",
  md: "h-5.5 gap-1.5 px-1.5 text-[11.5px] [&_svg]:size-3",
  lg: "h-6.5 gap-1.5 px-2 text-[12.5px] [&_svg]:size-3.5",
};
const RADIUS: Record<BadgeSize, string> = { sm: "rounded-[5px]", md: "rounded-md", lg: "rounded-[7px]" };
/* Pills get a touch more side room so the ends don't crowd the text. */
const PILL_PAD: Record<BadgeSize, string> = { sm: "px-2", md: "px-2", lg: "px-2.5" };
/* With an × last, the right padding tucks in so the button sits in the corner. */
const REMOVABLE_PAD: Record<BadgeSize, string> = { sm: "pr-0.5", md: "pr-0.5", lg: "pr-1" };
const ICON: Record<BadgeSize, string> = { sm: "size-3", md: "size-3.5", lg: "size-4" };
const DOT_SIZE: Record<BadgeSize, string> = { sm: "size-1.25", md: "size-1.5", lg: "size-1.75" };
const REMOVE: Record<BadgeSize, string> = { sm: "size-4 [&_svg]:size-2.5", md: "size-4.5 [&_svg]:size-3", lg: "size-5 [&_svg]:size-3" };

const ease = "transition-[background-color,border-color,color,box-shadow,opacity] duration-200 ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))] motion-reduce:transition-none";
/* Interactive badges: a quiet lift of the fill, using the badge's own text colour so every tone works. */
const PRESSABLE = "cursor-pointer hover:shadow-[inset_0_0_0_999px_color-mix(in_srgb,currentColor_9%,transparent)] active:shadow-[inset_0_0_0_999px_color-mix(in_srgb,currentColor_15%,transparent)]";

/** Plain text of a React node, for accessible names ("Remove Beta") and tooltips. */
export function badgeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(badgeText).join("");
  if (isValidElement(node)) return badgeText((node.props as { children?: ReactNode }).children);
  return "";
}

export interface BadgeProps extends Omit<HTMLAttributes<HTMLElement>, "onClick"> {
  tone?: BadgeTone;
  variant?: BadgeVariant;
  /** Leading dot in the tone colour. */
  dot?: boolean;
  /** "sm" 20px, "md" 22px (default), "lg" 26px. */
  size?: BadgeSize;
  /** "rounded" (default) or a full "pill". */
  shape?: BadgeShape;
  /** Leading glyph, logo or tiny avatar (e.g. `modelIcon("Sonnet")`, `<Avatar size="xs" decorative />`). Sized to the badge. */
  icon?: ReactNode;
  /** Makes the badge a button (focusable, with a focus ring). */
  onClick?: MouseEventHandler<HTMLElement>;
  /** Adds a small × button. Clicking it never triggers `onClick`. */
  onRemove?: () => void;
  /** Accessible name of the × button. Default "Remove <label text>". */
  removeLabel?: string;
  /** For interactive or removable badges. */
  disabled?: boolean;
  ref?: Ref<HTMLElement>;
}

function RemoveGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="m5 5 6 6m0-6-6 6" />
    </svg>
  );
}

/**
 * A small label for state or metadata: soft, outline or solid, in six tones. Optional dot, icon,
 * click action and × remove. For values people type or pick (filters, recipients), use Tag.
 */
export function Badge({
  tone = "neutral",
  variant = "soft",
  dot,
  size = "md",
  shape = "rounded",
  icon,
  onClick,
  onRemove,
  removeLabel,
  disabled,
  className,
  children,
  ref,
  ...rest
}: BadgeProps) {
  const pill = shape === "pill";
  const look = cn(
    "inline-flex items-center font-medium whitespace-nowrap tabular-nums",
    SIZE[size],
    pill ? cn("rounded-full", PILL_PAD[size]) : RADIUS[size],
    variant === "soft" && SOFT[tone],
    variant === "outline" && cn("border", OUTLINE[tone]),
    variant === "solid" && SOLID[tone],
    (onClick || onRemove) && ease,
    disabled && "opacity-50",
  );
  const body = (
    <>
      {dot && <span aria-hidden="true" className={cn("flex-none rounded-full", DOT_SIZE[size], variant === "solid" ? "bg-current" : DOT[tone])} />}
      {icon && (
        <span aria-hidden="true" className={cn("-ml-0.5 grid flex-none place-items-center overflow-hidden [&>*]:size-full [&_svg]:size-full!", ICON[size], pill && "rounded-full")}>
          {icon}
        </span>
      )}
      {children}
    </>
  );

  /* Clickable, no ×: the whole badge is the button. */
  if (onClick && !onRemove) {
    return (
      <button
        type="button"
        ref={ref as Ref<HTMLButtonElement>}
        onClick={onClick}
        disabled={disabled}
        className={cn(look, PRESSABLE, "disabled:pointer-events-none", focusRing, className)}
        {...rest}
      >
        {body}
      </button>
    );
  }

  const remove = onRemove && (
    <button
      type="button"
      disabled={disabled}
      aria-label={removeLabel ?? `Remove ${badgeText(children)}`.trim()}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onRemove();
      }}
      className={cn(
        "-my-1 grid flex-none cursor-pointer place-items-center opacity-70",
        pill ? "rounded-full" : "rounded-[4px]",
        "transition-[background-color,opacity] duration-150 ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))] hover:bg-[color-mix(in_srgb,currentColor_14%,transparent)] hover:opacity-100",
        "disabled:pointer-events-none pointer-coarse:size-6",
        REMOVE[size],
        focusRing,
      )}
    >
      <RemoveGlyph />
    </button>
  );

  return (
    <span ref={ref as Ref<HTMLSpanElement>} className={cn(look, onRemove && REMOVABLE_PAD[size], className)} {...rest}>
      {onClick ? (
        /* Clickable and removable: two sibling buttons, never one inside the other. */
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          className={cn("-my-1 -ml-1 inline-flex items-center gap-[inherit] self-stretch rounded-[inherit] py-1 pl-1 text-inherit", PRESSABLE, "disabled:pointer-events-none", focusRing)}
        >
          {body}
        </button>
      ) : (
        body
      )}
      {remove}
    </span>
  );
}

/* ── Group ── */

/** How many badges a group shows and how many fold into "+N". Never folds a single badge ("+1" is no shorter). */
export function splitBadges(total: number, max?: number): { shown: number; hidden: number } {
  if (max === undefined || max < 0 || total <= max + 1) return { shown: total, hidden: 0 };
  return { shown: max, hidden: total - max };
}

export interface BadgeGroupProps {
  children: ReactNode;
  /** Show at most this many; the rest fold into a "+N" badge whose tooltip lists them. Click it to show all. */
  max?: number;
  /** Size of the "+N" badge (match your badges). */
  size?: BadgeSize;
  shape?: BadgeShape;
  /** Names the group (role="group"). */
  "aria-label"?: string;
  className?: string;
}

/** A wrapping row of badges with an overflow count. */
export function BadgeGroup({ children, max, size = "md", shape = "rounded", "aria-label": label, className }: BadgeGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const all = Children.toArray(children).filter(isValidElement) as ReactElement<{ children?: ReactNode }>[];
  const { shown, hidden } = expanded ? { shown: all.length, hidden: 0 } : splitBadges(all.length, max);
  const rest = all.slice(shown).map((b) => badgeText(b.props.children)).filter(Boolean);

  return (
    <div role={label ? "group" : undefined} aria-label={label} className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {all.slice(0, shown)}
      {hidden > 0 && (
        <Tooltip content={rest.join(", ")}>
          <Badge
            size={size}
            shape={shape}
            variant="outline"
            aria-label={`Show ${hidden} more: ${rest.join(", ")}`}
            onClick={() => setExpanded(true)}
          >
            +{hidden}
          </Badge>
        </Tooltip>
      )}
    </div>
  );
}

export default Badge;
