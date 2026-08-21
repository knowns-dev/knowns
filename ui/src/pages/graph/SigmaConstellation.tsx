import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import { forceLink, forceManyBody, forceSimulation, type Simulation } from "d3-force";

import {
	createConstellationForce,
	edgeColor,
	linkNodeId,
	shouldDrawConstellationLabel,
	type ConstellationLink,
	type ConstellationNode,
} from "./graphModel";

export interface ConstellationPalette {
	canvas: string;
	labelSurface: string;
	labelBorder: string;
	text: string;
	nodeOutline: string;
	dimNode: string;
	link: string;
	dimLink: string;
}

export interface SigmaConstellationHandle {
	/** Frame the whole graph. */
	fitView(): void;
	/** Bring one node to the middle of the viewport, zooming in a little if needed. */
	centerOnNode(id: string): void;
	zoomBy(factor: number): void;
}

interface SigmaConstellationProps {
	nodes: ConstellationNode[];
	links: ConstellationLink[];
	palette: ConstellationPalette;
	selectedNodeId: string | null;
	impactNeighborhood: Map<string, number> | null;
	searchActive: boolean;
	compact: boolean;
	onSelectNode(node: ConstellationNode): void;
	onBackgroundClick(): void;
	onEngineRunningChange(running: boolean): void;
}

/** Mirrors the old force-graph props: stop once the layout has visibly settled. */
const COOLDOWN_TICKS = 110;
const COOLDOWN_MS = 3_500;
const ALPHA_DECAY = 0.042;
const VELOCITY_DECAY = 0.32;

/** sigma works in camera ratios, which are the inverse of the old zoom factors. */
const MIN_CAMERA_RATIO = 1 / 8;
const MAX_CAMERA_RATIO = 1 / 0.08;

