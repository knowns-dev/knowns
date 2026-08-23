import type { GraphData, GraphEdge, GraphNode } from "@/ui/api/client";

export const TASK_COLOR = "#6366f1";
export const DOC_COLOR = "#f59e0b";
export const MEMORY_COLOR = "#22c55e";
export const DECISION_COLOR = "#e11d48";
export const TEMPLATE_COLOR = "#06b6d4";
export const CODE_COLOR = "#ec4899";

export const statusBorderColors: Record<string, string> = {
	todo: "#6b7280",
	"in-progress": "#f59e0b",
	"in-review": "#a855f7",
	done: "#22c55e",
	blocked: "#ef4444",
	"on-hold": "#8b5cf6",
	urgent: "#dc2626",
};

export const memoryLayerColors: Record<string, string> = {
	working: "#6b7280",
	project: "#22c55e",
	global: "#a855f7",
};

export interface FilterState {
	tasks: boolean;
	docs: boolean;
	memories: boolean;
	decisions: boolean;
	templates: boolean;
	showIsolated: boolean;
	showEdges: boolean;
	edgeParent: boolean;
	edgeSpec: boolean;
	edgeReferences: boolean;
	edgeImplements: boolean;
	edgeBlockedBy: boolean;
	edgeRelated: boolean;
	edgeDepends: boolean;
	edgeFollows: boolean;
}

export const KNOWLEDGE_FILTERS: FilterState = {
	tasks: true,
	docs: true,
	memories: true,
	decisions: true,
	templates: true,
	showIsolated: false,
	showEdges: true,
	edgeParent: true,
	edgeSpec: true,
	edgeReferences: true,
	edgeImplements: true,
	edgeBlockedBy: true,
	edgeRelated: true,
	edgeDepends: true,
	edgeFollows: true,
};

export const KNOWLEDGE_SEMANTIC_EDGE_ORDER = ["references", "implements", "blocked-by", "related", "depends", "follows"] as const;
export type KnowledgeSemanticEdgeKind = (typeof KNOWLEDGE_SEMANTIC_EDGE_ORDER)[number];

export const knowledgeSemanticEdgeLabels: Record<KnowledgeSemanticEdgeKind, string> = {
	references: "References",
	implements: "Implements",
	"blocked-by": "Blocked By",
	related: "Related",
	depends: "Depends",
	follows: "Follows",
};

export const knowledgeSemanticEdgeColors: Record<KnowledgeSemanticEdgeKind, string> = {
	references: "#64748b",
	implements: "#6366f1",
	"blocked-by": "#ef4444",
	related: "#8b5cf6",
	depends: "#0ea5e9",
	follows: "#22c55e",
};

export function isKnowledgeSemanticEdge(type: GraphEdge["type"]): type is KnowledgeSemanticEdgeKind {
	return (KNOWLEDGE_SEMANTIC_EDGE_ORDER as readonly string[]).includes(type);
}

export function knowledgeSemanticEdgeFilterKey(kind: KnowledgeSemanticEdgeKind): keyof FilterState {
	switch (kind) {
	case "references":
		return "edgeReferences";
	case "implements":
		return "edgeImplements";
	case "blocked-by":
		return "edgeBlockedBy";
	case "related":
		return "edgeRelated";
	case "depends":
		return "edgeDepends";
	case "follows":
		return "edgeFollows";
	}
}


export interface GraphReferenceItem {
	nodeId: string;
	label: string;
	type: GraphNode["type"] | "external";
	edgeType: GraphEdge["type"];
	isVirtual?: boolean;
	resolutionStatus?: string;
}

export interface SelectedNodeReferences {
	incoming: GraphReferenceItem[];
	outgoing: GraphReferenceItem[];
}

export function buildSelectedNodeReferences(data: GraphData | null, selectedNode: GraphNode | null): SelectedNodeReferences {
	if (!data || !selectedNode) {
		return { incoming: [], outgoing: [] };
	}

	const dedupeRefs = (items: GraphReferenceItem[]) => {
		const seen = new Set<string>();
		return items.filter((item) => {
			const key = [item.nodeId, item.label, item.type, item.edgeType, item.resolutionStatus || "", item.isVirtual ? "1" : "0"].join("|");
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	};

	const nodeMap = new Map(data.nodes.map((node) => [node.id, node] as const));
	const toRef = (edge: GraphEdge, relatedId: string) => {
		const relatedNode = nodeMap.get(relatedId);
		if (relatedNode) {
			return {
				nodeId: relatedNode.id,
				label: relatedNode.label,
				type: relatedNode.type,
				edgeType: edge.type,
			};
		}
		const displayTarget = typeof edge.data?.display_target === "string" ? edge.data.display_target : null;
		if (!displayTarget) return null;
		return {
			nodeId: relatedId,
			label: displayTarget,
			type: "external" as const,
			edgeType: edge.type,
			isVirtual: true,
			resolutionStatus: typeof edge.data?.resolution_status === "string" ? edge.data.resolution_status : undefined,
		};
	};

	const incoming = dedupeRefs(
		data.edges
		.filter((edge) => edge.target === selectedNode.id)
		.map((edge) => toRef(edge, edge.source))
		.filter((item): item is NonNullable<typeof item> => item !== null)
		.sort((a, b) => a.label.localeCompare(b.label)),
	);

	const outgoing = dedupeRefs(
		data.edges
		.filter((edge) => edge.source === selectedNode.id)
		.map((edge) => toRef(edge, edge.target))
		.filter((item): item is NonNullable<typeof item> => item !== null)
		.sort((a, b) => a.label.localeCompare(b.label)),
	);

	return { incoming, outgoing };
}
