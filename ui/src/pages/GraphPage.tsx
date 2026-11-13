import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import { getGraph, type GraphData, type GraphNode } from "@/ui/api/client";
import { DecisionPreviewDialog } from "@/ui/components/organisms/DecisionPreview/DecisionPreviewDialog";
import { DocPreviewDialog } from "@/ui/components/organisms/DocsPreview/DocPreviewDialog";
import { MemoryPreviewDialog } from "@/ui/components/organisms/MemoryPreview/MemoryPreviewDialog";
import { TaskPreviewDialog } from "@/ui/components/organisms/TaskDetail/TaskPreviewDialog";
import { PageError, PageLoading } from "@/ui/components/templates";
import { Button } from "@/ui/components/ui/knowns/button";
import { Spinner } from "@/ui/components/ui/knowns/spinner";
import { toast } from "@/ui/components/ui/sonner";
import { useSSEEvent } from "@/ui/contexts/SSEContext";
import { cn } from "@/ui/lib/utils";

import { GraphDetailPanel } from "./GraphDetailPanel";
import { buildSelectedNodeReferences, KNOWLEDGE_FILTERS, type FilterState } from "./graph/constants";
import {
	buildConstellationData,
	type ConstellationLink,
	type ConstellationNode,
} from "./graph/graphModel";
import { GraphTypeKey } from "./graph/GraphLegend";
import { GraphToolbar } from "./graph/GraphToolbar";
import { SigmaConstellation, type SigmaConstellationHandle } from "./graph/SigmaConstellation";
import { useGraphTheme } from "./graph/theme";
import { useContainerSize } from "./graph/useContainerSize";

const EMPTY_FORCE_DATA: {
	nodes: ConstellationNode[];
	links: ConstellationLink[];
	matches: number;
} = { nodes: [], links: [], matches: 0 };

function filterGraphData(data: GraphData, filters: FilterState): GraphData {
	const visibleNodeIds = new Set(
		data.nodes
			.filter(
				(node) =>
					(node.type === "task" && filters.tasks) ||
					(node.type === "doc" && filters.docs) ||
					(node.type === "memory" && filters.memories) ||
					(node.type === "decision" && filters.decisions) ||
					(node.type === "template" && filters.templates),
			)
			.map((node) => node.id),
	);
	const visibleEdges = filters.showEdges
		? data.edges.filter(
				(edge) =>
					visibleNodeIds.has(edge.source) &&
					visibleNodeIds.has(edge.target) &&
					((edge.type === "parent" && filters.edgeParent) ||
						(edge.type === "spec" && filters.edgeSpec) ||
						(edge.type === "references" && filters.edgeReferences) ||
						(edge.type === "implements" && filters.edgeImplements) ||
						(edge.type === "blocked-by" && filters.edgeBlockedBy) ||
						(edge.type === "related" && filters.edgeRelated) ||
						(edge.type === "depends" && filters.edgeDepends) ||
						(edge.type === "follows" && filters.edgeFollows)),
			)
		: [];
	const connectedIds = new Set<string>();
	for (const edge of visibleEdges) {
		connectedIds.add(edge.source);
		connectedIds.add(edge.target);
	}
	const nodes = data.nodes.filter(
		(node) => visibleNodeIds.has(node.id) && (filters.showIsolated || connectedIds.has(node.id)),
	);
	return { nodes, edges: visibleEdges };
}

function computeNeighborhood(data: GraphData, rootId: string, hops: number) {
	const adjacency = new Map<string, Set<string>>();
	for (const node of data.nodes) adjacency.set(node.id, new Set());
	for (const edge of data.edges) {
		adjacency.get(edge.source)?.add(edge.target);
		adjacency.get(edge.target)?.add(edge.source);
	}

	const distances = new Map<string, number>([[rootId, 0]]);
	const queue = [rootId];
	for (let index = 0; index < queue.length; index += 1) {
		const current = queue[index];
		if (!current) continue;
		const distance = distances.get(current) ?? 0;
		if (distance >= hops) continue;
		for (const next of adjacency.get(current) ?? []) {
			if (distances.has(next)) continue;
			distances.set(next, distance + 1);
			queue.push(next);
		}
	}
	return distances;
}

