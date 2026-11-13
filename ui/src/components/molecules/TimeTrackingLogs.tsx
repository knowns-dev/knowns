import { Play } from "lucide-react";
import type { TimeEntry } from "@/ui/models/task";
import { useTimeTracker } from "../../contexts/TimeTrackerContext";
import { Button } from "@/ui/components/ui/knowns/button";
import { formatTracked } from "../organisms/TaskDetail/types";

interface TimeTrackingLogsProps {
	taskId: string;
	timeEntries: TimeEntry[];
	timeSpent: number;
	/** Start is unavailable (archived Tasks). */
	disabled?: boolean;
}

function dayLabel(date: Date): string {
	return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function TimeTrackingLogs({ taskId, timeEntries, timeSpent, disabled = false }: TimeTrackingLogsProps) {
	const { isTaskRunning, start } = useTimeTracker();
	const isThisTaskActive = isTaskRunning(taskId);
	const completedEntries = (timeEntries ?? []).filter((e) => e.endedAt).slice().reverse();

	const handleStartTimer = async () => {
		if (isThisTaskActive) return;
		try {
			await start(taskId);
		} catch (error) {
			console.error("Failed to start timer:", error);
		}
	};

	return (
		<section aria-labelledby={`time-${taskId}`} className="flex flex-col gap-4">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="flex flex-col gap-0.5">
					<h3 id={`time-${taskId}`} className="text-[13.5px] font-semibold text-foreground">
						Time Tracking
					</h3>
					<p className="text-[13px] text-muted-foreground">
						<span className="text-[20px] font-semibold tracking-tight text-foreground tabular-nums">{formatTracked(timeSpent)}</span>{" "}
						tracked in {completedEntries.length} {completedEntries.length === 1 ? "session" : "sessions"}
					</p>
				</div>
				{isThisTaskActive ? (
					<span className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[12.5px] font-medium text-emerald-700 dark:text-emerald-300">
						<span aria-hidden className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />
						Recording...
					</span>
				) : (
					<Button size="sm" variant="secondary" icon={<Play />} onClick={handleStartTimer} disabled={disabled}>
						Start Timer
					</Button>
				)}
			</div>
			{completedEntries.length === 0 ? (
				<p className="text-[13px] text-muted-foreground">No sessions yet. Start the timer to log time against this task.</p>
			) : (
				<ol aria-label="Time entries" className="divide-y divide-[color-mix(in_srgb,var(--foreground)_8%,transparent)]">
					{completedEntries.map((entry) => (
						<li key={entry.id} className="flex items-baseline gap-3 py-2.5 text-[13.5px]">
							<time dateTime={entry.startedAt.toISOString()} className="w-28 flex-none text-muted-foreground tabular-nums max-sm:w-24">
								{dayLabel(entry.startedAt)}
							</time>
							<span className="min-w-0 flex-1 truncate text-foreground/85">
								{entry.note || (
									<span className="text-muted-foreground">
										{entry.startedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
									</span>
								)}
							</span>
							<span className="flex-none font-medium text-foreground tabular-nums">{formatTracked(entry.duration)}</span>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}
