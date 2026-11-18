import { useEffect, useRef } from "react";

interface InfiniteSentinelProps {
	/** Called when the sentinel nears the end of the scroll area and more can be loaded. */
	onVisible: () => void;
	hasMore: boolean;
	/** A page is loading (or failed): the sentinel stays quiet. */
	busy: boolean;
	/** How many items are loaded; a change re-arms the observer if the sentinel is still in view. */
	count: number;
	/** The scroll container; by default the nearest scrollable ancestor (or the viewport). */
	root?: Element | null;
	/** Load this far before the end. */
	margin?: number;
}

/**
 * An empty element at the end of a list. When it comes within `margin` px of the scroll area's edge it
 * asks for the next page, so the next rows are usually there before the user arrives. Place the
 * skeleton rows next to it while `busy`.
 */
function scrollParent(el: Element | null): Element | null {
	for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
		const oy = getComputedStyle(p).overflowY;
		if (oy === "auto" || oy === "scroll") return p;
	}
	return null;
}

export function InfiniteSentinel({ onVisible, hasMore, busy, count, root, margin = 400 }: InfiniteSentinelProps) {
	const ref = useRef<HTMLDivElement>(null);
	const cb = useRef(onVisible);
	cb.current = onVisible;

	// biome-ignore lint/correctness/useExhaustiveDependencies: `count` re-arms the observer after a page lands
	useEffect(() => {
		const el = ref.current;
		if (!el || !hasMore || busy) return;
		if (typeof IntersectionObserver === "undefined") return;
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) cb.current();
			},
			{ root: root === undefined ? scrollParent(el) : root, rootMargin: `0px 0px ${margin}px 0px` },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [hasMore, busy, count, root, margin]);

	return <div ref={ref} aria-hidden="true" data-testid="infinite-sentinel" className="h-px w-full" />;
}
