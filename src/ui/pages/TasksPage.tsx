import { useEffect, useState } from "react";
import { LayoutList, LayoutGrid } from "lucide-react";
import type { Task } from "../../models/task";
import { TaskDetailSheet, TaskDataTable } from "../components/organisms";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { TaskGroupedView } from "./TasksPage/TaskGroupedView";

interface TasksPageProps {
	tasks: Task[];
	loading: boolean;
	onTasksUpdate: () => void;
	selectedTask?: Task | null;
	onTaskClose?: () => void;
	onNewTask: () => void;
}

type ViewMode = "table" | "grouped";

export default function TasksPage({
	tasks,
	loading,
	onTasksUpdate,
	selectedTask: externalSelectedTask,
	onTaskClose,
	onNewTask,
}: TasksPageProps) {
	const [viewMode, setViewMode] = useState<ViewMode>("table");
	const [selectedTask, setSelectedTask] = useState<Task | null>(null);
	const [selectedTasks, setSelectedTasks] = useState<Task[]>([]);

	// Handle external selected task from search
	useEffect(() => {
		if (externalSelectedTask) {
			setSelectedTask(externalSelectedTask);
		}
	}, [externalSelectedTask]);

	const handleTaskClick = (task: Task) => {
		window.location.hash = `/tasks/${task.id}`;
	};

	if (loading) {
		return (
			<div className="p-6 flex items-center justify-center h-64">
				<div className="text-lg text-muted-foreground">Loading tasks...</div>
			</div>
		);
	}

	return (
		<div className="p-6 h-full flex flex-col overflow-hidden">
			{/* Header */}
			<div className="mb-6 flex items-center justify-between gap-4">
				<div className="flex items-center gap-4">
					<h1 className="text-2xl font-bold">All Tasks</h1>
					<span className="text-muted-foreground">
						{tasks.length} {tasks.length === 1 ? "task" : "tasks"}
					</span>
				</div>

				{/* View Toggle */}
				<div className="flex items-center gap-2">
					<div className="flex items-center border rounded-lg p-1">
						<Button
							variant={viewMode === "table" ? "secondary" : "ghost"}
							size="sm"
							onClick={() => setViewMode("table")}
							className="h-8 px-3"
						>
							<LayoutList className="h-4 w-4 mr-2" />
							Table
						</Button>
						<Button
							variant={viewMode === "grouped" ? "secondary" : "ghost"}
							size="sm"
							onClick={() => setViewMode("grouped")}
							className="h-8 px-3"
						>
							<LayoutGrid className="h-4 w-4 mr-2" />
							Grouped
						</Button>
					</div>
				</div>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-hidden">
				{viewMode === "table" ? (
					<ScrollArea className="h-full">
						<div className="pr-4">
							<TaskDataTable
								tasks={tasks}
								onTaskClick={handleTaskClick}
								onSelectionChange={setSelectedTasks}
								onNewTask={onNewTask}
							/>
						</div>
					</ScrollArea>
				) : (
					<TaskGroupedView
						tasks={tasks}
						onTaskClick={handleTaskClick}
						onNewTask={onNewTask}
					/>
				)}
			</div>

			{/* Bulk Actions Bar */}
			{selectedTasks.length > 0 && (
				<div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground px-4 py-2 rounded-lg shadow-lg flex items-center gap-4">
					<span className="text-sm font-medium">
						{selectedTasks.length} task{selectedTasks.length > 1 ? "s" : ""} selected
					</span>
					<Button
						variant="secondary"
						size="sm"
						onClick={() => {
							// TODO: Implement bulk actions
							console.log("Bulk action on:", selectedTasks);
						}}
					>
						Bulk Edit
					</Button>
				</div>
			)}

			{/* Task Detail Sheet */}
			<TaskDetailSheet
				task={selectedTask}
				allTasks={tasks}
				onClose={() => {
					setSelectedTask(null);
					if (onTaskClose) onTaskClose();
				}}
				onUpdate={onTasksUpdate}
			/>
		</div>
	);
}
