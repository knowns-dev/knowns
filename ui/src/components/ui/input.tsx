import * as React from "react"

import { cn } from "@/ui/lib/utils"
import { fieldClass } from "./knowns/field-class"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          fieldClass,
          "flex h-8 px-3 py-1 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground pointer-coarse:h-10",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
