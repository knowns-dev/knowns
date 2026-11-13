import type { ReactNode } from "react";

import type { GraphData } from "@/ui/api/client";
import { cn, focusRing } from "@/ui/lib/knowns/utils";

import {
	isKnowledgeSemanticEdge,
	KNOWLEDGE_SEMANTIC_EDGE_ORDER,
	knowledgeSemanticEdgeFilterKey,
	knowledgeSemanticEdgeLabels,
	type FilterState,
} from "./constants";
import type { GraphColors } from "./theme";

export function entityTypeItems(colors: GraphColors) {
	return [
		{ key: "tasks" as const, type: "task", label: "Tasks", color: colors.task },
		{ key: "docs" as const, type: "doc", label: "Docs", color: colors.doc },
		{ key: "memories" as const, type: "memory", label: "Memories", color: colors.memory },
		{ key: "decisions" as const, type: "decision", label: "Decisions", color: colors.decision },
		{ key: "templates" as const, type: "template", label: "Templates", color: colors.template },
	];
}

function countNodeTypes(data: GraphData | null) {
	const counts: Record<string, number> = {};
	for (const node of data?.nodes ?? []) counts[node.type] = (counts[node.type] ?? 0) + 1;
	return counts;
}

function countEdgeTypes(data: GraphData | null) {
	const counts: Record<string, number> = {};
	for (const edge of data?.edges ?? []) {
		if (edge.type === "parent" || edge.type === "spec" || isKnowledgeSemanticEdge(edge.type)) {
			counts[edge.type] = (counts[edge.type] ?? 0) + 1;
		}
	}
	return counts;
}

/**
 * One toggle per row. The row itself is the button (aria-pressed), so the whole line is the hit
 * area on a phone; the check on the right is drawn, not a second control.
 */
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
	marker: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={cn(
				"flex min-h-8 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:bg-muted pointer-coarse:min-h-11",
				active ? "text-foreground" : "text-muted-foreground",
				focusRing,
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"flex w-4 shrink-0 justify-center transition-opacity duration-(--kn-dur-fast) ease-(--kn-ease-out)",
					!active && "opacity-40",
				)}
			>
				{marker}
			</span>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{typeof count === "number" && <span className="text-[12px] tabular-nums text-muted-foreground">{count}</span>}
			<span
				aria-hidden="true"
				className={cn(
					"grid size-4 shrink-0 place-items-center rounded-[5px] border transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out)",
					active
						? "border-transparent bg-[color:var(--kn-accent,var(--primary))] text-[color:var(--kn-accent-foreground,var(--primary-foreground))]"
						: "border-border bg-background",
				)}
			>
				{active && (
					<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3">
						<path d="m4 8.5 2.5 2.5L12 5.5" />
					</svg>
				)}
			</span>
		</button>
	);
}

function SectionTitle({ id, children }: { id: string; children: ReactNode }) {
	return (
		<h3 id={id} className="mb-1 px-2 text-[12px] font-medium text-muted-foreground">
			{children}
		</h3>
	);
}

interface GraphLegendProps {
	data: GraphData | null;
	filters: FilterState;
	colors: GraphColors;
	onToggleFilter: (key: keyof FilterState) => void;
}

/** The body of the Filters popover: entity types, what to show, and relation types. */
export function GraphLegend({ data, filters, colors, onToggleFilter }: GraphLegendProps) {
	const nodeCounts = countNodeTypes(data);
	const edgeCounts = countEdgeTypes(data);
	const relationItems = [
		{ key: "edgeParent" as const, label: "Parent", color: colors.neutral, count: edgeCounts.parent ?? 0, dashed: false },
		{ key: "edgeSpec" as const, label: "Spec", color: colors.task, count: edgeCounts.spec ?? 0, dashed: true },
		...KNOWLEDGE_SEMANTIC_EDGE_ORDER.map((kind) => ({
			key: knowledgeSemanticEdgeFilterKey(kind),
			label: knowledgeSemanticEdgeLabels[kind],
			color: colors.edges[kind],
			count: edgeCounts[kind] ?? 0,
			dashed: kind !== "references",
		})),
	].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

	return (
		<div className="flex flex-col gap-3">
			<section aria-labelledby="graph-entity-filter-heading">
				<SectionTitle id="graph-entity-filter-heading">Entity types</SectionTitle>
				{entityTypeItems(colors).map((item) => (
					<FilterRow
						key={item.key}
						active={filters[item.key]}
						count={nodeCounts[item.type] ?? 0}
						label={item.label}
						onClick={() => onToggleFilter(item.key)}
						marker={<span className="size-2.5 rounded-full" style={{ backgroundColor: item.color }} />}
					/>
				))}
			</section>

			<section aria-labelledby="graph-visibility-filter-heading" className="border-t border-border/70 pt-3">
				<SectionTitle id="graph-visibility-filter-heading">Visibility</SectionTitle>
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
					marker={<span className="size-2 rounded-full border border-foreground/70" />}
				/>
			</section>

			<section aria-labelledby="graph-relation-filter-heading" className="border-t border-border/70 pt-3">
				<SectionTitle id="graph-relation-filter-heading">Relation types</SectionTitle>
				<div className="max-h-52 overflow-y-auto">
					{relationItems.map((item) => (
						<FilterRow
							key={item.key}
							active={filters[item.key]}
							count={item.count}
							label={item.label}
							onClick={() => onToggleFilter(item.key)}
							marker={<span className={cn("w-4 border-t-2", item.dashed && "border-dashed")} style={{ borderColor: item.color }} />}
						/>
					))}
				</div>
			</section>
		</div>
	);
}

/** The colour key over the canvas: which dot is which entity type. Read-only. */
export function GraphTypeKey({ colors, className }: { colors: GraphColors; className?: string }) {
	return (
		<ul
			aria-label="Entity colours"
			className={cn(
				"flex items-center gap-3 rounded-[10px] border border-border/70 bg-background/90 px-3 py-1.5 text-[12px] text-muted-foreground shadow-xs backdrop-blur-sm",
				className,
			)}
		>
			{entityTypeItems(colors).map((item) => (
				<li key={item.key} className="flex items-center gap-1.5">
					<span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: item.color }} />
					{item.label}
				</li>
			))}
		</ul>
	);
}
