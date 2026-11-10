import { forwardRef } from "react";
import { Search, X } from "lucide-react";

import { Input } from "@/ui/components/ui/knowns/input";
import { SegmentedControl } from "@/ui/components/ui/knowns/segmented-control";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

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

const FILTER_OPTIONS: { value: DocsFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "specs", label: "Specs" },
	{ value: "imported", label: "Imported" },
];

export const DocsLibraryToolbar = forwardRef<
	HTMLInputElement,
	DocsLibraryToolbarProps
>(function DocsLibraryToolbar(
	{ filter, onFilterChange, onQueryChange, onSortChange, query, sort },
	ref,
) {
	return (
		<div className="flex shrink-0 flex-col gap-2.5 border-b border-border/55 px-4 py-3 sm:px-6 lg:flex-row lg:items-center">
			<Input
				ref={ref}
				value={query}
				onChange={(event) => onQueryChange(event.target.value)}
				placeholder="Search title, path, tags, description..."
				aria-label="Search docs"
				icon={<Search />}
				trailing={
					query ? (
						<button
							type="button"
							onClick={() => onQueryChange("")}
							className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
							aria-label="Clear search"
						>
							<X className="size-3.5" />
						</button>
					) : undefined
				}
				className="min-w-0 flex-1 lg:max-w-xl"
			/>

			<div className="flex items-center gap-2.5 lg:ml-auto">
				<SegmentedControl
					aria-label="Filter docs"
					options={FILTER_OPTIONS}
					value={filter}
					onValueChange={(value) => onFilterChange(value as DocsFilter)}
				/>
				<Select value={sort} onValueChange={(value) => onSortChange(value as DocsSort)}>
					<SelectTrigger className="h-9 min-w-0 flex-1 text-[13px] sm:w-[150px] sm:flex-none" aria-label="Sort docs">
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
	);
});
