import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Maximize2, Minimize2, X } from "lucide-react";
import {
	Sheet,
	SheetContent,
} from "../../ui/sheet";
import {
	Dialog,
	DialogContent,
	DialogTitle,
} from "../../ui/dialog";
import { Button } from "../../ui/button";
import { ScrollArea } from "../../ui/ScrollArea";
import type { Task } from "@/ui/models/task";
import { api, LifecycleAPIError, updateTask } from "../../../api/client";
import type { TaskLifecycleResponse } from "../../../models/taskLifecycle";
import { navigateTo } from "../../../lib/navigation";
import { toast } from "../../ui/sonner";
import { useCurrentUser } from "../../../contexts/UserContext";
import { useUIPreferences } from "../../../contexts/UIPreferencesContext";
import { useIsMobile } from "../../../hooks/useMobile";
import { TaskHeader } from "./TaskHeader";
import { TaskDescription } from "./TaskDescription";
import { TaskAcceptanceCriteria } from "./TaskAcceptanceCriteria";
import { TaskImplementationSection } from "./TaskImplementationSection";
import { TaskSidebar } from "./TaskSidebar";
import { TimeTrackingLogs } from "../../molecules";
import TaskHistoryPanel from "../TaskHistoryPanel";
import { TaskLifecycleDialog } from "../TaskLifecycleDialog";
import { TaskHardDeleteDialog } from "../TaskHardDeleteDialog";
import { useConfig } from "../../../contexts/ConfigContext";

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
	// Animation variants
	const contentVariants = {
		hidden: { opacity: 0, y: 20, scale: 0.98 },
		visible: {
			opacity: 1,
			y: 0,
			scale: 1,
			transition: { duration: 0.2, ease: "easeOut" }
		},
		exit: {
			opacity: 0,
			y: 10,
			scale: 0.98,
			transition: { duration: 0.15, ease: "easeIn" }
		}
	};

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

	// Handle markdown link clicks for internal navigation
	useEffect(() => {
		const handleLinkClick = (e: MouseEvent) => {
			let target = e.target as HTMLElement;

			while (target && target.tagName !== "A" && target !== contentRef.current) {
				target = target.parentElement as HTMLElement;
			}

			if (target && target.tagName === "A") {
				const anchor = target as HTMLAnchorElement;
				const href = anchor.getAttribute("href");

				if (href && href.startsWith("/")) {
					onClose();
					return;
				}

				if (href && /^(task-)?\d+(\.md)?$/.test(href)) {
					e.preventDefault();
					const taskId = href.replace(/^task-/, "").replace(/\.md$/, "");
					navigateTo(`/kanban/${taskId}`);
					onClose();
					return;
				}

				if (href && (href.endsWith(".md") || href.includes(".md#"))) {
					e.preventDefault();
					const normalizedPath = href.replace(/^\.\//, "").replace(/^\//, "");
					navigateTo(`/docs/${normalizedPath}`);
					onClose();
				}
			}
		};

		const contentEl = contentRef.current;
		if (contentEl) {
			contentEl.addEventListener("click", handleLinkClick);
			return () => contentEl.removeEventListener("click", handleLinkClick);
		}
	}, [onClose]);

	if (!task) return null;

	// Header component (shared)
	const Header = (
		<div className="flex items-center justify-between gap-2 px-6 py-4 border-b border-border/40">
			<div className="flex-1 min-w-0">
				<TaskHeader task={task} onSave={handleSave} saving={saving} />
			</div>
			<div className="flex items-center gap-0.5 shrink-0">
				{/* Hide maximize button on mobile - only sheet mode available */}
				{!isMobile && (
					<Button
						variant="ghost"
						size="icon"
						onClick={toggleTaskDetailLayout}
						className="h-8 w-8 text-muted-foreground hover:text-foreground"
						title={isMaximized ? "Minimize" : "Maximize"}
					>
						{isMaximized ? (
							<Minimize2 className="w-4 h-4" />
						) : (
							<Maximize2 className="w-4 h-4" />
						)}
					</Button>
				)}
				<Button
					variant="ghost"
					size="icon"
					onClick={onClose}
					className="h-8 w-8 text-muted-foreground hover:text-foreground"
					title="Close"
				>
					<X className="w-4 h-4" />
				</Button>
			</div>
		</div>
	);

	// Main content section (shared)
	const MainContent = (
		<div className="px-6 py-8 space-y-0">
			<TaskDescription task={task} onSave={handleSave} saving={saving} />

			<div className="border-t border-border/40" />
			<TaskAcceptanceCriteria task={task} onSave={handleSave} saving={saving} />

			<div className="border-t border-border/40" />
			<TaskImplementationSection
				task={task}
				onSave={handleSave}
				saving={saving}
				type="plan"
			/>

			<div className="border-t border-border/40" />
			<TaskImplementationSection
				task={task}
				onSave={handleSave}
				saving={saving}
				type="notes"
			/>

			{/* AI Workspace — normal position when not running */}
			{/* Time Tracking */}
			<div className="border-t border-border/40" />
			<div className="pt-8">
				<TimeTrackingLogs
					taskId={task.id}
					timeEntries={task.timeEntries}
					timeSpent={task.timeSpent}
				/>
			</div>

			{/* History */}
			<div className="border-t border-border/40" />
			<div className="pt-8 pb-4">
				<TaskHistoryPanel taskId={task.id} />
			</div>
		</div>
	);

	// Sidebar component (shared)
	const Sidebar = (
		<TaskSidebar
			task={task}
			allTasks={allTasks}
			currentUser={currentUser}
			onSave={handleSave}
			onDelete={onDelete}
			onArchive={() => previewLifecycle("archive")}
			onUnarchive={() => previewLifecycle("unarchive")}
			onHardDelete={() => {
				setHardDeleteError(null);
				setHardDeleteOpen(true);
			}}
			canHardDelete={config.capabilities?.taskHardDelete === true}
			onNavigateToTask={onNavigateToTask}
			saving={saving || lifecycleLoading}
		/>
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
			{config.capabilities?.taskHardDelete === true && (
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

	// Centered Dialog mode (default) - Sidebar on RIGHT
	// On mobile, always use Sheet mode (no center dialog)
	if (isMaximized && !isMobile) {
		return (
			<AnimatePresence>
				{task && (
					<Dialog open={!!task} onOpenChange={(open) => !open && onClose()}>
						<DialogContent
							className="max-w-6xl w-[95vw] h-[90vh] p-0 gap-0 overflow-hidden flex flex-col"
							hideCloseButton
						>
							<DialogTitle className="sr-only">Task Details: {task.title}</DialogTitle>
							<motion.div
								ref={contentRef}
								className="flex flex-col h-full overflow-hidden"
								variants={contentVariants}
								initial="hidden"
								animate="visible"
								exit="exit"
							>
								{Header}
								<div className="flex-1 flex overflow-hidden">
									{/* Main Content */}
									<ScrollArea className="flex-1">
										{MainContent}
									</ScrollArea>
									{/* Sidebar on right */}
									<div className="shrink-0 w-72 border-l border-border/40 overflow-hidden">
										<ScrollArea className="h-full w-full">
											<div className="p-5 w-full max-w-full overflow-hidden">{Sidebar}</div>
										</ScrollArea>
									</div>
								</div>
							</motion.div>
								{LifecycleDialogs}
							</DialogContent>
					</Dialog>
				)}
			</AnimatePresence>
		);
	}

	// Side Sheet mode - Sidebar on TOP (compact)
	return (
		<AnimatePresence>
			{task && (
				<Sheet open={!!task} onOpenChange={(open) => !open && onClose()}>
					<SheetContent
						side="right"
						className="w-full sm:max-w-2xl lg:max-w-3xl xl:max-w-4xl p-0 flex flex-col gap-0"
						hideCloseButton
					>
						<motion.div
							ref={contentRef}
							className="flex flex-col h-full overflow-hidden"
							variants={contentVariants}
							initial="hidden"
							animate="visible"
							exit="exit"
						>
							{Header}
							<div className="flex-1 flex flex-col overflow-hidden">
								{/* Sidebar on top - compact mode */}
								<div className="shrink-0 border-b border-border/40">
									<div className="px-6 py-4">
										<TaskSidebar
											task={task}
											allTasks={allTasks}
											currentUser={currentUser}
											onSave={handleSave}
											onDelete={onDelete}
											onArchive={() => previewLifecycle("archive")}
											onUnarchive={() => previewLifecycle("unarchive")}
											onHardDelete={() => {
												setHardDeleteError(null);
												setHardDeleteOpen(true);
											}}
											canHardDelete={config.capabilities?.taskHardDelete === true}
											onNavigateToTask={onNavigateToTask}
											saving={saving || lifecycleLoading}
											compact
										/>
									</div>
								</div>
								{/* Main Content below */}
								<ScrollArea className="flex-1">
									{MainContent}
								</ScrollArea>
							</div>
						</motion.div>
					{LifecycleDialogs}
				</SheetContent>
				</Sheet>
			)}
		</AnimatePresence>
	);
}
