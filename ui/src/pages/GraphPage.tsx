import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { AlertCircle, RefreshCw } from "lucide-react";

import { useTheme } from "@/ui/App";
import { getGraph, type GraphData, type GraphNode } from "@/ui/api/client";
import { DocPreviewDialog } from "@/ui/components/organisms/DocsPreview/DocPreviewDialog";
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
	createConstellationForce,
	edgeColor,
	linkNodeId,
	shouldDrawConstellationLabel,
	type ConstellationLink,
	type ConstellationNode,
} from "./graph/graphModel";
import { GraphToolbar } from "./graph/GraphToolbar";
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

function truncateLabel(label: string, maxLength = 36): string {
	return label.length > maxLength ? `${label.slice(0, maxLength - 1)}…` : label;
}

function isLinkInNeighborhood(link: ConstellationLink, neighborhood: Map<string, number> | null): boolean {
	if (!neighborhood) return true;
	return neighborhood.has(linkNodeId(link.source)) && neighborhood.has(linkNodeId(link.target));
}

interface LabelRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

function labelRectsOverlap(a: LabelRect, b: LabelRect, gap: number): boolean {
	return !(
		a.x + a.width + gap < b.x ||
		b.x + b.width + gap < a.x ||
		a.y + a.height + gap < b.y ||
		b.y + b.height + gap < a.y
	);
}

