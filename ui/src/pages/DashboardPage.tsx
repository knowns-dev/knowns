import { Link } from "@tanstack/react-router";
import {
	Activity,
	AlertCircle,
	ArrowRight,
	BookOpen,
	CheckCircle2,
	CircleDot,
	Clock3,
	Database,
	FileText,
	Flame,
	GitPullRequest,
	Info,
	LayoutDashboard,
	ListChecks,
	RefreshCw,
	Sparkles,
	Timer,
	TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
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
import { Button } from "../components/ui/button";
import { Progress } from "../components/ui/progress";
import { FeatureHeader } from "../components/templates";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { useConfig } from "../contexts/ConfigContext";
import { useTimeTracker } from "../contexts/TimeTrackerContext";
import { cn } from "../lib/utils";
import type { Task } from "@/ui/models/task";
import {
	buildThroughput,
	buildWorkAging,
	formatStatus,
	getAttentionItems,
	getLeadTimeStats,
	type AgingRow,
	type LeadTimeStats,
	type ThroughputBucket,
} from "./dashboard/analytics";

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

interface KnowledgeSignal {
	key: string;
	title: string;
	icon: React.ElementType;
	href: string;
	value: number | null;
	valueLabel: string;
	detail: string;
	tone: "healthy" | "watch" | "critical" | "neutral";
}

const PERIOD_OPTIONS = [7, 30, 90] as const;
const ALL_ASSIGNEES = "__all_assignees";
const UNASSIGNED = "__unassigned";
const ALL_LABELS = "__all_labels";
const STATUS_PALETTE = [
	"#7B8494",
	"#3B82F6",
	"#6558D3",
	"#0F9D7A",
	"#D97706",
	"#D14343",
	"#0891B2",
];

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

function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return "0m";
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours >= 24) {
		const days = Math.floor(hours / 24);
		const remainingHours = hours % 24;
		return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
	}
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return `${Math.max(1, minutes)}m`;
}

function formatDays(days: number): string {
	if (days < 1) {
		const hours = Math.max(1, Math.round(days * 24));
		return `${hours}h`;
	}
	if (days < 10) return `${days.toFixed(1)}d`;
	return `${Math.round(days)}d`;
}

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

function statusColor(status: string, configured?: Record<string, string>): string {
	if (configured?.[status]) return configured[status]!;
	let hash = 0;
	for (const character of status) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
	return STATUS_PALETTE[Math.abs(hash) % STATUS_PALETTE.length]!;
}

function SectionCard({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("rounded-xl border border-border/70 bg-card", className)}>
			{children}
		</section>
	);
}

