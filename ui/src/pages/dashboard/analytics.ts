import type { Task } from "@/ui/models/task";

const DAY_MS = 86_400_000;

export interface ThroughputBucket {
	label: string;
	rangeLabel: string;
	created: number;
	completed: number;
	start: Date;
	end: Date;
}

export interface LeadTimeStats {
	values: number[];
	p50: number;
	p90: number;
	max: number;
	sampleSize: number;
}

export interface AgingBucket {
	key: "fresh" | "watch" | "risk" | "critical";
	label: string;
	count: number;
}

export interface AgingRow {
	status: string;
	total: number;
	buckets: AgingBucket[];
}

export interface AttentionItem {
	task: Task;
	score: number;
	reason: string;
}

function startOfDay(value: Date): Date {
	return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, days: number): Date {
	const next = new Date(value);
	next.setDate(next.getDate() + days);
	return next;
}

function validDate(value: Date | string | undefined): Date | null {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function percentile(sortedValues: number[], percentileValue: number): number {
	if (sortedValues.length === 0) return 0;
	const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
	return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))] ?? 0;
}

export function getPeriodStart(periodDays: number, now = new Date()): Date {
	return addDays(startOfDay(now), -(periodDays - 1));
}

export function buildThroughput(
	tasks: Task[],
	periodDays: number,
	now = new Date(),
): ThroughputBucket[] {
	const bucketSize = periodDays <= 7 ? 1 : periodDays <= 30 ? 3 : 7;
	const periodStart = getPeriodStart(periodDays, now);
	const periodEnd = addDays(startOfDay(now), 1);
	const buckets: ThroughputBucket[] = [];

	for (let offset = 0; offset < periodDays; offset += bucketSize) {
		const start = addDays(periodStart, offset);
		const end = new Date(
			Math.min(addDays(start, bucketSize).getTime(), periodEnd.getTime()),
		);
		const rangeEnd = addDays(end, -1);
		const shortDate = new Intl.DateTimeFormat(undefined, {
			month: "short",
			day: "numeric",
		});
		const label = periodDays <= 7
			? new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(start)
			: shortDate.format(start);
		const rangeLabel = start.toDateString() === rangeEnd.toDateString()
			? shortDate.format(start)
			: `${shortDate.format(start)}–${shortDate.format(rangeEnd)}`;

		let created = 0;
		let completed = 0;
		for (const task of tasks) {
			const createdAt = validDate(task.createdAt);
			const completedAt = validDate(task.completedAt);
			if (createdAt && createdAt >= start && createdAt < end) created += 1;
			if (completedAt && completedAt >= start && completedAt < end) completed += 1;
		}

		buckets.push({ label, rangeLabel, created, completed, start, end });
	}

	return buckets;
}

export function getLeadTimeStats(
	tasks: Task[],
	periodDays: number,
	now = new Date(),
): LeadTimeStats | null {
	const periodStart = getPeriodStart(periodDays, now);
	const periodEnd = addDays(startOfDay(now), 1);
	const values = tasks
		.flatMap((task) => {
			const createdAt = validDate(task.createdAt);
			const completedAt = validDate(task.completedAt);
			if (
				!createdAt ||
				!completedAt ||
				completedAt < periodStart ||
				completedAt >= periodEnd ||
				completedAt < createdAt
			) {
				return [];
			}
			return [(completedAt.getTime() - createdAt.getTime()) / DAY_MS];
		})
		.sort((a, b) => a - b);

	if (values.length === 0) return null;
	return {
		values,
		p50: percentile(values, 50),
		p90: percentile(values, 90),
		max: Math.max(...values),
		sampleSize: values.length,
	};
}

