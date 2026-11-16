// The end of a long list: loads the next page when it nears the viewport, or on click.
import { useEffect, useRef } from "react";
import { useInView } from "../ui/knowns/illustrations/use-in-view";

interface LoadMoreProps {
	remaining: number;
	pageSize: number;
	onMore: () => void;
	className?: string;
}

export function LoadMore({ remaining, pageSize, onMore, className }: LoadMoreProps) {
	const ref = useRef<HTMLDivElement>(null);
	const inView = useInView(ref, "240px");
	const more = useRef(onMore);
	more.current = onMore;
	// Only the step into view loads a page: the sentinel stays mounted while the list grows.
	useEffect(() => {
		if (inView) more.current();
	}, [inView]);
	return (
		<div ref={ref} className={className ?? "mt-2"}>
			<button
				type="button"
				onClick={onMore}
				className="h-8 w-full rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			>
				Show {Math.min(remaining, pageSize)} more ({remaining} left)
			</button>
		</div>
	);
}
