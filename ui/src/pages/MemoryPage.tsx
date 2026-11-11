import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";

import { SourceLinkList } from "@/ui/components/molecules/SourceLinkList";
import { navigateTo } from "@/ui/lib/navigation";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
	MemoryReviewRequiredError,
	auditApi,
	memoryApi,
	search as searchKnowns,
	type AuditEvent,
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
	AtSign,
	Brain,
	Check,
	CheckCircle2,
	ChevronDown,
	ExternalLink,
	Pencil,
	Quote,
	CircleAlert,
	FileText,
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
import { Button } from "@/ui/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/ui/components/ui/dialog";
import { toast } from "@/ui/components/ui/sonner";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/ui/components/ui/sheet";
import { DetailSection } from "@/ui/components/organisms/TaskDetail/DetailSection";
import { MDEditor } from "@/ui/components/editor";
import { MDRenderWithHighlight } from "@/ui/components/editor/MDRenderWithHighlight";
import { parseSource } from "@/ui/components/molecules/SourceLinkList";
import { Fold } from "@/ui/lib/knowns/motion";
import { Breadcrumb } from "@/ui/components/ui/knowns/breadcrumb";
import { Button as KnButton } from "@/ui/components/ui/knowns/button";
import { Tag } from "@/ui/components/ui/knowns/tag";
import {
	PageHeader,
	type PageHeaderAction,
	type PageHeaderMeta,
} from "@/ui/components/ui/knowns/blocks/page-header";
import { focusRing, writeClipboard } from "@/ui/lib/knowns/utils";
import {
	AgentMemory,
	type MemoryItem,
	type MemoryScope,
	type MemoryUse,
	type ScopeFilter,
} from "@/ui/components/ui/knowns/agent-memory/agent-memory";
import { ago } from "@/ui/components/ui/knowns/agent-memory/memory-utils";
import { Badge, type BadgeTone } from "@/ui/components/ui/knowns/badge";
import { Checkbox } from "@/ui/components/ui/knowns/checkbox";
import { Input } from "@/ui/components/ui/knowns/input";
import { SegmentedControl } from "@/ui/components/ui/knowns/segmented-control";
import { Tabs, TabsList, TabsTrigger } from "@/ui/components/ui/knowns/tabs";
import { FeatureHeader } from "@/ui/components/templates";
import {
	PageContent,
	PageError,
	PageLoading,
	PageShell,
} from "@/ui/components/templates/PageShell";
import { useIsMobile } from "@/ui/hooks/useMobile";
import { cn } from "@/ui/lib/utils";
import { NoTools } from "@/ui/components/ui/knowns/illustrations/empty-states";

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
	icon: LucideIcon;
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

/*
 * The Knowns memory model on the agent-memory block:
 * - layer -> scope: global is the user's own recall across projects, project stays project,
 *   working is the short-lived session layer. The labels keep the Knowns names.
 * - pin -> the "pinned" tag, so it survives in the markdown and needs no new field.
 * - forget -> archive. Trusted recall is never deleted from here; it moves to History.
 * - "Why was this used?" -> MCP audit events that read the memory (memory get with its id).
 */
const PIN_TAG = "pinned";
const layerScope: Record<string, MemoryScope> = { global: "user", project: "project", working: "session" };
const scopeLabels: Record<MemoryScope, string> = { user: "Global", project: "Project", session: "Working" };
const scopeHints: Record<MemoryScope, string> = {
	user: "Global: your own recall, shared by every project",
	project: "Project: only this project",
	session: "Working: short-lived, this session only",
};
const scopeLayer: Record<MemoryScope, string> = { user: "global", project: "project", session: "working" };
const confidenceValue: Record<string, number> = { low: 0.35, medium: 0.65, high: 0.9 };