export function buildWorkAging(
	tasks: Task[],
	statusOrder: string[],
	now = new Date(),
): AgingRow[] {
	const activeTasks = tasks.filter(
		(task) => task.lifecycleState !== "done" && !task.completedAt && !task.archived,
	);
	const actualStatuses = [...new Set(activeTasks.map((task) => task.status))];
	const orderedStatuses = [
		...statusOrder.filter((status) => actualStatuses.includes(status)),
		...actualStatuses.filter((status) => !statusOrder.includes(status)).sort(),
	];

	return orderedStatuses.map((status) => {
		const buckets: AgingBucket[] = [
			{ key: "fresh", label: "0–2d", count: 0 },
			{ key: "watch", label: "3–7d", count: 0 },
			{ key: "risk", label: "8–14d", count: 0 },
			{ key: "critical", label: "15d+", count: 0 },
		];
		const statusTasks = activeTasks.filter((task) => task.status === status);
		for (const task of statusTasks) {
			const updatedAt = validDate(task.updatedAt);
			const ageDays = updatedAt
				? Math.max(0, Math.floor((now.getTime() - updatedAt.getTime()) / DAY_MS))
				: Number.POSITIVE_INFINITY;
			const bucketIndex = ageDays <= 2 ? 0 : ageDays <= 7 ? 1 : ageDays <= 14 ? 2 : 3;
			buckets[bucketIndex]!.count += 1;
		}
		return { status, total: statusTasks.length, buckets };
	});
}

export function getAttentionItems(tasks: Task[], now = new Date()): AttentionItem[] {
	return tasks
		.flatMap((task) => {
			if (task.archived || task.lifecycleState === "done" || task.completedAt) return [];
			let score = 0;
			const reasons: string[] = [];
			const normalizedStatus = task.status.toLowerCase();
			const updatedAt = validDate(task.updatedAt);
			const ageDays = updatedAt
				? Math.max(0, Math.floor((now.getTime() - updatedAt.getTime()) / DAY_MS))
				: 0;

			if (normalizedStatus.includes("block")) {
				score += 100;
				reasons.push("blocked");
			}
			if (normalizedStatus.includes("urgent")) {
				score += 80;
				reasons.push("urgent");
			}
			if (normalizedStatus.includes("review")) {
				score += 25;
				reasons.push("awaiting review");
			}
			if (task.priority === "high") {
				score += 20;
				reasons.push("high priority");
			}
			if (ageDays >= 14) {
				score += 30;
				reasons.push(`${ageDays}d since update`);
			} else if (ageDays >= 7) {
				score += 15;
				reasons.push(`${ageDays}d since update`);
			}

			if (score === 0) return [];
			return [{ task, score, reason: reasons.slice(0, 2).join(" · ") }];
		})
		.sort((a, b) => b.score - a.score || b.task.updatedAt.getTime() - a.task.updatedAt.getTime())
		.slice(0, 5);
}

