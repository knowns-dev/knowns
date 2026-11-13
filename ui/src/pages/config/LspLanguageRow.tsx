import { useId, useState } from "react";
import { Activity, AlertCircle, ChevronRight, Copy, Download, Loader2, Package, RefreshCw, Terminal, Trash2, X } from "lucide-react";
import { Badge, type BadgeTone } from "@/ui/components/ui/knowns/badge";
import { Button } from "@/ui/components/ui/knowns/button";
import { Input } from "@/ui/components/ui/knowns/input";
import { Select } from "@/ui/components/ui/knowns/select";
import { Switch } from "@/ui/components/ui/knowns/switch";
import type { LSPLanguageInfo } from "@/ui/api/client";

export type LSPLogKind = "runtime" | "trace";

export interface LSPConfigDraft {
	backend?: string;
	projectPath?: string;
	version?: string;
	binary?: string;
}

export interface LSPLogPanelState {
	kind: LSPLogKind;
	content: string;
	path?: string;
	loading?: boolean;
}

export interface LspLanguageConfig {
	enabled?: boolean;
	binary?: string;
	version?: string;
	backend?: string;
	projectPath?: string;
}

const CSHARP_BACKENDS = ["auto", "roslyn-ls", "csharp-ls", "omnisharp"];

const display = (value?: string) => (value && value.trim() ? value : "-");

function tone(status?: string): BadgeTone {
	switch (status) {
		case "running":
		case "ready":
		case "installed":
			return "success";
		case "crashed":
		case "error":
			return "danger";
		case "starting":
		case "indexing":
		case "degraded":
			return "warning";
		default:
			return "neutral";
	}
}

interface LspLanguageRowProps {
	lang: string;
	config: LspLanguageConfig;
	info?: LSPLanguageInfo;
	/** Keys of the actions in flight for this language. */
	busy: boolean;
	configBusy: boolean;
	traceOn: boolean;
	draft: LSPConfigDraft;
	logPanel?: LSPLogPanelState;
	onToggle: (enabled: boolean) => void;
	onRestart: () => void;
	onInstall: (action: "install" | "update") => void;
	onCleanup: () => void;
	onRemove: () => void;
	onLogs: (kind?: LSPLogKind) => void;
	onTrace: (enabled: boolean) => void;
	onDraft: (field: keyof LSPConfigDraft, value: string) => void;
	onApplyConfig: () => void;
}

