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
 */
export function FeatureHeader({ title, status, actions, className }: FeatureHeaderProps) {
	return (
		<div className={cn("shrink-0 border-b border-border/55 px-4 pt-4 sm:px-6", className)}>
			<KnPageHeader
				title={title}
				titleText={title}
				description={status ? <span className="tabular-nums">{status}</span> : undefined}
				trailing={actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : undefined}
				condense={false}
			/>
		</div>
	);
}
