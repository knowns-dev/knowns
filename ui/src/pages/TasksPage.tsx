import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutList, LayoutGrid, ArchiveRestore } from "lucide-react";
import type { Task } from "@/ui/models/task";
import { navigateTo } from "../lib/navigation";
import { TaskNotionList } from "../components/organisms";
import { TaskDetailSheet } from "../components/organisms/TaskDetail/TaskDetailSheet";
import { TaskGroupedView } from "./TasksPage/TaskGroupedView";
import { Button } from "../components/ui/button";
import { api, LifecycleAPIError } from "../api/client";
import type { TaskLifecycleResponse } from "../models/taskLifecycle";
import { TaskLifecycleDialog } from "../components/organisms/TaskLifecycleDialog";
import { toast } from "../components/ui/sonner";
import { useSSEEvent } from "../contexts/SSEContext";
import {
	PageContent,
	PageError,
	PageHeader,
	PageLoading,
	PageShell,
} from "../components/templates/PageShell";

interface TasksPageProps {
	tasks: Task[];
	loading: boolean;
	error?: string | null;
	onRetry?: () => void;
	onTasksUpdate: () => void;
	selectedTask?: Task | null;
	onTaskClose?: () => void;
	onNewTask: () => void;
}

type ViewMode = "table" | "grouped";

