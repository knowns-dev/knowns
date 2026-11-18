import type { ReactNode } from "react";
import { Button } from "../ui/knowns/button";
import { Skeleton } from "../ui/knowns/skeleton";
import { InfiniteSentinel } from "./InfiniteSentinel";

interface ListTailProps {
	hasMore: boolean;
	/** A page is loading. */
	busy: boolean;
	/** The failure of the page being loaded; shows a retry instead of the skeletons. */
	error: string | null;
	count: number;
	onMore: () => void;
	onRetry: () => void;
	/** The placeholder rows or cards; rendered `skeletonCount` times while busy. */
	skeleton: ReactNode;
	skeletonCount?: number;
	root?: Element | null;
}

/**
 * The end of a paged list: skeletons where the next page will land (while it loads), a sentinel that
 * asks for it a little before the user arrives, and a retry when the last page failed. Nothing renders
 * once the cursor is exhausted, so a finished list never shows a skeleton.
 */
export function ListTail({ hasMore, busy, error, count, onMore, onRetry, skeleton, skeletonCount = 3, root }: ListTailProps) {
	if (error) {
		return (
			<div role="alert" className="flex flex-col items-center gap-2 px-3 py-4 text-center text-xs text-muted-foreground">
				<span>{error}</span>
				<Button size="sm" variant="secondary" onClick={onRetry}>
					Retry
				</Button>
			</div>
		);
	}
	if (!hasMore) return null;
	return (
		<div aria-busy={busy}>
			{busy && (
				<div className="flex flex-col gap-2" aria-hidden="true">
					{Array.from({ length: skeletonCount }, (_, i) => (
						<div key={i}>{skeleton}</div>
					))}
				</div>
			)}
			<InfiniteSentinel hasMore={hasMore} busy={busy} count={count} onVisible={onMore} root={root} />
		</div>
	);
}

/** A card-shaped placeholder the height of a Kanban card, so nothing jumps when the cards arrive. */
export function CardSkeleton() {
	return (
		<div className="flex flex-col gap-2 rounded-xl border border-border/60 p-3">
			<Skeleton className="h-3 w-1/3" />
			<Skeleton className="h-4 w-full" />
			<Skeleton className="h-4 w-4/5" />
			<Skeleton className="h-3 w-1/2" />
		</div>
	);
}
