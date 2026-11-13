import type { Task, TaskPriority, TaskStatus } from "@/ui/models/task";

export interface TaskDetailProps {
	task: Task;
	allTasks: Task[];
	onUpdate: (task: Task) => void;
	onClose: () => void;
	onDelete?: (taskId: string) => void;
	onNavigateToTask?: (taskId: string) => void;
}

export interface TaskSectionProps {
	task: Task;
	onSave: (updates: Partial<Task>) => Promise<void>;
	saving: boolean;
}

export const statusOptions: { value: TaskStatus; label: string }[] = [
	{ value: "todo", label: "To Do" },
	{ value: "in-progress", label: "In Progress" },
	{ value: "in-review", label: "In Review" },
	{ value: "done", label: "Done" },
	{ value: "blocked", label: "Blocked" },
	{ value: "on-hold", label: "On Hold" },
	{ value: "urgent", label: "Urgent" },
];

export const priorityOptions: { value: TaskPriority; label: string }[] = [
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
];

export const statusColors: Record<TaskStatus, string> = {
	todo: "bg-secondary text-secondary-foreground hover:bg-secondary",
	"in-progress": "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 hover:bg-blue-200",
	"in-review": "bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300 hover:bg-purple-200",
	done: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300 hover:bg-green-200",
	blocked: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300 hover:bg-red-200",
	"on-hold": "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300 hover:bg-yellow-200",
	urgent: "bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300 hover:bg-orange-200",
};

export const priorityColors: Record<TaskPriority, string> = {
	low: "bg-secondary text-secondary-foreground",
	medium: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
	high: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
};

/** Knowns UI tone for a status colour name from config (Badge, Combobox dot). */
export type DetailTone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";

const COLOR_TONES: Record<string, DetailTone> = {
	gray: "neutral",
	red: "danger",
	orange: "warning",
	yellow: "warning",
	green: "success",
	teal: "success",
	blue: "info",
	cyan: "info",
	purple: "accent",
	indigo: "accent",
	pink: "accent",
};

const DEFAULT_STATUS_TONE_COLORS: Record<string, string> = {
	todo: "gray",
	"in-progress": "blue",
	"in-review": "purple",
	done: "green",
	blocked: "red",
	"on-hold": "yellow",
	urgent: "orange",
};

export function statusTone(status: string, configColors: Record<string, string> = {}): DetailTone {
	const color = configColors[status] || DEFAULT_STATUS_TONE_COLORS[status] || "gray";
	return COLOR_TONES[color] ?? "neutral";
}

export const priorityTones: Record<TaskPriority, DetailTone> = {
	low: "neutral",
	medium: "warning",
	high: "danger",
};

/** "2h 5m", "45m", "30s". */
export function formatTracked(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	if (minutes === 0 && seconds > 0) return `${seconds}s`;
	return `${minutes}m`;
}

/** Move one item of a list from `from` to `to` (both clamped). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
	if (from < 0 || from >= list.length) return list;
	const target = Math.max(0, Math.min(list.length - 1, to));
	if (target === from) return list;
	const next = list.slice();
	const [item] = next.splice(from, 1);
	if (item !== undefined) next.splice(target, 0, item);
	return next;
}
