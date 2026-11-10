import type { ReactNode, Ref, SelectHTMLAttributes } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { fieldClass } from "./input";

export type SelectOption = string | { value: string; label: string; disabled?: boolean };

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  options: SelectOption[];
  /** 28 / 32 / 36px, same scale as Input and Combobox. Default "md". */
  size?: "sm" | "md" | "lg";
  /** Glyph inside the field, on the left. */
  icon?: ReactNode;
  /** Shown (muted) while no value is chosen: an empty, unselectable first option. Pair with value="" or defaultValue="". */
  placeholder?: string;
  invalid?: boolean;
  ref?: Ref<HTMLSelectElement>;
}

// `!` because fieldClass also sets a radius and font size, and cn() does not merge conflicts.
// Same heights, padding, radius and type as Input; right padding leaves room for the chevron.
const SIZE = {
  sm: "h-7 rounded-[8px]! pl-2.5 pr-7 text-[12.5px]! pointer-coarse:h-9",
  md: "h-8 rounded-[9px]! pl-3 pr-8 text-[13.5px]! pointer-coarse:h-10",
  lg: "h-9 rounded-[10px]! pl-3.5 pr-9 text-sm! pointer-coarse:h-11",
};
const WITH_ICON = { sm: "pl-7!", md: "pl-8.5!", lg: "pl-9.5!" };
const ICON_AT = { sm: "left-2.5 [&_svg]:size-3.5", md: "left-3 [&_svg]:size-4", lg: "left-3.5 [&_svg]:size-[17px]" };
const CHEVRON_AT = { sm: "right-2", md: "right-2.5", lg: "right-3" };

/**
 * A native select in the field style: keyboard, mobile pickers, autofill and forms just work.
 * Reach for Combobox when options need search, avatars, descriptions or multiple choice.
 */
export function Select({ options, size = "md", icon, placeholder, invalid, className, ...rest }: SelectProps) {
  return (
    <span className={cn("relative flex w-full items-center", className)}>
      {icon && (
        <span aria-hidden="true" className={cn("pointer-events-none absolute grid text-muted-foreground", ICON_AT[size])}>
          {icon}
        </span>
      )}
      <select
        aria-invalid={invalid || undefined}
        className={cn(fieldClass, "cursor-pointer appearance-none", SIZE[size], icon && WITH_ICON[size], "has-[option[value='']:checked]:text-muted-foreground")}
        {...rest}
      >
        {placeholder !== undefined && (
          <option value="" disabled hidden>
            {placeholder}
          </option>
        )}
        {options.map((o) => {
          const opt = typeof o === "string" ? { value: o, label: o } : o;
          return (
            <option key={opt.value} value={opt.value} disabled={"disabled" in opt ? opt.disabled : undefined} className="text-foreground">
              {opt.label}
            </option>
          );
        })}
      </select>
      <svg viewBox="0 0 16 16" aria-hidden="true" className={cn("pointer-events-none absolute size-3.5 text-muted-foreground", CHEVRON_AT[size])}>
        <path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
