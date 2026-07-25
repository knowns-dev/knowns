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
