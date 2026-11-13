import type { AuditDailyBucket, AuditEvent, AuditToolStats } from "@/ui/api/client";
import { errorSummary, toolLabel } from "./auditFormat";

export function hasCoveredAuditDays(buckets: AuditDailyBucket[]): boolean {
	return buckets.some((bucket) => bucket.covered);
}

/**
 * The buckets from the first to the last day the retained log covers, and how many earlier days it does not.
 * Days after the covered window (none in practice) are dropped too, so the chart never starts with a blank stretch.
 */
export function coveredWindow(buckets: AuditDailyBucket[]): { window: AuditDailyBucket[]; earlierUncovered: number } {
	const first = buckets.findIndex((bucket) => bucket.covered);
	if (first < 0) return { window: [], earlierUncovered: buckets.length };
	let last = buckets.length - 1;
	while (last > first && !buckets[last]?.covered) last -= 1;
	return { window: buckets.slice(first, last + 1), earlierUncovered: first };
}

export interface TrendPoint {
	/** First day of the point (a day, or the Monday of a week). */
	date: string;
	/** Last day the point stands for (same as `date` for a day). */
	endDate: string;
	succeeded: number;
	attention: number;
	total: number;
	days: number;
}

/** One point per day, or per week when `weekly`. Uncovered days count as nothing. */
export function toTrendPoints(buckets: AuditDailyBucket[], weekly: boolean): TrendPoint[] {
	const perDay = buckets.map<TrendPoint>((bucket) => ({
		date: bucket.date,
		endDate: bucket.date,
		succeeded: bucket.successCount,
		attention: bucket.needsAttention,
		total: bucket.totalCalls,
		days: 1,
	}));
	if (!weekly) return perDay;
	const out: TrendPoint[] = [];
	for (let i = 0; i < perDay.length; i += 7) {
		const chunk = perDay.slice(i, i + 7);
		const first = chunk[0];
		const last = chunk[chunk.length - 1];
		if (!first || !last) continue;
		out.push({
			date: first.date,
			endDate: last.date,
			succeeded: chunk.reduce((sum, p) => sum + p.succeeded, 0),
			attention: chunk.reduce((sum, p) => sum + p.attention, 0),
			total: chunk.reduce((sum, p) => sum + p.total, 0),
			days: chunk.length,
		});
	}
	return out;
}

/** The days with the most calls, busiest first; ties go to the more recent day. */
export function busiestDays(buckets: AuditDailyBucket[], count = 5): AuditDailyBucket[] {
	return buckets
		.filter((bucket) => bucket.covered && bucket.totalCalls > 0)
		.sort((a, b) => b.totalCalls - a.totalCalls || b.date.localeCompare(a.date))
		.slice(0, count);
}

export interface AttentionRow {
	/** "tasks.create", as the tool list names it. */
	tool: string;
	errors: number;
	denied: number;
	total: number;
	/** Which result the row opens Recent Activity on: the larger of the two. */
	dominant: "error" | "denied";
	/** The most frequent message among the failing calls that were loaded, if any of them had one. */
	topMessage?: string;
	topMessageCount?: number;
	/** Timestamp (ms) of the latest failing call that was loaded. */
	lastSeen?: number;
}

/**
 * Tools with errors or denials, worst first. The counts come from the range analytics; the most common message and
 * the last-seen time come from the failing calls that were loaded (the latest ones), so a tool whose failures are all
 * older than those carries a count but no message.
 */
export function attentionRows(tools: AuditToolStats[], failing: AuditEvent[]): AttentionRow[] {
	const byTool = new Map<string, { messages: Map<string, number>; lastSeen: number }>();
	for (const event of failing) {
		const key = toolLabel(event);
		const entry = byTool.get(key) ?? { messages: new Map<string, number>(), lastSeen: 0 };
		const message = errorSummary(event);
		if (message) entry.messages.set(message, (entry.messages.get(message) ?? 0) + 1);
		const at = Date.parse(event.timestamp);
		if (Number.isFinite(at)) entry.lastSeen = Math.max(entry.lastSeen, at);
		byTool.set(key, entry);
	}

	const rows: AttentionRow[] = [];
	for (const tool of tools) {
		const errors = tool.byResult.error ?? 0;
		const denied = tool.byResult.denied ?? 0;
		if (errors + denied === 0) continue;
		const seen = byTool.get(tool.tool);
		let topMessage: string | undefined;
		let topMessageCount = 0;
		for (const [message, count] of seen?.messages ?? []) {
			if (count > topMessageCount) {
				topMessage = message;
				topMessageCount = count;
			}
		}
		rows.push({
			tool: tool.tool,
			errors,
			denied,
			total: tool.totalCalls,
			dominant: errors >= denied ? "error" : "denied",
			topMessage,
			topMessageCount: topMessage ? topMessageCount : undefined,
			lastSeen: seen?.lastSeen || undefined,
		});
	}
	return rows.sort((a, b) => b.errors + b.denied - (a.errors + a.denied) || a.tool.localeCompare(b.tool));
}
