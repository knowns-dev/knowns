import { useEffect, useState } from "react";
import { Plus, Filter, ClipboardList } from "lucide-react";
import type { Task } from "../../models/task";
import { useTheme } from "../App";
import TaskDetailModal from "../components/TaskDetailModal";
import { ScrollArea } from "../components/ui/scroll-area";

// Default status icons
const DEFAULT_STATUS_ICONS: Record<string, string> = {
	todo: "○",
	"in-progress": "◒",
	"in-review": "◎",
	done: "◉",
	blocked: "⊗",
	"on-hold": "⊙",
	urgent: "⚡",
};

// Default status labels
const DEFAULT_STATUS_LABELS: Record<string, string> = {
	todo: "To Do",
	"in-progress": "In Progress",
	"in-review": "In Review",
	done: "Done",
	blocked: "Blocked",
	"on-hold": "On Hold",
	urgent: "Urgent",
};

// Get status icon with fallback
function getStatusIcon(status: string): string {
	return DEFAULT_STATUS_ICONS[status] || "●";
}

// Get status label with fallback
function getStatusLabel(status: string): string {
	if (DEFAULT_STATUS_LABELS[status]) {
		return DEFAULT_STATUS_LABELS[status];
	}
	// Auto-generate: "my-status" → "My Status"
	return status
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

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
	const [parentFilter, setParentFilter] = useState<string>("all");
	const [selectedTask, setSelectedTask] = useState<Task | null>(null);
	const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());

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

	// Get list of parent tasks (tasks that have subtasks)
	const parentTasks = tasks.filter((t) => t.subtasks && t.subtasks.length > 0);

	// Filter tasks by status and parent
	let filteredTasks = statusFilter === "all" ? tasks : tasks.filter((t) => t.status === statusFilter);

	// Apply parent filter
	if (parentFilter === "root") {
		// Show only tasks without parent
		filteredTasks = filteredTasks.filter((t) => !t.parent);
	} else if (parentFilter !== "all") {
		// Show only subtasks of selected parent
		filteredTasks = filteredTasks.filter((t) => t.parent === parentFilter);
	}

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
		<div className="p-6 h-full flex flex-col overflow-hidden">
			{/* Header with title and New Task button */}
			<div className="mb-6 flex items-center justify-between gap-4">
				<div className="flex-1">
					<h1 className={`text-2xl font-bold ${textColor} mb-4`}>All Tasks</h1>

					{/* Filters */}
					<div className="flex items-center gap-3 flex-wrap">
						<Filter className="w-4 h-4" />

						{/* Status Filter */}
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

						{/* Parent Filter */}
						<select
							value={parentFilter}
							onChange={(e) => setParentFilter(e.target.value)}
							className={`px-3 py-2 rounded-lg border ${borderColor} ${bgColor} ${textColor} focus:outline-none focus:ring-2 focus:ring-blue-500`}
						>
							<option value="all">All Tasks</option>
							<option value="root">Root Tasks Only</option>
							{parentTasks.map((parent) => {
								const fullText = `Subtasks of #${parent.id}: ${parent.title}`;
								const displayText = fullText.length > 60 ? fullText.substring(0, 60) + "..." : fullText;
								return (
									<option key={parent.id} value={parent.id} title={fullText}>
										{displayText}
									</option>
								);
							})}
						</select>

						<span className={textSecondary}>
							{filteredTasks.length} {filteredTasks.length === 1 ? "task" : "tasks"}
						</span>
					</div>
				</div>

				<button
					type="button"
					onClick={onNewTask}
					className="shrink-0 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 flex items-center gap-2 transition-colors ml-4"
				>
					<Plus className="w-4 h-4" />
					New Task
				</button>
			</div>

			{/* Task Groups */}
			<ScrollArea className="flex-1">
				<div className="space-y-6 pr-4">
				{Object.entries(groupedTasks).map(([status, statusTasks]) => {
					if (statusTasks.length === 0) return null;

					return (
						<div key={status}>
							<h2 className={`text-lg font-semibold ${textColor} mb-3`}>
								{getStatusLabel(status)} ({statusTasks.length})
							</h2>
							<div className="space-y-2">
								{statusTasks.map((task) => {
									const isExpanded = expandedTasks.has(task.id);
									const parentTask = task.parent ? tasks.find((t) => t.id === task.parent) : null;

									return (
										<div
											key={task.id}
											className={`${bgColor} rounded-lg p-4 border ${borderColor} transition-colors`}
										>
											<div className="flex items-start gap-3">
												{/* Status Icon */}
												<span className="text-xl mt-0.5">{getStatusIcon(task.status)}</span>

												{/* Task Info */}
												<div className="flex-1 min-w-0">
													<div className="flex items-center gap-2 mb-1 flex-wrap">
														<span className={`text-xs ${textSecondary} font-mono`}>
															{task.id}
														</span>
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

														{/* Parent/Subtask badges */}
														{parentTask && (
															<span
																className={`text-xs px-2 py-0.5 rounded ${isDark ? "bg-purple-900 text-purple-200" : "bg-purple-100 text-purple-700"}`}
															>
																Subtask of #{parentTask.id}
															</span>
														)}
														{task.subtasks && task.subtasks.length > 0 && (
															<span
																className={`text-xs px-2 py-0.5 rounded ${isDark ? "bg-green-900 text-green-200" : "bg-green-100 text-green-700"}`}
															>
																{task.subtasks.length} subtask
																{task.subtasks.length > 1 ? "s" : ""}
															</span>
														)}
													</div>

													<button
														type="button"
														onClick={() => {
															// Navigate to kanban view with task detail
															window.location.hash = `/kanban/${task.id}`;
														}}
														className={`font-medium ${textColor} mb-1 hover:underline text-left w-full`}
													>
														{task.title}
													</button>

													{task.description && (
														<div className={`text-sm ${textSecondary} mt-2`}>
															<p
																className={
																	isExpanded ? "" : "line-clamp-2"
																}
															>
																{task.description}
															</p>
															{task.description.length > 100 && (
																<button
																	type="button"
																	onClick={(e) => {
																		e.stopPropagation();
																		const newExpanded = new Set(
																			expandedTasks,
																		);
																		if (isExpanded) {
																			newExpanded.delete(task.id);
																		} else {
																			newExpanded.add(task.id);
																		}
																		setExpandedTasks(newExpanded);
																	}}
																	className={`text-xs ${isDark ? "text-blue-400 hover:text-blue-300" : "text-blue-600 hover:text-blue-700"} mt-1 font-medium`}
																>
																	{isExpanded ? "Show less" : "Show more"}
																</button>
															)}
														</div>
													)}

													{/* Acceptance Criteria Progress */}
													{task.acceptanceCriteria.length > 0 && (
														<div className={`flex items-center gap-2 mt-2 text-xs ${textSecondary}`}>
															<ClipboardList className="w-3 h-3" />
															<span>
																{task.acceptanceCriteria.filter((ac) => ac.completed).length}/
																{task.acceptanceCriteria.length} criteria
															</span>
														</div>
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
													<span
														className={`text-sm ${textSecondary} font-mono shrink-0`}
													>
														{task.assignee}
													</span>
												)}
											</div>
										</div>
									);
								})}
							</div>
						</div>
					);
				})}
				{filteredTasks.length === 0 && (
					<div className="text-center py-12">
						<p className={`text-lg ${textSecondary}`}>No tasks found</p>
					</div>
				)}
				</div>
			</ScrollArea>

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