function SectionHeader({
	icon: Icon,
	title,
	description,
	action,
}: {
	icon: React.ElementType;
	title: string;
	description: string;
	action?: React.ReactNode;
}) {
	return (
		<header className="analysis-rule flex min-w-0 items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
			<div className="flex min-w-0 items-start gap-3">
				<Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<div className="min-w-0">
					<h2 className="text-sm font-semibold tracking-[-0.01em]">{title}</h2>
					<p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
				</div>
			</div>
			{action}
		</header>
	);
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

function ChartLoading() {
	return (
		<div className="space-y-4 p-5" aria-label="Loading dashboard data">
			<div className="grid grid-cols-3 gap-3">
				<Skeleton className="h-14" />
				<Skeleton className="h-14" />
				<Skeleton className="h-14" />
			</div>
			<Skeleton className="h-52" />
		</div>
	);
}

function Metric({
	label,
	value,
	detail,
	tone,
}: {
	label: string;
	value: string;
	detail?: string;
	tone?: "created" | "completed" | "risk";
}) {
	return (
		<div className="min-w-0 border-l border-border/70 pl-3 first:border-l-0 first:pl-0">
			<p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
			<p
				className={cn(
					"mt-1 text-xl font-semibold tabular-nums tracking-[-0.03em]",
					tone === "created" && "text-[var(--analysis-created)]",
					tone === "completed" && "text-[var(--analysis-completed)]",
					tone === "risk" && "text-[var(--analysis-risk)]",
				)}
			>
				{value}
			</p>
			{detail && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</p>}
		</div>
	);
}

function MetricTile({
	label,
	value,
	detail,
	tone,
}: {
	label: string;
	value: string;
	detail?: string;
	tone?: "created" | "completed" | "risk";
}) {
	return (
		<div className="min-w-0 rounded-xl border border-border/70 bg-card px-4 py-3">
			<p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
			<p
				className={cn(
					"mt-1 text-xl font-semibold tabular-nums tracking-[-0.03em]",
					tone === "created" && "text-[var(--analysis-created)]",
					tone === "completed" && "text-[var(--analysis-completed)]",
					tone === "risk" && "text-[var(--analysis-risk)]",
				)}
			>
				{value}
			</p>
			{detail && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</p>}
		</div>
	);
}

function ThroughputChart({ data }: { data: ThroughputBucket[] }) {
	const titleId = useId();
	const descriptionId = useId();
	const width = 760;
	const height = 236;
	const margin = { top: 18, right: 18, bottom: 34, left: 34 };
	const chartWidth = width - margin.left - margin.right;
	const chartHeight = height - margin.top - margin.bottom;
	const maxValue = Math.max(1, ...data.flatMap((bucket) => [bucket.created, bucket.completed]));
	const tickValues = [maxValue, Math.round(maxValue / 2), 0];
	const pointFor = (value: number, index: number) => ({
		x: margin.left + (data.length <= 1 ? chartWidth / 2 : (index / (data.length - 1)) * chartWidth),
		y: margin.top + chartHeight - (value / maxValue) * chartHeight,
	});
	const linePath = (key: "created" | "completed") =>
		data
			.map((bucket, index) => {
				const point = pointFor(bucket[key], index);
				return `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
			})
			.join(" ");
	const xLabelStep = Math.max(1, Math.ceil(data.length / 6));

	return (
		<>
			<div className="relative">
				<svg
					viewBox={`0 0 ${width} ${height}`}
					className="h-[236px] w-full overflow-visible"
					role="img"
					aria-labelledby={`${titleId} ${descriptionId}`}
				>
					<title id={titleId}>Created and completed task throughput</title>
					<desc id={descriptionId}>
						{data
							.map((bucket) => `${bucket.rangeLabel}: ${bucket.created} created and ${bucket.completed} completed`)
							.join(". ")}
					</desc>
					{tickValues.map((tick, index) => {
						const y = margin.top + (index / (tickValues.length - 1)) * chartHeight;
						return (
							<g key={`${tick}-${index}`}>
								<line
									x1={margin.left}
									x2={width - margin.right}
									y1={y}
									y2={y}
									stroke="var(--analysis-grid)"
									strokeWidth="1"
								/>
								<text
									x={margin.left - 8}
									y={y + 4}
									textAnchor="end"
									className="fill-muted-foreground text-[10px]"
								>
									{tick}
								</text>
							</g>
						);
					})}
					<path
						d={linePath("created")}
						fill="none"
						stroke="var(--analysis-created)"
						strokeWidth="2.5"
						strokeLinejoin="round"
						strokeLinecap="round"
					/>
					<path
						d={linePath("completed")}
						fill="none"
						stroke="var(--analysis-completed)"
						strokeWidth="2.5"
						strokeLinejoin="round"
						strokeLinecap="round"
					/>
					{data.map((bucket, index) => {
						const createdPoint = pointFor(bucket.created, index);
						const completedPoint = pointFor(bucket.completed, index);
						const showLabel = index % xLabelStep === 0 || index === data.length - 1;
						return (
							<g key={bucket.start.toISOString()}>
								<circle
									cx={createdPoint.x}
									cy={createdPoint.y}
									r="3.5"
									fill="var(--analysis-canvas)"
									stroke="var(--analysis-created)"
									strokeWidth="2"
								>
									<title>{`${bucket.rangeLabel}: ${bucket.created} created`}</title>
								</circle>
								<circle
									cx={completedPoint.x}
									cy={completedPoint.y}
									r="3.5"
									fill="var(--analysis-canvas)"
									stroke="var(--analysis-completed)"
									strokeWidth="2"
								>
									<title>{`${bucket.rangeLabel}: ${bucket.completed} completed`}</title>
								</circle>
								{showLabel && (
									<text
										x={createdPoint.x}
										y={height - 10}
										textAnchor="middle"
										className="fill-muted-foreground text-[10px]"
									>
										{bucket.label}
									</text>
								)}
							</g>
						);
					})}
				</svg>
			</div>
			<details className="border-t border-border/60 px-5 py-3 text-xs">
				<summary className="cursor-pointer select-none font-medium text-muted-foreground hover:text-foreground">
					View throughput data
				</summary>
				<div className="mt-3 overflow-x-auto">
					<table className="w-full min-w-80 text-left">
						<thead className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
							<tr>
								<th className="pb-2 font-medium">Period</th>
								<th className="pb-2 text-right font-medium">Created</th>
								<th className="pb-2 text-right font-medium">Completed</th>
							</tr>
						</thead>
						<tbody>
							{data.map((bucket) => (
								<tr key={bucket.start.toISOString()} className="border-t border-border/50">
									<td className="py-2">{bucket.rangeLabel}</td>
									<td className="py-2 text-right tabular-nums">{bucket.created}</td>
									<td className="py-2 text-right tabular-nums">{bucket.completed}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</details>
		</>
	);
}

function WorkAgingChart({ rows }: { rows: AgingRow[] }) {
	const bucketStyles: Record<AgingRow["buckets"][number]["key"], string> = {
		fresh: "var(--analysis-created)",
		watch: "var(--analysis-knowledge)",
		risk: "var(--analysis-risk)",
		critical: "var(--analysis-critical)",
	};

	if (rows.length === 0) {
		return (
			<EmptyState
				icon={CheckCircle2}
				title="No open work"
				detail="No active tasks match the current assignee and label filters."
			/>
		);
	}

	return (
		<div className="p-5">
			<div
				className="space-y-3"
				role="img"
				aria-label={rows
					.map((row) => `${formatStatus(row.status)}: ${row.total} tasks`)
					.join(". ")}
			>
				{rows.map((row) => (
					<div key={row.status} className="grid grid-cols-[6.5rem_minmax(0,1fr)_1.75rem] items-center gap-3">
						<span className="truncate text-xs text-muted-foreground" title={formatStatus(row.status)}>
							{formatStatus(row.status)}
						</span>
						<div className="flex h-5 overflow-hidden rounded-sm bg-muted/50">
							{row.buckets.map((bucket) => (
								<div
									key={bucket.key}
									style={{
										width: `${row.total > 0 ? (bucket.count / row.total) * 100 : 0}%`,
										backgroundColor: bucketStyles[bucket.key],
									}}
									title={`${bucket.label}: ${bucket.count}`}
								/>
							))}
						</div>
						<span className="text-right text-xs font-medium tabular-nums">{row.total}</span>
					</div>
				))}
			</div>
			<div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 border-t border-border/60 pt-4">
				{rows[0]!.buckets.map((bucket) => (
					<div key={bucket.key} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
						<span
							className="h-2 w-2 rounded-[2px]"
							style={{ backgroundColor: bucketStyles[bucket.key] }}
						/>
						{bucket.label}
					</div>
				))}
			</div>
			<details className="mt-4 border-t border-border/60 pt-3 text-xs">
				<summary className="cursor-pointer select-none font-medium text-muted-foreground hover:text-foreground">
					View aging data
				</summary>
				<div className="mt-3 overflow-x-auto">
					<table className="w-full min-w-[28rem] text-left">
						<thead className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
							<tr>
								<th className="pb-2 font-medium">Status</th>
								{rows[0]!.buckets.map((bucket) => (
									<th key={bucket.key} className="pb-2 text-right font-medium">{bucket.label}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.status} className="border-t border-border/50">
									<td className="py-2">{formatStatus(row.status)}</td>
									{row.buckets.map((bucket) => (
										<td key={bucket.key} className="py-2 text-right tabular-nums">{bucket.count}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</details>
		</div>
	);
}

function LeadTimeDistribution({ stats }: { stats: LeadTimeStats }) {
	const scaleMax = Math.max(stats.max, 1);
	return (
		<div className="p-5">
			<div className="grid grid-cols-3 gap-4">
				<Metric label="P50" value={formatDays(stats.p50)} />
				<Metric label="P90" value={formatDays(stats.p90)} tone="risk" />
				<Metric label="Sample" value={String(stats.sampleSize)} detail="completed tasks" />
			</div>
			<div className="mt-7" role="img" aria-label={`Lead time distribution from ${formatDays(stats.values[0] ?? 0)} to ${formatDays(stats.max)}`}>
				<div className="relative h-8">
					<div className="absolute inset-x-0 top-3.5 h-px bg-border" />
					<div
						className="absolute top-2 h-3 w-0.5 bg-[var(--analysis-created)]"
						style={{ left: `${(stats.p50 / scaleMax) * 100}%` }}
						title={`P50 ${formatDays(stats.p50)}`}
					/>
					<div
						className="absolute top-1.5 h-4 w-0.5 bg-[var(--analysis-risk)]"
						style={{ left: `${(stats.p90 / scaleMax) * 100}%` }}
						title={`P90 ${formatDays(stats.p90)}`}
					/>
					{stats.values.map((value, index) => (
						<span
							key={`${value}-${index}`}
							className="absolute top-2.5 h-2 w-2 -translate-x-1/2 rounded-full border border-card bg-[var(--analysis-completed)]"
							style={{ left: `${(value / scaleMax) * 100}%` }}
							title={formatDays(value)}
						/>
					))}
				</div>
				<div className="flex justify-between text-[10px] text-muted-foreground">
					<span>0d</span>
					<span>{formatDays(scaleMax)}</span>
				</div>
			</div>
			<p className="mt-5 flex items-start gap-2 border-t border-border/60 pt-4 text-[11px] leading-5 text-muted-foreground">
				<Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				Created → completed. First in-progress history is not exposed in the batch API, so this is lead time—not cycle time.
			</p>
		</div>
	);
}

function SignalRow({ signal }: { signal: KnowledgeSignal }) {
	const toneClasses = {
		healthy: "bg-[var(--analysis-completed)]",
		watch: "bg-[var(--analysis-risk)]",
		critical: "bg-[var(--analysis-error)]",
		neutral: "bg-[var(--analysis-neutral)]",
	};
	const Icon = signal.icon;
	return (
		<Link
			to={signal.href}
			className="group grid grid-cols-[minmax(0,1fr)_minmax(8rem,0.7fr)] items-center gap-5 border-t border-border/60 px-5 py-4 first:border-t-0 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
		>
			<div className="flex min-w-0 items-start gap-3">
				<Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="truncate text-sm font-medium">{signal.title}</span>
						<ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none" />
					</div>
					<p className="mt-1 text-xs leading-5 text-muted-foreground">{signal.detail}</p>
				</div>
			</div>
			<div className="min-w-0">
				<div className="flex items-center justify-between gap-3 text-xs">
					<span className="text-muted-foreground">Signal</span>
					<span className="font-medium tabular-nums">{signal.valueLabel}</span>
				</div>
				<div
					className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
					role="progressbar"
					aria-label={`${signal.title}: ${signal.valueLabel}`}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={signal.value ?? undefined}
				>
					{signal.value !== null && (
						<div
							className={cn("h-full rounded-full", toneClasses[signal.tone])}
							style={{ width: `${Math.max(2, Math.min(100, signal.value))}%` }}
						/>
					)}
				</div>
			</div>
		</Link>
	);
}

function FilterBar({
	period,
	onPeriodChange,
	assignee,
	onAssigneeChange,
	label,
	onLabelChange,
	assignees,
	labels,
	filteredCount,
}: {
	period: number;
	onPeriodChange: (value: number) => void;
	assignee: string;
	onAssigneeChange: (value: string) => void;
	label: string;
	onLabelChange: (value: string) => void;
	assignees: string[];
	labels: string[];
	filteredCount: number;
}) {
	return (
		<div className="mb-5 flex h-[52px] shrink-0 flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-card px-3">
			<fieldset className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
				<legend className="sr-only">Analysis period</legend>
				{PERIOD_OPTIONS.map((option) => (
					<button
						key={option}
						type="button"
						aria-pressed={period === option}
						onClick={() => onPeriodChange(option)}
						className={cn(
							"h-7 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
							period === option
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{option}d
					</button>
				))}
			</fieldset>
			<div className="h-5 w-px bg-border max-sm:hidden" />
			{/* No dedicated "project" filter exists on this page; the label filter fills that slot. */}
			<div className="flex min-w-[10rem] items-center gap-2">
				<span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Label</span>
				<Select value={label} onValueChange={onLabelChange}>
					<SelectTrigger className="h-8 min-w-32 flex-1 border-border/80 bg-background text-xs shadow-none" aria-label="Filter by label">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ALL_LABELS}>All labels</SelectItem>
						{labels.map((item) => (
							<SelectItem key={item} value={item}>{item}</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<div className="flex min-w-[10rem] items-center gap-2">
				<span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Assignee</span>
				<Select value={assignee} onValueChange={onAssigneeChange}>
					<SelectTrigger className="h-8 min-w-36 flex-1 border-border/80 bg-background text-xs shadow-none" aria-label="Filter by assignee">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ALL_ASSIGNEES}>All assignees</SelectItem>
						<SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
						{assignees.map((item) => (
							<SelectItem key={item} value={item}>{item}</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<p className="ml-auto shrink-0 text-xs text-muted-foreground">
				<span className="font-medium tabular-nums text-foreground">{filteredCount}</span>{" "}
				{filteredCount === 1 ? "task" : "tasks"} in range
			</p>
		</div>
	);
}

export default function DashboardPage({ tasks, loading }: DashboardPageProps) {
	const { config } = useConfig();
	const { activeTimers, getElapsedForTask } = useTimeTracker();
	const [period, setPeriod] = useState<number>(30);
	const [assignee, setAssignee] = useState(ALL_ASSIGNEES);
	const [label, setLabel] = useState(ALL_LABELS);
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

	const assignees = useMemo(
		() => [...new Set(tasks.map((task) => task.assignee).filter((value): value is string => Boolean(value)))].sort(),
		[tasks],
	);
	const labels = useMemo(
		() => [...new Set(tasks.flatMap((task) => task.labels ?? []))].sort(),
		[tasks],
	);
	const filteredTasks = useMemo(
		() => tasks.filter((task) => {
			const assigneeMatches =
				assignee === ALL_ASSIGNEES ||
				(assignee === UNASSIGNED ? !task.assignee : task.assignee === assignee);
			const labelMatches = label === ALL_LABELS || task.labels.includes(label);
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
	const throughput = useMemo(
		() => buildThroughput(filteredTasks, period),
		[filteredTasks, period],
	);
	const throughputSummary = useMemo(
		() => throughput.reduce(
			(summary, bucket) => ({
				created: summary.created + bucket.created,
				completed: summary.completed + bucket.completed,
			}),
			{ created: 0, completed: 0 },
		),
		[throughput],
	);
	const leadTime = useMemo(
		() => getLeadTimeStats(filteredTasks, period),
		[filteredTasks, period],
	);
	const workAging = useMemo(
		() => buildWorkAging(filteredTasks, statuses),
		[filteredTasks, statuses],
	);
	const attentionItems = useMemo(
		() => getAttentionItems(filteredTasks),
		[filteredTasks],
	);

	const timedTask = activeTimers
		.map((timerEntry) => tasks.find((task) => task.id === timerEntry.taskId))
		.find((task): task is Task => Boolean(task));
	const suggestedTask = useMemo(
		() => [...filteredTasks]
			.filter((task) => task.lifecycleState !== "done" && !task.completedAt && task.status.toLowerCase().includes("progress"))
			.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0],
		[filteredTasks],
	);
	const recommendedItem = attentionItems[0];
	const focusTask = timedTask ?? suggestedTask ?? recommendedItem?.task;
	const focusTimer = focusTask
		? activeTimers.find((timerEntry) => timerEntry.taskId === focusTask.id)
		: undefined;
	const isRecommendedFocus = Boolean(focusTask && !timedTask && !suggestedTask);
	const visibleAttentionItems = isRecommendedFocus ? attentionItems.slice(1) : attentionItems;
	const focusLabel = focusTimer
		? "Active timer"
		: suggestedTask
			? "Suggested focus"
			: focusTask
				? "Next recommended"
				: "No active focus";
	const focusCompletedAC = focusTask?.acceptanceCriteria.filter((item) => item.completed).length ?? 0;
	const focusTotalAC = focusTask?.acceptanceCriteria.length ?? 0;
	const focusProgress = focusTotalAC > 0 ? Math.round((focusCompletedAC / focusTotalAC) * 100) : 0;
	const focusSeconds = focusTask
		? (focusTask.timeSpent ?? 0) + (focusTimer ? getElapsedForTask(focusTask.id) / 1000 : 0)
		: 0;

	const knowledgeSignals = useMemo<KnowledgeSignal[]>(() => {
		const coverage = remote.sdd?.stats.coverage;
		const activeMemories = remote.memories?.filter((item) => item.status === "active").length;
		const proposedMemories = remote.memories?.filter((item) => item.status === "proposed").length;
		const reviewableMemories =
			activeMemories !== undefined && proposedMemories !== undefined
				? activeMemories + proposedMemories
				: undefined;
		const memoryReadiness =
			reviewableMemories && activeMemories !== undefined
				? Math.round((activeMemories / reviewableMemories) * 100)
				: null;
		const acceptedDecisions = remote.decisions?.filter((item) => item.status === "accepted").length;
		const decisionReviewCount = remote.decisionReview?.length;
		const decisionTotal =
			acceptedDecisions !== undefined && decisionReviewCount !== undefined
				? acceptedDecisions + decisionReviewCount
				: undefined;
		const decisionReadiness =
			decisionTotal && acceptedDecisions !== undefined
				? Math.round((acceptedDecisions / decisionTotal) * 100)
				: null;

		return [
			{
				key: "spec",
				title: "Spec-linked tasks",
				icon: ListChecks,
				href: "/tasks",
				value: coverage?.percent ?? null,
				valueLabel: coverage ? `${coverage.percent}%` : "Unavailable",
				detail: coverage
					? `${coverage.linked} of ${coverage.total} tasks link to a spec`
					: "Spec coverage endpoint is unavailable",
				tone: coverage && coverage.percent >= 80 ? "healthy" : coverage && coverage.percent >= 60 ? "watch" : coverage ? "critical" : "neutral",
			},
			{
				key: "docs",
				title: "Document inventory",
				icon: FileText,
				href: "/docs",
				value: remote.docs ? 100 : null,
				valueLabel: remote.docs ? `${remote.docs.length} indexed` : "Unavailable",
				detail: remote.docs
					? "Freshness is not exposed by the document list API"
					: "Document inventory endpoint is unavailable",
				tone: "neutral",
			},
			{
				key: "memory",
				title: "Memory readiness",
				icon: Database,
				href: "/memory",
				value: memoryReadiness,
				valueLabel: memoryReadiness !== null ? `${memoryReadiness}% active` : "Unavailable",
				detail:
					activeMemories !== undefined && proposedMemories !== undefined
						? `${activeMemories} active · ${proposedMemories} proposed`
						: "Memory inventory endpoint is unavailable",
				tone: memoryReadiness !== null && memoryReadiness >= 80 ? "healthy" : memoryReadiness !== null && memoryReadiness >= 60 ? "watch" : memoryReadiness !== null ? "critical" : "neutral",
			},
			{
				key: "decision",
				title: "Decision review",
				icon: GitPullRequest,
				href: "/decisions",
				value: decisionReadiness,
				valueLabel:
					decisionReviewCount !== undefined
						? decisionReviewCount === 0
							? "Inbox clear"
							: `${decisionReviewCount} waiting`
						: "Unavailable",
				detail:
					acceptedDecisions !== undefined && decisionReviewCount !== undefined
						? `${acceptedDecisions} accepted · ${decisionReviewCount} awaiting review`
						: "Decision review endpoint is unavailable",
				tone: decisionReviewCount === 0 ? "healthy" : decisionReviewCount !== undefined && decisionReviewCount <= 3 ? "watch" : decisionReviewCount !== undefined ? "critical" : "neutral",
			},
		];
	}, [remote]);

	const runtimeFailures = Array.isArray(remote.services)
		? remote.services.filter((service) => service.status === "error")
		: [];
	const hasThroughput = throughputSummary.created + throughputSummary.completed > 0;
	const gap = throughputSummary.created - throughputSummary.completed;

	return (
		<div className="analysis-workbench h-full overflow-auto bg-[var(--analysis-canvas)] text-foreground">
			<FeatureHeader
				icon={LayoutDashboard}
				title="Dashboard"
				status={
					<span className="inline-flex items-center gap-1.5">
						<span className={cn("h-1.5 w-1.5 rounded-full", remote.errors.length > 0 ? "bg-[var(--analysis-risk)]" : "bg-[var(--analysis-completed)]")} />
						{remote.errors.length > 0
							? "Partial data"
							: remote.loading
								? "Refreshing"
								: "All sources ready"}
						{" · Updated "}
						{remote.refreshedAt ? formatRelativeTime(remote.refreshedAt) : "—"}
					</span>
				}
				actions={
					<Button
						variant="outline"
						size="sm"
						onClick={() => void loadRemoteData()}
						disabled={remote.loading}
						aria-label="Refresh dashboard data"
					>
						<RefreshCw className={cn(remote.loading && "animate-spin motion-reduce:animate-none")} />
						Refresh
					</Button>
				}
			/>

			<div className="w-full px-4 py-5 sm:px-6">
				<FilterBar
					period={period}
					onPeriodChange={setPeriod}
					assignee={assignee}
					onAssigneeChange={setAssignee}
					label={label}
					onLabelChange={setLabel}
					assignees={assignees}
					labels={labels}
					filteredCount={filteredTasks.length}
				/>

				{loading ? (
					<div className="mb-5 grid grid-cols-3 gap-4">
						<Skeleton className="h-[68px]" />
						<Skeleton className="h-[68px]" />
						<Skeleton className="h-[68px]" />
					</div>
				) : (
					<div className="mb-5 grid grid-cols-3 gap-4">
						<MetricTile label="Created" value={String(throughputSummary.created)} tone="created" />
						<MetricTile label="Completed" value={String(throughputSummary.completed)} tone="completed" />
						<MetricTile
							label="Flow gap"
							value={`${gap > 0 ? "+" : ""}${gap}`}
							detail={gap > 0 ? "intake above output" : gap < 0 ? "output above intake" : "balanced"}
							tone={gap > 0 ? "risk" : undefined}
						/>
					</div>
				)}

				<div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_23rem]">
					<main className="order-2 min-w-0 space-y-5 xl:order-1">
						<SectionCard>
							<SectionHeader
								icon={Activity}
								title="Throughput"
								description={`Created and completed task flow · last ${period} days`}
								action={
									<span className="shrink-0 rounded-md border border-border/70 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
										{throughput.length} buckets
									</span>
								}
							/>
							{loading ? (
								<ChartLoading />
							) : (
								<>
									<div className="px-3 pt-5">
										<ThroughputChart data={throughput} />
									</div>
									{!hasThroughput && (
										<p className="px-5 pb-4 pt-1 text-center text-xs text-muted-foreground">
											No tasks were created or completed in this window.
										</p>
									)}
								</>
							)}
						</SectionCard>

						<div className="grid min-w-0 gap-5 lg:grid-cols-2">
							<SectionCard className="min-w-0">
								<SectionHeader
									icon={Clock3}
									title="Work aging"
									description="Current open work grouped by time since latest task update"
									action={
										<span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--analysis-risk)]">
											Update-age proxy
										</span>
									}
								/>
								{loading ? <ChartLoading /> : <WorkAgingChart rows={workAging} />}
							</SectionCard>

							<SectionCard className="min-w-0">
								<SectionHeader
									icon={Timer}
									title="Lead time"
									description={`Created → completed · completions in the last ${period} days`}
								/>
								{loading ? (
									<ChartLoading />
								) : leadTime ? (
									<LeadTimeDistribution stats={leadTime} />
								) : (
									<EmptyState
										icon={Timer}
										title="No completed-task sample"
										detail="Complete a task in this period to calculate P50 and P90 lead time."
									/>
								)}
							</SectionCard>
						</div>

						<SectionCard>
							<SectionHeader
								icon={Sparkles}
								title="Knowledge health"
								description="Coverage, inventory, and review signals from Knowns project memory"
								action={
									remote.errors.length > 0 ? (
										<span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--analysis-risk)]">
											<TriangleAlert className="h-3.5 w-3.5" />
											Partial
										</span>
									) : undefined
								}
							/>
							{remote.loading &&
							!remote.refreshedAt &&
							remote.errors.length === 0 ? (
								<ChartLoading />
							) : (
								<>
									<div>
										{knowledgeSignals.map((signal) => (
											<SignalRow key={signal.key} signal={signal} />
										))}
									</div>
									{remote.errors.length > 0 && (
										<div className="flex items-start gap-2 border-t border-border/60 bg-[var(--analysis-risk-soft)] px-5 py-3 text-xs text-[var(--analysis-risk-text)]" role="status">
											<TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
											<span>
												Unavailable now: {remote.errors.join(", ")}. Available signals remain visible.
											</span>
										</div>
									)}
								</>
							)}
						</SectionCard>
					</main>

					<aside className="order-1 min-w-0 xl:sticky xl:top-5 xl:order-2" aria-label="Project pulse">
						<SectionCard className="overflow-hidden">
							<SectionHeader
								icon={Flame}
								title="Project pulse"
								description="Current focus, attention queue, and recent failures"
							/>

							<div className="border-b border-border/60 p-4">
								<div className="mb-3 flex items-center justify-between gap-3">
									<p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
										{focusLabel}
									</p>
									{focusTask && (
										<span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
											<span
												className="h-1.5 w-1.5 rounded-full"
												style={{ backgroundColor: statusColor(focusTask.status, config.statusColors) }}
											/>
											{formatStatus(focusTask.status)}
										</span>
									)}
								</div>
								{focusTask ? (
									<div>
										<div className="flex items-start justify-between gap-3">
											<div className="min-w-0">
												<Link
													to="/kanban/$taskId"
													params={{ taskId: focusTask.id }}
													className="line-clamp-2 text-sm font-semibold leading-5 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
												>
													{focusTask.title}
												</Link>
												<p className="mt-1 font-mono text-[10px] text-muted-foreground">#{focusTask.id}</p>
												{isRecommendedFocus && recommendedItem && (
													<p className="mt-2 text-[11px] leading-4 text-muted-foreground">
														Why now: {recommendedItem.reason}
													</p>
												)}
											</div>
											<span className={cn(
												"rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]",
												focusTask.priority === "high"
													? "border-[var(--analysis-error)]/30 text-[var(--analysis-error)]"
													: "border-border text-muted-foreground",
											)}>
												{focusTask.priority}
											</span>
										</div>
										<div className="mt-4 grid grid-cols-2 gap-3 border-y border-border/60 py-3">
											<div>
												<p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Tracked</p>
												<p className="mt-1 text-sm font-medium tabular-nums">{formatDuration(focusSeconds)}</p>
											</div>
											<div>
												<p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Acceptance</p>
												<p className="mt-1 text-sm font-medium tabular-nums">
													{focusTotalAC > 0 ? `${focusCompletedAC}/${focusTotalAC}` : "No ACs"}
												</p>
											</div>
										</div>
										{focusTotalAC > 0 && (
											<Progress
												value={focusProgress}
												className="mt-3 h-1.5"
												aria-label={`Acceptance criteria ${focusProgress}% complete`}
											/>
										)}
										<Button asChild className="mt-4 w-full" size="sm">
											<Link to="/kanban/$taskId" params={{ taskId: focusTask.id }}>
												{isRecommendedFocus ? "Review task" : "Continue task"}
												<ArrowRight />
											</Link>
										</Button>
									</div>
								) : (
									<EmptyState
										icon={CheckCircle2}
										title="No active focus"
										detail="Start a timer or move a task into progress to pin it here."
									/>
								)}
							</div>

							<div className="border-b border-border/60">
								<div className="flex items-center justify-between px-4 pb-2 pt-4">
									<h3 className="text-xs font-semibold">Needs attention</h3>
									<span className="text-[11px] tabular-nums text-muted-foreground">{visibleAttentionItems.length}</span>
								</div>
								{loading ? (
									<div className="space-y-2 px-4 pb-4">
										<Skeleton className="h-12" />
										<Skeleton className="h-12" />
									</div>
								) : visibleAttentionItems.length > 0 ? (
									<ol className="pb-3">
										{visibleAttentionItems.map((item, index) => (
											<li key={item.task.id}>
												<Link
													to="/kanban/$taskId"
													params={{ taskId: item.task.id }}
													className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 px-4 py-2.5 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
												>
													<span className="pt-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
														{String(index + 1).padStart(2, "0")}
													</span>
													<span className="min-w-0">
														<span className="line-clamp-2 text-xs font-medium leading-5">{item.task.title}</span>
														<span className="mt-0.5 block line-clamp-2 text-[10px] leading-4 text-muted-foreground">{item.reason}</span>
													</span>
												</Link>
											</li>
										))}
									</ol>
								) : (
									<p className="px-4 pb-4 text-xs leading-5 text-muted-foreground">
										No blocked, urgent, review-bound, high-priority, or aging tasks match these filters.
									</p>
								)}
							</div>

							<div>
								<div className="flex items-center justify-between px-4 pb-2 pt-4">
									<h3 className="text-xs font-semibold">Recent failures</h3>
									<Link to="/audit" className="text-[11px] text-muted-foreground hover:text-foreground hover:underline">
										Audit trail
									</Link>
								</div>
								{remote.loading && !remote.refreshedAt ? (
									<div className="space-y-2 px-4 pb-4">
										<Skeleton className="h-12" />
										<Skeleton className="h-12" />
									</div>
								) : remote.auditErrors === null && remote.services === null ? (
									<div className="flex items-start gap-2 px-4 pb-4 text-xs leading-5 text-[var(--analysis-risk-text)]">
										<AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
										Failure sources are unavailable.
									</div>
								) : runtimeFailures.length === 0 && (remote.auditErrors?.length ?? 0) === 0 ? (
									<div className="flex items-center gap-2 px-4 pb-4 text-xs text-muted-foreground">
										<CheckCircle2 className="h-4 w-4 text-[var(--analysis-completed)]" />
										No recent runtime or tool failures.
									</div>
								) : (
									<ul className="pb-3">
										{runtimeFailures.slice(0, 2).map((service) => (
											<li key={service.name} className="flex items-start gap-2 px-4 py-2.5">
												<AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--analysis-error)]" />
												<div className="min-w-0">
													<p className="truncate text-xs font-medium">{service.name}</p>
													<p className="mt-0.5 text-[10px] text-muted-foreground">Runtime service reports an error</p>
												</div>
											</li>
										))}
										{remote.auditErrors?.slice(0, Math.max(1, 4 - runtimeFailures.length)).map((event, index) => (
											<li key={`${event.timestamp}-${event.toolName}-${index}`}>
												<Link
													to="/audit"
													className="flex items-start gap-2 px-4 py-2.5 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
												>
													<AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--analysis-error)]" />
													<span className="min-w-0">
														<span className="block truncate text-xs font-medium">{event.toolName}</span>
														<span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
															{event.errorMessage || event.action || event.actionClass} · {formatRelativeTime(event.timestamp)}
														</span>
													</span>
												</Link>
											</li>
										))}
									</ul>
								)}
							</div>
						</SectionCard>

						<div className="mt-3 grid grid-cols-2 gap-2">
							<Link
								to="/tasks"
								className="flex items-center justify-center gap-2 rounded-lg border border-border/70 bg-card px-3 py-2 text-xs font-medium hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<BookOpen className="h-3.5 w-3.5" />
								All tasks
							</Link>
							<Link
								to="/graph"
								className="flex items-center justify-center gap-2 rounded-lg border border-border/70 bg-card px-3 py-2 text-xs font-medium hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<Database className="h-3.5 w-3.5" />
								Knowledge graph
							</Link>
						</div>
					</aside>
				</div>
			</div>
		</div>
	);
}
