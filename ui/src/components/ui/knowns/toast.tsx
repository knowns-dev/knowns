"use client";
/** @registry name="toast" type="ui" title="Toast" description="Notifications with ToastProvider and useToast()." */

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { cn } from "@/ui/lib/knowns/utils";

export type ToastTone = "neutral" | "success" | "warning" | "danger";
export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** e.g. { label: "Undo", onClick } */
  action?: { label: string; onClick: () => void };
  /** ms before it hides; hovering pauses. Default 4500. */
  duration?: number;
}
type Item = ToastOptions & { id: number; closing?: boolean };

const ToastCtx = createContext<((t: ToastOptions) => number) | null>(null);
const DismissCtx = createContext<((id: number) => void) | null>(null);

/** `const toast = useToast(); toast({ title: "Saved" })`. Needs a <ToastProvider> above. */
export function useToast() {
  const t = useContext(ToastCtx);
  if (!t) throw new Error("useToast needs a <ToastProvider>");
  return t;
}

/** `const dismiss = useDismissToast(); dismiss(id)` closes the toast whose id `toast()` returned. */
export function useDismissToast() {
  const d = useContext(DismissCtx);
  if (!d) throw new Error("useDismissToast needs a <ToastProvider>");
  return d;
}

const DOT: Record<ToastTone, string> = {
  neutral: "bg-muted-foreground",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  // Removing plays the exit first (the enter in reverse: it goes back down), then drops the item.
  const remove = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, closing: true } : x)));
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 140);
  }, []);
  const arm = useCallback((id: number, ms: number) => timers.current.set(id, setTimeout(() => remove(id), ms)), [remove]);

  const toast = useCallback(
    (t: ToastOptions) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      arm(id, t.duration ?? 4500);
      return id;
    },
    [arm],
  );

  return (
    <ToastCtx.Provider value={toast}>
      <DismissCtx.Provider value={remove}>{children}</DismissCtx.Provider>
      <ol aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
        {items.map((t) => (
          <li
            key={t.id}
            data-state={t.closing ? "closed" : "open"}
            onPointerEnter={() => clearTimeout(timers.current.get(t.id))}
            onPointerLeave={() => arm(t.id, 2000)}
            className="pointer-events-auto flex items-start gap-3 rounded-xl border bg-popover px-3.5 py-3 text-[13px] text-popover-foreground shadow-[0_12px_32px_-12px_rgb(0_0_0/0.3)] transition-[opacity,translate] duration-[var(--kn-dur,180ms)] ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))] starting:translate-y-1 starting:opacity-0 data-[state=closed]:pointer-events-none data-[state=closed]:translate-y-1 data-[state=closed]:opacity-0 data-[state=closed]:duration-[var(--kn-dur-fast,120ms)] motion-reduce:transition-none"
          >
            <span aria-hidden="true" className={cn("mt-1.5 size-1.5 flex-none rounded-full", DOT[t.tone ?? "neutral"])} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t.title}</div>
              {t.description && <div className="mt-0.5 text-muted-foreground">{t.description}</div>}
            </div>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action!.onClick();
                  remove(t.id);
                }}
                className="flex-none rounded-md px-2 py-0.5 text-[12.5px] font-medium text-foreground hover:bg-muted focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring"
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => remove(t.id)}
              className="-mr-1 grid size-5 flex-none place-items-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring"
            >
              <svg viewBox="0 0 16 16" className="size-3">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </li>
        ))}
      </ol>
    </ToastCtx.Provider>
  );
}
