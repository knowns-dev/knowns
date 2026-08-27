import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

import { useTheme } from "@/ui/App";
import { getGraph, type GraphData, type GraphNode } from "@/ui/api/client";
import { DecisionPreviewDialog } from "@/ui/components/organisms/DecisionPreview/DecisionPreviewDialog";
import { DocPreviewDialog } from "@/ui/components/organisms/DocsPreview/DocPreviewDialog";
import { MemoryPreviewDialog } from "@/ui/components/organisms/MemoryPreview/MemoryPreviewDialog";
import { TaskPreviewDialog } from "@/ui/components/organisms/TaskDetail/TaskPreviewDialog";
import { useSSEEvent } from "@/ui/contexts/SSEContext";

import { GraphDetailPanel } from "./GraphDetailPanel";
import {
	buildSelectedNodeReferences,
	DECISION_COLOR,
	DOC_COLOR,
	KNOWLEDGE_FILTERS,
	MEMORY_COLOR,
	TASK_COLOR,
	TEMPLATE_COLOR,
	type FilterState,
} from "./graph/constants";
import {
	buildConstellationData,
	type ConstellationLink,
	type ConstellationNode,
} from "./graph/graphModel";
import { GraphToolbar } from "./graph/GraphToolbar";
import { SigmaConstellation, type SigmaConstellationHandle } from "./graph/SigmaConstellation";
import { useContainerSize } from "./graph/useContainerSize";

const EMPTY_FORCE_DATA: {
	nodes: ConstellationNode[];
	links: ConstellationLink[];
	matches: number;
} = { nodes: [], links: [], matches: 0 };

const GRAPH_TYPE_KEY = [
	{ label: "Tasks", color: TASK_COLOR },
	{ label: "Docs", color: DOC_COLOR },
	{ label: "Memories", color: MEMORY_COLOR },
	{ label: "Decisions", color: DECISION_COLOR },
	{ label: "Templates", color: TEMPLATE_COLOR },
];

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

