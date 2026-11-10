// The default Dashboard widgets. Each one answers one question a person opening Knowns has:
// what am I doing, what needs me, how is it going, what changed, and is anything broken.
// Built on Knowns UI components; the older analytics stay available as optional widgets.
import { Link } from "@tanstack/react-router";
import { AlertCircle, ArrowRight, CheckCircle2, CircleDot, Eye, Inbox, OctagonAlert, Timer } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "@/ui/components/ui/knowns/badge";
import { Chart } from "@/ui/components/ui/knowns/chart/chart";
import { Sparkline } from "@/ui/components/ui/knowns/chart/sparkline";
import { Progress } from "@/ui/components/ui/knowns/progress";
import { NumberTicker } from "@/ui/components/ui/knowns/text-animation/number-ticker";
import { cn } from "@/ui/lib/utils";
import type { Task } from "@/ui/models/task";
import type { AttentionItem, ThroughputBucket } from "./analytics";

/* ----------------------------------------------------------------- shared */

export function Panel({
	title,
	hint,
	action,
	children,
	className,
}: {
	title: string;
	/** One plain sentence on why this panel is here. */
	hint?: string;
	action?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section
			className={cn(
				"min-w-0 rounded-xl bg-card",
				"shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_10%,transparent),0_1px_2px_rgb(0_0_0/0.05)]",
				className,
			)}
			aria-label={title}
		>
			<header className="px-4 pb-2 pt-4">
				{/* Title and action share one line so the action sits on the title, not beside a wrapped hint. */}
				<div className="flex min-h-6 items-center justify-between gap-3">
					<h2 className="truncate text-sm font-semibold tracking-[-0.01em]">{title}</h2>
					{action}
				</div>
				{hint && <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{hint}</p>}
			</header>
			{children}
		</section>
	);
}

const isInProgress = (t: Task) => t.status.toLowerCase().includes("progress");
const isInReview = (t: Task) => t.status.toLowerCase().includes("review");
const isBlocked = (t: Task) => t.status.toLowerCase() === "blocked";
const isOpen = (t: Task) => !t.archived && t.lifecycleState !== "done" && !t.completedAt;

function acOf(t: Task) {
	const total = t.acceptanceCriteria?.length ?? 0;
	const done = t.acceptanceCriteria?.filter((a) => a.completed).length ?? 0;
	return { total, done };
}

/* ---------------------------------------------------------------- summary */

/** Four numbers a person can act on, each a link to the work behind it. */
export function SummaryStrip({ tasks, doneByDay }: { tasks: Task[]; doneByDay: number[] }) {
	const open = tasks.filter(isOpen);
	const doneThisWeek = doneByDay.reduce((a, b) => a + b, 0);
	const tiles: { label: string; value: number; hint: string; tone: BadgeTone; icon: ReactNode; extra?: ReactNode }[] = [
		{ label: "In progress", value: open.filter(isInProgress).length, hint: "being worked on now", tone: "info", icon: <CircleDot className="h-3.5 w-3.5" /> },
		{ label: "Waiting for review", value: open.filter(isInReview).length, hint: "done, needs a check", tone: "accent", icon: <Eye className="h-3.5 w-3.5" /> },
		{ label: "Blocked", value: open.filter(isBlocked).length, hint: "cannot move until unblocked", tone: "danger", icon: <OctagonAlert className="h-3.5 w-3.5" /> },
		{
			label: "Done this week",
			value: doneThisWeek,
			hint: "completed in the last 7 days",
			tone: "success",
			icon: <CheckCircle2 className="h-3.5 w-3.5" />,
			extra: <Sparkline values={doneByDay} label="Tasks completed per day, last 7 days" area width={72} height={24} />,
		},
	];
	return (
		<div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
			{tiles.map((t) => (
				<Link
					key={t.label}
					to="/kanban"
					className="group rounded-xl bg-card p-4 shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_10%,transparent)] transition-shadow hover:shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_22%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
						<Badge tone={t.tone} size="sm" className="h-5 w-5 justify-center p-0">
							{t.icon}
						</Badge>
						{t.label}
					</div>
					<div className="mt-2 flex items-end justify-between gap-2">
						<NumberTicker value={t.value} className="text-2xl font-semibold tabular-nums" />
						{t.extra}
					</div>
					<p className="mt-1 text-[11px] text-muted-foreground">{t.hint}</p>
				</Link>
			))}
		</div>
	);
}

/* --------------------------------------------------------------- continue */

