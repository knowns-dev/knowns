import { createContext, useContext, useEffect, useState } from "react";
import type { Task } from "../models/task";
import { api, connectWebSocket, getConfig } from "./api/client";
import { AppSidebar } from "./components/AppSidebar";
import TaskCreateForm from "./components/TaskCreateForm";
import SearchCommandDialog from "./components/SearchCommandDialog";
import NotificationBell from "./components/NotificationBell";
import { SidebarProvider, SidebarTrigger } from "./components/ui/sidebar";
import { Separator } from "./components/ui/separator";
import { UserProvider } from "./contexts/UserContext";
import ConfigPage from "./pages/ConfigPage";
import DocsPage from "./pages/DocsPage";
import KanbanPage from "./pages/KanbanPage";
import TasksPage from "./pages/TasksPage";

// Dark mode context
interface ThemeContextType {
	isDark: boolean;
	toggle: () => void;
}

export const ThemeContext = createContext<ThemeContextType>({
	isDark: false,
	toggle: () => {},
});

export const useTheme = () => useContext(ThemeContext);

export default function App() {
	const [tasks, setTasks] = useState<Task[]>([]);
	const [loading, setLoading] = useState(true);
	const [showCreateForm, setShowCreateForm] = useState(false);
	const [showCommandDialog, setShowCommandDialog] = useState(false);
	const [projectName, setProjectName] = useState("Knowns");
	const [isDark, setIsDark] = useState(() => {
		if (typeof window !== "undefined") {
			const saved = localStorage.getItem("theme");
			if (saved) return saved === "dark";
			return window.matchMedia("(prefers-color-scheme: dark)").matches;
		}
		return false;
	});

	// Get current route from hash
	const getCurrentRoute = () => {
		const hash = window.location.hash.slice(1); // Remove #
		if (hash.startsWith("/tasks")) return "tasks";
		if (hash.startsWith("/docs")) return "docs";
		if (hash.startsWith("/config")) return "config";
		if (hash.startsWith("/kanban")) return "kanban";
		if (hash === "/" || hash === "") return "kanban";
		return "kanban"; // default
	};

	// Extract task ID from hash (e.g., #/tasks/42, #/kanban/42, or #/tasks?id=42)
	const getTaskIdFromHash = (page?: string): string | null => {
		const hash = window.location.hash.slice(1);

		// Support both /tasks/42, /kanban/42 and /tasks?id=42 formats
		const prefix = page || "(?:kanban|tasks)";
		const match =
			hash.match(new RegExp(`^\/${prefix}\/([^?]+)`)) || hash.match(/[?&]id=([^&]+)/);
		return match ? match[1] : null;
	};

	const [currentPage, setCurrentPage] = useState(getCurrentRoute());
	const [currentHash, setCurrentHash] = useState(window.location.hash);

	// Listen to hash changes for routing
	useEffect(() => {
		const handleHashChange = () => {
			setCurrentPage(getCurrentRoute());
			setCurrentHash(window.location.hash);
		};

		window.addEventListener("hashchange", handleHashChange);
		return () => window.removeEventListener("hashchange", handleHashChange);
	}, [getCurrentRoute]);

	// Apply dark mode class to document
	useEffect(() => {
		if (isDark) {
			document.documentElement.classList.add("dark");
			localStorage.setItem("theme", "dark");
		} else {
			document.documentElement.classList.remove("dark");
			localStorage.setItem("theme", "light");
		}
	}, [isDark]);

	// Keyboard shortcut for command dialog (⌘K / Ctrl+K)
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "k") {
				e.preventDefault();
				setShowCommandDialog((prev) => !prev);
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, []);

	useEffect(() => {
		// Fetch config for project name
		getConfig()
			.then((config) => {
				if (config?.name) {
					setProjectName(config.name as string);
				}
			})
			.catch((err) => console.error("Failed to load config:", err));

		api
			.getTasks()
			.then((data) => {
				setTasks(data);
				setLoading(false);
			})
			.catch((err) => {
				console.error("Failed to load tasks:", err);
				setLoading(false);
			});

		const ws = connectWebSocket((data) => {
			if (data.type === "tasks:updated" && data.task) {
				// Update specific task instead of reloading all tasks
				setTasks((prevTasks) => {
					const existingIndex = prevTasks.findIndex((t) => t.id === data.task?.id);
					if (existingIndex >= 0) {
						// Update existing task
						const newTasks = [...prevTasks];
						newTasks[existingIndex] = data.task;
						return newTasks;
					}
					// Add new task
					return [...prevTasks, data.task];
				});
			} else if (data.type === "tasks:refresh") {
				// Reload all tasks (CLI bulk operation)
				api.getTasks().then(setTasks).catch(console.error);
			}
		});

		return () => {
			if (ws) ws.close();
		};
	}, []);

	const handleTaskCreated = () => {
		api.getTasks().then(setTasks).catch(console.error);
	};

	const handleTasksUpdate = (updatedTasks: Task[]) => {
		setTasks(updatedTasks);
	};

	const toggleTheme = () => setIsDark((prev) => !prev);

	// Handle search task select
	const handleSearchTaskSelect = (task: Task) => {
		// Navigate to kanban view with task detail
		window.location.hash = `/kanban/${task.id}`;
		// State will be updated via hashchange listener
	};

	// Handle search doc select
	const handleSearchDocSelect = (doc?: { path?: string; filename?: string }) => {
		// Update URL hash to /docs/path
		if (doc?.path) {
			window.location.hash = `/docs/${doc.path}`;
		} else if (doc?.filename) {
			window.location.hash = `/docs/${doc.filename}`;
		} else {
			window.location.hash = "/docs";
		}
	};

	// Render current page
	const renderPage = () => {
		switch (currentPage) {
			case "kanban":
				return (
					<KanbanPage
						tasks={tasks}
						loading={loading}
						onTasksUpdate={handleTasksUpdate}
						onNewTask={() => setShowCreateForm(true)}
					/>
				);
			case "tasks": {
				// Get task ID from hash
				const taskId = getTaskIdFromHash();
				const selectedTask = taskId ? tasks.find((t) => t.id === taskId) : null;

				return (
					<TasksPage
						tasks={tasks}
						loading={loading}
						onTasksUpdate={handleTaskCreated}
						selectedTask={selectedTask}
						onTaskClose={() => {
							// Clear task ID from hash, keep on /tasks page
							window.location.hash = "/tasks";
						}}
						onNewTask={() => setShowCreateForm(true)}
					/>
				);
			}
			case "docs":
				return <DocsPage />;
			case "config":
				return <ConfigPage />;
			default:
				return (
					<KanbanPage
						tasks={tasks}
						loading={loading}
						onTasksUpdate={handleTasksUpdate}
						onNewTask={() => setShowCreateForm(true)}
					/>
				);
		}
	};

	return (
		<ThemeContext.Provider value={{ isDark, toggle: toggleTheme }}>
			<UserProvider>
				<SidebarProvider>
				<AppSidebar
					currentPage={currentPage}
					isDark={isDark}
					onToggleTheme={toggleTheme}
					onSearchClick={() => setShowCommandDialog(true)}
				/>
				<main className="flex flex-1 flex-col bg-background overflow-hidden">
					{/* Header with Trigger */}
					<header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
						<SidebarTrigger className="-ml-1" />
						<Separator orientation="vertical" className="mr-2 h-4" />
						<div className="flex flex-1 items-center gap-2 text-sm">
							<span className={`font-semibold ${isDark ? "text-gray-100" : "text-gray-900"}`}>
								{projectName}
							</span>
						</div>
						<NotificationBell />
					</header>

					{/* Page Content */}
					<div className="flex-1 w-full overflow-y-auto overflow-x-hidden">{renderPage()}</div>
				</main>

				{/* Task Create Form Modal */}
				<TaskCreateForm
					isOpen={showCreateForm}
					allTasks={tasks}
					onClose={() => setShowCreateForm(false)}
					onCreated={handleTaskCreated}
				/>

			{/* Command Dialog (⌘K Search) */}
			<SearchCommandDialog
				open={showCommandDialog}
				onOpenChange={setShowCommandDialog}
				onTaskSelect={handleSearchTaskSelect}
				onDocSelect={handleSearchDocSelect}
			/>
			</SidebarProvider>
			</UserProvider>
		</ThemeContext.Provider>
	);
}
