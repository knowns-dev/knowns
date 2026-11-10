import { useMemo, useState, type ReactNode } from "react";
import { ArrowUpRight, CornerLeftUp, FileText, Pause, Play, Plus, Square } from "lucide-react";
import { Button } from "@/ui/components/ui/knowns/button";
import { Combobox } from "@/ui/components/ui/knowns/combobox";
import { Input } from "@/ui/components/ui/knowns/input";
import { Tag } from "@/ui/components/ui/knowns/tag";
import AssigneeDropdown from "../AssigneeDropdown";
import type { Task, TaskStatus, TaskPriority } from "@/ui/models/task";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { navigateTo } from "../../../lib/navigation";
import { useTimeTracker } from "../../../contexts/TimeTrackerContext";
import { useConfig } from "../../../contexts/ConfigContext";
import { buildStatusOptions } from "../../../utils/colors";
import { TaskLifecycleBadge, TaskLifecycleTimestamps } from "../../molecules/TaskLifecycleBadge";
import { priorityOptions, priorityTones, statusTone } from "./types";

interface TaskSidebarProps {
	task: Task;
	allTasks: Task[];
	currentUser: string;
	onSave: (updates: Partial<Task>) => Promise<void>;
	onNavigateToTask?: (taskId: string) => void;
	saving: boolean;
	className?: string;
}

/** One property: a muted label over its control. */
function Property({ label, children, className, wide }: { label: string; children: ReactNode; className?: string; wide?: boolean }) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-1.5", wide && "@[440px]:col-span-2", className)}>
			<span className="text-[12px] font-medium text-muted-foreground">{label}</span>
			{children}
		</div>
	);
}

function TaskLink({ task, onOpen, done }: { task: Task; onOpen?: (id: string) => void; done?: boolean }) {
	return (
		<button
			type="button"
			onClick={() => onOpen?.(task.id)}
			title={`#${task.id} ${task.title}`}
			className={cn(
				"-mx-2 flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]",
				focusRing,
			)}
		>
			{done !== undefined && (
				<span
					aria-hidden
					className={cn("size-2 flex-none rounded-full", done ? "bg-emerald-500" : "bg-[color-mix(in_srgb,var(--foreground)_22%,transparent)]")}
				/>
			)}
			<span className="min-w-0 flex-1">
				<span className="block font-mono text-[11.5px] text-muted-foreground">#{task.id}</span>
				<span className={cn("block truncate text-[13.5px]", done ? "text-muted-foreground line-through decoration-muted-foreground/50" : "text-foreground")}>
					{task.title}
				</span>
			</span>
			{done !== undefined && <span className="sr-only">{done ? ", done" : ", open"}</span>}
		</button>
	);
}

/**
 * The task's properties: timer, status, priority, assignee, labels, spec, parent and subtasks, lifecycle.
 * A column beside the content on wide sheets; stacked under it on phones (two columns once there is room).
 */
