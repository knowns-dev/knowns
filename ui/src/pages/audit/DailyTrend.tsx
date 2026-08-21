import type { AuditDailyBucket } from "@/ui/api/client";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/ui/components/ui/tooltip";
import { createChartPoints, createSegmentedLinePath } from "./analyticsMath";

const CHART_WIDTH = 720;
const CHART_HEIGHT = 164;
const CHART_PADDING_Y = 12;
const CHART_PADDING_X = 12;

function formatShortDate(date: string): string {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${date}T00:00:00Z`));
}

function formatTotalCalls(value: number): string {
	return `${value} total ${value === 1 ? "call" : "calls"}`;
}

function formatCalls(value: number): string {
	return `${value} ${value === 1 ? "call" : "calls"}`;
}

function describeTrendPoint(bucket: AuditDailyBucket): string {
	if (!bucket.covered) {
		return `${formatShortDate(bucket.date)}: history unavailable.`;
	}
	return `${formatShortDate(bucket.date)}: ${formatTotalCalls(bucket.totalCalls)}, ${formatCalls(bucket.needsAttention)} ${
		bucket.needsAttention === 1 ? "needs" : "need"
	} attention. Open Recent Activity for this day.`;
}

export function DailyTrend({
	buckets,
	onSelectDay,
}: {
	buckets: AuditDailyBucket[];
	onSelectDay: (date: string) => void;
}) {
	const maxTotal = Math.max(
		0,
		...buckets.filter((bucket) => bucket.covered).map((bucket) => bucket.totalCalls),
	);
	const totalPoints = createChartPoints(
		buckets,
		(bucket) => bucket.totalCalls,
		CHART_WIDTH - CHART_PADDING_X * 2,
		CHART_HEIGHT - CHART_PADDING_Y * 2,
		maxTotal,
	).map((point) => ({
		...point,
		x: point.x + CHART_PADDING_X,
		y: point.y + CHART_PADDING_Y,
	}));
	const attentionPoints = createChartPoints(
		buckets,
		(bucket) => bucket.needsAttention,
		CHART_WIDTH - CHART_PADDING_X * 2,
		CHART_HEIGHT - CHART_PADDING_Y * 2,
		maxTotal,
	).map((point) => ({
		...point,
		x: point.x + CHART_PADDING_X,
		y: point.y + CHART_PADDING_Y,
	}));
	const slotWidth =
		(CHART_WIDTH - CHART_PADDING_X * 2) / Math.max(1, buckets.length);
	const barWidth = Math.max(2, Math.min(28, slotWidth * 0.62));
	const labelIndexes = new Set([
		0,
		Math.floor((buckets.length - 1) / 2),
		Math.max(0, buckets.length - 1),
	]);

	return (
		<section
			aria-labelledby="audit-trend-heading"
			className="h-full min-w-0 rounded-xl border bg-card p-5 sm:p-6"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<h2 id="audit-trend-heading" className="text-sm font-semibold">
					Daily Trend
				</h2>
				<div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
					<span className="inline-flex items-center gap-1.5">
						<span
							className="h-2.5 w-2.5 rounded-sm bg-foreground/75"
							aria-hidden="true"
						/>
						Total calls
					</span>
					<span className="inline-flex items-center gap-1.5">
						<span
							className="w-4 border-t-2 border-dashed border-[#CF222E] dark:border-[#FF7B72]"
							aria-hidden="true"
						/>
						Needs attention
					</span>
				</div>
			</div>

			<div className="mt-4 overflow-x-auto pb-1">
				<TooltipProvider delayDuration={120}>
					<div
						className="relative pb-5"
						style={{ minWidth: `${Math.max(576, buckets.length * 16)}px` }}
					>
						<svg
							viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
							role="img"
							aria-labelledby="audit-trend-title audit-trend-description"
							className="block h-44 w-full overflow-visible"
							preserveAspectRatio="none"
						>
							<title id="audit-trend-title">Daily MCP audit trend</title>
							<desc id="audit-trend-description">
								Total calls as vertical bars and errors plus denials as a dashed
								line. Focus a point to inspect a day.
							</desc>
							{[0, 0.5, 1].map((fraction) => (
								<line
									key={fraction}
									x1="0"
									x2={CHART_WIDTH}
									y1={CHART_PADDING_Y + fraction * (CHART_HEIGHT - CHART_PADDING_Y * 2)}
									y2={CHART_PADDING_Y + fraction * (CHART_HEIGHT - CHART_PADDING_Y * 2)}
									className="stroke-border"
									strokeDasharray="3 5"
									vectorEffect="non-scaling-stroke"
								/>
							))}
							{buckets.map((bucket, index) => {
								const point = totalPoints[index];
								if (!bucket.covered || !point) return null;
								const height = Math.max(
									bucket.totalCalls > 0 ? 1.5 : 0.75,
									CHART_HEIGHT - CHART_PADDING_Y - point.y,
								);
								return (
									<rect
										key={bucket.date}
										x={point.x - barWidth / 2}
										y={CHART_HEIGHT - CHART_PADDING_Y - height}
										width={barWidth}
										height={height}
										rx={Math.min(2, barWidth / 4)}
										className="fill-foreground/75 dark:fill-foreground/70"
									/>
								);
							})}
							<path
								d={createSegmentedLinePath(attentionPoints)}
								fill="none"
								strokeWidth="2"
								strokeDasharray="6 4"
								strokeLinecap="round"
								strokeLinejoin="round"
								vectorEffect="non-scaling-stroke"
								className="stroke-[#CF222E] dark:stroke-[#FF7B72]"
							/>
						</svg>

						{buckets.map((bucket, index) => {
							const totalPoint = totalPoints[index];
							if (!totalPoint) return null;
							const left = `${(totalPoint.x / CHART_WIDTH) * 100}%`;
							const top = bucket.covered
								? `${(totalPoint.y / CHART_HEIGHT) * 100}%`
								: "88%";
							return (
								<Tooltip key={bucket.date}>
									<TooltipTrigger asChild>
										<button
											type="button"
											onClick={() => onSelectDay(bucket.date)}
											aria-label={describeTrendPoint(bucket)}
											className="absolute z-10 grid h-4 w-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
											style={{ left, top }}
										>
											<span
												aria-hidden="true"
												className={
													bucket.covered
														? "h-2.5 w-2.5 rounded-full border-2 border-card bg-foreground/80 shadow-sm"
														: "h-2.5 w-2.5 rounded-full border border-dashed border-muted-foreground bg-card"
												}
											/>
										</button>
									</TooltipTrigger>
									<TooltipContent side="top" className="p-3">
										<p className="font-semibold">{formatShortDate(bucket.date)}</p>
										{bucket.covered ? (
											<dl className="mt-1 grid gap-0.5 tabular-nums">
												<div className="flex min-w-44 justify-between gap-4">
													<dt className="text-primary-foreground/70">
														Total calls
													</dt>
													<dd>{bucket.totalCalls}</dd>
												</div>
												<div className="flex min-w-44 justify-between gap-4">
													<dt className="text-primary-foreground/70">
														Needs attention
													</dt>
													<dd>{bucket.needsAttention}</dd>
												</div>
											</dl>
										) : (
											<p className="mt-1 text-primary-foreground/70">
												History unavailable
											</p>
										)}
									</TooltipContent>
								</Tooltip>
							);
						})}
						<div className="absolute inset-x-0 bottom-0 flex items-center justify-between text-[10px] text-muted-foreground">
							{buckets.map((bucket, index) =>
								labelIndexes.has(index) ? (
									<span key={bucket.date}>{formatShortDate(bucket.date)}</span>
								) : null,
							)}
						</div>
					</div>
				</TooltipProvider>
			</div>
			<p className="sr-only">Highest daily total: {maxTotal} calls.</p>
		</section>
	);
}
