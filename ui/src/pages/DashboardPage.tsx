import { CircleDot, LayoutDashboard, RefreshCw, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	auditApi,
	decisionApi,
	getDocs,
	getRuntimeServices,
	getSDDStats,
	memoryApi,
	type AuditEvent,
	type DecisionEntry,
	type Doc,
	type MemoryEntry,
	type RuntimeService,
	type SDDResult,
} from "../api/client";
import { useConfig } from "../contexts/ConfigContext";
import { useTimeTracker } from "../contexts/TimeTrackerContext";
import { cn } from "../lib/utils";
import type { Task } from "@/ui/models/task";
import { ALL, AnalyticsTab, UNASSIGNED } from "./dashboard/AnalyticsTab";
import { DashboardCustomize } from "./dashboard/DashboardCustomize";
import { type MainWidgetId, type SideWidgetId, useDashboardLayout } from "./dashboard/layout";
import { ContinueWorking, NeedsAttention, Panel, Problems, ProgressChart, ReviewInbox, SummaryStrip } from "./dashboard/widgets";
import ActivityFeed from "../components/organisms/ActivityFeed";
import { PageHeader } from "@/ui/components/ui/knowns/blocks/page-header";
import { TabsContent } from "@/ui/components/ui/knowns/tabs";
import { buildThroughput, getAttentionItems } from "./dashboard/analytics";

interface DashboardPageProps {
	tasks: Task[];
	loading: boolean;
}

interface RemoteData {
	loading: boolean;
	refreshedAt: Date | null;
	sdd: SDDResult | null;
	docs: Doc[] | null;
	memories: MemoryEntry[] | null;
	decisions: DecisionEntry[] | null;
	decisionReview: DecisionEntry[] | null;
	auditErrors: AuditEvent[] | null;
	services: RuntimeService[] | null;
	errors: string[];
}

const EMPTY_REMOTE_DATA: RemoteData = {
	loading: true,
	refreshedAt: null,
	sdd: null,
	docs: null,
	memories: null,
	decisions: null,
	decisionReview: null,
	auditErrors: null,
	services: null,
	errors: [],
};

