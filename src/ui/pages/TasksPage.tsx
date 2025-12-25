import { useEffect, useState } from "react";
import type { Task } from "../../models/task";
import { useTheme } from "../App";
import TaskDetailModal from "../components/TaskDetailModal";

interface TasksPageProps {
	tasks: Task[];
	loading: boolean;
	onTasksUpdate: () => void;
	selectedTask?: Task | null;
	onTaskClose?: () => void;
	onNewTask: () => void;
}

const Icons = {
	Plus: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
		</svg>
	),
	Filter: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
			/>
		</svg>
	),
};

const statusIcons: Record<string, string> = {
	todo: "○",
	"in-progress": "◒",
	"in-review": "◎",
	done: "◉",
	blocked: "⊗",
};

const statusLabels: Record<string, string> = {
	todo: "To Do",
	"in-progress": "In Progress",
	"in-review": "In Review",
	done: "Done",
	blocked: "Blocked",
};

export default function TasksPage({
	tasks,
	loading,
	onTasksUpdate,
	selectedTask: externalSelectedTask,
	onTaskClose,
	onNewTask,
}: TasksPageProps) {
	const { isDark } = useTheme();
	const [statusFilter, setStatusFilter] = useState<string>("all");
	const [selectedTask, setSelectedTask] = useState<Task | null>(null);

	// Handle external selected task from search
	useEffect(() => {
		if (externalSelectedTask) {
			setSelectedTask(externalSelectedTask);
		}
	}, [externalSelectedTask]);

	const bgColor = isDark ? "bg-gray-800" : "bg-white";
	const textColor = isDark ? "text-gray-200" : "text-gray-900";
	const textSecondary = isDark ? "text-gray-400" : "text-gray-600";
	const borderColor = isDark ? "border-gray-700" : "border-gray-200";
	const hoverBg = isDark ? "hover:bg-gray-700" : "hover:bg-gray-50";

	// Filter tasks
	const filteredTasks =
		statusFilter === "all" ? tasks : tasks.filter((t) => t.status === statusFilter);

	// Group by status
	const groupedTasks: Record<string, Task[]> = {
		todo: [],
		"in-progress": [],
		"in-review": [],
		blocked: [],
		done: [],
	};

	for (const task of filteredTasks) {
		if (groupedTasks[task.status]) {
			groupedTasks[task.status].push(task);
		}
	}

	// Sort by priority within each group
	const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
	for (const status in groupedTasks) {
		groupedTasks[status].sort((a, b) => {
			const diff = priorityOrder[a.priority] - priorityOrder[b.priority];
			if (diff !== 0) return diff;
			return a.id.localeCompare(b.id, undefined, { numeric: true });
		});
	}

	if (loading) {
		return (
			<div className="p-6 flex items-center justify-center h-64">
				<div className={`text-lg ${textSecondary}`}>Loading tasks...</div>
			</div>
		);
	}

	return (
		<div className="p-6">
			{/* Header with title and New Task button */}
			<div className="mb-6 flex items-center justify-between">
				<div className="flex-1">
					<h1 className={`text-2xl font-bold ${textColor} mb-4`}>All Tasks</h1>

					{/* Filter */}
					<div className="flex items-center gap-2">
						<Icons.Filter />
						<select
							value={statusFilter}
							onChange={(e) => setStatusFilter(e.target.value)}
							className={`px-3 py-2 rounded-lg border ${borderColor} ${bgColor} ${textColor} focus:outline-none focus:ring-2 focus:ring-blue-500`}
						>
							<option value="all">All Status</option>
							<option value="todo">To Do</option>
							<option value="in-progress">In Progress</option>
							<option value="in-review">In Review</option>
							<option value="blocked">Blocked</option>
							<option value="done">Done</option>
						</select>
						<span className={textSecondary}>
							{filteredTasks.length} {filteredTasks.length === 1 ? "task" : "tasks"}
						</span>
					</div>
				</div>

				<button
					type="button"
					onClick={onNewTask}
					className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 flex items-center gap-2 transition-colors ml-4"
				>
					<Icons.Plus />
					New Task
				</button>
			</div>

			{/* Task Groups */}
			<div className="space-y-6">
				{Object.entries(groupedTasks).map(([status, statusTasks]) => {
					if (statusTasks.length === 0) return null;

					return (
						<div key={status}>
							<h2 className={`text-lg font-semibold ${textColor} mb-3`}>
								{statusLabels[status]} ({statusTasks.length})
							</h2>
							<div className="space-y-2">
								{statusTasks.map((task) => (
									<button
										key={task.id}
										type="button"
										onClick={() => setSelectedTask(task)}
										className={`w-full ${bgColor} rounded-lg p-4 border ${borderColor} ${hoverBg} transition-colors text-left`}
									>
										<div className="flex items-start gap-3">
											{/* Status Icon */}
											<span className="text-xl mt-0.5">{statusIcons[task.status]}</span>

											{/* Task Info */}
											<div className="flex-1 min-w-0">
												<div className="flex items-center gap-2 mb-1">
													<span className={`text-xs ${textSecondary} font-mono`}>{task.id}</span>
													<span
														className={`text-xs px-2 py-0.5 rounded ${
															task.priority === "high"
																? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200"
																: task.priority === "medium"
																	? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-200"
																	: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
														}`}
													>
														{task.priority.toUpperCase()}
													</span>
												</div>
												<h3 className={`font-medium ${textColor} mb-1`}>{task.title}</h3>
												{task.description && (
													<p className={`text-sm ${textSecondary} line-clamp-2`}>
														{task.description}
													</p>
												)}
												{task.labels.length > 0 && (
													<div className="flex gap-1 mt-2 flex-wrap">
														{task.labels.map((label) => (
															<span
																key={label}
																className={`text-xs px-2 py-0.5 rounded ${isDark ? "bg-blue-900 text-blue-200" : "bg-blue-100 text-blue-700"}`}
															>
																{label}
															</span>
														))}
													</div>
												)}
											</div>

											{/* Assignee */}
											{task.assignee && (
												<span className={`text-sm ${textSecondary} font-mono shrink-0`}>
													{task.assignee}
												</span>
											)}
										</div>
									</button>
								))}
							</div>
						</div>
					);
				})}
			</div>

			{filteredTasks.length === 0 && (
				<div className="text-center py-12">
					<p className={`text-lg ${textSecondary}`}>No tasks found</p>
				</div>
			)}

			{/* Task Detail Modal */}
			{selectedTask && (
				<TaskDetailModal
					task={selectedTask}
					allTasks={tasks}
					onClose={() => {
						setSelectedTask(null);
						if (onTaskClose) onTaskClose();
					}}
					onUpdate={onTasksUpdate}
				/>
			)}
		</div>
	);
}
