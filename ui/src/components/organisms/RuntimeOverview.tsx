// The Runtime page: what the shared Knowns daemon is running for this workspace (daemon,
// LSP servers, the search index and its embedder, tunnels), what it is working on, and what
// needs a person. Built on Knowns UI: Badge, Card, Tabs, SegmentedControl, Progress and Fold.
import { Link } from "@tanstack/react-router";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	Activity,
	AlertTriangle,
	ArrowRight,
	CheckCircle2,
	ChevronRight,
	CircleDot,
	Clock,
	ListChecks,
	Plug,
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
import { Badge, type BadgeTone } from "../ui/knowns/badge";
import { Button as KnButton, buttonClass } from "../ui/knowns/button";
import { Button } from "../ui/button";
import { Progress } from "../ui/knowns/progress";
import { SegmentedControl } from "../ui/knowns/segmented-control";
import { Skeleton } from "../ui/knowns/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/knowns/tabs";
import { Fold } from "@/ui/lib/knowns/motion";
import { FeatureHeader } from "../templates/FeatureHeader";
import { PageContent, PageError, PageLoading } from "../templates/PageShell";


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
	if (!start || !end) return "-";
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

// When the running daemon started. A daemon that reports it lets staleness be
// exact: an error recorded before the process started came from an earlier
// build. Older daemons do not, and the 24h proxy above stands in.
const DaemonStartedAtContext = createContext<string | undefined>(undefined);

function daemonStartedMs(daemonStartedAt?: string) {
	if (!daemonStartedAt) return Number.NaN;
	return new Date(daemonStartedAt).getTime();
}

function isErrorStale(job: RuntimeJob, now: number, daemonStartedAt?: string) {
	if (!job.deadLetter) return false;
	const failedAt = new Date(jobFailedAt(job)).getTime();
	if (Number.isNaN(failedAt)) return false;
	const startedMs = daemonStartedMs(daemonStartedAt);
	if (!Number.isNaN(startedMs)) return failedAt < startedMs;
	return now - failedAt > DEAD_LETTER_STALE_AFTER_MS;
}

function staleErrorTitle(daemonStartedAt?: string, version?: string) {
	const build = version ? ` (v${version})` : "";
	return Number.isNaN(daemonStartedMs(daemonStartedAt))
		? `Failed more than 24 hours ago; the running build${build} may no longer produce this error.`
		: `Recorded before the running build${build} started; it may no longer reproduce.`;
}

// Every runtime projectRoot is the project's `.knowns` directory, so its last
// segment is always ".knowns" and names nothing: every client, job and failure
// row read as ".knowns" no matter which workspace it belonged to. The workspace
// is the directory that holds it.
function projectPath(root: string) {
	const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
	const segments = root.split(/[\\/]/);
	if (segments[segments.length - 1] === ".knowns") segments.pop();
	const path = segments.join(separator);
	return path === "" || path === separator ? root : path;
}

