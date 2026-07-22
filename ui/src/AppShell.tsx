import { createContext, useCallback, useContext, useEffect, useRef, useState, lazy, Suspense } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { Task } from "./models/task";
import { api, getProjectStatus } from "./api/client";
import { useSSEEvent } from "./contexts/SSEContext";
import { AppSidebar, TaskCreateForm, SearchCommandDialog, NotificationBell, TaskDetailSheet } from "./components/organisms";
import { WorkspacePicker } from "./components/organisms/WorkspacePicker";
import { RuntimeMonitorPanel } from "./components/organisms/RuntimeMonitorPanel";
import { WelcomePage } from "./pages/WelcomePage";
import { ConnectionStatus, ThemeToggle, ErrorBoundary } from "./components/atoms";
import { HeaderTimeTracker } from "./components/molecules";
import { AppBreadcrumb } from "./components/molecules/AppBreadcrumb";
import { SidebarProvider, SidebarTrigger } from "./components/ui/sidebar";
import { Separator } from "./components/ui/separator";
import { Toaster } from "./components/ui/sonner";
import { useConfig } from "./contexts/ConfigContext";
import { useGlobalTask } from "./contexts/GlobalTaskContext";
import { Loader2 } from "lucide-react";
import { ThemeContext } from "./App";
import { cn } from "./lib/utils";

// Retry wrapper for lazy imports — auto-reloads when chunks are stale after a deploy.
function lazyWithRetry(factory: () => Promise<{ default: React.ComponentType<any> }>) {
	return lazy(() =>
		factory().catch((err) => {
			// In development, surface the real error to the ErrorBoundary instead of
			// triggering a reload loop that hides the root cause.
			if (import.meta.env.DEV) {
				throw err;
			}

			window.location.reload();
			// Return a never-resolving promise so React doesn't render a broken component.
			return new Promise(() => {});
		}),
	);
}

const ConfigPage = lazyWithRetry(() => import("./pages/ConfigPage"));
const DashboardPage = lazyWithRetry(() => import("./pages/DashboardPage"));
const DocsPage = lazyWithRetry(() => import("./pages/DocsPage"));
const ImportsPage = lazyWithRetry(() => import("./pages/ImportsPage"));
const KanbanPage = lazyWithRetry(() => import("./pages/KanbanPage"));
const TasksPage = lazyWithRetry(() => import("./pages/TasksPage"));
const ChatPage = lazyWithRetry(() => import("./pages/ChatPage"));
const GraphPage = lazyWithRetry(() => import("./pages/GraphPage"));
const MemoryPage = lazyWithRetry(() => import("./pages/MemoryPage"));
const DecisionPage = lazyWithRetry(() => import("./pages/DecisionPage"));
const AuditPage = lazyWithRetry(() => import("./pages/AuditPage"));

function PageLoading() {
	return (
		<div className="flex-1 flex items-center justify-center">
			<div className="flex items-center gap-2 text-muted-foreground">
				<Loader2 className="w-5 h-5 animate-spin" />
				<span>Loading...</span>
			</div>
		</div>
	);
}

function getCurrentPage(pathname: string) {
	if (pathname.startsWith("/dashboard")) return "dashboard";
	if (pathname.startsWith("/tasks")) return "tasks";
	if (pathname.startsWith("/docs")) return "docs";
	if (pathname.startsWith("/imports")) return "imports";
	if (pathname.startsWith("/graph")) return "graph";
	if (pathname.startsWith("/memory")) return "memory";
	if (pathname.startsWith("/decisions")) return "decisions";
	if (pathname.startsWith("/audit")) return "audit";
	if (pathname.startsWith("/chat")) return "chat";
	if (pathname.startsWith("/config")) return "config";
	if (pathname.startsWith("/kanban")) return "kanban";
	if (pathname === "/" || pathname === "") return "dashboard";
	return "dashboard";
}

