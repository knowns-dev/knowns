"use client";
/** @registry name="avatar" type="ui" title="Avatar" description="Image, logo or initials with status dot, badge and verified mark; AvatarGroup with +N and invite; AvatarLabel with name and supporting text." */

import { Children, cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { Tooltip } from "./tooltip";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
export type AvatarStatus = "online" | "offline" | "busy" | "away";

export interface AvatarProps {
  /** Used for the initials fallback and the accessible name. */
  label: string;
  /** Photo. If it fails to load, the avatar falls back to `icon`, then initials. */
  src?: string;
  /** Logo or glyph shown instead of initials. */
  icon?: ReactNode;
  /** Letters to show instead of the ones taken from `label`, e.g. one letter for a workspace. */
  initials?: string;
  size?: AvatarSize;
  shape?: "square" | "circle";
  /** Tint for glyphs and initials, e.g. an agent colour. */
  hue?: string;
  /** Presence dot, bottom-right. Included in the accessible name ("Ada Lovelace, online"). */
  status?: AvatarStatus;
  /** Small mark on the corner, e.g. a company or model logo. Moves the status dot to the top. */
  badge?: ReactNode;
  /** A small check mark on the corner (used when there is no `badge`). Announced as "verified". */
  verified?: boolean;
  /**
   * A ring in the surface colour around the avatar, to separate it from neighbours in a stack.
   * The dot, badge and ring use `--avatar-ring` (default `var(--background)`); set it when the avatar sits on a card.
   */
  ring?: boolean;
  /** Hide from assistive tech when the name is already next to it. */
  decorative?: boolean;
  className?: string;
}

/* Box, type and corner radius per size. xs–lg keep their original look. */
const SIZE: Record<AvatarSize, string> = {
  xs: "size-5 text-[9px] rounded-md",
  sm: "size-6 text-[10px] rounded-md",
  md: "size-8 text-xs rounded-lg",
  lg: "size-11 text-sm rounded-xl",
  xl: "size-14 text-base rounded-2xl",
  "2xl": "size-18 text-xl rounded-[20px]",
};
/* Presence dot diameter, ~a fifth of the avatar. */
const DOT: Record<AvatarSize, string> = {
  xs: "size-1.5",
  sm: "size-[7px]",
  md: "size-2.5",
  lg: "size-3",
  xl: "size-3.5",
  "2xl": "size-4",
};
/* Corner badge, ~two fifths of the avatar. */
const BADGE: Record<AvatarSize, string> = {
  xs: "size-2.5 rounded-[3px]",
  sm: "size-3 rounded-[4px]",
  md: "size-3.5 rounded-[5px]",
  lg: "size-[18px] rounded-md",
  xl: "size-[22px] rounded-[7px]",
  "2xl": "size-[26px] rounded-lg",
};
/* How far each avatar slides under the previous one in a group. */
const OVERLAP: Record<AvatarSize, string> = {
  xs: "-ml-1",
  sm: "-ml-1.5",
  md: "-ml-2",
  lg: "-ml-3",
  xl: "-ml-3.5",
  "2xl": "-ml-4.5",
};

const STATUS_DOT: Record<AvatarStatus, string> = {
  online: "bg-emerald-500",
  busy: "bg-red-500",
  away: "bg-amber-400",
  // Hollow grey: present in the UI, absent in person.
  offline: "bg-[color-mix(in_srgb,var(--foreground)_28%,var(--background))]",
};
const STATUS_TEXT: Record<AvatarStatus, string> = { online: "online", offline: "offline", busy: "busy", away: "away" };

/** Two letters: first + second word ("Ada Lovelace" → "AL"), else the first two characters. */
export function initials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  return (parts.length > 1 ? [...parts[0]][0] + [...parts[1]][0] : [...parts[0]].slice(0, 2).join("")).toUpperCase();
}

/** Accessible name: the label plus anything only shown visually ("Ada Lovelace, online, verified"). */
export function avatarName(label: string, status?: AvatarStatus, verified?: boolean): string {
  // An unnamed avatar with no status still needs a name, or role="img" is announced as nothing.
  return [label, status && STATUS_TEXT[status], verified && "verified"].filter(Boolean).join(", ") || "Unknown";
}

/** How many avatars a group shows and how many fold into "+N". Never folds a single item ("+1" is no shorter than the avatar). */
export function splitGroup(total: number, max?: number): { shown: number; hidden: number } {
  // "+1" takes the same room as the avatar it would hide, so show that one instead.
  if (max === undefined || max < 1 || total <= max + 1) return { shown: total, hidden: 0 };
  return { shown: max, hidden: total - max };
}

