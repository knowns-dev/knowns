"use client";
/** @registry name="tag" type="ui" title="Tag" description="Quiet chips and TagGroup with selection, removal and roving focus." */

import {
  isValidElement,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";

export type TagTone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";
export type TagSize = "sm" | "md";

/* Quieter than Badge: a card chip with a hairline; tones only tint the ring, the dot and a whisper of fill. */
const TONE: Record<TagTone, string> = {
  neutral: "bg-card shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_12%,transparent)] dark:bg-[color-mix(in_srgb,var(--muted)_45%,var(--card))]",
  accent: "bg-[color:var(--kn-accent,var(--color-indigo-500))]/[0.06] shadow-[0_0_0_1px_color-mix(in_srgb,var(--kn-accent,rgb(99_102_241))_22%,transparent)] dark:bg-[color:var(--kn-accent,var(--color-indigo-400))]/10",
  info: "bg-sky-500/[0.06] shadow-[0_0_0_1px_rgb(14_165_233/0.22)] dark:bg-sky-400/10",
  success: "bg-emerald-500/[0.06] shadow-[0_0_0_1px_rgb(16_185_129/0.22)] dark:bg-emerald-400/10",
  warning: "bg-amber-500/[0.07] shadow-[0_0_0_1px_rgb(245_158_11/0.26)] dark:bg-amber-400/10",
  danger: "bg-red-500/[0.06] shadow-[0_0_0_1px_rgb(239_68_68/0.22)] dark:bg-red-400/10",
};
const DOT: Record<TagTone, string> = {
  neutral: "bg-muted-foreground",
  accent: "bg-[color:var(--kn-accent,var(--color-indigo-500))]",
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
};
const SIZE: Record<TagSize, string> = {
  sm: "h-6 gap-1.5 rounded-[7px] px-2 text-[12px] [&_svg]:size-3",
  md: "h-7 gap-1.5 rounded-[8px] px-2.5 text-[13px] [&_svg]:size-3.5",
};
/* Pull the right padding in when the last thing is the × button, so it sits in the corner. */
const SIZE_REMOVABLE: Record<TagSize, string> = { sm: "pr-0.5", md: "pr-1" };
const AVATAR: Record<TagSize, string> = { sm: "size-4 -ml-1", md: "size-5 -ml-1.5" };
const SELECTED = "bg-[color-mix(in_srgb,var(--foreground)_8%,var(--card))] shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_38%,transparent)] text-foreground";

/** Plain text of a React node, for accessible names ("Remove Pricing"). */
export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

export interface TagProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  children: ReactNode;
  tone?: TagTone;
  /** Leading dot in the tone colour. */
  dot?: boolean;
  /** 12–14px glyph before the label. */
  icon?: ReactNode;
  /** A tiny avatar or logo before the label (e.g. an `<Avatar size="xs" decorative />`). */
  avatar?: ReactNode;
  /** Muted number after the label. */
  count?: number;
  /** Shows an × button. */
  onRemove?: () => void;
  /** Accessible name of the × button. Default "Remove <label text>". */
  removeLabel?: string;
  size?: TagSize;
  /** Selected look (TagGroup sets it). */
  selected?: boolean;
  disabled?: boolean;
  ref?: Ref<HTMLSpanElement>;
  /** @internal TagGroup makes the × mouse-only, since Delete removes the focused tag. */
  removeTabIndex?: number;
}

function RemoveGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <path d="m5 5 6 6m0-6-6 6" />
    </svg>
  );
}

