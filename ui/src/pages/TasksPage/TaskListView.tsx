import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Columns3, FileText, Search } from "lucide-react";
import type { Task } from "@/ui/models/task";
import { Button } from "@/ui/components/ui/knowns/button";
import { Input } from "@/ui/components/ui/knowns/input";
import { Menu, type MenuItem } from "@/ui/components/ui/knowns/menu";
import { SegmentedControl } from "@/ui/components/ui/knowns/segmented-control";
import {
	DataTable,
	type DataColumn,
	type Density,
} from "@/ui/components/ui/knowns/data-table/data-table";
import { LabelList, PriorityBadge, TaskStatusIcon } from "@/ui/components/molecules";
import { TaskLifecycleBadge } from "@/ui/components/molecules/TaskLifecycleBadge";
import { useConfig } from "@/ui/contexts/ConfigContext";
import { getStatusLabel } from "@/ui/utils/colors";
import { navigateTo } from "../../lib/navigation";

interface TaskListViewProps {
	tasks: Task[];
	onTaskClick: (task: Task) => void;
	/** Opens the archive preview for these ids. */
	onArchiveSelected: (ids: string[]) => void;
}

type Grouping = "flat" | "status";

const GROUP_STORAGE_KEY = "knowns.tasks.list.group";
const DENSITY_STORAGE_KEY = "knowns.tasks.list.density";
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

const GROUP_OPTIONS = [
	{ value: "flat", label: "Flat" },
	{ value: "status", label: "By status" },
];

const DENSITY_OPTIONS = [
	{ value: "compact", label: "Compact" },
	{ value: "default", label: "Default" },
	{ value: "comfortable", label: "Roomy" },
];

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
	try {
		const value = localStorage.getItem(key);
		return allowed.includes(value as T) ? (value as T) : fallback;
	} catch {
		return fallback;
	}
}

function writeStored(key: string, value: string) {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Storage disabled: the choice just won't persist.
	}
}

function formatUpdatedAt(value: Date | string) {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return "-";
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
	}).format(date);
}

function progressOf(task: Task) {
	const criteria = task.acceptanceCriteria ?? [];
	const done = criteria.filter((c) => c.completed).length;
	return { done, total: criteria.length };
}

