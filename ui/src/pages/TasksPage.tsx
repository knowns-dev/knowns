import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutList, LayoutGrid, ListTodo, ArchiveRestore, Archive, ChevronDown, Columns3, Layers, Plus, UserX, Users } from "lucide-react";
import { Avatar as KnAvatar } from "@/ui/components/ui/knowns/avatar";
import { Combobox, type ComboboxOption } from "@/ui/components/ui/knowns/combobox";
import { Select as KnSelect } from "@/ui/components/ui/knowns/select";
import type { Task } from "@/ui/models/task";
import { navigateTo } from "../lib/navigation";
import { Board } from "../components/organisms";
import { TaskDetailSheet } from "../components/organisms/TaskDetail/TaskDetailSheet";
import { TaskGroupedView } from "./TasksPage/TaskGroupedView";
import { TaskListView } from "./TasksPage/TaskListView";
import {
	ALL_ASSIGNEES,
	assigneeLabel,
	filterTasksByAssignee,
	groupTasksByAssignee,
	UNASSIGNED,
} from "./TasksPage/assignees";
import { mergeTaskSubset } from "./TasksPage/mergeTasks";
import { Button } from "../components/ui/button";
import { Menu } from "@/ui/components/ui/knowns/menu";
import { api, LifecycleAPIError } from "../api/client";
import type { TaskLifecycleResponse } from "../models/taskLifecycle";
import { TaskLifecycleDialog } from "../components/organisms/TaskLifecycleDialog";
import { toast } from "../components/ui/sonner";
import { useSSEEvent } from "../contexts/SSEContext";
import {
	PageContent,
	PageError,
	PageLoading,
	PageShell,
} from "../components/templates/PageShell";
import { FeatureHeader } from "../components/templates";
import { NoRuns } from "@/ui/components/ui/knowns/illustrations/empty-states";

// Time duration options for batch archive (in milliseconds)
// Label used when the archive preview comes from selected rows, not an age window.
const SELECTED_ARCHIVE_LABEL = "the selected rows";

const BATCH_ARCHIVE_OPTIONS = [
	{ label: "now", value: 0 },
	{ label: "1 hour ago", value: 1 * 60 * 60 * 1000 },
	{ label: "1 day ago", value: 24 * 60 * 60 * 1000 },
	{ label: "1 week ago", value: 7 * 24 * 60 * 60 * 1000 },
	{ label: "1 month ago", value: 30 * 24 * 60 * 60 * 1000 },
	{ label: "3 months ago", value: 90 * 24 * 60 * 60 * 1000 },
];

interface TasksPageProps {
	tasks: Task[];
	loading: boolean;
	error?: string | null;
	onRetry?: () => void;
	onTasksUpdate: () => void;
	/** Board drag-and-drop replaces the whole task set, so it needs the list form. */
	onTasksReplace?: (tasks: Task[]) => void;
	selectedTask?: Task | null;
	onTaskClose?: () => void;
	onNewTask: () => void;
	/** Forces a view on mount, e.g. the /kanban route pins the Board. */
	initialView?: ViewMode;
	/** Route the detail URL is nested under, so /kanban keeps its own path. */
	detailBasePath?: "/tasks" | "/kanban";
}

type ViewMode = "board" | "list" | "grouped";

const VIEW_STORAGE_KEY = "knowns.tasks.view";

const LIFECYCLE_OPTIONS = [
	{ value: "current", label: "Current (active + done)" },
	{ value: "active", label: "Active" },
	{ value: "done", label: "Done" },
	{ value: "archived", label: "Archived" },
	{ value: "all", label: "All lifecycle states" },
];

const VIEW_OPTIONS: { value: ViewMode; label: string; icon: typeof LayoutList }[] = [
	{ value: "board", label: "Board", icon: Columns3 },
	{ value: "list", label: "List", icon: LayoutList },
	{ value: "grouped", label: "Grouped", icon: LayoutGrid },
];

function isViewMode(value: unknown): value is ViewMode {
	return VIEW_OPTIONS.some((option) => option.value === value);
}

