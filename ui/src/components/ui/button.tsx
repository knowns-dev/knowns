// The app's Button keeps its shadcn API (variant, size, asChild, forwardRef, so Radix triggers keep
// working) but draws with Knowns UI's button look, so every page shares one button style.
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "@/ui/lib/utils"
import { buttonClass, type ButtonSize as KnSize, type ButtonVariant as KnVariant } from "./knowns/button"

type Variant = "default" | "destructive" | "outline" | "secondary" | "ghost" | "link"
type Size = "default" | "sm" | "lg" | "icon"

const VARIANT: Record<Variant, KnVariant> = {
  default: "primary",
  destructive: "destructive",
  outline: "secondary",
  secondary: "secondary",
  ghost: "ghost",
  link: "quiet",
}

const SIZE: Record<Size, KnSize> = { default: "md", sm: "sm", lg: "lg", icon: "md" }

/** Same call shape as before: buttonVariants({ variant, size, className }). */
function buttonVariants({
  variant,
  size,
  className,
}: { variant?: Variant | null; size?: Size | null; className?: string } = {}) {
  const v = variant ?? "default"
  const s = size ?? "default"
  return buttonClass(
    VARIANT[v],
    SIZE[s],
    s === "icon",
    cn("gap-2", v === "link" && "underline-offset-4 hover:underline", className),
  )
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant | null
  size?: Size | null
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  // No default type: forms rely on <Button> submitting, as the shadcn version did.
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={buttonVariants({ variant, size, className })}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
