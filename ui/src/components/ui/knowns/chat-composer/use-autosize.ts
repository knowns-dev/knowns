import { useLayoutEffect, type RefObject } from "react";

/**
 * Grows a textarea with its content, up to `maxRows` lines, then scrolls. Re-measures when
 * the text changes and when the textarea's width changes (wrapping moves).
 */
export function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxRows: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.clientWidth;
    const fit = () => {
      const cs = getComputedStyle(el);
      const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 21;
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const max = line * Math.max(1, maxRows) + pad;
      el.style.height = "auto";
      const full = el.scrollHeight;
      el.style.height = `${Math.min(full, max)}px`;
      el.style.overflowY = full > max + 1 ? "auto" : "hidden";
    };
    fit();
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, value, maxRows]);
}
