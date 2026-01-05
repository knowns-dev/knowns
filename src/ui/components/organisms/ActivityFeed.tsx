import { useState, useEffect, useCallback } from "react";
import { Activity, Filter, RefreshCw } from "lucide-react";
import { api, type Activity as ActivityType } from "../../api/client";
import { useSSEEvent } from "../../contexts/SSEContext";
import Avatar from "../atoms/Avatar";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

interface ActivityFeedProps {
	limit?: number;
	showFilter?: boolean;
	onTaskClick?: (taskId: string) => void;
}

// Activity type categories for filtering
const ACTIVITY_TYPES = [
	{ value: "all", label: "All" },
	{ value: "status", label: "Status" },
	{ value: "assignee", label: "Assignee" },
	{ value: "content", label: "Content" },
];

// Get activity summary
function getActivitySummary(activity: ActivityType): string {
	const changes = activity.changes;
	if (changes.length === 0) return "Updated";

	// Check for specific changes
	const statusChange = changes.find((c) => c.field === "status");
	if (statusChange) {
		const newStatus = String(statusChange.newValue);
		if (newStatus === "done") return "Completed";
		if (newStatus === "in-progress") return "Started working on";
		if (newStatus === "in-review") return "Submitted for review";
		if (newStatus === "blocked") return "Blocked";
		return `Changed status to ${newStatus}`;
	}

	const assigneeChange = changes.find((c) => c.field === "assignee");
	if (assigneeChange) {
		const newAssignee = assigneeChange.newValue;
		if (!newAssignee) return "Unassigned";
		return `Assigned to ${newAssignee}`;
	}

	const titleChange = changes.find((c) => c.field === "title");
	if (titleChange) return "Updated title";

	const priorityChange = changes.find((c) => c.field === "priority");
	if (priorityChange) return `Set priority to ${priorityChange.newValue}`;

	if (changes.some((c) => c.field === "description")) return "Updated description";
	if (changes.some((c) => c.field === "acceptanceCriteria")) return "Updated acceptance criteria";
	if (changes.some((c) => c.field === "implementationPlan")) return "Updated plan";
	if (changes.some((c) => c.field === "implementationNotes")) return "Updated notes";
	if (changes.some((c) => c.field === "labels")) return "Updated labels";

	return `Updated ${changes.length} field(s)`;
}

// Format relative time
function formatRelativeTime(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;

	return date.toLocaleDateString();
}

// Get activity color based on type
function getActivityColor(changes: ActivityType["changes"]): string {
	if (changes.some((c) => c.field === "status" && c.newValue === "done")) {
		return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400";
	}
	if (changes.some((c) => c.field === "status" && c.newValue === "in-progress")) {
		return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400";
	}
	if (changes.some((c) => c.field === "status" && c.newValue === "blocked")) {
		return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
	}
	if (changes.some((c) => c.field === "assignee")) {
		return "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400";
	}
	return "bg-muted text-muted-foreground";
}

export default function ActivityFeed({
	limit = 20,
	showFilter = true,
	onTaskClick,
}: ActivityFeedProps) {
	const [activities, setActivities] = useState<ActivityType[]>([]);
	const [loading, setLoading] = useState(true);
	const [filter, setFilter] = useState("all");
	const [refreshing, setRefreshing] = useState(false);

	const loadActivities = useCallback(async () => {
		try {
			const typeFilter = filter === "all" ? undefined : filter;
			const data = await api.getActivities({ limit, type: typeFilter });
			setActivities(data);
		} catch (err) {
			console.error("Failed to load activities:", err);
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	}, [limit, filter]);

	useEffect(() => {
		loadActivities();
	}, [loadActivities]);

	// Subscribe to SSE for real-time updates
	useSSEEvent("tasks:updated", () => {
		loadActivities();
	}, [loadActivities]);

	const handleRefresh = () => {
		setRefreshing(true);
		loadActivities();
	};

	const handleTaskClick = (taskId: string) => {
		if (onTaskClick) {
			onTaskClick(taskId);
		} else {
			// Default: navigate to kanban view
			window.location.hash = `/kanban/${taskId}`;
		}
	};

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-between mb-3">
				<div className="flex items-center gap-2">
					<Activity className="w-5 h-5" />
					<h3 className="font-semibold">Recent Activity</h3>
				</div>
				<Button
					variant="ghost"
					size="icon"
					onClick={handleRefresh}
					disabled={refreshing}
					className="h-8 w-8"
				>
					<RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
				</Button>
			</div>

			{/* Filter */}
			{showFilter && (
				<div className="flex items-center gap-2 mb-3">
					<Filter className="w-4 h-4 text-muted-foreground" />
					<select
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						className="text-sm rounded px-2 py-1 bg-card border flex-1"
					>
						{ACTIVITY_TYPES.map((type) => (
							<option key={type.value} value={type.value}>
								{type.label}
							</option>
						))}
					</select>
				</div>
			)}

			{/* Activity List */}
			<ScrollArea className="flex-1">
				<div className="space-y-1.5 pr-3">
					{loading ? (
						<div className="text-sm text-muted-foreground py-4 text-center">
							Loading activities...
						</div>
					) : activities.length === 0 ? (
						<div className="text-sm text-muted-foreground py-4 text-center">
							No recent activity
						</div>
					) : (
						activities.map((activity, idx) => (
							<div
								key={`${activity.taskId}-${activity.version}-${idx}`}
								role="button"
								tabIndex={0}
								onClick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									handleTaskClick(activity.taskId);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										handleTaskClick(activity.taskId);
									}
								}}
								className="w-full bg-card rounded p-2 text-left hover:bg-accent transition-colors border cursor-pointer select-none"
							>
								<div className="flex items-center gap-2">
									{/* Avatar */}
									{activity.author ? (
										<Avatar name={activity.author} size="xs" />
									) : (
										<div
											className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${getActivityColor(activity.changes)}`}
										>
											<Activity className="w-2.5 h-2.5" />
										</div>
									)}

									{/* Content */}
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-1.5">
											<span className="text-xs font-medium truncate">
												{getActivitySummary(activity)}
											</span>
											<span className="text-[10px] text-muted-foreground shrink-0">
												{formatRelativeTime(activity.timestamp)}
											</span>
										</div>
										<div className="text-[11px] text-muted-foreground truncate">
											<span className="font-medium">#{activity.taskId}</span>
											{" "}
											{activity.taskTitle}
										</div>
									</div>
								</div>
							</div>
						))
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
