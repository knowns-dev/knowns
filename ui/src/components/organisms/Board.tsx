// The Tasks board, on Knowns UI's KanbanBoard: keyboard and touch drag that saves status and order,
// swimlanes per assignee that reassign, quick add, and column visibility saved to config.
import { useCallback, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, FileText } from "lucide-react";
import type { Task, TaskStatus } from "@/ui/models/task";
import { getTaskLifecycleState } from "@/ui/models/taskLifecycle";
import { cn } from "@/ui/lib/utils";
import { agentIcon, agentName } from "@/ui/lib/agent";
import { PageError } from "@/ui/components/templates/PageShell";
import { CardSkeleton, ListTail } from "../molecules/ListTail";
import { useTaskColumns } from "../../hooks/useTaskColumns";
import { useTaskCounts } from "../../hooks/useTaskCounts";
import type { TaskFilters } from "../../api/client";
import { TaskLifecycleBadge } from "../molecules/TaskLifecycleBadge";
import { api } from "../../api/client";
import { useConfig } from "../../contexts/ConfigContext";
import { DEFAULT_STATUS_COLORS, type ColorName } from "../../utils/colors";
import { toast } from "../ui/sonner";
import { useIsMobile } from "../../hooks/useMobile";
import { KanbanBoard } from "../ui/knowns/kanban/kanban-board";
import type {
	KanbanCard,
	KanbanColumn,
	KanbanMove,
	KanbanPerson,
} from "../ui/knowns/kanban/types";

const DEFAULT_COLUMN_LABELS: Record<string, string> = {
	todo: "To Do",
	"in-progress": "In Progress",
	"in-review": "In Review",
	done: "Done",
	blocked: "Blocked",
	"on-hold": "On Hold",
};

function columnLabel(status: string): string {
	return (
		DEFAULT_COLUMN_LABELS[status] ??
		status
			.split("-")
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ")
	);
}

type Tone = NonNullable<KanbanColumn["tone"]>;

const TONE_BY_COLOR: Partial<Record<ColorName, Tone>> = {
	gray: "neutral",
	blue: "info",
	green: "success",
	yellow: "warning",
	orange: "warning",
	red: "danger",
	purple: "accent",
};

const PRIORITY_TONE: Record<string, Tone> = { high: "danger", medium: "warning", low: "neutral" };
function toCard(task: Task): KanbanCard {
	const ac = task.acceptanceCriteria ?? [];
	return {
		id: task.id,
		column: task.status,
		title: task.title,
		key: `#${task.id}`,
		labels: [
			{ text: task.priority, tone: PRIORITY_TONE[task.priority] ?? "neutral" },
			...(task.labels ?? []).slice(0, 2).map((text) => ({ text })),
		],
		...(task.assignee ? { assignee: task.assignee } : {}),
		...(ac.length > 0
			? { checklist: { done: ac.filter((a) => a.completed).length, total: ac.length } }
			: {}),
		...(task.status === "blocked"
			? { state: "blocked" as const }
			: task.workedBy?.active
				? { state: "busy" as const }
				: {}),
		...(hasFooter(task) ? { footer: <CardFooter task={task} /> } : {}),
	};
}

const hasFooter = (task: Task) =>
	!!task.workedBy ||
	!!task.description || !!task.descriptionPreview || !!task.spec || getTaskLifecycleState(task) !== "active";

