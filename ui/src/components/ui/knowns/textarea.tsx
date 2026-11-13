"use client";
/** @registry name="textarea" type="ui" title="Textarea" description="A multi-line field that grows with its text up to a row limit, with a character or word counter, a soft or hard limit, and a counter that is announced only when it matters." */

import { useCallback, useId, useRef, useState, type ChangeEvent, type Ref, type RefCallback, type TextareaHTMLAttributes } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { useAutosize } from "./chat-composer/use-autosize";
import { fieldClass } from "./field-class";

export type CounterUnit = "characters" | "words";
export type CounterState = "ok" | "near" | "at" | "over";

/** Words are runs of non-space characters. */
export function countOf(text: string, unit: CounterUnit): number {
  if (unit === "characters") return Array.from(text).length;
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** "ok" below 80% of the limit, "near" from 80%, "at" exactly on it, "over" past it. No limit is always "ok". */
export function counterState(count: number, limit?: number): CounterState {
  if (limit === undefined || limit <= 0) return "ok";
  if (count > limit) return "over";
  if (count === limit) return "at";
  return count >= limit * 0.8 ? "near" : "ok";
}

/** "120 / 500", or with `remaining` "380 left" (negative: "20 over"). Without a limit just the count. */
export function counterText(count: number, limit: number | undefined, remaining: boolean, unit: CounterUnit): string {
  const noun = unit === "words" ? (count === 1 ? "word" : "words") : count === 1 ? "character" : "characters";
  if (limit === undefined) return `${count} ${noun}`;
  if (!remaining) return `${count} / ${limit}`;
  const left = limit - count;
  return left >= 0 ? `${left} left` : `${-left} over`;
}

/** Spoken only when the state changes, so a screen reader is not read a number on every key. */
const SPOKEN: Record<CounterState, (limit: number, unit: CounterUnit) => string> = {
  ok: () => "",
  near: (l, u) => `Nearing the limit of ${l} ${u}`,
  at: (l, u) => `Limit reached: ${l} ${u}`,
  over: (l, u) => `Over the limit of ${l} ${u}`,
};

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "maxLength"> {
  invalid?: boolean;
  /** Grow with the text, from `minRows` up to `maxRows`, then scroll. Default false: a fixed `minRows` box. */
  autosize?: boolean;
  /** Default 3. */
  minRows?: number;
  /** With autosize, the most rows before it scrolls. Default 10. */
  maxRows?: number;
  /** A counter under the field: "characters" or "words". Without a `limit` it is just the count. Off by default. */
  count?: CounterUnit;
  /** A soft limit: typing is allowed, and the counter turns red when passed. Pair with `invalid` and a message. */
  limit?: number;
  /** A hard limit: the browser stops input at this many characters (characters only). */
  maxLength?: number;
  /** Show what is left ("380 left") instead of "120 / 500". */
  remaining?: boolean;
  /** Which way the user can drag the corner. Default "vertical" without autosize, "none" with it. */
  resize?: "none" | "vertical";
  ref?: Ref<HTMLTextAreaElement>;
}

/**
 * Textarea: a multi-line field in the same look as Input. It can grow with its text, and show a counter in
 * characters or words against a soft `limit` or a hard `maxLength`. The counter is described to the field and
 * is read out when you near, reach or pass the limit, not on every key.
 */
export function Textarea({
  invalid,
  autosize,
  minRows = 3,
  maxRows = 10,
  count,
  limit,
  maxLength,
  remaining = false,
  resize,
  value,
  defaultValue,
  onChange,
  className,
  ref,
  ...rest
}: TextareaProps) {
  const inner = useRef<HTMLTextAreaElement>(null);
  const setRef: RefCallback<HTMLTextAreaElement> = useCallback(
    (el) => {
      inner.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as { current: HTMLTextAreaElement | null }).current = el;
    },
    [ref],
  );
  const [local, setLocal] = useState(String(defaultValue ?? ""));
  const text = value !== undefined ? String(value) : local;
  const idle = useRef<HTMLTextAreaElement>(null);
  useAutosize(autosize ? inner : idle, text, maxRows);
  const counterId = useId();

  const change = (e: ChangeEvent<HTMLTextAreaElement>) => {
    if (value === undefined) setLocal(e.target.value);
    onChange?.(e);
  };

  // A hard maxLength is a character limit, so it needs the character counter.
  const unit: CounterUnit = maxLength !== undefined ? "characters" : (count ?? "characters");
  const cap = maxLength ?? limit;
  const counting = count !== undefined || maxLength !== undefined || limit !== undefined;
  const n = countOf(text, unit);
  const state = counterState(n, cap);
  const resizeMode = resize ?? (autosize ? "none" : "vertical");
  const describedBy = [rest["aria-describedby"], counting ? counterId : undefined].filter(Boolean).join(" ") || undefined;

  const field = (
    <textarea
      ref={setRef}
      rows={minRows}
      maxLength={maxLength}
      value={value}
      defaultValue={defaultValue}
      onChange={change}
      aria-invalid={invalid || state === "over" || undefined}
      {...rest}
      aria-describedby={describedBy}
      className={cn(fieldClass, "px-3 py-2 leading-relaxed", resizeMode === "none" ? "resize-none" : "field-sizing-content min-h-16 resize-y", className)}
    />
  );
  if (!counting) return field;
  return (
    <span className="flex w-full flex-col gap-1">
      {field}
      <span id={counterId} className={cn("self-end text-[11.5px] tabular-nums transition-colors duration-200 ease-out", state === "at" ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
        <span aria-hidden="true">{counterText(n, cap, remaining, unit)}</span>
        <span className="sr-only" role="status">
          {cap !== undefined ? SPOKEN[state](cap, unit) : ""}
        </span>
      </span>
    </span>
  );
}
