import type { AuditDailyBucket } from "@/ui/api/client";
import { cn } from "@/ui/lib/utils";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/ui/components/ui/tooltip";
import {
	buildCalendarLayout,
	getActivityLevel,
	getActivityThresholds,
	type HeatmapActivityLevel,
} from "./analyticsMath";

const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];

const ACTIVITY_CLASSES: Record<HeatmapActivityLevel, string> = {
	0: "border-foreground/25 bg-transparent",
	1: "border-foreground/20 bg-foreground/20",
	2: "border-foreground/35 bg-foreground/35",
	3: "border-foreground/55 bg-foreground/55",
	4: "border-foreground/75 bg-foreground/85",
};

function formatDay(date: string): string {
	return new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${date}T00:00:00Z`));
}

function formatLatency(value: number): string {
	if (!Number.isFinite(value)) return "0 ms";
	return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

function formatCount(value: number, singular: string, plural = `${singular}s`): string {
	return `${value} ${value === 1 ? singular : plural}`;
}

function describeDay(bucket: AuditDailyBucket): string {
	const attention =
		bucket.needsAttention > 0
			? `, ${formatCount(bucket.needsAttention, "call")} ${
					bucket.needsAttention === 1 ? "needs" : "need"
				} attention`
			: "";
	const details = bucket.covered
		? `, top tool ${bucket.topTool || "none"}, average latency ${formatLatency(
				bucket.averageDurationMs,
			)}`
		: "";
	const coverage = bucket.covered
		? `${formatCount(bucket.totalCalls, "call")}, ${bucket.successCount} successful, ${formatCount(bucket.errorCount, "error")}, ${bucket.deniedCount} denied${attention}${details}`
		: "history unavailable";
	return `${formatDay(bucket.date)}: ${coverage}. Open Recent Activity for this day.`;
}

function HeatmapTooltip({ bucket }: { bucket: AuditDailyBucket }) {
	return (
		<div className="grid min-w-52 gap-2 py-1">
			<div>
				<p className="font-semibold">{formatDay(bucket.date)}</p>
				<p className="text-primary-foreground/70">
					{bucket.covered ? "Retained audit history" : "History unavailable"}
				</p>
			</div>
			<dl className="grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums">
				<div className="flex justify-between gap-3">
					<dt className="text-primary-foreground/70">Total</dt>
					<dd>{bucket.covered ? bucket.totalCalls : "—"}</dd>
				</div>
				<div className="flex justify-between gap-3">
					<dt className="text-primary-foreground/70">Success</dt>
					<dd>{bucket.covered ? bucket.successCount : "—"}</dd>
				</div>
				<div className="flex justify-between gap-3">
					<dt className="text-primary-foreground/70">Errors</dt>
					<dd>{bucket.covered ? bucket.errorCount : "—"}</dd>
				</div>
				<div className="flex justify-between gap-3">
					<dt className="text-primary-foreground/70">Denied</dt>
					<dd>{bucket.covered ? bucket.deniedCount : "—"}</dd>
				</div>
			</dl>
			<div className="border-t border-primary-foreground/20 pt-2">
				<p>
					<span className="text-primary-foreground/70">Top tool: </span>
					<span className="font-mono">{bucket.topTool || "—"}</span>
				</p>
				<p>
					<span className="text-primary-foreground/70">Average latency: </span>
					{bucket.covered ? formatLatency(bucket.averageDurationMs) : "—"}
				</p>
			</div>
		</div>
	);
}

export function ActivityHeatmap({
	buckets,
	onSelectDay,
}: {
	buckets: AuditDailyBucket[];
	onSelectDay: (date: string) => void;
}) {
	const thresholds = getActivityThresholds(buckets);
	const { weeks, monthLabels } = buildCalendarLayout(buckets);
	const gridTemplateColumns = `2.25rem repeat(${weeks.length}, 1.75rem)`;

	return (
		<section
			aria-labelledby="audit-activity-heading"
			className="h-full rounded-xl border bg-card p-5 sm:p-6"
		>
			<div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
				<h2 id="audit-activity-heading" className="text-sm font-semibold">
					Activity
				</h2>
				<p className="text-xs text-muted-foreground">
					Select a day to inspect its events
				</p>
			</div>

			<div className="mt-5 overflow-x-auto pb-2">
				<TooltipProvider delayDuration={120}>
					<div
						className="grid w-max gap-1"
						style={{
							gridTemplateColumns,
							gridTemplateRows: "1rem repeat(7, 1.125rem)",
						}}
					>
						{monthLabels.map((month) => (
							<span
								key={`${month.label}-${month.weekIndex}`}
								className="self-end text-[10px] text-muted-foreground"
								style={{ gridColumn: month.weekIndex + 2, gridRow: 1 }}
							>
								{month.label}
							</span>
						))}
						{WEEKDAY_LABELS.map((label, dayIndex) => (
							<span
								key={`${label}-${dayIndex}`}
								className="self-center text-[9px] text-muted-foreground"
								style={{ gridColumn: 1, gridRow: dayIndex + 2 }}
							>
								{label}
							</span>
						))}
						{weeks.flatMap((week, weekIndex) =>
							week.days.map((bucket, dayIndex) =>
								bucket ? (
									<Tooltip key={bucket.date}>
										<TooltipTrigger asChild>
											<button
												type="button"
												aria-label={describeDay(bucket)}
												onClick={() => onSelectDay(bucket.date)}
												className={cn(
													"relative h-[1.125rem] w-[1.125rem] justify-self-center rounded-[3px] border transition-transform hover:z-10 hover:scale-125 focus-visible:z-10 focus-visible:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none",
													bucket.covered
														? ACTIVITY_CLASSES[
																getActivityLevel(bucket, thresholds)
															]
														: "border-dashed border-muted-foreground/40 bg-transparent",
												)}
												style={{
													gridColumn: weekIndex + 2,
													gridRow: dayIndex + 2,
												}}
											>
												{bucket.covered && bucket.totalCalls === 0 ? (
													<span
														aria-hidden="true"
														className="absolute inset-[3px] rounded-[2px] border border-foreground/30"
													/>
												) : null}
												{bucket.needsAttention > 0 ? (
													<span
														aria-hidden="true"
														className="absolute -right-1 -top-1 grid h-2.5 w-2.5 place-items-center rounded-full bg-[#9A6700] text-[7px] font-black leading-none text-white ring-1 ring-card"
													>
														!
													</span>
												) : null}
											</button>
										</TooltipTrigger>
										<TooltipContent side="top" className="p-3">
											<HeatmapTooltip bucket={bucket} />
										</TooltipContent>
									</Tooltip>
								) : (
									<span
										key={`${week.startDate}-${dayIndex}`}
										aria-hidden="true"
										style={{
											gridColumn: weekIndex + 2,
											gridRow: dayIndex + 2,
										}}
									/>
								),
							),
						)}
					</div>
				</TooltipProvider>
			</div>

			<div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-[11px] text-muted-foreground">
				<div className="flex items-center gap-2">
					<span
						aria-hidden="true"
						className="h-3 w-3 rounded-[3px] border border-dashed border-muted-foreground/40"
					/>
					Unavailable
					<span
						aria-hidden="true"
						className="relative h-3 w-3 rounded-[3px] border border-foreground/25"
					>
						<span className="absolute inset-[2px] rounded-[1px] border border-foreground/30" />
					</span>
					No calls
					<span
						aria-hidden="true"
						className="grid h-3 w-3 place-items-center rounded-full bg-[#9A6700] text-[8px] font-black text-white"
					>
						!
					</span>
					Needs attention
				</div>
				<div className="flex items-center gap-1" aria-label="Activity intensity scale">
					Less
					{([1, 2, 3, 4] as const).map((level) => (
						<span
							key={level}
							aria-hidden="true"
							className={cn(
								"h-3 w-3 rounded-[3px] border",
								ACTIVITY_CLASSES[level],
							)}
						/>
					))}
					More
				</div>
			</div>
		</section>
	);
}
