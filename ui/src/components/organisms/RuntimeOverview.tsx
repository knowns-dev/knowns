import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Activity,
	AlertTriangle,
	ArrowRight,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Circle,
	Clock,
	RefreshCw,
	Server,
	Settings2,
	Users,
	XCircle,
} from "lucide-react";
import { getRuntimeServices, postRuntimeRetry } from "@/ui/api/client";
import type {
	RuntimeJob,
	RuntimeJobResult,
	RuntimeProjectSnapshot,
	RuntimeRetryJobRef,
	RuntimeService,
} from "@/ui/api/client";
import { useRuntimeMonitor } from "@/ui/hooks/useRuntimeMonitor";
import { cn } from "@/ui/lib/utils";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { FeatureHeader } from "../templates/FeatureHeader";
import { PageContent } from "../templates/PageShell";

type ServiceOperationalState =
	| "attention"
	| "running"
	| "standby"
	| "disabled";

type ServiceFilter = "all" | ServiceOperationalState;

type RuntimeTab = "services" | "activity" | "clients";

// A stuck or backlogged queue can hold hundreds of jobs; the page shows a
// readable head of each list and reports the rest as a count.
const JOB_PREVIEW_LIMIT = 12;

interface ServiceGroupDefinition {
	state: ServiceOperationalState;
	title: string;
	description: string;
	services: RuntimeService[];
}

function timeAgo(value?: string | null) {
	if (!value) return "not yet";
	const diff = Math.max(0, Date.now() - new Date(value).getTime());
	const seconds = Math.floor(diff / 1000);
	if (seconds < 10) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	return `${Math.floor(minutes / 60)}h ago`;
}

