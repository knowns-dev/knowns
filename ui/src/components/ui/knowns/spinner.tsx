import { cn } from "@/ui/lib/knowns/utils";

/** Small indeterminate spinner. Inherits the text colour and size from its parent. */
export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
  // An empty label makes it decorative (e.g. inside a button that already says aria-busy).
  return (
    <svg viewBox="0 0 16 16" role={label ? "status" : undefined} aria-label={label || undefined} aria-hidden={!label || undefined} className={cn("size-4 animate-spin motion-reduce:animate-none", className)}>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
