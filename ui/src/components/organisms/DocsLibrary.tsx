import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
	BookOpenText,
	ChevronLeft,
	ChevronRight,
	ClipboardCheck,
	Clock3,
	FileText,
	FolderOpen,
	PackageOpen,
	Pin,
	Plus,
	RotateCcw,
	Search,
} from "lucide-react";
import { DocKindBadges } from "../atoms/DocKindBadges";
import {
	DocsLibraryToolbar,
	type DocsFilter,
	type DocsSort,
} from "../molecules/DocsLibraryToolbar";
import { Button } from "../ui/button";
import { FeatureHeader } from "../templates/FeatureHeader";
import { Skeleton } from "../ui/skeleton";
import {
	cn,
	isSpec,
	parseACProgress,
	toDisplayPath,
	type Doc,
} from "../../lib/utils";
import { navigateTo } from "../../lib/navigation";

interface DocsLibraryViewState {
	version: 1;
	folder: string | null;
	query: string;
	filter: DocsFilter;
	sort: DocsSort;
	selectedKey: string | null;
	pinnedPaths: string[];
	recentPaths: string[];
	scrollTop: number;
}

interface FolderEntry {
	type: "folder";
	key: string;
	name: string;
	fullPath: string;
	docCount: number;
	updatedAt: string;
	specProgress?: {
		completed: number;
		total: number;
	};
}

interface DocumentEntry {
	type: "document";
	key: string;
	doc: Doc;
}

type LibraryEntry = FolderEntry | DocumentEntry;

interface DocsLibraryProps {
	docs: Doc[];
	loading: boolean;
	error: string | null;
	initialFolder?: string | null;
	onCreateDoc: (folder: string | null) => void;
	onSelectDoc: (doc: Doc) => void;
	onRetry: () => void;
}

const VIEW_STATE_STORAGE_KEY = "knowns.docs.library";
const MAX_QUICK_ACCESS_ITEMS = 4;

const defaultViewState: DocsLibraryViewState = {
	version: 1,
	folder: null,
	query: "",
	filter: "all",
	sort: "updated-desc",
	selectedKey: null,
	pinnedPaths: [],
	recentPaths: [],
	scrollTop: 0,
};

function normalizedPath(path: string): string {
	return toDisplayPath(path).replace(/^\/+/, "");
}

function pathWithoutExtension(path: string): string {
	return normalizedPath(path).replace(/\.md$/i, "");
}

function docFolder(doc: Doc): string {
	if (doc.folder) return normalizedPath(doc.folder).replace(/\/+$/, "");
	const segments = normalizedPath(doc.path).split("/");
	return segments.length > 1 ? segments.slice(0, -1).join("/") : "";
}

function timestamp(value: string | undefined): number {
	const parsed = value ? Date.parse(value) : 0;
	return Number.isFinite(parsed) ? parsed : 0;
}

function formatRelativeDate(value: string): string {
	const date = timestamp(value);
	if (!date) return "Unknown";
	const elapsed = date - Date.now();
	const absoluteElapsed = Math.abs(elapsed);
	const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	if (absoluteElapsed < 60_000) return "Just now";
	if (absoluteElapsed < 3_600_000) {
		return formatter.format(Math.round(elapsed / 60_000), "minute");
	}
	if (absoluteElapsed < 86_400_000) {
		return formatter.format(Math.round(elapsed / 3_600_000), "hour");
	}
	if (absoluteElapsed < 604_800_000) {
		return formatter.format(Math.round(elapsed / 86_400_000), "day");
	}
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year:
			new Date(date).getFullYear() === new Date().getFullYear()
				? undefined
				: "numeric",
	}).format(date);
}

function isDocsFilter(value: unknown): value is DocsFilter {
	return value === "all" || value === "specs" || value === "imported";
}