function projectName(root: string) {
	return projectPath(root).split(/[\\/]/).filter(Boolean).pop() || root;
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


/* ------------------------------------------------------------------ look */

// The same raised surface the Dashboard panels use, so the two operational pages read alike.
const SURFACE =
	"min-w-0 overflow-hidden rounded-xl bg-card shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_10%,transparent),0_1px_2px_rgb(0_0_0/0.05)]";
// Hover is seen many times a day: colour only, fast.
const ROW_HOVER =
	"transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:bg-muted/40";
const FOCUS_INSET =
	"outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const COLUMN_HEAD =
	"font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground";

const SERVICE_TONE: Record<ServiceOperationalState, BadgeTone> = {
	attention: "warning",
	running: "success",
	standby: "neutral",
	disabled: "neutral",
};

const JOB_STATE: Record<JobLifecycleState, { label: string; tone: BadgeTone }> = {
	running: { label: "Active", tone: "info" },
	ready: { label: "Waiting", tone: "neutral" },
	retrying: { label: "Retrying", tone: "warning" },
	dead: { label: "Failed permanently", tone: "danger" },
};

type CalloutTone = "danger" | "warning" | "success" | "neutral";

const CALLOUT_SURFACE: Record<CalloutTone, string> = {
	danger: "border-red-500/25 bg-red-500/[0.06] dark:border-red-400/25 dark:bg-red-500/10",
	warning: "border-amber-500/30 bg-amber-500/[0.07] dark:border-amber-400/25 dark:bg-amber-500/10",
	success: "border-border bg-card",
	neutral: "border-border bg-card",
};

const CALLOUT_ICON: Record<CalloutTone, string> = {
	danger: "text-red-600 dark:text-red-400",
	warning: "text-amber-600 dark:text-amber-400",
	success: "text-emerald-600 dark:text-emerald-400",
	neutral: "text-muted-foreground",
};

/** How long ago the daemon started, as a short uptime ("3h 12m"). */
function uptimeSince(value?: string) {
	if (!value) return "";
	const started = new Date(value).getTime();
	if (Number.isNaN(started)) return "";
	const minutes = Math.floor(Math.max(0, Date.now() - started) / 60000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const plural = (count: number, one: string, many: string) =>
	`${count} ${count === 1 ? one : many}`;

/* ------------------------------------------------------------ primitives */

function KindBadge({ kind }: { kind: string }) {
	return (
		<Badge size="sm" variant="outline" className="shrink-0 font-mono text-[10px] uppercase tracking-wide">
			{kind}
		</Badge>
	);
}

function Callout({
	tone,
	icon,
	title,
	children,
	action,
	role,
	testId,
	className,
}: {
	tone: CalloutTone;
	icon?: ReactNode;
	title: ReactNode;
	children?: ReactNode;
	action?: ReactNode;
	role?: "alert" | "status";
	testId?: string;
	className?: string;
}) {
	return (
		<div
			role={role}
			data-testid={testId}
			className={cn(
				"flex shrink-0 flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-start",
				CALLOUT_SURFACE[tone],
				className,
			)}
		>
			<div className="flex min-w-0 flex-1 items-start gap-3">
				<span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", CALLOUT_ICON[tone])} aria-hidden="true">
					{icon ??
						(tone === "success" ? <CheckCircle2 /> : <AlertTriangle />)}
				</span>
				<div className="min-w-0 flex-1">
					<p className="text-sm font-medium">{title}</p>
					{children && (
						<div className="mt-0.5 text-xs leading-5 text-muted-foreground">
							{children}
						</div>
					)}
				</div>
			</div>
			{action && (
				<div className="flex shrink-0 items-center gap-3 self-end sm:self-start">
					{action}
				</div>
			)}
		</div>
	);
}

function RuntimeEmptyState({
	icon: Icon,
	title,
	description,
	action,
}: {
	icon: typeof Activity;
	title: string;
	description: string;
	action?: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center px-6 py-10 text-center">
			<div className="grid size-10 place-items-center rounded-full bg-muted">
				<Icon className="size-4.5 text-muted-foreground" aria-hidden="true" />
			</div>
			<p className="mt-3 text-sm font-medium">{title}</p>
			<p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
				{description}
			</p>
			{action && <div className="mt-4">{action}</div>}
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

/** A chevron that turns when its region opens. Something already on screen moving: ease-inout. */
function DisclosureChevron({ open, className }: { open: boolean; className?: string }) {
	return (
		<ChevronRight
			className={cn(
				"size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--kn-dur) ease-(--kn-ease-inout) motion-reduce:transition-none",
				open && "rotate-90",
				className,
			)}
			aria-hidden="true"
		/>
	);
}

/* --------------------------------------------------------- health tiles */

function HealthTile({
	label,
	icon,
	tone,
	value,
	detail,
	onSelect,
	selectLabel,
	testId,
}: {
	label: string;
	icon: ReactNode;
	tone: BadgeTone;
	value: ReactNode;
	detail: ReactNode;
	onSelect: () => void;
	selectLabel: string;
	testId?: string;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			aria-label={selectLabel}
			data-testid={testId}
			className={cn(
				"group min-w-0 rounded-xl bg-card p-4 text-left",
				"shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_10%,transparent)] hover:shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_22%,transparent)]",
				"transition-shadow duration-(--kn-dur-fast) ease-(--kn-ease-out) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
			)}
		>
			<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<Badge tone={tone} size="sm" className="h-5 w-5 justify-center p-0 [&_svg]:size-3.5">
					{icon}
				</Badge>
				{label}
			</div>
			<div className="mt-2 truncate text-2xl font-semibold tabular-nums">{value}</div>
			<p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{detail}</p>
		</button>
	);
}

/* --------------------------------------------------------------- services */

function ServiceStateBadge({
	service,
	state,
}: {
	service: RuntimeService;
	state: ServiceOperationalState;
}) {
	return (
		<Badge
			tone={SERVICE_TONE[state]}
			variant={state === "disabled" ? "outline" : "soft"}
			dot
			size="sm"
			className="w-fit shrink-0"
		>
			{serviceStatusLabel(service, state)}
		</Badge>
	);
}

function ServiceRow({ service }: { service: RuntimeService }) {
	const state = serviceOperationalState(service);
	const details = serviceDetailItems(service);
	const installCommand = detailValue(service, "install_cmd");
	const processSummary = serviceProcessSummary(service, state);
	const guidance = serviceGuidance(service, state);

	return (
		<article
			data-service-state={state}
			className={cn(
				"grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 px-4 py-3 @4xl:grid-cols-[minmax(11rem,1fr)_8.5rem_9.5rem_minmax(14rem,1.4fr)_auto] @4xl:items-center @4xl:py-2.5",
				ROW_HOVER,
			)}
		>
			<div className={cn("min-w-0", state === "disabled" && "opacity-70")}>
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate text-sm font-medium" title={service.name}>
						{service.name}
					</span>
					<span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
						{service.type}
					</span>
				</div>
			</div>

			<div className="justify-self-end @4xl:justify-self-start">
				<ServiceStateBadge service={service} state={state} />
			</div>

			<div className="col-span-2 text-xs text-muted-foreground @4xl:col-span-1">
				<span className="font-mono tabular-nums text-foreground/85">{processSummary}</span>
				{service.uptime && (
					<span className="ml-2 @4xl:ml-0 @4xl:mt-0.5 @4xl:block">Up {service.uptime}</span>
				)}
			</div>

			<div className="col-span-2 min-w-0 @4xl:col-span-1">
				<p
					className={cn(
						"text-xs leading-5 text-muted-foreground @4xl:truncate",
						state === "attention" && "text-amber-700 dark:text-amber-300",
					)}
					title={guidance}
				>
					{guidance}
				</p>
				{details.length > 0 && (state === "attention" || state === "running") && (
					<div className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1">
						{details.map((item) => (
							<span
								key={item.key}
								className="max-w-44 truncate font-mono text-[10px] text-muted-foreground/80"
								title={`${item.label}=${item.value}`}
							>
								{item.label}={item.value}
							</span>
						))}
					</div>
				)}
				{state === "attention" && installCommand && (
					<code
						className="mt-1.5 block truncate rounded-md bg-muted px-2 py-1 font-mono text-[10px] text-foreground/80"
						title={installCommand}
					>
						{installCommand}
					</code>
				)}
			</div>

			<Link
				to="/config"
				search={{ category: serviceSettingsCategory(service) }}
				aria-label={`Configure ${service.name}`}
				className={buttonClass(
					"ghost",
					"sm",
					false,
					"col-span-2 -ml-3 w-fit @4xl:col-span-1 @4xl:ml-0 @4xl:justify-self-end",
				)}
			>
				Configure
				<ArrowRight aria-hidden="true" />
			</Link>
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
	const [open, setOpen] = useState(
		soleGroup || group.state === "attention" || group.state === "running",
	);
	const regionId = `runtime-group-${group.state}`;
	return (
		<section aria-label={group.title} data-testid={`runtime-group-${group.state}`}>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={regionId}
				onClick={() => setOpen((current) => !current)}
				className={cn(
					"flex w-full items-center gap-2 border-t border-border/50 bg-muted/25 px-4 py-2 text-left",
					ROW_HOVER,
					FOCUS_INSET,
				)}
			>
				<DisclosureChevron open={open} />
				<h3 className="text-xs font-semibold">{group.title}</h3>
				<p className="hidden min-w-0 truncate text-[11px] text-muted-foreground sm:block">
					{group.description}
				</p>
				<span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
					{group.services.length}
				</span>
			</button>
			<Fold open={open}>
				<div id={regionId} className="divide-y divide-border/50 border-t border-border/50">
					{group.services.map((service) => (
						<ServiceRow key={`${service.type}-${service.name}`} service={service} />
					))}
				</div>
			</Fold>
		</section>
	);
}

/* ------------------------------------------------------------------- jobs */

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
	const meta = JOB_STATE[state];
	return (
		<Badge tone={meta.tone} dot size="sm" className="w-fit shrink-0">
			{meta.label}
		</Badge>
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
	const daemonStartedAt = useContext(DaemonStartedAtContext);
	const stale =
		state === "dead" && isErrorStale(job, Date.now(), daemonStartedAt);

	return (
		<div className={cn("grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]", ROW_HOVER)}>
			<KindBadge kind={job.kind} />
			<div className="min-w-0">
				<div className="truncate text-sm" title={job.target || project.root}>
					{job.target || projectName(project.root)}
				</div>
				<div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
					<span className="truncate">{job.phase || projectName(project.root)}</span>
					{hasProgress && (
						<span className="shrink-0 tabular-nums">
							{job.processed}/{job.total}
						</span>
					)}
				</div>
				{hasProgress && (
					<Progress
						className="mt-2"
						size="sm"
						tone={state === "running" ? "info" : "neutral"}
						value={job.processed ?? 0}
						max={job.total ?? 1}
						valueLabel="none"
						aria-label={`${job.kind} progress`}
					/>
				)}
				{job.lastError ? (
					<p
						className={cn(
							"mt-1 truncate text-[11px]",
							stale ? "italic text-muted-foreground" : "text-red-600 dark:text-red-400",
						)}
						title={stale ? staleErrorTitle(daemonStartedAt) : job.lastError}
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
			<div className="col-start-2 flex flex-wrap items-center gap-2 sm:col-start-3 sm:flex-col sm:items-end sm:gap-1">
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
				<div className="flex items-center justify-between border-b border-border/50 bg-muted/25 px-4 py-2 text-[11px] font-medium text-muted-foreground">
					<span>{title}</span>
					<span className="font-mono tabular-nums">{jobs.length}</span>
				</div>
			)}
			<div className="divide-y divide-border/50">
				{jobs.slice(0, JOB_PREVIEW_LIMIT).map(({ job, project }) => (
					<JobRow key={job.id} job={job} project={project} state={state} />
				))}
			</div>
			{jobs.length > JOB_PREVIEW_LIMIT && (
				<p className="border-t border-border/50 px-4 py-2 text-[11px] text-muted-foreground">
					Showing {JOB_PREVIEW_LIMIT} of {jobs.length}.
				</p>
			)}
		</div>
	);
}

function RecentRow({ job }: { job: RuntimeJobResult }) {
	const [open, setOpen] = useState(false);
	const hasDetails = Boolean(job.details?.stats || job.details?.phase || job.error);
	const Row = hasDetails ? "button" : "div";

	return (
		<div>
			<Row
				{...(hasDetails
					? {
							type: "button" as const,
							onClick: () => setOpen((current) => !current),
							"aria-expanded": open,
						}
					: {})}
				className={cn(
					"grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left",
					hasDetails && cn(ROW_HOVER, FOCUS_INSET),
				)}
			>
				{job.success ? (
					<CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-label="Succeeded" />
				) : (
					<XCircle className="size-3.5 text-red-600 dark:text-red-400" aria-label="Failed" />
				)}
				<KindBadge kind={job.kind} />
				<div className="min-w-0">
					<div className="truncate text-xs" title={job.target || job.key}>
						{job.target || job.key}
					</div>
					{job.error && !open && (
						<div className="truncate text-[11px] text-red-600 dark:text-red-400">{job.error}</div>
					)}
				</div>
				<div className="flex items-center gap-1 font-mono text-[11px] tabular-nums text-muted-foreground">
					{duration(job.startedAt, job.completedAt)}
					{hasDetails && <DisclosureChevron open={open} className="size-3" />}
				</div>
			</Row>
			<Fold open={open}>
				<div className="space-y-1 bg-muted/25 px-4 py-3 pl-12 text-[11px] text-muted-foreground">
					<div>Completed {timeAgo(job.completedAt)}</div>
					{job.attemptCount > 1 && <div>Attempts: {job.attemptCount}</div>}
					{job.details?.phase && <div>Final phase: {job.details.phase}</div>}
					{job.details?.processed !== undefined && job.details?.total !== undefined && (
						<div>
							Progress: {job.details.processed}/{job.details.total}
						</div>
					)}
					{job.error && <div className="text-red-600 dark:text-red-400">{job.error}</div>}
					{job.details?.stats &&
						Object.entries(job.details.stats).map(([key, value]) => (
							<div key={key} className="capitalize">
								{key}: {value.toLocaleString()}
							</div>
						))}
				</div>
			</Fold>
		</div>
	);
}

// The cause table replaces the old By-project / Failures / per-job-list
// trio: one row per distinct (kind, message) cause, project surfaced as a
// column instead of a separate card, and the individual jobs it accounts
// for live inside the row's own disclosure instead of a permanently visible
// list (AC2, AC3, AC5, AC6).
const CAUSE_COLUMNS =
	"@2xl:grid-cols-[minmax(0,1fr)_3.5rem_5.5rem_10rem_5.5rem]";

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
		<section className={cn(SURFACE, "@container")} aria-label="Failure causes" data-testid="runtime-failure-causes">
			<div className={cn("hidden gap-3 border-b border-border/50 bg-muted/25 px-4 py-2 @2xl:grid", CAUSE_COLUMNS, COLUMN_HEAD)}>
				<span className="pl-5.5">Cause</span>
				<span className="text-right">Count</span>
				<span>Newest</span>
				<span>Project</span>
				<span className="text-right">Action</span>
			</div>
			<div className="divide-y divide-border/50">
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
		</section>
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
	const [open, setOpen] = useState(false);
	const daemonStartedAt = useContext(DaemonStartedAtContext);
	const isRetrying = retryingKey === failure.key;
	const primaryProject = failure.projects[0];
	const extraProjectCount = failure.projects.length - 1;
	const projectLabel = primaryProject
		? `${projectName(primaryProject.root)}${extraProjectCount > 0 ? ` +${extraProjectCount}` : ""}`
		: "-";
	const projectTitle = failure.projects
		.map((p) => `${projectName(p.root)} (${p.count})`)
		.join(", ");
	const bucketState = failure.bucket === "dead" ? "dead" : "retrying";

	return (
		<div data-testid="runtime-failure-cause">
			<div className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-4 py-2.5 @2xl:items-center", CAUSE_COLUMNS, ROW_HOVER)}>
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((current) => !current)}
					className={cn("flex min-w-0 items-start gap-2 rounded-md text-left", FOCUS_INSET)}
				>
					<DisclosureChevron open={open} className="mt-1" />
					<span className="min-w-0 flex-1">
						<span className="flex min-w-0 flex-wrap items-center gap-1.5">
							<KindBadge kind={failure.kind} />
							<JobStateBadge state={bucketState} />
							{failure.allStale && (
								<Badge size="sm" variant="outline" title={staleErrorTitle(daemonStartedAt, version)}>
									Stale
								</Badge>
							)}
						</span>
						<span
							className={cn(
								"mt-1 block text-[11px] leading-5 text-red-600 dark:text-red-400",
								!open && "line-clamp-2",
							)}
						>
							{failure.message}
						</span>
						<span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground @2xl:hidden">
							<span className="font-mono tabular-nums">{failure.count}×</span>
							<span>newest {timeAgo(failure.mostRecentFailedAt)}</span>
							<span className="truncate" title={projectTitle}>
								{projectLabel}
							</span>
						</span>
					</span>
				</button>
				<span className="hidden text-right font-mono text-xs tabular-nums text-muted-foreground @2xl:block">
					{failure.count}
				</span>
				<span className="hidden text-xs text-muted-foreground @2xl:block">
					{timeAgo(failure.mostRecentFailedAt)}
				</span>
				<span className="hidden min-w-0 truncate text-xs text-muted-foreground @2xl:block" title={projectTitle}>
					{projectLabel}
				</span>
				<span className="flex justify-end">
					{failure.bucket === "dead" && (
						<KnButton
							variant="secondary"
							size="xs"
							onClick={() => onRetry(failure)}
							disabled={retryingKey !== null && !isRetrying}
							loading={isRetrying}
							aria-label={`Retry ${failure.count} ${failure.kind} ${failure.count === 1 ? "job" : "jobs"}`}
						>
							{isRetrying ? "Retrying" : "Retry"}
						</KnButton>
					)}
				</span>
			</div>
			<Fold open={open}>
				<div className="border-t border-border/50 bg-muted/20">
					<JobSection title="Affected targets" jobs={failure.entries} state={bucketState} hideHeader />
				</div>
			</Fold>
		</div>
	);
}

function RecentCompletions({ jobs }: { jobs: RuntimeJobResult[] }) {
	// Completed work stays available without occupying the top of the tab,
	// and is collapsed by default (AC8).
	const [open, setOpen] = useState(false);
	const failed = jobs.filter((job) => !job.success).length;
	return (
		<section className={SURFACE} aria-label="Recent completions">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
				className={cn("flex w-full items-center gap-2 px-4 py-2.5 text-left", ROW_HOVER, FOCUS_INSET)}
			>
				<DisclosureChevron open={open} />
				<h3 className="text-xs font-semibold">Recent completions</h3>
				{failed > 0 && (
					<Badge tone="danger" size="sm">
						{failed} failed
					</Badge>
				)}
				<span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">{jobs.length}</span>
			</button>
			<Fold open={open}>
				<div className="divide-y divide-border/50 border-t border-border/50">
					{jobs.map((job) => (
						<RecentRow key={job.jobId} job={job} />
					))}
				</div>
			</Fold>
		</section>
	);
}

/* ------------------------------------------------------------------ page */

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
				error instanceof Error ? error.message : "Managed services could not be loaded.",
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
	const daemonStartedAt = data?.status.startedAt;
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
				const stale =
					bucket === "dead" && isErrorStale(job, now, daemonStartedAt);
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
	}, [deadJobs, retryingJobs, daemonStartedAt]);
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

	const daemonDown =
		Boolean(data) && !runtimeRunning && readyJobs.length + retryingJobs.length > 0;

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
		// The daemon exits after a short idle period with no client attached
		// (runtime/queue.ts, DEFAULT_IDLE_TIMEOUT_MS) and starts again on the next
		// write, search or agent. Not running is only a problem while work waits.
		if (daemonDown) {
			return {
				title: "Runtime daemon is offline",
				description: `${readyJobs.length + retryingJobs.length} queued ${readyJobs.length + retryingJobs.length === 1 ? "job is" : "jobs are"} waiting, but the Knowns runtime is not running to pick ${readyJobs.length + retryingJobs.length === 1 ? "it" : "them"} up.`,
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
		if (!runtimeRunning) {
			return {
				title: "Idle",
				description:
					"The daemon starts on demand when a command, search or agent needs it.",
				tone: "healthy" as const,
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
		daemonDown,
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
				runtimeRunning ? "daemon online" : daemonDown ? "daemon offline" : "daemon idle",
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


	const showServiceAttention = () => {
		setTab("services");
		setServiceFilter("attention");
	};

	// Nothing could be read at all: the page has no last snapshot to keep showing.
	const nothingLoaded =
		!isLoading && !servicesLoading && !data && services.length === 0;
	const fullyUnavailable = nothingLoaded && errors.length > 0;
	const firstLoad = isLoading && servicesLoading && !data && services.length === 0;

	const daemonDetail = [
		data?.status.version ? `v${data.status.version}` : null,
		data?.status.pid ? `PID ${data.status.pid}` : null,
		runtimeRunning && daemonStartedAt ? `up ${uptimeSince(daemonStartedAt)}` : null,
	]
		.filter(Boolean)
		.join(" · ");

	const queueTone: BadgeTone =
		deadJobs.length > 0
			? "danger"
			: stalledReadyJobs.length > 0 && runningJobs.length === 0
				? "warning"
				: runningJobs.length > 0
					? "info"
					: "neutral";

	return (
		<DaemonStartedAtContext.Provider value={daemonStartedAt}>
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
							{/* A spinner is a progress signal: linear, and still under reduced motion. */}
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
				className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-8"
				data-testid="runtime-page-overview"
			>
				{fullyUnavailable ? (
					<PageError
						title="Runtime status could not load"
						description={`${errors.join(" ")} The Knowns server may be restarting; try again in a moment.`}
						onRetry={() => void handleRefresh()}
						className="flex-1"
					/>
				) : firstLoad ? (
					<PageLoading label="Loading runtime status" className="flex-1" />
				) : (
					<>
						{errors.length > 0 && (
							<Callout
								tone="danger"
								role="alert"
								title="Live status is partially unavailable"
								action={
									<KnButton variant="secondary" size="sm" onClick={() => void handleRefresh()} loading={busy}>
										Retry
									</KnButton>
								}
							>
								{errors.join(" ")} Existing values remain visible until a refresh succeeds.
							</Callout>
						)}

						{alert && (
							<Callout
								tone={alert.tone === "offline" ? "danger" : "warning"}
								role="status"
								testId="runtime-operational-posture"
								title={<span className="font-semibold">{alert.title}</span>}
								action={
									attentionCount > 0 ? (
										<KnButton variant="secondary" size="sm" onClick={showServiceAttention}>
											Show {plural(attentionCount, "service", "services")}
										</KnButton>
									) : deadJobs.length > 0 && tab !== "activity" ? (
										// The Activity tab owns recovery, so the banner hands the reader
										// over to it instead of restating the CLI command beside a button
										// that already does the work.
										<KnButton variant="secondary" size="sm" onClick={() => setTab("activity")}>
											Show failures
										</KnButton>
									) : undefined
								}
							>
								{alert.description}
							</Callout>
						)}

						<div className="grid shrink-0 grid-cols-2 gap-3 xl:grid-cols-4" data-testid="runtime-health">
							<HealthTile
								label="Daemon"
								icon={<Server />}
								tone={loading ? "neutral" : runtimeRunning ? "success" : daemonDown ? "danger" : "neutral"}
								value={loading ? "-" : runtimeRunning ? "Online" : daemonDown ? "Offline" : "Idle"}
								detail={runtimeRunning || daemonDown ? daemonDetail || "scheduler" : [data?.status.version ? `v${data.status.version}` : null, "starts on demand"].filter(Boolean).join(" · ")}
								onSelect={() => setTab("clients")}
								selectLabel="Daemon status, show attached clients"
								testId="runtime-tile-daemon"
							/>
							<HealthTile
								label="Services"
								icon={<Plug />}
								tone={attentionCount > 0 ? "warning" : runningServiceCount > 0 ? "success" : "neutral"}
								value={`${runningServiceCount}/${reachableServiceCount}`}
								detail={attentionCount > 0 ? `${attentionCount} need setup` : "active now"}
								onSelect={() => (attentionCount > 0 ? showServiceAttention() : setTab("services"))}
								selectLabel="Services status, show services"
								testId="runtime-tile-services"
							/>
							<HealthTile
								label="Queue"
								icon={<ListChecks />}
								tone={queueTone}
								value={readyJobs.length}
								detail={[
									`${runningJobs.length} running`,
									retryingJobs.length > 0 ? `${retryingJobs.length} retrying` : null,
									deadJobs.length > 0 ? `${deadJobs.length} failed` : null,
								]
									.filter(Boolean)
									.join(" · ")}
								onSelect={() => setTab("activity")}
								selectLabel="Queue status, show activity"
								testId="runtime-tile-queue"
							/>
							<HealthTile
								label="Clients"
								icon={<Users />}
								tone={clients.length > 0 ? "info" : "neutral"}
								value={clients.length}
								detail={
									clients.length > 0
										? `heartbeat ${timeAgo(freshestClientHeartbeat)}`
										: "none attached"
								}
								onSelect={() => setTab("clients")}
								selectLabel="Clients, show attached clients"
								testId="runtime-tile-clients"
							/>
						</div>

						<Tabs value={tab} onValueChange={(value) => setTab(value as RuntimeTab)} className="flex min-w-0 flex-col gap-3">
							<TabsList aria-label="Runtime views">
								{tabs.map((entry) => (
									<TabsTrigger
										key={entry.id}
										value={entry.id}
										icon={
											entry.id === "services" ? <Plug /> : entry.id === "activity" ? <Activity /> : <Users />
										}
										badge={<span className="tabular-nums">{entry.count}</span>}
									>
										{entry.label}
									</TabsTrigger>
								))}
							</TabsList>

							<TabsContent value="services">
								<section className={cn(SURFACE, "@container")} data-testid="runtime-service-fleet" aria-label="Managed services">
									<div className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
										<p className="text-xs leading-5 text-muted-foreground">
											Language servers, the search embedder and tunnels this daemon manages, by what needs action first.
										</p>
										<div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] lg:mx-0 lg:px-0 [&::-webkit-scrollbar]:hidden">
											<SegmentedControl
												size="sm"
												aria-label="Filter managed services"
												value={serviceFilter}
												onValueChange={(value) => setServiceFilter(value as ServiceFilter)}
												className="min-w-[27rem]"
												options={filterOptions.map((option) => ({
													value: option.id,
													label: (
														<span className="inline-flex items-center gap-1.5">
															{option.label}
															<span className="font-mono text-[10px] tabular-nums opacity-60">{option.count}</span>
														</span>
													),
												}))}
											/>
										</div>
									</div>

									<div className={cn("hidden grid-cols-[minmax(11rem,1fr)_8.5rem_9.5rem_minmax(14rem,1.4fr)_auto] gap-3 border-t border-border/50 bg-muted/25 px-4 py-2 @4xl:grid", COLUMN_HEAD)}>
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
											description="Enable a runtime-backed feature, such as code intelligence or semantic search, to see it here."
											action={
												<Link to="/config" search={{ category: "runtime" }} className={buttonClass("secondary", "sm")}>
													Open Settings
												</Link>
											}
										/>
									) : serviceGroups.length > 0 ? (
										<div>
											{serviceGroups.map((group) => (
												<ServiceGroup
													key={`${serviceFilter}-${group.state}`}
													group={group}
													soleGroup={serviceGroups.length === 1}
												/>
											))}
										</div>
									) : (
										<RuntimeEmptyState
											icon={CircleDot}
											title="No services match this filter"
											description="Choose another state to keep inspecting the runtime."
											action={
												<KnButton variant="secondary" size="sm" onClick={() => setServiceFilter("all")}>
													Show all services
												</KnButton>
											}
										/>
									)}
								</section>
							</TabsContent>

							<TabsContent value="activity">
								<div className="flex min-w-0 flex-col gap-4" data-testid="runtime-activity">
									{loading ? (
										<div className={SURFACE}>
											<RuntimeListSkeleton rows={2} />
										</div>
									) : (
										<>
											{/* One line for what's wrong and how to recover it, before any
											    list (AC1). A backlog with nothing permanently dead reads as
											    calm (AC10). */}
											{deadJobs.length > 0 ? (
												<Callout
													tone="danger"
													title={`${plural(deadJobs.length, "job", "jobs")} failed permanently across ${plural(deadProjectCount, "project", "projects")}`}
													action={
														<>
															{oldestDeadFailedAt && (
																<span className="whitespace-nowrap text-[11px] text-muted-foreground">
																	since {timeAgo(oldestDeadFailedAt)}
																</span>
															)}
															<KnButton
																variant="secondary"
																size="sm"
																onClick={() => void handleRetryAll()}
																disabled={retryingKey !== null && retryingKey !== "all"}
																loading={retryingKey === "all"}
															>
																{retryingKey === "all" ? "Retrying" : "Retry all"}
															</KnButton>
														</>
													}
												>
													They will not run again on their own. Retry once the cause below is fixed.
												</Callout>
											) : (
												<Callout
													tone="success"
													title={
														<span className="font-normal text-muted-foreground">
															{jobFailures.length > 0
																? `No permanent failures. ${retryingJobs.length} ${retryingJobs.length === 1 ? "job is" : "jobs are"} waiting out a retry.`
																: "No failures. Background jobs are completing normally."}
														</span>
													}
												/>
											)}
											<Fold open={Boolean(retryError)}>
												<p role="alert" className="px-1 text-xs text-red-600 dark:text-red-400">
													{retryError}
												</p>
											</Fold>

											{jobFailures.length > 0 && (
												<CauseTable
													failures={jobFailures}
													onRetry={handleRetryCause}
													retryingKey={retryingKey}
													version={data?.status.version}
												/>
											)}

											{runningJobs.length + readyJobs.length > 0 && (
												<section className={SURFACE} aria-label="Work in progress" data-testid="runtime-work-queue">
													<div className="px-4 py-3">
														<h3 className="text-sm font-semibold">Work in progress</h3>
														<p className="mt-0.5 text-xs text-muted-foreground">
															Indexing, embedding and reconcile jobs the daemon is running or about to pick up.
														</p>
													</div>
													{runningJobs.length > 0 && (
														<JobSection title="Running" jobs={runningJobs} state="running" />
													)}
													{readyJobs.length > 0 && (
														<JobSection title="Waiting to start" jobs={readyJobs} state="ready" />
													)}
												</section>
											)}

											{/* Live counts, deliberately plain text so they never compete
											    with the failure banner or cause table (AC7). */}
											<div className="px-1 text-xs text-muted-foreground">
												<span className="font-mono tabular-nums text-foreground/80">{runningJobs.length}</span> running
												<span className="mx-1.5 text-border">·</span>
												<span className="font-mono tabular-nums text-foreground/80">{readyJobs.length}</span> ready
												<span className="mx-1.5 text-border">·</span>
												<span className="font-mono tabular-nums text-foreground/80">{retryingJobs.length}</span> retrying
											</div>

											{recentJobs.length > 0 && <RecentCompletions jobs={recentJobs} />}
										</>
									)}
								</div>
							</TabsContent>

							<TabsContent value="clients">
								<section className={SURFACE} aria-label="Attached clients" data-testid="runtime-clients">
									<p className="border-b border-border/50 px-4 py-3 text-xs leading-5 text-muted-foreground">
										CLI, MCP and agent processes holding a connection to this daemon.
									</p>
									{clients.length > 0 ? (
										<div className="divide-y divide-border/50">
											{clients.map((client) => (
												<div
													key={`${client.clientKind}-${client.projectRoot}-${client.pid}`}
													className={cn(
														"grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-2.5 text-xs sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-center",
														ROW_HOVER,
													)}
												>
													<span className="flex items-center gap-2 font-medium">
														<span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
														{client.clientKind}
													</span>
													<span
														className="col-span-2 row-start-2 truncate font-mono text-[11px] text-muted-foreground sm:col-span-1 sm:row-start-auto"
														title={client.projectRoot}
													>
														{projectPath(client.projectRoot)}
													</span>
													<span className="justify-self-end font-mono text-[10px] tabular-nums text-muted-foreground">
														pid {client.pid || "?"} · {timeAgo(client.updatedAt)}
													</span>
												</div>
											))}
										</div>
									) : (
										<RuntimeEmptyState
											icon={Users}
											title="No clients attached"
											description="CLI sessions, MCP servers and agents appear here while they hold a runtime connection."
										/>
									)}
								</section>
							</TabsContent>
						</Tabs>
					</>
				)}
			</PageContent>
		</DaemonStartedAtContext.Provider>
	);
}