function sameNodeIds(a: ConstellationNode[], b: ConstellationNode[]): boolean {
	return a.length === b.length && a.every((node, index) => node.id === b[index]?.id);
}

function sameLinkIds(a: ConstellationLink[], b: ConstellationLink[]): boolean {
	return a.length === b.length && a.every((link, index) => link.id === b[index]?.id);
}

function toGraphNode(node: ConstellationNode): GraphNode {
	return { id: node.id, label: node.label, type: node.type, data: node.data };
}

const sameFilters = (a: FilterState, b: FilterState) =>
	(Object.keys(a) as (keyof FilterState)[]).every((key) => a[key] === b[key]);

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export default function GraphPage() {
	const constellationRef = useRef<SigmaConstellationHandle>(null);
	const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const stableForceDataRef = useRef(EMPTY_FORCE_DATA);
	const palette = useGraphTheme();
	const { ref: graphContainerRef, width, height } = useContainerSize<HTMLElement>();

	const [data, setData] = useState<GraphData | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [filters, setFilters] = useState<FilterState>(KNOWLEDGE_FILTERS);
	// Archived Tasks stay out of the graph unless asked for: the graph answers
	// "what is the project now", while the archive is history.
	const [includeArchived, setIncludeArchived] = useState(false);
	const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
	const [previewTaskId, setPreviewTaskId] = useState<string | null>(null);
	const [previewDocPath, setPreviewDocPath] = useState<string | null>(null);
	const [previewMemoryId, setPreviewMemoryId] = useState<string | null>(null);
	const [previewDecisionId, setPreviewDecisionId] = useState<string | null>(null);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
	const [impactNodeId, setImpactNodeId] = useState<string | null>(null);
	const [engineRunning, setEngineRunning] = useState(false);
	const hasDataRef = useRef(false);
	hasDataRef.current = data !== null;

	const fetchGraph = useCallback(async () => {
		setLoading(true);
		try {
			const graphData = await getGraph({ includeHistorical: includeArchived });
			setData(graphData);
			setError(null);
		} catch (fetchError) {
			console.error(fetchError);
			// A refresh that fails keeps the graph on screen: say so, do not blank the page.
			if (hasDataRef.current) toast.error("Could not refresh the graph");
			else setError("Check that the local server is running, then try again.");
		} finally {
			setLoading(false);
		}
	}, [includeArchived]);

	useEffect(() => {
		fetchGraph();
	}, [fetchGraph]);

	useSSEEvent("tasks:updated", fetchGraph);
	useSSEEvent("tasks:refresh", fetchGraph);
	useSSEEvent("docs:updated", fetchGraph);

	useEffect(() => {
		if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
		searchTimerRef.current = setTimeout(() => setDebouncedSearchQuery(searchQuery), 180);
		return () => {
			if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
		};
	}, [searchQuery]);

	// Fullscreen covers the window with the graph page and asks the browser for real fullscreen on
	// the whole document, so popovers, tooltips and toasts (portalled to <body>) keep working.
	// Leaving browser fullscreen (Escape) leaves the graph fullscreen too.
	useEffect(() => {
		const handleFullscreenChange = () => {
			if (!document.fullscreenElement) setIsFullscreen(false);
		};
		document.addEventListener("fullscreenchange", handleFullscreenChange);
		return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
	}, []);

	const filteredData = useMemo(() => (data ? filterGraphData(data, filters) : null), [data, filters]);
	const impactNeighborhood = useMemo(() => {
		if (!filteredData || !impactNodeId) return null;
		return computeNeighborhood(filteredData, impactNodeId, 2);
	}, [filteredData, impactNodeId]);
	const impactSummary = useMemo(() => {
		if (!filteredData || !impactNodeId) return null;
		const distances = computeNeighborhood(filteredData, impactNodeId, 3);
		const affected = filteredData.nodes.filter((node) => {
			const distance = distances.get(node.id);
			return typeof distance === "number" && distance > 0 && distance <= 3;
		});
		return {
			tasks: affected.filter((node) => node.type === "task").length,
			docs: affected.filter((node) => node.type === "doc").length,
		};
	}, [filteredData, impactNodeId]);

	const forceData = useMemo(() => {
		if (!filteredData) return EMPTY_FORCE_DATA;
		const built = buildConstellationData(filteredData, debouncedSearchQuery, palette.colors);
		// Paint order decides both what is drawn on top and, more importantly, which
		// node wins a click where hit areas overlap: the last one painted takes it.
		// Draw the biggest first so small nodes end up on top and stay clickable
		// instead of being swallowed by a large neighbour.
		const next = {
			...built,
			nodes: [...built.nodes].sort((a, b) => b.val - a.val),
		};
		const previous = stableForceDataRef.current;
		const structureSame = sameNodeIds(previous.nodes, next.nodes) && sameLinkIds(previous.links, next.links);

		if (!structureSame) {
			stableForceDataRef.current = next;
			return next;
		}

		const merged = {
			nodes: previous.nodes.map((node, index) => {
				const update = next.nodes[index];
				return update
					? {
							...node,
							color: update.color,
							val: update.val,
							degree: update.degree,
							labelRank: update.labelRank,
							highlighted: update.highlighted,
						}
					: node;
			}),
			links: previous.links.map((link, index) => {
				const update = next.links[index];
				return update
					? {
							...link,
							color: update.color,
							width: update.width,
							dashed: update.dashed,
							muted: update.muted,
						}
					: link;
			}),
			matches: next.matches,
		};
		stableForceDataRef.current = merged;
		return merged;
	}, [filteredData, debouncedSearchQuery, palette.colors]);

	const fitView = useCallback(() => {
		constellationRef.current?.fitView();
	}, []);

	const toggleFilter = useCallback((key: keyof FilterState) => {
		setFilters((previous) => ({ ...previous, [key]: !previous[key] }));
		setSelectedNode(null);
		setImpactNodeId(null);
	}, []);

	const selectedNodeReferences = useMemo(
		() => buildSelectedNodeReferences(filteredData, selectedNode),
		[filteredData, selectedNode],
	);

	// force-graph re-heats the whole simulation (forceLayout.stop().alpha(1))
	// every time the graphData prop changes identity. Passing an object literal
	// here meant every React render — selecting a node included — shook the
	// layout, so the graph shifted under the cursor between clicks and aiming at
	// a node became a coin flip. Keep the wrapper stable; forceData already
	// preserves the node objects themselves.
	const graphDataProp = useMemo(
		() => ({ nodes: forceData.nodes, links: forceData.links }),
		[forceData.nodes, forceData.links],
	);

	const handleZoomToFit = useCallback(() => {
		fitView();
	}, [fitView]);

	const clearSelection = useCallback(() => {
		setSelectedNode(null);
		setImpactNodeId(null);
	}, []);

	const toggleFullscreen = useCallback(async () => {
		if (isFullscreen) {
			setIsFullscreen(false);
			if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
			return;
		}
		setIsFullscreen(true);
		// Not every browser has element fullscreen (iPhone Safari): the page still covers the window.
		await document.documentElement.requestFullscreen?.().catch(() => undefined);
	}, [isFullscreen]);

	const resetFilters = useCallback(() => {
		setFilters(KNOWLEDGE_FILTERS);
		setSelectedNode(null);
		setImpactNodeId(null);
	}, []);

	const handleNodeNavigate = useCallback(
		(node: GraphNode) => {
			const [type, ...rest] = node.id.split(":");
			const entityId = rest.join(":");
			if (type === "task") setPreviewTaskId(entityId);
			else if (type === "doc") setPreviewDocPath(entityId);
			else if (type === "memory") setPreviewMemoryId(entityId);
			else if (type === "decision") setPreviewDecisionId(entityId);
		},
		[],
	);

	const selectNode = useCallback((node: ConstellationNode, options?: { center?: boolean }) => {
		setSelectedNode(toGraphNode(node));
		setImpactNodeId(node.id);
		// A click does not recentre the view. The node the user just aimed at would
		// slide out from under the cursor and half the graph would swing off screen,
		// which reads as the click having broken something. Only programmatic
		// selection recentres, because there the target may be off screen already.
		if (!options?.center) return;
		constellationRef.current?.centerOnNode(node.id);
	}, []);

	const selectNodeById = useCallback(
		(id: string) => {
			const node = stableForceDataRef.current.nodes.find((candidate) => candidate.id === id);
			if (node) selectNode(node, { center: true });
		},
		[selectNode],
	);

	const handleCanvasKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			if (event.key === "Escape") {
				if (selectedNode) clearSelection();
				else if (isFullscreen && !document.fullscreenElement) setIsFullscreen(false);
			}
			if (event.key.toLocaleLowerCase() === "f" && !event.metaKey && !event.ctrlKey && !event.altKey) {
				event.preventDefault();
				handleZoomToFit();
			}
		},
		[clearSelection, handleZoomToFit, selectedNode, isFullscreen],
	);

	const nodeCount = forceData.nodes.length;
	const edgeCount = forceData.links.length;
	const filtersChanged = !sameFilters(filters, KNOWLEDGE_FILTERS);
	const projectEmpty = data !== null && data.nodes.length === 0;
	const filteredEmpty = !projectEmpty && filteredData !== null && nodeCount === 0;
	const showCanvas = data !== null;

	return (
		<div
			className={cn(
				"flex min-h-0 flex-1 flex-col bg-background",
				isFullscreen && "fixed inset-0 z-50 h-dvh pt-[env(safe-area-inset-top)]",
			)}
		>
			<GraphToolbar
				data={data}
				filters={filters}
				filtersChanged={filtersChanged}
				colors={palette.colors}
				searchQuery={searchQuery}
				searchMatchCount={forceData.matches}
				isFullscreen={isFullscreen}
				nodeCount={nodeCount}
				edgeCount={edgeCount}
				onToggleFilter={toggleFilter}
				onResetFilters={resetFilters}
				onSearchChange={setSearchQuery}
				onZoomToFit={handleZoomToFit}
				onToggleFullscreen={toggleFullscreen}
				includeArchived={includeArchived}
				onToggleArchived={() => setIncludeArchived((previous) => !previous)}
			/>

			{!showCanvas && (
				<div className="min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-6">
					{loading || !error ? (
						<PageLoading label="Loading the graph" />
					) : (
						<PageError title="We couldn’t load the graph" description={error} onRetry={fetchGraph} />
					)}
				</div>
			)}

			{showCanvas && (
				<main
					ref={graphContainerRef}
					role="region"
					aria-label={`Knowledge graph with ${nodeCount} entities and ${edgeCount} relations`}
					aria-describedby="graph-keyboard-help"
					aria-busy={loading}
					tabIndex={0}
					className="relative min-h-0 flex-1 overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
					style={{ background: palette.canvas }}
					onKeyDown={handleCanvasKeyDown}
				>
					<span id="graph-keyboard-help" className="sr-only">
						Drag to pan, scroll to zoom, press F to fit the graph, and press Escape to clear the selected entity.
					</span>

					{width > 0 && height > 0 && (
						<SigmaConstellation
							ref={constellationRef}
							nodes={forceData.nodes}
							links={forceData.links}
							palette={palette}
							selectedNodeId={selectedNode?.id ?? null}
							impactNeighborhood={impactNeighborhood}
							searchActive={forceData.matches > 0}
							compact={width < 640}
							onSelectNode={selectNode}
							onBackgroundClick={clearSelection}
							onEngineRunningChange={setEngineRunning}
						/>
					)}

					{(projectEmpty || filteredEmpty) && (
						<div className="absolute inset-0 z-10 flex items-center justify-center px-6">
							<div className="flex max-w-sm flex-col items-center gap-1.5 text-center">
								<h2 className="text-[14px] font-semibold text-foreground">
									{projectEmpty ? "Nothing to map yet" : "No entities match these filters"}
								</h2>
								<p className="text-[13px] leading-relaxed text-muted-foreground">
									{projectEmpty
										? "Tasks, docs, memories and decisions appear here once the project has some, linked by the references between them."
										: "Turn an entity type back on, or show isolated entities, to bring the graph back."}
								</p>
								{filteredEmpty && filtersChanged && (
									<Button variant="secondary" size="sm" className="mt-2" onClick={resetFilters}>
										Reset filters
									</Button>
								)}
							</div>
						</div>
					)}

					{/* Top left: what the canvas is doing, then the focus the selection put it in. */}
					<div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-2 sm:max-w-[calc(100%-22rem)]">
						{engineRunning && !error && (
							<div
								className="flex items-center gap-2 rounded-[10px] border border-border/70 bg-background/90 px-2.5 py-1.5 text-[12px] text-muted-foreground shadow-xs backdrop-blur-sm"
								aria-live="polite"
							>
								<Spinner className="size-3.5" label="" />
								Arranging communities…
							</div>
						)}
						{impactSummary && (
							<div className="pointer-events-auto flex items-center gap-2 rounded-[10px] border border-border/70 bg-background/90 py-1 pl-2.5 pr-1 text-[12.5px] shadow-xs backdrop-blur-sm">
								<span aria-hidden="true" className="size-1.5 rounded-full bg-[color:var(--kn-accent,var(--primary))]" />
								<span className="font-medium text-foreground">2-hop focus</span>
								<span className="text-muted-foreground">
									Affects {plural(impactSummary.tasks, "task", "tasks")}, {plural(impactSummary.docs, "doc", "docs")}
								</span>
								<Button variant="ghost" size="xs" icon={<X />} aria-label="Clear focus" onClick={clearSelection} />
							</div>
						)}
					</div>

					{!projectEmpty && <GraphTypeKey colors={palette.colors} className="pointer-events-none absolute bottom-3 left-3 z-10 max-md:hidden" />}

					<GraphDetailPanel
						node={selectedNode}
						colors={palette.colors}
						onClose={clearSelection}
						onNavigate={handleNodeNavigate}
						onSelectNode={selectNodeById}
						references={selectedNodeReferences}
					/>
				</main>
			)}

			<TaskPreviewDialog
				taskId={previewTaskId}
				open={Boolean(previewTaskId)}
				onOpenChange={(open) => {
					if (!open) setPreviewTaskId(null);
				}}
			/>
			<DocPreviewDialog
				docPath={previewDocPath}
				open={Boolean(previewDocPath)}
				onOpenChange={(open) => {
					if (!open) setPreviewDocPath(null);
				}}
			/>
			<MemoryPreviewDialog
				memoryId={previewMemoryId}
				open={Boolean(previewMemoryId)}
				onOpenChange={(open) => {
					if (!open) setPreviewMemoryId(null);
				}}
				onOpenSource={(ref) => {
					setPreviewMemoryId(null);
					if (ref.kind === "doc") setPreviewDocPath(ref.path);
					else if (ref.kind === "task") setPreviewTaskId(ref.id);
					else if (ref.kind === "memory") setPreviewMemoryId(ref.id);
					else setPreviewDecisionId(ref.id);
				}}
			/>
			<DecisionPreviewDialog
				decisionId={previewDecisionId}
				open={Boolean(previewDecisionId)}
				onOpenChange={(open) => {
					if (!open) setPreviewDecisionId(null);
				}}
			/>
		</div>
	);
}