export default function MemoryPage() {
	const navigate = useNavigate();
	const isMobile = useIsMobile();
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const view = viewFromPath(pathname);
	// The graph links straight to one entry, e.g. /memory/<id>, so a node there
	// opens the same detail dialog the list uses.
	const routeSelectedID = useMemo(() => {
		const match = pathname.match(/^\/memory\/([^/]+)\/?$/);
		const id = match?.[1];
		if (!id) return null;
		return ["review", "history"].includes(id) ? null : decodeURIComponent(id);
	}, [pathname]);
	const [memories, setMemories] = useState<MemoryEntry[]>([]);
	const [inbox, setInbox] = useState<MemoryReviewInboxResponse>(emptyInbox);
	const [reviewAvailable, setReviewAvailable] = useState(true);
	const [uses, setUses] = useState<Map<string, MemoryUse[]> | null>(null);
	const [scope, setScope] = useState<ScopeFilter>("all");
	const [selectedID, setSelectedID] = useState<string | null>(null);
	const [selectedIDs, setSelectedIDs] = useState<Set<string>>(() => new Set());
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(true);
	const [actionBusy, setActionBusy] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [bulkAction, setBulkAction] = useState<MemoryBulkAction | null>(null);
	const [errorMessage, setErrorMessage] = useState("");
	const [dataWarning, setDataWarning] = useState("");
	const lastOpenedMemoryID = useRef<string | null>(null);

	const loadMemories = useCallback(async (): Promise<LoadResult> => {
		setErrorMessage("");
		const listPromise = memoryApi.list();
		const reviewPromise = memoryApi.reviewInbox();

		// The review inbox is far slower than the base ledger, so paint the ledger as
		// soon as it lands instead of holding the whole page in a skeleton behind it.
		void listPromise
			.then((base) => {
				setMemories((prev) => (prev.length === 0 ? base : prev));
				setLoading(false);
			})
			.catch(() => {});

		const [listResult, reviewResult] = await Promise.allSettled([
			listPromise,
			reviewPromise,
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

	// Usage comes from the MCP audit log and is optional: without it the rows simply
	// leave out "Used N times".
	const loadUses = useCallback(async () => {
		try {
			const { events } = await auditApi.recent({ tool: "memory", limit: 500 });
			setUses(usesFromAudit(events));
		} catch {
			setUses(null);
		}
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
		void loadUses();
		return () => {
			cancelled = true;
		};
	}, [loadMemories, loadUses]);

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

	const trustedItems = useMemo(
		() => trustedMemories.map((memory) => toMemoryItem(memory, uses)),
		[trustedMemories, uses],
	);
	const historyItems = useMemo(
		() => historicalMemories.map((memory) => toMemoryItem(memory, uses)),
		[historicalMemories, uses],
	);

	// The block searches its own text; ours also matches ids, content, tags and sources.
	const matchMemory = useCallback(
		(item: MemoryItem, q: string) => {
			const memory = memoryByID.get(item.id);
			return memory ? memoryMatches(memory, q, itemByID.get(item.id)) : false;
		},
		[itemByID, memoryByID],
	);

	const reviewMemories = useMemo(() => {
		const byScope = inbox.items
			.map((item) => item.memory)
			.filter((memory) => scope === "all" || memory.layer === scopeLayer[scope]);
		const q = query.trim();
		if (!q) return byScope;
		return byScope.filter((memory) => memoryMatches(memory, q, itemByID.get(memory.id)));
	}, [inbox.items, itemByID, query, scope]);

	// A linked entry may sit in a tab that has not been fetched yet — a proposal
	// while the trusted list is showing, say — so fall back to loading it alone.
	const [routeEntry, setRouteEntry] = useState<MemoryEntry | null>(null);
	useEffect(() => {
		if (!routeSelectedID) {
			setRouteEntry(null);
			return;
		}
		setSelectedID(routeSelectedID);
		if (memoryByID.has(routeSelectedID)) return;
		let cancelled = false;
		memoryApi
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
	}, [memoryByID, routeSelectedID]);

	const selectedMemory = selectedID ? memoryByID.get(selectedID) || routeEntry || null : null;
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

	const reviewCount = destinationCounts.review;
	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	const headerStatus =
		view === "history"
			? `${plural(destinationCounts.history, "retired Memory", "retired Memories")}, kept for provenance`
			: view === "trusted"
				? `${plural(destinationCounts.trusted, "Memory", "Memories")} agents recall by default${reviewCount > 0 ? `, ${reviewCount} to review` : ""}`
				: reviewCount > 0
					? `${plural(reviewCount, "proposal needs", "proposals need")} review before agents recall them`
					: "No proposals awaiting review";

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
			const memoryRow =
				document.querySelector<HTMLButtonElement>(`[data-testid="memory-row-${memoryID}"]`) ||
				document.querySelector<HTMLButtonElement>(`[data-memory-open="${CSS.escape(memoryID)}"]`);
			const activeDestination =
				document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
			(memoryRow || activeDestination)?.focus();
		});
	}, []);

	const handleRefresh = useCallback(async () => {
		setLoading(true);
		try {
			await loadMemories();
			void loadUses();
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : "Failed to refresh Memories");
		} finally {
			setLoading(false);
		}
	}, [loadMemories, loadUses]);

	const handleReviewAction = useCallback(
		async (memory: MemoryEntry, action: ReviewAction) => {
			setActionBusy(true);
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
				toast.success(reviewActionNotice(action, memory));
				if (stillNeedsReview && refreshed.reviewAvailable) {
					setSelectedID(memory.id);
				} else {
					handleCloseMemory();
				}
				return true;
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Memory review action failed");
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
		try {
			await memoryApi.bulkAction(bulkAction, Array.from(selectedIDs));
			await loadMemories();
			setBulkAction(null);
			setSelectedIDs(new Set());
			toast.success(`${bulkActionLabel(bulkAction)} completed for ${selectedIDs.size} Memories.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Bulk Memory action failed");
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
				toast.success(`Proposal @memory/${created.id} saved to Review Inbox.`);
			} catch (error) {
				toast.error(
					error instanceof Error
						? `Memory was saved, but Review Inbox could not refresh: ${error.message}`
						: "Memory was saved, but Review Inbox could not refresh.",
				);
			}
		},
		[handleNavigate, loadMemories],
	);

	// Block callbacks. Each applies locally first, so the row does not jump back while
	// the server answers, and reloads from the server if the save fails.
	const patchLocal = useCallback((id: string, patch: Partial<MemoryEntry>) => {
		setMemories((current) => current.map((memory) => (memory.id === id ? { ...memory, ...patch } : memory)));
	}, []);

	const handleEdit = useCallback(
		async (id: string, text: string) => {
			const memory = memoryByID.get(id);
			if (!memory) return;
			// The row shows the title when there is one, so that is what an edit changes.
			const patch: Partial<MemoryEntry> = memory.title?.trim() ? { title: text } : { content: text };
			patchLocal(id, patch);
			try {
				const saved = await memoryApi.update(id, patch);
				patchLocal(id, saved);
				toast.success("Memory updated");
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Failed to update Memory");
				void loadMemories();
			}
		},
		[loadMemories, memoryByID, patchLocal],
	);

	const handlePin = useCallback(
		async (id: string, pinned: boolean) => {
			const memory = memoryByID.get(id);
			if (!memory) return;
			const others = (memory.tags || []).filter((tag) => tag !== PIN_TAG);
			const tags = pinned ? [...others, PIN_TAG] : others;
			patchLocal(id, { tags });
			try {
				await memoryApi.update(id, { tags });
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Failed to pin Memory");
				void loadMemories();
			}
		},
		[loadMemories, memoryByID, patchLocal],
	);

	// Runs after the block's undo window has passed: archive, never delete.
	const handleForget = useCallback(
		async (ids: string[]) => {
			try {
				await memoryApi.bulkAction("archive", ids);
				await loadMemories();
				toast.success(
					`${ids.length === 1 ? "1 Memory" : `${ids.length} Memories`} moved to History.`,
				);
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Failed to archive Memories");
				void loadMemories();
			}
		},
		[loadMemories],
	);

	const [contentSaving, setContentSaving] = useState(false);
	const handleSaveContent = useCallback(
		async (memory: MemoryEntry, content: string) => {
			setContentSaving(true);
			try {
				await memoryApi.update(memory.id, { content });
				await loadMemories();
				toast.success("Memory updated", { description: memory.title || `@memory/${memory.id}` });
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Failed to update Memory");
			} finally {
				setContentSaving(false);
			}
		},
		[loadMemories],
	);

	const historyMeta = useCallback(
		(item: MemoryItem) => {
			const memory = memoryByID.get(item.id);
			if (!memory) return null;
			return (
				<>
					<StatusBadge status={normalizedStatus(memory)} />
					<MemoryMeta memory={memory} />
				</>
			);
		},
		[memoryByID],
	);

	const trustedMeta = useCallback(
		(item: MemoryItem) => {
			const memory = memoryByID.get(item.id);
			return memory ? <MemoryMeta memory={memory} /> : null;
		},
		[memoryByID],
	);

	return (
		<PageShell>
			<FeatureHeader
				className="border-b-0"
				icon={Brain}
				title="Memories"
				status={headerStatus}
				actions={
					<>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setCreateOpen(true)}
							className="h-11 sm:h-8"
						>
							<Plus className="h-4 w-4" />
							New proposal
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={() => void handleRefresh()}
							aria-label="Refresh Memories"
							className="h-11 w-11 sm:h-8 sm:w-8"
						>
							<RefreshCw className="h-4 w-4" />
						</Button>
					</>
				}
			/>

			<div className="shrink-0 px-4 sm:px-6">
				<Tabs value={view} onValueChange={(value) => handleNavigate(value as MemoryView)}>
					<TabsList aria-label="Memory destinations">
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
				{errorMessage && memories.length === 0 ? (
					<PageError
						title="Memories could not load"
						description={errorMessage}
						onRetry={() => void handleRefresh()}
						className="flex-1"
					/>
				) : loading && memories.length === 0 ? (
					<PageLoading label="Loading Memories" className="flex-1" />
				) : (
					<div data-testid={`memory-${view}-destination`} className="flex flex-col gap-4">
						{dataWarning ? (
							<p
								role="status"
								className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
							>
								<CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
								{dataWarning}
							</p>
						) : null}

						{view === "trusted" && memories.length === 0 && inbox.items.length === 0 && !query ? (
							<div className="flex flex-1 items-center justify-center py-10" data-testid="memory-empty">
								<NoTools
									title="No Memories yet"
									description="Memories are facts the next session needs. Agents propose them as they work, and you review them here."
									action={
										<KnButton size="sm" variant="secondary" icon={<Plus />} onClick={() => setCreateOpen(true)}>
											Propose a Memory
										</KnButton>
									}
								/>
							</div>
						) : view === "trusted" ? (
							<AgentMemory
								key="trusted"
								variant={isMobile ? "compact" : "default"}
								title="Trusted"
								hideHeading
								className={listClass}
								emptyText="No trusted Memories yet. Proposals become trusted once you review them."
								items={trustedItems}
								scope={scope}
								onScopeChange={setScope}
								query={query}
								onQueryChange={setQuery}
								scopeLabels={scopeLabels}
								scopeHints={scopeHints}
								match={matchMemory}
								meta={trustedMeta}
								onOpen={handleOpenMemory}
								onEdit={(id, text) => void handleEdit(id, text)}
								onPin={(id, pinned) => void handlePin(id, pinned)}
								onForget={(ids) => void handleForget(ids)}
								onNavigate={navigateTo}
							/>
						) : view === "history" ? (
							<AgentMemory
								key="history"
								variant={isMobile ? "compact" : "default"}
								title="History"
								hideHeading
								className={listClass}
								emptyText="Nothing in History yet."
								items={historyItems}
								scope={scope}
								onScopeChange={setScope}
								query={query}
								onQueryChange={setQuery}
								scopeLabels={scopeLabels}
								scopeHints={scopeHints}
								match={matchMemory}
								meta={historyMeta}
								onOpen={handleOpenMemory}
								onNavigate={navigateTo}
							/>
						) : (
							<ReviewInbox
								available={reviewAvailable}
								total={inbox.items.length}
								memories={reviewMemories}
								itemByID={itemByID}
								counts={scopeCountsOf(inbox.items.map((item) => item.memory))}
								scope={scope}
								onScopeChange={setScope}
								query={query}
								onQueryChange={setQuery}
								selectedIDs={selectedIDs}
								onSelect={handleSelect}
								onOpen={handleOpenMemory}
								bulkBar={
									selectedIDs.size > 0 ? (
										<BulkActionBar
											selectedCount={selectedIDs.size}
											canVerify={canVerifySelected}
											canReject={canRejectSelected}
											onAction={setBulkAction}
											onClear={() => setSelectedIDs(new Set())}
										/>
									) : null
								}
							/>
						)}
					</div>
				)}
			</PageContent>

			<Sheet open={selectedMemory !== null} onOpenChange={(open) => !open && handleCloseMemory()}>
				<SheetContent
					side="right"
					hideCloseButton
					className="flex h-dvh w-full flex-col gap-0 p-0 max-sm:border-l-0 sm:max-w-3xl xl:max-w-[60rem]"
					onCloseAutoFocus={(event) => event.preventDefault()}
					data-testid="memory-focus-dialog"
				>
					<SheetTitle className="sr-only">{selectedMemory?.title || "Memory detail"}</SheetTitle>
					<SheetDescription className="sr-only">
						{view === "review" ? "Review a persisted Memory." : "Read Memory details and provenance."}
					</SheetDescription>
					{selectedMemory ? (
						<MemoryDetail
							memory={selectedMemory}
							mode={
								view === "review" && selectedReviewItem
									? "review"
									: normalizedStatus(selectedMemory) === "active"
										? "trusted"
										: historyStatuses.has(normalizedStatus(selectedMemory))
											? "history"
											: "trusted"
							}
							reviewItem={view === "review" ? selectedReviewItem : null}
							uses={uses ? (uses.get(selectedMemory.id) ?? []) : undefined}
							busy={actionBusy}
							saving={contentSaving}
							onClose={handleCloseMemory}
							onAction={handleReviewAction}
							onSaveContent={(memory, content) => void handleSaveContent(memory, content)}
						/>
					) : null}
				</SheetContent>
			</Sheet>

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
		</PageShell>
	);
}

/**
 * Review Inbox: the triage the agent-memory block does not cover (selection, bulk
 * outcomes, review state). Drawn as the same card as the block so the three tabs read
 * as one surface: header with count, search and scope, then divided rows.
 */
function ReviewInbox({
	available,
	total,
	memories,
	itemByID,
	counts,
	scope,
	onScopeChange,
	query,
	onQueryChange,
	selectedIDs,
	onSelect,
	onOpen,
	bulkBar,
}: {
	available: boolean;
	total: number;
	memories: MemoryEntry[];
	itemByID: Map<string, MemoryReviewItem>;
	counts: Record<ScopeFilter, number>;
	scope: ScopeFilter;
	onScopeChange: (scope: ScopeFilter) => void;
	query: string;
	onQueryChange: (query: string) => void;
	selectedIDs: Set<string>;
	onSelect: (id: string, checked: boolean) => void;
	onOpen: (id: string) => void;
	bulkBar: ReactNode;
}) {
	const visibleIDs = memories.map((memory) => memory.id);
	const selectedVisible = visibleIDs.filter((id) => selectedIDs.has(id)).length;
	return (
		<section
			aria-labelledby="memory-review-heading"
			className={cn("flex flex-col", listClass)}
		>
			<header className="flex flex-col gap-3 border-b px-4 py-3.5 sm:px-5">
				<h3 id="memory-review-heading" className="sr-only">
					Review Inbox
				</h3>
				<div className="flex flex-wrap items-center gap-2">
					<Input
						type="search"
						size="sm"
						value={query}
						onChange={(event) => onQueryChange(event.target.value)}
						placeholder="Search proposals"
						aria-label="Search proposals"
						icon={<Search className="h-4 w-4" />}
						className="min-w-[180px] flex-1 sm:max-w-[260px]"
					/>
					<SegmentedControl
						aria-label="Scope"
						size="sm"
						value={scope}
						onValueChange={(value) => onScopeChange(value as ScopeFilter)}
						options={[
							{ value: "all", label: "All" },
							...(["user", "project", "session"] as MemoryScope[]).map((value) => ({
								value,
								label: `${scopeLabels[value]} ${counts[value]}`,
							})),
						]}
					/>
					<span className="ml-auto hidden text-[12.5px] tabular-nums text-muted-foreground sm:inline">
						{`${total} ${total === 1 ? "proposal" : "proposals"}`}
					</span>
				</div>
				{bulkBar}
			</header>

			{!available ? (
				<EmptyState
					title="Review Inbox is temporarily unavailable"
					description="Trusted and History remain readable. Refresh when review metadata is available again."
				/>
			) : memories.length === 0 ? (
				<p className="px-5 py-12 text-center text-[13px] text-muted-foreground">
					{total === 0
						? "Review Inbox is clear. New proposals, stale recall and source repairs will appear here."
						: query
							? `No proposals match "${query}".`
							: "No proposals in this scope."}
				</p>
			) : (
				<>
					<div className="flex items-center gap-3 border-b px-4 py-2 text-[12px] text-muted-foreground sm:px-5">
						<Checkbox
							size="sm"
							checked={selectedVisible > 0 && selectedVisible === visibleIDs.length}
							indeterminate={selectedVisible > 0 && selectedVisible < visibleIDs.length}
							onChange={(event) => {
								for (const id of visibleIDs) onSelect(id, event.target.checked);
							}}
							aria-label="Select all shown proposals"
						/>
						<span>{selectedVisible > 0 ? `${selectedVisible} of ${visibleIDs.length} selected` : "Select to verify, archive or reject in bulk"}</span>
					</div>
					<ul className="divide-y" aria-label="Proposals" data-testid="memory-list">
						{memories.map((memory) => {
							const reviewItem = itemByID.get(memory.id);
							const state = reviewItem ? reviewState(reviewItem) : null;
							const title = memory.title || "Untitled memory";
							return (
								<li
									key={memory.id}
									className={cn(
										"flex gap-3 px-4 py-3.5 sm:px-5",
										selectedIDs.has(memory.id) && "bg-muted/25",
									)}
									data-testid={`memory-register-item-${memory.id}`}
								>
									<div className="pt-0.5">
										<Checkbox
											size="sm"
											checked={selectedIDs.has(memory.id)}
											onChange={(event) => onSelect(memory.id, event.target.checked)}
											aria-label={`Select ${memory.title || memory.id}`}
										/>
									</div>
									<div className="min-w-0 flex-1">
										<button
											type="button"
											onClick={() => onOpen(memory.id)}
											className="rounded text-left text-[14px] leading-relaxed underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
											data-testid={`memory-row-${memory.id}`}
										>
											{title}
										</button>
										<div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
											<LayerBadge layer={memory.layer} />
											{state ? <ReviewStateBadge state={state} /> : null}
											{reviewItem?.reasons.map((reason) => (
												<Badge key={reason} size="sm" variant="outline">
													{reasonLabels[reason]}
												</Badge>
											))}
											<MemoryMeta memory={memory} />
											<span>{`Updated ${ago(memory.updatedAt)}`}</span>
										</div>
									</div>
								</li>
							);
						})}
					</ul>
				</>
			)}
		</section>
	);
}

/** Lists sit flush on the page like Tasks: no card, rows aligned with the header and tabs. */
const listClass = "-mx-4 w-auto rounded-none border-0 bg-transparent sm:-mx-5";

/** Category, tags (not the pin tag) and the reference, as quiet metadata after the scope badge. */
function MemoryMeta({ memory }: { memory: MemoryEntry }) {
	const tags = (memory.tags || []).filter((tag) => tag !== PIN_TAG);
	return (
		<>
			{memory.category ? <span>{memory.category}</span> : null}
			{tags.slice(0, 3).map((tag) => (
				<span key={tag} className="font-mono text-[11.5px]">
					#{tag}
				</span>
			))}
			{tags.length > 3 ? <span>+{tags.length - 3}</span> : null}
		</>
	);
}

function toMemoryItem(memory: MemoryEntry, uses: Map<string, MemoryUse[]> | null): MemoryItem {
	const source = memory.sources?.[0];
	const memoryUses = uses ? (uses.get(memory.id) ?? []) : undefined;
	return {
		id: memory.id,
		text: memory.title?.trim() || firstLine(memory.content) || "Untitled memory",
		scope: layerScope[memory.layer] ?? "project",
		source: source
			? { id: source, label: sourceLabel(source), href: sourceHref(source) }
			: undefined,
		createdAt: memory.createdAt,
		lastUsedAt: memoryUses?.[0]?.at ?? null,
		confidence: memory.confidence ? confidenceValue[memory.confidence] : undefined,
		pinned: (memory.tags || []).includes(PIN_TAG),
		uses: memoryUses,
	};
}

/** Reads of a memory from the MCP audit log, newest first, keyed by memory id. */
function usesFromAudit(events: AuditEvent[]): Map<string, MemoryUse[]> {
	const byID = new Map<string, MemoryUse[]>();
	const sorted = [...events].sort((a, b) => dateValue(b.timestamp) - dateValue(a.timestamp));
	for (const [index, event] of sorted.entries()) {
		if (event.result !== "success" || event.action !== "get") continue;
		for (const ref of event.entityRefs || []) {
			if (!ref.startsWith("memory:")) continue;
			const id = ref.slice("memory:".length);
			const list = byID.get(id) ?? [];
			list.push({
				id: `${event.timestamp}-${index}`,
				label: event.projectRoot
					? `An agent read it in ${event.projectRoot.split(/[\\/]/).filter(Boolean).pop()}`
					: "An agent read it",
				href: "/audit",
				at: event.timestamp,
			});
			byID.set(id, list);
		}
	}
	return byID;
}

function memoryMatches(memory: MemoryEntry, query: string, reviewItem?: MemoryReviewItem) {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return true;
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
}

function scopeCountsOf(list: MemoryEntry[]): Record<ScopeFilter, number> {
	const counts: Record<ScopeFilter, number> = { all: 0, user: 0, project: 0, session: 0 };
	for (const memory of list) {
		counts.all++;
		counts[layerScope[memory.layer] ?? "project"]++;
	}
	return counts;
}

function firstLine(content?: string) {
	const line = (content || "")
		.split("\n")
		.map((value) => value.replace(/^#+\s*/, "").trim())
		.find(Boolean);
	if (!line) return "";
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function sourceLabel(source: string) {
	return source.length > 48 ? `${source.slice(0, 47)}…` : source;
}

function sourceHref(source: string): string | undefined {
	if (/^https?:\/\//.test(source)) return source;
	const match = source.match(/^@(doc|task|memory|decision)\/(.+?)(?:\{.*\})?$/);
	if (!match) return undefined;
	const kind = match[1];
	const id = match[2] ?? "";
	if (kind === "doc") return `/docs/${id.replace(/\.md$/, "")}`;
	if (kind === "task") return `/tasks/${encodeURIComponent(id)}`;
	if (kind === "memory") return `/memory/${encodeURIComponent(id)}`;
	return `/decisions/${encodeURIComponent(id)}`;
}

const statusTone: Record<MemoryStatus, BadgeTone> = {
	proposed: "info",
	active: "success",
	stale: "warning",
	deprecated: "neutral",
	archived: "neutral",
	rejected: "danger",
	merged: "accent",
};

function StatusBadge({ status }: { status: MemoryStatus }) {
	return (
		<Badge size="sm" variant="outline" tone={statusTone[status]}>
			{statusLabels[status]}
		</Badge>
	);
}

type DetailMode = "trusted" | "review" | "history";

/**
 * A Memory's own page in a side sheet, laid out for reading. The title and one line of trust
 * context come first, then the body in the Docs reader (same typography, code blocks and
 * @doc/@task chips) at a comfortable measure. Everything else (layer, category, confidence,
 * tags, sources, dates, usage) sits out of the reading path: a compact column beside the body on
 * wide sheets, a folded "Details" section under it on phones. Review work follows the body.
 */
function MemoryDetail({
	memory,
	mode,
	reviewItem,
	uses,
	busy,
	saving,
	onClose,
	onAction,
	onSaveContent,
}: {
	memory: MemoryEntry;
	mode: DetailMode;
	reviewItem: MemoryReviewItem | null;
	uses?: MemoryUse[];
	busy: boolean;
	saving: boolean;
	onClose: () => void;
	onAction: (memory: MemoryEntry, action: ReviewAction) => Promise<boolean>;
	onSaveContent: (memory: MemoryEntry, content: string) => void;
}) {
	const isMobile = useIsMobile();
	const scrollRef = useRef<HTMLDivElement>(null);
	const [sourceText, setSourceText] = useState("");
	const [action, setAction] = useState<ReviewAction | null>(null);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const status = normalizedStatus(memory);
	const reference = `@memory/${memory.id}`;
	const title = memory.title || "Untitled memory";
	const state = reviewItem ? reviewState(reviewItem) : null;
	const hasSourceIssue = reviewItem?.reasons.some((reason) => sourceReasons.has(reason)) ?? false;
	const shouldRecommendSources =
		reviewItem?.reasons.some((reason) => reason === "missing_source" || reason === "source_missing") ?? false;
	const canVerify = mode === "review" && !hasSourceIssue && (status === "proposed" || status === "stale");
	const canReject = mode === "review" && status === "proposed";
	const parsedSources = parseSourceInput(sourceText);
	const destination = destinations.find((item) => item.id === mode) ?? destinations[0]!;

	useEffect(() => {
		setSourceText("");
		setAction(null);
		setDetailsOpen(false);
		setEditing(false);
		scrollRef.current?.scrollTo({ top: 0 });
	}, [memory.id]);

	const confirmAction = async () => {
		if (!action) return;
		const succeeded = await onAction(memory, action);
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

	// In-app links (breadcrumbs, sources, links in the body) navigate without a reload and close the sheet.
	const handleLinkClick = (event: React.MouseEvent) => {
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
		const href = (event.target as HTMLElement).closest("a")?.getAttribute("href");
		if (!href || !href.startsWith("/")) return;
		event.preventDefault();
		go(href);
	};

	const statusBadge =
		mode === "review" && state
			? { label: reviewStateLabels[state], tone: reviewStateTone[state] }
			: mode === "trusted"
				? { label: "Trusted", tone: "success" as BadgeTone }
				: { label: statusLabels[status], tone: statusTone[status] };

	const context =
		mode === "review" && state
			? reviewStateDescription(state)
			: mode === "trusted"
				? "Available to default retrieval. Agents recall it without asking."
				: "Historical record. Kept for provenance; agents do not recall it by default.";

	const moreActions: PageHeaderAction[] = [
		{ id: "copy-ref", label: "Copy reference", icon: <AtSign />, onSelect: copy(reference, "Reference copied") },
		{
			id: "copy-link",
			label: "Copy link",
			icon: <Link2 />,
			onSelect: copy(`${window.location.origin}/memory/${encodeURIComponent(memory.id)}`, "Link copied"),
		},
	];

	// Phones keep the title wide: Edit moves into the overflow menu, as in the task detail.
	const editAction: PageHeaderAction | undefined =
		mode !== "history" && !editing && (memory.content || "").trim()
			? { id: "edit", label: "Edit", icon: <Pencil />, onSelect: () => setEditing(true) }
			: undefined;

	const details = <MemoryDetails memory={memory} uses={uses} onOpenSource={go} />;
	const lifecycle =
		mode === "history" ? null : (
			<div className="flex flex-col gap-2">
				<span className="text-[12px] font-medium text-muted-foreground">Lifecycle</span>
				{mode === "trusted" ? (
					<>
						<p className="text-[12.5px] leading-5 text-muted-foreground">
							Stop default retrieval and move it to History. Content and provenance are kept.
						</p>
						<ActionButton
							label="Remove from Trusted"
							Icon={Archive}
							fullWidth
							disabled={busy}
							onClick={() => setAction({ kind: "archive" })}
						/>
					</>
				) : (
					<>
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
					</>
				)}
			</div>
		);

	return (
		<div
			className="flex h-full min-h-0 flex-col"
			onClick={handleLinkClick}
			data-testid={mode === "review" ? "memory-review-detail" : "memory-readonly-detail"}
		>
			{/* Stays put while the body scrolls, so Close is always one tap away (phones have no Escape). */}
			<div className="flex h-12 flex-none items-center gap-3 px-3 pt-[env(safe-area-inset-top)] sm:h-14 sm:px-6">
				<Breadcrumb
					items={[
						{ label: "Memories", href: "/memory" },
						{ label: destination.label, href: destination.path },
						{ label: reference },
					]}
					size="sm"
					separator="slash"
					aria-label={`Breadcrumb: memory ${memory.id}`}
					className="min-w-0 flex-1"
				/>
				<KnButton
					variant="ghost"
					icon={<X />}
					onClick={onClose}
					aria-label="Close Memory detail"
					title="Close"
					className="text-muted-foreground"
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
					title={title}
					titleText={title}
					status={statusBadge}
					description={context}
					actions={editAction && !isMobile ? [editAction] : undefined}
					moreActions={editAction && isMobile ? [editAction, ...moreActions] : moreActions}
					scrollContainer={scrollRef}
				>
					<div className="@container/detail">
						<div className="grid grid-cols-1 gap-x-12 gap-y-8 pt-5 @[820px]/detail:grid-cols-[minmax(0,1fr)_15rem]">
							<div className="flex min-w-0 flex-col gap-10">
								<MemoryReader
									content={memory.content || ""}
									editable={mode !== "history"}
									editing={editing}
									onEditingChange={setEditing}
									saving={saving}
									onSave={(next) => onSaveContent(memory, next)}
									onOpenDoc={(path) => go(`/docs/${path}`)}
									onOpenTask={(id) => go(`/tasks/${id}`)}
								/>

								{mode === "review" && reviewItem ? (
									<DetailSection title="Why this needs review">
										<div className="flex flex-wrap gap-1.5">
											{reviewItem.reasons.map((reason) => (
												<ReasonPill key={reason} reason={reason} />
											))}
										</div>
										{reviewItem.issues?.length ? (
											<ul className="flex flex-col gap-2 rounded-xl bg-[color-mix(in_srgb,var(--kn-warning,#d97706)_8%,transparent)] px-3 py-2.5 text-[13.5px] text-amber-800 dark:text-amber-300">
												{reviewItem.issues.map((issue) => (
													<li key={`${issue.code}-${issue.source || issue.message}`} className="flex gap-2">
														<CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
														<span className="min-w-0 break-words">{issue.message}</span>
													</li>
												))}
											</ul>
										) : null}
									</DetailSection>
								) : null}

								{hasSourceIssue ? (
									<div data-testid="memory-source-panel">
										<DetailSection title="Repair evidence">
											<p className="max-w-[68ch] text-[13.5px] leading-6 text-muted-foreground">
												Add a readable source, or apply a verified replacement below. The Memory is re-evaluated after saving.
											</p>
											{shouldRecommendSources ? (
												<SuggestedSources memory={memory} value={sourceText} onChange={setSourceText} />
											) : null}
											<div className="mt-3">
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
											{reviewItem?.repairSources?.length ? (
												<div className="mt-4 divide-y rounded-xl border px-3">
													{reviewItem.repairSources.map((repair) => (
														<SourceRepairRow
															key={`${repair.source}-${repair.replacement}`}
															repair={repair}
															onReview={() =>
																setAction({ kind: "repair_source", source: repair.source, replacement: repair.replacement })
															}
														/>
													))}
												</div>
											) : null}
										</DetailSection>
									</div>
								) : null}

								{mode === "review" && reviewItem?.matches?.length ? (
									<div data-testid="memory-duplicate-panel">
										<DetailSection title="Similar trusted Memories" count={reviewItem.matches.length}>
											<p className="max-w-[68ch] text-[13.5px] leading-6 text-muted-foreground">
												Merge this proposal into an existing trusted Memory, or keep it separate by explicitly activating it.
											</p>
											<ul className="divide-y rounded-xl border">
												{reviewItem.matches.map((match) => (
													<li key={match.id} className="flex flex-wrap items-start justify-between gap-3 px-3 py-3">
														<div className="min-w-0 flex-1">
															<p className="truncate text-[13.5px] font-medium">{match.title || match.id}</p>
															<p className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">
																@memory/{match.id} · {Math.round(match.score * 100)}% similar
															</p>
															{match.snippet ? (
																<p className="mt-1.5 line-clamp-2 max-w-[56ch] text-[13px] text-muted-foreground">{match.snippet}</p>
															) : null}
														</div>
														<ActionButton
															label="Review merge"
															Icon={GitMerge}
															disabled={busy}
															onClick={() =>
																setAction({ kind: "merge_existing", targetID: match.id, targetTitle: match.title || match.id })
															}
														/>
													</li>
												))}
											</ul>
										</DetailSection>
									</div>
								) : null}

								{canVerify ? (
									<DetailSection title={status === "stale" ? "Re-verify this Memory" : "Keep as separate trusted recall"}>
										<div className="flex flex-col items-start gap-3 rounded-xl border px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
											<p className="max-w-[52ch] text-[13.5px] leading-6 text-muted-foreground">
												This makes the Memory active and available to default retrieval.
											</p>
											<ActionButton
												label={status === "stale" ? "Review re-verification" : "Review activation"}
												Icon={CheckCircle2}
												primary
												disabled={busy}
												onClick={() => setAction({ kind: "verify" })}
											/>
										</div>
									</DetailSection>
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
												{scopeLabels[layerScope[memory.layer] ?? "project"]}
												{memory.category ? ` · ${memory.category}` : ""}
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
											<div className="pt-3">{details}</div>
										</Fold>
									</div>
								) : (
									details
								)}
								{lifecycle}
							</aside>
						</div>
					</div>
				</PageHeader>
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

/**
 * The memory body in the Docs reader: same typography, code blocks and @doc/@task chips, at a
 * reading measure of about 68 characters. Edit (in the page header) swaps in the markdown editor.
 */
function MemoryReader({
	content,
	editable,
	editing,
	onEditingChange: setEditing,
	saving,
	onSave,
	onOpenDoc,
	onOpenTask,
}: {
	content: string;
	editable: boolean;
	editing: boolean;
	onEditingChange: (editing: boolean) => void;
	saving: boolean;
	onSave: (next: string) => void;
	onOpenDoc: (path: string) => void;
	onOpenTask: (id: string) => void;
}) {
	const [draft, setDraft] = useState(content);
	useEffect(() => {
		if (!editing) setDraft(content);
	}, [content, editing]);
	const save = () => {
		if (draft !== content) onSave(draft);
		setEditing(false);
	};
	const cancel = () => {
		setDraft(content);
		setEditing(false);
	};

	if (editing) {
		return (
			<section
				aria-label="Edit content"
				className="flex flex-col gap-2"
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						cancel();
					}
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						save();
					}
				}}
			>
				<MDEditor markdown={draft} onChange={setDraft} placeholder="Write durable recall in markdown" readOnly={saving} height={320} />
				<div className="flex items-center gap-2">
					<KnButton size="sm" onClick={save} disabled={saving}>
						Save
					</KnButton>
					<KnButton size="sm" variant="ghost" onClick={cancel}>
						Cancel
					</KnButton>
					<span className="ml-auto hidden text-[12px] text-muted-foreground sm:inline">Ctrl+Enter to save, Esc to cancel</span>
				</div>
			</section>
		);
	}

	if (!content.trim()) {
		return editable ? (
			<button
				type="button"
				onClick={() => setEditing(true)}
				className={cn(
					"rounded-lg border border-dashed border-[color-mix(in_srgb,var(--foreground)_14%,transparent)] px-3 py-3 text-left text-[13.5px] text-muted-foreground transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:border-[color-mix(in_srgb,var(--foreground)_24%,transparent)] hover:text-foreground",
					focusRing,
				)}
			>
				No content yet. Click to write what agents should recall.
			</button>
		) : (
			<p className="text-[14px] text-muted-foreground">No content.</p>
		);
	}

	return (
		<section aria-label="Content">
			<div className="prose-neutral max-w-[68ch] dark:prose-invert [&_.md-render-wrapper>:first-child]:mt-0! [&_.md-render-wrapper>:last-child]:mb-0!">
				<MDRenderWithHighlight
					content={readableMarkdown(content)}
					lineHighlight={null}
					onDocLinkClick={onOpenDoc}
					onTaskLinkClick={onOpenTask}
				/>
			</div>
		</section>
	);
}

/** Compact facts beside the body: one row per fact, long values truncate (full value on hover). */
function MemoryDetails({
	memory,
	uses,
	onOpenSource,
}: {
	memory: MemoryEntry;
	uses?: MemoryUse[];
	onOpenSource: (path: string) => void;
}) {
	const tags = (memory.tags || []).filter((tag) => tag !== PIN_TAG);
	const pinned = (memory.tags || []).includes(PIN_TAG);
	const scope = layerScope[memory.layer] ?? "project";
	const sources = memory.sources || [];
	return (
		<div className="flex flex-col gap-5 text-[13px]">
			<dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5">
				<Fact label="Layer">
					<span className="flex flex-wrap items-center gap-1.5">
						<LayerBadge layer={memory.layer} />
						{pinned ? (
							<Badge size="sm" variant="outline">
								Pinned
							</Badge>
						) : null}
					</span>
				</Fact>
				{normalizedStatus(memory) !== "active" ? (
					<Fact label="Status">
						<StatusBadge status={normalizedStatus(memory)} />
					</Fact>
				) : null}
				<Fact label="Category">{memory.category || "Uncategorized"}</Fact>
				<Fact label="Confidence">
					<span className="capitalize">{memory.confidence || "Not set"}</span>
				</Fact>
				<Fact label="Updated" title={formatDate(memory.updatedAt)}>
					{memory.updatedAt ? ago(memory.updatedAt) : "Not set"}
				</Fact>
				<Fact label="Created" title={formatDate(memory.createdAt)}>
					{memory.createdAt ? ago(memory.createdAt) : "Not set"}
				</Fact>
				<Fact label="Verified">{formatDate(memory.lastVerified)}</Fact>
				{memory.ttlDays ? <Fact label="Re-verify">{`Every ${memory.ttlDays} days`}</Fact> : null}
			</dl>
			<p className="sr-only">{scopeHints[scope]}</p>

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
						{sources.map((source) => {
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
							const label = <span className="min-w-0 truncate font-mono text-[12px]">{source}</span>;
							return (
								<li key={source} className="min-w-0">
									{path ? (
										<button
											type="button"
											title={source}
											onClick={() => onOpenSource(path)}
											className={cn(
												"-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-muted-foreground transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] hover:text-foreground",
												focusRing,
											)}
										>
											<Icon aria-hidden className="h-3.5 w-3.5 flex-none" />
											{label}
										</button>
									) : ref.kind === "url" ? (
										<a
											href={ref.href}
											target="_blank"
											rel="noreferrer"
											title={source}
											className={cn("-mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-muted-foreground hover:text-foreground", focusRing)}
										>
											<Icon aria-hidden className="h-3.5 w-3.5 flex-none" />
											{label}
										</a>
									) : (
										<span title={source} className="flex min-w-0 items-center gap-2 py-1 text-muted-foreground">
											<Icon aria-hidden className="h-3.5 w-3.5 flex-none" />
											{label}
										</span>
									)}
								</li>
							);
						})}
					</ul>
				)}
			</FactGroup>

			{memory.mergedInto ? (
				<FactGroup label="Merged into">
					<a
						href={`/memory/${encodeURIComponent(memory.mergedInto)}`}
						className={cn("block truncate font-mono text-[12px] text-muted-foreground hover:text-foreground", focusRing)}
					>
						@memory/{memory.mergedInto}
					</a>
				</FactGroup>
			) : null}

			{uses ? (
				<FactGroup label={uses.length === 0 ? "Recent use" : `Recent use · ${uses.length}`}>
					{uses.length === 0 ? (
						<span className="text-muted-foreground">No agent has read it yet.</span>
					) : (
						<ul className="flex flex-col">
							{uses.slice(0, 4).map((use) => (
								<li key={use.id} className="flex items-baseline justify-between gap-3 py-0.5">
									<span className="min-w-0 truncate">{use.label}</span>
									<span className="flex-none text-[12px] text-muted-foreground">{ago(use.at)}</span>
								</li>
							))}
						</ul>
					)}
				</FactGroup>
			) : null}
		</div>
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

/**
 * Plain text reads as written: when a memory has no markdown, single line breaks stay line breaks
 * (markdown would join them into one paragraph). Markdown is left alone.
 */
function readableMarkdown(content: string) {
	const looksLikeMarkdown = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>|```|\|)|`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/.test(content);
	if (looksLikeMarkdown) return content;
	return content.replace(/\r\n/g, "\n").replace(/([^\n])\n(?!\n)/g, "$1  \n");
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
					<p className="mt-1 text-xs leading-5 text-muted-foreground">
						Nearby current docs and tasks ranked from this Memory’s title and content.
					</p>
				</div>
				{!loading && !error && suggestions.length > 0 ? (
					<span className="text-xs tabular-nums text-muted-foreground">
						{suggestions.length} nearby
					</span>
				) : null}
			</div>

			<div className="mt-3" aria-live="polite">
				{loading ? (
					<div
						className="divide-y border-y"
						aria-label="Loading suggested sources"
					>
						{Array.from({ length: 3 }).map((_, index) => (
							<div key={index} className="flex min-h-16 items-center gap-3 py-3">
								<span className="h-8 w-8 shrink-0 animate-pulse rounded-md bg-muted" />
								<span className="min-w-0 flex-1">
									<span className="block h-4 w-2/5 animate-pulse rounded bg-muted" />
									<span className="mt-2 block h-3 w-3/4 animate-pulse rounded bg-muted" />
								</span>
							</div>
						))}
					</div>
				) : error ? (
					<div className="flex flex-wrap items-center justify-between gap-3 border-y py-3 text-sm">
						<span className="text-muted-foreground">{error}</span>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setReloadKey((current) => current + 1)}
						>
							<RefreshCw className="h-4 w-4" />
							Retry
						</Button>
					</div>
				) : suggestions.length === 0 ? (
					<p className="border-y py-3 text-sm text-muted-foreground">
						No nearby docs or tasks found. Search manually or enter an external source below.
					</p>
				) : (
					<ul className="divide-y border-y">
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
										className="group flex min-h-16 w-full items-start gap-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
									>
										<span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground group-hover:text-foreground">
											<Icon className="h-4 w-4" />
										</span>
										<span className="min-w-0 flex-1">
											<span className="flex flex-wrap items-center gap-2">
												<span className="truncate text-sm font-medium">{suggestion.title}</span>
												<span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
													{suggestion.kind === "doc" ? "Doc" : "Task"}
												</span>
												{suggestion.status ? (
													<span className="text-xs text-muted-foreground">
														{suggestion.status}
													</span>
												) : null}
											</span>
											<span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
												{suggestion.reference}
											</span>
											{suggestion.snippet ? (
												<span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">
													{suggestion.snippet}
												</span>
											) : null}
										</span>
										<span
											className={cn(
												"inline-flex min-w-[72px] shrink-0 items-center justify-end gap-1 pt-1 text-xs font-medium",
												selected
													? "text-emerald-700 dark:text-emerald-400"
													: "text-muted-foreground group-hover:text-foreground",
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
				<p className="break-all font-mono text-xs text-muted-foreground line-through">
					{repair.source}
				</p>
				<p className="mt-1 break-all font-mono text-xs text-foreground">
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
				className="z-[100] w-[min(560px,calc(100vw-2rem))] gap-0 overflow-hidden rounded-xl bg-background p-0 shadow-[0_12px_32px_rgba(0,0,0,0.2)]"
				data-testid="memory-impact-dialog"
			>
				<DialogTitle className="border-b px-5 py-4 text-base">
					Confirm Memory outcome
				</DialogTitle>
				<DialogDescription className="sr-only">
					Review the selected Memory, target, evidence effect, and resulting lifecycle before confirming.
				</DialogDescription>
				{impact ? (
					<div className="px-5 py-5">
						<dl className="divide-y border-y text-sm">
							<ImpactRow label="Memory" value={`${memory.title || "Untitled memory"} · @memory/${memory.id}`} />
							{impact.target ? <ImpactRow label="Target" value={impact.target} /> : null}
							<ImpactRow label="Evidence outcome" value={impact.evidence} />
							<ImpactRow label="Resulting lifecycle" value={impact.lifecycle} />
						</dl>
					</div>
				) : null}
				<div className="flex flex-col-reverse gap-2 border-t px-5 py-4 sm:flex-row sm:justify-end">
					<Button
						type="button"
						variant="ghost"
						onClick={onCancel}
						disabled={busy}
						className="min-h-11 sm:min-h-10"
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="default"
						onClick={onConfirm}
						disabled={busy}
						className="min-h-11 sm:min-h-10"
					>
						{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
						Confirm outcome
					</Button>
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
			className="mb-4 flex min-h-12 flex-wrap items-center justify-between gap-3 border-y bg-card px-3 py-2"
			data-testid="memory-bulk-toolbar"
		>
			<div className="flex items-center gap-3">
				<span className="text-sm font-medium">{selectedCount} selected</span>
				<button
					type="button"
					onClick={onClear}
					className="text-sm text-muted-foreground hover:text-foreground"
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
				className="z-[100] w-[min(520px,calc(100vw-2rem))] gap-0 overflow-hidden rounded-xl bg-background p-0 shadow-[0_12px_32px_rgba(0,0,0,0.2)]"
			>
				<DialogTitle className="border-b px-5 py-4 text-base">
					Confirm bulk outcome
				</DialogTitle>
				<DialogDescription className="px-5 py-5 text-sm leading-6 text-muted-foreground">
					{action ? `${bulkActionLabel(action)} will update ${count} selected Memories.` : ""}
				</DialogDescription>
				<div className="flex flex-col-reverse gap-2 border-t px-5 py-4 sm:flex-row sm:justify-end">
					<Button
						type="button"
						variant="ghost"
						onClick={onCancel}
						disabled={busy}
						className="min-h-11 sm:min-h-10"
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="default"
						onClick={onConfirm}
						disabled={busy}
						className="min-h-11 sm:min-h-10"
					>
						{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
						Confirm bulk action
					</Button>
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
				className="left-0 top-0 flex h-[100dvh] max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 shadow-none sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[calc(100dvh-3rem)] sm:w-[min(900px,calc(100vw-3rem))] sm:max-w-[900px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:shadow-[0_12px_32px_rgba(0,0,0,0.16)]"
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
							<p className="mt-1 max-w-[65ch] text-sm leading-6 text-muted-foreground">
								Every manual Memory begins as proposed and remains outside trusted retrieval until reviewed.
							</p>
						</div>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={resetAndClose}
							aria-label="Close Memory proposal"
							className="h-11 w-11 shrink-0 sm:h-9 sm:w-9"
						>
							<X className="h-4 w-4" />
						</Button>
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
								className="min-h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
							/>
						</FormField>
						<FormField label="Content">
							<textarea
								value={draft.content}
								onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
								placeholder="Write durable recall in markdown"
								rows={8}
								className="w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
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
									className="min-h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
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
									className="min-h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
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
							<p className="border-y border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive">
								{error}
							</p>
						) : null}

						<div className="flex flex-col-reverse gap-2 border-t pt-5 sm:flex-row sm:justify-end">
							<Button
								type="button"
								variant="ghost"
								onClick={resetAndClose}
								className="min-h-11 sm:min-h-9"
							>
								Cancel
							</Button>
							<Button
								type="submit"
								variant="default"
								disabled={!draft.content.trim() || legacyDecisionCategory || submitting}
								className="min-h-11 sm:min-h-9"
							>
								{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
								Save proposal
							</Button>
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
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={onCreateAnyway}
				disabled={busy}
				className="mt-4 min-h-11 border-amber-700/30 text-amber-900 hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-500/10"
			>
				<Plus className="h-4 w-4" />
				Keep separate as proposal
			</Button>
		</section>
	);
}

function StatusPill({ status }: { status: MemoryStatus; trusted?: boolean }) {
	return <StatusBadge status={status} />;
}

const reviewStateTone: Record<MemoryReviewState, BadgeTone> = {
	ready_for_review: "success",
	needs_resolution: "accent",
	needs_reverification: "warning",
	needs_evidence: "warning",
};

function ReviewStateBadge({ state }: { state: MemoryReviewState }) {
	return (
		<Badge size="sm" tone={reviewStateTone[state]}>
			{reviewStateLabels[state]}
		</Badge>
	);
}

const ReviewStatePill = ReviewStateBadge;

function ReasonPill({ reason }: { reason: MemoryReviewReason }) {
	return (
		<Badge size="sm" variant="outline">
			{reasonLabels[reason]}
		</Badge>
	);
}

function ImpactRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="grid gap-1 py-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-4">
			<dt className="text-muted-foreground">{label}</dt>
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
		<Button
			type="button"
			variant={primary ? "default" : "outline"}
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"min-h-11 sm:min-h-10",
				danger && "border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive",
				fullWidth && "w-full",
			)}
		>
			{Icon ? <Icon className="h-4 w-4" /> : null}
			<span className="truncate">{label}</span>
		</Button>
	);
}

function EmptyState({ title, description }: { title: string; description: string }) {
	return (
		<div className="flex min-h-52 flex-col items-center justify-center px-4 py-10 text-center">
			<Brain className="h-6 w-6 text-muted-foreground" />
			<p className="mt-3 text-sm font-medium">{title}</p>
			<p className="mt-1 max-w-[52ch] text-sm leading-6 text-muted-foreground">{description}</p>
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

function LayerBadge({ layer }: { layer: string }) {
	const scope = layerScope[layer] ?? "project";
	return (
		<Badge size="sm" tone={scope === "user" ? "accent" : scope === "project" ? "info" : "neutral"} title={scopeHints[scope]}>
			{scopeLabels[scope]}
		</Badge>
	);
}

function viewFromPath(pathname: string): MemoryView {
	if (pathname.startsWith("/memory/review")) return "review";
	if (pathname.startsWith("/memory/history")) return "history";
	return "trusted";
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
	// Go's zero time (0001-01-01) means "never set".
	if (Number.isNaN(parsed.getTime()) || parsed.getFullYear() < 1971) return "Not set";
	return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
