import type { Column } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, EyeOff } from "lucide-react";

import { cn } from "@/ui/lib/utils";
import { Button } from "@/ui/components/ui/button";
import { Menu, type MenuItem, type MenuSection } from "@/ui/components/ui/knowns/menu";

interface DataTableColumnHeaderProps<TData, TValue> extends React.HTMLAttributes<HTMLDivElement> {
	column: Column<TData, TValue>;
	title: string;
}

export function DataTableColumnHeader<TData, TValue>({
	column,
	title,
	className,
}: DataTableColumnHeaderProps<TData, TValue>) {
	if (!column.getCanSort()) {
		return <div className={cn(className)}>{title}</div>;
	}

	const sorted = column.getIsSorted();
	const sections: MenuSection[] = [
		{
			id: "sort",
			items: [
				{ id: "asc", label: "Asc", icon: <ArrowUp />, kind: "radio", checked: sorted === "asc" },
				{ id: "desc", label: "Desc", icon: <ArrowDown />, kind: "radio", checked: sorted === "desc" },
			],
		},
		...(column.getCanHide() ? [{ id: "view", items: [{ id: "hide", label: "Hide", icon: <EyeOff /> }] }] : []),
	];

	const onSelect = (item: MenuItem) => {
		if (item.id === "asc") column.toggleSorting(false);
		else if (item.id === "desc") column.toggleSorting(true);
		else if (item.id === "hide") column.toggleVisibility(false);
	};

	return (
		<div className={cn("flex items-center space-x-2", className)}>
			<Menu
				aria-label={`Sort by ${title}`}
				items={sections}
				onSelect={onSelect}
				trigger={
					<Button variant="ghost" size="sm" className="-ml-3 h-8 aria-expanded:bg-accent">
						<span>{title}</span>
						{sorted === "desc" ? (
							<ArrowDown className="ml-2 h-4 w-4" />
						) : sorted === "asc" ? (
							<ArrowUp className="ml-2 h-4 w-4" />
						) : (
							<ChevronsUpDown className="ml-2 h-4 w-4" />
						)}
					</Button>
				}
			/>
		</div>
	);
}
