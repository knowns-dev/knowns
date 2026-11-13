"use client";
/** @registry name="combobox" type="ui" title="Combobox" description="Select with icons, avatars, status dots, supporting text, groups, search, multiple choice and a tags mode. Opens as a popover, a dialog, or a bottom sheet on phones." */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/ui/lib/knowns/utils";
import { Avatar } from "./avatar";
import { Button } from "./button";
import { Dialog } from "./dialog";
import { fieldClass } from "./input";
import { GlideHighlight, MenuCheck, matchIndex, nextIndex, useGlide } from "./menu";
import { Tag } from "./tag";
import { FLOAT_FADE, useFloating } from "./use-floating";

export type ComboboxDotTone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Muted text right after the label, on the same line (an @handle, a unit, a short id). Also searched. */
  supportingText?: string;
  /** Second, muted line under the label. */
  description?: string;
  /** Extra words that match the search but are not shown (a full name, a code, aliases). */
  keywords?: string;
  /** 16px leading glyph. */
  icon?: ReactNode;
  /** Leading avatar: an image URL (rendered with Avatar) or any element. Wins over `dot` and `icon`. */
  avatar?: string | ReactNode;
  /** Leading status dot; `true` is neutral. Wins over `icon`. */
  dot?: true | ComboboxDotTone;
  disabled?: boolean;
  /** Options with the same group are listed together under a small header. */
  group?: string;
}

type AriaBool = boolean | "true" | "false";

interface Common {
  options: ComboboxOption[];
  placeholder?: string;
  /** Accessible name. Not needed when a <label for={id}> (e.g. Field) names it. */
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Set by Field (hint / error); forwarded to the focusable control. */
  "aria-describedby"?: string;
  "aria-invalid"?: AriaBool;
  "aria-required"?: AriaBool;
  /** Search field at the top of the popup that filters by label and supporting text. */
  searchable?: boolean;
  /** Shown when nothing matches. Default "No results". */
  emptyText?: ReactNode;
  /** 28 / 32 / 36px, same scale as Input and Button. Default "md". */
  size?: "sm" | "md" | "lg";
  /** Leading glyph in the trigger when the chosen option has no visual of its own (or nothing is chosen). */
  icon?: ReactNode;
  disabled?: boolean;
  invalid?: boolean;
  /** Id of the focusable control, so <label htmlFor> (and Field) can point at it. */
  id?: string;
  /** Submit the value(s) with a form: one hidden input per selected value. */
  name?: string;
  /**
   * Where the options open. "popover" (default): a dropdown under the field. "dialog": a modal with a
   * search field (a bottom sheet on small screens). "auto": dialog below 640px or on touch, popover otherwise.
   */
  presentation?: "popover" | "dialog" | "auto";
  /** Dialog title. Default: aria-label, else the field's <label> text. */
  dialogTitle?: ReactNode;
  dialogDescription?: ReactNode;
  className?: string;
}
export interface ComboboxSingleProps extends Common {
  multiple?: false;
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string) => void;
}
export interface ComboboxMultipleProps extends Common {
  multiple: true;
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
  /**
   * "summary" (default): the trigger shows the first label and +N; the popup has Clear / Done.
   * "tags": chosen values are removable chips inside the field, with an inline search; Backspace removes the last one.
   */
  display?: "summary" | "tags";
}
export type ComboboxProps = ComboboxSingleProps | ComboboxMultipleProps;

/* ── Pure helpers (exported for tests) ── */

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/đ/g, "d");

/** Options whose label, supporting text or keywords contain `query` (case- and accent-insensitive). Empty query keeps everything. */
export function filterOptions<T extends Pick<ComboboxOption, "label"> & { supportingText?: string; keywords?: string }>(options: T[], query: string): T[] {
  const q = fold(query.trim());
  const has = (s?: string) => s !== undefined && fold(s).includes(q);
  return q ? options.filter((o) => fold(o.label).includes(q) || has(o.supportingText) || has(o.keywords)) : options;
}

