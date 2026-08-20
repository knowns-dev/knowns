import type { GraphData, GraphEdge, GraphNode } from "@/ui/api/client";

import {
	CODE_COLOR,
	DECISION_COLOR,
	DOC_COLOR,
	isKnowledgeSemanticEdge,
	knowledgeSemanticEdgeColors,
	MEMORY_COLOR,
	memoryLayerColors,
	TASK_COLOR,
	TEMPLATE_COLOR,
} from "./constants";

export type ConstellationNode = GraphNode & {
	color: string;
	val: number;
	degree: number;
	componentId: number;
	componentSize: number;
	anchorX: number;
	anchorY: number;
	isIsolated: boolean;
	labelRank: number;
	highlighted: boolean;
	x?: number;
	y?: number;
	vx?: number;
	vy?: number;
	fx?: number;
	fy?: number;
};

export type ConstellationLink = Omit<GraphEdge, "source" | "target"> & {
	id: string;
	source: string | ConstellationNode;
	target: string | ConstellationNode;
	color: string;
	width: number;
	dashed: boolean;
	muted: boolean;
};

type ForceFn = {
	(alpha: number): void;
	initialize?: (nodes: ConstellationNode[]) => void;
};

/** Dimmed fills are never painted directly — the canvas swaps in a themed colour. */
const NEUTRAL_COLOR = "#94a3b8";
const DIM_COLOR = "rgba(148,163,184,0.25)";

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function hashString(value: string): number {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function nodeColor(node: GraphNode): string {
	switch (node.type) {
	case "task":
		return TASK_COLOR;
	case "doc":
		return DOC_COLOR;
	case "memory":
		return memoryLayerColors[(node.data.layer as string) || "project"] || MEMORY_COLOR;
	case "decision":
		return DECISION_COLOR;
	case "template":
		return TEMPLATE_COLOR;
	case "code":
		return CODE_COLOR;
	default:
		return NEUTRAL_COLOR;
	}
}

export function edgeColor(edge: Pick<GraphEdge, "type">): string {
	switch (edge.type) {
	case "spec":
		return TASK_COLOR;
	case "parent":
	case "mention":
		return NEUTRAL_COLOR;
	default:
		if (isKnowledgeSemanticEdge(edge.type)) return knowledgeSemanticEdgeColors[edge.type];
		return NEUTRAL_COLOR;
	}
}

function edgeId(edge: GraphEdge): string {
	return `${edge.source}-${edge.type}-${edge.target}`;
}

function buildAdjacency(data: GraphData) {
	const adjacency = new Map<string, Set<string>>();
	for (const node of data.nodes) adjacency.set(node.id, new Set());
	for (const edge of data.edges) {
		adjacency.get(edge.source)?.add(edge.target);
		adjacency.get(edge.target)?.add(edge.source);
	}
	return adjacency;
}

function buildComponents(nodes: GraphNode[], adjacency: Map<string, Set<string>>) {
	const remaining = new Set(nodes.map((node) => node.id));
	const components: string[][] = [];

	while (remaining.size > 0) {
		const first = remaining.values().next().value;
		if (!first) break;

		const component: string[] = [];
		const queue = [first];
		remaining.delete(first);

		for (let index = 0; index < queue.length; index += 1) {
			const current = queue[index];
			if (!current) continue;
			component.push(current);
			for (const neighbor of adjacency.get(current) ?? []) {
				if (!remaining.has(neighbor)) continue;
				remaining.delete(neighbor);
				queue.push(neighbor);
			}
		}

		component.sort();
		components.push(component);
	}

	return components.sort((a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""));
}

function selectCommunityHubs(component: string[], adjacency: Map<string, Set<string>>, degree: Map<string, number>) {
	if (component.length < 12) return [component[0]].filter((id): id is string => Boolean(id));

	const hubLimit = Math.min(10, Math.max(2, Math.round(Math.sqrt(component.length) / 2)));
	const candidates = [...component].sort(
		(a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b),
	);
	const hubs: string[] = [];

	for (const candidate of candidates) {
		const directlyTouchesHub = hubs.some((hub) => adjacency.get(candidate)?.has(hub));
		if (!directlyTouchesHub || hubs.length === 0) hubs.push(candidate);
		if (hubs.length >= hubLimit) break;
	}

	return hubs.length > 0 ? hubs : [component[0]].filter((id): id is string => Boolean(id));
}

function assignCommunities(component: string[], hubs: string[], adjacency: Map<string, Set<string>>) {
	const componentSet = new Set(component);
	const owner = new Map<string, string>();
	const queue: string[] = [];

	for (const hub of hubs) {
		owner.set(hub, hub);
		queue.push(hub);
	}

	for (let index = 0; index < queue.length; index += 1) {
		const current = queue[index];
		if (!current) continue;
		const currentOwner = owner.get(current);
		if (!currentOwner) continue;
		for (const neighbor of adjacency.get(current) ?? []) {
			if (!componentSet.has(neighbor) || owner.has(neighbor)) continue;
			owner.set(neighbor, currentOwner);
			queue.push(neighbor);
		}
	}

	const fallback = hubs[0];
	for (const id of component) {
		if (!owner.has(id) && fallback) owner.set(id, fallback);
	}
	return owner;
}

function componentCenter(index: number, size: number) {
	if (index === 0) return { x: 0, y: 0 };
	const angle = (index - 1) * GOLDEN_ANGLE;
	const radius = 430 + Math.sqrt(index) * 88 + Math.min(size, 10) * 6;
	return {
		x: Math.cos(angle) * radius,
		y: Math.sin(angle) * radius,
	};
}

function buildAnchors(data: GraphData) {
	const adjacency = buildAdjacency(data);
	const degree = new Map<string, number>();
	for (const node of data.nodes) degree.set(node.id, adjacency.get(node.id)?.size ?? 0);

	const components = buildComponents(data.nodes, adjacency);
	const connectedComponents = components.filter(
		(component) => component.length > 1 || (degree.get(component[0] ?? "") ?? 0) > 0,
	);
	const isolatedIds = components
		.filter((component) => component.length === 1 && (degree.get(component[0] ?? "") ?? 0) === 0)
		.flat();
	const anchors = new Map<
		string,
		{ x: number; y: number; componentId: number; componentSize: number; isIsolated: boolean }
	>();

	connectedComponents.forEach((component, componentIndex) => {
		const center = componentCenter(componentIndex, component.length);
		const hubs = selectCommunityHubs(component, adjacency, degree);
		const owner = assignCommunities(component, hubs, adjacency);
		const hubIndex = new Map(hubs.map((hub, index) => [hub, index]));
		const communityRadius =
			componentIndex === 0
				? Math.min(240, 72 + Math.sqrt(component.length) * 10)
				: Math.min(86, 34 + component.length * 4);

		for (const id of component) {
			const community = owner.get(id) ?? hubs[0] ?? id;
			const communityIndex = hubIndex.get(community) ?? 0;
			const communityAngle = communityIndex * GOLDEN_ANGLE;
			const communityDistance = communityIndex === 0 ? 0 : communityRadius * (0.65 + (communityIndex % 3) * 0.18);
			const hash = hashString(id);
			const localAngle = ((hash % 360) / 180) * Math.PI;
			const localDistance = 10 + ((hash >>> 8) % 34) + Math.sqrt(component.length) * 0.7;

			anchors.set(id, {
				x: center.x + Math.cos(communityAngle) * communityDistance + Math.cos(localAngle) * localDistance,
				y: center.y + Math.sin(communityAngle) * communityDistance + Math.sin(localAngle) * localDistance,
				componentId: componentIndex,
				componentSize: component.length,
				isIsolated: false,
			});
		}
	});

	// Hug the connected core instead of using a fixed radius: a far-flung ring
	// would force "fit to view" to shrink the part people actually read.
	let coreRadius = 0;
	for (const anchor of anchors.values()) {
		if (anchor.isIsolated) continue;
		coreRadius = Math.max(coreRadius, Math.hypot(anchor.x, anchor.y));
	}
	const isolatedBaseRadius = Math.max(320, coreRadius * 1.12);
	isolatedIds.forEach((id, index) => {
		const angleSeed = hashString(`${id}:angle`) / 0xffffffff;
		const radiusSeed = hashString(`${id}:radius`) / 0xffffffff;
		const angle = angleSeed * Math.PI * 2;
		const outerRadius = isolatedBaseRadius * 1.28;
		const radius = Math.sqrt(
			isolatedBaseRadius * isolatedBaseRadius +
				radiusSeed * (outerRadius * outerRadius - isolatedBaseRadius * isolatedBaseRadius),
		);
		anchors.set(id, {
			x: Math.cos(angle) * radius,
			y: Math.sin(angle) * radius,
			componentId: connectedComponents.length + index,
			componentSize: 1,
			isIsolated: true,
		});
	});

	return { anchors, degree };
}

export function buildConstellationData(
	data: GraphData,
	searchQuery: string,
): { nodes: ConstellationNode[]; links: ConstellationLink[]; matches: number } {
	const query = searchQuery.trim().toLocaleLowerCase();
	const matchedIds = new Set<string>();
	if (query) {
		for (const node of data.nodes) {
			if (`${node.label} ${node.id}`.toLocaleLowerCase().includes(query)) matchedIds.add(node.id);
		}
	}

	const { anchors, degree } = buildAnchors(data);
	const labelOrder = [...data.nodes].sort(
		(a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.label.localeCompare(b.label),
	);
	const labelRank = new Map(labelOrder.map((node, index) => [node.id, index]));

	const nodes = data.nodes
		.map((node) => {
			const anchor = anchors.get(node.id) ?? {
				x: 0,
				y: 0,
				componentId: 0,
				componentSize: 1,
				isIsolated: true,
			};
			const nodeDegree = degree.get(node.id) ?? 0;
			const highlighted = matchedIds.size === 0 || matchedIds.has(node.id);
			return {
				...node,
				color: highlighted ? nodeColor(node) : DIM_COLOR,
				val: anchor.isIsolated ? 2.2 : 3.1 + Math.min(7.5, Math.sqrt(nodeDegree + 1) * 1.45),
				degree: nodeDegree,
				componentId: anchor.componentId,
				componentSize: anchor.componentSize,
				anchorX: anchor.x,
				anchorY: anchor.y,
				isIsolated: anchor.isIsolated,
				labelRank: labelRank.get(node.id) ?? Number.MAX_SAFE_INTEGER,
				highlighted,
				x: anchor.x,
				y: anchor.y,
			};
		})
		.sort((a, b) => a.labelRank - b.labelRank || a.id.localeCompare(b.id));

	const links = data.edges.map((edge) => {
		const highlighted = matchedIds.size === 0 || matchedIds.has(edge.source) || matchedIds.has(edge.target);
		return {
			...edge,
			id: edgeId(edge),
			color: highlighted ? edgeColor(edge) : DIM_COLOR,
			width: 0.55,
			dashed: edge.type === "spec" || (isKnowledgeSemanticEdge(edge.type) && edge.type !== "references"),
			muted: !highlighted,
		};
	});

	return { nodes, links, matches: matchedIds.size };
}

export function createConstellationForce(): ForceFn {
	let nodes: ConstellationNode[] = [];
	const force: ForceFn = (alpha) => {
		for (const node of nodes) {
			if (node.fx !== undefined || node.fy !== undefined) continue;
			const strength = node.isIsolated ? 0.24 : node.componentSize < 12 ? 0.14 : 0.075;
			node.vx = (node.vx ?? 0) + (node.anchorX - (node.x ?? node.anchorX)) * strength * alpha;
			node.vy = (node.vy ?? 0) + (node.anchorY - (node.y ?? node.anchorY)) * strength * alpha;
		}
	};
	force.initialize = (nextNodes) => {
		nodes = nextNodes;
	};
	return force;
}

export function shouldDrawConstellationLabel(
	node: ConstellationNode,
	globalScale: number,
	state: {
		isSelected: boolean;
		isHovered: boolean;
		isFocusMode: boolean;
		isSearchMatch: boolean;
		isCompact: boolean;
	},
): boolean {
	if (state.isSelected || state.isHovered) return true;
	if (state.isFocusMode) return false;
	if (!node.highlighted) return false;
	if (state.isSearchMatch) return true;
	if (node.isIsolated) {
		return node.labelRank < (state.isCompact ? 4 : 12) || globalScale >= (state.isCompact ? 5 : 4.2);
	}
	if (node.labelRank < (state.isCompact ? 7 : 22)) return true;
	if (globalScale >= (state.isCompact ? 1.7 : 1.25) && node.labelRank < (state.isCompact ? 60 : 120)) return true;
	if (globalScale >= (state.isCompact ? 3 : 2.4) && node.labelRank < (state.isCompact ? 180 : 320)) return true;
	return globalScale >= (state.isCompact ? 4.2 : 3.5);
}

export function linkNodeId(value: string | ConstellationNode): string {
	return typeof value === "string" ? value : value.id;
}
