import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { History, ChevronDown, ChevronRight, Filter, RotateCcw, GitCompare, ArrowRight } from "lucide-react";
import type { TaskVersion, TaskChange, TaskHistoryMetadata } from "@/ui/models/version";
import { createTaskDiff } from "@/ui/models/version";
import { api } from "../../api/client";
import Avatar from "../atoms/Avatar";
import { Button } from "../ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "../ui/collapsible";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import VersionDiffViewer from "./VersionDiffViewer";

interface TaskHistoryPanelProps {
	taskId: string;
	onRestore?: (version: TaskVersion) => void;
}

// Human-readable field names
const FIELD_LABELS: Record<string, string> = {
	title: "Title",
	description: "Description",
	status: "Status",
	priority: "Priority",
	assignee: "Assignee",
	labels: "Labels",
	acceptanceCriteria: "Acceptance Criteria",
	implementationPlan: "Implementation Plan",
	implementationNotes: "Implementation Notes",
};

// Change type categories for filtering
const CHANGE_TYPES = [
	{ value: "all", label: "All Changes" },
	{ value: "status", label: "Status" },
	{ value: "assignee", label: "Assignee" },
	{ value: "content", label: "Content" },
];

// Get category for a field
function getChangeCategory(field: string): string {
	if (field === "status") return "status";
	if (field === "assignee") return "assignee";
	return "content";
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

// Get change summary
function taskVersionFromMetadata(item: TaskHistoryMetadata): TaskVersion {
	return {
		id: item.id,
		taskId: item.taskId,
		version: item.version,
		timestamp: item.timestamp,
		author: item.author || item.actor,
		actor: item.actor,
		source: item.source,
		checkpoint: item.checkpoint,
		operation: item.operation,
		tombstone: item.tombstone,
		changes: [],
		snapshot: {},
	};
}

function getChangeSummary(version: TaskVersion, loaded: boolean): string {
	if (!loaded) {
		if (version.operation) return version.operation.replaceAll("_", " ");
		if (version.checkpoint) return "Checkpoint";
		return "Open to load change details";
	}
	if (version.changes.length === 0) return "No field changes";
	if (version.changes.length === 1) {
		const change = version.changes[0];
		return `Changed ${FIELD_LABELS[change.field] || change.field}`;
	}
	return `Changed ${version.changes.length} fields`;
}

export default function TaskHistoryPanel({ taskId, onRestore }: TaskHistoryPanelProps) {
	const [versions, setVersions] = useState<TaskVersion[]>([]);
	const [loadedVersions, setLoadedVersions] = useState<Set<number>>(new Set());
	const [loading, setLoading] = useState(true);
	const [hasMore, setHasMore] = useState(false);
	const [tailTruncated, setTailTruncated] = useState(false);
	const [isOpen, setIsOpen] = useState(true);
	const [filter, setFilter] = useState("all");
	const [expandedVersions, setExpandedVersions] = useState<Set<number>>(new Set());

	// Compare mode state
	const [compareMode, setCompareMode] = useState(false);
	const [fromVersion, setFromVersion] = useState<string>("");
	const [toVersion, setToVersion] = useState<string>("");

	// Keyboard navigation state
	const [focusedIndex, setFocusedIndex] = useState(-1);
	const listRef = useRef<HTMLDivElement>(null);
	const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

	useEffect(() => {
		if (!taskId) return;
		setLoading(true);
		setLoadedVersions(new Set());
		api.getTaskHistoryMetadata(taskId)
			.then((page) => {
				setHasMore(page.hasMore);
				setTailTruncated(Boolean(page.tailTruncated));
				setVersions(page.items.map(taskVersionFromMetadata).sort((a, b) => b.version - a.version));
			})
			.catch((err) => {
				console.error("Failed to load task history:", err);
				setVersions([]);
				setTailTruncated(false);
			})
			.finally(() => {
				setLoading(false);
			});
	}, [taskId]);

	const loadMore = useCallback(async () => {
		if (!hasMore) return;
		try {
			const page = await api.getTaskHistoryMetadata(taskId, versions.length);
			setHasMore(page.hasMore);
			setVersions((previous) => [...previous, ...page.items.map(taskVersionFromMetadata)]);
		} catch (err) {
			console.error("Failed to load more task history:", err);
		}
	}, [hasMore, taskId, versions.length]);

	const loadVersionDetail = useCallback(async (versionNumber: number) => {
		const current = versions.find((version) => version.version === versionNumber);
		if (!current || loadedVersions.has(versionNumber)) return current;
		try {
			const detail = await api.getTaskRevisionDetail(taskId, versionNumber);
			setVersions((previous) => previous.map((version) => version.version === versionNumber ? detail : version));
			setLoadedVersions((previous) => new Set(previous).add(versionNumber));
			return detail;
		} catch (err) {
			console.error("Failed to load task revision:", err);
			return undefined;
		}
	}, [loadedVersions, taskId, versions]);

	// Filter versions based on selected filter
	const filteredVersions = useMemo(() => {
		if (filter === "all") return versions;
		if (versions.some((version) => !loadedVersions.has(version.version))) return versions;
		return versions.filter((v) =>
			v.changes.some((c) => getChangeCategory(c.field) === filter)
		);
	}, [filter, loadedVersions, versions]);

	useEffect(() => {
		if (filter === "all") return;
		for (const version of versions) {
			if (!loadedVersions.has(version.version)) void loadVersionDetail(version.version);
		}
	}, [filter, loadVersionDetail, loadedVersions, versions]);

	const toggleVersion = (versionNum: number) => {
		void loadVersionDetail(versionNum);
		setExpandedVersions((prev) => {
			const next = new Set(prev);
			if (next.has(versionNum)) {
				next.delete(versionNum);
			} else {
				next.add(versionNum);
			}
			return next;
		});
	};

	// Compute comparison diff between two selected versions
	const comparisonDiff = useMemo((): TaskChange[] => {
		if (!compareMode || !fromVersion || !toVersion) return [];
		if (fromVersion === toVersion) return [];

		const fromVer = versions.find((v) => String(v.version) === fromVersion);
		const toVer = versions.find((v) => String(v.version) === toVersion);

		if (!fromVer?.snapshot || !toVer?.snapshot || !loadedVersions.has(fromVer.version) || !loadedVersions.has(toVer.version)) return [];

		return createTaskDiff(fromVer.snapshot, toVer.snapshot);
	}, [compareMode, fromVersion, loadedVersions, toVersion, versions]);

	// Find version for restore in compare mode
	const toVersionObj = useMemo(() => {
		if (!toVersion) return undefined;
		const version = versions.find((v) => String(v.version) === toVersion);
		return version && loadedVersions.has(version.version) ? version : undefined;
	}, [loadedVersions, toVersion, versions]);

	useEffect(() => {
		if (!compareMode || !fromVersion || !toVersion) return;
		void loadVersionDetail(Number(fromVersion));
		void loadVersionDetail(Number(toVersion));
	}, [compareMode, fromVersion, toVersion, loadVersionDetail]);

	// Keyboard navigation handlers
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (!isOpen || filteredVersions.length === 0) return;

			switch (e.key) {
				case "ArrowDown":
				case "j": {
					e.preventDefault();
					const nextIndex = Math.min(focusedIndex + 1, filteredVersions.length - 1);
					setFocusedIndex(nextIndex);
					const item = itemRefs.current.get(filteredVersions[nextIndex].version);
					item?.focus();
					break;
				}
				case "ArrowUp":
				case "k": {
					e.preventDefault();
					const prevIndex = Math.max(focusedIndex - 1, 0);
					setFocusedIndex(prevIndex);
					const item = itemRefs.current.get(filteredVersions[prevIndex].version);
					item?.focus();
					break;
				}
				case "Enter":
				case " ": {
					e.preventDefault();
					if (focusedIndex >= 0 && focusedIndex < filteredVersions.length) {
						toggleVersion(filteredVersions[focusedIndex].version);
					}
					break;
				}
				case "Home": {
					e.preventDefault();
					setFocusedIndex(0);
					const item = itemRefs.current.get(filteredVersions[0].version);
					item?.focus();
					break;
				}
				case "End": {
					e.preventDefault();
					const lastIndex = filteredVersions.length - 1;
					setFocusedIndex(lastIndex);
					const item = itemRefs.current.get(filteredVersions[lastIndex].version);
					item?.focus();
					break;
				}
			}
		},
		[isOpen, filteredVersions, focusedIndex, toggleVersion]
	);

	// Reset focus when list changes
	useEffect(() => {
		setFocusedIndex(-1);
	}, [filter, versions]);

	// Reset compare mode selections when versions change
	useEffect(() => {
		setFromVersion("");
		setToVersion("");
	}, [versions]);

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen}>
			<div className="flex items-center gap-2 mb-3 text-secondary-foreground">
				<CollapsibleTrigger asChild>
					<Button variant="ghost" size="sm" className="p-0 h-auto">
						{isOpen ? (
							<ChevronDown className="w-5 h-5" />
						) : (
							<ChevronRight className="w-5 h-5" />
						)}
					</Button>
				</CollapsibleTrigger>
				<History className="w-5 h-5" />
				<h3 className="font-semibold">History</h3>
				{versions.length > 0 && (
					<span className="text-sm text-muted-foreground">
						({versions.length} changes)
					</span>
				)}
			</div>

			<CollapsibleContent>
				{tailTruncated && (
					<div className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
						The final history append is incomplete and was ignored. Run reconciliation before restoring that revision.
					</div>
				)}
				{/* Controls: Filter and Compare Mode */}
				{versions.length > 0 && (
					<div className="space-y-3 mb-4">
						{/* Filter and Compare Toggle */}
						<div className="flex items-center justify-between gap-2">
							<div className="flex items-center gap-2">
								<Filter className="w-4 h-4 text-muted-foreground" />
								<select
									value={filter}
									onChange={(e) => setFilter(e.target.value)}
									className="text-sm rounded px-2 py-1 bg-card border border-border text-secondary-foreground"
									disabled={compareMode}
								>
									{CHANGE_TYPES.map((type) => (
										<option key={type.value} value={type.value}>
											{type.label}
										</option>
									))}
								</select>
							</div>
							<Button
								variant={compareMode ? "secondary" : "ghost"}
								size="sm"
								onClick={() => setCompareMode(!compareMode)}
								className="text-xs"
							>
								<GitCompare className="w-3 h-3 mr-1" />
								Compare
							</Button>
						</div>

						{/* Version Selectors for Compare Mode */}
						{compareMode && (
							<div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg border border-border">
								<Select value={fromVersion} onValueChange={setFromVersion}>
									<SelectTrigger className="w-[120px] h-8 text-xs">
										<SelectValue placeholder="From v..." />
									</SelectTrigger>
									<SelectContent>
										{versions.map((v) => (
											<SelectItem
												key={v.version}
												value={String(v.version)}
												disabled={String(v.version) === toVersion}
											>
												v{v.version}
											</SelectItem>
										))}
									</SelectContent>
								</Select>

								<ArrowRight className="w-4 h-4 text-muted-foreground" />

								<Select value={toVersion} onValueChange={setToVersion}>
									<SelectTrigger className="w-[120px] h-8 text-xs">
										<SelectValue placeholder="To v..." />
									</SelectTrigger>
									<SelectContent>
										{versions.map((v) => (
											<SelectItem
												key={v.version}
												value={String(v.version)}
												disabled={String(v.version) === fromVersion}
											>
												v{v.version}
											</SelectItem>
										))}
									</SelectContent>
								</Select>

								{fromVersion && toVersion && fromVersion !== toVersion && (
									<span className="text-xs text-muted-foreground ml-2">
										{comparisonDiff.length === 0
											? "No changes"
											: `${comparisonDiff.length} field${comparisonDiff.length > 1 ? "s" : ""} changed`}
									</span>
								)}
							</div>
						)}

						{/* Comparison Diff View */}
						{compareMode && fromVersion && toVersion && fromVersion !== toVersion && (
							<div className="space-y-3">
								<VersionDiffViewer
									changes={comparisonDiff}
									viewType="split"
									showToggle={true}
								/>
								{onRestore && toVersionObj && toVersionObj.version > 1 && (
									<div className="flex justify-end">
										<Button
											variant="outline"
											size="sm"
											onClick={() => onRestore(toVersionObj)}
											className="text-xs"
										>
											<RotateCcw className="w-3 h-3 mr-1" />
											Restore to v{toVersionObj.version}
										</Button>
									</div>
								)}
							</div>
						)}

						{/* Keyboard hints */}
						{!compareMode && (
							<div className="text-xs text-muted-foreground flex items-center gap-3">
								<span>
									<kbd className="px-1.5 py-0.5 rounded bg-muted border border-border text-[10px]">↑</kbd>
									<kbd className="px-1.5 py-0.5 rounded bg-muted border border-border text-[10px] ml-0.5">↓</kbd>
									<span className="ml-1">navigate</span>
								</span>
								<span>
									<kbd className="px-1.5 py-0.5 rounded bg-muted border border-border text-[10px]">Enter</kbd>
									<span className="ml-1">expand</span>
								</span>
							</div>
						)}
					</div>
				)}

				{loading ? (
					<div className="text-sm text-muted-foreground py-4 text-center">
						Loading history...
					</div>
				) : filteredVersions.length === 0 ? (
					<div className="text-sm text-muted-foreground py-4 text-center">
						No history available
					</div>
				) : !compareMode ? (
					<div
						ref={listRef}
						className="space-y-2 relative"
						onKeyDown={handleKeyDown}
						role="listbox"
						aria-label="Version history"
						tabIndex={0}
					>
						{/* Timeline line */}
						<div className="absolute left-3 top-2 bottom-2 w-0.5 bg-border" />

						{filteredVersions.map((version, index) => {
							const isExpanded = expandedVersions.has(version.version);
							const isFocused = focusedIndex === index;

							return (
								<div key={version.id} className="relative pl-8">
									{/* Timeline dot */}
									<div
										className={`absolute left-1.5 top-3 w-3 h-3 rounded-full border-2 bg-background transition-colors ${
											isFocused
												? "border-primary ring-2 ring-primary/20"
												: "border-blue-500 dark:border-blue-400"
										}`}
									/>

									<button
										ref={(el) => {
											if (el) {
												itemRefs.current.set(version.version, el);
											} else {
												itemRefs.current.delete(version.version);
											}
										}}
										type="button"
										onClick={() => toggleVersion(version.version)}
										onFocus={() => setFocusedIndex(index)}
										className={`w-full bg-card rounded-lg p-3 text-left hover:bg-accent transition-colors border ${
											isFocused
												? "border-primary ring-2 ring-primary/20"
												: "border-border"
										}`}
										role="option"
										aria-selected={isExpanded}
										aria-expanded={isExpanded}
										tabIndex={isFocused ? 0 : -1}
									>
										{/* Header */}
										<div className="flex items-start justify-between gap-2">
											<div className="flex items-center gap-2">
												{version.author && (
													<Avatar name={version.author} size="sm" />
												)}
												<div>
													<div className="text-sm font-medium text-secondary-foreground">
													{getChangeSummary(version, loadedVersions.has(version.version))}
													</div>
													<div className="text-xs text-muted-foreground">
														{version.author && (
															<span>{version.author} &bull; </span>
														)}
														{formatRelativeTime(version.timestamp)}
													</div>
												</div>
											</div>
											<div className="flex items-center gap-1">
												<span className="text-xs text-muted-foreground">
													v{version.version}
												</span>
												{isExpanded ? (
													<ChevronDown className="w-4 h-4 text-muted-foreground" />
												) : (
													<ChevronRight className="w-4 h-4 text-muted-foreground" />
												)}
											</div>
										</div>

										{/* Expanded diff view */}
										{isExpanded && (
											<div
												className="mt-3 pt-3 border-t border-dashed border-border"
												onClick={(e) => e.stopPropagation()}
											>
												<VersionDiffViewer
													changes={version.changes}
													viewType="unified"
													showToggle={false}
												/>
												{onRestore && version.version > 1 && (
													<div className="mt-3 flex justify-end">
														<Button
															variant="outline"
															size="sm"
															onClick={(e) => {
																e.stopPropagation();
															void loadVersionDetail(version.version).then((detail) => {
																if (detail) onRestore(detail);
															});
															}}
															className="text-xs"
														>
															<RotateCcw className="w-3 h-3 mr-1" />
															Restore to v{version.version}
														</Button>
													</div>
												)}
											</div>
										)}
									</button>
								</div>
							);
						})}
						{hasMore && (
							<div className="pt-2 text-center">
								<Button variant="ghost" size="sm" onClick={() => void loadMore()}>Load more history</Button>
							</div>
						)}
					</div>
				) : null}
			</CollapsibleContent>
		</Collapsible>
	);
}
