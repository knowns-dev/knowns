import { useState, useMemo } from "react";
import { Plus, X, Archive, ArchiveRestore, Trash2, ArrowUp, Play, Square, Pause, FileText } from "lucide-react";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import { Input } from "../../ui/input";
import { Label } from "@/ui/components/ui/label";
import { Separator } from "../../ui/separator";
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

interface TaskSidebarProps {
	task: Task;
	allTasks: Task[];
	currentUser: string;
	onSave: (updates: Partial<Task>) => Promise<void>;
	onDelete?: (taskId: string) => void;
	onArchive?: (taskId: string) => void;
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
		if (!newLabel.trim() || task.labels.includes(newLabel.trim())) return;
		onSave({ labels: [...task.labels, newLabel.trim()] });
		setNewLabel("");
		setAddingLabel(false);
	};

	const handleRemoveLabel = (label: string) => {
		onSave({ labels: task.labels.filter((l) => l !== label) });
	};

	const parentTask = task.parent ? allTasks.find((t) => t.id === task.parent) : null;

	// Compact layout for Sheet mode (horizontal)
	if (compact) {
		return (
			<div className="space-y-3">
				{/* Row 0: Timer */}
				<div className="flex items-center gap-2">
					<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
						Timer:
					</Label>
					{isThisTaskActive ? (
						<div className="flex items-center gap-1">
							<Button
								variant="outline"
								size="sm"
								className="h-8"
								onClick={handlePauseResumeTimer}
							>
								{isPaused ? (
									<>
										<Play className="w-3.5 h-3.5 mr-1.5 text-emerald-600" />
										Resume
									</>
								) : (
									<>
										<Pause className="w-3.5 h-3.5 mr-1.5 text-yellow-600" />
										Pause
									</>
								)}
							</Button>
							<Button
								variant="outline"
								size="sm"
								className="h-8"
								onClick={handleStopTimer}
							>
								<Square className="w-3.5 h-3.5 mr-1.5 text-red-500" />
								Stop
							</Button>
						</div>
					) : (
						<Button
							variant="default"
							size="sm"
							className="h-8"
							onClick={handleStartTimer}
						>
							<Play className="w-3.5 h-3.5 mr-1.5" />
							Start Timer
						</Button>
					)}
				</div>

				{/* Row 1: Status, Priority, Assignee */}
				<div className="grid grid-cols-3 gap-3">
					<div className="space-y-1">
						<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
							Status
						</Label>
						<Select
							value={task.status}
							onValueChange={(value) => onSave({ status: value as TaskStatus })}
							disabled={saving}
						>
							<SelectTrigger className={cn("w-full h-9", getStatusBadgeClasses(task.status, configStatusColors))}>
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
						<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
							Priority
						</Label>
						<Select
							value={task.priority}
							onValueChange={(value) => onSave({ priority: value as TaskPriority })}
							disabled={saving}
						>
							<SelectTrigger className={cn("w-full h-9", priorityColors[task.priority])}>
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
						<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
							Assignee
						</Label>
						<AssigneeDropdown
							value={task.assignee || ""}
							onChange={(newAssignee) => onSave({ assignee: newAssignee || undefined })}
							currentUser={currentUser}
							showGrabButton={false}
						/>
					</div>
				</div>

				{/* Row 2: Labels + Actions */}
				<div className="flex items-center gap-4 flex-wrap">
					{/* Labels */}
					<div className="flex items-center gap-2 flex-1 min-w-0">
						<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
							Labels:
						</Label>
						<div className="flex flex-wrap gap-1 flex-1">
							{task.labels.map((label) => (
								<Badge key={label} variant="secondary" className="gap-1 pr-1 text-xs">
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
								<Button
									variant="ghost"
									size="sm"
									className="h-6 px-2 text-xs text-muted-foreground"
									onClick={() => setAddingLabel(true)}
								>
									<Plus className="w-3 h-3 mr-1" />
									Add
								</Button>
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
							className="h-8"
							onClick={() => onSave({ status: "done" })}
							disabled={saving || task.status === "done"}
							title="Mark as Done"
						>
							<ArchiveRestore className="w-4 h-4 mr-1" />
							Done
						</Button>
						{onArchive && (
							<Button
								variant="ghost"
								size="sm"
								className="h-8 text-amber-600 hover:text-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/20"
								onClick={() => {
									if (confirm("Archive this task? It will be moved to the archive folder.")) onArchive(task.id);
								}}
								disabled={saving}
								title="Archive Task"
							>
								<Archive className="w-4 h-4" />
							</Button>
						)}
						{onDelete && (
							<Button
								variant="ghost"
								size="sm"
								className="h-8 text-destructive hover:text-destructive hover:bg-destructive/10"
								onClick={() => {
									if (confirm("Delete this task?")) onDelete(task.id);
								}}
								disabled={saving}
								title="Delete Task"
							>
								<Trash2 className="w-4 h-4" />
							</Button>
						)}
					</div>
				</div>

				{/* Linked Spec (compact) */}
				{task.spec && (
					<div className="flex items-center gap-2">
						<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
							Spec:
						</Label>
						<button
							type="button"
							onClick={() => {
								window.location.hash = `/docs/${task.spec}.md`;
							}}
							className="flex items-center gap-1 text-sm text-purple-600 dark:text-purple-400 hover:underline"
							title={`@doc/${task.spec}`}
						>
							<FileText className="w-4 h-4" />
							{task.spec.split("/").pop()}
						</button>
					</div>
				)}

				{/* Parent/Subtasks summary (if any) */}
				{(parentTask || task.subtasks.length > 0) && (
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
						{task.subtasks.length > 0 && (
							<span>{task.subtasks.length} subtask{task.subtasks.length > 1 ? "s" : ""}</span>
						)}
					</div>
				)}
			</div>
		);
	}

	// Normal layout (vertical) for Dialog mode
	return (
		<div className="space-y-6 overflow-hidden">
			{/* Timer Controls */}
			<div className="space-y-2">
				<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Timer
				</Label>
				{isThisTaskActive ? (
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							className="flex-1"
							onClick={handlePauseResumeTimer}
						>
							{isPaused ? (
								<>
									<Play className="w-4 h-4 mr-2 text-emerald-600" />
									Resume
								</>
							) : (
								<>
									<Pause className="w-4 h-4 mr-2 text-yellow-600" />
									Pause
								</>
							)}
						</Button>
						<Button
							variant="outline"
							size="sm"
							className="flex-1"
							onClick={handleStopTimer}
						>
							<Square className="w-4 h-4 mr-2 text-red-500" />
							Stop
						</Button>
					</div>
				) : (
					<Button
						variant="default"
						size="sm"
						className="w-full"
						onClick={handleStartTimer}
					>
						<Play className="w-4 h-4 mr-2" />
						Start Timer
					</Button>
				)}
			</div>

			{/* Status */}
			<div className="space-y-2">
				<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Status
				</Label>
				<Select
					value={task.status}
					onValueChange={(value) => onSave({ status: value as TaskStatus })}
					disabled={saving}
				>
					<SelectTrigger className={cn("w-full", getStatusBadgeClasses(task.status, configStatusColors))}>
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
			<div className="space-y-2">
				<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Priority
				</Label>
				<Select
					value={task.priority}
					onValueChange={(value) => onSave({ priority: value as TaskPriority })}
					disabled={saving}
				>
					<SelectTrigger className={cn("w-full", priorityColors[task.priority])}>
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
			<div className="space-y-2">
				<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Assignee
				</Label>
				<AssigneeDropdown
					value={task.assignee || ""}
					onChange={(newAssignee) => onSave({ assignee: newAssignee || undefined })}
					currentUser={currentUser}
					showGrabButton={false}
				/>
			</div>

			{/* Labels */}
			<div className="space-y-2">
				<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Labels
				</Label>
				<div className="flex flex-wrap gap-1">
					{task.labels.map((label) => (
						<Badge key={label} variant="secondary" className="gap-1 pr-1">
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
					<Button
						variant="ghost"
						size="sm"
						className="w-full justify-start text-muted-foreground"
						onClick={() => setAddingLabel(true)}
					>
						<Plus className="w-4 h-4 mr-2" />
						Add label
					</Button>
				)}
			</div>

			{/* Linked Spec */}
			{task.spec && (
				<div className="space-y-2">
					<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						Linked Spec
					</Label>
					<Button
						variant="outline"
						className="w-full justify-start h-auto py-2"
						onClick={() => {
							window.location.hash = `/docs/${task.spec}.md`;
						}}
						title={`@doc/${task.spec}`}
					>
						<FileText className="w-4 h-4 mr-2 text-purple-600 dark:text-purple-400" />
						<span className="text-purple-600 dark:text-purple-400">
							{task.spec.split("/").pop()}
						</span>
					</Button>
				</div>
			)}

			{/* Parent Task */}
			{parentTask && (
				<div className="space-y-2 overflow-hidden">
					<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						Parent Task
					</Label>
					<Button
						variant="outline"
						className="w-full justify-start h-auto py-2 min-w-0 max-w-full overflow-hidden"
						onClick={() => onNavigateToTask?.(parentTask.id)}
						title={`#${parentTask.id} - ${parentTask.title}`}
					>
						<ArrowUp className="w-4 h-4 mr-2 shrink-0" />
						<div className="text-left overflow-hidden min-w-0 flex-1">
							<span className="text-xs text-muted-foreground font-mono block">#{parentTask.id}</span>
							<p className="truncate text-sm">{parentTask.title}</p>
						</div>
					</Button>
				</div>
			)}

			{/* Subtasks */}
			{task.subtasks.length > 0 && (
				<div className="space-y-2 overflow-hidden">
					<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						Subtasks ({task.subtasks.length})
					</Label>
					<div className="space-y-1 max-h-48 overflow-y-auto overflow-x-hidden">
						{task.subtasks.map((subtaskId) => {
							const subtask = allTasks.find((t) => t.id === subtaskId);
							if (!subtask) return null;
							return (
								<Button
									key={subtaskId}
									variant="outline"
									className="w-full justify-start h-auto py-2 min-w-0 max-w-full overflow-hidden"
									onClick={() => onNavigateToTask?.(subtaskId)}
									title={`#${subtask.id} - ${subtask.title}`}
								>
									<span
										className={cn(
											"w-2 h-2 rounded-full mr-2 shrink-0",
											subtask.status === "done" ? "bg-green-500" : "bg-muted-foreground"
										)}
									/>
									<div className="text-left overflow-hidden min-w-0 flex-1">
										<span className="text-xs text-muted-foreground font-mono block">
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
								</Button>
							);
						})}
					</div>
				</div>
			)}

			<Separator />

			{/* Actions */}
			<div className="space-y-2">
				<Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Actions
				</Label>
				<div className="space-y-1">
					<Button
						variant="ghost"
						className="w-full justify-start"
						onClick={() => onSave({ status: "done" })}
						disabled={saving || task.status === "done"}
					>
						<ArchiveRestore className="w-4 h-4 mr-2" />
						Mark as Done
					</Button>
					{onArchive && (
						<Button
							variant="ghost"
							className="w-full justify-start text-amber-600 hover:text-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/20"
							onClick={() => {
								if (confirm("Archive this task? It will be moved to the archive folder.")) onArchive(task.id);
							}}
							disabled={saving}
						>
							<Archive className="w-4 h-4 mr-2" />
							Archive Task
						</Button>
					)}
					{onDelete && (
						<Button
							variant="ghost"
							className="w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10"
							onClick={() => {
								if (confirm("Delete this task?")) onDelete(task.id);
							}}
							disabled={saving}
						>
							<Trash2 className="w-4 h-4 mr-2" />
							Delete Task
						</Button>
					)}
				</div>
			</div>

			<Separator />

			{/* Timestamps */}
			<div className="text-xs text-muted-foreground space-y-1">
				<p>Created: {new Date(task.createdAt).toLocaleString()}</p>
				<p>Updated: {new Date(task.updatedAt).toLocaleString()}</p>
			</div>
		</div>
	);
}
