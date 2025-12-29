import { useEffect, useState, useMemo } from "react";
import { Eye, EyeOff, ClipboardList, ChevronDown, ChevronUp } from "lucide-react";
import type { Task, TaskStatus } from "../../models/task";
import { api } from "../../api/client";
import { useConfig } from "../../contexts/ConfigContext";
import { TaskDetailSheet } from "./task-detail";
import { ScrollArea, ScrollBar } from "../ui/scroll-area";
import {
	KanbanProvider,
	KanbanBoard,
	KanbanHeader,
	KanbanCards,
	KanbanCard,
	type DragEndEvent,
} from "../ui/kanban";
import { Avatar } from "../atoms";
import {
	getColumnClasses,
	getStatusBadgeClasses,
	DEFAULT_STATUS_COLORS,
	type ColorName,
} from "../../utils/colors";
import { cn } from "@/ui/lib/utils";
import { useIsMobile } from "@/ui/hooks/use-mobile";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { toast } from "../ui/sonner";

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
	return status
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

// Kanban item type that extends Task with required kanban fields
type KanbanTaskItem = {
	id: string;
	name: string;
	column: string;
	task: Task;
};

// Kanban column type
type KanbanColumn = {
	id: string;
	name: string;
	color: string;
};

interface BoardProps {
	tasks: Task[];
	loading: boolean;
	onTasksUpdate: (tasks: Task[]) => void;
}

