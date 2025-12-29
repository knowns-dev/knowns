import { useEffect, useState } from "react";
import { Search, X, ClipboardList, FileText } from "lucide-react";
import type { Task } from "../../models/task";
import { Input } from "../ui/input";

interface Doc {
	filename: string;
	path: string;
	folder: string;
	metadata: {
		title: string;
		description?: string;
		tags?: string[];
	};
	content: string;
}

interface SearchBoxProps {
	onTaskSelect?: (task: Task) => void;
	onDocSelect?: (doc: Doc) => void;
}


export default function SearchBox({ onTaskSelect, onDocSelect }: SearchBoxProps) {
	const [query, setQuery] = useState("");
	const [tasks, setTasks] = useState<Task[]>([]);
	const [docs, setDocs] = useState<Doc[]>([]);
	const [loading, setLoading] = useState(false);
	const [showResults, setShowResults] = useState(false);

	useEffect(() => {
		if (query.length < 2) {
			setTasks([]);
			setDocs([]);
			setShowResults(false);
			return;
		}

		const debounce = setTimeout(() => {
			performSearch();
		}, 300);

		return () => clearTimeout(debounce);
	}, [query]);

	const performSearch = async () => {
		setLoading(true);
		try {
			const response = await fetch(
				`/api/search?q=${encodeURIComponent(query)}`
			);
			const data = await response.json();
			setTasks(data.tasks || []);
			setDocs(data.docs || []);
			setShowResults(true);
		} catch (error) {
			console.error("Search failed:", error);
		} finally {
			setLoading(false);
		}
	};

	const clearSearch = () => {
		setQuery("");
		setTasks([]);
		setDocs([]);
		setShowResults(false);
	};

	const handleTaskClick = (task: Task) => {
		if (onTaskSelect) onTaskSelect(task);
		clearSearch();
	};

	const handleDocClick = (doc: Doc) => {
		if (onDocSelect) onDocSelect(doc);
		clearSearch();
	};

	const totalResults = tasks.length + docs.length;

	return (
		<div className="relative w-full max-w-2xl">
			{/* Search Input */}
			<div className="relative">
				<div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
					<Search className="w-5 h-5 text-muted-foreground" />
				</div>
				<Input
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search tasks and docs..."
					className="pl-10 pr-10"
				/>
				{query && (
					<button
						type="button"
						onClick={clearSearch}
						className="absolute inset-y-0 right-0 pr-3 flex items-center text-muted-foreground hover:text-foreground transition-colors"
					>
						<X className="w-4 h-4" />
					</button>
				)}
			</div>

			{/* Search Results Dropdown */}
			{showResults && query.length >= 2 && (
				<div className="absolute z-50 w-full mt-2 bg-card rounded-lg border shadow-lg max-h-96 overflow-y-auto">
					{loading && (
						<div className="p-4 text-center">
							<span className="text-muted-foreground">Searching...</span>
						</div>
					)}

					{!loading && totalResults === 0 && (
						<div className="p-4 text-center">
							<span className="text-muted-foreground">No results found for "{query}"</span>
						</div>
					)}

					{!loading && totalResults > 0 && (
						<div className="py-2">
							{/* Tasks */}
							{tasks.length > 0 && (
								<div>
									<div className="px-4 py-2 text-muted-foreground text-xs font-semibold uppercase">
										Tasks ({tasks.length})
									</div>
									{tasks.map((task) => (
										<button
											key={task.id}
											type="button"
											onClick={() => handleTaskClick(task)}
											className="w-full text-left px-4 py-2 hover:bg-accent transition-colors flex items-start gap-3"
										>
											<ClipboardList className="w-4 h-4 mt-1 text-muted-foreground" />
											<div className="flex-1 min-w-0">
												<div className="flex items-center gap-2">
													<span className="text-xs text-muted-foreground font-mono">{task.id}</span>
													<span
														className={`text-xs px-1.5 py-0.5 rounded ${
															task.priority === "high"
																? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
																: task.priority === "medium"
																	? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
																	: "bg-muted text-muted-foreground"
														}`}
													>
														{task.priority}
													</span>
												</div>
												<p className="font-medium mt-1">{task.title}</p>
												{task.description && (
													<p className="text-sm text-muted-foreground line-clamp-1 mt-1">
														{task.description}
													</p>
												)}
											</div>
										</button>
									))}
								</div>
							)}

							{/* Docs */}
							{docs.length > 0 && (
								<div className={tasks.length > 0 ? "mt-2 pt-2 border-t" : ""}>
									<div className="px-4 py-2 text-muted-foreground text-xs font-semibold uppercase">
										Documentation ({docs.length})
									</div>
									{docs.map((doc) => (
										<button
											key={doc.filename}
											type="button"
											onClick={() => handleDocClick(doc)}
											className="w-full text-left px-4 py-2 hover:bg-accent transition-colors flex items-start gap-3"
										>
											<FileText className="w-4 h-4 mt-1 text-muted-foreground" />
											<div className="flex-1 min-w-0">
												<p className="font-medium">{doc.metadata.title}</p>
												{doc.metadata.description && (
													<p className="text-sm text-muted-foreground line-clamp-1 mt-1">
														{doc.metadata.description}
													</p>
												)}
												{doc.metadata.tags && doc.metadata.tags.length > 0 && (
													<div className="flex gap-1 mt-1">
														{doc.metadata.tags.slice(0, 3).map((tag) => (
															<span
																key={tag}
																className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
															>
																{tag}
															</span>
														))}
													</div>
												)}
											</div>
										</button>
									))}
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
