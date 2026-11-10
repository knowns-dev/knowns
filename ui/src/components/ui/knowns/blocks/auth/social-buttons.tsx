"use client";
/** @registry part-of="auth-card" */
/** OAuth sign-in buttons: GitHub, Google, Microsoft, Apple, or your own. Callbacks only; the app starts the OAuth flow. */
import type { ReactNode } from "react";
import { Button } from "../../button";
import { PROVIDER_NAME, type SocialProvider } from "./auth-utils";

/** A provider we don't ship an icon for (an SSO, GitLab, your own IdP). */
export interface CustomProvider {
  id: string;
  label: string;
  icon?: ReactNode;
}

export type ProviderOption = SocialProvider | CustomProvider;

export const providerId = (p: ProviderOption) => (typeof p === "string" ? p : p.id);
export const providerLabel = (p: ProviderOption) => (typeof p === "string" ? PROVIDER_NAME[p] : p.label);

export interface SocialButtonsProps {
  providers: ProviderOption[];
  /** Called with the built-in provider name, or the custom provider object. */
  onSelect: (provider: ProviderOption) => void;
  /** The provider id whose redirect is starting (shows a spinner on it, disables the rest). */
  pending?: string | null;
  disabled?: boolean;
  /** "Continue with" by default. */
  verb?: string;
}

export function SocialButtons({ providers, onSelect, pending = null, disabled, verb = "Continue with" }: SocialButtonsProps) {
  if (providers.length === 0) return null;
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: providers.length > 1 ? "repeat(auto-fit, minmax(9rem, 1fr))" : undefined }}>
      {providers.map((p) => {
        const id = providerId(p);
        return (
          <Button
            key={id}
            type="button"
            variant="secondary"
            className="w-full"
            loading={pending === id}
            disabled={disabled || (pending !== null && pending !== id)}
            onClick={() => onSelect(p)}
            aria-label={`${verb} ${providerLabel(p)}`}
            // As the icon prop, so the loading spinner takes its place instead of stacking on top.
            icon={typeof p === "string" ? ICON[p]() : p.icon}
          >
            {providerLabel(p)}
          </Button>
        );
      })}
    </div>
  );
}

export const GitHubIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.88.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
);

export const GoogleIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.63h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.56-5.17 3.56-8.8Z" />
    <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.11A12 12 0 0 0 12 24Z" />
    <path fill="#FBBC05" d="M5.29 14.29a7.2 7.2 0 0 1 0-4.58V6.6H1.28a12 12 0 0 0 0 10.8l4.01-3.11Z" />
    <path fill="#EA4335" d="M12 4.75c1.76 0 3.34.6 4.59 1.8l3.44-3.44A11.5 11.5 0 0 0 12 0 12 12 0 0 0 1.28 6.6l4.01 3.11C6.23 6.86 8.88 4.75 12 4.75Z" />
  </svg>
);

export const MicrosoftIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path fill="#F25022" d="M1 1h6.5v6.5H1z" />
    <path fill="#7FBA00" d="M8.5 1H15v6.5H8.5z" />
    <path fill="#00A4EF" d="M1 8.5h6.5V15H1z" />
    <path fill="#FFB900" d="M8.5 8.5H15V15H8.5z" />
  </svg>
);

export const AppleIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <path d="M11.18 8.5c-.02-1.6 1.31-2.37 1.37-2.41-.75-1.09-1.91-1.24-2.32-1.26-.99-.1-1.93.58-2.43.58-.5 0-1.27-.57-2.09-.55A3.1 3.1 0 0 0 3.1 6.45c-1.12 1.94-.29 4.81.8 6.38.53.77 1.17 1.63 2 1.6.8-.03 1.11-.52 2.08-.52.97 0 1.24.52 2.09.5.86-.01 1.41-.78 1.94-1.55.61-.89.86-1.75.88-1.8-.02 0-1.69-.65-1.71-2.56ZM9.6 3.8c.44-.54.74-1.28.66-2.03-.64.03-1.41.43-1.87.96-.41.47-.77 1.24-.67 1.97.71.06 1.44-.36 1.88-.9Z" />
  </svg>
);

const ICON: Record<SocialProvider, () => ReactNode> = { github: GitHubIcon, google: GoogleIcon, microsoft: MicrosoftIcon, apple: AppleIcon };
