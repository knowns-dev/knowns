// The Analytics tab. Every section is one question a person running a Knowns project asks, answered
// in a sentence computed from the data, with the chart underneath as the evidence. Charts are the
// Knowns UI `chart`, so they share axes, tooltips, keyboard reading and the screen-reader table.
import { Link } from "@tanstack/react-router";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Badge, type BadgeTone } from "@/ui/components/ui/knowns/badge";
import { Chart, type ChartProps } from "@/ui/components/ui/knowns/chart/chart";
import { Sparkline } from "@/ui/components/ui/knowns/chart/sparkline";
import { Progress, type ProgressTone } from "@/ui/components/ui/knowns/progress";
import { SegmentedControl } from "@/ui/components/ui/knowns/segmented-control";
import { Select } from "@/ui/components/ui/knowns/select";
import { Skeleton } from "@/ui/components/ui/knowns/skeleton";
import { cn } from "@/ui/lib/utils";
import type { Task } from "@/ui/models/task";
import {
	agingChartData,
	agingTakeaway,
	buildLabelGrowth,
	buildLeadTimeHistogram,
	buildLoadByAssignee,
	buildOpenTrend,
	buildThroughput,
	buildWorkAging,
	finishedWithSpec,
	flowTakeaway,
	formatSpan,
	getFlowSummary,
	getLeadTimeStats,
	knowledgeTakeaway,
	labelTakeaway,
	leadTimeP85,
	leadTimeTakeaway,
	loadTakeaway,
	MIN_LEAD_TIME_SAMPLE,
	UNASSIGNED_LABEL,
} from "./analytics";

export const ALL = "__all";
export const UNASSIGNED = "__unassigned";
const PERIODS = [7, 30, 90] as const;

const C = {
	finished: "var(--analysis-completed)",
	added: "var(--analysis-created)",
	progress: "var(--analysis-created)",
	review: "var(--analysis-knowledge)",
	blocked: "var(--analysis-error)",
	todo: "var(--analysis-stage-todo)",
};

export interface KnowledgeData {
	loading: boolean;
	errors: string[];
	spec?: { linked: number; total: number; percent: number };
	docs?: number;
	memoriesActive?: number;
	memoriesProposed?: number;
	decisionsAccepted?: number;
	decisionsWaiting?: number;
}

/* ---------------------------------------------------------------- pieces */

function Question({
	question,
	takeaway,
	status,
	footnote,
	children,
	className,
}: {
	question: string;
	takeaway: string;
	status?: { label: string; tone: BadgeTone };
	footnote?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section
			className={cn(
				"flex min-w-0 flex-col rounded-xl bg-card",
				"shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_10%,transparent),0_1px_2px_rgb(0_0_0/0.05)]",
				className,
			)}
			aria-label={question}
		>
			<header className="px-5 pt-5">
				<div className="flex items-start justify-between gap-3">
					<h2 className="text-[15px] font-semibold leading-6 tracking-[-0.01em]">{question}</h2>
					{status && (
						<Badge tone={status.tone} size="sm" shape="pill" dot className="mt-0.5 shrink-0">
							{status.label}
						</Badge>
					)}
				</div>
				<p className="mt-1 max-w-[68ch] text-pretty text-[13px] leading-5 text-muted-foreground">{takeaway}</p>
			</header>
			<div className="flex-1 px-5 pb-5 pt-4">{children}</div>
			{footnote && (
				<p className="border-t border-border/60 px-5 py-3 text-[11px] leading-4 text-muted-foreground">{footnote}</p>
			)}
		</section>
	);
}

function Tile({
	label,
	value,
	detail,
	spark,
	sparkLabel,
	color,
}: {
	label: string;
	value: string;
	detail: string;
	spark?: number[];
	sparkLabel?: string;
	color?: string;
}) {
	return (
		<div className="min-w-0 rounded-xl bg-card p-4 shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_10%,transparent)]">
			<p className="text-xs text-muted-foreground">{label}</p>
			<div className="mt-1.5 flex items-end justify-between gap-3">
				<p className="text-2xl font-semibold tabular-nums tracking-[-0.02em]">{value}</p>
				{spark && spark.length > 1 && (
					<Sparkline
						values={spark}
						label={sparkLabel ?? label}
						color={color}
						area
						width={84}
						height={28}
						className="mb-1 shrink-0"
					/>
				)}
			</div>
			<p className="mt-1 truncate text-[11px] text-muted-foreground" title={detail}>
				{detail}
			</p>
		</div>
	);
}

function Meter({
	title,
	to,
	value,
	max,
	tone,
	figure,
	detail,
}: {
	title: string;
	to: string;
	value?: number;
	max?: number;
	tone: ProgressTone;
	figure: string;
	detail: string;
}) {
	const known = value !== undefined && max !== undefined && max > 0;
	return (
		<Link
			to={to}
			className="group block min-w-0 rounded-lg p-3 -m-3 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<div className="flex items-baseline justify-between gap-3">
				<span className="truncate text-[13px] font-medium">{title}</span>
				<span className="shrink-0 text-[13px] font-semibold tabular-nums">{figure}</span>
			</div>
			<Progress
				value={known ? value : 0}
				max={known ? max : 1}
				size="sm"
				tone={known ? tone : "neutral"}
				aria-label={`${title}: ${figure}`}
				valueLabel="none"
				className="mt-2"
			/>
			<p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{detail}</p>
		</Link>
	);
}

/** Counts never need a fractional tick: keep the axis at whole numbers, at least 0 to 4. */
const countDomain = (rows: Record<string, unknown>[], keys: string[], stacked = false): [number, number] => {
	const max = Math.max(
		0,
		...rows.map((r) =>
			stacked ? keys.reduce((s, k) => s + Number(r[k] ?? 0), 0) : Math.max(...keys.map((k) => Number(r[k] ?? 0))),
		),
	);
	return [0, Math.max(4, Math.ceil(max))];
};

/** A chart of task counts: whole-number ticks and values. */
function CountChart(props: ChartProps) {
	const keys = props.series.map((s) => s.key);
	return <Chart {...props} domain={countDomain(props.data, keys, props.stacked)} format={(v) => String(Math.round(v))} />;
}

const pctTone = (pct: number): ProgressTone => (pct >= 80 ? "success" : pct >= 50 ? "warning" : "danger");

/* ------------------------------------------------------------------ tab */

