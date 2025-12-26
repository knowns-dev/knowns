import { useState, useEffect, useCallback } from "react";
import { Bell } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Button } from "./ui/button";
import ActivityFeed from "./ActivityFeed";
import { api, connectWebSocket } from "../api/client";
import { useTheme } from "../App";

export default function NotificationBell() {
	const { isDark } = useTheme();
	const [hasNew, setHasNew] = useState(false);
	const [open, setOpen] = useState(false);
	const [lastChecked, setLastChecked] = useState<Date>(() => {
		const stored = localStorage.getItem("knowns-last-activity-check");
		return stored ? new Date(stored) : new Date();
	});

	// Check for new activities
	const checkNewActivities = useCallback(async () => {
		try {
			const activities = await api.getActivities({ limit: 1 });
			if (activities.length > 0) {
				const latestTime = new Date(activities[0].timestamp);
				if (latestTime > lastChecked) {
					setHasNew(true);
				}
			}
		} catch (err) {
			console.error("Failed to check activities:", err);
		}
	}, [lastChecked]);

	// Initial check
	useEffect(() => {
		checkNewActivities();
	}, [checkNewActivities]);

	// Subscribe to WebSocket for real-time updates
	useEffect(() => {
		const ws = connectWebSocket((data) => {
			if (data.type === "tasks:updated" && !open) {
				setHasNew(true);
			}
		});

		return () => {
			if (ws) ws.close();
		};
	}, [open]);

	// Mark as read when opening
	const handleOpenChange = (isOpen: boolean) => {
		setOpen(isOpen);
		if (isOpen) {
			setHasNew(false);
			const now = new Date();
			setLastChecked(now);
			localStorage.setItem("knowns-last-activity-check", now.toISOString());
		}
	};

	return (
		<Popover open={open} onOpenChange={handleOpenChange}>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="relative h-8 w-8"
					aria-label="Notifications"
				>
					<Bell className="h-4 w-4" />
					{hasNew && (
						<span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
					)}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className={`w-80 p-0 ${isDark ? "bg-gray-800 border-gray-700" : ""}`}
				align="end"
				sideOffset={8}
			>
				<div className="flex flex-col h-[400px]">
					<div className={`px-4 py-3 border-b ${isDark ? "border-gray-700" : "border-gray-200"}`}>
						<h3 className={`font-semibold text-sm ${isDark ? "text-gray-100" : "text-gray-900"}`}>
							Recent Activity
						</h3>
					</div>
					<div className="flex-1 overflow-hidden p-2">
						<ActivityFeed
							limit={20}
							showFilter={false}
							onTaskClick={(taskId) => {
								setOpen(false);
								window.location.hash = `/kanban/${taskId}`;
							}}
						/>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
