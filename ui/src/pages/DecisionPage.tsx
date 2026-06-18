import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import {
	decisionApi,
	type DecisionEntry,
	type DecisionResolveRequest,
	type DecisionStatus,
} from "@/ui/api/client";
import {
	CheckCircle2,
	CircleAlert,
	Clock3,
	FileText,
	GitBranch,
	History,
	Link2,
	Loader2,
	Plus,
	RefreshCw,
	ScrollText,
	ShieldCheck,
	Tags,
} from "lucide-react";
import MDRender from "@/ui/components/editor/MDRender";
import { cn } from "@/ui/lib/utils";

type DecisionFilter = DecisionStatus | "all";
type SupersedeMode = "create" | "select";

type ReplacementDraft = {
	title: string;
	status: DecisionStatus;
	tagsText: string;
	sourcesText: string;
	relatedDocsText: string;
	relatedTasksText: string;
	context: string;
	decision: string;
	alternativesConsidered: string;
	consequences: string;
};

type ReplacementPayload = {
	title: string;
	status: DecisionStatus;
	tags: string[];
	sources: string[];
	relatedDocs: string[];
	relatedTasks: string[];
	context: string;
	decision: string;
	alternativesConsidered: string;
	consequences: string;
};

const decisionFilters: Array<{ id: DecisionFilter; label: string }> = [
	{ id: "accepted", label: "Accepted" },
	{ id: "draft", label: "Draft" },
	{ id: "superseded", label: "Superseded" },
	{ id: "rejected", label: "Rejected" },
	{ id: "archived", label: "Archived" },
	{ id: "all", label: "All" },
];

const statusLabels: Record<DecisionStatus, string> = {
	draft: "Draft",
	accepted: "Accepted",
	superseded: "Superseded",
	rejected: "Rejected",
	archived: "Archived",
};

const bodySections: Array<{ key: keyof DecisionEntry; label: string }> = [
	{ key: "context", label: "Context" },
	{ key: "decision", label: "Decision" },
	{ key: "alternativesConsidered", label: "Alternatives considered" },
	{ key: "consequences", label: "Consequences" },
];

const emptyDraft = (): ReplacementDraft => ({
	title: "",
	status: "accepted",
	tagsText: "",
	sourcesText: "",
	relatedDocsText: "",
	relatedTasksText: "",
	context: "",
	decision: "",
	alternativesConsidered: "",
	consequences: "",
});

