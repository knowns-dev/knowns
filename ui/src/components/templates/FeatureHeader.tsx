import type { ComponentType, ReactNode } from "react";
import { PageHeader as KnPageHeader } from "@/ui/components/ui/knowns/blocks/page-header";
import { cn } from "@/ui/lib/utils";

interface FeatureHeaderProps {
	/** Lucide-style icon component. Kept for callers; the Knowns UI header shows the title alone. */
	icon?: ComponentType<{ className?: string }>;
	title: string;
	/**
	 * Short context shown under the title, e.g. "12 proposals need review"
	 * or "143 docs". A fragment, never a full sentence.
	 */
	status?: ReactNode;
	actions?: ReactNode;
	className?: string;
}

/**
 * The header shared by every feature page, drawn with the Knowns UI page header so all pages
 * (and the Dashboard, which uses it directly) start the same way: a title, a muted line of
 * context under it, and the page's own controls on the right.
 *
 * The controls are a sibling of the header rather than its `trailing` slot: that slot never
 * wraps, so a page with many controls (Tasks) pushed them off a phone screen and over the title.
 * Below `lg` they wrap onto their own rows under the title; from `lg` up they sit on the right.
 */
export function FeatureHeader({ title, status, actions, className }: FeatureHeaderProps) {
	return (
		<div className={cn("shrink-0 border-b border-border/55 px-4 pt-4 sm:px-6", className)}>
			<div className="flex flex-col gap-x-6 pb-4 lg:flex-row lg:items-start lg:justify-between">
				{/* The block wraps its <header> in its own div, so flex-1 goes on a wrapper of ours:
				    next to the controls the header would otherwise shrink to zero width. */}
				<div className="min-w-40 flex-1">
					<KnPageHeader
						className="[&_h1]:truncate"
						title={title}
						titleText={title}
						description={status ? <span className="tabular-nums">{status}</span> : undefined}
						condense={false}
					/>
				</div>
				{actions && (
					<div className="flex min-w-0 flex-wrap items-center gap-2 lg:flex-[0_1_auto] lg:justify-end lg:pt-1">{actions}</div>
				)}
			</div>
		</div>
	);
}
