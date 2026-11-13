import { cn } from "@/ui/lib/knowns/utils";

/** The surface of a field: card fill, a hairline ring and a whisper of shadow. */
export const SURFACE =
  "bg-card text-foreground shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_14%,transparent),0_1px_2px_rgb(0_0_0/0.04)] transition-[box-shadow] duration-200 ease-out dark:bg-[color-mix(in_srgb,var(--muted)_35%,var(--card))]";

/** Shared field look: hairline ring, soft focus ring, red when invalid. Put it on a native input, select or textarea. */
export const fieldClass = cn(
  "w-full min-w-0 rounded-[9px] text-[13.5px] outline-none",
  SURFACE,
  "placeholder:text-muted-foreground",
  "focus-visible:shadow-[0_0_0_1px_color-mix(in_srgb,var(--ring)_80%,transparent),0_0_0_4px_color-mix(in_srgb,var(--ring)_22%,transparent)]",
  "aria-invalid:shadow-[0_0_0_1px_rgb(239_68_68/0.6),0_0_0_4px_rgb(239_68_68/0.12)]",
  "disabled:cursor-not-allowed disabled:opacity-50",
);
