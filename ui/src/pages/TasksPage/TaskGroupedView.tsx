import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, ClipboardList } from "lucide-react";
import type { Task } from "@/ui/models/task";
import { Combobox } from "@/ui/components/ui/knowns/combobox";
import { Skeleton } from "@/ui/components/ui/knowns/skeleton";
import { Button } from "@/ui/components/ui/button";
import { StatusBadge, PriorityBadge, LabelList } from "@/ui/components/molecules";
import { PageError } from "@/ui/components/templates/PageShell";
import { ListTail } from "@/ui/components/molecules/ListTail";
import { useConfig } from "@/ui/contexts/ConfigContext";
import { useTaskColumns } from "@/ui/hooks/useTaskColumns";
import { useTaskCounts } from "@/ui/hooks/useTaskCounts";
import { getStatusLabel, buildStatusOptions } from "@/ui/utils/colors";
import { TaskLifecycleBadge } from "@/ui/components/molecules/TaskLifecycleBadge";
import type { TaskFilters } from "@/ui/api/client";
import { assigneeLabel, UNASSIGNED } from "./assignees";

interface TaskGroupedViewProps {
	/** Server-side filters from the page (assignee, lifecycle). */
	filters: TaskFilters;
	onTotal?: (total: number | null) => void;
	onTaskClick: (task: Task) => void;
	onNewTask: () => void;
}

const PAGE = 30;

function TaskRowSkeleton() {
	return (
		<div className="flex flex-col gap-2 px-2 py-2.5">
			<Skeleton className="h-4 w-2/3" />
			<Skeleton className="h-3 w-1/3" />
		</div>
	);
}

