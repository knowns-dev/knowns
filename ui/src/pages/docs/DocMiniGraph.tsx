import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { X } from "lucide-react";

import { type GraphData, type GraphEdge, type GraphNode, getGraph } from "../../api/client";
import { navigateTo } from "../../lib/navigation";

type MiniForceNode = GraphNode & {
	color: string;
	val: number;
	x?: number;
	y?: number;
	isCurrent?: boolean;
};

type MiniForceLink = GraphEdge & {
	id: string;
	source: string | MiniForceNode;
	target: string | MiniForceNode;
	color: string;
};

const MINI_HEIGHT = 140;

function nodeSize(node: GraphNode, isCurrent: boolean): number {
	if (isCurrent) return 6;
	switch (node.type) {
	case "task":
		return 4;
	case "doc":
		return 4;
	case "memory":
		return 3.5;
	default:
		return 3.5;
	}
}

function nodeColor(node: GraphNode): string {
	switch (node.type) {
	case "task":
		return "#6366f1";
	case "doc":
		return "#f59e0b";
	case "memory":
		return "#22c55e";
	default:
		return "#94a3b8";
	}
}

function edgeColor(edge: GraphEdge): string {
	switch (edge.type) {
	case "spec":
		return "#6366f1";
	case "parent":
		return "#94a3b8";
	case "mention":
	case "references":
		return "#64748b";
	case "implements":
		return "#6366f1";
	case "blocked-by":
		return "#ef4444";
	case "related":
		return "#8b5cf6";
	case "depends":
		return "#0ea5e9";
	case "follows":
		return "#22c55e";
	default:
		return "#94a3b8";
	}
}

function shortLabel(node: MiniForceNode, maxLen = 22): string {
	const label = node.label || node.id;
	const value = node.type === "doc" ? label.replace(/\.md$/, "") : label;
	return value.length > maxLen ? `${value.slice(0, maxLen - 2)}…` : value;
}

function GraphCanvas({
	forceData,
	docNodeId,
	width,
	height,
	isDark,
	onNodeClick,
	graphRef,
}: {
	forceData: { nodes: MiniForceNode[]; links: MiniForceLink[] };
	docNodeId: string;
	width: number;
	height: number;
	isDark: boolean;
	onNodeClick: (node: MiniForceNode) => void;
	graphRef: React.MutableRefObject<ForceGraphMethods<MiniForceNode, MiniForceLink> | undefined>;
}) {
	return (
		<ForceGraph2D
			ref={graphRef}
			width={width}
			height={height}
			graphData={forceData}
			backgroundColor="rgba(0,0,0,0)"
			minZoom={0.3}
			maxZoom={6}
			d3AlphaDecay={0.08}
			d3VelocityDecay={0.4}
			cooldownTicks={60}
			cooldownTime={2000}
			enableZoomInteraction={true}
			enablePanInteraction={true}
			nodeLabel={() => ""}
			nodeVal={(node) => node.val}
			nodeColor={(node) => node.color}
			linkColor={(link) => (link as MiniForceLink).color}
			linkWidth={1.5}
			linkDirectionalArrowLength={4}
			linkDirectionalArrowRelPos={1}
			nodeCanvasObjectMode={() => "replace"}
			onNodeClick={onNodeClick}
			nodeCanvasObject={(node, ctx, globalScale) => {
				const x = node.x ?? 0;
				const y = node.y ?? 0;
				const r = node.val;

				if (node.isCurrent) {
					ctx.beginPath();
					ctx.arc(x, y, r + 4, 0, 2 * Math.PI, false);
					ctx.strokeStyle = node.color;
					ctx.lineWidth = 2;
					ctx.globalAlpha = 0.65;
					ctx.stroke();
					ctx.globalAlpha = 1;
				}

				ctx.beginPath();
				ctx.arc(x, y, r, 0, 2 * Math.PI, false);
				ctx.fillStyle = node.color;
				ctx.fill();

				const fontSize = Math.min(12 / globalScale, 14);
				ctx.font = `${fontSize}px Sans-Serif`;
				ctx.textAlign = "left";
				ctx.textBaseline = "middle";
				ctx.fillStyle = isDark ? "#e5e7eb" : "#374151";
				ctx.fillText(shortLabel(node, height > 300 ? 40 : 22), x + r + 2, y);
			}}
		/>
	);
}

export function DocMiniGraph({ docPath }: { docPath: string }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const miniGraphRef = useRef<ForceGraphMethods<MiniForceNode, MiniForceLink> | undefined>(undefined);
	const popupGraphRef = useRef<ForceGraphMethods<MiniForceNode, MiniForceLink> | undefined>(undefined);
	const popupContainerRef = useRef<HTMLDivElement>(null);
	const [miniWidth, setMiniWidth] = useState(0);
	const [popupSize, setPopupSize] = useState({ width: 0, height: 0 });
	const [graphData, setGraphData] = useState<GraphData | null>(null);
	const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));
	const [popupOpen, setPopupOpen] = useState(false);
	const normalizedPath = docPath.replace(/\.md$/, "");
	const docNodeId = `doc:${normalizedPath}`;

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const measure = () => setMiniWidth(el.clientWidth);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		const raf = requestAnimationFrame(measure);
		return () => { ro.disconnect(); cancelAnimationFrame(raf); };
	}, []);

	useEffect(() => {
		let cancelled = false;
		getGraph()
			.then((data) => {
				if (!cancelled) setGraphData(data);
			})
			.catch((err) => console.error("Failed to load doc graph:", err));
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		const update = () => setIsDark(document.documentElement.classList.contains("dark"));
		const observer = new MutationObserver(update);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
		return () => observer.disconnect();
	}, []);

	const forceData = useMemo(() => {
		if (!graphData) return { nodes: [], links: [] };
		console.log("[DocMiniGraph] docNodeId:", docNodeId, "| total nodes:", graphData.nodes.length, "| total edges:", graphData.edges.length);
		const edges = graphData.edges.filter((edge) => edge.source === docNodeId || edge.target === docNodeId);
		console.log("[DocMiniGraph] matching edges:", edges.length);

		const ids = new Set<string>([docNodeId]);
		edges.forEach((edge) => {
			ids.add(edge.source);
			ids.add(edge.target);
		});

		const nodes = graphData.nodes
			.filter((node) => ids.has(node.id))
			.map((node) => ({
				...node,
				color: nodeColor(node),
				val: nodeSize(node, node.id === docNodeId),
				isCurrent: node.id === docNodeId,
			}));

		if (nodes.length === 0) {
			const currentNode = graphData.nodes.find((n) => n.id === docNodeId);
			if (currentNode) {
				nodes.push({
					...currentNode,
					color: nodeColor(currentNode),
					val: nodeSize(currentNode, true),
					isCurrent: true,
				});
			}
		}

		const links = edges.map((edge, index) => ({
			...edge,
			id: `${edge.source}->${edge.target}:${edge.type}:${index}`,
			color: edgeColor(edge),
		}));

		return { nodes, links };
	}, [docNodeId, graphData]);

	useEffect(() => {
		if (forceData.nodes.length > 0 && miniWidth > 0) {
			window.setTimeout(() => miniGraphRef.current?.zoomToFit(300, 30), 120);
		}
	}, [forceData.nodes.length, forceData.links.length, miniWidth]);

	useEffect(() => {
		if (!popupOpen) return;
		const el = popupContainerRef.current;
		if (!el) return;
		const measure = () => setPopupSize({ width: el.clientWidth, height: el.clientHeight });
		const raf = requestAnimationFrame(measure);
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => { cancelAnimationFrame(raf); ro.disconnect(); };
	}, [popupOpen]);

	const handleNodeClick = useCallback((node: MiniForceNode) => {
		if (node.isCurrent) return;
		if (node.type === "doc") {
			setPopupOpen(false);
			void navigateTo(`/docs/${node.id.replace("doc:", "").replace(/\.md$/, "")}`);
		} else if (node.type === "task") {
			setPopupOpen(false);
			void navigateTo(`/tasks/${node.id.replace("task:", "")}`);
		}
	}, []);

	useEffect(() => {
		if (!popupOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setPopupOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [popupOpen]);

	if (!graphData) return null;

	console.log("[DocMiniGraph] rendering, miniWidth:", miniWidth, "nodes:", forceData.nodes.length, "links:", forceData.links.length);

	const effectiveWidth = miniWidth || 200;

	return (
		<>
			<div
				ref={containerRef}
				className="h-[140px] w-full shrink-0 cursor-pointer overflow-hidden rounded-xl border bg-card transition-colors hover:border-foreground/20"
				onClick={() => setPopupOpen(true)}
				title="Connections: click to expand the graph"
			>
				<GraphCanvas
					forceData={forceData}
					docNodeId={docNodeId}
					width={effectiveWidth}
					height={MINI_HEIGHT}
					isDark={isDark}
					onNodeClick={handleNodeClick}
					graphRef={miniGraphRef}
				/>
			</div>

			{popupOpen && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
					onClick={(e) => {
						if (e.target === e.currentTarget) setPopupOpen(false);
					}}
				>
					<div className="relative w-[90vw] h-[80vh] max-w-[1200px] max-h-[800px] rounded-xl border border-border bg-background shadow-2xl overflow-hidden">
						<div className="absolute top-3 right-3 z-10">
							<button
								onClick={() => setPopupOpen(false)}
								className="p-1.5 rounded-md hover:bg-muted transition-colors"
							>
								<X className="w-5 h-5" />
							</button>
						</div>
						<div className="absolute top-3 left-4 z-10 text-sm text-muted-foreground">
							{normalizedPath} — {forceData.nodes.length} nodes, {forceData.links.length} edges
						</div>
						<div ref={popupContainerRef} className="w-full h-full pt-10">
							{popupSize.width > 0 && popupSize.height > 0 && (
								<GraphCanvas
									forceData={forceData}
									docNodeId={docNodeId}
									width={popupSize.width}
									height={popupSize.height - 40}
									isDark={isDark}
									onNodeClick={handleNodeClick}
									graphRef={popupGraphRef}
								/>
							)}
						</div>
					</div>
				</div>
			)}
		</>
	);
}
