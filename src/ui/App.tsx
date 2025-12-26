import { createContext, useContext, useEffect, useState } from "react";
import type { Task } from "../models/task";
import { api, connectWebSocket } from "./api/client";
import SearchBox from "./components/SearchBox";
import Sidebar from "./components/Sidebar";
import TaskCreateForm from "./components/TaskCreateForm";
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

// Icons
const Icons = {
	Sun: () => (
		<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
			/>
		</svg>
	),
	Moon: () => (
		<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
			/>
		</svg>
	),
	Plus: () => (
		<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
		</svg>
	),
};

export default function App() {
	const [tasks, setTasks] = useState<Task[]>([]);
	const [loading, setLoading] = useState(true);
	const [showCreateForm, setShowCreateForm] = useState(false);
	const [searchSelectedTask, setSearchSelectedTask] = useState<Task | null>(null);
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
		if (hash === "/" || hash === "") return "kanban";
		return "kanban"; // default
	};

	const [currentPage, setCurrentPage] = useState(getCurrentRoute());

	// Listen to hash changes for routing
	useEffect(() => {
		const handleHashChange = () => {
			setCurrentPage(getCurrentRoute());
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

	useEffect(() => {
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
		setCurrentPage("tasks");
		setSearchSelectedTask(task);
	};

	// Handle search doc select
	const handleSearchDocSelect = () => {
		setCurrentPage("docs");
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
			case "tasks":
				return (
					<TasksPage
						tasks={tasks}
						loading={loading}
						onTasksUpdate={handleTaskCreated}
						selectedTask={searchSelectedTask}
						onTaskClose={() => setSearchSelectedTask(null)}
						onNewTask={() => setShowCreateForm(true)}
					/>
				);
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
			<div
				className={`min-h-screen transition-colors duration-200 flex ${isDark ? "bg-gray-900" : "bg-gray-100"}`}
			>
				{/* Sidebar */}
				<Sidebar currentPage={currentPage} />

				{/* Main Content */}
				<div className="flex-1 flex flex-col min-h-screen">
					{/* Header */}
					<header
						className={`shadow transition-colors duration-200 ${isDark ? "bg-gray-800" : "bg-white"}`}
					>
						<div className="px-6 py-3 flex items-center justify-between gap-4">
							{/* Search Box */}
							<div className="flex-1 max-w-2xl">
								<SearchBox
									onTaskSelect={handleSearchTaskSelect}
									onDocSelect={handleSearchDocSelect}
								/>
							</div>

							{/* Dark mode toggle */}
							<button
								type="button"
								onClick={toggleTheme}
								className={`p-2 rounded-lg transition-colors ${
									isDark
										? "bg-gray-700 text-yellow-400 hover:bg-gray-600"
										: "bg-gray-100 text-gray-600 hover:bg-gray-200"
								}`}
								aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
							>
								{isDark ? <Icons.Sun /> : <Icons.Moon />}
							</button>
						</div>
					</header>

					{/* Page Content */}
					<main className="flex-1 overflow-auto">{renderPage()}</main>
				</div>

				{/* Task Create Form Modal */}
				<TaskCreateForm
					isOpen={showCreateForm}
					allTasks={tasks}
					onClose={() => setShowCreateForm(false)}
					onCreated={handleTaskCreated}
				/>
			</div>
		</ThemeContext.Provider>
	);
}
