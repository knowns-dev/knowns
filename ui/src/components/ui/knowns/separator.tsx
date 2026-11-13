import { cn } from "@/ui/lib/knowns/utils";

/** Thin divider. Decorative by default; pass `decorative={false}` for a semantic separator. */
export function Separator({ orientation = "horizontal", decorative = true, className }: { orientation?: "horizontal" | "vertical"; decorative?: boolean; className?: string }) {
  return (
    <div
      role={decorative ? "none" : "separator"}
      aria-orientation={decorative ? undefined : orientation}
      className={cn("flex-none bg-border", orientation === "horizontal" ? "h-px w-full" : "w-px self-stretch", className)}
    />
  );
}
