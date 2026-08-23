import type { ComponentType, ReactNode } from "react";
import { cn } from "@/ui/lib/utils";

interface FeatureHeaderProps {
	/** Lucide-style icon component. */
	icon?: ComponentType<{ className?: string }>;
	title: string;
	/**
	 * Short context shown inline after the title, e.g. "12 proposals need review"
	 * or "143 docs". A fragment, never a full sentence.
	 */
	status?: ReactNode;
	actions?: ReactNode;
	className?: string;
}

/**
 * The compact feature header shared by every feature page.
 *
 * Feature pages are dense (tables, canvases, long lists), so they get this 48px
 * bar rather than the tall `PageHeader`: title and status sit on one line and
 * the remaining vertical space goes to the content.
 */
export function FeatureHeader({ icon: Icon, title, status, actions, className }: FeatureHeaderProps) {
	return (
		<header
			className={cn(
				"flex h-12 shrink-0 items-center gap-3 border-b border-border/55 px-4 sm:px-6",
				className,
			)}
		>
			<div className="flex min-w-0 items-center gap-2">
				{Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
				<h1 className="truncate text-sm font-semibold tracking-tight">{title}</h1>
				{status && (
					<span className="truncate text-xs tabular-nums text-muted-foreground">{status}</span>
				)}
			</div>
			{actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
		</header>
	);
}
