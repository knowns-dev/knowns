import type { GraphData } from "@/ui/api/client";
import { Check } from "lucide-react";

import { cn } from "@/ui/lib/utils";

import {
	DECISION_COLOR,
	DOC_COLOR,
	isKnowledgeSemanticEdge,
	KNOWLEDGE_SEMANTIC_EDGE_ORDER,
	knowledgeSemanticEdgeColors,
	knowledgeSemanticEdgeFilterKey,
	knowledgeSemanticEdgeLabels,
	MEMORY_COLOR,
	TASK_COLOR,
	TEMPLATE_COLOR,
	type FilterState,
} from "./constants";

interface GraphLegendProps {
	data: GraphData | null;
	filters: FilterState;
	onToggleFilter: (key: keyof FilterState) => void;
}

function countKnowledgeNodeTypes(data: GraphData | null) {
	const counts = { task: 0, doc: 0, memory: 0, decision: 0, template: 0 };
	if (!data) return counts;
	for (const node of data.nodes) {
		if (node.type in counts) counts[node.type as keyof typeof counts] += 1;
	}
	return counts;
}

function countKnowledgeEdgeTypes(data: GraphData | null) {
	const counts: Record<string, number> = { parent: 0, spec: 0 };
	for (const kind of KNOWLEDGE_SEMANTIC_EDGE_ORDER) counts[kind] = 0;
	if (!data) return counts;
	for (const edge of data.edges) {
		if (edge.type === "parent" || edge.type === "spec") counts[edge.type] = (counts[edge.type] ?? 0) + 1;
		else if (isKnowledgeSemanticEdge(edge.type)) counts[edge.type] = (counts[edge.type] ?? 0) + 1;
	}
	return counts;
}

function FilterRow({
	active,
	count,
	label,
	onClick,
	marker,
}: {
	active: boolean;
	count?: number;
	label: string;
	onClick: () => void;
	marker: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={cn(
				"group flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors duration-150 sm:min-h-10",
				active ? "text-foreground hover:bg-accent" : "text-muted-foreground hover:bg-accent/70",
			)}
		>
			<span className={cn("flex w-4 shrink-0 justify-center transition-opacity", active ? "opacity-100" : "opacity-35")}>
				{marker}
			</span>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{typeof count === "number" && (
				<span className="font-mono text-[0.6875rem] tabular-nums text-muted-foreground">{count}</span>
			)}
			<span
				aria-hidden="true"
				className={cn(
					"flex h-4 w-4 items-center justify-center rounded-[0.25rem] border",
					active ? "border-foreground/40 bg-foreground text-background" : "border-border bg-background",
				)}
			>
				{active && <Check className="h-3 w-3" strokeWidth={2.5} />}
			</span>
		</button>
	);
}

export function GraphLegend({ data, filters, onToggleFilter }: GraphLegendProps) {
	const nodeCounts = countKnowledgeNodeTypes(data);
	const edgeCounts = countKnowledgeEdgeTypes(data);
	const nodeItems = [
		{ key: "tasks" as const, label: "Tasks", color: TASK_COLOR, count: nodeCounts.task },
		{ key: "docs" as const, label: "Docs", color: DOC_COLOR, count: nodeCounts.doc },
		{ key: "memories" as const, label: "Memories", color: MEMORY_COLOR, count: nodeCounts.memory },
		{ key: "decisions" as const, label: "Decisions", color: DECISION_COLOR, count: nodeCounts.decision },
		{ key: "templates" as const, label: "Templates", color: TEMPLATE_COLOR, count: nodeCounts.template },
	];
	const relationItems = [
		{ key: "edgeParent" as const, label: "Parent", color: "#94a3b8", count: edgeCounts.parent ?? 0, dashed: false },
		{ key: "edgeSpec" as const, label: "Spec", color: TASK_COLOR, count: edgeCounts.spec ?? 0, dashed: true },
		...KNOWLEDGE_SEMANTIC_EDGE_ORDER.map((kind) => ({
			key: knowledgeSemanticEdgeFilterKey(kind),
			label: knowledgeSemanticEdgeLabels[kind],
			color: knowledgeSemanticEdgeColors[kind],
			count: edgeCounts[kind] ?? 0,
			dashed: kind !== "references",
		})),
	].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

	return (
		<div className="space-y-4">
			<section aria-labelledby="graph-entity-filter-heading">
				<div
					id="graph-entity-filter-heading"
					className="mb-1 px-2 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
				>
					Entity types
				</div>
				<div className="space-y-0.5">
					{nodeItems.map((item) => (
						<FilterRow
							key={item.key}
							active={filters[item.key]}
							count={item.count}
							label={item.label}
							onClick={() => onToggleFilter(item.key)}
							marker={<span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />}
						/>
					))}
				</div>
			</section>

			<section aria-labelledby="graph-visibility-filter-heading" className="border-t border-border pt-3">
				<div
					id="graph-visibility-filter-heading"
					className="mb-1 px-2 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
				>
					Visibility
				</div>
				<FilterRow
					active={filters.showEdges}
					label="Relations"
					onClick={() => onToggleFilter("showEdges")}
					marker={<span className="w-4 border-t border-foreground/70" />}
				/>
				<FilterRow
					active={filters.showIsolated}
					label="Isolated entities"
					onClick={() => onToggleFilter("showIsolated")}
					marker={<span className="h-2 w-2 rounded-full border border-foreground/70" />}
				/>
			</section>

			<section aria-labelledby="graph-relation-filter-heading" className="border-t border-border pt-3">
				<div
					id="graph-relation-filter-heading"
					className="mb-1 px-2 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
				>
					Relation types
				</div>
				<div className="max-h-48 space-y-0.5 overflow-y-auto pr-1">
					{relationItems.map((item) => (
						<FilterRow
							key={item.key}
							active={filters[item.key]}
							count={item.count}
							label={item.label}
							onClick={() => onToggleFilter(item.key)}
							marker={
								<span
									className={cn("w-4 border-t-2", item.dashed && "border-dashed")}
									style={{ borderColor: item.color }}
								/>
							}
						/>
					))}
				</div>
			</section>
		</div>
	);
}
