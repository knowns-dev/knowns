import type React from "react";
import { useState, useEffect } from "react";
import { ClipboardList } from "lucide-react";
import type { Task, TaskStatus } from "../../models/task";
import { useTheme } from "../App";
import { getConfig } from "../api/client";
import {
	generateColorScheme,
	DEFAULT_COLOR_SCHEME,
	DEFAULT_STATUS_COLORS,
	type ColorName,
} from "../utils/colors";
import Avatar from "./Avatar";
import { Skeleton } from "./ui/skeleton";

interface TaskCardProps {
	task: Task;
	onClick?: () => void;
}

// Default status labels
const DEFAULT_STATUS_LABELS: Record<string, string> = {
	todo: "To Do",
	"in-progress": "In Progress",
	"in-review": "In Review",
	done: "Done",
	blocked: "Blocked",
	"on-hold": "On Hold",
	urgent: "Urgent",
};

// Get status label with fallback
function getStatusLabel(status: string): string {
	if (DEFAULT_STATUS_LABELS[status]) {
		return DEFAULT_STATUS_LABELS[status];
	}
	// Auto-generate label: "my-status" → "My Status"
	return status
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

export default function TaskCard({ task, onClick }: TaskCardProps) {
	const { isDark } = useTheme();
	const [statusColors, setStatusColors] = useState<Record<string, ColorName>>(DEFAULT_STATUS_COLORS);

	// Load status colors from config
	useEffect(() => {
		getConfig()
			.then((config) => {
				if (config?.statusColors) {
					setStatusColors(config.statusColors as Record<string, ColorName>);
				}
			})
			.catch((err) => console.error("Failed to load status colors:", err));
	}, []);

	// Get color scheme for task status
	const colorScheme = statusColors[task.status]
		? generateColorScheme(statusColors[task.status])
		: DEFAULT_COLOR_SCHEME;

	const handleDragStart = (e: React.DragEvent) => {
		e.dataTransfer.setData("taskId", task.id);
		e.dataTransfer.effectAllowed = "move";
	};

	const handleClick = (e: React.MouseEvent) => {
		if (e.defaultPrevented) return;
		onClick?.();
	};

	const completedAC = task.acceptanceCriteria.filter((ac) => ac.completed).length;
	const totalAC = task.acceptanceCriteria.length;

	const statusBadgeClasses = isDark
		? `${colorScheme.darkBg} ${colorScheme.darkText}`
		: `${colorScheme.bg} ${colorScheme.text}`;

	return (
		<button
			type="button"
			className={`task-card rounded-lg shadow hover:shadow-md p-3 cursor-pointer active:cursor-grabbing select-none w-full text-left ${
				isDark ? "bg-gray-700 hover:bg-gray-650" : "bg-white"
			}`}
			draggable
			onDragStart={handleDragStart}
			onClick={handleClick}
			aria-label={`Task ${task.id}: ${task.title}`}
		>
			<div className="flex items-center justify-between gap-2 mb-1">
				<span
					className={`text-xs font-mono shrink-0 ${isDark ? "text-gray-500" : "text-gray-400"}`}
				>
					#{task.id}
				</span>
				<div className="flex items-center gap-1 flex-wrap justify-end">
					<span className={`text-xs px-1.5 py-0.5 rounded font-medium ${statusBadgeClasses}`}>
						{getStatusLabel(task.status)}
					</span>
					{task.priority === "high" && (
						<span
							className={`text-xs px-1.5 py-0.5 rounded font-medium ${
								isDark ? "bg-red-900/50 text-red-300" : "bg-red-100 text-red-700"
							}`}
						>
							HIGH
						</span>
					)}
					{task.priority === "medium" && (
						<span
							className={`text-xs px-1.5 py-0.5 rounded font-medium ${
								isDark ? "bg-yellow-900/50 text-yellow-300" : "bg-yellow-100 text-yellow-700"
							}`}
						>
							MED
						</span>
					)}
				</div>
			</div>

			<h3
				className={`font-medium text-sm mb-2 line-clamp-2 ${isDark ? "text-gray-100" : "text-gray-900"}`}
			>
				{task.title}
			</h3>

			{totalAC > 0 && (
				<div
					className={`flex items-center gap-2 text-xs mb-2 ${isDark ? "text-gray-400" : "text-gray-500"}`}
				>
					<ClipboardList className="w-3 h-3" aria-hidden="true" />
					<span>
						{completedAC}/{totalAC}
					</span>
				</div>
			)}

			{task.labels.length > 0 && (
				<div className="flex flex-wrap gap-1 mb-2">
					{task.labels.map((label) => (
						<span
							key={label}
							className={`text-xs px-1.5 py-0.5 rounded ${
								isDark ? "bg-blue-900/50 text-blue-300" : "bg-blue-100 text-blue-700"
							}`}
						>
							{label}
						</span>
					))}
				</div>
			)}

			{task.assignee && (
				<div
					className={`flex items-center gap-1.5 text-xs mt-2 ${isDark ? "text-gray-400" : "text-gray-600"}`}
				>
					<Avatar name={task.assignee} size="sm" />
					<span>{task.assignee}</span>
				</div>
			)}
		</button>
	);
}
