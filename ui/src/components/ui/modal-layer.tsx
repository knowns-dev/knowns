import * as React from "react"
import { createPortal } from "react-dom"

import { useExit } from "@/ui/components/ui/knowns/use-floating"

/*
 * Shared core of the Dialog and Sheet adapters: a native modal <dialog> in the browser top layer.
 *
 * The <dialog> element is a transparent, full-viewport layer and the visible panel is a child of it.
 * That keeps the old Radix panel classes working unchanged (fixed + translate centring, side sheets) and
 * makes "outside" simple: a press that starts and ends on the layer itself is a press on the backdrop.
 *
 * Why native: Knowns UI floating pieces (popover, combobox, menu, tooltip) portal into the nearest open
 * dialog, so everything opened inside a dialog or sheet stays clickable above it, and Escape closes only
 * the topmost thing.
 */

const MOTION = `
[data-kn-layer]{transition:opacity var(--kn-dur,180ms) var(--kn-ease-out,cubic-bezier(.22,1,.36,1)),overlay 260ms allow-discrete,display 260ms allow-discrete}
[data-kn-layer]::backdrop{background:rgb(0 0 0/.4);opacity:1;transition:opacity 220ms ease-out,overlay 220ms allow-discrete,display 220ms allow-discrete}
[data-kn-layer]:not([open])::backdrop{opacity:0;transition-duration:180ms}
@starting-style{[data-kn-layer][open]::backdrop{opacity:0}}
[data-kn-layer=dialog]{opacity:1}
[data-kn-layer=dialog]:not([open]){opacity:0;transition-duration:var(--kn-dur-fast,120ms)}
@starting-style{[data-kn-layer=dialog][open]{opacity:0}}
[data-kn-layer=dialog]::backdrop{backdrop-filter:blur(2px)}
[data-kn-layer]>[data-kn-panel]{transform:none;transition:transform var(--kn-dur,180ms) var(--kn-ease-out,cubic-bezier(.22,1,.36,1))}
[data-kn-layer=dialog]:not([open])>[data-kn-panel]{transform:translateY(4px);transition-duration:var(--kn-dur-fast,120ms)}
@starting-style{[data-kn-layer=dialog][open]>[data-kn-panel]{transform:translateY(4px)}}
[data-kn-layer=sheet]>[data-kn-panel]{transition-duration:260ms}
[data-kn-layer=sheet]:not([open])>[data-kn-panel]{transition-duration:200ms;transition-timing-function:cubic-bezier(.4,0,1,1)}
[data-kn-layer=sheet][data-side=left]:not([open])>[data-kn-panel]{transform:translateX(-100%)}
[data-kn-layer=sheet][data-side=right]:not([open])>[data-kn-panel]{transform:translateX(100%)}
[data-kn-layer=sheet][data-side=top]:not([open])>[data-kn-panel]{transform:translateY(-100%)}
[data-kn-layer=sheet][data-side=bottom]:not([open])>[data-kn-panel]{transform:translateY(100%)}
@starting-style{
  [data-kn-layer=sheet][data-side=left][open]>[data-kn-panel]{transform:translateX(-100%)}
  [data-kn-layer=sheet][data-side=right][open]>[data-kn-panel]{transform:translateX(100%)}
  [data-kn-layer=sheet][data-side=top][open]>[data-kn-panel]{transform:translateY(-100%)}
  [data-kn-layer=sheet][data-side=bottom][open]>[data-kn-panel]{transform:translateY(100%)}
}
@media (prefers-reduced-motion:reduce){
  [data-kn-layer]>[data-kn-panel],[data-kn-layer]:not([open])>[data-kn-panel]{transform:none!important;transition-duration:0s!important}
}
`

/** How long a closing layer stays mounted: a little over the longest exit above (260ms). */
const EXIT_MS = 280

/* Open layers lock the page scroll together; it unlocks when the last one closes. */
let locks = 0
let before = ""
function lockScroll() {
  if (locks++ === 0) {
    before = document.documentElement.style.overflow
    document.documentElement.style.overflow = "hidden"
  }
}
function unlockScroll() {
  if (--locks === 0) document.documentElement.style.overflow = before
}

/*
 * Like Radix, hide everything but the topmost layer from assistive tech. A native modal makes the rest inert,
 * but not every tool reads inertness (Playwright's role queries do not), so the page behind would still answer
 * getByRole and a screen reader's virtual cursor in some browsers. Body children that hold another open
 * <dialog> (a Knowns UI dialog such as the command menu) stay visible.
 */
