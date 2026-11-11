import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
	AtSign,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	CircleAlert,
	ExternalLink,
	FileText,
	GitBranch,
	History,
	Inbox,
	Link2,
	ListTodo,
	Loader2,
	Plus,
	Quote,
	RefreshCw,
	ScrollText,
	Search,
	ShieldCheck,
	X,
	XCircle,
	type LucideIcon,
} from "lucide-react";
import ReferencePicker from "@/ui/components/organisms/ReferencePicker";
import { MDRenderWithHighlight } from "@/ui/components/editor/MDRenderWithHighlight";
import { parseSource } from "@/ui/components/molecules/SourceLinkList";
import { DetailSection } from "@/ui/components/organisms/TaskDetail/DetailSection";
import { Button } from "@/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/ui/components/ui/sheet";
import { toast } from "@/ui/components/ui/sonner";
import { Badge, type BadgeTone } from "@/ui/components/ui/knowns/badge";
import { Breadcrumb } from "@/ui/components/ui/knowns/breadcrumb";
import { Button as KnButton } from "@/ui/components/ui/knowns/button";
import { Field, Input, Textarea } from "@/ui/components/ui/knowns/input";
import { SegmentedControl } from "@/ui/components/ui/knowns/segmented-control";
import { Select } from "@/ui/components/ui/knowns/select";
import { Tabs, TabsList, TabsTrigger } from "@/ui/components/ui/knowns/tabs";
import { Tag } from "@/ui/components/ui/knowns/tag";
import { PageHeader, type PageHeaderAction } from "@/ui/components/ui/knowns/blocks/page-header";
import { ago } from "@/ui/components/ui/knowns/agent-memory/memory-utils";
import { FeatureHeader } from "@/ui/components/templates";
import { PageContent, PageError, PageLoading, PageShell } from "@/ui/components/templates/PageShell";
import { useIsMobile } from "@/ui/hooks/useMobile";
import { Fold } from "@/ui/lib/knowns/motion";
import { focusRing, writeClipboard } from "@/ui/lib/knowns/utils";
import { navigateTo } from "@/ui/lib/navigation";
import { cn } from "@/ui/lib/utils";

type DecisionView = "current" | "review" | "history";
type DetailMode = DecisionView;

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
	icon: LucideIcon;
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

const statusTone: Record<DecisionStatus, BadgeTone> = {
	draft: "neutral",
	accepted: "info",
	superseded: "neutral",
	rejected: "danger",
	archived: "neutral",
};

const reviewStateLabels: Record<DecisionReviewState, string> = {
	needs_evidence: "Needs evidence",
	needs_resolution: "Needs resolution",
	ready_for_review: "Ready for review",
};

const reviewStateTone: Record<DecisionReviewState, BadgeTone> = {
	needs_evidence: "warning",
	needs_resolution: "accent",
	ready_for_review: "success",
};

const historyStatuses: DecisionStatus[] = ["superseded", "rejected", "archived"];

/** The record's four parts, in ADR order. Empty optional parts are left out of the reader. */
const bodySections: Array<{ key: "context" | "decision" | "alternativesConsidered" | "consequences"; label: string }> = [
	{ key: "context", label: "Context" },
	{ key: "decision", label: "Decision" },
	{ key: "alternativesConsidered", label: "Alternatives considered" },
	{ key: "consequences", label: "Consequences" },
];

