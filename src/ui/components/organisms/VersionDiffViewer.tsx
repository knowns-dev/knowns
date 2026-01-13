import { useState } from "react";
import DiffViewer from "react-diff-viewer-continued-react19";
import { Columns2, AlignJustify } from "lucide-react";
import type { TaskChange } from "../../../models/version";
import { useTheme } from "../../App";
import { Button } from "../ui/button";

// DiffMethod enum
const DiffMethod = {
	CHARS: "diffChars",
	WORDS: "diffWords",
	WORDS_WITH_SPACE: "diffWordsWithSpace",
	LINES: "diffLines",
	TRIMMED_LINES: "diffTrimmedLines",
	SENTENCES: "diffSentences",
	CSS: "diffCss",
} as const;

interface VersionDiffViewerProps {
	changes: TaskChange[];
	viewType?: "split" | "unified";
	showToggle?: boolean;
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

// Convert value to string for display
function valueToString(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		// Handle acceptance criteria array
		if (value.length > 0 && typeof value[0] === "object" && "text" in value[0]) {
			return value
				.map((ac: { text: string; completed: boolean }, i) =>
					`${i + 1}. [${ac.completed ? "x" : " "}] ${ac.text}`
				)
				.join("\n");
		}
		// Handle labels array
		return value.join(", ");
	}
	if (typeof value === "object") {
		return JSON.stringify(value, null, 2);
	}
	return String(value);
}

export default function VersionDiffViewer({
	changes,
	viewType: initialViewType = "unified",
	showToggle = true,
}: VersionDiffViewerProps) {
	const { isDark } = useTheme();
	const [viewType, setViewType] = useState<"split" | "unified">(initialViewType);


	// Custom styles for react-diff-viewer
	const darkTheme = {
		variables: {
			dark: {
				diffViewerBackground: "#1f2937",
				diffViewerColor: "#d1d5db",
				addedBackground: "rgba(34, 197, 94, 0.2)",
				addedColor: "#86efac",
				removedBackground: "rgba(239, 68, 68, 0.2)",
				removedColor: "#fca5a5",
				wordAddedBackground: "rgba(34, 197, 94, 0.4)",
				wordRemovedBackground: "rgba(239, 68, 68, 0.4)",
				addedGutterBackground: "rgba(34, 197, 94, 0.3)",
				removedGutterBackground: "rgba(239, 68, 68, 0.3)",
				gutterBackground: "#374151",
				gutterBackgroundDark: "#1f2937",
				highlightBackground: "rgba(59, 130, 246, 0.3)",
				highlightGutterBackground: "rgba(59, 130, 246, 0.2)",
				codeFoldGutterBackground: "#374151",
				codeFoldBackground: "#1f2937",
				emptyLineBackground: "#1f2937",
				gutterColor: "#9ca3af",
				addedGutterColor: "#86efac",
				removedGutterColor: "#fca5a5",
				codeFoldContentColor: "#9ca3af",
				diffViewerTitleBackground: "#374151",
				diffViewerTitleColor: "#d1d5db",
				diffViewerTitleBorderColor: "#4b5563",
			},
		},
	};

	const lightTheme = {
		variables: {
			light: {
				diffViewerBackground: "#ffffff",
				diffViewerColor: "#374151",
				addedBackground: "rgba(187, 247, 208, 0.5)",
				addedColor: "#166534",
				removedBackground: "rgba(254, 202, 202, 0.5)",
				removedColor: "#991b1b",
				wordAddedBackground: "rgba(187, 247, 208, 0.8)",
				wordRemovedBackground: "rgba(254, 202, 202, 0.8)",
				addedGutterBackground: "rgba(187, 247, 208, 0.7)",
				removedGutterBackground: "rgba(254, 202, 202, 0.7)",
				gutterBackground: "#f3f4f6",
				gutterBackgroundDark: "#e5e7eb",
				highlightBackground: "rgba(59, 130, 246, 0.1)",
				highlightGutterBackground: "rgba(59, 130, 246, 0.1)",
				codeFoldGutterBackground: "#f3f4f6",
				codeFoldBackground: "#f9fafb",
				emptyLineBackground: "#f9fafb",
				gutterColor: "#6b7280",
				addedGutterColor: "#166534",
				removedGutterColor: "#991b1b",
				codeFoldContentColor: "#6b7280",
				diffViewerTitleBackground: "#f3f4f6",
				diffViewerTitleColor: "#374151",
				diffViewerTitleBorderColor: "#e5e7eb",
			},
		},
	};

	if (changes.length === 0) {
		return (
			<div className="text-sm text-secondary-foreground text-center py-4">
				No changes to display
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{/* View Type Toggle */}
			{showToggle && (
				<div className="flex items-center justify-end gap-2">
					<Button
						variant={viewType === "unified" ? "secondary" : "ghost"}
						size="sm"
						onClick={() => setViewType("unified")}
						title="Unified view"
					>
						<AlignJustify className="w-4 h-4 mr-1" />
						Unified
					</Button>
					<Button
						variant={viewType === "split" ? "secondary" : "ghost"}
						size="sm"
						onClick={() => setViewType("split")}
						title="Split view"
					>
						<Columns2 className="w-4 h-4 mr-1" />
						Split
					</Button>
				</div>
			)}

			{/* Diffs */}
			{changes.map((change, idx) => {
				const oldStr = valueToString(change.oldValue);
				const newStr = valueToString(change.newValue);
				const label = FIELD_LABELS[change.field] || change.field;

				return (
					<div
						key={`${change.field}-${idx}`}
						className="rounded-lg border border-border overflow-hidden"
					>
						{/* Field Header */}
						<div className="px-3 py-2 bg-muted border-b border-border font-medium text-sm text-secondary-foreground">
							{label}
						</div>

						{/* Diff Content */}
						<div className="text-xs">
							<DiffViewer
								oldValue={oldStr}
								newValue={newStr}
								splitView={viewType === "split"}
								useDarkTheme={isDark}
								styles={isDark ? darkTheme : lightTheme}
								compareMethod={DiffMethod.WORDS}
								extraLinesSurroundingDiff={5}
								hideLineNumbers={false}
								showDiffOnly={false}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}
