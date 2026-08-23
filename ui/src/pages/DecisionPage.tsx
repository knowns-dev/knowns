import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
	decisionApi,
	DecisionReviewRequiredError,
	type DecisionEntry,
	type DecisionReviewResolution,
	type DecisionReviewState,
	type DecisionStatus,
} from "@/ui/api/client";
import {
	ArrowLeft,
	CheckCircle2,
	ChevronRight,
	CircleAlert,
	Clock3,
	Copy,
	FileText,
	GitBranch,
	History,
	Inbox,
	Link2,
	Loader2,
	Plus,
	RefreshCw,
	ScrollText,
	Search,
	ShieldCheck,
	Tags,
	X,
} from "lucide-react";
import MDRender from "@/ui/components/editor/MDRender";
import ReferencePicker from "@/ui/components/organisms/ReferencePicker";
import { Button } from "@/ui/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/ui/components/ui/dialog";
import { PageContent, PageShell } from "@/ui/components/templates/PageShell";
import { FeatureHeader } from "@/ui/components/templates";
import { cn } from "@/ui/lib/utils";

type DecisionView = "current" | "review" | "history";

type DecisionDraft = {
	title: string;
	tagsText: string;
	sourcesText: string;
	relatedDocsText: string;
	relatedTasksText: string;
	context: string;
	decision: string;
	alternativesConsidered: string;
	consequences: string;
};

type ReviewAction =
	| { kind: "link_evidence"; links: EvidenceLinks }
	| { kind: "accept_new" }
	| { kind: "link_as_related"; targetID: string; targetTitle: string }
	| { kind: "supersede_existing"; targetID: string; targetTitle: string }
	| { kind: "reject_new" };

type EvidenceLinks = {
	sources: string[];
	relatedDocs: string[];
	relatedTasks: string[];
};

const destinations: Array<{
	id: DecisionView;
	label: string;
	path: "/decisions" | "/decisions/review" | "/decisions/history";
	icon: ComponentType<{ className?: string }>;
}> = [
	{ id: "current", label: "Current", path: "/decisions", icon: ShieldCheck },
	{ id: "review", label: "Review Inbox", path: "/decisions/review", icon: Inbox },
	{ id: "history", label: "History", path: "/decisions/history", icon: History },
];

const destinationStatusWords: Record<DecisionView, string> = {
	current: "current",
	review: "pending",
	history: "historical",
};

const statusLabels: Record<DecisionStatus, string> = {
	draft: "Draft",
	accepted: "Accepted",
	superseded: "Superseded",
	rejected: "Rejected",
	archived: "Archived",
};

const reviewStateLabels: Record<DecisionReviewState, string> = {
	needs_evidence: "Needs evidence",
	needs_resolution: "Needs resolution",
	ready_for_review: "Ready for review",
};

const bodySections: Array<{ key: keyof DecisionEntry; label: string }> = [
	{ key: "context", label: "Context" },
	{ key: "decision", label: "Decision" },
	{ key: "alternativesConsidered", label: "Alternatives considered" },
	{ key: "consequences", label: "Consequences" },
];

