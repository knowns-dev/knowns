import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
	MemoryReviewRequiredError,
	memoryApi,
	type MemoryBulkAction,
	type MemoryEntry,
	type MemoryItemAction,
	type MemoryReviewInboxResponse,
	type MemoryReviewItem,
	type MemoryReviewMatch,
	type MemoryReviewReason,
	type MemoryReviewResolution,
	type MemoryReviewResult,
	type MemorySourceRepair,
	type MemoryStatus,
	type PersistentMemoryLayer,
} from "@/ui/api/client";
import {
	Archive,
	CheckCircle2,
	CircleAlert,
	Clock3,
	FileQuestion,
	GitMerge,
	Link2,
	Loader2,
	Plus,
	RefreshCw,
	ShieldCheck,
	SquareCheckBig,
	Wrench,
	XCircle,
	type LucideIcon,
} from "lucide-react";
import MDRender from "@/ui/components/editor/MDRender";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/ui/components/ui/dialog";
import { cn } from "@/ui/lib/utils";

type MemoryView = "review" | "healthy" | "archived" | "all";

type CreateDraft = {
	title: string;
	content: string;
	layer: PersistentMemoryLayer;
	category: string;
	status: MemoryStatus;
	sources: string[];
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

const reviewGroups: Array<{
	id: MemoryReviewReason;
	label: string;
	shortLabel: string;
	description: string;
	Icon: LucideIcon;
}> = [
	{
		id: "proposed",
		label: "Proposed",
		shortLabel: "Proposed",
		description: "New memories waiting to become trusted.",
		Icon: SquareCheckBig,
	},
	{
		id: "duplicate_review",
		label: "Duplicate review",
		shortLabel: "Duplicate",
		description: "Candidates with similar active memories.",
		Icon: GitMerge,
	},
	{
		id: "stale_ttl",
		label: "Stale TTL",
		shortLabel: "Stale",
		description: "Entries that need re-verification.",
		Icon: Clock3,
	},
	{
		id: "missing_source",
		label: "Missing source",
		shortLabel: "No source",
		description: "Trusted status is weaker until a source is linked.",
		Icon: Link2,
	},
	{
		id: "source_missing",
		label: "Source missing",
		shortLabel: "Broken",
		description: "A referenced source cannot be resolved.",
		Icon: FileQuestion,
	},
	{
		id: "source_decision_superseded",
		label: "Source decision superseded",
		shortLabel: "Superseded",
		description: "A Decision source has newer guidance.",
		Icon: CircleAlert,
	},
];

const viewTabs: Array<{ id: MemoryView; label: string }> = [
	{ id: "review", label: "Review Inbox" },
	{ id: "healthy", label: "Healthy" },
	{ id: "archived", label: "Archived" },
	{ id: "all", label: "All" },
];

const statusLabels: Record<string, string> = {
	proposed: "Proposed",
	active: "Active",
	stale: "Stale",
	deprecated: "Deprecated",
	archived: "Archived",
	rejected: "Rejected",
	merged: "Merged",
};

const resolutionLabels: Record<MemoryReviewResolution, string> = {
	update_existing: "Update existing",
	archive_existing_create_new: "Archive and replace",
	create_proposed: "Create proposed",
	reject_new: "Reject",
	merge_existing: "Merge",
};

export default function MemoryPage() {
	const [inbox, setInbox] = useState<MemoryReviewInboxResponse>(emptyInbox);
	const [loading, setLoading] = useState(true);
	const [view, setView] = useState<MemoryView>("review");
	const [selectedID, setSelectedID] = useState<string | null>(null);
	const [selectedIDs, setSelectedIDs] = useState<Set<string>>(() => new Set());
	const [createOpen, setCreateOpen] = useState(false);
	const [errorMessage, setErrorMessage] = useState("");

	const fetchReview = useCallback(async () => {
		setErrorMessage("");
		const data = await memoryApi.reviewInbox();
		setInbox(data);
		setSelectedIDs(new Set());
		setSelectedID((current) => {
			if (current && data.memories.some((memory) => memory.id === current)) {
				return current;
			}
			return null;
		});
	}, []);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		fetchReview()
			.catch((err: unknown) => {
				if (!cancelled) {
					setErrorMessage(err instanceof Error ? err.message : "Failed to load memory review");
				}
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [fetchReview]);

	const itemByID = useMemo(() => {
		const byID = new Map<string, MemoryReviewItem>();
		for (const item of inbox.items) {
			byID.set(item.memory.id, item);
		}
		return byID;
	}, [inbox.items]);

	const groupedItems = useMemo(() => {
		const byReason = new Map<MemoryReviewReason, MemoryReviewItem[]>();
		for (const group of reviewGroups) {
			byReason.set(group.id, []);
		}
		for (const item of inbox.items) {
			for (const reason of item.reasons) {
				byReason.get(reason)?.push(item);
			}
		}
		return byReason;
	}, [inbox.items]);

	const healthyMemories = useMemo(
		() =>
			inbox.memories.filter((memory) => {
				const status = memory.status || "active";
				return status === "active" && !itemByID.has(memory.id);
			}),
		[inbox.memories, itemByID],
	);

	const archivedMemories = useMemo(
		() => inbox.memories.filter((memory) => memory.status === "archived"),
		[inbox.memories],
	);

	const visibleMemories = useMemo(() => {
		switch (view) {
			case "healthy":
				return healthyMemories;
			case "archived":
				return archivedMemories;
			case "all":
				return inbox.memories;
			default:
				return [];
		}
	}, [archivedMemories, healthyMemories, inbox.memories, view]);

	const selectedMemory = useMemo(
		() => inbox.memories.find((memory) => memory.id === selectedID) ?? null,
		[inbox.memories, selectedID],
	);
	const selectedReviewItem = selectedMemory ? itemByID.get(selectedMemory.id) ?? null : null;
	const selectedMemories = useMemo(
		() => inbox.memories.filter((memory) => selectedIDs.has(memory.id)),
		[inbox.memories, selectedIDs],
	);
	const canRejectSelected = selectedMemories.length > 0 && selectedMemories.every((memory) => memory.status === "proposed");

	const refreshAfterAction = useCallback(async () => {
		try {
			await fetchReview();
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : "Failed to refresh memory review");
		}
	}, [fetchReview]);

	const handleSelect = useCallback((id: string, checked: boolean) => {
		setSelectedIDs((current) => {
			const next = new Set(current);
			if (checked) {
				next.add(id);
			} else {
				next.delete(id);
			}
			return next;
		});
	}, []);

	const handleBulk = useCallback(
		async (action: MemoryBulkAction) => {
			if (selectedIDs.size === 0) return;
			try {
				await memoryApi.bulkAction(action, Array.from(selectedIDs));
				await refreshAfterAction();
			} catch (err) {
				setErrorMessage(err instanceof Error ? err.message : "Bulk action failed");
			}
		},
		[refreshAfterAction, selectedIDs],
	);

	const handleItemAction = useCallback(
		async (id: string, action: MemoryItemAction, payload: Partial<Parameters<typeof memoryApi.action>[1]> = {}) => {
			try {
				await memoryApi.action(id, { action, ...payload });
				await refreshAfterAction();
			} catch (err) {
				setErrorMessage(err instanceof Error ? err.message : "Memory action failed");
			}
		},
		[refreshAfterAction],
	);

	const handleResolve = useCallback(
		async (memory: MemoryEntry, resolution: MemoryReviewResolution, targetID?: string) => {
			try {
				const includeSourceID = resolution === "merge_existing";
				await memoryApi.resolveReview({
					resolution,
					targetId: targetID,
					id: includeSourceID ? memory.id : undefined,
					title: memory.title,
					content: memory.content,
					layer: memory.layer === "working" ? "project" : memory.layer,
					category: memory.category,
					tags: memory.tags,
					sources: memory.sources,
					confidence: memory.confidence,
					ttlDays: memory.ttlDays,
					status: resolution === "create_proposed" ? "proposed" : undefined,
				});
				await refreshAfterAction();
			} catch (err) {
				setErrorMessage(err instanceof Error ? err.message : "Review resolution failed");
			}
		},
		[refreshAfterAction],
	);

	if (loading) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="h-5 w-5 animate-spin" />
					<span>Loading memory review...</span>
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
							<h1 className="text-2xl font-semibold tracking-tight">Memory review</h1>
							<span className="rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground">
								{inbox.items.length} needs review
							</span>
						</div>
						<p className="mt-1 text-sm text-muted-foreground">
							Review Inbox first. Healthy, archived, and all memories stay one tab away.
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							onClick={() => {
								setLoading(true);
								void refreshAfterAction().finally(() => setLoading(false));
							}}
							className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border/60 px-3 text-sm font-medium transition-colors hover:bg-accent"
						>
							<RefreshCw className="h-4 w-4" />
							Refresh
						</button>
						<button
							type="button"
							onClick={() => setCreateOpen(true)}
							className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
						>
							<Plus className="h-4 w-4" />
							New memory
						</button>
					</div>
				</div>
				<div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Memory views">
					{viewTabs.map((tab) => (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={view === tab.id}
							onClick={() => setView(tab.id)}
							className={cn(
								"rounded-lg px-3 py-2 text-sm font-medium transition-colors",
								view === tab.id
									? "bg-foreground text-background"
									: "bg-muted text-muted-foreground hover:text-foreground",
							)}
						>
							{tab.label}
						</button>
					))}
				</div>
			</header>

			{errorMessage && (
				<div className="mx-4 mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive sm:mx-6">
					{errorMessage}
				</div>
			)}

			<main className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:grid-rows-1">
				<section className="min-h-[520px] flex-1 overflow-y-auto px-4 py-4 sm:px-6 lg:min-h-0">
					{view === "review" ? (
						<ReviewInbox
							groupedItems={groupedItems}
							counts={inbox.counts}
							selectedIDs={selectedIDs}
							onSelect={handleSelect}
							onOpen={setSelectedID}
							onBulk={handleBulk}
							canRejectSelected={canRejectSelected}
						/>
					) : (
						<MemoryList
							title={viewTitle(view)}
							memories={visibleMemories}
							itemByID={itemByID}
							selectedID={selectedID}
							onOpen={setSelectedID}
						/>
					)}
				</section>

				<MemoryDetailPanel
					memory={selectedMemory}
					reviewItem={selectedReviewItem}
					onAction={handleItemAction}
					onResolve={handleResolve}
				/>
			</main>

			<CreateMemoryDialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				onCreated={async (created) => {
					setSelectedID(created.id);
					await refreshAfterAction();
				}}
			/>
		</div>
	);
}

