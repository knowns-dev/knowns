import type React from "react";
import type { Task, TaskStatus } from "../../models/task";
import { useTheme } from "../App";

interface TaskCardProps {
	task: Task;
	onClick?: () => void;
}

const statusColors: Record<
	TaskStatus,
	{ bg: string; darkBg: string; text: string; darkText: string; label: string }
> = {
	todo: {
		bg: "bg-gray-100",
		darkBg: "bg-gray-700",
		text: "text-gray-700",
		darkText: "text-gray-300",
		label: "To Do",
	},
	"in-progress": {
		bg: "bg-blue-100",
		darkBg: "bg-blue-900/50",
		text: "text-blue-700",
		darkText: "text-blue-300",
		label: "In Progress",
	},
	"in-review": {
		bg: "bg-purple-100",
		darkBg: "bg-purple-900/50",
		text: "text-purple-700",
		darkText: "text-purple-300",
		label: "In Review",
	},
	done: {
		bg: "bg-green-100",
		darkBg: "bg-green-900/50",
		text: "text-green-700",
		darkText: "text-green-300",
		label: "Done",
	},
	blocked: {
		bg: "bg-red-100",
		darkBg: "bg-red-900/50",
		text: "text-red-700",
		darkText: "text-red-300",
		label: "Blocked",
	},
};

export default function TaskCard({ task, onClick }: TaskCardProps) {
	const { isDark } = useTheme();

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
	const statusStyle = statusColors[task.status];

	return (
		<button
			type="button"
			className={`rounded-lg shadow hover:shadow-md transition-all p-3 cursor-pointer active:cursor-grabbing select-none w-full text-left ${
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
					<span
						className={`text-xs px-1.5 py-0.5 rounded font-medium ${
							isDark
								? `${statusStyle.darkBg} ${statusStyle.darkText}`
								: `${statusStyle.bg} ${statusStyle.text}`
						}`}
					>
						{statusStyle.label}
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
					<svg
						className="w-3 h-3"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
						/>
					</svg>
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
					className={`flex items-center gap-1 text-xs mt-2 ${isDark ? "text-gray-400" : "text-gray-600"}`}
				>
					<svg
						className="w-3 h-3"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
						/>
					</svg>
					<span>{task.assignee}</span>
				</div>
			)}
		</button>
	);
}