/** A compact chip for a filter, a label or a piece of context. Quieter than Badge. */
export function Tag({
  children,
  tone = "neutral",
  dot,
  icon,
  avatar,
  count,
  onRemove,
  removeLabel,
  size = "md",
  selected,
  disabled,
  removeTabIndex,
  className,
  ...rest
}: TagProps) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 flex-none items-center font-medium whitespace-nowrap text-foreground/90 select-none",
        "transition-[background-color,box-shadow,color,opacity] duration-200 ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))]",
        SIZE[size],
        selected ? SELECTED : TONE[tone],
        onRemove && SIZE_REMOVABLE[size],
        disabled && "opacity-50",
        className,
      )}
      {...rest}
    >
      {avatar && <span aria-hidden className={cn("grid flex-none place-items-center overflow-hidden rounded-full [&>*]:size-full", AVATAR[size])}>{avatar}</span>}
      {dot && <span aria-hidden className={cn("size-1.5 flex-none rounded-full", DOT[tone])} />}
      {icon && <span aria-hidden className="grid flex-none place-items-center text-muted-foreground">{icon}</span>}
      <span className="min-w-0 truncate">{children}</span>
      {count !== undefined && <span className="flex-none text-muted-foreground tabular-nums">{count}</span>}
      {onRemove && (
        <button
          type="button"
          tabIndex={removeTabIndex}
          disabled={disabled}
          aria-label={removeLabel ?? `Remove ${textOf(children)}`.trim()}
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
            onRemove();
          }}
          className={cn(
            "grid flex-none cursor-pointer place-items-center rounded-[5px] text-muted-foreground",
            "transition-[background-color,color] duration-150 hover:bg-[color-mix(in_srgb,var(--foreground)_9%,transparent)] hover:text-foreground",
            "disabled:pointer-events-none",
            size === "sm" ? "size-5 [&_svg]:size-3" : "size-5.5 [&_svg]:size-3.5",
            "pointer-coarse:size-7",
            focusRing,
          )}
        >
          <RemoveGlyph />
        </button>
      )}
    </span>
  );
}

/* ── Group ── */

export interface TagItem {
  id: string;
  label: ReactNode;
  /** Text for the accessible name when `label` isn't plain text. */
  textValue?: string;
  tone?: TagTone;
  dot?: boolean;
  icon?: ReactNode;
  avatar?: ReactNode;
  count?: number;
  disabled?: boolean;
  /** Set false to keep this tag when the group is removable. */
  removable?: boolean;
}

export type TagSelectionMode = "none" | "single" | "multiple";

export interface TagGroupProps {
  items: TagItem[];
  "aria-label": string;
  /**
   * "none" (default): a list (role=list); tags are focusable only when removable.
   * "single" / "multiple": a listbox (role=listbox, options with aria-selected); Space or Enter toggles.
   */
  selectionMode?: TagSelectionMode;
  /** Selected ids (single mode uses at most one). */
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (ids: string[]) => void;
  /** Makes tags removable: × button, Backspace or Delete on the focused tag. */
  onRemove?: (ids: string[]) => void;
  /** Show at most this many; a "+N more" button reveals the rest. */
  max?: number;
  size?: TagSize;
  className?: string;
}

/** Next selection after toggling `id`. Single mode replaces (or clears when it was the selected one). */
export function toggleSelection(value: string[], id: string, mode: TagSelectionMode): string[] {
  if (mode === "none") return value;
  const on = value.includes(id);
  if (mode === "single") return on ? [] : [id];
  return on ? value.filter((v) => v !== id) : [...value, id];
}

/** Index to focus after the tag at `removed` goes away from a list of `length` (before removal). -1 when empty. */
export function focusAfterRemove(removed: number, length: number): number {
  const left = length - 1;
  if (left <= 0) return -1;
  return Math.min(removed, left - 1);
}

/**
 * A row of tags with roving focus (←/→, Home/End). Optionally selectable (single or multiple) and
 * removable (× or Backspace/Delete, focus moves to the next tag).
 */
