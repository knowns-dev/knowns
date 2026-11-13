import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { activeHeading, tocTree, type TocItem, type TocNode } from "@/ui/components/ui/knowns/blocks/docs/docs-utils";
import { cn } from "@/ui/lib/utils";
import { parseHeadingMeta } from "../editor/headingUtils";

interface TOCHeading extends TocItem {
	/** "2.1", matching the number the rendered heading shows. */
	number: string;
}

interface DocsTOCProps {
	markdown: string;
	/** The element the doc scrolls in. The rail follows it rather than the window. */
	scrollContainerRef?: React.RefObject<HTMLElement | null>;
	onHeadingSelect?: (id: string) => void;
	/** Cards under the list, e.g. the connections graph. */
	children?: ReactNode;
	className?: string;
}

/** Headings ## to #### with the renderer's own numbers and ids. The rail nests one level, so h4s sit with h3s. */
export function parseHeadings(markdown: string): TOCHeading[] {
	return parseHeadingMeta(markdown).map((h) => ({ id: h.id, text: h.text, number: h.number, depth: h.level === 2 ? 2 : 3 }));
}

/** Which heading the reader is at, measured against the scroll container instead of the window. */
function useActiveHeading(ids: string[], containerRef?: React.RefObject<HTMLElement | null>) {
	const [active, setActive] = useState<string | null>(null);
	useEffect(() => {
		const container = containerRef?.current;
		if (!container || ids.length === 0) return;
		let frame = 0;
		const update = () => {
			frame = 0;
			const box = container.getBoundingClientRect();
			const tops = ids
				.map((id) => ({ id, top: container.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.getBoundingClientRect().top }))
				.filter((t): t is { id: string; top: number } => t.top !== undefined)
				.map((t) => ({ id: t.id, top: t.top - box.top }));
			// At the end of the doc the last heading wins even if it never reaches the top.
			const atEnd = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
			setActive(atEnd && container.scrollTop > 0 ? (tops[tops.length - 1]?.id ?? null) : activeHeading(tops, 96));
		};
		const onScroll = () => {
			frame ||= requestAnimationFrame(update);
		};
		const settle = window.setTimeout(update, 120);
		container.addEventListener("scroll", onScroll, { passive: true });
		window.addEventListener("resize", onScroll);
		return () => {
			window.clearTimeout(settle);
			cancelAnimationFrame(frame);
			container.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", onScroll);
		};
	}, [containerRef, ids.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
	return [active, setActive] as const;
}

const numbers = (items: TOCHeading[]) => new Map(items.map((item) => [item.id, item.number]));

function List({
	nodes,
	active,
	numberOf,
	onPick,
	nested,
}: {
	nodes: TocNode[];
	active: string | null;
	numberOf: Map<string, string>;
	onPick: (id: string) => void;
	nested?: boolean;
}) {
	return (
		<ul className={cn("flex flex-col", !nested && "border-l [border-color:color-mix(in_srgb,var(--foreground)_10%,transparent)]")}>
			{nodes.map((node) => (
				<li key={node.id}>
					<a
						href={`#${node.id}`}
						aria-current={active === node.id ? "location" : undefined}
						onClick={(event) => {
							event.preventDefault();
							onPick(node.id);
						}}
						title={node.text}
						className={cn(
							"-ml-px flex gap-2 border-l-2 border-transparent py-1 text-[13px] leading-snug text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring",
							"aria-[current=location]:border-foreground aria-[current=location]:font-medium aria-[current=location]:text-foreground",
							nested ? "pl-6" : "pl-3",
						)}
					>
						<span className="shrink-0 tabular-nums text-muted-foreground/60">{numberOf.get(node.id)}</span>
						<span className="min-w-0">{node.text}</span>
					</a>
					{node.children.length > 0 && (
						<List nodes={node.children} active={active} numberOf={numberOf} onPick={onPick} nested />
					)}
				</li>
			))}
		</ul>
	);
}

/**
 * The doc's "On this page" rail, drawn like the Knowns UI docs table of contents: a nested list with
 * a scroll-aware current section on wide screens, and the same list from a floating pill below xl.
 */
export function DocsTOC({ markdown, scrollContainerRef, onHeadingSelect, children, className }: DocsTOCProps) {
	const items = useMemo(() => parseHeadings(markdown), [markdown]);
	const tree = useMemo(() => tocTree(items), [items]);
	const numberOf = useMemo(() => numbers(items), [items]);
	const [active, setActive] = useActiveHeading(
		items.map((item) => item.id),
		scrollContainerRef,
	);
	const [open, setOpen] = useState(false);
	const pill = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open) return;
		const close = (event: Event) => {
			if (event instanceof KeyboardEvent) {
				if (event.key !== "Escape") return;
				setOpen(false);
				button.current?.focus();
			} else if (!pill.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("keydown", close);
		document.addEventListener("pointerdown", close);
		return () => {
			document.removeEventListener("keydown", close);
			document.removeEventListener("pointerdown", close);
		};
	}, [open]);

	const pick = useCallback(
		(id: string, after?: () => void) => {
			if (onHeadingSelect) onHeadingSelect(id);
			else scrollContainerRef?.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
			setActive(id);
			after?.();
		},
		[onHeadingSelect, scrollContainerRef, setActive],
	);

	const showList = items.length >= 2;
	const current = items.find((item) => item.id === active);

	return (
		<>
			<aside className={cn("flex flex-col gap-6 pb-6", className)}>
				{showList && (
					<nav aria-label="On this page">
						<p className="mb-2 text-[12px] font-medium text-foreground">On this page</p>
						<List nodes={tree} active={active} numberOf={numberOf} onPick={(id) => pick(id)} />
					</nav>
				)}
				{children}
			</aside>

			{showList && (
				<div ref={pill} data-toc-pill="" className="fixed right-5 bottom-5 z-40 xl:hidden">
					{open && (
						<nav
							aria-label="On this page"
							className="absolute right-0 bottom-full mb-2 max-h-[60dvh] w-72 overflow-y-auto rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
						>
							<p className="mb-2 text-[12px] font-medium text-foreground">On this page</p>
							<List nodes={tree} active={active} numberOf={numberOf} onPick={(id) => pick(id, () => setOpen(false))} />
						</nav>
					)}
					<button
						ref={button}
						type="button"
						aria-expanded={open}
						onClick={() => setOpen((value) => !value)}
						className="flex max-w-[60vw] items-center gap-2 rounded-full border bg-background/90 px-3.5 py-2 text-[13px] shadow-md backdrop-blur outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
					>
						<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" className="size-3.5 shrink-0">
							<path d="M3 4h10M3 8h7M3 12h5" />
						</svg>
						<span className="truncate">{current ? current.text : "On this page"}</span>
					</button>
				</div>
			)}
		</>
	);
}
