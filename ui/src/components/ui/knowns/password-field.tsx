"use client";
/** @registry name="password-field" type="ui" title="Password field" description="Password input with a show/hide toggle (aria-pressed, controllable), a Caps Lock warning, autocomplete for sign-in or a new password, and Field integration." */

/**
 * PasswordField: our Input for passwords. An eye button shows or hides the value (aria-pressed), a
 * "Caps Lock" chip appears while Caps Lock is on, and autocomplete is set for sign-in or for a new
 * password so password managers do the right thing. Works inside Field (label, hint, error).
 */
import { useId, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { Input, type InputProps } from "./input";

export type PasswordPurpose = "current" | "new";

/** The autocomplete token for a purpose: "current-password" on sign-in, "new-password" on sign-up and change. */
export function passwordAutoComplete(purpose: PasswordPurpose = "current") {
  return purpose === "new" ? "new-password" : "current-password";
}

/** Caps Lock state from a key event; null when the browser can't tell (some mobile keyboards). */
export function capsLockFrom(e: Pick<KeyboardEvent, "getModifierState">): boolean | null {
  try {
    return typeof e.getModifierState === "function" ? e.getModifierState("CapsLock") : null;
  } catch {
    return null;
  }
}

export interface PasswordFieldProps extends Omit<InputProps, "type" | "autoComplete"> {
  /** "current" for sign-in, "new" for sign-up and change-password forms. Sets autocomplete. */
  purpose?: PasswordPurpose;
  /** Overrides the autocomplete token from purpose. */
  autoComplete?: string;
  /** Show the Caps Lock chip. Pass text to change its words. */
  capsLockWarning?: boolean | ReactNode;
  /** Whether the value is shown; leave unset to let the eye button manage it. */
  revealed?: boolean;
  defaultRevealed?: boolean;
  onRevealedChange?: (revealed: boolean) => void;
}

const CapsIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true" className="size-3">
    <path d="M8 2.5 13 8h-2.75v2.5h-4.5V8H3z" />
    <path d="M5.75 13.25h4.5" strokeLinecap="round" />
  </svg>
);

export function PasswordField({
  purpose = "current",
  autoComplete,
  capsLockWarning = true,
  revealed,
  defaultRevealed = false,
  onRevealedChange,
  trailing,
  onKeyDown,
  onKeyUp,
  onBlur,
  id,
  "aria-describedby": describedBy,
  ...rest
}: PasswordFieldProps) {
  const [ownRevealed, setOwnRevealed] = useState(defaultRevealed);
  const [caps, setCaps] = useState(false);
  const capsId = `${useId()}-caps`;
  const shown = revealed ?? ownRevealed;
  const warn = capsLockWarning !== false && caps;

  const readCaps = (e: KeyboardEvent<HTMLInputElement>) => {
    const on = capsLockFrom(e);
    if (on !== null) setCaps(on);
  };

  return (
    <>
      <Input
        {...rest}
        id={id}
        type="password"
        autoComplete={autoComplete ?? passwordAutoComplete(purpose)}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        revealed={shown}
        onRevealedChange={(next) => {
          if (revealed === undefined) setOwnRevealed(next);
          onRevealedChange?.(next);
        }}
        aria-describedby={cn(describedBy, warn && capsId) || undefined}
        onKeyDown={(e) => (readCaps(e), onKeyDown?.(e))}
        onKeyUp={(e) => (readCaps(e), onKeyUp?.(e))}
        onBlur={(e: FocusEvent<HTMLInputElement>) => (setCaps(false), onBlur?.(e))}
        trailing={
          warn || trailing ? (
            <>
              {warn && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "mr-1 inline-flex h-5 select-none items-center gap-1 whitespace-nowrap rounded-[6px] px-1.5 text-[11px] font-medium",
                    "bg-amber-500/14 text-amber-800 dark:text-amber-300",
                    "animate-[kn-pop_160ms_var(--kn-ease-out,cubic-bezier(.22,1,.36,1))_both] motion-reduce:animate-none",
                  )}
                >
                  <CapsIcon />
                  {capsLockWarning === true ? "Caps Lock" : capsLockWarning}
                </span>
              )}
              {trailing}
            </>
          ) : undefined
        }
      />
      {/* Always in the DOM so the change is announced. */}
      <span id={capsId} role="status" className="sr-only">
        {warn ? (capsLockWarning === true ? "Caps Lock is on" : capsLockWarning) : ""}
      </span>
    </>
  );
}