function getTaskIdFromLocation(pathname: string, searchStr: string, page?: string): string | null {
	const prefix = page || "(?:kanban|tasks)";
	const match =
		pathname.match(new RegExp(`^/${prefix}/([^?]+)`)) ||
		searchStr.match(/[?&]id=([^&]+)/);
	return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export default function AppShell() {
	const { config, refetch: refetchConfig } = useConfig();
	const { currentTaskId, closeTask } = useGlobalTask();
	const navigate = useNavigate();
	const location = useRouterState({ select: (state) => state.location });
	const [tasks, setTasks] = useState<Task[]>([]);
	const [directTask, setDirectTask] = useState<Task | null>(null);
	const [loading, setLoading] = useState(true);
	const currentRequestRef = useRef<{ generation: number; controller?: AbortController }>({ generation: 0 });
	const directRequestRef = useRef<{ generation: number; controller?: AbortController }>({ generation: 0 });
	const [projectActive, setProjectActive] = useState<boolean | null>(null);
	const [serverVersion, setServerVersion] = useState<string>("");
	const [showCreateForm, setShowCreateForm] = useState(false);
	const [showCommandDialog, setShowCommandDialog] = useState(false);
	const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [isDark, setIsDark] = useState(() => {
		if (typeof window !== "undefined") {
			const saved = localStorage.getItem("theme");
			if (saved) return saved === "dark";
			return window.matchMedia("(prefers-color-scheme: dark)").matches;
		}
		return false;
	});

	const currentPage = getCurrentPage(location.pathname);
	const isChatPage = currentPage === "chat";
	const currentTasks = tasks;
	const routeTaskId = currentPage === "tasks"
		? getTaskIdFromLocation(location.pathname, location.searchStr, "tasks")
		: null;
	const requestedDirectTaskId = currentTaskId || routeTaskId;

	const loadCurrentTasks = useCallback(async (showLoading = false) => {
		currentRequestRef.current.controller?.abort();
		const controller = new AbortController();
		const generation = currentRequestRef.current.generation + 1;
		currentRequestRef.current = { generation, controller };
		if (showLoading) setLoading(true);
		try {
			const data = await api.getTasks({ signal: controller.signal });
			if (currentRequestRef.current.generation === generation) {
				setTasks(data.filter((task) => task.lifecycleState !== "archived"));
			}
		} catch (error) {
			if (!(error instanceof DOMException && error.name === "AbortError")) {
				console.error("Failed to load tasks:", error);
			}
		} finally {
			if (currentRequestRef.current.generation === generation) setLoading(false);
		}
	}, []);

	// Update document title based on current page
	useEffect(() => {
		const titles: Record<string, string> = {
			dashboard: "Dashboard",
			kanban: "Kanban",
			tasks: "Tasks",
			docs: "Docs",
			graph: "Graph",
			memory: "Memories",
			decisions: "Decisions",
			audit: "Audit Trail",
			imports: "Imports",
			chat: "Chat",
			config: "Settings",
		};
		const pageTitle = titles[currentPage] || "Dashboard";
		const projectName = config.name || "Knowns";
		document.title = `${pageTitle} · ${projectName}`;
	}, [currentPage, config.name]);

	const handleSidebarOpenChange = (open: boolean) => {
		setSidebarOpen(open);
	};

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
		getProjectStatus()
			.then((s) => {
				setProjectActive(s.active);
				if (s.version) setServerVersion(s.version);
			})
			.catch(() => setProjectActive(true));
	}, []);

	useEffect(() => {
		void loadCurrentTasks(true);
		return () => currentRequestRef.current.controller?.abort();
	}, [loadCurrentTasks]);

	useEffect(() => {
		directRequestRef.current.controller?.abort();
		const generation = directRequestRef.current.generation + 1;
		if (!requestedDirectTaskId || tasks.some((task) => task.id === requestedDirectTaskId)) {
			directRequestRef.current = { generation };
			setDirectTask(null);
			return;
		}
		const controller = new AbortController();
		directRequestRef.current = { generation, controller };
		api.getTask(requestedDirectTaskId, { signal: controller.signal })
			.then((task) => {
				if (directRequestRef.current.generation === generation) setDirectTask(task);
			})
			.catch((error) => {
				if (!(error instanceof DOMException && error.name === "AbortError")) setDirectTask(null);
			});
		return () => controller.abort();
	}, [requestedDirectTaskId, tasks]);

	useSSEEvent("tasks:updated", ({ task }) => {
		currentRequestRef.current.controller?.abort();
		currentRequestRef.current = { generation: currentRequestRef.current.generation + 1 };
		setTasks((prevTasks) => {
			const existingIndex = prevTasks.findIndex((t) => t.id === task.id);
			if (task.lifecycleState === "archived") {
				return existingIndex >= 0 ? prevTasks.filter((item) => item.id !== task.id) : prevTasks;
			}
			if (existingIndex >= 0) {
				const newTasks = [...prevTasks];
				newTasks[existingIndex] = task;
				return newTasks;
			}
			return [...prevTasks, task];
		});
		setDirectTask((current) => current?.id === task.id ? task : current);
	});

	useSSEEvent("tasks:refresh", () => {
		void loadCurrentTasks();
	});

	// Handle workspace switch — full page reload for clean state
	useSSEEvent("refresh", (data) => {
		if (data?.reason === "workspace-switch") {
			window.location.reload();
		}
	}, []);

	const handleTaskCreated = () => {
		void loadCurrentTasks();
	};

	const handleTasksUpdate = (updatedTasks: Task[]) => {
		currentRequestRef.current.controller?.abort();
		currentRequestRef.current = { generation: currentRequestRef.current.generation + 1 };
		setTasks(updatedTasks.filter((task) => task.lifecycleState !== "archived"));
	};

	const toggleTheme = async (event: React.MouseEvent<HTMLButtonElement>) => {
		const newIsDark = !isDark;

		if (
			!document.startViewTransition ||
			window.matchMedia("(prefers-reduced-motion: reduce)").matches
		) {
			setIsDark(newIsDark);
			return;
		}

		const x = event.clientX;
		const y = event.clientY;
		const endRadius = Math.hypot(
			Math.max(x, window.innerWidth - x),
			Math.max(y, window.innerHeight - y),
		);

		const transition = document.startViewTransition(() => {
			setIsDark(newIsDark);
		});

		await transition.ready;

		document.documentElement.animate(
			{
				clipPath: [
					`circle(0px at ${x}px ${y}px)`,
					`circle(${endRadius}px at ${x}px ${y}px)`,
				],
			},
			{
				duration: 400,
				easing: "ease-out",
				pseudoElement: "::view-transition-new(root)",
			},
		);
	};

	const handleSearchTaskSelect = (task: Task) => {
		navigate({ to: `/kanban/${task.id}` });
	};

	const handleSearchDocSelect = (doc?: { path?: string; filename?: string }) => {
		if (doc?.path) {
			navigate({ to: `/docs/${doc.path}` });
		} else if (doc?.filename) {
			navigate({ to: `/docs/${doc.filename}` });
		} else {
			navigate({ to: "/docs" });
		}
	};

	const renderPage = () => {
		switch (currentPage) {
			case "dashboard":
				return <DashboardPage tasks={currentTasks} loading={loading} />;
			case "kanban":
				return (
					<KanbanPage
						tasks={currentTasks}
						loading={loading}
						onTasksUpdate={handleTasksUpdate}
						onNewTask={() => setShowCreateForm(true)}
					/>
				);
			case "tasks": {
				const selectedTask = routeTaskId
					? tasks.find((task) => task.id === routeTaskId) || (directTask?.id === routeTaskId ? directTask : null)
					: null;

				return (
					<TasksPage
					tasks={currentTasks}
						loading={loading}
						onTasksUpdate={handleTaskCreated}
						selectedTask={selectedTask}
						onTaskClose={() => {
							navigate({ to: "/tasks" });
						}}
						onNewTask={() => setShowCreateForm(true)}
					/>
				);
			}
			case "docs":
				return <DocsPage />;
			case "graph":
				return <GraphPage />;
			case "memory":
				return <MemoryPage />;
			case "decisions":
				return <DecisionPage />;
			case "audit":
				return <AuditPage />;
			case "imports":
				return <ImportsPage />;
			case "chat":
				return <ChatPage />;
			case "config":
				return <ConfigPage />;
			default:
				return <DashboardPage tasks={currentTasks} loading={loading} />;
		}
	};

	return (
		<ThemeContext.Provider value={{ isDark, toggle: toggleTheme }}>
			{projectActive === null && (
				<div className="flex flex-1 items-center justify-center min-h-screen">
					<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
				</div>
			)}
			{projectActive === false && (
				<WelcomePage onProjectSelected={() => window.location.reload()} />
			)}
			{projectActive === true && (
			<SidebarProvider open={sidebarOpen} onOpenChange={handleSidebarOpenChange}>
				<AppSidebar
					currentPage={currentPage}
					onSearchClick={() => setShowCommandDialog(true)}
					onWorkspacePickerClick={() => setShowWorkspacePicker(true)}
					serverVersion={serverVersion}
				/>
					<main className={cn("flex min-w-0 flex-1 flex-col overflow-hidden", isChatPage ? "bg-background" : "bg-background")}>
						<header
							className={cn(
								"flex shrink-0 items-center gap-1.5 px-2 sm:px-4",
								isChatPage
									? "h-11 border-b border-border/50 bg-background/95 px-4 sm:px-6"
									: "h-11 border-b border-border/50 bg-background sm:gap-2",
							)}
						>
							<SidebarTrigger className={cn("-ml-1", isChatPage && "opacity-80")} />
							<Separator orientation="vertical" className={cn("mr-1 h-4 sm:mr-2", isChatPage && "opacity-50")} />
							<ConnectionStatus />
							<AppBreadcrumb
								currentPage={currentPage}
								projectName={config.name || "Knowns"}
							/>
							{!isChatPage && (
								<HeaderTimeTracker
									onTaskClick={(taskId) => {
										navigate({ to: `/kanban/${taskId}` });
									}}
								/>
							)}
							<ThemeToggle
								isDark={isDark}
								onToggle={toggleTheme}
								size="sm"
								className={cn(isChatPage && "scale-95 opacity-80")}
							/>
							{!isChatPage && <NotificationBell />}
						</header>

						<div
							className={cn(
								"flex-1 w-full overflow-x-hidden flex flex-col",
								isChatPage ? "min-h-0 overflow-hidden bg-muted/10" : "overflow-y-auto",
							)}
						>
							<ErrorBoundary>
								<Suspense fallback={<PageLoading />}>
									<div
										key={currentPage}
										className="animate-page-in flex-1 flex flex-col min-h-0"
									>
										{renderPage()}
									</div>
							</Suspense>
						</ErrorBoundary>
					</div>
						<RuntimeMonitorPanel />
					</main>

					<TaskCreateForm
					isOpen={showCreateForm}
					allTasks={currentTasks}
					onClose={() => setShowCreateForm(false)}
					onCreated={handleTaskCreated}
				/>

				<SearchCommandDialog
					open={showCommandDialog}
					onOpenChange={setShowCommandDialog}
					onTaskSelect={handleSearchTaskSelect}
					onDocSelect={handleSearchDocSelect}
				/>

				<WorkspacePicker
					open={showWorkspacePicker}
					onOpenChange={setShowWorkspacePicker}
					onSwitched={() => window.location.reload()}
				/>

				<TaskDetailSheet
					task={currentTaskId ? tasks.find((t) => t.id === currentTaskId) || (directTask?.id === currentTaskId ? directTask : null) : null}
					allTasks={currentTasks}
					onClose={closeTask}
					onUpdate={(updatedTask) => {
						setTasks((prev) => prev.map((t) => (t.id === updatedTask.id ? updatedTask : t)));
					}}
					onLifecycleChange={handleTaskCreated}
				/>
			</SidebarProvider>
			)}
			<Toaster />
		</ThemeContext.Provider>
	);
}
