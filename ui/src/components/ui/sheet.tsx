import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/ui/lib/utils"
import { DialogClose, DialogDescription, DialogTitle, DialogTrigger } from "./dialog"
import { Layer, LayerRoot, type LayerProps, type LayerRootProps } from "./modal-layer"
import { X } from "lucide-react"

/*
 * Sheet with the old Radix/shadcn API on a native modal <dialog>: the panel slides in from its edge with the
 * Knowns UI sheet motion (see modal-layer.tsx). Dialog and Sheet share one context, so SheetTitle works inside a
 * Dialog and DialogTitle inside a Sheet.
 */

const Sheet = (props: LayerRootProps) => <LayerRoot {...props} />

const SheetTrigger = DialogTrigger
const SheetClose = DialogClose

const sheetVariants = cva(
  "fixed gap-4 bg-background p-6 text-foreground outline-none shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_10%,transparent),0_24px_64px_-16px_rgb(0_0_0/0.35)]",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b pt-[max(1.5rem,env(safe-area-inset-top))]",
        bottom: "inset-x-0 bottom-0 border-t pb-[max(1.5rem,env(safe-area-inset-bottom))]",
        left: "inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm",
        right: "inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm",
      },
    },
    defaultVariants: {
      side: "right",
    },
  }
)

interface SheetContentProps extends Omit<LayerProps, "kind" | "side">, VariantProps<typeof sheetVariants> {
  hideCloseButton?: boolean
}

const SheetContent = React.forwardRef<HTMLDivElement, SheetContentProps>(
  ({ side = "right", className, children, hideCloseButton, ...props }, ref) => (
    <Layer ref={ref} kind="sheet" side={side ?? "right"} className={cn(sheetVariants({ side }), className)} {...props}>
      {!hideCloseButton && (
        <SheetClose className="absolute right-4 top-4 grid size-7 place-items-center rounded-[8px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </SheetClose>
      )}
      {children}
    </Layer>
  )
)
SheetContent.displayName = "SheetContent"

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-2 text-center sm:text-left", className)} {...props} />
)
SheetHeader.displayName = "SheetHeader"

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)} {...props} />
)
SheetFooter.displayName = "SheetFooter"

const SheetTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(({ className, ...props }, ref) => (
  <DialogTitle ref={ref} className={cn("text-lg font-semibold leading-normal tracking-normal text-foreground", className)} {...props} />
))
SheetTitle.displayName = "SheetTitle"

const SheetDescription = DialogDescription

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription }
