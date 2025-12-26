import type React from "react";
import { useState } from "react";
import type { Task, TaskStatus } from "../../models/task";
import { useTheme } from "../App";
import TaskCard from "./TaskCard";

interface ColumnProps {
	status: TaskStatus;
	tasks: Task[];
	onDrop: (taskId: string, status: TaskStatus) => void;
	onTaskClick: (task: Task) => void;
}

const LABELS: Record<TaskStatus, string> = {
	todo: "To Do",
	"in-progress": "In Progress",
	"in-review": "In Review",
	done: "Done",
	blocked: "Blocked",
};

const COLORS_LIGHT: Record<TaskStatus, string> = {
	todo: "bg-gray-50 border-gray-200",
	"in-progress": "bg-blue-50 border-blue-200",
	"in-review": "bg-purple-50 border-purple-200",
	done: "bg-green-50 border-green-200",
	blocked: "bg-red-50 border-red-200",
};

const COLORS_DARK: Record<TaskStatus, string> = {
	todo: "bg-gray-800 border-gray-700",
	"in-progress": "bg-blue-900/30 border-blue-800",
	"in-review": "bg-purple-900/30 border-purple-800",
	done: "bg-green-900/30 border-green-800",
	blocked: "bg-red-900/30 border-red-800",
};

export default function Column({ status, tasks, onDrop, onTaskClick }: ColumnProps) {
	const { isDark } = useTheme();
	const [isDragOver, setIsDragOver] = useState(false);

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

	const colors = isDark ? COLORS_DARK : COLORS_LIGHT;

	return (
		<div
			className={`rounded-lg border-2 p-4 min-w-[380px] max-w-[420px] flex-shrink-0 transition-colors overflow-visible ${
				colors[status]
			} ${isDragOver ? "ring-2 ring-blue-400 border-blue-400" : ""}`}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			<div className="flex items-center justify-between mb-3">
				<h2
					className={`font-bold text-sm uppercase tracking-wide ${isDark ? "text-gray-300" : "text-gray-700"}`}
				>
					{LABELS[status]}
				</h2>
				<span
					className={`text-xs rounded-full px-2 py-1 font-medium ${
						isDark ? "text-gray-400 bg-gray-700" : "text-gray-500 bg-white"
					}`}
				>
					{tasks.length}
				</span>
			</div>

			<div className="space-y-2 overflow-visible">
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
		</div>
	);
}
