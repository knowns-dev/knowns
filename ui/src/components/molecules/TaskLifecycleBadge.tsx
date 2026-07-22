import { Archive, CheckCircle2, Circle } from "lucide-react";
import type { Task, TaskLifecycleState } from "@/ui/models/task";
import { formatLifecycleState } from "@/ui/models/taskLifecycle";
import { cn } from "@/ui/lib/utils";

const styles: Record<TaskLifecycleState, string> = {
	active: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
	done: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
	archived: "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
};

export function TaskLifecycleBadge({ state, className }: { state: TaskLifecycleState; className?: string }) {
	const Icon = state === "archived" ? Archive : state === "done" ? CheckCircle2 : Circle;
	return (
		<span
			data-testid="task-lifecycle-state"
			className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", styles[state], className)}
		>
			<Icon className="h-3 w-3" aria-hidden="true" />
			{formatLifecycleState(state)}
		</span>
	);
}

export function TaskLifecycleTimestamps({ task, compact = false }: { task: Task; compact?: boolean }) {
	const values = [
		task.completedAt ? `Completed ${task.completedAt.toLocaleString()}` : null,
		task.archivedAt ? `Archived ${task.archivedAt.toLocaleString()}` : null,
	].filter(Boolean);
	if (values.length === 0) return null;
	return (
		<div className={cn("text-muted-foreground", compact ? "text-[11px]" : "space-y-1 text-xs")} data-testid="task-lifecycle-timestamps">
			{values.map((value) => <div key={value}>{value}</div>)}
		</div>
	);
}
