import { Clock3, UserRound } from "lucide-react";
import type { Task } from "@/ui/models/task";
import {
	LabelList,
	PriorityBadge,
	TaskStatusIcon,
} from "@/ui/components/molecules";
import { TaskLifecycleBadge } from "@/ui/components/molecules/TaskLifecycleBadge";

interface TaskTableViewProps {
	tasks: Task[];
	onTaskClick: (task: Task) => void;
}

function formatUpdatedAt(value: Date) {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return "—";
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
	}).format(date);
}

export function TaskTableView({ tasks, onTaskClick }: TaskTableViewProps) {
	return (
		<div
			className="h-full min-h-0 overflow-auto"
			data-testid="task-table-view"
		>
			<table className="w-full min-w-[920px] border-separate border-spacing-0 text-left">
				<thead className="sticky top-0 z-10 bg-background">
					<tr className="h-10 bg-muted/45 text-xs font-medium text-muted-foreground">
						<th className="w-[42%] border-b border-border/35 px-3 font-medium">Task</th>
						<th className="w-40 border-b border-border/35 px-3 font-medium">Status</th>
						<th className="w-28 border-b border-border/35 px-3 font-medium">Priority</th>
						<th className="w-44 border-b border-border/35 px-3 font-medium">Assignee</th>
						<th className="border-b border-border/35 px-3 font-medium">Labels</th>
						<th className="w-32 border-b border-border/35 px-3 text-right font-medium">Updated</th>
					</tr>
				</thead>
				<tbody>
					{tasks.map((task) => (
						<tr
							key={task.id}
							className="group h-10 cursor-pointer transition-colors hover:bg-muted/35"
							onClick={() => onTaskClick(task)}
						>
							<td className="border-b border-border/30 px-3">
								<button
									type="button"
									className="flex h-10 w-full min-w-0 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									onClick={(event) => {
										event.stopPropagation();
										onTaskClick(task);
									}}
								>
									<span className="w-16 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
										#{task.id}
									</span>
									<span className="min-w-0 truncate text-sm font-medium">
										{task.title}
									</span>
									<TaskLifecycleBadge state={task.lifecycleState} />
								</button>
							</td>
							<td className="border-b border-border/30 px-3">
								<TaskStatusIcon status={task.status} showLabel />
							</td>
							<td className="border-b border-border/30 px-3">
								<PriorityBadge priority={task.priority} />
							</td>
							<td className="border-b border-border/30 px-3">
								{task.assignee ? (
									<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
										<UserRound className="size-3.5" />
										{task.assignee}
									</span>
								) : (
									<span className="text-xs text-muted-foreground/55">Unassigned</span>
								)}
							</td>
							<td className="border-b border-border/30 px-3">
								{task.labels.length > 0 ? (
									<LabelList labels={task.labels} maxVisible={2} />
								) : (
									<span className="text-xs text-muted-foreground/55">—</span>
								)}
							</td>
							<td className="border-b border-border/30 px-3 text-right">
								<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
									<Clock3 className="size-3.5" />
									{formatUpdatedAt(task.updatedAt)}
								</span>
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{tasks.length === 0 && (
				<div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
					No Tasks match the current filters.
				</div>
			)}
		</div>
	);
}