export default function TasksPage({
	tasks,
	loading,
	error,
	onRetry,
	onTasksUpdate,
	onTasksReplace,
	selectedTask: externalSelectedTask,
	onTaskClose,
	onNewTask,
	initialView,
	detailBasePath = "/tasks",
}: TasksPageProps) {
	const [viewMode, setViewMode] = useState<ViewMode>(() => {
		if (initialView) return initialView;
		const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(VIEW_STORAGE_KEY);
		return isViewMode(stored) ? stored : "list";
	});

	const selectView = useCallback((next: ViewMode) => {
		setViewMode(next);
		try {
			localStorage.setItem(VIEW_STORAGE_KEY, next);
		} catch {
			// Private mode or storage disabled: the choice just won't persist.
		}
	}, []);
	const [selectedTask, setSelectedTask] = useState<Task | null>(null);
	const [lifecycleFilter, setLifecycleFilter] = useState<"current" | "active" | "done" | "archived" | "all">("current");
	const [assigneeFilter, setAssigneeFilter] = useState<string>(ALL_ASSIGNEES);
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
	const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
	const [archiveResponse, setArchiveResponse] = useState<TaskLifecycleResponse | null>(null);
	const [archiveError, setArchiveError] = useState<string | null>(null);
	const [archiveLoading, setArchiveLoading] = useState(false);
	const [archiveRequest, setArchiveRequest] = useState<{ generation: number; minimumAgeMs: number; label: string; ids?: readonly string[] } | null>(null);
	const archiveGenerationRef = useRef(0);
	const archiveInFlightRef = useRef(false);
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

	const lifecycleTasks = useMemo(() => {
		switch (lifecycleFilter) {
			case "active": return taskSource.filter((task) => task.lifecycleState === "active");
			case "done": return taskSource.filter((task) => task.lifecycleState === "done");
			case "archived": return taskSource.filter((task) => task.lifecycleState === "archived");
			case "all": return taskSource;
			default: return taskSource.filter((task) => task.lifecycleState !== "archived");
		}
	}, [taskSource, lifecycleFilter]);

	// Counts follow the lifecycle filter so each option says how many Tasks picking it shows.
	const assigneeGroups = useMemo(() => groupTasksByAssignee(lifecycleTasks), [lifecycleTasks]);
	const assigneeOptions = useMemo<ComboboxOption[]>(() => {
		const count = (n: number) => `${n} ${n === 1 ? "task" : "tasks"}`;
		const person = (key: string, n: number): ComboboxOption =>
			key === UNASSIGNED
				? { value: key, label: assigneeLabel(key), supportingText: count(n), icon: <UserX className="h-3.5 w-3.5" /> }
				: {
						value: key,
						label: assigneeLabel(key),
						supportingText: count(n),
						avatar: <KnAvatar label={assigneeLabel(key).replace(/^@/, "")} size="xs" shape="circle" decorative />,
					};
		return [
			{ value: ALL_ASSIGNEES, label: "All assignees", supportingText: count(lifecycleTasks.length), icon: <Users className="h-3.5 w-3.5" /> },
			// Keep a picked person listed at 0 when the lifecycle filter empties them.
			...(assigneeFilter !== ALL_ASSIGNEES && !assigneeGroups.some((group) => group.key === assigneeFilter)
				? [person(assigneeFilter, 0)]
				: []),
			...assigneeGroups.map((group) => person(group.key, group.tasks.length)),
		];
	}, [assigneeGroups, assigneeFilter, lifecycleTasks.length]);

	const visibleTasks = useMemo(
		() => filterTasksByAssignee(lifecycleTasks, assigneeFilter),
		[lifecycleTasks, assigneeFilter],
	);

	// The Board hands back the subset it was given; merge it so filtered-out Tasks
	// are not dropped from the app's Task set. A historical Board shows archived
	// Tasks too: only update known ids and reload the historical list it reads.
	const replaceBoardTasks = useCallback((updated: Task[]) => {
		if (onTasksReplace) onTasksReplace(mergeTaskSubset(tasks, updated, { appendNew: !historicalMode }));
		else onTasksUpdate();
		if (historicalMode) void loadHistorical();
	}, [tasks, onTasksReplace, onTasksUpdate, historicalMode, loadHistorical]);

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

	const reconcileTasks = async () => {
		const current = await api.getTasks();
		if (onTasksReplace) onTasksReplace(current);
		else onTasksUpdate();
	};

	const handleBatchArchivePreview = async (minimumAgeMs: number, label: string, selectedIds?: readonly string[]) => {
		const generation = ++archiveGenerationRef.current;
		setArchiveRequest({ generation, minimumAgeMs, label });
		setArchiveDialogOpen(true);
		setArchiveResponse(null);
		setArchiveError(null);
		setArchiveLoading(true);
		try {
			const response = await api.batchArchiveTasks({ minimumAgeMs, ids: selectedIds ? [...selectedIds] : undefined });
			if (archiveGenerationRef.current !== generation) return;
			setArchiveRequest({ generation, minimumAgeMs, label, ids: Object.freeze(response.items.map((item) => item.taskId)) });
			setArchiveResponse(response);
		} catch (error) {
			if (archiveGenerationRef.current !== generation) return;
			const response = error instanceof LifecycleAPIError ? error.response || null : null;
			if (response) {
				setArchiveRequest({ generation, minimumAgeMs, label, ids: Object.freeze(response.items.map((item) => item.taskId)) });
			}
			setArchiveResponse(response);
			setArchiveError(error instanceof Error ? error.message : "Failed to preview archive");
		} finally {
			if (archiveGenerationRef.current === generation) setArchiveLoading(false);
		}
	};

	const handleBatchArchiveExecute = async () => {
		if (!archiveRequest?.ids || archiveInFlightRef.current) return;
		const { generation, minimumAgeMs, ids } = archiveRequest;
		archiveInFlightRef.current = true;
		setArchiveLoading(true);
		setArchiveError(null);
		try {
			const response = await api.batchArchiveTasks({ ids: [...ids], minimumAgeMs, execute: true });
			if (archiveGenerationRef.current !== generation) return;
			setArchiveResponse(response);
			await reconcileTasks();
			if (!response.failedTaskId) {
				toast.success(`Archived ${response.changed} task${response.changed === 1 ? "" : "s"}`);
			}
		} catch (error) {
			if (archiveGenerationRef.current === generation) {
				if (error instanceof LifecycleAPIError && error.response) setArchiveResponse(error.response);
				setArchiveError(error instanceof Error ? error.message : "Failed to archive Tasks");
			}
			await reconcileTasks().catch(() => {});
		} finally {
			archiveInFlightRef.current = false;
			if (archiveGenerationRef.current === generation) setArchiveLoading(false);
		}
	};

	const closeArchiveDialog = (open: boolean) => {
		if (open) return setArchiveDialogOpen(true);
		++archiveGenerationRef.current;
		setArchiveDialogOpen(false);
		setArchiveRequest(null);
		setArchiveResponse(null);
		setArchiveError(null);
	};

	// Handle external selected task from search
	useEffect(() => {
		setSelectedTask(externalSelectedTask || null);
	}, [externalSelectedTask]);

	const handleTaskClick = (task: Task) => {
		navigateTo(`${detailBasePath}/${task.id}`);
	};

	const handleNavigateToTask = (taskId: string) => {
		navigateTo(`${detailBasePath}/${taskId}`);
	};

	const refreshVisibleData = () => {
		onTasksUpdate();
		if (historicalMode) void loadHistorical();
	};

	return (
		<PageShell>
			<FeatureHeader
				icon={ListTodo}
				title="Tasks"
				status={
					<span className="tabular-nums">
						{visibleTasks.length} {visibleTasks.length === 1 ? "task" : "tasks"}
					</span>
				}
				actions={
					<div className="flex flex-wrap items-center gap-2">
						<KnSelect
							id="task-lifecycle-filter"
							aria-label="Show tasks"
							size="sm"
							icon={<Layers className="h-3.5 w-3.5" />}
							value={lifecycleFilter}
							onChange={(event) => setLifecycleFilter(event.target.value as typeof lifecycleFilter)}
							options={LIFECYCLE_OPTIONS}
							className="w-full min-w-44 sm:w-auto"
						/>
						<Combobox
							id="task-assignee-filter"
							aria-label="Assignee"
							size="sm"
							searchable
							value={assigneeFilter}
							onValueChange={setAssigneeFilter}
							options={assigneeOptions}
							className="w-full min-w-56 sm:w-auto"
						/>
						{archivedIDs.length > 0 && (lifecycleFilter === "archived" || lifecycleFilter === "all") && (
							<Button variant="outline" size="sm" onClick={previewRestore} className="h-11 gap-1.5 sm:h-8">
								<ArchiveRestore className="h-3.5 w-3.5" /> Restore archived…
							</Button>
						)}
						{/* Batch Archive Dropdown */}
						<Menu
							aria-label="Archive completed Tasks"
							align="end"
							items={BATCH_ARCHIVE_OPTIONS.map((option) => ({ id: String(option.value), label: `Done before ${option.label}` }))}
							onSelect={(item) => {
								const option = BATCH_ARCHIVE_OPTIONS.find((o) => String(o.value) === item.id);
								if (option) handleBatchArchivePreview(option.value, option.label);
							}}
							trigger={
								<Button
									variant="outline"
									size="sm"
									aria-label="Archive completed Tasks"
									className="h-11 gap-1.5 sm:h-8"
								>
									<Archive className="w-4 h-4" />
									<span className="hidden sm:inline text-sm">Archive</span>
									<ChevronDown className="w-3 h-3" />
								</Button>
							}
						/>
						{/* View Toggle */}
						<div className="flex items-center rounded-md bg-muted/70 p-0.5" aria-label="Task view">
							{VIEW_OPTIONS.map((option) => {
								const Icon = option.icon;
								const active = viewMode === option.value;
								return (
									<Button
										key={option.value}
										type="button"
										variant="ghost"
										size="sm"
										aria-label={`${option.label} view`}
										aria-pressed={active}
										onClick={() => selectView(option.value)}
										className={active ? "h-10 bg-background px-2 shadow-sm hover:bg-background sm:h-7" : "h-10 px-2 text-muted-foreground sm:h-7"}
									>
										<Icon className="h-3.5 w-3.5" />
										<span className="hidden sm:inline">{option.label}</span>
									</Button>
								);
							})}
						</div>
						{/* Lives in the header so every view can create a Task: the Board and
						    Table views have no empty-state "New" affordance of their own. */}
						<Button size="sm" onClick={onNewTask} className="h-11 gap-1.5 sm:h-8">
							<Plus className="h-3.5 w-3.5" /> New Task
						</Button>
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
				) : taskSource.length === 0 && !historicalMode && viewMode !== "board" ? (
					// The board keeps its empty columns (they are drop targets); the header owns "New Task".
					<div className="flex flex-1 items-center justify-center" data-testid="tasks-empty">
						<NoRuns title="No Tasks yet" description="Create the first Task with New Task, or let an agent create one over MCP." />
					</div>
				) : viewMode === "board" ? (
					<Board
						tasks={visibleTasks}
						onTasksUpdate={replaceBoardTasks}
						onTaskClick={handleTaskClick}
					/>
				) : viewMode === "list" ? (
					<TaskListView
						tasks={visibleTasks}
						onTaskClick={handleTaskClick}
						onArchiveSelected={(ids) => void handleBatchArchivePreview(0, SELECTED_ARCHIVE_LABEL, ids)}
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

			<TaskLifecycleDialog
				open={archiveDialogOpen}
				onOpenChange={closeArchiveDialog}
				title="Archive completed Tasks"
				description={archiveRequest?.label === SELECTED_ARCHIVE_LABEL ? "Preview for the Tasks you selected. Eligibility and warnings come from the backend." : `Preview for Tasks completed before ${archiveRequest?.label || "the selected retention window"}. Eligibility and warnings come from the backend.`}
				response={archiveResponse}
				loading={archiveLoading}
				error={archiveError}
				confirmLabel="Archive eligible Tasks"
				onConfirm={handleBatchArchiveExecute}
			/>
		</PageShell>
	);
}
