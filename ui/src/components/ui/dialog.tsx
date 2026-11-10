import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { X } from "lucide-react"

import { cn } from "@/ui/lib/utils"
import { Layer, LayerRoot, useLayer, useOptionalLayer, type LayerProps, type LayerRootProps } from "./modal-layer"

/*
 * Dialog with the old Radix/shadcn API (Dialog, DialogContent, DialogHeader, DialogTitle, ...) on a native modal
 * <dialog> with the Knowns UI motion and surface. Floating Knowns UI pieces opened inside it portal into it, so
 * selects, menus and popovers inside a dialog work. See modal-layer.tsx.
 */

const Dialog = (props: LayerRootProps) => <LayerRoot {...props} />

type SlotButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }

const DialogTrigger = React.forwardRef<HTMLButtonElement, SlotButtonProps>(({ asChild, onClick, ...props }, ref) => {
  const { open, setOpen } = useLayer("DialogTrigger")
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : "button"}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(e)
        if (!e.defaultPrevented) setOpen(true)
      }}
      {...props}
    />
  )
})
DialogTrigger.displayName = "DialogTrigger"

const DialogClose = React.forwardRef<HTMLButtonElement, SlotButtonProps>(({ asChild, onClick, ...props }, ref) => {
  const { setOpen } = useLayer("DialogClose")
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : "button"}
      onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(e)
        if (!e.defaultPrevented) setOpen(false)
      }}
      {...props}
    />
  )
})
DialogClose.displayName = "DialogClose"

interface DialogContentProps extends Omit<LayerProps, "kind" | "side"> {
  hideCloseButton?: boolean
}

const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  ({ className, children, hideCloseButton, ...props }, ref) => (
    <Layer
      ref={ref}
      kind="dialog"
      className={cn(
        "fixed left-[50%] top-[50%] grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 bg-background p-6 text-foreground outline-none shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_12%,transparent),0_24px_64px_-16px_rgb(0_0_0/0.35)] sm:rounded-2xl",
        className
      )}
      {...props}
    >
      {children}
      {!hideCloseButton && (
        <DialogClose className="absolute right-4 top-4 grid size-7 place-items-center rounded-[8px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogClose>
      )}
    </Layer>
  )
)
DialogContent.displayName = "DialogContent"

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)} {...props} />
)
DialogFooter.displayName = "DialogFooter"

/** The layer's accessible name. Works in a Dialog or a Sheet (they share one context). */
const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => {
    const layer = useOptionalLayer()
    return (
      <h2
        ref={ref}
        id={layer?.titleId}
        className={cn("text-lg font-semibold leading-none tracking-tight", className)}
        {...props}
      />
    )
  }
)
DialogTitle.displayName = "DialogTitle"

const DialogDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => {
    const layer = useOptionalLayer()
    const setHasDescription = layer?.setHasDescription
    React.useLayoutEffect(() => {
      if (!setHasDescription) return
      setHasDescription(true)
      return () => setHasDescription(false)
    }, [setHasDescription])
    return <p ref={ref} id={layer?.descriptionId} className={cn("text-sm text-muted-foreground", className)} {...props} />
  }
)
DialogDescription.displayName = "DialogDescription"

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