export default function Board({ tasks, loading, onTasksUpdate }: BoardProps) {
	const { config, updateConfig } = useConfig();
	const [visibleColumns, setVisibleColumns] = useState<Set<TaskStatus>>(new Set());
	const [columnControlsOpen, setColumnControlsOpen] = useState(false);
	const isMobile = useIsMobile();

	// Get statuses from config
	const availableStatuses = (config?.statuses as TaskStatus[]) || [
		"todo",
		"in-progress",
		"in-review",
		"done",
		"blocked",
	];

	// Get status colors from config
	const statusColors = (config?.statusColors as Record<string, ColorName>) || DEFAULT_STATUS_COLORS;

	// Convert statuses to kanban columns
	const columns: KanbanColumn[] = useMemo(() => {
		return availableStatuses
			.filter((status) => visibleColumns.has(status))
			.map((status) => ({
				id: status,
				name: getColumnLabel(status),
				color: statusColors[status] || "gray",
			}));
	}, [availableStatuses, visibleColumns, statusColors]);

	// Priority order for sorting (lower number = higher priority)
	const priorityOrder: Record<string, number> = {
		high: 0,
		medium: 1,
		low: 2,
	};

	// Convert tasks to kanban items with sorting
	const kanbanData: KanbanTaskItem[] = useMemo(() => {
		// Sort by priority (high → medium → low), then by updatedAt (newest first)
		const sortedTasks = [...tasks].sort((a, b) => {
			const priorityA = priorityOrder[a.priority] ?? 2;
			const priorityB = priorityOrder[b.priority] ?? 2;

			if (priorityA !== priorityB) {
				return priorityA - priorityB;
			}

			// Same priority: sort by updatedAt (newest first)
			return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
		});

		return sortedTasks.map((task) => ({
			id: task.id,
			name: task.title,
			column: task.status,
			task,
		}));
	}, [tasks]);

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

		setSelectedTask(getSelectedTask());

		window.addEventListener("hashchange", handleHashChange);
		return () => window.removeEventListener("hashchange", handleHashChange);
	}, [tasks]);

	// Initialize visible columns from config
	useEffect(() => {
		if (config?.visibleColumns) {
			setVisibleColumns(new Set(config.visibleColumns as TaskStatus[]));
		} else {
			setVisibleColumns(new Set(availableStatuses));
		}
	}, [config?.visibleColumns, availableStatuses.join(",")]);

	// Save visible columns to config when changed
	const saveVisibleColumns = async (columns: Set<TaskStatus>) => {
		try {
			await updateConfig({ visibleColumns: [...columns] });
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

	// Handle kanban data change (drag-drop)
	const handleDataChange = async (newData: KanbanTaskItem[]) => {
		// Find tasks that changed column (status)
		const changedTasks = newData.filter((item) => {
			const originalTask = tasks.find((t) => t.id === item.id);
			return originalTask && originalTask.status !== item.column;
		});

		// Optimistic update
		const updatedTasks = tasks.map((task) => {
			const newItem = newData.find((item) => item.id === task.id);
			if (newItem && newItem.column !== task.status) {
				return { ...task, status: newItem.column as TaskStatus };
			}
			return task;
		});
		onTasksUpdate(updatedTasks);

		// Call API for each changed task
		for (const item of changedTasks) {
			try {
				await api.updateTask(item.id, { status: item.column as TaskStatus });
				toast.success("Status updated", {
					description: `#${item.id} moved to ${getColumnLabel(item.column)}`,
				});
			} catch (error) {
				console.error("Failed to update task:", error);
				toast.error("Failed to update status", {
					description: error instanceof Error ? error.message : "Unknown error",
				});
				// Revert on error
				api.getTasks().then(onTasksUpdate).catch(console.error);
				break;
			}
		}
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-center">
					<div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
					<p className="mt-2 text-muted-foreground">Loading tasks...</p>
				</div>
			</div>
		);
	}

	const handleTaskClick = (task: Task) => {
		window.location.hash = `/kanban/${task.id}`;
	};

	const handleModalClose = () => {
		window.location.hash = "/";
	};

	const handleTaskUpdate = (updatedTask: Task) => {
		onTasksUpdate(tasks.map((t) => (t.id === updatedTask.id ? updatedTask : t)));
	};

	const handleNavigateToTask = (taskId: string) => {
		window.location.hash = `/kanban/${taskId}`;
	};

	const handleArchive = async (taskId: string) => {
		try {
			await api.archiveTask(taskId);
			// Remove task from list after archiving
			onTasksUpdate(tasks.filter((t) => t.id !== taskId));
			// Close modal
			handleModalClose();
		} catch (error) {
			console.error("Failed to archive task:", error);
		}
	};

	return (
		<div className="flex flex-col h-full">
			{/* Column Visibility Controls - Fixed at top */}
			{isMobile ? (
				// Mobile: Collapsible controls
				<Collapsible
					open={columnControlsOpen}
					onOpenChange={setColumnControlsOpen}
					className="shrink-0 bg-card rounded-lg mb-4 border border-border"
				>
					<CollapsibleTrigger className="flex items-center justify-between w-full p-3">
						<span className="text-sm font-medium text-muted-foreground">
							Show Columns ({visibleColumns.size}/{availableStatuses.length})
						</span>
						{columnControlsOpen ? (
							<ChevronUp className="w-4 h-4 text-muted-foreground" />
						) : (
							<ChevronDown className="w-4 h-4 text-muted-foreground" />
						)}
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="flex flex-wrap gap-2 px-3 pb-3">
							{availableStatuses.map((column) => {
								const isVisible = visibleColumns.has(column);
								const taskCount = tasks.filter((t) => t.status === column).length;
								return (
									<button
										key={column}
										type="button"
										onClick={() => toggleColumn(column)}
										className={cn(
											"flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors text-xs",
											isVisible
												? "bg-primary/10 text-primary dark:bg-primary/20"
												: "bg-muted text-muted-foreground"
										)}
									>
										{isVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
										<span className="font-medium">
											{getColumnLabel(column)} ({taskCount})
										</span>
									</button>
								);
							})}
						</div>
					</CollapsibleContent>
				</Collapsible>
			) : (
				// Desktop: Always visible controls
				<div className="shrink-0 bg-card rounded-lg p-4 mb-4 border border-border">
					<div className="flex items-center gap-4 flex-wrap">
						<span className="text-sm font-medium text-muted-foreground">Show Columns:</span>
						{availableStatuses.map((column) => {
							const isVisible = visibleColumns.has(column);
							const taskCount = tasks.filter((t) => t.status === column).length;
							return (
								<button
									key={column}
									type="button"
									onClick={() => toggleColumn(column)}
									className={cn(
										"flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors",
										isVisible
											? "bg-primary/10 text-primary dark:bg-primary/20"
											: "bg-muted text-muted-foreground"
									)}
								>
									{isVisible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
									<span className="text-sm font-medium">
										{getColumnLabel(column)} ({taskCount})
									</span>
								</button>
							);
						})}
					</div>
				</div>
			)}

			{/* Kanban Board */}
			<ScrollArea className="flex-1">
				{visibleColumns.size > 0 ? (
					<KanbanProvider
						columns={columns}
						data={kanbanData}
						onDataChange={handleDataChange}
						className="min-h-full pb-4"
					>
						{(column) => {
							const columnClasses = getColumnClasses(column.id as TaskStatus, statusColors);
							const taskCount = kanbanData.filter((item) => item.column === column.id).length;

							return (
								<KanbanBoard
									id={column.id}
									key={column.id}
									className={cn(
										// Desktop: fixed width columns
										"min-w-[320px] max-w-[380px]",
										// Mobile: full width columns
										isMobile && "min-w-0 max-w-none w-full",
										columnClasses.bg,
										columnClasses.border
									)}
								>
									<KanbanHeader className="flex items-center justify-between">
										<span className="font-bold text-sm uppercase tracking-wide text-foreground">
											{column.name}
										</span>
										<span className="text-xs rounded-full px-2 py-1 font-medium text-muted-foreground bg-background">
											{taskCount}
										</span>
									</KanbanHeader>
									<KanbanCards<KanbanTaskItem> id={column.id}>
										{(item) => (
											<TaskKanbanCard
												key={item.id}
												item={item}
												statusColors={statusColors}
												onClick={() => handleTaskClick(item.task)}
											/>
										)}
									</KanbanCards>
								</KanbanBoard>
							);
						}}
					</KanbanProvider>
				) : (
					<div className="text-center py-12">
						<p className="text-lg text-muted-foreground">
							No columns visible. Please select at least one column to display.
						</p>
					</div>
				)}
				<ScrollBar orientation="horizontal" />
			</ScrollArea>

			<TaskDetailSheet
				task={selectedTask}
				allTasks={tasks}
				onClose={handleModalClose}
				onUpdate={handleTaskUpdate}
				onArchive={handleArchive}
				onNavigateToTask={handleNavigateToTask}
			/>
		</div>
	);
}

// Task card content component for KanbanCard
interface TaskKanbanCardProps {
	item: KanbanTaskItem;
	statusColors: Record<string, ColorName>;
	onClick: () => void;
}

function TaskKanbanCard({ item, statusColors, onClick }: TaskKanbanCardProps) {
	const { task } = item;
	const statusBadgeClasses = getStatusBadgeClasses(task.status, statusColors);
	const completedAC = task.acceptanceCriteria.filter((ac) => ac.completed).length;
	const totalAC = task.acceptanceCriteria.length;

	return (
		<KanbanCard
			id={item.id}
			name={item.name}
			column={item.column}
			className="w-full"
		>
			<div
				onClick={onClick}
				onKeyDown={(e) => e.key === "Enter" && onClick()}
				role="button"
				tabIndex={0}
				className="cursor-pointer"
			>
				<div className="flex items-center justify-between gap-2 mb-1">
					<span className="text-xs font-mono shrink-0 text-muted-foreground">
						#{task.id}
					</span>
					<div className="flex items-center gap-1 flex-wrap justify-end">
						<span className={cn("text-xs px-1.5 py-0.5 rounded font-medium", statusBadgeClasses)}>
							{getColumnLabel(task.status)}
						</span>
						{task.priority === "high" && (
							<span className="text-xs px-1.5 py-0.5 rounded font-medium bg-destructive/10 text-destructive dark:bg-destructive/20">
								HIGH
							</span>
						)}
						{task.priority === "medium" && (
							<span className="text-xs px-1.5 py-0.5 rounded font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
								MED
							</span>
						)}
					</div>
				</div>

				<h3 className="font-medium text-sm mb-2 line-clamp-2 text-foreground">
					{task.title}
				</h3>

				{totalAC > 0 && (
					<div className="flex items-center gap-2 text-xs mb-2 text-muted-foreground">
						<ClipboardList className="w-3 h-3" aria-hidden="true" />
						<span>
							{completedAC}/{totalAC}
						</span>
					</div>
				)}

				{task.labels.length > 0 && (
					<div className="flex flex-wrap gap-1 mb-2">
						{task.labels.map((label) => (
							<span
								key={label}
								className="text-xs px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground"
							>
								{label}
							</span>
						))}
					</div>
				)}

				{task.assignee && (
					<div className="flex items-center gap-1.5 text-xs mt-2 text-muted-foreground">
						<Avatar name={task.assignee} size="sm" />
						<span>{task.assignee}</span>
					</div>
				)}
			</div>
		</KanbanCard>
	);
}
