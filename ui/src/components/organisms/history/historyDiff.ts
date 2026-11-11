import type { ChangedFile } from "@/ui/components/ui/knowns/diff/change-summary";

/**
 * Word diff runs Myers over words and the spaces between them, and keeps one trace row per step, so its cost
 * grows with size. Past this many tokens on either side the history view shows a line diff instead.
 */
export const PROSE_TOKEN_LIMIT = 2000;

/** Words and the whitespace between them, the same split the prose diff uses. */
export function tokenCount(text: string): number {
	return text.match(/\s+|[^\s]+/g)?.length ?? 0;
}

export type TextDiffMode = "prose" | "lines";

export function textDiffMode(before: string, after: string): TextDiffMode {
	return tokenCount(before) <= PROSE_TOKEN_LIMIT && tokenCount(after) <= PROSE_TOKEN_LIMIT ? "prose" : "lines";
}

export interface FieldChange {
	field: string;
	oldValue?: unknown;
	newValue?: unknown;
}

/** One entry per changed field for ChangeSummary, labelled for people and with both sides as text. */
export function changedFiles(
	changes: FieldChange[],
	label: (field: string) => string,
	text: (field: string, value: unknown) => string,
): ChangedFile[] {
	return changes.map((change) => ({
		path: label(change.field),
		status: "modified" as const,
		before: text(change.field, change.oldValue),
		after: text(change.field, change.newValue),
	}));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The fields that differ between two document snapshots, in the order given. */
export function snapshotChanges(
	from: Record<string, unknown> | undefined,
	to: Record<string, unknown> | undefined,
	fields: string[],
): FieldChange[] {
	const changes: FieldChange[] = [];
	for (const field of fields) {
		const oldValue = from?.[field];
		const newValue = to?.[field];
		if (!same(oldValue, newValue)) changes.push({ field, oldValue, newValue });
	}
	return changes;
}

/** Unchanged runs longer than this are folded to their ends until the reader asks for the whole text. */
export const FOLD_OVER = 600;
export const FOLD_KEEP = 200;

export function foldRun(text: string): { head: string; tail: string; hidden: number } | null {
	if (text.length <= FOLD_OVER) return null;
	return { head: text.slice(0, FOLD_KEEP), tail: text.slice(-FOLD_KEEP), hidden: text.length - 2 * FOLD_KEEP };
}