export default function GraphPage() {
	const graphShellRef = useRef<HTMLDivElement>(null);
	const graphContainerRef = useRef<HTMLDivElement>(null);
	const constellationRef = useRef<SigmaConstellationHandle>(null);
	const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const stableForceDataRef = useRef(EMPTY_FORCE_DATA);
	const { isDark } = useTheme();
	const { width, height } = useContainerSize(graphContainerRef);

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

	const canvasPalette = useMemo(
		() =>
			isDark
				? {
						canvas: "#0b1020",
						labelSurface: "#111a2e",
						labelBorder: "#25314d",
						text: "#e5e7eb",
						nodeOutline: "#0b1020",
						dimNode: "#334155",
						link: "#3f4a63",
						dimLink: "#1b2338",
					}
				: {
						canvas: "#ffffff",
						labelSurface: "#f8fafc",
						labelBorder: "#e2e8f0",
						text: "#111827",
						nodeOutline: "#ffffff",
						dimNode: "#cbd5e1",
						link: "#cbd5e1",
						dimLink: "#eef2f6",
					},
		[isDark],
	);

	const fetchGraph = useCallback(async () => {
		setLoading(true);
		try {
			const graphData = await getGraph({ includeHistorical: includeArchived });
			setData(graphData);
			setError(null);
		} catch (fetchError) {
			setError("We couldn’t load the graph.");
			console.error(fetchError);
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

	useEffect(() => {
		const handleFullscreenChange = () => {
			setIsFullscreen(document.fullscreenElement === graphShellRef.current);
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
		const built = buildConstellationData(filteredData, debouncedSearchQuery);
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
	}, [filteredData, debouncedSearchQuery]);

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
		try {
			if (document.fullscreenElement === graphShellRef.current) await document.exitFullscreen();
			else await graphShellRef.current?.requestFullscreen();
		} catch (fullscreenError) {
			console.error("Unable to toggle graph fullscreen", fullscreenError);
		}
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
			if (event.key === "Escape") clearSelection();
			if (event.key.toLocaleLowerCase() === "f" && !event.metaKey && !event.ctrlKey && !event.altKey) {
				event.preventDefault();
				handleZoomToFit();
			}
		},
		[clearSelection, handleZoomToFit],
	);

	const nodeCount = forceData.nodes.length;
	const edgeCount = forceData.links.length;
	const isEmpty = !loading && !error && filteredData !== null && nodeCount === 0;

	return (
		<div ref={graphShellRef} className="flex min-h-0 flex-1 flex-col bg-background">
			<GraphToolbar
				data={data}
				filters={filters}
				searchQuery={searchQuery}
				searchMatchCount={forceData.matches}
				impactNodeId={impactNodeId}
				isFullscreen={isFullscreen}
				nodeCount={nodeCount}
				edgeCount={edgeCount}
				onToggleFilter={toggleFilter}
				onSearchChange={setSearchQuery}
				onClearImpact={clearSelection}
				onZoomToFit={handleZoomToFit}
				onToggleFullscreen={toggleFullscreen}
				includeArchived={includeArchived}
				onToggleArchived={() => setIncludeArchived((previous) => !previous)}
			/>

			<main
				ref={graphContainerRef}
				role="region"
				aria-label={`Knowledge graph with ${nodeCount} entities and ${edgeCount} relations`}
				aria-describedby="graph-keyboard-help"
				aria-busy={loading}
				tabIndex={0}
				className="relative min-h-0 flex-1 overflow-hidden bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
				onKeyDown={handleCanvasKeyDown}
			>
				<span id="graph-keyboard-help" className="sr-only">
					Drag to pan, scroll to zoom, press F to fit the graph, and press Escape to clear the selected entity.
				</span>

				{filteredData && width > 0 && height > 0 && (
					<SigmaConstellation
						ref={constellationRef}
						nodes={forceData.nodes}
						links={forceData.links}
						palette={canvasPalette}
						selectedNodeId={selectedNode?.id ?? null}
						impactNeighborhood={impactNeighborhood}
						searchActive={forceData.matches > 0}
						compact={width < 640}
						onSelectNode={selectNode}
						onBackgroundClick={clearSelection}
						onEngineRunningChange={setEngineRunning}
					/>
				)}

				<div className="pointer-events-none absolute bottom-3 left-3 z-10 hidden items-center gap-3 rounded-md border border-border bg-background px-3 py-2 shadow-sm lg:flex">
					{GRAPH_TYPE_KEY.map((item) => (
						<span key={item.label} className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
							<span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
							{item.label}
						</span>
					))}
				</div>

				{loading && (
					<div className="absolute inset-0 z-20 flex items-center justify-center bg-background" aria-live="polite">
						<div className="w-64 space-y-4 text-center">
							<div className="relative mx-auto h-24 w-40 motion-safe:animate-pulse" aria-hidden="true">
								<span className="absolute left-4 top-8 h-8 w-8 rounded-full bg-muted" />
								<span className="absolute left-16 top-2 h-11 w-11 rounded-full bg-muted" />
								<span className="absolute right-3 top-12 h-7 w-7 rounded-full bg-muted" />
								<span className="absolute left-9 top-12 h-px w-14 rotate-[-25deg] bg-border" />
								<span className="absolute right-8 top-10 h-px w-12 rotate-[28deg] bg-border" />
							</div>
							<div>
								<div className="text-sm font-medium text-foreground">Mapping your knowledge</div>
								<div className="mt-1 text-xs text-muted-foreground">Finding communities and high-impact entities…</div>
							</div>
						</div>
					</div>
				)}

				{error && !loading && (
					<div className="absolute inset-0 z-20 flex items-center justify-center bg-background px-6" role="alert">
						<div className="max-w-sm text-center">
							<AlertCircle aria-hidden="true" className="mx-auto h-7 w-7 text-destructive" />
							<h2 className="mt-3 text-sm font-semibold text-foreground">{error}</h2>
							<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
								Check that the local server is running, then try again.
							</p>
							<button
								type="button"
								onClick={fetchGraph}
								className="mt-4 inline-flex h-11 items-center gap-2 rounded-md border border-border px-4 text-xs font-semibold text-foreground transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
								Retry
							</button>
						</div>
					</div>
				)}

				{isEmpty && (
					<div className="absolute inset-0 z-20 flex items-center justify-center bg-background px-6">
						<div className="max-w-sm text-center">
							<h2 className="text-sm font-semibold text-foreground">No entities match these filters</h2>
							<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
								Open Filters and turn on an entity type to bring the constellation back.
							</p>
						</div>
					</div>
				)}

				{engineRunning && !loading && !error && (
					<div
						className="pointer-events-none absolute left-3 top-3 z-10 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[0.6875rem] text-muted-foreground shadow-sm"
						aria-live="polite"
					>
						Arranging communities…
					</div>
				)}

				{impactSummary && (
					<div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-lg border border-border bg-background/95 px-4 py-2 text-xs shadow-lg backdrop-blur-sm">
						<span className="font-medium text-foreground">Impact: </span>
						<span className="text-muted-foreground">
							Affects {impactSummary.tasks} task{impactSummary.tasks !== 1 ? "s" : ""}, {impactSummary.docs} doc
							{impactSummary.docs !== 1 ? "s" : ""}
						</span>
					</div>
				)}

				<div className="absolute right-3 top-3 z-10">
					<GraphDetailPanel
						node={selectedNode}
						onClose={clearSelection}
						onNavigate={handleNodeNavigate}
						onSelectNode={selectNodeById}
						references={selectedNodeReferences}
					/>
				</div>
			</main>

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
