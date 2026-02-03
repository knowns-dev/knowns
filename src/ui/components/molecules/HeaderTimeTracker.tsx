import { useState } from "react";
import { Play, Pause, Square, Timer, ChevronDown, StopCircle } from "lucide-react";
import { useTimeTracker } from "../../contexts/TimeTrackerContext";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "@/ui/lib/utils";
import type { ActiveTimer } from "../../api/client";

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

interface TimerItemProps {
	timer: ActiveTimer;
	elapsed: number;
	onPauseResume: (taskId: string, isPaused: boolean) => void;
	onStop: (taskId: string) => void;
	onTaskClick?: (taskId: string) => void;
}

function TimerItem({ timer, elapsed, onPauseResume, onStop, onTaskClick }: TimerItemProps) {
	const isPaused = timer.pausedAt !== null;

	return (
		<div className="flex items-center gap-2 px-2 py-1.5 w-full">
			{/* Status indicator */}
			{!isPaused ? (
				<span className="relative flex h-2 w-2 flex-shrink-0">
					<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
					<span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
				</span>
			) : (
				<span className="h-2 w-2 rounded-full bg-yellow-500 flex-shrink-0" />
			)}

			{/* Task info */}
			<button
				type="button"
				onClick={() => onTaskClick?.(timer.taskId)}
				className="flex-1 min-w-0 text-left hover:text-foreground transition-colors"
			>
				<span className="text-muted-foreground font-medium text-xs">#{timer.taskId}</span>
				<span className="block text-sm truncate">{timer.taskTitle}</span>
			</button>

			{/* Time display */}
			<div className={cn(
				"font-mono text-xs tabular-nums px-1.5 py-0.5 rounded flex-shrink-0",
				isPaused
					? "text-yellow-600 dark:text-yellow-400 bg-yellow-500/10"
					: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10"
			)}>
				{formatTime(elapsed)}
			</div>

			{/* Controls */}
			<div className="flex items-center gap-0.5 flex-shrink-0">
				<Button
					variant="ghost"
					size="icon"
					className="h-6 w-6"
					onClick={(e) => {
						e.stopPropagation();
						onPauseResume(timer.taskId, isPaused);
					}}
					title={isPaused ? "Resume" : "Pause"}
				>
					{isPaused ? (
						<Play className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
					) : (
						<Pause className="w-3 h-3 text-yellow-600 dark:text-yellow-400" />
					)}
				</Button>
				<Button
					variant="ghost"
					size="icon"
					className="h-6 w-6"
					onClick={(e) => {
						e.stopPropagation();
						onStop(timer.taskId);
					}}
					title="Stop"
				>
					<Square className="w-3 h-3 text-red-500" />
				</Button>
			</div>
		</div>
	);
}

export function HeaderTimeTracker({ className, onTaskClick }: HeaderTimeTrackerProps) {
	const { activeTimers, getElapsedForTask, pause, resume, stop, loading } = useTimeTracker();
	const [open, setOpen] = useState(false);

	// Don't render if no active timers
	if (activeTimers.length === 0 || loading) {
		return null;
	}

	const runningCount = activeTimers.filter(t => !t.pausedAt).length;
	const pausedCount = activeTimers.filter(t => t.pausedAt).length;

	const handlePauseResume = async (taskId: string, isPaused: boolean) => {
		try {
			if (isPaused) {
				await resume(taskId);
			} else {
				await pause(taskId);
			}
		} catch (error) {
			console.error("Failed to pause/resume:", error);
		}
	};

	const handleStop = async (taskId: string) => {
		try {
			await stop(taskId);
		} catch (error) {
			console.error("Failed to stop:", error);
		}
	};

	const handleStopAll = async () => {
		try {
			await stop(undefined, true);
			setOpen(false);
		} catch (error) {
			console.error("Failed to stop all:", error);
		}
	};

	// For single timer, show inline
	if (activeTimers.length === 1) {
		const timer = activeTimers[0]!;
		const elapsed = getElapsedForTask(timer.taskId);
		const isPaused = timer.pausedAt !== null;

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
					onClick={() => onTaskClick?.(timer.taskId)}
					className={cn(
						"flex items-center gap-1.5 px-2 py-1 rounded-md text-sm",
						"hover:bg-muted/80 transition-colors",
						"focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					)}
				>
					<span className="text-muted-foreground font-medium">#{timer.taskId}</span>
					<span className="max-w-[120px] truncate text-foreground/80">
						{timer.taskTitle}
					</span>
				</button>

				{/* Time display */}
				<div className={cn(
					"font-mono text-sm tabular-nums px-2 py-1 rounded-md",
					isPaused
						? "text-yellow-600 dark:text-yellow-400 bg-yellow-500/10"
						: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10"
				)}>
					{formatTime(elapsed)}
				</div>

				{/* Controls */}
				<div className="flex items-center">
					<Button
						variant="ghost"
						size="icon"
						className="h-7 w-7 rounded-md"
						onClick={() => handlePauseResume(timer.taskId, isPaused)}
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
						onClick={() => handleStop(timer.taskId)}
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

	// For multiple timers, show badge with dropdown
	return (
		<div
			className={cn(
				"flex items-center gap-1.5 h-8",
				"animate-in fade-in slide-in-from-right-2 duration-200",
				className
			)}
		>
			{/* Recording indicator - show if any timer is running */}
			{runningCount > 0 && (
				<span className="relative flex h-2 w-2">
					<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
					<span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
				</span>
			)}

			<DropdownMenu open={open} onOpenChange={setOpen}>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className={cn(
							"h-7 px-2 gap-1.5",
							"hover:bg-muted/80 transition-colors"
						)}
					>
						<Timer className="w-4 h-4" />
						<span className="text-sm font-medium">{activeTimers.length}</span>
						{/* Show status breakdown */}
						<span className="text-xs text-muted-foreground">
							({runningCount} running{pausedCount > 0 ? `, ${pausedCount} paused` : ""})
						</span>
						<ChevronDown className="w-3 h-3 ml-0.5" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-80">
					{activeTimers.map((timer) => (
						<DropdownMenuItem
							key={timer.taskId}
							className="p-0 focus:bg-transparent"
							onSelect={(e) => e.preventDefault()}
						>
							<TimerItem
								timer={timer}
								elapsed={getElapsedForTask(timer.taskId)}
								onPauseResume={handlePauseResume}
								onStop={handleStop}
								onTaskClick={(taskId) => {
									onTaskClick?.(taskId);
									setOpen(false);
								}}
							/>
						</DropdownMenuItem>
					))}
					<DropdownMenuSeparator />
					<DropdownMenuItem
						className="text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400"
						onClick={handleStopAll}
					>
						<StopCircle className="w-4 h-4 mr-2" />
						Stop all timers
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			{/* Separator */}
			<div className="h-5 w-px bg-border ml-1" />
		</div>
	);
}
