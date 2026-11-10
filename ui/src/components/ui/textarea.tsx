import * as React from "react"

import { cn } from "@/ui/lib/utils"
import { fieldClass } from "./knowns/field-class"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        fieldClass,
        "flex min-h-[60px] px-3 py-2 leading-5",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
