import { useState, useEffect, useCallback } from "react";
import { Activity, Filter, RefreshCw } from "lucide-react";
import { api, type Activity as ActivityType, connectWebSocket } from "../api/client";
import { useTheme } from "../App";
import Avatar from "./Avatar";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";

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

// Get activity icon based on change type
function getActivityIcon(changes: ActivityType["changes"]): string {
	if (changes.some((c) => c.field === "status")) {
		const statusChange = changes.find((c) => c.field === "status");
		if (statusChange?.newValue === "done") return "check";
		if (statusChange?.newValue === "in-progress") return "play";
		return "status";
	}
	if (changes.some((c) => c.field === "assignee")) return "user";
	if (changes.some((c) => c.field === "title")) return "edit";
	if (changes.some((c) => c.field === "priority")) return "flag";
	return "edit";
}

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
function getActivityColor(changes: ActivityType["changes"], isDark: boolean): string {
	if (changes.some((c) => c.field === "status" && c.newValue === "done")) {
		return isDark ? "bg-green-900/30 text-green-400" : "bg-green-100 text-green-700";
	}
	if (changes.some((c) => c.field === "status" && c.newValue === "in-progress")) {
		return isDark ? "bg-blue-900/30 text-blue-400" : "bg-blue-100 text-blue-700";
	}
	if (changes.some((c) => c.field === "status" && c.newValue === "blocked")) {
		return isDark ? "bg-red-900/30 text-red-400" : "bg-red-100 text-red-700";
	}
	if (changes.some((c) => c.field === "assignee")) {
		return isDark ? "bg-purple-900/30 text-purple-400" : "bg-purple-100 text-purple-700";
	}
	return isDark ? "bg-gray-700 text-gray-300" : "bg-gray-100 text-gray-700";
}

export default function ActivityFeed({
	limit = 20,
	showFilter = true,
	onTaskClick,
}: ActivityFeedProps) {
	const { isDark } = useTheme();
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

	// Subscribe to WebSocket for real-time updates
	useEffect(() => {
		const ws = connectWebSocket((data) => {
			if (data.type === "tasks:updated") {
				// Reload activities when a task is updated
				loadActivities();
			}
		});

		return () => {
			if (ws) ws.close();
		};
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

	// Theme classes
	const textSecondary = isDark ? "text-gray-300" : "text-gray-700";
	const textMuted = isDark ? "text-gray-400" : "text-gray-500";
	const bgCard = isDark ? "bg-gray-700" : "bg-white";
	const borderColor = isDark ? "border-gray-600" : "border-gray-200";
	const hoverBg = isDark ? "hover:bg-gray-600" : "hover:bg-gray-50";

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-between mb-3">
				<div className={`flex items-center gap-2 ${textSecondary}`}>
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
					<Filter className={`w-4 h-4 ${textMuted}`} />
					<select
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						className={`text-sm rounded px-2 py-1 ${bgCard} ${borderColor} border ${textSecondary} flex-1`}
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
						<div className={`text-sm ${textMuted} py-4 text-center`}>
							Loading activities...
						</div>
					) : activities.length === 0 ? (
						<div className={`text-sm ${textMuted} py-4 text-center`}>
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
								className={`w-full ${bgCard} rounded p-2 text-left ${hoverBg} transition-colors border ${borderColor} cursor-pointer select-none`}
							>
								<div className="flex items-center gap-2">
									{/* Avatar */}
									{activity.author ? (
										<Avatar name={activity.author} size="xs" />
									) : (
										<div
											className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${getActivityColor(activity.changes, isDark)}`}
										>
											<Activity className="w-2.5 h-2.5" />
										</div>
									)}

									{/* Content */}
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-1.5">
											<span className={`text-xs font-medium ${textSecondary} truncate`}>
												{getActivitySummary(activity)}
											</span>
											<span className={`text-[10px] ${textMuted} shrink-0`}>
												{formatRelativeTime(activity.timestamp)}
											</span>
										</div>
										<div className={`text-[11px] ${textMuted} truncate`}>
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
