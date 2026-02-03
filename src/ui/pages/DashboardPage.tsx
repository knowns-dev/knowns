/**
 * Dashboard Page
 * Overview of tasks, docs, and SDD coverage
 */

import { useEffect, useState, useMemo } from "react";
import {
	ListTodo,
	FileText,
	ClipboardCheck,
	CheckCircle2,
	AlertTriangle,
	ChevronDown,
	ChevronUp,
	RefreshCw,
	Clock,
	TrendingUp,
	Target,
	Zap,
	Activity,
	Timer,
	ArrowRight,
} from "lucide-react";
import type { Task } from "../../models/task";
import { api, getDocs, getSDDStats, type SDDResult, type Activity as ActivityType } from "../api/client";
import { Button } from "../components/ui/button";
import { Progress } from "../components/ui/progress";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { cn, isSpec, parseACProgress, type Doc } from "../lib/utils";

interface DashboardPageProps {
	tasks: Task[];
	loading: boolean;
}

// Format duration in seconds to human readable
function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) {
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	return `${minutes}m`;
}

// Format relative time
function formatRelativeTime(date: Date): string {
	const now = new Date();
	const diff = now.getTime() - date.getTime();
	const minutes = Math.floor(diff / 60000);
	const hours = Math.floor(diff / 3600000);
	const days = Math.floor(diff / 86400000);

	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	if (days < 7) return `${days}d ago`;
	return date.toLocaleDateString();
}

// Get change description
function getChangeDescription(change: { field: string; oldValue?: unknown; newValue?: unknown }): string {
	const { field, oldValue, newValue } = change;
	switch (field) {
		case "status":
			return `status → ${newValue}`;
		case "priority":
			return `priority → ${newValue}`;
		case "assignee":
			return newValue ? `assigned to ${newValue}` : "unassigned";
		case "title":
			return "title updated";
		case "description":
			return "description updated";
		case "acceptanceCriteria":
			return "AC updated";
		default:
			return `${field} changed`;
	}
}

