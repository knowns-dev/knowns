import * as React from "react";
import type { Table } from "@tanstack/react-table";
import { X, Search, Plus } from "lucide-react";

import { Button } from "@/ui/components/ui/button";
import { Input } from "@/ui/components/ui/input";
import { Combobox } from "@/ui/components/ui/knowns/combobox";
import { DataTable } from "@/ui/components/ui/DataTable";
import { taskColumns } from "./columns";
import type { Task } from "@/models/task";
import { useConfig } from "@/ui/contexts/ConfigContext";
import { buildStatusOptions } from "@/ui/utils/colors";

interface TaskDataTableToolbarProps {
	table: Table<Task>;
	globalFilter: string;
	setGlobalFilter: (value: string) => void;
	statusFilter: string;
	setStatusFilter: (value: string) => void;
	priorityFilter: string;
	setPriorityFilter: (value: string) => void;
	specFilter: string;
	setSpecFilter: (value: string) => void;
	availableSpecs: string[];
	statusOptions: { value: string; label: string }[];
	onNewTask?: () => void;
}

function TaskDataTableToolbar({
	globalFilter,
	setGlobalFilter,
	statusFilter,
	setStatusFilter,
	priorityFilter,
	setPriorityFilter,
	specFilter,
	setSpecFilter,
	availableSpecs,
	statusOptions,
	onNewTask,
}: TaskDataTableToolbarProps) {
	const isFiltered = globalFilter || statusFilter !== "all" || priorityFilter !== "all" || specFilter !== "all";

	return (
		<div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 sm:gap-4">
			<div className="flex flex-1 items-center flex-wrap gap-2">
				<div className="relative flex-1 min-w-[150px] sm:min-w-[200px] sm:max-w-[250px]">
					<Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
					<Input
						placeholder="Search tasks..."
						value={globalFilter}
						onChange={(event) => setGlobalFilter(event.target.value)}
						className="pl-8 border-border/40"
					/>
				</div>
				<Combobox
					aria-label="Status"
					value={statusFilter}
					onValueChange={setStatusFilter}
					options={[{ value: "all", label: "All Status" }, ...statusOptions]}
					className="w-[100px] sm:w-[130px] h-9 text-sm"
				/>
				<Combobox
					aria-label="Priority"
					value={priorityFilter}
					onValueChange={setPriorityFilter}
					options={[
						{ value: "all", label: "All Priority" },
						{ value: "high", label: "High" },
						{ value: "medium", label: "Medium" },
						{ value: "low", label: "Low" },
					]}
					className="w-[100px] sm:w-[130px] h-9 text-sm"
				/>
				{availableSpecs.length > 0 && (
					<Combobox
						aria-label="Spec"
						value={specFilter}
						onValueChange={setSpecFilter}
						options={[
							{ value: "all", label: "All Specs" },
							{ value: "none", label: "No Spec" },
							...availableSpecs.map((spec) => ({ value: spec, label: spec.split("/").pop() ?? spec })),
						]}
						className="w-[100px] sm:w-[130px] h-9 text-sm"
					/>
				)}
				{isFiltered && (
					<button
						type="button"
						onClick={() => {
							setGlobalFilter("");
							setStatusFilter("all");
							setPriorityFilter("all");
							setSpecFilter("all");
						}}
						className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
					>
						Reset
						<X className="h-3.5 w-3.5" />
					</button>
				)}
			</div>
			{onNewTask && (
				<Button onClick={onNewTask} size="sm" className="shrink-0 w-full sm:w-auto gap-1.5">
					<Plus className="h-4 w-4" />
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
	const { config } = useConfig();
	const [globalFilter, setGlobalFilter] = React.useState("");
	const [statusFilter, setStatusFilter] = React.useState("all");
	const [priorityFilter, setPriorityFilter] = React.useState("all");
	const [specFilter, setSpecFilter] = React.useState("all");

	// Build status options from config
	const statusOptions = React.useMemo(() => {
		const statuses = config.statuses || ["todo", "in-progress", "in-review", "done", "blocked"];
		return buildStatusOptions(statuses);
	}, [config.statuses]);

	// Extract unique specs from tasks
	const availableSpecs = React.useMemo(() => {
		const specs = new Set<string>();
		for (const task of tasks) {
			if (task.spec) specs.add(task.spec);
		}
		return Array.from(specs).sort();
	}, [tasks]);

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
					(task.labels ?? []).some((label) => label.toLowerCase().includes(search))
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

		// Spec filter
		if (specFilter !== "all") {
			if (specFilter === "none") {
				result = result.filter((task) => !task.spec);
			} else {
				result = result.filter((task) => task.spec === specFilter);
			}
		}

		return result;
	}, [tasks, globalFilter, statusFilter, priorityFilter, specFilter]);

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
					specFilter={specFilter}
					setSpecFilter={setSpecFilter}
					availableSpecs={availableSpecs}
					statusOptions={statusOptions}
					onNewTask={onNewTask}
				/>
			}
		/>
	);
}
