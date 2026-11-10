// Pilot: the Tasks board on Knowns UI's KanbanBoard (WIP-aware columns, keyboard and touch drag,
// swimlanes per assignee, quick add). Same props as Board so TasksPage can swap them.
import { useCallback, useMemo, useRef } from "react";
import { Eye, EyeOff, FileText } from "lucide-react";
import type { Task, TaskStatus } from "@/ui/models/task";
import { getTaskLifecycleState } from "@/ui/models/taskLifecycle";
import { cn } from "@/ui/lib/utils";
import { TaskLifecycleBadge } from "../molecules/TaskLifecycleBadge";
import { api } from "../../api/client";
import { useConfig } from "../../contexts/ConfigContext";
import { DEFAULT_STATUS_COLORS, type ColorName } from "../../utils/colors";
import { toast } from "../ui/sonner";
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
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function sortTasks(tasks: Task[]): Task[] {
	return [...tasks].sort((a, b) => {
		if (a.order != null && b.order != null) return a.order - b.order;
		if (a.order != null) return -1;
		if (b.order != null) return 1;
		const p = (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2);
		if (p !== 0) return p;
		return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
	});
}

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
		...(task.status === "blocked" ? { state: "blocked" as const } : {}),
		...(hasFooter(task) ? { footer: <CardFooter task={task} /> } : {}),
	};
}

const hasFooter = (task: Task) =>
	!!task.description || !!task.spec || getTaskLifecycleState(task) !== "active";

/** What the old board showed under the title: description, spec link, and a non-active lifecycle. */
function CardFooter({ task }: { task: Task }) {
	const lifecycle = getTaskLifecycleState(task);
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			{task.description && (
				<p className="line-clamp-2 text-xs leading-4 text-muted-foreground">{task.description}</p>
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

interface BoardNextProps {
	tasks: Task[];
	loading: boolean;
	onTasksUpdate: (tasks: Task[]) => void;
	onTaskClick: (task: Task) => void;
}

export default function BoardNext({ tasks, onTasksUpdate, onTaskClick }: BoardNextProps) {
	const { config, updateConfig } = useConfig();
	const statuses = (config?.statuses as TaskStatus[]) || ["todo", "in-progress", "in-review", "done", "blocked"];
	const visible = new Set((config?.visibleColumns as TaskStatus[]) ?? statuses);

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

	const countByStatus = useMemo(() => {
		const counts = new Map<string, number>();
		for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
		return counts;
	}, [tasks]);

	const columnToggles = (
		<div className="flex flex-wrap items-center gap-1" role="group" aria-label="Visible columns">
			{statuses.map((status) => {
				const on = visible.has(status);
				return (
					<button
						key={status}
						type="button"
						aria-pressed={on}
						onClick={() => toggleColumn(status)}
						className={cn(
							"flex h-8 items-center gap-1.5 rounded-md px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							on ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
						)}
					>
						{on ? <Eye className="h-3.5 w-3.5" aria-hidden="true" /> : <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />}
						<span>
							{columnLabel(status)} <span className="tabular-nums text-muted-foreground">{countByStatus.get(status) ?? 0}</span>
						</span>
					</button>
				);
			})}
		</div>
	);
	const statusColors = (config?.statusColors as Record<string, ColorName>) || DEFAULT_STATUS_COLORS;

	const columns: KanbanColumn[] = statuses
		.filter((s) => visible.has(s))
		.map((s) => ({ id: s, title: columnLabel(s), tone: TONE_BY_COLOR[statusColors[s] ?? "gray"] ?? "neutral" }));

	const cards = useMemo(() => sortTasks(tasks).map(toCard), [tasks]);

	const people: KanbanPerson[] = useMemo(() => {
		const ids = [...new Set(tasks.map((t) => t.assignee).filter((a): a is string => !!a))];
		return ids.map((id) => ({ id, name: id.replace(/^@/, "") }));
	}, [tasks]);

	const tasksRef = useRef(tasks);
	tasksRef.current = tasks;

	// Swimlane moves reassign: the board reports them only through onCardsChange.
	const handleCardsChange = useCallback(
		(next: KanbanCard[]) => {
			const byId = new Map(tasksRef.current.map((t) => [t.id, t]));
			for (const card of next) {
				const task = byId.get(card.id);
				if (!task || (task.assignee ?? undefined) === (card.assignee ?? undefined)) continue;
				onTasksUpdate(tasksRef.current.map((t) => (t.id === task.id ? { ...t, assignee: card.assignee } : t)));
				api
					.updateTask(task.id, { assignee: card.assignee ?? "" })
					.catch((err: unknown) => {
						toast.error("Failed to reassign", { description: err instanceof Error ? err.message : String(err) });
						api.getTasks().then(onTasksUpdate).catch(console.error);
					});
			}
		},
		[onTasksUpdate],
	);

	const handleMove = useCallback(
		(move: KanbanMove) => {
			const current = tasksRef.current;
			const moved = current.find((t) => t.id === move.card);
			if (!moved) return false;
			const target = sortTasks(current).filter((t) => t.status === move.to && t.id !== moved.id);
			target.splice(move.index, 0, { ...moved, status: move.to as TaskStatus });
			const orders = target.map((t, order) => ({ id: t.id, order }));
			const orderOf = new Map(orders.map((o) => [o.id, o.order]));
			onTasksUpdate(
				current.map((t) =>
					t.id === moved.id
						? { ...t, status: move.to as TaskStatus, order: orderOf.get(t.id) }
						: orderOf.has(t.id)
							? { ...t, order: orderOf.get(t.id) }
							: t,
				),
			);
			void (async () => {
				try {
					if (move.from !== move.to) {
						await api.updateTask(moved.id, { status: move.to as TaskStatus });
						toast.success("Status updated", { description: `#${moved.id} moved to ${columnLabel(move.to)}` });
					}
					await api.reorderTasks(orders);
				} catch (err) {
					toast.error("Failed to update", { description: err instanceof Error ? err.message : String(err) });
					api.getTasks().then(onTasksUpdate).catch(console.error);
				}
			})();
		},
		[onTasksUpdate],
	);

	const handleAddCard = useCallback(
		(column: string, title: string) => {
			api
				.createTask({ title, status: column as TaskStatus })
				.then((task) => onTasksUpdate([...tasksRef.current, task]))
				.catch((err: unknown) =>
					toast.error("Failed to create Task", { description: err instanceof Error ? err.message : String(err) }),
				);
		},
		[onTasksUpdate],
	);

	return (
		<KanbanBoard
			columns={columns}
			people={people}
			cards={cards}
			onCardsChange={handleCardsChange}
			onMove={handleMove}
			onAddCard={handleAddCard}
			onCardOpen={(card) => {
				const task = tasksRef.current.find((t) => t.id === card.id);
				if (task) onTaskClick(task);
			}}
			actions={columnToggles}
			surface="none"
			columnMinWidth={216}
			className="min-h-0 flex-1"
			aria-label="Task board"
		/>
	);
}