export default function TasksPage({
	tasks,
	loading,
	error,
	onRetry,
	onTasksUpdate,
	selectedTask: externalSelectedTask,
	onTaskClose,
	onNewTask,
}: TasksPageProps) {
	const [viewMode, setViewMode] = useState<ViewMode>("table");
	const [selectedTask, setSelectedTask] = useState<Task | null>(null);
	const [lifecycleFilter, setLifecycleFilter] = useState<"current" | "active" | "done" | "archived" | "all">("current");
	const [restoreOpen, setRestoreOpen] = useState(false);
	const [restoreResponse, setRestoreResponse] = useState<TaskLifecycleResponse | null>(null);
	const [restoreError, setRestoreError] = useState<string | null>(null);
	const [restoreLoading, setRestoreLoading] = useState(false);
	const [historicalTasks, setHistoricalTasks] = useState<Task[] | null>(null);
	const [historicalLoading, setHistoricalLoading] = useState(false);
	const historicalRequestRef = useRef<{ generation: number; controller?: AbortController }>({ generation: 0 });
	const restoreGenerationRef = useRef(0);
	const restoreInFlightRef = useRef(false);
	const [restoreScope, setRestoreScope] = useState<{ generation: number; ids: readonly string[] } | null>(null);
	const historicalMode = lifecycleFilter === "archived" || lifecycleFilter === "all";

	const loadHistorical = useCallback(async () => {
		historicalRequestRef.current.controller?.abort();
		const controller = new AbortController();
		const generation = historicalRequestRef.current.generation + 1;
		historicalRequestRef.current = { generation, controller };
		setHistoricalLoading(true);
		try {
			const data = await api.getTasks({ includeHistorical: true, signal: controller.signal });
			if (historicalRequestRef.current.generation === generation) setHistoricalTasks(data);
		} catch (error) {
			if (!(error instanceof DOMException && error.name === "AbortError")) {
				toast.error(error instanceof Error ? error.message : "Failed to load historical Tasks");
			}
		} finally {
			if (historicalRequestRef.current.generation === generation) setHistoricalLoading(false);
		}
	}, []);

	useEffect(() => {
		if (historicalMode) {
			void loadHistorical();
			return () => historicalRequestRef.current.controller?.abort();
		}
		historicalRequestRef.current.controller?.abort();
		historicalRequestRef.current = { generation: historicalRequestRef.current.generation + 1 };
		setHistoricalTasks(null);
		setHistoricalLoading(false);
	}, [historicalMode, loadHistorical]);

	const invalidateHistorical = useCallback(() => {
		if (historicalMode) void loadHistorical();
	}, [historicalMode, loadHistorical]);

	useSSEEvent("tasks:refresh", invalidateHistorical, [invalidateHistorical]);
	useSSEEvent("tasks:updated", invalidateHistorical, [invalidateHistorical]);
	useSSEEvent("tasks:archived", invalidateHistorical, [invalidateHistorical]);
	useSSEEvent("tasks:unarchived", invalidateHistorical, [invalidateHistorical]);
	useSSEEvent("tasks:batch-archived", invalidateHistorical, [invalidateHistorical]);

	const taskSource = historicalMode ? historicalTasks || [] : tasks;

	const visibleTasks = useMemo(() => {
		switch (lifecycleFilter) {
			case "active": return taskSource.filter((task) => task.lifecycleState === "active");
			case "done": return taskSource.filter((task) => task.lifecycleState === "done");
			case "archived": return taskSource.filter((task) => task.lifecycleState === "archived");
			case "all": return taskSource;
			default: return taskSource.filter((task) => task.lifecycleState !== "archived");
		}
	}, [taskSource, lifecycleFilter]);

	const archivedIDs = useMemo(
		() => taskSource.filter((task) => task.lifecycleState === "archived").map((task) => task.id),
		[taskSource],
	);

	const previewRestore = async () => {
		const requestedIDs = [...archivedIDs];
		const generation = ++restoreGenerationRef.current;
		setRestoreOpen(true);
		setRestoreScope(null);
		setRestoreResponse(null);
		setRestoreError(null);
		setRestoreLoading(true);
		try {
			const response = await api.batchUnarchiveTasks(requestedIDs, false);
			if (restoreGenerationRef.current !== generation) return;
			setRestoreScope({ generation, ids: Object.freeze(requestedIDs) });
			setRestoreResponse(response);
		} catch (error) {
			if (restoreGenerationRef.current !== generation) return;
			const response = error instanceof LifecycleAPIError ? error.response || null : null;
			if (response) setRestoreScope({ generation, ids: Object.freeze(requestedIDs) });
			setRestoreResponse(response);
			setRestoreError(error instanceof Error ? error.message : "Failed to preview restore");
		} finally {
			if (restoreGenerationRef.current === generation) setRestoreLoading(false);
		}
	};

	const executeRestore = async () => {
		if (!restoreScope || restoreInFlightRef.current) return;
		const { ids, generation } = restoreScope;
		restoreInFlightRef.current = true;
		setRestoreLoading(true);
		setRestoreError(null);
		try {
			const response = await api.batchUnarchiveTasks([...ids], true);
			if (restoreGenerationRef.current !== generation) return;
			setRestoreResponse(response);
			onTasksUpdate();
			await loadHistorical();
			if (!response.failedTaskId) toast.success(`Restored ${response.changed} task${response.changed === 1 ? "" : "s"}`);
		} catch (error) {
			if (restoreGenerationRef.current === generation) {
				if (error instanceof LifecycleAPIError) setRestoreResponse(error.response || null);
				setRestoreError(error instanceof Error ? error.message : "Failed to restore Tasks");
			}
			onTasksUpdate();
			await loadHistorical().catch(() => {});
		} finally {
			restoreInFlightRef.current = false;
			if (restoreGenerationRef.current === generation) setRestoreLoading(false);
		}
	};

	const closeRestore = (open: boolean) => {
		if (open) return setRestoreOpen(true);
		++restoreGenerationRef.current;
		setRestoreOpen(false);
		setRestoreScope(null);
		setRestoreResponse(null);
		setRestoreError(null);
	};

	// Handle external selected task from search
	useEffect(() => {
		setSelectedTask(externalSelectedTask || null);
	}, [externalSelectedTask]);

	const handleTaskClick = (task: Task) => {
		navigateTo(`/tasks/${task.id}`);
	};

	const handleNavigateToTask = (taskId: string) => {
		navigateTo(`/tasks/${taskId}`);
	};

	const refreshVisibleData = () => {
		onTasksUpdate();
		if (historicalMode) void loadHistorical();
	};

	return (
		<PageShell>
			<PageHeader
				title="Tasks"
				description="Plan, review, and recover project work across its lifecycle."
				context="Project work"
				status={
					<span className="tabular-nums">
						{visibleTasks.length} {visibleTasks.length === 1 ? "task" : "tasks"}
					</span>
				}
				actions={
					<div className="flex flex-wrap items-center gap-2">
						<label className="sr-only" htmlFor="task-lifecycle-filter">Lifecycle</label>
						<select
							id="task-lifecycle-filter"
							value={lifecycleFilter}
							onChange={(event) => setLifecycleFilter(event.target.value as typeof lifecycleFilter)}
							className="h-11 max-w-full rounded-md border bg-background px-2 text-xs sm:h-8"
						>
							<option value="current">Current (active + done)</option>
							<option value="active">Active</option>
							<option value="done">Done</option>
							<option value="archived">Archived</option>
							<option value="all">All lifecycle states</option>
						</select>
						{archivedIDs.length > 0 && (lifecycleFilter === "archived" || lifecycleFilter === "all") && (
							<Button variant="outline" size="sm" onClick={previewRestore} className="h-11 gap-1.5 sm:h-8">
								<ArchiveRestore className="h-3.5 w-3.5" /> Restore archived…
							</Button>
						)}
						{/* View Toggle */}
						<div className="flex items-center rounded-md bg-muted/70 p-0.5" aria-label="Task view">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								aria-label="Table view"
								aria-pressed={viewMode === "table"}
								onClick={() => setViewMode("table")}
								className={viewMode === "table" ? "h-10 bg-background px-2 shadow-sm hover:bg-background sm:h-7" : "h-10 px-2 text-muted-foreground sm:h-7"}
							>
								<LayoutList className="h-3.5 w-3.5" />
								<span className="hidden sm:inline">Table</span>
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								aria-label="Grouped view"
								aria-pressed={viewMode === "grouped"}
								onClick={() => setViewMode("grouped")}
								className={viewMode === "grouped" ? "h-10 bg-background px-2 shadow-sm hover:bg-background sm:h-7" : "h-10 px-2 text-muted-foreground sm:h-7"}
							>
								<LayoutGrid className="h-3.5 w-3.5" />
								<span className="hidden sm:inline">Grouped</span>
							</Button>
						</div>
					</div>
				}
			/>

			<PageContent size="full" className="flex min-h-0 flex-1 flex-col overflow-hidden py-5">
				{loading ? (
					<PageLoading label="Loading Tasks" className="flex-1" />
				) : error && taskSource.length === 0 ? (
					<PageError
						description={error}
						onRetry={onRetry}
						className="flex-1"
					/>
				) : historicalMode && historicalLoading && historicalTasks === null ? (
					<PageLoading label="Loading historical Tasks" className="flex-1" />
				) : viewMode === "table" ? (
					<TaskNotionList
						tasks={visibleTasks}
						onTaskClick={handleTaskClick}
						onNewTask={onNewTask}
					/>
				) : (
					<TaskGroupedView
						tasks={visibleTasks}
						onTaskClick={handleTaskClick}
						onNewTask={onNewTask}
					/>
				)}
			</PageContent>

			{/* Task Detail Sheet */}
			<TaskDetailSheet
				task={selectedTask}
				allTasks={taskSource}
				onClose={() => {
					setSelectedTask(null);
					if (onTaskClose) onTaskClose();
				}}
				onUpdate={refreshVisibleData}
				onLifecycleChange={refreshVisibleData}
				onNavigateToTask={handleNavigateToTask}
			/>

			<TaskLifecycleDialog
				open={restoreOpen}
				onOpenChange={closeRestore}
				title="Restore archived Tasks"
				description="This preview includes every selected archived Task, backend skip reason, warning, and retention timestamp before any mutation."
				response={restoreResponse}
				loading={restoreLoading}
				error={restoreError}
				confirmLabel="Restore eligible Tasks"
				onConfirm={executeRestore}
			/>
		</PageShell>
	);
}
