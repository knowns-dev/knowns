import type { Task } from "../../models/task";
import { useTheme } from "../App";
import Board from "../components/Board";

interface KanbanPageProps {
	tasks: Task[];
	loading: boolean;
	onTasksUpdate: (tasks: Task[]) => void;
	onNewTask: () => void;
}

const Icons = {
	Plus: () => (
		<svg
			aria-hidden="true"
			className="w-4 h-4"
			fill="none"
			stroke="currentColor"
			viewBox="0 0 24 24"
		>
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
		</svg>
	),
};

export default function KanbanPage({ tasks, loading, onTasksUpdate, onNewTask }: KanbanPageProps) {
	const { isDark } = useTheme();
	const textColor = isDark ? "text-gray-200" : "text-gray-900";

	return (
		<div className="p-6">
			{/* Header with New Task button */}
			<div className="mb-6 flex items-center justify-between">
				<h1 className={`text-2xl font-bold ${textColor}`}>Kanban Board</h1>
				<button
					type="button"
					onClick={onNewTask}
					className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 flex items-center gap-2 transition-colors"
				>
					<Icons.Plus />
					New Task
				</button>
			</div>

			<Board tasks={tasks} loading={loading} onTasksUpdate={onTasksUpdate} />
		</div>
	);
}
