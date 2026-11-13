import * as React from "react"
import * as CheckboxPrimitive from "@radix-ui/react-checkbox"
import { Check } from "lucide-react"

import { cn } from "@/ui/lib/utils"

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "grid place-content-center peer h-4 w-4 shrink-0 cursor-pointer rounded-[5px] bg-card shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_24%,transparent),0_1px_1px_rgb(0_0_0/0.05)] transition-[background-color,box-shadow] duration-(--kn-dur-fast) ease-(--kn-ease-out) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[color:var(--kn-accent,var(--primary))] data-[state=checked]:text-[color:var(--kn-accent-foreground,var(--primary-foreground))] data-[state=checked]:shadow-[0_0_0_1px_var(--kn-accent,var(--primary))]",
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={cn("grid place-content-center text-current")}
    >
      <Check className="h-4 w-4" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
