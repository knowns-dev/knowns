import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import {
	Pencil,
	Check,
	X,
	Copy,
	Maximize2,
	Minimize2,
	Menu,
	History,
	PanelLeftClose,
	PanelLeftOpen,
} from "lucide-react";
import { MDEditor } from "../components/editor";
import { Button } from "../components/ui/button";
import { updateDoc } from "../api/client";
import { useGlobalTask } from "../contexts/GlobalTaskContext";
import { useDocsOptional } from "../contexts/DocsContext";
import { DocsNavSidebar, buildDocsSections, type DocsNavFilter } from "../components/organisms/DocsNavSidebar";
import { toDisplayPath, normalizePathForAPI } from "../lib/utils";
import { navigateTo } from "../lib/navigation";
import { DocsTOC } from "../components/molecules/DocsTOC";
import { TaskPreviewDialog } from "../components/organisms/TaskDetail/TaskPreviewDialog";
import { Sheet, SheetContent, SheetTitle } from "../components/ui/sheet";

import { DocsDocHeader } from "./docs/DocsDocHeader";
import { DocsCreateView } from "./docs/DocsCreateView";
import { PageError, PageLoading } from "../components/templates/PageShell";
import { DocMiniGraph } from "./docs/DocMiniGraph";
import { DocHistorySheet } from "./docs/DocHistorySheet";
import { MDRenderWithHighlight } from "../components/editor/MDRenderWithHighlight";

import { AnnotationProvider, useAnnotationContext } from "../contexts/AnnotationContext";
import { AnnotationSelectionToolbar } from "../components/annotations/AnnotationSelectionToolbar";
import { AnnotationHighlighter } from "../components/annotations/AnnotationHighlighter";
import { AnnotationBubble } from "../components/annotations/AnnotationBubble";
import { NoResults } from "@/ui/components/ui/knowns/illustrations/empty-states";

/** The header's previous / next arrows, routed in the app. */
function PagerLink({ href, children, ...rest }: { href: string; children?: ReactNode; className?: string; rel?: string; "aria-label"?: string }) {
	const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
		event.preventDefault();
		void navigateTo(href);
	};
	return (
		<a href={href} onClick={handleClick} {...rest}>
			{children}
		</a>
	);
}

const toolbarButton = "h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground";

export default function DocsPage() {
	return (
		<AnnotationProvider>
			<DocsPageInner />
		</AnnotationProvider>
	);
}

