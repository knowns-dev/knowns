import { useCallback, useEffect, useMemo, useState } from "react";
import {
	AlertTriangle,
	CheckCircle2,
	Clipboard,
	Copy,
	Database,
	FileClock,
	History,
	RefreshCw,
	RotateCcw,
	ShieldQuestion,
} from "lucide-react";
import {
	getDocHistory,
	getDocRevisionDiff,
	restoreDocRevision,
	type DocChange,
	type DocChangeScope,
	type DocHistoryGap,
	type DocRevisionDiff,
	type DocVersion,
	type DocVersionHistory,
} from "../../api/client";
import { Button } from "../../components/ui/button";
import { DiffViewer } from "../../components/ui/DiffViewer";
import { ScrollArea } from "../../components/ui/ScrollArea";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "../../components/ui/sheet";
import { toast } from "../../components/ui/sonner";
import { cn, toDisplayPath } from "../../lib/utils";

interface DocHistorySheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	docPath: string;
	docTitle: string;
	readOnly?: boolean;
	onRestored: () => void;
}

const FIELD_LABELS: Record<string, string> = {
	path: "Path",
	title: "Title",
	description: "Description",
	content: "Content",
	tags: "Tags",
};

function valueToString(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.join(", ");
	if (typeof value === "object") return JSON.stringify(value, null, 2);
	return String(value);
}

function formatDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatActor(version: DocVersion): string {
	const actor = version.actor || version.author || "Unknown";
	if (version.source && version.source !== actor) return `${actor} via ${version.source}`;
	return actor;
}

function formatScope(scope: DocChangeScope): string {
	if (scope.type === "section" && scope.section) return `Section: ${scope.section}`;
	if (scope.type === "whole_doc") return "Whole document";
	if (scope.field) return FIELD_LABELS[scope.field] || scope.field;
	return scope.summary || scope.type;
}

function changeSummary(version: DocVersion): string {
	const scope = version.changedScopes?.[0];
	if (scope) return formatScope(scope);
	if (version.changes.length === 1) return FIELD_LABELS[version.changes[0].field] || version.changes[0].field;
	return `${version.changes.length} fields`;
}

function changeSize(version: DocVersion): string {
	const scopes = version.changedScopes || [];
	const delta = scopes.reduce((sum, scope) => sum + (scope.deltaBytes || 0), 0);
	if (delta !== 0) return `${delta > 0 ? "+" : ""}${delta} B`;
	const bytes = scopes.reduce((sum, scope) => sum + (scope.newBytes || 0), 0);
	if (bytes > 0) return `${bytes} B`;
	return "0 B";
}

function retentionGapText(gap: DocHistoryGap): string {
	const after = gap.afterVersion ? ` before ${gap.afterVersion}` : "";
	return `${gap.count} revision${gap.count === 1 ? "" : "s"} hidden by ${gap.reason.replaceAll("_", " ")}${after}`;
}

function latestVersion(history: DocVersionHistory | null): DocVersion | null {
	if (!history?.versions.length) return null;
	return [...history.versions].sort((a, b) => b.version - a.version)[0] || null;
}

function sectionScope(diff: DocRevisionDiff | null): DocChangeScope | undefined {
	return diff?.changedScopes?.find((scope) => scope.type === "section" && !!scope.section);
}

function copyPayload(diff: DocRevisionDiff | null): string {
	if (!diff) return "";
	const contentChange = diff.changes.find((change) => change.field === "content");
	if (contentChange) return valueToString(contentChange.newValue);
	return diff.changes
		.map((change) => {
			const label = FIELD_LABELS[change.field] || change.field;
			return `${label}\n${valueToString(change.newValue)}`;
		})
		.join("\n\n");
}