const emptyDraft = (): DecisionDraft => ({
	title: "",
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
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const view = viewFromPath(pathname);
	// The graph links straight to one entry, e.g. /decisions/<id>, so a node there
	// opens the same detail dialog the list uses.
	const routeSelectedID = useMemo(() => {
		const match = pathname.match(/^\/decisions\/([^/]+)\/?$/);
		const id = match?.[1];
		if (!id) return null;
		return ["review", "history"].includes(id) ? null : decodeURIComponent(id);
	}, [pathname]);
	const [currentDecisions, setCurrentDecisions] = useState<DecisionEntry[]>([]);
	const [allDecisions, setAllDecisions] = useState<DecisionEntry[]>([]);
	const [reviewCandidates, setReviewCandidates] = useState<DecisionEntry[]>([]);
	const [selectedID, setSelectedID] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(true);
	const [actionBusy, setActionBusy] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [errorMessage, setErrorMessage] = useState("");
	const [notice, setNotice] = useState("");
	const lastOpenedDecisionID = useRef<string | null>(null);

	const loadDecisions = useCallback(async () => {
		setErrorMessage("");
		const [current, all, inbox] = await Promise.all([
			decisionApi.list(),
			decisionApi.list({ includeAll: true }),
			decisionApi.reviewInbox(),
		]);
		setCurrentDecisions(current);
		setAllDecisions(mergeDecisionSets(current, all, inbox));
		setReviewCandidates(inbox);
		return { current, all, inbox };
	}, []);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		loadDecisions()
			.catch((error: unknown) => {
				if (!cancelled) setErrorMessage(error instanceof Error ? error.message : "Failed to load Decisions");
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [loadDecisions]);

	useEffect(() => {
		setSelectedID(null);
		setQuery("");
	}, [view]);

	const historyDecisions = useMemo(
		() =>
			allDecisions.filter(
				(decision) =>
					decision.status === "superseded" ||
					decision.status === "rejected" ||
					decision.status === "archived",
			),
		[allDecisions],
	);

	const destinationDecisions = useMemo(() => {
		switch (view) {
			case "review":
				return reviewCandidates;
			case "history":
				return historyDecisions;
			default:
				return currentDecisions;
		}
	}, [currentDecisions, historyDecisions, reviewCandidates, view]);

	const visibleDecisions = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		if (!normalized) return destinationDecisions;
		return destinationDecisions.filter((entry) =>
			[
				entry.title,
				entry.id,
				entry.decision,
				...(entry.tags || []),
				...(entry.sources || []),
				...(entry.relatedDocs || []),
				...(entry.relatedTasks || []),
			]
				.filter(Boolean)
				.some((value) => String(value).toLowerCase().includes(normalized)),
		);
	}, [destinationDecisions, query]);

	const decisionByID = useMemo(() => {
		const byID = new Map<string, DecisionEntry>();
		for (const decision of allDecisions) byID.set(decision.id, decision);
		for (const decision of reviewCandidates) byID.set(decision.id, decision);
		return byID;
	}, [allDecisions, reviewCandidates]);

	// A linked entry may sit in a tab that has not been fetched yet — a proposal
	// while the trusted list is showing, say — so fall back to loading it alone.
	const [routeEntry, setRouteEntry] = useState<DecisionEntry | null>(null);
	useEffect(() => {
		if (!routeSelectedID) {
			setRouteEntry(null);
			return;
		}
		setSelectedID(routeSelectedID);
		if (decisionByID.has(routeSelectedID)) return;
		let cancelled = false;
		decisionApi
			.get(routeSelectedID)
			.then((entry) => {
				if (!cancelled) setRouteEntry(entry);
			})
			.catch(() => {
				if (!cancelled) setRouteEntry(null);
			});
		return () => {
			cancelled = true;
		};
	}, [decisionByID, routeSelectedID]);

	const selectedDecision = selectedID ? decisionByID.get(selectedID) || routeEntry || null : null;

	const destinationCounts: Record<DecisionView, number> = {
		current: currentDecisions.length,
		review: reviewCandidates.length,
		history: historyDecisions.length,
	};

	const headerStatus = useMemo(() => {
		const count = destinationCounts[view];
		const word = destinationStatusWords[view];
		if (count === 0) return `No ${word} Decisions`;
		return `${count} ${word} ${count === 1 ? "Decision" : "Decisions"}`;
	}, [destinationCounts, view]);

	const handleNavigate = useCallback(
		(nextView: DecisionView) => {
			const destination = destinations.find((item) => item.id === nextView);
			if (destination) void navigate({ to: destination.path });
		},
		[navigate],
	);

	const handleOpenDecision = useCallback((id: string) => {
		lastOpenedDecisionID.current = id;
		setSelectedID(id);
	}, []);

	const handleCloseDecision = useCallback(() => {
		setSelectedID(null);
		const decisionID = lastOpenedDecisionID.current;
		if (!decisionID) return;
		requestAnimationFrame(() => {
			document.querySelector<HTMLButtonElement>(`[data-testid="decision-row-${decisionID}"]`)?.focus();
		});
	}, []);

	const handleRefresh = useCallback(async () => {
		setLoading(true);
		setNotice("");
		try {
			await loadDecisions();
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Failed to refresh Decisions");
		} finally {
			setLoading(false);
		}
	}, [loadDecisions]);

	const handleCreateCandidate = useCallback(
		async (draft: DecisionDraft) => {
			setActionBusy(true);
			setErrorMessage("");
			let candidateID = "";
			try {
				const candidate = await decisionApi.create({
					title: draft.title.trim(),
					status: "draft",
					tags: parseListInput(draft.tagsText),
					sources: parseListInput(draft.sourcesText),
					relatedDocs: parseListInput(draft.relatedDocsText),
					relatedTasks: parseListInput(draft.relatedTasksText),
					context: draft.context,
					decision: draft.decision,
					alternativesConsidered: draft.alternativesConsidered,
					consequences: draft.consequences,
				});
				candidateID = candidate.id;
			} catch (error) {
				if (error instanceof DecisionReviewRequiredError && error.result.candidate) {
					candidateID = error.result.candidate.id;
				} else {
					setErrorMessage(error instanceof Error ? error.message : "Failed to create Decision candidate");
					return;
				}
			} finally {
				setActionBusy(false);
			}

			setCreateOpen(false);
			setSelectedID(null);
			handleNavigate("review");
			try {
				const refreshed = await loadDecisions();
				const candidate = refreshed.inbox.find((entry) => entry.id === candidateID);
				setNotice(
					candidate
						? `Candidate saved to Review Inbox as ${reviewStateLabel(candidate)}.`
						: "Candidate saved to Review Inbox.",
				);
			} catch (error) {
				setErrorMessage(
					error instanceof Error
						? `Candidate was saved, but Review Inbox could not refresh: ${error.message}`
						: "Candidate was saved, but Review Inbox could not refresh.",
				);
			}
		},
		[handleNavigate, loadDecisions],
	);

	const handleLinkEvidence = useCallback(
		async (candidate: DecisionEntry, links: EvidenceLinks) => {
			setActionBusy(true);
			setErrorMessage("");
			try {
				const updated = await decisionApi.link(candidate.id, links);
				await loadDecisions();
				setSelectedID(updated.id);
				setNotice(`Evidence reviewed. Candidate is now ${reviewStateLabel(updated)}.`);
				return true;
			} catch (error) {
				setErrorMessage(error instanceof Error ? error.message : "Failed to link candidate evidence");
				return false;
			} finally {
				setActionBusy(false);
			}
		},
		[loadDecisions],
	);

	const handleResolveCandidate = useCallback(
		async (candidate: DecisionEntry, resolution: DecisionReviewResolution, targetId?: string) => {
			setActionBusy(true);
			setErrorMessage("");
			try {
				await decisionApi.resolveReview({
					candidateId: candidate.id,
					resolution,
					targetId,
				});
				await loadDecisions();
				setSelectedID(null);
				setNotice(resolutionNotice(resolution, candidate.title));
				return true;
			} catch (error) {
				setErrorMessage(error instanceof Error ? error.message : "Failed to resolve Decision candidate");
				return false;
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
					<span>Loading Decisions…</span>
				</div>
			</div>
		);
	}

	return (
		<PageShell>
			<FeatureHeader
				className="border-b-0"
				icon={ScrollText}
				title="System Decisions"
				status={headerStatus}
				actions={
					<>
						{view === "review" ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setCreateOpen(true)}
								className="h-11 sm:h-8"
							>
								<Plus className="h-4 w-4" />
								New candidate
							</Button>
						) : null}
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={() => void handleRefresh()}
							aria-label="Refresh Decisions"
							className="h-11 w-11 sm:h-8 sm:w-8"
						>
							<RefreshCw className="h-4 w-4" />
						</Button>
					</>
				}
			/>

			{errorMessage ? (
				<div role="alert" className="fixed left-1/2 top-4 z-[90] w-[min(92vw,640px)] -translate-x-1/2 rounded-lg border border-destructive/30 bg-card px-4 py-3 text-sm text-destructive shadow-lg">
					{errorMessage}
				</div>
			) : null}
			{notice ? (
				<div role="status" aria-live="polite" className="fixed left-1/2 top-4 z-[90] w-[min(92vw,640px)] -translate-x-1/2 rounded-lg border border-emerald-200 bg-card px-4 py-3 text-sm text-emerald-700 shadow-lg dark:border-emerald-500/30 dark:text-emerald-300">
					{notice}
				</div>
			) : null}

			<div className="flex h-[58px] shrink-0 items-center border-b border-border bg-card">
				<div className="flex w-full items-center gap-3 px-4 sm:px-6">
					<label className="relative min-w-0 flex-1">
						<span className="sr-only">Search this destination</span>
						<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
						<input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search title, ID, source…"
							className="min-h-11 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none focus:ring-1 focus:ring-ring sm:min-h-9"
						/>
					</label>
					<div
						role="tablist"
						aria-label="Decision destinations"
						className="flex shrink-0 items-center gap-1 overflow-x-auto"
					>
						{destinations.map((destination) => {
							const Icon = destination.icon;
							const active = view === destination.id;
							return (
								<button
									key={destination.id}
									type="button"
									role="tab"
									aria-selected={active}
									onClick={() => handleNavigate(destination.id)}
									className={cn(
										"inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors sm:min-h-10",
										active
											? "border-primary text-primary"
											: "border-transparent text-muted-foreground hover:text-foreground",
									)}
								>
									<Icon className="h-4 w-4" />
									{destination.label}
									<span className="rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
										{destinationCounts[destination.id]}
									</span>
								</button>
							);
						})}
					</div>
				</div>
			</div>

			<PageContent size="full" className="flex min-h-0 flex-1 flex-col gap-4">
				<div data-testid={`decision-${view}-destination`}>
					<DecisionRegister
						view={view}
						decisions={visibleDecisions}
						onOpen={handleOpenDecision}
					/>
				</div>
			</PageContent>

			<Dialog open={selectedDecision !== null} onOpenChange={(open) => !open && handleCloseDecision()}>
				<DialogContent
					hideCloseButton
					overlayClassName="bg-black/45 backdrop-blur-[1.5px]"
					className="left-0 top-0 flex h-[100dvh] max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-card p-0 shadow-none sm:left-1/2 sm:top-1/2 sm:h-[min(860px,calc(100dvh-3rem))] sm:w-[min(1120px,calc(100vw-3rem))] sm:max-w-[1120px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:border-border sm:shadow-[0_12px_32px_rgba(0,0,0,0.16)]"
					onCloseAutoFocus={(event) => event.preventDefault()}
					data-testid="decision-focus-dialog"
				>
					<DialogTitle className="sr-only">{selectedDecision?.title || "Decision detail"}</DialogTitle>
					<DialogDescription className="sr-only">
						{view === "review" ? "Review a persisted Decision candidate." : "Read Decision details and provenance."}
					</DialogDescription>
					{selectedDecision ? (
						view === "review" ? (
							<CandidateReviewDetail
								candidate={selectedDecision}
								busy={actionBusy}
								onClose={handleCloseDecision}
								onLinkEvidence={handleLinkEvidence}
								onResolve={handleResolveCandidate}
							/>
						) : (
							<ReadOnlyDecisionDetail
								decision={selectedDecision}
								decisionByID={decisionByID}
								current={isCurrentDecision(selectedDecision)}
								onClose={handleCloseDecision}
								onOpenDecision={handleOpenDecision}
							/>
						)
					) : null}
				</DialogContent>
			</Dialog>

			<Dialog open={createOpen} onOpenChange={setCreateOpen}>
				<DialogContent
					hideCloseButton
					overlayClassName="bg-black/45 backdrop-blur-[1.5px]"
					className="left-0 top-0 flex h-[100dvh] max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-card p-0 shadow-none sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[calc(100dvh-3rem)] sm:w-[min(900px,calc(100vw-3rem))] sm:max-w-[900px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:border-border sm:shadow-[0_12px_32px_rgba(0,0,0,0.16)]"
					id="decision-create-workflow"
				>
					<DialogTitle className="sr-only">Create a System Decision candidate</DialogTitle>
					<DialogDescription className="sr-only">
						Create a persisted candidate that returns to the Decision Review Inbox.
					</DialogDescription>
					<div className="overflow-y-auto p-5 sm:p-7">
						<DecisionCandidateForm
							busy={actionBusy}
							onSubmit={handleCreateCandidate}
							onCancel={() => setCreateOpen(false)}
						/>
					</div>
				</DialogContent>
			</Dialog>
		</PageShell>
	);
}

