"use client";
/** @registry name="otp-input" type="ui" title="OTP input" description="One-time code in N slots: paste fills all, auto-advance and backspace, numeric or alphanumeric, masked, error state, onComplete." */

import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { cn } from "@/ui/lib/knowns/utils";

export type OtpMode = "numeric" | "alphanumeric";

/* ── Pure helpers (exported for tests) ── */

/** Keeps only the characters a slot accepts: digits, or letters and digits (upper-cased). */
export function sanitizeOtp(text: string, mode: OtpMode = "numeric"): string {
  return mode === "numeric" ? text.replace(/\D/g, "") : text.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

/**
 * Writes `text` into the slots from `index` on (a paste or a fast typist) and returns the new slots
 * and the slot to focus next. A paste as long as the whole code always fills from the first slot.
 */
export function fillSlots(slots: string[], index: number, text: string, mode: OtpMode = "numeric"): { slots: string[]; focus: number } {
  const chars = sanitizeOtp(text, mode);
  if (!chars) return { slots, focus: index };
  const start = chars.length >= slots.length ? 0 : index;
  const next = [...slots];
  let i = start;
  for (const c of chars) {
    if (i >= next.length) break;
    next[i++] = c;
  }
  return { slots: next, focus: Math.min(i, next.length - 1) };
}

/** Backspace: clear this slot, or if it is already empty, clear the one before and move there. */
export function backspaceSlots(slots: string[], index: number): { slots: string[]; focus: number } {
  const next = [...slots];
  if (next[index]) {
    next[index] = "";
    return { slots: next, focus: index };
  }
  const prev = Math.max(0, index - 1);
  next[prev] = "";
  return { slots: next, focus: prev };
}

const toSlots = (value: string, length: number) => Array.from({ length }, (_, i) => value[i] ?? "");

/* ── Component ── */

export interface OtpInputProps {
  /** Number of slots. Default 6. */
  length?: number;
  /** The code so far (controlled). */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Called once every slot is filled. */
  onComplete?: (code: string) => void;
  mode?: OtpMode;
  /** Shows dots instead of the characters (the value is unchanged). */
  mask?: boolean;
  /** Draws a gap after these slot counts, e.g. [3] for "123 456". */
  groups?: number[];
  invalid?: boolean;
  disabled?: boolean;
  size?: "md" | "lg";
  autoFocus?: boolean;
  /** id of the first slot, for a Field label. */
  id?: string;
  name?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-required"?: boolean;
}

const SLOT = {
  md: "h-10 w-10 rounded-[10px] text-[17px] pointer-coarse:h-11 pointer-coarse:w-11",
  lg: "h-12 w-12 rounded-[12px] text-[20px]",
};

/** One-time code in separate slots: type, paste the whole code, Backspace and arrows move between slots. */
export function OtpInput({
  length = 6,
  value: valueProp,
  defaultValue = "",
  onValueChange,
  onComplete,
  mode = "numeric",
  mask = false,
  groups,
  invalid,
  disabled,
  size = "md",
  autoFocus,
  id,
  name,
  className,
  "aria-label": label = "One-time code",
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  "aria-required": required,
}: OtpInputProps) {
  const [own, setOwn] = useState(defaultValue);
  const value = valueProp ?? own;
  const slots = toSlots(value, length);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const auto = useId();
  const firstId = id ?? auto;
  const bad = invalid || ariaInvalid;

  const commit = (next: string[], focus: number) => {
    const code = next.join("");
    if (valueProp === undefined) setOwn(code);
    if (code !== value) onValueChange?.(code);
    if (code.length === length && !next.includes("") && code !== value) onComplete?.(code);
    const el = refs.current[focus];
    el?.focus();
    el?.select();
  };

  const onInput = (i: number, raw: string) => {
    // Some mobile keyboards delete with an input event instead of a Backspace key.
    if (raw === "") {
      const next = [...slots];
      next[i] = "";
      return commit(next, i);
    }
    // The slot already holds a character; the new one is whichever differs (caret may be either side).
    const typed = raw.length > 1 && slots[i] ? raw.replace(slots[i], "") || raw.slice(-1) : raw;
    const { slots: next, focus } = fillSlots(slots, i, typed, mode);
    if (next === slots) return;
    commit(next, typed.length === 1 ? Math.min(i + 1, length - 1) : focus);
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    const move = (to: number) => {
      e.preventDefault();
      const el = refs.current[Math.min(Math.max(0, to), length - 1)];
      el?.focus();
      el?.select();
    };
    if (e.key === "Backspace") {
      e.preventDefault();
      const { slots: next, focus } = backspaceSlots(slots, i);
      commit(next, focus);
    } else if (e.key === "Delete") {
      e.preventDefault();
      const next = [...slots];
      next[i] = "";
      commit(next, i);
    } else if (e.key === "ArrowLeft") move(i - 1);
    else if (e.key === "ArrowRight") move(i + 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(length - 1);
  };

  const onPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const { slots: next, focus } = fillSlots(slots, i, e.clipboardData.getData("text"), mode);
    if (next !== slots) commit(next, focus);
  };

  return (
    <div role="group" aria-label={label} aria-describedby={describedBy} className={cn("flex max-w-full items-center gap-1.5 sm:gap-2", className)}>
      {slots.map((c, i) => (
        <span key={i} className="contents">
          {groups?.includes(i) && i > 0 && <span aria-hidden="true" className="mx-0.5 h-px w-2.5 flex-none bg-muted-foreground/50" />}
          <input
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={i === 0 ? firstId : undefined}
            type={mask ? "password" : "text"}
            inputMode={mode === "numeric" ? "numeric" : "text"}
            autoComplete={i === 0 ? "one-time-code" : "off"}
            autoCapitalize={mode === "alphanumeric" ? "characters" : "off"}
            spellCheck={false}
            autoFocus={autoFocus && i === 0}
            disabled={disabled}
            value={c}
            aria-label={`Character ${i + 1} of ${length}`}
            aria-invalid={bad || undefined}
            aria-required={required || undefined}
            onChange={(e) => onInput(i, e.target.value)}
            onKeyDown={(e) => onKeyDown(i, e)}
            onPaste={(e) => onPaste(i, e)}
            onFocus={(e) => e.target.select()}
            className={cn(
              SLOT[size],
              // Slots keep their height and narrow (never past their size) when the row is tight, e.g. 8 slots on a phone.
              "min-w-0 shrink bg-card text-center font-medium tabular-nums caret-transparent outline-none",
              "shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_14%,transparent),0_1px_2px_rgb(0_0_0/0.04)] transition-[box-shadow] duration-200 ease-out dark:bg-[color-mix(in_srgb,var(--muted)_35%,var(--card))]",
              "focus:shadow-[0_0_0_1.5px_color-mix(in_srgb,var(--ring)_90%,transparent),0_0_0_4px_color-mix(in_srgb,var(--ring)_22%,transparent)]",
              bad && "shadow-[0_0_0_1px_rgb(239_68_68/0.6),0_0_0_4px_rgb(239_68_68/0.12)] focus:shadow-[0_0_0_1.5px_rgb(239_68_68/0.8),0_0_0_4px_rgb(239_68_68/0.16)]",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          />
        </span>
      ))}
      {name && <input type="hidden" name={name} value={value} />}
    </div>
  );
}