/** "Ada, Grace and Alan" */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const ringShadow = "shadow-[0_0_0_2px_var(--avatar-ring,var(--background))]";

const PersonGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
    <circle cx="8" cy="5.75" r="2.75" />
    <path d="M2.75 13.75c.9-2.4 2.9-3.75 5.25-3.75s4.35 1.35 5.25 3.75" />
  </svg>
);
const CheckGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m4.5 8.25 2.25 2.25 4.75-5" />
  </svg>
);

/** Whether the photo covers the avatar: it has a src that loaded and did not fail. The fallback hides then. */
export function photoShown(src: string | undefined, loaded: string | null, failed: string | null): boolean {
  return !!src && loaded === src && failed !== src;
}

export function Avatar({
  label,
  src,
  icon,
  initials: letters,
  size = "md",
  shape = "square",
  hue,
  status,
  badge,
  verified,
  ring,
  decorative,
  className,
}: AvatarProps) {
  // Track by URL so a new src gets a fresh try.
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const showImg = !!src && failed !== src;
  const text = letters ?? initials(label);
  const circle = shape === "circle";
  const corner = badge ?? (verified ? <CheckGlyph /> : null);

  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : avatarName(label, status, verified)}
      aria-hidden={decorative || undefined}
      style={hue ? { ["--hue" as string]: hue } : undefined}
      className={cn("relative inline-grid flex-none", SIZE[size], circle && "rounded-full!", className)}
    >
      <span
        className={cn(
          "relative grid size-full place-items-center overflow-hidden rounded-[inherit] border bg-muted/40 font-semibold",
          // Initials in the raw hue fall under 4.5:1 (emerald 2.5:1 on light); mixing in the foreground keeps the hue and passes in both themes.
          hue ? "text-[color-mix(in_srgb,var(--hue)_58%,var(--foreground))]" : "text-muted-foreground",
          ring && ringShadow,
        )}
      >
        {/* The fallback shows until the photo has loaded, then fades out as the photo fades in (no pop, and
            no letters left showing through a transparent or letterboxed photo). */}
        <span
          aria-hidden="true"
          data-avatar-fallback=""
          className={cn(
            "absolute inset-0 grid place-items-center transition-opacity duration-300 ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))] motion-reduce:transition-none",
            photoShown(src, loaded, failed) && "opacity-0",
          )}
        >
          {icon ? (
            <span className="grid size-[62%] place-items-center [&>*]:size-full [&>svg]:size-full">{icon}</span>
          ) : text ? (
            <span className="leading-none tracking-[0.02em]">{text}</span>
          ) : (
            <span className="grid size-[58%] place-items-center opacity-80 [&>svg]:size-full">
              <PersonGlyph />
            </span>
          )}
        </span>
        {showImg && (
          <img
            src={src}
            alt=""
            draggable={false}
            ref={(el) => {
              // Cached images can finish before React wires onLoad.
              if (el?.complete && el.naturalWidth > 0 && loaded !== src) setLoaded(src);
            }}
            onLoad={() => setLoaded(src)}
            onError={() => setFailed(src)}
            className={cn(
              "absolute inset-0 size-full bg-background object-cover transition-opacity duration-300 ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))] motion-reduce:transition-none",
              loaded === src ? "opacity-100" : "opacity-0",
            )}
          />
        )}
      </span>

      {status && (
        <span
          aria-hidden
          className={cn(
            "absolute rounded-full",
            ringShadow,
            DOT[size],
            STATUS_DOT[status],
            // On a circle the dot sits on the curve; on a rounded square it tucks into the corner.
            corner ? (circle ? "top-0 right-0" : "-top-0.5 -right-0.5") : circle ? "right-0 bottom-0" : "-right-0.5 -bottom-0.5",
          )}
        />
      )}

      {corner && (
        <span
          aria-hidden
          className={cn(
            "absolute grid place-items-center overflow-hidden",
            ringShadow,
            BADGE[size],
            circle ? "-right-0.5 -bottom-0.5 rounded-full" : "-right-1 -bottom-1",
            badge ? "bg-card p-[12%] text-foreground [&>*]:size-full [&>svg]:size-full" : "bg-sky-500 p-[14%] text-white [&>svg]:size-full",
          )}
        >
          {corner}
        </span>
      )}
    </span>
  );
}