export default function DecisionPage() {
	const [currentDecisions, setCurrentDecisions] = useState<DecisionEntry[]>([]);
	const [allDecisions, setAllDecisions] = useState<DecisionEntry[]>([]);
	const [filter, setFilter] = useState<DecisionFilter>("accepted");
	const [selectedID, setSelectedID] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [actionBusy, setActionBusy] = useState(false);
	const [errorMessage, setErrorMessage] = useState("");
	const [notice, setNotice] = useState("");

	const loadDecisions = useCallback(async () => {
		setErrorMessage("");
		const [current, all] = await Promise.all([
			decisionApi.list(),
			decisionApi.list({ includeAll: true }),
		]);
		const merged = mergeDecisionSets(current, all);
		setCurrentDecisions(current);
		setAllDecisions(merged);
		return { current, all: merged };
	}, []);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		loadDecisions()
			.catch((err: unknown) => {
				if (!cancelled) {
					setErrorMessage(err instanceof Error ? err.message : "Failed to load decisions");
				}
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [loadDecisions]);

	const decisionByID = useMemo(() => {
		const byID = new Map<string, DecisionEntry>();
		for (const decision of allDecisions) {
			byID.set(decision.id, decision);
		}
		return byID;
	}, [allDecisions]);

	const currentIDs = useMemo(() => new Set(currentDecisions.map((decision) => decision.id)), [currentDecisions]);

	const filterCounts = useMemo(() => {
		const counts: Record<DecisionFilter, number> = {
			accepted: currentDecisions.length,
			draft: 0,
			superseded: 0,
			rejected: 0,
			archived: 0,
			all: allDecisions.length,
		};
		for (const decision of allDecisions) {
			if (decision.status !== "accepted") {
				counts[decision.status] += 1;
			}
		}
		return counts;
	}, [allDecisions, currentDecisions.length]);

	const visibleDecisions = useMemo(() => {
		if (filter === "accepted") {
			return currentDecisions;
		}
		if (filter === "all") {
			return allDecisions;
		}
		return allDecisions.filter((decision) => decision.status === filter);
	}, [allDecisions, currentDecisions, filter]);

	const selectedDecision = useMemo(() => {
		if (selectedID) {
			const selected = decisionByID.get(selectedID);
			if (selected) return selected;
		}
		return visibleDecisions[0] ?? null;
	}, [decisionByID, selectedID, visibleDecisions]);

	const replacementCandidates = useMemo(
		() =>
			allDecisions.filter(
				(decision) =>
					decision.id !== selectedDecision?.id &&
					decision.status !== "superseded" &&
					decision.status !== "rejected" &&
					decision.status !== "archived",
			),
		[allDecisions, selectedDecision?.id],
	);

	const handleRefresh = useCallback(async () => {
		setLoading(true);
		setNotice("");
		try {
			await loadDecisions();
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : "Failed to refresh decisions");
		} finally {
			setLoading(false);
		}
	}, [loadDecisions]);

	const handleOpenDecision = useCallback((id: string) => {
		setSelectedID(id);
	}, []);

	const handleOpenLinkedDecision = useCallback(
		(id: string) => {
			if (!decisionByID.has(id)) return;
			setFilter("all");
			setSelectedID(id);
		},
		[decisionByID],
	);

	const handleCreateReplacement = useCallback(
		async (target: DecisionEntry, replacement: ReplacementPayload) => {
			setActionBusy(true);
			setErrorMessage("");
			setNotice("");
			try {
				const request: DecisionResolveRequest = {
					resolution: "supersede_existing",
					targetId: target.id,
					...replacement,
				};
				await decisionApi.resolveReview(request);
				await loadDecisions();
				setFilter("superseded");
				setSelectedID(target.id);
				setNotice(`${target.title} is now historical guidance.`);
			} catch (err) {
				setErrorMessage(err instanceof Error ? err.message : "Failed to supersede decision");
			} finally {
				setActionBusy(false);
			}
		},
		[loadDecisions],
	);

	const handleSelectReplacement = useCallback(
		async (target: DecisionEntry, replacementID: string) => {
			setActionBusy(true);
			setErrorMessage("");
			setNotice("");
			try {
				await decisionApi.supersede(target.id, replacementID);
				await loadDecisions();
				setFilter("superseded");
				setSelectedID(target.id);
				setNotice(`${target.title} is now historical guidance.`);
			} catch (err) {
				setErrorMessage(err instanceof Error ? err.message : "Failed to supersede decision");
			} finally {
				setActionBusy(false);
			}
		},
		[loadDecisions],
	);

	if (loading) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="h-5 w-5 animate-spin" />
					<span>Loading decisions...</span>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden bg-background">
			<header className="shrink-0 border-b border-border/60 px-4 py-4 sm:px-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-3">
							<h1 className="text-2xl font-semibold tracking-tight">Decision ledger</h1>
							<span className="rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground">
								{currentDecisions.length} current
							</span>
						</div>
						<p className="mt-1 text-sm text-muted-foreground">
							Current accepted guidance first. Historical records stay visible when you ask for them.
						</p>
					</div>
					<button
						type="button"
						onClick={() => void handleRefresh()}
						className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border/60 px-3 text-sm font-medium transition-colors hover:bg-accent"
					>
						<RefreshCw className="h-4 w-4" />
						Refresh
					</button>
				</div>

				<div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Decision status filters">
					{decisionFilters.map((tab) => (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={filter === tab.id}
							onClick={() => setFilter(tab.id)}
							className={cn(
								"inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors",
								filter === tab.id
									? "bg-foreground text-background"
									: "bg-muted text-muted-foreground hover:text-foreground",
							)}
						>
							<span>{tab.label}</span>
							<span className="rounded bg-background/20 px-1.5 py-0.5 text-[11px]">{filterCounts[tab.id]}</span>
						</button>
					))}
				</div>
			</header>

			{errorMessage && (
				<div className="mx-4 mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive sm:mx-6">
					{errorMessage}
				</div>
			)}
			{notice && (
				<div className="mx-4 mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300 sm:mx-6">
					{notice}
				</div>
			)}

			<main className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_430px] lg:grid-rows-1">
				<section className="min-h-[520px] flex-1 overflow-y-auto px-4 py-4 sm:px-6 lg:min-h-0" data-testid="decision-list">
					<DecisionList
						filter={filter}
						decisions={visibleDecisions}
						currentIDs={currentIDs}
						selectedID={selectedDecision?.id ?? null}
						onOpen={handleOpenDecision}
					/>
				</section>

				<DecisionDetailPanel
					decision={selectedDecision}
					decisionByID={decisionByID}
					replacementCandidates={replacementCandidates}
					actionBusy={actionBusy}
					onOpenDecision={handleOpenLinkedDecision}
					onCreateReplacement={handleCreateReplacement}
					onSelectReplacement={handleSelectReplacement}
				/>
			</main>
		</div>
	);
}

