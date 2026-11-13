import type { ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";

export interface AuthPageAside {
  eyebrow?: ReactNode;
  headline: ReactNode;
  description?: ReactNode;
  /** Short points with an optional icon each, e.g. what the product does. Keep them factual. */
  points?: { icon?: ReactNode; text: ReactNode }[];
  /** Behind the panel content, e.g. a Backgrounds block. Gets `absolute inset-0`. */
  background?: ReactNode;
  /** Pinned to the bottom of the panel: a legal line, a status link. */
  bottom?: ReactNode;
}

export interface AuthPageProps {
  variant?: "centered" | "split";
  /** Your logo or wordmark. In split, it sits on the panel (and above the form on small screens). */
  logo?: ReactNode;
  /** Top-right of the form side, e.g. "Have an account? Sign in". */
  topRight?: ReactNode;
  /** The card or form. */
  children: ReactNode;
  /** Under the form: Terms, Privacy, Help links. */
  footer?: ReactNode;
  /** Split only. */
  aside?: AuthPageAside;
  /** Full viewport height with a <main> landmark (default), or the parent's height without one, e.g. inside a preview. */
  fill?: "screen" | "parent";
  className?: string;
}

export function AuthPage({ variant = "centered", logo, topRight, children, footer, aside, fill = "screen", className }: AuthPageProps) {
  const height = fill === "screen" ? "min-h-dvh" : "min-h-full";
  // Embedded (fill="parent", e.g. a docs preview) it must not add a second <main> landmark to the page.
  const Main = fill === "screen" ? "main" : "div";
  const form = (
    <div className="relative flex flex-1 flex-col px-4 py-6 sm:px-8">
      {/* The top row only when there's something in it (a site header may already carry the logo). */}
      {(logo || topRight) && (
        <div className={cn("flex min-h-8 items-center gap-3", variant === "split" ? "justify-between lg:justify-end" : "justify-between")}>
          <div className={cn(variant === "split" && "lg:hidden")}>{logo}</div>
          {topRight && <div className="text-[13px] text-muted-foreground">{topRight}</div>}
        </div>
      )}
      <Main className="flex flex-1 flex-col items-center justify-center py-8">{children}</Main>
      {footer && <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">{footer}</footer>}
    </div>
  );

  if (variant === "centered" || !aside) return <div className={cn("flex w-full flex-col bg-background text-foreground", height, className)}>{form}</div>;

  return (
    <div className={cn("grid w-full bg-background text-foreground lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]", height, className)}>
      <aside className="relative hidden overflow-hidden border-r bg-muted/40 lg:flex lg:flex-col">
        {aside.background && <div className="pointer-events-none absolute inset-0">{aside.background}</div>}
        <div className="relative flex flex-1 flex-col p-10">
          <div>{logo}</div>
          <div className="my-auto max-w-[440px] py-10">
            {aside.eyebrow && <p className="text-[12.5px] font-medium text-muted-foreground">{aside.eyebrow}</p>}
            <h2 className="mt-2 text-[28px] leading-[1.15] font-semibold tracking-[-0.02em] text-balance">{aside.headline}</h2>
            {aside.description && <p className="mt-3 text-[14.5px] leading-relaxed text-muted-foreground">{aside.description}</p>}
            {aside.points && aside.points.length > 0 && (
              <ul className="mt-7 grid gap-3.5">
                {aside.points.map((p, i) => (
                  <li key={i} className="flex gap-3 text-[14px] leading-snug">
                    <span aria-hidden="true" className="mt-0.5 grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                      {p.icon ?? (
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m3.5 8.5 3 3 6-7" />
                        </svg>
                      )}
                    </span>
                    <span>{p.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {aside.bottom && <div className="text-[12px] text-muted-foreground">{aside.bottom}</div>}
        </div>
      </aside>
      {form}
    </div>
  );
}