export default function GraphPage() {
	const graphShellRef = useRef<HTMLDivElement>(null);
	const graphContainerRef = useRef<HTMLDivElement>(null);
	const graphRef = useRef<ForceGraphMethods<ConstellationNode, ConstellationLink> | undefined>(undefined);
	const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const initialFitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const stableForceDataRef = useRef(EMPTY_FORCE_DATA);
	const hoverNodeIdRef = useRef<string | null>(null);
	const didInitialFitRef = useRef(false);
	const { isDark } = useTheme();
	const { width, height } = useContainerSize(graphContainerRef);

	const [data, setData] = useState<GraphData | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [filters, setFilters] = useState<FilterState>(KNOWLEDGE_FILTERS);
	const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
	const [previewTaskId, setPreviewTaskId] = useState<string | null>(null);
	const [previewDocPath, setPreviewDocPath] = useState<string | null>(null);
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
			const graphData = await getGraph();
			setData(graphData);
			setError(null);
			didInitialFitRef.current = false;
		} catch (fetchError) {
			setError("We couldn’t load the graph.");
			console.error(fetchError);
		} finally {
			setLoading(false);
		}
	}, []);

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
		const next = buildConstellationData(filteredData, debouncedSearchQuery);
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

	const structureKey = useMemo(
		() => `${forceData.nodes.map((node) => node.id).join("|")}::${forceData.links.map((link) => link.id).join("|")}`,
		[forceData.nodes, forceData.links],
	);

	const fitView = useCallback((durationMs: number, padding: number) => {
		graphRef.current?.zoomToFit(durationMs, padding);
	}, []);

	useEffect(() => {
		if (!filteredData || forceData.nodes.length === 0 || width <= 0 || height <= 0) {
			setEngineRunning(false);
			return;
		}

		setEngineRunning(true);
		const frame = requestAnimationFrame(() => {
			const graph = graphRef.current;
			if (!graph) return;

			graph.d3Force("center", null);
			graph.d3Force("constellation", createConstellationForce());

			const charge = graph.d3Force("charge") as
				| {
						strength: (accessor: (node: ConstellationNode) => number) => unknown;
						distanceMax: (distance: number) => unknown;
					}
				| undefined;
			charge?.strength((node) => (node.isIsolated ? -10 : -34 - Math.sqrt(node.degree + 1) * 9));
			charge?.distanceMax(260);

			const linkForce = graph.d3Force("link") as
				| {
						distance: (accessor: (link: ConstellationLink) => number) => unknown;
						strength: (accessor: (link: ConstellationLink) => number) => unknown;
					}
				| undefined;
			linkForce?.distance((link) => {
				const source = typeof link.source === "string" ? undefined : link.source;
				const target = typeof link.target === "string" ? undefined : link.target;
				return 26 + Math.min(34, ((source?.degree ?? 0) + (target?.degree ?? 0)) * 1.4);
			});
			linkForce?.strength((link) => (link.type === "parent" || link.type === "spec" ? 0.42 : 0.28));

			graph.d3ReheatSimulation();
			if (!didInitialFitRef.current) {
				if (initialFitTimerRef.current) clearTimeout(initialFitTimerRef.current);
				initialFitTimerRef.current = setTimeout(() => {
					fitView(0, 64);
					didInitialFitRef.current = true;
				}, 80);
			}
		});

		return () => {
			cancelAnimationFrame(frame);
			if (initialFitTimerRef.current) clearTimeout(initialFitTimerRef.current);
		};
	}, [filteredData, fitView, forceData.nodes.length, height, structureKey, width]);

	const toggleFilter = useCallback((key: keyof FilterState) => {
		setFilters((previous) => ({ ...previous, [key]: !previous[key] }));
		setSelectedNode(null);
		setImpactNodeId(null);
		didInitialFitRef.current = false;
	}, []);

	const selectedNodeReferences = useMemo(
		() => buildSelectedNodeReferences(filteredData, selectedNode),
		[filteredData, selectedNode],
	);

	const handleZoomToFit = useCallback(() => {
		fitView(350, 56);
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

	const handleNodeNavigate = useCallback((node: GraphNode) => {
		const [type, ...rest] = node.id.split(":");
		const entityId = rest.join(":");
		if (type === "task") setPreviewTaskId(entityId);
		else if (type === "doc") setPreviewDocPath(entityId);
	}, []);

	const selectNode = useCallback((node: ConstellationNode) => {
		setSelectedNode(toGraphNode(node));
		setImpactNodeId(node.id);
		if (typeof node.x === "number" && typeof node.y === "number") {
			graphRef.current?.centerAt(node.x, node.y, 250);
			const currentZoom = graphRef.current?.zoom() ?? 1;
			if (currentZoom < 1.15) graphRef.current?.zoom(1.15, 250);
		}
	}, []);

	const selectNodeById = useCallback(
		(id: string) => {
			const node = stableForceDataRef.current.nodes.find((candidate) => candidate.id === id);
			if (node) selectNode(node);
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
					<ForceGraph2D
						ref={graphRef}
						width={width}
						height={height}
						graphData={{ nodes: forceData.nodes, links: forceData.links }}
						backgroundColor={canvasPalette.canvas}
						minZoom={0.08}
						maxZoom={8}
						enableZoomInteraction
						enablePanInteraction
						enablePointerInteraction={forceData.nodes.length < 2_000}
						d3AlphaDecay={0.042}
						d3VelocityDecay={0.32}
						warmupTicks={0}
						cooldownTicks={110}
						cooldownTime={3_500}
						onEngineStop={() => setEngineRunning(false)}
						onRenderFramePost={(context, globalScale) => {
							const occupiedLabels: LabelRect[] = [];
							const candidates: ConstellationNode[] = [];
							const selectedForceNode = selectedNode
								? forceData.nodes.find((node) => node.id === selectedNode.id)
								: undefined;
							const hoveredForceNode = hoverNodeIdRef.current
								? forceData.nodes.find((node) => node.id === hoverNodeIdRef.current)
								: undefined;
							if (selectedForceNode) candidates.push(selectedForceNode);
							if (hoveredForceNode && hoveredForceNode.id !== selectedForceNode?.id) candidates.push(hoveredForceNode);
							if (forceData.matches > 0) {
								for (const node of forceData.nodes) {
									if (node.highlighted) candidates.push(node);
								}
							}
							candidates.push(...forceData.nodes);

							const rendered = new Set<string>();
							for (const graphNode of candidates) {
								if (rendered.has(graphNode.id)) continue;
								rendered.add(graphNode.id);

								const isSelected = selectedNode?.id === graphNode.id;
								const isHovered = hoverNodeIdRef.current === graphNode.id;
								const focusDistance = impactNeighborhood?.get(graphNode.id);
								const isFocusMode = impactNeighborhood !== null;
								const isSearchMatch = forceData.matches > 0 && graphNode.highlighted;
								const isCompact = width < 640;
								if (
									!shouldDrawConstellationLabel(graphNode, globalScale, {
										isSelected,
										isHovered,
										isFocusMode,
										isSearchMatch,
										isCompact,
									})
								) {
									continue;
								}

								const x = graphNode.x ?? 0;
								const y = graphNode.y ?? 0;
								const minimumScreenRadius = graphNode.isIsolated ? 1.4 : 2.4;
								const radius = Math.max(graphNode.val, minimumScreenRadius / Math.max(globalScale, 0.08));
								const label = truncateLabel(graphNode.label || graphNode.id, isCompact ? 24 : 36);
								const fontSize = (isSelected ? 11.5 : 10.5) / globalScale;
								const fontWeight = isSelected || graphNode.labelRank < 15 ? 600 : 500;
								context.font = `${fontWeight} ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
								const textWidth = context.measureText(label).width;
								const paddingX = 3 / globalScale;
								const paddingY = 2 / globalScale;
								const placeLeft = !isSelected && graphNode.labelRank % 2 === 1;
								const verticalOffset = isSelected ? 0 : ((graphNode.labelRank % 3) - 1) * fontSize * 0.8;
								const mayOverlap = isSelected || isHovered;
								const labelHeight = fontSize + paddingY * 2;
								const horizontalGap = 3 / globalScale;
								const rightPosition = {
									x: x + radius + horizontalGap,
									y: y - fontSize / 2 - paddingY + verticalOffset,
								};
								const leftPosition = {
									x: x - radius - horizontalGap - textWidth,
									y: y - fontSize / 2 - paddingY + verticalOffset,
								};
								const topPosition = {
									x: x - textWidth / 2,
									y: y - radius - horizontalGap - labelHeight,
								};
								const bottomPosition = {
									x: x - textWidth / 2,
									y: y + radius + horizontalGap,
								};
								const positionOptions = placeLeft
									? [leftPosition, rightPosition, topPosition, bottomPosition]
									: [rightPosition, leftPosition, topPosition, bottomPosition];
								const placement = positionOptions
									.map(({ x: labelX, y: labelY }) => ({
										labelX,
										labelY,
										rect: {
											x: labelX - paddingX,
											y: labelY,
											width: textWidth + paddingX * 2,
											height: labelHeight,
										},
									}))
									.find(
										(candidate) =>
											mayOverlap ||
											!occupiedLabels.some((occupied) =>
												labelRectsOverlap(candidate.rect, occupied, 3 / globalScale),
											),
									);
								if (!placement) continue;
								const { labelX, labelY, rect } = placement;
								occupiedLabels.push(rect);

								const isFocusActive = !impactNeighborhood || typeof focusDistance === "number";
								context.globalAlpha = isFocusActive ? 0.96 : 0.35;
								context.fillStyle = canvasPalette.labelSurface;
								context.fillRect(rect.x, rect.y, rect.width, rect.height);
								context.strokeStyle = canvasPalette.labelBorder;
								context.lineWidth = 0.65 / globalScale;
								context.strokeRect(rect.x, rect.y, rect.width, rect.height);
								context.fillStyle = canvasPalette.text;
								context.textBaseline = "middle";
								context.fillText(label, labelX, labelY + fontSize / 2 + paddingY);
								context.globalAlpha = 1;
							}
						}}
						nodeLabel={() => ""}
						nodeVal={(node) => (node as ConstellationNode).val}
						nodeColor={(node) => (node as ConstellationNode).color}
						nodePointerAreaPaint={(node, paintColor, context, globalScale) => {
							const graphNode = node as ConstellationNode;
							const radius = Math.max(graphNode.val + 2, 7 / globalScale);
							context.beginPath();
							context.arc(graphNode.x ?? 0, graphNode.y ?? 0, radius, 0, Math.PI * 2);
							context.fillStyle = paintColor;
							context.fill();
						}}
						linkColor={(link) => {
							const graphLink = link as ConstellationLink;
							if (!isLinkInNeighborhood(graphLink, impactNeighborhood)) return canvasPalette.dimLink;
							if (impactNeighborhood) return edgeColor(graphLink);
							if (graphLink.muted) return canvasPalette.dimLink;
							return canvasPalette.link;
						}}
						linkWidth={(link) => {
							const graphLink = link as ConstellationLink;
							if (!isLinkInNeighborhood(graphLink, impactNeighborhood)) return 0.25;
							if (!impactNeighborhood) return graphLink.width;
							const sourceDistance = impactNeighborhood.get(linkNodeId(graphLink.source));
							const targetDistance = impactNeighborhood.get(linkNodeId(graphLink.target));
							return sourceDistance === 0 || targetDistance === 0 ? 1.45 : 0.9;
						}}
						linkLineDash={(link) => ((link as ConstellationLink).dashed ? [3, 3] : null)}
						linkDirectionalArrowLength={(link) => {
							const graphLink = link as ConstellationLink;
							if (!impactNeighborhood || !isLinkInNeighborhood(graphLink, impactNeighborhood)) return 0;
							const sourceDistance = impactNeighborhood.get(linkNodeId(graphLink.source));
							const targetDistance = impactNeighborhood.get(linkNodeId(graphLink.target));
							return sourceDistance === 0 || targetDistance === 0 ? 2.5 : 0;
						}}
						linkDirectionalArrowColor={(link) => edgeColor(link as ConstellationLink)}
						linkDirectionalArrowRelPos={0.92}
						onNodeClick={(node) => selectNode(node as ConstellationNode)}
						onNodeHover={(node) => {
							hoverNodeIdRef.current = node ? String(node.id) : null;
						}}
						onNodeDragEnd={(node) => {
							const graphNode = node as ConstellationNode;
							graphNode.fx = graphNode.x;
							graphNode.fy = graphNode.y;
						}}
						onBackgroundClick={clearSelection}
						nodeCanvasObject={(node, context, globalScale) => {
							const graphNode = node as ConstellationNode;
							const x = graphNode.x ?? 0;
							const y = graphNode.y ?? 0;
							const minimumScreenRadius = graphNode.isIsolated ? 1.4 : 2.4;
							const radius = Math.max(graphNode.val, minimumScreenRadius / Math.max(globalScale, 0.08));
							const isSelected = selectedNode?.id === graphNode.id;
							const focusDistance = impactNeighborhood?.get(graphNode.id);
							const isFocusActive = !impactNeighborhood || typeof focusDistance === "number";
							const opacity = !isFocusActive
								? 0.16
								: focusDistance === 2
									? 0.64
									: graphNode.isIsolated
										? 0.62
										: graphNode.highlighted
											? 1
											: 0.24;
							const displayColor = isFocusActive && graphNode.highlighted ? graphNode.color : canvasPalette.dimNode;

							if (graphNode.degree >= 8 && isFocusActive) {
								context.beginPath();
								context.arc(x, y, radius + 2.2, 0, Math.PI * 2);
								context.strokeStyle = graphNode.color;
								context.lineWidth = 0.8;
								context.globalAlpha = opacity * 0.42;
								context.stroke();
							}

							if (isSelected) {
								context.beginPath();
								context.arc(x, y, radius + 4.5, 0, Math.PI * 2);
								context.strokeStyle = canvasPalette.text;
								context.lineWidth = 1.35 / Math.max(globalScale, 0.45);
								context.globalAlpha = 0.95;
								context.stroke();
								context.beginPath();
								context.arc(x, y, radius + 2.1, 0, Math.PI * 2);
								context.strokeStyle = graphNode.color;
								context.lineWidth = 1.1 / Math.max(globalScale, 0.45);
								context.stroke();
							}

							context.beginPath();
							context.arc(x, y, radius, 0, Math.PI * 2);
							context.fillStyle = displayColor;
							context.globalAlpha = opacity;
							context.fill();
							context.strokeStyle = canvasPalette.nodeOutline;
							context.lineWidth = 0.8 / Math.max(globalScale, 0.5);
							context.stroke();
							context.globalAlpha = 1;
						}}
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
						onShowImpact={setImpactNodeId}
						onSelectNode={selectNodeById}
						impactActive={Boolean(impactNodeId)}
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
		</div>
	);
}
