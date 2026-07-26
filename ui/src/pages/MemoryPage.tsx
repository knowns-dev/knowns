import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ComponentType,
	type ReactNode,
} from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
	MemoryReviewRequiredError,
	memoryApi,
	search as searchKnowns,
	type KnownsSearchResult,
	type KnownsSearchResponse,
	type MemoryBulkAction,
	type MemoryEntry,
	type MemoryReviewInboxResponse,
	type MemoryReviewItem,
	type MemoryReviewReason,
	type MemoryReviewResult,
	type MemorySourceRepair,
	type MemoryStatus,
	type PersistentMemoryLayer,
} from "@/ui/api/client";
import {
	Archive,
	ArrowLeft,
	Brain,
	Check,
	CheckCircle2,
	ChevronRight,
	CircleAlert,
	Clock3,
	Copy,
	FileText,
	FileQuestion,
	GitMerge,
	History,
	Inbox,
	Link2,
	ListTodo,
	Loader2,
	Plus,
	RefreshCw,
	Search,
	ShieldCheck,
	Wrench,
	X,
	XCircle,
	type LucideIcon,
} from "lucide-react";
import MDRender from "@/ui/components/editor/MDRender";
import ReferencePicker from "@/ui/components/organisms/ReferencePicker";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/ui/components/ui/dialog";
import { cn } from "@/ui/lib/utils";

type MemoryView = "trusted" | "review" | "history";
type MemoryReviewState = "needs_evidence" | "needs_resolution" | "needs_reverification" | "ready_for_review";

type CreateDraft = {
	title: string;
	content: string;
	layer: PersistentMemoryLayer;
	category: string;
	sourcesText: string;
};

type ReviewAction =
	| { kind: "verify" }
	| { kind: "archive" }
	| { kind: "reject" }
	| { kind: "link_source"; sources: string[] }
	| { kind: "repair_source"; source: string; replacement: string }
	| { kind: "merge_existing"; targetID: string; targetTitle: string };

type LoadResult = {
	memories: MemoryEntry[];
	inbox: MemoryReviewInboxResponse;
	reviewAvailable: boolean;
};

type SuggestedSource = {
	kind: "doc" | "task";
	id: string;
	title: string;
	reference: string;
	score: number;
	snippet?: string;
	status?: string;
};

const emptyInbox: MemoryReviewInboxResponse = {
	memories: [],
	items: [],
	counts: {
		proposed: 0,
		duplicate_review: 0,
		stale_ttl: 0,
		missing_source: 0,
		source_missing: 0,
		source_decision_superseded: 0,
	},
};

const destinations: Array<{
	id: MemoryView;
	label: string;
	path: "/memory" | "/memory/review" | "/memory/history";
	icon: ComponentType<{ className?: string }>;
}> = [
	{ id: "trusted", label: "Trusted", path: "/memory", icon: ShieldCheck },
	{ id: "review", label: "Review Inbox", path: "/memory/review", icon: Inbox },
	{ id: "history", label: "History", path: "/memory/history", icon: History },
];

const statusLabels: Record<MemoryStatus, string> = {
	proposed: "Proposed",
	active: "Active",
	stale: "Stale",
	deprecated: "Deprecated",
	archived: "Archived",
	rejected: "Rejected",
	merged: "Merged",
};

const reasonLabels: Record<MemoryReviewReason, string> = {
	proposed: "Proposed",
	duplicate_review: "Similar memory",
	stale_ttl: "Re-verification due",
	missing_source: "Missing source",
	source_missing: "Broken source",
	source_decision_superseded: "Superseded source",
};

const reviewStateLabels: Record<MemoryReviewState, string> = {
	needs_evidence: "Needs evidence",
	needs_resolution: "Needs resolution",
	needs_reverification: "Needs re-verification",
	ready_for_review: "Ready for review",
};

const historyStatuses = new Set<MemoryStatus>(["archived", "rejected", "merged", "deprecated"]);
const sourceReasons = new Set<MemoryReviewReason>([
	"missing_source",
	"source_missing",
	"source_decision_superseded",
]);

