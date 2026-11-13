import type { ContextKind, ContextSegment } from "@/ui/components/ui/knowns/context-window/context-utils";

export type PackItemType = "doc" | "task" | "memory" | "decision";

/** One item of the context pack, as GET /api/retrieve returns it (only the fields the view reads). */
export interface PackItem {
	type: string;
	id: string;
	title: string;
	content: string;
	directMatch?: boolean;
	expandedFrom?: string;
	metadata?: Record<string, unknown>;
}

export interface PackCandidate {
	type: string;
	id: string;
	score: number;
}

/** A pack item with what the list needs: its estimated size, its score and where it opens. */
export interface PackRow {
	key: string;
	type: PackItemType;
	id: string;
	title: string;
	tokens: number;
	score: number | null;
	directMatch: boolean;
	href: string | null;
}

const TYPE_ORDER: PackItemType[] = ["doc", "task", "memory", "decision"];

export const TYPE_LABEL: Record<PackItemType, string> = {
	doc: "Docs",
	task: "Tasks",
	memory: "Memories",
	decision: "Decisions",
};

/** The segment kind only picks the tile colour; each Knowns type gets its own. */
const TYPE_KIND: Record<PackItemType, ContextKind> = {
	doc: "files",
	task: "history",
	memory: "tools",
	decision: "system",
};

/** Knowns has no tokenizer in the browser: about four characters per token, shown as an estimate. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function isPackType(type: string): type is PackItemType {
	return type === "doc" || type === "task" || type === "memory" || type === "decision";
}

/** Where an item opens in the web UI, or null for a type the UI has no page for. */
export function itemHref(type: PackItemType, id: string): string {
	const segment = encodeURIComponent(id);
	switch (type) {
		case "doc":
			return `/docs/${id.split("/").map(encodeURIComponent).join("/")}`;
		case "task":
			return `/tasks/${segment}`;
		case "memory":
			return `/memory/${segment}`;
		case "decision":
			return `/decisions/${segment}`;
	}
}

export function packRows(items: PackItem[], candidates: PackCandidate[] = []): PackRow[] {
	const scores = new Map(candidates.map((c) => [`${c.type}:${c.id}`, c.score]));
	const rows: PackRow[] = [];
	for (const item of items) {
		if (!isPackType(item.type)) continue;
		rows.push({
			key: `${item.type}:${item.id}`,
			type: item.type,
			id: item.id,
			title: item.title || item.id,
			tokens: estimateTokens(item.content ?? ""),
			score: scores.get(`${item.type}:${item.id}`) ?? null,
			directMatch: item.directMatch === true,
			href: itemHref(item.type, item.id),
		});
	}
	return rows;
}

/** One segment per type, each item a part, so the window shows the total and the treemap each item's weight. */
export function packSegments(rows: PackRow[]): ContextSegment[] {
	const segments: ContextSegment[] = [];
	for (const type of TYPE_ORDER) {
		const own = rows.filter((r) => r.type === type);
		if (own.length === 0) continue;
		segments.push({
			id: type,
			label: TYPE_LABEL[type],
			kind: TYPE_KIND[type],
			tokens: own.reduce((sum, r) => sum + r.tokens, 0),
			parts: own.map((r) => ({
				id: r.key,
				label: r.title,
				tokens: r.tokens,
				detail: r.score === null ? r.id : `${r.id} · score ${r.score.toFixed(2)}`,
			})),
		});
	}
	return segments;
}
