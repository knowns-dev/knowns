import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	Activity,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	Circle,
	Clock,
	GripHorizontal,
	Loader2,
	XCircle,
} from "lucide-react";
import { cn } from "@/ui/lib/utils";
import { useRuntimeMonitor } from "@/ui/hooks/useRuntimeMonitor";
import { getRuntimeServices } from "@/ui/api/client";
import type { RuntimeJob, RuntimeJobResult, RuntimeProjectSnapshot, RuntimeService } from "@/ui/api/client";

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 400;
const DEFAULT_HEIGHT = 250;

function timeAgo(value?: string) {
	if (!value) return "now";
	const diff = Math.max(0, Date.now() - new Date(value).getTime());
	const seconds = Math.floor(diff / 1000);
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

function projectName(root: string) {
	return root.split(/[\\/]/).filter(Boolean).pop() || root;
}

function detailValue(service: RuntimeService, key: string) {
	const value = service.details?.[key];
	if (value === undefined || value === null || value === "") return "";
	return String(value);
}

function commaCount(value: string) {
	return value.split(",").filter((item) => item.trim()).length;
}

function serviceDetailItems(service: RuntimeService) {
	const items: Array<{ key: string; label: string; title?: string; destructive?: boolean }> = [];
	const add = (key: string, label: string, options: { title?: string; destructive?: boolean } = {}) => {
		const value = detailValue(service, key);
		if (value) items.push({ key, label: `${label}=${value}`, ...options });
	};
	add("provider", "provider");
	add("model", "model");
	add("dimensions", "dims");
	add("runtime_loaded", "loaded");
	add("active_sessions", "sessions");
	const consumers = detailValue(service, "consumers");
	if (consumers) items.push({ key: "consumers", label: `consumers=${commaCount(consumers)}`, title: consumers });
	add("running_jobs", "jobs");
	add("queued_jobs", "queued");
	add("idle_unload_after", "idle");
	if (detailValue(service, "degraded") === "true") items.push({ key: "degraded", label: "degraded", destructive: true });
	const lastError = detailValue(service, "last_error") || detailValue(service, "error");
	if (lastError) items.push({ key: "error", label: `error=${lastError}`, title: lastError, destructive: true });
	const log = detailValue(service, "runtime_log");
	if (log) items.push({ key: "runtime_log", label: `log=${log}`, title: log });
	return items;
}

function KindBadge({ kind }: { kind: string }) {
	return (
		<span className="inline-flex shrink-0 items-center rounded-md border border-border/60 bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
			{kind}
		</span>
	);
}

function ServiceRow({ service }: { service: RuntimeService }) {
	const statusColor = {
		running: "text-emerald-500",
		stopped: "text-muted-foreground",
		disabled: "text-muted-foreground",
		error: "text-destructive",
	}[service.status];
	const details = serviceDetailItems(service);

	return (
		<div className={cn("border-b border-border/40 px-3 py-2 last:border-b-0", service.status !== "running" && "opacity-60")}>
			<div className="flex items-center gap-2">
				<Circle className={cn("h-2.5 w-2.5 fill-current", statusColor)} />
				<span className="font-medium text-foreground">{service.name}</span>
			</div>
			<div className="mt-0.5 pl-[18px] text-[11px] text-muted-foreground">
				{service.status}
				{service.pid ? ` · pid=${service.pid}` : ""}
					{service.port ? ` · :${service.port}` : ""}
					{service.uptime ? ` · ${service.uptime}` : ""}
				</div>
				{details.length > 0 && (
					<div className="mt-1 flex flex-wrap gap-1 pl-[18px]">
						{details.map((item) => (
							<span
								key={item.key}
								title={item.title || item.label}
								className={cn(
									"max-w-full truncate rounded border border-border/50 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground",
									item.destructive && "border-destructive/40 bg-destructive/10 text-destructive",
								)}
							>
								{item.label}
							</span>
						))}
					</div>
				)}
			</div>
	);
}

function EmptyState({ label }: { label: string }) {
	return <div className="px-3 py-4 text-xs text-muted-foreground">{label}</div>;
}

function JobRow({ job, project }: { job: RuntimeJob; project: RuntimeProjectSnapshot }) {
	const hasProgress = typeof job.processed === "number" && typeof job.total === "number" && job.total > 0;
	const progress = hasProgress ? Math.min(100, Math.round(((job.processed ?? 0) / (job.total ?? 1)) * 100)) : 0;

	return (
		<div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-border/40 px-3 py-2 last:border-b-0">
			<KindBadge kind={job.kind} />
			<div className="min-w-0">
				<div className="truncate text-xs text-foreground" title={job.target || project.root}>
					{job.target || projectName(project.root)}
				</div>
				<div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
					<span className="truncate">{job.phase || projectName(project.root)}</span>
					{hasProgress && <span>{job.processed}/{job.total}</span>}
					{job.lastError && <span className="truncate text-destructive">{job.lastError}</span>}
				</div>
				{hasProgress && (
					<div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
						<div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
					</div>
				)}
			</div>
			<div className="flex items-center gap-1 text-[11px] text-muted-foreground">
				<Clock className="h-3 w-3" />
				{timeAgo(job.requestedAt)}
			</div>
		</div>
	);
}

function RecentRow({ job }: { job: RuntimeJobResult }) {
	const [open, setOpen] = useState(false);
	const hasDetails = !!(job.details?.stats || job.details?.phase || job.error);

	return (
		<div className="border-b border-border/40 last:border-b-0">
			<button
				type="button"
				className={cn(
					"grid w-full grid-cols-[auto_auto_1fr_auto] items-center gap-2 px-3 py-2 text-left transition-colors",
					hasDetails && "cursor-pointer hover:bg-muted/40",
				)}
				onClick={() => hasDetails && setOpen(!open)}
			>
				{job.success ? (
					<CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
				) : (
					<XCircle className="h-3.5 w-3.5 text-destructive" />
				)}
				<KindBadge kind={job.kind} />
				<div className="min-w-0">
					<div className="truncate text-xs text-foreground" title={job.target || job.key}>
						{job.target || job.key}
					</div>
					{job.error && !open && <div className="truncate text-[11px] text-destructive">{job.error}</div>}
				</div>
				<div className="flex items-center gap-1">
					<span className="text-[11px] text-muted-foreground">{duration(job.startedAt, job.completedAt)}</span>
					{hasDetails && (open ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />)}
				</div>
			</button>
			{open && (
				<div className="space-y-0.5 px-3 pb-2 pl-8 text-[11px] text-muted-foreground">
					<div>Requested: {new Date(job.requestedAt).toLocaleTimeString()}</div>
					<div>Started: {new Date(job.startedAt).toLocaleTimeString()}</div>
					<div>Completed: {new Date(job.completedAt).toLocaleTimeString()}</div>
					{job.attemptCount > 1 && <div>Attempts: {job.attemptCount}</div>}
					{job.details?.phase && <div>Final phase: {job.details.phase}</div>}
					{job.details?.processed !== undefined && job.details?.total !== undefined && (
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

export function RuntimeMonitorPanel() {
	const { data, isLoading, totalActive } = useRuntimeMonitor();
	const [isExpanded, setIsExpanded] = useState(false);
	const [panelHeight, setPanelHeight] = useState(DEFAULT_HEIGHT);
	const [services, setServices] = useState<RuntimeService[]>([]);
	const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
	const dragHandlersRef = useRef<{ move: (ev: MouseEvent) => void; up: () => void } | null>(null);

	useEffect(() => {
		let cancelled = false;
		const fetchServices = () => {
			getRuntimeServices()
				.then((res) => { if (!cancelled) setServices(res.services ?? []); })
				.catch(() => {});
		};
		fetchServices();
		const interval = setInterval(fetchServices, 7000);
		return () => { cancelled = true; clearInterval(interval); };
	}, []);

	useEffect(() => {
		return () => {
			if (dragHandlersRef.current) {
				document.removeEventListener("mousemove", dragHandlersRef.current.move);
				document.removeEventListener("mouseup", dragHandlersRef.current.up);
				dragHandlersRef.current = null;
			}
		};
	}, []);

	const runningJobs = useMemo(
		() => data?.projects?.flatMap((project) => (project.running ?? []).map((job) => ({ job, project }))) ?? [],
		[data],
	);
	const queuedJobs = useMemo(
		() => data?.projects?.flatMap((project) => (project.queued ?? []).map((job) => ({ job, project }))) ?? [],
		[data],
	);
	const recentJobs = useMemo(
		() => data?.projects?.flatMap((project) => project.recent ?? [])
			.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())
			.slice(0, 20) ?? [],
		[data],
	);

	const handleDragStart = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			dragRef.current = { startY: e.clientY, startHeight: panelHeight };

			const handleDragMove = (ev: MouseEvent) => {
				if (!dragRef.current) return;
				const delta = dragRef.current.startY - ev.clientY;
				setPanelHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragRef.current.startHeight + delta)));
			};

			const handleDragEnd = () => {
				dragRef.current = null;
				dragHandlersRef.current = null;
				document.removeEventListener("mousemove", handleDragMove);
				document.removeEventListener("mouseup", handleDragEnd);
			};

			dragHandlersRef.current = { move: handleDragMove, up: handleDragEnd };
			document.addEventListener("mousemove", handleDragMove);
			document.addEventListener("mouseup", handleDragEnd);
		},
		[panelHeight],
	);

	if (!isExpanded) {
		return (
			<button
				type="button"
				onClick={() => setIsExpanded(true)}
				className="flex h-8 shrink-0 items-center justify-between border-t border-border bg-background px-3 text-xs text-muted-foreground transition-colors hover:bg-muted/40"
			>
				<span className="flex items-center gap-2">
					<Activity className="h-3.5 w-3.5" />
					<span className="font-medium text-foreground">Runtime</span>
					<span className={cn("rounded-full px-2 py-0.5 text-[11px]", totalActive > 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
						{totalActive}
					</span>
					{isLoading && <Loader2 className="h-3 w-3 animate-spin" />}
				</span>
				<ChevronUp className="h-4 w-4" />
			</button>
		);
	}

	return (
		<section className="flex shrink-0 flex-col border-t border-border bg-background" style={{ height: panelHeight }}>
			<div onMouseDown={handleDragStart} className="flex h-2 cursor-ns-resize items-center justify-center hover:bg-muted/60">
				<GripHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
			</div>
			<div className="flex h-9 shrink-0 items-center justify-between border-b border-border/70 px-3">
				<div className="flex items-center gap-2 text-xs">
					<Activity className="h-4 w-4 text-muted-foreground" />
					<span className="font-medium">Runtime</span>
					<Circle className={cn("h-2.5 w-2.5 fill-current", data?.status.running ? "text-emerald-500" : "text-destructive")} />
					<span className="text-muted-foreground">{data?.status.running ? "running" : "stopped"}</span>
					{data?.status.pid && <span className="text-muted-foreground">pid={data.status.pid}</span>}
					{data?.status.version && <span className="text-muted-foreground">v{data.status.version}</span>}
					<span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{totalActive} active</span>
				</div>
				<button type="button" onClick={() => setIsExpanded(false)} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
					<ChevronDown className="h-4 w-4" />
				</button>
			</div>
			<div className="grid min-h-0 flex-1 grid-cols-5 overflow-hidden text-xs">
				<div className="min-h-0 overflow-auto border-r border-border/60">
					<div className="sticky top-0 bg-background/95 px-3 py-2 font-medium">Services ({services.length})</div>
					{services.length ? services.map((svc) => <ServiceRow key={`${svc.type}-${svc.name}`} service={svc} />) : <EmptyState label="No services detected" />}
				</div>
				<div className="min-h-0 overflow-auto border-r border-border/60">
					<div className="sticky top-0 bg-background/95 px-3 py-2 font-medium">Clients ({data?.status.clients.length ?? 0})</div>
					{data?.status.clients.length ? data.status.clients.map((client) => (
						<div key={`${client.clientKind}-${client.projectRoot}-${client.pid}`} className="border-b border-border/40 px-3 py-2">
							<div className="font-medium text-foreground">{client.clientKind}</div>
							<div className="truncate text-muted-foreground" title={client.projectRoot}>{projectName(client.projectRoot)}</div>
							<div className="text-[11px] text-muted-foreground">pid={client.pid || "?"} age={timeAgo(client.updatedAt)}</div>
						</div>
					)) : <EmptyState label="No clients connected" />}
				</div>
				<div className="min-h-0 overflow-auto border-r border-border/60">
					<div className="sticky top-0 bg-background/95 px-3 py-2 font-medium">Running ({runningJobs.length})</div>
					{runningJobs.length ? runningJobs.map(({ job, project }) => <JobRow key={job.id} job={job} project={project} />) : <EmptyState label="No running jobs" />}
				</div>
				<div className="min-h-0 overflow-auto border-r border-border/60">
					<div className="sticky top-0 bg-background/95 px-3 py-2 font-medium">Queued ({queuedJobs.length})</div>
					{queuedJobs.length ? queuedJobs.map(({ job, project }) => <JobRow key={job.id} job={job} project={project} />) : <EmptyState label="No queued jobs" />}
				</div>
				<div className="min-h-0 overflow-auto">
					<div className="sticky top-0 bg-background/95 px-3 py-2 font-medium">Recent ({recentJobs.length})</div>
					{recentJobs.length ? recentJobs.map((job) => <RecentRow key={job.jobId} job={job} />) : <EmptyState label="No recent completions" />}
				</div>
			</div>
		</section>
	);
}
