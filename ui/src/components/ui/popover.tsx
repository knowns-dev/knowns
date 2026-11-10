import * as React from "react"
import { createPortal } from "react-dom"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "@/ui/lib/utils"
import { FLOAT_FADE, setRefs, useFloating } from "@/ui/components/ui/knowns/use-floating"

/*
 * Popover with the old Radix/shadcn API (Popover, PopoverTrigger asChild, PopoverContent align/side/sideOffset)
 * on Knowns UI's useFloating: fixed positioning that flips and stays in the viewport, the Knowns UI fade, and a
 * portal into the nearest open <dialog> (else <body>), so a popover opened inside a dialog or sheet is clickable.
 * Escape and a press outside close it; focus moves into the panel and back to the trigger.
 */

interface PopoverContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  triggerRef: React.RefObject<HTMLElement | null>
  anchorRef: React.RefObject<HTMLElement | null>
  contentId: string
}

const PopoverContext = React.createContext<PopoverContextValue | null>(null)

function usePopover(name: string) {
  const ctx = React.useContext(PopoverContext)
  if (!ctx) throw new Error(`<${name}> must be used inside <Popover>`)
  return ctx
}

interface PopoverProps {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** Accepted for Radix compatibility; unused. */
  modal?: boolean
  children?: React.ReactNode
}

function Popover({ open: openProp, defaultOpen = false, onOpenChange, children }: PopoverProps) {
  const [own, setOwn] = React.useState(defaultOpen)
  const open = openProp ?? own
  const onOpenChangeRef = React.useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  const controlled = openProp !== undefined
  const setOpen = React.useCallback(
    (v: boolean) => {
      if (!controlled) setOwn(v)
      onOpenChangeRef.current?.(v)
    },
    [controlled]
  )
  const triggerRef = React.useRef<HTMLElement | null>(null)
  const anchorRef = React.useRef<HTMLElement | null>(null)
  const contentId = React.useId()
  const value = React.useMemo(() => ({ open, setOpen, triggerRef, anchorRef, contentId }), [open, setOpen, contentId])
  return <PopoverContext.Provider value={value}>{children}</PopoverContext.Provider>
}

type TriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }

const PopoverTrigger = React.forwardRef<HTMLButtonElement, TriggerProps>(({ asChild, onClick, ...props }, ref) => {
  const { open, setOpen, triggerRef, contentId } = usePopover("PopoverTrigger")
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      ref={(node: HTMLButtonElement | null) => setRefs(node, ref, triggerRef as React.Ref<HTMLButtonElement>)}
      type={asChild ? undefined : "button"}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? contentId : undefined}
      data-state={open ? "open" : "closed"}
      onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(e)
        if (!e.defaultPrevented) setOpen(!open)
      }}
      {...props}
    />
  )
})
PopoverTrigger.displayName = "PopoverTrigger"

/** Positions the content against this element instead of the trigger. */
const PopoverAnchor = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { asChild?: boolean }>(
  ({ asChild, ...props }, ref) => {
    const { anchorRef } = usePopover("PopoverAnchor")
    const Comp = asChild ? Slot : "div"
    return <Comp ref={(node: HTMLDivElement | null) => setRefs(node, ref, anchorRef as React.Ref<HTMLDivElement>)} {...props} />
  }
)
PopoverAnchor.displayName = "PopoverAnchor"

const TABBABLE =
  "button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
const tabbables = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.getClientRects().length > 0)

interface PopoverContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  sideOffset?: number
  /** Minimum distance from the viewport edges, px. */
  collisionPadding?: number
  /** Accepted for Radix compatibility: the panel always portals into the nearest open dialog, else <body>. */
  container?: HTMLElement | null
  onOpenAutoFocus?: (event: Event) => void
  onCloseAutoFocus?: (event: Event) => void
  onEscapeKeyDown?: (event: KeyboardEvent) => void
  onInteractOutside?: (event: Event) => void
  onPointerDownOutside?: (event: Event) => void
  forceMount?: true
}

