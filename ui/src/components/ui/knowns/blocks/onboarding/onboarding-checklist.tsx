"use client";
/** @registry name="onboarding-checklist" type="block" title="Onboarding checklist" description="First-run steps for a dashboard corner: progress, done, current and locked states, a call to action and an optional how-to on each step, snooze and dismiss, and a calm completion state." */
/**
 * Onboarding checklist: a compact card of first-run steps. Controlled: you own `steps[].done`; the block shows
 * "3 of 5", opens the current step, lets people open any other available step, and calls back for each action.
 * Done steps are plain rows, locked steps say why, and finishing the last step swaps the list for a short
 * completion message (a single pop of the check, still for reduced motion).
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { Button, buttonClass } from "../../button";
import { Progress } from "../../progress";
import { checklistCounts, checklistStatus, currentStepId, lockedReason, progressLabel, type ChecklistStatus } from "./onboarding-utils";

export interface ChecklistStep {
  id: string;
  title: ReactNode;
  /** One or two lines shown when the step is open. */
  description?: ReactNode;
  /** The action for this step. With `href` it renders as a link; `onClick` also fires `onStepAction`. */
  cta?: { label: ReactNode; href?: string; onClick?: () => void };
  /** Extra help behind a "How to" disclosure inside the open step. */
  how?: ReactNode;
  done?: boolean;
  /** Not available yet. A string is shown as the reason. */
  locked?: boolean | string;
}

export interface OnboardingChecklistProps {
  steps: ChecklistStep[];
  title?: ReactNode;
  description?: ReactNode;
  /** Called for every step action (the CTA click), with the step id. */
  onStepAction?: (id: string) => void;
  /** Shows "Remind me later". The block does not hide itself: set `dismissed` or unmount it. */
  onSnooze?: () => void;
  /** Shows "Dismiss". */
  onDismiss?: () => void;
  /** Renders nothing when true. */
  dismissed?: boolean;
  /** Heading of the completion state. */
  completeTitle?: ReactNode;
  completeDescription?: ReactNode;
  className?: string;
  "aria-label"?: string;
}

/* ── Icons ── */

const Check = ({ className = "size-3.5" }: { className?: string }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
    <path d="m4 8.5 2.5 2.5L12 5.5" />
  </svg>
);
const Lock = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-3">
    <rect x="3.5" y="7" width="9" height="6" rx="1.5" />
    <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" />
  </svg>
);
const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform ease-(--kn-ease-out) motion-reduce:transition-none", open && "rotate-90")}>
    <path d="m6 3.5 4.5 4.5L6 12.5" />
  </svg>
);

const MARK: Record<ChecklistStatus, string> = {
  done: "bg-primary text-primary-foreground",
  current: "bg-card text-foreground shadow-[0_0_0_1.5px_var(--foreground),0_0_0_4px_color-mix(in_srgb,var(--foreground)_8%,transparent)]",
  todo: "bg-card text-muted-foreground shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_18%,transparent)]",
  locked: "bg-muted text-muted-foreground",
};
const STATUS_WORD: Record<ChecklistStatus, string> = { done: "Done", current: "Next", todo: "To do", locked: "Locked" };

