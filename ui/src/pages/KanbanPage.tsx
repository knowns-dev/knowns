import { useRef, useState } from "react";
import { Plus, Archive, ChevronDown, ListTodo, X } from "lucide-react";
import type { Task } from "@/ui/models/task";
import { Board } from "../components/organisms";
import { Button } from "../components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../components/ui/DropdownMenu";
import { api } from "../api/client";
import { LifecycleAPIError } from "../api/client";
import type { TaskLifecycleResponse } from "../models/taskLifecycle";
import { TaskLifecycleDialog } from "../components/organisms/TaskLifecycleDialog";
import { toast } from "../components/ui/sonner";
import { useIsMobile } from "../hooks/useMobile";

// Time duration options for batch archive (in milliseconds)
const BATCH_ARCHIVE_OPTIONS = [
	{ label: "now", value: 0 },
	{ label: "1 hour ago", value: 1 * 60 * 60 * 1000 },
	{ label: "1 day ago", value: 24 * 60 * 60 * 1000 },
	{ label: "1 week ago", value: 7 * 24 * 60 * 60 * 1000 },
	{ label: "1 month ago", value: 30 * 24 * 60 * 60 * 1000 },
	{ label: "3 months ago", value: 90 * 24 * 60 * 60 * 1000 },
];

interface KanbanPageProps {
	tasks: Task[];
	loading: boolean;
	onTasksUpdate: (tasks: Task[]) => void;
	onNewTask: () => void;
}

export default function KanbanPage({ tasks, loading, onTasksUpdate, onNewTask }: KanbanPageProps) {
	const isMobile = useIsMobile();
	const [mobileWarningDismissed, setMobileWarningDismissed] = useState(() => {
		return sessionStorage.getItem("kanban-mobile-warning-dismissed") === "true";
	});
	const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
	const [archiveResponse, setArchiveResponse] = useState<TaskLifecycleResponse | null>(null);
	const [archiveError, setArchiveError] = useState<string | null>(null);
	const [archiveLoading, setArchiveLoading] = useState(false);
	const [archiveRequest, setArchiveRequest] = useState<{ generation: number; minimumAgeMs: number; label: string; ids?: readonly string[] } | null>(null);
	const archiveGenerationRef = useRef(0);
	const archiveInFlightRef = useRef(false);

	const reconcileTasks = async () => {
		const current = await api.getTasks();
		onTasksUpdate(current);
	};

	const handleBatchArchivePreview = async (minimumAgeMs: number, label: string) => {
		const generation = ++archiveGenerationRef.current;
		setArchiveRequest({ generation, minimumAgeMs, label });
		setArchiveDialogOpen(true);
		setArchiveResponse(null);
		setArchiveError(null);
		setArchiveLoading(true);
		try {
			const response = await api.batchArchiveTasks({ minimumAgeMs });
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

	const dismissMobileWarning = () => {
		setMobileWarningDismissed(true);
		sessionStorage.setItem("kanban-mobile-warning-dismissed", "true");
	};

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{/* Mobile Warning Banner */}
			{isMobile && !mobileWarningDismissed && (
				<div className="shrink-0 mx-4 mt-4 py-2 px-3 flex items-center gap-3 text-sm text-yellow-700 dark:text-yellow-300 bg-yellow-50/50 dark:bg-yellow-900/10 rounded-md">
					<ListTodo className="w-4 h-4 shrink-0" />
					<span className="flex-1">
						Drag & drop may not work well on mobile.{" "}
						<a href="/tasks" className="underline font-medium">Use Tasks page</a> instead.
					</span>
					<button
						type="button"
						onClick={dismissMobileWarning}
						className="shrink-0 p-0.5 text-yellow-600 dark:text-yellow-400 hover:text-yellow-800 dark:hover:text-yellow-200"
					>
						<X className="w-3.5 h-3.5" />
					</button>
				</div>
			)}

			{/* Header */}
			<div className="shrink-0 px-6 pt-8 pb-4">
				<div className="flex items-center justify-between gap-4">
					<div>
						<h1 className="text-3xl font-semibold tracking-tight">Kanban Board</h1>
					</div>
					<div className="flex items-center gap-2 shrink-0">
						{/* Batch Archive Dropdown */}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground">
									<Archive className="w-4 h-4" />
									<span className="hidden sm:inline text-sm">Archive</span>
									<ChevronDown className="w-3 h-3" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								{BATCH_ARCHIVE_OPTIONS.map((option) => (
										<DropdownMenuItem
											key={option.value}
											onClick={() => handleBatchArchivePreview(option.value, option.label)}
										>
											<span className="flex-1">Done before {option.label}</span>
										</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
						{/* New Task Button */}
						<Button
							onClick={onNewTask}
							size="sm"
							className="gap-1.5"
						>
							<Plus className="w-4 h-4" />
							<span className="hidden sm:inline text-sm">New Task</span>
						</Button>
					</div>
				</div>
			</div>

			{/* Board with scrollable columns */}
			<div className="flex-1 overflow-hidden px-6 pb-6">
				<Board tasks={tasks} loading={loading} onTasksUpdate={onTasksUpdate} />
			</div>

			<TaskLifecycleDialog
				open={archiveDialogOpen}
				onOpenChange={closeArchiveDialog}
				title="Archive completed Tasks"
				description={`Preview for Tasks completed before ${archiveRequest?.label || "the selected retention window"}. Eligibility and warnings come from the backend.`}
				response={archiveResponse}
				loading={archiveLoading}
				error={archiveError}
				confirmLabel="Archive eligible Tasks"
				onConfirm={handleBatchArchiveExecute}
			/>
		</div>
	);
}