const stack: HTMLDialogElement[] = []
const HIDDEN_MARK = "data-kn-aria-hidden"
function syncOutside() {
  if (typeof document === "undefined") return
  document.querySelectorAll(`[${HIDDEN_MARK}]`).forEach((el) => {
    el.removeAttribute("aria-hidden")
    el.removeAttribute(HIDDEN_MARK)
  })
  const top = stack[stack.length - 1]
  if (!top) return
  for (const child of Array.from(document.body.children)) {
    if (child.contains(top) || child.hasAttribute("aria-hidden") || child.matches("script, style, link")) continue
    if (child.querySelector("dialog[open]:not([data-kn-layer])")) continue
    child.setAttribute("aria-hidden", "true")
    child.setAttribute(HIDDEN_MARK, "")
  }
}
function pushLayer(d: HTMLDialogElement) {
  if (!stack.includes(d)) stack.push(d)
  syncOutside()
}
function popLayer(d: HTMLDialogElement) {
  const i = stack.indexOf(d)
  if (i === -1) return
  stack.splice(i, 1)
  syncOutside()
}

const TABBABLE =
  "button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1']), [contenteditable=true]"

/** A Radix-style cancellable event, for onOpenAutoFocus / onCloseAutoFocus / onEscapeKeyDown / onInteractOutside. */
export type LayerEvent = Event

/* ── Root state, shared by Dialog and Sheet (TaskHeader renders SheetTitle inside a Dialog) ── */

interface LayerContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  titleId: string
  descriptionId: string
  hasDescription: boolean
  setHasDescription: (v: boolean) => void
}

const LayerContext = React.createContext<LayerContextValue | null>(null)

export function useLayer(name: string) {
  const ctx = React.useContext(LayerContext)
  if (!ctx) throw new Error(`<${name}> must be used inside <Dialog> or <Sheet>`)
  return ctx
}

/** Like useLayer, but outside a Dialog or Sheet it returns null (titles rendered on their own). */
export function useOptionalLayer() {
  return React.useContext(LayerContext)
}

export interface LayerRootProps {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** Accepted for Radix compatibility. A native modal dialog is always modal. */
  modal?: boolean
  children?: React.ReactNode
}

export function LayerRoot({ open: openProp, defaultOpen = false, onOpenChange, children }: LayerRootProps) {
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
  const titleId = React.useId()
  const descriptionId = React.useId()
  const [hasDescription, setHasDescription] = React.useState(false)
  const value = React.useMemo(
    () => ({ open, setOpen, titleId, descriptionId, hasDescription, setHasDescription }),
    [open, setOpen, titleId, descriptionId, hasDescription]
  )
  return <LayerContext.Provider value={value}>{children}</LayerContext.Provider>
}

/* ── The layer itself ── */

export interface LayerProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onKeyDown"> {
  kind: "dialog" | "sheet"
  side?: "top" | "right" | "bottom" | "left"
  /** Classes on the <dialog> layer (e.g. a backdrop: utility); the old Radix overlay classes are mapped here. */
  layerClassName?: string
  onOpenAutoFocus?: (event: LayerEvent) => void
  onCloseAutoFocus?: (event: LayerEvent) => void
  onEscapeKeyDown?: (event: LayerEvent) => void
  onInteractOutside?: (event: LayerEvent) => void
  onPointerDownOutside?: (event: LayerEvent) => void
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
  /** Accepted for Radix compatibility; unused. */
  forceMount?: true
}

/**
 * Renders a native modal <dialog> (portaled to <body>) while open and through its exit, then unmounts it,
 * as Radix did. The panel's children mount only after showModal(), so React autoFocus inside works.
 */
