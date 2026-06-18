import { cn } from "@/ui/lib/utils";
import type { FilterState } from "./constants";

import {
	isKnowledgeSemanticEdge,
	KNOWLEDGE_SEMANTIC_EDGE_ORDER,
	knowledgeSemanticEdgeFilterKey,
	knowledgeSemanticEdgeColors,
	knowledgeSemanticEdgeLabels,
} from "./constants";
import type { GraphData } from "@/ui/api/client";

interface GraphLegendProps {
	data: GraphData | null;
	filters: FilterState;
	onToggleFilter: (key: keyof FilterState) => void;
}

function countKnowledgeNodeTypes(data: GraphData | null) {
	const counts = { task: 0, doc: 0, memory: 0, decision: 0, template: 0 };
	if (!data) return counts;
	for (const node of data.nodes) {
		if (node.type === "task" || node.type === "doc" || node.type === "memory" || node.type === "decision" || node.type === "template") counts[node.type] += 1;
	}
	return counts;
}

function countKnowledgeEdgeTypes(data: GraphData | null) {
	const counts: Record<string, number> = { parent: 0, spec: 0 };
	for (const kind of KNOWLEDGE_SEMANTIC_EDGE_ORDER) counts[kind] = 0;
	if (!data) return counts;
	for (const edge of data.edges) {
		if (edge.type === "parent" || edge.type === "spec") counts[edge.type] += 1;
		else if (isKnowledgeSemanticEdge(edge.type)) counts[edge.type] += 1;
	}
	return counts;
}

export function GraphLegend({ data, filters, onToggleFilter }: GraphLegendProps) {
	const nodeCounts = countKnowledgeNodeTypes(data);
	const edgeCounts = countKnowledgeEdgeTypes(data);
	const semanticLegendItems = KNOWLEDGE_SEMANTIC_EDGE_ORDER
		.map((kind, index) => ({
			kind,
			index,
			count: edgeCounts[kind],
			filterKey: knowledgeSemanticEdgeFilterKey(kind),
		}))
		.sort((a, b) => {
			const aHasCount = a.count > 0 ? 1 : 0;
			const bHasCount = b.count > 0 ? 1 : 0;
			if (aHasCount !== bHasCount) return bHasCount - aHasCount;
			if (a.count !== b.count) return b.count - a.count;
			return a.index - b.index;
		});

	return (
		<div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1.5 rounded-lg border bg-background/90 backdrop-blur-sm p-2.5 text-xs shadow-sm">
			<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Node types</div>
			<div className="flex flex-col gap-1">
				{[
					{ key: "tasks" as const, label: "Tasks", color: "#6366f1", active: filters.tasks, count: nodeCounts.task },
					{ key: "docs" as const, label: "Docs", color: "#f59e0b", active: filters.docs, count: nodeCounts.doc },
					{ key: "memories" as const, label: "Memories", color: "#22c55e", active: filters.memories, count: nodeCounts.memory },
					{ key: "decisions" as const, label: "Decisions", color: "#e11d48", active: filters.decisions, count: nodeCounts.decision },
					{ key: "templates" as const, label: "Templates", color: "#06b6d4", active: filters.templates, count: nodeCounts.template },
				].map((item) => (
					<button
						key={item.key}
						type="button"
						onClick={() => onToggleFilter(item.key)}
						className={cn(
							"flex items-center justify-between gap-3 rounded-md border px-2 py-1 text-left transition-colors",
							item.active ? "border-border bg-background/80" : "border-transparent opacity-45 hover:opacity-80",
						)}
					>
						<span className="flex items-center gap-1.5">
							<span className="h-3 w-3 rounded-full" style={{ backgroundColor: item.color }} />
							<span className="text-muted-foreground">{item.label}</span>
						</span>
						<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.count}</span>
					</button>
				))}
			</div>
			<div className="h-px bg-border my-0.5" />
			<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Edges</div>
			<div className="flex flex-col gap-1">
				{[
					{ key: "edgeParent" as const, label: "Parent", active: filters.edgeParent, count: edgeCounts.parent, className: "border-gray-400" },
					{ key: "edgeSpec" as const, label: "Spec", active: filters.edgeSpec, count: edgeCounts.spec, className: "border-indigo-500" },
				].map((item) => (
					<button
						key={item.key}
						type="button"
						onClick={() => onToggleFilter(item.key)}
						className={cn(
							"flex items-center justify-between gap-3 rounded-md border px-2 py-1 text-left transition-colors",
							item.active ? "border-border bg-background/80" : "border-transparent opacity-45 hover:opacity-80",
						)}
					>
						<span className="flex items-center gap-1.5">
							<span className={cn("w-4 border-t-2", item.className)} />
							<span className="text-muted-foreground">{item.label}</span>
						</span>
						<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.count}</span>
					</button>
				))}
			</div>
			<div className="mt-1 space-y-1 border-t border-border pt-1.5">
				<div className="px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
					Semantic Relations
				</div>
				{semanticLegendItems.map(({ kind, count, filterKey }) => {
					const active = filters[filterKey];
					return (
						<button
							key={kind}
							type="button"
							onClick={() => onToggleFilter(filterKey)}
							className={cn(
								"flex w-full items-center justify-between gap-3 rounded-md border px-2 py-1 text-left transition-colors",
								active ? "border-border bg-background/80" : "border-transparent opacity-45 hover:opacity-80",
							)}
						>
							<span className="flex items-center gap-1.5">
								<span className="w-4 border-t-2 border-dashed" style={{ borderColor: knowledgeSemanticEdgeColors[kind] }} />
								<span className="text-muted-foreground">{knowledgeSemanticEdgeLabels[kind]}</span>
							</span>
							<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{count}</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}