/** Bucket options by `group`, in order of first appearance; ungrouped options form a leading group with no header. */
export function groupOptions<T extends Pick<ComboboxOption, "group">>(options: T[]): { group?: string; options: T[] }[] {
  const loose: T[] = [];
  const groups = new Map<string, T[]>();
  for (const o of options) {
    if (o.group === undefined) loose.push(o);
    else if (groups.has(o.group)) groups.get(o.group)!.push(o);
    else groups.set(o.group, [o]);
  }
  return [...(loose.length ? [{ options: loose }] : []), ...[...groups].map(([group, opts]) => ({ group, options: opts }))];
}

/** Trigger text for a multi-select: first label plus "+N". */
export function summarize(labels: string[]): { first: string; more: number } | null {
  return labels.length ? { first: labels[0], more: labels.length - 1 } : null;
}

/** Add or remove `value` (multiple), keeping the order values were chosen in. */
export function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

/** Which leading visual an option shows: avatar, then dot, then icon. */
export function leadKind(o: Pick<ComboboxOption, "avatar" | "dot" | "icon">): "avatar" | "dot" | "icon" | null {
  return o.avatar ? "avatar" : o.dot ? "dot" : o.icon ? "icon" : null;
}

/** Whether to open as a dialog, given the presentation and the environment. */
export function resolvePresentation(presentation: "popover" | "dialog" | "auto" | undefined, env: { narrow: boolean; coarse: boolean }): "popover" | "dialog" {
  if (presentation === "dialog") return "dialog";
  if (presentation === "auto" && (env.narrow || env.coarse)) return "dialog";
  return "popover";
}

const ENV_QUERY = { narrow: "(max-width: 639.98px)", coarse: "(pointer: coarse)" };
const readEnv = () =>
  typeof window === "undefined" || !window.matchMedia
    ? { narrow: false, coarse: false }
    : { narrow: window.matchMedia(ENV_QUERY.narrow).matches, coarse: window.matchMedia(ENV_QUERY.coarse).matches };

/** Track the environment only when "auto" needs it. */
function useAutoDialog(presentation: ComboboxProps["presentation"]) {
  const [env, setEnv] = useState(readEnv);
  useEffect(() => {
    if (presentation !== "auto" || !window.matchMedia) return;
    const lists = Object.values(ENV_QUERY).map((q) => window.matchMedia(q));
    const on = () => setEnv(readEnv());
    lists.forEach((l) => l.addEventListener("change", on));
    on();
    return () => lists.forEach((l) => l.removeEventListener("change", on));
  }, [presentation]);
  return resolvePresentation(presentation, env) === "dialog";
}

/* ── Styles ── */

// `!` because fieldClass also sets a radius and font size, and cn() does not merge conflicts.
// Same heights, padding, radius and type as Input (28 / 32 / 36px, taller on touch).
const SIZE = {
  sm: "h-7 gap-1.5 rounded-[8px]! px-2.5 text-[12.5px]! pointer-coarse:h-9",
  md: "h-8 gap-2 rounded-[9px]! px-3 text-[13.5px]! pointer-coarse:h-10",
  lg: "h-9 gap-2 rounded-[10px]! px-3.5 text-sm! pointer-coarse:h-11",
};
// Tags mode grows with its chips; the inner input matches the chip height.
const TAGS_SIZE = {
  sm: "min-h-7 gap-1 rounded-[8px]! py-0.5 pl-0.5 pr-2.5 text-[12.5px]! pointer-coarse:min-h-9",
  md: "min-h-8 gap-1 rounded-[9px]! py-1 pl-1 pr-3 text-[13.5px]! pointer-coarse:min-h-10",
  lg: "min-h-9 gap-1 rounded-[10px]! py-1 pl-1 pr-3.5 text-sm! pointer-coarse:min-h-11",
};
// The field's focus / invalid rings, lit from the inline input (written out in full so Tailwind sees them).
const TAGS_RING = cn(
  "has-[input:focus-visible]:shadow-[0_0_0_1px_color-mix(in_srgb,var(--ring)_80%,transparent),0_0_0_4px_color-mix(in_srgb,var(--ring)_22%,transparent)]",
  "has-[input[aria-invalid=true]]:shadow-[0_0_0_1px_rgb(239_68_68/0.6),0_0_0_4px_rgb(239_68_68/0.12)]",
);
const DOT: Record<ComboboxDotTone, string> = {
  neutral: "bg-muted-foreground/70",
  accent: "bg-indigo-500",
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
};

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-3.5 flex-none text-muted-foreground">
      <path d="M4.5 6.5 8 10l3.5-3.5" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden className="size-3.5 flex-none text-muted-foreground">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 13.5 13.5" />
    </svg>
  );
}