export function TaskSidebar({ task, allTasks, currentUser, onSave, onNavigateToTask, saving, className }: TaskSidebarProps) {
	const [addingLabel, setAddingLabel] = useState(false);
	const [newLabel, setNewLabel] = useState("");
	const { isTaskRunning, isTaskPaused, start, stop, pause, resume } = useTimeTracker();
	const { config } = useConfig();
	const archived = task.lifecycleState === "archived";

	const configStatusColors = (config.statusColors || {}) as Record<string, string>;
	const statusOptions = useMemo(() => {
		const statuses = config.statuses || ["todo", "in-progress", "in-review", "done", "blocked"];
		return buildStatusOptions(statuses).map((o) => ({ ...o, dot: statusTone(o.value, configStatusColors) }));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [config.statuses, config.statusColors]);
	const priorityChoices = useMemo(() => priorityOptions.map((o) => ({ ...o, dot: priorityTones[o.value] })), []);

	const running = isTaskRunning(task.id);
	const paused = isTaskPaused(task.id);

	const run = (label: string, fn: () => Promise<unknown>) => async () => {
		try {
			await fn();
		} catch (error) {
			console.error(`Failed to ${label} timer:`, error);
		}
	};

	const labels = task.labels ?? [];
	const handleAddLabel = () => {
		const value = newLabel.trim();
		if (!value || labels.includes(value)) return;
		onSave({ labels: [...labels, value] });
		setNewLabel("");
		setAddingLabel(false);
	};

	const parentTask = task.parent ? allTasks.find((t) => t.id === task.parent) : null;
	const subtasks = (task.subtasks ?? []).map((id) => allTasks.find((t) => t.id === id)).filter((t): t is Task => !!t);
	const subtasksDone = subtasks.filter((t) => t.status === "done").length;

	return (
		<div className={cn("@container", className)}>
			<div className="grid grid-cols-1 gap-x-6 gap-y-5 @[440px]:grid-cols-2">
				<Property label="Timer" wide>
					{running ? (
						<div className="flex flex-wrap items-center gap-2">
							<Button
								size="sm"
								variant="secondary"
								icon={paused ? <Play className="text-emerald-600 dark:text-emerald-400" /> : <Pause />}
								onClick={run(paused ? "resume" : "pause", () => (paused ? resume(task.id) : pause(task.id)))}
							>
								{paused ? "Resume" : "Pause"}
							</Button>
							<Button size="sm" variant="secondary" icon={<Square className="text-red-600 dark:text-red-400" />} onClick={run("stop", () => stop(task.id))}>
								Stop
							</Button>
							<span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
								<span aria-hidden className={cn("size-1.5 rounded-full", paused ? "bg-amber-500" : "bg-emerald-500 motion-safe:animate-pulse")} />
								{paused ? "Paused" : "Running"}
							</span>
						</div>
					) : (
						<Button
							size="sm"
							variant="secondary"
							icon={<Play />}
							className="self-start"
							onClick={run("start", () => start(task.id))}
							disabled={archived}
						>
							Start Timer
						</Button>
					)}
				</Property>

				<Property label="Status">
					<Combobox
						options={statusOptions}
						aria-label="Status"
						size="sm"
						value={task.status}
						onValueChange={(value) => value !== task.status && onSave({ status: value as TaskStatus })}
						disabled={saving || archived}
						className="w-full"
					/>
				</Property>

				<Property label="Priority">
					<Combobox
						options={priorityChoices}
						aria-label="Priority"
						size="sm"
						value={task.priority}
						onValueChange={(value) => value !== task.priority && onSave({ priority: value as TaskPriority })}
						disabled={saving}
						className="w-full"
					/>
				</Property>

				<Property label="Assignee" wide>
					<AssigneeDropdown
						value={task.assignee || ""}
						onChange={(newAssignee) => onSave({ assignee: newAssignee || undefined })}
						currentUser={currentUser}
						showGrabButton={false}
					/>
				</Property>

				<Property label="Labels" wide>
					<div className="flex flex-wrap items-center gap-1.5">
						{labels.map((label) => (
							<Tag key={label} size="sm" onRemove={() => onSave({ labels: labels.filter((l) => l !== label) })} disabled={saving}>
								{label}
							</Tag>
						))}
						{!addingLabel && (
							<button
								type="button"
								onClick={() => setAddingLabel(true)}
								className={cn(
									"inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12.5px] text-muted-foreground transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] hover:text-foreground",
									focusRing,
								)}
							>
								<Plus className="size-3.5" aria-hidden />
								Add label
							</button>
						)}
					</div>
					{addingLabel && (
						<div className="flex items-center gap-2">
							<Input
								size="sm"
								value={newLabel}
								onChange={(e) => setNewLabel(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && newLabel.trim()) handleAddLabel();
									if (e.key === "Escape") {
										e.stopPropagation();
										setNewLabel("");
										setAddingLabel(false);
									}
								}}
								placeholder="Label name"
								aria-label="New label"
								className="min-w-0 flex-1"
								autoFocus
							/>
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
					)}
				</Property>

				{task.spec && (
					<Property label="Linked Spec" wide>
						<button
							type="button"
							onClick={() => navigateTo(`/docs/${task.spec}.md`)}
							title={`@doc/${task.spec}`}
							className={cn(
								"-mx-2 flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13.5px] text-foreground transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]",
								focusRing,
							)}
						>
							<FileText className="size-4 flex-none text-muted-foreground" aria-hidden />
							<span className="min-w-0 flex-1 truncate">{task.spec.split("/").pop()}</span>
							<ArrowUpRight className="size-3.5 flex-none text-muted-foreground" aria-hidden />
						</button>
					</Property>
				)}

				{parentTask && (
					<Property label="Parent Task" wide>
						<div className="flex items-center gap-1">
							<CornerLeftUp className="size-3.5 flex-none text-muted-foreground" aria-hidden />
							<TaskLink task={parentTask} onOpen={onNavigateToTask} />
						</div>
					</Property>
				)}

				{subtasks.length > 0 && (
					<Property label={`Subtasks ${subtasksDone}/${subtasks.length}`} wide>
						<ul className="flex max-h-60 flex-col overflow-y-auto overscroll-contain">
							{subtasks.map((subtask) => (
								<li key={subtask.id} className="flex">
									<TaskLink task={subtask} onOpen={onNavigateToTask} done={subtask.status === "done"} />
								</li>
							))}
						</ul>
					</Property>
				)}

				<Property label="Lifecycle" wide>
					<div className="flex flex-col items-start gap-1.5" role="group" aria-label="Task lifecycle">
						<TaskLifecycleBadge state={task.lifecycleState} />
						<TaskLifecycleTimestamps task={task} compact />
					</div>
				</Property>
			</div>
		</div>
	);
}