function DocsPageInner() {
	const location = useRouterState({ select: (state) => state.location });
	const { openTask } = useGlobalTask();
	const docsContext = useDocsOptional();

	if (!docsContext) {
		return (
			<div className="p-6 flex items-center justify-center h-64">
				<div className="text-lg text-muted-foreground">Loading documentation...</div>
			</div>
		);
	}

	const {
		docs, loading, error, selectedDoc, setSelectedDoc,
		isEditing, setIsEditing, editedContent, setEditedContent,
		linkedTasks, showSpecsOnly, setShowSpecsOnly,
		linkedTasksExpanded, setLinkedTasksExpanded,
		loadDocs, currentFolder, navigateToFolder,
	} = docsContext;

	const [saving, setSaving] = useState(false);
	// A failed save shows its server message next to what was being saved,
	// e.g. a change that arrived through store sync after this version was read.
	const [saveError, setSaveError] = useState<string | null>(null);
	const [metaError, setMetaError] = useState<{ field: "title" | "description" | "tags"; message: string } | null>(null);
	const [showCreateView, setShowCreateView] = useState(false);
	const [pathCopied, setPathCopied] = useState(false);
	const [previewTaskId, setPreviewTaskId] = useState<string | null>(null);
	const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
	const [docSearchQuery, setDocSearchQuery] = useState("");
	const [lineHighlight, setLineHighlight] = useState<{ start: number; end: number } | null>(null);
	const [wideMode, setWideMode] = useState(() => localStorage.getItem("docs-wide-mode") === "true");
	const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("docs-sidebar-collapsed") === "true");
	const [historyOpen, setHistoryOpen] = useState(false);
	const [metaTitle, setMetaTitle] = useState("");
	const [metaDescription, setMetaDescription] = useState("");
	const [metaTags, setMetaTags] = useState("");
	const [navFilter, setNavFilterState] = useState<DocsNavFilter>(() => (showSpecsOnly ? "specs" : "all"));
	const setNavFilter = (filter: DocsNavFilter) => {
		setNavFilterState(filter);
		setShowSpecsOnly(filter === "specs");
	};

	// Previous / next follow the sidebar's reading order: each folder's own docs, then its subfolders.
	const readingOrder = useMemo(
		() => buildDocsSections(docs).flatMap((section) => [...(section.pages ?? []), ...(section.categories ?? []).flatMap((category) => category.pages)]),
		[docs],
	);
	const pager = useMemo(() => {
		if (!selectedDoc) return { prev: null, next: null };
		const id = toDisplayPath(selectedDoc.path).replace(/^\/+/, "");
		const index = readingOrder.findIndex((page) => page.id === id);
		if (index < 0) return { prev: null, next: null };
		const link = (i: number) => {
			const page = readingOrder[i];
			return page ? { href: page.href, title: page.label } : null;
		};
		return { prev: link(index - 1), next: link(index + 1) };
	}, [readingOrder, selectedDoc]);

	// One layout for the whole Docs area: with no doc in the URL (/docs, or a folder path), open a
	// doc instead of a separate library page. A folder opens its first doc; otherwise the root
	// README, otherwise the first doc in reading order.
	const defaultDocHref = useMemo(() => {
		if (readingOrder.length === 0) return null;
		const folder = currentFolder?.replace(/^\/+|\/+$/g, "");
		const inFolder = folder ? readingOrder.find((page) => page.id.startsWith(`${folder}/`)) : undefined;
		const readme = readingOrder.find((page) => /^readme(\.md)?$/i.test(page.id));
		return (inFolder ?? readme ?? readingOrder[0])?.href ?? null;
	}, [readingOrder, currentFolder]);

	const markdownPreviewRef = useRef<HTMLDivElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const scrollPositions = useRef<Map<string, number>>(new Map());
	const scrollAnimationRef = useRef<number | null>(null);
	const lineHighlightRef = useRef<HTMLDivElement>(null);
	const docViewerRef = useRef<HTMLDivElement>(null);

	// Annotation context
	const annotationCtx = useAnnotationContext();

	// --- Scroll helpers ---
	const scrollToHeading = useCallback((headingId: string, behavior: ScrollBehavior = "smooth") => {
		const container = scrollContainerRef.current;
		if (!container) return false;
		const viewport = container.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]") || container;
		const escapedHeadingId = CSS.escape(headingId);
		const heading =
			viewport.querySelector<HTMLElement>(`#${escapedHeadingId}`) ||
			viewport.querySelector<HTMLElement>(`[data-heading-slug="${escapedHeadingId}"]`) ||
			viewport.querySelector<HTMLElement>(`[id$="-${escapedHeadingId}"]`);
		if (!heading) return false;

		const viewportRect = viewport.getBoundingClientRect();
		const headingRect = heading.getBoundingClientRect();
		const targetTop = viewport.scrollTop + (headingRect.top - viewportRect.top) - 20;

		if (scrollAnimationRef.current !== null) {
			window.cancelAnimationFrame(scrollAnimationRef.current);
			scrollAnimationRef.current = null;
		}

		if (behavior === "auto") {
			viewport.scrollTop = targetTop;
			return true;
		}

		const startTop = viewport.scrollTop;
		const distance = targetTop - startTop;
		const duration = 280;
		const startTime = performance.now();
		const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

		const animate = (now: number) => {
			const progress = Math.min((now - startTime) / duration, 1);
			viewport.scrollTop = startTop + distance * ease(progress);
			if (progress < 1) {
				scrollAnimationRef.current = window.requestAnimationFrame(animate);
			} else {
				scrollAnimationRef.current = null;
			}
		};
		scrollAnimationRef.current = window.requestAnimationFrame(animate);
		return true;
	}, []);

	const updateSectionHash = useCallback((headingId: string | null) => {
		const hash = headingId ? `#${encodeURIComponent(headingId)}` : "";
		window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${hash}`);
	}, []);

	const navigateToHeading = useCallback((headingId: string, behavior: ScrollBehavior = "smooth") => {
		if (scrollToHeading(headingId, behavior)) updateSectionHash(headingId);
	}, [scrollToHeading, updateSectionHash]);

	// --- Effects ---
	useEffect(() => { localStorage.setItem("docs-wide-mode", String(wideMode)); }, [wideMode]);
	useEffect(() => { localStorage.setItem("docs-sidebar-collapsed", String(sidebarCollapsed)); }, [sidebarCollapsed]);

	useEffect(() => {
		if (selectedDoc) {
			setMetaTitle(selectedDoc.metadata.title || "");
			setMetaDescription(selectedDoc.metadata.description || "");
			setMetaTags(selectedDoc.metadata.tags?.join(", ") || "");
		}
	}, [selectedDoc?.path]);

	const handleSaveMetadata = async (field: "title" | "description" | "tags") => {
		if (!selectedDoc || selectedDoc.isImported) return;
		const updates: { title?: string; description?: string; tags?: string[] } = {};
		if (field === "title" && metaTitle !== (selectedDoc.metadata.title || "")) updates.title = metaTitle;
		else if (field === "description" && metaDescription !== (selectedDoc.metadata.description || "")) updates.description = metaDescription;
		else if (field === "tags") {
			const newTags = metaTags.split(",").map(t => t.trim()).filter(t => t);
			if (JSON.stringify(newTags) !== JSON.stringify(selectedDoc.metadata.tags || [])) updates.tags = newTags;
		}
		if (Object.keys(updates).length === 0) return;
		try {
			await updateDoc(normalizePathForAPI(selectedDoc.path), { ...updates, expectedHash: selectedDoc.canonicalHash });
			setMetaError(null);
			loadDocs();
		} catch (err) {
			console.error("Failed to save metadata:", err);
			setMetaError({ field, message: err instanceof Error ? err.message : String(err) });
			setMetaTitle(selectedDoc.metadata.title || "");
			setMetaDescription(selectedDoc.metadata.description || "");
			setMetaTags(selectedDoc.metadata.tags?.join(", ") || "");
		}
	};

	// URL params
	useEffect(() => {
		if ((location.search as Record<string, unknown>).create === true || (location.search as Record<string, unknown>).create === "true") {
			setShowCreateView(true);
			navigateTo("/docs", { replace: true });
		}
	}, [(location.search as Record<string, unknown>).create]);

	useEffect(() => {
		const rawSearch = String(location.searchStr || "");
		const params = new URLSearchParams(rawSearch.startsWith("?") ? rawSearch : `?${rawSearch}`);
		const lParam = params.get("L");
		if (!lParam) {
			setLineHighlight(null);
			return;
		}
		const rangeMatch = lParam.match(/^(\d+)-(\d+)$/);
		if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
			setLineHighlight({ start: +rangeMatch[1], end: +rangeMatch[2] });
		} else {
			const line = parseInt(lParam, 10);
			setLineHighlight(!isNaN(line) ? { start: line, end: line } : null);
		}
	}, [location.searchStr]);

	useEffect(() => {
		if (lineHighlight && lineHighlightRef.current) {
			requestAnimationFrame(() => lineHighlightRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
		}
	}, [lineHighlight]);

	// Scroll position restore
	useEffect(() => {
		if (selectedDoc && scrollContainerRef.current) {
			const activeHash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
			const rawSearch = String(location.searchStr || "");
			const params = new URLSearchParams(rawSearch.startsWith("?") ? rawSearch : `?${rawSearch}`);
			if (activeHash || params.has("L")) return;
			const saved = scrollPositions.current.get(selectedDoc.path) || 0;
			requestAnimationFrame(() => { if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = saved; });
		}
	}, [location.searchStr, selectedDoc?.path]);

	useEffect(() => {
		if (!selectedDoc) return;
		const id = decodeURIComponent(String(location.hash || "").replace(/^#/, ""));
		if (id) {
			window.setTimeout(() => scrollToHeading(id, "auto"), 80);
		}
	}, [location.hash, scrollToHeading, selectedDoc?.path]);

	useEffect(() => {
		const applyHash = () => {
			const id = decodeURIComponent(window.location.hash.replace(/^#/, ""));
			if (id) window.setTimeout(() => scrollToHeading(id, "auto"), 80);
		};
		window.addEventListener("hashchange", applyHash);
		return () => window.removeEventListener("hashchange", applyHash);
	}, [scrollToHeading]);

	useEffect(() => () => { if (scrollAnimationRef.current !== null) window.cancelAnimationFrame(scrollAnimationRef.current); }, []);

	// Handle markdown link clicks
	useEffect(() => {
		const handleLinkClick = (e: MouseEvent) => {
			let target = e.target as HTMLElement;
			while (target && target.tagName !== "A" && target !== markdownPreviewRef.current) {
				target = target.parentElement as HTMLElement;
			}
			if (target && target.tagName === "A") {
				const href = (target as HTMLAnchorElement).getAttribute("href");
				if (href?.startsWith("#")) {
					e.preventDefault();
					navigateToHeading(decodeURIComponent(href.slice(1)));
					return;
				}
				if (href && /^@?task-[\w.]+(.md)?$/.test(href)) {
					e.preventDefault();
					openTask(href.replace(/^@/, "").replace(/^task-/, "").replace(".md", ""));
					return;
				}
				if (href?.startsWith("@doc/")) {
					e.preventDefault();
					navigateTo(`/docs/${href.replace("@doc/", "")}.md`);
					return;
				}
				if (href && (href.endsWith(".md") || href.includes(".md#"))) {
					e.preventDefault();
					const normalized = href.replace(/^\.\//, "").replace(/^\//, "");
					const [docPath, hashPart] = normalized.split("#");
					void navigateTo(`/docs/${docPath ?? normalized}`).then(() => {
						if (hashPart) window.setTimeout(() => navigateToHeading(decodeURIComponent(hashPart), "auto"), 80);
					});
				}
			}
		};
		const el = markdownPreviewRef.current;
		if (el) { el.addEventListener("click", handleLinkClick); return () => el.removeEventListener("click", handleLinkClick); }
	}, [docs, navigateToHeading, openTask, selectedDoc]);

	// --- Handlers ---
	const handleEdit = () => { if (selectedDoc) { setEditedContent(selectedDoc.content); setIsEditing(true); } };
	const handleCopyPath = () => {
		if (selectedDoc) {
			navigator.clipboard.writeText(`@doc/${toDisplayPath(selectedDoc.path).replace(/\.md$/, "")}`).then(() => {
				setPathCopied(true);
				setTimeout(() => setPathCopied(false), 2000);
			});
		}
	};
	const handleSave = async () => {
		if (!selectedDoc) return;
		setSaving(true);
		try {
			await updateDoc(normalizePathForAPI(selectedDoc.path), { content: editedContent, expectedHash: selectedDoc.canonicalHash });
			setSaveError(null);
			loadDocs();
			setIsEditing(false);
		}
		catch (err) {
			console.error("Failed to save doc:", err);
			setSaveError(err instanceof Error ? err.message : String(err));
		}
		finally { setSaving(false); }
	};
	const handleCancel = () => { setIsEditing(false); setEditedContent(""); setSaveError(null); };
	const openCreateView = () => { setShowCreateView(true); setMobileSidebarOpen(false); };
	const dismissLineHighlight = () => {
		setLineHighlight(null);
		window.history.replaceState(window.history.state, "", window.location.pathname + window.location.hash);
	};

	// Annotation handler
	const handleAnnotate = useCallback(
		(selectedText: string, type: "comment" | "replace" | "delete", content: string, contextBefore: string, contextAfter: string, startLine: number, startChar: number, endLine: number, endChar: number) => {
			if (!selectedDoc) return;
			const docPath = toDisplayPath(selectedDoc.path).replace(/\.md$/, "");
			annotationCtx.add(docPath, selectedText, type, content, contextBefore, contextAfter, startLine, startChar, endLine, endChar);
		},
		[selectedDoc, annotationCtx],
	);

	const currentDocPath = selectedDoc ? toDisplayPath(selectedDoc.path).replace(/\.md$/, "") : "";
	const currentDocAnnotations = selectedDoc ? annotationCtx.getByDoc(currentDocPath) : [];

	const sidebarContent = (
		<DocsNavSidebar
			docs={docs}
			selectedDocPath={selectedDoc?.path}
			filter={navFilter}
			onFilterChange={setNavFilter}
			searchQuery={docSearchQuery}
			onSearchQueryChange={setDocSearchQuery}
			onCreateDoc={openCreateView}
			onItemSelect={() => setMobileSidebarOpen(false)}
		/>
	);

	const docReference = selectedDoc ? `@doc/${toDisplayPath(selectedDoc.path).replace(/\.md$/, "")}` : "";
	const breadcrumb = selectedDoc
		? [
				{ label: "Docs", onClick: () => navigateToFolder(null) },
				...toDisplayPath(selectedDoc.path)
					.replace(/^\/+/, "")
					.split("/")
					.slice(0, -1)
					.map((segment, index, segments) => ({
						label: segment,
						onClick: () => navigateToFolder(segments.slice(0, index + 1).join("/")),
					})),
				{ label: selectedDoc.metadata.title || "Untitled" },
			]
		: [];

	const opensDefaultDoc = !loading && !error && !selectedDoc && !showCreateView && Boolean(defaultDocHref);
	useEffect(() => {
		if (opensDefaultDoc && defaultDocHref) void navigateTo(defaultDocHref, { replace: true });
	}, [opensDefaultDoc, defaultDocHref]);

	return (
		<div className="h-full flex overflow-hidden bg-background">
			{!sidebarCollapsed && (
				<aside aria-label="Docs library" className="hidden w-[272px] shrink-0 border-r border-border/55 lg:flex">
					<div className="flex h-full w-full flex-col pt-4 pb-3 pl-3">{sidebarContent}</div>
				</aside>
			)}

			<div className="min-w-0 flex-1 flex flex-col overflow-hidden">
				<Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
					<SheetContent side="left" className="w-[88vw] max-w-none p-0 sm:max-w-sm">
						<div className="flex h-full flex-col">
							<div className="border-b border-border/55 px-4 py-3"><SheetTitle>Browse docs</SheetTitle></div>
							<div className="flex min-h-0 flex-1 flex-col pt-4 pb-3 pl-3">{sidebarContent}</div>
						</div>
					</SheetContent>
				</Sheet>

				{selectedDoc ? (
					<>
						{/* Toolbar */}
						<div className="flex h-12 shrink-0 items-center gap-1 border-b border-border/55 bg-background px-2 sm:px-4">
							<Button variant="ghost" size="sm" onClick={() => setMobileSidebarOpen(true)} className={`${toolbarButton} lg:hidden`} aria-label="Browse docs">
								<Menu className="size-4" />
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
								aria-pressed={sidebarCollapsed}
								aria-label={sidebarCollapsed ? "Show doc list" : "Hide doc list"}
								className={`${toolbarButton} hidden lg:inline-flex`}
								title={sidebarCollapsed ? "Show doc list" : "Hide doc list"}
							>
								{sidebarCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
							</Button>
							<button
								type="button"
								onClick={handleCopyPath}
								className="flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
								title="Copy reference"
							>
								{pathCopied ? <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" /> : <Copy className="size-3.5 shrink-0" />}
								<span className="max-w-[200px] truncate font-mono sm:max-w-[320px] lg:max-w-[420px]">{docReference}</span>
								<span aria-live="polite" className={pathCopied ? "text-emerald-700 dark:text-emerald-400" : "sr-only"}>{pathCopied ? "Copied" : ""}</span>
							</button>
							<div className="flex-1" />
							{!isEditing && (
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setWideMode(!wideMode)}
									aria-pressed={wideMode}
									aria-label={wideMode ? "Normal width" : "Full width"}
									className={`${toolbarButton} hidden md:inline-flex`}
									title={wideMode ? "Normal width" : "Full width"}
								>
									{wideMode ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
								</Button>
							)}
							{!isEditing && (
								<Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)} className={toolbarButton} title="Document history">
									<History className="size-4" /><span className="hidden sm:inline">History</span>
								</Button>
							)}
							{!isEditing ? (
								<Button size="sm" variant="outline" onClick={handleEdit} disabled={selectedDoc.isImported} className="ml-1 h-8 gap-1.5" title={selectedDoc.isImported ? "Imported docs are read-only" : "Edit document"}>
									<Pencil className="size-3.5" /><span className="hidden sm:inline">Edit</span>
								</Button>
							) : (
								<>
									<Button size="sm" variant="outline" onClick={handleCancel} disabled={saving} className="h-8 gap-1.5">
										<X className="size-3.5" /><span className="hidden sm:inline">Cancel</span>
									</Button>
									<Button size="sm" onClick={handleSave} disabled={saving} className="ml-1 h-8 gap-1.5">
										<Check className="size-3.5" /><span className="hidden sm:inline">{saving ? "Saving..." : "Save"}</span>
									</Button>
								</>
							)}
						</div>

						{isEditing ? (
							<div className="flex-1 min-h-0 overflow-hidden p-4 sm:p-6 flex flex-col gap-3">
								{saveError && (
									<div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
										{saveError}
									</div>
								)}
								<div className="flex-1 min-h-0">
									<MDEditor markdown={editedContent} onChange={setEditedContent} placeholder="Write your documentation here..." height="100%" className="h-full" />
								</div>
							</div>
						) : (
							<div className="flex-1 overflow-y-auto relative" ref={scrollContainerRef}>
								<div ref={docViewerRef} className="flex justify-center relative">
									<article key={selectedDoc.path} className={`min-w-0 w-full px-5 sm:px-10 pt-8 pb-16 sm:pt-10 animate-kn-doc-in ${wideMode ? "max-w-[1080px]" : "max-w-[800px]"}`}>
										<DocsDocHeader
											selectedDoc={selectedDoc}
											reference={docReference}
											breadcrumb={breadcrumb}
											prev={pager.prev}
											next={pager.next}
											pagerLinkAs={PagerLink}
											onOpenHistory={() => setHistoryOpen(true)}
											metaTitle={metaTitle} setMetaTitle={setMetaTitle}
											metaDescription={metaDescription} setMetaDescription={setMetaDescription}
											metaTags={metaTags} setMetaTags={setMetaTags}
											handleSaveMetadata={handleSaveMetadata}
											metaError={metaError}
											linkedTasks={linkedTasks}
											linkedTasksExpanded={linkedTasksExpanded} setLinkedTasksExpanded={setLinkedTasksExpanded}
											openTask={openTask}
										/>
										<div ref={markdownPreviewRef} className="prose-neutral dark:prose-invert relative">
											<MDRenderWithHighlight
												ref={lineHighlightRef}
												content={selectedDoc.content || ""}
												lineHighlight={lineHighlight}
												onDismissHighlight={lineHighlight ? dismissLineHighlight : undefined}
												onTaskLinkClick={setPreviewTaskId}
												onDocLinkClick={(path) => navigateTo(`/docs/${path}`)}
												onHeadingAnchorClick={navigateToHeading}
												showHeadingAnchors
											/>
											{/* Annotation highlights */}
											<AnnotationHighlighter
												containerRef={markdownPreviewRef}
												annotations={currentDocAnnotations}
												docContent={selectedDoc.content || ""}
												active={true}
												onEdit={(ann, changes) => {
													annotationCtx.update(ann.id, changes);
												}}
												onRemove={annotationCtx.remove}
											/>
											{/* Annotation selection toolbar */}
											<AnnotationSelectionToolbar
												containerRef={markdownPreviewRef}
												active={true}
												docContent={selectedDoc.content || ""}
												onAnnotate={handleAnnotate}
											/>
										</div>
									</article>
									{!isEditing && (
										<div className="w-60 shrink-0 pr-6 pt-10 max-xl:w-0 max-xl:p-0">
											<DocsTOC
												markdown={selectedDoc.content || ""}
												scrollContainerRef={scrollContainerRef}
												onHeadingSelect={navigateToHeading}
												className="sticky top-10 hidden max-h-[calc(100dvh-9rem)] overflow-y-auto xl:flex"
											>
												<DocMiniGraph docPath={selectedDoc.path} />
											</DocsTOC>
										</div>
									)}
									{/* Annotation bubble */}
									<AnnotationBubble
										containerRef={scrollContainerRef}
										onNavigateToDoc={(docPath) => navigateTo(`/docs/${docPath}`)}
									/>
								</div>
							</div>
						)}
					</>
				) : showCreateView ? (
					<DocsCreateView
						currentFolder={currentFolder}
						onClose={() => setShowCreateView(false)}
						onCreated={() => { setShowCreateView(false); setMobileSidebarOpen(false); loadDocs(); }}
						onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
					/>
				) : error ? (
					<PageError description={error} onRetry={loadDocs} className="flex-1" />
				) : loading || opensDefaultDoc ? (
					<PageLoading label="Loading docs" className="flex-1" />
				) : (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
						<Button variant="ghost" size="sm" onClick={() => setMobileSidebarOpen(true)} className={`${toolbarButton} lg:hidden`} aria-label="Browse docs">
							<Menu className="size-4" />
						</Button>
						<NoResults
							title="No docs yet"
							description="Create the first doc in this project, or add one with `knowns doc create`."
							action={
								<Button size="sm" onClick={openCreateView} className="h-8 gap-1.5">
									<Pencil className="size-3.5" /> New doc
								</Button>
							}
						/>
					</div>
				)}
			</div>
			{selectedDoc && (
				<DocHistorySheet
					open={historyOpen}
					onOpenChange={setHistoryOpen}
					docPath={selectedDoc.path}
					docTitle={selectedDoc.metadata.title || selectedDoc.path}
					readOnly={selectedDoc.isImported}
					onRestored={() => {
						void loadDocs();
					}}
				/>
			)}
			<TaskPreviewDialog taskId={previewTaskId} open={!!previewTaskId} onOpenChange={(open) => { if (!open) setPreviewTaskId(null); }} />
		</div>
	);
}