export default function MemoryPage() {
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const view = viewFromPath(pathname);
	const [memories, setMemories] = useState<MemoryEntry[]>([]);
	const [inbox, setInbox] = useState<MemoryReviewInboxResponse>(emptyInbox);
	const [reviewAvailable, setReviewAvailable] = useState(true);
	const [selectedID, setSelectedID] = useState<string | null>(null);
	const [selectedIDs, setSelectedIDs] = useState<Set<string>>(() => new Set());
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(true);
	const [actionBusy, setActionBusy] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [bulkAction, setBulkAction] = useState<MemoryBulkAction | null>(null);
	const [errorMessage, setErrorMessage] = useState("");
	const [notice, setNotice] = useState("");
	const [dataWarning, setDataWarning] = useState("");
	const lastOpenedMemoryID = useRef<string | null>(null);

	const loadMemories = useCallback(async (): Promise<LoadResult> => {
		setErrorMessage("");
		const [listResult, reviewResult] = await Promise.allSettled([
			memoryApi.list(),
			memoryApi.reviewInbox(),
		]);

		if (listResult.status === "rejected" && reviewResult.status === "rejected") {
			throw new Error("Failed to load Memories and review metadata.");
		}

		const nextMemories =
			listResult.status === "fulfilled"
				? listResult.value
				: reviewResult.status === "fulfilled"
					? reviewResult.value.memories
					: [];
		const nextInbox =
			reviewResult.status === "fulfilled"
				? reviewResult.value
				: { ...emptyInbox, memories: nextMemories };
		const nextReviewAvailable = reviewResult.status === "fulfilled";
		const warnings: string[] = [];
		if (listResult.status === "rejected") {
			warnings.push("The base ledger is unavailable; showing the review service snapshot.");
		}
		if (reviewResult.status === "rejected") {
			warnings.push("Review metadata is unavailable; Trusted and History remain readable.");
		}

		setMemories(mergeMemorySets(nextMemories, nextInbox.memories));
		setInbox(nextInbox);
		setReviewAvailable(nextReviewAvailable);
		setDataWarning(warnings.join(" "));
		setSelectedIDs(new Set());
		return {
			memories: mergeMemorySets(nextMemories, nextInbox.memories),
			inbox: nextInbox,
			reviewAvailable: nextReviewAvailable,
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		loadMemories()
			.catch((error: unknown) => {
				if (!cancelled) {
					setErrorMessage(error instanceof Error ? error.message : "Failed to load Memories");
				}
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [loadMemories]);

	useEffect(() => {
		setSelectedID(null);
		setSelectedIDs(new Set());
		setQuery("");
	}, [view]);

	const itemByID = useMemo(() => {
		const result = new Map<string, MemoryReviewItem>();
		for (const item of inbox.items) result.set(item.memory.id, item);
		return result;
	}, [inbox.items]);

	const memoryByID = useMemo(() => {
		const result = new Map<string, MemoryEntry>();
		for (const memory of memories) result.set(memory.id, memory);
		for (const item of inbox.items) result.set(item.memory.id, item.memory);
		return result;
	}, [inbox.items, memories]);

	const trustedMemories = useMemo(
		() => memories.filter((memory) => normalizedStatus(memory) === "active"),
		[memories],
	);

	const historicalMemories = useMemo(
		() => memories.filter((memory) => historyStatuses.has(normalizedStatus(memory))),
		[memories],
	);

	const destinationMemories = useMemo(() => {
		switch (view) {
			case "review":
				return inbox.items.map((item) => item.memory);
			case "history":
				return historicalMemories;
			default:
				return trustedMemories;
		}
	}, [historicalMemories, inbox.items, trustedMemories, view]);

	const visibleMemories = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		if (!normalized) return destinationMemories;
		return destinationMemories.filter((memory) => {
			const reviewItem = itemByID.get(memory.id);
			return [
				memory.title,
				memory.id,
				memory.content,
				memory.layer,
				memory.category,
				...(memory.tags || []),
				...(memory.sources || []),
				...(reviewItem?.reasons || []),
			]
				.filter(Boolean)
				.some((value) => String(value).toLowerCase().includes(normalized));
		});
	}, [destinationMemories, itemByID, query]);

	const selectedMemory = selectedID ? memoryByID.get(selectedID) || null : null;
	const selectedReviewItem = selectedID ? itemByID.get(selectedID) || null : null;
	const selectedReviewItems = useMemo(
		() => inbox.items.filter((item) => selectedIDs.has(item.memory.id)),
		[inbox.items, selectedIDs],
	);
	const canVerifySelected =
		selectedReviewItems.length > 0 &&
		selectedReviewItems.every(
			(item) =>
				!item.reasons.some((reason) => sourceReasons.has(reason)) &&
				(item.memory.status === "proposed" || item.memory.status === "stale"),
		);
	const canRejectSelected =
		selectedReviewItems.length > 0 &&
		selectedReviewItems.every((item) => item.memory.status === "proposed");

	const destinationCounts: Record<MemoryView, number> = {
		trusted: trustedMemories.length,
		review: inbox.items.length,
		history: historicalMemories.length,
	};

	const handleNavigate = useCallback(
		(nextView: MemoryView) => {
			const destination = destinations.find((item) => item.id === nextView);
			if (destination) void navigate({ to: destination.path });
		},
		[navigate],
	);

	const handleOpenMemory = useCallback((id: string) => {
		lastOpenedMemoryID.current = id;
		setSelectedID(id);
	}, []);

	const handleCloseMemory = useCallback(() => {
		setSelectedID(null);
		const memoryID = lastOpenedMemoryID.current;
		if (!memoryID) return;
		requestAnimationFrame(() => {
			const memoryRow = document.querySelector<HTMLButtonElement>(
				`[data-testid="memory-row-${memoryID}"]`,
			);
			const activeDestination =
				document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
			(memoryRow || activeDestination)?.focus();
		});
	}, []);

	const handleRefresh = useCallback(async () => {
		setLoading(true);
		setNotice("");
		try {
			await loadMemories();
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Failed to refresh Memories");
		} finally {
			setLoading(false);
		}
	}, [loadMemories]);

	const handleReviewAction = useCallback(
		async (memory: MemoryEntry, action: ReviewAction) => {
			setActionBusy(true);
			setErrorMessage("");
			try {
				switch (action.kind) {
					case "merge_existing":
						await memoryApi.resolveReview({
							resolution: "merge_existing",
							targetId: action.targetID,
							id: memory.id,
							title: memory.title,
							content: memory.content,
							layer: memory.layer === "working" ? "project" : memory.layer,
							category: memory.category,
							tags: memory.tags,
							sources: memory.sources,
							confidence: memory.confidence,
							ttlDays: memory.ttlDays,
						});
						break;
					case "link_source":
						await memoryApi.action(memory.id, { action: "link_source", sources: action.sources });
						break;
					case "repair_source":
						await memoryApi.action(memory.id, {
							action: "repair_source",
							source: action.source,
							replacement: action.replacement,
						});
						break;
					default:
						await memoryApi.action(memory.id, { action: action.kind });
				}
				const refreshed = await loadMemories();
				const stillNeedsReview = refreshed.inbox.items.some((item) => item.memory.id === memory.id);
				setNotice(reviewActionNotice(action, memory));
				if (stillNeedsReview && refreshed.reviewAvailable) {
					setSelectedID(memory.id);
				} else {
					handleCloseMemory();
				}
				return true;
			} catch (error) {
				setErrorMessage(error instanceof Error ? error.message : "Memory review action failed");
				return false;
			} finally {
				setActionBusy(false);
			}
		},
		[handleCloseMemory, loadMemories],
	);

	const handleBulkAction = useCallback(async () => {
		if (!bulkAction || selectedIDs.size === 0) return;
		setActionBusy(true);
		setErrorMessage("");
		try {
			await memoryApi.bulkAction(bulkAction, Array.from(selectedIDs));
			await loadMemories();
			setBulkAction(null);
			setSelectedIDs(new Set());
			setNotice(`${bulkActionLabel(bulkAction)} completed for ${selectedIDs.size} Memories.`);
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Bulk Memory action failed");
		} finally {
			setActionBusy(false);
		}
	}, [bulkAction, loadMemories, selectedIDs]);

	const handleSelect = useCallback((id: string, checked: boolean) => {
		setSelectedIDs((current) => {
			const next = new Set(current);
			if (checked) next.add(id);
			else next.delete(id);
			return next;
		});
	}, []);

	const handleCreated = useCallback(
		async (created: MemoryEntry) => {
			setCreateOpen(false);
			handleNavigate("review");
			try {
				await loadMemories();
				setNotice(`Proposal @memory/${created.id} saved to Review Inbox.`);
			} catch (error) {
				setErrorMessage(
					error instanceof Error
						? `Memory was saved, but Review Inbox could not refresh: ${error.message}`
						: "Memory was saved, but Review Inbox could not refresh.",
				);
			}
		},
		[handleNavigate, loadMemories],
	);

	if (loading) return <MemoryLoadingState />;

	return (
		<div className="flex h-full flex-col overflow-hidden bg-[#FAFAFA] text-zinc-950 dark:bg-background dark:text-foreground">
			<header className="shrink-0 border-b border-zinc-200 bg-white dark:border-border dark:bg-background">
				<div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-start justify-between gap-4 px-4 py-5 sm:px-6">
					<div className="min-w-0">
						<h1 className="text-2xl font-semibold tracking-[-0.025em]">Memories</h1>
						<p className="mt-1 max-w-[72ch] text-sm leading-6 text-zinc-600 dark:text-muted-foreground">
							Trusted memories are read-only here. New recall and uncertain evidence stay in Review Inbox until explicitly resolved.
						</p>
					</div>
					<div className="flex items-center gap-1">
						{view === "review" ? (
							<button
								type="button"
								onClick={() => setCreateOpen(true)}
								className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 dark:border-border dark:bg-background dark:hover:bg-accent sm:min-h-9"
							>
								<Plus className="h-4 w-4" />
								New proposal
							</button>
						) : null}
						<button
							type="button"
							onClick={() => void handleRefresh()}
							aria-label="Refresh Memories"
							className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 dark:text-muted-foreground dark:hover:bg-accent dark:hover:text-foreground sm:h-9 sm:w-9"
						>
							<RefreshCw className="h-4 w-4" />
						</button>
					</div>
				</div>

				<div
					className="mx-auto flex w-full max-w-[1440px] items-end gap-1 overflow-x-auto px-4 sm:px-6"
					role="tablist"
					aria-label="Memory destinations"
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
									"inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 sm:min-h-10",
									active
										? "border-zinc-950 text-zinc-950 dark:border-zinc-100 dark:text-zinc-100"
										: "border-transparent text-zinc-500 hover:text-zinc-950 dark:text-muted-foreground dark:hover:text-foreground",
								)}
							>
								<Icon className="h-4 w-4" />
								{destination.label}
								<span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-600 dark:bg-muted dark:text-muted-foreground">
									{destinationCounts[destination.id]}
								</span>
							</button>
						);
					})}
				</div>
			</header>

			{errorMessage ? (
				<div
					role="alert"
					className="fixed left-1/2 top-4 z-[90] w-[min(92vw,640px)] -translate-x-1/2 rounded-lg border border-red-200 bg-white px-4 py-3 text-sm text-red-700 shadow-lg dark:border-destructive/30 dark:bg-background dark:text-destructive"
				>
					{errorMessage}
				</div>
			) : null}
			{notice ? (
				<div
					role="status"
					aria-live="polite"
					className="fixed left-1/2 top-4 z-[90] w-[min(92vw,640px)] -translate-x-1/2 rounded-lg border border-emerald-200 bg-white px-4 py-3 text-sm text-emerald-700 shadow-lg dark:border-emerald-500/30 dark:bg-background dark:text-emerald-300"
				>
					{notice}
				</div>
			) : null}

			<main className="min-h-0 flex-1 overflow-y-auto">
				<section
					className="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6"
					data-testid={`memory-${view}-destination`}
				>
					<div className="mb-4 flex flex-wrap items-end justify-between gap-3">
						<div>
							<h2 className="text-base font-semibold">{destinationTitle(view)}</h2>
							<p className="mt-1 text-sm text-zinc-500 dark:text-muted-foreground">
								{destinationDescription(view)}
							</p>
						</div>
						<label className="relative block w-full sm:w-72">
							<span className="sr-only">Search this destination</span>
							<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
							<input
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Search title, ID, source…"
								className="min-h-11 w-full rounded-lg border border-zinc-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 dark:border-border dark:bg-background sm:min-h-9"
							/>
						</label>
					</div>

					{dataWarning ? (
						<p
							role="status"
							className="mb-4 flex items-start gap-2 border-y border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
						>
							<CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
							{dataWarning}
						</p>
					) : null}

					{view === "review" && selectedIDs.size > 0 ? (
						<BulkActionBar
							selectedCount={selectedIDs.size}
							canVerify={canVerifySelected}
							canReject={canRejectSelected}
							onAction={setBulkAction}
							onClear={() => setSelectedIDs(new Set())}
						/>
					) : null}

					{view === "review" && !reviewAvailable ? (
						<EmptyState
							title="Review Inbox is temporarily unavailable"
							description="Trusted and History remain readable. Refresh when review metadata is available again."
						/>
					) : (
						<MemoryRegister
							view={view}
							memories={visibleMemories}
							itemByID={itemByID}
							selectedIDs={selectedIDs}
							onSelect={handleSelect}
							onOpen={handleOpenMemory}
						/>
					)}
				</section>
			</main>

			<Dialog open={selectedMemory !== null} onOpenChange={(open) => !open && handleCloseMemory()}>
				<DialogContent
					hideCloseButton
					overlayClassName="bg-zinc-950/45 backdrop-blur-[1.5px]"
					className="left-0 top-0 flex h-[100dvh] max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-white p-0 shadow-none dark:bg-background sm:left-1/2 sm:top-1/2 sm:h-[min(860px,calc(100dvh-3rem))] sm:w-[min(1120px,calc(100vw-3rem))] sm:max-w-[1120px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:border-zinc-200 sm:shadow-[0_12px_32px_rgba(0,0,0,0.16)] dark:sm:border-border"
					onCloseAutoFocus={(event) => event.preventDefault()}
					data-testid="memory-focus-dialog"
				>
					<DialogTitle className="sr-only">{selectedMemory?.title || "Memory detail"}</DialogTitle>
					<DialogDescription className="sr-only">
						{view === "review" ? "Review a persisted Memory." : "Read Memory details and provenance."}
					</DialogDescription>
					{selectedMemory ? (
						view === "review" && selectedReviewItem ? (
							<MemoryReviewDetail
								memory={selectedMemory}
								reviewItem={selectedReviewItem}
								busy={actionBusy}
								onClose={handleCloseMemory}
								onAction={handleReviewAction}
							/>
						) : (
							<ReadOnlyMemoryDetail
								memory={selectedMemory}
								trusted={view === "trusted"}
								busy={actionBusy}
								onClose={handleCloseMemory}
								onRemoveFromTrusted={(memory) =>
									handleReviewAction(memory, { kind: "archive" })
								}
							/>
						)
					) : null}
				</DialogContent>
			</Dialog>

			<CreateMemoryDialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				onCreated={handleCreated}
			/>

			<ConfirmBulkActionDialog
				action={bulkAction}
				count={selectedIDs.size}
				busy={actionBusy}
				onCancel={() => setBulkAction(null)}
				onConfirm={() => void handleBulkAction()}
			/>
		</div>
	);
}