function withAlpha(color: string, alpha: number): string {
	if (alpha >= 0.999) return color;
	if (color.startsWith("#") && (color.length === 7 || color.length === 4)) {
		const full =
			color.length === 4 ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}` : color;
		const r = Number.parseInt(full.slice(1, 3), 16);
		const g = Number.parseInt(full.slice(3, 5), 16);
		const b = Number.parseInt(full.slice(5, 7), 16);
		return `rgba(${r},${g},${b},${alpha})`;
	}
	return color;
}

function truncateLabel(label: string, maxLength: number): string {
	return label.length > maxLength ? `${label.slice(0, maxLength - 1)}…` : label;
}

export const SigmaConstellation = forwardRef<SigmaConstellationHandle, SigmaConstellationProps>(
	function SigmaConstellation(
		{
			nodes,
			links,
			palette,
			selectedNodeId,
			impactNeighborhood,
			searchActive,
			compact,
			onSelectNode,
			onBackgroundClick,
			onEngineRunningChange,
		},
		ref,
	) {
		const containerRef = useRef<HTMLDivElement>(null);
		const sigmaRef = useRef<Sigma | null>(null);
		const graphRef = useRef<Graph | null>(null);
		const simulationRef = useRef<Simulation<ConstellationNode, ConstellationLink> | null>(null);

		// The reducers run on every sigma frame, so they read live state through refs
		// rather than being rebuilt (and re-registered) whenever a prop changes.
		const nodeIndexRef = useRef(new Map<string, ConstellationNode>());
		const linkIndexRef = useRef(new Map<string, ConstellationLink>());
		const paletteRef = useRef(palette);
		const selectedRef = useRef(selectedNodeId);
		const impactRef = useRef(impactNeighborhood);
		const searchRef = useRef(searchActive);
		const compactRef = useRef(compact);
		const hoveredRef = useRef<string | null>(null);
		const onSelectNodeRef = useRef(onSelectNode);
		const onBackgroundClickRef = useRef(onBackgroundClick);
		const onEngineRunningChangeRef = useRef(onEngineRunningChange);

		paletteRef.current = palette;
		selectedRef.current = selectedNodeId;
		impactRef.current = impactNeighborhood;
		searchRef.current = searchActive;
		compactRef.current = compact;
		onSelectNodeRef.current = onSelectNode;
		onBackgroundClickRef.current = onBackgroundClick;
		onEngineRunningChangeRef.current = onEngineRunningChange;

		const drawRings = useCallback(() => {
			const sigma = sigmaRef.current;
			if (!sigma) return;
			const canvas = sigma.getCanvases().rings;
			const context = canvas?.getContext("2d");
			if (!canvas || !context) return;

			// sigma only resizes the layers it owns a 2d context for, and createCanvas
			// does not register one, so this layer keeps its own sizing in step.
			const { width, height } = sigma.getDimensions();
			const pixelRatio = window.devicePixelRatio || 1;
			if (canvas.width !== Math.round(width * pixelRatio)) {
				canvas.width = Math.round(width * pixelRatio);
				canvas.height = Math.round(height * pixelRatio);
				canvas.style.width = `${width}px`;
				canvas.style.height = `${height}px`;
			}
			context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
			context.clearRect(0, 0, width, height);

			const colors = paletteRef.current;
			const impact = impactRef.current;
			const selected = selectedRef.current;

			for (const node of nodeIndexRef.current.values()) {
				const display = sigma.getNodeDisplayData(node.id);
				if (!display) continue;
				const focusDistance = impact?.get(node.id);
				const inFocus = !impact || typeof focusDistance === "number";
				// Display data is in sigma's framed (normalised) space and its size is
				// unscaled, so both need converting before they mean screen pixels.
				const point = sigma.framedGraphToViewport({ x: display.x, y: display.y });
				const radius = sigma.scaleSize(display.size);

				// Faint corona so the busiest hubs read as hubs at a glance.
				if (node.degree >= 8 && inFocus) {
					context.beginPath();
					context.arc(point.x, point.y, radius + 3.2, 0, Math.PI * 2);
					context.strokeStyle = withAlpha(node.color, 0.42);
					context.lineWidth = 1;
					context.stroke();
				}

				if (selected === node.id) {
					context.beginPath();
					context.arc(point.x, point.y, radius + 6, 0, Math.PI * 2);
					context.strokeStyle = colors.text;
					context.lineWidth = 1.6;
					context.stroke();
					context.beginPath();
					context.arc(point.x, point.y, radius + 3.2, 0, Math.PI * 2);
					context.strokeStyle = node.color;
					context.lineWidth = 1.3;
					context.stroke();
				}
			}
		}, []);

		// Create the renderer once and keep it for the life of the component. Data
		// changes go through graphology, not through tearing sigma down.
		useEffect(() => {
			const container = containerRef.current;
			if (!container) return;

			const graph = new Graph({ multi: true, type: "undirected" });
			graphRef.current = graph;

			const sigma = new Sigma(graph, container, {
				allowInvalidContainer: true,
				renderLabels: true,
				renderEdgeLabels: false,
				enableEdgeEvents: false,
				zIndex: true,
				minCameraRatio: MIN_CAMERA_RATIO,
				maxCameraRatio: MAX_CAMERA_RATIO,
				stagePadding: 48,
				labelFont: "var(--app-font-sans), system-ui, sans-serif",
				labelSize: 11,
				labelWeight: "500",
				labelColor: { color: palette.text },
				labelDensity: 0.6,
				labelGridCellSize: 70,
				defaultDrawNodeLabel: (context, data) => {
					if (!data.label) return;
					const colors = paletteRef.current;
					context.font = `500 11px var(--app-font-sans), system-ui, sans-serif`;
					const text = data.label;
					const metrics = context.measureText(text);
					const paddingX = 4;
					const paddingY = 3;
					const boxWidth = metrics.width + paddingX * 2;
					const boxHeight = 15;
					const left = data.x + data.size + 5;
					const top = data.y - boxHeight / 2;

					context.fillStyle = colors.labelSurface;
					context.strokeStyle = colors.labelBorder;
					context.lineWidth = 1;
					context.beginPath();
					context.roundRect(left, top, boxWidth, boxHeight, 3);
					context.fill();
					context.stroke();

					context.fillStyle = colors.text;
					context.fillText(text, left + paddingX, top + boxHeight - paddingY - 1);
				},
				nodeReducer: (id, data) => {
					const node = nodeIndexRef.current.get(id);
					if (!node) return data;

					const colors = paletteRef.current;
					const impact = impactRef.current;
					const focusDistance = impact?.get(id);
					const inFocus = !impact || typeof focusDistance === "number";
					const isSelected = selectedRef.current === id;
					const isHovered = hoveredRef.current === id;

					const opacity = !inFocus
						? 0.16
						: focusDistance === 2
							? 0.64
							: node.isIsolated
								? 0.62
								: node.highlighted
									? 1
									: 0.24;
					const baseColor = inFocus && node.highlighted ? node.color : colors.dimNode;

					const camera = sigmaRef.current?.getCamera().getState();
					const scale = camera ? 1 / camera.ratio : 1;
					const showLabel = shouldDrawConstellationLabel(node, scale, {
						isSelected,
						isHovered,
						isFocusMode: impact !== null,
						isSearchMatch: searchRef.current && node.highlighted,
						isCompact: compactRef.current,
					});

					return {
						...data,
						size: node.val,
						color: withAlpha(baseColor, opacity),
						label: showLabel ? truncateLabel(node.label || node.id, compactRef.current ? 24 : 36) : null,
						forceLabel: showLabel,
						// Small nodes last so they stay on top of, and clickable next to,
						// their bigger neighbours.
						zIndex: Math.round(1000 - node.val * 10),
					};
				},
				edgeReducer: (id, data) => {
					const link = linkIndexRef.current.get(id);
					if (!link) return data;
					const colors = paletteRef.current;
					const impact = impactRef.current;
					const inNeighborhood =
						!impact ||
						(impact.has(linkNodeId(link.source)) && impact.has(linkNodeId(link.target)));

					let color = colors.link;
					if (!inNeighborhood) color = colors.dimLink;
					else if (impact) color = edgeColor(link);
					else if (link.muted) color = colors.dimLink;

					return { ...data, size: link.width, color };
				},
			});

			sigma.createCanvas("rings", { beforeLayer: "nodes" });
			sigma.on("afterRender", drawRings);

			// Selection hangs off pointerdown rather than click. sigma counts any two
			// clicks inside doubleClickTimeout as a double click without comparing
			// their positions, and its handler returns before re-emitting the second
			// one, so clicking node after node — exactly how a graph gets browsed —
			// silently dropped every quick second selection.
			sigma.on("downNode", ({ node }) => {
				const target = nodeIndexRef.current.get(node);
				if (target) onSelectNodeRef.current(target);
			});
			sigma.on("clickStage", () => onBackgroundClickRef.current());
			// ...and for the same reason a fast second click must not zoom.
			sigma.on("doubleClickNode", ({ event }) => event.preventSigmaDefault());
			sigma.on("doubleClickStage", ({ event }) => event.preventSigmaDefault());
			sigma.on("enterNode", ({ node }) => {
				hoveredRef.current = node;
				sigma.refresh({ skipIndexation: true });
			});
			sigma.on("leaveNode", () => {
				hoveredRef.current = null;
				sigma.refresh({ skipIndexation: true });
			});

			sigmaRef.current = sigma;

			return () => {
				sigma.kill();
				sigmaRef.current = null;
				graphRef.current = null;
			};
			// Built once: everything mutable is read through refs.
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [drawRings]);

		// Feed graphology whenever the data set itself changes, then relax the layout.
		useEffect(() => {
			const graph = graphRef.current;
			const sigma = sigmaRef.current;
			if (!graph || !sigma) return;

			simulationRef.current?.stop();

			nodeIndexRef.current = new Map(nodes.map((node) => [node.id, node]));
			linkIndexRef.current = new Map();

			graph.clear();
			for (const node of nodes) {
				graph.addNode(node.id, {
					x: node.x ?? node.anchorX,
					y: node.y ?? node.anchorY,
					size: node.val,
					color: node.color,
					label: node.label,
				});
			}
			for (const link of links) {
				const source = linkNodeId(link.source);
				const target = linkNodeId(link.target);
				if (!graph.hasNode(source) || !graph.hasNode(target)) continue;
				const key = graph.addEdge(source, target, { size: link.width, color: link.color });
				linkIndexRef.current.set(key, link);
			}

			if (nodes.length === 0) {
				onEngineRunningChangeRef.current(false);
				sigma.refresh();
				return;
			}

			onEngineRunningChangeRef.current(true);

			const simulation = forceSimulation<ConstellationNode, ConstellationLink>(nodes)
				.alphaDecay(ALPHA_DECAY)
				.velocityDecay(VELOCITY_DECAY)
				.force(
					"charge",
					forceManyBody<ConstellationNode>()
						.strength((node) => (node.isIsolated ? -10 : -34 - Math.sqrt(node.degree + 1) * 9))
						.distanceMax(260),
				)
				.force(
					"link",
					forceLink<ConstellationNode, ConstellationLink>(links)
						.id((node) => node.id)
						.distance((link) => {
							const source = typeof link.source === "string" ? undefined : link.source;
							const target = typeof link.target === "string" ? undefined : link.target;
							return 26 + Math.min(34, ((source?.degree ?? 0) + (target?.degree ?? 0)) * 1.4);
						})
						.strength((link) => (link.type === "parent" || link.type === "spec" ? 0.42 : 0.28)),
				)
				.force("constellation", createConstellationForce())
				.stop();

			simulationRef.current = simulation;

			// Drive the simulation ourselves so the graph freezes on the same terms
			// the old renderer used: a tick budget and a wall-clock budget.
			let ticks = 0;
			let frame = 0;
			const startedAt = performance.now();
			let fitted = false;

			const step = () => {
				const batch = Math.min(4, COOLDOWN_TICKS - ticks);
				for (let i = 0; i < batch; i += 1) {
					simulation.tick();
					ticks += 1;
				}
				for (const node of nodes) {
					if (!graph.hasNode(node.id)) continue;
					graph.setNodeAttribute(node.id, "x", node.x ?? 0);
					graph.setNodeAttribute(node.id, "y", node.y ?? 0);
				}
				if (!fitted) {
					sigma.getCamera().animatedReset({ duration: 0 });
					fitted = true;
				}
				if (ticks >= COOLDOWN_TICKS || performance.now() - startedAt > COOLDOWN_MS) {
					onEngineRunningChangeRef.current(false);
					sigma.getCamera().animatedReset({ duration: 250 });
					return;
				}
				frame = requestAnimationFrame(step);
			};
			frame = requestAnimationFrame(step);

			return () => {
				cancelAnimationFrame(frame);
				simulation.stop();
			};
		}, [nodes, links]);

		// Styling state lives in refs, so a repaint is all that is needed.
		useEffect(() => {
			sigmaRef.current?.refresh();
		}, [palette, selectedNodeId, impactNeighborhood, searchActive, compact]);

		useEffect(() => {
			sigmaRef.current?.setSetting("labelColor", { color: palette.text });
		}, [palette]);

		useImperativeHandle(
			ref,
			() => ({
				fitView() {
					sigmaRef.current?.getCamera().animatedReset({ duration: 350 });
				},
				centerOnNode(id) {
					const sigma = sigmaRef.current;
					if (!sigma) return;
					const display = sigma.getNodeDisplayData(id);
					if (!display) return;
					const camera = sigma.getCamera();
					const ratio = Math.min(camera.getState().ratio, 0.7);
					camera.animate({ x: display.x, y: display.y, ratio }, { duration: 250 });
				},
				zoomBy(factor) {
					const camera = sigmaRef.current?.getCamera();
					if (!camera) return;
					camera.animate({ ratio: camera.getBoundedRatio(camera.getState().ratio / factor) }, { duration: 200 });
				},
			}),
			[],
		);

		return <div ref={containerRef} className="absolute inset-0" style={{ background: palette.canvas }} />;
	},
);
