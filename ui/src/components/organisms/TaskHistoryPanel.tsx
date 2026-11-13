import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { History, ChevronRight, RotateCcw, GitCompare, ArrowRight } from "lucide-react";
import type { TaskVersion, TaskChange, TaskHistoryMetadata } from "@/ui/models/version";
import { createTaskDiff } from "@/ui/models/version";
import { api } from "../../api/client";
import { Avatar } from "@/ui/components/ui/knowns/avatar";
import { Button } from "@/ui/components/ui/knowns/button";
import { Combobox } from "@/ui/components/ui/knowns/combobox";
import { SegmentedControl } from "@/ui/components/ui/knowns/segmented-control";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
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
	timeSpent: "Time spent",
	parent: "Parent",
	spec: "Linked Spec",
};

// Change type categories for filtering
const CHANGE_TYPES = [
	{ value: "all", label: "All" },
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
			if (filteredVersions.length === 0) return;

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
		[filteredVersions, focusedIndex, toggleVersion]
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

	const summary = loading ? "Loading history" : `${versions.length}${hasMore ? "+" : ""} change${versions.length === 1 ? "" : "s"}`;

	return (
		<section aria-label="History" className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
				<p className="text-[13px] text-muted-foreground tabular-nums">{summary}</p>
				{versions.length > 0 && (
					<div className="flex flex-wrap items-center gap-2">
						<SegmentedControl
							size="sm"
							aria-label="Filter changes"
							value={filter}
							onValueChange={setFilter}
							disabled={compareMode}
							options={CHANGE_TYPES}
						/>
						<Button
							size="sm"
							variant={compareMode ? "secondary" : "ghost"}
							icon={<GitCompare />}
							aria-pressed={compareMode}
							onClick={() => setCompareMode(!compareMode)}
						>
							Compare
						</Button>
					</div>
				)}
			</div>

			{tailTruncated && (
				<div role="alert" className="rounded-lg bg-amber-500/10 px-3 py-2 text-[13px] text-amber-900 dark:text-amber-100">
					The final history append is incomplete and was ignored. Run reconciliation before restoring that revision.
				</div>
			)}

			{compareMode && versions.length > 0 && (
				<div className="flex flex-col gap-3">
					<div className="flex flex-wrap items-center gap-2">
						<Combobox
							size="sm"
							aria-label="From version"
							placeholder="From version"
							value={fromVersion || null}
							onValueChange={setFromVersion}
							options={versions.map((v) => ({ value: String(v.version), label: `v${v.version}`, disabled: String(v.version) === toVersion }))}
							className="w-32"
						/>
						<ArrowRight aria-hidden className="size-4 text-muted-foreground" />
						<Combobox
							size="sm"
							aria-label="To version"
							placeholder="To version"
							value={toVersion || null}
							onValueChange={setToVersion}
							options={versions.map((v) => ({ value: String(v.version), label: `v${v.version}`, disabled: String(v.version) === fromVersion }))}
							className="w-32"
						/>
						{fromVersion && toVersion && fromVersion !== toVersion && (
							<span className="text-[12.5px] text-muted-foreground">
								{comparisonDiff.length === 0
									? "No changes"
									: `${comparisonDiff.length} field${comparisonDiff.length > 1 ? "s" : ""} changed`}
							</span>
						)}
					</div>
					{fromVersion && toVersion && fromVersion !== toVersion ? (
						<>
							<VersionDiffViewer changes={comparisonDiff} viewType="split" showToggle />
							{onRestore && toVersionObj && toVersionObj.version > 1 && (
								<div className="flex justify-end">
									<Button size="sm" variant="secondary" icon={<RotateCcw />} onClick={() => onRestore(toVersionObj)}>
										Restore to v{toVersionObj.version}
									</Button>
								</div>
							)}
						</>
					) : (
						<p className="text-[13px] text-muted-foreground">Pick two versions to see what changed between them.</p>
					)}
				</div>
			)}

			{loading ? (
				<div className="flex flex-col gap-3" aria-hidden>
					{[0, 1, 2].map((i) => (
						<div key={i} className="flex items-center gap-3">
							<span className="size-6 rounded-md bg-muted motion-safe:animate-pulse" />
							<span className="h-3 flex-1 rounded bg-muted motion-safe:animate-pulse" />
						</div>
					))}
				</div>
			) : filteredVersions.length === 0 ? (
				<p className="py-2 text-[13px] text-muted-foreground">
					{versions.length === 0 ? "No history yet. Edits to this task show up here." : "No changes of this kind."}
				</p>
			) : !compareMode ? (
				<div
					ref={listRef}
					className="flex flex-col"
					onKeyDown={handleKeyDown}
					role="listbox"
					aria-label="Version history"
					tabIndex={focusedIndex >= 0 ? -1 : 0}
					onFocus={(e) => {
						if (e.target === e.currentTarget && filteredVersions.length > 0) {
							const first = filteredVersions[0];
							setFocusedIndex(0);
							if (first) itemRefs.current.get(first.version)?.focus();
						}
					}}
				>
					{filteredVersions.map((version, index) => {
						const isExpanded = expandedVersions.has(version.version);
						const isFocused = focusedIndex === index;
						const who = version.author || version.actor;

						return (
							<div key={version.id} className="border-b border-[color-mix(in_srgb,var(--foreground)_8%,transparent)] last:border-b-0">
								<button
									ref={(el) => {
										if (el) itemRefs.current.set(version.version, el);
										else itemRefs.current.delete(version.version);
									}}
									type="button"
									onClick={() => toggleVersion(version.version)}
									onFocus={() => setFocusedIndex(index)}
									className={cn(
										"-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]",
										focusRing,
									)}
									role="option"
									aria-selected={isExpanded}
									aria-expanded={isExpanded}
									tabIndex={isFocused || (focusedIndex < 0 && index === 0) ? 0 : -1}
								>
									{who ? (
										<Avatar label={who} size="sm" shape="circle" decorative />
									) : (
										<span aria-hidden className="grid size-6 flex-none place-items-center rounded-full bg-muted text-muted-foreground">
											<History className="size-3.5" />
										</span>
									)}
									<span className="min-w-0 flex-1">
										<span className="block truncate text-[13.5px] text-foreground">
											{getChangeSummary(version, loadedVersions.has(version.version))}
										</span>
										<span className="block truncate text-[12.5px] text-muted-foreground">
											{who ? `${who} · ` : ""}
											<time dateTime={version.timestamp.toISOString()} title={version.timestamp.toLocaleString()}>
												{formatRelativeTime(version.timestamp)}
											</time>
										</span>
									</span>
									<span className="flex-none font-mono text-[12px] text-muted-foreground tabular-nums">v{version.version}</span>
									<ChevronRight
										aria-hidden
										className={cn("size-4 flex-none text-muted-foreground transition-[rotate] duration-200", isExpanded && "rotate-90")}
									/>
								</button>
								{isExpanded && (
									<div className="pb-4 pl-9 max-sm:pl-0">
										<VersionDiffViewer changes={version.changes} viewType="unified" showToggle={false} />
										{onRestore && version.version > 1 && (
											<div className="mt-3 flex justify-end">
												<Button
													size="sm"
													variant="secondary"
													icon={<RotateCcw />}
													onClick={() => {
														void loadVersionDetail(version.version).then((detail) => {
															if (detail) onRestore(detail);
														});
													}}
												>
													Restore to v{version.version}
												</Button>
											</div>
										)}
									</div>
								)}
							</div>
						);
					})}
					{hasMore && (
						<div className="pt-3">
							<Button variant="ghost" size="sm" onClick={() => void loadMore()}>
								Load more history
							</Button>
						</div>
					)}
				</div>
			) : null}
		</section>
	);
}