/** What the old board showed under the title: description, spec link, and a non-active lifecycle. */
function CardFooter({ task }: { task: Task }) {
	const lifecycle = getTaskLifecycleState(task);
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			{task.workedBy && (
				<span
					data-testid="worked-by"
					title={`Worked by ${agentName(task.workedBy.client)}${task.workedBy.active ? "" : " (timer not running)"}`}
					className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
				>
					<span aria-hidden className="grid size-4 flex-none place-items-center [&>*]:size-full [&_svg]:size-full">
						{agentIcon(task.workedBy.client)}
					</span>
					<span className="truncate">{agentName(task.workedBy.client)}</span>
				</span>
			)}
			{(task.description ?? task.descriptionPreview) && (
				<p className="line-clamp-2 text-xs leading-4 text-muted-foreground">{task.description ?? task.descriptionPreview}</p>
			)}
			{(task.spec || lifecycle !== "active") && (
				<div className="flex min-w-0 flex-wrap items-center gap-1.5">
					{task.spec && (
						<a
							href={`/docs/${task.spec}`}
							className="flex min-w-0 items-center gap-1 text-xs text-purple-600 hover:underline dark:text-purple-400"
						>
							<FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
							<span className="truncate">{task.spec.replace(/^specs\//, "")}</span>
						</a>
					)}
					{lifecycle !== "active" && <TaskLifecycleBadge state={task.lifecycleState} />}
				</div>
			)}
		</div>
	);
}

/** Cards a column asks for per page; the next page loads as its scroll nears the end. */
const COLUMN_PAGE = 20;

interface BoardProps {
	/** Server-side filters shared by every column (the assignee picker); status is the column's. */
	filters?: TaskFilters;
	onTaskClick: (task: Task) => void;
	/** Called when a local change (a created card) makes the rest of the page worth refreshing. */
	onChanged?: () => void;
}

const NO_FILTERS: TaskFilters = {};

export default function Board({ filters = NO_FILTERS, onTaskClick, onChanged }: BoardProps) {
	const { config, updateConfig } = useConfig();
	const isMobile = useIsMobile();
	const statuses = (config?.statuses as TaskStatus[]) || ["todo", "in-progress", "in-review", "done", "blocked"];
	// Settings can save an empty or stale list (every column unticked, a status removed): show all then,
	// since a board with no columns has nothing to drop onto.
	const saved = ((config?.visibleColumns as TaskStatus[] | undefined) ?? []).filter((s) => statuses.includes(s));
	const visible = new Set(config?.visibleColumns && saved.length > 0 ? saved : statuses);
	const visibleStatuses = useMemo(() => statuses.filter((s) => visible.has(s)), [statuses.join("|"), [...visible].join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

	// Each visible column is its own server-paged list in the user's manual order (sort=order).
	const filtersFor = useCallback((status: string): TaskFilters => ({ ...filters, status }), [filters]);
	const feeds = useTaskColumns({ keys: visibleStatuses, filtersFor, sort: "board", pageSize: COLUMN_PAGE });
	const { counts, refresh: refreshCounts } = useTaskCounts(filters);

	const toggleColumn = (status: TaskStatus) => {
		const next = new Set(visible);
		if (next.has(status)) next.delete(status);
		else next.add(status);
		// Keep the configured order; at least one column stays visible.
		if (next.size === 0) return;
		updateConfig({ visibleColumns: statuses.filter((s) => next.has(s)) }).catch((err: unknown) =>
			toast.error("Failed to save columns", { description: err instanceof Error ? err.message : String(err) }),
		);
	};

	const countFor = useCallback(
		(status: string) => counts?.byStatus[status] ?? (visibleStatuses.includes(status as TaskStatus) ? feeds.column(status).total : 0),
		[counts, feeds, visibleStatuses],
	);

	const columnToggles = (
		<div
			className="-mx-1 flex max-w-full items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible"
			role="group"
			aria-label="Visible columns"
		>
			{statuses.map((status) => {
				const on = visible.has(status);
				return (
					<button
						key={status}
						type="button"
						aria-pressed={on}
						onClick={() => toggleColumn(status)}
						className={cn(
							"flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							on ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
						)}
					>
						{on ? <Eye className="h-3.5 w-3.5" aria-hidden="true" /> : <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />}
						<span>
							{columnLabel(status)} <span className="tabular-nums text-muted-foreground">{countFor(status)}</span>
						</span>
					</button>
				);
			})}
		</div>
	);
	const statusColors = (config?.statusColors as Record<string, ColorName>) || DEFAULT_STATUS_COLORS;

	const columns: KanbanColumn[] = visibleStatuses.map((s) => ({
		id: s,
		title: columnLabel(s),
		tone: TONE_BY_COLOR[statusColors[s] ?? "gray"] ?? "neutral",
	}));

	const loadedTasks = feeds.all;
	const cards = useMemo(() => visibleStatuses.flatMap((s) => feeds.column(s).items.map(toCard)), [feeds, visibleStatuses]);
	const columnCounts = useMemo(() => Object.fromEntries(visibleStatuses.map((s) => [s, countFor(s)])), [visibleStatuses, countFor]);

	// Skeleton cards where the next page lands, a sentinel a little before the end of the column's own
	// scroll, and a retry if the last page failed. A finished column renders nothing here.
	const renderColumnFooter = useCallback(
		(column: KanbanColumn) => {
			const col = feeds.column(column.id);
			if (col.status === "loading" && col.items.length === 0) {
				return <ListTail hasMore busy error={null} count={0} onMore={() => {}} onRetry={() => feeds.retry(column.id)} skeleton={<CardSkeleton />} skeletonCount={3} />;
			}
			return (
				<ListTail
					hasMore={col.hasMore}
					busy={col.status === "loadingMore" || col.status === "loading"}
					error={col.error}
					count={col.items.length}
					onMore={() => feeds.loadMore(column.id)}
					onRetry={() => feeds.retry(column.id)}
					skeleton={<CardSkeleton />}
					skeletonCount={2}
				/>
			);
		},
		[feeds],
	);

	const people: KanbanPerson[] = useMemo(() => {
		const ids = [...new Set(loadedTasks.map((t) => t.assignee).filter((a): a is string => !!a))];
		return ids.map((id) => ({ id, name: id.replace(/^@/, "") }));
	}, [loadedTasks]);

	const tasksRef = useRef(loadedTasks);
	tasksRef.current = loadedTasks;
	const feedsRef = useRef(feeds);
	feedsRef.current = feeds;

	const reconcile = useCallback(() => {
		feedsRef.current.refresh();
		refreshCounts();
	}, [refreshCounts]);

	// Swimlane moves reassign: the board reports them only through onCardsChange.
	const handleCardsChange = useCallback(
		(next: KanbanCard[]) => {
			const byId = new Map(tasksRef.current.map((t) => [t.id, t]));
			for (const card of next) {
				const task = byId.get(card.id);
				if (!task || (task.assignee ?? undefined) === (card.assignee ?? undefined)) continue;
				feedsRef.current.patch({ ...task, assignee: card.assignee });
				api
					.updateTask(task.id, { assignee: card.assignee ?? "" })
					.catch((err: unknown) => {
						toast.error("Failed to reassign", { description: err instanceof Error ? err.message : String(err) });
						reconcile();
					});
			}
		},
		[reconcile],
	);

	const handleMove = useCallback(
		(move: KanbanMove) => {
			const moved = tasksRef.current.find((t) => t.id === move.card);
			if (!moved) return false;
			const target = feedsRef.current.column(move.to).items.filter((t) => t.id !== moved.id);
			const at = Math.max(0, Math.min(move.index, target.length));
			const placed = { ...moved, status: move.to as TaskStatus };
			target.splice(at, 0, placed);
			// Orders go to the loaded cards only; unloaded ones sort after them by their own order.
			const orders = target.map((t, order) => ({ id: t.id, order }));
			feedsRef.current.place({ ...placed, order: at }, move.to, at);
			void (async () => {
				try {
					if (move.from !== move.to) {
						await api.updateTask(moved.id, { status: move.to as TaskStatus });
						toast.success("Status updated", { description: `#${moved.id} moved to ${columnLabel(move.to)}` });
					}
					await api.reorderTasks(orders);
				} catch (err) {
					toast.error("Failed to update", { description: err instanceof Error ? err.message : String(err) });
					reconcile();
				}
			})();
		},
		[reconcile],
	);

	const handleAddCard = useCallback(
		(column: string, title: string) => {
			api
				.createTask({ title, status: column as TaskStatus })
				// The server's task-created event can land before this response: patch replaces, never adds twice.
				.then((task) => {
					feedsRef.current.patch(task);
					refreshCounts();
					onChanged?.();
				})
				.catch((err: unknown) =>
					toast.error("Failed to create Task", { description: err instanceof Error ? err.message : String(err) }),
				);
		},
		[refreshCounts, onChanged],
	);

	const allFailed = visibleStatuses.length > 0 && visibleStatuses.every((s) => feeds.column(s).status === "error" && feeds.column(s).items.length === 0);
	if (allFailed) {
		return <PageError description={feeds.column(visibleStatuses[0] as string).error ?? undefined} onRetry={() => visibleStatuses.forEach((s) => feeds.retry(s))} className="flex-1" />;
	}

	return (
		<KanbanBoard
			columns={columns}
			people={people}
			cards={cards}
			columnCounts={columnCounts}
			renderColumnFooter={renderColumnFooter}
			onCardsChange={handleCardsChange}
			onMove={handleMove}
			onAddCard={handleAddCard}
			onCardOpen={(card) => {
				const task = tasksRef.current.find((t) => t.id === card.id);
				if (task) onTaskClick(task);
			}}
			actions={columnToggles}
			surface="none"
			// On phones a column takes most of the screen so a card reads whole; swipe for the next one.
			columnMinWidth={isMobile ? 280 : 216}
			className="min-h-0 flex-1"
			aria-label="Task board"
		/>
	);
}
