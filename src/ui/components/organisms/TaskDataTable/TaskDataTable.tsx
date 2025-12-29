import * as React from "react";
import type { Table } from "@tanstack/react-table";
import { X, Search, Plus } from "lucide-react";

import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/ui/components/ui/select";
import { DataTable } from "@/ui/components/ui/data-table";
import { taskColumns } from "./columns";
import type { Task } from "@/models/task";

interface TaskDataTableToolbarProps {
	table: Table<Task>;
	globalFilter: string;
	setGlobalFilter: (value: string) => void;
	statusFilter: string;
	setStatusFilter: (value: string) => void;
	priorityFilter: string;
	setPriorityFilter: (value: string) => void;
	onNewTask?: () => void;
}

function TaskDataTableToolbar({
	globalFilter,
	setGlobalFilter,
	statusFilter,
	setStatusFilter,
	priorityFilter,
	setPriorityFilter,
	onNewTask,
}: TaskDataTableToolbarProps) {
	const isFiltered = globalFilter || statusFilter !== "all" || priorityFilter !== "all";

	return (
		<div className="flex items-center justify-between gap-4">
			<div className="flex flex-1 items-center space-x-2">
				<div className="relative w-[250px]">
					<Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
					<Input
						placeholder="Search tasks..."
						value={globalFilter}
						onChange={(event) => setGlobalFilter(event.target.value)}
						className="pl-8"
					/>
				</div>
				<Select value={statusFilter} onValueChange={setStatusFilter}>
					<SelectTrigger className="w-[150px]">
						<SelectValue placeholder="Status" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All Status</SelectItem>
						<SelectItem value="todo">To Do</SelectItem>
						<SelectItem value="in-progress">In Progress</SelectItem>
						<SelectItem value="in-review">In Review</SelectItem>
						<SelectItem value="blocked">Blocked</SelectItem>
						<SelectItem value="done">Done</SelectItem>
					</SelectContent>
				</Select>
				<Select value={priorityFilter} onValueChange={setPriorityFilter}>
					<SelectTrigger className="w-[150px]">
						<SelectValue placeholder="Priority" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All Priority</SelectItem>
						<SelectItem value="high">High</SelectItem>
						<SelectItem value="medium">Medium</SelectItem>
						<SelectItem value="low">Low</SelectItem>
					</SelectContent>
				</Select>
				{isFiltered && (
					<Button
						variant="ghost"
						onClick={() => {
							setGlobalFilter("");
							setStatusFilter("all");
							setPriorityFilter("all");
						}}
						className="h-8 px-2 lg:px-3"
					>
						Reset
						<X className="ml-2 h-4 w-4" />
					</Button>
				)}
			</div>
			{onNewTask && (
				<Button onClick={onNewTask} className="bg-green-700 hover:bg-green-800 text-white">
					<Plus className="mr-2 h-4 w-4" />
					New Task
				</Button>
			)}
		</div>
	);
}

interface TaskDataTableProps {
	tasks: Task[];
	onTaskClick?: (task: Task) => void;
	onSelectionChange?: (tasks: Task[]) => void;
	onNewTask?: () => void;
}

export function TaskDataTable({
	tasks,
	onTaskClick,
	onSelectionChange,
	onNewTask,
}: TaskDataTableProps) {
	const [globalFilter, setGlobalFilter] = React.useState("");
	const [statusFilter, setStatusFilter] = React.useState("all");
	const [priorityFilter, setPriorityFilter] = React.useState("all");

	// Filter tasks based on all filters
	const filteredTasks = React.useMemo(() => {
		let result = tasks;

		// Global search filter
		if (globalFilter) {
			const search = globalFilter.toLowerCase();
			result = result.filter(
				(task) =>
					task.id.toLowerCase().includes(search) ||
					task.title.toLowerCase().includes(search) ||
					task.description?.toLowerCase().includes(search) ||
					task.assignee?.toLowerCase().includes(search) ||
					task.labels.some((label) => label.toLowerCase().includes(search))
			);
		}

		// Status filter
		if (statusFilter !== "all") {
			result = result.filter((task) => task.status === statusFilter);
		}

		// Priority filter
		if (priorityFilter !== "all") {
			result = result.filter((task) => task.priority === priorityFilter);
		}

		return result;
	}, [tasks, globalFilter, statusFilter, priorityFilter]);

	return (
		<DataTable
			columns={taskColumns}
			data={filteredTasks}
			onRowClick={onTaskClick}
			onSelectionChange={onSelectionChange}
			showPagination={true}
			showRowSelection={true}
			initialSorting={[{ id: "priority", desc: false }]}
			toolbar={
				<TaskDataTableToolbar
					table={null as unknown as Table<Task>}
					globalFilter={globalFilter}
					setGlobalFilter={setGlobalFilter}
					statusFilter={statusFilter}
					setStatusFilter={setStatusFilter}
					priorityFilter={priorityFilter}
					setPriorityFilter={setPriorityFilter}
					onNewTask={onNewTask}
				/>
			}
		/>
	);
}
