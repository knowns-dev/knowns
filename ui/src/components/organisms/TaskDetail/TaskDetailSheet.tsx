import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Archive, ArchiveRestore, CheckCircle2, Link2, Maximize2, Minimize2, AtSign, Trash2, X } from "lucide-react";
import { Sheet, SheetContent } from "../../ui/sheet";
import { Dialog, DialogContent, DialogTitle } from "../../ui/dialog";
import { Button } from "@/ui/components/ui/knowns/button";
import { Avatar } from "@/ui/components/ui/knowns/avatar";
import { TabsContent } from "@/ui/components/ui/knowns/tabs";
import { PageHeader, type PageHeaderAction, type PageHeaderMeta } from "@/ui/components/ui/knowns/blocks/page-header";
import { Breadcrumb, type BreadcrumbItem } from "@/ui/components/ui/knowns/breadcrumb";
import { writeClipboard } from "@/ui/lib/knowns/utils";
import type { Task } from "@/ui/models/task";
import { api, LifecycleAPIError, updateTask } from "../../../api/client";
import type { TaskLifecycleResponse } from "../../../models/taskLifecycle";
import { navigateTo } from "../../../lib/navigation";
import { toast } from "../../ui/sonner";
import { useCurrentUser } from "../../../contexts/UserContext";
import { useUIPreferences } from "../../../contexts/UIPreferencesContext";
import { useIsMobile } from "../../../hooks/useMobile";
import { getStatusLabel } from "../../../utils/colors";
import { TaskTitle } from "./TaskTitle";
import { TaskDescription } from "./TaskDescription";
import { TaskAcceptanceCriteria } from "./TaskAcceptanceCriteria";
import { TaskImplementationSection } from "./TaskImplementationSection";
import { TaskSidebar } from "./TaskSidebar";
import { TimeTrackingLogs } from "../../molecules";
import TaskHistoryPanel from "../TaskHistoryPanel";
import { TaskLifecycleDialog } from "../TaskLifecycleDialog";
import { TaskHardDeleteDialog } from "../TaskHardDeleteDialog";
import { useConfig } from "../../../contexts/ConfigContext";
import { formatTracked, priorityOptions, statusTone } from "./types";

interface TaskDetailSheetProps {
	task: Task | null;
	allTasks: Task[];
	onClose: () => void;
	onUpdate: (task: Task) => void;
	onDelete?: (taskId: string) => void;
	onLifecycleChange?: () => void;
	onNavigateToTask?: (taskId: string) => void;
}

interface LifecyclePreviewState {
	taskId: string;
	taskTitle: string;
	operation: "archive" | "unarchive";
	generation: number;
	response: TaskLifecycleResponse | null;
	phase: "preview" | "execute";
}