function ReviewInbox({
	groupedItems,
	counts,
	selectedIDs,
	onSelect,
	onOpen,
	onBulk,
	canRejectSelected,
}: {
	groupedItems: Map<MemoryReviewReason, MemoryReviewItem[]>;
	counts: Record<MemoryReviewReason, number>;
	selectedIDs: Set<string>;
	onSelect: (id: string, checked: boolean) => void;
	onOpen: (id: string) => void;
	onBulk: (action: MemoryBulkAction) => void;
	canRejectSelected: boolean;
}) {
	const selectedCount = selectedIDs.size;

	return (
		<div className="space-y-4">
			<BulkToolbar
				selectedCount={selectedCount}
				canRejectSelected={canRejectSelected}
				onBulk={onBulk}
			/>
			{reviewGroups.map((group) => {
				const items = groupedItems.get(group.id) || [];
				return (
					<section
						key={group.id}
						className="border-t border-border/60 pt-4"
						data-testid={`memory-review-group-${group.id}`}
					>
						<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
							<div className="flex min-w-0 items-center gap-3">
								<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
									<group.Icon className="h-4 w-4 text-muted-foreground" />
								</div>
								<div className="min-w-0">
									<h2 className="truncate text-sm font-semibold">{group.label}</h2>
									<p className="text-xs text-muted-foreground">{group.description}</p>
								</div>
							</div>
							<span className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
								{counts[group.id] || 0}
							</span>
						</div>
						{items.length === 0 ? (
							<p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-sm text-muted-foreground">
								No memories in this group.
							</p>
						) : (
							<div className="space-y-2">
								{items.map((item) => (
									<MemoryReviewRow
										key={`${group.id}-${item.memory.id}`}
										item={item}
										reason={group.id}
										selected={selectedIDs.has(item.memory.id)}
										onSelect={onSelect}
										onOpen={onOpen}
									/>
								))}
							</div>
						)}
					</section>
				);
			})}
		</div>
	);
}

