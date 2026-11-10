"use client";
/** @registry name="input" type="ui" title="Input" description="Input with sizes, prefix/suffix, shortcut and password reveal; InputGroup; Textarea with counter and auto-grow; Field with label, hint, error, required and help." */

import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useRef,
  useState,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefCallback,
  type TextareaHTMLAttributes,
} from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { Kbd } from "./kbd";
import { Tooltip } from "./tooltip";
import { SURFACE } from "./field-class";
import { Textarea as StandaloneTextarea } from "./textarea";

/* ── Shared look ── */

export { fieldClass } from "./field-class";

/** The same look on a wrapper: it lights up while the input inside has focus or is invalid. */
const frameClass = cn(
  "relative flex w-full min-w-0 items-center",
  SURFACE,
  "has-[input:focus-visible]:shadow-[0_0_0_1px_color-mix(in_srgb,var(--ring)_80%,transparent),0_0_0_4px_color-mix(in_srgb,var(--ring)_22%,transparent)]",
  "has-[input[aria-invalid=true]]:shadow-[0_0_0_1px_rgb(239_68_68/0.6),0_0_0_4px_rgb(239_68_68/0.12)]",
  "has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-50",
);

export type InputSize = "sm" | "md" | "lg";

// 28 / 32 / 36px, taller on touch screens; matches Button sizes so they line up in an InputGroup.
const SIZE: Record<InputSize, string> = {
  sm: "h-7 gap-1.5 rounded-[8px] px-2.5 text-[12.5px] [&_svg]:size-3.5 pointer-coarse:h-9",
  md: "h-8 gap-2 rounded-[9px] px-3 text-[13.5px] [&_svg]:size-4 pointer-coarse:h-10",
  lg: "h-9 gap-2 rounded-[10px] px-3.5 text-sm [&_svg]:size-[17px] pointer-coarse:h-11",
};

function useMergedRef<T>(...refs: (Ref<T> | undefined)[]): RefCallback<T> {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((el: T | null) => {
    for (const r of refs) {
      if (typeof r === "function") r(el);
      else if (r) (r as { current: T | null }).current = el;
    }
  }, refs);
}

const Eye = ({ off }: { off?: boolean }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z" />
    <circle cx="8" cy="8" r="2" />
    {off && <path d="M2.5 2.5l11 11" />}
  </svg>
);

/* ── Input ── */

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  /** 28, 32 or 36px high (taller on touch screens). */
  size?: InputSize;
  /** Icon inside the field, on the left. */
  icon?: ReactNode;
  /** Muted text inside the field before the value, e.g. "https://". */
  prefix?: ReactNode;
  /** Muted text inside the field after the value, e.g. "USD". */
  suffix?: ReactNode;
  /** Keyboard hint on the right, e.g. "⌘K". */
  shortcut?: string;
  /** Content inside the field, on the right (a unit, a button). */
  trailing?: ReactNode;
  invalid?: boolean;
  /** type="password" only: whether the value is shown. Leave unset to let the eye button manage it. */
  revealed?: boolean;
  /** type="password" only: called when the eye button is pressed. */
  onRevealedChange?: (revealed: boolean) => void;
  ref?: Ref<HTMLInputElement>;
}

export function Input({ size = "md", icon, prefix, suffix, shortcut, trailing, invalid, revealed, onRevealedChange, type, className, ref, ...rest }: InputProps) {
  const inner = useRef<HTMLInputElement>(null);
  const setRef = useMergedRef(inner, ref);
  const [ownShown, setOwnShown] = useState(false);
  const shown = revealed ?? ownShown;
  const setShown = (next: boolean) => {
    if (revealed === undefined) setOwnShown(next);
    onRevealedChange?.(next);
  };
  const password = type === "password";

  // Clicks on the prefix, suffix or padding still put the caret in the input.
  const focusInput = (e: MouseEvent<HTMLSpanElement>) => {
    const t = e.target as HTMLElement;
    if (t === inner.current || t.closest("button, a, [tabindex]")) return;
    e.preventDefault();
    inner.current?.focus();
  };

  return (
    <span data-slot="input" className={cn(frameClass, SIZE[size], "cursor-text", className)} onMouseDown={focusInput}>
      {icon && (
        <span aria-hidden="true" className="grid flex-none text-muted-foreground">
          {icon}
        </span>
      )}
      {prefix && <span className="flex-none select-none whitespace-nowrap text-muted-foreground">{prefix}</span>}
      <input
        ref={setRef}
        type={password && shown ? "text" : type}
        aria-invalid={invalid || undefined}
        className="h-full w-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        {...rest}
      />
      {suffix && <span className="flex-none select-none whitespace-nowrap text-muted-foreground">{suffix}</span>}
      {shortcut && (
        <Kbd aria-hidden="true" className="flex-none">
          {shortcut}
        </Kbd>
      )}
      {password && (
        <button
          type="button"
          aria-label="Show password"
          aria-pressed={shown}
          disabled={rest.disabled}
          onClick={() => setShown(!shown)}
          className={cn(
            "-mr-1.5 grid size-6 flex-none cursor-pointer place-items-center rounded-[6px] text-muted-foreground transition-colors duration-150 ease-out hover:bg-muted hover:text-foreground disabled:pointer-events-none",
            focusRing,
          )}
        >
          <Eye off={shown} />
        </button>
      )}
      {trailing && <span className="-mr-1.5 flex flex-none items-center text-muted-foreground">{trailing}</span>}
    </span>
  );
}