/** One language: the common controls on the row, everything else behind Details. */
export function LspLanguageRow(props: LspLanguageRowProps) {
	const { lang, config, info, busy, configBusy, traceOn, draft, logPanel } = props;
	const [open, setOpen] = useState(false);
	const detailsId = useId();
	const isRunning = info?.running ?? false;
	const isInstalled = info?.installed ?? config.binary !== undefined;
	const enabled = config.enabled ?? true;
	const name = info?.name || lang;
	const state = info?.status || info?.runningState;
	const cell = (label: string, value: string) => (
		<div className="min-w-0 rounded-md border bg-background/60 px-2.5 py-2">
			<dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
			<dd className="mt-1 break-words font-mono text-[11px] leading-5">{value}</dd>
		</div>
	);

	return (
		<li className="overflow-hidden rounded-lg border bg-card" data-testid={`lsp-language-${lang}`}>
			<div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
				<Switch aria-label={`Enable ${name}`} checked={config.enabled ?? false} onCheckedChange={props.onToggle} disabled={busy} />
				<span
					aria-hidden
					className={`size-2 shrink-0 rounded-full ${isRunning ? "bg-emerald-500" : enabled ? "bg-amber-500" : "bg-muted-foreground/50"}`}
				/>
				<span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{name}</span>
				{busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Working" />}
				<Badge tone={tone(state)} size="sm">
					{display(state)}
				</Badge>
				<Button size="xs" variant="secondary" icon={<RefreshCw />} onClick={props.onRestart} disabled={busy || !enabled}>
					Restart
				</Button>
				<Button
					size="xs"
					variant="ghost"
					icon={<ChevronRight className={open ? "rotate-90" : ""} />}
					aria-expanded={open}
					aria-controls={detailsId}
					onClick={() => setOpen((v) => !v)}
				>
					Details
				</Button>
				<Button size="xs" variant="ghost" icon={<Trash2 />} aria-label={`Remove ${name}`} onClick={props.onRemove} disabled={busy} />
			</div>

			{open && (
				<div id={detailsId} className="flex flex-col gap-3 border-t bg-muted/20 p-3">
					<div className="flex flex-wrap gap-1.5">
						<Badge tone={tone(info?.installState)} size="sm" variant="outline">
							Install: {display(info?.installState)}
						</Badge>
						<Badge tone={tone(info?.readinessState)} size="sm" variant="outline">
							Ready: {display(info?.readinessState)}
						</Badge>
					</div>
					<div className="flex flex-wrap gap-1.5">
						<Button size="xs" variant="secondary" icon={<Download />} onClick={() => props.onInstall("install")} disabled={busy || !info?.installHint}>
							Install
						</Button>
						<Button size="xs" variant="secondary" icon={<Package />} onClick={() => props.onInstall("update")} disabled={busy || !isInstalled}>
							Update
						</Button>
						<Button size="xs" variant="secondary" icon={<X />} onClick={props.onCleanup} disabled={busy || !info?.cleanupEligible}>
							Cleanup
						</Button>
						<Button size="xs" variant="secondary" icon={<Terminal />} onClick={() => props.onLogs()} disabled={busy}>
							Logs
						</Button>
						<Button size="xs" variant={traceOn ? "primary" : "secondary"} icon={<Activity />} aria-pressed={traceOn} onClick={() => props.onTrace(!traceOn)} disabled={busy}>
							Trace
						</Button>
					</div>

					<dl className="grid grid-cols-[repeat(auto-fit,minmax(11.5rem,1fr))] gap-2">
						{cell("Backend", `${display(info?.backend)}${info?.backendSource ? ` (${info.backendSource})` : ""}`)}
						{cell("Project", `${display(info?.projectPath)}${info?.projectKind ? ` (${info.projectKind})` : ""}`)}
						{cell("Binary", display(info?.binaryPath || info?.binary || config.binary))}
						{cell("Version", display(info?.version || config.version))}
						{cell("Cache", display(info?.cachePath))}
						{cell("Log", display(info?.logPath))}
						{cell("Capabilities", display(info?.capabilities?.join(", ")))}
					</dl>

					{info?.installHint && !isInstalled && (
						<p className="rounded-md border bg-background/60 px-3 py-2 text-xs text-muted-foreground">
							Install: <code className="text-xs">{info.installHint}</code>
						</p>
					)}
					{(info?.installError || info?.updateError) && (
						<p role="alert" className="flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
							<AlertCircle className="mt-0.5 size-3.5 shrink-0" />
							<span>{info.installError || info.updateError}</span>
						</p>
					)}
					{info?.missingCapabilities && info.missingCapabilities.length > 0 && (
						<p className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
							<AlertCircle className="mt-0.5 size-3.5 shrink-0" />
							<span>Missing required capabilities: {info.missingCapabilities.join(", ")}</span>
						</p>
					)}
					{info?.attempts && info.attempts.length > 0 && (
						<div className="flex flex-wrap gap-1.5">
							{info.attempts.map((attempt, index) => (
								<Badge key={`${attempt.backend}-${index}`} tone={tone(attempt.status)} size="sm" variant="outline">
									{attempt.backend}: {attempt.status}
									{attempt.reason ? ` - ${attempt.reason}` : ""}
								</Badge>
							))}
						</div>
					)}

					{lang === "csharp" && (
						<div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2 rounded-md border bg-background/60 p-3">
							<Select
								size="sm"
								aria-label="C# backend"
								value={draft.backend ?? config.backend ?? "auto"}
								onChange={(e) => props.onDraft("backend", e.target.value)}
								options={CSHARP_BACKENDS}
								disabled={configBusy}
							/>
							<Input size="sm" aria-label="C# solution or project path" value={draft.projectPath ?? config.projectPath ?? ""} onChange={(e) => props.onDraft("projectPath", e.target.value)} placeholder={info?.projectPath || "solution or project path"} disabled={configBusy} />
							<Input size="sm" aria-label="C# binary" value={draft.binary ?? config.binary ?? ""} onChange={(e) => props.onDraft("binary", e.target.value)} placeholder="binary override" disabled={configBusy} />
							<Input size="sm" aria-label="C# version" value={draft.version ?? config.version ?? ""} onChange={(e) => props.onDraft("version", e.target.value)} placeholder="version override" disabled={configBusy} />
							<Button size="sm" onClick={props.onApplyConfig} disabled={configBusy || !enabled} loading={configBusy}>
								Apply
							</Button>
						</div>
					)}

					{logPanel && (
						<div className="overflow-hidden rounded-md border bg-background/60">
							<div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
								<Button size="xs" variant={logPanel.kind === "runtime" ? "primary" : "secondary"} onClick={() => props.onLogs("runtime")}>
									Runtime
								</Button>
								<Button size="xs" variant={logPanel.kind === "trace" ? "primary" : "secondary"} onClick={() => props.onLogs("trace")}>
									Trace
								</Button>
								<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{display(logPanel.path || info?.logPath)}</span>
								<Button size="xs" variant="ghost" icon={<Copy />} aria-label="Copy log path" onClick={() => navigator.clipboard?.writeText(logPanel.path || info?.logPath || "")} />
								<Button size="xs" variant="ghost" icon={<RefreshCw />} aria-label="Reload log" onClick={() => props.onLogs(logPanel.kind)} disabled={logPanel.loading} loading={logPanel.loading} />
							</div>
							<pre className="max-h-64 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-muted-foreground">
								{logPanel.loading ? "Loading..." : logPanel.content || "No log output"}
							</pre>
						</div>
					)}
				</div>
			)}
		</li>
	);
}
