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
import { ScrollArea } from "../../ui/scroll-area";
import type { Task } from "../../../models/task";
import { updateTask } from "../../../api/client";
import { toast } from "../../ui/sonner";
import { useCurrentUser } from "../../../contexts/UserContext";
import { useUIPreferences } from "../../../contexts/UIPreferencesContext";
import { TaskHeader } from "./TaskHeader";
import { TaskDescription } from "./TaskDescription";
import { TaskAcceptanceCriteria } from "./TaskAcceptanceCriteria";
import { TaskImplementationSection } from "./TaskImplementationSection";
import { TaskSidebar } from "./TaskSidebar";
import { TimeTrackingLogs } from "../../molecules";
import TaskHistoryPanel from "../TaskHistoryPanel";

interface TaskDetailSheetProps {
	task: Task | null;
	allTasks: Task[];
	onClose: () => void;
	onUpdate: (task: Task) => void;
	onDelete?: (taskId: string) => void;
	onArchive?: (taskId: string) => void;
	onNavigateToTask?: (taskId: string) => void;
}

export function TaskDetailSheet({
	task,
	allTasks,
	onClose,
	onUpdate,
	onDelete,
	onArchive,
	onNavigateToTask,
}: TaskDetailSheetProps) {
	const { currentUser } = useCurrentUser();
	const { preferences, toggleTaskDetailLayout } = useUIPreferences();
	const [saving, setSaving] = useState(false);
	const isMaximized = preferences.taskDetailLayout === "maximized";
	const contentRef = useRef<HTMLDivElement>(null);

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

				if (href && href.startsWith("#/")) {
					onClose();
					return;
				}

				if (href && /^(task-)?\d+(\.md)?$/.test(href)) {
					e.preventDefault();
					const taskId = href.replace(/^task-/, "").replace(/\.md$/, "");
					window.location.hash = `/kanban/${taskId}`;
					onClose();
					return;
				}

				if (href && (href.endsWith(".md") || href.includes(".md#"))) {
					e.preventDefault();
					const normalizedPath = href.replace(/^\.\//, "").replace(/^\//, "");
					window.location.hash = `/docs/${normalizedPath}`;
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
		<div className="flex items-center justify-between gap-2 p-4 border-b bg-blue-800">
			<div className="flex-1 min-w-0">
				<TaskHeader task={task} onSave={handleSave} saving={saving} />
			</div>
			<div className="flex items-center gap-1 shrink-0">
				<Button
					variant="ghost"
					size="icon"
					onClick={toggleTaskDetailLayout}
					className="h-8 w-8 text-foreground hover:text-foreground"
					title={isMaximized ? "Minimize" : "Maximize"}
				>
					{isMaximized ? (
						<Minimize2 className="w-4 h-4" />
					) : (
						<Maximize2 className="w-4 h-4" />
					)}
				</Button>
				<Button
					variant="ghost"
					size="icon"
					onClick={onClose}
					className="h-8 w-8 text-foreground hover:text-foreground"
					title="Close"
				>
					<X className="w-4 h-4" />
				</Button>
			</div>
		</div>
	);

	// Main content section (shared)
	const MainContent = (
		<div className="p-6 space-y-6">
			<TaskDescription task={task} onSave={handleSave} saving={saving} />
			<TaskAcceptanceCriteria task={task} onSave={handleSave} saving={saving} />
			<TaskImplementationSection
				task={task}
				onSave={handleSave}
				saving={saving}
				type="plan"
			/>
			<TaskImplementationSection
				task={task}
				onSave={handleSave}
				saving={saving}
				type="notes"
			/>

			{/* Time Tracking */}
			<TimeTrackingLogs
				taskId={task.id}
				timeEntries={task.timeEntries}
				timeSpent={task.timeSpent}
			/>

			{/* History */}
			<TaskHistoryPanel taskId={task.id} />
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
			onArchive={onArchive}
			onNavigateToTask={onNavigateToTask}
			saving={saving}
		/>
	);

	// Centered Dialog mode (default) - Sidebar on RIGHT
	if (isMaximized) {
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
									<div className="shrink-0 w-72 border-l bg-muted/20 overflow-hidden">
										<ScrollArea className="h-full w-full">
											<div className="p-4 w-full max-w-full overflow-hidden">{Sidebar}</div>
										</ScrollArea>
									</div>
								</div>
							</motion.div>
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
								<div className="shrink-0 border-b bg-muted/20">
									<div className="p-4">
										<TaskSidebar
											task={task}
											allTasks={allTasks}
											currentUser={currentUser}
											onSave={handleSave}
											onDelete={onDelete}
											onArchive={onArchive}
											onNavigateToTask={onNavigateToTask}
											saving={saving}
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
					</SheetContent>
				</Sheet>
			)}
		</AnimatePresence>
	);
}
