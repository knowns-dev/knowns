import { forwardRef } from "react";
import { Search, X } from "lucide-react";

import { Input } from "../ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { cn } from "../../lib/utils";

export type DocsFilter = "all" | "specs" | "imported";
export type DocsSort = "updated-desc" | "title-asc" | "path-asc";

interface DocsLibraryToolbarProps {
	filter: DocsFilter;
	onFilterChange: (filter: DocsFilter) => void;
	onQueryChange: (query: string) => void;
	onSortChange: (sort: DocsSort) => void;
	query: string;
	sort: DocsSort;
}

const FILTER_LABELS: Record<DocsFilter, string> = {
	all: "All",
	specs: "Specs",
	imported: "Imported",
};

export const DocsLibraryToolbar = forwardRef<
	HTMLInputElement,
	DocsLibraryToolbarProps
>(function DocsLibraryToolbar(
	{
		filter,
		onFilterChange,
		onQueryChange,
		onSortChange,
		query,
		sort,
	},
	ref,
) {
	return (
		<div className="shrink-0 border-b border-border/45 px-4 py-3 sm:px-6">
			<div className="flex flex-col gap-2.5 lg:flex-row lg:items-center">
				<div className="relative min-w-0 flex-1 lg:max-w-xl">
					<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						ref={ref}
						value={query}
						onChange={(event) => onQueryChange(event.target.value)}
						placeholder="Search title, path, tags, description..."
						className="h-9 rounded-md border-border/70 bg-background pl-9 pr-9 text-sm shadow-none focus-visible:ring-2"
						aria-label="Search docs"
					/>
					{query && (
						<button
							type="button"
							onClick={() => onQueryChange("")}
							className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
							aria-label="Clear search"
						>
							<X className="h-3.5 w-3.5" />
						</button>
					)}
				</div>

				<div className="flex items-center gap-2.5">
					<div
						className="inline-flex h-9 w-fit items-center rounded-md border border-border/70 bg-muted/35 p-0.5"
						aria-label="Filter docs"
					>
						{(["all", "specs", "imported"] as DocsFilter[]).map(
							(option) => (
								<button
									key={option}
									type="button"
									onClick={() => onFilterChange(option)}
									className={cn(
										"h-7 rounded px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
										filter === option
											? "bg-background text-foreground shadow-sm"
											: "text-muted-foreground hover:text-foreground",
									)}
									aria-pressed={filter === option}
								>
									{FILTER_LABELS[option]}
								</button>
							),
						)}
					</div>

					<Select
						value={sort}
						onValueChange={(value) => onSortChange(value as DocsSort)}
					>
						<SelectTrigger
							className="h-9 min-w-0 flex-1 rounded-md border-border/70 bg-background text-xs shadow-none sm:w-[148px] sm:flex-none"
							aria-label="Sort docs"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="updated-desc">Last updated</SelectItem>
							<SelectItem value="title-asc">Title</SelectItem>
							<SelectItem value="path-asc">Path</SelectItem>
						</SelectContent>
					</Select>
				</div>
			</div>
		</div>
	);
});