export function formatStatus(status: string): string {
	return status
		.split(/[-_]/g)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/* ------------------------------------------------------------------------------------------------
 * Analytics tab. Each helper answers one question and pairs with a takeaway sentence below, so a
 * chart never ships without the plain answer it is there to show.
 * ---------------------------------------------------------------------------------------------- */

const isOpenTask = (task: Task) => !task.archived && task.lifecycleState !== "done" && !task.completedAt;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function formatSpan(days: number): string {
	if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
	if (days < 10) return `${Math.round(days * 10) / 10}d`;
	return `${Math.round(days)}d`;
}

export interface FlowSummary {
	created: number;
	completed: number;
	/** Completions in the period of the same length just before this one. */
	previousCompleted: number;
	openNow: number;
	/** Open tasks at the start of the period. */
	openAtStart: number;
}

/** Tasks open at an instant: created before it and not finished before it. Archived tasks are left out. */
export function openAt(tasks: Task[], at: Date): number {
	let count = 0;
	for (const task of tasks) {
		if (task.archived) continue;
		const createdAt = validDate(task.createdAt);
		const completedAt = validDate(task.completedAt);
		if (!createdAt || createdAt >= at) continue;
		if (completedAt && completedAt < at) continue;
		if (!completedAt && task.lifecycleState === "done") continue;
		count += 1;
	}
	return count;
}

/** Open work at the end of each throughput bucket, so a sparkline can show whether the pile grows. */
export function buildOpenTrend(tasks: Task[], buckets: ThroughputBucket[]): number[] {
	return buckets.map((bucket) => openAt(tasks, bucket.end));
}

export function getFlowSummary(tasks: Task[], periodDays: number, now = new Date()): FlowSummary {
	const start = getPeriodStart(periodDays, now);
	const end = addDays(startOfDay(now), 1);
	const previousStart = addDays(start, -periodDays);
	let created = 0;
	let completed = 0;
	let previousCompleted = 0;
	for (const task of tasks) {
		const createdAt = validDate(task.createdAt);
		const completedAt = validDate(task.completedAt);
		if (createdAt && createdAt >= start && createdAt < end) created += 1;
		if (completedAt && completedAt >= start && completedAt < end) completed += 1;
		if (completedAt && completedAt >= previousStart && completedAt < start) previousCompleted += 1;
	}
	return { created, completed, previousCompleted, openNow: tasks.filter(isOpenTask).length, openAtStart: openAt(tasks, start) };
}

export function flowTakeaway(flow: FlowSummary, periodDays: number): string {
	if (flow.created + flow.completed === 0) {
		return `Nothing was added or finished in the last ${periodDays} days.`;
	}
	const net = flow.created - flow.completed;
	const head = `You finished ${flow.completed} and added ${flow.created} in the last ${periodDays} days`;
	const direction =
		net > 0
			? `, so open work grew by ${net}.`
			: net < 0
				? `, so open work shrank by ${-net}.`
				: ", so open work held steady.";
	const delta = flow.completed - flow.previousCompleted;
	const compare =
		flow.previousCompleted === 0 && flow.completed > 0
			? ""
			: delta > 0
				? ` That is ${delta} more finished than the ${periodDays} days before.`
				: delta < 0
					? ` That is ${-delta} fewer finished than the ${periodDays} days before.`
					: "";
	return head + direction + compare;
}

export interface LeadTimeBucket {
	label: string;
	count: number;
}

const LEAD_TIME_EDGES: { label: string; below: number }[] = [
	{ label: "< 1d", below: 1 },
	{ label: "1-3d", below: 3 },
	{ label: "3-7d", below: 7 },
	{ label: "1-4w", below: 28 },
	{ label: "4w+", below: Number.POSITIVE_INFINITY },
];

/** How many finished tasks took each span from created to completed. Every bucket is present, even at zero. */
export function buildLeadTimeHistogram(values: number[]): LeadTimeBucket[] {
	const buckets = LEAD_TIME_EDGES.map((edge) => ({ label: edge.label, count: 0 }));
	for (const value of values) {
		const index = LEAD_TIME_EDGES.findIndex((edge) => value < edge.below);
		buckets[index]!.count += 1;
	}
	return buckets;
}

export function leadTimeP85(stats: LeadTimeStats): number {
	return percentile(stats.values, 85);
}

/** Below this many finished tasks a percentile says more about one task than about the team. */
export const MIN_LEAD_TIME_SAMPLE = 5;

export function leadTimeTakeaway(stats: LeadTimeStats | null, periodDays: number): string {
	if (!stats) return `No task was finished in the last ${periodDays} days, so there is no time to measure yet.`;
	const fastest = stats.values[0] ?? 0;
	if (stats.sampleSize < MIN_LEAD_TIME_SAMPLE) {
		return stats.sampleSize === 1
			? `Only 1 task was finished in this range; it took ${formatSpan(fastest)}. Finish a few more to see a pattern.`
			: `Only ${stats.sampleSize} tasks were finished in this range, taking ${formatSpan(fastest)} to ${formatSpan(stats.max)}. Too few to see a pattern yet.`;
	}
	return `Half the work is finished within ${formatSpan(stats.p50)} of being created, and 85% within ${formatSpan(
		leadTimeP85(stats),
	)}. The slowest took ${formatSpan(stats.max)}.`;
}

/** Rows for a stacked bar per status: how long its open tasks have gone without an update. */
export function agingChartData(rows: AgingRow[]): Record<string, string | number>[] {
	return rows.map((row) => ({
		status: formatStatus(row.status),
		...Object.fromEntries(row.buckets.map((bucket) => [bucket.key, bucket.count])),
	}));
}

export function agingTakeaway(rows: AgingRow[]): string {
	const open = rows.reduce((sum, row) => sum + row.total, 0);
	if (open === 0) return "No open work, so nothing is stuck.";
	const staleOf = (row: AgingRow) =>
		row.buckets.filter((bucket) => bucket.key === "risk" || bucket.key === "critical").reduce((s, b) => s + b.count, 0);
	const stale = rows.reduce((sum, row) => sum + staleOf(row), 0);
	if (stale === 0) return `All ${plural(open, "open task")} moved in the last week. Nothing looks stuck.`;
	const worst = [...rows].sort((a, b) => staleOf(b) - staleOf(a) || b.total - a.total)[0]!;
	return `${stale} of ${plural(open, "open task")} have not moved for more than a week. ${formatStatus(worst.status)} holds the most: ${staleOf(worst)} of ${worst.total}.`;
}

export type StageKey = "todo" | "progress" | "review" | "blocked";

export function stageOf(status: string): StageKey {
	const s = status.toLowerCase();
	if (s.includes("block")) return "blocked";
	if (s.includes("review")) return "review";
	if (s.includes("progress")) return "progress";
	return "todo";
}

export interface LoadRow {
	who: string;
	todo: number;
	progress: number;
	review: number;
	blocked: number;
	total: number;
}

export const UNASSIGNED_LABEL = "Unassigned";

/** Open work per person, split by stage; the busiest first, the rest folded into "Others". */
export function buildLoadByAssignee(tasks: Task[], limit = 7): LoadRow[] {
	const byWho = new Map<string, LoadRow>();
	for (const task of tasks) {
		if (!isOpenTask(task)) continue;
		const who = task.assignee?.trim() || UNASSIGNED_LABEL;
		const row = byWho.get(who) ?? { who, todo: 0, progress: 0, review: 0, blocked: 0, total: 0 };
		row[stageOf(task.status)] += 1;
		row.total += 1;
		byWho.set(who, row);
	}
	const rows = [...byWho.values()].sort((a, b) => b.total - a.total || a.who.localeCompare(b.who));
	if (rows.length <= limit) return rows;
	const rest = rows.slice(limit - 1).reduce<LoadRow>(
		(sum, row) => ({
			who: "Others",
			todo: sum.todo + row.todo,
			progress: sum.progress + row.progress,
			review: sum.review + row.review,
			blocked: sum.blocked + row.blocked,
			total: sum.total + row.total,
		}),
		{ who: "Others", todo: 0, progress: 0, review: 0, blocked: 0, total: 0 },
	);
	return [...rows.slice(0, limit - 1), rest];
}

export function loadTakeaway(rows: LoadRow[]): string {
	const total = rows.reduce((sum, row) => sum + row.total, 0);
	if (total === 0) return "Nobody holds open work right now.";
	const people = rows.filter((row) => row.who !== UNASSIGNED_LABEL && row.who !== "Others");
	const unassigned = rows.find((row) => row.who === UNASSIGNED_LABEL)?.total ?? 0;
	const tail = unassigned > 0 ? ` ${plural(unassigned, "task")} ${unassigned === 1 ? "has" : "have"} no owner.` : "";
	if (people.length === 0) return `None of the ${plural(total, "open task")} has an owner yet.`;
	const top = people[0]!;
	if (people.length === 1 && unassigned === 0) return `${top.who} holds all ${plural(total, "open task")}.`;
	const share = Math.round((top.total / total) * 100);
	const inFlight = top.progress + top.review;
	return `${top.who} holds the most open work: ${top.total} of ${total} (${share}%), ${inFlight} of them in progress or review.${tail}`;
}

export interface LabelGrowthRow {
	label: string;
	added: number;
	finished: number;
	net: number;
}

export const NO_LABEL = "No label";

/** Per label: tasks added and finished in the period. The fastest-growing labels first. */
export function buildLabelGrowth(tasks: Task[], periodDays: number, now = new Date(), limit = 8): LabelGrowthRow[] {
	const start = getPeriodStart(periodDays, now);
	const end = addDays(startOfDay(now), 1);
	const rows = new Map<string, LabelGrowthRow>();
	for (const task of tasks) {
		const createdAt = validDate(task.createdAt);
		const completedAt = validDate(task.completedAt);
		const added = Boolean(createdAt && createdAt >= start && createdAt < end);
		const finished = Boolean(completedAt && completedAt >= start && completedAt < end);
		if (!added && !finished) continue;
		const labels = task.labels?.length ? task.labels : [NO_LABEL];
		for (const label of labels) {
			const row = rows.get(label) ?? { label, added: 0, finished: 0, net: 0 };
			if (added) row.added += 1;
			if (finished) row.finished += 1;
			row.net = row.added - row.finished;
			rows.set(label, row);
		}
	}
	return [...rows.values()]
		.sort((a, b) => b.net - a.net || b.added + b.finished - (a.added + a.finished) || a.label.localeCompare(b.label))
		.slice(0, limit);
}

export function labelTakeaway(rows: LabelGrowthRow[], periodDays: number): string {
	if (rows.length === 0) return `No labelled work was added or finished in the last ${periodDays} days.`;
	const top = rows[0]!;
	if (rows.every((row) => row.label === NO_LABEL)) {
		return "None of this work has a label yet. Label tasks to see which areas grow.";
	}
	if (top.net <= 0) {
		const busiest = [...rows].sort((a, b) => b.finished - a.finished)[0]!;
		return `No area grew: every label finished at least as much as it added. ${busiest.label} saw the most done (${busiest.finished}).`;
	}
	return `${top.label} grows fastest: ${top.added} added, ${top.finished} finished, so ${plural(top.net, "more task")} open than ${periodDays} days ago.`;
}

export interface KnowledgeInput {
	specLinked?: number;
	specTotal?: number;
	finishedWithSpec: number;
	finished: number;
	memoriesActive?: number;
	memoriesProposed?: number;
	decisionsAccepted?: number;
	decisionsWaiting?: number;
}

/** Finished tasks in the period and how many of them link to a spec. */
export function finishedWithSpec(tasks: Task[], periodDays: number, now = new Date()): { finished: number; withSpec: number } {
	const start = getPeriodStart(periodDays, now);
	const end = addDays(startOfDay(now), 1);
	let finished = 0;
	let withSpec = 0;
	for (const task of tasks) {
		const completedAt = validDate(task.completedAt);
		if (!completedAt || completedAt < start || completedAt >= end) continue;
		finished += 1;
		if (task.spec) withSpec += 1;
	}
	return { finished, withSpec };
}

export function knowledgeTakeaway(input: KnowledgeInput): string {
	const parts: string[] = [];
	const waiting = (input.memoriesProposed ?? 0) + (input.decisionsWaiting ?? 0);
	if (waiting > 0) {
		const pieces = [
			input.memoriesProposed ? plural(input.memoriesProposed, "memory", "memories") : null,
			input.decisionsWaiting ? plural(input.decisionsWaiting, "decision") : null,
		].filter(Boolean);
		parts.push(`${pieces.join(" and ")} ${waiting === 1 ? "waits" : "wait"} for your review.`);
	}
	if (input.finished > 0) {
		const pct = Math.round((input.finishedWithSpec / input.finished) * 100);
		parts.push(
			input.finishedWithSpec === 0
				? `None of the ${plural(input.finished, "task")} finished in this range links to a spec.`
				: `${input.finishedWithSpec} of ${plural(input.finished, "task")} finished in this range ${input.finishedWithSpec === 1 ? "links" : "link"} to a spec (${pct}%).`,
		);
	} else if (input.specTotal) {
		parts.push(`${input.specLinked ?? 0} of ${plural(input.specTotal, "task")} link to a spec.`);
	}
	if (parts.length === 0) return "Knowledge is up to date: nothing waits for review.";
	if (waiting === 0 && (input.memoriesActive !== undefined || input.decisionsAccepted !== undefined)) {
		parts.unshift("Nothing waits for review.");
	}
	return parts.join(" ");
}