function DecisionRegister({
	view,
	decisions,
	onOpen,
}: {
	view: DecisionView;
	decisions: DecisionEntry[];
	onOpen: (id: string) => void;
}) {
	if (decisions.length === 0) {
		return (
			<EmptyState
				title={view === "review" ? "Review Inbox is clear" : "No Decisions here"}
				description={
					view === "review"
						? "New workflow candidates will appear here before becoming current guidance."
						: "No records match this destination and search."
				}
			/>
		);
	}
	return (
		<div className="overflow-hidden rounded-lg border bg-card" data-testid="decision-list">
			<div className="hidden grid-cols-[minmax(0,1fr)_160px_150px_32px] gap-4 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
				<span>Decision</span>
				<span>{view === "review" ? "Review state" : "Lifecycle"}</span>
				<span>Updated</span>
				<span aria-hidden="true" />
			</div>
			<div className="divide-y divide-border">
				{decisions.map((decision) => (
					<button
						key={decision.id}
						type="button"
						onClick={() => onOpen(decision.id)}
						className="group grid min-h-[76px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:grid-cols-[minmax(0,1fr)_160px_150px_32px] md:gap-4"
						data-testid={`decision-row-${decision.id}`}
					>
						<span className="min-w-0">
							<span className="block truncate text-sm font-medium text-foreground">{decision.title}</span>
							<span className="mt-1 block truncate font-mono text-xs text-muted-foreground">@decision/{decision.id}</span>
						</span>
						<span className="hidden md:block">
							{view === "review" ? <ReviewStatePill state={decision.reviewState} /> : <StatusPill status={decision.status} current={view === "current"} />}
						</span>
						<span className="hidden text-sm tabular-nums text-muted-foreground md:block">{formatDate(decision.updatedAt)}</span>
						<span className="flex items-center gap-2 justify-self-end">
							<span className="md:hidden">{view === "review" ? <ReviewStatePill state={decision.reviewState} /> : <StatusPill status={decision.status} current={view === "current"} />}</span>
							<ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
						</span>
					</button>
				))}
			</div>
		</div>
	);
}

