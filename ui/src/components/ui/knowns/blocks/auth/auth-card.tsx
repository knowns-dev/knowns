"use client";
/** @registry name="auth-card" type="block" title="Auth card" description="Sign in or sign up by email code, magic link or both, with OAuth buttons (GitHub, Google, Microsoft, Apple or your own), resend and rate-limit countdowns. Callbacks only, any auth backend." */
/**
 * AuthCard: one sign-in or sign-up card. Email first, then a one-time code (OtpInput), a "check your inbox"
 * step for magic links, or both. Resend with a countdown, OAuth buttons, and error, rate-limit and loading states.
 *
 * It holds no auth logic: the app passes callbacks (send, verify, start OAuth) that resolve to an AuthResult.
 * Works with any backend (Better Auth, Auth.js, Supabase, your own API).
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { Button, buttonClass } from "../../button";
import { Field, Input } from "../../input";
import { OtpInput } from "../../otp-input";
import { SocialButtons, providerId, type CustomProvider, type ProviderOption } from "./social-buttons";
import { cleanCode, cleanName, formatCountdown, inboxFor, isEmail, settle, type AuthDelivery, type AuthMode, type AuthResult, type SocialProvider } from "./auth-utils";

export interface AuthCardProps {
  /** Default: "Sign in" or "Create your account", by mode. */
  title?: ReactNode;
  description?: ReactNode;
  /** "sign-up" adds an optional name field and shows `terms`. Default "sign-in". */
  mode?: AuthMode;
  /** Shows the "New here? / Already have an account?" switch under the card. */
  onModeChange?: (mode: AuthMode) => void;
  /** What the email carries. "code": type a code. "link": click a link (no code step). "both": either. Default "code". */
  delivery?: AuthDelivery;
  /** OAuth buttons above the email form: built-in names, or { id, label, icon } for your own. Empty: email only. */
  providers?: ProviderOption[];
  /** Sends the code or link. `name` is set in sign-up mode when the user typed one. */
  onSendCode: (email: string, extra: { mode: AuthMode; name?: string }) => Promise<AuthResult>;
  /** Checks the code (delivery "code" or "both"). On ok the app usually navigates away; the card keeps its loading state. */
  onVerify?: (email: string, code: string) => Promise<AuthResult>;
  /** Starts a built-in OAuth redirect. Resolve with an error to show it; on success the page navigates away. */
  onSocial?: (provider: SocialProvider) => Promise<AuthResult | void>;
  /** Starts a custom provider's redirect. */
  onProvider?: (provider: CustomProvider) => Promise<AuthResult | void>;
  codeLength?: number;
  /** Minutes the code or link is valid, for the hint. Default 10. */
  codeTtlMinutes?: number;
  /** Seconds before "Send a new code" is enabled again. Default 30. */
  resendAfterS?: number;
  defaultEmail?: string;
  /** @deprecated Use delivery="both". */
  linkSent?: boolean;
  /** An error to show on the email step from the start, e.g. an expired link that sent the user back here. */
  initialError?: string;
  /** Called after a code or link was sent (the app may show extra help, such as a dev panel). */
  onSent?: (email: string) => void;
  /** Sign-up only: the terms line under the button, e.g. links to your Terms and Privacy Policy. */
  terms?: ReactNode;
  /** Small print under the card body. */
  footer?: ReactNode;
  className?: string;
}

type Step = "email" | "code" | "link";