const PopoverContent = React.forwardRef<HTMLDivElement, PopoverContentProps>(
  (
    {
      className,
      side = "bottom",
      align = "center",
      sideOffset = 4,
      collisionPadding = 8,
      container: _container,
      onOpenAutoFocus,
      onCloseAutoFocus,
      onEscapeKeyDown,
      onInteractOutside,
      onPointerDownOutside,
      forceMount: _forceMount,
      onKeyDown,
      style: styleProp,
      children,
      ...props
    },
    ref
  ) => {
    const { open, setOpen, triggerRef, anchorRef, contentId } = usePopover("PopoverContent")
    const floating = useFloating<HTMLElement, HTMLDivElement>({ open, side, align, offset: sideOffset, margin: collisionPadding })
    // Anchor the panel to PopoverAnchor or the trigger (both set their node into the shared context).
    floating.triggerRef.current = anchorRef.current ?? triggerRef.current
    const { floatingRef, style, placement, portalHost, ready, closing } = floating

    const callbacks = React.useRef({ onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown, onInteractOutside, onPointerDownOutside })
    callbacks.current = { onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown, onInteractOutside, onPointerDownOutside }

    const close = React.useCallback(
      (refocus: boolean) => {
        setOpen(false)
        if (!refocus) return
        const event = new Event("closeAutoFocus", { cancelable: true })
        callbacks.current.onCloseAutoFocus?.(event)
        if (!event.defaultPrevented) triggerRef.current?.focus({ preventScroll: true })
      },
      [setOpen, triggerRef]
    )

    // Focus moves in once the panel is placed (it is visibility:hidden until then), unless something inside
    // (an autoFocus input) already took it or onOpenAutoFocus cancels.
    React.useEffect(() => {
      if (!ready) return
      const panel = floatingRef.current
      if (!panel || panel.contains(document.activeElement)) return
      const event = new Event("openAutoFocus", { cancelable: true })
      callbacks.current.onOpenAutoFocus?.(event)
      if (event.defaultPrevented) return
      ;(panel.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? tabbables(panel)[0] ?? panel).focus({ preventScroll: true })
    }, [ready, floatingRef])

    React.useEffect(() => {
      if (!open) return
      const onDown = (e: PointerEvent) => {
        const t = e.target as Node
        if (floatingRef.current?.contains(t) || triggerRef.current?.contains(t)) return
        const event = new Event("pointerDownOutside", { cancelable: true })
        callbacks.current.onPointerDownOutside?.(event)
        callbacks.current.onInteractOutside?.(event)
        if (!event.defaultPrevented) close(false)
      }
      const onKey = (e: KeyboardEvent) => {
        // Already handled inside (e.g. a combobox in the panel closed its own list).
        if (e.key !== "Escape" || e.defaultPrevented) return
        callbacks.current.onEscapeKeyDown?.(e)
        const keep = e.defaultPrevented
        e.preventDefault() // keep an enclosing <dialog> open
        if (!keep) close(true)
      }
      document.addEventListener("pointerdown", onDown)
      document.addEventListener("keydown", onKey)
      return () => {
        document.removeEventListener("pointerdown", onDown)
        document.removeEventListener("keydown", onKey)
      }
    }, [open, close, floatingRef, triggerRef])

    /** The panel lives at the end of its host: stitch it into the tab order right after the trigger. */
    const onPanelKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(e)
      if (e.defaultPrevented || e.key !== "Tab") return
      const panel = floatingRef.current
      const t = triggerRef.current
      if (!panel || !t) return
      const inside = tabbables(panel)
      const first = inside[0] ?? panel
      const last = inside[inside.length - 1] ?? panel
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        t.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        const all = tabbables(t.closest("dialog[open]") ?? document).filter((el) => !panel.contains(el))
        const next = all[all.indexOf(t) + 1]
        setOpen(false)
        ;(next ?? t).focus()
      }
    }

    if (!portalHost) return null
    return createPortal(
      <div
        ref={(node: HTMLDivElement | null) => setRefs(node, floatingRef, ref)}
        id={contentId}
        role="dialog"
        tabIndex={-1}
        data-side={placement}
        data-state={closing ? "closed" : "open"}
        style={{ ...styleProp, ...style }}
        onKeyDown={onPanelKey}
        className={cn(
          "z-[60] w-72 overflow-auto rounded-xl bg-popover p-4 text-[13px] text-popover-foreground outline-none",
          "shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_12%,transparent),0_12px_32px_-12px_rgb(0_0_0/0.3),0_2px_6px_rgb(0_0_0/0.06)]",
          FLOAT_FADE,
          className
        )}
        {...props}
      >
        {children}
      </div>,
      portalHost
    )
  }
)
PopoverContent.displayName = "PopoverContent"

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