function CandidateReviewDetail({
	candidate,
	busy,
	onClose,
	onLinkEvidence,
	onResolve,
}: {
	candidate: DecisionEntry;
	busy: boolean;
	onClose: () => void;
	onLinkEvidence: (candidate: DecisionEntry, links: EvidenceLinks) => Promise<boolean>;
	onResolve: (candidate: DecisionEntry, resolution: DecisionReviewResolution, targetId?: string) => Promise<boolean>;
}) {
	const [sources, setSources] = useState("");
	const [relatedDocs, setRelatedDocs] = useState("");
	const [relatedTasks, setRelatedTasks] = useState("");
	const [action, setAction] = useState<ReviewAction | null>(null);
	const [copied, setCopied] = useState(false);
	const state = candidate.reviewState || "needs_evidence";
	const allowed = new Set(candidate.reviewAllowedResolutions || []);

	useEffect(() => {
		setSources("");
		setRelatedDocs("");
		setRelatedTasks("");
		setAction(null);
	}, [candidate.id]);

	const links: EvidenceLinks = {
		sources: parseListInput(sources),
		relatedDocs: parseListInput(relatedDocs),
		relatedTasks: parseListInput(relatedTasks),
	};
	const hasNewEvidence = links.sources.length + links.relatedDocs.length + links.relatedTasks.length > 0;
	const reference = `@decision/${candidate.id}`;

	const confirmAction = async () => {
		if (!action) return;
		const succeeded =
			action.kind === "link_evidence"
				? await onLinkEvidence(candidate, action.links)
				: await onResolve(
						candidate,
						action.kind,
						"targetID" in action ? action.targetID : undefined,
					);
		if (succeeded) setAction(null);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="decision-review-detail">
			<div className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-4 sm:px-6">
				<Button
					type="button"
					variant="ghost"
					size="icon"
					onClick={onClose}
					aria-label="Back to Review Inbox"
					className="h-11 w-11 shrink-0 sm:h-9 sm:w-9"
					data-testid="decision-mobile-back"
				>
					<ArrowLeft className="h-4 w-4" />
				</Button>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<ReviewStatePill state={candidate.reviewState} />
						<span className="text-xs text-muted-foreground">Persisted candidate</span>
					</div>
					<h2 className="mt-2 text-xl font-semibold tracking-[-0.02em] sm:text-2xl">{candidate.title}</h2>
					<button
						type="button"
						onClick={() => {
							void navigator.clipboard?.writeText(reference);
							setCopied(true);
							window.setTimeout(() => setCopied(false), 1500);
						}}
						className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						{reference}
						<Copy className="h-3 w-3" />
						<span className="sr-only">{copied ? "Copied" : "Copy reference"}</span>
					</button>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					onClick={onClose}
					aria-label="Close candidate review"
					className="h-11 w-11 shrink-0 sm:h-9 sm:w-9"
				>
					<X className="h-4 w-4" />
				</Button>
			</div>

			<div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_340px]">
				<article className="min-h-0 overflow-y-auto px-5 py-6 sm:px-8 sm:py-8">
					<section aria-labelledby="review-status-heading" className="border-y border-border py-5">
						<h3 id="review-status-heading" className="text-sm font-semibold">Review status</h3>
						<p className="mt-2 text-base leading-7 text-muted-foreground">{reviewStateDescription(state)}</p>
						{candidate.reviewBlockers?.length ? (
							<ul className="mt-4 space-y-2 text-sm text-amber-800 dark:text-amber-300">
								{candidate.reviewBlockers.map((blocker) => (
									<li key={blocker} className="flex gap-2">
										<CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
										<span>{blocker}</span>
									</li>
								))}
							</ul>
						) : (
							<p className="mt-3 flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
								<CheckCircle2 className="h-4 w-4" />
								No evidence blockers remain.
							</p>
						)}
					</section>

					<div className="divide-y divide-border">
						{bodySections.map((section) => (
							<BodySection key={section.key} title={section.label} markdown={String(candidate[section.key] || "")} />
						))}
					</div>

					{state === "needs_evidence" ? (
						<section className="border-t border-border pt-6" data-testid="decision-evidence-panel">
							<h3 className="text-sm font-semibold">Add verifiable evidence</h3>
							<p className="mt-1 text-sm leading-6 text-muted-foreground">
								Select a readable source and completed task. Saving re-evaluates this persisted candidate.
							</p>
							<div className="mt-5 space-y-4">
								<ReferencePicker
									label="Sources"
									value={sources}
									onChange={setSources}
									placeholder="@doc/specs/path, https://…"
									allowedKinds={["doc", "task", "decision", "memory"]}
									valueMode="source"
								/>
								<div className="grid gap-4 sm:grid-cols-2">
									<ReferencePicker
										label="Related docs"
										value={relatedDocs}
										onChange={setRelatedDocs}
										placeholder="specs/path"
										allowedKinds={["doc"]}
										valueMode="related-doc"
										browseLabel="Find doc"
									/>
									<ReferencePicker
										label="Completed tasks"
										value={relatedTasks}
										onChange={setRelatedTasks}
										placeholder="task-id"
										allowedKinds={["task"]}
										valueMode="related-task"
										browseLabel="Find task"
									/>
								</div>
								<div className="flex justify-end">
									<ActionButton
										label="Review evidence update"
										Icon={Link2}
										disabled={busy || !hasNewEvidence}
										onClick={() => setAction({ kind: "link_evidence", links })}
									/>
								</div>
							</div>
						</section>
					) : null}

					{state === "needs_resolution" ? (
						<section className="border-t border-border pt-6" data-testid="decision-resolution-panel">
							<h3 className="text-sm font-semibold">Resolve against current guidance</h3>
							<p className="mt-1 text-sm leading-6 text-muted-foreground">
								Only persisted review matches can be linked or replaced.
							</p>
							<div className="mt-4 divide-y divide-border border-y border-border">
								{(candidate.reviewMatches || []).map((match) => (
									<div key={match.id} className="py-4">
										<div className="flex flex-wrap items-start justify-between gap-3">
											<div className="min-w-0">
												<p className="truncate text-sm font-medium">{match.title}</p>
												<p className="mt-1 font-mono text-xs text-muted-foreground">
													@decision/{match.id} · {match.kind || "related"} · {Math.round(match.score * 100)}%
												</p>
											</div>
											<div className="flex flex-wrap gap-2">
												{allowed.has("link_as_related") ? (
													<ActionButton
														label="Link to current"
														Icon={Link2}
														disabled={busy}
														onClick={() => setAction({ kind: "link_as_related", targetID: match.id, targetTitle: match.title })}
													/>
												) : null}
												{allowed.has("supersede_existing") ? (
													<ActionButton
														label="Replace current"
														Icon={GitBranch}
														tone="primary"
														disabled={busy}
														onClick={() => setAction({ kind: "supersede_existing", targetID: match.id, targetTitle: match.title })}
													/>
												) : null}
											</div>
										</div>
										{match.snippet ? <p className="mt-3 text-sm leading-6 text-muted-foreground">{match.snippet}</p> : null}
									</div>
								))}
							</div>
						</section>
					) : null}

					{state === "ready_for_review" && allowed.has("accept_new") ? (
						<section className="border-t border-border pt-6" data-testid="decision-ready-panel">
							<h3 className="text-sm font-semibold">Ready for human acceptance</h3>
							<p className="mt-1 max-w-[68ch] text-sm leading-6 text-muted-foreground">
								Verified evidence is present and no current Decision requires resolution. Acceptance makes this candidate current guidance.
							</p>
							<div className="mt-4 flex justify-end">
								<ActionButton
									label="Review acceptance"
									Icon={ShieldCheck}
									tone="primary"
									disabled={busy}
									onClick={() => setAction({ kind: "accept_new" })}
								/>
							</div>
						</section>
					) : null}
				</article>

				<aside className="min-h-0 overflow-y-auto border-t border-border bg-muted/40 px-5 py-6 dark:bg-muted/10 md:border-l md:border-t-0">
					<DetailSection title="Lifecycle">
						<dl className="divide-y divide-border text-sm">
							<MetadataItem label="State" value={reviewStateLabel(candidate)} />
							<MetadataItem label="Evaluated" value={formatDate(candidate.reviewEvaluatedAt)} />
							<MetadataItem label="Created" value={formatDate(candidate.createdAt)} />
							<MetadataItem label="Matches" value={String(candidate.reviewMatches?.length || 0)} />
							<MetadataItem label="Blockers" value={String(candidate.reviewBlockers?.length || 0)} />
						</dl>
					</DetailSection>
					<div className="mt-7 space-y-5 border-t border-border pt-5">
						<TokenGroup label="Sources" values={candidate.sources || []} Icon={Link2} />
						<TokenGroup label="Docs" values={candidate.relatedDocs || []} Icon={FileText} />
						<TokenGroup label="Tasks" values={candidate.relatedTasks || []} Icon={CheckCircle2} />
						<TokenGroup label="Tags" values={candidate.tags || []} Icon={Tags} prefix="#" />
					</div>
					{allowed.has("reject_new") ? (
						<div className="mt-7 border-t border-border pt-5">
							<ActionButton
								label="Review rejection"
								Icon={CircleAlert}
								tone="danger"
								disabled={busy}
								onClick={() => setAction({ kind: "reject_new" })}
							/>
						</div>
					) : null}
				</aside>
			</div>

			<ReviewActionDialog
				action={action}
				candidate={candidate}
				busy={busy}
				onCancel={() => setAction(null)}
				onConfirm={confirmAction}
			/>
		</div>
	);
}

