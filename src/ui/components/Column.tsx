import type React from "react";
import { useState, useEffect } from "react";
import type { Task, TaskStatus } from "../../models/task";
import { useTheme } from "../App";
import { getConfig } from "../api/client";
import TaskCard from "./TaskCard";
import { ScrollArea } from "./ui/scroll-area";
import {
	generateColorScheme,
	DEFAULT_COLOR_SCHEME,
	DEFAULT_STATUS_COLORS,
	type ColorName,
} from "../utils/colors";

interface ColumnProps {
	status: TaskStatus;
	tasks: Task[];
	onDrop: (taskId: string, status: TaskStatus) => void;
	onTaskClick: (task: Task) => void;
}

// Default column labels
const DEFAULT_LABELS: Record<string, string> = {
	todo: "To Do",
	"in-progress": "In Progress",
	"in-review": "In Review",
	done: "Done",
	blocked: "Blocked",
	"on-hold": "On Hold",
	urgent: "Urgent",
};

// Convert status slug to readable label
function getColumnLabel(status: string): string {
	if (DEFAULT_LABELS[status]) {
		return DEFAULT_LABELS[status];
	}
	// Auto-generate label: "my-status" → "My Status"
	return status
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

export default function Column({ status, tasks, onDrop, onTaskClick }: ColumnProps) {
	const { isDark } = useTheme();
	const [isDragOver, setIsDragOver] = useState(false);
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

	// Get color scheme for current status
	const colorScheme = statusColors[status]
		? generateColorScheme(statusColors[status])
		: DEFAULT_COLOR_SCHEME;

	const columnColors = isDark
		? `${colorScheme.columnBgDark} ${colorScheme.columnBorderDark}`
		: `${colorScheme.columnBg} ${colorScheme.columnBorder}`;

	const handleDragOver = (e: React.DragEvent) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		setIsDragOver(true);
	};

	const handleDragLeave = () => {
		setIsDragOver(false);
	};

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		setIsDragOver(false);
		const taskId = e.dataTransfer.getData("taskId");
		if (taskId) {
			onDrop(taskId, status);
		}
	};

	return (
		<div
			className={`rounded-lg border-2 p-4 min-w-[380px] max-w-[420px] flex-shrink-0 transition-colors flex flex-col max-h-[calc(100vh-220px)] ${columnColors} ${isDragOver ? "ring-2 ring-blue-400 border-blue-400" : ""}`}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			<div className="flex items-center justify-between mb-3 shrink-0">
				<h2
					className={`font-bold text-sm uppercase tracking-wide ${isDark ? "text-gray-300" : "text-gray-700"}`}
				>
					{getColumnLabel(status)}
				</h2>
				<span
					className={`text-xs rounded-full px-2 py-1 font-medium ${
						isDark ? "text-gray-400 bg-gray-700" : "text-gray-500 bg-white"
					}`}
				>
					{tasks.length}
				</span>
			</div>

			<ScrollArea className="flex-1 -mr-2 pr-2">
				<div className="space-y-2 stagger-animation">
					{tasks.length === 0 ? (
						<div className={`text-center py-8 text-sm ${isDark ? "text-gray-500" : "text-gray-400"}`}>
							No tasks
						</div>
					) : (
						tasks.map((task) => (
							<TaskCard key={task.id} task={task} onClick={() => onTaskClick(task)} />
						))
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