function BulkToolbar({
	selectedCount,
	canRejectSelected,
	onBulk,
}: {
	selectedCount: number;
	canRejectSelected: boolean;
	onBulk: (action: MemoryBulkAction) => void;
}) {
	const hasSelection = selectedCount > 0;
	return (
		<div
			className="flex min-h-12 flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
			data-testid="memory-bulk-toolbar"
		>
			<p className="text-sm text-muted-foreground">
				{hasSelection ? `${selectedCount} selected` : "Select memories for safe bulk actions"}
			</p>
			<div className="flex flex-wrap gap-2">
				<ActionButton
					label="Verify"
					Icon={CheckCircle2}
					disabled={!hasSelection}
					onClick={() => onBulk("verify")}
				/>
				<ActionButton
					label="Archive"
					Icon={Archive}
					disabled={!hasSelection}
					onClick={() => onBulk("archive")}
				/>
				<ActionButton
					label="Reject proposed"
					Icon={XCircle}
					disabled={!canRejectSelected}
					onClick={() => onBulk("reject_proposed")}
				/>
			</div>
		</div>
	);
}

function MemoryReviewRow({
	item,
	reason,
	selected,
	onSelect,
	onOpen,
}: {
	item: MemoryReviewItem;
	reason: MemoryReviewReason;
	selected: boolean;
	onSelect: (id: string, checked: boolean) => void;
	onOpen: (id: string) => void;
}) {
	const memory = item.memory;
	const preview = memory.content?.replace(/\s+/g, " ").trim();
	const firstMatch = item.matches?.[0];

	return (
		<div
			className="grid min-h-[88px] grid-cols-[36px_minmax(0,1fr)] gap-3 rounded-lg border border-border/60 bg-card px-3 py-3 [contain-intrinsic-size:0_88px] [content-visibility:auto]"
			data-testid={`memory-row-${memory.id}`}
		>
			<label className="flex h-8 w-8 items-center justify-center rounded-md border border-border/60" title="Select memory">
				<input
					type="checkbox"
					checked={selected}
					onChange={(event) => onSelect(memory.id, event.target.checked)}
					className="h-4 w-4 accent-foreground"
					aria-label={`Select ${memory.title || memory.id}`}
				/>
			</label>
			<button
				type="button"
				onClick={() => onOpen(memory.id)}
				className="grid min-w-0 gap-2 text-left"
			>
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<span className="truncate text-sm font-semibold text-foreground">
						{memory.title || "Untitled memory"}
					</span>
					<ReasonPill reason={reason} />
					<StatusPill status={memory.status} />
				</div>
				<p className="line-clamp-2 text-sm text-muted-foreground">{preview || "No content."}</p>
				<div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<span className="font-mono">{memory.id}</span>
					<span>{memory.category || "uncategorized"}</span>
					{firstMatch && <span className="truncate">Nearest: {firstMatch.title || firstMatch.id}</span>}
				</div>
			</button>
		</div>
	);
}

