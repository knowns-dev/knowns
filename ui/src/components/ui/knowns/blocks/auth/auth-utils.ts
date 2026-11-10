export type AuthResult =
  | { ok: true }
  | { ok: false; error: string; kind?: AuthErrorKind; retryAfterS?: number };

export type AuthErrorKind = "invalid" | "expired" | "locked" | "rate-limit" | "network" | "unknown";

/** Built-in OAuth buttons (brand icon and name included). */
export type SocialProvider = "github" | "google" | "microsoft" | "apple";

export const PROVIDER_NAME: Record<SocialProvider, string> = { github: "GitHub", google: "Google", microsoft: "Microsoft", apple: "Apple" };

/** sign-in: email first. sign-up: also asks for a name (optional) and shows the terms line. */
export type AuthMode = "sign-in" | "sign-up";

/** What the email carries: a code to type, a link to click, or both. */
export type AuthDelivery = "code" | "link" | "both";

/** Sign-up names: trimmed, inner spaces collapsed, at most 80 characters. Empty is allowed (the field is optional). */
export function cleanName(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** The webmail inbox for an address, for an "Open Gmail" style shortcut on the link step. Null for unknown domains. */
export function inboxFor(email: string): { label: string; href: string } | null {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  if (domain === "gmail.com" || domain === "googlemail.com") return { label: "Open Gmail", href: "https://mail.google.com/mail/u/0/#inbox" };
  if (/^(outlook|hotmail|live|msn)\./.test(domain)) return { label: "Open Outlook", href: "https://outlook.live.com/mail/0/" };
  if (domain === "yahoo.com") return { label: "Open Yahoo Mail", href: "https://mail.yahoo.com/" };
  if (domain === "icloud.com" || domain === "me.com") return { label: "Open iCloud Mail", href: "https://www.icloud.com/mail" };
  if (domain === "proton.me" || domain === "protonmail.com") return { label: "Open Proton Mail", href: "https://mail.proton.me/" };
  return null;
}

/** Lenient on purpose: the server decides. Catches typos like a missing @ or domain. */
export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
}

/** "45s", "1:05". */
export function formatCountdown(s: number): string {
  const n = Math.max(0, Math.ceil(s));
  return n < 60 ? `${n}s` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

/** Only digits, at most `length`. */
export function cleanCode(s: string, length = 6): string {
  return s.replace(/\D/g, "").slice(0, length);
}

/** A thrown error (offline, CORS, 500 HTML) as an AuthResult, so the card never gets stuck loading. */
export async function settle(p: Promise<AuthResult>): Promise<AuthResult> {
  try {
    return await p;
  } catch (e) {
    return { ok: false, kind: "network", error: e instanceof Error && e.message ? e.message : "Could not reach the server. Check your connection and try again." };
  }
}
