import { useState } from "react";
import type { TaskChange } from "@/ui/models/version";
import { InlineDiff, type DiffView } from "@/ui/components/ui/knowns/diff/inline-diff";
import { SegmentedControl } from "@/ui/components/ui/knowns/segmented-control";
import { getStatusLabel } from "../../utils/colors";
import { formatTracked } from "./TaskDetail/types";

interface VersionDiffViewerProps {
	changes: TaskChange[];
	viewType?: DiffView;
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
	timeSpent: "Time spent",
	parent: "Parent",
	spec: "Linked Spec",
};

/** Fields that read as prose or lists: shown as a line diff. Everything else is a short before / after. */
const TEXT_FIELDS = new Set(["description", "acceptanceCriteria", "implementationPlan", "implementationNotes"]);

// Convert value to string for display
export function valueToString(field: string, value: unknown): string {
	if (value === null || value === undefined) return "";
	if (field === "status" && typeof value === "string") return getStatusLabel(value);
	if (field === "priority" && typeof value === "string") return value.charAt(0).toUpperCase() + value.slice(1);
	if (field === "timeSpent" && typeof value === "number") return formatTracked(value);
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		// Acceptance criteria: one numbered line each
		if (value.length > 0 && typeof value[0] === "object" && value[0] !== null && "text" in value[0]) {
			return value
				.map((ac: { text: string; completed: boolean }, i) => `${i + 1}. [${ac.completed ? "x" : " "}] ${ac.text}`)
				.join("\n");
		}
		return value.join(", ");
	}
	if (typeof value === "object") return JSON.stringify(value, null, 2);
	return String(value);
}

function ScalarChange({ label, before, after }: { label: string; before: string; after: string }) {
	return (
		<div className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] items-baseline gap-3 py-2 text-[13px]">
			<span className="truncate text-muted-foreground">{label}</span>
			<span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
				{before ? (
					<del className="rounded-[4px] bg-red-500/10 px-1.5 text-foreground/70 decoration-red-500/50 dark:bg-red-400/10">
						<span className="sr-only">Removed: </span>
						{before}
					</del>
				) : (
					<span className="text-muted-foreground">None</span>
				)}
				<span aria-hidden className="text-muted-foreground">
					→
				</span>
				{after ? (
					<ins className="rounded-[4px] bg-emerald-500/12 px-1.5 text-foreground no-underline dark:bg-emerald-400/12">
						<span className="sr-only">Added: </span>
						{after}
					</ins>
				) : (
					<span className="text-muted-foreground">None</span>
				)}
			</span>
		</div>
	);
}

export default function VersionDiffViewer({ changes, viewType: initialViewType = "unified", showToggle = true }: VersionDiffViewerProps) {
	const [view, setView] = useState<DiffView>(initialViewType);

	if (changes.length === 0) {
		return <p className="py-3 text-[13px] text-muted-foreground">No field changes in this version.</p>;
	}

	const scalars = changes.filter((c) => !TEXT_FIELDS.has(c.field));
	const texts = changes.filter((c) => TEXT_FIELDS.has(c.field));

	return (
		<div className="flex flex-col gap-3">
			{showToggle && texts.length > 0 && (
				<div className="flex justify-end">
					<SegmentedControl
						size="sm"
						aria-label="Diff layout"
						value={view}
						onValueChange={(v) => setView(v as DiffView)}
						options={[
							{ value: "unified", label: "Unified" },
							{ value: "split", label: "Split" },
						]}
					/>
				</div>
			)}
			{scalars.length > 0 && (
				<div className="divide-y divide-[color-mix(in_srgb,var(--foreground)_8%,transparent)]">
					{scalars.map((change, idx) => (
						<ScalarChange
							key={`${change.field}-${idx}`}
							label={FIELD_LABELS[change.field] || change.field}
							before={valueToString(change.field, change.oldValue)}
							after={valueToString(change.field, change.newValue)}
						/>
					))}
				</div>
			)}
			{texts.map((change, idx) => (
				<InlineDiff
					key={`${change.field}-${idx}`}
					path={FIELD_LABELS[change.field] || change.field}
					before={valueToString(change.field, change.oldValue)}
					after={valueToString(change.field, change.newValue)}
					view={view}
					onViewChange={setView}
					wrap
				/>
			))}
		</div>
	);
}