function avatarNode(o: ComboboxOption, className?: string) {
  return typeof o.avatar === "string" ? <Avatar label={o.label} src={o.avatar} size="xs" shape="circle" decorative className={className} /> : o.avatar;
}

/** The option's leading visual, sized for a 20px line. */
function Lead({ o, fallback }: { o?: ComboboxOption; fallback?: ReactNode }) {
  const kind = o ? leadKind(o) : null;
  if (o && kind === "avatar") return <span className="grid size-5 flex-none place-items-center">{avatarNode(o)}</span>;
  if (o && kind === "dot")
    return (
      <span aria-hidden className="grid size-4 flex-none place-items-center">
        <span className={cn("size-2 rounded-full", DOT[o.dot === true ? "neutral" : o.dot!])} />
      </span>
    );
  const glyph = (o && kind === "icon" && o.icon) || fallback;
  return glyph ? <span className="grid size-4 flex-none place-items-center text-muted-foreground [&>svg]:size-full">{glyph}</span> : null;
}

/**
 * Select with a custom popup: optional search, groups, avatars / dots / icons, inline supporting text and
 * descriptions, single or multiple choice (summary or removable tags). The popup is a listbox in a portal
 * (useFloating, trigger width); the highlighted option is exposed with aria-activedescendant, so focus
 * stays on the trigger, the search field or the inline tag input.
 */
