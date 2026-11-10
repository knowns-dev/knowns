import * as React from "react"
import { createPortal } from "react-dom"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "@/ui/lib/utils"
import { FLOAT_FADE, setRefs, useFloating } from "@/ui/components/ui/knowns/use-floating"

/*
 * Tooltip with the old Radix/shadcn API (TooltipProvider, Tooltip, TooltipTrigger asChild, TooltipContent) and the
 * Knowns UI tooltip look and behaviour, on useFloating. Unlike Knowns UI's <Tooltip>, the trigger is not wrapped
 * in a span, so grid cells (the audit heatmap) keep their placement. For new code prefer
 * `@/ui/components/ui/knowns/tooltip`.
 */

const ProviderContext = React.createContext<{ delayDuration: number }>({ delayDuration: 300 })

function TooltipProvider({ delayDuration = 300, children }: { delayDuration?: number; skipDelayDuration?: number; children?: React.ReactNode }) {
  const value = React.useMemo(() => ({ delayDuration }), [delayDuration])
  return <ProviderContext.Provider value={value}>{children}</ProviderContext.Provider>
}

interface TooltipContextValue {
  open: boolean
  show: (now?: boolean) => void
  hide: (now?: boolean) => void
  triggerRef: React.RefObject<HTMLElement | null>
  contentId: string
}

const TooltipContext = React.createContext<TooltipContextValue | null>(null)

function useTooltip(name: string) {
  const ctx = React.useContext(TooltipContext)
  if (!ctx) throw new Error(`<${name}> must be used inside <Tooltip>`)
  return ctx
}

/** When a tooltip last closed: the next one within a moment opens at once (a sweep along a row). */
let lastClosed = 0
const WARM_MS = 400

function Tooltip({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  delayDuration,
  children,
}: {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  delayDuration?: number
  children?: React.ReactNode
}) {
  const provider = React.useContext(ProviderContext)
  const delay = delayDuration ?? provider.delayDuration
  const [own, setOwn] = React.useState(defaultOpen)
  const open = openProp ?? own
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  const triggerRef = React.useRef<HTMLElement | null>(null)
  const contentId = React.useId()
  const onOpenChangeRef = React.useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange

  const set = React.useCallback(
    (v: boolean) => {
      if (openProp === undefined) setOwn(v)
      onOpenChangeRef.current?.(v)
      if (!v) lastClosed = Date.now()
    },
    [openProp]
  )
  const show = React.useCallback(
    (now = false) => {
      clearTimeout(timer.current)
      const warm = Date.now() - lastClosed < WARM_MS
      timer.current = setTimeout(() => set(true), now || warm ? 0 : delay)
    },
    [delay, set]
  )
  const hide = React.useCallback(
    (now = false) => {
      clearTimeout(timer.current)
      if (now) set(false)
      else timer.current = setTimeout(() => set(false), 80)
    },
    [set]
  )
  React.useEffect(() => () => clearTimeout(timer.current), [])

  // Escape dismisses even when the pointer, not focus, opened it.
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide(true)
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, hide])

  const value = React.useMemo(() => ({ open, show, hide, triggerRef, contentId }), [open, show, hide, contentId])
  return <TooltipContext.Provider value={value}>{children}</TooltipContext.Provider>
}

type TriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }

const TooltipTrigger = React.forwardRef<HTMLButtonElement, TriggerProps>(
  ({ asChild, onPointerEnter, onPointerLeave, onPointerDown, onFocus, onBlur, ...props }, ref) => {
    const { open, show, hide, triggerRef, contentId } = useTooltip("TooltipTrigger")
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        ref={(node: HTMLButtonElement | null) => setRefs(node, ref, triggerRef as React.Ref<HTMLButtonElement>)}
        type={asChild ? undefined : "button"}
        aria-describedby={open ? contentId : undefined}
        data-state={open ? "delayed-open" : "closed"}
        onPointerEnter={(e: React.PointerEvent<HTMLButtonElement>) => {
          onPointerEnter?.(e)
          if (e.pointerType !== "touch") show()
        }}
        onPointerLeave={(e: React.PointerEvent<HTMLButtonElement>) => {
          onPointerLeave?.(e)
          hide()
        }}
        onPointerDown={(e: React.PointerEvent<HTMLButtonElement>) => {
          onPointerDown?.(e)
          hide(true)
        }}
        onFocus={(e: React.FocusEvent<HTMLButtonElement>) => {
          onFocus?.(e)
          if ((e.target as HTMLElement).matches?.(":focus-visible")) show(true)
        }}
        onBlur={(e: React.FocusEvent<HTMLButtonElement>) => {
          onBlur?.(e)
          hide(true)
        }}
        {...props}
      />
    )
  }
)
TooltipTrigger.displayName = "TooltipTrigger"

interface TooltipContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  sideOffset?: number
}

const TooltipContent = React.forwardRef<HTMLDivElement, TooltipContentProps>(
  ({ className, side = "top", align = "center", sideOffset = 6, style: styleProp, children, ...props }, ref) => {
    const { open, triggerRef, contentId } = useTooltip("TooltipContent")
    const floating = useFloating<HTMLElement, HTMLDivElement>({ open, side, align, offset: sideOffset })
    floating.triggerRef.current = triggerRef.current
    const { floatingRef, style, placement, portalHost, closing } = floating
    if (!portalHost) return null
    return createPortal(
      <div
        ref={(node: HTMLDivElement | null) => setRefs(node, floatingRef, ref)}
        id={contentId}
        role="tooltip"
        data-side={placement}
        data-state={closing ? "closed" : "open"}
        style={{ ...styleProp, ...style }}
        className={cn(
          "pointer-events-none z-[70] w-max max-w-64 rounded-[8px] bg-foreground px-2 py-1 text-xs leading-[1.35] font-medium text-background",
          "shadow-[0_6px_20px_-8px_rgb(0_0_0/0.35)]",
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
TooltipContent.displayName = "TooltipContent"

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