function ReviewActionDialog({
	action,
	candidate,
	busy,
	onCancel,
	onConfirm,
}: {
	action: ReviewAction | null;
	candidate: DecisionEntry;
	busy: boolean;
	onCancel: () => void;
	onConfirm: () => Promise<void>;
}) {
	if (!action) return null;
	const impact = reviewActionImpact(action, candidate);
	return (
		<Dialog open onOpenChange={(open) => !open && onCancel()}>
			<DialogContent
				hideCloseButton
				overlayClassName="z-[65] bg-black/55"
				className="z-[70] w-[calc(100vw-2rem)] max-w-lg gap-0 overflow-hidden rounded-xl border border-border bg-card p-0 shadow-[0_16px_48px_rgba(0,0,0,0.22)]"
				data-testid="decision-action-confirmation"
			>
				<div className="border-b border-border px-5 py-4">
					<DialogTitle className="text-base">{impact.title}</DialogTitle>
					<DialogDescription className="mt-1">Review the exact lifecycle effect before confirming.</DialogDescription>
				</div>
				<dl className="divide-y divide-border px-5 text-sm">
					<ImpactRow label="Candidate" value={`${candidate.title} (@decision/${candidate.id})`} />
					<ImpactRow label="Target" value={impact.target} />
					<ImpactRow label="Evidence outcome" value={impact.evidence} />
					<ImpactRow label="Resulting lifecycle" value={impact.lifecycle} />
				</dl>
				<div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end">
					<ActionButton label="Cancel" disabled={busy} onClick={onCancel} />
					<ActionButton label={busy ? "Applying…" : impact.confirmLabel} Icon={impact.icon} tone={impact.tone} disabled={busy} onClick={() => void onConfirm()} />
				</div>
			</DialogContent>
		</Dialog>
	);
}

