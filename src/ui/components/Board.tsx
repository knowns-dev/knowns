import { useEffect, useState } from "react";
import type { Task, TaskStatus } from "../../models/task";
import { useTheme } from "../App";
import { api } from "../api/client";
import Column from "./Column";
import TaskDetailModal from "./TaskDetailModal";

const COLUMNS: TaskStatus[] = ["todo", "in-progress", "in-review", "done", "blocked"];

const COLUMN_LABELS: Record<TaskStatus, string> = {
	todo: "To Do",
	"in-progress": "In Progress",
	"in-review": "In Review",
	done: "Done",
	blocked: "Blocked",
};

const Icons = {
	Eye: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
			/>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
			/>
		</svg>
	),
	EyeOff: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
			/>
		</svg>
	),
};

interface BoardProps {
	tasks: Task[];
	loading: boolean;
	onTasksUpdate: (tasks: Task[]) => void;
}

export default function Board({ tasks, loading, onTasksUpdate }: BoardProps) {
	const { isDark } = useTheme();
	const [selectedTask, setSelectedTask] = useState<Task | null>(null);
	const [visibleColumns, setVisibleColumns] = useState<Set<TaskStatus>>(
		new Set(["todo", "in-progress", "done"])
	);

	// Load visible columns from config
	useEffect(() => {
		fetch("http://localhost:3456/api/config")
			.then((res) => res.json())
			.then((data) => {
				if (data.config?.visibleColumns) {
					setVisibleColumns(new Set(data.config.visibleColumns));
				}
			})
			.catch((err) => console.error("Failed to load config:", err));
	}, []);

	// Save visible columns to config when changed
	const saveVisibleColumns = async (columns: Set<TaskStatus>) => {
		try {
			// Get current config first
			const response = await fetch("http://localhost:3456/api/config");
			const data = await response.json();
			const config = data.config || {};

			// Update visibleColumns
			config.visibleColumns = [...columns];

			// Save back
			await fetch("http://localhost:3456/api/config", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(config),
			});
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
		setSelectedTask(task);
	};

	const handleModalClose = () => {
		setSelectedTask(null);
	};

	const handleTaskUpdate = (updatedTask: Task) => {
		onTasksUpdate(tasks.map((t) => (t.id === updatedTask.id ? updatedTask : t)));
		setSelectedTask(updatedTask);
	};

	const handleNavigateToTask = (taskId: string) => {
		const task = tasks.find((t) => t.id === taskId);
		if (task) setSelectedTask(task);
	};

	const bgColor = isDark ? "bg-gray-800" : "bg-white";
	const _textColor = isDark ? "text-gray-200" : "text-gray-900";
	const textSecondary = isDark ? "text-gray-400" : "text-gray-600";
	const borderColor = isDark ? "border-gray-700" : "border-gray-200";

	return (
		<>
			{/* Column Visibility Controls */}
			<div className={`${bgColor} rounded-lg p-4 mb-4 border ${borderColor}`}>
				<div className="flex items-center gap-4 flex-wrap">
					<span className={`text-sm font-medium ${textSecondary}`}>Show Columns:</span>
					{COLUMNS.map((column) => {
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
									{isVisible ? <Icons.Eye /> : <Icons.EyeOff />}
									<span className="text-sm font-medium">{COLUMN_LABELS[column]}</span>
								</button>
							</label>
						);
					})}
				</div>
			</div>

			{/* Board Columns */}
			<div className="flex gap-4 overflow-x-auto pb-4">
				{COLUMNS.filter((status) => visibleColumns.has(status)).map((status) => (
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

			<TaskDetailModal
				task={selectedTask}
				allTasks={tasks}
				onClose={handleModalClose}
				onUpdate={handleTaskUpdate}
				onNavigateToTask={handleNavigateToTask}
			/>
		</>
	);
}