export function TaskDetailSheet({
	task,
	allTasks,
	onClose,
	onUpdate,
	onDelete,
	onLifecycleChange,
	onNavigateToTask,
}: TaskDetailSheetProps) {
	const { currentUser } = useCurrentUser();
	const { preferences, toggleTaskDetailLayout } = useUIPreferences();
	const [saving, setSaving] = useState(false);
	const isMaximized = preferences.taskDetailLayout === "maximized";
	const isMobile = useIsMobile();
	const { config } = useConfig();
	const contentRef = useRef<HTMLDivElement>(null);
	const [lifecyclePreview, setLifecyclePreview] = useState<LifecyclePreviewState | null>(null);
	const [lifecycleError, setLifecycleError] = useState<string | null>(null);
	const [lifecycleLoading, setLifecycleLoading] = useState(false);
	const lifecycleGenerationRef = useRef(0);
	const lifecycleRequestRef = useRef<AbortController | null>(null);
	const lifecycleInFlightRef = useRef(false);
	const taskIDRef = useRef(task?.id);
	taskIDRef.current = task?.id;
	const [hardDeleteOpen, setHardDeleteOpen] = useState(false);
	const [hardDeleteError, setHardDeleteError] = useState<string | null>(null);

	useEffect(() => {
		++lifecycleGenerationRef.current;
		lifecycleRequestRef.current?.abort();
		lifecycleRequestRef.current = null;
		lifecycleInFlightRef.current = false;
		setLifecyclePreview(null);
		setLifecycleError(null);
		setLifecycleLoading(false);
		setHardDeleteOpen(false);
		setHardDeleteError(null);
	}, [task?.id]);
	const handleSave = useCallback(
		async (updates: Partial<Task>) => {
			if (!task) return;
			setSaving(true);
			try {
				const updated = await updateTask(task.id, updates);
				onUpdate(updated);
				toast.success("Task updated", {
					description: `#${task.id} ${task.title}`,
				});
			} catch (error) {
				console.error("Failed to update task:", error);
				toast.error("Failed to update task", {
					description: error instanceof Error ? error.message : "Unknown error",
				});
			} finally {
				setSaving(false);
			}
		},
		[task, onUpdate]
	);

	const reconcileLifecycle = useCallback(async (taskId: string) => {
		try {
			onUpdate(await api.getTask(taskId));
		} catch {
			// Hard-delete intentionally makes direct retrieval fail.
		}
		onLifecycleChange?.();
	}, [onUpdate, onLifecycleChange]);

	const previewLifecycle = useCallback(async (operation: "archive" | "unarchive") => {
		if (!task) return;
		lifecycleRequestRef.current?.abort();
		const controller = new AbortController();
		const generation = ++lifecycleGenerationRef.current;
		const preview: LifecyclePreviewState = { taskId: task.id, taskTitle: task.title, operation, generation, response: null, phase: "preview" };
		lifecycleRequestRef.current = controller;
		setLifecyclePreview(preview);
		setLifecycleError(null);
		setLifecycleLoading(true);
		try {
			const response = operation === "archive"
				? await api.archiveTask(task.id, false, controller.signal)
				: await api.unarchiveTask(task.id, false, undefined, controller.signal);
			if (lifecycleGenerationRef.current === generation && taskIDRef.current === task.id) {
				setLifecyclePreview({ ...preview, response });
			}
		} catch (error) {
			if (lifecycleGenerationRef.current !== generation || taskIDRef.current !== task.id) return;
			if (!(error instanceof DOMException && error.name === "AbortError")) {
				setLifecyclePreview({ ...preview, response: error instanceof LifecycleAPIError ? error.response || null : null });
				setLifecycleError(error instanceof Error ? error.message : "Lifecycle preview failed");
			}
		} finally {
			if (lifecycleGenerationRef.current === generation) setLifecycleLoading(false);
		}
	}, [task]);

	const executeLifecycle = useCallback(async () => {
		const preview = lifecyclePreview;
		if (!preview || taskIDRef.current !== preview.taskId || lifecycleInFlightRef.current) return;
		lifecycleRequestRef.current?.abort();
		const controller = new AbortController();
		const generation = ++lifecycleGenerationRef.current;
		const executing: LifecyclePreviewState = { ...preview, generation, phase: "execute" };
		lifecycleRequestRef.current = controller;
		lifecycleInFlightRef.current = true;
		setLifecyclePreview(executing);
		setLifecycleLoading(true);
		setLifecycleError(null);
		try {
			const response = preview.operation === "archive"
				? await api.archiveTask(preview.taskId, true, controller.signal)
				: await api.unarchiveTask(preview.taskId, true, undefined, controller.signal);
			if (lifecycleGenerationRef.current !== generation || taskIDRef.current !== preview.taskId) return;
			setLifecyclePreview({ ...executing, response });
			await reconcileLifecycle(preview.taskId);
			if (!response.failedTaskId) {
				toast.success(preview.operation === "archive" ? "Task archived" : "Task restored", { description: `#${preview.taskId} ${preview.taskTitle}` });
			}
		} catch (error) {
			if (lifecycleGenerationRef.current === generation && taskIDRef.current === preview.taskId) {
				if (!(error instanceof DOMException && error.name === "AbortError")) {
					setLifecyclePreview({ ...executing, response: error instanceof LifecycleAPIError ? error.response || null : null });
					setLifecycleError(error instanceof Error ? error.message : "Lifecycle operation failed");
				}
				await reconcileLifecycle(preview.taskId);
			}
		} finally {
			lifecycleInFlightRef.current = false;
			if (lifecycleGenerationRef.current === generation) setLifecycleLoading(false);
		}
	}, [lifecyclePreview, reconcileLifecycle]);

	const closeLifecycleDialog = useCallback(() => {
		++lifecycleGenerationRef.current;
		lifecycleRequestRef.current?.abort();
		lifecycleRequestRef.current = null;
		lifecycleInFlightRef.current = false;
		setLifecyclePreview(null);
		setLifecycleError(null);
		setLifecycleLoading(false);
	}, []);

	const executeHardDelete = useCallback(async (reason: string) => {
		if (!task) return;
		setLifecycleLoading(true);
		setHardDeleteError(null);
		try {
			await api.hardDeleteTask(task.id, reason, true);
			setHardDeleteOpen(false);
			toast.success(`Task #${task.id} permanently deleted`);
			onLifecycleChange?.();
			onClose();
		} catch (error) {
			const response = error instanceof LifecycleAPIError ? error.response : undefined;
			const permission = response?.items.some((item) => item.reasons.some((reasonItem) => reasonItem.code === "permission_required"));
			setHardDeleteError(permission ? "Permission required. Your trusted session does not allow permanent Task deletion." : error instanceof Error ? error.message : "Permanent deletion failed");
		} finally {
			setLifecycleLoading(false);
		}
	}, [task, onLifecycleChange, onClose]);

	const [tab, setTab] = useState("overview");
	const scrollRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		setTab("overview");
		scrollRef.current?.scrollTo({ top: 0 });
	}, [task?.id]);

	/** "/kanban" when the detail sits on the board, else "/tasks": the task URLs keep their section. */
	const section = typeof window !== "undefined" && window.location.pathname.startsWith("/kanban") ? "/kanban" : "/tasks";

	const openTask = useCallback(
		(id: string) => {
			if (onNavigateToTask) onNavigateToTask(id);
			else navigateTo(`${section}/${id}`);
		},
		[onNavigateToTask, section],
	);

	// Links inside the detail: task links open in place, section links close, docs leave for the Docs page.
	const handleLinkClick = useCallback(
		(e: React.MouseEvent) => {
			if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
			const anchor = (e.target as HTMLElement).closest("a");
			if (!anchor || !contentRef.current?.contains(anchor)) return;
			const href = anchor.getAttribute("href");
			if (!href) return;

			const taskRoute = href.match(/^\/(?:tasks|kanban)\/([^/?#]+)$/);
			if (taskRoute) {
				e.preventDefault();
				openTask(decodeURIComponent(taskRoute[1] ?? ""));
				return;
			}
			if (href === "/tasks" || href === "/kanban") {
				e.preventDefault();
				onClose();
				return;
			}
			if (href.startsWith("/")) {
				onClose();
				return;
			}
			if (/^task-[\w-]+(\.md)?$/.test(href) || /^\d+(\.md)?$/.test(href)) {
				e.preventDefault();
				openTask(href.replace(/^task-/, "").replace(/\.md$/, ""));
				return;
			}
			if (href.endsWith(".md") || href.includes(".md#")) {
				e.preventDefault();
				navigateTo(`/docs/${href.replace(/^\.\//, "").replace(/^\//, "")}`);
				onClose();
			}
		},
		[onClose, openTask],
	);

	const allTasksById = useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks]);

	if (!task) return null;

	const archived = task.lifecycleState === "archived";
	const canHardDelete = config.capabilities?.taskHardDelete === true;
	const busy = saving || lifecycleLoading;
	const parentTask = task.parent ? allTasksById.get(task.parent) : undefined;
	const ac = task.acceptanceCriteria ?? [];
	const acDone = ac.filter((a) => a.completed).length;
	const sessions = (task.timeEntries ?? []).filter((e) => e.endedAt).length;

	const breadcrumbs: BreadcrumbItem[] = [
		{ label: section === "/kanban" ? "Board" : "Tasks", href: section },
		...(parentTask ? [{ label: `#${parentTask.id}`, href: `${section}/${parentTask.id}` }] : []),
		{ label: `#${task.id}` },
	];

	const updated = new Date(task.updatedAt);
	const created = new Date(task.createdAt);
	const meta: PageHeaderMeta[] = [
		{
			id: "assignee",
			content: task.assignee ? (
				<span className="inline-flex items-center gap-1.5">
					<Avatar label={task.assignee.replace(/^@/, "")} size="xs" shape="circle" decorative />
					{task.assignee}
				</span>
			) : (
				<span className="text-muted-foreground">Unassigned</span>
			),
		},
		{ id: "priority", label: "Priority", content: priorityOptions.find((p) => p.value === task.priority)?.label ?? task.priority },
		...(task.timeSpent > 0 ? [{ id: "tracked", label: "Tracked", content: <span className="tabular-nums">{formatTracked(task.timeSpent)}</span> }] : []),
		{
			id: "created",
			label: "Created",
			content: (
				<time dateTime={created.toISOString()} title={created.toLocaleString()}>
					{created.toLocaleDateString(undefined, { month: "short", day: "numeric", year: created.getFullYear() === new Date().getFullYear() ? undefined : "numeric" })}
				</time>
			),
		},
		{
			id: "updated",
			label: "Updated",
			content: (
				<time dateTime={updated.toISOString()} title={updated.toLocaleString()}>
					{updated.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
				</time>
			),
		},
	];

	const primaryAction: PageHeaderAction | undefined = archived
		? { id: "restore", label: "Restore Task", icon: <ArchiveRestore />, disabled: busy, onSelect: () => previewLifecycle("unarchive") }
		: task.status !== "done"
			? { id: "done", label: "Mark as Done", icon: <CheckCircle2 />, disabled: busy, onSelect: () => handleSave({ status: "done" }) }
			: undefined;

	const archiveAction: PageHeaderAction[] = archived
		? []
		: [{ id: "archive", label: "Archive Task", icon: <Archive />, disabled: busy, onSelect: () => previewLifecycle("archive") }];
	// Phones: only the primary action sits beside the title; the rest live in the overflow menu.
	const actions = isMobile ? [] : archiveAction;

	const copy = (text: string, done: string) => async () => {
		try {
			await writeClipboard(text);
			toast.success(done);
		} catch {
			toast.error("Could not copy to the clipboard");
		}
		return done;
	};
	const moreActions: PageHeaderAction[] = [
		...(isMobile ? archiveAction : []),
		{ id: "copy-link", label: "Copy link", icon: <Link2 />, onSelect: copy(`${window.location.origin}${section}/${task.id}`, "Link copied") },
		{ id: "copy-ref", label: "Copy reference", icon: <AtSign />, onSelect: copy(`@task-${task.id}`, "Reference copied") },
		...(canHardDelete
			? [
					{
						id: "hard-delete",
						label: "Permanently delete…",
						icon: <Trash2 />,
						danger: true,
						disabled: busy,
						onSelect: () => {
							setHardDeleteError(null);
							setHardDeleteOpen(true);
						},
					},
				]
			: []),
		...(onDelete
			? [
					{
						id: "delete",
						label: "Delete Task",
						icon: <Trash2 />,
						danger: true,
						disabled: busy,
						onSelect: () => {
							if (confirm("Delete this task?")) onDelete(task.id);
						},
					},
				]
			: []),
	];

	const showMaximize = !isMobile;
	const windowControls = (
		<div className="flex flex-none items-center gap-0.5">
			{showMaximize && (
				<Button
					variant="ghost"
					icon={isMaximized ? <Minimize2 /> : <Maximize2 />}
					onClick={toggleTaskDetailLayout}
					aria-label={isMaximized ? "Show as side sheet" : "Expand to full width"}
					title={isMaximized ? "Show as side sheet" : "Expand to full width"}
					className="text-muted-foreground max-md:hidden"
				/>
			)}
			<Button variant="ghost" icon={<X />} onClick={onClose} aria-label="Close" title="Close" className="text-muted-foreground" />
		</div>
	);

	const body = (
		<div ref={contentRef} onClick={handleLinkClick} className="flex h-full min-h-0 flex-col">
			{/* Stays put while the body scrolls, so Close is always one tap away (phones have no Escape). */}
			<div className="flex h-12 flex-none items-center gap-3 px-3 pt-[env(safe-area-inset-top)] sm:h-14 sm:px-6">
				<Breadcrumb items={breadcrumbs} size="sm" separator="slash" aria-label={`Breadcrumb: task ${task.id}`} className="min-w-0 flex-1" />
				{windowControls}
			</div>
			<div
				ref={scrollRef}
				data-autofocus
				tabIndex={-1}
				className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(3rem,env(safe-area-inset-bottom))] outline-none [scrollbar-gutter:stable] sm:px-8"
			>
				<PageHeader
					layout="stacked"
					size="lg"
					className="pt-1"
					title={<TaskTitle task={task} onSave={handleSave} saving={saving} />}
					titleText={task.title}
					status={{ label: getStatusLabel(task.status), tone: statusTone(task.status, (config.statusColors || {}) as Record<string, string>) }}
					meta={meta}
					progress={ac.length > 0 ? { value: acDone, total: ac.length, unit: "criteria", label: "Acceptance criteria done" } : undefined}
					tabs={[
						{ value: "overview", label: "Overview" },
						{ value: "time", label: "Time", count: sessions || undefined },
						{ value: "history", label: "History" },
					]}
					tab={tab}
					onTabChange={setTab}
					primaryAction={primaryAction}
					actions={actions}
					moreActions={moreActions}
					scrollContainer={scrollRef}
				>
					<div className="@container/detail">
						<div className="grid grid-cols-1 gap-x-10 gap-y-10 pt-6 @[760px]/detail:grid-cols-[minmax(0,1fr)_15.5rem]">
							<div className="min-w-0">
								<TabsContent value="overview" className="flex flex-col gap-9">
									<TaskDescription task={task} onSave={handleSave} saving={saving} />
									<TaskAcceptanceCriteria task={task} onSave={handleSave} saving={saving} />
									<TaskImplementationSection task={task} onSave={handleSave} saving={saving} type="plan" />
									<TaskImplementationSection task={task} onSave={handleSave} saving={saving} type="notes" />
								</TabsContent>
								<TabsContent value="time">
									<TimeTrackingLogs taskId={task.id} timeEntries={task.timeEntries ?? []} timeSpent={task.timeSpent} disabled={archived} />
								</TabsContent>
								<TabsContent value="history">
									<TaskHistoryPanel taskId={task.id} />
								</TabsContent>
							</div>
							<aside
								aria-label="Properties"
								className="min-w-0 border-t border-[color-mix(in_srgb,var(--foreground)_9%,transparent)] pt-6 @[760px]/detail:self-start @[760px]/detail:border-t-0 @[760px]/detail:border-l @[760px]/detail:pt-0 @[760px]/detail:pl-6"
							>
								<TaskSidebar
									task={task}
									allTasks={allTasks}
									currentUser={currentUser}
									onSave={handleSave}
									onNavigateToTask={openTask}
									saving={busy}
								/>
							</aside>
						</div>
					</div>
				</PageHeader>
			</div>
		</div>
	);

	const LifecycleDialogs = (
		<>
			<TaskLifecycleDialog
				open={lifecyclePreview !== null}
				onOpenChange={(open) => {
					if (!open) closeLifecycleDialog();
				}}
				title={lifecyclePreview?.operation === "archive" ? `Archive Task #${lifecyclePreview.taskId}` : `Restore Task #${lifecyclePreview?.taskId || task.id}`}
				description="Eligibility, skip reasons, retention deadlines, and durable-knowledge warnings are evaluated by the backend."
				response={lifecyclePreview?.response || null}
				loading={lifecycleLoading}
				error={lifecycleError}
				confirmLabel={lifecyclePreview?.operation === "archive" ? "Archive Task" : "Restore Task"}
				onConfirm={executeLifecycle}
				allowCancelWhileLoading={lifecyclePreview?.phase === "preview"}
			/>
			{canHardDelete && (
				<TaskHardDeleteDialog
					task={task}
					open={hardDeleteOpen}
					onOpenChange={setHardDeleteOpen}
					loading={lifecycleLoading}
					error={hardDeleteError}
					onConfirm={executeHardDelete}
				/>
			)}
		</>
	);

	const label = <DialogTitle className="sr-only">Task details: {task.title}</DialogTitle>;

	// Expanded: a wide centred dialog. Phones always get the full-height sheet.
	if (isMaximized && !isMobile) {
		return (
			<Dialog open={!!task} onOpenChange={(open) => !open && onClose()}>
				<DialogContent className="flex h-[min(92vh,60rem)] w-[min(96vw,76rem)] max-w-none flex-col gap-0 overflow-hidden p-0" hideCloseButton>
					{label}
					{body}
					{LifecycleDialogs}
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<Sheet open={!!task} onOpenChange={(open) => !open && onClose()}>
			<SheetContent
				side="right"
				className="flex h-dvh w-full flex-col gap-0 p-0 max-sm:border-l-0 sm:max-w-3xl xl:max-w-[60rem]"
				hideCloseButton
			>
				{label}
				{body}
				{LifecycleDialogs}
			</SheetContent>
		</Sheet>
	);
}
