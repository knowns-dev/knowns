import { Archive, Maximize2, Minimize2, Scan, Search, SlidersHorizontal, X } from "lucide-react";

import type { GraphData } from "@/ui/api/client";
import { FeatureHeader } from "@/ui/components/templates";
import { Button } from "@/ui/components/ui/knowns/button";
import { Input } from "@/ui/components/ui/knowns/input";
import { Popover } from "@/ui/components/ui/knowns/popover";
import { Tooltip } from "@/ui/components/ui/knowns/tooltip";
import { cn } from "@/ui/lib/knowns/utils";

import type { FilterState } from "./constants";
import { GraphLegend } from "./GraphLegend";
import type { GraphColors } from "./theme";

interface GraphToolbarProps {
	data: GraphData | null;
	filters: FilterState;
	filtersChanged: boolean;
	colors: GraphColors;
	searchQuery: string;
	searchMatchCount: number;
	isFullscreen: boolean;
	nodeCount: number;
	edgeCount: number;
	onToggleFilter: (key: keyof FilterState) => void;
	onResetFilters: () => void;
	onSearchChange: (value: string) => void;
	onZoomToFit: () => void;
	onToggleFullscreen: () => void;
	includeArchived: boolean;
	onToggleArchived: () => void;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The Graph page header: the shared FeatureHeader (title, counts) with search, filters and the
 * view controls as its actions. On a phone the actions wrap under the title, search takes the
 * first row on its own and the buttons sit on the next, all at touch height.
 */
export function GraphToolbar({
	data,
	filters,
	filtersChanged,
	colors,
	searchQuery,
	searchMatchCount,
	isFullscreen,
	nodeCount,
	edgeCount,
	onToggleFilter,
	onResetFilters,
	onSearchChange,
	onZoomToFit,
	onToggleFullscreen,
	includeArchived,
	onToggleArchived,
}: GraphToolbarProps) {
	const archivedLabel = includeArchived ? "Hide archived tasks" : "Show archived tasks";
	const fullscreenLabel = isFullscreen ? "Exit graph fullscreen" : "Open graph fullscreen";

	return (
		<FeatureHeader
			title="Graph"
			status={`${plural(nodeCount, "entity", "entities")} · ${plural(edgeCount, "relation", "relations")}`}
			actions={
				<div className="flex w-full min-w-0 items-center gap-2 lg:w-auto">
					<label htmlFor="graph-search" className="sr-only">
						Search graph entities
					</label>
					<Input
						id="graph-search"
						name="graph-search"
						type="search"
						autoComplete="off"
						value={searchQuery}
						onChange={(event) => onSearchChange(event.target.value)}
						placeholder="Search graph…"
						icon={<Search />}
						className="min-w-0 flex-1 sm:w-64 sm:flex-none [&_input::-webkit-search-cancel-button]:hidden"
						suffix={
							searchQuery ? (
								<span aria-live="polite" className="text-[12px] tabular-nums">
									{plural(searchMatchCount, "match", "matches")}
								</span>
							) : undefined
						}
						trailing={
							searchQuery ? (
								<Button variant="ghost" size="xs" icon={<X />} aria-label="Clear graph search" onClick={() => onSearchChange("")} />
							) : undefined
						}
					/>

					<div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
						<Popover
							align="end"
							aria-label="Graph filters"
							className="w-[min(18rem,calc(100vw-2rem))]"
							trigger={
								<Button variant="secondary" icon={<SlidersHorizontal />} aria-label="Graph filters" className="relative max-md:w-8 max-md:px-0 max-md:pointer-coarse:w-10">
									<span className="max-md:hidden">Filters</span>
									{filtersChanged && (
										<span
											aria-hidden="true"
											className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-[color:var(--kn-accent,var(--primary))] ring-2 ring-background"
										/>
									)}
								</Button>
							}
						>
							<div className="mb-3 flex items-start justify-between gap-3 px-2">
								<div>
									<div className="text-[13.5px] font-semibold text-foreground">Graph filters</div>
									<p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">Isolated entities are hidden by default.</p>
								</div>
								{filtersChanged && (
									<Button variant="quiet" size="sm" onClick={onResetFilters}>
										Reset
									</Button>
								)}
							</div>
							<GraphLegend data={data} filters={filters} colors={colors} onToggleFilter={onToggleFilter} />
						</Popover>

						<Tooltip content={archivedLabel}>
							<Button
								variant="ghost"
								icon={<Archive />}
								aria-pressed={includeArchived}
								aria-label={archivedLabel}
								onClick={onToggleArchived}
								className={cn(includeArchived && "bg-muted text-foreground")}
							/>
						</Tooltip>
						<Tooltip content="Fit graph to view" description="F">
							<Button variant="ghost" icon={<Scan />} aria-label="Fit graph to view" onClick={onZoomToFit} />
						</Tooltip>
						<Tooltip content={fullscreenLabel}>
							<Button
								variant="ghost"
								icon={isFullscreen ? <Minimize2 /> : <Maximize2 />}
								aria-label={fullscreenLabel}
								onClick={onToggleFullscreen}
							/>
						</Tooltip>
					</div>
				</div>
			}
		/>
	);
}
