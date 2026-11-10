import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Clock, RefreshCw } from "lucide-react";
import {
	auditApi,
	type AuditAnalytics,
	type AuditEvent,
	type AuditRangeDays,
	type AuditStats,
} from "@/ui/api/client";
import { Button as KnButton } from "@/ui/components/ui/knowns/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/components/ui/knowns/tabs";
import { FeatureHeader } from "@/ui/components/templates";
import {
	PageContent,
	PageError,
	PageLoading,
	PageShell,
} from "@/ui/components/templates/PageShell";
import { cn } from "@/ui/lib/utils";
import { AuditEventSheet } from "./audit/AuditEventDetail";
import { type AuditFilters, AuditEventList, AuditToolbar } from "./audit/AuditEventList";
import { AuditStatsPanel } from "./audit/AuditStatsPanel";
import { type AuditRow, browserTimezone, matchesQuery, toRows } from "./audit/auditFormat";

type Tab = "recent" | "stats";

/** Events per page. "Show older" asks for one more page. */
const PAGE_SIZE = 100;

const EMPTY_FILTERS: AuditFilters = { query: "", tool: "", result: "", actionClass: "", day: "" };

function errorText(caught: unknown, fallback: string): string {
	return caught instanceof Error ? caught.message : fallback;
}

export default function AuditPage() {
	const [tab, setTab] = useState<Tab>("recent");
	const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
	const [limit, setLimit] = useState(PAGE_SIZE);

	const [events, setEvents] = useState<AuditEvent[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [now, setNow] = useState(() => Date.now());

	const [stats, setStats] = useState<AuditStats | null>(null);
	const [statsLoading, setStatsLoading] = useState(true);
	const [statsError, setStatsError] = useState<string | null>(null);

	const [range, setRange] = useState<AuditRangeDays>(30);
	const [analytics, setAnalytics] = useState<AuditAnalytics | null>(null);
	const [analyticsLoading, setAnalyticsLoading] = useState(true);
	const [analyticsError, setAnalyticsError] = useState<string | null>(null);

	const [selectedKey, setSelectedKey] = useState<string | null>(null);

	// A paging request keeps the list on screen; any other fetch shows the loading state.
	const pagingRef = useRef(false);
	const { tool, result, day } = filters;

	const fetchRecent = useCallback(async () => {
		const paging = pagingRef.current;
		pagingRef.current = false;
		if (paging) setLoadingMore(true);
		else setLoading(true);
		setError(null);
		try {
			const opts: Parameters<typeof auditApi.recent>[0] = { limit };
			if (tool) opts.tool = tool;
			if (result) opts.result = result;
			if (day) {
				opts.from = day;
				opts.to = day;
				opts.timezone = browserTimezone();
			}
			const data = await auditApi.recent(opts);
			setEvents(data.events || []);
			setNow(Date.now());
		} catch (caught) {
			setEvents([]);
			setError(errorText(caught, "The audit events could not be loaded."));
		} finally {
			setLoading(false);
			setLoadingMore(false);
		}
	}, [tool, result, day, limit]);

	const fetchStats = useCallback(async () => {
		setStatsLoading(true);
		setStatsError(null);
		try {
			setStats(await auditApi.stats());
		} catch (caught) {
			setStats(null);
			setStatsError(errorText(caught, "The audit statistics could not be loaded."));
		} finally {
			setStatsLoading(false);
		}
	}, []);

	const fetchAnalytics = useCallback(async () => {
		setAnalyticsLoading(true);
		setAnalyticsError(null);
		try {
			setAnalytics(
				await auditApi.analytics({ days: range, timezone: browserTimezone(), scope: "all" }),
			);
		} catch (caught) {
			setAnalytics(null);
			setAnalyticsError(errorText(caught, "The audit analytics could not be loaded."));
		} finally {
			setAnalyticsLoading(false);
		}
	}, [range]);

	useEffect(() => {
		if (tab === "recent") fetchRecent();
	}, [tab, fetchRecent]);

	// Stats name the tools for the filter, so they load once up front; the charts load with their tab.
	useEffect(() => {
		fetchStats();
	}, [fetchStats]);

	useEffect(() => {
		if (tab === "stats") fetchAnalytics();
	}, [tab, fetchAnalytics]);

	const refresh = () => {
		if (tab === "recent") fetchRecent();
		else fetchAnalytics();
		fetchStats();
	};

	const updateFilters = (patch: Partial<AuditFilters>) => {
		setFilters((current) => ({ ...current, ...patch }));
		// A new server-side filter starts again from the first page.
		if ("tool" in patch || "result" in patch || "day" in patch) setLimit(PAGE_SIZE);
	};

	const loadOlder = () => {
		pagingRef.current = true;
		setLimit((current) => current + PAGE_SIZE);
	};

	// Clicking a day or a tool in the charts drills into the event list.
	const handleSelectDay = (date: string) => {
		updateFilters({ day: date });
		setTab("recent");
	};
	const handleSelectTool = (name: string) => {
		updateFilters({ tool: name.split(".")[0] ?? name });
		setTab("recent");
	};

	const allRows = useMemo(() => toRows(events), [events]);
	const rows = useMemo(
		() =>
			allRows.filter(
				(row) =>
					(!filters.actionClass || row.event.actionClass === filters.actionClass) &&
					matchesQuery(row.event, filters.query),
			),
		[allRows, filters.actionClass, filters.query],
	);

	const tools = useMemo(() => {
		const counts = new Map<string, number | undefined>();
		// Stats count per "tool.action"; the server filters by tool name, so sum the actions per tool.
		for (const [key, count] of Object.entries(stats?.byTool ?? {})) {
			const name = key.split(".")[0] ?? key;
			counts.set(name, (counts.get(name) ?? 0) + count);
		}
		for (const event of events) if (!counts.has(event.toolName)) counts.set(event.toolName, undefined);
		if (filters.tool && !counts.has(filters.tool)) counts.set(filters.tool, undefined);
		return [...counts.entries()]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name));
	}, [stats, events, filters.tool]);

	const selectedIndex = selectedKey ? rows.findIndex((row) => row.key === selectedKey) : -1;
	const selectedRow: AuditRow | null = selectedIndex >= 0 ? rows[selectedIndex]! : null;
	const stepSelection = (delta: -1 | 1) => {
		const next = rows[selectedIndex + delta];
		if (next) setSelectedKey(next.key);
	};

	const hasMore = !error && events.length >= limit;
	const filtersActive = Boolean(
		filters.query || filters.tool || filters.result || filters.actionClass || filters.day,
	);
	const busy = tab === "recent" ? loading : analyticsLoading;

	return (
		<PageShell>
			<FeatureHeader
				title="MCP Audit Trail"
				status={tab === "recent" ? `${events.length} events` : `${stats?.totalCalls ?? 0} calls`}
				actions={
					<KnButton
						variant="secondary"
						size="sm"
						icon={<RefreshCw className={cn(busy && "animate-spin motion-reduce:animate-none")} />}
						onClick={refresh}
						disabled={busy}
						aria-label="Refresh audit data"
						aria-busy={busy}
					>
						{busy ? "Refreshing" : "Refresh"}
					</KnButton>
				}
			/>

			<PageContent size="full" className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden">
				<AuditStatusSummary
					tab={tab}
					rows={allRows}
					stats={stats}
					unavailable={tab === "recent" ? loading || Boolean(error) : statsLoading || Boolean(statsError)}
				/>

				<Tabs
					value={tab}
					onValueChange={(value) => setTab(value as Tab)}
					className="sm:min-h-0 sm:flex-1"
				>
					<TabsList aria-label="Audit views">
						<TabsTrigger value="recent" icon={<Clock className="size-4" />}>
							Recent Activity
						</TabsTrigger>
						<TabsTrigger value="stats" icon={<BarChart3 className="size-4" />}>
							Statistics
						</TabsTrigger>
					</TabsList>

					<TabsContent value="recent" className="flex flex-col gap-3 sm:min-h-0 sm:flex-1">
						<AuditToolbar
							filters={filters}
							tools={tools}
							shown={rows.length}
							loaded={events.length}
							onChange={updateFilters}
						/>
						<div aria-busy={loading} className="flex min-w-0 flex-col sm:min-h-0 sm:flex-1">
							{loading ? (
								<PageLoading label="Loading audit events" className="flex-1" />
							) : error ? (
								<PageError
									title="Audit activity unavailable"
									description={error}
									onRetry={fetchRecent}
									className="flex-1"
								/>
							) : (
								<AuditEventList
									rows={rows}
									now={now}
									selectedKey={selectedKey}
									onSelect={(row) => setSelectedKey(row.key)}
									hasMore={hasMore}
									loadingMore={loadingMore}
									onLoadMore={loadOlder}
									emptyText={
										events.length === 0
											? filtersActive
												? "No audit events match these filters."
												: "No audit events found."
											: "No loaded events match this search."
									}
								/>
							)}
						</div>
					</TabsContent>

					<TabsContent value="stats" className="flex flex-col sm:min-h-0 sm:flex-1">
						<AuditStatsPanel
							stats={stats}
							loading={statsLoading}
							error={statsError}
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
					</TabsContent>
				</Tabs>
			</PageContent>

			<AuditEventSheet
				row={selectedRow}
				now={now}
				position={selectedRow ? { index: selectedIndex + 1, total: rows.length } : null}
				onClose={() => setSelectedKey(null)}
				onStep={stepSelection}
			/>
		</PageShell>
	);
}