/* ── Group ── */

export interface AvatarGroupProps {
  /** Avatar elements. Size, shape and the separating ring are applied for you. */
  children: ReactNode;
  /** Show at most this many; the rest fold into a "+N" tile whose tooltip lists them. */
  max?: number;
  size?: AvatarSize;
  shape?: "square" | "circle";
  /** Accessible name for the group. Default "N people". */
  label?: string;
  /** Shows a dashed "+" button at the end. */
  onAdd?: () => void;
  /** Tooltip and accessible name for the add button. Default "Add people". */
  addLabel?: string;
  className?: string;
}

/** Overlapping stack of avatars with an overflow count and an optional add button. */
export function AvatarGroup({ children, max, size = "md", shape = "circle", label, onAdd, addLabel = "Add people", className }: AvatarGroupProps) {
  const items = Children.toArray(children).filter((c): c is ReactElement<AvatarProps> => isValidElement(c));
  const { shown, hidden } = splitGroup(items.length, max);
  const rest = items.slice(shown).map((c) => c.props.label);
  const circle = shape === "circle";

  return (
    <div role="group" aria-label={label ?? `${items.length} ${items.length === 1 ? "person" : "people"}`} className={cn("flex items-center", className)}>
      {items.slice(0, shown).map((child, i) => (
        <span
          key={child.key ?? i}
          className={cn(
            "relative inline-grid transition-[translate] duration-200 ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))] hover:z-10 hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0",
            i > 0 && OVERLAP[size],
          )}
        >
          {cloneElement(child, { size, shape, ring: true })}
        </span>
      ))}

      {hidden > 0 && (
        <Tooltip content={listNames(rest)} className={OVERLAP[size]}>
          <span
            tabIndex={0}
            role="img"
            aria-label={`${hidden} more: ${listNames(rest)}`}
            className={cn(
              "grid place-items-center bg-muted font-semibold text-muted-foreground tabular-nums",
              ringShadow,
              SIZE[size],
              circle && "rounded-full!",
              focusRing,
            )}
          >
            +{hidden}
          </span>
        </Tooltip>
      )}

      {onAdd && (
        <Tooltip content={addLabel} className="ml-1.5">
          <button
            type="button"
            aria-label={addLabel}
            onClick={onAdd}
            className={cn(
              "grid cursor-pointer place-items-center border border-dashed border-[color-mix(in_srgb,var(--foreground)_24%,transparent)] text-muted-foreground",
              "transition-[color,background-color,border-color] duration-200 ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))]",
              "hover:border-[color-mix(in_srgb,var(--foreground)_40%,transparent)] hover:bg-muted/60 hover:text-foreground",
              "[&>svg]:size-[45%]",
              SIZE[size],
              circle && "rounded-full!",
              focusRing,
            )}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
              <path d="M8 3.5v9M3.5 8h9" />
            </svg>
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/* ── Avatar + name ── */

export interface AvatarLabelProps extends Omit<AvatarProps, "size" | "decorative"> {
  /** Supporting line under the name, e.g. an email or a role. */
  description?: ReactNode;
  size?: "sm" | "md" | "lg";
}

const LABEL_SIZE = {
  sm: { avatar: "sm", gap: "gap-2", name: "text-[12.5px]", desc: "text-[11.5px]" },
  md: { avatar: "md", gap: "gap-2.5", name: "text-[13.5px]", desc: "text-[12.5px]" },
  lg: { avatar: "lg", gap: "gap-3", name: "text-[15px]", desc: "text-[13px]" },
} as const;

/** An avatar with the name and an optional supporting line beside it. */
export function AvatarLabel({ label, description, size = "md", className, ...avatar }: AvatarLabelProps) {
  const s = LABEL_SIZE[size];
  const extra = avatarName("", avatar.status, avatar.verified);
  return (
    <span className={cn("inline-flex min-w-0 items-center", s.gap, className)}>
      {/* The visible name already names it; status and "verified" are spoken after it. */}
      <Avatar label={label} size={s.avatar} decorative {...avatar} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className={cn("truncate font-medium text-foreground", s.name)}>
          {label}
          {extra && <span className="sr-only">, {extra}</span>}
        </span>
        {description && <span className={cn("truncate text-muted-foreground", s.desc, size !== "sm" && "mt-0.5")}>{description}</span>}
      </span>
    </span>
  );
}

export default Avatar;
