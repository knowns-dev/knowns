import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
	Activity,
	ArrowRightLeft,
	Brain,
	FileText,
	Import,
	Layers,
	LayoutDashboard,
	ListTodo,
	Monitor,
	Moon,
	Network,
	Plus,
	ScrollText,
	Settings,
	Sun,
} from "lucide-react";
import {
	CommandMenu,
	type CommandItem,
	type CommandPage,
} from "@/ui/components/ui/knowns/command-menu/command-menu";
import { TaskStatusIcon } from "../molecules/TaskStatusIcon";
import type { Task } from "@/ui/models/task";
import { API_BASE, apiFetch } from "@/ui/api/client";

/** A doc as /api/search returns it (title, path); older shapes carried filename and metadata. */
interface DocItem {
	path: string;
	title?: string;
	filename?: string;
	metadata?: {
		title?: string;
		description?: string;
		tags?: string[];
	};
}

interface SearchCommandDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onTaskSelect: (task: Task) => void;
	onDocSelect: (doc?: { path?: string; filename?: string }) => void;
	onNewTask: () => void;
	onSwitchWorkspace: () => void;
	isDark: boolean;
	onToggleTheme: () => void;
}

/** What a picked task or doc needs to show up again in Recent after a reload. */
type RecentEntity =
	| { kind: "task"; id: string; title: string; status: string }
	| { kind: "doc"; path: string; title: string };

interface StoredRecents {
	ids: string[];
	entities: Record<string, RecentEntity>;
}

const RECENTS_KEY = "knowns.commandMenu.recents";
const MAX_RESULTS = 8;
const RECENT_PAGE = "__recent";

const GROUP_PAGES = "Pages";
const GROUP_ACTIONS = "Actions";
const GROUP_TASKS = "Tasks";
const GROUP_DOCS = "Docs";

const PAGES = [
	{ id: "dashboard", label: "Dashboard", to: "/", icon: LayoutDashboard },
	{ id: "tasks", label: "Tasks", to: "/tasks", icon: ListTodo, keywords: ["board", "kanban"] },
	{ id: "docs", label: "Docs", to: "/docs", icon: FileText, keywords: ["documentation"] },
	{ id: "graph", label: "Graph", to: "/graph", icon: Network },
	{ id: "memory", label: "Memories", to: "/memory", icon: Brain },
	{ id: "decisions", label: "System Decisions", to: "/decisions", icon: ScrollText },
	{ id: "context", label: "Context pack", to: "/context", icon: Layers, keywords: ["retrieve", "build context"] },
	{ id: "runtime", label: "Runtime", to: "/runtime", icon: Monitor },
	{ id: "audit", label: "Audit Trail", to: "/audit", icon: Activity, keywords: ["history", "log"] },
	{ id: "imports", label: "Imports", to: "/imports", icon: Import },
	{ id: "config", label: "Settings", to: "/config", icon: Settings, keywords: ["config", "preferences"] },
];

function readRecents(): StoredRecents {
	try {
		const raw = localStorage.getItem(RECENTS_KEY);
		if (!raw) return { ids: [], entities: {} };
		const data = JSON.parse(raw) as Partial<StoredRecents>;
		return {
			ids: Array.isArray(data.ids) ? data.ids.filter((id) => typeof id === "string") : [],
			entities: data.entities && typeof data.entities === "object" ? data.entities : {},
		};
	} catch {
		return { ids: [], entities: {} };
	}
}

function writeRecents(value: StoredRecents) {
	try {
		localStorage.setItem(RECENTS_KEY, JSON.stringify(value));
	} catch {
		// Storage can be full or blocked (private windows): recents then last only this session.
	}
}

/**
 * The global ⌘K palette: jump to a page, run an action, or search tasks and docs on the server.
 * Recently picked items (tasks and docs included) are kept per browser.
 */
