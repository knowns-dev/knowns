import { useState, useEffect, useMemo } from "react";
import { History, ChevronDown, ChevronRight, Filter, RotateCcw } from "lucide-react";
import type { TaskVersion, TaskChange } from "../../models/version";
import { api } from "../api/client";
import { useTheme } from "../App";
import Avatar from "./Avatar";
import { Button } from "./ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "./ui/collapsible";
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
function getChangeSummary(changes: TaskChange[]): string {
	if (changes.length === 0) return "No changes";
	if (changes.length === 1) {
		const change = changes[0];
		return `Changed ${FIELD_LABELS[change.field] || change.field}`;
	}
	return `Changed ${changes.length} fields`;
}

export default function TaskHistoryPanel({ taskId, onRestore }: TaskHistoryPanelProps) {
	const { isDark } = useTheme();
	const [versions, setVersions] = useState<TaskVersion[]>([]);
	const [loading, setLoading] = useState(true);
	const [isOpen, setIsOpen] = useState(false);
	const [filter, setFilter] = useState("all");
	const [expandedVersions, setExpandedVersions] = useState<Set<number>>(new Set());

	useEffect(() => {
		if (isOpen && taskId) {
			setLoading(true);
			api.getTaskHistory(taskId)
				.then((data) => {
					// Sort by version descending (most recent first)
					setVersions(data.sort((a, b) => b.version - a.version));
				})
				.catch((err) => {
					console.error("Failed to load task history:", err);
				})
				.finally(() => {
					setLoading(false);
				});
		}
	}, [taskId, isOpen]);

	// Filter versions based on selected filter
	const filteredVersions = useMemo(() => {
		if (filter === "all") return versions;
		return versions.filter((v) =>
			v.changes.some((c) => getChangeCategory(c.field) === filter)
		);
	}, [versions, filter]);

	const toggleVersion = (versionNum: number) => {
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

	// Theme classes
	const textSecondary = isDark ? "text-gray-300" : "text-gray-700";
	const textMuted = isDark ? "text-gray-400" : "text-gray-500";
	const bgCard = isDark ? "bg-gray-700" : "bg-white";
	const borderColor = isDark ? "border-gray-600" : "border-gray-200";
	const hoverBg = isDark ? "hover:bg-gray-600" : "hover:bg-gray-50";

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen}>
			<div className={`flex items-center gap-2 mb-3 ${textSecondary}`}>
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
					<span className={`text-sm ${textMuted}`}>
						({versions.length} changes)
					</span>
				)}
			</div>

			<CollapsibleContent>
				{/* Filter */}
				{versions.length > 0 && (
					<div className="flex items-center gap-2 mb-3">
						<Filter className={`w-4 h-4 ${textMuted}`} />
						<select
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							className={`text-sm rounded px-2 py-1 ${bgCard} ${borderColor} border ${textSecondary}`}
						>
							{CHANGE_TYPES.map((type) => (
								<option key={type.value} value={type.value}>
									{type.label}
								</option>
							))}
						</select>
					</div>
				)}

				{loading ? (
					<div className={`text-sm ${textMuted} py-4 text-center`}>
						Loading history...
					</div>
				) : filteredVersions.length === 0 ? (
					<div className={`text-sm ${textMuted} py-4 text-center`}>
						No history available
					</div>
				) : (
					<div className="space-y-2 relative">
						{/* Timeline line */}
						<div
							className={`absolute left-3 top-2 bottom-2 w-0.5 ${isDark ? "bg-gray-600" : "bg-gray-200"}`}
						/>

						{filteredVersions.map((version) => {
							const isExpanded = expandedVersions.has(version.version);

							return (
								<div key={version.id} className="relative pl-8">
									{/* Timeline dot */}
									<div
										className={`absolute left-1.5 top-3 w-3 h-3 rounded-full border-2 ${
											isDark
												? "bg-gray-800 border-blue-400"
												: "bg-white border-blue-500"
										}`}
									/>

									<button
										type="button"
										onClick={() => toggleVersion(version.version)}
										className={`w-full ${bgCard} rounded-lg p-3 text-left ${hoverBg} transition-colors border ${borderColor}`}
									>
										{/* Header */}
										<div className="flex items-start justify-between gap-2">
											<div className="flex items-center gap-2">
												{version.author && (
													<Avatar name={version.author} size="sm" />
												)}
												<div>
													<div className={`text-sm font-medium ${textSecondary}`}>
														{getChangeSummary(version.changes)}
													</div>
													<div className={`text-xs ${textMuted}`}>
														{version.author && (
															<span>{version.author} &bull; </span>
														)}
														{formatRelativeTime(version.timestamp)}
													</div>
												</div>
											</div>
											<div className={`text-xs ${textMuted}`}>
												v{version.version}
											</div>
										</div>

										{/* Expanded diff view */}
										{isExpanded && (
											<div
												className="mt-3 pt-3 border-t border-dashed"
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
																onRestore(version);
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
					</div>
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}
