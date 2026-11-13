import type { HTMLAttributes } from "react";
import { cn } from "@/ui/lib/knowns/utils";

type Div = HTMLAttributes<HTMLDivElement>;

/** Surface with a border. Compose with CardHeader, CardContent and CardFooter. */
export function Card({ className, ...rest }: Div) {
  return <div className={cn("rounded-2xl border bg-card text-[13px] text-card-foreground shadow-xs", className)} {...rest} />;
}

export function CardHeader({ className, ...rest }: Div) {
  return <div className={cn("flex flex-col gap-1 px-5 pb-3 pt-4.5", className)} {...rest} />;
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-[15px] font-semibold leading-snug tracking-tight", className)} {...rest} />;
}

export function CardDescription({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-[13px] leading-relaxed text-muted-foreground", className)} {...rest} />;
}

export function CardContent({ className, ...rest }: Div) {
  return <div className={cn("px-5 pb-4.5", className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: Div) {
  return <div className={cn("flex items-center gap-2 rounded-b-2xl border-t bg-muted/30 px-5 py-3", className)} {...rest} />;
}
