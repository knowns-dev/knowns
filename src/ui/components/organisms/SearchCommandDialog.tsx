import { useEffect, useState } from "react";
import { FileText, ListTodo } from "lucide-react";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "../ui/command";
import { Dialog, DialogContent } from "../ui/dialog";
import type { Task } from "../../models/task";

interface SearchCommandDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onTaskSelect: (task: Task) => void;
	onDocSelect: (doc?: { path?: string; filename?: string }) => void;
}

interface DocItem {
	filename: string;
	path: string;
	metadata?: {
		title?: string;
		description?: string;
		tags?: string[];
	};
}

interface SearchResult {
	tasks: Task[];
	docs: DocItem[];
}

// Status badge colors
const STATUS_COLORS: Record<string, string> = {
	"todo": "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
	"in-progress": "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
	"in-review": "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
	"done": "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
	"blocked": "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
	"on-hold": "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
};

// Status labels
const STATUS_LABELS: Record<string, string> = {
	"todo": "To Do",
	"in-progress": "In Progress",
	"in-review": "In Review",
	"done": "Done",
	"blocked": "Blocked",
	"on-hold": "On Hold",
};

export default function SearchCommandDialog({
	open,
	onOpenChange,
	onTaskSelect,
	onDocSelect,
}: SearchCommandDialogProps) {
	const [search, setSearch] = useState("");
	const [results, setResults] = useState<SearchResult>({ tasks: [], docs: [] });
	const [loading, setLoading] = useState(false);

	// Search using API with debounce
	useEffect(() => {
		if (!open) {
			setSearch("");
			setResults({ tasks: [], docs: [] });
			return;
		}

		if (!search.trim()) {
			setResults({ tasks: [], docs: [] });
			return;
		}

		setLoading(true);
		const timeoutId = setTimeout(() => {
			fetch(`/api/search?q=${encodeURIComponent(search)}`)
				.then((res) => res.json())
				.then((data) => {
					setResults({
						tasks: data.tasks || [],
						docs: data.docs || [],
					});
				})
				.catch((err) => {
					console.error("Search failed:", err);
					setResults({ tasks: [], docs: [] });
				})
				.finally(() => {
					setLoading(false);
				});
		}, 300); // Debounce 300ms

		return () => clearTimeout(timeoutId);
	}, [search, open]);

	const handleTaskSelect = (task: Task) => {
		onTaskSelect(task);
		onOpenChange(false);
		setSearch("");
	};

	const handleDocSelect = (doc: DocItem) => {
		onDocSelect(doc);
		onOpenChange(false);
		setSearch("");
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="overflow-hidden p-0 max-w-2xl" hideClose>
				<Command shouldFilter={false}>
					<CommandInput
						placeholder="Search tasks and docs..."
						value={search}
						onValueChange={setSearch}
					/>
					<CommandList>
						<CommandEmpty>
							{loading ? "Searching..." : search ? "No results found." : "Type to search..."}
						</CommandEmpty>

						{results.tasks.length > 0 && (
							<CommandGroup heading="Tasks">
								{results.tasks.slice(0, 8).map((task) => {
									const statusColor = STATUS_COLORS[task.status] || STATUS_COLORS.todo;
									const statusLabel = STATUS_LABELS[task.status] || task.status;

									return (
										<CommandItem
											key={task.id}
											value={`task-${task.id}`}
											onSelect={() => handleTaskSelect(task)}
										>
											<ListTodo className="mr-2 h-4 w-4 shrink-0" />
											<div className="flex-1 min-w-0">
												<div className="flex items-center gap-2 mb-1">
													<span className="text-xs font-mono text-muted-foreground">
														#{task.id}
													</span>
													<span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor}`}>
														{statusLabel}
													</span>
												</div>
												<div className="font-medium truncate">
													{task.title}
												</div>
											</div>
										</CommandItem>
									);
								})}
							</CommandGroup>
						)}

						{results.tasks.length > 0 && results.docs.length > 0 && (
							<CommandSeparator />
						)}

						{results.docs.length > 0 && (
							<CommandGroup heading="Documentation">
								{results.docs.slice(0, 8).map((doc) => {
									const title = doc.metadata?.title || doc.filename;

									return (
										<CommandItem
											key={doc.path}
											value={`doc-${doc.path}`}
											onSelect={() => handleDocSelect(doc)}
										>
											<FileText className="mr-2 h-4 w-4 shrink-0" />
											<div className="flex-1 min-w-0">
												<div className="font-medium truncate mb-1">
													{title}
												</div>
												<div className="flex items-center gap-2 text-xs text-muted-foreground">
													<span className="truncate">{doc.path}</span>
												</div>
											</div>
										</CommandItem>
									);
								})}
							</CommandGroup>
						)}
					</CommandList>
				</Command>
			</DialogContent>
		</Dialog>
	);
}