/** The task with a running timer first, then in-progress work, most recently touched first. */
export function ContinueWorking({
	tasks,
	timedTaskId,
	trackedSeconds,
}: {
	tasks: Task[];
	timedTaskId?: string;
	trackedSeconds: (task: Task) => number;
}) {
	const inProgress = tasks
		.filter((t) => isOpen(t) && (isInProgress(t) || t.id === timedTaskId))
		.sort((a, b) => (a.id === timedTaskId ? -1 : b.id === timedTaskId ? 1 : b.updatedAt.getTime() - a.updatedAt.getTime()))
		.slice(0, 5);
	return (
		<Panel title="Continue working" hint="What is in progress, so you can pick up where you left off.">
			{inProgress.length === 0 ? (
				<p className="px-4 pb-4 text-sm text-muted-foreground">
					Nothing is in progress. Move a task to In Progress on the{" "}
					<Link to="/kanban" className="font-medium text-foreground underline underline-offset-2">
						board
					</Link>{" "}
					to see it here.
				</p>
			) : (
				<ul className="divide-y divide-border/60 pb-1">
					{inProgress.map((task) => {
						const ac = acOf(task);
						const seconds = trackedSeconds(task);
						return (
							<li key={task.id}>
								<Link
									to="/tasks/$taskId"
									params={{ taskId: task.id }}
									className="group flex items-center gap-4 px-4 py-2.5 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
								>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="truncate text-sm font-medium">{task.title}</span>
											{task.id === timedTaskId && (
												<Badge tone="success" size="sm" className="shrink-0">
													<Timer className="h-3 w-3" /> Timer running
												</Badge>
											)}
										</div>
										<div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
											<span className="font-mono">#{task.id}</span>
											{task.assignee && <span>{task.assignee}</span>}
											{seconds > 0 && <span>{formatDuration(seconds)} tracked</span>}
										</div>
									</div>
									{/* Criteria progress sits in its own right-hand column so each row stays two lines tall. */}
									<div className="hidden w-44 shrink-0 sm:block">
										{ac.total > 0 ? (
											<Progress
												value={ac.done}
												max={ac.total}
												size="sm"
												tone="accent"
												aria-label={`${ac.done} of ${ac.total} acceptance criteria done`}
												format={() => `${ac.done}/${ac.total} criteria`}
											/>
										) : (
											<span className="text-[11px] text-muted-foreground">No criteria</span>
										)}
									</div>
									<ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
								</Link>
							</li>
						);
					})}
				</ul>
			)}
		</Panel>
	);
}