function isDocsSort(value: unknown): value is DocsSort {
	return (
		value === "updated-desc" ||
		value === "title-asc" ||
		value === "path-asc"
	);
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function readViewState(
	value: unknown,
	initialFolder: string | null,
): DocsLibraryViewState {
	if (!value || typeof value !== "object") {
		return { ...defaultViewState, folder: initialFolder };
	}
	const candidate = value as Partial<DocsLibraryViewState>;
	if (candidate.version !== 1) {
		return { ...defaultViewState, folder: initialFolder };
	}
	return {
		version: 1,
		folder:
			typeof candidate.folder === "string" || candidate.folder === null
				? candidate.folder
				: initialFolder,
		query: typeof candidate.query === "string" ? candidate.query : "",
		filter: isDocsFilter(candidate.filter) ? candidate.filter : "all",
		sort: isDocsSort(candidate.sort) ? candidate.sort : "updated-desc",
		selectedKey:
			typeof candidate.selectedKey === "string"
				? candidate.selectedKey
				: null,
		pinnedPaths: stringList(candidate.pinnedPaths),
		recentPaths: stringList(candidate.recentPaths),
		scrollTop:
			typeof candidate.scrollTop === "number" &&
			Number.isFinite(candidate.scrollTop)
				? candidate.scrollTop
				: 0,
	};
}

function loadViewState(initialFolder: string | null): DocsLibraryViewState {
	try {
		const raw = localStorage.getItem(VIEW_STATE_STORAGE_KEY);
		if (raw) return readViewState(JSON.parse(raw), initialFolder);
	} catch {
		// Ignore parse/storage errors and fall back to defaults.
	}
	return { ...defaultViewState, folder: initialFolder };
}

function saveViewState(state: DocsLibraryViewState): void {
	try {
		localStorage.setItem(VIEW_STATE_STORAGE_KEY, JSON.stringify(state));
	} catch {
		// Ignore storage errors (e.g. private browsing quota).
	}
}

function matchesFilter(doc: Doc, filter: DocsFilter): boolean {
	if (filter === "specs") return isSpec(doc);
	if (filter === "imported") return Boolean(doc.isImported);
	return true;
}

function searchScore(doc: Doc, normalizedQuery: string): number {
	if (!normalizedQuery) return 1;
	const title = doc.metadata.title.toLowerCase();
	const path = normalizedPath(doc.path).toLowerCase();
	const tags = (doc.metadata.tags || []).join(" ").toLowerCase();
	const description = (doc.metadata.description || "").toLowerCase();
	if (title.startsWith(normalizedQuery)) return 5;
	if (title.includes(normalizedQuery)) return 4;
	if (path.includes(normalizedQuery)) return 3;
	if (tags.includes(normalizedQuery)) return 2;
	if (description.includes(normalizedQuery)) return 1;
	return 0;
}

function compareDocs(a: Doc, b: Doc, sort: DocsSort): number {
	if (sort === "title-asc") {
		return a.metadata.title.localeCompare(b.metadata.title);
	}
	if (sort === "path-asc") {
		return normalizedPath(a.path).localeCompare(normalizedPath(b.path));
	}
	return (
		timestamp(b.metadata.updatedAt) - timestamp(a.metadata.updatedAt) ||
		a.metadata.title.localeCompare(b.metadata.title)
	);
}

function buildEntries(
	docs: Doc[],
	folder: string | null,
	query: string,
	filter: DocsFilter,
	sort: DocsSort,
): LibraryEntry[] {
	const normalizedQuery = query.trim().toLowerCase();
	const filteredDocs = docs.filter((doc) => matchesFilter(doc, filter));

	if (normalizedQuery) {
		return filteredDocs
			.map((doc) => ({ doc, score: searchScore(doc, normalizedQuery) }))
			.filter(({ score }) => score > 0)
			.sort(
				(a, b) =>
					b.score - a.score || compareDocs(a.doc, b.doc, sort),
			)
			.map(({ doc }) => ({
				type: "document" as const,
				key: `doc:${normalizedPath(doc.path)}`,
				doc,
			}));
	}

	const directDocs: Doc[] = [];
	const folderDocs = new Map<string, Doc[]>();
	const prefix = folder ? `${folder}/` : "";

	for (const doc of filteredDocs) {
		const effectiveFolder = docFolder(doc);
		if (folder) {
			if (effectiveFolder === folder) {
				directDocs.push(doc);
				continue;
			}
			if (!effectiveFolder.startsWith(prefix)) continue;
			const child = effectiveFolder.slice(prefix.length).split("/")[0];
			if (!child) continue;
			const childPath = `${prefix}${child}`;
			folderDocs.set(childPath, [...(folderDocs.get(childPath) || []), doc]);
			continue;
		}

		if (!effectiveFolder) {
			directDocs.push(doc);
			continue;
		}
		const child = effectiveFolder.split("/")[0];
		if (!child) continue;
		folderDocs.set(child, [...(folderDocs.get(child) || []), doc]);
	}

	const folders: FolderEntry[] = [...folderDocs.entries()].map(
		([fullPath, descendants]) => {
			let completed = 0;
			let total = 0;
			for (const doc of descendants) {
				if (!isSpec(doc)) continue;
				const progress = parseACProgress(doc.content);
				completed += progress.completed;
				total += progress.total;
			}
			const latestDoc = descendants.reduce<Doc | null>(
				(latest, doc) =>
					!latest ||
					timestamp(doc.metadata.updatedAt) >
						timestamp(latest.metadata.updatedAt)
						? doc
						: latest,
				null,
			);
			return {
				type: "folder",
				key: `folder:${fullPath}`,
				name: fullPath.split("/").pop() || fullPath,
				fullPath,
				docCount: descendants.length,
				updatedAt: latestDoc?.metadata.updatedAt || "",
				specProgress: total > 0 ? { completed, total } : undefined,
			};
		},
	);

	folders.sort((a, b) => {
		if (sort === "updated-desc") {
			return (
				timestamp(b.updatedAt) - timestamp(a.updatedAt) ||
				a.name.localeCompare(b.name)
			);
		}
		return (sort === "path-asc" ? a.fullPath : a.name).localeCompare(
			sort === "path-asc" ? b.fullPath : b.name,
		);
	});

	const documents = directDocs.sort((a, b) => compareDocs(a, b, sort)).map(
		(doc): DocumentEntry => ({
			type: "document",
			key: `doc:${normalizedPath(doc.path)}`,
			doc,
		}),
	);

	return [...folders, ...documents];
}

function documentRoute(doc: Doc): string {
	return `/docs/${normalizedPath(doc.path)
		.split("/")
		.map(encodeURIComponent)
		.join("/")}`;
}

function parentFolder(folder: string): string | null {
	const parts = folder.split("/").filter(Boolean);
	return parts.length > 1 ? parts.slice(0, -1).join("/") : null;
}

function QuickAccessRow({
	doc,
	pinned,
	onOpen,
	onTogglePin,
}: {
	doc: Doc;
	pinned: boolean;
	onOpen: (doc: Doc) => void;
	onTogglePin: (doc: Doc) => void;
}) {
	return (
		<div className="group flex min-w-0 items-center border-t border-border/45 first:border-t-0">
			<button
				type="button"
				onClick={() => onOpen(doc)}
				className="flex min-w-0 flex-1 items-center gap-2.5 px-1 py-2 text-left outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
				aria-label={`Open ${doc.metadata.title}`}
			>
				{isSpec(doc) ? (
					<ClipboardCheck className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
				) : (
					<FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
				)}
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-1.5">
						<span className="truncate text-[13px] font-medium">
							{doc.metadata.title}
						</span>
						<DocKindBadges doc={doc} />
					</span>
					<span className="block truncate font-mono text-[10px] text-muted-foreground">
						{pathWithoutExtension(doc.path)}
					</span>
				</span>
				<span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground sm:block">
					{formatRelativeDate(doc.metadata.updatedAt)}
				</span>
			</button>
			<button
				type="button"
				onClick={() => onTogglePin(doc)}
				className={cn(
					"mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
					pinned
						? "text-blue-600 dark:text-blue-400"
						: "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100",
				)}
				aria-label={
					pinned
						? `Unpin ${doc.metadata.title}`
						: `Pin ${doc.metadata.title}`
				}
				title={pinned ? "Remove from quick access" : "Pin to quick access"}
			>
				<Pin className={cn("h-3.5 w-3.5", pinned && "fill-current")} />
			</button>
		</div>
	);
}

export function DocsLibrary({
	docs,
	loading,
	error,
	initialFolder = null,
	onCreateDoc,
	onSelectDoc,
	onRetry,
}: DocsLibraryProps) {
	// View state (folder, query, filter, sort, pins, recents, scroll position)
	// persists across reloads via localStorage instead of a workspace-tab store.
	const [viewState, setViewState] = useState<DocsLibraryViewState>(() =>
		loadViewState(initialFolder),
	);
	const [hydrated, setHydrated] = useState(false);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const rowRefs = useRef(new Map<string, HTMLButtonElement>());
	const scrollFrameRef = useRef<number | null>(null);

	useEffect(() => {
		setHydrated(true);
	}, []);

	const persistViewState = useCallback((next: DocsLibraryViewState) => {
		saveViewState(next);
	}, []);

	useEffect(() => {
		if (!hydrated) return;
		persistViewState(viewState);
	}, [hydrated, persistViewState, viewState]);

	useEffect(() => {
		if (!hydrated || !scrollContainerRef.current) return;
		const frame = window.requestAnimationFrame(() => {
			if (scrollContainerRef.current) {
				scrollContainerRef.current.scrollTop = viewState.scrollTop;
			}
		});
		return () => window.cancelAnimationFrame(frame);
	}, [hydrated]);

	useEffect(() => {
		if (
			hydrated &&
			viewState.scrollTop === 0 &&
			scrollContainerRef.current
		) {
			scrollContainerRef.current.scrollTop = 0;
		}
	}, [
		hydrated,
		viewState.filter,
		viewState.folder,
		viewState.query,
		viewState.scrollTop,
	]);

	useEffect(
		() => () => {
			if (scrollFrameRef.current !== null) {
				window.cancelAnimationFrame(scrollFrameRef.current);
			}
		},
		[],
	);

	const entries = useMemo(
		() =>
			buildEntries(
				docs,
				viewState.folder,
				viewState.query,
				viewState.filter,
				viewState.sort,
			),
		[
			docs,
			viewState.filter,
			viewState.folder,
			viewState.query,
			viewState.sort,
		],
	);

	const docByPath = useMemo(
		() =>
			new Map(
				docs.map((doc) => [normalizedPath(doc.path).toLowerCase(), doc]),
			),
		[docs],
	);
	const pinnedSet = useMemo(
		() => new Set(viewState.pinnedPaths.map((path) => path.toLowerCase())),
		[viewState.pinnedPaths],
	);
	const pinnedDocs = useMemo(
		() =>
			viewState.pinnedPaths
				.map((path) => docByPath.get(path.toLowerCase()))
				.filter((doc): doc is Doc => Boolean(doc)),
		[docByPath, viewState.pinnedPaths],
	);
	const recentDocs = useMemo(
		() =>
			viewState.recentPaths
				.filter((path) => !pinnedSet.has(path.toLowerCase()))
				.map((path) => docByPath.get(path.toLowerCase()))
				.filter((doc): doc is Doc => Boolean(doc)),
		[docByPath, pinnedSet, viewState.recentPaths],
	);
	const pinnedLimit =
		recentDocs.length > 0
			? Math.min(2, pinnedDocs.length)
			: Math.min(MAX_QUICK_ACCESS_ITEMS, pinnedDocs.length);
	const visiblePinned = pinnedDocs.slice(0, pinnedLimit);
	const visibleRecent = recentDocs.slice(
		0,
		MAX_QUICK_ACCESS_ITEMS - visiblePinned.length,
	);
	const hasQuickAccess =
		visiblePinned.length > 0 || visibleRecent.length > 0;

	const setViewStateAndPersist = useCallback(
		(
			updater:
				| DocsLibraryViewState
				| ((current: DocsLibraryViewState) => DocsLibraryViewState),
		) => {
			setViewState(updater);
		},
		[],
	);

	const openDoc = useCallback(
		(doc: Doc) => {
			const path = normalizedPath(doc.path);
			const nextState = {
				...viewState,
				recentPaths: [
					path,
					...viewState.recentPaths.filter(
						(item) => item.toLowerCase() !== path.toLowerCase(),
					),
				].slice(0, 12),
			};
			persistViewState(nextState);
			setViewState(nextState);
			onSelectDoc(doc);
			void navigateTo(documentRoute(doc));
		},
		[onSelectDoc, persistViewState, viewState],
	);

	const togglePinned = useCallback(
		(doc: Doc) => {
			const path = normalizedPath(doc.path);
			setViewStateAndPersist((current) => {
				const isPinned = current.pinnedPaths.some(
					(item) => item.toLowerCase() === path.toLowerCase(),
				);
				return {
					...current,
					pinnedPaths: isPinned
						? current.pinnedPaths.filter(
								(item) => item.toLowerCase() !== path.toLowerCase(),
							)
						: [path, ...current.pinnedPaths].slice(0, 12),
				};
			});
		},
		[setViewStateAndPersist],
	);

	const openFolder = useCallback(
		(folder: string | null) => {
			if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
			setViewStateAndPersist((current) => ({
				...current,
				folder,
				selectedKey: null,
				scrollTop: 0,
			}));
		},
		[setViewStateAndPersist],
	);

	const activateEntry = useCallback(
		(entry: LibraryEntry) => {
			setViewState((current) => ({ ...current, selectedKey: entry.key }));
			if (entry.type === "folder") {
				openFolder(entry.fullPath);
			} else {
				openDoc(entry.doc);
			}
		},
		[openDoc, openFolder],
	);

	const focusEntry = useCallback((entry: LibraryEntry) => {
		window.requestAnimationFrame(() => rowRefs.current.get(entry.key)?.focus());
	}, []);

	const handleKeyboard = useCallback(
		(event: ReactKeyboardEvent<HTMLDivElement>) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target as HTMLElement;
			const isSelectControl = Boolean(
				target.closest('[role="combobox"], [role="listbox"]'),
			);

			if (event.key === "Escape") {
				if (viewState.query) {
					event.preventDefault();
					setViewStateAndPersist((current) => ({
						...current,
						query: "",
						selectedKey: null,
						scrollTop: 0,
					}));
					searchInputRef.current?.focus();
					return;
				}
				if (viewState.selectedKey) {
					event.preventDefault();
					setViewStateAndPersist((current) => ({
						...current,
						selectedKey: null,
					}));
				}
				return;
			}

			if (
				isSelectControl ||
				(event.key !== "ArrowDown" &&
					event.key !== "ArrowUp" &&
					event.key !== "Enter")
			) {
				return;
			}

			const currentIndex = entries.findIndex(
				(entry) => entry.key === viewState.selectedKey,
			);
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				if (entries.length === 0) return;
				event.preventDefault();
				const nextIndex =
					event.key === "ArrowDown"
						? Math.min(
								currentIndex < 0 ? 0 : currentIndex + 1,
								entries.length - 1,
							)
						: Math.max(
								currentIndex < 0 ? entries.length - 1 : currentIndex - 1,
								0,
							);
				const nextEntry = entries[nextIndex];
				if (!nextEntry) return;
				setViewStateAndPersist((current) => ({
					...current,
					selectedKey: nextEntry.key,
				}));
				focusEntry(nextEntry);
				return;
			}

			if (event.key === "Enter") {
				if (target.closest("[data-doc-library-row]")) return;
				const selected =
					entries.find((entry) => entry.key === viewState.selectedKey) ||
					entries[0];
				if (!selected) return;
				event.preventDefault();
				activateEntry(selected);
			}
		},
		[
			activateEntry,
			entries,
			focusEntry,
			setViewStateAndPersist,
			viewState.query,
			viewState.selectedKey,
		],
	);

	const handleScroll = useCallback(() => {
		if (scrollFrameRef.current !== null) return;
		scrollFrameRef.current = window.requestAnimationFrame(() => {
			scrollFrameRef.current = null;
			const scrollTop = scrollContainerRef.current?.scrollTop || 0;
			setViewState((current) => {
				if (Math.abs(current.scrollTop - scrollTop) < 8) return current;
				return { ...current, scrollTop };
			});
		});
	}, []);

	const folderSegments = viewState.folder?.split("/").filter(Boolean) || [];
	return (
		<div
			className="flex h-full min-w-0 flex-col overflow-hidden bg-background"
			data-testid="docs-library"
			onKeyDown={handleKeyboard}
		>
			<FeatureHeader
				icon={BookOpenText}
				title="Docs"
				status={`${docs.length} ${docs.length === 1 ? "doc" : "docs"}`}
				actions={
					<Button
						size="sm"
						onClick={() => onCreateDoc(viewState.folder)}
						className="h-8 px-3 text-xs"
						title="Create new document"
					>
						<Plus className="mr-1.5 h-3.5 w-3.5" />
						New Doc
					</Button>
				}
			/>

			<DocsLibraryToolbar
				ref={searchInputRef}
				filter={viewState.filter}
				query={viewState.query}
				sort={viewState.sort}
				onQueryChange={(query) =>
					setViewStateAndPersist((current) => ({
						...current,
						query,
						selectedKey: null,
						scrollTop: 0,
					}))
				}
				onFilterChange={(filter) =>
					setViewStateAndPersist((current) => ({
						...current,
						filter,
						selectedKey: null,
						scrollTop: 0,
					}))
				}
				onSortChange={(sort) =>
					setViewStateAndPersist((current) => ({
						...current,
						sort,
						selectedKey: null,
						scrollTop: 0,
					}))
				}
			/>

			{hasQuickAccess && !loading && !error && (
				<section
					className="shrink-0 border-b border-border/45 px-4 py-3 sm:px-6"
					aria-labelledby="quick-access-heading"
				>
					<div className="mb-1.5 flex items-center gap-2">
						<h2
							id="quick-access-heading"
							className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
						>
							Quick access
						</h2>
						<span className="text-[11px] text-muted-foreground/70">
							{visiblePinned.length + visibleRecent.length} items
						</span>
					</div>
					<div className="grid gap-x-8 md:grid-cols-2">
						{visiblePinned.length > 0 && (
							<div className="min-w-0">
								<div className="flex h-6 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
									<Pin className="h-3 w-3" />
									Pinned
								</div>
								{visiblePinned.map((doc) => (
									<QuickAccessRow
										key={`pinned:${doc.path}`}
										doc={doc}
										pinned
										onOpen={openDoc}
										onTogglePin={togglePinned}
									/>
								))}
							</div>
						)}
						{visibleRecent.length > 0 && (
							<div className="min-w-0">
								<div className="flex h-6 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
									<Clock3 className="h-3 w-3" />
									Recent
								</div>
								{visibleRecent.map((doc) => (
									<QuickAccessRow
										key={`recent:${doc.path}`}
										doc={doc}
										pinned={false}
										onOpen={openDoc}
										onTogglePin={togglePinned}
									/>
								))}
							</div>
						)}
					</div>
				</section>
			)}

			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/45 px-4 sm:px-6">
					<nav
						className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
						aria-label="Document folder"
					>
						<button
							type="button"
							onClick={() => openFolder(null)}
							className={cn(
								"rounded px-1.5 py-1 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
								!viewState.folder && "font-medium text-foreground",
							)}
						>
							Docs
						</button>
						{folderSegments.map((segment, index) => {
							const folder = folderSegments.slice(0, index + 1).join("/");
							const isCurrent = index === folderSegments.length - 1;
							return (
								<span key={folder} className="flex min-w-0 items-center gap-1">
									<ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
									<button
										type="button"
										onClick={() => openFolder(folder)}
										className={cn(
											"max-w-[180px] truncate rounded px-1.5 py-1 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
											isCurrent && "font-medium text-foreground",
										)}
									>
										{segment}
									</button>
								</span>
							);
						})}
					</nav>
					<div className="flex-1" />
					{viewState.query ? (
						<span className="text-xs tabular-nums text-muted-foreground">
							{entries.length} {entries.length === 1 ? "result" : "results"}
						</span>
					) : viewState.folder ? (
						<button
							type="button"
							onClick={() => openFolder(parentFolder(viewState.folder!))}
							className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
						>
							<ChevronLeft className="h-3 w-3" />
							Up
						</button>
					) : null}
				</div>

				<div className="hidden h-8 shrink-0 grid-cols-[minmax(0,1fr)_96px] items-center gap-3 border-b border-border/45 px-4 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground sm:grid sm:grid-cols-[minmax(240px,1.4fr)_minmax(160px,1fr)_96px] sm:px-6 xl:grid-cols-[minmax(280px,1.7fr)_minmax(180px,1fr)_minmax(140px,0.75fr)_96px]">
					<span>Title</span>
					<span className="hidden sm:block">Path</span>
					<span className="hidden xl:block">Tags</span>
					<span>Updated</span>
				</div>

				<div
					ref={scrollContainerRef}
					onScroll={handleScroll}
					className="min-h-0 flex-1 overflow-y-auto"
					data-testid="docs-library-list"
				>
					{loading ? (
						<div className="px-4 py-2 sm:px-6" aria-label="Loading documents">
							{Array.from({ length: 9 }).map((_, index) => (
								<div
									key={index}
									className="grid h-11 grid-cols-[minmax(0,1fr)_96px] items-center gap-3 border-b border-border/35 sm:grid-cols-[minmax(240px,1.4fr)_minmax(160px,1fr)_96px] xl:grid-cols-[minmax(280px,1.7fr)_minmax(180px,1fr)_minmax(140px,0.75fr)_96px]"
								>
									<Skeleton className="h-4 w-2/3" />
									<Skeleton className="hidden h-3 w-3/4 sm:block" />
									<Skeleton className="hidden h-5 w-20 xl:block" />
									<Skeleton className="h-3 w-14" />
								</div>
							))}
						</div>
					) : error ? (
						<div className="flex min-h-[280px] items-center justify-center px-6 py-12">
							<div className="max-w-sm text-center">
								<RotateCcw className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
								<h2 className="text-sm font-semibold">
									Docs could not be loaded
								</h2>
								<p className="mt-1 text-sm text-muted-foreground">{error}</p>
								<Button
									variant="outline"
									size="sm"
									onClick={onRetry}
									className="mt-4 h-8 text-xs"
								>
									Try again
								</Button>
							</div>
						</div>
					) : entries.length === 0 ? (
						<div className="flex min-h-[300px] items-center justify-center px-6 py-12">
							<div className="max-w-sm text-center">
								{viewState.query || viewState.filter !== "all" ? (
									<Search className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
								) : (
									<PackageOpen className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
								)}
								<h2 className="text-sm font-semibold">
									{viewState.query
										? "No matching docs"
										: viewState.filter === "specs"
											? "No specs here"
											: viewState.filter === "imported"
												? "No imported docs here"
												: viewState.folder
													? "This folder is empty"
													: "No docs yet"}
								</h2>
								<p className="mt-1 text-sm text-muted-foreground">
									{viewState.query
										? "Try another title, path, tag, or description."
										: viewState.filter !== "all"
											? "Change the filter to see the rest of the library."
											: "Create the first document in this workspace."}
								</p>
								<div className="mt-4 flex items-center justify-center gap-2">
									{(viewState.query || viewState.filter !== "all") && (
										<Button
											variant="outline"
											size="sm"
											onClick={() =>
												setViewStateAndPersist((current) => ({
													...current,
													query: "",
													filter: "all",
													selectedKey: null,
												}))
											}
											className="h-8 text-xs"
										>
											Clear filters
										</Button>
									)}
									{!viewState.query && viewState.filter === "all" && (
										<Button
											size="sm"
											onClick={() => onCreateDoc(viewState.folder)}
											className="h-8 text-xs"
										>
											<Plus className="mr-1.5 h-3.5 w-3.5" />
											New Doc
										</Button>
									)}
								</div>
							</div>
						</div>
					) : (
						<div
							role="list"
							aria-label="Documents"
							className="pb-8"
						>
							{entries.map((entry) => {
								const selected = viewState.selectedKey === entry.key;
								if (entry.type === "folder") {
									return (
										<div
											key={entry.key}
											role="listitem"
											className={cn(
												"border-b border-border/35 border-l-2 border-l-transparent transition-colors duration-150",
												selected
													? "border-l-blue-500 bg-blue-50/70 dark:bg-blue-950/25"
													: "hover:bg-muted/35",
											)}
										>
											<button
												ref={(node) => {
													if (node) rowRefs.current.set(entry.key, node);
													else rowRefs.current.delete(entry.key);
												}}
												type="button"
												data-doc-library-row
												onClick={() => activateEntry(entry)}
												className="grid min-h-11 w-full grid-cols-[minmax(0,1fr)_96px] items-center gap-3 px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(240px,1.4fr)_minmax(160px,1fr)_96px] sm:px-6 xl:grid-cols-[minmax(280px,1.7fr)_minmax(180px,1fr)_minmax(140px,0.75fr)_96px]"
												aria-label={`Open folder ${entry.name}, ${entry.docCount} documents`}
												aria-current={selected ? "true" : undefined}
											>
												<span className="flex min-w-0 items-center gap-2.5">
													<FolderOpen className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
													<span className="min-w-0">
														<span className="flex items-center gap-2">
															<span className="truncate text-[13px] font-medium">
																{entry.name}
															</span>
															<span className="shrink-0 text-[11px] text-muted-foreground">
																{entry.docCount}{" "}
																{entry.docCount === 1 ? "doc" : "docs"}
															</span>
															{entry.specProgress && (
																<span className="hidden shrink-0 text-[11px] text-muted-foreground md:inline">
																	{entry.specProgress.completed}/
																	{entry.specProgress.total} ACs
																</span>
															)}
														</span>
														<span className="block truncate font-mono text-[10px] text-muted-foreground sm:hidden">
															{entry.fullPath}
														</span>
													</span>
												</span>
												<span className="hidden truncate font-mono text-[11px] text-muted-foreground sm:block">
													{entry.fullPath}
												</span>
												<span className="hidden text-[11px] text-muted-foreground xl:block">
													{entry.specProgress
														? `${entry.specProgress.completed}/${entry.specProgress.total} ACs`
														: "Folder"}
												</span>
												<span className="flex items-center justify-end gap-2 text-right text-[11px] tabular-nums text-muted-foreground">
													{formatRelativeDate(entry.updatedAt)}
													<ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
												</span>
											</button>
										</div>
									);
								}

								const { doc } = entry;
								const path = normalizedPath(doc.path);
								const pinned = pinnedSet.has(path.toLowerCase());
								const tags = doc.metadata.tags || [];
								return (
									<div
										key={entry.key}
										role="listitem"
										className={cn(
											"group flex border-b border-border/35 border-l-2 border-l-transparent transition-colors duration-150",
											selected
												? "border-l-blue-500 bg-blue-50/70 dark:bg-blue-950/25"
												: "hover:bg-muted/35",
										)}
									>
										<button
											ref={(node) => {
												if (node) rowRefs.current.set(entry.key, node);
												else rowRefs.current.delete(entry.key);
											}}
											type="button"
											data-doc-library-row
											onClick={() => activateEntry(entry)}
											className="grid min-h-11 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_96px] items-center gap-3 px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(240px,1.4fr)_minmax(160px,1fr)_96px] sm:pl-6 sm:pr-3 xl:grid-cols-[minmax(280px,1.7fr)_minmax(180px,1fr)_minmax(140px,0.75fr)_96px]"
											aria-label={`Open ${doc.metadata.title}`}
											aria-current={selected ? "true" : undefined}
										>
											<span className="flex min-w-0 items-center gap-2.5">
												{isSpec(doc) ? (
													<ClipboardCheck className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
												) : doc.isImported ? (
													<PackageOpen className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />
												) : (
													<FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
												)}
												<span className="min-w-0">
													<span className="flex min-w-0 items-center gap-1.5">
														<span className="truncate text-[13px] font-medium">
															{doc.metadata.title}
														</span>
														<DocKindBadges doc={doc} />
													</span>
													<span className="block truncate font-mono text-[10px] text-muted-foreground sm:hidden">
														{pathWithoutExtension(path)}
													</span>
												</span>
											</span>
											<span className="hidden truncate font-mono text-[11px] text-muted-foreground sm:block">
												{pathWithoutExtension(path)}
											</span>
											<span className="hidden min-w-0 items-center gap-1 xl:flex">
												{tags.slice(0, 2).map((tag) => (
													<span
														key={tag}
														className="max-w-24 truncate rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
													>
														{tag}
													</span>
												))}
												{tags.length > 2 && (
													<span className="text-[10px] text-muted-foreground">
														+{tags.length - 2}
													</span>
												)}
												{tags.length === 0 && (
													<span className="text-[11px] text-muted-foreground/60">
														No tags
													</span>
												)}
											</span>
											<span className="text-right text-[11px] tabular-nums text-muted-foreground">
												{formatRelativeDate(doc.metadata.updatedAt)}
											</span>
										</button>
										<button
											type="button"
											onClick={() => togglePinned(doc)}
											className={cn(
												"mr-3 flex w-7 shrink-0 items-center justify-center self-stretch text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:mr-5",
												pinned
													? "text-blue-600 dark:text-blue-400"
													: "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100",
											)}
											aria-label={
												pinned
													? `Unpin ${doc.metadata.title}`
													: `Pin ${doc.metadata.title}`
											}
											title={
												pinned
													? "Remove from quick access"
													: "Pin to quick access"
											}
										>
											<Pin
												className={cn(
													"h-3.5 w-3.5",
													pinned && "fill-current",
												)}
											/>
										</button>
									</div>
								);
							})}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
