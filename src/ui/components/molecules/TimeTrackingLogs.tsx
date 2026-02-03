import { Clock, Play } from "lucide-react";
import type { TimeEntry } from "../../models/task";
import { useTimeTracker } from "../../contexts/TimeTrackerContext";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

interface TimeTrackingLogsProps {
	taskId: string;
	timeEntries: TimeEntry[];
	timeSpent: number;
}

function formatDuration(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes === 0 && seconds > 0) {
		return `${seconds}s`;
	}
	return `${minutes}m`;
}

export function TimeTrackingLogs({ taskId, timeEntries, timeSpent }: TimeTrackingLogsProps) {
	const { isTaskRunning, start } = useTimeTracker();

	const isThisTaskActive = isTaskRunning(taskId);

	const completedEntries = timeEntries.filter((e) => e.endedAt);

	const handleStartTimer = async () => {
		if (isThisTaskActive) return;
		try {
			await start(taskId);
		} catch (error) {
			console.error("Failed to start timer:", error);
		}
	};

	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex items-center justify-between">
					<CardTitle className="flex items-center gap-2 text-base">
						<Clock className="w-4 h-4" />
						Time Tracking
					</CardTitle>
					<div className="flex items-center gap-3">
						<span className="text-sm text-muted-foreground">
							Total: <span className="font-semibold text-foreground">{formatDuration(timeSpent)}</span>
						</span>
						{!isThisTaskActive && (
							<Button
								size="sm"
								variant="default"
								onClick={handleStartTimer}
								className="gap-1.5"
							>
								<Play className="w-3.5 h-3.5" />
								Start Timer
							</Button>
						)}
						{isThisTaskActive && (
							<span className="text-xs px-2 py-1 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 font-medium animate-pulse">
								Recording...
							</span>
						)}
					</div>
				</div>
			</CardHeader>
			<CardContent>
				{completedEntries.length === 0 ? (
					<p className="text-sm text-muted-foreground text-center py-4">
						No time entries yet. Click "Start Timer" to begin tracking.
					</p>
				) : (
					<div className="space-y-1 max-h-48 overflow-y-auto">
						{completedEntries
							.slice()
							.reverse()
							.map((entry) => (
								<div
									key={entry.id}
									className="flex justify-between items-center text-sm py-1.5 px-2 rounded hover:bg-muted/50"
								>
									<div className="flex-1 min-w-0">
										<span className="text-muted-foreground">
											{entry.startedAt.toLocaleDateString()}{" "}
											{entry.startedAt.toLocaleTimeString([], {
												hour: "2-digit",
												minute: "2-digit",
											})}
										</span>
										{entry.note && (
											<span className="text-muted-foreground/70 ml-2 truncate">
												- {entry.note}
											</span>
										)}
									</div>
									<span className="font-medium text-foreground shrink-0 ml-2">
										{formatDuration(entry.duration)}
									</span>
								</div>
							))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
