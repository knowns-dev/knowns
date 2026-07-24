import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
	decisionApi,
	decisionMigrationApi,
	type DecisionEntry,
	type DecisionMigrationCandidate,
	type DecisionMigrationPreview,
	type DecisionMigrationResolution,
	type DecisionMigrationSelection,
} from "@/ui/api/client";
import {
	ArchiveRestore,
	CircleAlert,
	DatabaseZap,
	RefreshCw,
	RotateCcw,
	ShieldCheck,
	X,
} from "lucide-react";
import ReferencePicker from "@/ui/components/organisms/ReferencePicker";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/ui/components/ui/dialog";
import { cn } from "@/ui/lib/utils";

type MigrationReviewAction = "apply" | "rollback";

const migrationResolutions: Array<{ value: DecisionMigrationResolution; label: string }> = [
	{ value: "create_decision", label: "Create System Decision" },
	{ value: "link_existing", label: "Link existing Decision" },
	{ value: "consolidate_duplicate", label: "Consolidate duplicate" },
	{ value: "reclassify", label: "Reclassify Memory" },
	{ value: "archive_noise", label: "Archive noise" },
	{ value: "reject_noise", label: "Reject noise" },
	{ value: "leave_unchanged", label: "Leave unchanged" },
];

export default function DecisionMigrationTool() {
	const [open, setOpen] = useState(false);
	const [preview, setPreview] = useState<DecisionMigrationPreview | null>(null);
	const [decisions, setDecisions] = useState<DecisionEntry[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	const loadPreview = useCallback(async () => {
		setBusy(true);
		setError("");
		try {
			const [nextPreview, allDecisions] = await Promise.all([
				decisionMigrationApi.preview(),
				decisionApi.list({ includeAll: true }),
			]);
			setPreview(nextPreview);
			setDecisions(allDecisions);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : "Failed to preview Legacy Decision Memory migration");
		} finally {
			setBusy(false);
		}
	}, []);

	useEffect(() => {
		if (open && preview === null) void loadPreview();
	}, [loadPreview, open, preview]);

	const handleApply = useCallback(
		async (selection: DecisionMigrationSelection) => {
			setBusy(true);
			setError("");
			try {
				const result = await decisionMigrationApi.apply(selection);
				const item = result.results[0];
				await loadPreview();
				setNotice(
					item.legacyExcluded
						? `Legacy Decision Memory ${item.memoryId} is no longer current retrieval guidance.`
						: `Migration recorded for ${item.memoryId}; the legacy entry remains readable until its replacement is current.`,
				);
				return true;
			} catch (nextError) {
				setError(nextError instanceof Error ? nextError.message : "Failed to apply migration");
				return false;
			} finally {
				setBusy(false);
			}
		},
		[loadPreview],
	);

	const handleRollback = useCallback(
		async (memoryID: string) => {
			setBusy(true);
			setError("");
			try {
				await decisionMigrationApi.rollback(memoryID);
				await loadPreview();
				setNotice(`Migration for ${memoryID} was rolled back.`);
				return true;
			} catch (nextError) {
				setError(nextError instanceof Error ? nextError.message : "Failed to roll back migration");
				return false;
			} finally {
				setBusy(false);
			}
		},
		[loadPreview],
	);

	return (
		<section aria-labelledby="decision-migration-tool-heading">
			<div className="flex items-start gap-3">
				<div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
					<DatabaseZap className="h-4 w-4 text-muted-foreground" />
				</div>
				<div className="min-w-0 flex-1">
					<h3 id="decision-migration-tool-heading" className="text-sm font-semibold">Legacy Decision Memory migration</h3>
					<p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
						Review legacy category=decision Memories and explicitly migrate, reclassify, archive, reject, or leave each one unchanged.
					</p>
					<button
						type="button"
						onClick={() => setOpen(true)}
						className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<ArchiveRestore className="h-4 w-4" />
						Open migration workspace
					</button>
				</div>
			</div>

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent
					hideCloseButton
					overlayClassName="bg-zinc-950/50 backdrop-blur-[1.5px]"
					className="left-0 top-0 flex h-[100dvh] max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-white p-0 shadow-none dark:bg-background sm:left-1/2 sm:top-1/2 sm:h-[min(900px,calc(100dvh-3rem))] sm:w-[min(1180px,calc(100vw-3rem))] sm:max-w-[1180px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:border-zinc-200 sm:shadow-[0_12px_32px_rgba(0,0,0,0.16)] dark:sm:border-border"
					data-testid="decision-migration-panel"
				>
					<DialogTitle className="sr-only">Legacy Decision Memory migration</DialogTitle>
					<DialogDescription className="sr-only">
						Preview and apply one reviewed legacy migration at a time.
					</DialogDescription>
					<div className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-200 px-4 py-4 dark:border-border sm:px-6">
						<div>
							<h2 className="text-xl font-semibold tracking-[-0.02em]">Legacy Decision Memory migration</h2>
							<p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
								Preview is read-only. Apply one reviewed row at a time; Decision-backed legacy guidance remains readable until its replacement is verified and current.
							</p>
						</div>
						<div className="flex items-center gap-1">
							<button type="button" onClick={() => void loadPreview()} disabled={busy} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium hover:bg-accent disabled:opacity-50 sm:min-h-9">
								<RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
								Preview
							</button>
							<button type="button" onClick={() => setOpen(false)} aria-label="Close migration review" className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground sm:h-9 sm:w-9">
								<X className="h-4 w-4" />
							</button>
						</div>
					</div>

					{error ? <div role="alert" className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-destructive/30 dark:bg-destructive/10 dark:text-destructive sm:px-6">{error}</div> : null}
					{notice ? <div role="status" aria-live="polite" className="border-b border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300 sm:px-6">{notice}</div> : null}

					{preview ? (
						<div className="min-h-0 flex-1 overflow-y-auto">
							<div className="flex flex-wrap gap-4 border-b border-zinc-200 bg-zinc-50 px-4 py-2.5 text-xs text-muted-foreground dark:border-border dark:bg-muted/20 sm:px-6">
								<span>{preview.counts.total} candidates</span>
								<span>{preview.counts.highNoise} high-noise</span>
								<span>{preview.counts.duplicate} duplicate members</span>
								<span>{preview.counts.withIssue} source issues</span>
							</div>
							{preview.candidates.length ? (
								preview.candidates.map((candidate) => (
									<DecisionMigrationRow
										key={candidate.memoryId}
										candidate={candidate}
										decisions={decisions}
										busy={busy}
										onApply={handleApply}
										onRollback={handleRollback}
									/>
								))
							) : (
								<div className="px-4 py-10 text-sm text-muted-foreground sm:px-6">No Legacy Decision Memories found.</div>
							)}
						</div>
					) : (
						<div className="px-4 py-10 text-sm text-muted-foreground sm:px-6">
							{busy ? "Building read-only preview…" : "Preview has not been loaded."}
						</div>
					)}
				</DialogContent>
			</Dialog>
		</section>
	);
}

function DecisionMigrationRow({
	candidate,
	decisions,
	busy,
	onApply,
	onRollback,
}: {
	candidate: DecisionMigrationCandidate;
	decisions: DecisionEntry[];
	busy: boolean;
	onApply: (selection: DecisionMigrationSelection) => Promise<boolean>;
	onRollback: (memoryID: string) => Promise<boolean>;
}) {
	const [resolution, setResolution] = useState<DecisionMigrationResolution>(candidate.proposedResolution);
	const [decisionID, setDecisionID] = useState(candidate.proposedDecisionId || candidate.linkedDecisionId || "");
	const [targetMemoryID, setTargetMemoryID] = useState(candidate.proposedTargetId || "");
	const [category, setCategory] = useState(candidate.proposedCategory || "pattern");
	const [reason, setReason] = useState(candidate.noiseReasons?.join(", ") || "");
	const [relatedDocs, setRelatedDocs] = useState("");
	const [relatedTasks, setRelatedTasks] = useState("");
	const [acceptVerified, setAcceptVerified] = useState(false);
	const [reviewAction, setReviewAction] = useState<MigrationReviewAction | null>(null);

	useEffect(() => {
		setResolution(candidate.proposedResolution);
		setDecisionID(candidate.proposedDecisionId || candidate.linkedDecisionId || "");
		setTargetMemoryID(candidate.proposedTargetId || "");
		setCategory(candidate.proposedCategory || "pattern");
		setReason(candidate.noiseReasons?.join(", ") || "");
		setRelatedDocs("");
		setRelatedTasks("");
		setAcceptVerified(false);
		setReviewAction(null);
	}, [candidate]);

	const selection: DecisionMigrationSelection = {
		memoryId: candidate.memoryId,
		resolution,
		decisionId: resolution === "link_existing" ? decisionID : undefined,
		targetMemoryId: resolution === "consolidate_duplicate" ? targetMemoryID : undefined,
		category: resolution === "reclassify" ? category : undefined,
		reason: resolution === "archive_noise" || resolution === "reject_noise" ? reason : undefined,
		relatedDocs: resolution === "create_decision" || resolution === "link_existing" ? parseListInput(relatedDocs) : undefined,
		relatedTasks: resolution === "create_decision" || resolution === "link_existing" ? parseListInput(relatedTasks) : undefined,
		acceptVerified: resolution === "create_decision" || resolution === "link_existing" ? acceptVerified : false,
	};
	const missingRequired =
		(resolution === "link_existing" && !decisionID) ||
		(resolution === "consolidate_duplicate" && !targetMemoryID) ||
		(resolution === "reclassify" && !category);

	return (
		<div className="border-b border-border px-4 py-4 last:border-b-0 sm:px-6" data-testid={`decision-migration-row-${candidate.memoryId}`}>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-sm font-medium">{candidate.title}</span>
						<span className="font-mono text-xs text-muted-foreground">{candidate.memoryId}</span>
						<span className="rounded border border-border px-1.5 py-0.5 text-xs">{candidate.layer}</span>
						<span className="rounded border border-border px-1.5 py-0.5 text-xs">noise: {candidate.noiseLikelihood}</span>
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{candidate.sources.length ? candidate.sources.join(" · ") : "No recorded sources"}
						{candidate.sourceIssues?.length ? ` · ${candidate.sourceIssues.join(", ")}` : ""}
					</p>
				</div>
				{candidate.journalState ? <span className="rounded bg-muted px-2 py-1 text-xs">journal: {candidate.journalState}</span> : null}
			</div>

			<div className="mt-4 flex flex-wrap items-end gap-3">
				<FormField label="Reviewed resolution">
					<select value={resolution} onChange={(event) => setResolution(event.target.value as DecisionMigrationResolution)} className="min-h-10 rounded-lg border border-border bg-background px-2 text-sm">
						{migrationResolutions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
					</select>
				</FormField>
				{resolution === "link_existing" ? (
					<FormField label="System Decision">
						<select value={decisionID} onChange={(event) => setDecisionID(event.target.value)} className="min-h-10 max-w-72 rounded-lg border border-border bg-background px-2 text-sm">
							<option value="">Select Decision</option>
							{decisions.map((decision) => <option key={decision.id} value={decision.id}>{decision.title}</option>)}
						</select>
					</FormField>
				) : null}
				{resolution === "consolidate_duplicate" ? <FormField label="Target Memory"><input value={targetMemoryID} onChange={(event) => setTargetMemoryID(event.target.value)} className="min-h-10 rounded-lg border border-border bg-background px-2 text-sm" /></FormField> : null}
				{resolution === "reclassify" ? <FormField label="New category"><input value={category} onChange={(event) => setCategory(event.target.value)} className="min-h-10 rounded-lg border border-border bg-background px-2 text-sm" /></FormField> : null}
				{resolution === "archive_noise" || resolution === "reject_noise" ? <FormField label="Reason"><input value={reason} onChange={(event) => setReason(event.target.value)} className="min-h-10 rounded-lg border border-border bg-background px-2 text-sm" /></FormField> : null}
			</div>

			{resolution === "create_decision" || resolution === "link_existing" ? (
				<div className="mt-4 grid gap-4 sm:grid-cols-2">
					<ReferencePicker label="Related docs" value={relatedDocs} onChange={setRelatedDocs} placeholder="specs/path" allowedKinds={["doc"]} valueMode="related-doc" browseLabel="Find doc" />
					<ReferencePicker label="Completed task IDs" value={relatedTasks} onChange={setRelatedTasks} placeholder="task-id" allowedKinds={["task"]} valueMode="related-task" browseLabel="Find task" />
					<label className="flex min-h-10 items-center gap-2 text-xs sm:col-span-2">
						<input type="checkbox" checked={acceptVerified} onChange={(event) => setAcceptVerified(event.target.checked)} />
						Accept only if evidence verifies
					</label>
				</div>
			) : null}

			<div className="mt-4 flex flex-wrap gap-2">
				<ActionButton label={candidate.journalState === "applied" ? "Review recheck" : "Review apply"} Icon={ShieldCheck} disabled={busy || missingRequired || candidate.journalState === "rolled_back"} onClick={() => setReviewAction("apply")} />
				{candidate.journalState === "applied" || candidate.journalState === "failed" ? <ActionButton label="Review rollback" Icon={RotateCcw} disabled={busy} onClick={() => setReviewAction("rollback")} /> : null}
			</div>

			{reviewAction ? (
				<div className="mt-4 border-y border-amber-300 bg-amber-50/60 py-4 dark:border-amber-500/30 dark:bg-amber-500/5" data-testid={`decision-migration-confirm-${candidate.memoryId}`}>
					<div className="flex items-start gap-2">
						<CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
						<div>
							<h4 className="text-sm font-semibold">{reviewAction === "apply" ? "Review migration impact" : "Review rollback impact"}</h4>
							<p className="mt-1 text-xs text-muted-foreground">Target: {candidate.title} ({candidate.memoryId})</p>
						</div>
					</div>
					<p className="mt-3 text-sm leading-6">{reviewAction === "apply" ? migrationImpactText(selection) : "The migration journal restores the original Legacy Decision Memory snapshot and compensates migration-owned links or records where safe."}</p>
					<p className="mt-2 text-xs text-muted-foreground">{reviewAction === "apply" ? "Only this reviewed row is applied. Decision-backed legacy guidance remains readable until its replacement is verified and current." : "Rollback is bounded to this journaled row; unrelated Decision and Memory records are not changed."}</p>
					<div className="mt-4 flex flex-wrap justify-end gap-2">
						<ActionButton label="Cancel" disabled={busy} onClick={() => setReviewAction(null)} />
						<ActionButton
							label={reviewAction === "apply" ? "Confirm migration" : "Confirm rollback"}
							Icon={reviewAction === "apply" ? ShieldCheck : RotateCcw}
							tone={reviewAction === "rollback" ? "danger" : "primary"}
							disabled={busy}
							onClick={() => {
								void (async () => {
									const succeeded = reviewAction === "apply" ? await onApply(selection) : await onRollback(candidate.memoryId);
									if (succeeded) setReviewAction(null);
								})();
							}}
						/>
					</div>
				</div>
			) : null}
		</div>
	);
}

function migrationImpactText(selection: DecisionMigrationSelection) {
	const label = migrationResolutions.find((item) => item.value === selection.resolution)?.label || selection.resolution.replaceAll("_", " ");
	switch (selection.resolution) {
		case "create_decision":
			return `${label} for Memory ${selection.memoryId}. ${selection.acceptVerified ? "The new Decision is accepted only if linked evidence verifies." : "The new Decision starts as a draft candidate."}`;
		case "link_existing":
			return `${label} ${selection.decisionId || ""} to Memory ${selection.memoryId}. The legacy entry is excluded only when the linked Decision is current.`;
		case "consolidate_duplicate":
			return `${label} into migrated Memory ${selection.targetMemoryId || ""}; provenance is retained in the target Decision journal.`;
		case "reclassify":
			return `${label} ${selection.memoryId} from legacy decision to ${selection.category || "the reviewed category"}.`;
		case "archive_noise":
		case "reject_noise":
			return `${label} for ${selection.memoryId} and retain the reviewed reason in lifecycle metadata.`;
		default:
			return `${label} for ${selection.memoryId} and record that review in the reversible migration journal.`;
	}
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
	return (
		<label className="grid gap-2">
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			{children}
		</label>
	);
}

function ActionButton({
	label,
	Icon,
	disabled,
	onClick,
	tone = "neutral",
}: {
	label: string;
	Icon?: ComponentType<{ className?: string }>;
	disabled?: boolean;
	onClick: () => void;
	tone?: "neutral" | "primary" | "danger";
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50",
				tone === "neutral" && "border-border bg-background hover:bg-accent",
				tone === "primary" && "border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800",
				tone === "danger" && "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15",
			)}
		>
			{Icon ? <Icon className="h-4 w-4" /> : null}
			{label}
		</button>
	);
}

function parseListInput(value: string) {
	return value
		.split(/[\n,]+/)
		.map((item) => item.trim())
		.filter(Boolean);
}
