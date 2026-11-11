import { InlineDiff, type DiffView } from "@/ui/components/ui/knowns/diff/inline-diff";
import { ReadOnlyProseDiff } from "./ReadOnlyProseDiff";
import { textDiffMode } from "./historyDiff";

interface TextChangeDiffProps {
	label: string;
	before: string;
	after: string;
	/** Prose (description, plan, notes, doc content) reads best word by word; lists and code stay line by line. */
	prose: boolean;
	view: DiffView;
	onViewChange: (view: DiffView) => void;
}

/** Whether this change is drawn as a word diff (so the layout switch has nothing to do for it). */
export function usesProse(prose: boolean, before: string, after: string): boolean {
	return prose && textDiffMode(before, after) === "prose";
}

export function TextChangeDiff({ label, before, after, prose, view, onViewChange }: TextChangeDiffProps) {
	if (usesProse(prose, before, after)) {
		return (
			<section aria-label={label} className="overflow-hidden rounded-lg border border-border bg-card">
				<div className="border-b border-border bg-muted/40 px-3 py-2 text-sm font-medium">{label}</div>
				<ReadOnlyProseDiff before={before} after={after} />
			</section>
		);
	}
	return <InlineDiff path={label} before={before} after={after} view={view} onViewChange={onViewChange} wrap />;
}