/* ── InputGroup ── */

/**
 * Joins an Input with Buttons or Selects into one control: the corners between them go square
 * and their hairlines meet. Give a Select a fixed width by wrapping it, e.g. <span className="w-28 flex-none">.
 */
export function InputGroup({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="group"
      className={cn(
        "flex w-full items-stretch",
        "[&>*]:relative [&>*:focus-within]:z-10 [&>*:hover]:z-[1]",
        // Hairlines are drawn outside each part; a 1px gap makes neighbours share one.
        "[&>*:not(:first-child)]:ml-px",
        "[&>*:not(:first-child)]:rounded-l-none [&>*:not(:last-child)]:rounded-r-none",
        "[&>*:not(:first-child)_select]:rounded-l-none [&>*:not(:last-child)_select]:rounded-r-none",
        "[&>button]:hover:translate-y-0 [&>button]:active:scale-100",
        className,
      )}
      {...rest}
    />
  );
}

/* ── Textarea ── */

/** "120 / 500". */
export function countText(length: number, max: number) {
  return `${length} / ${max}`;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  /** Grow with the text up to maxRows, then scroll. */
  autoGrow?: boolean;
  maxRows?: number;
  ref?: Ref<HTMLTextAreaElement>;
}

/**
 * The Textarea lives in its own item (./textarea). This keeps the props of the first version: `autoGrow` is
 * `autosize` there, and `maxLength` shows the same "120 / 500" counter.
 */
export function Textarea({ autoGrow, maxRows = 8, rows = 3, ...rest }: TextareaProps) {
  return <StandaloneTextarea autosize={autoGrow} maxRows={maxRows} minRows={autoGrow ? 1 : rows} {...rest} />;
}

/* ── Field ── */

const Info = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" className="size-3.5">
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.25v3.75M8 5v.01" />
  </svg>
);

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** id of the control inside, for the label. */
  id: string;
  /** Shows an asterisk and sets aria-required on the control. */
  required?: boolean;
  /** Shows "Optional" (or your text) next to the label. */
  optional?: boolean | ReactNode;
  /** Help behind an info icon next to the label. */
  tooltip?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Label + field + hint/error, wired for screen readers. */
export function Field({ label, hint, error, id, required, optional, tooltip, children, className }: FieldProps) {
  const msgId = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  // Wire the single control inside: required, invalid and the hint/error description.
  const only = Children.count(children) === 1 && isValidElement(children) ? (children as ReactElement<Record<string, unknown>>) : null;
  const control = only
    ? cloneElement(only, {
        "aria-required": only.props["aria-required"] ?? (required || undefined),
        "aria-describedby": only.props["aria-describedby"] ?? msgId,
        ...(error && only.props.invalid === undefined && only.props["aria-invalid"] === undefined ? { "aria-invalid": true } : {}),
      })
    : children;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-[13px] font-medium">
          {label}
          {required && (
            <span aria-hidden="true" className="ml-0.5 text-red-600 dark:text-red-400">
              *
            </span>
          )}
        </label>
        {optional && !required && <span className="text-[12px] text-muted-foreground">{optional === true ? "Optional" : optional}</span>}
        {tooltip && (
          <Tooltip content={tooltip}>
            <button
              type="button"
              aria-label="More information"
              className={cn("grid size-4 cursor-help place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:text-foreground", focusRing)}
            >
              <Info />
            </button>
          </Tooltip>
        )}
      </span>
      {control}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )
      )}
    </div>
  );
}