export function Combobox(props: ComboboxProps) {
  const { options, searchable, emptyText = "No results", size = "md", icon, disabled, invalid, name, className, presentation = "popover", dialogTitle, dialogDescription } = props;
  const multiple = props.multiple === true;
  const tags = props.multiple === true && props.display === "tags";
  const placeholder = props.placeholder ?? (tags ? "Add…" : "Select…");
  const label = props["aria-label"];
  const invalidAttr = invalid || props["aria-invalid"] === true || props["aria-invalid"] === "true" || undefined;

  /* Value: controlled or not; always an array inside. */
  const toArr = (v: string | string[] | null | undefined) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const [own, setOwn] = useState<string[]>(() => toArr(props.defaultValue));
  const selected = props.value !== undefined ? toArr(props.value) : own;
  const commit = (next: string[]) => {
    if (props.value === undefined) setOwn(next);
    if (props.multiple) props.onValueChange?.(next);
    else if (next[0] !== undefined) props.onValueChange?.(next[0]);
  };

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [listName, setListName] = useState<string | undefined>(label);
  /** The presentation right now (follows "auto"), and the one locked in for the current opening. */
  const dialogMode = useAutoDialog(presentation);
  const [asDialog, setAsDialog] = useState(false);
  /** Dialog + multiple: changes stay here until Done. */
  const [draft, setDraft] = useState<string[]>([]);
  /** Set once the modal is actually showing, so rows can be measured for the highlight. */
  const [dialogShown, setDialogShown] = useState(false);
  const refocusAfterDialog = useRef(false);
  const intent = useRef<"first" | "last" | null>(null);
  /** In tags mode, the option to keep highlighted after the query is cleared by a pick. */
  const keep = useRef<string | null>(null);
  const typed = useRef({ text: "", timer: undefined as ReturnType<typeof setTimeout> | undefined });
  const search = useRef<HTMLInputElement>(null);
  const inline = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { triggerRef, floatingRef, style, portalHost, ready, closing } = useFloating<HTMLElement, HTMLDivElement>({ open: open && !asDialog, side: "auto", align: "start", offset: 6, matchWidth: true });

  const baseId = useId();
  const controlId = props.id ?? `${baseId}-control`;
  const listId = `${baseId}-list`;
  const optId = (i: number) => `${baseId}-opt-${i}`;

  const visible = useMemo(() => groupOptions(filterOptions(options, query)), [options, query]);
  const flat = useMemo(() => visible.flatMap((g) => g.options), [visible]);

  /* Starting highlight on open, and after the query changes. */
  useLayoutEffect(() => {
    if (!open) return;
    const want = intent.current;
    intent.current = null;
    const kept = keep.current;
    keep.current = null;
    if (kept !== null) {
      const at = flat.findIndex((o) => o.value === kept);
      if (at >= 0) return setActive(at);
    }
    const sel = query ? -1 : flat.findIndex((o) => (asDialog && multiple ? draft : selected).includes(o.value) && !o.disabled);
    setActive(want === "last" ? nextIndex(flat, -1, -1) : sel >= 0 ? sel : nextIndex(flat, -1, 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  /* Name the listbox like the control: aria-label, else the <label for> text (Field). */
  useLayoutEffect(() => {
    if (!open) return;
    setListName(label ?? document.querySelector(`label[for="${CSS.escape(controlId)}"]`)?.textContent?.replace("*", "").trim() ?? undefined);
  }, [open, label, controlId]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  /* Focus the popup search field once the popup is placed. */
  useEffect(() => {
    if (ready && searchable && !tags) search.current?.focus({ preventScroll: true });
  }, [ready, searchable, tags]);

  /* Dialog: Dialog's own effect calls showModal() first (child effects run before ours); then measure, and
     after it closes put focus back on the control (focus can't move out of an open modal). */
  useEffect(() => {
    setDialogShown(open && asDialog);
    if (!open && refocusAfterDialog.current) {
      refocusAfterDialog.current = false;
      focusControl();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, asDialog]);

  /* Outside press closes (popover only; the dialog has its backdrop). */
  useEffect(() => {
    if (!open || asDialog) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (floatingRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, asDialog, floatingRef, triggerRef]);

  const shownOpen = open && (asDialog ? dialogShown : ready);
  const hi = useGlide(list, shownOpen && active >= 0 ? optId(active) : null, flat, dialogShown);
  /** Values with a check mark: the draft while a multi-select dialog is open. */
  const checked = asDialog && multiple ? draft : selected;

  /** The element keyboard focus lives on: the trigger button, or the inline input in tags mode. */
  const focusControl = () => (tags ? inline.current : (triggerRef.current as HTMLElement | null))?.focus();
  const close = (refocus: boolean) => {
    setOpen(false);
    if (!refocus) return;
    if (asDialog) refocusAfterDialog.current = true;
    else focusControl();
  };
  const openWith = (at: "first" | "last", seed?: string) => {
    if (disabled) return;
    intent.current = at;
    setAsDialog(dialogMode);
    if (dialogMode) setDraft(selected);
    if (seed) setQuery(seed);
    setOpen(true);
  };

  const choose = (i: number) => {
    const o = flat[i];
    if (!o || o.disabled) return;
    if (asDialog && multiple) {
      setDraft((d) => toggleValue(d, o.value));
      setActive(i);
    } else if (multiple) {
      commit(toggleValue(selected, o.value));
      if (tags && query) {
        keep.current = o.value;
        setQuery("");
      } else setActive(i);
    } else {
      commit([o.value]);
      close(true);
    }
  };

  const removeValue = (value: string) => {
    commit(selected.filter((v) => v !== value));
    inline.current?.focus();
  };

  const move = (e: ReactKeyboardEvent, i: number) => {
    e.preventDefault();
    if (i >= 0) setActive(i);
  };

  /** Keys while open, from the trigger button (select-only) or the popup search field. */
  const onNavKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    switch (e.key) {
      case "ArrowDown":
        return move(e, nextIndex(flat, active, 1));
      case "ArrowUp":
        return move(e, nextIndex(flat, active, -1));
      case "Home":
        if (searchable) return; // keep caret movement in the search field
        return move(e, nextIndex(flat, -1, 1));
      case "End":
        if (searchable) return;
        return move(e, nextIndex(flat, -1, -1));
      case "PageUp":
        return move(e, nextIndex(flat, -1, 1));
      case "PageDown":
        return move(e, nextIndex(flat, -1, -1));
      case "Enter":
        e.preventDefault();
        return choose(active);
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        return close(true);
      case "Tab":
        if (multiple && !e.shiftKey) {
          // Step into the popup footer (Clear / Done) instead of leaving.
          const btn = floatingRef.current?.querySelector<HTMLButtonElement>("[data-footer] button:not([disabled])");
          if (btn) {
            e.preventDefault();
            return btn.focus();
          }
        }
        if (searchable) (triggerRef.current as HTMLElement | null)?.focus(); // let the browser move on from the trigger
        return setOpen(false);
    }
    if (searchable) return; // typing goes into the field
    if (e.key === " " && !typed.current.text) {
      e.preventDefault();
      return choose(active);
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const t = typed.current;
      clearTimeout(t.timer);
      t.text += e.key;
      t.timer = setTimeout(() => (t.text = ""), 500);
      move(e, matchIndex(flat, active, t.text));
    }
  };

  /** Keys in the dialog's search field. Escape and Tab belong to the dialog. */
  const onDialogKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        return move(e, nextIndex(flat, active, 1));
      case "ArrowUp":
        return move(e, nextIndex(flat, active, -1));
      case "PageUp":
        return move(e, nextIndex(flat, -1, 1));
      case "PageDown":
        return move(e, nextIndex(flat, -1, -1));
      case "Enter":
        e.preventDefault();
        return choose(active);
    }
  };

  const onTriggerKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (open && !searchable && !asDialog) return onNavKey(e);
    if (open) return;
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openWith("first");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openWith("last");
    }
  };

  /** Keys in the inline input of tags mode: it is the combobox. */
  const onInlineKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case " ":
        if (dialogMode && !open) return e.preventDefault(), openWith("first");
        return;
      case "ArrowDown":
        if (!open) return e.preventDefault(), openWith("first");
        return move(e, nextIndex(flat, active, 1));
      case "ArrowUp":
        if (!open) return e.preventDefault(), openWith("last");
        return move(e, nextIndex(flat, active, -1));
      case "PageUp":
        return open && move(e, nextIndex(flat, -1, 1));
      case "PageDown":
        return open && move(e, nextIndex(flat, -1, -1));
      case "Enter":
        e.preventDefault(); // never submit the form from here
        return open ? choose(active) : openWith("first");
      case "Escape":
        if (!open) return;
        e.preventDefault();
        e.stopPropagation();
        return setOpen(false);
      case "Backspace":
        if (!query && selected.length) {
          e.preventDefault();
          commit(selected.slice(0, -1));
        }
        return;
      case "Tab":
        return setOpen(false);
    }
  };

  /* Trigger content. */
  const byValue = new Map(options.map((o) => [o.value, o]));
  const chosen = selected.map((v) => byValue.get(v)).filter((o): o is ComboboxOption => !!o);
  const sum = summarize(chosen.map((o) => o.label));
  const single = !multiple ? chosen[0] : undefined;

  /* Field wiring: describedby / invalid / required go to the focusable control. */
  const aria = {
    "aria-label": label,
    "aria-labelledby": props["aria-labelledby"],
    "aria-describedby": props["aria-describedby"],
    "aria-invalid": invalidAttr,
    "aria-required": props["aria-required"],
  };

  let index = 0;
  const countText = query ? (flat.length === 1 ? "1 result" : `${flat.length} results`) : "";

  const trigger = tags ? (
    <div
      ref={triggerRef as Ref<HTMLDivElement>}
      onMouseDown={(e) => {
        if (disabled || (e.target as Element).closest("button")) return;
        // Clicks on the frame (not the × buttons) focus the input and toggle the list.
        if (e.target !== inline.current) e.preventDefault();
        inline.current?.focus();
        if (open) setOpen(false);
        else openWith("first");
      }}
      className={cn(
        fieldClass,
        "flex cursor-text flex-wrap items-center",
        TAGS_SIZE[size],
        TAGS_RING,
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      {icon && !chosen.length && (
        <span className="ml-2 grid size-4 flex-none place-items-center text-muted-foreground [&>svg]:size-full" aria-hidden>
          {icon}
        </span>
      )}
      {chosen.map((o) => (
        <Tag
          key={o.value}
          size={size === "lg" ? "md" : "sm"}
          avatar={o.avatar ? avatarNode(o) : undefined}
          dot={!o.avatar && !!o.dot}
          tone={o.dot && o.dot !== true ? o.dot : "neutral"}
          icon={!o.avatar && !o.dot ? o.icon : undefined}
          onRemove={disabled ? undefined : () => removeValue(o.value)}
          removeLabel={`Remove ${o.label}`}
        >
          {o.label}
        </Tag>
      ))}
      <input
        ref={inline}
        id={controlId}
        role="combobox"
        {...aria}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={!asDialog && open && ready && active >= 0 ? optId(active) : undefined}
        disabled={disabled}
        value={asDialog ? "" : query}
        onChange={(e) => {
          // Typing in dialog presentation opens the dialog with what was typed as the search.
          if (dialogMode && !open) return openWith("first", e.target.value);
          setQuery(e.target.value);
          if (!open) openWith("first");
        }}
        onKeyDown={onInlineKey}
        aria-haspopup={dialogMode ? "dialog" : "listbox"}
        inputMode={dialogMode ? "none" : undefined}
        placeholder={chosen.length ? "" : placeholder}
        autoComplete="off"
        spellCheck={false}
        className={cn(
          "h-6 min-w-[6ch] flex-1 bg-transparent outline-none placeholder:text-muted-foreground",
          chosen.length || icon ? "px-1" : "px-2",
        )}
      />
      <Chevron />
    </div>
  ) : (
    <button
      ref={triggerRef as Ref<HTMLButtonElement>}
      id={controlId}
      type="button"
      disabled={disabled}
      role="combobox"
      {...aria}
      aria-haspopup={dialogMode ? "dialog" : "listbox"}
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-activedescendant={!searchable && !asDialog && open && ready && active >= 0 ? optId(active) : undefined}
      onClick={() => (open ? close(false) : openWith("first"))}
      onKeyDown={onTriggerKey}
      className={cn(fieldClass, "flex cursor-pointer items-center text-left", SIZE[size], className)}
    >
      <Lead o={single} fallback={icon} />
      <span className={cn("flex min-w-0 flex-1 items-baseline gap-1.5", !sum && "text-muted-foreground")}>
        <span className="truncate">{sum ? sum.first : placeholder}</span>
        {single?.supportingText && <span className="truncate text-[0.93em] text-muted-foreground">{single.supportingText}</span>}
      </span>
      {sum && sum.more > 0 && <span className="flex-none rounded-full bg-muted px-1.5 text-[11px] leading-[18px] font-medium text-muted-foreground tabular-nums">+{sum.more}</span>}
      <Chevron />
    </button>
  );

  const listbox = (
    <div
      ref={list}
      id={listId}
      role="listbox"
      aria-label={listName}
      aria-multiselectable={multiple || undefined}
      onPointerLeave={() => setActive(-1)}
      className={cn("relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-1", asDialog && "px-2 pb-2")}
    >
      <GlideHighlight hi={hi} />
      {flat.length === 0 && <div className="px-2.5 py-6 text-center text-[12.5px] text-muted-foreground">{emptyText}</div>}
      {visible.map((g, gi) => {
        const headId = g.group ? `${baseId}-g-${gi}` : undefined;
        return (
          <div key={g.group ?? "_"} role={g.group ? "group" : undefined} aria-labelledby={headId}>
            {gi > 0 && <div aria-hidden className="mx-1.5 my-1 h-px bg-border" />}
            {g.group && (
              <div id={headId} className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-[0.01em] text-muted-foreground">
                {g.group}
              </div>
            )}
            {g.options.map((o) => {
              const i = index++;
              const isSel = checked.includes(o.value);
              const kind = leadKind(o);
              return (
                <div
                  key={o.value}
                  id={optId(i)}
                  role="option"
                  aria-selected={isSel}
                  aria-disabled={o.disabled || undefined}
                  onPointerMove={() => !o.disabled && active !== i && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()} // keep focus on the trigger / search field / inline input
                  onClick={() => choose(i)}
                  className={cn(
                    "relative flex min-h-8 items-start gap-2.5 rounded-[8px] px-2.5 py-1.5 leading-5 select-none",
                    o.disabled ? "cursor-default opacity-45" : "cursor-pointer",
                  )}
                >
                  {kind && (
                    <span className={cn("flex-none", kind === "avatar" ? "" : "mt-0.5")}>
                      <Lead o={o} />
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate">{o.label}</span>
                      {o.supportingText && <span className="truncate text-[12.5px] text-muted-foreground">{o.supportingText}</span>}
                    </span>
                    {o.description && <span className="text-[12px] leading-[1.35] text-muted-foreground">{o.description}</span>}
                  </span>
                  <span className={cn("mt-0.5 flex-none", !isSel && "invisible")}>
                    <MenuCheck />
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
  const live = (
    <span aria-live="polite" className="sr-only">
      {countText}
    </span>
  );

  return (
    <>
      {trigger}
      {name && selected.map((v) => <input key={v} type="hidden" name={name} value={v} />)}
      {!asDialog &&
        portalHost &&
        createPortal(
          <div
            ref={floatingRef}
            data-state={closing ? "closed" : "open"}
            style={style}
            className={cn(
              "z-[60] flex min-w-[180px] flex-col overflow-hidden rounded-xl bg-popover text-[13px] text-popover-foreground",
              "shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_12%,transparent),0_12px_32px_-12px_rgb(0_0_0/0.3),0_2px_6px_rgb(0_0_0/0.06)]",
              FLOAT_FADE,
            )}
          >
            {searchable && !tags && (
              <div className="flex flex-none items-center gap-2 border-b px-3">
                <SearchGlyph />
                <input
                  ref={search}
                  role="combobox"
                  aria-label={listName ? `Search ${listName}` : "Search"}
                  aria-expanded
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={ready && active >= 0 ? optId(active) : undefined}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onNavKey}
                  placeholder="Search…"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
                />
              </div>
            )}
            {listbox}
            {multiple && !tags && (
              <div
                data-footer
                className="flex flex-none items-center justify-between gap-2 border-t px-2 py-1.5"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    close(true);
                  } else if (e.key === "Tab" && !e.shiftKey && (e.target as HTMLElement).dataset.last !== undefined) {
                    e.preventDefault();
                    close(true);
                  } else if (e.key === "Tab" && e.shiftKey && e.target === e.currentTarget.querySelector("button:not([disabled])")) {
                    // Back to where focus came from (the popup sits at the end of <body>).
                    e.preventDefault();
                    (searchable ? search.current : (triggerRef.current as HTMLElement | null))?.focus();
                  }
                }}
              >
                <button
                  type="button"
                  disabled={selected.length === 0}
                  onClick={() => commit([])}
                  className="h-7 cursor-pointer rounded-[8px] px-2.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent"
                >
                  Clear
                </button>
                <button
                  type="button"
                  data-last=""
                  onClick={() => close(true)}
                  className="h-7 cursor-pointer rounded-[8px] bg-foreground px-3 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  Done
                </button>
              </div>
            )}
            {live}
          </div>,
          portalHost,
        )}
      {presentation !== "popover" && (
        <Dialog
          open={open && asDialog}
          onOpenChange={(v) => !v && close(true)}
          title={dialogTitle ?? listName ?? "Select"}
          description={dialogDescription}
          size="sm"
          sheet
          className="max-h-[min(40rem,85vh)] open:flex open:flex-col"
          bodyClassName="flex min-h-0 flex-1 flex-col"
          footer={
            multiple ? (
              <>
                <Button variant="ghost" size="sm" className="mr-auto" disabled={!draft.length} onClick={() => setDraft([])}>
                  Clear
                </Button>
                <Button variant="secondary" size="sm" onClick={() => close(true)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    commit(draft);
                    close(true);
                  }}
                >
                  Done ({draft.length})
                </Button>
              </>
            ) : undefined
          }
        >
          {open && asDialog && (
            <>
              <div className="mx-5 mt-1 mb-2 flex flex-none items-center gap-2 rounded-[9px] bg-muted/60 px-3 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--foreground)_8%,transparent)] focus-within:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ring)_70%,transparent)]">
                <SearchGlyph />
                <input
                  ref={search}
                  data-autofocus
                  role="combobox"
                  aria-label={listName ? `Search ${listName}` : "Search"}
                  aria-expanded
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={dialogShown && active >= 0 ? optId(active) : undefined}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onDialogKey}
                  placeholder="Search…"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-9 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-[13px]"
                />
              </div>
              {listbox}
              {live}
            </>
          )}
        </Dialog>
      )}
    </>
  );
}

export default Combobox;