function DecisionList({
	filter,
	decisions,
	currentIDs,
	selectedID,
	onOpen,
}: {
	filter: DecisionFilter;
	decisions: DecisionEntry[];
	currentIDs: Set<string>;
	selectedID: string | null;
	onOpen: (id: string) => void;
}) {
	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-3">
				<h2 className="text-sm font-semibold">{viewTitle(filter)}</h2>
				<span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{decisions.length}</span>
			</div>
			{decisions.length === 0 ? (
				<EmptyState title="No decisions here" description="This status has no Decision records in the current project." />
			) : (
				<div className="space-y-2">
					{decisions.map((decision) => (
						<DecisionListRow
							key={decision.id}
							decision={decision}
							current={currentIDs.has(decision.id)}
							active={selectedID === decision.id}
							onOpen={onOpen}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function DecisionListRow({
	decision,
	current,
	active,
	onOpen,
}: {
	decision: DecisionEntry;
	current: boolean;
	active: boolean;
	onOpen: (id: string) => void;
}) {
	const preview = decision.decision || decision.context || decision.content || "";
	return (
		<button
			type="button"
			onClick={() => onOpen(decision.id)}
			className={cn(
				"grid min-h-[92px] w-full gap-2 rounded-lg border px-3 py-3 text-left transition-colors [contain-intrinsic-size:0_92px] [content-visibility:auto]",
				active ? "border-foreground/40 bg-muted/40" : "border-border/60 bg-card hover:bg-accent/40",
				isHistoricalDecision(decision) && "border-amber-500/40 bg-amber-500/5",
			)}
			data-testid={`decision-row-${decision.id}`}
		>
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<span className="truncate text-sm font-semibold">{decision.title}</span>
				<StatusPill status={decision.status} current={current} />
				{isHistoricalDecision(decision) && <HistoricalPill />}
			</div>
			<p className="line-clamp-2 text-sm text-muted-foreground">{preview || "No decision body."}</p>
			<div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
				<span className="font-mono">{decision.id}</span>
				<span>{formatDate(decision.updatedAt)}</span>
				{decision.tags?.slice(0, 2).map((tag) => (
					<span key={tag} className="truncate">
						#{tag}
					</span>
				))}
			</div>
		</button>
	);
}

function DecisionDetailPanel({
	decision,
	decisionByID,
	replacementCandidates,
	actionBusy,
	onOpenDecision,
	onCreateReplacement,
	onSelectReplacement,
}: {
	decision: DecisionEntry | null;
	decisionByID: Map<string, DecisionEntry>;
	replacementCandidates: DecisionEntry[];
	actionBusy: boolean;
	onOpenDecision: (id: string) => void;
	onCreateReplacement: (target: DecisionEntry, replacement: ReplacementPayload) => Promise<void>;
	onSelectReplacement: (target: DecisionEntry, replacementID: string) => Promise<void>;
}) {
	if (!decision) {
		return (
			<aside
				className="border-t border-border/60 p-4 lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-t-0"
				data-testid="decision-detail-panel"
			>
				<EmptyState title="Select a decision" description="Open a Decision row to inspect metadata, refs, and supersession links." />
			</aside>
		);
	}

	const historical = isHistoricalDecision(decision);
	const supersedes = decision.supersedes || [];
	const supersededBy = decision.supersededBy || [];

	return (
		<aside
			className={cn(
				"min-h-0 border-t border-border/60 bg-muted/10 lg:overflow-y-auto lg:border-l lg:border-t-0",
				historical && "bg-amber-500/5",
			)}
			data-testid="decision-detail-panel"
		>
			<div className={cn("space-y-5 p-4", historical && "border-l-4 border-amber-500/70")}>
				<div className="space-y-3">
					<div className="flex flex-wrap items-center gap-2">
						<StatusPill status={decision.status} current={!historical && decision.status === "accepted"} />
						{historical && <HistoricalPill />}
					</div>
					<div>
						<h2 className="text-lg font-semibold leading-tight">{decision.title}</h2>
						<p className="mt-1 break-all font-mono text-xs text-muted-foreground">@decision/{decision.id}</p>
					</div>
					{historical && (
						<div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
							<div className="flex items-start gap-2">
								<CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
								<div>
									<p className="font-medium">Historical guidance</p>
									<p>Use current replacements for default recommendations.</p>
								</div>
							</div>
						</div>
					)}
				</div>

				<DetailSection title="Status">
					<div className="grid gap-2 sm:grid-cols-2">
						<MetadataItem label="Created" value={formatDate(decision.createdAt)} />
						<MetadataItem label="Updated" value={formatDate(decision.updatedAt)} />
						<MetadataItem label="Sources" value={String(decision.sources?.length || 0)} />
						<MetadataItem label="Related refs" value={String((decision.relatedDocs?.length || 0) + (decision.relatedTasks?.length || 0))} />
					</div>
				</DetailSection>

				<DetailSection title="Supersession">
					<ReferenceList
						empty="No superseded predecessors."
						refs={supersedes}
						decisionByID={decisionByID}
						onOpen={onOpenDecision}
						prefix="Supersedes"
					/>
					<div className="mt-2">
						<ReferenceList
							empty="No replacement recorded."
							refs={supersededBy}
							decisionByID={decisionByID}
							onOpen={onOpenDecision}
							prefix="Superseded by"
						/>
					</div>
				</DetailSection>

				<DetailSection title="Related">
					<div className="space-y-3">
						<TokenGroup label="Sources" values={decision.sources || []} Icon={Link2} />
						<TokenGroup label="Docs" values={decision.relatedDocs || []} Icon={FileText} />
						<TokenGroup label="Tasks" values={decision.relatedTasks || []} Icon={CheckCircle2} />
						<TokenGroup label="Tags" values={decision.tags || []} Icon={Tags} prefix="#" />
					</div>
				</DetailSection>

				<DetailSection title="Body sections">
					<div className="space-y-3">
						{bodySections.map((section) => (
							<BodySection key={section.key} title={section.label} markdown={String(decision[section.key] || "")} />
						))}
					</div>
				</DetailSection>

				{!historical ? (
					<SupersedePanel
						target={decision}
						candidates={replacementCandidates}
						busy={actionBusy}
						onCreate={onCreateReplacement}
						onSelect={onSelectReplacement}
					/>
				) : (
					<DetailSection title="Supersede">
						<p className="rounded-lg border border-amber-500/30 bg-background px-3 py-3 text-sm text-muted-foreground">
							This record is already historical. Open the current replacement to continue the chain.
						</p>
					</DetailSection>
				)}
			</div>
		</aside>
	);
}

function SupersedePanel({
	target,
	candidates,
	busy,
	onCreate,
	onSelect,
}: {
	target: DecisionEntry;
	candidates: DecisionEntry[];
	busy: boolean;
	onCreate: (target: DecisionEntry, replacement: ReplacementPayload) => Promise<void>;
	onSelect: (target: DecisionEntry, replacementID: string) => Promise<void>;
}) {
	const [mode, setMode] = useState<SupersedeMode>("create");
	const [draft, setDraft] = useState<ReplacementDraft>(() => emptyDraft());
	const [selectedReplacementID, setSelectedReplacementID] = useState("");

	useEffect(() => {
		setMode("create");
		setDraft(emptyDraft());
		setSelectedReplacementID(candidates[0]?.id || "");
	}, [target.id, candidates]);

	const canCreate = draft.title.trim() !== "" && draft.decision.trim() !== "";
	const canSelect = selectedReplacementID.trim() !== "";

	return (
		<DetailSection title="Supersede">
			<div className="space-y-3 rounded-lg border border-border/60 bg-background p-3" data-testid="decision-supersede-panel">
				<div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Supersede mode">
					<button
						type="button"
						role="tab"
						aria-selected={mode === "create"}
						onClick={() => setMode("create")}
						className={cn(
							"inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium",
							mode === "create" ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground",
						)}
					>
						<Plus className="h-4 w-4" />
						Create
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={mode === "select"}
						onClick={() => setMode("select")}
						className={cn(
							"inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium",
							mode === "select" ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground",
						)}
					>
						<GitBranch className="h-4 w-4" />
						Select
					</button>
				</div>

				{mode === "create" ? (
					<form
						className="space-y-3"
						onSubmit={(event) => {
							event.preventDefault();
							if (!canCreate || busy) return;
							void onCreate(target, {
								title: draft.title,
								status: draft.status,
								tags: parseListInput(draft.tagsText),
								sources: parseListInput(draft.sourcesText),
								relatedDocs: parseListInput(draft.relatedDocsText),
								relatedTasks: parseListInput(draft.relatedTasksText),
								context: draft.context,
								decision: draft.decision,
								alternativesConsidered: draft.alternativesConsidered,
								consequences: draft.consequences,
							});
						}}
					>
						<FormField label="Replacement title">
							<input
								value={draft.title}
								onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
								placeholder="Use Qdrant as default vector DB"
								className="min-h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-primary"
							/>
						</FormField>
						<div className="grid gap-3 sm:grid-cols-2">
							<FormField label="Status">
								<select
									value={draft.status}
									onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as DecisionStatus }))}
									className="min-h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-primary"
								>
									<option value="accepted">Accepted</option>
									<option value="draft">Draft</option>
								</select>
							</FormField>
							<FormField label="Tags">
								<input
									value={draft.tagsText}
									onChange={(event) => setDraft((current) => ({ ...current, tagsText: event.target.value }))}
									placeholder="search, architecture"
									className="min-h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-primary"
								/>
							</FormField>
						</div>
						<FormField label="Sources">
							<input
								value={draft.sourcesText}
								onChange={(event) => setDraft((current) => ({ ...current, sourcesText: event.target.value }))}
								placeholder="@doc/specs/path or @task/id"
								className="min-h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-primary"
							/>
						</FormField>
						<div className="grid gap-3 sm:grid-cols-2">
							<FormField label="Related docs">
								<input
									value={draft.relatedDocsText}
									onChange={(event) => setDraft((current) => ({ ...current, relatedDocsText: event.target.value }))}
									placeholder="specs/vector"
									className="min-h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-primary"
								/>
							</FormField>
							<FormField label="Related tasks">
								<input
									value={draft.relatedTasksText}
									onChange={(event) => setDraft((current) => ({ ...current, relatedTasksText: event.target.value }))}
									placeholder="h1oeud"
									className="min-h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-primary"
								/>
							</FormField>
						</div>
						<FormField label="Context">
							<textarea
								value={draft.context}
								onChange={(event) => setDraft((current) => ({ ...current, context: event.target.value }))}
								rows={3}
								className="w-full resize-y rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
							/>
						</FormField>
						<FormField label="Decision">
							<textarea
								value={draft.decision}
								onChange={(event) => setDraft((current) => ({ ...current, decision: event.target.value }))}
								rows={4}
								className="w-full resize-y rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
							/>
						</FormField>
						<div className="grid gap-3 sm:grid-cols-2">
							<FormField label="Alternatives considered">
								<textarea
									value={draft.alternativesConsidered}
									onChange={(event) =>
										setDraft((current) => ({ ...current, alternativesConsidered: event.target.value }))
									}
									rows={3}
									className="w-full resize-y rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
								/>
							</FormField>
							<FormField label="Consequences">
								<textarea
									value={draft.consequences}
									onChange={(event) => setDraft((current) => ({ ...current, consequences: event.target.value }))}
									rows={3}
									className="w-full resize-y rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
								/>
							</FormField>
						</div>
						<ActionButton label="Create replacement" Icon={ShieldCheck} disabled={!canCreate || busy} />
					</form>
				) : (
					<form
						className="space-y-3"
						onSubmit={(event) => {
							event.preventDefault();
							if (!canSelect || busy) return;
							void onSelect(target, selectedReplacementID);
						}}
					>
						<FormField label="Replacement Decision">
							<select
								value={selectedReplacementID}
								onChange={(event) => setSelectedReplacementID(event.target.value)}
								className="min-h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-primary"
							>
								{candidates.length === 0 ? (
									<option value="">No eligible replacements</option>
								) : (
									candidates.map((candidate) => (
										<option key={candidate.id} value={candidate.id}>
											{candidate.title}
										</option>
									))
								)}
							</select>
						</FormField>
						<ActionButton label="Use selected" Icon={GitBranch} disabled={!canSelect || busy} />
					</form>
				)}
			</div>
		</DetailSection>
	);
}

function ReferenceList({
	refs,
	decisionByID,
	onOpen,
	prefix,
	empty,
}: {
	refs: string[];
	decisionByID: Map<string, DecisionEntry>;
	onOpen: (id: string) => void;
	prefix: string;
	empty: string;
}) {
	if (refs.length === 0) {
		return <p className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-sm text-muted-foreground">{empty}</p>;
	}
	return (
		<div className="space-y-2">
			{refs.map((id) => {
				const linked = decisionByID.get(id);
				return (
					<button
						key={`${prefix}-${id}`}
						type="button"
						onClick={() => onOpen(id)}
						disabled={!linked}
						className="grid min-h-12 w-full gap-1 rounded-lg border border-border/60 bg-background px-3 py-2 text-left text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
					>
						<span className="text-xs text-muted-foreground">{prefix}</span>
						<span className="truncate font-medium">{linked?.title || id}</span>
					</button>
				);
			})}
		</div>
	);
}

function TokenGroup({
	label,
	values,
	Icon,
	prefix = "",
}: {
	label: string;
	values: string[];
	Icon: ComponentType<{ className?: string }>;
	prefix?: string;
}) {
	return (
		<div>
			<div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
				<Icon className="h-3.5 w-3.5" />
				<span>{label}</span>
			</div>
			{values.length === 0 ? (
				<p className="rounded-lg border border-dashed border-border/60 px-3 py-2 text-sm text-muted-foreground">None linked.</p>
			) : (
				<div className="flex flex-wrap gap-2">
					{values.map((value) => (
						<span key={`${label}-${value}`} className="max-w-full rounded-md border border-border/60 px-2 py-1 font-mono text-xs">
							{prefix}
							{value}
						</span>
					))}
				</div>
			)}
		</div>
	);
}

function BodySection({ title, markdown }: { title: string; markdown: string }) {
	return (
		<section className="rounded-lg border border-border/60 bg-background p-3">
			<h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
				<ScrollText className="h-4 w-4 text-muted-foreground" />
				{title}
			</h4>
			{markdown.trim() ? (
				<MDRender markdown={markdown} className="prose prose-sm max-w-none dark:prose-invert" />
			) : (
				<p className="text-sm text-muted-foreground">Not documented.</p>
			)}
		</section>
	);
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="space-y-2">
			<h3 className="text-xs font-semibold uppercase text-muted-foreground">{title}</h3>
			{children}
		</section>
	);
}

function MetadataItem({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-lg border border-border/60 bg-background px-3 py-2">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className="mt-1 truncate text-sm font-medium">{value}</p>
		</div>
	);
}

function StatusPill({ status, current }: { status: DecisionStatus; current?: boolean }) {
	const classes: Record<DecisionStatus, string> = {
		accepted: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
		draft: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
		superseded: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
		rejected: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
		archived: "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
	};
	return (
		<span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium", classes[status])}>
			{current ? <ShieldCheck className="h-3 w-3" /> : <Clock3 className="h-3 w-3" />}
			{current ? "Current" : statusLabels[status]}
		</span>
	);
}

function HistoricalPill() {
	return (
		<span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
			<History className="h-3 w-3" />
			Historical
		</span>
	);
}

function ActionButton({
	label,
	Icon,
	disabled,
	onClick,
}: {
	label: string;
	Icon?: ComponentType<{ className?: string }>;
	disabled?: boolean;
	onClick?: () => void;
}) {
	return (
		<button
			type={onClick ? "button" : "submit"}
			disabled={disabled}
			onClick={onClick}
			title={label}
			className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-border/60 px-3 text-sm font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
		>
			{Icon && <Icon className="h-4 w-4" />}
			<span className="truncate">{label}</span>
		</button>
	);
}

function EmptyState({ title, description }: { title: string; description: string }) {
	return (
		<div className="flex min-h-48 flex-col justify-center rounded-lg border border-dashed border-border/60 px-4 py-8 text-center">
			<p className="text-sm font-medium">{title}</p>
			<p className="mt-1 text-sm text-muted-foreground">{description}</p>
		</div>
	);
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
	return (
		<label className="grid gap-2">
			<span className="text-sm font-medium">{label}</span>
			{children}
		</label>
	);
}

function mergeDecisionSets(current: DecisionEntry[], all: DecisionEntry[]) {
	const byID = new Map<string, DecisionEntry>();
	for (const decision of all) {
		byID.set(decision.id, decision);
	}
	for (const decision of current) {
		byID.set(decision.id, decision);
	}
	return Array.from(byID.values());
}

function isHistoricalDecision(decision: DecisionEntry) {
	return decision.status === "superseded" || (decision.supersededBy?.length || 0) > 0;
}

function viewTitle(view: DecisionFilter) {
	switch (view) {
		case "accepted":
			return "Current accepted Decisions";
		case "draft":
			return "Draft Decisions";
		case "superseded":
			return "Superseded Decisions";
		case "rejected":
			return "Rejected Decisions";
		case "archived":
			return "Archived Decisions";
		case "all":
			return "All Decisions";
		default:
			return "Decisions";
	}
}

function parseListInput(value: string) {
	return value
		.split(/[\n,]+/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function formatDate(value?: string) {
	if (!value) return "Not set";
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return "Not set";
	return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