export function TagGroup({
  items,
  "aria-label": label,
  selectionMode = "none",
  value: valueProp,
  defaultValue = [],
  onValueChange,
  onRemove,
  max,
  size = "md",
  className,
}: TagGroupProps) {
  const [own, setOwn] = useState(defaultValue);
  const value = valueProp ?? own;
  const setValue = useCallback(
    (v: string[]) => {
      if (valueProp === undefined) setOwn(v);
      onValueChange?.(v);
    },
    [valueProp, onValueChange],
  );

  const [expanded, setExpanded] = useState(false);
  const limited = max !== undefined && max >= 0 && !expanded && items.length > max + 1;
  const visible = limited ? items.slice(0, max) : items;
  const hidden = items.length - visible.length;

  const selectable = selectionMode !== "none";
  const removable = (it: TagItem) => !!onRemove && it.removable !== false && !it.disabled;
  // Tags are tab stops only when there is something to do with them.
  const interactive = selectable || !!onRemove;

  const [focus, setFocus] = useState(0);
  const refs = useRef<(HTMLElement | null)[]>([]);
  const pending = useRef<number | null>(null);
  const tabStop = Math.min(focus, visible.length - 1);

  /* After a removal, put focus on the tag that took its place. */
  useLayoutEffect(() => {
    if (pending.current === null) return;
    const i = pending.current;
    pending.current = null;
    if (i >= 0) refs.current[i]?.focus();
  }, [items]);

  const move = (i: number) => {
    const n = visible.length;
    if (!n) return;
    const next = ((i % n) + n) % n;
    setFocus(next);
    refs.current[next]?.focus();
  };

  const remove = (i: number) => {
    const it = visible[i];
    if (!it || !removable(it)) return;
    const next = focusAfterRemove(i, visible.length);
    pending.current = next;
    setFocus(Math.max(0, next));
    onRemove?.([it.id]);
  };

  const onKey = (e: KeyboardEvent<HTMLElement>, i: number) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        return move(i + 1);
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        return move(i - 1);
      case "Home":
        e.preventDefault();
        return move(0);
      case "End":
        e.preventDefault();
        return move(visible.length - 1);
      case "Backspace":
      case "Delete":
        if (onRemove) {
          e.preventDefault();
          remove(i);
        }
        return;
      case " ":
      case "Enter":
        if (selectable && !visible[i].disabled) {
          e.preventDefault();
          setValue(toggleSelection(value, visible[i].id, selectionMode));
        }
    }
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <div
        role={selectable ? "listbox" : "list"}
        aria-label={label}
        aria-multiselectable={selectionMode === "multiple" || undefined}
        aria-orientation={selectable ? "horizontal" : undefined}
        className="flex min-w-0 flex-wrap items-center gap-1.5"
      >
        {visible.map((it, i) => {
          const selected = selectable && value.includes(it.id);
          const name = it.textValue ?? textOf(it.label);
          return (
            <Tag
              key={it.id}
              ref={(el: HTMLSpanElement | null) => void (refs.current[i] = el)}
              role={selectable ? "option" : "listitem"}
              aria-selected={selectable ? selected : undefined}
              aria-disabled={it.disabled || undefined}
              aria-keyshortcuts={removable(it) ? "Delete" : undefined}
              tabIndex={interactive ? (i === tabStop ? 0 : -1) : undefined}
              onFocus={() => setFocus(i)}
              onKeyDown={interactive ? (e) => onKey(e, i) : undefined}
              onClick={selectable && !it.disabled ? () => setValue(toggleSelection(value, it.id, selectionMode)) : undefined}
              tone={it.tone}
              dot={it.dot}
              icon={it.icon}
              avatar={it.avatar}
              count={it.count}
              size={size}
              selected={selected}
              disabled={it.disabled}
              onRemove={removable(it) ? () => remove(i) : undefined}
              removeLabel={`Remove ${name}`}
              removeTabIndex={-1}
              className={cn(interactive && cn("outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"), selectable && !it.disabled && "cursor-pointer hover:bg-[color-mix(in_srgb,var(--foreground)_5%,var(--card))]")}
            >
              {it.label}
            </Tag>
          );
        })}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
          className={cn(
            "inline-flex cursor-pointer items-center rounded-[8px] px-2 font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground",
            size === "sm" ? "h-6 text-[12px]" : "h-7 text-[13px]",
            focusRing,
          )}
        >
          +{hidden} more
        </button>
      )}
    </div>
  );
}

export default Tag;
