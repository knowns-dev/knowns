import { useEffect, useRef, type ReactNode } from "react"

import { cn } from "@/ui/lib/utils"

/*
 * Dialogs and sheets are native modal <dialog>s in the browser top layer, which paints above any z-index. Page
 * level notices that used a high z-index to sit above a dialog (toasts, status banners) render in a TopLayer
 * instead: a manual popover, also in the top layer, raised again whenever a dialog opens so it stays on top.
 * While a modal is open the notice is visible but not clickable (the page outside the modal is inert).
 */

const layers = new Set<HTMLElement>()
let observer: MutationObserver | null = null

function raise(el: HTMLElement) {
  try {
    if (el.matches(":popover-open")) el.hidePopover()
    el.showPopover()
  } catch {
    // Not connected, or popovers unsupported: the content still renders in place.
  }
}

function watch(el: HTMLElement) {
  layers.add(el)
  if (!observer && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver((records) => {
      if (records.some((r) => r.target instanceof HTMLDialogElement && r.target.open)) layers.forEach(raise)
    })
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] })
  }
  return () => {
    layers.delete(el)
    if (layers.size === 0) {
      observer?.disconnect()
      observer = null
    }
  }
}

/** Renders `children` above every open dialog. The wrapper has no size; children position themselves (fixed). */
/** `passThrough`: children keep pointer-events none unless they opt in (the toast list does this per toast). */
export function TopLayer({ children, className, passThrough }: { children?: ReactNode; className?: string; passThrough?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof el.showPopover !== "function") return
    raise(el)
    return watch(el)
  }, [])
  return (
    <div
      ref={ref}
      popover="manual"
      className={cn("pointer-events-none m-0 h-0 w-0 overflow-visible border-0 bg-transparent p-0", !passThrough && "[&>*]:pointer-events-auto", className)}
    >
      {children}
    </div>
  )
}