export default function DashboardPage({ tasks, loading }: DashboardPageProps) {
	const [docs, setDocs] = useState<Doc[]>([]);
	const [docsLoading, setDocsLoading] = useState(true);
	const [sddData, setSDDData] = useState<SDDResult | null>(null);
	const [sddLoading, setSDDLoading] = useState(true);
	const [warningsOpen, setWarningsOpen] = useState(false);
	const [passedOpen, setPassedOpen] = useState(false);
	const [activities, setActivities] = useState<ActivityType[]>([]);
	const [activitiesLoading, setActivitiesLoading] = useState(true);

	// Load docs
	useEffect(() => {
		getDocs()
			.then((d) => {
				// Server returns Doc with nested metadata, API type is simpler
				setDocs(d as unknown as Doc[]);
				setDocsLoading(false);
			})
			.catch(() => setDocsLoading(false));
	}, []);

	// Load SDD stats
	const loadSDD = async () => {
		try {
			setSDDLoading(true);
			const result = await getSDDStats();
			setSDDData(result);
		} catch (err) {
			console.error("Failed to load SDD stats:", err);
		} finally {
			setSDDLoading(false);
		}
	};

	useEffect(() => {
		loadSDD();
	}, []);

	// Load activities
	useEffect(() => {
		api.getActivities({ limit: 10 })
			.then((data) => {
				setActivities(data);
				setActivitiesLoading(false);
			})
			.catch(() => setActivitiesLoading(false));
	}, []);

	// Calculate time tracking stats
	const timeStats = useMemo(() => {
		const now = new Date();
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const weekStart = new Date(todayStart);
		weekStart.setDate(weekStart.getDate() - weekStart.getDay());

		let todaySeconds = 0;
		let weekSeconds = 0;
		let totalSeconds = 0;

		for (const task of tasks) {
			totalSeconds += task.timeSpent || 0;
			for (const entry of task.timeEntries || []) {
				const entryDate = new Date(entry.startedAt);
				if (entryDate >= todayStart) {
					todaySeconds += entry.duration || 0;
				}
				if (entryDate >= weekStart) {
					weekSeconds += entry.duration || 0;
				}
			}
		}

		return { today: todaySeconds, week: weekSeconds, total: totalSeconds };
	}, [tasks]);

	// Get recent tasks (sorted by updatedAt)
	const recentTasks = useMemo(() => {
		return [...tasks]
			.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
			.slice(0, 5);
	}, [tasks]);

	// Get spec progress data
	const specProgress = useMemo(() => {
		const specs = docs.filter((d) => isSpec(d));
		return specs.map((spec) => {
			const progress = parseACProgress(spec.content || "");
			const linkedTasks = tasks.filter((t) => {
				if (!t.spec) return false;
				const normalizedSpec = t.spec.replace(/\.md$/, "").replace(/^specs\//, "");
				const docPath = spec.path?.replace(/\.md$/, "").replace(/^specs\//, "") || "";
				return normalizedSpec === docPath;
			});
			const completedTasks = linkedTasks.filter((t) => t.status === "done").length;
			return {
				...spec,
				acProgress: progress,
				linkedTasks: linkedTasks.length,
				completedTasks,
			};
		}).slice(0, 4); // Show max 4 specs
	}, [docs, tasks]);

	// Calculate task stats
	const taskStats = {
		total: tasks.length,
		todo: tasks.filter((t) => t.status === "todo").length,
		inProgress: tasks.filter((t) => t.status === "in-progress").length,
		inReview: tasks.filter((t) => t.status === "in-review").length,
		done: tasks.filter((t) => t.status === "done").length,
		blocked: tasks.filter((t) => t.status === "blocked").length,
		highPriority: tasks.filter((t) => t.priority === "high" && t.status !== "done").length,
	};

	const taskCompletion = taskStats.total > 0 ? Math.round((taskStats.done / taskStats.total) * 100) : 0;

	// Calculate doc stats
	const docStats = {
		total: docs.length,
		local: docs.filter((d) => !d.isImported).length,
		imported: docs.filter((d) => d.isImported).length,
	};

	return (
		<div className="p-6 h-full overflow-auto">
			<div className="mb-6">
				<h1 className="text-2xl font-bold">Dashboard</h1>
				<p className="text-muted-foreground text-sm">Overview of your project</p>
			</div>

			{/* Top Row - Summary Widgets */}
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">
				{/* Tasks Widget */}
				<div className="bg-card rounded-xl border p-6 shadow-sm">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-3">
							<div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30">
								<ListTodo className="w-5 h-5 text-blue-600 dark:text-blue-400" />
							</div>
							<div>
								<h2 className="font-semibold">Tasks</h2>
								<p className="text-xs text-muted-foreground">{taskStats.total} total</p>
							</div>
						</div>
						<a
							href="#/tasks"
							className="text-xs text-blue-600 hover:underline"
						>
							View all
						</a>
					</div>

					{loading ? (
						<div className="flex items-center justify-center h-32">
							<RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
						</div>
					) : (
						<>
							{/* Completion Progress */}
							<div className="mb-4">
								<div className="flex items-center justify-between text-sm mb-2">
									<span className="text-muted-foreground">Completion</span>
									<span className="font-semibold">{taskCompletion}%</span>
								</div>
								<Progress value={taskCompletion} className="h-2" />
							</div>

							{/* Status Breakdown */}
							<div className="grid grid-cols-2 gap-3">
								<div className="flex items-center gap-2">
									<div className="w-2 h-2 rounded-full bg-gray-400" />
									<span className="text-sm text-muted-foreground">To Do</span>
									<span className="text-sm font-medium ml-auto">{taskStats.todo}</span>
								</div>
								<div className="flex items-center gap-2">
									<div className="w-2 h-2 rounded-full bg-yellow-500" />
									<span className="text-sm text-muted-foreground">In Progress</span>
									<span className="text-sm font-medium ml-auto">{taskStats.inProgress}</span>
								</div>
								<div className="flex items-center gap-2">
									<div className="w-2 h-2 rounded-full bg-blue-500" />
									<span className="text-sm text-muted-foreground">In Review</span>
									<span className="text-sm font-medium ml-auto">{taskStats.inReview}</span>
								</div>
								<div className="flex items-center gap-2">
									<div className="w-2 h-2 rounded-full bg-green-500" />
									<span className="text-sm text-muted-foreground">Done</span>
									<span className="text-sm font-medium ml-auto">{taskStats.done}</span>
								</div>
							</div>

							{/* High Priority Alert */}
							{taskStats.highPriority > 0 && (
								<div className="mt-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
									<div className="flex items-center gap-2 text-red-600 dark:text-red-400">
										<Zap className="w-4 h-4" />
										<span className="text-sm font-medium">{taskStats.highPriority} high priority task{taskStats.highPriority > 1 ? "s" : ""}</span>
									</div>
								</div>
							)}
						</>
					)}
				</div>

				{/* Docs Widget */}
				<div className="bg-card rounded-xl border p-6 shadow-sm">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-3">
							<div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
								<FileText className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
							</div>
							<div>
								<h2 className="font-semibold">Documentation</h2>
								<p className="text-xs text-muted-foreground">{docStats.total} documents</p>
							</div>
						</div>
						<a
							href="#/docs"
							className="text-xs text-emerald-600 hover:underline"
						>
							View all
						</a>
					</div>

					{docsLoading ? (
						<div className="flex items-center justify-center h-32">
							<RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
						</div>
					) : (
						<>
							{/* Doc Stats */}
							<div className="space-y-4">
								<div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
									<div className="flex items-center gap-2">
										<FileText className="w-4 h-4 text-muted-foreground" />
										<span className="text-sm">Local Docs</span>
									</div>
									<span className="text-lg font-bold">{docStats.local}</span>
								</div>
								<div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
									<div className="flex items-center gap-2">
										<FileText className="w-4 h-4 text-muted-foreground" />
										<span className="text-sm">Imported Docs</span>
									</div>
									<span className="text-lg font-bold">{docStats.imported}</span>
								</div>
							</div>
						</>
					)}
				</div>

				{/* SDD Widget */}
				<div className="bg-card rounded-xl border p-6 shadow-sm">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-3">
							<div className="p-2 rounded-lg bg-purple-100 dark:bg-purple-900/30">
								<ClipboardCheck className="w-5 h-5 text-purple-600 dark:text-purple-400" />
							</div>
							<div>
								<h2 className="font-semibold">SDD Coverage</h2>
								<p className="text-xs text-muted-foreground">Spec-Driven Development</p>
							</div>
						</div>
						<Button
							variant="ghost"
							size="sm"
							onClick={loadSDD}
							disabled={sddLoading}
							className="h-7 w-7 p-0"
						>
							<RefreshCw className={cn("w-4 h-4", sddLoading && "animate-spin")} />
						</Button>
					</div>

					{sddLoading && !sddData ? (
						<div className="flex items-center justify-center h-32">
							<RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
						</div>
					) : !sddData || sddData.stats.specs.total === 0 ? (
						<div className="flex flex-col items-center justify-center h-32 text-center">
							<ClipboardCheck className="w-8 h-8 text-muted-foreground/50 mb-2" />
							<p className="text-sm text-muted-foreground">No specs found</p>
							<p className="text-xs text-muted-foreground">Create specs in docs/specs/ folder</p>
						</div>
					) : (
						<>
							{/* Coverage Stats */}
							<div className="grid grid-cols-3 gap-2 mb-4">
								<div className="text-center p-2 rounded-lg bg-muted/50">
									<div className="text-xl font-bold">{sddData.stats.specs.total}</div>
									<div className="text-xs text-muted-foreground">Specs</div>
								</div>
								<div className="text-center p-2 rounded-lg bg-muted/50">
									<div className="text-xl font-bold">{sddData.stats.tasks.withSpec}</div>
									<div className="text-xs text-muted-foreground">Linked</div>
								</div>
								<div className="text-center p-2 rounded-lg bg-muted/50">
									<div className={cn(
										"text-xl font-bold",
										sddData.stats.coverage.percent >= 75 ? "text-green-600" :
										sddData.stats.coverage.percent >= 50 ? "text-yellow-600" : "text-red-600"
									)}>
										{sddData.stats.coverage.percent}%
									</div>
									<div className="text-xs text-muted-foreground">Coverage</div>
								</div>
							</div>

							{/* Coverage Progress */}
							<div className="mb-4">
								<div className="flex items-center justify-between text-xs mb-1">
									<span className="text-muted-foreground">Task-Spec Coverage</span>
									<span>{sddData.stats.coverage.linked}/{sddData.stats.coverage.total}</span>
								</div>
								<Progress value={sddData.stats.coverage.percent} className="h-2" />
							</div>

							{/* Warnings */}
							{sddData.warnings.length > 0 && (
								<Collapsible open={warningsOpen} onOpenChange={setWarningsOpen} className="mb-2">
									<CollapsibleTrigger className="flex items-center justify-between w-full py-1.5 text-sm hover:bg-muted/50 rounded px-2 -mx-2">
										<div className="flex items-center gap-2 text-yellow-600">
											<AlertTriangle className="w-4 h-4" />
											<span>{sddData.warnings.length} Warning{sddData.warnings.length > 1 ? "s" : ""}</span>
										</div>
										{warningsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
									</CollapsibleTrigger>
									<CollapsibleContent>
										<div className="mt-2 space-y-1 max-h-24 overflow-y-auto text-xs">
											{sddData.warnings.slice(0, 5).map((w, i) => (
												<div key={`${w.entity}-${i}`} className="text-muted-foreground truncate">
													<span className="font-mono text-yellow-600">{w.entity}</span>: {w.message}
												</div>
											))}
											{sddData.warnings.length > 5 && (
												<div className="text-muted-foreground italic">+{sddData.warnings.length - 5} more</div>
											)}
										</div>
									</CollapsibleContent>
								</Collapsible>
							)}

							{/* Passed */}
							{sddData.passed.length > 0 && (
								<Collapsible open={passedOpen} onOpenChange={setPassedOpen}>
									<CollapsibleTrigger className="flex items-center justify-between w-full py-1.5 text-sm hover:bg-muted/50 rounded px-2 -mx-2">
										<div className="flex items-center gap-2 text-green-600">
											<CheckCircle2 className="w-4 h-4" />
											<span>{sddData.passed.length} Passed</span>
										</div>
										{passedOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
									</CollapsibleTrigger>
									<CollapsibleContent>
										<div className="mt-2 space-y-1 max-h-24 overflow-y-auto text-xs">
											{sddData.passed.map((p, i) => (
												<div key={`passed-${i}`} className="text-muted-foreground flex items-center gap-1">
													<CheckCircle2 className="w-3 h-3 text-green-600 shrink-0" />
													<span className="truncate">{p}</span>
												</div>
											))}
										</div>
									</CollapsibleContent>
								</Collapsible>
							)}
						</>
					)}
				</div>
			</div>

			{/* Second Row - Time Tracking & Recent Activity */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
				{/* Time Tracking Summary */}
				<div className="bg-card rounded-xl border p-6 shadow-sm">
					<div className="flex items-center gap-3 mb-4">
						<div className="p-2 rounded-lg bg-orange-100 dark:bg-orange-900/30">
							<Timer className="w-5 h-5 text-orange-600 dark:text-orange-400" />
						</div>
						<div>
							<h2 className="font-semibold">Time Tracking</h2>
							<p className="text-xs text-muted-foreground">Hours logged</p>
						</div>
					</div>

					{loading ? (
						<div className="flex items-center justify-center h-24">
							<RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
						</div>
					) : (
						<div className="grid grid-cols-3 gap-4">
							<div className="text-center p-3 rounded-lg bg-muted/50">
								<div className="text-2xl font-bold text-orange-600 dark:text-orange-400">
									{formatDuration(timeStats.today)}
								</div>
								<div className="text-xs text-muted-foreground">Today</div>
							</div>
							<div className="text-center p-3 rounded-lg bg-muted/50">
								<div className="text-2xl font-bold text-orange-600 dark:text-orange-400">
									{formatDuration(timeStats.week)}
								</div>
								<div className="text-xs text-muted-foreground">This Week</div>
							</div>
							<div className="text-center p-3 rounded-lg bg-muted/50">
								<div className="text-2xl font-bold">
									{formatDuration(timeStats.total)}
								</div>
								<div className="text-xs text-muted-foreground">Total</div>
							</div>
						</div>
					)}
				</div>

				{/* Recent Activity */}
				<div className="bg-card rounded-xl border p-6 shadow-sm">
					<div className="flex items-center gap-3 mb-4">
						<div className="p-2 rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
							<Activity className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
						</div>
						<div>
							<h2 className="font-semibold">Recent Activity</h2>
							<p className="text-xs text-muted-foreground">Latest updates</p>
						</div>
					</div>

					{activitiesLoading ? (
						<div className="flex items-center justify-center h-32">
							<RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
						</div>
					) : activities.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-32 text-center">
							<Activity className="w-8 h-8 text-muted-foreground/50 mb-2" />
							<p className="text-sm text-muted-foreground">No recent activity</p>
						</div>
					) : (
						<div className="space-y-3 max-h-48 overflow-y-auto">
							{activities.slice(0, 5).map((activity, i) => (
								<a
									key={`${activity.taskId}-${activity.version}-${i}`}
									href={`#/kanban/${activity.taskId}`}
									className="flex items-start gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors"
								>
									<div className="w-2 h-2 rounded-full bg-indigo-500 mt-2 shrink-0" />
									<div className="flex-1 min-w-0">
										<p className="text-sm font-medium truncate">{activity.taskTitle}</p>
										<p className="text-xs text-muted-foreground">
											{activity.changes.slice(0, 2).map((c) => getChangeDescription(c)).join(", ")}
										</p>
									</div>
									<span className="text-xs text-muted-foreground shrink-0">
										{formatRelativeTime(activity.timestamp)}
									</span>
								</a>
							))}
						</div>
					)}
				</div>
			</div>

			{/* Third Row - Recent Tasks & Spec Progress */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				{/* Recent Tasks */}
				<div className="bg-card rounded-xl border p-6 shadow-sm">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-3">
							<div className="p-2 rounded-lg bg-cyan-100 dark:bg-cyan-900/30">
								<TrendingUp className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
							</div>
							<div>
								<h2 className="font-semibold">Recent Tasks</h2>
								<p className="text-xs text-muted-foreground">Recently updated</p>
							</div>
						</div>
						<a
							href="#/tasks"
							className="text-xs text-cyan-600 hover:underline flex items-center gap-1"
						>
							View all <ArrowRight className="w-3 h-3" />
						</a>
					</div>

					{loading ? (
						<div className="flex items-center justify-center h-32">
							<RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
						</div>
					) : recentTasks.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-32 text-center">
							<ListTodo className="w-8 h-8 text-muted-foreground/50 mb-2" />
							<p className="text-sm text-muted-foreground">No tasks yet</p>
						</div>
					) : (
						<div className="space-y-2">
							{recentTasks.map((task) => (
								<a
									key={task.id}
									href={`#/kanban/${task.id}`}
									className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors"
								>
									<div className={cn(
										"w-2 h-2 rounded-full shrink-0",
										task.status === "done" ? "bg-green-500" :
										task.status === "in-progress" ? "bg-yellow-500" :
										task.status === "blocked" ? "bg-red-500" : "bg-gray-400"
									)} />
									<div className="flex-1 min-w-0">
										<p className="text-sm font-medium truncate">{task.title}</p>
										<p className="text-xs text-muted-foreground">
											#{task.id} • {task.status}
										</p>
									</div>
									{task.priority === "high" && (
										<span className="text-xs px-1.5 py-0.5 rounded bg-destructive/10 text-destructive shrink-0">
											HIGH
										</span>
									)}
								</a>
							))}
						</div>
					)}
				</div>

				{/* Spec Progress Cards */}
				<div className="bg-card rounded-xl border p-6 shadow-sm">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-3">
							<div className="p-2 rounded-lg bg-pink-100 dark:bg-pink-900/30">
								<Target className="w-5 h-5 text-pink-600 dark:text-pink-400" />
							</div>
							<div>
								<h2 className="font-semibold">Spec Progress</h2>
								<p className="text-xs text-muted-foreground">Implementation status</p>
							</div>
						</div>
						<a
							href="#/docs"
							className="text-xs text-pink-600 hover:underline flex items-center gap-1"
						>
							View all <ArrowRight className="w-3 h-3" />
						</a>
					</div>

					{docsLoading ? (
						<div className="flex items-center justify-center h-32">
							<RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
						</div>
					) : specProgress.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-32 text-center">
							<ClipboardCheck className="w-8 h-8 text-muted-foreground/50 mb-2" />
							<p className="text-sm text-muted-foreground">No specs found</p>
							<p className="text-xs text-muted-foreground">Create specs in docs/specs/</p>
						</div>
					) : (
						<div className="grid grid-cols-2 gap-3">
							{specProgress.map((spec) => {
								const acPercent = spec.acProgress.total > 0
									? Math.round((spec.acProgress.completed / spec.acProgress.total) * 100)
									: 0;
								const status = spec.metadata.status || "draft";
								return (
									<a
										key={spec.path}
										href={`#/docs/${spec.path}`}
										className="p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
									>
										<div className="flex items-center justify-between gap-2 mb-2">
											<p className="text-sm font-medium truncate flex-1">{spec.metadata.title}</p>
											<span className={cn(
												"text-[10px] px-1.5 py-0.5 rounded font-medium uppercase shrink-0",
												status === "implemented" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" :
												status === "approved" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" :
												"bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
											)}>
												{status}
											</span>
										</div>
										<div className="space-y-1">
											<div className="flex items-center justify-between text-xs">
												<span className="text-muted-foreground">AC</span>
												<span className={cn(
													acPercent >= 75 ? "text-green-600" :
													acPercent >= 50 ? "text-yellow-600" : "text-muted-foreground"
												)}>
													{spec.acProgress.completed}/{spec.acProgress.total}
												</span>
											</div>
											<Progress value={acPercent} className="h-1.5" />
											<div className="flex items-center justify-between text-xs text-muted-foreground">
												<span>{spec.linkedTasks} tasks</span>
												<span>{spec.completedTasks} done</span>
											</div>
										</div>
									</a>
								);
							})}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
