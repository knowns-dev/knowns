import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Join class names and resolve Tailwind conflicts, so the last class wins: a `className` you pass beats the
 * component's own `bg-*`, `text-*`, `rounded-*` or `p-*`. Falsy values (false, null, undefined, 0, "") are skipped.
 */
export function cn(...classes: unknown[]) {
  return twMerge(clsx(classes as Parameters<typeof clsx>));
}

/** Shared focus ring for interactive elements. */
export const focusRing = "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * How much `el` is drawn bigger or smaller than its layout size: CSS `zoom` on an ancestor, or a scale
 * transform. getBoundingClientRect is in screen px; offsetWidth and SVG drawing coordinates are not.
 */
export function layoutScale(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  const x = el.offsetWidth ? r.width / el.offsetWidth : 1;
  const y = el.offsetHeight ? r.height / el.offsetHeight : 1;
  return { x: x || 1, y: y || 1 };
}

/**
 * `el`'s box relative to `root`, in root's own layout px (what an absolutely placed child or an SVG inside
 * root draws in), so it stays right under CSS zoom and scale transforms. Rotation and skew are not handled.
 */
export function localRect(el: Element, root: HTMLElement) {
  const R = root.getBoundingClientRect();
  const s = layoutScale(root);
  const r = el.getBoundingClientRect();
  const left = (r.left - R.left) / s.x;
  const top = (r.top - R.top) / s.y;
  const width = r.width / s.x;
  const height = r.height / s.y;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/**
 * Put text on the clipboard. Uses the async Clipboard API where the page allows it (HTTPS or localhost), and
 * falls back to a hidden textarea + execCommand("copy") on plain-HTTP pages and older browsers, where
 * navigator.clipboard is missing. Rejects when both fail, so callers keep their "blocked" branch.
 */
export async function writeClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* permission denied or not focused: try the fallback */
    }
  }
  if (typeof document === "undefined") throw new Error("clipboard unavailable");
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  const active = document.activeElement as HTMLElement | null;
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    area.remove();
    active?.focus?.({ preventScroll: true });
  }
  if (!ok) throw new Error("clipboard unavailable");
}