function MemoryRegister({
	view,
	memories,
	itemByID,
	selectedIDs,
	onSelect,
	onOpen,
}: {
	view: MemoryView;
	memories: MemoryEntry[];
	itemByID: Map<string, MemoryReviewItem>;
	selectedIDs: Set<string>;
	onSelect: (id: string, checked: boolean) => void;
	onOpen: (id: string) => void;
}) {
	if (memories.length === 0) {
		return (
			<EmptyState
				title={view === "review" ? "Review Inbox is clear" : "No Memories here"}
				description={
					view === "review"
						? "New proposals, stale recall, and source repairs will appear here."
						: "No records match this destination and search."
				}
			/>
		);
	}

	return (
		<div
			className="overflow-hidden border-y border-zinc-200 bg-white dark:border-border dark:bg-background"
			data-testid="memory-list"
		>
			<div
				className={cn(
					"hidden gap-4 border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-xs font-medium text-zinc-500 dark:border-border dark:bg-muted/20 dark:text-muted-foreground md:grid",
					view === "review"
						? "grid-cols-[32px_minmax(0,1fr)_170px_130px_32px]"
						: "grid-cols-[minmax(0,1fr)_170px_130px_32px]",
				)}
			>
				{view === "review" ? <span aria-hidden="true" /> : null}
				<span>Memory</span>
				<span>{view === "review" ? "Review state" : "Lifecycle"}</span>
				<span>Updated</span>
				<span aria-hidden="true" />
			</div>
			<div className="divide-y divide-zinc-200 dark:divide-border">
				{memories.map((memory) => {
					const reviewItem = itemByID.get(memory.id);
					return (
						<div
							key={memory.id}
							className={cn(
								"group grid min-h-[76px] items-center gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-muted/20 md:gap-4",
								view === "review"
									? "grid-cols-[32px_minmax(0,1fr)_auto] md:grid-cols-[32px_minmax(0,1fr)_170px_130px_32px]"
									: "grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_170px_130px_32px]",
							)}
							data-testid={`memory-register-item-${memory.id}`}
						>
							{view === "review" ? (
								<label className="flex h-8 w-8 items-center justify-center" title="Select Memory">
									<input
										type="checkbox"
										checked={selectedIDs.has(memory.id)}
										onChange={(event) => onSelect(memory.id, event.target.checked)}
										className="h-4 w-4 accent-emerald-700"
										aria-label={`Select ${memory.title || memory.id}`}
									/>
								</label>
							) : null}
							<button
								type="button"
								onClick={() => onOpen(memory.id)}
								className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
								data-testid={`memory-row-${memory.id}`}
							>
								<span className="block truncate text-sm font-medium text-zinc-950 dark:text-foreground">
									{memory.title || "Untitled memory"}
								</span>
								<span className="mt-1 block truncate font-mono text-xs text-zinc-500 dark:text-muted-foreground">
									@memory/{memory.id} · {memory.layer}
									{memory.category ? ` · ${memory.category}` : ""}
								</span>
							</button>
							<span className="hidden md:block">
								{view === "review" && reviewItem ? (
									<ReviewStatePill state={reviewState(reviewItem)} />
								) : (
									<StatusPill status={normalizedStatus(memory)} trusted={view === "trusted"} />
								)}
							</span>
							<span className="hidden text-sm tabular-nums text-zinc-500 dark:text-muted-foreground md:block">
								{formatDate(memory.updatedAt)}
							</span>
							<button
								type="button"
								onClick={() => onOpen(memory.id)}
								aria-label={`Open ${memory.title || memory.id}`}
								className="flex items-center gap-2 justify-self-end rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
							>
								<span className="md:hidden">
									{view === "review" && reviewItem ? (
										<ReviewStatePill state={reviewState(reviewItem)} />
									) : (
										<StatusPill status={normalizedStatus(memory)} trusted={view === "trusted"} />
									)}
								</span>
								<ChevronRight className="h-4 w-4 text-zinc-400 transition-transform group-hover:translate-x-0.5" />
							</button>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function ReadOnlyMemoryDetail({
	memory,
	trusted,
	busy,
	onClose,
	onRemoveFromTrusted,
}: {
	memory: MemoryEntry;
	trusted: boolean;
	busy: boolean;
	onClose: () => void;
	onRemoveFromTrusted: (memory: MemoryEntry) => Promise<boolean>;
}) {
	const [copied, setCopied] = useState(false);
	const [removeOpen, setRemoveOpen] = useState(false);
	const reference = `@memory/${memory.id}`;

	useEffect(() => {
		setRemoveOpen(false);
	}, [memory.id]);

	const confirmRemoval = async () => {
		const succeeded = await onRemoveFromTrusted(memory);
		if (succeeded) setRemoveOpen(false);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="memory-readonly-detail">
			<FocusHeader
				title={memory.title || "Untitled memory"}
				reference={reference}
				badge={<StatusPill status={normalizedStatus(memory)} trusted={trusted} />}
				context={trusted ? "Available to default retrieval" : "Historical record"}
				copied={copied}
				onCopy={() => {
					void navigator.clipboard?.writeText(reference);
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1500);
				}}
				onClose={onClose}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto md:grid md:grid-cols-[minmax(0,1fr)_340px] md:overflow-hidden">
				<article className="px-5 py-6 sm:px-8 sm:py-8 md:min-h-0 md:overflow-y-auto">
					<div className="border-y border-zinc-200 py-6 dark:border-border">
						{memory.content ? (
							<MDRender
								markdown={memory.content}
								className="prose prose-zinc max-w-[72ch] dark:prose-invert"
							/>
						) : (
							<p className="text-sm text-zinc-500 dark:text-muted-foreground">No content.</p>
						)}
					</div>
				</article>
				<MemoryMetadataAside memory={memory}>
					{trusted && normalizedStatus(memory) === "active" ? (
						<section className="mt-7 border-t border-zinc-200 pt-6 dark:border-border">
							<h3 className="text-sm font-semibold">Lifecycle</h3>
							<p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-muted-foreground">
								Stop default retrieval and move this Memory to History. Its content and provenance
								will be retained.
							</p>
							<div className="mt-4">
								<ActionButton
									label="Remove from Trusted"
									Icon={Archive}
									fullWidth
									disabled={busy}
									onClick={() => setRemoveOpen(true)}
								/>
							</div>
						</section>
					) : null}
				</MemoryMetadataAside>
			</div>

			<ConfirmReviewActionDialog
				memory={memory}
				action={removeOpen ? { kind: "archive" } : null}
				busy={busy}
				onCancel={() => setRemoveOpen(false)}
				onConfirm={() => void confirmRemoval()}
			/>
		</div>
	);
}

function MemoryReviewDetail({
	memory,
	reviewItem,
	busy,
	onClose,
	onAction,
}: {
	memory: MemoryEntry;
	reviewItem: MemoryReviewItem;
	busy: boolean;
	onClose: () => void;
	onAction: (memory: MemoryEntry, action: ReviewAction) => Promise<boolean>;
}) {
	const [sourceText, setSourceText] = useState("");
	const [action, setAction] = useState<ReviewAction | null>(null);
	const [copied, setCopied] = useState(false);
	const state = reviewState(reviewItem);
	const hasSourceIssue = reviewItem.reasons.some((reason) => sourceReasons.has(reason));
	const shouldRecommendSources = reviewItem.reasons.some(
		(reason) => reason === "missing_source" || reason === "source_missing",
	);
	const canVerify =
		!hasSourceIssue && (memory.status === "proposed" || memory.status === "stale");
	const canReject = memory.status === "proposed";
	const reference = `@memory/${memory.id}`;
	const parsedSources = parseSourceInput(sourceText);

	useEffect(() => {
		setSourceText("");
		setAction(null);
	}, [memory.id]);

	const confirmAction = async () => {
		if (!action) return;
		const succeeded = await onAction(memory, action);
		if (succeeded) setAction(null);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="memory-review-detail">
			<FocusHeader
				title={memory.title || "Untitled memory"}
				reference={reference}
				badge={<ReviewStatePill state={state} />}
				context="Persisted Memory review"
				copied={copied}
				onCopy={() => {
					void navigator.clipboard?.writeText(reference);
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1500);
				}}
				onClose={onClose}
			/>

			<div className="min-h-0 flex-1 overflow-y-auto md:grid md:grid-cols-[minmax(0,1fr)_340px] md:overflow-hidden">
				<article className="px-5 py-6 sm:px-8 sm:py-8 md:min-h-0 md:overflow-y-auto">
					<section className="border-y border-zinc-200 py-5 dark:border-border">
						<h3 className="text-sm font-semibold">Why this needs review</h3>
						<p className="mt-2 max-w-[68ch] text-base leading-7 text-zinc-600 dark:text-muted-foreground">
							{reviewStateDescription(state)}
						</p>
						<div className="mt-3 flex flex-wrap gap-2">
							{reviewItem.reasons.map((reason) => (
								<ReasonPill key={reason} reason={reason} />
							))}
						</div>
						{reviewItem.issues?.length ? (
							<ul className="mt-4 space-y-2 text-sm text-amber-800 dark:text-amber-300">
								{reviewItem.issues.map((issue) => (
									<li key={`${issue.code}-${issue.source || issue.message}`} className="flex gap-2">
										<CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
										<span>{issue.message}</span>
									</li>
								))}
							</ul>
						) : null}
					</section>

					<section className="border-b border-zinc-200 py-6 dark:border-border">
						<h3 className="mb-4 text-sm font-semibold">Memory content</h3>
						{memory.content ? (
							<MDRender
								markdown={memory.content}
								className="prose prose-zinc max-w-[72ch] dark:prose-invert"
							/>
						) : (
							<p className="text-sm text-zinc-500 dark:text-muted-foreground">No content.</p>
						)}
					</section>

					{hasSourceIssue ? (
						<section className="border-b border-zinc-200 py-6 dark:border-border" data-testid="memory-source-panel">
							<h3 className="text-sm font-semibold">Repair evidence</h3>
							<p className="mt-1 max-w-[68ch] text-sm leading-6 text-zinc-500 dark:text-muted-foreground">
								Add a readable source, or apply a verified replacement below. The Memory is re-evaluated after saving.
							</p>
							{shouldRecommendSources ? (
								<SuggestedSources
									memory={memory}
									value={sourceText}
									onChange={setSourceText}
								/>
							) : null}
							<div className="mt-5">
								<ReferencePicker
									label="Sources"
									value={sourceText}
									onChange={setSourceText}
									placeholder="@doc/path, @task/id, https://…"
									allowedKinds={["doc", "task", "decision", "memory"]}
									valueMode="source"
								/>
								<div className="mt-3 flex justify-end">
									<ActionButton
										label="Review source update"
										Icon={Link2}
										disabled={busy || parsedSources.length === 0}
										onClick={() => setAction({ kind: "link_source", sources: parsedSources })}
									/>
								</div>
							</div>
							{reviewItem.repairSources?.length ? (
								<div className="mt-6 divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-border dark:border-border">
									{reviewItem.repairSources.map((repair) => (
										<SourceRepairRow
											key={`${repair.source}-${repair.replacement}`}
											repair={repair}
											onReview={() =>
												setAction({
													kind: "repair_source",
													source: repair.source,
													replacement: repair.replacement,
												})
											}
										/>
									))}
								</div>
							) : null}
						</section>
					) : null}

					{reviewItem.matches?.length ? (
						<section className="border-b border-zinc-200 py-6 dark:border-border" data-testid="memory-duplicate-panel">
							<h3 className="text-sm font-semibold">Similar trusted Memories</h3>
							<p className="mt-1 max-w-[68ch] text-sm leading-6 text-zinc-500 dark:text-muted-foreground">
								Merge this proposal into an existing trusted Memory, or keep it separate by explicitly activating it.
							</p>
							<div className="mt-4 divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-border dark:border-border">
								{reviewItem.matches.map((match) => (
									<div key={match.id} className="flex flex-wrap items-start justify-between gap-3 py-4">
										<div className="min-w-0">
											<p className="truncate text-sm font-medium">{match.title || match.id}</p>
											<p className="mt-1 font-mono text-xs text-zinc-500 dark:text-muted-foreground">
												@memory/{match.id} · {Math.round(match.score * 100)}%
											</p>
											{match.snippet ? (
												<p className="mt-2 line-clamp-2 max-w-[56ch] text-sm text-zinc-500 dark:text-muted-foreground">
													{match.snippet}
												</p>
											) : null}
										</div>
										<ActionButton
											label="Review merge"
											Icon={GitMerge}
											disabled={busy}
											onClick={() =>
												setAction({
													kind: "merge_existing",
													targetID: match.id,
													targetTitle: match.title || match.id,
												})
											}
										/>
									</div>
								))}
							</div>
						</section>
					) : null}

					{canVerify ? (
						<section className="py-6">
							<h3 className="text-sm font-semibold">
								{memory.status === "stale" ? "Re-verify this Memory" : "Keep as separate trusted recall"}
							</h3>
							<p className="mt-1 max-w-[68ch] text-sm leading-6 text-zinc-500 dark:text-muted-foreground">
								This makes the Memory active and available to default retrieval.
							</p>
							<div className="mt-4">
								<ActionButton
									label={memory.status === "stale" ? "Review re-verification" : "Review activation"}
									Icon={CheckCircle2}
									primary
									disabled={busy}
									onClick={() => setAction({ kind: "verify" })}
								/>
							</div>
						</section>
					) : null}
				</article>

				<aside className="border-t border-zinc-200 bg-zinc-50/70 px-5 py-6 dark:border-border dark:bg-muted/10 md:min-h-0 md:overflow-y-auto md:border-l md:border-t-0">
					<h3 className="text-sm font-semibold">Review outcome</h3>
					<dl className="mt-4 divide-y divide-zinc-200 border-y border-zinc-200 text-sm dark:divide-border dark:border-border">
						<MetadataRow label="Lifecycle" value={statusLabels[normalizedStatus(memory)]} />
						<MetadataRow label="Layer" value={memory.layer} />
						<MetadataRow label="Category" value={memory.category || "Uncategorized"} />
						<MetadataRow label="Updated" value={formatDate(memory.updatedAt)} />
					</dl>

					<div className="mt-6 space-y-2">
						<ActionButton
							label="Review archive"
							Icon={Archive}
							fullWidth
							disabled={busy}
							onClick={() => setAction({ kind: "archive" })}
						/>
						{canReject ? (
							<ActionButton
								label="Review rejection"
								Icon={XCircle}
								fullWidth
								danger
								disabled={busy}
								onClick={() => setAction({ kind: "reject" })}
							/>
						) : null}
					</div>
				</aside>
			</div>

			<ConfirmReviewActionDialog
				memory={memory}
				action={action}
				busy={busy}
				onCancel={() => setAction(null)}
				onConfirm={() => void confirmAction()}
			/>
		</div>
	);
}

function FocusHeader({
	title,
	reference,
	badge,
	context,
	copied,
	onCopy,
	onClose,
}: {
	title: string;
	reference: string;
	badge: ReactNode;
	context: string;
	copied: boolean;
	onCopy: () => void;
	onClose: () => void;
}) {
	return (
		<div className="flex shrink-0 items-start gap-3 border-b border-zinc-200 px-4 py-4 dark:border-border sm:px-6">
			<button
				type="button"
				onClick={onClose}
				aria-label="Back to Memories"
				className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 dark:text-muted-foreground dark:hover:bg-accent dark:hover:text-foreground sm:h-9 sm:w-9"
				data-testid="memory-mobile-back"
			>
				<ArrowLeft className="h-4 w-4" />
			</button>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					{badge}
					<span className="text-xs text-zinc-500 dark:text-muted-foreground">{context}</span>
				</div>
				<h2 className="mt-2 text-xl font-semibold tracking-[-0.02em] sm:text-2xl">{title}</h2>
				<button
					type="button"
					onClick={onCopy}
					className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-zinc-500 hover:text-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 dark:text-muted-foreground dark:hover:text-foreground"
				>
					{reference}
					<Copy className="h-3 w-3" />
					<span className="sr-only">{copied ? "Copied" : "Copy reference"}</span>
				</button>
			</div>
			<button
				type="button"
				onClick={onClose}
				aria-label="Close Memory detail"
				className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 sm:h-9 sm:w-9"
			>
				<X className="h-4 w-4" />
			</button>
		</div>
	);
}

function MemoryMetadataAside({
	memory,
	children,
}: {
	memory: MemoryEntry;
	children?: ReactNode;
}) {
	return (
		<aside className="border-t border-zinc-200 bg-zinc-50/70 px-5 py-6 dark:border-border dark:bg-muted/10 md:min-h-0 md:overflow-y-auto md:border-l md:border-t-0">
			<h3 className="text-sm font-semibold">Provenance</h3>
			<dl className="mt-4 divide-y divide-zinc-200 border-y border-zinc-200 text-sm dark:divide-border dark:border-border">
				<MetadataRow label="Layer" value={memory.layer} />
				<MetadataRow label="Category" value={memory.category || "Uncategorized"} />
				<MetadataRow label="Confidence" value={memory.confidence || "Not set"} />
				<MetadataRow label="Last verified" value={formatDate(memory.lastVerified)} />
				<MetadataRow label="TTL" value={memory.ttlDays ? `${memory.ttlDays} days` : "Not set"} />
				<MetadataRow label="Updated" value={formatDate(memory.updatedAt)} />
			</dl>
			<section className="mt-6">
				<h3 className="text-sm font-semibold">Sources</h3>
				{memory.sources?.length ? (
					<ul className="mt-3 divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-border dark:border-border">
						{memory.sources.map((source) => (
							<li key={source} className="break-all py-3 font-mono text-xs text-zinc-600 dark:text-muted-foreground">
								{source}
							</li>
						))}
					</ul>
				) : (
					<p className="mt-2 text-sm text-zinc-500 dark:text-muted-foreground">No source linked.</p>
				)}
			</section>
			{memory.mergedInto ? (
				<section className="mt-6">
					<h3 className="text-sm font-semibold">Merged into</h3>
					<p className="mt-2 break-all font-mono text-xs text-zinc-600 dark:text-muted-foreground">
						@memory/{memory.mergedInto}
					</p>
				</section>
			) : null}
			{children}
		</aside>
	);
}

function SuggestedSources({
	memory,
	value,
	onChange,
}: {
	memory: MemoryEntry;
	value: string;
	onChange: (value: string) => void;
}) {
	const [suggestions, setSuggestions] = useState<SuggestedSource[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [reloadKey, setReloadKey] = useState(0);
	const selectedSources = useMemo(() => new Set(parseSourceInput(value)), [value]);

	useEffect(() => {
		let cancelled = false;
		const query = sourceRecommendationQuery(memory);
		if (!query) {
			setSuggestions([]);
			setLoading(false);
			setError("");
			return;
		}

		setLoading(true);
		setError("");
		Promise.allSettled([
			searchKnowns(query, { type: "doc", mode: "hybrid", limit: 6 }),
			searchKnowns(query, { type: "task", mode: "hybrid", limit: 6 }),
		])
			.then(([docResult, taskResult]) => {
				if (cancelled) return;
				if (docResult.status === "rejected" && taskResult.status === "rejected") {
					setSuggestions([]);
					setError("Suggestions are unavailable. Manual source entry still works.");
					return;
				}

				const docs =
					docResult.status === "fulfilled" ? docResult.value.docs : [];
				const tasks =
					taskResult.status === "fulfilled" ? taskResult.value.tasks : [];
				setSuggestions(buildSourceSuggestions(docs, tasks, memory.sources || []));
			})
			.catch(() => {
				if (cancelled) return;
				setSuggestions([]);
				setError("Suggestions are unavailable. Manual source entry still works.");
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [memory, reloadKey]);

	return (
		<section className="mt-5" data-testid="memory-source-recommendations">
			<div className="flex flex-wrap items-end justify-between gap-2">
				<div>
					<h4 className="text-sm font-semibold">Suggested sources</h4>
					<p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-muted-foreground">
						Nearby current docs and tasks ranked from this Memory’s title and content.
					</p>
				</div>
				{!loading && !error && suggestions.length > 0 ? (
					<span className="text-xs tabular-nums text-zinc-500 dark:text-muted-foreground">
						{suggestions.length} nearby
					</span>
				) : null}
			</div>

			<div className="mt-3" aria-live="polite">
				{loading ? (
					<div
						className="divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-border dark:border-border"
						aria-label="Loading suggested sources"
					>
						{Array.from({ length: 3 }).map((_, index) => (
							<div key={index} className="flex min-h-16 items-center gap-3 py-3">
								<span className="h-8 w-8 shrink-0 animate-pulse rounded-md bg-zinc-100 dark:bg-muted" />
								<span className="min-w-0 flex-1">
									<span className="block h-4 w-2/5 animate-pulse rounded bg-zinc-100 dark:bg-muted" />
									<span className="mt-2 block h-3 w-3/4 animate-pulse rounded bg-zinc-100 dark:bg-muted" />
								</span>
							</div>
						))}
					</div>
				) : error ? (
					<div className="flex flex-wrap items-center justify-between gap-3 border-y border-zinc-200 py-3 text-sm dark:border-border">
						<span className="text-zinc-600 dark:text-muted-foreground">{error}</span>
						<button
							type="button"
							onClick={() => setReloadKey((current) => current + 1)}
							className="inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 dark:text-foreground dark:hover:bg-accent"
						>
							<RefreshCw className="h-4 w-4" />
							Retry
						</button>
					</div>
				) : suggestions.length === 0 ? (
					<p className="border-y border-zinc-200 py-3 text-sm text-zinc-500 dark:border-border dark:text-muted-foreground">
						No nearby docs or tasks found. Search manually or enter an external source below.
					</p>
				) : (
					<ul className="divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-border dark:border-border">
						{suggestions.map((suggestion) => {
							const selected = selectedSources.has(suggestion.reference);
							const Icon = suggestion.kind === "doc" ? FileText : ListTodo;
							return (
								<li key={`${suggestion.kind}-${suggestion.id}`}>
									<button
										type="button"
										onClick={() => onChange(appendSourceValue(value, suggestion.reference))}
										disabled={selected}
										aria-label={`${selected ? "Selected" : "Select"} ${suggestion.kind}: ${suggestion.title}`}
										className="group flex min-h-16 w-full items-start gap-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-default"
									>
										<span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-500 group-hover:text-zinc-950 dark:bg-muted dark:text-muted-foreground dark:group-hover:text-foreground">
											<Icon className="h-4 w-4" />
										</span>
										<span className="min-w-0 flex-1">
											<span className="flex flex-wrap items-center gap-2">
												<span className="truncate text-sm font-medium">{suggestion.title}</span>
												<span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-muted dark:text-muted-foreground">
													{suggestion.kind === "doc" ? "Doc" : "Task"}
												</span>
												{suggestion.status ? (
													<span className="text-xs text-zinc-500 dark:text-muted-foreground">
														{suggestion.status}
													</span>
												) : null}
											</span>
											<span className="mt-1 block truncate font-mono text-xs text-zinc-500 dark:text-muted-foreground">
												{suggestion.reference}
											</span>
											{suggestion.snippet ? (
												<span className="mt-1 line-clamp-2 block text-xs leading-5 text-zinc-500 dark:text-muted-foreground">
													{suggestion.snippet}
												</span>
											) : null}
										</span>
										<span
											className={cn(
												"inline-flex min-w-[72px] shrink-0 items-center justify-end gap-1 pt-1 text-xs font-medium",
												selected
													? "text-emerald-700 dark:text-emerald-300"
													: "text-zinc-500 group-hover:text-zinc-950 dark:text-muted-foreground dark:group-hover:text-foreground",
											)}
										>
											{selected ? (
												<>
													<Check className="h-4 w-4" />
													Selected
												</>
											) : (
												`${formatMatchScore(suggestion.score)} match`
											)}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</section>
	);
}

function SourceRepairRow({
	repair,
	onReview,
}: {
	repair: MemorySourceRepair;
	onReview: () => void;
}) {
	return (
		<div className="flex flex-wrap items-start justify-between gap-3 py-4">
			<div className="min-w-0">
				<p className="break-all font-mono text-xs text-zinc-500 line-through dark:text-muted-foreground">
					{repair.source}
				</p>
				<p className="mt-1 break-all font-mono text-xs text-zinc-950 dark:text-foreground">
					{repair.replacement}
				</p>
			</div>
			<ActionButton label="Review repair" Icon={Wrench} onClick={onReview} />
		</div>
	);
}

function ConfirmReviewActionDialog({
	memory,
	action,
	busy,
	onCancel,
	onConfirm,
}: {
	memory: MemoryEntry;
	action: ReviewAction | null;
	busy: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const impact = action ? reviewActionImpact(action) : null;
	return (
		<Dialog open={action !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
			<DialogContent
				hideCloseButton
				overlayClassName="z-[90] bg-zinc-950/55"
				className="z-[100] w-[min(560px,calc(100vw-2rem))] gap-0 overflow-hidden rounded-xl border border-zinc-200 bg-white p-0 shadow-[0_12px_32px_rgba(0,0,0,0.2)] dark:border-border dark:bg-background"
				data-testid="memory-impact-dialog"
			>
				<DialogTitle className="border-b border-zinc-200 px-5 py-4 text-base dark:border-border">
					Confirm Memory outcome
				</DialogTitle>
				<DialogDescription className="sr-only">
					Review the selected Memory, target, evidence effect, and resulting lifecycle before confirming.
				</DialogDescription>
				{impact ? (
					<div className="px-5 py-5">
						<dl className="divide-y divide-zinc-200 border-y border-zinc-200 text-sm dark:divide-border dark:border-border">
							<ImpactRow label="Memory" value={`${memory.title || "Untitled memory"} · @memory/${memory.id}`} />
							{impact.target ? <ImpactRow label="Target" value={impact.target} /> : null}
							<ImpactRow label="Evidence outcome" value={impact.evidence} />
							<ImpactRow label="Resulting lifecycle" value={impact.lifecycle} />
						</dl>
					</div>
				) : null}
				<div className="flex flex-col-reverse gap-2 border-t border-zinc-200 px-5 py-4 dark:border-border sm:flex-row sm:justify-end">
					<button
						type="button"
						onClick={onCancel}
						disabled={busy}
						className="min-h-11 rounded-lg px-4 text-sm font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:text-muted-foreground dark:hover:bg-accent sm:min-h-10"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={onConfirm}
						disabled={busy}
						className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200 sm:min-h-10"
					>
						{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
						Confirm outcome
					</button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function BulkActionBar({
	selectedCount,
	canVerify,
	canReject,
	onAction,
	onClear,
}: {
	selectedCount: number;
	canVerify: boolean;
	canReject: boolean;
	onAction: (action: MemoryBulkAction) => void;
	onClear: () => void;
}) {
	return (
		<div
			className="mb-4 flex min-h-12 flex-wrap items-center justify-between gap-3 border-y border-zinc-200 bg-white px-3 py-2 dark:border-border dark:bg-background"
			data-testid="memory-bulk-toolbar"
		>
			<div className="flex items-center gap-3">
				<span className="text-sm font-medium">{selectedCount} selected</span>
				<button
					type="button"
					onClick={onClear}
					className="text-sm text-zinc-500 hover:text-zinc-950 dark:text-muted-foreground dark:hover:text-foreground"
				>
					Clear
				</button>
			</div>
			<div className="flex flex-wrap gap-2">
				<ActionButton
					label="Verify"
					Icon={CheckCircle2}
					disabled={!canVerify}
					onClick={() => onAction("verify")}
				/>
				<ActionButton label="Archive" Icon={Archive} onClick={() => onAction("archive")} />
				<ActionButton
					label="Reject proposed"
					Icon={XCircle}
					danger
					disabled={!canReject}
					onClick={() => onAction("reject_proposed")}
				/>
			</div>
		</div>
	);
}

function ConfirmBulkActionDialog({
	action,
	count,
	busy,
	onCancel,
	onConfirm,
}: {
	action: MemoryBulkAction | null;
	count: number;
	busy: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	return (
		<Dialog open={action !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
			<DialogContent
				hideCloseButton
				overlayClassName="z-[90] bg-zinc-950/55"
				className="z-[100] w-[min(520px,calc(100vw-2rem))] gap-0 overflow-hidden rounded-xl border border-zinc-200 bg-white p-0 shadow-[0_12px_32px_rgba(0,0,0,0.2)] dark:border-border dark:bg-background"
			>
				<DialogTitle className="border-b border-zinc-200 px-5 py-4 text-base dark:border-border">
					Confirm bulk outcome
				</DialogTitle>
				<DialogDescription className="px-5 py-5 text-sm leading-6 text-zinc-600 dark:text-muted-foreground">
					{action ? `${bulkActionLabel(action)} will update ${count} selected Memories.` : ""}
				</DialogDescription>
				<div className="flex flex-col-reverse gap-2 border-t border-zinc-200 px-5 py-4 dark:border-border sm:flex-row sm:justify-end">
					<button
						type="button"
						onClick={onCancel}
						disabled={busy}
						className="min-h-11 rounded-lg px-4 text-sm font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:text-muted-foreground dark:hover:bg-accent sm:min-h-10"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={onConfirm}
						disabled={busy}
						className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950 sm:min-h-10"
					>
						{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
						Confirm bulk action
					</button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function CreateMemoryDialog({
	open,
	onOpenChange,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: (memory: MemoryEntry) => Promise<void>;
}) {
	const [draft, setDraft] = useState<CreateDraft>({
		title: "",
		content: "",
		layer: "project",
		category: "",
		sourcesText: "",
	});
	const [review, setReview] = useState<MemoryReviewResult | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState("");
	const legacyDecisionCategory = draft.category.trim().toLowerCase() === "decision";

	useEffect(() => {
		if (!open) {
			setReview(null);
			setError("");
		}
	}, [open]);

	const resetAndClose = useCallback(() => {
		setDraft({ title: "", content: "", layer: "project", category: "", sourcesText: "" });
		setReview(null);
		setError("");
		onOpenChange(false);
	}, [onOpenChange]);

	const create = useCallback(
		async (skipReview: boolean) => {
			setSubmitting(true);
			setError("");
			try {
				const memory = await memoryApi.create({
					title: draft.title.trim(),
					content: draft.content,
					layer: draft.layer,
					category: draft.category.trim(),
					status: "proposed",
					sources: parseSourceInput(draft.sourcesText),
					skipReview,
				});
				await onCreated(memory);
				setDraft({ title: "", content: "", layer: "project", category: "", sourcesText: "" });
				setReview(null);
			} catch (error) {
				if (error instanceof MemoryReviewRequiredError) {
					setReview(error.result);
				} else {
					setError(error instanceof Error ? error.message : "Failed to create Memory proposal");
				}
			} finally {
				setSubmitting(false);
			}
		},
		[draft, onCreated],
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				hideCloseButton
				overlayClassName="bg-zinc-950/45 backdrop-blur-[1.5px]"
				className="left-0 top-0 flex h-[100dvh] max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-white p-0 shadow-none dark:bg-background sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[calc(100dvh-3rem)] sm:w-[min(900px,calc(100vw-3rem))] sm:max-w-[900px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:border-zinc-200 sm:shadow-[0_12px_32px_rgba(0,0,0,0.16)] dark:sm:border-border"
				data-testid="memory-create-dialog"
			>
				<DialogTitle className="sr-only">Create a Memory proposal</DialogTitle>
				<DialogDescription className="sr-only">
					Create a proposed Memory that returns to Review Inbox.
				</DialogDescription>
				<div className="min-h-0 overflow-y-auto p-5 sm:p-7">
					<div className="flex items-start justify-between gap-4">
						<div>
							<h2 className="text-xl font-semibold tracking-[-0.02em]">New Memory proposal</h2>
							<p className="mt-1 max-w-[65ch] text-sm leading-6 text-zinc-500 dark:text-muted-foreground">
								Every manual Memory begins as proposed and remains outside trusted retrieval until reviewed.
							</p>
						</div>
						<button
							type="button"
							onClick={resetAndClose}
							aria-label="Close Memory proposal"
							className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 dark:hover:bg-accent sm:h-9 sm:w-9"
						>
							<X className="h-4 w-4" />
						</button>
					</div>

					<form
						className="mt-6 space-y-5"
						onSubmit={(event) => {
							event.preventDefault();
							void create(false);
						}}
					>
						<FormField label="Title">
							<input
								value={draft.title}
								onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
								placeholder="Optional title"
								className="min-h-11 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 dark:border-border dark:bg-background"
							/>
						</FormField>
						<FormField label="Content">
							<textarea
								value={draft.content}
								onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
								placeholder="Write durable recall in markdown"
								rows={8}
								className="w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 dark:border-border dark:bg-background"
							/>
						</FormField>
						<div className="grid gap-4 sm:grid-cols-2">
							<FormField label="Layer">
								<select
									value={draft.layer}
									onChange={(event) =>
										setDraft((current) => ({
											...current,
											layer: event.target.value as PersistentMemoryLayer,
										}))
									}
									className="min-h-11 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 dark:border-border dark:bg-background"
								>
									<option value="project">Project</option>
									<option value="global">Global</option>
								</select>
							</FormField>
							<FormField label="Category">
								<input
									value={draft.category}
									onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))}
									placeholder="pattern, convention, preference…"
									className="min-h-11 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600 dark:border-border dark:bg-background"
								/>
							</FormField>
						</div>
						<ReferencePicker
							label="Sources"
							value={draft.sourcesText}
							onChange={(sourcesText) => setDraft((current) => ({ ...current, sourcesText }))}
							placeholder="@doc/path, @task/id, https://…"
							allowedKinds={["doc", "task", "decision", "memory"]}
							valueMode="source"
						/>

						{legacyDecisionCategory ? (
							<p className="border-y border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
								Memory category “decision” is legacy. Create a first-class System Decision from Decisions instead.
							</p>
						) : null}
						{review ? (
							<DuplicateReviewPanel
								review={review}
								busy={submitting}
								onCreateAnyway={() => void create(true)}
							/>
						) : null}
						{error ? (
							<p className="border-y border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700 dark:border-destructive/30 dark:bg-destructive/10 dark:text-destructive">
								{error}
							</p>
						) : null}

						<div className="flex flex-col-reverse gap-2 border-t border-zinc-200 pt-5 dark:border-border sm:flex-row sm:justify-end">
							<button
								type="button"
								onClick={resetAndClose}
								className="min-h-11 rounded-lg px-4 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-muted-foreground dark:hover:bg-accent"
							>
								Cancel
							</button>
							<button
								type="submit"
								disabled={!draft.content.trim() || legacyDecisionCategory || submitting}
								className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
							>
								{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
								Save proposal
							</button>
						</div>
					</form>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function DuplicateReviewPanel({
	review,
	busy,
	onCreateAnyway,
}: {
	review: MemoryReviewResult;
	busy: boolean;
	onCreateAnyway: () => void;
}) {
	return (
		<section className="border-y border-amber-200 bg-amber-50 px-4 py-4 dark:border-amber-500/30 dark:bg-amber-500/10">
			<div className="flex items-start gap-2">
				<CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
				<div>
					<h3 className="text-sm font-semibold">Similar trusted Memories found</h3>
					<p className="mt-1 text-sm leading-6 text-amber-800/90 dark:text-amber-200">
						Keeping this separate persists a proposal in Review Inbox; it does not make the Memory trusted.
					</p>
				</div>
			</div>
			<div className="mt-4 divide-y divide-amber-200 border-y border-amber-200 dark:divide-amber-500/30 dark:border-amber-500/30">
				{(review.matches || []).map((match) => (
					<div key={match.id} className="py-3">
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-sm font-medium">{match.title || match.id}</span>
							<span className="text-xs text-amber-800 dark:text-amber-200">
								{Math.round(match.score * 100)}% similar
							</span>
						</div>
						<p className="mt-1 line-clamp-2 text-sm text-amber-800/80 dark:text-amber-200/80">
							{match.snippet || "No snippet."}
						</p>
					</div>
				))}
			</div>
			<button
				type="button"
				onClick={onCreateAnyway}
				disabled={busy}
				className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg border border-amber-700/30 px-3 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50 dark:text-amber-100 dark:hover:bg-amber-500/10"
			>
				<Plus className="h-4 w-4" />
				Keep separate as proposal
			</button>
		</section>
	);
}

function MemoryLoadingState() {
	return (
		<div className="flex h-full flex-col bg-[#FAFAFA] dark:bg-background" aria-label="Loading Memories">
			<div className="border-b border-zinc-200 bg-white px-4 py-5 dark:border-border dark:bg-background sm:px-6">
				<div className="h-7 w-36 animate-pulse rounded bg-zinc-200 dark:bg-muted" />
				<div className="mt-3 h-4 w-[min(560px,80vw)] animate-pulse rounded bg-zinc-100 dark:bg-muted/60" />
			</div>
			<div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6">
				<div className="space-y-px overflow-hidden border-y border-zinc-200 dark:border-border">
					{Array.from({ length: 6 }).map((_, index) => (
						<div key={index} className="h-20 animate-pulse bg-white dark:bg-muted/20" />
					))}
				</div>
			</div>
		</div>
	);
}

function StatusPill({ status, trusted = false }: { status: MemoryStatus; trusted?: boolean }) {
	return (
		<span
			className={cn(
				"inline-flex rounded-md px-2 py-0.5 text-xs font-medium",
				trusted || status === "active"
					? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
					: "bg-zinc-100 text-zinc-600 dark:bg-muted dark:text-muted-foreground",
			)}
		>
			{statusLabels[status]}
		</span>
	);
}

function ReviewStatePill({ state }: { state: MemoryReviewState }) {
	const tone =
		state === "ready_for_review"
			? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
			: state === "needs_resolution"
				? "bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300"
				: "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300";
	return <span className={cn("inline-flex rounded-md px-2 py-0.5 text-xs font-medium", tone)}>{reviewStateLabels[state]}</span>;
}

function ReasonPill({ reason }: { reason: MemoryReviewReason }) {
	return (
		<span className="inline-flex rounded-md border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 dark:border-border dark:text-muted-foreground">
			{reasonLabels[reason]}
		</span>
	);
}

function MetadataRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-start justify-between gap-4 py-3">
			<dt className="text-zinc-500 dark:text-muted-foreground">{label}</dt>
			<dd className="max-w-[60%] break-words text-right font-medium">{value}</dd>
		</div>
	);
}

function ImpactRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="grid gap-1 py-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-4">
			<dt className="text-zinc-500 dark:text-muted-foreground">{label}</dt>
			<dd className="break-words font-medium">{value}</dd>
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
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-10",
				primary
					? "bg-zinc-950 text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
					: danger
						? "border border-red-200 text-red-700 hover:bg-red-50 dark:border-destructive/30 dark:text-destructive dark:hover:bg-destructive/10"
						: "border border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-100 dark:border-border dark:bg-background dark:text-foreground dark:hover:bg-accent",
				fullWidth && "w-full",
			)}
		>
			{Icon ? <Icon className="h-4 w-4" /> : null}
			<span className="truncate">{label}</span>
		</button>
	);
}

function EmptyState({ title, description }: { title: string; description: string }) {
	return (
		<div className="flex min-h-52 flex-col items-center justify-center border-y border-zinc-200 bg-white px-4 py-10 text-center dark:border-border dark:bg-background">
			<Brain className="h-6 w-6 text-zinc-400" />
			<p className="mt-3 text-sm font-medium">{title}</p>
			<p className="mt-1 max-w-[52ch] text-sm leading-6 text-zinc-500 dark:text-muted-foreground">{description}</p>
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

function viewFromPath(pathname: string): MemoryView {
	if (pathname.startsWith("/memory/review")) return "review";
	if (pathname.startsWith("/memory/history")) return "history";
	return "trusted";
}

function destinationTitle(view: MemoryView) {
	switch (view) {
		case "review":
			return "Review Inbox";
		case "history":
			return "Historical Memories";
		default:
			return "Trusted Memories";
	}
}

function destinationDescription(view: MemoryView) {
	switch (view) {
		case "review":
			return "One row per Memory requiring activation, re-verification, evidence repair, or duplicate resolution.";
		case "history":
			return "Archived, rejected, merged, and deprecated recall retained for audit and context.";
		default:
			return "Active recall currently available to default search and runtime retrieval.";
	}
}

function reviewState(item: MemoryReviewItem): MemoryReviewState {
	if (item.reasons.some((reason) => sourceReasons.has(reason))) return "needs_evidence";
	if (item.reasons.includes("duplicate_review")) return "needs_resolution";
	if (item.reasons.includes("stale_ttl")) return "needs_reverification";
	return "ready_for_review";
}

function reviewStateDescription(state: MemoryReviewState) {
	switch (state) {
		case "needs_evidence":
			return "A source is missing, unreadable, or points to superseded guidance. Repair provenance before trusting this recall.";
		case "needs_resolution":
			return "This Memory overlaps trusted recall. Decide whether it should remain separate or merge into an existing Memory.";
		case "needs_reverification":
			return "The Memory exceeded its verification window and is excluded from default retrieval until re-verified.";
		default:
			return "This proposal has no blocking evidence issue and is ready for an explicit trust decision.";
	}
}

function normalizedStatus(memory: MemoryEntry): MemoryStatus {
	return memory.status || "active";
}

function mergeMemorySets(...sets: MemoryEntry[][]) {
	const byID = new Map<string, MemoryEntry>();
	for (const set of sets) {
		for (const memory of set) byID.set(memory.id, memory);
	}
	return Array.from(byID.values()).sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt));
}

function dateValue(value?: string) {
	if (!value) return 0;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function reviewActionImpact(action: ReviewAction) {
	switch (action.kind) {
		case "verify":
			return {
				evidence: "Current sources and review context will be recorded as explicitly re-verified.",
				lifecycle: "Active; included in default retrieval.",
			};
		case "archive":
			return {
				evidence: "Provenance is retained without remaining actionable.",
				lifecycle: "Archived; excluded from default retrieval and moved to History.",
			};
		case "reject":
			return {
				evidence: "The proposal is retained as a rejected review outcome.",
				lifecycle: "Rejected; excluded from default retrieval and moved to History.",
			};
		case "link_source":
			return {
				target: action.sources.join(", "),
				evidence: `${action.sources.length} source${action.sources.length === 1 ? "" : "s"} will be linked and review metadata recalculated.`,
				lifecycle: "Current lifecycle retained until re-evaluation completes.",
			};
		case "repair_source":
			return {
				target: `${action.source} → ${action.replacement}`,
				evidence: "The broken or superseded source will be replaced and verification time refreshed.",
				lifecycle: "Current lifecycle retained until re-evaluation completes.",
			};
		case "merge_existing":
			return {
				target: `${action.targetTitle} · @memory/${action.targetID}`,
				evidence: "The trusted target remains canonical; this Memory keeps a traceable merge pointer.",
				lifecycle: "Merged; excluded from default retrieval and moved to History.",
			};
	}
}

function reviewActionNotice(action: ReviewAction, memory: MemoryEntry) {
	const title = memory.title || `@memory/${memory.id}`;
	switch (action.kind) {
		case "verify":
			return `${title} is now trusted active recall.`;
		case "archive":
			return `${title} moved to History as archived.`;
		case "reject":
			return `${title} moved to History as rejected.`;
		case "merge_existing":
			return `${title} merged into ${action.targetTitle}.`;
		case "link_source":
			return `Sources linked to ${title}; Review Inbox was recalculated.`;
		case "repair_source":
			return `Source repaired for ${title}; Review Inbox was recalculated.`;
	}
}

function bulkActionLabel(action: MemoryBulkAction) {
	switch (action) {
		case "verify":
			return "Verify selected";
		case "archive":
			return "Archive selected";
		case "reject_proposed":
			return "Reject selected proposals";
	}
}

function sourceRecommendationQuery(memory: MemoryEntry) {
	return [memory.title, memory.content]
		.filter(Boolean)
		.join(" ")
		.replace(/[`*_>#()[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 600);
}

function buildSourceSuggestions(
	docs: KnownsSearchResult[],
	tasks: KnownsSearchResponse["tasks"],
	excludedSources: string[],
) {
	const excluded = new Set(excludedSources);
	const suggestions: SuggestedSource[] = [];

	for (const doc of docs) {
		const path = normalizeSuggestedDocPath(doc.path || doc.id);
		if (!path) continue;
		const reference = `@doc/${path}`;
		if (excluded.has(reference)) continue;
		suggestions.push({
			kind: "doc",
			id: path,
			title: doc.title || path,
			reference,
			score: doc.score || 0,
			snippet: doc.snippet,
		});
	}

	for (const task of tasks) {
		if (!task.id || !task.title) continue;
		const reference = `@task/${task.id}`;
		if (excluded.has(reference)) continue;
		suggestions.push({
			kind: "task",
			id: task.id,
			title: task.title,
			reference,
			score: task.score || 0,
			snippet: task.snippet || task.description,
			status: task.status,
		});
	}

	const unique = new Map<string, SuggestedSource>();
	for (const suggestion of suggestions.sort((left, right) => right.score - left.score)) {
		if (!unique.has(suggestion.reference)) unique.set(suggestion.reference, suggestion);
	}
	return Array.from(unique.values()).slice(0, 3);
}

function normalizeSuggestedDocPath(path: string) {
	return path
		.trim()
		.replace(/^@doc\//, "")
		.replace(/^\.knowns\/docs\//, "")
		.replace(/\.md$/, "");
}

function parseSourceInput(value: string) {
	return value
		.split(/[\n,]+/)
		.map((source) => source.trim())
		.filter(Boolean);
}

function appendSourceValue(current: string, next: string) {
	const sources = parseSourceInput(current);
	if (!sources.includes(next)) sources.push(next);
	return sources.join(", ");
}

function formatMatchScore(score: number) {
	return `${Math.max(0, Math.min(100, Math.round(score * 100)))}%`;
}

function formatDate(value?: string) {
	if (!value) return "Not set";
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return "Not set";
	return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
