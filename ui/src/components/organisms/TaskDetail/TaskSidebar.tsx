import { useState, useMemo } from "react";
import { navigateTo } from "../../../lib/navigation";
import { Plus, X, Archive, ArchiveRestore, Trash2, ArrowUp, Play, Square, Pause, FileText } from "lucide-react";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import { Input } from "../../ui/input";
import { Label } from "@/ui/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../ui/select";
import AssigneeDropdown from "../AssigneeDropdown";
import type { Task, TaskStatus, TaskPriority } from "@models/task";
import { priorityOptions, priorityColors } from "./types";
import { cn } from "@/ui/lib/utils";
import { useTimeTracker } from "../../../contexts/TimeTrackerContext";
import { useConfig } from "../../../contexts/ConfigContext";
import { buildStatusOptions, getStatusBadgeClasses, type ColorName } from "../../../utils/colors";
import { TaskLifecycleBadge, TaskLifecycleTimestamps } from "../../molecules/TaskLifecycleBadge";

interface TaskSidebarProps {
	task: Task;
	allTasks: Task[];
	currentUser: string;
	onSave: (updates: Partial<Task>) => Promise<void>;
	onDelete?: (taskId: string) => void;
	onArchive?: (taskId: string) => void;
	onUnarchive?: (taskId: string) => void;
	onHardDelete?: (taskId: string) => void;
	canHardDelete?: boolean;
	onNavigateToTask?: (taskId: string) => void;
	saving: boolean;
	compact?: boolean;
}

