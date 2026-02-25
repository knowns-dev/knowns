import { useMemo, useState } from "react";
import { Plus, Filter, ClipboardList } from "lucide-react";
import type { Task } from "@/models/task";
import { ScrollArea } from "@/ui/components/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/ui/components/ui/select";
import { Button } from "@/ui/components/ui/button";
import { StatusBadge, PriorityBadge, LabelList } from "@/ui/components/molecules";
import { useConfig } from "@/ui/contexts/ConfigContext";
import { getStatusLabel, buildStatusOptions } from "@/ui/utils/colors";

interface TaskGroupedViewProps {
	tasks: Task[];
	onTaskClick: (task: Task) => void;
	onNewTask: () => void;
}

export function TaskGroupedView({ tasks, onTaskClick, onNewTask }: TaskGroupedViewProps) {
	const { config } = useConfig();
	const [statusFilter, setStatusFilter] = useState<string>("all");
	const [parentFilter, setParentFilter] = useState<string>("all");
	const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());

	// Get statuses from config
	const availableStatuses = useMemo(() => {
		return (config?.statuses as string[]) || ["todo", "in-progress", "in-review", "done", "blocked"];
	}, [config?.statuses]);

	// Build status options for filter dropdown
	const statusOptions = useMemo(() => {
		return buildStatusOptions(availableStatuses);
	}, [availableStatuses]);

	// Get list of parent tasks (tasks that have subtasks)
	const parentTasks = tasks.filter((t) => t.subtasks && t.subtasks.length > 0);

	// Filter tasks by status and parent
	let filteredTasks = statusFilter === "all" ? tasks : tasks.filter((t) => t.status === statusFilter);

	// Apply parent filter
	if (parentFilter === "root") {
		filteredTasks = filteredTasks.filter((t) => !t.parent);
	} else if (parentFilter !== "all") {
		filteredTasks = filteredTasks.filter((t) => t.parent === parentFilter);
	}

	// Group by status - dynamically from config
	const groupedTasks: Record<string, Task[]> = useMemo(() => {
		const groups: Record<string, Task[]> = {};
		// Initialize all statuses from config
		for (const status of availableStatuses) {
			groups[status] = [];
		}
		// Group filtered tasks
		for (const task of filteredTasks) {
			if (groups[task.status]) {
				groups[task.status].push(task);
			} else {
				// Handle tasks with unknown status (not in config)
				groups[task.status] = [task];
			}
		}
		// Sort by priority within each group
		const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
		for (const status in groups) {
			groups[status].sort((a, b) => {
				const diff = (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2);
				if (diff !== 0) return diff;
				return a.id.localeCompare(b.id, undefined, { numeric: true });
			});
		}
		return groups;
	}, [availableStatuses, filteredTasks]);

	return (
		<div className="h-full flex flex-col">
			{/* Toolbar */}
			<div className="flex items-center justify-between gap-4 mb-4">
				<div className="flex items-center gap-3 flex-wrap">
					<Filter className="w-4 h-4 text-muted-foreground" />

					{/* Status Filter */}
					<Select value={statusFilter} onValueChange={setStatusFilter}>
						<SelectTrigger className="w-[150px]">
							<SelectValue placeholder="Status" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All Status</SelectItem>
							{statusOptions.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>

					{/* Parent Filter */}
					<Select value={parentFilter} onValueChange={setParentFilter}>
						<SelectTrigger className="w-[200px]">
							<SelectValue placeholder="Parent" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All Tasks</SelectItem>
							<SelectItem value="root">Root Tasks Only</SelectItem>
							{parentTasks.map((parent) => {
								const fullText = `Subtasks of #${parent.id}: ${parent.title}`;
								const displayText = fullText.length > 40 ? fullText.substring(0, 40) + "..." : fullText;
								return (
									<SelectItem key={parent.id} value={parent.id} title={fullText}>
										{displayText}
									</SelectItem>
								);
							})}
						</SelectContent>
					</Select>

					<span className="text-muted-foreground text-sm">
						{filteredTasks.length} {filteredTasks.length === 1 ? "task" : "tasks"}
					</span>
				</div>

				<Button onClick={onNewTask} className="bg-green-700 hover:bg-green-800 text-white">
					<Plus className="mr-2 h-4 w-4" />
					New Task
				</Button>
			</div>

			{/* Task Groups */}
			<ScrollArea className="flex-1">
				<div className="space-y-6 pr-4">
					{Object.entries(groupedTasks).map(([status, statusTasks]) => {
						if (statusTasks.length === 0) return null;

						return (
							<div key={status}>
								<h2 className="text-lg font-semibold mb-3">
									{getStatusLabel(status)} ({statusTasks.length})
								</h2>
								<div className="space-y-2">
									{statusTasks.map((task) => {
										const isExpanded = expandedTasks.has(task.id);
										const parentTask = task.parent ? tasks.find((t) => t.id === task.parent) : null;

										return (
											<div
												key={task.id}
												className="bg-card rounded-lg p-4 border transition-colors hover:bg-accent/50"
											>
												<div className="flex items-start gap-3">
													{/* Task Info */}
													<div className="flex-1 min-w-0">
														<div className="flex items-center gap-2 mb-2 flex-wrap">
															<span className="text-xs text-muted-foreground font-mono">
																#{task.id}
															</span>
															<StatusBadge status={task.status} />
															<PriorityBadge priority={task.priority} />

															{/* Parent/Subtask badges */}
															{parentTask && (
																<span className="text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
																	Subtask of #{parentTask.id}
																</span>
															)}
															{task.subtasks && task.subtasks.length > 0 && (
																<span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
																	{task.subtasks.length} subtask{task.subtasks.length > 1 ? "s" : ""}
																</span>
															)}
														</div>

														<button
															type="button"
															onClick={() => onTaskClick(task)}
															className="font-medium mb-1 hover:underline text-left w-full"
														>
															{task.title}
														</button>

														{task.description && (
															<div className="text-sm text-muted-foreground mt-2">
																<p className={isExpanded ? "" : "line-clamp-2"}>
																	{task.description}
																</p>
																{task.description.length > 100 && (
																	<button
																		type="button"
																		onClick={(e) => {
																			e.stopPropagation();
																			const newExpanded = new Set(expandedTasks);
																			if (isExpanded) {
																				newExpanded.delete(task.id);
																			} else {
																				newExpanded.add(task.id);
																			}
																			setExpandedTasks(newExpanded);
																		}}
																		className="text-xs text-primary hover:underline mt-1 font-medium"
																	>
																		{isExpanded ? "Show less" : "Show more"}
																	</button>
																)}
															</div>
														)}

														{/* Acceptance Criteria Progress */}
														{task.acceptanceCriteria.length > 0 && (
															<div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
																<ClipboardList className="w-3 h-3" />
																<span>
																	{task.acceptanceCriteria.filter((ac) => ac.completed).length}/
																	{task.acceptanceCriteria.length} criteria
																</span>
															</div>
														)}

														{task.labels.length > 0 && (
															<div className="mt-2">
																<LabelList labels={task.labels} maxVisible={3} />
															</div>
														)}
													</div>

													{/* Assignee */}
													{task.assignee && (
														<span className="text-sm text-muted-foreground font-mono shrink-0">
															{task.assignee}
														</span>
													)}
												</div>
											</div>
										);
									})}
								</div>
							</div>
						);
					})}
					{filteredTasks.length === 0 && (
						<div className="text-center py-12">
							<p className="text-lg text-muted-foreground">No tasks found</p>
						</div>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
