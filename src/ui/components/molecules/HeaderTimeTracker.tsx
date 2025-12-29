import { Play, Pause, Square } from "lucide-react";
import { useTimeTracker } from "../../contexts/TimeTrackerContext";
import { Button } from "../ui/button";
import { cn } from "@/ui/lib/utils";

interface HeaderTimeTrackerProps {
	className?: string;
	onTaskClick?: (taskId: string) => void;
}

function formatTime(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

export function HeaderTimeTracker({ className, onTaskClick }: HeaderTimeTrackerProps) {
	const { activeTimer, isPaused, elapsedMs, pause, resume, stop, loading } = useTimeTracker();

	// Don't render if no active timer
	if (!activeTimer || loading) {
		return null;
	}

	const handleTaskClick = () => {
		if (onTaskClick && activeTimer?.taskId) {
			onTaskClick(activeTimer.taskId);
		}
	};

	const handlePauseResume = async (e: React.MouseEvent) => {
		e.stopPropagation();
		try {
			if (isPaused) {
				await resume();
			} else {
				await pause();
			}
		} catch (error) {
			console.error("Failed to pause/resume:", error);
		}
	};

	const handleStop = async (e: React.MouseEvent) => {
		e.stopPropagation();
		try {
			await stop();
		} catch (error) {
			console.error("Failed to stop:", error);
		}
	};

	return (
		<div
			className={cn(
				"flex items-center gap-1.5 h-8",
				"animate-in fade-in slide-in-from-right-2 duration-200",
				className
			)}
		>
			{/* Recording indicator */}
			{!isPaused && (
				<span className="relative flex h-2 w-2">
					<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
					<span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
				</span>
			)}

			{/* Task info button */}
			<button
				type="button"
				onClick={handleTaskClick}
				className={cn(
					"flex items-center gap-1.5 px-2 py-1 rounded-md text-sm",
					"hover:bg-muted/80 transition-colors",
					"focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				)}
			>
				<span className="text-muted-foreground font-medium">#{activeTimer.taskId}</span>
				<span className="max-w-[120px] truncate text-foreground/80">
					{activeTimer.taskTitle}
				</span>
			</button>

			{/* Time display */}
			<div className={cn(
				"font-mono text-sm tabular-nums px-2 py-1 rounded-md",
				isPaused
					? "text-yellow-600 dark:text-yellow-400 bg-yellow-500/10"
					: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10"
			)}>
				{formatTime(elapsedMs)}
			</div>

			{/* Controls */}
			<div className="flex items-center">
				<Button
					variant="ghost"
					size="icon"
					className="h-7 w-7 rounded-md"
					onClick={handlePauseResume}
					title={isPaused ? "Resume" : "Pause"}
				>
					{isPaused ? (
						<Play className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
					) : (
						<Pause className="w-3.5 h-3.5 text-yellow-600 dark:text-yellow-400" />
					)}
				</Button>
				<Button
					variant="ghost"
					size="icon"
					className="h-7 w-7 rounded-md"
					onClick={handleStop}
					title="Stop"
				>
					<Square className="w-3.5 h-3.5 text-red-500" />
				</Button>
			</div>

			{/* Separator */}
			<div className="h-5 w-px bg-border ml-1" />
		</div>
	);
}