export const Layer = React.forwardRef<HTMLDivElement, LayerProps>(function Layer(
  {
    kind,
    side = "right",
    layerClassName,
    className,
    style,
    children,
    onOpenAutoFocus,
    onCloseAutoFocus,
    onEscapeKeyDown,
    onInteractOutside,
    onPointerDownOutside,
    forceMount: _forceMount,
    ...panelProps
  },
  ref
) {
  const { open, setOpen, titleId, descriptionId, hasDescription } = useLayer(kind === "sheet" ? "SheetContent" : "DialogContent")
  const { mounted } = useExit(open, EXIT_MS)
  const dialogRef = React.useRef<HTMLDialogElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  /** True once showModal() ran: children render from then on, through the exit, until unmount. */
  const [ready, setReady] = React.useState(false)
  /** Counts showModal() calls: each one runs the open autofocus. */
  const [opening, setOpening] = React.useState(0)
  /** Bumped when the browser closed the dialog on its own, to re-show it if the owner keeps it open. */
  const [, setForced] = React.useState(0)
  const downOnLayer = React.useRef(false)
  /** Set while we close the native dialog ourselves, so its close event is not taken for a browser close. */
  const selfClosing = React.useRef(false)

  const callbacks = React.useRef({ onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown, onInteractOutside, onPointerDownOutside })
  callbacks.current = { onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown, onInteractOutside, onPointerDownOutside }

  const closeNative = React.useCallback(() => {
    const d = dialogRef.current
    if (!d?.open) return
    selfClosing.current = true
    d.close() // the browser puts focus back where it was before showModal()
    popLayer(d)
    const event = new Event("closeAutoFocus", { cancelable: true })
    callbacks.current.onCloseAutoFocus?.(event)
    if (event.defaultPrevented) (document.activeElement as HTMLElement | null)?.blur?.()
  }, [])

  // Open and close the native dialog. Runs on every render: if the browser closed it by itself (an
  // Escape it would not let us cancel) and the owner kept it open, it is shown again.
  React.useLayoutEffect(() => {
    const d = dialogRef.current
    if (!d) return
    if (open && !d.open) {
      d.showModal()
      pushLayer(d)
      setReady(true)
      setOpening((n) => n + 1)
    } else if (!open && d.open) {
      closeNative()
    }
  })

  React.useLayoutEffect(() => {
    if (!mounted) setReady(false)
  }, [mounted])

  // Once the children are in: honour an autoFocus that already landed inside, else focus the first
  // control (or [data-autofocus]), like Radix. onOpenAutoFocus can cancel and keep focus on the panel.
  React.useLayoutEffect(() => {
    if (!opening || !open) return
    const panel = panelRef.current
    if (!panel) return
    const event = new Event("openAutoFocus", { cancelable: true })
    callbacks.current.onOpenAutoFocus?.(event)
    if (event.defaultPrevented) {
      panel.focus({ preventScroll: true })
      return
    }
    // showModal() focused the panel itself (tabIndex -1); an autoFocus child may have taken it since.
    const active = document.activeElement
    if (active && active !== panel && panel.contains(active)) return
    const target =
      panel.querySelector<HTMLElement>("[data-autofocus]") ??
      [...panel.querySelectorAll<HTMLElement>(TABBABLE)].find((el) => el.getClientRects().length > 0) ??
      panel
    target.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening])

  // The page behind does not scroll.
  React.useEffect(() => {
    if (!open) return
    lockScroll()
    return unlockScroll
  }, [open])

  // Unmounted while open (a parent went away): close it so focus goes back where it was.
  React.useLayoutEffect(() => () => closeNative(), [closeNative])

  if (!mounted || typeof document === "undefined") return null

  const setPanelRef = (node: HTMLDivElement | null) => {
    panelRef.current = node
    if (typeof ref === "function") ref(node)
    else if (ref) ref.current = node
  }

  return createPortal(
    <>
      <style href="kn-modal-layer" precedence="default">
        {MOTION}
      </style>
      <dialog
        ref={dialogRef}
        // Explicit, so CSS selectors like [role="dialog"] keep matching the open layer.
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hasDescription ? descriptionId : undefined}
        data-kn-layer={kind}
        data-side={kind === "sheet" ? side : undefined}
        data-state={open ? "open" : "closed"}
        onCancel={(e) => {
          // React passes a nested dialog's cancel and close up the component tree: only handle our own.
          if (e.target !== e.currentTarget) return
          e.preventDefault()
          const event = new Event("escapeKeyDown", { cancelable: true })
          callbacks.current.onEscapeKeyDown?.(event)
          if (!event.defaultPrevented) setOpen(false)
        }}
        onClose={(e) => {
          if (e.target !== e.currentTarget) return
          if (selfClosing.current) {
            selfClosing.current = false
            return
          }
          // The browser closed it (not us): tell the owner, and re-show if it keeps it open.
          popLayer(e.currentTarget)
          if (open) {
            setOpen(false)
            setForced((n) => n + 1)
          }
        }}
        onPointerDown={(e) => {
          downOnLayer.current = e.target === e.currentTarget
        }}
        onClick={(e) => {
          if (e.target !== e.currentTarget || !downOnLayer.current) return
          downOnLayer.current = false
          const event = new Event("pointerDownOutside", { cancelable: true })
          callbacks.current.onPointerDownOutside?.(event)
          callbacks.current.onInteractOutside?.(event)
          if (!event.defaultPrevented) setOpen(false)
        }}
        className={[
          "fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-hidden border-0 bg-transparent p-0 text-foreground outline-none",
          layerClassName,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div
          ref={setPanelRef}
          data-kn-panel=""
          data-state={open ? "open" : "closed"}
          tabIndex={-1}
          className={className}
          style={style}
          {...panelProps}
        >
          {ready && children}
        </div>
      </dialog>
    </>,
    document.body
  )
})