function DecisionCandidateForm({
	busy,
	onSubmit,
	onCancel,
}: {
	busy: boolean;
	onSubmit: (draft: DecisionDraft) => Promise<void>;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState<DecisionDraft>(() => emptyDraft());
	const canSubmit = draft.title.trim() !== "" && draft.decision.trim() !== "";
	return (
		<form
			className="space-y-6"
			onSubmit={(event) => {
				event.preventDefault();
				if (canSubmit && !busy) void onSubmit(draft);
			}}
			data-testid="decision-create-panel"
		>
			<div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
				<div>
					<p className="text-xs font-medium text-muted-foreground">Secondary workflow</p>
					<h2 className="mt-1 text-xl font-semibold tracking-[-0.02em]">New System Decision candidate</h2>
					<p className="mt-1 max-w-[70ch] text-sm leading-6 text-muted-foreground">
						Creation never changes current guidance. The candidate returns to Review Inbox with a persisted review state.
					</p>
				</div>
				<Button type="button" variant="ghost" size="sm" onClick={onCancel} className="h-11 sm:h-9">
					Cancel
				</Button>
			</div>
			<div className="grid gap-5 sm:grid-cols-2">
				<FormField label="Title">
					<input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} className="min-h-11 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring sm:min-h-10" placeholder="Require reviewed workflow checkpoints" />
				</FormField>
				<FormField label="Tags">
					<input value={draft.tagsText} onChange={(event) => setDraft((current) => ({ ...current, tagsText: event.target.value }))} className="min-h-11 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring sm:min-h-10" placeholder="workflow, decision" />
				</FormField>
			</div>
			<ReferencePicker
				label="Sources"
				value={draft.sourcesText}
				onChange={(sourcesText) => setDraft((current) => ({ ...current, sourcesText }))}
				placeholder="@doc/specs/path, https://…"
				allowedKinds={["doc", "task", "decision", "memory"]}
				valueMode="source"
			/>
			<div className="grid gap-5 sm:grid-cols-2">
				<ReferencePicker
					label="Related docs"
					value={draft.relatedDocsText}
					onChange={(relatedDocsText) => setDraft((current) => ({ ...current, relatedDocsText }))}
					placeholder="specs/path"
					allowedKinds={["doc"]}
					valueMode="related-doc"
					browseLabel="Find doc"
				/>
				<ReferencePicker
					label="Completed tasks"
					value={draft.relatedTasksText}
					onChange={(relatedTasksText) => setDraft((current) => ({ ...current, relatedTasksText }))}
					placeholder="task-id"
					allowedKinds={["task"]}
					valueMode="related-task"
					browseLabel="Find task"
				/>
			</div>
			<div className="grid gap-5">
				<FormField label="Context">
					<textarea value={draft.context} onChange={(event) => setDraft((current) => ({ ...current, context: event.target.value }))} rows={3} className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring" />
				</FormField>
				<FormField label="Decision">
					<textarea value={draft.decision} onChange={(event) => setDraft((current) => ({ ...current, decision: event.target.value }))} rows={4} className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring" />
				</FormField>
				<div className="grid gap-5 sm:grid-cols-2">
					<FormField label="Alternatives considered">
						<textarea value={draft.alternativesConsidered} onChange={(event) => setDraft((current) => ({ ...current, alternativesConsidered: event.target.value }))} rows={3} className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring" />
					</FormField>
					<FormField label="Consequences">
						<textarea value={draft.consequences} onChange={(event) => setDraft((current) => ({ ...current, consequences: event.target.value }))} rows={3} className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring" />
					</FormField>
				</div>
			</div>
			<div className="flex justify-end border-t border-border pt-5">
				<ActionButton label={busy ? "Saving…" : "Save to Review Inbox"} Icon={Inbox} tone="primary" disabled={!canSubmit || busy} />
			</div>
		</form>
	);
}