function duration(start?: string, end?: string) {
	if (!start || !end) return "—";
	const ms = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function timeUntil(value?: string | null) {
	if (!value) return "soon";
	const diff = new Date(value).getTime() - Date.now();
	if (diff <= 0) return "any moment";
	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h`;
}

// The queue only ever backs off or dead-letters a Qdrant reconcile job
// (runtimequeue.go CompleteJob): every other kind is dropped outright on
// failure and never reappears in the queued list. So any queued job that
// still carries a lastError is one of exactly two cases, and both stamp
// runAfter by a fixed, known offset from the moment it actually failed:
//   - dead-lettered: runAfter = failedAt + 24h (a bookkeeping stamp; dead
//     letters are skipped unconditionally regardless of runAfter)
//   - retrying: runAfter = failedAt + backoff(attempts), backoff doubling
//     each attempt and capped at 5 minutes
// That lets the UI recover the real failure time from data already on the
// wire, without an API change, instead of showing when the job was first
// requested.
const DEAD_LETTER_RUN_AFTER_OFFSET_MS = 24 * 60 * 60 * 1000;

// No per-job "producing version" is on the wire, and the API does not
// expose when the running daemon started — only its current version
// string. So staleness can't be tied to the binary precisely; this reuses
// the queue's own 24h dead-letter bookkeeping window as a deliberately
// conservative proxy: an error frozen for at least that long is flagged as
// possibly outdated rather than silently presented as current. Documented
// as a known limitation, not a precise binary-vs-error comparison.
const DEAD_LETTER_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// The daemon claims one job per scheduling tick, and this page polls every
// few seconds, so catching a ready job with nothing running is the ordinary
// gap between a job arriving and the scheduler picking it up. Calling that a
// stall is the false alarm this panel exists to stop raising. A job still
// ready well past that handoff is a different claim, and only that one earns
// the banner.
const READY_STALL_GRACE_MS = 60 * 1000;

function jobReadySinceMs(job: RuntimeJob) {
	const readyAt = new Date(job.runAfter || job.requestedAt).getTime();
	return Number.isNaN(readyAt) ? Number.NaN : readyAt;
}

function backoffDelayMs(attempts?: number) {
	const attempt = Math.max(1, attempts ?? 1);
	return Math.min(1000 * 2 ** (attempt - 1), 5 * 60 * 1000);
}

function jobFailedAt(job: RuntimeJob): string {
	const runAfterMs = job.runAfter ? new Date(job.runAfter).getTime() : Number.NaN;
	if (Number.isNaN(runAfterMs)) return job.requestedAt;
	const offsetMs = job.deadLetter
		? DEAD_LETTER_RUN_AFTER_OFFSET_MS
		: backoffDelayMs(job.attempts);
	return new Date(runAfterMs - offsetMs).toISOString();
}

function isErrorStale(job: RuntimeJob, now: number) {
	if (!job.deadLetter) return false;
	const failedAt = new Date(jobFailedAt(job)).getTime();
	if (Number.isNaN(failedAt)) return false;
	return now - failedAt > DEAD_LETTER_STALE_AFTER_MS;
}

function projectName(root: string) {
	return root.split(/[\\/]/).filter(Boolean).pop() || root;
}

function detailValue(service: RuntimeService, key: string) {
	const value = service.details?.[key];
	if (value === undefined || value === null || value === "") return "";
	return String(value);
}

function detailIsTrue(service: RuntimeService, key: string) {
	return detailValue(service, key).toLowerCase() === "true";
}

function serviceLastError(service: RuntimeService) {
	return detailValue(service, "last_error") || detailValue(service, "error");
}

function isExternalEmbeddingService(service: RuntimeService) {
	if (service.type !== "embedding") return false;
	const runtimeScope = detailValue(service, "runtime_scope").toLowerCase();
	if (runtimeScope === "external") return true;
	if (runtimeScope === "embedded") return false;
	return Boolean(detailValue(service, "api_base"));
}

function embeddingEndpointLabel(service: RuntimeService) {
	const endpointScope = detailValue(service, "endpoint_scope").toLowerCase();
	if (endpointScope === "remote") return "Remote endpoint";
	if (endpointScope === "local") return "Local endpoint";
	return "External API";
}

function serviceProcessSummary(
	service: RuntimeService,
	state: ServiceOperationalState,
) {
	const processPid = service.pid
		? String(service.pid)
		: detailValue(service, "daemon_pid");
	if (processPid) {
		return `PID ${processPid}${service.port ? ` · :${service.port}` : ""}`;
	}
	if (state === "attention" && detailValue(service, "install_cmd")) {
		return "Install required";
	}
	if (isExternalEmbeddingService(service)) {
		return state === "running"
			? "Active session"
			: embeddingEndpointLabel(service);
	}
	if (state === "running") return "Shared process";
	if (service.type === "embedding") return "Runtime idle";
	return "No process";
}

function serviceOperationalState(
	service: RuntimeService,
): ServiceOperationalState {
	const runningState = detailValue(service, "running_state").toLowerCase();
	const readinessState = detailValue(service, "readiness_state").toLowerCase();
	const installState = detailValue(service, "install_state").toLowerCase();
	const detected = detailIsTrue(service, "detected");
	const hasFailure =
		service.status === "error" ||
		detailIsTrue(service, "degraded") ||
		Boolean(serviceLastError(service)) ||
		runningState === "crashed" ||
		readinessState === "error";

	if (hasFailure || (detected && installState === "not_installed")) {
		return "attention";
	}
	if (service.status === "running") return "running";
	// "warm" describes an embedder that is loaded but idle between requests —
	// distinct from cold/disabled, but only when the service isn't already
	// reporting as running (a loaded, actively-serving embedder must count as
	// active, not standby).
	if (
		service.type === "embedding" &&
		detailValue(service, "activity_state") === "warm"
	) {
		return "standby";
	}
	if (service.status === "disabled" || !service.enabledInConfig) {
		return "disabled";
	}
	return "standby";
}

function serviceStatusLabel(
	service: RuntimeService,
	state: ServiceOperationalState,
) {
	if (state === "attention") {
		return detailValue(service, "install_state") === "not_installed"
			? "Setup needed"
			: "Needs attention";
	}
	if (state === "running") return "Running";
	if (state === "disabled") return "Disabled";
	if (
		isExternalEmbeddingService(service) &&
		detailValue(service, "readiness_state") === "configured"
	) {
		return "Configured";
	}
	return "Standby";
}

function serviceGuidance(
	service: RuntimeService,
	state: ServiceOperationalState,
) {
	const error = serviceLastError(service);
	if (error) return error;
	if (state === "attention") {
		const reason = detailValue(service, "reason");
		return reason === "not_installed"
			? "Detected in this project, but its backend is not installed."
			: "The service cannot reach a ready state. Review its configuration.";
	}
	if (state === "disabled") {
		return "Disabled in project configuration. Enable it only when this project needs it.";
	}
	if (isExternalEmbeddingService(service)) {
		if (state === "running") {
			return "Semantic requests are actively using the configured provider.";
		}
		return (
			detailValue(service, "note") ||
			"Provider and model are configured; no semantic session is active."
		);
	}

	const note = detailValue(service, "note");
	if (note) return note;
	if (service.type === "lsp") {
		const backend = detailValue(service, "backend");
		const language = detailValue(service, "language");
		const installState = detailValue(service, "install_state");
		const detected = detailIsTrue(service, "detected");
		if (state === "running") {
			return `${backend || "Language server"} is serving ${language || "this project"}.`;
		}
		if (installState === "not_installed" && !detected) {
			return "Not detected in this project; install its backend only when needed.";
		}
		return "Installed and available when code intelligence requests it.";
	}
	if (state === "running") return "Process is active and responding.";
	return "Configured, with no dedicated process active right now.";
}

function serviceDetailItems(service: RuntimeService) {
	const keys = [
		["provider", "provider"],
		["model", "model"],
		["dimensions", "dims"],
		["endpoint_scope", "endpoint"],
		["backend", "backend"],
		["language", "language"],
		["version", "version"],
		["mode", "mode"],
		["source", "source"],
	] as const;

	return keys
		.map(([key, label]) => ({ key, label, value: detailValue(service, key) }))
		.filter((item) => item.value)
		.slice(0, 4);
}

function serviceSettingsCategory(service: RuntimeService) {
	if (service.type === "lsp") return "code";
	if (service.type === "cloudflared") return "tunnel";
	if (service.type === "embedding") return "search";
	return "runtime";
}

// The service list always reports every built-in LSP adapter this binary
// ships, whether or not the project uses that language (adapters.go), plus
// cloudflared and embedding — 16 + 2 regardless of project. A project can
// only ever "reach" the LSP adapters it actually has a matching language
// for (marked `detected`); non-LSP services are always relevant. Counting
// against the full fixed list makes "0/18" the normal steady state for any
// project that isn't polyglot, which reads as a fault when it isn't one.
function isReachableService(service: RuntimeService) {
	if (service.type !== "lsp") return true;
	return detailIsTrue(service, "detected");
}

function KindBadge({ kind }: { kind: string }) {
	return (
		<span className="inline-flex shrink-0 items-center rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
			{kind}
		</span>
	);
}

function RuntimeEmptyState({
	icon: Icon,
	title,
	description,
}: {
	icon: typeof Activity;
	title: string;
	description: string;
}) {
	return (
		<div className="flex items-start gap-3 px-4 py-5">
			<div className="mt-0.5 rounded-md bg-muted p-2">
				<Icon className="size-4 text-muted-foreground" aria-hidden="true" />
			</div>
			<div>
				<p className="text-sm font-medium">{title}</p>
				<p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
					{description}
				</p>
			</div>
		</div>
	);
}

function ServiceStateBadge({
	service,
	state,
}: {
	service: RuntimeService;
	state: ServiceOperationalState;
}) {
	return (
		<span
			className={cn(
				"inline-flex w-fit items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium",
				state === "attention" &&
					"border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
				state === "running" &&
					"border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
				state === "standby" &&
					"border-border bg-muted/45 text-muted-foreground",
				state === "disabled" &&
					"border-border/70 bg-background text-muted-foreground",
			)}
		>
			<Circle
				className={cn(
					"size-1.5 fill-current",
					state === "attention" && "text-amber-500",
					state === "running" && "text-emerald-500",
					(state === "standby" || state === "disabled") &&
						"text-muted-foreground/60",
				)}
				aria-hidden="true"
			/>
			{serviceStatusLabel(service, state)}
		</span>
	);
}

function ServiceRow({ service }: { service: RuntimeService }) {
	const state = serviceOperationalState(service);
	const details = serviceDetailItems(service);
	const installCommand = detailValue(service, "install_cmd");
	const processSummary = serviceProcessSummary(service, state);

	return (
		<article
			className={cn(
				"grid gap-3 px-4 py-2.5 transition-colors hover:bg-muted/25 md:grid-cols-[minmax(12rem,1.05fr)_9rem_10rem_minmax(14rem,1.25fr)_auto] md:items-center",
				state === "disabled" && "opacity-70",
			)}
		>
			<div className="min-w-0">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate text-sm font-semibold" title={service.name}>
						{service.name}
					</span>
					<span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
						{service.type}
					</span>
				</div>
				<p className="mt-1 text-xs leading-5 text-muted-foreground md:hidden">
					{serviceGuidance(service, state)}
				</p>
			</div>

			<ServiceStateBadge service={service} state={state} />

			<div className="text-xs text-muted-foreground">
				<div className="font-mono tabular-nums text-foreground/85">
					{processSummary}
				</div>
				{service.uptime && <div className="mt-1">Up {service.uptime}</div>}
			</div>

			<div className="hidden min-w-0 md:block">
				<p
					className={cn(
						"truncate text-xs text-muted-foreground",
						state === "attention" &&
							"text-amber-700 dark:text-amber-300",
					)}
					title={serviceGuidance(service, state)}
				>
					{serviceGuidance(service, state)}
				</p>
				{details.length > 0 && (state === "attention" || state === "running") && (
					<div className="mt-1.5 flex min-w-0 flex-wrap gap-x-2 gap-y-1">
						{details.map((item) => (
							<span
								key={item.key}
								className="max-w-44 truncate font-mono text-[10px] text-muted-foreground/75"
								title={`${item.label}=${item.value}`}
							>
								{item.label}={item.value}
							</span>
						))}
					</div>
				)}
				{state === "attention" && installCommand && (
					<div
						className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground"
						title={installCommand}
					>
						{installCommand}
					</div>
				)}
			</div>

			<Button
				asChild
				variant="ghost"
				size="sm"
				className="h-8 w-fit gap-1 px-2 text-xs md:justify-self-end"
			>
				<Link
					to="/config"
					search={{ category: serviceSettingsCategory(service) }}
					aria-label={`Configure ${service.name}`}
				>
					Configure
					<ArrowRight className="size-3.5" aria-hidden="true" />
				</Link>
			</Button>
		</article>
	);
}

function ServiceGroup({
	group,
	soleGroup,
}: {
	group: ServiceGroupDefinition;
	soleGroup: boolean;
}) {
	// Standby/disabled services are the long tail (often 15+ rows) and rarely the
	// reason someone opens this page, so they stay folded until asked for —
	// unless they are all this filter has to show.
	const openByDefault =
		soleGroup || group.state === "attention" || group.state === "running";
	return (
		<details className="group/svc" open={openByDefault} aria-label={group.title}>
			<summary className="flex cursor-pointer list-none items-center gap-2 border-b border-border/45 bg-muted/15 px-4 py-2 transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
				<ChevronRight
					className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/svc:rotate-90 motion-reduce:transition-none"
					aria-hidden="true"
				/>
				<h3 className="text-xs font-semibold">{group.title}</h3>
				<p className="hidden min-w-0 truncate text-[11px] text-muted-foreground sm:block">
					{group.description}
				</p>
				<span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
					{group.services.length}
				</span>
			</summary>
			<div className="divide-y divide-border/45">
				{group.services.map((service) => (
					<ServiceRow
						key={`${service.type}-${service.name}`}
						service={service}
					/>
				))}
			</div>
		</details>
	);
}

type JobLifecycleState = "running" | "ready" | "retrying" | "dead";

// A running or queued job paired with the project it belongs to — the unit
// the Activity tab groups, retries, and renders throughout.
type JobEntry = { job: RuntimeJob; project: RuntimeProjectSnapshot };

// One distinct failure cause (same job kind + same message), with the jobs
// it accounts for and the projects it spans. `key` is stable across renders
// and doubles as the React list key and the in-flight retry identifier.
interface JobFailureGroup {
	key: string;
	kind: string;
	message: string;
	count: number;
	mostRecentFailedAt: string;
	allStale: boolean;
	bucket: "dead" | "retrying";
	entries: JobEntry[];
	projects: Array<{ root: string; count: number }>;
}

function JobStateBadge({ state }: { state: JobLifecycleState }) {
	const label =
		state === "running"
			? "Active"
			: state === "dead"
				? "Failed permanently"
				: state === "retrying"
					? "Retrying"
					: "Waiting";
	return (
		<span
			className={cn(
				"inline-flex w-fit shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-medium",
				state === "running" &&
					"border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
				state === "dead" &&
					"border-destructive/30 bg-destructive/10 text-destructive",
				state === "retrying" &&
					"border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
				state === "ready" &&
					"border-border bg-muted/45 text-muted-foreground",
			)}
		>
			<Circle
				className={cn(
					"size-1.5 fill-current",
					state === "running" && "text-emerald-500",
					state === "dead" && "text-destructive",
					state === "retrying" && "text-amber-500",
					state === "ready" && "text-muted-foreground/60",
				)}
				aria-hidden="true"
			/>
			{label}
		</span>
	);
}

function JobRow({
	job,
	project,
	state,
}: {
	job: RuntimeJob;
	project: RuntimeProjectSnapshot;
	state: JobLifecycleState;
}) {
	const hasProgress =
		typeof job.processed === "number" &&
		typeof job.total === "number" &&
		job.total > 0;
	const progress = hasProgress
		? Math.min(
				100,
				Math.round(((job.processed ?? 0) / (job.total ?? 1)) * 100),
			)
		: 0;
	const stale = state === "dead" && isErrorStale(job, Date.now());

	return (
		<div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/25">
			<KindBadge kind={job.kind} />
			<div className="min-w-0">
				<div className="truncate text-sm" title={job.target || project.root}>
					{job.target || projectName(project.root)}
				</div>
				<div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
					<span className="truncate">
						{job.phase || projectName(project.root)}
					</span>
					{hasProgress && (
						<span className="shrink-0 tabular-nums">
							{job.processed}/{job.total}
						</span>
					)}
				</div>
				{hasProgress && (
					<div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
						<div
							className="h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
							style={{ width: `${progress}%` }}
						/>
					</div>
				)}
				{job.lastError ? (
					<p
						className={cn(
							"mt-1 truncate text-[11px]",
							stale ? "text-muted-foreground italic" : "text-destructive",
						)}
						title={
							stale
								? "Recorded before the currently running build; may no longer reproduce."
								: job.lastError
						}
					>
						{job.lastError}
						{stale ? " (stale)" : ""}
					</p>
				) : (
					state === "dead" && (
						<p className="mt-1 text-[11px] italic text-muted-foreground">
							No error message recorded.
						</p>
					)
				)}
			</div>
			<div className="flex flex-col items-end gap-1">
				<JobStateBadge state={state} />
				<div className="flex items-center gap-1 text-[11px] text-muted-foreground">
					<Clock className="size-3" aria-hidden="true" />
					{state === "running"
						? "active"
						: state === "retrying"
							? `retry in ${timeUntil(job.runAfter)}`
							: state === "dead"
								? `failed ${timeAgo(jobFailedAt(job))}`
								: timeAgo(job.requestedAt)}
				</div>
			</div>
		</div>
	);
}

function RecentRow({ job }: { job: RuntimeJobResult }) {
	const [open, setOpen] = useState(false);
	const hasDetails = Boolean(
		job.details?.stats || job.details?.phase || job.error,
	);

	return (
		<div>
			<button
				type="button"
				className={cn(
					"grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left",
					hasDetails &&
						"hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
				)}
				onClick={() => hasDetails && setOpen((current) => !current)}
				aria-expanded={hasDetails ? open : undefined}
			>
				{job.success ? (
					<CheckCircle2
						className="size-3.5 text-emerald-500"
						aria-label="Succeeded"
					/>
				) : (
					<XCircle
						className="size-3.5 text-destructive"
						aria-label="Failed"
					/>
				)}
				<KindBadge kind={job.kind} />
				<div className="min-w-0">
					<div className="truncate text-xs" title={job.target || job.key}>
						{job.target || job.key}
					</div>
					{job.error && !open && (
						<div className="truncate text-[11px] text-destructive">
							{job.error}
						</div>
					)}
				</div>
				<div className="flex items-center gap-1 font-mono text-[11px] tabular-nums text-muted-foreground">
					{duration(job.startedAt, job.completedAt)}
					{hasDetails &&
						(open ? (
							<ChevronDown className="size-3" />
						) : (
							<ChevronRight className="size-3" />
						))}
				</div>
			</button>
			{open && (
				<div className="space-y-1 bg-muted/25 px-4 py-3 pl-12 text-[11px] text-muted-foreground">
					<div>Completed {timeAgo(job.completedAt)}</div>
					{job.attemptCount > 1 && <div>Attempts: {job.attemptCount}</div>}
					{job.details?.phase && <div>Final phase: {job.details.phase}</div>}
					{job.details?.processed !== undefined &&
						job.details?.total !== undefined && (
							<div>
								Progress: {job.details.processed}/{job.details.total}
							</div>
						)}
					{job.error && <div className="text-destructive">{job.error}</div>}
					{job.details?.stats &&
						Object.entries(job.details.stats).map(([key, value]) => (
							<div key={key} className="capitalize">
								{key}: {value.toLocaleString()}
							</div>
						))}
				</div>
			)}
		</div>
	);
}

function RuntimeListSkeleton({ rows = 3 }: { rows?: number }) {
	return (
		<div className="space-y-5 px-4 py-5" aria-hidden="true">
			{Array.from({ length: rows }).map((_, index) => (
				<div key={index} className="flex items-center gap-3">
					<Skeleton className="size-3 rounded-full" />
					<div className="flex-1 space-y-2">
						<Skeleton className="h-3 w-2/3" />
						<Skeleton className="h-2.5 w-1/2" />
					</div>
				</div>
			))}
		</div>
	);
}

function SummaryFact({
	label,
	value,
	detail,
}: {
	label: string;
	value: string | number;
	detail: string;
}) {
	return (
		<div className="min-w-0 bg-card px-4 py-3">
			<dt className="text-xs font-medium text-muted-foreground">{label}</dt>
			<dd className="mt-1 flex items-baseline gap-2">
				<span className="text-xl font-semibold tabular-nums">{value}</span>
				<span className="truncate text-[11px] text-muted-foreground">
					{detail}
				</span>
			</dd>
		</div>
	);
}

export function RuntimeOverview() {
	const {
		data,
		error: runtimeError,
		isLoading,
		isRefreshing,
		lastUpdatedAt,
		refresh,
		totalActive,
	} = useRuntimeMonitor();
	const [services, setServices] = useState<RuntimeService[]>([]);
	const [servicesLoading, setServicesLoading] = useState(true);
	const [servicesRefreshing, setServicesRefreshing] = useState(false);
	const [servicesError, setServicesError] = useState<string | null>(null);
	const [servicesUpdatedAt, setServicesUpdatedAt] = useState<string | null>(null);
	const [serviceFilter, setServiceFilter] = useState<ServiceFilter>("all");
	const [tab, setTab] = useState<RuntimeTab>("services");
	// The key of the in-flight retry request — "all" for the recovery
	// banner's bulk action, or a cause's own key for a per-cause retry. Only
	// one retry runs at a time so a second click can't race the first.
	const [retryingKey, setRetryingKey] = useState<string | null>(null);
	const [retryError, setRetryError] = useState<string | null>(null);

	const loadServices = useCallback(async () => {
		setServicesRefreshing(true);
		try {
			const response = await getRuntimeServices();
			setServices(response.services ?? []);
			setServicesError(null);
			setServicesUpdatedAt(new Date().toISOString());
		} catch (error) {
			setServicesError(
				error instanceof Error
					? error.message
					: "Managed services could not be loaded.",
			);
		} finally {
			setServicesLoading(false);
			setServicesRefreshing(false);
		}
	}, []);

	useEffect(() => {
		void loadServices();
		const interval = window.setInterval(loadServices, 7000);
		return () => window.clearInterval(interval);
	}, [loadServices]);

	// A queued job collapses three distinct backend states into one label if
	// treated as a single bucket: ready to run now, waiting out a retry
	// backoff, or dead-lettered (permanently skipped by the scheduler,
	// runtimequeue.go). Only a job with nothing ready and nothing running is
	// an actual stall — a backlog that is only retrying or only dead is not.
	const jobBuckets = useMemo(() => {
		const now = Date.now();
		const running: JobEntry[] = [];
		const ready: JobEntry[] = [];
		const retrying: JobEntry[] = [];
		const dead: JobEntry[] = [];
		for (const project of data?.projects ?? []) {
			for (const job of project.running ?? []) running.push({ job, project });
			for (const job of project.queued ?? []) {
				const entry: JobEntry = { job, project };
				if (job.deadLetter) dead.push(entry);
				else if (job.runAfter && new Date(job.runAfter).getTime() > now)
					retrying.push(entry);
				else ready.push(entry);
			}
		}
		return { running, ready, retrying, dead };
	}, [data]);
	const runningJobs = jobBuckets.running;
	const readyJobs = jobBuckets.ready;
	// Ready long enough that the scheduler should already have claimed it.
	const stalledReadyJobs = useMemo(() => {
		const cutoff = Date.now() - READY_STALL_GRACE_MS;
		return readyJobs.filter(({ job }) => {
			const readyAt = jobReadySinceMs(job);
			return Number.isNaN(readyAt) || readyAt <= cutoff;
		});
	}, [readyJobs]);
	const retryingJobs = jobBuckets.retrying;
	const deadJobs = jobBuckets.dead;
	const queuedJobs = useMemo(
		() => [...readyJobs, ...retryingJobs, ...deadJobs],
		[readyJobs, retryingJobs, deadJobs],
	);
	const recentJobs = useMemo(
		() =>
			data?.projects
				?.flatMap((project) => project.recent ?? [])
				.sort(
					(a, b) =>
						new Date(b.completedAt).getTime() -
						new Date(a.completedAt).getTime(),
				)
				.slice(0, 10) ?? [],
		[data],
	);
	const clients = data?.status.clients ?? [];
	const runtimeRunning = Boolean(data?.status.running);
	const loading = isLoading && !data;

	const servicesByState = useMemo(() => {
		const buckets: Record<ServiceOperationalState, RuntimeService[]> = {
			attention: [],
			running: [],
			standby: [],
			disabled: [],
		};
		for (const service of services) {
			buckets[serviceOperationalState(service)].push(service);
		}
		for (const bucket of Object.values(buckets)) {
			bucket.sort((a, b) => a.name.localeCompare(b.name));
		}
		return buckets;
	}, [services]);

	const serviceGroups = useMemo<ServiceGroupDefinition[]>(
		() =>
			[
				{
					state: "attention" as const,
					title: "Needs attention",
					description: "Detected services with a missing backend or a reported failure.",
					services: servicesByState.attention,
				},
				{
					state: "running" as const,
					title: "Running now",
					description: "Processes actively serving this workspace.",
					services: servicesByState.running,
				},
				{
					state: "standby" as const,
					title: "Not active",
					description: "Ready-on-demand services and optional backends this project does not currently need.",
					services: servicesByState.standby,
				},
				{
					state: "disabled" as const,
					title: "Disabled",
					description: "Optional services intentionally kept out of the runtime.",
					services: servicesByState.disabled,
				},
			]
				.filter((group) => group.services.length > 0)
				.filter(
					(group) => serviceFilter === "all" || group.state === serviceFilter,
				),
		[serviceFilter, servicesByState],
	);

	// Queue backlogs repeat the same failure verbatim across every job, so the
	// activity view groups by (kind, message) and reports a count instead. A
	// dead-lettered job can carry no captured error at all — it is still
	// grouped here (rather than silently dropped) so the count stays
	// accounted for. Recency is derived per-job (jobFailedAt), not the
	// request time, and groups are labeled by bucket so "retrying" and
	// "failed permanently" are never conflated under one badge.
	const jobFailures = useMemo<JobFailureGroup[]>(() => {
		const now = Date.now();
		const groups = new Map<
			string,
			Omit<JobFailureGroup, "projects"> & { projectCounts: Map<string, number> }
		>();
		for (const bucket of ["dead", "retrying"] as const) {
			for (const entry of bucket === "dead" ? deadJobs : retryingJobs) {
				const { job, project } = entry;
				if (bucket === "retrying" && !job.lastError) continue;
				const message = job.lastError || "No error message recorded";
				const key = `${bucket}::${job.kind}::${message}`;
				const failedAt = jobFailedAt(job);
				const stale = bucket === "dead" && isErrorStale(job, now);
				let group = groups.get(key);
				if (!group) {
					group = {
						key,
						kind: job.kind,
						message,
						count: 0,
						mostRecentFailedAt: failedAt,
						allStale: true,
						bucket,
						entries: [],
						projectCounts: new Map(),
					};
					groups.set(key, group);
				}
				group.count += 1;
				if (failedAt > group.mostRecentFailedAt)
					group.mostRecentFailedAt = failedAt;
				group.allStale = group.allStale && stale;
				group.entries.push(entry);
				group.projectCounts.set(
					project.root,
					(group.projectCounts.get(project.root) ?? 0) + 1,
				);
			}
		}
		return [...groups.values()]
			.map(({ projectCounts, ...group }): JobFailureGroup => {
				// Busiest project first — the same rule the causes themselves
				// are sorted by, so "knowns +4" always names the project the
				// cause hit hardest.
				const projects = [...projectCounts.entries()]
					.map(([root, count]) => ({ root, count }))
					.sort((a, b) => b.count - a.count);
				return { ...group, projects };
			})
			.sort((a, b) => b.count - a.count);
	}, [deadJobs, retryingJobs]);
	const newestJobFailure = useMemo(
		() =>
			jobFailures.reduce<(typeof jobFailures)[number] | undefined>(
				(newest, failure) =>
					!newest || failure.mostRecentFailedAt > newest.mostRecentFailedAt
						? failure
						: newest,
				undefined,
			),
		[jobFailures],
	);

	// How many distinct projects a permanently-failed backlog touches, and
	// how long the oldest of those failures has been sitting there — the two
	// facts the recovery banner leads with (AC1).
	const deadProjectCount = useMemo(() => {
		const roots = new Set<string>();
		for (const { project } of deadJobs) roots.add(project.root);
		return roots.size;
	}, [deadJobs]);
	const oldestDeadFailedAt = useMemo(() => {
		let oldest: string | null = null;
		for (const { job } of deadJobs) {
			const failedAt = jobFailedAt(job);
			if (!oldest || failedAt < oldest) oldest = failedAt;
		}
		return oldest;
	}, [deadJobs]);

	// Both the "Retry all" banner action and a per-cause "Retry" button post
	// to the same endpoint and then re-fetch rather than guess the result —
	// a bulk release can touch jobs the client never separately enumerated.
	const runRetry = useCallback(
		async (
			key: string,
			request: { scope: "all" } | { scope: "jobs"; jobs: RuntimeRetryJobRef[] },
		) => {
			setRetryingKey(key);
			setRetryError(null);
			try {
				await postRuntimeRetry(request);
				await refresh();
			} catch (error) {
				setRetryError(
					error instanceof Error ? error.message : "Retry request failed.",
				);
			} finally {
				setRetryingKey(null);
			}
		},
		[refresh],
	);
	const handleRetryAll = useCallback(
		() => runRetry("all", { scope: "all" }),
		[runRetry],
	);
	const handleRetryCause = useCallback(
		(failure: JobFailureGroup) =>
			runRetry(failure.key, {
				scope: "jobs",
				jobs: failure.entries.map(({ job, project }) => ({
					projectRoot: project.root,
					jobId: job.id,
				})),
			}),
		[runRetry],
	);

	const attentionCount = servicesByState.attention.length;
	const runningServiceCount = servicesByState.running.length;
	const standbyCount = servicesByState.standby.length;
	const disabledCount = servicesByState.disabled.length;
	const initialUnavailable = !loading && !data && services.length === 0;
	const reachableServiceCount = useMemo(
		() => services.filter(isReachableService).length,
		[services],
	);

	const posture = useMemo(() => {
		if (loading || servicesLoading) {
			return {
				title: "Checking runtime",
				description:
					"Reading daemon health, managed services, and background work.",
				tone: "neutral" as const,
			};
		}
		if (initialUnavailable) {
			return {
				title: "Runtime status unavailable",
				description:
					"Live status could not be read. Retry without losing the last successful snapshot.",
				tone: "offline" as const,
			};
		}
		if (!runtimeRunning) {
			return {
				title: "Runtime daemon is offline",
				description:
					"Background work cannot start until the Knowns runtime is available again.",
				tone: "offline" as const,
			};
		}
		if (attentionCount > 0) {
			return {
				title: "Action required",
				description: `${attentionCount} ${attentionCount === 1 ? "service needs" : "services need"} setup or recovery. ${runningServiceCount} ${runningServiceCount === 1 ? "service is" : "services are"} active now.`,
				tone: "attention" as const,
			};
		}
		// A backlog that is only dead letters will never drain on its own — the
		// scheduler skips them unconditionally — so it reads as a past failure
		// with a recovery action, not as a stall in progress.
		if (
			deadJobs.length > 0 &&
			readyJobs.length === 0 &&
			retryingJobs.length === 0 &&
			runningJobs.length === 0
		) {
			return {
				title: "Past failures need recovery",
				description: `${deadJobs.length} ${deadJobs.length === 1 ? "job" : "jobs"} failed permanently and will not be retried automatically.`,
				tone: "attention" as const,
			};
		}
		// A job that is ready to run right now with nothing running is a real
		// stall, not healthy throughput — the daemon answers health checks while
		// no work actually drains. Jobs still waiting out a retry backoff don't
		// count toward this: that delay is deliberate, not stuck.
		if (stalledReadyJobs.length > 0 && runningJobs.length === 0) {
			return {
				title: "Queue is not draining",
				description: `${stalledReadyJobs.length} ${stalledReadyJobs.length === 1 ? "job has" : "jobs have"} been ready to run for a while and nothing is running.${
					newestJobFailure
						? ` Newest failure: ${newestJobFailure.message}`
						: ""
				}`,
				tone: "attention" as const,
			};
		}
		if (totalActive > 0) {
			return {
				title: "Runtime is working",
				description: `${totalActive} background ${totalActive === 1 ? "job is" : "jobs are"} running or queued across connected projects.`,
				tone: "working" as const,
			};
		}
		return {
			title: "Operational",
			description:
				runningServiceCount > 0
					? `${runningServiceCount} ${runningServiceCount === 1 ? "service is" : "services are"} active. The work queue is clear.`
					: "The daemon is online and ready. No background work is waiting.",
			tone: "healthy" as const,
		};
	}, [
		attentionCount,
		deadJobs.length,
		initialUnavailable,
		loading,
		newestJobFailure,
		readyJobs.length,
		retryingJobs.length,
		runningJobs.length,
		runningServiceCount,
		runtimeRunning,
		servicesLoading,
		stalledReadyJobs.length,
		totalActive,
	]);

	const filterOptions: Array<{
		id: ServiceFilter;
		label: string;
		count: number;
	}> = [
		{ id: "all", label: "All", count: services.length },
		{ id: "attention", label: "Attention", count: attentionCount },
		{ id: "running", label: "Running", count: runningServiceCount },
		{ id: "standby", label: "Inactive", count: standbyCount },
		{ id: "disabled", label: "Disabled", count: disabledCount },
	];

	const handleRefresh = async () => {
		await Promise.all([refresh(), loadServices()]);
	};

	const errors = [runtimeError, servicesError].filter(Boolean) as string[];
	// This page's own last successful fetch — used only for the refresh
	// button's tooltip, not for the Clients tile (see freshestClientHeartbeat
	// below): "the browser last polled" and "a client is still connected" are
	// different facts and were previously shown under the same word.
	const lastSyncedAt = [lastUpdatedAt, servicesUpdatedAt]
		.filter(Boolean)
		.sort()
		.at(-1);

	// The Clients tile previously showed when the browser last polled, which
	// reads as "checked" but really only says the page fetched — not that any
	// client is still there. Each client row already shows its own lease
	// heartbeat (client.updatedAt); the tile should say the same thing.
	const freshestClientHeartbeat = clients.reduce<string | null>(
		(latest, client) =>
			!latest || client.updatedAt > latest ? client.updatedAt : latest,
		null,
	);

	const busy = isRefreshing || servicesRefreshing;
	const headerStatus = loading
		? "checking…"
		: [
				runtimeRunning ? "daemon online" : "daemon offline",
				`${runningServiceCount} ${runningServiceCount === 1 ? "service" : "services"} active`,
				`${totalActive} ${totalActive === 1 ? "job" : "jobs"}`,
			].join(" · ");

	// Only an unhealthy runtime earns space above the fold; a healthy one says so
	// in the header status and gives the room back to the actual lists.
	const alert =
		posture.tone === "attention" || posture.tone === "offline" ? posture : null;

	// The tab badge is a row count for what's rendered in that panel (dead
	// letters included, since they still get their own section) — totalActive
	// deliberately excludes them so the header status above doesn't repeat the
	// "152 jobs queued" overstatement this page used to make.
	const tabs: Array<{ id: RuntimeTab; label: string; count: number }> = [
		{ id: "services", label: "Services", count: services.length },
		{
			id: "activity",
			label: "Activity",
			count: runningJobs.length + queuedJobs.length,
		},
		{ id: "clients", label: "Clients", count: clients.length },
	];

	const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
		const index = tabs.findIndex((entry) => entry.id === tab);
		let nextIndex: number | null = null;
		if (event.key === "ArrowLeft") nextIndex = (index + tabs.length - 1) % tabs.length;
		else if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
		else if (event.key === "Home") nextIndex = 0;
		else if (event.key === "End") nextIndex = tabs.length - 1;
		if (nextIndex === null) return;
		event.preventDefault();
		const next = tabs[nextIndex];
		if (!next) return;
		setTab(next.id);
		document.getElementById(`runtime-tab-${next.id}`)?.focus();
	};

	return (
		<>
			<FeatureHeader
				icon={Activity}
				title="Runtime"
				status={headerStatus}
				actions={
					<>
						<Button asChild variant="outline" size="sm" className="h-11 gap-1.5 sm:h-8">
							<Link to="/config" search={{ category: "runtime" }}>
								<Settings2 className="h-4 w-4" aria-hidden="true" />
								Settings
							</Link>
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-11 gap-1.5 sm:h-8"
							onClick={() => void handleRefresh()}
							disabled={busy}
							aria-busy={busy}
							aria-label="Refresh runtime status"
							title={lastSyncedAt ? `Page last synced ${timeAgo(lastSyncedAt)}` : undefined}
						>
							<RefreshCw
								className={cn("h-4 w-4", busy && "animate-spin motion-reduce:animate-none")}
								aria-hidden="true"
							/>
							{busy ? "Refreshing" : "Refresh"}
						</Button>
					</>
				}
			/>

			<PageContent
				size="full"
				className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden"
				data-testid="runtime-page-overview"
			>
				{errors.length > 0 && (
					<div
						className="flex shrink-0 items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
						role="alert"
					>
						<AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
						<div className="min-w-0 flex-1">
							<p className="font-medium">Live status is partially unavailable</p>
							<p className="mt-0.5 text-xs leading-5 text-muted-foreground">
								{errors.join(" ")} Existing values remain visible until a refresh succeeds.
							</p>
						</div>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-7 shrink-0 px-2 text-xs"
							onClick={() => void handleRefresh()}
						>
							Retry
						</Button>
					</div>
				)}

				{alert && (
					<div
						role="status"
						data-testid="runtime-operational-posture"
						className={cn(
							"flex shrink-0 flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-start",
							alert.tone === "offline"
								? "border-destructive/30 bg-destructive/5"
								: "border-amber-500/30 bg-amber-500/5",
						)}
					>
						<AlertTriangle
							className={cn(
								"mt-0.5 size-4 shrink-0",
								alert.tone === "offline" ? "text-destructive" : "text-amber-600 dark:text-amber-400",
							)}
							aria-hidden="true"
						/>
						<div className="min-w-0 flex-1">
							<p className="text-sm font-semibold">{alert.title}</p>
							<p className="mt-0.5 text-xs leading-5 text-muted-foreground">
								{alert.description}
							</p>
						</div>
						{attentionCount > 0 ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="h-8 shrink-0 self-start text-xs"
								onClick={() => {
									setTab("services");
									setServiceFilter("attention");
								}}
							>
								Show {attentionCount} {attentionCount === 1 ? "service" : "services"}
							</Button>
						) : deadJobs.length > 0 && tab !== "activity" ? (
							// The Activity tab owns recovery now, so the banner hands the
							// reader over to it instead of restating the CLI command beside
							// a button that already does the work.
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="h-8 shrink-0 self-start text-xs"
								onClick={() => setTab("activity")}
							>
								Show failures
							</Button>
						) : null}
					</div>
				)}

				<dl className="grid shrink-0 grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
					<SummaryFact
						label="Daemon"
						value={loading ? "—" : runtimeRunning ? "Online" : "Offline"}
						detail={data?.status.version ? `v${data.status.version}` : "scheduler"}
					/>
					<SummaryFact
						label="Services"
						value={`${runningServiceCount}/${reachableServiceCount}`}
						detail={attentionCount > 0 ? `${attentionCount} need setup` : "active now"}
					/>
					<SummaryFact
						label="Queue"
						value={readyJobs.length}
						detail={[
							`${runningJobs.length} running`,
							retryingJobs.length > 0 ? `${retryingJobs.length} retrying` : null,
							deadJobs.length > 0 ? `${deadJobs.length} failed` : null,
						]
							.filter(Boolean)
							.join(" · ")}
					/>
					<SummaryFact
						label="Clients"
						value={clients.length}
						detail={
							clients.length > 0
								? `heartbeat ${timeAgo(freshestClientHeartbeat)}`
								: "none attached"
						}
					/>
				</dl>

				<div role="tablist" aria-label="Runtime views" className="flex shrink-0 gap-1 border-b">
					{tabs.map((entry) => (
						<button
							key={entry.id}
							type="button"
							id={`runtime-tab-${entry.id}`}
							role="tab"
							aria-selected={tab === entry.id}
							aria-controls={`runtime-panel-${entry.id}`}
							tabIndex={tab === entry.id ? 0 : -1}
							onClick={() => setTab(entry.id)}
							onKeyDown={handleTabKeyDown}
							className={cn(
								"flex min-h-11 items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition-colors",
								tab === entry.id
									? "border-primary text-primary"
									: "border-transparent text-muted-foreground hover:text-foreground",
							)}
						>
							{entry.label}
							<span className="font-mono text-[11px] tabular-nums text-muted-foreground">
								{entry.count}
							</span>
						</button>
					))}
				</div>

				{tab === "services" && (
					<section
						id="runtime-panel-services"
						role="tabpanel"
						aria-labelledby="runtime-tab-services"
						className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card"
						data-testid="runtime-service-fleet"
					>
						<div className="flex shrink-0 flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
							<p className="text-xs leading-5 text-muted-foreground">
								Prioritized by what needs action, then by what is serving work now.
							</p>
							<div
								className="flex max-w-full gap-1 overflow-x-auto pb-1 [scrollbar-width:none] lg:pb-0 [&::-webkit-scrollbar]:hidden"
								aria-label="Filter managed services"
							>
								{filterOptions.map((option) => {
									const active = serviceFilter === option.id;
									return (
										<button
											key={option.id}
											type="button"
											aria-pressed={active}
											aria-label={`Filter services: ${option.label}`}
											onClick={() => setServiceFilter(option.id)}
											className={cn(
												"inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] motion-reduce:transform-none",
												active
													? "bg-foreground text-background"
													: "text-muted-foreground hover:bg-muted hover:text-foreground",
											)}
										>
											{option.label}
											<span
												className={cn(
													"font-mono text-[10px] tabular-nums",
													active ? "text-background/70" : "text-muted-foreground/70",
												)}
											>
												{option.count}
											</span>
										</button>
									);
								})}
							</div>
						</div>

						<div className="hidden shrink-0 grid-cols-[minmax(12rem,1.05fr)_9rem_10rem_minmax(14rem,1.25fr)_auto] gap-3 border-y border-border/45 bg-muted/15 px-4 py-2 font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground md:grid">
							<span>Service</span>
							<span>State</span>
							<span>Process</span>
							<span>Readiness</span>
							<span className="text-right">Action</span>
						</div>

						{servicesLoading && services.length === 0 ? (
							<RuntimeListSkeleton rows={5} />
						) : services.length === 0 ? (
							<RuntimeEmptyState
								icon={Server}
								title="No managed services reported"
								description="Enable a runtime-backed feature in Settings to add it to this operational view."
							/>
						) : serviceGroups.length > 0 ? (
							<div className="min-h-0 flex-1 overflow-auto border-t border-border/45 md:border-t-0">
								{serviceGroups.map((group) => (
									<ServiceGroup
										key={group.state}
										group={group}
										soleGroup={serviceGroups.length === 1}
									/>
								))}
							</div>
						) : (
							<RuntimeEmptyState
								icon={Server}
								title="No services match this filter"
								description="Choose another state to continue inspecting the runtime fleet."
							/>
						)}
					</section>
				)}

				{tab === "activity" && (
					<section
						id="runtime-panel-activity"
						role="tabpanel"
						aria-labelledby="runtime-tab-activity"
						className="min-h-0 min-w-0 flex-1 space-y-4 overflow-auto"
					>
						{loading ? (
							<div className="overflow-hidden rounded-lg border bg-card">
								<RuntimeListSkeleton rows={2} />
							</div>
						) : (
							<>
								{/* One line for what's wrong and how to recover it, before
								    any list (AC1). A backlog with nothing permanently dead
								    reads as calm, not as an empty version of this same
								    banner (AC10) — it gets a quieter, non-destructive line
								    instead of an alert that has nothing to report. */}
								{deadJobs.length > 0 ? (
									<div className="shrink-0 overflow-hidden rounded-lg border border-destructive/30 bg-destructive/5">
										<div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
											<div className="flex min-w-0 items-start gap-3">
												<AlertTriangle
													className="mt-0.5 size-4 shrink-0 text-destructive"
													aria-hidden="true"
												/>
												<p className="text-sm font-medium">
													{deadJobs.length}{" "}
													{deadJobs.length === 1 ? "job" : "jobs"} failed
													permanently across {deadProjectCount}{" "}
													{deadProjectCount === 1 ? "project" : "projects"}
												</p>
											</div>
											<div className="flex shrink-0 items-center gap-3 self-end sm:self-auto">
												{oldestDeadFailedAt && (
													<span className="whitespace-nowrap text-[11px] text-muted-foreground">
														since {timeAgo(oldestDeadFailedAt)}
													</span>
												)}
												<Button
													type="button"
													variant="outline"
													size="sm"
													className="h-8 shrink-0 text-xs"
													onClick={() => void handleRetryAll()}
													disabled={retryingKey !== null}
													aria-busy={retryingKey === "all"}
												>
													{retryingKey === "all" ? "Retrying…" : "Retry all"}
												</Button>
											</div>
										</div>
										{retryError && (
											<p
												role="alert"
												className="border-t border-destructive/20 px-4 py-2 text-[11px] text-destructive"
											>
												{retryError}
											</p>
										)}
									</div>
								) : (
									<div className="flex shrink-0 items-center gap-3 rounded-lg border bg-card px-4 py-3">
										<CheckCircle2
											className="size-4 shrink-0 text-emerald-500"
											aria-hidden="true"
										/>
										<p className="text-sm text-muted-foreground">
											{jobFailures.length > 0
												? `No permanent failures. ${retryingJobs.length} ${retryingJobs.length === 1 ? "job is" : "jobs are"} waiting out a retry.`
												: "No failures. Background jobs are completing normally."}
										</p>
										{retryError && (
											<p role="alert" className="ml-auto text-[11px] text-destructive">
												{retryError}
											</p>
										)}
									</div>
								)}

								{/* Every distinct cause, one row each, project as a column
								    (AC2, AC3, AC5). A cause expands for its full error text
								    and affected targets, collapsed by default (AC6). */}
								{jobFailures.length > 0 && (
									<CauseTable
										failures={jobFailures}
										onRetry={handleRetryCause}
										retryingKey={retryingKey}
										version={data?.status.version}
									/>
								)}

								{/* Live counts, present but deliberately plain text so they
								    never compete with the failure banner or cause table for
								    attention (AC7). */}
								<div className="shrink-0 px-1 text-xs text-muted-foreground">
									<span className="font-mono tabular-nums text-foreground/80">
										{runningJobs.length}
									</span>{" "}
									running
									<span className="mx-1.5 text-border">·</span>
									<span className="font-mono tabular-nums text-foreground/80">
										{readyJobs.length}
									</span>{" "}
									ready
									<span className="mx-1.5 text-border">·</span>
									<span className="font-mono tabular-nums text-foreground/80">
										{retryingJobs.length}
									</span>{" "}
									retrying
								</div>

								{/* Completed work stays available without occupying the top
								    of the tab, and is collapsed by default (AC8). */}
								{recentJobs.length > 0 && (
									<details className="group/recent shrink-0 overflow-hidden rounded-lg border bg-card">
										<summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
											<ChevronRight
												className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/recent:rotate-90 motion-reduce:transition-none"
												aria-hidden="true"
											/>
											<h3 className="text-xs font-semibold">
												Recent completions
											</h3>
											<span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground">
												{recentJobs.length}
											</span>
										</summary>
										<div className="divide-y divide-border/40 border-t border-border/45">
											{recentJobs.map((job) => (
												<RecentRow key={job.jobId} job={job} />
											))}
										</div>
									</details>
								)}
							</>
						)}
					</section>
				)}

				{tab === "clients" && (
					<section
						id="runtime-panel-clients"
						role="tabpanel"
						aria-labelledby="runtime-tab-clients"
						className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card"
					>
						<p className="shrink-0 border-b border-border/45 px-4 py-3 text-xs leading-5 text-muted-foreground">
							CLI, MCP, and agent processes currently attached to this daemon.
						</p>
						{clients.length > 0 ? (
							<div className="min-h-0 flex-1 divide-y divide-border/40 overflow-auto">
								{clients.map((client) => (
									<div
										key={`${client.clientKind}-${client.projectRoot}-${client.pid}`}
										className="grid gap-1 px-4 py-2.5 text-xs sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-center"
									>
										<span className="font-medium">{client.clientKind}</span>
										<span className="truncate text-muted-foreground" title={client.projectRoot}>
											{projectName(client.projectRoot)}
										</span>
										<span className="font-mono text-[10px] tabular-nums text-muted-foreground">
											pid={client.pid || "?"} · {timeAgo(client.updatedAt)}
										</span>
									</div>
								))}
							</div>
						) : (
							<RuntimeEmptyState
								icon={Users}
								title="No clients attached"
								description="CLI sessions, MCP servers, and agents appear here while they hold a runtime connection."
							/>
						)}
					</section>
				)}
			</PageContent>
		</>
	);
}

function JobSection({
	title,
	jobs,
	state,
	hideHeader = false,
}: {
	title: string;
	jobs: JobEntry[];
	state: JobLifecycleState;
	// A cause's expansion already states its own state badge and count in
	// the row above; repeating "Failed permanently · 86" as a second header
	// right beneath it would say the same thing twice.
	hideHeader?: boolean;
}) {
	return (
		<div>
			{!hideHeader && (
				<div className="flex items-center justify-between border-b border-border/40 bg-muted/15 px-4 py-2 text-[11px] font-medium text-muted-foreground">
					<span>{title}</span>
					<span className="font-mono tabular-nums">{jobs.length}</span>
				</div>
			)}
			<div className="divide-y divide-border/40">
				{jobs.slice(0, JOB_PREVIEW_LIMIT).map(({ job, project }) => (
					<JobRow key={job.id} job={job} project={project} state={state} />
				))}
			</div>
			{jobs.length > JOB_PREVIEW_LIMIT && (
				<p className="border-t border-border/40 px-4 py-2 text-[11px] text-muted-foreground">
					Showing {JOB_PREVIEW_LIMIT} of {jobs.length}.
				</p>
			)}
		</div>
	);
}

// The cause table replaces the old By-project / Failures / per-job-list
// trio: one row per distinct (kind, message) cause, project surfaced as a
// column instead of a separate card, and the individual jobs it accounts
// for live inside the row's own disclosure instead of a permanently visible
// list (AC2, AC3, AC5, AC6).
function CauseTable({
	failures,
	onRetry,
	retryingKey,
	version,
}: {
	failures: JobFailureGroup[];
	onRetry: (failure: JobFailureGroup) => void;
	retryingKey: string | null;
	version?: string;
}) {
	return (
		<div className="overflow-hidden rounded-lg border bg-card">
			<div className="hidden grid-cols-[1.25rem_minmax(0,1fr)_3.5rem_5.5rem_11rem_5.5rem] gap-3 border-b border-border/45 bg-muted/15 px-4 py-2 font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground md:grid">
				<span />
				<span>Cause</span>
				<span className="text-right">Count</span>
				<span>Newest</span>
				<span>Project</span>
				<span className="text-right">Action</span>
			</div>
			<div className="divide-y divide-border/40">
				{failures.map((failure) => (
					<CauseRow
						key={failure.key}
						failure={failure}
						onRetry={onRetry}
						retryingKey={retryingKey}
						version={version}
					/>
				))}
			</div>
		</div>
	);
}

function CauseRow({
	failure,
	onRetry,
	retryingKey,
	version,
}: {
	failure: JobFailureGroup;
	onRetry: (failure: JobFailureGroup) => void;
	retryingKey: string | null;
	version?: string;
}) {
	const isRetrying = retryingKey === failure.key;
	const primaryProject = failure.projects[0];
	const extraProjectCount = failure.projects.length - 1;
	const projectLabel = primaryProject
		? `${projectName(primaryProject.root)}${extraProjectCount > 0 ? ` +${extraProjectCount}` : ""}`
		: "—";
	const projectTitle = failure.projects
		.map((p) => `${projectName(p.root)} (${p.count})`)
		.join(", ");

	return (
		<details className="group/cause">
			<summary className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-4 py-2.5 transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:grid-cols-[1.25rem_minmax(0,1fr)_3.5rem_5.5rem_11rem_5.5rem] md:items-center [&::-webkit-details-marker]:hidden">
				<ChevronRight
					className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open/cause:rotate-90 motion-reduce:transition-none md:mt-0"
					aria-hidden="true"
				/>
				<div className="min-w-0">
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<KindBadge kind={failure.kind} />
						<JobStateBadge
							state={failure.bucket === "dead" ? "dead" : "retrying"}
						/>
						{failure.allStale && (
							<span
								className="shrink-0 rounded-md border border-border bg-muted/45 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
								title={`Recorded before the currently running build${version ? ` (v${version})` : ""}; may no longer reproduce.`}
							>
								Stale
							</span>
						)}
					</div>
					<p className="mt-1 line-clamp-2 text-[11px] leading-5 text-destructive group-open/cause:line-clamp-none">
						{failure.message}
					</p>
					<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground md:hidden">
						<span className="font-mono tabular-nums">{failure.count}×</span>
						<span>newest {timeAgo(failure.mostRecentFailedAt)}</span>
						<span className="truncate" title={projectTitle}>
							{projectLabel}
						</span>
					</div>
				</div>
				<span className="hidden text-right font-mono text-xs tabular-nums text-muted-foreground md:block">
					{failure.count}
				</span>
				<span className="hidden text-xs text-muted-foreground md:block">
					{timeAgo(failure.mostRecentFailedAt)}
				</span>
				<span
					className="hidden min-w-0 truncate text-xs text-muted-foreground md:block"
					title={projectTitle}
				>
					{projectLabel}
				</span>
				<span className="flex items-start justify-end md:items-center">
					{failure.bucket === "dead" && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-7 shrink-0 px-2 text-[11px]"
							onClick={(event) => {
								event.preventDefault();
								event.stopPropagation();
								onRetry(failure);
							}}
							disabled={retryingKey !== null}
							aria-busy={isRetrying}
						>
							{isRetrying ? "Retrying…" : "Retry"}
						</Button>
					)}
				</span>
			</summary>
			<div className="border-t border-border/40 bg-muted/10">
				<JobSection
					title="Affected targets"
					jobs={failure.entries}
					state={failure.bucket === "dead" ? "dead" : "retrying"}
					hideHeader
				/>
			</div>
		</details>
	);
}