export function AuthCard({
  title,
  description,
  mode = "sign-in",
  onModeChange,
  delivery: deliveryProp,
  providers = [],
  onSendCode,
  onVerify,
  onSocial,
  onProvider,
  codeLength = 6,
  codeTtlMinutes = 10,
  resendAfterS = 30,
  defaultEmail = "",
  linkSent = false,
  initialError,
  onSent,
  terms,
  footer,
  className,
}: AuthCardProps) {
  const delivery: AuthDelivery = deliveryProp ?? (linkSent ? "both" : "code");
  const ids = { name: useId(), email: useId(), code: useId(), status: useId(), heading: useId() };
  const [step, setStep] = useState<Step>("email");
  const [name, setName] = useState("");
  const [email, setEmail] = useState(defaultEmail);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [social, setSocial] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; kind?: string } | null>(initialError ? { text: initialError, kind: "expired" } : null);
  const [cooldown, setCooldown] = useState(0); // resend countdown
  const [blockedFor, setBlockedFor] = useState(0); // rate-limit countdown
  const verifying = useRef(false);
  const linkHeading = useRef<HTMLHeadingElement>(null);

  // One ticking clock for both countdowns.
  useEffect(() => {
    if (cooldown <= 0 && blockedFor <= 0) return;
    const t = setTimeout(() => {
      setCooldown((s) => Math.max(0, s - 1));
      setBlockedFor((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearTimeout(t);
  }, [cooldown, blockedFor]);

  // The link step has no input to focus: move focus to its heading so keyboard and screen reader users land on it.
  useEffect(() => {
    if (step === "link") linkHeading.current?.focus();
  }, [step]);

  const fail = (r: Extract<AuthResult, { ok: false }>) => {
    setError({ text: r.error, kind: r.kind });
    if (r.kind === "rate-limit") setBlockedFor(r.retryAfterS ?? 60);
  };

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!isEmail(email)) return setError({ text: "Enter a valid email address.", kind: "invalid" });
    setBusy(true);
    setError(null);
    const typed = cleanName(name);
    const r = await settle(onSendCode(email.trim(), { mode, ...(mode === "sign-up" && typed ? { name: typed } : {}) }));
    setBusy(false);
    if (!r.ok) return fail(r);
    setStep(delivery === "link" ? "link" : "code");
    setCode("");
    setCooldown(resendAfterS);
    onSent?.(email.trim());
  };

  const verify = async (value = code) => {
    if (!onVerify || verifying.current || value.length !== codeLength) return;
    verifying.current = true;
    setBusy(true);
    setError(null);
    const r = await settle(onVerify(email.trim(), value));
    verifying.current = false;
    if (!r.ok) {
      setBusy(false);
      setCode("");
      return fail(r);
    }
    // Success: keep the loading state while the app navigates.
  };

  const startProvider = async (p: ProviderOption) => {
    const run = typeof p === "string" ? (onSocial ? () => onSocial(p) : null) : onProvider ? () => onProvider(p) : null;
    if (!run) return;
    setSocial(providerId(p));
    setError(null);
    const r = await settle(Promise.resolve(run()).then((x) => x ?? { ok: true as const }));
    if (!r.ok) {
      setSocial(null);
      fail(r);
    }
  };

  const back = () => (setStep("email"), setError(null), setCode(""));
  const blocked = blockedFor > 0;
  const errorText = error ? (blocked ? `${error.text} Try again in ${formatCountdown(blockedFor)}.` : error.text) : null;
  const shownProviders = providers.filter((p) => (typeof p === "string" ? Boolean(onSocial) : Boolean(onProvider)));
  const who = <span className="font-medium break-all">{email.trim()}</span>;
  const inbox = step === "link" ? inboxFor(email) : null;

  const resend = (
    <button
      type="button"
      disabled={cooldown > 0 || busy || blocked}
      onClick={() => void send()}
      className="rounded text-muted-foreground underline-offset-[3px] tabular-nums enabled:hover:text-foreground enabled:hover:underline disabled:opacity-60 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring"
    >
      {cooldown > 0 ? `${step === "link" ? "Resend link" : "Send a new code"} in ${formatCountdown(cooldown)}` : step === "link" ? "Resend link" : "Send a new code"}
    </button>
  );
  const another = (
    <button
      type="button"
      className="rounded text-muted-foreground underline-offset-[3px] hover:text-foreground hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring"
      onClick={back}
    >
      Use another email
    </button>
  );

  return (
    <div className={cn("w-full max-w-[400px] rounded-2xl border bg-card p-6 text-card-foreground shadow-sm sm:p-8", className)}>
      {step === "link" ? (
        <div className="grid gap-4 text-center">
          <span aria-hidden="true" className="mx-auto grid size-11 place-items-center rounded-full bg-muted text-foreground">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2.5" />
              <path d="m4 7 8 6 8-6" />
            </svg>
          </span>
          <div>
            <h1 ref={linkHeading} tabIndex={-1} className="text-[19px] font-semibold tracking-[-0.01em] outline-none">
              Check your inbox
            </h1>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
              We sent a {mode === "sign-up" ? "link to finish creating your account" : "sign-in link"} to {who}. It expires in {codeTtlMinutes} minutes. You can close this tab.
            </p>
          </div>
          {inbox && (
            <a href={inbox.href} target="_blank" rel="noreferrer" className={buttonClass("secondary", "md", false, "w-full")}>
              {inbox.label}
            </a>
          )}
          {errorText && (
            <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">
              {errorText}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
            {another}
            {resend}
          </div>
        </div>
      ) : (
        <div className="text-center">
          <h1 className="text-[19px] font-semibold tracking-[-0.01em]">{title ?? (mode === "sign-up" ? "Create your account" : "Sign in")}</h1>
          {description && <p className="mt-1.5 text-[13.5px] text-muted-foreground">{description}</p>}
        </div>
      )}

      {step === "email" && (
        <div className="mt-6 grid gap-5">
          {shownProviders.length > 0 && (
            <>
              <SocialButtons providers={shownProviders} onSelect={(p) => void startProvider(p)} pending={social} disabled={busy} verb={mode === "sign-up" ? "Sign up with" : "Continue with"} />
              <div className="flex items-center gap-3 text-[12px] text-muted-foreground" aria-hidden="true">
                <span className="h-px flex-1 bg-border" />
                or
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}
          <form onSubmit={send} className="grid gap-4" noValidate>
            {mode === "sign-up" && (
              <Field label="Name" id={ids.name} optional>
                <Input id={ids.name} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" maxLength={80} disabled={busy || social !== null} />
              </Field>
            )}
            <Field label="Email address" id={ids.email} error={errorText ?? undefined}>
              <Input
                id={ids.email}
                type="email"
                autoComplete="email"
                inputMode="email"
                autoFocus={mode === "sign-in"}
                value={email}
                onChange={(e) => (setEmail(e.target.value), error?.kind === "invalid" && setError(null))}
                placeholder="you@company.com"
                invalid={Boolean(errorText)}
                disabled={busy || social !== null}
              />
            </Field>
            <Button type="submit" loading={busy} disabled={blocked || social !== null} className="w-full">
              {mode === "sign-up" ? "Create account" : "Continue"}
            </Button>
            {mode === "sign-up" && terms && <p className="text-center text-[12px] leading-relaxed text-muted-foreground">{terms}</p>}
          </form>
        </div>
      )}

      {step === "code" && (
        <form onSubmit={(e) => (e.preventDefault(), verify())} className="mt-6 grid gap-4" noValidate>
          <p className="text-[13.5px] leading-relaxed">
            {delivery === "both" ? (
              <>
                We emailed a sign-in link and a {codeLength}-digit code to {who}. Click the link, or enter the code here. Both expire in {codeTtlMinutes} minutes.
              </>
            ) : (
              <>
                We sent a {codeLength}-digit code to {who}. It expires in {codeTtlMinutes} minutes.
              </>
            )}
          </p>
          <Field label="Code" id={ids.code} error={errorText ?? undefined}>
            <OtpInput
              id={ids.code}
              length={codeLength}
              value={code}
              onValueChange={(v) => setCode(cleanCode(v, codeLength))}
              onComplete={(v) => void verify(v)}
              groups={codeLength === 6 ? [3] : undefined}
              invalid={Boolean(errorText)}
              disabled={busy || blocked}
              autoFocus
              aria-label={`${codeLength}-digit code`}
            />
          </Field>
          <Button type="submit" loading={busy} disabled={code.length !== codeLength || blocked} className="w-full">
            Verify
          </Button>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
            {another}
            {resend}
          </div>
        </form>
      )}

      {/* Announces step changes and sends to screen readers. */}
      <p id={ids.status} role="status" aria-live="polite" className="sr-only">
        {step === "code" && !busy ? `Code sent to ${email.trim()}.` : step === "link" ? `Link sent to ${email.trim()}.` : ""}
      </p>
      {footer && <div className="mt-6 text-center text-[12px] text-muted-foreground">{footer}</div>}
      {onModeChange && step === "email" && (
        <p className="mt-5 text-center text-[13px] text-muted-foreground">
          {mode === "sign-up" ? "Already have an account? " : "New here? "}
          <button
            type="button"
            onClick={() => (onModeChange(mode === "sign-up" ? "sign-in" : "sign-up"), setError(null))}
            className="rounded font-medium text-foreground underline-offset-[3px] hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring"
          >
            {mode === "sign-up" ? "Sign in" : "Create an account"}
          </button>
        </p>
      )}
    </div>
  );
}