function ReadOnlyDecisionDetail({
	decision,
	decisionByID,
	current,
	onClose,
	onOpenDecision,
}: {
	decision: DecisionEntry;
	decisionByID: Map<string, DecisionEntry>;
	current: boolean;
	onClose: () => void;
	onOpenDecision: (id: string) => void;
}) {
	const [copied, setCopied] = useState(false);
	const reference = `@decision/${decision.id}`;
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="decision-detail-panel">
			<div className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-4 sm:px-6">
				<Button
					type="button"
					variant="ghost"
					size="icon"
					onClick={onClose}
					aria-label="Back to Decisions"
					className="h-11 w-11 shrink-0 sm:h-9 sm:w-9"
					data-testid="decision-mobile-back"
				>
					<ArrowLeft className="h-4 w-4" />
				</Button>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<StatusPill status={decision.status} current={current} />
						<span className="text-xs text-muted-foreground">{current ? "Read-only current guidance" : "Read-only history"}</span>
					</div>
					<h2 className="mt-2 text-xl font-semibold tracking-[-0.02em] sm:text-2xl">{decision.title}</h2>
					<button
						type="button"
						onClick={() => {
							void navigator.clipboard?.writeText(reference);
							setCopied(true);
							window.setTimeout(() => setCopied(false), 1500);
						}}
						className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						{reference}
						<Copy className="h-3 w-3" />
						<span className="sr-only">{copied ? "Copied" : "Copy reference"}</span>
					</button>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					onClick={onClose}
					aria-label="Close Decision detail"
					className="h-11 w-11 shrink-0 sm:h-9 sm:w-9"
				>
					<X className="h-4 w-4" />
				</Button>
			</div>
			<div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_340px]">
				<article className="min-h-0 overflow-y-auto px-5 py-6 sm:px-8 sm:py-8">
					<div className="divide-y divide-border">
						{bodySections.map((section) => (
							<BodySection key={section.key} title={section.label} markdown={String(decision[section.key] || "")} />
						))}
					</div>
				</article>
				<aside className="min-h-0 overflow-y-auto border-t border-border bg-muted/40 px-5 py-6 dark:bg-muted/10 md:border-l md:border-t-0">
					<DecisionLineage decision={decision} decisionByID={decisionByID} onOpenDecision={onOpenDecision} />
					<div className="mt-7 border-t border-border pt-5">
						<DetailSection title="Lifecycle">
							<dl className="divide-y divide-border text-sm">
								<MetadataItem label="Status" value={current ? "Current" : statusLabels[decision.status]} />
								<MetadataItem label="Created" value={formatDate(decision.createdAt)} />
								<MetadataItem label="Updated" value={formatDate(decision.updatedAt)} />
								<MetadataItem label="Verified" value={formatDate(decision.verifiedAt)} />
								<MetadataItem label="Evidence" value={String(decision.verification?.length || 0)} />
							</dl>
						</DetailSection>
					</div>
					<div className="mt-7 space-y-5 border-t border-border pt-5">
						<TokenGroup label="Sources" values={decision.sources || []} Icon={Link2} />
						<TokenGroup label="Docs" values={decision.relatedDocs || []} Icon={FileText} />
						<TokenGroup label="Tasks" values={decision.relatedTasks || []} Icon={CheckCircle2} />
						<TokenGroup label="Tags" values={decision.tags || []} Icon={Tags} prefix="#" />
					</div>
				</aside>
			</div>
		</div>
	);
}

function DecisionLineage({
	decision,
	decisionByID,
	onOpenDecision,
}: {
	decision: DecisionEntry;
	decisionByID: Map<string, DecisionEntry>;
	onOpenDecision: (id: string) => void;
}) {
	const nodes = [
		...(decision.supersedes || []).map((id) => ({ id, relation: "Supersedes" })),
		{ id: decision.id, relation: "This Decision" },
		...(decision.supersededBy || []).map((id) => ({ id, relation: "Superseded by" })),
	];
	return (
		<DetailSection title="Decision lineage">
			<div className="divide-y divide-border">
				{nodes.map((node) => {
					const linked = decisionByID.get(node.id);
					const selected = node.id === decision.id;
					return (
						<button
							key={`${node.relation}-${node.id}`}
							type="button"
							onClick={() => !selected && linked && onOpenDecision(node.id)}
							disabled={selected || !linked}
							aria-label={`${node.relation}: ${linked?.title || node.id}`}
							className="group flex min-h-12 w-full items-center justify-between gap-3 py-2 text-left disabled:cursor-default"
						>
							<span className="min-w-0">
								<span className="block text-xs text-muted-foreground">{node.relation}</span>
								<span className="block truncate text-sm font-medium group-enabled:group-hover:text-primary">{linked?.title || node.id}</span>
							</span>
							{!selected && linked ? <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
						</button>
					);
				})}
			</div>
		</DetailSection>
	);
}

function BodySection({ title, markdown }: { title: string; markdown: string }) {
	return (
		<section className="py-7 first:pt-0 last:pb-0">
			<h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
				<ScrollText className="h-4 w-4 text-muted-foreground" />
				{title}
			</h3>
			{markdown.trim() ? (
				<MDRender markdown={markdown} className="prose max-w-none text-base leading-7 prose-p:my-3 prose-li:my-1 dark:prose-invert" />
			) : (
				<p className="text-base leading-7 text-muted-foreground">Not documented.</p>
			)}
		</section>
	);
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="space-y-2.5">
			<h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
			{children}
		</section>
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
			<div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
				<Icon className="h-3.5 w-3.5" />
				<span>{label}</span>
			</div>
			{values.length ? (
				<div className="flex flex-wrap gap-1.5">
					{values.map((value) => (
						<span key={`${label}-${value}`} className="max-w-full truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground dark:bg-muted">{prefix}{value}</span>
					))}
				</div>
			) : (
				<p className="text-sm text-muted-foreground">None linked.</p>
			)}
		</div>
	);
}