function formatRelativeTime(value: Date | string): string {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return "Unknown time";
	const elapsed = Math.max(0, Date.now() - date.getTime());
	const minutes = Math.floor(elapsed / 60_000);
	const hours = Math.floor(elapsed / 3_600_000);
	const days = Math.floor(elapsed / 86_400_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	if (days < 7) return `${days}d ago`;
	return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function EmptyState({
	icon: Icon = CircleDot,
	title,
	detail,
}: {
	icon?: React.ElementType;
	title: string;
	detail: string;
}) {
	return (
		<div className="flex min-h-40 flex-col items-center justify-center px-5 py-8 text-center">
			<Icon className="mb-3 h-5 w-5 text-muted-foreground/60" aria-hidden="true" />
			<p className="text-sm font-medium">{title}</p>
			<p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{detail}</p>
		</div>
	);
}

export default function DashboardPage({ tasks, loading }: DashboardPageProps) {
	const { config } = useConfig();
	const dashboardLayout = useDashboardLayout();
	const [tab, setTab] = useState("overview");
	const [customizeOpen, setCustomizeOpen] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);
	const { activeTimers, getElapsedForTask } = useTimeTracker();
	const [period, setPeriod] = useState<number>(30);
	const [assignee, setAssignee] = useState(ALL);
	const [label, setLabel] = useState(ALL);
	const [remote, setRemote] = useState<RemoteData>(EMPTY_REMOTE_DATA);
	const loadRemoteData = useCallback(async () => {
		setRemote((current) => ({ ...current, loading: true, errors: [] }));
		const markError = (label: string) => {
			setRemote((current) => ({
				...current,
				errors: current.errors.includes(label) ? current.errors : [...current.errors, label],
			}));
		};
		const markFresh = <K extends keyof RemoteData>(key: K, value: RemoteData[K]) => {
			setRemote((current) => ({ ...current, [key]: value, refreshedAt: new Date() }));
		};
		const requests = [
			getSDDStats().then((value) => markFresh("sdd", value)).catch(() => markError("Spec coverage")),
			getDocs().then((value) => markFresh("docs", value)).catch(() => markError("Document inventory")),
			memoryApi.list("project").then((value) => markFresh("memories", value)).catch(() => markError("Memory health")),
			decisionApi.list().then((value) => markFresh("decisions", value)).catch(() => markError("Decision inventory")),
			decisionApi.reviewInbox().then((value) => markFresh("decisionReview", value)).catch(() => markError("Decision review")),
			auditApi.recent({ limit: 5, result: "error" })
				.then((value) => markFresh("auditErrors", value.events))
				.catch(() => markError("Recent failures")),
			getRuntimeServices()
				.then((value) => markFresh("services", Array.isArray(value.services) ? value.services : null))
				.catch(() => markError("Runtime services")),
		];
		await Promise.all(requests);
		setRemote((current) => ({
			...current,
			loading: false,
			refreshedAt: current.refreshedAt ?? new Date(),
		}));
	}, []);

	useEffect(() => {
		void loadRemoteData();
	}, [loadRemoteData]);

	const filteredTasks = useMemo(
		() => tasks.filter((task) => {
			const assigneeMatches =
				assignee === ALL || (assignee === UNASSIGNED ? !task.assignee : task.assignee === assignee);
			const labelMatches = label === ALL || task.labels.includes(label);
			return assigneeMatches && labelMatches;
		}),
		[tasks, assignee, label],
	);
	const statuses = useMemo(
		() => [
			...(config.statuses ?? []),
			...tasks
				.map((task) => task.status)
				.filter((status) => !(config.statuses ?? []).includes(status)),
		].filter((status, index, list) => list.indexOf(status) === index),
		[config.statuses, tasks],
	);

	const timedTask = activeTimers
		.map((timerEntry) => tasks.find((task) => task.id === timerEntry.taskId))
		.find((task): task is Task => Boolean(task));
	const runtimeFailures = Array.isArray(remote.services)
		? remote.services.filter((service) => service.status === "error")
		: [];

	// Overview data: all tasks, not the Analytics filters.
	const overviewAttention = getAttentionItems(tasks);
	const overviewThroughput = buildThroughput(tasks, period);
	const doneByDay = Array.from({ length: 7 }, (_, i) => {
		const day = new Date();
		day.setHours(0, 0, 0, 0);
		day.setDate(day.getDate() - (6 - i));
		const next = new Date(day);
		next.setDate(day.getDate() + 1);
		return tasks.filter((t) => t.completedAt && t.completedAt >= day && t.completedAt < next).length;
	});
	const openTasks = tasks.filter((t) => !t.archived && t.lifecycleState !== "done" && !t.completedAt);
	const inProgressCount = openTasks.filter((t) => t.status.toLowerCase().includes("progress")).length;
	const blockedCount = openTasks.filter((t) => t.status.toLowerCase() === "blocked").length;
	const summarySentence = loading
		? "Loading your project…"
		: [
				`${inProgressCount} in progress`,
				blockedCount > 0 ? `${blockedCount} blocked` : null,
				overviewAttention.length > 0 ? `${overviewAttention.length} need your attention` : "nothing needs your attention",
			]
				.filter(Boolean)
				.join(" · ");
	const problems =
		remote.auditErrors === null && remote.services === null
			? null
			: [
					...runtimeFailures.map((s) => ({ key: `svc-${s.name}`, title: s.name, detail: "Runtime service reports an error" })),
					...(remote.auditErrors ?? []).slice(0, 4).map((e, i) => ({
						key: `audit-${e.timestamp}-${i}`,
						title: e.toolName,
						detail: `${e.errorMessage || e.action || e.actionClass} · ${formatRelativeTime(e.timestamp)}`,
					})),
				];
	const overviewBlocks: Record<MainWidgetId | SideWidgetId, ReactNode> = {
		continue: (
			<ContinueWorking
				tasks={tasks}
				timedTaskId={timedTask?.id}
				trackedSeconds={(t) =>
					(t.timeSpent ?? 0) + (activeTimers.some((a) => a.taskId === t.id) ? getElapsedForTask(t.id) / 1000 : 0)
				}
			/>
		),
		attention: <NeedsAttention items={overviewAttention} />,
		progress: <ProgressChart buckets={overviewThroughput} period={period} onPeriodChange={setPeriod} />,
		review: (
			<ReviewInbox
				proposedMemories={remote.memories?.filter((m) => m.status === "proposed").length}
				decisionsWaiting={remote.decisionReview?.length}
				specCoverage={remote.sdd?.stats.coverage}
			/>
		),
		activity: (
			<Panel title="Recent activity" hint="What changed in this project lately.">
				<div className="px-2 pb-2">
					<ActivityFeed limit={8} showFilter={false} showHeader={false} />
				</div>
			</Panel>
		),
		problems: <Problems failures={problems} />,
	};
	const mainIds = dashboardLayout.layout.main.filter(dashboardLayout.isVisible);
	const sideIds = dashboardLayout.layout.side.filter(dashboardLayout.isVisible);
	const nothingVisible = !dashboardLayout.isVisible("summary") && mainIds.length === 0 && sideIds.length === 0;
	return (
		<div ref={scrollRef} className="analysis-workbench h-full overflow-auto bg-[var(--analysis-canvas)] text-foreground">
			<div className="w-full px-4 py-5 sm:px-6">
				<PageHeader
					title="Dashboard"
					status={{
						label: remote.errors.length > 0 ? "Partial data" : remote.loading ? "Refreshing" : "Up to date",
						tone: remote.errors.length > 0 ? "warning" : "success",
						dot: true,
					}}
					description={summarySentence}
					meta={[
						{
							id: "updated",
							label: "Updated",
							content: remote.refreshedAt ? formatRelativeTime(remote.refreshedAt) : "—",
						},
					]}
					tabs={[
						{ value: "overview", label: "Overview" },
						{ value: "analytics", label: "Analytics" },
					]}
					tab={tab}
					onTabChange={setTab}
					actions={[
						{
							id: "customize",
							label: "Customize",
							icon: <SlidersHorizontal className="h-4 w-4" />,
							onSelect: () => {
								setTab("overview");
								setCustomizeOpen(true);
							},
						},
						{
							id: "refresh",
							label: "Refresh",
							icon: <RefreshCw className="h-4 w-4" />,
							disabled: remote.loading,
							onSelect: () => {
								void loadRemoteData();
								return "Refreshing dashboard";
							},
						},
					]}
					// The compact sticky bar overlaps this scroll container's padded content; the tabs are enough.
					condense={false}
					// The canvas is a shade off the card colour; a solid header would paint a band across it.
					className="bg-transparent"
				>
					<TabsContent value="overview" className="pt-5">
						{dashboardLayout.isVisible("summary") && (
							<div className="mb-5">
								<SummaryStrip tasks={tasks} doneByDay={doneByDay} />
							</div>
						)}
						{nothingVisible && (
							<EmptyState
								icon={LayoutDashboard}
								title="Every widget is hidden"
								detail="Use Customize to choose what this dashboard shows."
							/>
						)}
						{(mainIds.length > 0 || sideIds.length > 0) && (
							<div className={cn("grid items-start gap-5", mainIds.length > 0 && sideIds.length > 0 && "xl:grid-cols-[minmax(0,1fr)_24rem]")}>
								{mainIds.length > 0 && (
									<div className="min-w-0 space-y-5">
										{mainIds.map((id) => (
											<div key={id} data-dashboard-widget={id}>{overviewBlocks[id]}</div>
										))}
									</div>
								)}
								{sideIds.length > 0 && (
									<div className="grid min-w-0 items-start gap-5 md:grid-cols-2 xl:grid-cols-1">
										{sideIds.map((id) => (
											<div key={id} data-dashboard-widget={id}>{overviewBlocks[id]}</div>
										))}
									</div>
								)}
							</div>
						)}
					</TabsContent>
					<TabsContent value="analytics" className="pt-5">
						<AnalyticsTab
							tasks={filteredTasks}
							allTasks={tasks}
							statuses={statuses}
							loading={loading}
							period={period}
							onPeriodChange={setPeriod}
							assignee={assignee}
							onAssigneeChange={setAssignee}
							label={label}
							onLabelChange={setLabel}
							knowledge={{
								loading: remote.loading,
								errors: remote.errors,
								spec: remote.sdd?.stats.coverage,
								docs: remote.docs?.length,
								memoriesActive: remote.memories?.filter((m) => m.status === "active").length,
								memoriesProposed: remote.memories?.filter((m) => m.status === "proposed").length,
								decisionsAccepted: remote.decisions?.filter((d) => d.status === "accepted").length,
								decisionsWaiting: remote.decisionReview?.length,
							}}
						/>
					</TabsContent>
				</PageHeader>
			</div>
			<DashboardCustomize
				open={customizeOpen}
				onOpenChange={setCustomizeOpen}
				layout={dashboardLayout.layout}
				isVisible={dashboardLayout.isVisible}
				onToggle={dashboardLayout.toggle}
				onMove={dashboardLayout.move}
				onReset={dashboardLayout.reset}
			/>
		</div>
	);
}