const ALL = "all";

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
	const isMobile = useIsMobile();
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const view = viewFromPath(pathname);
	// The graph links straight to one entry, e.g. /decisions/<id>, so a node there
	// opens the same detail the list uses.
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
	const [filter, setFilter] = useState<string>(ALL);
	const [loading, setLoading] = useState(true);
	const [loaded, setLoaded] = useState(false);
	const [actionBusy, setActionBusy] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [loadError, setLoadError] = useState("");
	const lastOpenedDecisionID = useRef<string | null>(null);

	const loadDecisions = useCallback(async () => {
		const [current, all, inbox] = await Promise.all([
			decisionApi.list(),
			decisionApi.list({ includeAll: true }),
			decisionApi.reviewInbox(),
		]);
		setCurrentDecisions(current);
		setAllDecisions(mergeDecisionSets(current, all, inbox));
		setReviewCandidates(inbox);
		setLoadError("");
		setLoaded(true);
		return { current, all, inbox };
	}, []);

	const handleRefresh = useCallback(async () => {
		setLoading(true);
		try {
			await loadDecisions();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to load Decisions";
			setLoadError(message);
			if (loaded) toast.error(message);
		} finally {
			setLoading(false);
		}
	}, [loadDecisions, loaded]);

	useEffect(() => {
		void handleRefresh();
		// Load once on mount; Refresh reloads on demand.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		setSelectedID(null);
		setQuery("");
		setFilter(ALL);
	}, [view]);

	const historyDecisions = useMemo(
		() => allDecisions.filter((decision) => historyStatuses.includes(decision.status)),
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

	const filterOptions = useMemo(() => filterOptionsFor(view, destinationDecisions), [destinationDecisions, view]);

	const visibleDecisions = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return destinationDecisions
			.filter((entry) => matchesFilter(view, entry, filter))
			.filter(
				(entry) =>
					!normalized ||
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
			)
			.sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt));
	}, [destinationDecisions, filter, query, view]);

	const decisionByID = useMemo(() => {
		const byID = new Map<string, DecisionEntry>();
		for (const decision of allDecisions) byID.set(decision.id, decision);
		for (const decision of reviewCandidates) byID.set(decision.id, decision);
		return byID;
	}, [allDecisions, reviewCandidates]);

	// A linked entry may sit in a tab that has not been fetched yet (a proposal while the
	// trusted list is showing, say), so fall back to loading it alone.
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
		if (!loaded) return "Loading";
		const count = destinationCounts[view];
		const word = destinationStatusWords[view];
		if (count === 0) return `No ${word} Decisions`;
		return `${count} ${word} ${count === 1 ? "Decision" : "Decisions"}`;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [loaded, currentDecisions, reviewCandidates, historyDecisions, view]);

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

	const handleCreateCandidate = useCallback(
		async (draft: DecisionDraft) => {
			setActionBusy(true);
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
					toast.error(error instanceof Error ? error.message : "Failed to create Decision candidate");
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
				toast.success(
					candidate
						? `Candidate saved to Review Inbox as ${reviewStateLabel(candidate)}.`
						: "Candidate saved to Review Inbox.",
				);
			} catch (error) {
				toast.error(
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
			try {
				const updated = await decisionApi.link(candidate.id, links);
				await loadDecisions();
				setSelectedID(updated.id);
				toast.success(`Evidence reviewed. Candidate is now ${reviewStateLabel(updated)}.`);
				return true;
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Failed to link candidate evidence");
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
			try {
				await decisionApi.resolveReview({ candidateId: candidate.id, resolution, targetId });
				await loadDecisions();
				setSelectedID(null);
				toast.success(resolutionNotice(resolution, candidate.title));
				return true;
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Failed to resolve Decision candidate");
				return false;
			} finally {
				setActionBusy(false);
			}
		},
		[loadDecisions],
	);

	const detailMode: DetailMode =
		view === "review"
			? "review"
			: selectedDecision && isCurrentDecision(selectedDecision)
				? "current"
				: "history";

	return (
		<PageShell>
			<FeatureHeader
				icon={ScrollText}
				className="border-b-0"
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

			<div className="shrink-0 px-4 sm:px-6">
				<Tabs value={view} onValueChange={(value) => handleNavigate(value as DecisionView)}>
					<TabsList aria-label="Decision destinations">
						{destinations.map((destination) => {
							const Icon = destination.icon;
							return (
								<TabsTrigger
									key={destination.id}
									value={destination.id}
									icon={<Icon />}
									badge={<span className="tabular-nums">{destinationCounts[destination.id]}</span>}
								>
									{destination.label}
								</TabsTrigger>
							);
						})}
					</TabsList>
				</Tabs>
			</div>

			<PageContent className="flex min-h-0 flex-1 flex-col pt-1">
				{loadError && !loaded ? (
					<PageError
						title="Decisions could not load"
						description={loadError}
						onRetry={() => void handleRefresh()}
						className="flex-1"
					/>
				) : loading && !loaded ? (
					<PageLoading label="Loading Decisions" className="flex-1" />
				) : (
					<div data-testid={`decision-${view}-destination`}>
						<DecisionList
							view={view}
							total={destinationDecisions.length}
							decisions={visibleDecisions}
							query={query}
							onQueryChange={setQuery}
							filter={filter}
							filterOptions={filterOptions}
							onFilterChange={setFilter}
							compactFilter={isMobile}
							onOpen={handleOpenDecision}
							onCreate={() => setCreateOpen(true)}
						/>
					</div>
				)}
			</PageContent>

			<Sheet open={selectedDecision !== null} onOpenChange={(open) => !open && handleCloseDecision()}>
				<SheetContent
					side="right"
					hideCloseButton
					className="flex h-dvh w-full flex-col gap-0 p-0 max-sm:border-l-0 sm:max-w-3xl xl:max-w-[60rem]"
					onCloseAutoFocus={(event) => event.preventDefault()}
					data-testid="decision-focus-dialog"
				>
					<SheetTitle className="sr-only">{selectedDecision?.title || "Decision detail"}</SheetTitle>
					<SheetDescription className="sr-only">
						{view === "review" ? "Review a persisted Decision candidate." : "Read Decision details and provenance."}
					</SheetDescription>
					{selectedDecision ? (
						<DecisionDetail
							decision={selectedDecision}
							mode={detailMode}
							decisionByID={decisionByID}
							busy={actionBusy}
							onClose={handleCloseDecision}
							onOpenDecision={handleOpenDecision}
							onLinkEvidence={handleLinkEvidence}
							onResolve={handleResolveCandidate}
						/>
					) : null}
				</SheetContent>
			</Sheet>

			<CreateCandidateDialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				busy={actionBusy}
				onSubmit={handleCreateCandidate}
			/>
		</PageShell>
	);
}

/* ── List ── */

type FilterOption = { value: string; label: string; count: number };

/**
 * One destination as a flush list, like Tasks and Memories: a toolbar (search, one filter,
 * count) over divided rows. Each row reads title, then the decision in one line, then quiet
 * metadata, so the list scans by what was decided rather than by IDs.
 */
function DecisionList({
	view,
	total,
	decisions,
	query,
	onQueryChange,
	filter,
	filterOptions,
	onFilterChange,
	compactFilter,
	onOpen,
	onCreate,
}: {
	view: DecisionView;
	total: number;
	decisions: DecisionEntry[];
	query: string;
	onQueryChange: (query: string) => void;
	filter: string;
	filterOptions: FilterOption[];
	onFilterChange: (value: string) => void;
	compactFilter: boolean;
	onOpen: (id: string) => void;
	onCreate: () => void;
}) {
	const noun = view === "review" ? "candidate" : "Decision";
	const filterLabel = view === "current" ? "Tag" : view === "review" ? "Review state" : "Lifecycle";
	// The tag list can be long, so Current always uses the select; the others fit a segmented control on wide screens.
	const useSelect = compactFilter || view === "current";
	const showFilter = filterOptions.length > 2 || (view === "current" && filterOptions.length > 1);
	return (
		<section aria-label={destinations.find((item) => item.id === view)?.label} className="-mx-4 flex flex-col sm:-mx-5">
			<header className="flex flex-wrap items-center gap-2 border-b px-4 py-3.5 sm:px-5">
				<Input
					type="search"
					size="sm"
					value={query}
					onChange={(event) => onQueryChange(event.target.value)}
					placeholder="Search title, ID, source…"
					aria-label="Search this destination"
					icon={<Search className="h-4 w-4" />}
					className="min-w-[180px] flex-1 sm:max-w-[280px]"
				/>
				{showFilter ? (
					useSelect ? (
						<Select
							size="sm"
							aria-label={filterLabel}
							value={filter}
							onChange={(event) => onFilterChange(event.target.value)}
							options={filterOptions.map((option) => ({
								value: option.value,
								label: `${option.label} (${option.count})`,
							}))}
							className="w-auto max-w-[220px]"
						/>
					) : (
						<SegmentedControl
							aria-label={filterLabel}
							size="sm"
							value={filter}
							onValueChange={onFilterChange}
							options={filterOptions.map((option) => ({
								value: option.value,
								label: (
									<span className="flex items-center gap-1.5">
										{option.label}
										<span className="tabular-nums text-muted-foreground">{option.count}</span>
									</span>
								),
							}))}
						/>
					)
				) : null}
				<span className="ml-auto hidden text-[12.5px] tabular-nums text-muted-foreground sm:inline">
					{decisions.length === total
						? `${total} ${total === 1 ? noun : `${noun}s`}`
						: `${decisions.length} of ${total}`}
				</span>
			</header>

			{decisions.length === 0 ? (
				<EmptyState
					view={view}
					filtered={total > 0}
					query={query}
					onCreate={onCreate}
				/>
			) : (
				<ul className="divide-y" aria-label={`${noun}s`} data-testid="decision-list">
					{decisions.map((decision) => (
						<li key={decision.id}>
							<DecisionRow decision={decision} view={view} onOpen={onOpen} />
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function DecisionRow({
	decision,
	view,
	onOpen,
}: {
	decision: DecisionEntry;
	view: DecisionView;
	onOpen: (id: string) => void;
}) {
	const summary = plainSummary(decision.decision || decision.context || "");
	const tags = decision.tags || [];
	return (
		<button
			type="button"
			onClick={() => onOpen(decision.id)}
			className="group flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5"
			data-testid={`decision-row-${decision.id}`}
		>
			<span className="min-w-0 flex-1">
				<span className="block text-[14px] font-medium leading-snug text-foreground">{decision.title}</span>
				{summary ? (
					<span className="mt-1 line-clamp-2 max-w-[72ch] text-[13px] leading-5 text-muted-foreground sm:line-clamp-1">
						{summary}
					</span>
				) : null}
				<span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
					<DecisionBadge decision={decision} view={view} />
					{tags.slice(0, 3).map((tag) => (
						<span key={tag}>#{tag}</span>
					))}
					{tags.length > 3 ? <span>+{tags.length - 3}</span> : null}
					<span title={formatDate(decision.updatedAt)}>{`Updated ${ago(decision.updatedAt)}`}</span>
				</span>
			</span>
			<ChevronRight aria-hidden className="mt-0.5 hidden h-4 w-4 flex-none text-muted-foreground sm:block" />
		</button>
	);
}

function EmptyState({
	view,
	filtered,
	query,
	onCreate,
}: {
	view: DecisionView;
	filtered: boolean;
	query: string;
	onCreate: () => void;
}) {
	if (filtered) {
		return (
			<p className="px-5 py-12 text-center text-[13px] text-muted-foreground">
				{query ? `No Decisions match "${query}".` : "No Decisions match this filter."}
			</p>
		);
	}
	const copy: Record<DecisionView, { title: string; body: string }> = {
		current: {
			title: "No current guidance yet",
			body: "Accepted Decisions appear here once a candidate is reviewed in Review Inbox.",
		},
		review: {
			title: "Review Inbox is clear",
			body: "New candidates wait here for evidence and a human review before they become current guidance.",
		},
		history: {
			title: "Nothing in History yet",
			body: "Superseded, rejected and archived Decisions stay readable here.",
		},
	};
	return (
		<div className="flex min-h-52 flex-col items-center justify-center px-4 py-10 text-center">
			<ScrollText className="h-6 w-6 text-muted-foreground" />
			<p className="mt-3 text-sm font-medium">{copy[view].title}</p>
			<p className="mt-1 max-w-[52ch] text-sm leading-6 text-muted-foreground">{copy[view].body}</p>
			{view === "review" ? (
				<KnButton size="sm" variant="secondary" icon={<Plus />} onClick={onCreate} className="mt-4">
					Propose a Decision
				</KnButton>
			) : null}
		</div>
	);
}

function DecisionBadge({ decision, view }: { decision: DecisionEntry; view: DecisionView }) {
	if (view === "review") {
		const state = decision.reviewState || "needs_evidence";
		return (
			<Badge size="sm" tone={reviewStateTone[state]}>
				{reviewStateLabels[state]}
			</Badge>
		);
	}
	if (isCurrentDecision(decision)) {
		return (
			<Badge size="sm" tone="success">
				Current
			</Badge>
		);
	}
	return (
		<Badge size="sm" tone={statusTone[decision.status]} variant={decision.status === "archived" ? "outline" : "soft"}>
			{statusLabels[decision.status]}
		</Badge>
	);
}

/* ── Detail ── */

/**
 * One Decision in a side sheet, laid out like the task and Memory details: a fixed top bar
 * (breadcrumb, Close), then a stacked page header and the record in the Docs reader at about
 * 68 characters. Lifecycle, lineage and provenance sit in a properties column beside it on wide
 * sheets and under a Details fold on phones, so nothing but the record is in the reading path.
 */
function DecisionDetail({
	decision,
	mode,
	decisionByID,
	busy,
	onClose,
	onOpenDecision,
	onLinkEvidence,
	onResolve,
}: {
	decision: DecisionEntry;
	mode: DetailMode;
	decisionByID: Map<string, DecisionEntry>;
	busy: boolean;
	onClose: () => void;
	onOpenDecision: (id: string) => void;
	onLinkEvidence: (candidate: DecisionEntry, links: EvidenceLinks) => Promise<boolean>;
	onResolve: (candidate: DecisionEntry, resolution: DecisionReviewResolution, targetId?: string) => Promise<boolean>;
}) {
	const isMobile = useIsMobile();
	const scrollRef = useRef<HTMLDivElement>(null);
	const [action, setAction] = useState<ReviewAction | null>(null);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const reference = `@decision/${decision.id}`;
	const reviewState = decision.reviewState || "needs_evidence";
	const allowed = new Set(decision.reviewAllowedResolutions || []);
	const destination = destinations.find((item) => item.id === mode) ?? destinations[0]!;
	const replacedBy = (decision.supersededBy || []).map((id) => decisionByID.get(id)).find(Boolean);

	useEffect(() => {
		setAction(null);
		setDetailsOpen(false);
		scrollRef.current?.scrollTo({ top: 0 });
	}, [decision.id]);

	const confirmAction = async () => {
		if (!action) return;
		const succeeded =
			action.kind === "link_evidence"
				? await onLinkEvidence(decision, action.links)
				: await onResolve(decision, action.kind, "targetID" in action ? action.targetID : undefined);
		if (succeeded) setAction(null);
	};

	const copy = (text: string, done: string) => async () => {
		try {
			await writeClipboard(text);
			toast.success(done);
		} catch {
			toast.error("Could not copy to the clipboard");
		}
		return done;
	};

	const go = (path: string) => {
		onClose();
		navigateTo(path);
	};

	// In-app links (breadcrumbs, links in the body) navigate without a reload and close the sheet.
	const handleLinkClick = (event: React.MouseEvent) => {
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
		const href = (event.target as HTMLElement).closest("a")?.getAttribute("href");
		if (!href || !href.startsWith("/")) return;
		event.preventDefault();
		go(href);
	};

	const status =
		mode === "review"
			? { label: reviewStateLabels[reviewState], tone: reviewStateTone[reviewState] }
			: mode === "current"
				? { label: "Current", tone: "success" as BadgeTone }
				: { label: statusLabels[decision.status], tone: statusTone[decision.status] };

	const context =
		mode === "review"
			? "Persisted candidate. It does not guide agents until a person accepts it."
			: mode === "current"
				? "Read-only current guidance. Agents follow it by default."
				: "Read-only history. Kept for provenance; agents no longer follow it.";

	const moreActions: PageHeaderAction[] = [
		{ id: "copy-ref", label: "Copy reference", icon: <AtSign />, onSelect: copy(reference, "Reference copied") },
		{
			id: "copy-link",
			label: "Copy link",
			icon: <Link2 />,
			onSelect: copy(`${window.location.origin}/decisions/${encodeURIComponent(decision.id)}`, "Link copied"),
		},
	];

	const properties = (
		<DecisionProperties
			decision={decision}
			mode={mode}
			decisionByID={decisionByID}
			onOpenDecision={onOpenDecision}
			onOpenPath={go}
		/>
	);

	return (
		<div
			className="flex h-full min-h-0 flex-col"
			onClick={handleLinkClick}
			data-testid={mode === "review" ? "decision-review-detail" : "decision-detail-panel"}
		>
			{/* Stays put while the body scrolls, so Close is always one tap away (phones have no Escape). */}
			<div className="flex h-14 flex-none items-center gap-3 px-3 pt-[env(safe-area-inset-top)] sm:px-6">
				<Breadcrumb
					items={[
						...(isMobile ? [] : [{ label: "Decisions", href: "/decisions" }]),
						{ label: destination.label, href: destination.path },
						{ label: reference },
					]}
					size="sm"
					separator="slash"
					aria-label={`Breadcrumb: decision ${decision.id}`}
					// Decision IDs are long: keep one line and let the last crumb truncate instead of wrapping.
					className="min-w-0 flex-1 [&_ol]:flex-nowrap"
				/>
				<KnButton
					variant="ghost"
					icon={<X />}
					onClick={onClose}
					aria-label={mode === "review" ? "Close candidate review" : "Close Decision detail"}
					title="Close"
					className="h-11 w-11 text-muted-foreground sm:h-8 sm:w-8"
					data-testid="decision-mobile-back"
				/>
			</div>
			<div
				ref={scrollRef}
				data-autofocus
				tabIndex={-1}
				className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(3rem,env(safe-area-inset-bottom))] outline-none [scrollbar-gutter:stable] sm:px-8"
			>
				<PageHeader
					layout="stacked"
					size="lg"
					className="pt-1"
					title={decision.title}
					titleText={decision.title}
					status={status}
					description={context}
					moreActions={moreActions}
					scrollContainer={scrollRef}
				>
					<div className="@container/detail">
						<div className="grid grid-cols-1 gap-x-12 gap-y-8 pt-5 @[820px]/detail:grid-cols-[minmax(0,1fr)_15rem]">
							<div className="flex min-w-0 flex-col gap-10">
								{mode === "review" ? <ReviewStatus decision={decision} /> : null}

								{mode === "history" && decision.status === "superseded" && replacedBy ? (
									<p className="flex max-w-[68ch] flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] px-3.5 py-2.5 text-[13.5px] text-muted-foreground">
										<GitBranch aria-hidden className="h-4 w-4 flex-none" />
										<span>Replaced by</span>
										<button
											type="button"
											onClick={() => onOpenDecision(replacedBy.id)}
											className={cn("rounded font-medium text-foreground underline-offset-2 hover:underline", focusRing)}
										>
											{replacedBy.title}
										</button>
									</p>
								) : null}

								<DecisionReader
									decision={decision}
									onOpenDoc={(path) => go(`/docs/${path}`)}
									onOpenTask={(id) => go(`/tasks/${id}`)}
								/>

								{mode === "review" ? (
									<ReviewPanels decision={decision} busy={busy} onAction={setAction} />
								) : null}
							</div>

							<aside
								aria-label="Properties"
								className="flex min-w-0 flex-col gap-6 border-t border-[color-mix(in_srgb,var(--foreground)_9%,transparent)] pt-5 @[820px]/detail:self-start @[820px]/detail:border-t-0 @[820px]/detail:border-l @[820px]/detail:pt-1 @[820px]/detail:pl-6"
							>
								{isMobile ? (
									<div>
										<button
											type="button"
											aria-expanded={detailsOpen}
											onClick={() => setDetailsOpen((open) => !open)}
											className={cn(
												"-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-[13.5px] font-semibold transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]",
												focusRing,
											)}
										>
											<span>Details</span>
											<span className="flex items-center gap-2 text-[12.5px] font-normal text-muted-foreground">
												{`Updated ${ago(decision.updatedAt)}`}
												<ChevronDown
													aria-hidden
													className={cn(
														"h-4 w-4 transition-transform duration-(--kn-dur) ease-(--kn-ease-inout)",
														detailsOpen && "rotate-180",
													)}
												/>
											</span>
										</button>
										<Fold open={detailsOpen}>
											<div className="pt-3">{properties}</div>
										</Fold>
									</div>
								) : (
									properties
								)}
								{mode === "review" && allowed.has("reject_new") ? (
									<div className="flex flex-col gap-2">
										<span className="text-[12px] font-medium text-muted-foreground">Lifecycle</span>
										<p className="text-[12.5px] leading-5 text-muted-foreground">
											Close this candidate without making it current. It stays readable in History.
										</p>
										<ActionButton
											label="Review rejection"
											Icon={XCircle}
											danger
											fullWidth
											disabled={busy}
											onClick={() => setAction({ kind: "reject_new" })}
										/>
									</div>
								) : null}
							</aside>
						</div>
					</div>
				</PageHeader>
			</div>

			<ReviewActionDialog
				action={action}
				candidate={decision}
				busy={busy}
				onCancel={() => setAction(null)}
				onConfirm={() => void confirmAction()}
			/>
		</div>
	);
}

/**
 * The record as one markdown document in the Docs reader (same typography, code blocks and
 * @doc/@task chips), so the four ADR parts read as a single text at a comfortable measure.
 */
function DecisionReader({
	decision,
	onOpenDoc,
	onOpenTask,
}: {
	decision: DecisionEntry;
	onOpenDoc: (path: string) => void;
	onOpenTask: (id: string) => void;
}) {
	const markdown = useMemo(() => decisionMarkdown(decision), [decision]);
	return (
		<section aria-label="Decision record">
			<div className="prose-neutral max-w-[68ch] dark:prose-invert [&_.md-render-wrapper>:first-child]:mt-0! [&_.md-render-wrapper>:last-child]:mb-0!">
				<MDRenderWithHighlight
					content={markdown}
					lineHighlight={null}
					onDocLinkClick={onOpenDoc}
					onTaskLinkClick={onOpenTask}
				/>
			</div>
		</section>
	);
}

function ReviewStatus({ decision }: { decision: DecisionEntry }) {
	const state = decision.reviewState || "needs_evidence";
	const blockers = decision.reviewBlockers || [];
	return (
		<DetailSection title="Review status">
			<p className="max-w-[68ch] text-[14px] leading-6 text-muted-foreground">{reviewStateDescription(state)}</p>
			{blockers.length ? (
				<ul className="flex max-w-[68ch] flex-col gap-2 rounded-xl bg-[color-mix(in_srgb,var(--kn-warning,#d97706)_8%,transparent)] px-3 py-2.5 text-[13.5px] text-amber-800 dark:text-amber-300">
					{blockers.map((blocker) => (
						<li key={blocker} className="flex gap-2">
							<CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
							<span className="min-w-0 break-words">{blocker}</span>
						</li>
					))}
				</ul>
			) : (
				<p className="flex items-center gap-2 text-[13.5px] text-emerald-700 dark:text-emerald-300">
					<CheckCircle2 aria-hidden className="h-4 w-4" />
					No evidence blockers remain.
				</p>
			)}
		</DetailSection>
	);
}

/** The step the candidate's review state asks for: add evidence, resolve a match, or accept. */
function ReviewPanels({
	decision,
	busy,
	onAction,
}: {
	decision: DecisionEntry;
	busy: boolean;
	onAction: (action: ReviewAction) => void;
}) {
	const [sources, setSources] = useState("");
	const [relatedDocs, setRelatedDocs] = useState("");
	const [relatedTasks, setRelatedTasks] = useState("");
	const state = decision.reviewState || "needs_evidence";
	const allowed = new Set(decision.reviewAllowedResolutions || []);

	useEffect(() => {
		setSources("");
		setRelatedDocs("");
		setRelatedTasks("");
	}, [decision.id]);

	const links: EvidenceLinks = {
		sources: parseListInput(sources),
		relatedDocs: parseListInput(relatedDocs),
		relatedTasks: parseListInput(relatedTasks),
	};
	const hasNewEvidence = links.sources.length + links.relatedDocs.length + links.relatedTasks.length > 0;

	if (state === "needs_evidence") {
		return (
			<div data-testid="decision-evidence-panel">
				<DetailSection title="Add verifiable evidence">
					<p className="max-w-[68ch] text-[13.5px] leading-6 text-muted-foreground">
						Link a readable source and a completed task. Saving re-evaluates this persisted candidate.
					</p>
					<div className="mt-2 flex flex-col gap-4">
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
								primary
								disabled={busy || !hasNewEvidence}
								onClick={() => onAction({ kind: "link_evidence", links })}
							/>
						</div>
					</div>
				</DetailSection>
			</div>
		);
	}

	if (state === "needs_resolution") {
		const matches = decision.reviewMatches || [];
		return (
			<div data-testid="decision-resolution-panel">
				<DetailSection title="Resolve against current guidance" count={matches.length}>
					<p className="max-w-[68ch] text-[13.5px] leading-6 text-muted-foreground">
						This candidate overlaps current guidance. Link it to the current Decision, or replace that Decision with it.
					</p>
					<ul className="divide-y rounded-xl border">
						{matches.map((match) => (
							<li key={match.id} className="flex flex-col gap-3 px-3.5 py-3.5">
								<div className="min-w-0">
									<p className="text-[13.5px] font-medium">{match.title}</p>
									<p className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">
										@decision/{match.id} · {match.kind || "related"} · {Math.round(match.score * 100)}% similar
									</p>
									{match.snippet ? (
										<p className="mt-1.5 line-clamp-3 max-w-[68ch] text-[13px] leading-5 text-muted-foreground">
											{plainText(match.snippet)}
										</p>
									) : null}
								</div>
								<div className="flex flex-wrap gap-2">
									{allowed.has("link_as_related") ? (
										<ActionButton
											label="Link to current"
											Icon={Link2}
											disabled={busy}
											onClick={() =>
												onAction({ kind: "link_as_related", targetID: match.id, targetTitle: match.title })
											}
										/>
									) : null}
									{allowed.has("supersede_existing") ? (
										<ActionButton
											label="Replace current"
											Icon={GitBranch}
											primary
											disabled={busy}
											onClick={() =>
												onAction({ kind: "supersede_existing", targetID: match.id, targetTitle: match.title })
											}
										/>
									) : null}
								</div>
							</li>
						))}
					</ul>
				</DetailSection>
			</div>
		);
	}

	if (state === "ready_for_review" && allowed.has("accept_new")) {
		return (
			<div data-testid="decision-ready-panel">
				<DetailSection title="Ready for human acceptance">
					<div className="flex flex-col items-start gap-3 rounded-xl border px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
						<p className="max-w-[52ch] text-[13.5px] leading-6 text-muted-foreground">
							Evidence is verified and nothing current conflicts. Accepting makes this candidate current guidance.
						</p>
						<ActionButton
							label="Review acceptance"
							Icon={ShieldCheck}
							primary
							disabled={busy}
							onClick={() => onAction({ kind: "accept_new" })}
						/>
					</div>
				</DetailSection>
			</div>
		);
	}

	return null;
}

/** Lifecycle facts, lineage and provenance: compact rows, long values truncate with the full value on hover. */
function DecisionProperties({
	decision,
	mode,
	decisionByID,
	onOpenDecision,
	onOpenPath,
}: {
	decision: DecisionEntry;
	mode: DetailMode;
	decisionByID: Map<string, DecisionEntry>;
	onOpenDecision: (id: string) => void;
	onOpenPath: (path: string) => void;
}) {
	const tags = decision.tags || [];
	const sources = decision.sources || [];
	const docs = decision.relatedDocs || [];
	const tasks = decision.relatedTasks || [];
	const lineage = [
		...(decision.supersedes || []).map((id) => ({ id, relation: "Supersedes" })),
		...(decision.supersededBy || []).map((id) => ({ id, relation: "Superseded by" })),
	];
	return (
		<div className="flex flex-col gap-5 text-[13px]">
			<dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5">
				{mode === "review" ? (
					<>
						<Fact label="Evaluated" title={formatDate(decision.reviewEvaluatedAt)}>
							{decision.reviewEvaluatedAt ? ago(decision.reviewEvaluatedAt) : "Not yet"}
						</Fact>
						<Fact label="Matches">{String(decision.reviewMatches?.length || 0)}</Fact>
						<Fact label="Blockers">{String(decision.reviewBlockers?.length || 0)}</Fact>
					</>
				) : (
					<>
						<Fact label="Status">
							<DecisionBadge decision={decision} view={mode} />
						</Fact>
						<Fact label="Verified" title={formatDate(decision.verifiedAt)}>
							{decision.verifiedAt ? ago(decision.verifiedAt) : "Not verified"}
						</Fact>
						<Fact label="Evidence">{`${decision.verification?.length || 0} records`}</Fact>
					</>
				)}
				<Fact label="Updated" title={formatDate(decision.updatedAt)}>
					{ago(decision.updatedAt)}
				</Fact>
				<Fact label="Created" title={formatDate(decision.createdAt)}>
					{ago(decision.createdAt)}
				</Fact>
			</dl>

			{lineage.length > 0 ? (
				<FactGroup label="Lineage">
					<ol className="flex flex-col">
						{lineage.map((node) => {
							const linked = decisionByID.get(node.id);
							return (
								<li key={`${node.relation}-${node.id}`} className="min-w-0">
									<button
										type="button"
										onClick={() => linked && onOpenDecision(node.id)}
										disabled={!linked}
										aria-label={`${node.relation}: ${linked?.title || node.id}`}
										title={linked?.title || node.id}
										className={cn(
											"-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 flex-col rounded-md px-1.5 py-1.5 text-left transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) enabled:hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] disabled:cursor-default",
											focusRing,
										)}
									>
										<span className="text-[11.5px] text-muted-foreground">{node.relation}</span>
										<span className="min-w-0 truncate font-medium">{linked?.title || node.id}</span>
									</button>
								</li>
							);
						})}
					</ol>
				</FactGroup>
			) : null}

			{tags.length > 0 ? (
				<FactGroup label="Tags">
					<span className="flex flex-wrap gap-1.5">
						{tags.map((tag) => (
							<Tag key={tag} size="sm">
								{tag}
							</Tag>
						))}
					</span>
				</FactGroup>
			) : null}

			<FactGroup label={sources.length > 1 ? `Sources · ${sources.length}` : "Source"}>
				{sources.length === 0 ? (
					<span className="text-muted-foreground">No source linked.</span>
				) : (
					<ul className="flex flex-col">
						{sources.map((source) => (
							<li key={source} className="min-w-0">
								<SourceLink source={source} onOpenPath={onOpenPath} />
							</li>
						))}
					</ul>
				)}
			</FactGroup>

			<FactGroup label={docs.length > 1 ? `Docs · ${docs.length}` : "Doc"}>
				{docs.length === 0 ? (
					<span className="text-muted-foreground">No doc linked.</span>
				) : (
					<ul className="flex flex-col">
						{docs.map((path) => (
							<li key={path} className="min-w-0">
								<PathLink icon={FileText} label={path} onClick={() => onOpenPath(`/docs/${path}`)} />
							</li>
						))}
					</ul>
				)}
			</FactGroup>

			<FactGroup label={tasks.length > 1 ? `Completed tasks · ${tasks.length}` : "Completed task"}>
				{tasks.length === 0 ? (
					<span className="text-muted-foreground">No task linked.</span>
				) : (
					<ul className="flex flex-col">
						{tasks.map((id) => (
							<li key={id} className="min-w-0">
								<PathLink icon={ListTodo} label={id} onClick={() => onOpenPath(`/tasks/${id}`)} />
							</li>
						))}
					</ul>
				)}
			</FactGroup>
		</div>
	);
}

function SourceLink({ source, onOpenPath }: { source: string; onOpenPath: (path: string) => void }) {
	const ref = parseSource(source);
	const Icon = ref.kind === "task" ? ListTodo : ref.kind === "url" ? ExternalLink : ref.kind === "text" ? Quote : FileText;
	const path =
		ref.kind === "doc"
			? `/docs/${ref.path}`
			: ref.kind === "task"
				? `/tasks/${ref.id}`
				: ref.kind === "memory"
					? `/memory/${encodeURIComponent(ref.id)}`
					: ref.kind === "decision"
						? `/decisions/${encodeURIComponent(ref.id)}`
						: null;
	if (path) return <PathLink icon={Icon} label={source} onClick={() => onOpenPath(path)} />;
	if (ref.kind === "url") {
		return (
			<a
				href={ref.href}
				target="_blank"
				rel="noreferrer"
				title={source}
				className={cn("-mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-muted-foreground hover:text-foreground", focusRing)}
			>
				<Icon aria-hidden className="h-3.5 w-3.5 flex-none" />
				<span className="min-w-0 truncate font-mono text-[12px]">{source}</span>
			</a>
		);
	}
	return (
		<span title={source} className="flex min-w-0 items-center gap-2 py-1 text-muted-foreground">
			<Icon aria-hidden className="h-3.5 w-3.5 flex-none" />
			<span className="min-w-0 truncate font-mono text-[12px]">{source}</span>
		</span>
	);
}

function PathLink({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
	return (
		<button
			type="button"
			title={label}
			onClick={onClick}
			className={cn(
				"-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-muted-foreground transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] hover:text-foreground",
				focusRing,
			)}
		>
			<Icon aria-hidden className="h-3.5 w-3.5 flex-none" />
			<span className="min-w-0 truncate font-mono text-[12px]">{label}</span>
		</button>
	);
}

function Fact({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0 truncate" title={title}>
				{children}
			</dd>
		</>
	);
}

function FactGroup({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<span className="text-[12px] font-medium text-muted-foreground">{label}</span>
			{children}
		</div>
	);
}

/* ── Dialogs ── */

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
	onConfirm: () => void;
}) {
	const impact = action ? reviewActionImpact(action, candidate) : null;
	return (
		<Dialog open={action !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
			<DialogContent
				hideCloseButton
				className="z-[100] w-[min(560px,calc(100vw-2rem))] gap-0 overflow-hidden rounded-xl bg-background p-0 shadow-[0_12px_32px_rgba(0,0,0,0.2)]"
				data-testid="decision-action-confirmation"
			>
				<DialogTitle className="border-b px-5 py-4 text-base">{impact?.title || "Confirm outcome"}</DialogTitle>
				<DialogDescription className="sr-only">Review the exact lifecycle effect before confirming.</DialogDescription>
				{impact ? (
					<div className="px-5 py-5">
						<dl className="divide-y border-y text-sm">
							<ImpactRow label="Candidate" value={`${candidate.title} · @decision/${candidate.id}`} />
							<ImpactRow label="Target" value={impact.target} />
							<ImpactRow label="Evidence outcome" value={impact.evidence} />
							<ImpactRow label="Resulting lifecycle" value={impact.lifecycle} />
						</dl>
					</div>
				) : null}
				<div className="flex flex-col-reverse gap-2 border-t px-5 py-4 sm:flex-row sm:justify-end">
					<Button type="button" variant="ghost" onClick={onCancel} disabled={busy} className="min-h-11 sm:min-h-10">
						Cancel
					</Button>
					{impact ? (
						<Button
							type="button"
							variant={impact.danger ? "destructive" : "default"}
							onClick={onConfirm}
							disabled={busy}
							className="min-h-11 sm:min-h-10"
						>
							{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <impact.icon className="h-4 w-4" />}
							{impact.confirmLabel}
						</Button>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function CreateCandidateDialog({
	open,
	onOpenChange,
	busy,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	busy: boolean;
	onSubmit: (draft: DecisionDraft) => Promise<void>;
}) {
	const [draft, setDraft] = useState<DecisionDraft>(() => emptyDraft());
	const canSubmit = draft.title.trim() !== "" && draft.decision.trim() !== "";
	const set = (key: keyof DecisionDraft) => (value: string) => setDraft((current) => ({ ...current, [key]: value }));

	useEffect(() => {
		if (open) setDraft(emptyDraft());
	}, [open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				hideCloseButton
				className="left-0 top-0 flex h-[100dvh] max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 shadow-none sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[calc(100dvh-3rem)] sm:w-[min(820px,calc(100vw-3rem))] sm:max-w-[820px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:shadow-[0_12px_32px_rgba(0,0,0,0.16)]"
				id="decision-create-workflow"
			>
				<DialogTitle className="sr-only">Create a System Decision candidate</DialogTitle>
				<DialogDescription className="sr-only">
					Create a persisted candidate that returns to the Decision Review Inbox.
				</DialogDescription>
				<form
					className="flex min-h-0 flex-1 flex-col"
					onSubmit={(event) => {
						event.preventDefault();
						if (canSubmit && !busy) void onSubmit(draft);
					}}
					data-testid="decision-create-panel"
				>
					<div className="flex flex-none items-start justify-between gap-4 border-b px-5 py-4 sm:px-7 sm:py-5">
						<div>
							<h2 className="text-xl font-semibold tracking-[-0.02em]">New Decision candidate</h2>
							<p className="mt-1 max-w-[65ch] text-sm leading-6 text-muted-foreground">
								Creating never changes current guidance. The candidate waits in Review Inbox for evidence and review.
							</p>
						</div>
						<KnButton
							type="button"
							variant="ghost"
							icon={<X />}
							onClick={() => onOpenChange(false)}
							aria-label="Close new candidate"
							className="h-11 w-11 flex-none text-muted-foreground sm:h-8 sm:w-8"
						/>
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
						<div className="flex flex-col gap-5">
							<div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
								<Field label="Title" id="decision-draft-title">
									<Input
										id="decision-draft-title"
										value={draft.title}
										onChange={(event) => set("title")(event.target.value)}
										placeholder="Require reviewed workflow checkpoints"
									/>
								</Field>
								<Field label="Tags" id="decision-draft-tags" optional hint="Comma separated">
									<Input
										id="decision-draft-tags"
										value={draft.tagsText}
										onChange={(event) => set("tagsText")(event.target.value)}
										placeholder="workflow, review"
									/>
								</Field>
							</div>
							<Field label="Decision" id="decision-draft-decision" hint="What was decided, in a sentence or two.">
								<Textarea
									id="decision-draft-decision"
									value={draft.decision}
									onChange={(event) => set("decision")(event.target.value)}
									rows={3}
								/>
							</Field>
							<Field label="Context" id="decision-draft-context" optional>
								<Textarea
									id="decision-draft-context"
									value={draft.context}
									onChange={(event) => set("context")(event.target.value)}
									rows={3}
								/>
							</Field>
							<div className="grid gap-4 sm:grid-cols-2">
								<Field label="Alternatives considered" id="decision-draft-alternatives" optional>
									<Textarea
										id="decision-draft-alternatives"
										value={draft.alternativesConsidered}
										onChange={(event) => set("alternativesConsidered")(event.target.value)}
										rows={3}
									/>
								</Field>
								<Field label="Consequences" id="decision-draft-consequences" optional>
									<Textarea
										id="decision-draft-consequences"
										value={draft.consequences}
										onChange={(event) => set("consequences")(event.target.value)}
										rows={3}
									/>
								</Field>
							</div>

							<div className="flex flex-col gap-4 border-t pt-5">
								<div>
									<h3 className="text-[13.5px] font-semibold">Evidence</h3>
									<p className="mt-0.5 text-[13px] text-muted-foreground">
										Optional now. A candidate needs a readable source and a completed task before it can be accepted.
									</p>
								</div>
								<ReferencePicker
									label="Sources"
									value={draft.sourcesText}
									onChange={set("sourcesText")}
									placeholder="@doc/specs/path, https://…"
									allowedKinds={["doc", "task", "decision", "memory"]}
									valueMode="source"
								/>
								<div className="grid gap-4 sm:grid-cols-2">
									<ReferencePicker
										label="Related docs"
										value={draft.relatedDocsText}
										onChange={set("relatedDocsText")}
										placeholder="specs/path"
										allowedKinds={["doc"]}
										valueMode="related-doc"
										browseLabel="Find doc"
									/>
									<ReferencePicker
										label="Completed tasks"
										value={draft.relatedTasksText}
										onChange={set("relatedTasksText")}
										placeholder="task-id"
										allowedKinds={["task"]}
										valueMode="related-task"
										browseLabel="Find task"
									/>
								</div>
							</div>
						</div>
					</div>

					<div className="flex flex-none flex-col-reverse gap-2 border-t px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end sm:px-7">
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)} className="min-h-11 sm:min-h-9">
							Cancel
						</Button>
						<Button type="submit" variant="default" disabled={!canSubmit || busy} className="min-h-11 sm:min-h-9">
							{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Inbox className="h-4 w-4" />}
							{busy ? "Saving…" : "Save to Review Inbox"}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function ImpactRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="grid gap-1 py-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-4">
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
	primary = false,
	danger = false,
	fullWidth = false,
}: {
	label: string;
	Icon?: LucideIcon;
	disabled?: boolean;
	onClick?: () => void;
	primary?: boolean;
	danger?: boolean;
	fullWidth?: boolean;
}) {
	return (
		<Button
			type="button"
			variant={primary ? "default" : "outline"}
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"min-h-11 sm:min-h-9",
				danger && "border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive",
				fullWidth && "w-full",
			)}
		>
			{Icon ? <Icon className="h-4 w-4" /> : null}
			<span className="truncate">{label}</span>
		</Button>
	);
}

/* ── Helpers ── */

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
				danger: false,
			};
		case "accept_new":
			return {
				title: "Confirm acceptance",
				target: "No current Decision is replaced",
				evidence: `${candidate.verification?.length || 0} verified evidence record(s); no review blockers or unresolved matches.`,
				lifecycle: "Candidate becomes accepted and enters Current guidance.",
				confirmLabel: "Accept as current",
				icon: ShieldCheck,
				danger: false,
			};
		case "link_as_related":
			return {
				title: "Confirm link to current",
				target: `${action.targetTitle} (@decision/${action.targetID})`,
				evidence: "Candidate provenance is transferred to the selected current Decision.",
				lifecycle: "Candidate becomes rejected history; the selected Decision remains current.",
				confirmLabel: "Link and close candidate",
				icon: Link2,
				danger: false,
			};
		case "supersede_existing":
			return {
				title: "Confirm replacement",
				target: `${action.targetTitle} (@decision/${action.targetID})`,
				evidence: "Candidate evidence is re-checked immediately before the atomic replacement.",
				lifecycle: "Candidate becomes current; the selected target becomes superseded history.",
				confirmLabel: "Replace current",
				icon: GitBranch,
				danger: false,
			};
		case "reject_new":
			return {
				title: "Confirm rejection",
				target: "This persisted candidate",
				evidence: "Existing evidence and review metadata remain readable in History.",
				lifecycle: "Candidate becomes rejected history and never enters Current guidance.",
				confirmLabel: "Reject candidate",
				icon: XCircle,
				danger: true,
			};
	}
}

function filterOptionsFor(view: DecisionView, decisions: DecisionEntry[]): FilterOption[] {
	if (view === "review") {
		const states: DecisionReviewState[] = ["needs_evidence", "needs_resolution", "ready_for_review"];
		return [
			{ value: ALL, label: "All", count: decisions.length },
			...states.map((state) => ({
				value: state,
				label: state === "ready_for_review" ? "Ready" : reviewStateLabels[state],
				count: decisions.filter((entry) => (entry.reviewState || "needs_evidence") === state).length,
			})),
		];
	}
	if (view === "history") {
		return [
			{ value: ALL, label: "All", count: decisions.length },
			...historyStatuses.map((status) => ({
				value: status,
				label: statusLabels[status],
				count: decisions.filter((entry) => entry.status === status).length,
			})),
		];
	}
	const counts = new Map<string, number>();
	for (const entry of decisions) for (const tag of entry.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
	return [
		{ value: ALL, label: "All tags", count: decisions.length },
		...Array.from(counts.entries())
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([tag, count]) => ({ value: tag, label: `#${tag}`, count })),
	];
}

function matchesFilter(view: DecisionView, entry: DecisionEntry, filter: string) {
	if (filter === ALL) return true;
	if (view === "review") return (entry.reviewState || "needs_evidence") === filter;
	if (view === "history") return entry.status === filter;
	return (entry.tags || []).includes(filter);
}

/** The four ADR parts as one markdown document; empty optional parts are skipped. */
function decisionMarkdown(decision: DecisionEntry) {
	const parts = bodySections
		.map((section) => {
			const text = String(decision[section.key] || "").trim();
			if (!text && section.key !== "decision") return "";
			return `## ${section.label}\n\n${text || "_Not documented._"}`;
		})
		.filter(Boolean);
	return parts.join("\n\n");
}

/** First paragraph of markdown as plain text, for the one-line summary in a row. */
function plainSummary(markdown: string) {
	const text = markdown
		.replace(/```[\s\S]*?```/g, " ")
		.split(/\n\s*\n/)
		.map((block) => block.trim())
		.find((block) => block && !/^#{1,6}\s/.test(block));
	return text ? plainText(text).slice(0, 240) : "";
}

/** Inline markdown as plain text (emphasis, code, links and list markers removed). */
function plainText(markdown: string) {
	return markdown
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[`*_>#]/g, "")
		.replace(/^\s*[-+]\s+/gm, "")
		.replace(/^\s*\d+\.\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
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
			return "Evidence is verified and no current Decision conflict remains. A person can accept or reject it.";
		default:
			return "This candidate cannot progress until a readable source and a completed task verify.";
	}
}

function reviewStateLabel(candidate: DecisionEntry) {
	return reviewStateLabels[candidate.reviewState || "needs_evidence"];
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

function dateValue(value?: string) {
	const parsed = value ? new Date(value).getTime() : Number.NaN;
	return Number.isNaN(parsed) ? 0 : parsed;
}

function formatDate(value?: string) {
	if (!value) return "Not set";
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return "Not set";
	return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