function ReviewStatePill({ state }: { state?: DecisionReviewState }) {
	const normalized = state || "needs_evidence";
	const classes: Record<DecisionReviewState, string> = {
		needs_evidence: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
		needs_resolution: "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300",
		ready_for_review: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
	};
	return (
		<span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium", classes[normalized])}>
			{reviewStateLabels[normalized]}
		</span>
	);
}

function StatusPill({ status, current }: { status: DecisionStatus; current?: boolean }) {
	const classes: Record<DecisionStatus, string> = {
		accepted: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
		draft: "border-border bg-muted text-foreground",
		superseded: "border-border bg-muted text-foreground",
		rejected: "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300",
		archived: "border-border bg-muted text-muted-foreground",
	};
	return (
		<span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium", classes[status])}>
			{current ? <ShieldCheck className="h-3 w-3" /> : <Clock3 className="h-3 w-3" />}
			{current ? "Current" : statusLabels[status]}
		</span>
	);
}

function MetadataItem({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between gap-3 py-2">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="truncate text-right font-medium tabular-nums">{value}</dd>
		</div>
	);
}

function ImpactRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="grid gap-1 py-3 sm:grid-cols-[132px_minmax(0,1fr)] sm:gap-3">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="break-words leading-6">{value}</dd>
		</div>
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
	onClick?: () => void;
	tone?: "neutral" | "primary" | "danger";
}) {
	return (
		<button
			type={onClick ? "button" : "submit"}
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9",
				tone === "neutral" && "border-border bg-card hover:bg-accent",
				tone === "primary" && "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
				tone === "danger" && "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15",
			)}
		>
			{Icon ? <Icon className="h-4 w-4" /> : null}
			<span>{label}</span>
		</button>
	);
}

function EmptyState({ title, description }: { title: string; description: string }) {
	return (
		<div className="flex min-h-56 flex-col items-center justify-center border-y border-border bg-card px-4 py-10 text-center">
			<Inbox className="h-5 w-5 text-muted-foreground" />
			<p className="mt-3 text-sm font-medium">{title}</p>
			<p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
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

function reviewActionImpact(action: ReviewAction, candidate: DecisionEntry) {
	switch (action.kind) {
		case "link_evidence":
			return {
				title: "Confirm evidence update",
				target: "This persisted candidate",
				evidence: `${action.links.sources.length} source(s), ${action.links.relatedDocs.length} doc(s), and ${action.links.relatedTasks.length} completed task(s) will be added and verified.`,
				lifecycle: "The candidate is re-evaluated as Needs evidence, Needs resolution, or Ready for review. It does not become current.",
				confirmLabel: "Confirm evidence",
				icon: Link2,
				tone: "primary" as const,
			};
		case "accept_new":
			return {
				title: "Confirm acceptance",
				target: "No current Decision is replaced",
				evidence: `${candidate.verification?.length || 0} verified evidence record(s); no review blockers or unresolved matches.`,
				lifecycle: "Candidate becomes accepted and enters Current guidance.",
				confirmLabel: "Accept as current",
				icon: ShieldCheck,
				tone: "primary" as const,
			};
		case "link_as_related":
			return {
				title: "Confirm link to current",
				target: `${action.targetTitle} (@decision/${action.targetID})`,
				evidence: "Candidate provenance is transferred to the selected current Decision.",
				lifecycle: "Candidate becomes rejected history; the selected Decision remains current.",
				confirmLabel: "Link and close candidate",
				icon: Link2,
				tone: "primary" as const,
			};
		case "supersede_existing":
			return {
				title: "Confirm replacement",
				target: `${action.targetTitle} (@decision/${action.targetID})`,
				evidence: "Candidate evidence is re-checked immediately before the atomic replacement.",
				lifecycle: "Candidate becomes current; the selected target becomes superseded history.",
				confirmLabel: "Replace current",
				icon: GitBranch,
				tone: "primary" as const,
			};
		case "reject_new":
			return {
				title: "Confirm rejection",
				target: "This persisted candidate",
				evidence: "Existing evidence and review metadata remain readable in History.",
				lifecycle: "Candidate becomes rejected history and never enters Current guidance.",
				confirmLabel: "Reject candidate",
				icon: CircleAlert,
				tone: "danger" as const,
			};
	}
}

function mergeDecisionSets(...sets: DecisionEntry[][]) {
	const byID = new Map<string, DecisionEntry>();
	for (const decisions of sets) {
		for (const decision of decisions) byID.set(decision.id, decision);
	}
	return Array.from(byID.values());
}

function isCurrentDecision(decision: DecisionEntry) {
	return decision.status === "accepted" && Boolean(decision.verifiedAt) && (decision.supersededBy?.length || 0) === 0;
}

function viewFromPath(pathname: string): DecisionView {
	if (pathname.startsWith("/decisions/review")) return "review";
	if (pathname.startsWith("/decisions/history")) return "history";
	return "current";
}


function reviewStateDescription(state: DecisionReviewState) {
	switch (state) {
		case "needs_resolution":
			return "Evidence is verified, but this candidate overlaps current guidance and needs an explicit relationship.";
		case "ready_for_review":
			return "Evidence is verified and no current Decision conflict remains. A human can accept or reject it.";
		default:
			return "This candidate cannot progress until its readable source and completed task evidence verify.";
	}
}

function reviewStateLabel(candidate: DecisionEntry) {
	const state = candidate.reviewState || "needs_evidence";
	return reviewStateLabels[state];
}

function resolutionNotice(resolution: DecisionReviewResolution, title: string) {
	switch (resolution) {
		case "accept_new":
			return `${title} is now current guidance.`;
		case "supersede_existing":
			return `${title} is current and the selected target moved to History.`;
		case "link_as_related":
			return `${title} was linked to current guidance and moved to rejected History.`;
		case "reject_new":
			return `${title} was rejected and moved to History.`;
		default:
			return `${title} review was resolved.`;
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