export default function SearchCommandDialog({
	open,
	onOpenChange,
	onTaskSelect,
	onDocSelect,
	onNewTask,
	onSwitchWorkspace,
	isDark,
	onToggleTheme,
}: SearchCommandDialogProps) {
	const navigate = useNavigate();
	const [recents, setRecents] = useState<StoredRecents>(readRecents);
	// Filled by a task or doc item's onSelect, which runs just before onRecentsChange.
	const pendingEntity = useRef<{ id: string; entity: RecentEntity } | null>(null);

	// Radix dialogs (the task sheet) close on an Escape they catch on the document before it reaches this
	// native dialog. While the menu is open, take Escape first on the window so it closes only the menu.
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			onOpenChange(false);
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [open, onOpenChange]);

	const taskItem = useCallback(
		(task: Pick<Task, "id" | "title" | "status">): CommandItem => ({
			id: `task:${task.id}`,
			label: task.title,
			group: GROUP_TASKS,
			icon: <ListTodo />,
			badge: <TaskStatusIcon status={task.status} showLabel />,
			description: <span className="font-mono">#{task.id}</span>,
			onSelect: () => {
				pendingEntity.current = {
					id: `task:${task.id}`,
					entity: { kind: "task", id: task.id, title: task.title, status: task.status },
				};
				onTaskSelect(task as Task);
			},
		}),
		[onTaskSelect],
	);

	const docItem = useCallback(
		(doc: DocItem): CommandItem => {
			const title = doc.title || doc.metadata?.title || doc.filename || doc.path;
			return {
				id: `doc:${doc.path}`,
				label: title,
				group: GROUP_DOCS,
				icon: <FileText />,
				description: doc.path,
				onSelect: () => {
					pendingEntity.current = {
						id: `doc:${doc.path}`,
						entity: { kind: "doc", path: doc.path, title },
					};
					onDocSelect(doc);
				},
			};
		},
		[onDocSelect],
	);

	const items = useMemo<CommandItem[]>(
		() => [
			...PAGES.map(({ id, label, to, icon: Icon, keywords }) => ({
				id: `page:${id}`,
				label,
				group: GROUP_PAGES,
				icon: <Icon />,
				keywords,
				onSelect: () => navigate({ to }),
			})),
			{
				id: "action:new-task",
				label: "New task",
				group: GROUP_ACTIONS,
				icon: <Plus />,
				keywords: ["create", "add"],
				onSelect: onNewTask,
			},
			{
				id: "action:theme",
				label: isDark ? "Switch to light theme" : "Switch to dark theme",
				group: GROUP_ACTIONS,
				icon: isDark ? <Sun /> : <Moon />,
				keywords: ["theme", "appearance", "dark", "light", "mode"],
				onSelect: onToggleTheme,
			},
			{
				id: "action:workspace",
				label: "Switch workspace",
				group: GROUP_ACTIONS,
				icon: <ArrowRightLeft />,
				keywords: ["project", "open"],
				onSelect: onSwitchWorkspace,
			},
		],
		[navigate, onNewTask, onToggleTheme, onSwitchWorkspace, isDark],
	);

	// Tasks and docs picked earlier live on a page nobody opens, so the menu can resolve their recent ids.
	const pages = useMemo<CommandPage[]>(() => {
		const recentItems = recents.ids.flatMap((id) => {
			const entity = recents.entities[id];
			if (!entity) return [];
			return [
				entity.kind === "task"
					? taskItem(entity)
					: docItem({ path: entity.path, title: entity.title }),
			];
		});
		return [{ id: RECENT_PAGE, title: "Recent", items: recentItems }];
	}, [recents, taskItem, docItem]);

	const load = useCallback(
		async (query: string, signal: AbortSignal): Promise<CommandItem[]> => {
			const res = await apiFetch(
				`${API_BASE}/api/search?q=${encodeURIComponent(query)}&includeHistorical=true`,
				{ signal },
			);
			if (!res.ok) throw new Error(`Search failed: ${res.status}`);
			const data = (await res.json()) as { tasks?: Task[]; docs?: DocItem[] };
			return [
				...(data.tasks ?? []).slice(0, MAX_RESULTS).map(taskItem),
				...(data.docs ?? []).slice(0, MAX_RESULTS).map(docItem),
			];
		},
		[taskItem, docItem],
	);

	const handleRecentsChange = useCallback((ids: string[]) => {
		setRecents((prev) => {
			const entities: Record<string, RecentEntity> = {};
			const picked = pendingEntity.current;
			pendingEntity.current = null;
			for (const id of ids) {
				const entity = picked?.id === id ? picked.entity : prev.entities[id];
				if (entity) entities[id] = entity;
			}
			const next = { ids, entities };
			writeRecents(next);
			return next;
		});
	}, []);

	return (
		<CommandMenu
			open={open}
			onOpenChange={onOpenChange}
			items={items}
			pages={pages}
			groups={[GROUP_PAGES, GROUP_ACTIONS, GROUP_TASKS, GROUP_DOCS]}
			load={load}
			debounce={200}
			recents={recents.ids}
			onRecentsChange={handleRecentsChange}
			placeholder="Search tasks and docs, or jump to a page…"
			empty={(query) => <>No tasks, docs or pages match “{query}”</>}
			aria-label="Search"
		/>
	);
}