export function TaskListView({ tasks, onTaskClick, onArchiveSelected }: TaskListViewProps) {
	const { config } = useConfig();
	const [grouping, setGrouping] = useState<Grouping>(() => readStored(GROUP_STORAGE_KEY, ["flat", "status"] as const, "flat"));
	const [density, setDensity] = useState<Density>(() =>
		readStored(DENSITY_STORAGE_KEY, ["compact", "default", "comfortable"] as const, "default"),
	);
	const [query, setQuery] = useState("");
	const [hidden, setHidden] = useState<Set<string>>(() => new Set(["spec"]));
	const [selected, setSelected] = useState<string[]>([]);

	const statuses = useMemo(
		() => (config.statuses as string[] | undefined) || ["todo", "in-progress", "in-review", "done", "blocked"],
		[config.statuses],
	);

	const columns = useMemo<DataColumn<Task>[]>(
		() => [
			{
				id: "task",
				label: "Task",
				header: "Task",
				accessor: (t) => `${t.id} ${t.title}`,
				sortable: true,
				hideable: false,
				width: "38%",
				cell: (t) => (
					<button
						type="button"
						aria-label={`Open task ${t.title}`}
						className="flex h-full w-full min-w-0 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						onClick={(event) => {
							event.stopPropagation();
							onTaskClick(t);
						}}
					>
						<span className="w-16 shrink-0 truncate font-mono text-[11px] text-muted-foreground">#{t.id}</span>
						<span className="min-w-0 truncate font-medium">{t.title}</span>
						<TaskLifecycleBadge state={t.lifecycleState} />
					</button>
				),
			},
			{
				id: "status",
				header: "Status",
				accessor: (t) => getStatusLabel(t.status),
				sortable: true,
				compare: (a, b) => {
					const ia = statuses.indexOf(a.status);
					const ib = statuses.indexOf(b.status);
					return (ia < 0 ? statuses.length : ia) - (ib < 0 ? statuses.length : ib);
				},
				cell: (t) => <TaskStatusIcon status={t.status} showLabel />,
			},
			{
				id: "priority",
				header: "Priority",
				accessor: "priority",
				sortable: true,
				compare: (a, b) => (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1),
				cell: (t) => <PriorityBadge priority={t.priority} />,
			},
			{
				id: "assignee",
				header: "Assignee",
				accessor: (t) => t.assignee ?? "",
				sortable: true,
				cell: (t) =>
					t.assignee ? (
						<span className="text-xs">{t.assignee}</span>
					) : (
						<span className="text-xs text-muted-foreground/60">Unassigned</span>
					),
			},
			{
				id: "labels",
				header: "Labels",
				accessor: (t) => (t.labels ?? []).join(" "),
				cell: (t) =>
					(t.labels ?? []).length > 0 ? (
						<LabelList labels={t.labels} maxVisible={2} />
					) : (
						<span className="text-xs text-muted-foreground/60">-</span>
					),
			},
			{
				id: "spec",
				header: "Spec",
				accessor: (t) => t.spec ?? "",
				sortable: true,
				cell: (t) =>
					t.spec ? (
						<button
							type="button"
							aria-label={`Open specification ${t.spec.split("/").pop()}`}
							onClick={(event) => {
								event.stopPropagation();
								navigateTo(`/docs/${t.spec}.md`);
							}}
							className="flex items-center gap-1 text-xs text-purple-600 hover:underline dark:text-purple-400"
							title={`@doc/${t.spec}`}
						>
							<FileText className="size-3" />
							{t.spec.split("/").pop()}
						</button>
					) : (
						<span className="text-xs text-muted-foreground/60">-</span>
					),
			},
			{
				id: "progress",
				header: "Progress",
				accessor: (t) => {
					const { done, total } = progressOf(t);
					return total === 0 ? -1 : done / total;
				},
				sortable: true,
				filterable: false,
				searchable: false,
				cell: (t) => {
					const { done, total } = progressOf(t);
					if (total === 0) return <span className="text-xs text-muted-foreground/60">-</span>;
					return (
						<div className="flex min-w-[88px] items-center gap-2">
							<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
								<div className="h-full bg-primary" style={{ width: `${Math.round((done / total) * 100)}%` }} />
							</div>
							<span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
								{done}/{total}
							</span>
						</div>
					);
				},
			},
			{
				id: "updated",
				header: "Updated",
				accessor: (t) => new Date(t.updatedAt).getTime() || 0,
				sortable: true,
				filterable: false,
				searchable: false,
				align: "end",
				cell: (t) => <span className="text-xs text-muted-foreground">{formatUpdatedAt(t.updatedAt)}</span>,
			},
		],
		[onTaskClick, statuses],
	);

	// One shared Columns menu: every group table gets the same visible set.
	const visibleColumns = useMemo(() => columns.filter((c) => !hidden.has(c.id)), [columns, hidden]);
	const columnItems = useMemo<MenuItem[]>(
		() =>
			columns
				.filter((c) => c.hideable !== false)
				.map((c) => ({
					id: c.id,
					label: c.label ?? String(c.header),
					kind: "switch" as const,
					checked: !hidden.has(c.id),
					textValue: c.label ?? String(c.header),
				})),
		[columns, hidden],
	);

	const searched = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return tasks;
		return tasks.filter(
			(t) =>
				t.id.toLowerCase().includes(q) ||
				t.title.toLowerCase().includes(q) ||
				(t.description ?? "").toLowerCase().includes(q) ||
				(t.assignee ?? "").toLowerCase().includes(q) ||
				(t.labels ?? []).some((l) => l.toLowerCase().includes(q)),
		);
	}, [tasks, query]);

	// Keep the selection to Tasks that still exist (archived rows leave the list).
	useEffect(() => {
		const ids = new Set(tasks.map((t) => t.id));
		setSelected((current) => {
			const next = current.filter((id) => ids.has(id));
			return next.length === current.length ? current : next;
		});
	}, [tasks]);

	const groups = useMemo(() => {
		const byStatus = new Map<string, Task[]>();
		for (const t of searched) {
			const list = byStatus.get(t.status) ?? [];
			list.push(t);
			byStatus.set(t.status, list);
		}
		const ordered = [...statuses, ...[...byStatus.keys()].filter((s) => !statuses.includes(s))];
		return ordered.filter((s) => byStatus.has(s)).map((s) => ({ status: s, rows: byStatus.get(s) as Task[] }));
	}, [searched, statuses]);

	const changeGrouping = useCallback((value: string) => {
		const next = value === "status" ? "status" : "flat";
		setGrouping(next);
		writeStored(GROUP_STORAGE_KEY, next);
	}, []);

	const changeDensity = useCallback((value: string) => {
		setDensity(value as Density);
		writeStored(DENSITY_STORAGE_KEY, value);
	}, []);

	const getRowId = useCallback((t: Task) => t.id, []);
	const empty = <span>{tasks.length === 0 ? "No Tasks yet." : "No Tasks match the current filters."}</span>;

	return (
		<div className="flex h-full min-h-0 flex-col gap-3" data-testid="task-list-view">
			<div className="flex flex-wrap items-center gap-2">
				<span className="w-full max-w-full sm:w-64">
					<Input
						size="sm"
						type="search"
						icon={<Search className="size-3.5" />}
						placeholder="Search Tasks"
						aria-label="Search Tasks"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</span>
				<span className="flex-1" />
				{selected.length > 0 && (
					<Button size="sm" variant="secondary" icon={<Archive className="size-3.5" />} onClick={() => onArchiveSelected(selected)}>
						Archive {selected.length} selected
					</Button>
				)}
				<SegmentedControl size="sm" aria-label="Group Tasks" options={GROUP_OPTIONS} value={grouping} onValueChange={changeGrouping} />
				<SegmentedControl size="sm" aria-label="Row density" options={DENSITY_OPTIONS} value={density} onValueChange={changeDensity} />
				<Menu
					aria-label="Columns"
					align="end"
					items={columnItems}
					onSelect={(item) =>
						setHidden((current) => {
							const next = new Set(current);
							if (next.has(item.id)) next.delete(item.id);
							else next.add(item.id);
							return next;
						})
					}
					trigger={
						<Button size="sm" variant="secondary" icon={<Columns3 className="size-3.5" />}>
							Columns
						</Button>
					}
				/>
			</div>

			<div className="min-h-0 flex-1 overflow-auto">
				{grouping === "flat" ? (
					<DataTable
						aria-label="Tasks"
						rows={searched}
						columns={visibleColumns}
						getRowId={getRowId}
						defaultSort={[{ id: "priority", desc: false }]}
						selectable
						selected={selected}
						onSelectedChange={setSelected}
						search={false}
						controls={false}
						filterRow
						density={density}
						onRowClick={onTaskClick}
						empty={empty}
					/>
				) : groups.length === 0 ? (
					<div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">{empty}</div>
				) : (
					<div className="flex flex-col gap-4">
						{groups.map((group) => (
							<DataTable
								key={group.status}
								title={getStatusLabel(group.status)}
								titleAs="h3"
								rows={group.rows}
								columns={visibleColumns}
								getRowId={getRowId}
								defaultSort={[{ id: "priority", desc: false }]}
								selectable
								selected={selected}
								onSelectedChange={setSelected}
								search={false}
								controls={false}
								pageSize={false}
								maxHeight={360}
								density={density}
								onRowClick={onTaskClick}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
