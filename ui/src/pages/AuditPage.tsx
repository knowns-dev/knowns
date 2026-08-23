import { type KeyboardEvent, useCallback, useEffect, useId, useState } from "react";
import {
	auditApi,
	type AuditAnalytics,
	type AuditEvent,
	type AuditRangeDays,
	type AuditStats,
} from "@/ui/api/client";
import {
	Activity,
	AlertCircle,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Clock,
	Filter,
	FolderOpen,
	RefreshCw,
	ShieldAlert,
	BarChart3,
	X,
} from "lucide-react";
import { cn } from "@/ui/lib/utils";
import { Button } from "@/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/components/ui/card";
import { ScrollArea } from "@/ui/components/ui/ScrollArea";
import { FeatureHeader } from "@/ui/components/templates";
import {
	PageContent,
	PageError,
	PageLoading,
	PageShell,
} from "@/ui/components/templates/PageShell";
import { ActivityHeatmap } from "./audit/ActivityHeatmap";
import { DailyTrend } from "./audit/DailyTrend";
import { TopTools } from "./audit/TopTools";
import { hasCoveredAuditDays } from "./audit/analyticsMath";

type Tab = "recent" | "stats";

const RANGE_OPTIONS: AuditRangeDays[] = [7, 30, 90];

function browserTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatRangeDay(date: string): string {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${date}T00:00:00Z`));
}

const resultColors: Record<string, { bg: string; text: string; icon: typeof CheckCircle2 }> = {
	success: {
		bg: "bg-emerald-500/10",
		text: "text-emerald-600 dark:text-emerald-400",
		icon: CheckCircle2,
	},
	error: {
		bg: "bg-red-500/10",
		text: "text-red-600 dark:text-red-400",
		icon: AlertCircle,
	},
	denied: {
		bg: "bg-yellow-500/10",
		text: "text-yellow-600 dark:text-yellow-400",
		icon: ShieldAlert,
	},
};

const classColors: Record<string, string> = {
	read: "text-blue-600 dark:text-blue-400",
	write: "text-orange-600 dark:text-orange-400",
	delete: "text-red-600 dark:text-red-400",
	generate: "text-purple-600 dark:text-purple-400",
	admin: "text-gray-600 dark:text-gray-400",
};

export default function AuditPage() {
	const [tab, setTab] = useState<Tab>("recent");
	const [events, setEvents] = useState<AuditEvent[]>([]);
	const [stats, setStats] = useState<AuditStats | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [toolFilter, setToolFilter] = useState("");
	const [resultFilter, setResultFilter] = useState("");
	const [dayFilter, setDayFilter] = useState("");
	const [range, setRange] = useState<AuditRangeDays>(30);
	const [analytics, setAnalytics] = useState<AuditAnalytics | null>(null);
	const [analyticsLoading, setAnalyticsLoading] = useState(true);
	const [analyticsError, setAnalyticsError] = useState<string | null>(null);

	const fetchRecent = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const opts: Parameters<typeof auditApi.recent>[0] = { limit: 100 };
			if (toolFilter) opts.tool = toolFilter;
			if (resultFilter) opts.result = resultFilter;
			if (dayFilter) {
				opts.from = dayFilter;
				opts.to = dayFilter;
				opts.timezone = browserTimezone();
			}
			const data = await auditApi.recent(opts);
			setEvents(data.events || []);
		} catch (caught) {
			setEvents([]);
			setError(
				caught instanceof Error
					? caught.message
					: "The audit events could not be loaded.",
			);
		} finally {
			setLoading(false);
		}
	}, [toolFilter, resultFilter, dayFilter]);

	const fetchStats = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await auditApi.stats();
			setStats(data);
		} catch (caught) {
			setStats(null);
			setError(
				caught instanceof Error
					? caught.message
					: "The audit statistics could not be loaded.",
			);
		} finally {
			setLoading(false);
		}
	}, []);

	const fetchAnalytics = useCallback(async () => {
		setAnalyticsLoading(true);
		setAnalyticsError(null);
		try {
			const data = await auditApi.analytics({
				days: range,
				timezone: browserTimezone(),
				scope: "all",
			});
			setAnalytics(data);
		} catch (caught) {
			setAnalytics(null);
			setAnalyticsError(
				caught instanceof Error
					? caught.message
					: "The audit analytics could not be loaded.",
			);
		} finally {
			setAnalyticsLoading(false);
		}
	}, [range]);

	useEffect(() => {
		if (tab === "recent") {
			fetchRecent();
			return;
		}
		fetchStats();
		fetchAnalytics();
	}, [tab, fetchRecent, fetchStats, fetchAnalytics]);

	// Clicking a day or a tool in the charts drills into the event list.
	const handleSelectDay = (date: string) => {
		setDayFilter(date);
		setTab("recent");
	};
	const handleSelectTool = (tool: string) => {
		setToolFilter(tool.split(".")[0] ?? tool);
		setTab("recent");
	};

	const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		let nextTab: Tab | null = null;
		if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			nextTab = tab === "recent" ? "stats" : "recent";
		} else if (event.key === "Home") {
			nextTab = "recent";
		} else if (event.key === "End") {
			nextTab = "stats";
		}

		if (!nextTab) return;
		event.preventDefault();
		setTab(nextTab);
		document.getElementById(`audit-tab-${nextTab}`)?.focus();
	};

	return (
		<PageShell>
			<FeatureHeader
				icon={Activity}
				title="MCP Audit Trail"
				status={
					tab === "recent"
						? `${events.length} events`
						: `${stats?.totalCalls ?? 0} calls`
				}
				actions={
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => (tab === "recent" ? fetchRecent() : fetchStats())}
						disabled={loading}
						aria-label="Refresh audit data"
						aria-busy={loading}
						className="h-11 sm:h-8"
					>
						<RefreshCw className={cn("w-4 h-4", loading && "animate-spin motion-reduce:animate-none")} />
						{loading ? "Refreshing" : "Refresh"}
					</Button>
				}
			/>

			<PageContent size="full" className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden">
				<AuditStatusSummary
					tab={tab}
					events={events}
					stats={stats}
					loading={loading}
					hasError={Boolean(error)}
				/>

				<div
					role="tablist"
					aria-label="Audit views"
					className="flex gap-1 border-b"
				>
					<button
						type="button"
						id="audit-tab-recent"
						role="tab"
						aria-selected={tab === "recent"}
						aria-controls="audit-panel-recent"
						tabIndex={tab === "recent" ? 0 : -1}
						onClick={() => setTab("recent")}
						onKeyDown={handleTabKeyDown}
						className={cn(
							"min-h-11 px-4 py-2 text-sm font-medium border-b-2 transition-colors",
							tab === "recent"
								? "border-primary text-primary"
								: "border-transparent text-muted-foreground hover:text-foreground",
						)}
					>
						<span className="flex items-center gap-1.5">
							<Clock className="w-4 h-4" />
							Recent Activity
						</span>
					</button>
					<button
						type="button"
						id="audit-tab-stats"
						role="tab"
						aria-selected={tab === "stats"}
						aria-controls="audit-panel-stats"
						tabIndex={tab === "stats" ? 0 : -1}
						onClick={() => setTab("stats")}
						onKeyDown={handleTabKeyDown}
						className={cn(
							"min-h-11 px-4 py-2 text-sm font-medium border-b-2 transition-colors",
							tab === "stats"
								? "border-primary text-primary"
								: "border-transparent text-muted-foreground hover:text-foreground",
						)}
					>
						<span className="flex items-center gap-1.5">
							<BarChart3 className="w-4 h-4" />
							Statistics
						</span>
					</button>
				</div>

				{tab === "recent" ? (
					<div
						id="audit-panel-recent"
						role="tabpanel"
						aria-labelledby="audit-tab-recent"
						aria-busy={loading}
						className="flex min-h-0 min-w-0 flex-1"
					>
						<RecentTab
							events={events}
							loading={loading}
							error={error}
							toolFilter={toolFilter}
							resultFilter={resultFilter}
							dayFilter={dayFilter}
							onToolFilter={setToolFilter}
							onResultFilter={setResultFilter}
							onClearDay={() => setDayFilter("")}
							onRetry={fetchRecent}
						/>
					</div>
				) : (
					<div
						id="audit-panel-stats"
						role="tabpanel"
						aria-labelledby="audit-tab-stats"
						aria-busy={loading}
						className="flex min-h-0 min-w-0 flex-1"
					>
						<StatsTab
							stats={stats}
							loading={loading}
							error={error}
							onRetry={fetchStats}
							analytics={analytics}
							analyticsLoading={analyticsLoading}
							analyticsError={analyticsError}
							range={range}
							onRangeChange={setRange}
							onRetryAnalytics={fetchAnalytics}
							onSelectDay={handleSelectDay}
							onSelectTool={handleSelectTool}
						/>
					</div>
				)}
			</PageContent>
		</PageShell>
	);
}

function AuditStatusSummary({
	tab,
	events,
	stats,
	loading,
	hasError,
}: {
	tab: Tab;
	events: AuditEvent[];
	stats: AuditStats | null;
	loading: boolean;
	hasError: boolean;
}) {
	const source = tab === "recent" ? events : null;
	const total = source ? source.length : stats?.totalCalls;
	const successful = source
		? source.filter((event) => event.result === "success").length
		: stats?.byResult.success;
	const needsAttention = source
		? source.filter((event) => event.result === "error" || event.result === "denied")
				.length
		: (stats?.byResult.error || 0) + (stats?.byResult.denied || 0);
	const unavailable = loading || hasError;

	const metrics = [
		{
			label: tab === "recent" ? "Events loaded" : "Calls recorded",
			value: unavailable ? "—" : (total ?? 0),
		},
		{
			label: "Successful",
			value: unavailable ? "—" : (successful ?? 0),
		},
		{
			label: "Errors / denied",
			value: unavailable ? "—" : needsAttention,
		},
	];

	return (
		<section
			aria-label="Audit status summary"
			className="grid grid-cols-3 overflow-hidden rounded-lg border bg-card"
		>
			{metrics.map((metric, index) => (
				<dl
					key={metric.label}
					className={cn(
						"px-4 py-3",
						index > 0 && "border-l",
					)}
				>
					<dt className="text-xs font-medium text-muted-foreground">
						{metric.label}
					</dt>
					<dd className="mt-1 text-xl font-semibold tabular-nums">
						{metric.value}
					</dd>
				</dl>
			))}
		</section>
	);
}

function RecentTab({
	events,
	loading,
	error,
	toolFilter,
	resultFilter,
	dayFilter,
	onToolFilter,
	onResultFilter,
	onClearDay,
	onRetry,
}: {
	events: AuditEvent[];
	loading: boolean;
	error: string | null;
	toolFilter: string;
	resultFilter: string;
	dayFilter: string;
	onToolFilter: (v: string) => void;
	onResultFilter: (v: string) => void;
	onClearDay: () => void;
	onRetry: () => void;
}) {
	// Extract unique tool names for filter.
	const tools = [...new Set(events.map((event) => event.toolName))].sort();

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<Filter className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
				<select
					aria-label="Filter by tool"
					value={toolFilter}
					onChange={(event) => onToolFilter(event.target.value)}
					className="min-h-11 rounded-md border bg-background px-3 py-1 text-sm sm:min-h-9"
				>
					<option value="">All tools</option>
					{tools.map((tool) => (
						<option key={tool} value={tool}>
							{tool}
						</option>
					))}
				</select>
				<select
					aria-label="Filter by result"
					value={resultFilter}
					onChange={(event) => onResultFilter(event.target.value)}
					className="min-h-11 rounded-md border bg-background px-3 py-1 text-sm sm:min-h-9"
				>
					<option value="">All results</option>
					<option value="success">Success</option>
					<option value="error">Error</option>
					<option value="denied">Denied</option>
				</select>
				{dayFilter && (
					<button
						type="button"
						onClick={onClearDay}
						className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 text-xs font-medium transition-colors hover:bg-muted"
						aria-label={`Clear the ${formatRangeDay(dayFilter)} filter`}
					>
						{formatRangeDay(dayFilter)}
						<X className="h-3.5 w-3.5" aria-hidden="true" />
					</button>
				)}
				<span className="w-full text-right text-muted-foreground sm:ml-auto sm:w-auto">
					{events.length} events loaded
				</span>
			</div>

			{loading ? (
				<PageLoading label="Loading audit events" className="flex-1" />
			) : error ? (
				<PageError
					title="Audit activity unavailable"
					description={error}
					onRetry={onRetry}
					className="flex-1"
				/>
			) : events.length === 0 ? (
				<div className="flex flex-1 items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
					No audit events found.
				</div>
			) : (
				<ScrollArea className="flex-1 rounded-lg border bg-card">
					<div className="divide-y divide-border/40">
						{events.map((event, index) => (
							<EventRow
								key={`${event.timestamp}-${event.toolName}-${event.action || ""}-${index}`}
								event={event}
							/>
						))}
					</div>
				</ScrollArea>
			)}
		</div>
	);
}

function EventRow({ event }: { event: AuditEvent }) {
	const [expanded, setExpanded] = useState(false);
	const detailsId = useId();
	const rc = resultColors[event.result] ?? {
		bg: "bg-gray-500/10",
		text: "text-gray-600 dark:text-gray-400",
		icon: CheckCircle2,
	};
	const ResultIcon = rc.icon;
	const ts = new Date(event.timestamp);
	const timeStr = ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	const dateStr = ts.toLocaleDateString([], { month: "short", day: "numeric" });

	const toolDisplay = event.action ? `${event.toolName}.${event.action}` : event.toolName;

	const hasDetails =
		(event.argumentSummary && Object.keys(event.argumentSummary).length > 0) ||
		event.projectRoot;
	const toggleExpanded = () => {
		if (hasDetails) setExpanded((current) => !current);
	};

	return (
		<div
			className={cn(
				"hover:bg-muted/50 transition-colors group",
				expanded && "bg-muted/30",
			)}
		>
			<div
				role={hasDetails ? "button" : undefined}
				tabIndex={hasDetails ? 0 : undefined}
				aria-expanded={hasDetails ? expanded : undefined}
				aria-controls={hasDetails ? detailsId : undefined}
				className={cn(
					"flex items-center gap-2.5 px-3 py-1.5",
					hasDetails && "cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				)}
				onClick={toggleExpanded}
				onKeyDown={(keyboardEvent) => {
					if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
					keyboardEvent.preventDefault();
					toggleExpanded();
				}}
			>
				{/* Expand indicator */}
				<div className="w-3.5 flex-shrink-0">
					{hasDetails ? (
						expanded ? (
							<ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
						) : (
							<ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
						)
					) : null}
				</div>

				<div className={cn("shrink-0 rounded p-0.5", rc.bg)}>
					<ResultIcon className={cn("w-3.5 h-3.5", rc.text)} />
				</div>
				<div className="flex-1 min-w-0">
					<div className="flex min-w-0 items-center gap-2">
						<span className="max-w-full truncate font-mono text-sm font-medium">{toolDisplay}</span>
						<span className={cn("text-xs font-medium", rc.text)}>
							{event.result}
						</span>
						<span className={cn("text-xs", classColors[event.actionClass] || "text-muted-foreground")}>
							{event.actionClass}
						</span>
						{event.dryRun && (
							<span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
								dry-run
							</span>
						)}
						{event.errorMessage ? (
							<span className="min-w-0 truncate text-xs text-red-500" title={event.errorMessage}>
								{event.errorMessage}
							</span>
						) : event.entityRefs && event.entityRefs.length > 0 ? (
							<span
								className="min-w-0 truncate text-xs text-muted-foreground"
								title={event.entityRefs.join(", ")}
							>
								{event.entityRefs.join(", ")}
							</span>
						) : null}
						<span className="ml-auto hidden shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground sm:inline">
							{event.durationMs}ms
						</span>
					</div>
					<p className="text-[11px] text-muted-foreground sm:hidden">
						{dateStr} · {timeStr} · {event.durationMs}ms
					</p>
				</div>
				<div className="hidden shrink-0 whitespace-nowrap text-right font-mono text-[11px] tabular-nums text-muted-foreground sm:block">
					{dateStr} · {timeStr}
				</div>
			</div>

			{/* Expanded details */}
			{expanded && hasDetails && (
				<div id={detailsId} className="ml-9 space-y-2 border-t border-border/50 px-3 pb-3 pt-2">
					{event.projectRoot && (
						<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
							<FolderOpen className="w-3 h-3 flex-shrink-0" />
							<span className="font-medium">Project:</span>
							<span className="font-mono truncate">{event.projectRoot}</span>
						</div>
					)}
					{event.argumentSummary && Object.keys(event.argumentSummary).length > 0 && (
						<div>
							<p className="text-xs font-medium text-muted-foreground mb-1">Arguments</p>
							<div className="rounded-md bg-muted/50 border border-border/50 overflow-hidden">
								<table className="w-full text-xs">
									<tbody>
										{Object.entries(event.argumentSummary).map(([key, value]) => (
											<tr key={key} className="border-b border-border/30 last:border-b-0">
												<td className="px-2 py-1 font-mono font-medium text-muted-foreground whitespace-nowrap align-top">
													{key}
												</td>
												<td className="px-2 py-1 font-mono break-all">
													{value}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function StatsTab({
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
}) {
	if (loading) {
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
			<div className="flex flex-1 items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
				No audit data available.
			</div>
		);
	}

	const classEntries = Object.entries(stats.byActionClass).sort((a, b) => b[1] - a[1]);
	const buckets = analytics?.dailyBuckets ?? [];
	const hasHistory = hasCoveredAuditDays(buckets);

	return (
		<ScrollArea className="flex-1">
			<div className="flex min-w-0 flex-col gap-4 pr-1">
				{/* Range selector + headline aggregates for the selected window */}
				<section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
					<div className="flex min-w-0 flex-col">
						<h3 className="text-sm font-semibold">Activity over time</h3>
						<p className="mt-0.5 text-xs text-muted-foreground">
							{analytics
								? `${formatRangeDay(analytics.rangeStart)} – ${formatRangeDay(analytics.rangeEnd)} · ${analytics.timezone}`
								: "Loading range…"}
						</p>
					</div>
					<div
						className="flex shrink-0 gap-1"
						role="group"
						aria-label="Analytics range"
					>
						{RANGE_OPTIONS.map((option) => (
							<button
								key={option}
								type="button"
								aria-pressed={range === option}
								onClick={() => onRangeChange(option)}
								className={cn(
									"inline-flex h-8 items-center rounded-md px-2.5 text-xs font-medium transition-colors",
									range === option
										? "bg-foreground text-background"
										: "text-muted-foreground hover:bg-muted hover:text-foreground",
								)}
							>
								{option}d
							</button>
						))}
					</div>
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
							<p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-300">
								{hasHistory
									? `Retained history only covers ${formatRangeDay(analytics.coverage.startDate ?? analytics.rangeStart)} – ${formatRangeDay(analytics.coverage.endDate ?? analytics.rangeEnd)}. Days outside that window are shown as uncovered rather than empty.`
									: "No retained audit history overlaps this range. Older events were rotated out of the log."}
							</p>
						)}

						{hasHistory && (
							<>
								<div className="grid min-w-0 gap-4 xl:grid-cols-2">
									<ActivityHeatmap buckets={buckets} onSelectDay={onSelectDay} />
									<DailyTrend buckets={buckets} onSelectDay={onSelectDay} />
								</div>
								<TopTools tools={analytics.tools} onSelectTool={onSelectTool} />
							</>
						)}
					</>
				) : null}

				{/* All-time breakdowns (not range-scoped) */}
				<section className="rounded-lg border bg-card px-4 py-3">
					<h3 className="text-sm font-semibold">All-time totals</h3>
					<div className="mt-3 flex flex-wrap gap-2">
						{Object.entries(stats.byResult).map(([result, count]) => {
							const rc = resultColors[result] ?? {
								bg: "bg-gray-500/10",
								text: "text-gray-600 dark:text-gray-400",
								icon: CheckCircle2,
							};
							return (
								<div key={result} className={cn("rounded-md px-3 py-1.5", rc.bg)}>
									<span className={cn("text-sm font-medium", rc.text)}>
										{result}: {count}
									</span>
								</div>
							);
						})}
						{classEntries.map(([cls, count]) => (
							<div key={cls} className="rounded-md bg-muted px-3 py-1.5">
								<span className={cn("text-sm", classColors[cls] || "text-foreground")}>
									{cls}
								</span>
								<span className="ml-1.5 text-sm text-muted-foreground">{count}</span>
							</div>
						))}
						<div className="rounded-md bg-muted px-3 py-1.5 text-sm">
							dry-run
							<span className="ml-1.5 text-muted-foreground">{stats.dryRunCount}</span>
						</div>
					</div>
				</section>
			</div>
		</ScrollArea>
	);
}

function AnalyticsSummary({ analytics }: { analytics: AuditAnalytics }) {
	const successRate =
		analytics.totalCalls > 0
			? Math.round(((analytics.byResult.success || 0) / analytics.totalCalls) * 100)
			: 0;
	const latency =
		analytics.averageDurationMs >= 1000
			? `${(analytics.averageDurationMs / 1000).toFixed(2)} s`
			: `${Math.round(analytics.averageDurationMs)} ms`;

	const metrics = [
		{ label: "Calls in range", value: analytics.totalCalls },
		{ label: "Success rate", value: `${successRate}%` },
		{ label: "Needs attention", value: analytics.needsAttention },
		{ label: "Avg latency", value: latency },
	];

	return (
		<section
			aria-label="Range summary"
			className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4"
		>
			{metrics.map((metric) => (
				<dl key={metric.label} className="bg-card px-4 py-3">
					<dt className="text-xs font-medium text-muted-foreground">{metric.label}</dt>
					<dd className="mt-1 text-xl font-semibold tabular-nums">{metric.value}</dd>
				</dl>
			))}
		</section>
	);
}
