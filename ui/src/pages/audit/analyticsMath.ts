import type { AuditDailyBucket } from "@/ui/api/client";

export type HeatmapActivityLevel = 0 | 1 | 2 | 3 | 4;

export interface CalendarWeek {
	startDate: string;
	days: Array<AuditDailyBucket | null>;
}

export interface MonthLabel {
	label: string;
	weekIndex: number;
}

export interface CalendarLayout {
	weeks: CalendarWeek[];
	monthLabels: MonthLabel[];
}

export interface ChartPoint {
	x: number;
	y: number;
	covered: boolean;
}

export function hasCoveredAuditDays(buckets: AuditDailyBucket[]): boolean {
	return buckets.some((bucket) => bucket.covered);
}

function parseCalendarDate(value: string): Date {
	const [year = 0, month = 1, day = 1] = value.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day));
}

function formatCalendarDate(value: Date): string {
	return value.toISOString().slice(0, 10);
}

function addCalendarDays(value: Date, amount: number): Date {
	const next = new Date(value);
	next.setUTCDate(next.getUTCDate() + amount);
	return next;
}

function quantile(sortedValues: number[], fraction: number): number {
	const index = Math.max(
		0,
		Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * fraction) - 1),
	);
	return sortedValues[index] ?? 0;
}

export function getActivityThresholds(
	buckets: AuditDailyBucket[],
): [number, number, number] {
	const values = buckets
		.filter((bucket) => bucket.covered && bucket.totalCalls > 0)
		.map((bucket) => bucket.totalCalls)
		.sort((left, right) => left - right);

	if (values.length === 0) return [0, 0, 0];

	return [
		quantile(values, 0.25),
		quantile(values, 0.5),
		quantile(values, 0.75),
	];
}

export function getActivityLevel(
	bucket: AuditDailyBucket,
	thresholds: [number, number, number],
): HeatmapActivityLevel {
	if (!bucket.covered || bucket.totalCalls === 0) return 0;

	let level: HeatmapActivityLevel = 1;
	if (bucket.totalCalls > thresholds[0]) level = 2;
	if (bucket.totalCalls > thresholds[1]) level = 3;
	if (bucket.totalCalls > thresholds[2]) level = 4;
	return level;
}

export function buildCalendarLayout(
	buckets: AuditDailyBucket[],
	locale = "en-US",
): CalendarLayout {
	if (buckets.length === 0) return { weeks: [], monthLabels: [] };

	const byDate = new Map(buckets.map((bucket) => [bucket.date, bucket]));
	const firstBucket = buckets[0];
	const lastBucket = buckets[buckets.length - 1];
	if (!firstBucket || !lastBucket) return { weeks: [], monthLabels: [] };
	const first = parseCalendarDate(firstBucket.date);
	const last = parseCalendarDate(lastBucket.date);
	const gridStart = addCalendarDays(first, -first.getUTCDay());
	const gridEnd = addCalendarDays(last, 6 - last.getUTCDay());
	const weeks: CalendarWeek[] = [];

	for (
		let cursor = gridStart;
		cursor.getTime() <= gridEnd.getTime();
		cursor = addCalendarDays(cursor, 7)
	) {
		const days = Array.from({ length: 7 }, (_, dayOffset) => {
			const date = formatCalendarDate(addCalendarDays(cursor, dayOffset));
			return byDate.get(date) ?? null;
		});
		weeks.push({ startDate: formatCalendarDate(cursor), days });
	}

	const monthLabels: MonthLabel[] = [];
	let previousLabel = "";
	for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
		const week = weeks[weekIndex];
		if (!week) continue;
		const representative =
			week.days.find((day) => day !== null)?.date ?? week.startDate;
		const label = new Intl.DateTimeFormat(locale, {
			month: "short",
			timeZone: "UTC",
		}).format(parseCalendarDate(representative));
		if (label !== previousLabel) {
			monthLabels.push({ label, weekIndex });
			previousLabel = label;
		}
	}

	return { weeks, monthLabels };
}

export function createChartPoints(
	buckets: AuditDailyBucket[],
	value: (bucket: AuditDailyBucket) => number,
	width: number,
	height: number,
	domainMax?: number,
): ChartPoint[] {
	const maxValue = Math.max(
		1,
		domainMax ?? Math.max(...buckets.filter((bucket) => bucket.covered).map(value)),
	);
	const lastIndex = Math.max(1, buckets.length - 1);

	return buckets.map((bucket, index) => ({
		x: (index / lastIndex) * width,
		y: height - (value(bucket) / maxValue) * height,
		covered: bucket.covered,
	}));
}

export function createSegmentedLinePath(points: ChartPoint[]): string {
	let path = "";
	let drawing = false;

	for (const point of points) {
		if (!point.covered) {
			drawing = false;
			continue;
		}
		path += `${drawing ? " L" : "M"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
		drawing = true;
	}

	return path.trim();
}
