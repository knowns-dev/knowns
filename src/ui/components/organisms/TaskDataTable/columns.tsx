import type { ColumnDef } from "@tanstack/react-table";
import { Checkbox } from "@/ui/components/ui/checkbox";
import { DataTableColumnHeader } from "@/ui/components/ui/data-table";
import { StatusBadge, PriorityBadge, LabelList } from "@/ui/components/molecules";
import type { Task } from "@/models/task";

export const taskColumns: ColumnDef<Task>[] = [
	{
		id: "select",
		header: ({ table }) => (
			<Checkbox
				checked={
					table.getIsAllPageRowsSelected() ||
					(table.getIsSomePageRowsSelected() && "indeterminate")
				}
				onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
				aria-label="Select all"
				className="translate-y-[2px]"
				onClick={(e) => e.stopPropagation()}
			/>
		),
		cell: ({ row }) => (
			<Checkbox
				checked={row.getIsSelected()}
				onCheckedChange={(value) => row.toggleSelected(!!value)}
				aria-label="Select row"
				className="translate-y-[2px]"
				onClick={(e) => e.stopPropagation()}
			/>
		),
		enableSorting: false,
		enableHiding: false,
	},
	{
		accessorKey: "id",
		header: ({ column }) => <DataTableColumnHeader column={column} title="ID" />,
		cell: ({ row }) => (
			<div className="w-[60px] font-mono text-xs text-muted-foreground">#{row.getValue("id")}</div>
		),
		enableSorting: true,
		enableHiding: false,
	},
	{
		accessorKey: "title",
		header: ({ column }) => <DataTableColumnHeader column={column} title="Title" />,
		cell: ({ row }) => {
			const task = row.original;
			return (
				<div className="flex flex-col gap-1">
					<span className="font-medium line-clamp-1">{task.title}</span>
					{task.description && (
						<span className="text-xs text-muted-foreground line-clamp-1">{task.description}</span>
					)}
				</div>
			);
		},
		enableSorting: true,
	},
	{
		accessorKey: "status",
		header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
		cell: ({ row }) => {
			const status = row.getValue("status") as string;
			return <StatusBadge status={status as "todo" | "in-progress" | "in-review" | "blocked" | "done"} />;
		},
		filterFn: (row, id, value) => {
			return value.includes(row.getValue(id));
		},
		enableSorting: true,
	},
	{
		accessorKey: "priority",
		header: ({ column }) => <DataTableColumnHeader column={column} title="Priority" />,
		cell: ({ row }) => {
			const priority = row.getValue("priority") as "low" | "medium" | "high";
			return <PriorityBadge priority={priority} />;
		},
		filterFn: (row, id, value) => {
			return value.includes(row.getValue(id));
		},
		enableSorting: true,
		sortingFn: (rowA, rowB) => {
			const priorityOrder = { high: 0, medium: 1, low: 2 };
			const a = priorityOrder[rowA.getValue("priority") as keyof typeof priorityOrder] ?? 1;
			const b = priorityOrder[rowB.getValue("priority") as keyof typeof priorityOrder] ?? 1;
			return a - b;
		},
	},
	{
		accessorKey: "assignee",
		header: ({ column }) => <DataTableColumnHeader column={column} title="Assignee" />,
		cell: ({ row }) => {
			const assignee = row.getValue("assignee") as string | undefined;
			return assignee ? (
				<span className="text-sm font-mono">{assignee}</span>
			) : (
				<span className="text-muted-foreground text-sm">-</span>
			);
		},
		filterFn: (row, id, value) => {
			const assignee = row.getValue(id) as string | undefined;
			if (!assignee) return value.includes("unassigned");
			return value.includes(assignee);
		},
		enableSorting: true,
	},
	{
		accessorKey: "labels",
		header: ({ column }) => <DataTableColumnHeader column={column} title="Labels" />,
		cell: ({ row }) => {
			const labels = row.getValue("labels") as string[];
			return labels.length > 0 ? (
				<LabelList labels={labels} maxVisible={2} />
			) : (
				<span className="text-muted-foreground text-sm">-</span>
			);
		},
		filterFn: (row, id, value) => {
			const labels = row.getValue(id) as string[];
			return value.some((v: string) => labels.includes(v));
		},
		enableSorting: false,
	},
	{
		accessorKey: "acceptanceCriteria",
		header: ({ column }) => <DataTableColumnHeader column={column} title="Progress" />,
		cell: ({ row }) => {
			const criteria = row.original.acceptanceCriteria;
			if (criteria.length === 0) return <span className="text-muted-foreground text-sm">-</span>;
			const completed = criteria.filter((c) => c.completed).length;
			const total = criteria.length;
			const percentage = Math.round((completed / total) * 100);
			return (
				<div className="flex items-center gap-2 min-w-[80px]">
					<div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
						<div
							className="h-full bg-primary transition-all"
							style={{ width: `${percentage}%` }}
						/>
					</div>
					<span className="text-xs text-muted-foreground whitespace-nowrap">
						{completed}/{total}
					</span>
				</div>
			);
		},
		enableSorting: false,
	},
];