function AuditStatusSummary({
	tab,
	rows,
	stats,
	unavailable,
}: {
	tab: Tab;
	rows: AuditRow[];
	stats: AuditStats | null;
	unavailable: boolean;
}) {
	const recent = tab === "recent";
	const total = recent ? rows.length : (stats?.totalCalls ?? 0);
	const successful = recent
		? rows.filter((row) => row.event.result === "success").length
		: (stats?.byResult.success ?? 0);
	const attention = recent
		? rows.filter((row) => row.event.result === "error" || row.event.result === "denied").length
		: (stats?.byResult.error ?? 0) + (stats?.byResult.denied ?? 0);

	const metrics = [
		{ label: recent ? "Events loaded" : "Calls recorded", value: total },
		{ label: "Successful", value: successful },
		{ label: "Errors / denied", value: attention, warn: attention > 0 },
	];

	return (
		<section
			aria-label="Audit status summary"
			className="grid grid-cols-3 overflow-hidden rounded-xl border border-border bg-card"
		>
			{metrics.map((metric, index) => (
				<dl key={metric.label} className={cn("min-w-0 px-3 py-3 sm:px-4", index > 0 && "border-l border-border")}>
					<dt className="truncate text-xs font-medium text-muted-foreground">{metric.label}</dt>
					<dd
						className={cn(
							"mt-1 text-xl font-semibold tabular-nums",
							!unavailable && metric.warn && "text-red-600 dark:text-red-400",
						)}
					>
						{unavailable ? "–" : metric.value}
					</dd>
				</dl>
			))}
		</section>
	);
}
