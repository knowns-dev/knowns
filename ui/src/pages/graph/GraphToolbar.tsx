import type { GraphData } from "@/ui/api/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/components/ui/popover";
import { cn } from "@/ui/lib/utils";
import { Maximize2, Minimize2, Scan, Search, SlidersHorizontal, X } from "lucide-react";

import { TASK_COLOR, type FilterState } from "./constants";
import { GraphLegend } from "./GraphLegend";

interface GraphToolbarProps {
	data: GraphData | null;
	filters: FilterState;
	searchQuery: string;
	searchMatchCount: number;
	impactNodeId: string | null;
	isFullscreen: boolean;
	nodeCount: number;
	edgeCount: number;
	onToggleFilter: (key: keyof FilterState) => void;
	onSearchChange: (value: string) => void;
	onClearImpact: () => void;
	onZoomToFit: () => void;
	onToggleFullscreen: () => void;
}

const entityFilterKeys: (keyof FilterState)[] = ["tasks", "docs", "memories", "decisions", "templates"];

export function GraphToolbar({
	data,
	filters,
	searchQuery,
	searchMatchCount,
	impactNodeId,
	isFullscreen,
	nodeCount,
	edgeCount,
	onToggleFilter,
	onSearchChange,
	onClearImpact,
	onZoomToFit,
	onToggleFullscreen,
}: GraphToolbarProps) {
	const hiddenEntityCount = entityFilterKeys.filter((key) => !filters[key]).length;
	const hasFilteredVisibility = hiddenEntityCount > 0 || !filters.showEdges;

	return (
		<header className="z-30 flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-2 sm:px-4">
			<div className="mr-1 flex min-w-0 items-baseline gap-2">
				<h1 className="text-sm font-semibold tracking-tight text-foreground">Graph</h1>
				<span className="hidden font-mono text-[0.6875rem] tabular-nums text-muted-foreground lg:inline">
					{nodeCount} entities · {edgeCount} relations
				</span>
			</div>

			<div className="relative order-3 min-w-[12rem] flex-[1_1_100%] sm:order-none sm:max-w-sm sm:flex-[1_1_16rem]">
				<label htmlFor="graph-search" className="sr-only">
					Search graph entities
				</label>
				<Search
					aria-hidden="true"
					className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
				/>
				<input
					id="graph-search"
					name="graph-search"
					type="search"
					autoComplete="off"
					value={searchQuery}
					onChange={(event) => onSearchChange(event.target.value)}
					placeholder="Search graph…"
					className="h-11 w-full rounded-md border border-border bg-background pl-8 pr-10 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:h-9"
				/>
				{searchQuery && (
					<button
						type="button"
						aria-label="Clear graph search"
						onClick={() => onSearchChange("")}
						className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-7 sm:w-7"
					>
						<X aria-hidden="true" className="h-3.5 w-3.5" />
					</button>
				)}
			</div>

			{searchQuery && (
				<span
					className="order-4 font-mono text-[0.6875rem] tabular-nums text-muted-foreground sm:order-none"
					aria-live="polite"
				>
					{searchMatchCount} {searchMatchCount === 1 ? "match" : "matches"}
				</span>
			)}

			<div className="ml-auto flex items-center gap-1">
				{impactNodeId && (
					<button
						type="button"
						onClick={onClearImpact}
						className="hidden h-9 items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex"
					>
						<span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: TASK_COLOR }} />
						2-hop focus
						<X aria-hidden="true" className="h-3 w-3 text-muted-foreground" />
					</button>
				)}

				<Popover>
					<PopoverTrigger asChild>
						<button
							type="button"
							aria-label="Graph filters"
							className={cn(
								"relative flex h-11 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:px-2.5",
								hasFilteredVisibility ? "bg-accent text-foreground" : "bg-background text-muted-foreground",
							)}
						>
							<SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
							<span className="hidden md:inline">Filters</span>
							{hasFilteredVisibility && (
								<span
									className="absolute -right-1 -top-1 h-2 w-2 rounded-full border border-background"
									style={{ backgroundColor: TASK_COLOR }}
								/>
							)}
						</button>
					</PopoverTrigger>
					<PopoverContent align="end" sideOffset={8} className="w-72 rounded-lg border-border bg-popover p-3 shadow-lg">
						<div className="mb-3">
							<div className="text-sm font-semibold">Graph filters</div>
							<p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
								Isolated entities are hidden by default.
							</p>
						</div>
						<GraphLegend data={data} filters={filters} onToggleFilter={onToggleFilter} />
					</PopoverContent>
				</Popover>

				<button
					type="button"
					aria-label="Fit graph to view"
					title="Fit graph to view"
					onClick={onZoomToFit}
					className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:w-9"
				>
					<Scan aria-hidden="true" className="h-4 w-4" />
				</button>
				<button
					type="button"
					aria-label={isFullscreen ? "Exit graph fullscreen" : "Open graph fullscreen"}
					title={isFullscreen ? "Exit graph fullscreen" : "Open graph fullscreen"}
					onClick={onToggleFullscreen}
					className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:w-9"
				>
					{isFullscreen ? (
						<Minimize2 aria-hidden="true" className="h-4 w-4" />
					) : (
						<Maximize2 aria-hidden="true" className="h-4 w-4" />
					)}
				</button>
			</div>

			<div className="order-2 ml-auto font-mono text-[0.6875rem] tabular-nums text-muted-foreground sm:hidden">
				{nodeCount} · {edgeCount}
			</div>
		</header>
	);
}
