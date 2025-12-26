import { Plus } from "lucide-react";
import type { Task } from "../../models/task";
import { useTheme } from "../App";
import Board from "../components/Board";

interface KanbanPageProps {
	tasks: Task[];
	loading: boolean;
	onTasksUpdate: (tasks: Task[]) => void;
	onNewTask: () => void;
}

export default function KanbanPage({ tasks, loading, onTasksUpdate, onNewTask }: KanbanPageProps) {
	const { isDark } = useTheme();
	const textColor = isDark ? "text-gray-200" : "text-gray-900";

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{/* Fixed Header with New Task button */}
			<div className="shrink-0 p-6 pb-0">
				<div className="mb-4 flex items-center justify-between gap-4">
					<h1 className={`text-2xl font-bold ${textColor}`}>Kanban Board</h1>
					<button
						type="button"
						onClick={onNewTask}
						className="shrink-0 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 flex items-center gap-2 transition-colors"
					>
						<Plus className="w-4 h-4" />
						New Task
					</button>
				</div>
			</div>

			{/* Board with scrollable columns */}
			<div className="flex-1 overflow-hidden px-6 pb-6">
				<Board tasks={tasks} loading={loading} onTasksUpdate={onTasksUpdate} />
			</div>
		</div>
	);
}
