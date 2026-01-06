import type { Task, TaskPriority, TaskStatus } from "@models/task";

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