function Mark({ status }: { status: ChecklistStatus }) {
  return (
    <span aria-hidden="true" className={cn("mt-px flex size-5 shrink-0 items-center justify-center rounded-full", MARK[status])}>
      {status === "done" ? <Check /> : status === "locked" ? <Lock /> : status === "current" ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
    </span>
  );
}

/* ── Component ── */

/** A first-run checklist card: progress, steps with a call to action, and a quiet way out. */
export function OnboardingChecklist({
  steps,
  title = "Get set up",
  description,
  onStepAction,
  onSnooze,
  onDismiss,
  dismissed = false,
  completeTitle = "You're all set",
  completeDescription = "Everything on the list is done. You can find these steps again in Settings.",
  className,
  "aria-label": ariaLabel,
}: OnboardingChecklistProps) {
  const uid = useId();
  const { done, total, complete } = checklistCounts(steps);
  const currentId = currentStepId(steps);
  // undefined: follow the current step; null: everything closed; otherwise the id the person opened.
  const [open, setOpen] = useState<string | null | undefined>(undefined);
  useEffect(() => setOpen(undefined), [currentId]);
  const openId = open === undefined ? currentId : open;

  if (dismissed) return null;

  const shell = cn("w-full rounded-xl border bg-card p-4 text-card-foreground @container sm:p-5", className);

  if (complete) {
    return (
      <section role="status" aria-label={ariaLabel ?? "Setup complete"} className={shell}>
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="flex size-8 shrink-0 animate-[kn-pop_.28s_var(--kn-ease-out)_both] items-center justify-center rounded-full bg-primary text-primary-foreground motion-reduce:animate-none">
            <Check className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] leading-6 font-semibold text-foreground">{completeTitle}</h3>
            <p className="mt-0.5 text-[13.5px] leading-5 text-muted-foreground">{completeDescription}</p>
            {onDismiss && (
              <Button size="sm" variant="secondary" className="mt-3" onClick={onDismiss}>
                Dismiss
              </Button>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-label={ariaLabel ?? (typeof title === "string" ? title : "Setup checklist")} className={shell}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[15px] leading-6 font-semibold text-foreground">{title}</h3>
        <span aria-hidden="true" className="text-[12.5px] text-muted-foreground tabular-nums">
          {progressLabel(done, total)}
        </span>
      </div>
      {description && <p className="mt-0.5 text-[13.5px] leading-5 text-muted-foreground">{description}</p>}
      <Progress aria-label="Setup progress" value={done} max={Math.max(total, 1)} valueLabel="none" size="sm" tone="neutral" className="mt-3" format={() => progressLabel(done, total)} />
      <p className="sr-only" aria-live="polite">
        {progressLabel(done, total)} steps done
      </p>

      <ol className="mt-3 flex flex-col">
        {steps.map((step) => {
          const status = checklistStatus(step, currentId);
          const reason = lockedReason(step);
          const panelId = `${uid}-${step.id}`;
          const expanded = openId === step.id;
          const heading = (
            <>
              <Mark status={status} />
              <span className="min-w-0 flex-1 text-left">
                <span className={cn("block text-[14px] leading-5", status === "done" ? "text-muted-foreground line-through decoration-muted-foreground/50" : "font-semibold text-foreground", status === "locked" && "font-normal text-muted-foreground")}>
                  {step.title}
                </span>
                {status === "locked" && reason && <span className="mt-0.5 block text-[12.5px] leading-4 text-muted-foreground">{reason}</span>}
              </span>
              <span className="sr-only">{`, ${STATUS_WORD[status]}`}</span>
            </>
          );
          return (
            <li key={step.id} className="border-t first:border-t-0">
              {status === "done" || status === "locked" ? (
                <div className="flex items-start gap-3 py-2.5">{heading}</div>
              ) : (
                <>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    onClick={() => setOpen(expanded ? null : step.id)}
                    className={cn("flex w-full items-start gap-3 rounded-md py-2.5 text-left", focusRing)}
                  >
                    {heading}
                    <Chevron open={expanded} />
                  </button>
                  <div id={panelId} hidden={!expanded} className="pb-3 pl-8">
                    {step.description && <p className="text-[13.5px] leading-5 text-muted-foreground">{step.description}</p>}
                    {step.cta &&
                      (step.cta.href ? (
                        <a
                          href={step.cta.href}
                          onClick={() => {
                            step.cta?.onClick?.();
                            onStepAction?.(step.id);
                          }}
                          className={cn(buttonClass(status === "current" ? "primary" : "secondary", "sm"), "mt-2.5")}
                        >
                          {step.cta.label}
                        </a>
                      ) : (
                        <Button
                          size="sm"
                          variant={status === "current" ? "primary" : "secondary"}
                          className="mt-2.5"
                          onClick={() => {
                            step.cta?.onClick?.();
                            onStepAction?.(step.id);
                          }}
                        >
                          {step.cta.label}
                        </Button>
                      ))}
                    {step.how && (
                      <details className="group mt-2.5 text-[13px] leading-5 text-muted-foreground">
                        <summary className={cn("w-fit cursor-pointer rounded-sm text-foreground underline-offset-2 hover:underline", focusRing)}>How to</summary>
                        <div className="mt-1.5">{step.how}</div>
                      </details>
                    )}
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ol>

      {(onSnooze || onDismiss) && (
        <div className="mt-2 flex items-center justify-end gap-1 border-t pt-3">
          {onSnooze && (
            <Button size="xs" variant="quiet" onClick={onSnooze}>
              Remind me later
            </Button>
          )}
          {onDismiss && (
            <Button size="xs" variant="quiet" onClick={onDismiss}>
              Dismiss
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