export function TaskGroupedView({ filters, onTotal, onTaskClick, onNewTask }: TaskGroupedViewProps) {
	const { config } = useConfig();
	const [groupBy, setGroupBy] = useState<"status" | "assignee">("status");
	const [statusFilter, setStatusFilter] = useState<string>("all");
	const [parentFilter, setParentFilter] = useState<string>("all");
	const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());

	const availableStatuses = useMemo(
		() => (config?.statuses as string[]) || ["todo", "in-progress", "in-review", "done", "blocked"],
		[config?.statuses],
	);
	const statusOptions = useMemo(() => buildStatusOptions(availableStatuses), [availableStatuses]);

	// Status and parent are server-side filters now; groups are server-paged lists like Kanban columns.
	const baseFilters = useMemo<TaskFilters>(
		() => ({ ...filters, ...(parentFilter === "root" ? { parent: "none" } : parentFilter !== "all" ? { parent: parentFilter } : {}) }),
		[filters, parentFilter],
	);
	// Counts ignore the status filter (the server does), so group headers stay honest.
	const { counts } = useTaskCounts(baseFilters);

	const groups = useMemo(() => {
		if (groupBy === "status") {
			return availableStatuses
				.filter((s) => statusFilter === "all" || s === statusFilter)
				.map((s) => ({ key: s, label: getStatusLabel(s), filters: { ...baseFilters, status: s } as TaskFilters, count: counts?.byStatus[s] }));
		}
		// By person: the people come from the counts (most tasks first, Unassigned last).
		const byAssignee = counts?.byAssignee ?? {};
		const people = Object.entries(byAssignee)
			.filter(([a]) => a !== "")
			.sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
			.map(([a, n]) => ({ key: a, label: assigneeLabel(a), filters: { ...baseFilters, assignee: a, ...(statusFilter !== "all" ? { status: statusFilter } : {}) } as TaskFilters, count: n }));
		if ((byAssignee[""] ?? 0) > 0) {
			people.push({ key: UNASSIGNED, label: assigneeLabel(UNASSIGNED), filters: { ...baseFilters, unassigned: true, ...(statusFilter !== "all" ? { status: statusFilter } : {}) } as TaskFilters, count: byAssignee[""] as number });
		}
		return people;
	}, [groupBy, availableStatuses, statusFilter, baseFilters, counts]);

	const keys = useMemo(() => groups.map((g) => g.key), [groups]);
	const filtersByKey = useMemo(() => new Map(groups.map((g) => [g.key, g.filters])), [groups]);
	const filtersFor = useCallback((key: string): TaskFilters => filtersByKey.get(key) ?? baseFilters, [filtersByKey, baseFilters]);
	const feeds = useTaskColumns({ keys, filtersFor, sort: "order", pageSize: PAGE, enabled: groupBy === "status" || counts !== null });

	const total = useMemo(() => {
		if (!counts) return null;
		return statusFilter === "all" ? counts.total : (counts.byStatus[statusFilter] ?? 0);
	}, [counts, statusFilter]);
	const failed = keys.some((k) => feeds.column(k).status === "error" && feeds.column(k).items.length === 0);
	useEffect(() => onTotal?.(failed ? null : total), [total, failed, onTotal]);

	// Parents to filter by: those among the Tasks loaded so far that have subtasks.
	const parentTasks = feeds.all.filter((t) => t.subtasks && t.subtasks.length > 0);
	const byId = useMemo(() => new Map(feeds.all.map((t) => [t.id, t])), [feeds.all]);

	return (
		<div className="h-full flex flex-col">
			{/* Toolbar */}
			<div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 sm:gap-4 mb-6">
				<div className="flex items-center gap-2 sm:gap-3 flex-wrap">
					<Combobox
						aria-label="Group by"
						value={groupBy}
						onValueChange={(value) => setGroupBy(value as typeof groupBy)}
						options={[
							{ value: "status", label: "Group by Status" },
							{ value: "assignee", label: "Group by Assignee" },
						]}
						className="w-[150px] sm:w-[170px] text-sm"
					/>
					<Combobox
						aria-label="Status"
						value={statusFilter}
						onValueChange={setStatusFilter}
						options={[{ value: "all", label: "All Status" }, ...statusOptions]}
						className="w-[100px] sm:w-[130px] text-sm"
					/>
					<Combobox
						aria-label="Parent"
						searchable
						value={parentFilter}
						onValueChange={setParentFilter}
						options={[
							{ value: "all", label: "All Tasks" },
							{ value: "root", label: "Root Tasks Only" },
							...(parentFilter !== "all" && parentFilter !== "root" && !parentTasks.some((p) => p.id === parentFilter)
								? [{ value: parentFilter, label: `Subtasks of #${parentFilter}`, supportingText: `#${parentFilter}` }]
								: []),
							...parentTasks.map((parent) => ({ value: parent.id, label: `Subtasks of ${parent.title}`, supportingText: `#${parent.id}` })),
						]}
						className="w-[130px] sm:w-[180px] text-sm"
					/>
					<span className="text-muted-foreground text-xs">
						{total ?? "..."} {total === 1 ? "task" : "tasks"}
					</span>
				</div>
				<Button onClick={onNewTask} size="sm" className="shrink-0 w-full sm:w-auto gap-1.5">
					<Plus className="h-4 w-4" />
					New Task
				</Button>
			</div>

			{/* Task Groups: the container scrolls, each group pages as its end comes near */}
			{keys.some((k) => feeds.column(k).status === "error" && feeds.column(k).items.length === 0) && (
				<PageError
					description={keys.map((k) => feeds.column(k).error).find(Boolean) ?? undefined}
					onRetry={() => keys.forEach((k) => feeds.retry(k))}
					className="flex-1"
				/>
			)}
			<div className="flex-1 min-h-0 overflow-y-auto">
				<div className="space-y-8 pr-4">
					{groups.map((group) => {
						const col = feeds.column(group.key);
						const n = group.count ?? col.total;
						if (col.status === "ready" && col.items.length === 0 && n === 0) return null;
						return (
							<div key={group.key}>
								<h2 className="text-lg font-semibold mb-1">
									{group.label}
									<span className="text-sm font-normal text-muted-foreground ml-2">{n}</span>
								</h2>
								<div className="border-t border-border/40 pt-2">
									{col.items.map((task) => {
										const isExpanded = expandedTasks.has(task.id);
										const parentTask = task.parent ? byId.get(task.parent) : null;
										const text = task.description ?? task.descriptionPreview;
										return (
											<div key={task.id} className="py-2.5 px-2 -mx-2 rounded-md transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:bg-muted/50">
												<div className="flex items-start gap-3">
													<div className="flex-1 min-w-0">
														<div className="flex items-center gap-2 mb-1 flex-wrap">
															<button type="button" onClick={() => onTaskClick(task)} className="font-medium text-sm hover:underline text-left">
																{task.title}
															</button>
															<span className="text-xs text-muted-foreground font-mono">#{task.id}</span>
															<TaskLifecycleBadge state={task.lifecycleState} />
														</div>
														<div className="flex items-center gap-2 flex-wrap">
															<StatusBadge status={task.status} />
															<PriorityBadge priority={task.priority} />
															{task.parent && (
																<span className="text-xs px-1.5 py-0.5 rounded bg-purple-100/60 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400">
																	↑ #{parentTask?.id ?? task.parent}
																</span>
															)}
															{task.subtasks && task.subtasks.length > 0 && (
																<span className="text-xs text-muted-foreground">
																	{task.subtasks.length} subtask{task.subtasks.length > 1 ? "s" : ""}
																</span>
															)}
															{(task.acceptanceCriteria ?? []).length > 0 && (
																<span className="flex items-center gap-1 text-xs text-muted-foreground">
																	<ClipboardList className="w-3 h-3" />
																	{(task.acceptanceCriteria ?? []).filter((ac) => ac.completed).length}/{(task.acceptanceCriteria ?? []).length}
																</span>
															)}
														</div>
														{text && (
															<div className="text-sm text-muted-foreground mt-1.5">
																<p className={isExpanded ? "" : "line-clamp-2"}>{text}</p>
																{text.length > 100 && (
																	<button
																		type="button"
																		onClick={(e) => {
																			e.stopPropagation();
																			const next = new Set(expandedTasks);
																			if (isExpanded) next.delete(task.id);
																			else next.add(task.id);
																			setExpandedTasks(next);
																		}}
																		className="text-xs text-muted-foreground hover:text-foreground mt-1 font-medium"
																	>
																		{isExpanded ? "Show less" : "Show more"}
																	</button>
																)}
															</div>
														)}
														{(task.labels ?? []).length > 0 && (
															<div className="mt-1.5">
																<LabelList labels={task.labels} maxVisible={3} />
															</div>
														)}
													</div>
													{task.assignee && <span className="text-xs text-muted-foreground font-mono shrink-0 mt-1">{task.assignee}</span>}
												</div>
											</div>
										);
									})}
									<ListTail
										hasMore={col.hasMore}
										busy={col.status === "loadingMore" || col.status === "loading"}
										error={col.error}
										count={col.items.length}
										onMore={() => feeds.loadMore(group.key)}
										onRetry={() => feeds.retry(group.key)}
										skeleton={<TaskRowSkeleton />}
										skeletonCount={col.items.length === 0 ? 3 : 2}
									/>
								</div>
							</div>
						);
					})}
					{total === 0 && (
						<div className="text-center py-12">
							<p className="text-sm text-muted-foreground">No tasks found</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
