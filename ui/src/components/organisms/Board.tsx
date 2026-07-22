import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Eye, EyeOff, ClipboardList, ChevronDown, ChevronUp, FileText } from "lucide-react";
import type { Task, TaskStatus } from "@/ui/models/task";
import { api } from "../../api/client";
import { navigateTo } from "../../lib/navigation";
import { useConfig } from "../../contexts/ConfigContext";
import { useNewTaskIds } from "../../hooks/useNewTaskIds";
import { TaskDetailSheet } from "./TaskDetail/TaskDetailSheet";
import { ScrollArea, ScrollBar } from "../ui/ScrollArea";
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
import { useIsMobile } from "@/ui/hooks/useMobile";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { toast } from "../ui/sonner";
import { TaskLifecycleBadge } from "../molecules/TaskLifecycleBadge";

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
	const location = useRouterState({ select: (state) => state.location });
	const { config, updateConfig } = useConfig();
	const newTaskIds = useNewTaskIds(tasks);
	const [visibleColumns, setVisibleColumns] = useState<Set<TaskStatus>>(new Set());
	const [columnControlsOpen, setColumnControlsOpen] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
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
	const kanbanDataFromTasks: KanbanTaskItem[] = useMemo(() => {
		const sortedTasks = [...tasks].sort((a, b) => {
			const hasOrderA = a.order != null;
			const hasOrderB = b.order != null;

			if (hasOrderA && hasOrderB) {
				return a.order! - b.order!;
			}
			if (hasOrderA) return -1;
			if (hasOrderB) return 1;

			const priorityA = priorityOrder[a.priority] ?? 2;
			const priorityB = priorityOrder[b.priority] ?? 2;
			if (priorityA !== priorityB) {
				return priorityA - priorityB;
			}
			return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
		});

		return sortedTasks.map((task) => ({
			id: task.id,
			name: task.title,
			column: task.status,
			task,
		}));
	}, [tasks]);
	const [kanbanData, setKanbanData] = useState<KanbanTaskItem[]>(kanbanDataFromTasks);

	// Get selected task from URL hash
	const getSelectedTask = (): Task | null => {
		const match = location.pathname.match(/^\/kanban\/([^?]+)/);
		if (!match) return null;

		const taskId = match[1];
		return tasks.find((t) => t.id === taskId) || null;
	};

	const [selectedTask, setSelectedTask] = useState<Task | null>(getSelectedTask());

	// Listen to route changes and tasks updates to update selected task
	useEffect(() => {
		setSelectedTask(getSelectedTask());
	}, [location.pathname, tasks]);

	useEffect(() => {
		if (!isDragging) {
			setKanbanData(kanbanDataFromTasks);
		}
	}, [isDragging, kanbanDataFromTasks]);

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

	// --- Drag-and-drop: refs to defer API calls until drag ends ---
	const lastDropDataRef = useRef<KanbanTaskItem[] | null>(null);
	const preDragTasksRef = useRef<Task[]>([]);
	const tasksRef = useRef(tasks);
	tasksRef.current = tasks;

	const handleDragStart = useCallback(() => {
		setIsDragging(true);
		lastDropDataRef.current = null;
		preDragTasksRef.current = tasksRef.current;
	}, []);

	const flushAfterDrag = useCallback(async () => {
		const newData = lastDropDataRef.current;
		lastDropDataRef.current = null;
		if (!newData) {
			setIsDragging(false);
			return;
		}

		const currentTasks = tasksRef.current;
		// Compare against pre-drag snapshot to detect changes, since
		// currentTasks may already reflect optimistic updates
		const originalTasks = preDragTasksRef.current;

		// Status changes
		const statusChanges = newData.filter((item) => {
			const orig = originalTasks.find((t) => t.id === item.id);
			return orig && orig.status !== item.column;
		});

		// Order changes - update ALL tasks in each column to ensure consistent ordering
		const orderUpdates: Array<{ id: string; order: number }> = [];
		for (const col of columns) {
			const colItems = newData.filter((item) => item.column === col.id);
			colItems.forEach((item, index) => {
				orderUpdates.push({ id: item.id, order: index });
			});
		}

		// Apply order optimistically
		if (orderUpdates.length > 0) {
			const orderMap = new Map(orderUpdates.map((o) => [o.id, o.order]));
			onTasksUpdate(
				currentTasks.map((task) => {
					const newOrder = orderMap.get(task.id);
					const newItem = newData.find((item) => item.id === task.id);
					const newStatus = newItem && newItem.column !== task.status
						? (newItem.column as TaskStatus)
						: task.status;
					if (newOrder !== undefined || newStatus !== task.status) {
						return { ...task, status: newStatus, ...(newOrder !== undefined ? { order: newOrder } : {}) };
					}
					return task;
				}),
			);
		}

		// Fire API calls — status changes first, then reorder, to avoid
		// race conditions where reorder reads stale status from disk.
		if (statusChanges.length === 0 && orderUpdates.length === 0) {
			setIsDragging(false);
			return;
		}

		try {
			// Apply status changes first (sequentially to avoid file conflicts)
			for (const item of statusChanges) {
				await api.updateTask(item.id, { status: item.column as TaskStatus });
				toast.success("Status updated", {
					description: `#${item.id} moved to ${getColumnLabel(item.column)}`,
				});
			}

			// Then apply order changes
			if (orderUpdates.length > 0) {
				await api.reorderTasks(orderUpdates);
			}
		} catch (error) {
			console.error("Failed to update tasks:", error);
			toast.error("Failed to update", {
				description: error instanceof Error ? error.message : "Unknown error",
			});
			api.getTasks().then(onTasksUpdate).catch(console.error);
		} finally {
			setIsDragging(false);
		}
	}, [columns, onTasksUpdate]);

	const handleDragEnd = useCallback(() => {
		setTimeout(flushAfterDrag, 0);
	}, [flushAfterDrag]);

	const handleDataChange = (newData: KanbanTaskItem[]) => {
		lastDropDataRef.current = newData;
		setKanbanData(newData);
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-muted-foreground">Loading tasks...</div>
			</div>
		);
	}

	const handleTaskClick = (task: Task) => {
		navigateTo(`/kanban/${task.id}`);
	};

	const handleModalClose = () => {
		navigateTo("/kanban");
	};

	const handleTaskUpdate = (updatedTask: Task) => {
		onTasksUpdate(tasks.map((t) => (t.id === updatedTask.id ? updatedTask : t)));
	};

	const handleNavigateToTask = (taskId: string) => {
		navigateTo(`/kanban/${taskId}`);
	};

	return (
		<div className="flex flex-col h-full">
			{/* Column Visibility Controls */}
			{isMobile ? (
				<Collapsible
					open={columnControlsOpen}
					onOpenChange={setColumnControlsOpen}
					className="shrink-0 mb-4"
				>
					<CollapsibleTrigger className="flex items-center justify-between w-full py-2">
						<span className="text-sm text-muted-foreground">
							Columns ({visibleColumns.size}/{availableStatuses.length})
						</span>
						{columnControlsOpen ? (
							<ChevronUp className="w-4 h-4 text-muted-foreground" />
						) : (
							<ChevronDown className="w-4 h-4 text-muted-foreground" />
						)}
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="flex flex-wrap gap-1.5 pt-2">
							{availableStatuses.map((column) => {
								const isVisible = visibleColumns.has(column);
								const taskCount = tasks.filter((t) => t.status === column).length;
								return (
									<button
										key={column}
										type="button"
										onClick={() => toggleColumn(column)}
										className={cn(
											"flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors text-xs",
											isVisible
												? "bg-muted text-foreground"
												: "text-muted-foreground hover:text-foreground"
										)}
									>
										{isVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
										<span>{getColumnLabel(column)} ({taskCount})</span>
									</button>
								);
							})}
						</div>
					</CollapsibleContent>
				</Collapsible>
			) : (
				<div className="shrink-0 mb-4">
					<div className="flex items-center gap-1.5 flex-wrap">
						<span className="text-sm text-muted-foreground mr-1">Columns</span>
						{availableStatuses.map((column) => {
							const isVisible = visibleColumns.has(column);
							const taskCount = tasks.filter((t) => t.status === column).length;
							return (
								<button
									key={column}
									type="button"
									onClick={() => toggleColumn(column)}
									className={cn(
										"flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors text-sm",
										isVisible
											? "bg-muted text-foreground"
											: "text-muted-foreground hover:text-foreground"
									)}
								>
									{isVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
									<span>{getColumnLabel(column)} ({taskCount})</span>
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
						onDragStart={handleDragStart}
						onDragEnd={handleDragEnd}
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
										"min-w-[300px] max-w-[360px]",
										isMobile && "min-w-0 max-w-none w-full",
										columnClasses.bg,
										columnClasses.border
									)}
								>
									<KanbanHeader className="flex items-center justify-between">
										<span className="font-semibold text-sm text-foreground">
											{column.name}
										</span>
										<span className="text-xs text-muted-foreground">
											{taskCount}
										</span>
									</KanbanHeader>
									<KanbanCards<KanbanTaskItem> id={column.id}>
										{(item) => (
											<TaskKanbanCard
												key={item.id}
												item={item}
												isNew={newTaskIds.has(item.id)}
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
						<p className="text-sm text-muted-foreground">
							No columns visible. Select at least one column above.
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
				onLifecycleChange={() => {
					api.getTasks().then(onTasksUpdate).catch(console.error);
				}}
				onNavigateToTask={handleNavigateToTask}
			/>
		</div>
	);
}

// Task card content component for KanbanCard
interface TaskKanbanCardProps {
	item: KanbanTaskItem;
	isNew?: boolean;
	statusColors: Record<string, ColorName>;
	onClick: () => void;
}

function TaskKanbanCard({ item, isNew, statusColors, onClick }: TaskKanbanCardProps) {
	const { task } = item;
	const statusBadgeClasses = getStatusBadgeClasses(task.status, statusColors);
	const ac = task.acceptanceCriteria ?? [];
	const completedAC = ac.filter((a) => a.completed).length;
	const totalAC = ac.length;
	return (
		<KanbanCard
			id={item.id}
			name={item.name}
			column={item.column}
			className={cn("w-full group/card", isNew && "animate-[fade-in-up_0.5s_ease-out]")}
		>
			<div
				onClick={onClick}
				onKeyDown={(e) => e.key === "Enter" && onClick()}
				role="button"
				tabIndex={0}
				className="cursor-pointer"
			>
				<div className="flex items-center justify-between gap-2 mb-1">
					<span className="text-xs font-mono text-muted-foreground">
						#{task.id}
					</span>
					<div className="flex items-center gap-1 flex-wrap justify-end">
						<TaskLifecycleBadge state={task.lifecycleState} />
						{task.priority === "high" && (
							<span className="text-xs text-red-600 dark:text-red-400 font-medium">
								HIGH
							</span>
						)}
						{task.priority === "medium" && (
							<span className="text-xs text-yellow-600 dark:text-yellow-400 font-medium">
								MED
							</span>
						)}
					</div>
				</div>

				<h3 className="font-medium text-sm mb-2 line-clamp-2 text-foreground">
					{task.title}
				</h3>

				{totalAC > 0 && (
					<div className="flex items-center gap-1.5 text-xs mb-2 text-muted-foreground">
						<ClipboardList className="w-3 h-3" aria-hidden="true" />
						<span>
							{completedAC}/{totalAC}
						</span>
					</div>
				)}

				{(task.labels ?? []).length > 0 && (
					<div className="flex flex-wrap gap-1 mb-2">
						{(task.labels ?? []).map((label) => (
							<span
								key={label}
								className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
							>
								{label}
							</span>
						))}
					</div>
				)}

				{/* Spec link */}
				{task.spec && (
					<a
						href={`/docs/${task.spec}`}
						onClick={(e) => e.stopPropagation()}
						className="flex items-center gap-1.5 text-xs mb-2 text-purple-600 dark:text-purple-400 hover:underline"
					>
						<FileText className="w-3 h-3" aria-hidden="true" />
						<span className="truncate">{task.spec.replace(/^specs\//, "")}</span>
					</a>
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