function formatDuration(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/* -------------------------------------------------------------- attention */

const REASON_TONE = (reason: string): BadgeTone =>
	/blocked/i.test(reason) ? "danger" : /review/i.test(reason) ? "accent" : /urgent|high/i.test(reason) ? "warning" : "neutral";

export function NeedsAttention({ items }: { items: AttentionItem[] }) {
	return (
		<Panel
			title="Needs your attention"
			hint="Blocked, waiting for review, or important and untouched for a while."
			action={
				items.length > 0 ? (
					<Badge tone="neutral" size="sm" shape="pill" className="tabular-nums">
						{items.length}
					</Badge>
				) : undefined
			}
		>
			{items.length === 0 ? (
				<p className="flex items-center gap-2 px-4 pb-4 text-sm text-muted-foreground">
					<CheckCircle2 className="h-4 w-4 text-[var(--analysis-completed,var(--chart-4))]" /> Nothing needs you right now.
				</p>
			) : (
				<ul className="divide-y divide-border/60 pb-1">
					{items.slice(0, 6).map((item) => (
						<li key={item.task.id}>
							<Link
								to="/tasks/$taskId"
								params={{ taskId: item.task.id }}
								className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
							>
								{/* One line per task: title, then why it needs you, then its id. */}
								<span className="flex min-w-0 flex-1 items-center gap-2">
									<span className="truncate text-sm font-medium">{item.task.title}</span>
									<span className="flex shrink-0 gap-1">
										{item.reason.split(" · ").map((r) => (
											<Badge key={r} tone={REASON_TONE(r)} size="sm">
												{r}
											</Badge>
										))}
									</span>
								</span>
								<span className="shrink-0 font-mono text-[11px] text-muted-foreground">#{item.task.id}</span>
							</Link>
						</li>
					))}
				</ul>
			)}
		</Panel>
	);
}

/* --------------------------------------------------------------- progress */

export function ProgressChart({
	buckets,
	period,
	onPeriodChange,
}: {
	buckets: ThroughputBucket[];
	period: number;
	onPeriodChange: (days: number) => void;
}) {
	const created = buckets.reduce((s, b) => s + b.created, 0);
	const completed = buckets.reduce((s, b) => s + b.completed, 0);
	const sentence =
		created + completed === 0
			? `No tasks were added or finished in the last ${period} days.`
			: `You finished ${completed} and added ${created} task${created === 1 ? "" : "s"} in the last ${period} days. ${
					completed >= created ? "The backlog is shrinking." : "Work is coming in faster than it is finished."
				}`;
	return (
		<Panel
			title="Progress"
			hint={sentence}
			action={
				<div className="flex shrink-0 rounded-md bg-muted p-0.5 text-xs" role="group" aria-label="Time range">
					{[7, 30, 90].map((d) => (
						<button
							key={d}
							type="button"
							aria-pressed={period === d}
							onClick={() => onPeriodChange(d)}
							className={cn(
								"rounded px-2 py-1 tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
								period === d ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
							)}
						>
							{d}d
						</button>
					))}
				</div>
			}
		>
			<div className="px-4 pb-4">
				<Chart
					type="bar"
					label={`Tasks finished and added, last ${period} days`}
					data={buckets.map((b) => ({ when: b.label, completed: b.completed, created: b.created }))}
					x="when"
					series={[
						{ key: "completed", label: "Finished", color: "var(--analysis-completed, var(--chart-4))" },
						{ key: "created", label: "Added", color: "var(--analysis-created, var(--chart-2))" },
					]}
					format={(v) => String(Math.round(v))}
					height={200}
					empty="No tasks were added or finished in this range"
				/>
			</div>
		</Panel>
	);
}

/* ----------------------------------------------------------- review inbox */

export function ReviewInbox({
	proposedMemories,
	decisionsWaiting,
	specCoverage,
}: {
	proposedMemories?: number;
	decisionsWaiting?: number;
	specCoverage?: { linked: number; total: number; percent: number };
}) {
	const rows: { label: string; detail: string; count?: number; to: string; tone: BadgeTone }[] = [
		{
			label: "Memories to review",
			detail: "Facts agents proposed. Accept the true ones so the next session knows them.",
			count: proposedMemories,
			to: "/memory",
			tone: "accent",
		},
		{
			label: "Decisions to review",
			detail: "Proposed project rules waiting for a yes or no.",
			count: decisionsWaiting,
			to: "/decisions",
			tone: "warning",
		},
	];
	const pending = rows.reduce((s, r) => s + (r.count ?? 0), 0);
	return (
		<Panel title="Waiting for you" hint="Knowledge that agents wrote and you have not confirmed yet.">
			{pending === 0 && rows.every((r) => r.count !== undefined) ? (
				<p className="flex items-center gap-2 px-4 pb-3 text-sm text-muted-foreground">
					<Inbox className="h-4 w-4" /> Inbox clear.
				</p>
			) : (
				<ul className="divide-y divide-border/60">
					{rows.map((r) => (
						<li key={r.label}>
							<Link
								to={r.to}
								className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
							>
								<span className="min-w-0 flex-1">
									<span className="block text-sm font-medium">{r.label}</span>
									<span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{r.detail}</span>
								</span>
								<Badge tone={r.count ? r.tone : "neutral"} size="sm" className="shrink-0 tabular-nums">
									{r.count === undefined ? "–" : r.count}
								</Badge>
							</Link>
						</li>
					))}
				</ul>
			)}
			{specCoverage && specCoverage.total > 0 && (
				<div className="border-t border-border/60 px-4 py-3">
					<Progress
						label="Tasks linked to a spec"
						value={specCoverage.linked}
						max={specCoverage.total}
						size="sm"
						tone={specCoverage.percent >= 80 ? "success" : specCoverage.percent >= 50 ? "warning" : "danger"}
						format={() => `${specCoverage.linked}/${specCoverage.total}`}
					/>
				</div>
			)}
		</Panel>
	);
}

/* --------------------------------------------------------------- problems */

export function Problems({
	failures,
}: {
	failures: { key: string; title: string; detail: string; to?: string }[] | null;
}) {
	return (
		<Panel
			title="Problems"
			hint="Errors from the runtime and from agent tool calls."
			action={
				<Link to="/audit" className="shrink-0 text-xs text-muted-foreground hover:text-foreground hover:underline">
					Audit trail
				</Link>
			}
		>
			{failures === null ? (
				<p className="flex items-center gap-2 px-4 pb-4 text-xs text-muted-foreground">
					<AlertCircle className="h-4 w-4" /> Could not load problem sources.
				</p>
			) : failures.length === 0 ? (
				<p className="flex items-center gap-2 px-4 pb-4 text-sm text-muted-foreground">
					<CheckCircle2 className="h-4 w-4 text-[var(--analysis-completed,var(--chart-4))]" /> Everything is running.
				</p>
			) : (
				<ul className="divide-y divide-border/60 pb-1">
					{failures.map((f) => (
						<li key={f.key} className="flex items-start gap-2 px-4 py-2.5">
							<AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--analysis-error,var(--destructive))]" />
							<span className="min-w-0">
								<span className="block truncate text-sm font-medium">{f.title}</span>
								<span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{f.detail}</span>
							</span>
						</li>
					))}
				</ul>
			)}
		</Panel>
	);
}
