import { useEffect, useState, type ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, X } from "lucide-react";

import type { GraphEdge, GraphNode } from "@/ui/api/client";
import { DetailSection } from "@/ui/components/organisms/TaskDetail/DetailSection";
import { priorityTones, statusTone } from "@/ui/components/organisms/TaskDetail/types";
import { Badge, type BadgeTone } from "@/ui/components/ui/knowns/badge";
import { Button } from "@/ui/components/ui/knowns/button";
import { MOTION } from "@/ui/lib/knowns/motion-utils";
import { cn, focusRing } from "@/ui/lib/knowns/utils";

import type { GraphReferenceItem, SelectedNodeReferences } from "./graph/constants";
import { nodeColor } from "./graph/graphModel";
import type { GraphColors } from "./graph/theme";

interface GraphDetailPanelProps {
	node: GraphNode | null;
	colors: GraphColors;
	onClose: () => void;
	onNavigate: (node: GraphNode) => void;
	onSelectNode?: (nodeId: string) => void;
	references?: SelectedNodeReferences;
}

const TYPE_LABELS: Record<string, string> = {
	task: "Task",
	doc: "Doc",
	memory: "Memory",
	decision: "Decision",
	template: "Template",
	code: "Code",
	external: "External",
};

const EDGE_LABELS: Record<GraphEdge["type"], string> = {
	parent: "Parent",
	spec: "Spec",
	mention: "Mention",
	"template-doc": "Template doc",
	"code-ref": "Code ref",
	calls: "Calls",
	imports: "Imports",
	contains: "Contains",
	instantiates: "Creates",
	implements: "Implements",
	references: "References",
	"blocked-by": "Blocked by",
	related: "Related",
	depends: "Depends",
	follows: "Follows",
};

const PRIORITY_LABELS: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };
const LAYER_LABELS: Record<string, string> = { global: "Global", project: "Project", working: "Working" };
const LAYER_TONES: Record<string, BadgeTone> = { global: "accent", project: "success", working: "neutral" };
const DECISION_TONES: Record<string, BadgeTone> = {
	accepted: "success",
	proposed: "info",
	rejected: "danger",
	superseded: "neutral",
	deprecated: "warning",
};

const OPENABLE = new Set(["task", "doc", "memory", "decision"]);
/** Long reference lists push the Open button off a phone screen: show this many, then a toggle. */
const CONNECTIONS_SHOWN = 8;

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : []);
const titleCase = (value: string) => value.replace(/[-_]/g, " ").replace(/^\w/, (char) => char.toUpperCase());

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-3 py-1">
			<dt className="pt-0.5 text-[12.5px] text-muted-foreground">{label}</dt>
			<dd className="min-w-0 text-[13px] text-foreground">{children}</dd>
		</div>
	);
}

function TagList({ items }: { items: string[] }) {
	return (
		<div className="flex flex-wrap gap-1">
			{items.map((item) => (
				<Badge key={item} size="sm">
					{item}
				</Badge>
			))}
		</div>
	);
}

