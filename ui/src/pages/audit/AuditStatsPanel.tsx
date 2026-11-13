import type { AuditAnalytics, AuditRangeDays, AuditStats } from "@/ui/api/client";
import { Badge } from "@/ui/components/ui/knowns/badge";
import { SegmentedControl } from "@/ui/components/ui/knowns/segmented-control";
import { PageError, PageLoading } from "@/ui/components/templates/PageShell";
import { Sparkline } from "@/ui/components/ui/knowns/chart/sparkline";
import { TopTools } from "./TopTools";
import { TrendChart } from "./TrendChart";
import { WhatNeedsAttention } from "./WhatNeedsAttention";
import { coveredWindow, hasCoveredAuditDays } from "./analyticsMath";
import { classMeta, formatDuration, formatRangeDay, resultMeta } from "./auditFormat";

const RANGE_OPTIONS: AuditRangeDays[] = [7, 30, 90];

export function AuditStatsPanel({
	stats,
	loading,
	error,
	onRetry,
	analytics,
	analyticsLoading,
	analyticsError,
	range,
	onRangeChange,
	onRetryAnalytics,
	onSelectDay,
	onSelectTool,
	onSelectAttention,
}: {
	stats: AuditStats | null;
	loading: boolean;
	error: string | null;
	onRetry: () => void;
	analytics: AuditAnalytics | null;
	analyticsLoading: boolean;
	analyticsError: string | null;
	range: AuditRangeDays;
	onRangeChange: (days: AuditRangeDays) => void;
	onRetryAnalytics: () => void;
	onSelectDay: (date: string) => void;
	onSelectTool: (tool: string) => void;
	onSelectAttention: (tool: string, result: "error" | "denied") => void;
}) {
	if (loading && !stats) {
		return <PageLoading label="Loading audit statistics" className="flex-1" />;
	}

	if (error) {
		return (
			<PageError
				title="Audit statistics unavailable"
				description={error}
				onRetry={onRetry}
				className="flex-1"
			/>
		);
	}

	if (!stats || stats.totalCalls === 0) {
		return (
			<div className="flex flex-1 items-center justify-center rounded-xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
				No audit data available.
			</div>
		);
	}

	const classEntries = Object.entries(stats.byActionClass).sort((a, b) => b[1] - a[1]);
	const resultEntries = Object.entries(stats.byResult).sort((a, b) => b[1] - a[1]);
	const buckets = analytics?.dailyBuckets ?? [];
	const hasHistory = hasCoveredAuditDays(buckets);

	return (
		<div className="sm:min-h-0 sm:flex-1 sm:overflow-y-auto sm:overscroll-contain">
			<div className="flex min-w-0 flex-col gap-4 pb-2">
				<section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
					<div className="flex min-w-0 flex-col">
						<h3 className="text-sm font-semibold">Activity over time</h3>
						<p className="mt-0.5 text-xs text-muted-foreground">
							{analytics
								? `${formatRangeDay(analytics.rangeStart)} to ${formatRangeDay(analytics.rangeEnd)}, ${analytics.timezone}`
								: "Loading range"}
						</p>
					</div>
					<SegmentedControl
						aria-label="Analytics range"
						size="sm"
						value={String(range)}
						onValueChange={(value) => onRangeChange(Number(value) as AuditRangeDays)}
						options={RANGE_OPTIONS.map((option) => ({ value: String(option), label: `${option}d` }))}
					/>
				</section>

				{analyticsError ? (
					<PageError
						title="Audit analytics unavailable"
						description={analyticsError}
						onRetry={onRetryAnalytics}
					/>
				) : analyticsLoading && !analytics ? (
					<PageLoading label="Loading audit analytics" />
				) : analytics ? (
					<>
						<AnalyticsSummary analytics={analytics} />

						{analytics.coverage.partial && (
							<p className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-300">
								{hasHistory
									? `Retained history only covers ${formatRangeDay(analytics.coverage.startDate ?? analytics.rangeStart)} to ${formatRangeDay(analytics.coverage.endDate ?? analytics.rangeEnd)}. Days outside that window are shown as uncovered rather than empty.`
									: "No retained audit history overlaps this range. Older events were rotated out of the log."}
							</p>
						)}

						{hasHistory && (
							<>
								<TrendChart buckets={buckets} onSelectDay={onSelectDay} />
								<WhatNeedsAttention analytics={analytics} onSelect={onSelectAttention} />
								<TopTools tools={analytics.tools} onSelectTool={onSelectTool} />
							</>
						)}
					</>
				) : null}

				<section className="rounded-xl border border-border bg-card px-4 py-3">
					<h3 className="text-sm font-semibold">All-time totals</h3>
					<div className="mt-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-6">
						<TotalsGroup label="Results">
							{resultEntries.map(([result, count]) => {
								const meta = resultMeta(result);
								return (
									<Badge key={result} tone={meta.tone} dot>
										{meta.label} <span className="tabular-nums">{count}</span>
									</Badge>
								);
							})}
						</TotalsGroup>
						<TotalsGroup label="Kinds">
							{classEntries.map(([actionClass, count]) => {
								const meta = classMeta(actionClass);
								return (
									<Badge key={actionClass} variant="outline" tone={meta.tone}>
										{meta.label} <span className="tabular-nums">{count}</span>
									</Badge>
								);
							})}
							<Badge variant="outline" tone="warning">
								Dry run <span className="tabular-nums">{stats.dryRunCount}</span>
							</Badge>
						</TotalsGroup>
					</div>
				</section>
			</div>
		</div>
	);
}

function TotalsGroup({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			<div className="flex flex-wrap gap-1.5">{children}</div>
		</div>
	);
}

function AnalyticsSummary({ analytics }: { analytics: AuditAnalytics }) {
	const successRate =
		analytics.totalCalls > 0
			? Math.round(((analytics.byResult.success || 0) / analytics.totalCalls) * 100)
			: 0;
	const days = coveredWindow(analytics.dailyBuckets).window;
	// A rate or an average on a day with no calls is undefined, not zero: draw one line through the days that had calls.
	// One such day repeats itself so the tile shows a flat line instead of the empty placeholder.
	const connected = (values: number[]) => (values.length === 1 ? [values[0] as number, values[0] as number] : values);

	const metrics = [
		{ label: "Calls in range", value: analytics.totalCalls, trend: days.map((d) => d.totalCalls), trendLabel: "Calls per day" },
		{
			label: "Success rate",
			value: `${successRate}%`,
			trend: connected(days.filter((d) => d.totalCalls > 0).map((d) => Math.round((d.successCount / d.totalCalls) * 100))),
			trendLabel: "Success rate per day",
		},
		{ label: "Needs attention", value: analytics.needsAttention, trend: days.map((d) => d.needsAttention), trendLabel: "Needs attention per day" },
		{
			label: "Avg latency",
			value: formatDuration(analytics.averageDurationMs),
			trend: connected(days.filter((d) => d.totalCalls > 0).map((d) => d.averageDurationMs)),
			trendLabel: "Average latency per day",
		},
	];

	return (
		<section
			aria-label="Range summary"
			className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4"
		>
			{metrics.map((metric) => (
				<dl key={metric.label} className="flex min-w-0 flex-col bg-card px-4 py-3">
					<dt className="text-xs font-medium text-muted-foreground">{metric.label}</dt>
					<dd className="mt-1 text-xl font-semibold tabular-nums">{metric.value}</dd>
					<Sparkline values={metric.trend} label={metric.trendLabel} fluid height={24} className="mt-2" color="var(--chart-1)" />
				</dl>
			))}
		</section>
	);
}
