import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X, Plus, FileText, ClipboardList, ChevronRight } from "lucide-react";
import type { Task } from "@/ui/models/task";
import { Input } from "@/ui/components/ui/input";
import { Button } from "@/ui/components/ui/button";
import { StatusBadge, PriorityBadge, LabelList } from "@/ui/components/molecules";
import { useConfig } from "@/ui/contexts/ConfigContext";
import { buildStatusOptions } from "@/ui/utils/colors";
import { useNewTaskIds } from "@/ui/hooks/useNewTaskIds";
import { navigateTo } from "../../lib/navigation";
import { cn } from "@/ui/lib/utils";
import { TaskLifecycleBadge } from "../molecules/TaskLifecycleBadge";

interface TaskNotionListProps {
	tasks: Task[];
	onTaskClick: (task: Task) => void;
	onNewTask?: () => void;
}

export function TaskNotionList({ tasks, onTaskClick, onNewTask }: TaskNotionListProps) {
	const { config } = useConfig();
	const newTaskIds = useNewTaskIds(tasks);
	const [searchQuery, setSearchQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState<string>("all");
	const [priorityFilter, setPriorityFilter] = useState<string>("all");

	const statusOptions = useMemo(() => {
		const statuses = config.statuses || ["todo", "in-progress", "in-review", "done", "blocked"];
		return buildStatusOptions(statuses);
	}, [config.statuses]);

	const filteredTasks = useMemo(() => {
		let result = tasks;

		if (searchQuery) {
			const q = searchQuery.toLowerCase();
			result = result.filter(
				(t) =>
					t.id.toLowerCase().includes(q) ||
					t.title.toLowerCase().includes(q) ||
					t.description?.toLowerCase().includes(q) ||
					t.assignee?.toLowerCase().includes(q) ||
					(t.labels ?? []).some((l: string) => l.toLowerCase().includes(q)),
			);
		}

		if (statusFilter !== "all") {
			result = result.filter((t) => t.status === statusFilter);
		}
		if (priorityFilter !== "all") {
			result = result.filter((t) => t.priority === priorityFilter);
		}

		return result;
	}, [tasks, searchQuery, statusFilter, priorityFilter]);

	// Sort within each group: priority high→low, then by order, then by id
	const sortTasks = useCallback((list: Task[]) => {
		const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
		return [...list].sort((a, b) => {
			const pa = priorityOrder[a.priority] ?? 1;
			const pb = priorityOrder[b.priority] ?? 1;
			if (pa !== pb) return pa - pb;
			if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
			if (a.order !== undefined) return -1;
			if (b.order !== undefined) return 1;
			return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
		});
	}, []);

	// Group tasks by status, following config status order
	const groupedTasks = useMemo(() => {
		const statuses = config.statuses || ["todo", "in-progress", "in-review", "done", "blocked"];
		const groups: { status: string; label: string; tasks: Task[] }[] = [];
		const tasksByStatus = new Map<string, Task[]>();

		for (const t of filteredTasks) {
			const list = tasksByStatus.get(t.status) || [];
			list.push(t);
			tasksByStatus.set(t.status, list);
		}

		// Follow config order, then any remaining statuses
		const seen = new Set<string>();
		for (const s of statuses) {
			seen.add(s);
			const list = tasksByStatus.get(s);
			if (list && list.length > 0) {
				const opt = statusOptions.find((o) => o.value === s);
				groups.push({ status: s, label: opt?.label || s, tasks: sortTasks(list) });
			}
		}
		for (const [s, list] of tasksByStatus) {
			if (!seen.has(s) && list.length > 0) {
				const opt = statusOptions.find((o) => o.value === s);
				groups.push({ status: s, label: opt?.label || s, tasks: sortTasks(list) });
			}
		}

		return groups;
	}, [filteredTasks, config.statuses, statusOptions, sortTasks]);

	const isFiltered = searchQuery || statusFilter !== "all" || priorityFilter !== "all";

	// Collapsed groups
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
	const toggleGroup = useCallback((status: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(status)) next.delete(status);
			else next.add(status);
			return next;
		});
	}, []);

	// Progressive rendering — load 30 at a time across all visible groups
	const BATCH_SIZE = 30;
	const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
	const scrollRef = useRef<HTMLDivElement>(null);

	// Reset visible count when filters change
	useEffect(() => {
		setVisibleCount(BATCH_SIZE);
	}, [searchQuery, statusFilter, priorityFilter]);

	// Flatten visible tasks across groups for lazy loading
	const { visibleGroups, totalVisible, totalTasks, hasMore } = useMemo(() => {
		let remaining = visibleCount;
		let total = 0;
		const result: { status: string; label: string; tasks: Task[]; totalInGroup: number }[] = [];

		for (const group of groupedTasks) {
			total += group.tasks.length;
			if (collapsedGroups.has(group.status)) {
				result.push({ ...group, tasks: [], totalInGroup: group.tasks.length });
				continue;
			}
			const slice = group.tasks.slice(0, remaining);
			result.push({ ...group, tasks: slice, totalInGroup: group.tasks.length });
			remaining -= slice.length;
			if (remaining <= 0) break;
		}

		return {
			visibleGroups: result,
			totalVisible: visibleCount - Math.max(remaining, 0),
			totalTasks: total,
			hasMore: visibleCount < total,
		};
	}, [groupedTasks, visibleCount, collapsedGroups]);

	const handleScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el || !hasMore) return;
		if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
			setVisibleCount((prev) => Math.min(prev + BATCH_SIZE, totalTasks));
		}
	}, [hasMore, totalTasks]);

	return (
		<div className="h-full flex flex-col">
			{/* Filter bar — pill style */}
			<div className="flex items-center gap-2 flex-wrap mb-4">
				<div className="relative flex-1 min-w-[180px] max-w-[280px]">
					<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
					<Input
						placeholder="Search..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-8 h-8 text-sm rounded-lg border-border/40 bg-background"
					/>
					{searchQuery && (
						<button
							type="button"
							onClick={() => setSearchQuery("")}
							className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
						>
							<X className="h-3 w-3" />
						</button>
					)}
				</div>

				{/* Status pills */}
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={() => setStatusFilter("all")}
						className={cn(
							"px-2.5 py-1 rounded-full text-xs transition-colors",
							statusFilter === "all"
								? "bg-foreground text-background"
								: "bg-muted/60 text-muted-foreground hover:bg-muted",
						)}
					>
						All
					</button>
					{statusOptions.map((opt) => (
						<button
							key={opt.value}
							type="button"
							onClick={() => setStatusFilter(statusFilter === opt.value ? "all" : opt.value)}
							className={cn(
								"px-2.5 py-1 rounded-full text-xs transition-colors",
								statusFilter === opt.value
									? "bg-foreground text-background"
									: "bg-muted/60 text-muted-foreground hover:bg-muted",
							)}
						>
							{opt.label}
						</button>
					))}
				</div>

				{/* Priority pills */}
				<div className="flex items-center gap-1">
					{(["high", "medium", "low"] as const).map((p) => (
						<button
							key={p}
							type="button"
							onClick={() => setPriorityFilter(priorityFilter === p ? "all" : p)}
							className={cn(
								"px-2.5 py-1 rounded-full text-xs capitalize transition-colors",
								priorityFilter === p
									? "bg-foreground text-background"
									: "bg-muted/60 text-muted-foreground hover:bg-muted",
							)}
						>
							{p}
						</button>
					))}
				</div>

				{isFiltered && (
					<button
						type="button"
						onClick={() => {
							setSearchQuery("");
							setStatusFilter("all");
							setPriorityFilter("all");
						}}
						className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5"
					>
						<X className="h-3 w-3" />
						Clear
					</button>
				)}

				<div className="flex-1" />

				<span className="text-xs text-muted-foreground">
					{filteredTasks.length} task{filteredTasks.length !== 1 ? "s" : ""}
				</span>

				{onNewTask && (
					<Button onClick={onNewTask} size="sm" variant="ghost" className="h-7 gap-1 text-xs">
						<Plus className="h-3.5 w-3.5" />
						New
					</Button>
				)}
			</div>

			{/* Task list — grouped by status */}
			<div
				ref={scrollRef}
				onScroll={handleScroll}
				className="flex-1 overflow-y-auto -mx-2"
			>
				{groupedTasks.length === 0 ? (
					<div className="text-center py-16">
						<p className="text-sm text-muted-foreground">
							{isFiltered ? "No tasks match your filters." : "No tasks yet."}
						</p>
					</div>
				) : (
					<div className="space-y-1">
						{visibleGroups.map((group) => (
							<div key={group.status}>
								{/* Group header */}
								<button
									type="button"
									onClick={() => toggleGroup(group.status)}
									className="flex items-center gap-2 w-full px-3 py-2 text-left rounded-md hover:bg-muted/40 transition-colors"
								>
									<ChevronRight
										className={cn(
											"h-3.5 w-3.5 text-muted-foreground/60 transition-transform",
											!collapsedGroups.has(group.status) && "rotate-90",
										)}
									/>
									<StatusBadge status={group.status} />
									<span className="text-xs text-muted-foreground/60">
										{group.totalInGroup}
									</span>
								</button>

								{/* Group tasks */}
								{!collapsedGroups.has(group.status) && group.tasks.length > 0 && (
									<div className="ml-2">
										{group.tasks.map((task) => (
											<TaskRow
												key={task.id}
												task={task}
												isNew={newTaskIds.has(task.id)}
												onClick={() => onTaskClick(task)}
											/>
										))}
									</div>
								)}
							</div>
						))}
						{hasMore && (
							<div className="py-3 text-center text-xs text-muted-foreground/60">
								Loading more...
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}


function TaskRow({ task, isNew, onClick }: { task: Task; isNew?: boolean; onClick: () => void }) {
	const criteria = task.acceptanceCriteria ?? [];
	const acCompleted = criteria.filter((c: { completed: boolean }) => c.completed).length;
	const acTotal = criteria.length;

	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-lg transition-colors hover:bg-muted/50 group",
				isNew && "animate-[fade-in-up_0.5s_ease-out] bg-primary/5",
			)}
		>
			{/* Title + description */}
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium truncate">{task.title}</span>
					<span className="text-[11px] font-mono text-muted-foreground/60 shrink-0">
						#{task.id}
					</span>
					<TaskLifecycleBadge state={task.lifecycleState} />
				</div>
				{task.description && (
					<p className="text-xs text-muted-foreground truncate mt-0.5 max-w-lg">
						{task.description}
					</p>
				)}
			</div>

			{/* Properties — right side */}
			<div className="flex items-center gap-2 shrink-0">
				{/* Labels */}
				{(task.labels ?? []).length > 0 && (
					<div className="hidden sm:block" onClick={(e) => e.stopPropagation()}>
						<LabelList labels={task.labels} maxVisible={2} />
					</div>
				)}

				{/* Spec link */}
				{task.spec && (
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							navigateTo(`/docs/${task.spec}.md`);
						}}
						className="hidden md:flex items-center gap-1 text-[11px] text-purple-600 dark:text-purple-400 hover:underline shrink-0"
						title={`@doc/${task.spec}`}
					>
						<FileText className="w-3 h-3" />
						{task.spec.split("/").pop()}
					</button>
				)}

				{/* AC progress */}
				{acTotal > 0 && (
					<span className="hidden sm:flex items-center gap-1 text-[11px] text-muted-foreground shrink-0">
						<ClipboardList className="w-3 h-3" />
						{acCompleted}/{acTotal}
					</span>
				)}

				{/* Assignee */}
				{task.assignee && (
					<span className="hidden lg:block text-[11px] font-mono text-muted-foreground shrink-0">
						{task.assignee}
					</span>
				)}

				{/* Priority */}
				<div className="shrink-0" onClick={(e) => e.stopPropagation()}>
					<PriorityBadge priority={task.priority} />
				</div>
			</div>
		</button>
	);
}