export function AnalyticsTab({
	tasks,
	allTasks,
	statuses,
	loading,
	period,
	onPeriodChange,
	assignee,
	onAssigneeChange,
	label,
	onLabelChange,
	knowledge,
}: {
	/** Tasks after the assignee and label filters. */
	tasks: Task[];
	allTasks: Task[];
	statuses: string[];
	loading: boolean;
	period: number;
	onPeriodChange: (days: number) => void;
	assignee: string;
	onAssigneeChange: (value: string) => void;
	label: string;
	onLabelChange: (value: string) => void;
	knowledge: KnowledgeData;
}) {
	const assignees = useMemo(
		() => [...new Set(allTasks.map((t) => t.assignee).filter((v): v is string => Boolean(v)))].sort(),
		[allTasks],
	);
	const labels = useMemo(() => [...new Set(allTasks.flatMap((t) => t.labels ?? []))].sort(), [allTasks]);

	const buckets = useMemo(() => buildThroughput(tasks, period), [tasks, period]);
	const flow = useMemo(() => getFlowSummary(tasks, period), [tasks, period]);
	const openTrend = useMemo(() => buildOpenTrend(tasks, buckets), [tasks, buckets]);
	const lead = useMemo(() => getLeadTimeStats(tasks, period), [tasks, period]);
	const histogram = useMemo(() => buildLeadTimeHistogram(lead?.values ?? []), [lead]);
	const aging = useMemo(() => buildWorkAging(tasks, statuses), [tasks, statuses]);
	const load = useMemo(() => buildLoadByAssignee(tasks), [tasks]);
	const growth = useMemo(() => buildLabelGrowth(tasks, period, new Date(), 5), [tasks, period]);
	const specDone = useMemo(() => finishedWithSpec(tasks, period), [tasks, period]);

	const filtered = assignee !== ALL || label !== ALL;
	const net = flow.created - flow.completed;
	const p85 = lead ? leadTimeP85(lead) : 0;
	const staleCount = aging.reduce(
		(s, r) => s + r.buckets.filter((b) => b.key === "risk" || b.key === "critical").reduce((a, b) => a + b.count, 0),
		0,
	);
	const openCount = aging.reduce((s, r) => s + r.total, 0);
	const reviewWaiting = (knowledge.memoriesProposed ?? 0) + (knowledge.decisionsWaiting ?? 0);
	const remoteReady = !(knowledge.loading && knowledge.memoriesActive === undefined && knowledge.spec === undefined);
	const sinceLabel = buckets[0]
		? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(buckets[0].start)
		: "";

	return (
		<div className="space-y-5">
			{/* Filters */}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<SegmentedControl
					aria-label="Time range"
					size="sm"
					value={String(period)}
					onValueChange={(v) => onPeriodChange(Number(v))}
					options={PERIODS.map((d) => ({ value: String(d), label: `${d} days` }))}
				/>
				<Select
					aria-label="Filter by label"
					size="sm"
					value={label}
					onChange={(e) => onLabelChange(e.target.value)}
					options={[{ value: ALL, label: "All labels" }, ...labels.map((l) => ({ value: l, label: l }))]}
					className="w-40"
				/>
				<Select
					aria-label="Filter by assignee"
					size="sm"
					value={assignee}
					onChange={(e) => onAssigneeChange(e.target.value)}
					options={[
						{ value: ALL, label: "Everyone" },
						{ value: UNASSIGNED, label: UNASSIGNED_LABEL },
						...assignees.map((a) => ({ value: a, label: a })),
					]}
					className="w-40"
				/>
				{filtered && (
					<button
						type="button"
						onClick={() => {
							onAssigneeChange(ALL);
							onLabelChange(ALL);
						}}
						className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Clear filters
					</button>
				)}
				<p className="ml-auto text-xs text-muted-foreground">
					{filtered ? (
						<>
							Showing <span className="font-medium tabular-nums text-foreground">{tasks.length}</span> of{" "}
							{allTasks.length} tasks
						</>
					) : (
						<>
							<span className="font-medium tabular-nums text-foreground">{tasks.length}</span> tasks in this project
						</>
					)}
				</p>
			</div>

			{loading ? (
				<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
					{[0, 1, 2, 3].map((i) => (
						<Skeleton key={i} className="h-[92px] rounded-xl" />
					))}
				</div>
			) : (
				<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
					<Tile
						label="Finished"
						value={String(flow.completed)}
						detail={
							flow.previousCompleted === flow.completed
								? `same as the ${period} days before`
								: `${flow.previousCompleted} in the ${period} days before`
						}
						spark={buckets.map((b) => b.completed)}
						sparkLabel={`Tasks finished, last ${period} days`}
						color={C.finished}
					/>
					<Tile
						label="Added"
						value={String(flow.created)}
						detail={`in the last ${period} days`}
						spark={buckets.map((b) => b.created)}
						sparkLabel={`Tasks added, last ${period} days`}
						color={C.added}
					/>
					<Tile
						label="Open now"
						value={String(flow.openNow)}
						detail={
							net === 0 ? `no change since ${sinceLabel}` : `${net > 0 ? "+" : ""}${net} since ${sinceLabel}`
						}
						spark={openTrend}
						sparkLabel={`Open tasks, last ${period} days`}
						color="var(--analysis-neutral)"
					/>
					<Tile
						label="Typical time to finish"
						value={lead ? formatSpan(lead.p50) : "–"}
						detail={
							!lead
								? "nothing finished in this range"
								: lead.sampleSize < MIN_LEAD_TIME_SAMPLE
									? `only ${lead.sampleSize} finished so far`
									: `85% within ${formatSpan(p85)}`
						}
					/>
				</div>
			)}

			{loading ? (
				<Skeleton className="h-80 rounded-xl" />
			) : (
				<>
					<Question
						question="Are we finishing more than we start?"
						takeaway={flowTakeaway(flow, period)}
						status={
							flow.created + flow.completed === 0
								? undefined
								: net > 0
									? { label: "Open work growing", tone: "warning" }
									: net < 0
										? { label: "Open work shrinking", tone: "success" }
										: { label: "Steady", tone: "neutral" }
						}
					>
						<CountChart
							type="bar"
							label={`Tasks finished and added, last ${period} days`}
							data={
								flow.created + flow.completed === 0
									? []
									: buckets.map((b) => ({ when: b.label, finished: b.completed, added: b.created }))
							}
							x="when"
							series={[
								{ key: "finished", label: "Finished", color: C.finished },
								{ key: "added", label: "Added", color: C.added },
							]}
							height={220}
							empty={`No tasks were added or finished in the last ${period} days`}
						/>
					</Question>

					<div className="grid gap-5 lg:grid-cols-2">
						<Question
							question="Where does work get stuck?"
							takeaway={agingTakeaway(aging)}
							status={
								openCount === 0
									? undefined
									: staleCount === 0
										? { label: "Moving", tone: "success" }
										: { label: `${staleCount} stale`, tone: staleCount / openCount > 0.3 ? "danger" : "warning" }
							}
							footnote="Open tasks by status, grouped by days since the task last changed. Knowns does not record when work started, so a task edited for any reason counts as moved."
						>
							<CountChart
								type="bar"
								stacked
								label="Open tasks by status and days since last update"
								data={openCount === 0 ? [] : agingChartData(aging)}
								x="status"
								series={[
									{ key: "fresh", label: "0-2 days", color: "var(--analysis-age-0)" },
									{ key: "watch", label: "3-7 days", color: "var(--analysis-age-1)" },
									{ key: "risk", label: "8-14 days", color: "var(--analysis-age-2)" },
									{ key: "critical", label: "15+ days", color: "var(--analysis-age-3)" },
								]}
								height={220}
								empty="No open work"
							/>
						</Question>

						<Question
							question="How long does work take?"
							takeaway={leadTimeTakeaway(lead, period)}
							status={lead ? { label: `${lead.sampleSize} finished`, tone: "neutral" } : undefined}
							footnote="From the day a task was created to the day it was finished, for tasks finished in this range."
						>
							<CountChart
								type="bar"
								label={`Tasks finished in the last ${period} days, by time from created to finished`}
								data={lead ? histogram.map((b) => ({ span: b.label, tasks: b.count })) : []}
								x="span"
								series={[{ key: "tasks", label: "Tasks", color: C.finished }]}
								legend={false}
								height={220}
								empty={`No task was finished in the last ${period} days`}
							/>
						</Question>

						<Question
							question="Who carries the load?"
							takeaway={loadTakeaway(load)}
							footnote="Open tasks per assignee, split by where they sit on the board."
						>
							<CountChart
								type="bar"
								stacked
								label="Open tasks per assignee by stage"
								data={load.map((r) => ({ who: r.who, todo: r.todo, progress: r.progress, review: r.review, blocked: r.blocked }))}
								x="who"
								series={[
									{ key: "progress", label: "In progress", color: C.progress },
									{ key: "review", label: "In review", color: C.review },
									{ key: "blocked", label: "Blocked", color: C.blocked },
									{ key: "todo", label: "Not started", color: C.todo },
								]}
								height={220}
								empty="Nobody holds open work"
							/>
						</Question>

						<Question
							question="Which areas are growing?"
							takeaway={labelTakeaway(growth, period)}
							footnote={`Tasks added and finished per label in the last ${period} days, the five fastest-growing first. A task with two labels counts in both.`}
						>
							<CountChart
								type="bar"
								label={`Tasks added and finished per label, last ${period} days`}
								data={growth.map((r) => ({ label: r.label, added: r.added, finished: r.finished }))}
								x="label"
								series={[
									{ key: "added", label: "Added", color: C.added },
									{ key: "finished", label: "Finished", color: C.finished },
								]}
								height={220}
								empty={`No work was added or finished in the last ${period} days`}
							/>
						</Question>
					</div>
				</>
			)}

			<Question
				question="Is knowledge keeping up with the work?"
				takeaway={
					remoteReady
						? knowledgeTakeaway({
								specLinked: knowledge.spec?.linked,
								specTotal: knowledge.spec?.total,
								finished: specDone.finished,
								finishedWithSpec: specDone.withSpec,
								memoriesActive: knowledge.memoriesActive,
								memoriesProposed: knowledge.memoriesProposed,
								decisionsAccepted: knowledge.decisionsAccepted,
								decisionsWaiting: knowledge.decisionsWaiting,
							})
						: "Loading specs, memories and decisions…"
				}
				status={
					!remoteReady
						? undefined
						: reviewWaiting > 0
							? { label: `${reviewWaiting} to review`, tone: "accent" }
							: { label: "Inbox clear", tone: "success" }
				}
				footnote={
					knowledge.errors.length > 0 ? (
						<span className="inline-flex items-start gap-1.5 text-[var(--analysis-risk-text)]">
							<TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
							Could not load {knowledge.errors.join(", ")}. The other numbers are current.
						</span>
					) : knowledge.docs !== undefined ? (
						`${knowledge.docs} ${knowledge.docs === 1 ? "doc" : "docs"} in this project. Spec coverage counts every task, the second meter only work finished in this range.`
					) : undefined
				}
			>
				{!remoteReady ? (
					<div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
						{[0, 1, 2, 3].map((i) => (
							<Skeleton key={i} className="h-16 rounded-lg" />
						))}
					</div>
				) : (
					<div className="grid gap-x-8 gap-y-6 px-3 pt-3 sm:grid-cols-2 xl:grid-cols-4">
						<Meter
							title="Tasks linked to a spec"
							to="/tasks"
							value={knowledge.spec?.linked}
							max={knowledge.spec?.total}
							tone={pctTone(knowledge.spec?.percent ?? 0)}
							figure={knowledge.spec ? `${knowledge.spec.percent}%` : "–"}
							detail={knowledge.spec ? `${knowledge.spec.linked} of ${knowledge.spec.total} tasks` : "Spec coverage is unavailable"}
						/>
						<Meter
							title="Finished work with a spec"
							to="/tasks"
							value={specDone.withSpec}
							max={specDone.finished}
							tone={pctTone(specDone.finished ? (specDone.withSpec / specDone.finished) * 100 : 0)}
							figure={specDone.finished ? `${specDone.withSpec}/${specDone.finished}` : "–"}
							detail={specDone.finished ? `of tasks finished in the last ${period} days` : `nothing finished in the last ${period} days`}
						/>
						<Meter
							title="Memories confirmed"
							to="/memory"
							value={knowledge.memoriesActive}
							max={(knowledge.memoriesActive ?? 0) + (knowledge.memoriesProposed ?? 0)}
							tone={knowledge.memoriesProposed ? "accent" : "success"}
							figure={
								knowledge.memoriesActive === undefined
									? "–"
									: `${knowledge.memoriesActive}/${knowledge.memoriesActive + (knowledge.memoriesProposed ?? 0)}`
							}
							detail={
								knowledge.memoriesActive === undefined
									? "Memories are unavailable"
									: knowledge.memoriesActive + (knowledge.memoriesProposed ?? 0) === 0
										? "No memories yet"
										: `${knowledge.memoriesProposed ?? 0} proposed, waiting for review`
							}
						/>
						<Meter
							title="Decisions settled"
							to="/decisions"
							value={knowledge.decisionsAccepted}
							max={(knowledge.decisionsAccepted ?? 0) + (knowledge.decisionsWaiting ?? 0)}
							tone={knowledge.decisionsWaiting ? "warning" : "success"}
							figure={
								knowledge.decisionsAccepted === undefined
									? "–"
									: `${knowledge.decisionsAccepted}/${knowledge.decisionsAccepted + (knowledge.decisionsWaiting ?? 0)}`
							}
							detail={
								knowledge.decisionsAccepted === undefined
									? "Decisions are unavailable"
									: knowledge.decisionsAccepted + (knowledge.decisionsWaiting ?? 0) === 0
										? "No decisions yet"
										: `${knowledge.decisionsWaiting ?? 0} proposed, waiting for review`
							}
						/>
					</div>
				)}
			</Question>
		</div>
	);
}
