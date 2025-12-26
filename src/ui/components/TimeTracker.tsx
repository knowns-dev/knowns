import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { Play, Pause, Square } from "lucide-react";
import type { Task, TimeEntry } from "../../models/task";
import { useTheme } from "../App";
import { updateTask } from "../api/client";

interface TimeTrackerProps {
	task: Task;
	onUpdate: (task: Task) => void;
}

export default function TimeTracker({ task, onUpdate }: TimeTrackerProps) {
	const { isDark } = useTheme();
	const [isRunning, setIsRunning] = useState(false);
	const [isPaused, setIsPaused] = useState(false);
	const [elapsedTime, setElapsedTime] = useState(0);
	const [startTime, setStartTime] = useState<Date | null>(null);
	const [showManualEntry, setShowManualEntry] = useState(false);
	const [manualHours, setManualHours] = useState("");
	const [manualMinutes, setManualMinutes] = useState("");
	const [manualNote, setManualNote] = useState("");
	const [saving, setSaving] = useState(false);

	// Theme classes
	const bgCard = isDark ? "bg-gray-700" : "bg-gray-50";
	const textPrimary = isDark ? "text-gray-100" : "text-gray-900";
	const textSecondary = isDark ? "text-gray-300" : "text-gray-700";
	const textMuted = isDark ? "text-gray-400" : "text-gray-500";
	const borderColor = isDark ? "border-gray-600" : "border-gray-300";
	const inputBg = isDark
		? "bg-gray-600 border-gray-500 text-gray-100"
		: "bg-white border-gray-300 text-gray-900";

	// Check if there's an active timer (entry without endedAt)
	useEffect(() => {
		const activeEntry = task.timeEntries.find((e) => !e.endedAt);
		if (activeEntry) {
			setIsRunning(true);
			setStartTime(activeEntry.startedAt);
			setElapsedTime(Date.now() - activeEntry.startedAt.getTime());
		} else {
			setIsRunning(false);
			setStartTime(null);
			setElapsedTime(0);
		}
	}, [task.timeEntries]);

	// Timer tick
	useEffect(() => {
		let interval: number | undefined;
		if (isRunning && !isPaused && startTime) {
			interval = window.setInterval(() => {
				setElapsedTime(Date.now() - startTime.getTime());
			}, 1000);
		}
		return () => {
			if (interval) clearInterval(interval);
		};
	}, [isRunning, isPaused, startTime]);

	const handleStart = async () => {
		setSaving(true);
		try {
			const newEntry: TimeEntry = {
				id: crypto.randomUUID(),
				startedAt: new Date(),
				duration: 0,
			};
			const updated = await updateTask(task.id, {
				timeEntries: [...task.timeEntries, newEntry],
			});
			onUpdate(updated);
		} catch (error) {
			console.error("Failed to start timer:", error);
		} finally {
			setSaving(false);
		}
	};

	const handleStop = async () => {
		const activeEntry = task.timeEntries.find((e) => !e.endedAt);
		if (!activeEntry) return;

		setSaving(true);
		try {
			const endTime = new Date();
			const duration = endTime.getTime() - activeEntry.startedAt.getTime();
			const updatedEntries = task.timeEntries.map((e) =>
				e.id === activeEntry.id ? { ...e, endedAt: endTime, duration } : e
			);
			const totalTime = updatedEntries.reduce((sum, e) => sum + e.duration, 0);
			const updated = await updateTask(task.id, {
				timeEntries: updatedEntries,
				timeSpent: totalTime,
			});
			onUpdate(updated);
			setIsPaused(false);
		} catch (error) {
			console.error("Failed to stop timer:", error);
		} finally {
			setSaving(false);
		}
	};

	const handlePause = () => {
		setIsPaused(true);
	};

	const handleResume = () => {
		setIsPaused(false);
	};

	const handleManualSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		const hours = Number.parseInt(manualHours, 10) || 0;
		const minutes = Number.parseInt(manualMinutes, 10) || 0;
		const duration = (hours * 60 + minutes) * 60 * 1000;

		if (duration <= 0) return;

		setSaving(true);
		try {
			const endTime = new Date();
			const startTimeCalc = new Date(endTime.getTime() - duration);
			const newEntry: TimeEntry = {
				id: crypto.randomUUID(),
				startedAt: startTimeCalc,
				endedAt: endTime,
				duration,
				note: manualNote.trim() || undefined,
			};
			const updatedEntries = [...task.timeEntries, newEntry];
			const totalTime = updatedEntries.reduce((sum, entry) => sum + entry.duration, 0);
			const updated = await updateTask(task.id, {
				timeEntries: updatedEntries,
				timeSpent: totalTime,
			});
			onUpdate(updated);
			setManualHours("");
			setManualMinutes("");
			setManualNote("");
			setShowManualEntry(false);
		} catch (error) {
			console.error("Failed to add manual time:", error);
		} finally {
			setSaving(false);
		}
	};

	const formatTime = useCallback((ms: number): string => {
		const totalSeconds = Math.floor(ms / 1000);
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;
		return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
	}, []);

	const formatDuration = useCallback((ms: number): string => {
		const hours = Math.floor(ms / 3600000);
		const minutes = Math.floor((ms % 3600000) / 60000);
		if (hours > 0) {
			return `${hours}h ${minutes}m`;
		}
		return `${minutes}m`;
	}, []);

	const completedEntries = task.timeEntries.filter((e) => e.endedAt);

	return (
		<div className="space-y-4">
			{/* Timer Display */}
			<div className={`flex items-center justify-between ${bgCard} rounded-lg p-4`}>
				<div className="text-center flex-1">
					<div className={`text-3xl font-mono font-bold ${textPrimary}`}>
						{formatTime(elapsedTime)}
					</div>
					<div className={`text-xs ${textMuted} mt-1`}>
						{isRunning ? (isPaused ? "Paused" : "Running") : "Ready"}
					</div>
				</div>
			</div>

			{/* Timer Controls */}
			<div className="flex justify-center gap-2">
				{!isRunning ? (
					<button
						type="button"
						onClick={handleStart}
						disabled={saving}
						className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
					>
						<Play className="w-4 h-4" aria-hidden="true" />
						Start
					</button>
				) : (
					<>
						{isPaused ? (
							<button
								type="button"
								onClick={handleResume}
								disabled={saving}
								className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
							>
								<Play className="w-4 h-4" aria-hidden="true" />
								Resume
							</button>
						) : (
							<button
								type="button"
								onClick={handlePause}
								disabled={saving}
								className="px-4 py-2 bg-yellow-600 text-white rounded hover:bg-yellow-700 disabled:opacity-50 flex items-center gap-2"
							>
								<Pause className="w-4 h-4" aria-hidden="true" />
								Pause
							</button>
						)}
						<button
							type="button"
							onClick={handleStop}
							disabled={saving}
							className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
						>
							<Square className="w-4 h-4" aria-hidden="true" />
							Stop
						</button>
					</>
				)}
				<button
					type="button"
					onClick={() => setShowManualEntry(!showManualEntry)}
					className={`px-4 py-2 border ${borderColor} rounded ${isDark ? "hover:bg-gray-600 text-gray-300" : "hover:bg-gray-50 text-gray-700"} text-sm`}
					disabled={saving}
				>
					+ Manual Entry
				</button>
			</div>

			{/* Manual Entry Form */}
			{showManualEntry && (
				<form onSubmit={handleManualSubmit} className={`${bgCard} rounded-lg p-4 space-y-3`}>
					<div className="flex gap-4">
						<div>
							<label htmlFor="manual-hours" className={`block text-xs ${textMuted} mb-1`}>
								Hours
							</label>
							<input
								id="manual-hours"
								type="number"
								min="0"
								value={manualHours}
								onChange={(e) => setManualHours(e.target.value)}
								className={`w-20 border rounded px-2 py-1 text-sm ${inputBg}`}
								placeholder="0"
								disabled={saving}
							/>
						</div>
						<div>
							<label htmlFor="manual-minutes" className={`block text-xs ${textMuted} mb-1`}>
								Minutes
							</label>
							<input
								id="manual-minutes"
								type="number"
								min="0"
								max="59"
								value={manualMinutes}
								onChange={(e) => setManualMinutes(e.target.value)}
								className={`w-20 border rounded px-2 py-1 text-sm ${inputBg}`}
								placeholder="0"
								disabled={saving}
							/>
						</div>
					</div>
					<div>
						<label htmlFor="manual-note" className={`block text-xs ${textMuted} mb-1`}>
							Note (optional)
						</label>
						<input
							id="manual-note"
							type="text"
							value={manualNote}
							onChange={(e) => setManualNote(e.target.value)}
							className={`w-full border rounded px-2 py-1 text-sm ${inputBg}`}
							placeholder="What did you work on?"
							disabled={saving}
						/>
					</div>
					<div className="flex gap-2">
						<button
							type="submit"
							className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
							disabled={saving}
						>
							Add Time
						</button>
						<button
							type="button"
							onClick={() => setShowManualEntry(false)}
							className={`px-3 py-1 border ${borderColor} rounded text-sm ${isDark ? "hover:bg-gray-600 text-gray-300" : "hover:bg-gray-100 text-gray-700"}`}
							disabled={saving}
						>
							Cancel
						</button>
					</div>
				</form>
			)}

			{/* Total Time */}
			<div className={`flex justify-between items-center py-2 border-t ${borderColor}`}>
				<span className={`text-sm font-medium ${textSecondary}`}>Total Time Spent</span>
				<span className={`text-lg font-bold ${textPrimary}`}>{formatDuration(task.timeSpent)}</span>
			</div>

			{/* Time History */}
			{completedEntries.length > 0 && (
				<div>
					<h4 className={`text-sm font-medium ${textSecondary} mb-2`}>Time Log</h4>
					<div className="space-y-1 max-h-40 overflow-y-auto">
						{completedEntries
							.slice()
							.reverse()
							.map((entry) => (
								<div key={entry.id} className={"flex justify-between items-center text-sm py-1"}>
									<div className="flex-1">
										<span className={textMuted}>
											{entry.startedAt.toLocaleDateString()}{" "}
											{entry.startedAt.toLocaleTimeString([], {
												hour: "2-digit",
												minute: "2-digit",
											})}
										</span>
										{entry.note && (
											<span className={`${isDark ? "text-gray-500" : "text-gray-400"} ml-2`}>
												- {entry.note}
											</span>
										)}
									</div>
									<span className={`font-medium ${textPrimary}`}>
										{formatDuration(entry.duration)}
									</span>
								</div>
							))}
					</div>
				</div>
			)}
		</div>
	);
}
