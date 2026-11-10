import type { AuditEvent } from "@/ui/api/client";
import type { BadgeTone } from "@/ui/components/ui/knowns/badge";

/** An event with a stable key and its time in ms, ready for the list and the detail sheet. */
export interface AuditRow {
	key: string;
	at: number;
	event: AuditEvent;
}

/** Keys stay stable across a refresh or a "Show older" so a row that did not change keeps its identity. */
export function toRows(events: AuditEvent[]): AuditRow[] {
	const seen = new Map<string, number>();
	return events.map((event) => {
		const base = `${event.timestamp}|${event.toolName}|${event.action ?? ""}`;
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		return { key: n ? `${base}|${n}` : base, at: Date.parse(event.timestamp), event };
	});
}

export const RESULT_META: Record<string, { label: string; tone: BadgeTone }> = {
	success: { label: "Success", tone: "success" },
	error: { label: "Error", tone: "danger" },
	denied: { label: "Denied", tone: "warning" },
};

export function resultMeta(result: string): { label: string; tone: BadgeTone } {
	return RESULT_META[result] ?? { label: result || "Unknown", tone: "neutral" };
}

export const CLASS_META: Record<string, { label: string; tone: BadgeTone }> = {
	read: { label: "Read", tone: "info" },
	write: { label: "Write", tone: "accent" },
	archive: { label: "Archive", tone: "warning" },
	delete: { label: "Delete", tone: "danger" },
	generate: { label: "Generate", tone: "accent" },
	admin: { label: "Admin", tone: "neutral" },
};

export function classMeta(actionClass: string): { label: string; tone: BadgeTone } {
	return CLASS_META[actionClass] ?? { label: actionClass || "Other", tone: "neutral" };
}

/** "tasks.create", or the bare tool name when there is no action. */
export function toolLabel(event: Pick<AuditEvent, "toolName" | "action">): string {
	return event.action ? `${event.toolName}.${event.action}` : event.toolName;
}

export interface EntityRef {
	raw: string;
	kind: string;
	id: string;
	/** "Task 12", "Doc guides/setup". */
	label: string;
	/** In-app route, when the kind has a page. */
	href?: string;
}

const ENTITY_KIND: Record<string, { label: string; href: (id: string) => string }> = {
	task: { label: "Task", href: (id) => `/tasks/${encodeURIComponent(id)}` },
	doc: { label: "Doc", href: (id) => `/docs/${id.replace(/^\/+/, "")}` },
	spec: { label: "Spec", href: (id) => `/docs/${id.replace(/^\/+/, "")}` },
	memory: { label: "Memory", href: (id) => `/memory/${encodeURIComponent(id)}` },
	template: { label: "Template", href: () => "/templates" },
};

/** "task:12" becomes a labelled ref with a link to the task. Unknown kinds keep their raw text. */
export function parseEntityRef(raw: string): EntityRef {
	const at = raw.indexOf(":");
	if (at <= 0) return { raw, kind: "", id: raw, label: raw };
	const kind = raw.slice(0, at);
	const id = raw.slice(at + 1);
	const meta = ENTITY_KIND[kind];
	if (!meta) return { raw, kind, id, label: raw };
	return { raw, kind, id, label: `${meta.label} ${id}`, href: meta.href(id) };
}

/** The last folder of a project path, for a compact row: "/Users/me/acme" -> "acme". */
export function projectName(root?: string): string {
	if (!root) return "";
	const parts = root.split(/[\\/]+/).filter(Boolean);
	return parts[parts.length - 1] ?? root;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms)) return "";
	if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
	return `${Math.round(ms)} ms`;
}

/** Everything a person might type to find an event: tool, action, refs, arguments, error and project. */
export function matchesQuery(event: AuditEvent, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	const hay = [
		toolLabel(event),
		event.actionClass,
		event.result,
		event.errorMessage ?? "",
		event.projectRoot ?? "",
		...(event.entityRefs ?? []),
		...(event.entityRefs ?? []).map((ref) => parseEntityRef(ref).label),
		...Object.entries(event.argumentSummary ?? {}).map(([key, value]) => `${key} ${value}`),
	]
		.join("\n")
		.toLowerCase();
	return q.split(/\s+/).every((word) => hay.includes(word));
}

/**
 * One readable line for the list. Plain errors pass through; a JSON payload (a denied operation, a
 * structured tool error) gives its message field when it has one, else a short description.
 */
export function errorSummary(event: Pick<AuditEvent, "errorMessage" | "result">): string {
	const text = (event.errorMessage ?? "").trim();
	if (!text.startsWith("{") && !text.startsWith("[")) return text;
	const field = /"(?:message|reason|error)"\s*:\s*"((?:\\.|[^"\\])+)"/.exec(text);
	if (field?.[1]) return field[1].replace(/\\"/g, '"');
	return event.result === "denied" ? "Blocked by a permission check" : "Structured error, open for details";
}

/** Parse text that holds JSON (a denied policy payload, a map argument); anything else comes back as null. */
export function parseJsonText(text: string): unknown | null {
	const trimmed = text.trim();
	if (!/^[[{]/.test(trimmed)) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

/** The event as the API sent it, pretty-printed, with JSON inside strings unpacked so it reads as one tree. */
export function eventJson(event: AuditEvent): string {
	const unpack = (value: string) => parseJsonText(value) ?? value;
	const copy: Record<string, unknown> = { ...event };
	if (event.errorMessage) copy.errorMessage = unpack(event.errorMessage);
	if (event.argumentSummary) {
		copy.argumentSummary = Object.fromEntries(
			Object.entries(event.argumentSummary).map(([key, value]) => [key, unpack(value)]),
		);
	}
	return JSON.stringify(copy, null, 2);
}

/** Exact local time for a hover hint and the detail sheet: "Wed, 11 Nov 2026, 14:05:09". */
export function exactTime(at: number): string {
	return new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).format(new Date(at));
}

export function browserTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function formatRangeDay(date: string): string {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${date}T00:00:00Z`));
}
