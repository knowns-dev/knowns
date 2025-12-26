import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { Task, TaskStatus } from "../../models/task";
import { useTheme } from "../App";
import { api, getConfig, saveConfig } from "../api/client";
import Column from "./Column";
import TaskDetailModal from "./TaskDetailModal";
import { ScrollArea, ScrollBar } from "./ui/scroll-area";

// Default column labels (can be overridden by config)
const DEFAULT_COLUMN_LABELS: Record<string, string> = {
	todo: "To Do",
	"in-progress": "In Progress",
	"in-review": "In Review",
	done: "Done",
	blocked: "Blocked",
	"on-hold": "On Hold",
};

// Convert status slug to readable label
function getColumnLabel(status: string): string {
	if (DEFAULT_COLUMN_LABELS[status]) {
		return DEFAULT_COLUMN_LABELS[status];
	}
	// Auto-generate label: "my-status" → "My Status"
	return status
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}


interface BoardProps {
	tasks: Task[];
	loading: boolean;
	onTasksUpdate: (tasks: Task[]) => void;
}

export default function Board({ tasks, loading, onTasksUpdate }: BoardProps) {
	const { isDark } = useTheme();
	const [availableStatuses, setAvailableStatuses] = useState<TaskStatus[]>([]);
	const [visibleColumns, setVisibleColumns] = useState<Set<TaskStatus>>(new Set());

	// Get selected task from URL hash
	const getSelectedTask = (): Task | null => {
		const hash = window.location.hash.slice(1);
		const match = hash.match(/^\/kanban\/([^?]+)/);
		if (!match) return null;

		const taskId = match[1];
		return tasks.find((t) => t.id === taskId) || null;
	};

	const [selectedTask, setSelectedTask] = useState<Task | null>(getSelectedTask());

	// Listen to hash changes and tasks updates to update selected task
	useEffect(() => {
		const handleHashChange = () => {
			setSelectedTask(getSelectedTask());
		};

		// Also update when tasks change (for initial load or when navigating directly to URL)
		setSelectedTask(getSelectedTask());

		window.addEventListener("hashchange", handleHashChange);
		return () => window.removeEventListener("hashchange", handleHashChange);
	}, [tasks]);

	// Load statuses and visible columns from config
	useEffect(() => {
		getConfig()
			.then((config) => {
				const statuses = (config?.statuses as TaskStatus[]) || [
					"todo",
					"in-progress",
					"in-review",
					"done",
					"blocked",
				];
				setAvailableStatuses(statuses);

				// By default, all columns are visible
				const newVisibleColumns = new Set(statuses);

				// If user has saved a preference, use that instead
				if (config?.visibleColumns) {
					setVisibleColumns(new Set(config.visibleColumns as TaskStatus[]));
				} else {
					setVisibleColumns(newVisibleColumns);
				}
			})
			.catch((err) => console.error("Failed to load config:", err));
	}, []);

	// Save visible columns to config when changed
	const saveVisibleColumns = async (columns: Set<TaskStatus>) => {
		try {
			// Get current config first
			const config = await getConfig();

			// Update visibleColumns
			config.visibleColumns = [...columns];

			// Save back
			await saveConfig(config);
		} catch (err) {
			console.error("Failed to save config:", err);
		}
	};

	const toggleColumn = (column: TaskStatus) => {
		setVisibleColumns((prev) => {
			const next = new Set(prev);
			if (next.has(column)) {
				next.delete(column);
			} else {
				next.add(column);
			}
			saveVisibleColumns(next);
			return next;
		});
	};

	const handleDrop = async (taskId: string, newStatus: TaskStatus) => {
		const task = tasks.find((t) => t.id === taskId);
		if (!task || task.status === newStatus) return;

		// Optimistic update
		onTasksUpdate(tasks.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t)));

		try {
			await api.updateTask(taskId, { status: newStatus });
		} catch (error) {
			console.error("Failed to update task:", error);
			// Revert on error
			api.getTasks().then(onTasksUpdate).catch(console.error);
		}
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-center">
					<div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900" />
					<p className="mt-2 text-gray-600">Loading tasks...</p>
				</div>
			</div>
		);
	}

	const handleTaskClick = (task: Task) => {
		// Update URL hash instead of setting state directly
		window.location.hash = `/kanban/${task.id}`;
	};

	const handleModalClose = () => {
		// Clear task ID from hash, return to kanban page
		window.location.hash = "/";
	};

	const handleTaskUpdate = (updatedTask: Task) => {
		onTasksUpdate(tasks.map((t) => (t.id === updatedTask.id ? updatedTask : t)));
		// Keep modal open by maintaining hash
	};

	const handleNavigateToTask = (taskId: string) => {
		// Navigate to task via hash
		window.location.hash = `/kanban/${taskId}`;
	};

	const bgColor = isDark ? "bg-gray-800" : "bg-white";
	const _textColor = isDark ? "text-gray-200" : "text-gray-900";
	const textSecondary = isDark ? "text-gray-400" : "text-gray-600";
	const borderColor = isDark ? "border-gray-700" : "border-gray-200";

	return (
		<div className="flex flex-col h-full">
			{/* Column Visibility Controls - Fixed at top */}
			<div className={`shrink-0 ${bgColor} rounded-lg p-4 mb-4 border ${borderColor}`}>
				<div className="flex items-center gap-4 flex-wrap">
					<span className={`text-sm font-medium ${textSecondary}`}>Show Columns:</span>
					{availableStatuses.map((column) => {
						const isVisible = visibleColumns.has(column);
						return (
							<label
								key={column}
								className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
							>
								<button
									type="button"
									onClick={() => toggleColumn(column)}
									className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors ${
										isVisible
											? isDark
												? "bg-blue-900 text-blue-200"
												: "bg-blue-100 text-blue-700"
											: isDark
												? "bg-gray-700 text-gray-400"
												: "bg-gray-100 text-gray-500"
									}`}
								>
									{isVisible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
									<span className="text-sm font-medium">{getColumnLabel(column)}</span>
								</button>
							</label>
						);
					})}
				</div>
			</div>

			{/* Board Columns - Horizontal scrollable area */}
			<ScrollArea className="flex-1">
				<div className="flex gap-4 pb-4 min-h-full">
					{availableStatuses.filter((status) => visibleColumns.has(status)).map((status) => (
						<Column
							key={status}
							status={status}
							tasks={tasks.filter((t) => t.status === status)}
							onDrop={handleDrop}
							onTaskClick={handleTaskClick}
						/>
					))}
				</div>

				{visibleColumns.size === 0 && (
					<div className="text-center py-12">
						<p className={`text-lg ${textSecondary}`}>
							No columns visible. Please select at least one column to display.
						</p>
					</div>
				)}
				<ScrollBar orientation="horizontal" />
			</ScrollArea>

			<TaskDetailModal
				task={selectedTask}
				allTasks={tasks}
				onClose={handleModalClose}
				onUpdate={handleTaskUpdate}
				onNavigateToTask={handleNavigateToTask}
			/>
		</div>
	);
}