export function TaskSidebar({
	task,
	allTasks,
	currentUser,
	onSave,
	onDelete,
	onArchive,
	onUnarchive,
	onHardDelete,
	canHardDelete = false,
	onNavigateToTask,
	saving,
	compact = false,
}: TaskSidebarProps) {
	const [addingLabel, setAddingLabel] = useState(false);
	const [newLabel, setNewLabel] = useState("");
	const { isTaskRunning, isTaskPaused, start, stop, pause, resume } = useTimeTracker();
	const { config } = useConfig();

	// Build status options from config
	const statusOptions = useMemo(() => {
		const statuses = config.statuses || ["todo", "in-progress", "in-review", "done", "blocked"];
		return buildStatusOptions(statuses);
	}, [config.statuses]);

	// Get status colors from config
	const configStatusColors = (config.statusColors || {}) as Record<string, ColorName>;

	const isThisTaskActive = isTaskRunning(task.id);
	const isPaused = isTaskPaused(task.id);

	const handleStartTimer = async () => {
		if (isThisTaskActive) return;
		try {
			await start(task.id);
		} catch (error) {
			console.error("Failed to start timer:", error);
		}
	};

	const handleStopTimer = async () => {
		try {
			await stop(task.id);
		} catch (error) {
			console.error("Failed to stop timer:", error);
		}
	};

	const handlePauseResumeTimer = async () => {
		try {
			if (isPaused) {
				await resume(task.id);
			} else {
				await pause(task.id);
			}
		} catch (error) {
			console.error("Failed to pause/resume timer:", error);
		}
	};

	const handleAddLabel = () => {
		if (!newLabel.trim() || (task.labels ?? []).includes(newLabel.trim())) return;
		onSave({ labels: [...task.labels, newLabel.trim()] });
		setNewLabel("");
		setAddingLabel(false);
	};

	const handleRemoveLabel = (label: string) => {
		onSave({ labels: (task.labels ?? []).filter((l) => l !== label) });
	};

	const parentTask = task.parent ? allTasks.find((t) => t.id === task.parent) : null;

	// Compact layout for Sheet mode (horizontal)
	if (compact) {
		return (
			<div className="space-y-3">
				<div className="flex flex-wrap items-center gap-2" aria-label="Task lifecycle">
					<TaskLifecycleBadge state={task.lifecycleState} />
					<TaskLifecycleTimestamps task={task} compact />
				</div>
				{/* Row 1: Timer */}
				<div className="flex items-center gap-2">
					<span className="text-xs text-muted-foreground shrink-0 w-12">Timer</span>
					{isThisTaskActive ? (
						<div className="flex items-center gap-1">
							<Button
								variant="ghost"
								size="sm"
								className="h-7"
								onClick={handlePauseResumeTimer}
							>
								{isPaused ? (
									<><Play className="w-3.5 h-3.5 mr-1 text-emerald-600" />Resume</>
								) : (
									<><Pause className="w-3.5 h-3.5 mr-1 text-yellow-600" />Pause</>
								)}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								className="h-7"
								onClick={handleStopTimer}
							>
								<Square className="w-3.5 h-3.5 mr-1 text-red-500" />
								Stop
							</Button>
						</div>
					) : (
						<Button
							variant="ghost"
							size="sm"
							className="h-7 text-muted-foreground hover:text-foreground"
							onClick={handleStartTimer}
							disabled={task.lifecycleState === "archived"}
						>
							<Play className="w-3.5 h-3.5 mr-1.5" />
							Start Timer
						</Button>
					)}
				</div>

				{/* Row 2: Status, Priority, Assignee */}
				<div className="grid grid-cols-3 gap-3">
					<div className="space-y-1">
						<span className="text-xs text-muted-foreground">Status</span>
						<Select
							value={task.status}
							onValueChange={(value) => onSave({ status: value as TaskStatus })}
							disabled={saving || task.lifecycleState === "archived"}
						>
							<SelectTrigger className={cn("w-full h-8 text-sm", getStatusBadgeClasses(task.status, configStatusColors))}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{statusOptions.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-1">
						<span className="text-xs text-muted-foreground">Priority</span>
						<Select
							value={task.priority}
							onValueChange={(value) => onSave({ priority: value as TaskPriority })}
							disabled={saving}
						>
							<SelectTrigger className={cn("w-full h-8 text-sm", priorityColors[task.priority])}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{priorityOptions.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-1">
						<span className="text-xs text-muted-foreground">Assignee</span>
						<AssigneeDropdown
							value={task.assignee || ""}
							onChange={(newAssignee) => onSave({ assignee: newAssignee || undefined })}
							currentUser={currentUser}
							showGrabButton={false}
						/>
					</div>
				</div>

				{/* Row 3: Labels + Actions */}
				<div className="flex items-center gap-4 flex-wrap">
					{/* Labels */}
					<div className="flex items-center gap-2 flex-1 min-w-0">
						<span className="text-xs text-muted-foreground shrink-0">Labels</span>
						<div className="flex flex-wrap gap-1 flex-1">
							{(task.labels ?? []).map((label) => (
								<Badge key={label} variant="secondary" className="gap-1 pr-1 text-xs bg-muted">
									{label}
									<button
										type="button"
										onClick={() => handleRemoveLabel(label)}
										className="ml-0.5 hover:text-destructive"
									>
										<X className="w-3 h-3" />
									</button>
								</Badge>
							))}
							{!addingLabel && (
								<button
									type="button"
									className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
									onClick={() => setAddingLabel(true)}
								>
									<Plus className="w-3 h-3" />
									Add
								</button>
							)}
						</div>
						{addingLabel && (
							<div className="flex items-center gap-2">
								<Input
									value={newLabel}
									onChange={(e) => setNewLabel(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && newLabel.trim()) handleAddLabel();
										if (e.key === "Escape") {
											setNewLabel("");
											setAddingLabel(false);
										}
									}}
									placeholder="Label"
									className="h-7 w-24 text-xs"
									autoFocus
								/>
								<Button size="sm" className="h-7 px-2" onClick={handleAddLabel} disabled={!newLabel.trim()}>
									Add
								</Button>
								<Button
									size="sm"
									variant="ghost"
									className="h-7 px-2"
									onClick={() => {
										setNewLabel("");
										setAddingLabel(false);
									}}
								>
									<X className="w-3 h-3" />
								</Button>
							</div>
						)}
					</div>

					{/* Compact Actions */}
					<div className="flex items-center gap-1 shrink-0">
						<Button
							variant="ghost"
							size="sm"
							className="h-7 text-xs"
							onClick={() => onSave({ status: "done" })}
							disabled={saving || task.status === "done" || task.lifecycleState === "archived"}
						>
							<ArchiveRestore className="w-3.5 h-3.5 mr-1" />
							Done
						</Button>
						{task.lifecycleState !== "archived" && onArchive && (
							<Button
								variant="ghost"
								size="sm"
								className="h-7 text-muted-foreground hover:text-amber-600"
								onClick={() => onArchive(task.id)}
								disabled={saving}
								title="Archive"
								aria-label="Archive Task"
							>
								<Archive className="w-3.5 h-3.5" />
							</Button>
						)}
						{task.lifecycleState === "archived" && onUnarchive && (
							<Button
								variant="ghost"
								size="sm"
								className="h-7 text-muted-foreground hover:text-emerald-600"
								onClick={() => onUnarchive(task.id)}
								disabled={saving}
								title="Restore"
								aria-label="Restore Task"
							>
								<ArchiveRestore className="w-3.5 h-3.5" />
							</Button>
						)}
						{canHardDelete && onHardDelete && (
							<Button
								variant="ghost"
								size="sm"
								className="h-7 text-muted-foreground hover:text-destructive"
								onClick={() => onHardDelete(task.id)}
								disabled={saving}
								title="Permanently delete"
								aria-label="Permanently delete Task"
							>
								<Trash2 className="w-3.5 h-3.5" />
							</Button>
						)}
						{onDelete && (
							<Button
								variant="ghost"
								size="sm"
								className="h-7 text-muted-foreground hover:text-destructive"
								onClick={() => {
									if (confirm("Delete this task?")) onDelete(task.id);
								}}
								disabled={saving}
								title="Delete"
							>
								<Trash2 className="w-3.5 h-3.5" />
							</Button>
						)}
					</div>
				</div>

				{/* Linked Spec (compact) */}
				{task.spec && (
					<div className="flex items-center gap-2">
						<span className="text-xs text-muted-foreground shrink-0 w-12">Spec</span>
						<button
							type="button"
							onClick={() => {
								navigateTo(`/docs/${task.spec}.md`);
							}}
							className="flex items-center gap-1 text-sm text-purple-600 dark:text-purple-400 hover:underline"
							title={`@doc/${task.spec}`}
						>
							<FileText className="w-3.5 h-3.5" />
							{task.spec.split("/").pop()}
						</button>
					</div>
				)}

				{/* Parent/Subtasks summary (if any) */}
				{(parentTask || (task.subtasks ?? []).length > 0) && (
					<div className="flex items-center gap-4 text-xs text-muted-foreground">
						{parentTask && (
							<button
								type="button"
								onClick={() => onNavigateToTask?.(parentTask.id)}
								className="flex items-center gap-1 hover:text-foreground transition-colors"
							>
								<ArrowUp className="w-3 h-3" />
								<span>Parent: #{parentTask.id}</span>
							</button>
						)}
						{(task.subtasks ?? []).length > 0 && (
							<span>{(task.subtasks ?? []).length} subtask{(task.subtasks ?? []).length > 1 ? "s" : ""}</span>
						)}
					</div>
				)}
			</div>
		);
	}

	// Normal layout (vertical) for Dialog mode
	return (
		<div className="space-y-5 overflow-hidden">
			{/* Timer Controls */}
			<div className="space-y-1.5">
				<span className="text-xs text-muted-foreground">Timer</span>
				{isThisTaskActive ? (
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="sm"
							className="flex-1"
							onClick={handlePauseResumeTimer}
						>
							{isPaused ? (
								<><Play className="w-4 h-4 mr-1.5 text-emerald-600" />Resume</>
							) : (
								<><Pause className="w-4 h-4 mr-1.5 text-yellow-600" />Pause</>
							)}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="flex-1"
							onClick={handleStopTimer}
						>
							<Square className="w-4 h-4 mr-1.5 text-red-500" />
							Stop
						</Button>
					</div>
				) : (
					<Button
						variant="ghost"
						size="sm"
					className="w-full justify-start text-muted-foreground hover:text-foreground"
					onClick={handleStartTimer}
					disabled={task.lifecycleState === "archived"}
					>
						<Play className="w-4 h-4 mr-2" />
						Start Timer
					</Button>
				)}
			</div>

			<div className="border-t border-border/40" />

			{/* Status */}
			<div className="space-y-1.5">
				<div className="flex items-center justify-between gap-2">
					<span className="text-xs text-muted-foreground">Status</span>
					<TaskLifecycleBadge state={task.lifecycleState} />
				</div>
				<Select
					value={task.status}
					onValueChange={(value) => onSave({ status: value as TaskStatus })}
					disabled={saving || task.lifecycleState === "archived"}
				>
					<SelectTrigger className={cn("w-full h-8 text-sm", getStatusBadgeClasses(task.status, configStatusColors))}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{statusOptions.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								{opt.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{/* Priority */}
			<div className="space-y-1.5">
				<span className="text-xs text-muted-foreground">Priority</span>
				<Select
					value={task.priority}
					onValueChange={(value) => onSave({ priority: value as TaskPriority })}
					disabled={saving}
				>
					<SelectTrigger className={cn("w-full h-8 text-sm", priorityColors[task.priority])}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{priorityOptions.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								{opt.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{/* Assignee */}
			<div className="space-y-1.5">
				<span className="text-xs text-muted-foreground">Assignee</span>
				<AssigneeDropdown
					value={task.assignee || ""}
					onChange={(newAssignee) => onSave({ assignee: newAssignee || undefined })}
					currentUser={currentUser}
					showGrabButton={false}
				/>
			</div>

			{/* Labels */}
			<div className="space-y-1.5">
				<span className="text-xs text-muted-foreground">Labels</span>
				<div className="flex flex-wrap gap-1">
					{(task.labels ?? []).map((label) => (
						<Badge key={label} variant="secondary" className="gap-1 pr-1 bg-muted">
							{label}
							<button
								type="button"
								onClick={() => handleRemoveLabel(label)}
								className="ml-1 hover:text-destructive"
							>
								<X className="w-3 h-3" />
							</button>
						</Badge>
					))}
				</div>
				{addingLabel ? (
					<div className="space-y-2">
						<Input
							value={newLabel}
							onChange={(e) => setNewLabel(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && newLabel.trim()) handleAddLabel();
								if (e.key === "Escape") {
									setNewLabel("");
									setAddingLabel(false);
								}
							}}
							placeholder="Label name"
							className="text-sm"
							autoFocus
						/>
						<div className="flex gap-2">
							<Button size="sm" onClick={handleAddLabel} disabled={!newLabel.trim()}>
								Add
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => {
									setNewLabel("");
									setAddingLabel(false);
								}}
							>
								Cancel
							</Button>
						</div>
					</div>
				) : (
					<button
						type="button"
						className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full py-1"
						onClick={() => setAddingLabel(true)}
					>
						<Plus className="w-4 h-4" />
						Add label
					</button>
				)}
			</div>

			{/* Linked Spec */}
			{task.spec && (
				<div className="space-y-1.5">
					<span className="text-xs text-muted-foreground">Linked Spec</span>
					<button
						type="button"
						className="flex items-center gap-2 w-full text-left py-1.5 text-sm text-purple-600 dark:text-purple-400 hover:underline"
						onClick={() => {
							navigateTo(`/docs/${task.spec}.md`);
						}}
						title={`@doc/${task.spec}`}
					>
						<FileText className="w-4 h-4" />
						{task.spec.split("/").pop()}
					</button>
				</div>
			)}

			{/* Parent Task */}
			{parentTask && (
				<div className="space-y-1.5 overflow-hidden">
					<span className="text-xs text-muted-foreground">Parent Task</span>
					<button
						type="button"
						className="flex items-center gap-2 w-full text-left py-1.5 rounded-md hover:bg-muted/50 transition-colors -mx-1 px-1"
						onClick={() => onNavigateToTask?.(parentTask.id)}
						title={`#${parentTask.id} - ${parentTask.title}`}
					>
						<ArrowUp className="w-4 h-4 shrink-0 text-muted-foreground" />
						<div className="overflow-hidden min-w-0 flex-1">
							<span className="text-xs text-muted-foreground font-mono">#{parentTask.id}</span>
							<p className="truncate text-sm">{parentTask.title}</p>
						</div>
					</button>
				</div>
			)}

			{/* Subtasks */}
			{(task.subtasks ?? []).length > 0 && (
				<div className="space-y-1.5 overflow-hidden">
					<span className="text-xs text-muted-foreground">
						Subtasks ({(task.subtasks ?? []).length})
					</span>
					<div className="space-y-0.5 max-h-48 overflow-y-auto overflow-x-hidden">
						{(task.subtasks ?? []).map((subtaskId) => {
							const subtask = allTasks.find((t) => t.id === subtaskId);
							if (!subtask) return null;
							return (
								<button
									key={subtaskId}
									type="button"
									className="flex items-center gap-2 w-full text-left py-1.5 rounded-md hover:bg-muted/50 transition-colors -mx-1 px-1"
									onClick={() => onNavigateToTask?.(subtaskId)}
									title={`#${subtask.id} - ${subtask.title}`}
								>
									<span
										className={cn(
											"w-2 h-2 rounded-full shrink-0",
											subtask.status === "done" ? "bg-green-500" : "bg-muted-foreground/40"
										)}
									/>
									<div className="overflow-hidden min-w-0 flex-1">
										<span className="text-xs text-muted-foreground font-mono">
											#{subtask.id}
										</span>
										<p
											className={cn(
												"truncate text-sm",
												subtask.status === "done" && "line-through text-muted-foreground"
											)}
										>
											{subtask.title}
										</p>
									</div>
								</button>
							);
						})}
					</div>
				</div>
			)}

			<div className="border-t border-border/40" />

			{/* Actions */}
			<div className="space-y-0.5">
				<button
					type="button"
					className="flex items-center gap-2 w-full text-left py-1.5 px-1 -mx-1 text-sm rounded-md hover:bg-muted/50 transition-colors disabled:opacity-50"
					onClick={() => onSave({ status: "done" })}
					disabled={saving || task.status === "done" || task.lifecycleState === "archived"}
				>
					<ArchiveRestore className="w-4 h-4" />
					Mark as Done
				</button>
				{task.lifecycleState !== "archived" && onArchive && (
					<button
						type="button"
						className="flex items-center gap-2 w-full text-left py-1.5 px-1 -mx-1 text-sm rounded-md text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/10 transition-colors disabled:opacity-50"
						onClick={() => onArchive(task.id)}
						disabled={saving}
					>
						<Archive className="w-4 h-4" />
						Archive Task
					</button>
				)}
				{task.lifecycleState === "archived" && onUnarchive && (
					<button
						type="button"
						className="flex items-center gap-2 w-full text-left py-1.5 px-1 -mx-1 text-sm rounded-md text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/10 transition-colors disabled:opacity-50"
						onClick={() => onUnarchive(task.id)}
						disabled={saving}
					>
						<ArchiveRestore className="w-4 h-4" />
						Restore Task
					</button>
				)}
				{canHardDelete && onHardDelete && (
					<button
						type="button"
						className="flex items-center gap-2 w-full text-left py-1.5 px-1 -mx-1 text-sm rounded-md text-destructive hover:bg-destructive/5 transition-colors disabled:opacity-50"
						onClick={() => onHardDelete(task.id)}
						disabled={saving}
					>
						<Trash2 className="w-4 h-4" />
						Permanently delete…
					</button>
				)}
				{onDelete && (
					<button
						type="button"
						className="flex items-center gap-2 w-full text-left py-1.5 px-1 -mx-1 text-sm rounded-md text-destructive hover:bg-destructive/5 transition-colors disabled:opacity-50"
						onClick={() => {
							if (confirm("Delete this task?")) onDelete(task.id);
						}}
						disabled={saving}
					>
						<Trash2 className="w-4 h-4" />
						Delete Task
					</button>
				)}
			</div>

			{/* Timestamps */}
			<div className="text-xs text-muted-foreground space-y-1 pt-2">
				<p>Created: {new Date(task.createdAt).toLocaleString()}</p>
				<p>Updated: {new Date(task.updatedAt).toLocaleString()}</p>
				<TaskLifecycleTimestamps task={task} />
			</div>
		</div>
	);
}