export function DocHistorySheet({
	open,
	onOpenChange,
	docPath,
	docTitle,
	readOnly = false,
	onRestored,
}: DocHistorySheetProps) {
	const [history, setHistory] = useState<DocVersionHistory | null>(null);
	const [selectedRevision, setSelectedRevision] = useState<string | null>(null);
	const [diff, setDiff] = useState<DocRevisionDiff | null>(null);
	const [loadingHistory, setLoadingHistory] = useState(false);
	const [loadingDiff, setLoadingDiff] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [restoring, setRestoring] = useState<"document" | "section" | null>(null);
	const [copied, setCopied] = useState(false);

	const versions = useMemo(
		() => [...(history?.versions || [])].sort((a, b) => b.version - a.version),
		[history?.versions],
	);
	const selectedVersion = useMemo(
		() => versions.find((version) => version.id === selectedRevision) || null,
		[versions, selectedRevision],
	);
	const selectedSectionScope = sectionScope(diff);
	const changedContent = copyPayload(diff);

	const loadHistory = useCallback(async () => {
		if (!docPath) return;
		setLoadingHistory(true);
		setError(null);
		try {
			const nextHistory = await getDocHistory(toDisplayPath(docPath).replace(/\.md$/, ""));
			setHistory(nextHistory);
			const nextLatest = latestVersion(nextHistory);
			setSelectedRevision((current) => {
				if (current && nextHistory.versions.some((version) => version.id === current)) return current;
				return nextLatest?.id || null;
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load document history");
			setHistory(null);
			setSelectedRevision(null);
		} finally {
			setLoadingHistory(false);
		}
	}, [docPath]);

	useEffect(() => {
		if (!open) return;
		void loadHistory();
	}, [open, loadHistory]);

	useEffect(() => {
		if (!open || !docPath || !selectedRevision) {
			setDiff(null);
			return;
		}
		let cancelled = false;
		setLoadingDiff(true);
		setError(null);
		getDocRevisionDiff(toDisplayPath(docPath).replace(/\.md$/, ""), selectedRevision)
			.then((nextDiff) => {
				if (!cancelled) setDiff(nextDiff);
			})
			.catch((err) => {
				if (!cancelled) {
					setDiff(null);
					setError(err instanceof Error ? err.message : "Failed to load revision diff");
				}
			})
			.finally(() => {
				if (!cancelled) setLoadingDiff(false);
			});
		return () => {
			cancelled = true;
		};
	}, [docPath, open, selectedRevision]);

	const handleCopy = async () => {
		if (!changedContent) return;
		try {
			await navigator.clipboard.writeText(changedContent);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
			toast.success("Copied change");
		} catch {
			toast.error("Failed to copy change");
		}
	};

	const handleRestore = async (mode: "document" | "section") => {
		if (!selectedRevision || readOnly) return;
		setRestoring(mode);
		try {
			const result = await restoreDocRevision(toDisplayPath(docPath).replace(/\.md$/, ""), {
				revisionId: selectedRevision,
				mode,
				section: mode === "section" ? selectedSectionScope?.section : undefined,
			});
			setHistory(result.history);
			const nextLatest = latestVersion(result.history);
			setSelectedRevision(nextLatest?.id || selectedRevision);
			onRestored();
			toast.success(mode === "section" ? "Section restored" : "Document restored");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to restore revision");
		} finally {
			setRestoring(null);
		}
	};

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="flex w-[96vw] max-w-none flex-col gap-0 p-0 sm:max-w-5xl">
				<div className="border-b border-border/60 px-5 py-4">
					<div className="flex items-start justify-between gap-4 pr-8">
						<div className="min-w-0">
							<SheetTitle className="flex items-center gap-2 text-base">
								<History className="h-4 w-4" />
								Document history
							</SheetTitle>
							<SheetDescription className="mt-1 truncate font-mono text-xs">
								@doc/{toDisplayPath(docPath).replace(/\.md$/, "")}
							</SheetDescription>
						</div>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => void loadHistory()}
							disabled={loadingHistory}
							className="h-8 px-2"
							title="Refresh history"
						>
							<RefreshCw className={cn("h-3.5 w-3.5", loadingHistory && "animate-spin")} />
						</Button>
					</div>
				</div>

				<div className="min-h-0 flex-1 overflow-hidden">
					<div className="grid h-full grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
						<aside className="min-h-0 border-b border-border/60 bg-muted/15 lg:border-b-0 lg:border-r">
							<div className="flex items-center justify-between px-4 py-3">
								<div>
									<div className="text-sm font-medium">Timeline</div>
									<div className="text-xs text-muted-foreground">{versions.length} revisions</div>
								</div>
								<FileClock className="h-4 w-4 text-muted-foreground" />
							</div>
							<ScrollArea className="h-[34vh] lg:h-[calc(100vh-116px)]">
								<div className="space-y-2 px-3 pb-4">
									{loadingHistory ? (
										<div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
											Loading history...
										</div>
									) : versions.length === 0 ? (
										<div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
											No history recorded
										</div>
									) : (
										versions.map((version) => (
											<button
												key={version.id}
												type="button"
												onClick={() => setSelectedRevision(version.id)}
												aria-pressed={selectedRevision === version.id}
												className={cn(
													"w-full rounded-lg border p-3 text-left transition-colors",
													selectedRevision === version.id
														? "border-primary bg-background shadow-sm"
														: "border-border bg-background/70 hover:bg-background",
												)}
											>
												<div className="flex items-center justify-between gap-2">
													<span className="font-mono text-xs font-semibold">{version.id}</span>
													<div className="flex items-center gap-1">
														{version.checkpoint && (
															<span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-800 dark:bg-blue-950/70 dark:text-blue-200">
																checkpoint
															</span>
														)}
														<span className="text-[10px] text-muted-foreground">{changeSize(version)}</span>
													</div>
												</div>
												<div className="mt-2 text-sm font-medium leading-snug">{changeSummary(version)}</div>
												<div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
													<span>{formatDate(version.timestamp)}</span>
													<span>{formatActor(version)}</span>
												</div>
											</button>
										))
									)}
								</div>
							</ScrollArea>
						</aside>

						<section className="min-h-0 bg-background">
							<ScrollArea className="h-full">
								<div className="space-y-4 p-4 sm:p-5">
									{error && (
										<div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
											<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
											<span>{error}</span>
										</div>
									)}

									{history?.retentionGaps?.length ? (
										<div className="space-y-2">
											{history.retentionGaps.map((gap, index) => (
												<div
													key={`${gap.afterVersion || "gap"}-${index}`}
													className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100"
												>
													<Database className="mt-0.5 h-4 w-4 shrink-0" />
													<span>{retentionGapText(gap)}</span>
												</div>
											))}
										</div>
									) : null}

									{selectedVersion ? (
										<>
											<div className="rounded-lg border border-border bg-card">
												<div className="border-b border-border px-4 py-3">
													<div className="flex flex-wrap items-center justify-between gap-3">
														<div className="min-w-0">
															<div className="flex flex-wrap items-center gap-2">
																<span className="font-mono text-sm font-semibold">{selectedVersion.id}</span>
																{selectedVersion.checkpoint && (
																	<span className="rounded bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-800 dark:bg-blue-950/70 dark:text-blue-200">
																		checkpoint
																	</span>
																)}
															</div>
															<div className="mt-1 text-sm text-muted-foreground">
																{formatDate(selectedVersion.timestamp)} - {formatActor(selectedVersion)}
															</div>
														</div>
														<div className="flex items-center gap-2">
															<Button
																variant="outline"
																size="sm"
																onClick={handleCopy}
																disabled={!changedContent}
																className="h-8 px-2.5"
															>
																{copied ? <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
																Copy
															</Button>
															<Button
																variant="outline"
																size="sm"
																onClick={() => void handleRestore("section")}
																disabled={readOnly || !selectedSectionScope?.section || restoring !== null}
																className="h-8 px-2.5"
															>
																<RotateCcw className="mr-1 h-3.5 w-3.5" />
																{restoring === "section" ? "Restoring..." : "Restore section"}
															</Button>
															<Button
																variant="secondary"
																size="sm"
																onClick={() => void handleRestore("document")}
																disabled={readOnly || restoring !== null}
																className="h-8 px-2.5"
															>
																<RotateCcw className="mr-1 h-3.5 w-3.5" />
																{restoring === "document" ? "Restoring..." : "Restore doc"}
															</Button>
														</div>
													</div>
												</div>
												<div className="grid gap-3 px-4 py-3 text-xs text-muted-foreground sm:grid-cols-2">
													<div className="flex items-center gap-2">
														<Clipboard className="h-3.5 w-3.5" />
														<span>{changeSummary(selectedVersion)}</span>
													</div>
													<div className="flex items-center gap-2">
														<ShieldQuestion className="h-3.5 w-3.5" />
														<span>{selectedVersion.auditEventId ? `Audit ${selectedVersion.auditEventId}` : "Audit link unavailable"}</span>
													</div>
												</div>
											</div>

											<div className="space-y-3">
												<div className="flex items-center justify-between">
													<h3 className="text-sm font-semibold">Diff</h3>
													{diff?.previousRevisionId && (
														<span className="font-mono text-xs text-muted-foreground">
															{diff.previousRevisionId}{" -> "}{diff.revisionId}
														</span>
													)}
												</div>
												{loadingDiff ? (
													<div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
														Loading diff...
													</div>
												) : diff?.changes.length ? (
													<div className="space-y-3">
														{diff.changes.map((change, index) => (
															<DocChangeDiff
																key={`${change.field}-${index}`}
																change={change}
																scope={diff.changedScopes?.find((scope) => scope.field === change.field)}
															/>
														))}
													</div>
												) : (
													<div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
														No diff available
													</div>
												)}
											</div>
										</>
									) : (
										<div className="rounded-lg border border-dashed border-border px-3 py-12 text-center">
											<div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
												<History className="h-5 w-5 text-muted-foreground" />
											</div>
											<div className="text-sm font-medium">{docTitle || "No document selected"}</div>
											<div className="mt-1 text-sm text-muted-foreground">No revision is selected.</div>
										</div>
									)}
								</div>
							</ScrollArea>
						</section>
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}

function DocChangeDiff({ change, scope }: { change: DocChange; scope?: DocChangeScope }) {
	const oldValue = valueToString(change.oldValue);
	const newValue = valueToString(change.newValue);
	const label = scope ? formatScope(scope) : FIELD_LABELS[change.field] || change.field;
	return (
		<div className="overflow-hidden rounded-lg border border-border bg-card">
			<div className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-3 py-2">
				<div className="min-w-0">
					<div className="truncate text-sm font-medium">{label}</div>
					{scope && (
						<div className="text-[11px] text-muted-foreground">
							{scope.oldBytes || 0}{" -> "}{scope.newBytes || 0} B
							{typeof scope.deltaBytes === "number" && ` (${scope.deltaBytes > 0 ? "+" : ""}${scope.deltaBytes})`}
						</div>
					)}
				</div>
				<span className="shrink-0 rounded bg-background px-2 py-0.5 text-[10px] uppercase text-muted-foreground">
					{change.field}
				</span>
			</div>
			<DiffViewer oldValue={oldValue} newValue={newValue} className="rounded-none border-0" />
		</div>
	);
}
