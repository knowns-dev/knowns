import { Plus, Archive, ChevronDown } from "lucide-react";
import type { Task } from "../../models/task";
import { Board } from "../components/organisms";
import { Button } from "../components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { api } from "../api/client";
import { toast } from "../components/ui/sonner";

// Time duration options for batch archive (in milliseconds)
const BATCH_ARCHIVE_OPTIONS = [
	{ label: "1 hour ago", value: 1 * 60 * 60 * 1000 },
	{ label: "1 day ago", value: 24 * 60 * 60 * 1000 },
	{ label: "1 week ago", value: 7 * 24 * 60 * 60 * 1000 },
	{ label: "1 month ago", value: 30 * 24 * 60 * 60 * 1000 },
	{ label: "3 months ago", value: 90 * 24 * 60 * 60 * 1000 },
];

interface KanbanPageProps {
	tasks: Task[];
	loading: boolean;
	onTasksUpdate: (tasks: Task[]) => void;
	onNewTask: () => void;
}

export default function KanbanPage({ tasks, loading, onTasksUpdate, onNewTask }: KanbanPageProps) {
	// Count done tasks for batch archive preview
	const getDoneTasksCount = (olderThanMs: number): number => {
		const cutoffTime = Date.now() - olderThanMs;
		return tasks.filter(
			(t) => t.status === "done" && new Date(t.updatedAt).getTime() < cutoffTime
		).length;
	};

	const handleBatchArchive = async (olderThanMs: number, label: string) => {
		try {
			const result = await api.batchArchiveTasks(olderThanMs);
			if (result.count > 0) {
				// Remove archived tasks from list
				const archivedIds = new Set(result.tasks.map((t) => t.id));
				onTasksUpdate(tasks.filter((t) => !archivedIds.has(t.id)));
				toast.success(`Archived ${result.count} task${result.count > 1 ? "s" : ""} done before ${label}`);
			} else {
				toast.info(`No done tasks found before ${label}`);
			}
		} catch (error) {
			console.error("Failed to batch archive tasks:", error);
			toast.error("Failed to archive tasks");
		}
	};

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{/* Fixed Header with New Task button */}
			<div className="shrink-0 p-6 pb-0">
				<div className="mb-4 flex items-center justify-between gap-4">
					<h1 className="text-2xl font-bold">Kanban Board</h1>
					<div className="flex items-center gap-2">
						{/* Batch Archive Dropdown */}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="outline" size="default" className="gap-2">
									<Archive className="w-4 h-4" />
									<span className="hidden sm:inline">Batch Archive</span>
									<ChevronDown className="w-3 h-3" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								{BATCH_ARCHIVE_OPTIONS.map((option) => {
									const count = getDoneTasksCount(option.value);
									return (
										<DropdownMenuItem
											key={option.value}
											onClick={() => handleBatchArchive(option.value, option.label)}
											disabled={count === 0}
										>
											<span className="flex-1">Done before {option.label}</span>
											<span className="ml-2 text-xs text-muted-foreground">
												({count})
											</span>
										</DropdownMenuItem>
									);
								})}
							</DropdownMenuContent>
						</DropdownMenu>
						{/* New Task Button */}
						<Button
							onClick={onNewTask}
							className="bg-green-600 hover:bg-green-700"
						>
							<Plus className="w-4 h-4 mr-2" />
							New Task
						</Button>
					</div>
				</div>
			</div>

			{/* Board with scrollable columns */}
			<div className="flex-1 overflow-hidden px-6 pb-6">
				<Board tasks={tasks} loading={loading} onTasksUpdate={onTasksUpdate} />
			</div>
		</div>
	);
}