function MemoryList({
	title,
	memories,
	itemByID,
	selectedID,
	onOpen,
}: {
	title: string;
	memories: MemoryEntry[];
	itemByID: Map<string, MemoryReviewItem>;
	selectedID: string | null;
	onOpen: (id: string) => void;
}) {
	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-3">
				<h2 className="text-sm font-semibold">{title}</h2>
				<span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{memories.length}</span>
			</div>
			{memories.length === 0 ? (
				<EmptyState title="No memories here" description="This view is empty for the current project." />
			) : (
				<div className="space-y-2">
					{memories.map((memory) => (
						<MemoryListRow
							key={memory.id}
							memory={memory}
							reviewItem={itemByID.get(memory.id)}
							active={selectedID === memory.id}
							onOpen={onOpen}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function MemoryListRow({
	memory,
	reviewItem,
	active,
	onOpen,
}: {
	memory: MemoryEntry;
	reviewItem?: MemoryReviewItem;
	active: boolean;
	onOpen: (id: string) => void;
}) {
	const preview = memory.content?.replace(/\s+/g, " ").trim();
	return (
		<button
			type="button"
			onClick={() => onOpen(memory.id)}
			className={cn(
				"grid min-h-[82px] w-full gap-2 rounded-lg border px-3 py-3 text-left transition-colors [contain-intrinsic-size:0_82px] [content-visibility:auto]",
				active ? "border-foreground/40 bg-muted/40" : "border-border/60 bg-card hover:bg-accent/40",
			)}
		>
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<span className="truncate text-sm font-semibold">{memory.title || "Untitled memory"}</span>
				<StatusPill status={memory.status} />
				{reviewItem?.reasons[0] && <ReasonPill reason={reviewItem.reasons[0]} />}
			</div>
			<p className="line-clamp-2 text-sm text-muted-foreground">{preview || "No content."}</p>
			<div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
				<span className="font-mono">{memory.id}</span>
				<span>{memory.layer}</span>
				<span>{formatDate(memory.updatedAt)}</span>
			</div>
		</button>
	);
}

function MemoryDetailPanel({
	memory,
	reviewItem,
	onAction,
	onResolve,
}: {
	memory: MemoryEntry | null;
	reviewItem: MemoryReviewItem | null;
	onAction: (id: string, action: MemoryItemAction, payload?: Partial<Parameters<typeof memoryApi.action>[1]>) => void;
	onResolve: (memory: MemoryEntry, resolution: MemoryReviewResolution, targetID?: string) => void;
}) {
	const [sourceText, setSourceText] = useState("");

	useEffect(() => {
		setSourceText("");
	}, [memory?.id]);

	if (!memory) {
		return (
			<aside
				className="border-t border-border/60 p-4 lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-t-0"
				data-testid="memory-detail-panel"
			>
				<EmptyState title="Select a memory" description="Open an inbox row to review details and item-level actions." />
			</aside>
		);
	}

	const matches = reviewItem?.matches || [];
	const repairs = reviewItem?.repairSources || [];
	const sources = memory.sources || [];

	return (
		<aside
			className="min-h-0 border-t border-border/60 bg-muted/10 lg:overflow-y-auto lg:border-l lg:border-t-0"
			data-testid="memory-detail-panel"
		>
			<div className="space-y-5 p-4">
				<div className="space-y-3">
					<div className="flex flex-wrap items-center gap-2">
						<StatusPill status={memory.status} />
						{reviewItem?.reasons.map((reason) => <ReasonPill key={reason} reason={reason} />)}
					</div>
					<div>
						<h2 className="text-lg font-semibold leading-tight">{memory.title || "Untitled memory"}</h2>
						<p className="mt-1 break-all font-mono text-xs text-muted-foreground">{memory.id}</p>
					</div>
				</div>

				<div className="rounded-lg border border-border/60 bg-background p-3">
					{memory.content ? (
						<MDRender markdown={memory.content} className="prose prose-sm max-w-none dark:prose-invert" />
					) : (
						<p className="text-sm text-muted-foreground">No content.</p>
					)}
				</div>

				<DetailSection title="Review context">
					<div className="grid gap-2 text-sm sm:grid-cols-2">
						<MetadataItem label="Layer" value={memory.layer} />
						<MetadataItem label="Category" value={memory.category || "Uncategorized"} />
						<MetadataItem label="Updated" value={formatDate(memory.updatedAt)} />
						<MetadataItem label="Last verified" value={formatDate(memory.lastVerified)} />
						<MetadataItem label="TTL" value={memory.ttlDays ? `${memory.ttlDays} days` : "Not set"} />
						<MetadataItem label="Confidence" value={memory.confidence || "Not set"} />
					</div>
				</DetailSection>

				<DetailSection title="Sources">
					{sources.length === 0 ? (
						<p className="text-sm text-muted-foreground">No source linked.</p>
					) : (
						<div className="space-y-2">
							{sources.map((source) => (
								<div key={source} className="rounded-md border border-border/60 px-2 py-1.5 font-mono text-xs">
									{source}
								</div>
							))}
						</div>
					)}
					<form
						className="mt-3 flex flex-col gap-2 sm:flex-row"
						onSubmit={(event) => {
							event.preventDefault();
							const nextSources = parseSourceInput(sourceText);
							if (nextSources.length === 0) return;
							onAction(memory.id, "link_source", { sources: nextSources });
						}}
					>
						<input
							value={sourceText}
							onChange={(event) => setSourceText(event.target.value)}
							placeholder="@doc/path or @decision/id"
							className="min-h-9 min-w-0 flex-1 rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-primary"
						/>
						<ActionButton label="Link source" Icon={Link2} disabled={!sourceText.trim()} />
					</form>
				</DetailSection>

				{repairs.length > 0 && (
					<DetailSection title="Source repair">
						<div className="space-y-2">
							{repairs.map((repair) => (
								<SourceRepairRow
									key={`${repair.source}-${repair.replacement}`}
									repair={repair}
									onRepair={() =>
										onAction(memory.id, "repair_source", {
											source: repair.source,
											replacement: repair.replacement,
										})
									}
								/>
							))}
						</div>
					</DetailSection>
				)}

				<DetailSection title="Item actions">
					<div className="grid gap-2 sm:grid-cols-2">
						<ActionButton label="Verify" Icon={CheckCircle2} onClick={() => onAction(memory.id, "verify")} />
						<ActionButton label="Archive" Icon={Archive} onClick={() => onAction(memory.id, "archive")} />
						<ActionButton label="Reject" Icon={XCircle} onClick={() => onAction(memory.id, "reject")} />
						<ActionButton
							label="Create proposed"
							Icon={Plus}
							onClick={() => onResolve(memory, "create_proposed")}
						/>
					</div>
				</DetailSection>

				{matches.length > 0 && (
					<DetailSection title="Duplicate candidates">
						<div className="space-y-2">
							{matches.map((match) => (
								<MatchRow
									key={match.id}
									match={match}
									onUpdate={() => onResolve(memory, "update_existing", match.id)}
									onMerge={() => onResolve(memory, "merge_existing", match.id)}
								/>
							))}
						</div>
					</DetailSection>
				)}
			</div>
		</aside>
	);
}

function SourceRepairRow({ repair, onRepair }: { repair: MemorySourceRepair; onRepair: () => void }) {
	return (
		<div className="grid gap-2 rounded-lg border border-border/60 bg-background p-3">
			<div className="min-w-0 text-xs">
				<p className="truncate font-mono text-muted-foreground">{repair.source}</p>
				<p className="truncate font-mono text-foreground">{repair.replacement}</p>
			</div>
			<ActionButton label="Repair source" Icon={Wrench} onClick={onRepair} />
		</div>
	);
}

function MatchRow({
	match,
	onUpdate,
	onMerge,
}: {
	match: MemoryReviewMatch;
	onUpdate: () => void;
	onMerge: () => void;
}) {
	return (
		<div className="grid gap-3 rounded-lg border border-border/60 bg-background p-3">
			<div className="min-w-0">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<p className="truncate text-sm font-medium">{match.title || match.id}</p>
					<span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
						{Math.round(match.score * 100)}%
					</span>
				</div>
				<p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{match.snippet || "No snippet."}</p>
			</div>
			<div className="flex flex-wrap gap-2">
				<ActionButton label={resolutionLabels.update_existing} Icon={ShieldCheck} onClick={onUpdate} />
				<ActionButton label={resolutionLabels.merge_existing} Icon={GitMerge} onClick={onMerge} />
			</div>
		</div>
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
		status: "proposed",
		sources: [],
	});
	const [sourcesText, setSourcesText] = useState("");
	const [review, setReview] = useState<MemoryReviewResult | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!open) {
			setReview(null);
			setError("");
		}
	}, [open]);

	const resetAndClose = useCallback(() => {
		setDraft({ title: "", content: "", layer: "project", category: "", status: "proposed", sources: [] });
		setSourcesText("");
		setReview(null);
		setError("");
		onOpenChange(false);
	}, [onOpenChange]);

	const create = useCallback(
		async (skipReview: boolean) => {
			setSubmitting(true);
			setError("");
			const payload = { ...draft, sources: parseSourceInput(sourcesText), skipReview };
			try {
				const memory = await memoryApi.create(payload);
				await onCreated(memory);
				resetAndClose();
			} catch (err) {
				if (err instanceof MemoryReviewRequiredError) {
					setReview(err.result);
				} else {
					setError(err instanceof Error ? err.message : "Failed to create memory");
				}
			} finally {
				setSubmitting(false);
			}
		},
		[draft, onCreated, resetAndClose, sourcesText],
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[90vh] w-[96vw] max-w-3xl flex-col gap-0 overflow-hidden p-0">
				<DialogHeader className="border-b border-border/60 px-5 py-4 text-left">
					<DialogTitle>New memory</DialogTitle>
					<DialogDescription>Creates a proposed memory unless review requires a decision.</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 overflow-y-auto px-5 py-4">
					<form
						className="space-y-4"
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
								className="min-h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-primary"
							/>
						</FormField>
						<FormField label="Content">
							<textarea
								value={draft.content}
								onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
								placeholder="Write in markdown"
								rows={8}
								className="w-full resize-y rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
							/>
						</FormField>
						<div className="grid gap-4 sm:grid-cols-3">
							<FormField label="Layer">
								<select
									value={draft.layer}
									onChange={(event) =>
										setDraft((current) => ({ ...current, layer: event.target.value as PersistentMemoryLayer }))
									}
									className="min-h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-primary"
								>
									<option value="project">Project</option>
									<option value="global">Global</option>
								</select>
							</FormField>
							<FormField label="Status">
								<select
									value={draft.status}
									onChange={(event) =>
										setDraft((current) => ({ ...current, status: event.target.value as MemoryStatus }))
									}
									className="min-h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-primary"
								>
									<option value="proposed">Proposed</option>
									<option value="active">Active</option>
								</select>
							</FormField>
							<FormField label="Category">
								<input
									value={draft.category}
									onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))}
									placeholder="Optional"
									className="min-h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-primary"
								/>
							</FormField>
						</div>
						<FormField label="Sources">
							<input
								value={sourcesText}
								onChange={(event) => setSourcesText(event.target.value)}
								placeholder="@doc/path, @task/id, or @decision/id"
								className="min-h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-primary"
							/>
						</FormField>

						{review && <DuplicateReviewPanel review={review} onCreateAnyway={() => void create(true)} />}
						{error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

						<div className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-4">
							<button
								type="button"
								onClick={resetAndClose}
								className="min-h-10 rounded-lg px-3 text-sm font-medium text-muted-foreground hover:text-foreground"
							>
								Cancel
							</button>
							<button
								type="submit"
								disabled={!draft.content.trim() || submitting}
								className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
							>
								{submitting && <Loader2 className="h-4 w-4 animate-spin" />}
								Create
							</button>
						</div>
					</form>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function DuplicateReviewPanel({ review, onCreateAnyway }: { review: MemoryReviewResult; onCreateAnyway: () => void }) {
	const matches = review.matches || [];
	return (
		<div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
			<div className="flex items-start gap-2">
				<CircleAlert className="mt-0.5 h-4 w-4 text-amber-600" />
				<div className="min-w-0">
					<p className="text-sm font-medium">Similar memories need review</p>
					<p className="text-sm text-muted-foreground">Choose Create anyway only when this should remain a separate proposed memory.</p>
				</div>
			</div>
			<div className="mt-3 space-y-2">
				{matches.map((match) => (
					<div key={match.id} className="rounded-md border border-border/60 bg-background px-3 py-2">
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-sm font-medium">{match.title || match.id}</span>
							<span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
								{Math.round(match.score * 100)}%
							</span>
						</div>
						<p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{match.snippet || "No snippet."}</p>
					</div>
				))}
			</div>
			<button
				type="button"
				onClick={onCreateAnyway}
				className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-lg border border-amber-500/40 px-3 text-sm font-medium hover:bg-amber-500/10"
			>
				<Plus className="h-4 w-4" />
				Create anyway
			</button>
		</div>
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

function ReasonPill({ reason }: { reason: MemoryReviewReason }) {
	const group = reviewGroups.find((item) => item.id === reason);
	return (
		<span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
			{group?.shortLabel || reason}
		</span>
	);
}

function StatusPill({ status }: { status?: string }) {
	const normalized = status || "active";
	return (
		<span className="inline-flex rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
			{statusLabels[normalized] || normalized}
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
	Icon?: LucideIcon;
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

function viewTitle(view: MemoryView) {
	switch (view) {
		case "healthy":
			return "Healthy memories";
		case "archived":
			return "Archived memories";
		case "all":
			return "All memories";
		default:
			return "Review Inbox";
	}
}

function parseSourceInput(value: string) {
	return value
		.split(/[\n,]+/)
		.map((source) => source.trim())
		.filter(Boolean);
}

function formatDate(value?: string) {
	if (!value) return "Not set";
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return "Not set";
	return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