function NodeFields({ node, type }: { node: GraphNode; type: string }) {
	const data = node.data ?? {};
	const fields: ReactNode[] = [];
	const description = str(data.description);
	const status = str(data.status);
	const tags = strings(data.tags);

	if (type === "task") {
		const priority = str(data.priority);
		const assignee = str(data.assignee);
		const labels = strings(data.labels);
		if (status)
			fields.push(
				<Field key="status" label="Status">
					<Badge tone={statusTone(status)} dot>
						{titleCase(status)}
					</Badge>
				</Field>,
			);
		if (priority)
			fields.push(
				<Field key="priority" label="Priority">
					<Badge tone={priorityTones[priority as keyof typeof priorityTones] ?? "neutral"}>
						{PRIORITY_LABELS[priority] ?? titleCase(priority)}
					</Badge>
				</Field>,
			);
		fields.push(
			<Field key="assignee" label="Assignee">
				{assignee || <span className="text-muted-foreground">Unassigned</span>}
			</Field>,
		);
		if (labels.length > 0)
			fields.push(
				<Field key="labels" label="Labels">
					<TagList items={labels} />
				</Field>,
			);
	}

	if (type === "memory") {
		const layer = str(data.layer) || "project";
		const category = str(data.category);
		fields.push(
			<Field key="layer" label="Layer">
				<Badge tone={LAYER_TONES[layer] ?? "neutral"}>{LAYER_LABELS[layer] ?? titleCase(layer)}</Badge>
			</Field>,
		);
		if (category)
			fields.push(
				<Field key="category" label="Category">
					{titleCase(category)}
				</Field>,
			);
	}

	if (type === "decision" && status)
		fields.push(
			<Field key="status" label="Status">
				<Badge tone={DECISION_TONES[status] ?? "neutral"} dot>
					{titleCase(status)}
				</Badge>
			</Field>,
		);

	if (type === "template") {
		const source = str(data.source);
		if (source)
			fields.push(
				<Field key="source" label="Imported">
					<span className="font-mono text-[12.5px]">{source}</span>
				</Field>,
			);
	}

	if (type === "code") {
		const kind = str(data.kind);
		const docPath = str(data.docPath);
		if (kind)
			fields.push(
				<Field key="kind" label="Kind">
					{titleCase(kind)}
				</Field>,
			);
		if (docPath)
			fields.push(
				<Field key="file" label="File">
					<span className="break-all font-mono text-[12.5px]">{docPath}</span>
				</Field>,
			);
	}

	if ((type === "doc" || type === "memory" || type === "decision") && tags.length > 0)
		fields.push(
			<Field key="tags" label="Tags">
				<TagList items={tags} />
			</Field>,
		);

	const code = type === "code" ? str(data.content) : "";
	const codeLines = code ? code.split("\n") : [];

	return (
		<>
			{description && <p className="text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
			{fields.length > 0 && <dl className="flex flex-col">{fields}</dl>}
			{codeLines.length > 0 && (
				<pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-[10px] border border-border/70 bg-muted/40 p-2.5 font-mono text-[12px] leading-relaxed">
					{codeLines.slice(0, 8).join("\n")}
					{codeLines.length > 8 ? "\n…" : ""}
				</pre>
			)}
		</>
	);
}

type Connection = GraphReferenceItem & { direction: "in" | "out" };

function ConnectionRow({
	item,
	colors,
	onSelectNode,
}: {
	item: Connection;
	colors: GraphColors;
	onSelectNode?: (nodeId: string) => void;
}) {
	const navigable = !item.isVirtual && item.type !== "external" && Boolean(onSelectNode);
	const Arrow = item.direction === "out" ? ArrowUpRight : ArrowDownLeft;
	const content = (
		<>
			<span
				aria-hidden="true"
				className="size-2 shrink-0 rounded-full"
				style={{ backgroundColor: item.type === "external" ? colors.neutral : nodeColor({ type: item.type, data: {} }, colors) }}
			/>
			<span className="sr-only">{TYPE_LABELS[item.type] ?? item.type}: </span>
			<span className="min-w-0 flex-1 truncate">{item.label}</span>
			{item.resolutionStatus === "unresolved" && <Badge size="sm">Unresolved</Badge>}
			{item.resolutionStatus === "resolved_external" && (
				<Badge size="sm" tone="warning">
					External
				</Badge>
			)}
			<span className="flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground">
				<Arrow aria-hidden="true" className="size-3" />
				<span className="sr-only">{item.direction === "out" ? "outgoing" : "incoming"}</span>
				{EDGE_LABELS[item.edgeType] ?? item.edgeType}
			</span>
		</>
	);
	const rowClass = "flex min-h-8 w-full items-center gap-2 rounded-[8px] px-2 text-left text-[13px] pointer-coarse:min-h-11";

	if (!navigable) return <li className={cn(rowClass, "text-muted-foreground")}>{content}</li>;
	return (
		<li>
			<button
				type="button"
				onClick={() => onSelectNode?.(item.nodeId)}
				className={cn(rowClass, "text-foreground transition-colors duration-(--kn-dur-fast) ease-(--kn-ease-out) hover:bg-muted", focusRing)}
			>
				{content}
			</button>
		</li>
	);
}

/**
 * What the selected entity is and what it touches. A card at the top right of the canvas on wider
 * screens; docked to the bottom on a phone so the graph above it stays usable. It enters with
 * kn-rise (a node pick happens a few times a session, so the standard 180ms) and does not replay
 * when another node is picked while it is open.
 */
export function GraphDetailPanel({ node: nodeProp, colors, onClose, onNavigate, onSelectNode, references }: GraphDetailPanelProps) {
	const [showAll, setShowAll] = useState(false);
	const [shownFor, setShownFor] = useState<string | null>(null);
	// The last node stays on screen for the exit fade, then goes.
	const [last, setLast] = useState<GraphNode | null>(null);
	if (nodeProp && shownFor !== nodeProp.id) {
		setShownFor(nodeProp.id);
		setShowAll(false);
	}
	if (nodeProp && last !== nodeProp) setLast(nodeProp);
	useEffect(() => {
		if (nodeProp || !last) return;
		const timer = window.setTimeout(() => setLast(null), MOTION.fast);
		return () => window.clearTimeout(timer);
	}, [nodeProp, last]);
	const node = nodeProp ?? last;
	const leaving = !nodeProp;
	if (!node) return null;

	const [type = "", ...rest] = node.id.split(":");
	const entityId = rest.join(":");
	const typeLabel = TYPE_LABELS[type] ?? titleCase(type);
	const connections: Connection[] = [
		...(references?.outgoing ?? []).map((item) => ({ ...item, direction: "out" as const })),
		...(references?.incoming ?? []).map((item) => ({ ...item, direction: "in" as const })),
	];
	const visible = showAll ? connections : connections.slice(0, CONNECTIONS_SHOWN);

	return (
		<aside
			aria-label={`${typeLabel} details`}
			data-testid="graph-detail-panel"
			className={cn(
				"absolute z-20 flex flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-[0_12px_32px_-12px_rgb(0_0_0/0.3),0_2px_6px_rgb(0_0_0/0.06)]",
				"inset-x-2 bottom-2 max-h-[min(55%,24rem)]",
				"sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-3 sm:max-h-[calc(100%-1.5rem)]",
				type === "code" ? "sm:w-96" : "sm:w-80",
				leaving
					? "pointer-events-none animate-[kn-fall_var(--kn-dur-fast)_var(--kn-ease-out)_both]"
					: "animate-[kn-rise_var(--kn-dur)_var(--kn-ease-out)_both] motion-reduce:animate-none",
			)}
			aria-hidden={leaving || undefined}
			inert={leaving || undefined}
		>
			<header className="flex shrink-0 items-start gap-2 border-b border-border/70 px-4 pb-3 pt-3.5">
				<div className="min-w-0 flex-1">
					<div className="mb-1 flex min-w-0 items-center gap-2">
						<Badge
							size="sm"
							icon={<span className="size-1.5 rounded-full" style={{ backgroundColor: nodeColor(node, colors) }} />}
						>
							{typeLabel}
						</Badge>
						<span className="truncate font-mono text-[12px] text-muted-foreground">{entityId}</span>
					</div>
					<h2 className="break-words text-[15px] font-semibold leading-snug tracking-tight text-foreground">{node.label}</h2>
				</div>
				<Button variant="ghost" size="sm" icon={<X />} aria-label="Close details" onClick={onClose} className="-mr-1.5 -mt-0.5" />
			</header>

			<div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-3">
				<NodeFields node={node} type={type} />

				<DetailSection title="Connections" count={connections.length}>
					{connections.length === 0 ? (
						<p className="text-[13px] text-muted-foreground">No relations with the current filters.</p>
					) : (
						<>
							<ul className="-mx-2 flex flex-col">
								{visible.map((item, index) => (
									<ConnectionRow
										key={`${item.direction}-${item.edgeType}-${item.nodeId}-${index}`}
										item={item}
										colors={colors}
										onSelectNode={onSelectNode}
									/>
								))}
							</ul>
							{connections.length > CONNECTIONS_SHOWN && (
								<Button variant="quiet" size="sm" className="self-start" onClick={() => setShowAll((value) => !value)}>
									{showAll ? "Show fewer" : `Show all ${connections.length}`}
								</Button>
							)}
						</>
					)}
				</DetailSection>
			</div>

			{OPENABLE.has(type) && (
				<footer className="shrink-0 border-t border-border/70 px-4 py-3">
					<Button size="sm" className="w-full" onClick={() => onNavigate(node)}>
						Open {typeLabel.toLowerCase()}
					</Button>
				</footer>
			)}
		</aside>
	);
}
